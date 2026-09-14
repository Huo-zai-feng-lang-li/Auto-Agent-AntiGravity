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
