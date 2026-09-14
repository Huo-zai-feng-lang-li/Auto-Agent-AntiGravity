# 计划：单窗口多会话自动触发（性能最优版）

> ⚠️ 已废弃（2026-09-14）：本文档的「轮询切换会话标签」方案因大会话重渲染卡顿被否决，
> 最终采用事件驱动网络层方案，见同目录 `plan-网络层多会话自动确认(中文).md`。以下仅留档。

> 状态：待用户确认
> 创建时间：2026-09-14
> 关联项目：Auto-Agent-AntiGravity

## 一、目标
用户只能打开一个会话窗口查看，但希望**所有正在进行回复的会话都能自动触发确认**（Accept/Run/Apply 等），且保证性能（低 CPU、界面不狂跳）。

## 二、现状取证（基于 9000 端口 CDP 实测，信心 9）

### 2.1 多 target 结构
- 9000 端口下有 2 个独立 IDE 窗口（security-management-platform、tachyon-pinwheel），各为独立 workbench.html page。
- 扩展已分别注入所有 page，`isRunning=true`，但当前均为 `isBackgroundMode=false`（单标签模式）。

### 2.2 单窗口会话结构（security 窗口实测）
- 单个窗口内同一时刻只有一个 `#conversation` 容器挂载当前会话；**非激活会话被卸载，不在 DOM**。
- 会话切换入口：顶部 `[data-tooltip-id="history-tooltip"]` 按钮，点击弹出 "Select a conversation" 浮层。
- 浮层根元素：`div.jetski-fast-pick`（absolute z-50）。
- 列表容器：`div.flex.flex-col.gap-1.overflow-auto.overflow-y-scroll.max-h-[50vh]`。
- 分组：`Current` / `Recent in <workspace>`，每组 `div.flex.flex-col.gap-0.5`。
- **会话项**：`div.px-2.5.cursor-pointer.flex.items-center.justify-between.rounded-md.py-2`
  - 当前会话额外带：`bg-quickinput-list-focusBackground border-focus-border text-quickinput-list-focusForeground`
  - 非当前会话：`text-quickinput-foreground hover:bg-list-hover`
  - 内部：标题区 + 时间 span（`text-xs opacity-50`，如 "9 mins ago"）+ 删除按钮（lucide-trash）
- **会话项上无任何"进行中/待确认"状态标识**（无 spinner/红点/badge），无法事件驱动，只能轮询切换检查。

### 2.3 旧多标签模式失效原因
- 旧 TAB_SELECTORS（`button.grow` 等 5 个）在新版 UI 命中数全为 0。
- 旧逻辑假设会话标签常驻显示，新版改为 history 弹层式切换，架构已变。

### 2.4 共性 bug：rAF 后台卡顿
- `waitForDisappear()`（full_cdp_script.js 698-713 行）用 `requestAnimationFrame` 递归验证按钮消失。
- 页面不可见（窗口最小化/面板隐藏）时 rAF 被 Chromium 暂停，`await waitForDisappear` 永久挂起，整个 unifiedLoop 卡死，回前台才恢复。
- 这是"后台窗口不动、一激活就动"的直接根因之一。

## 三、根因总结
1. 非激活会话被卸载，不在 DOM → 必须切换到该会话才能点到 Accept。
2. 旧多标签选择器全失效 → 无法自动切换会话。
3. rAF 后台卡顿 → 后台/不可见页面循环卡死。
4. 当前为单标签模式 → 多会话逻辑未启用。

## 四、方案设计

### 4.1 核心思路
**当前会话事件驱动即时点 + 后台会话低频轮转切换检查 + 修 rAF 保活**

### 4.2 修共性 bug：rAF → setTimeout 轮询
- `waitForDisappear()` 改为纯 `setTimeout` 条件轮询（每 50ms 检查按钮是否消失，最多 500ms），不依赖 rAF。
- 保证后台/不可见页面循环不卡死。

### 4.3 新增：后台会话低频轮转检查
在 `unifiedLoop` 中，当前会话处理完后，按间隔（默认 12s，可配置）触发一次后台检查：

1. **记录原会话**：打开 history 弹层，找到当前会话项（`.bg-quickinput-list-focusBackground`）的文本/索引，记为 `originalSession`。
2. **轮转选一个后台会话**：维护 `bgCheckIndex`，每次选下一个非当前会话。
3. **切换到后台会话**：点击该会话项 div，等 800-1200ms 让 `#conversation` 渲染。
4. **执行 performClick**：扫描并点击 Accept/Run/Apply 等按钮（复用现有逻辑）。
5. **切回原会话**：再次打开 history 弹层，点击 `originalSession`，等渲染。
6. **关闭弹层**。

### 4.4 性能优化策略（关键）
- **长间隔 + 每次只查 1 个**：12s 间隔，每次只切换检查 1 个后台会话（N 个会话分 N 轮查完），避免一次切 N 个导致界面长时间抖动。
- **当前会话生成时暂停**：`isWorking()=true` 时暂停后台检查，避免切换打断当前生成或抢焦点；等当前会话空闲再查。
- **检查期间屏蔽 observer 重复触发**：设 `bgChecking=true` 标志，MutationObserver 在此期间不重复触发 actionCheck。
- **Worker 定时器控间隔**：不被后台节流。
- **切换操作本身是低频 DOM 点击**，CPU 消耗可忽略。

### 4.5 用户体验
- 后台检查时界面快速闪一下（弹层→切后台会话→点 Accept→切回），因间隔长、每次只切 1 个，影响很小。
- 切回原会话保证用户视角不变。
- 后台会话无 Accept 时，切换后立刻切回，总耗时 < 3s。

### 4.6 配置项
- `autoAll.bgSessionCheckEnabled`：启用后台会话检查（默认 true，多标签模式下生效）。
- `autoAll.bgSessionCheckInterval`：检查间隔 ms（默认 12000）。
- 设置面板 UI 后续可选加。

## 五、文件清单与改动点

### 5.1 `main_scripts/full_cdp_script.js`（核心，改动最大）
1. 修 `waitForDisappear()`：rAF → setTimeout 条件轮询。
2. 新增历史弹层操作函数：
   - `openHistoryPopup()`：点击 `[data-tooltip-id="history-tooltip"]`，等弹层出现。
   - `getConversationItems()`：在 `.jetski-fast-pick` 内找所有会话项，返回 `{element, text, isCurrent, index}`。
   - `switchToSession(item)`：点击会话项，等 `#conversation` 渲染。
   - `closeHistoryPopup()`：再点 history 按钮或发 Escape。
3. 新增 `checkBackgroundSessions()`：后台检查主函数（4.3 流程）。
4. 在 `unifiedLoop` 集成：当前会话空闲时、按间隔触发后台检查；生成时暂停。

### 5.2 `extension.js`
- `syncSessions()` 中把新配置（bgSessionCheckEnabled、bgSessionCheckInterval）加入传给 `cdpHandler.start()` 的 config。
- config 会通过 `__autoAllStart(config)` 注入页面脚本。

### 5.3 `package.json`（可选）
- `contributes.configuration.properties` 加 `autoAll.bgSessionCheckEnabled`、`autoAll.bgSessionCheckInterval` 定义。

### 5.4 `main_scripts/settings-panel.js`（可选，后续）
- 加后台多会话开关和间隔调节 UI。

## 六、验收标准
1. 单窗口开 2 个会话，会话 A（当前）空闲，会话 B 有 Accept 按钮；用户停在 A 不操作 → 12s 内自动切到 B 点掉 Accept 再切回 A，A 视角不变。
2. 会话 A 正在生成时 → 后台检查暂停，等 A 完成后再查 B。
3. 当前会话的 Accept 仍即时响应（< 1s，MutationObserver 驱动）。
4. CPU 占用无明显上升（12s 间隔，每次操作 < 3s）。
5. 窗口最小化时循环不卡死（rAF 修复验证）。
6. `node --check main_scripts/full_cdp_script.js` 通过；`npm test` 通过。
7. 打包 vsix 后在真实 Antigravity 安装验收。

## 七、风险与待确认
1. **切走会话是否暂停生成**：若切走会暂停，后台会话被切到前不会产生新 Accept，轮询切换起到"推进"作用；若不暂停，后台会话可能已完成停在 Accept，轮询只是点掉。两种情况方案均适用，但"生成时暂停后台检查"策略需根据实测微调。**实施第一步实测确认。**
2. **会话项定位稳定性**：用 `.jetski-fast-pick .cursor-pointer.rounded-md`，Tailwind 类可能随版本变。加降级：找不到 `.jetski-fast-pick` 时，用 `absolute.z-50` 弹层 + `div.cursor-pointer` 兜底。
3. **切回原会话可靠性**：用文本标识，重名时用索引；检查期间若用户手动切换了会话，检测到并放弃切回。
4. **历史弹层搜索框**：打开弹层时可能聚焦搜索 input，我们只点击会话项不输入，无影响。

## 八、执行步骤
1. 实测确认"切走会话是否暂停生成"（在两个会话各发起请求，切走观察 DOM 变化）。
2. 修 `waitForDisappear` rAF 卡顿。
3. 实现历史弹层操作函数（open/getItems/switch/close）。
4. 实现 `checkBackgroundSessions()` 主逻辑。
5. 集成进 `unifiedLoop`（间隔触发 + 生成时暂停 + bgChecking 标志）。
6. extension.js 传新配置。
7. `node --check` + `npm test`。
8. 打包 vsix，真实 Antigravity 多会话验收。
9. 独立审计（子 Agent）。
10. 同步文档（README / rules）。

## 九、不做的事（边界）
- 不改 Antigravity IDE 编译产物（高风险、不可持续）。
- 不做高频轮询（< 5s），保证性能。
- 不在当前会话生成时强制切换后台会话（避免打断）。
- 本次不加设置面板 UI（后续可选）。
