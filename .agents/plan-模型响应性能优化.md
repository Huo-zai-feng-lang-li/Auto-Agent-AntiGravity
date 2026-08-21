# 模型响应性能优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 保留全部自动确认能力，同时消除流式输出期间的高频全 DOM 扫描和重复 CDP 探测。

**Architecture:** 将渲染器检测改为 MutationObserver 事件触发、短防抖、精确选择器优先，并保留 5 秒低频兜底；宿主侧连接同步采用 singleflight 与断线触发重扫。危险命令拦截、单/多标签页和重连行为保持不变。

**Tech Stack:** VS Code Extension API、Node.js、Chrome DevTools Protocol、JavaScript。

### Task 1: 建立性能调度测试

**Files:**
- Create: `test/performance-scheduler.test.js`
- Create: `main_scripts/performance-scheduler.js`

- [ ] 写失败测试：字符流变化不触发检查、节点新增合并为一次检查、兜底扫描可执行、并发同步被合并。
- [ ] 运行测试并确认 RED。
- [ ] 实现最小调度器并确认 GREEN。

### Task 2: 替换渲染器永久全量轮询

**Files:**
- Modify: `main_scripts/full_cdp_script.js`
- Test: `test/performance-scheduler.test.js`

- [ ] 接入 MutationObserver，忽略 characterData，仅处理相关节点/属性变化。
- [ ] 单次检查只枚举一次 document/iframe，精确选择器优先，宽泛选择器仅兜底。
- [ ] 保留 5 秒安全兜底和原自动点击、黑名单功能。

### Task 3: 收敛宿主/CDP同步

**Files:**
- Modify: `extension.js`
- Modify: `main_scripts/cdp-handler.js`
- Test: `test/performance-scheduler.test.js`

- [ ] 使用递归 timeout/singleflight 防止同步重叠。
- [ ] CDP 仅在断开、报错或低频健康检查时重扫端口。
- [ ] 成功响应清理 timer，断线拒绝 pending 请求。

### Task 4: 构建、安装、验收

- [ ] 运行单测、语法检查和扩展打包。
- [ ] 安装最新本地 VSIX，重启 IDE。
- [ ] 验证 Accept/Execute/Confirm、危险命令拦截、重连和流式输出不卡顿。

## 2026-08-21 实际闭环记录

- [x] 修复 MutationObserver 启动链：使用 `getSearchRoots(true)`，并将 `observer.observe` 绑定到实际 root，消除未定义 `getDocuments/doc` 导致的循环中断。
- [x] 合并点击选择器为单次 `queryAll(selectors.join(', '))`，Antigravity 限定 Agent 面板，其他 IDE 保留通用选择器。
- [x] 使用 `findAny` 快路径检测 Send/Stop，保留 disabled Send 的完成判定，并在 DOM 变更时记录工作态，避免漏报。
- [x] `npm test`、`node --check main_scripts/full_cdp_script.js`、编译和 VSIX 打包通过；`1.0.79` 已安装并重启运行。
- [x] 真实 CDP 验收：Accept all 自动点击成功；Stop→Send 仅发出 1 条完成事件，聚焦 IDE 时宿主正确抑制通知。

> 说明：不自动提交或暂存，避免覆盖用户现有 README 暂存内容。
