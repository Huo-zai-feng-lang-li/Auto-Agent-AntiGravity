# 任务计划：修复 MCP 工具调用导致的任务完成通知误触发

## 背景与问题
在 Agent 调用 MCP 工具（如网页抓取、执行脚本、检索等）期间，LLM 生成暂时中断，界面 Stop 按钮可能短暂隐藏或变为 Tool Pending 状态，导致 `checkIsGenerating` 瞬时返回 `false`。若 MCP 工具执行时间超过 2.5 秒，状态机误判为任务已完全结束并发送通知。当 MCP 返回后模型继续生成，最终结束时又触发一次通知。

## 目标
1. 强化 `checkIsGenerating()`，全面覆盖 MCP/Tool Call、后台任务以及加载指示器的特征（如 `animate-spin`、`codicon-loading`、`tool-invocation`、`tool-call`、`step-running`、`data-status` 等）。
2. 在状态机中增加对 MCP / Tool Pending 执行态的识别，防止流式中断期间误判为完成。
3. 优化防抖静默期时间（调整为 3500ms 并配合持续稳定采样），杜绝 MCP 运行与调用交接过程中的虚假完成通知。
4. 升级版本至 `1.0.67`，编译打包并验证交付。

## 执行步骤
1. [ ] 修改 `main_scripts/full_cdp_script.js`：
   - 扩充 `checkIsGenerating` 中的 MCP / Tool Calling 特征匹配选择器与动画特征；
   - 改进状态机防抖逻辑与双重确认；
2. [ ] 更新 `package.json` 版本至 `1.0.67`；
3. [ ] 执行 `npm run compile` 及 `npm run package` 生成 `Auto-Agent-AntiGravity-1.0.67.vsix`；
4. [ ] 更新 `handoff.md` 归档。
