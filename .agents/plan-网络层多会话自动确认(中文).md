# 多会话（含后台未打开会话）自动确认 —— 最终实现归档

状态：已完成并真机端到端验证通过（2026-09-14）。
旧文档 `plan-单窗口多会话自动触发(中文).md` 的「轮询切换会话标签」方案已废弃（大会话重渲染卡顿，被用户否决）。

## 1. 根因（第一性原理）
- IDE 前端只为「当前打开的那一个 conversation」订阅 agent 状态流，确认按钮也只在当前会话 DOM 里渲染。
- 原扩展用 MutationObserver + DOM 扫描，因此永远扫不到未打开/后台会话的 WAITING，表现为「只有当前会话能自动点」。
- 但后端 language server 为**所有**会话保留状态：对未打开会话直接订阅状态流也能立即收到快照；确认动作最终走本地 Connect RPC，页面内 fetch 即可调用（自签证书天然信任）。

## 2. 方案（事件驱动，不切换、不轮询 DOM）
在注入脚本里新增网络层 `createNetworkAutoAccept()`：
1. hook fetch + `performance` 资源 + 早期注入的 `window.__cap`，三路获取**动态**端口与 `x-codeium-csrf-token`（禁止硬编码端口）。
2. 每 15s（Web Worker 计时，后台标签不被节流）用 unary `GetAllCascadeTrajectories` 枚举全部会话，并清理已删除会话的失效订阅。
3. 为每个会话挂一条 server-streaming 长连接 `StreamAgentStateUpdates`，空闲挂起、零 CPU；首帧全量、后续按 indices 增量合并。
4. 收到 `CORTEX_STEP_STATUS_WAITING` 步骤，按 `step.requestedInteraction` 的 key（最权威，回退到内容字段推断）构造**平铺 oneof** 的 `HandleCascadeUserInteraction` 回发确认；`(cascadeId,stepIndex)` 去重，失败允许重试。
5. 原 DOM 点击保留为「当前可见会话」前台兜底；**删除后台循环切换 tab 分支**。

## 3. 关键 RPC 契约（proto descriptor + 真机双证）
- endpoint：`https://127.0.0.1:{动态port}/exa.language_server_pb.LanguageServerService/{Method}`，POST，必带 header `x-codeium-csrf-token:<UUID>`。
- unary：`application/json` + 纯 JSON。streaming：请求体/响应体都是 Connect envelope（1B flag=0 + 4B 大端 uint32 长度 + JSON），`Content-Type: application/connect+json`。
- `HandleCascadeUserInteraction` 正确体（平铺 oneof，不能再套一层 {case,value}）：
  `{cascadeId, interaction:{trajectoryId, stepIndex, runCommand:{confirm:true,proposedCommandLine:cmd,submittedCommandLine:cmd}}}`
  - runCommand 之外：openBrowserUrl/executeBrowserJavascript/mcp/... 为 `{confirm:true}`；
  - filePermission：`{allow:true, scope:"PERMISSION_SCOPE_ONCE", absolutePathUri}`；
  - elicitation 不盲目自动；runCommand 仍受 bannedCommands 黑名单约束。
- `cascadeId === conversationId`；stepIndex 即 steps 数组下标；成功返回 200 空对象 `{}`。

## 4. 改动文件
- `main_scripts/full_cdp_script.js`
  - 新增 `createNetworkAutoAccept()`（网络层）与只读诊断 `window.__autoAllState.netDiag`。
  - `waitForDisappear` 由 requestAnimationFrame 改为 workerDelay 轮询（修后台标签 rAF 冻结导致永久 pending）。
  - unifiedLoop 删除后台切换 tab 分支与闲置 `index/TAB_SELECTORS`，统一为前台兜底。
  - `__autoAllStart` 单例幂等启动网络层（扩展周期性 syncSessions 会重复调用，禁止重建）；`__autoAllStop` 停止并清理。
- `main_scripts/cdp-handler.js`
  - 新增 `installEarlyTokenHook()`：`Page.enable` + `Page.addScriptToEvaluateOnNewDocument` 最早注入 fetch 钩子写 `window.__cap`，并对当前文档补注一次（幂等）。
- 构建：`npm run compile`（esbuild）→ `dist/extension.js`；部署到
  `C:\Users\Administrator\.antigravity\extensions\huo-zai-feng-lang-li.auto-agent-antigravity-1.0.79\`
  （full_cdp_script.js 运行时按文件读取，cdp-handler 被 bundle 进 dist）。

## 5. 验证记录（客观判据：状态 WAITING→RUNNING→DONE + 命令副作用真实发生）
- 前台会话 Remove-Item：自动确认、文件真实删除。
- 严格后台：新建会话发删除指令后立即切到空白会话使其后台化，后台 WAITING 仍被网络层确认，文件真实删除；handled 计数长期稳定（单例不重建）。
- reload / 冷启动：零交互自动恢复，自动发现动态端口并订阅全部会话（实测 5/6/7/8 条）。
- 性能：7 条长连接空闲 12s，整页 ScriptDuration≈273ms（含 IDE 本体）、LayoutDuration≈5ms、RecalcStyle≈17ms，无忙等、几乎零 DOM 活动。
- 冷启动 IDE 正常：9000 调试端口、多进程、扩展激活均正常，不影响启动。

## 6. 运维须知
- 不改 IDE 安装文件；重装/升级 IDE 后只需重新安装本扩展（或重新部署上述三个文件）并 `npm run compile`。
- 扩展总开关状态存 globalState `auto-all-enabled-global`；冷启动若显示「⚡关闭」是开关被关，点状态栏开启即可（与本次代码无关）。
- 注意：通过 CDP `Page.reload` 反复重载在本版本可能让 Electron 关闭 remote-debugging 端口；用 VBS 快捷方式正常重启即可恢复（属验证手段副作用，非产品问题）。

## 7. 独立审计与修复（2026-09-14 闭环）
独立子 agent 按 7 项 checklist 审计，处理结果：
- M1 Overlay 回归 + M2 死代码：新架构不再切 tab，旧「切换遮罩」整套（showOverlay/updateOverlay/hideOverlay + stripTimeSuffix/deduplicateNames/updateTabNames/updateConversationCompletionState + state.tabNames/completionStatus）已整体删除（约 205 行）。
- M3：enumerate 清理失效会话订阅时同步删除其 `handled` 去重键，避免长期累积。
- S1：buildInteraction 区分 `{skip:true}`（elicitation 明确不自动，标记一次）与 `null`（信息暂缺，不标记、下帧可重试）。
- S2：enumerate 增加 enumRunning in-flight 锁，慢响应下不重叠。
- S4：trajectoryId 只在快照顶层保留单一数据源。
- S5：端口发现正则同时兼容 127.0.0.1 与 localhost（full_cdp 两处 + cdp-handler 一处）。
- 另修：主框架导航 Page.frameNavigated 后重置注入标记以便重注入；删除循环内未使用变量。
- 不采纳 S6（buf.slice 帧拷贝）：半包/粘包拼帧必需、频率极低，改动收益不足。
- 回归验证：冷启动零交互自动订阅全部会话、页面 0 异常 0 错误日志；Enter 发送后 1.2s 切后台，t+4s 后台 WAITING 被网络层确认（handled+1）、文件真实删除、计数长期稳定。

## 8. 性能去重 / 重复注入修复 / Manager 弹窗排查（2026-09-15，进行中）
背景：用户反馈 ① Agent Manager（独立窗口，页面 URL 前缀 `workbench-jetski-agent.html`，与 IDE 的 `workbench.html` 同源 `vscode-file://vscode-app`）里「Ask every time / Reject / Run」确认条没被自动点；② 模型响应变慢。

### 8.1 已证实并修复：重复订阅（性能根因之一）
- 每个被注入页面都各跑一套网络层。Agent Manager 与「同工作区 IDE 窗口」连**同一个 language server 端口**，于是同一 LS 的全部会话被订阅两遍（实测 12315 上 10 会话×2=20 条，全局 40 条）。模型高频流式输出时，重复的 `applyIndexed`(复制 steps 数组，大会话数百步) + `scanWaiting`(遍历) 线性放大主线程负担。
- 修复（full_cdp_script.js）：同源 `BroadcastChannel('autoall-coord-v1')` Bully 选举，**同一 LS 端口仅 id 最小且心跳活跃的页面为 leader 建订阅**，follower 零连接；leader 心跳 2s、租约 6s，崩溃/关窗自动接管；不同 LS 端口互不影响；BroadcastChannel 不可用时降级为各自订阅（旧行为，安全）。DOM 前台兜底每个窗口照跑，与 leader 网络层互为幂等双保险。
- 实测：稳态每个 LS 端口 leaders=1、totalSubs=会话数，全局去重正确。

### 8.2 已证实并修复：重复注入导致多实例「幽灵 leader」
- IIFE 原本无重入守卫。CDP 断线重连 / frameNavigated 重复注入会在**同一 JS 上下文**叠加 IIFE，旧闭包里的选举广播/状态流订阅/DOM 循环不退出：旧实例持续发 beat 压制新实例（新实例误判有更小 leader 而永不订阅），旧版本还会因此重复订阅。
- 修复：IIFE 顶部 `if(window.__autoAllTeardown) window.__autoAllTeardown()`；末尾注册 `__autoAllTeardown`（停网络层 + sessionID 递增使旧 DOM 循环退出 + 广播 yield）。实测对同一页面重复注入完整 IIFE 后，旧实例被拆除、新实例稳定成为唯一 leader（subs 正常、无幽灵、13s 不叠加）。

### 8.3 加固：runCommand 字段回退链对齐前端
- 前端确认组件 LSi 读 `step.commandLine`（空则 `command+args`）；buildInteraction 的 runCommand 改为 `runCommand||requestedInteraction.runCommand`，命令取 `proposedCommandLine||commandLine||submittedCommandLine||command+args`，空命令返回 null 等下帧、绝不盲目确认。

### 8.4 诊断仪表 netTrace（为 8.5 抓现场）
- ctx 环形缓冲（240 条）暴露到 `netDiag.trace()`：`step`(非 DONE 状态跳变，含 RUNNING→WAITING)、`wait`(到达 scanWaiting 的 WAITING 形态:req/top/hasRC)、`build`(构造结果 null/skip/banned/字段名)、`rpc`(HTTP 状态)、`leader`(选举升降)。另 netDiag 新增 isLeader/engineOn/myId/leaderInfo。

### 8.5 未闭环：Manager 的 Run 确认条（根因待定，需现场 trace）
- 已用 IDE bundle 取证：前端仅在 `step.status===WAITING` 渲染 Run/Reject（jetskiAgent/main.js 与 workbench.desktop.main.js 一致），点 Run 走 sendUserInteraction=HandleCascadeUserInteraction；前端 `p7` 也是按 indices 整体替换、后端推完整 step（排除「稀疏 patch 覆盖丢字段」假设）。
- 但首次排查时全页面订阅里 WAITING=0（时序错位，没抓到现场）。**下一步：用户复现该弹窗（先别点 Run），立即跑 agent workspace 的 `dump_trace.js`，据 trace 判断断点：step 事件有无 WAITING（流是否到达）→ wait（scanWaiting 是否看到）→ build（构造是否 null）→ rpc（确认是否 200）。**
- commit c59c7bc（本地，未 push；待 8.5 闭环后与问题1修复一起 bump 1.0.81 打包发布）。部署目录现为 `...auto-agent-antigravity-1.0.80\main_scripts\`（用户已用 1.0.80 vsix 正式安装）。

