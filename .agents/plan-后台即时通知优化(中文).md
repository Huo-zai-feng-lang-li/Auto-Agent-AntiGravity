# Plan: 后台即时通知深度优化与零误报方案

## 一、核心目标
彻底解决“必须进入 IDE 窗口才弹出通知”的问题，实现：
1. **真后台穿透感知**：无论 IDE 窗口是最小化、处于后台被其他软件遮挡还是非激活，CDP 状态机均能精准捕捉 AI 模型生成全过程。
2. **生成完毕立即弹出**：AI 停止生成并经过防抖确认（2500ms 静默）后，后台毫秒级唤起 Windows 屏幕右下角 WPF 极清通知，无需切回 IDE。
3. **100% 杜绝误通知**：过滤 UI 抖动、页面加载与中间工具调用，确保只有整轮回答/任务完成时才触发一次。

## 二、关键技术卡点与修复措施

### 1. `isElementVisible` 在后台失效问题
- **现状**：依赖了 `getBoundingClientRect()`，当 IDE 处于后台/最小化时尺寸计算为 0，导致后台判定生成状态为 `false`，生成状态机未被激活，直到用户切回 IDE 触发重新计算才弹窗。
- **修复**：
  - 生成感知器改用基于 DOM 树结构、属性与连接状态的穿透检测（`queryAll` 覆盖所有 iframe/webview，判断 `el.isConnected && !el.disabled && getComputedStyle(el).display !== 'none'`）。
  - 文本内容监听使用 `textContent` 代替 `innerText`，避免后台非活跃状态下 `innerText` 返回空字符串。

### 2. 状态机时序与防抖优化
- 引入清晰的三态状态机：`IDLE` -> `GENERATING` -> `COOLING_DOWN` -> `COMPLETED`。
- 生成中持续更新 `lastWorkTime`；生成结束（Stop 按钮/Loading 消失）进入 2500ms 静默窗口期，冷却完成即刻广播 `TASK_COMPLETED`。

### 3. 构建与端到端闭环验证
- 升级版本至 `1.0.62`。
- 测试后台生成检测逻辑与通知唤起效果。
- 重新编译并打包 VSIX 安装包。
