# Auto-Agent-AntiGravity

> 释放全自动 AI Agent 的潜能。实现真正的零干预开发。支持 Antigravity / Cursor / VS Code / Windsurf。

<p align="center">
  <img src="./media/icon.png" alt="Auto-Agent-AntiGravity Logo" width="128" />
</p>

<h1 align="center">Auto-Agent-AntiGravity</h1>

<p align="center">
  <strong>📣 释放 AI Agent 的潜能。实现真正的零干预开发。</strong>
</p>

<p align="center">
  <a href="https://github.com/Huo-zai-feng-lang-li/Auto-Agent-AntiGravity/blob/master/LICENSE">
    <img src="https://img.shields.io/github/license/Huo-zai-feng-lang-li/Auto-Agent-AntiGravity?style=for-the-badge&color=22c55e" alt="MIT 协议" />
  </a>
  <a href="https://github.com/Huo-zai-feng-lang-li/Auto-Agent-AntiGravity">
    <img src="https://img.shields.io/github/stars/Huo-zai-feng-lang-li/Auto-Agent-AntiGravity?style=for-the-badge&color=f97316" alt="GitHub Stars" />
  </a>
</p>

---

## ✨ 什么是 Auto-Agent-AntiGravity?

**Auto-Agent-AntiGravity** 是一款为 AI 辅助编程量身定制的多 IDE 扩展。它通过消除重复的“接受/确认”弹窗，彻底改变了你的 AI 编程体验。它能够自动接受文件修改、执行终端命令，并自动恢复卡住的 Agent —— 让你的 AI 能够**持续、自主、无间断地工作**。

> **✅ 100% 免费。无任何付费墙。所有功能全面开启。**

---

### 状态栏模式

扩展程序集成在状态栏中，通过直观的图标显示当前状态：

|     图标      | 模式           | 描述                                                    |
| :-----------: | :------------- | :------------------------------------------------------ |
| `$(zap) 关闭` | **已禁用**     | 扩展已关闭。点击开启。                                  |
|   `⚡ 开启`   | **单标签模式** | 仅监控当前活跃的 AI 对话标签页。                        |
|  `⚡ 多模式`  | **多标签模式** | 同时监控所有 Agent 标签页。完美适配“Agent 管理器”模式。 |

### 使用说明

1. **点击状态栏图标** 循环切换模式：`关闭 → 开启 → 多模式 → 关闭`
2. **悬停在图标上** 查看当前详细状态及打开设置面板
3. **点击“打开设置”** 进入仪表盘查看统计数据

---

### 核心特性

| 特性                     | 描述                                           |
| :----------------------- | :--------------------------------------------- |
| 🔄 **自动接受文件修改**  | 瞬间应用 AI 建议的代码变更，无需手动点击“接受” |
| 💻 **自动执行终端命令**  | 自动运行终端指令，告别繁琐的“运行”按钮点击     |
| 🔁 **Agent 自动恢复**    | 检测并自动重试卡住或失败的 AI 任务             |
| ⚡ **单/多标签灵活切换** | 支持专注单任务或多任务并行的 Agent 监控        |
| 🛡️ **安全黑名单**        | 拦截类似 `rm -rf /` 的危险操作，守护系统安全   |
| 📊 **生产力仪表盘**      | 实时可视化统计节省的点击次数和时间             |
| 🔄 **CDP 自动恢复**      | 自动检测调试协议连接状态，坏掉时一键修复       |

---

### 安全第一

自动化不代表盲目执行。内置的**安全规则**系统会拦截以下高危模式：

```text
rm -rf /
rm -rf ~
rm -rf *
format c:
del /f /s /q
rd /s /q
:(){ :|:& };:
```

✏️ **高度可定制**：你可以通过设置面板随时添加自己的过滤规则。

---

### 支持的 IDE

| IDE                | 状态     |
| :----------------- | :------- |
| ✅ **Antigravity** | 完美支持 |
| ✅ **VS Code**     | 完美支持 |
| ✅ **Cursor**      | 完美支持 |

---

## 🙏 致谢

本项目是基于 **MunKhin** 的 [auto-accept-agent](https://github.com/Munkhin/auto-accept-agent) 进行的深度优化分支。感谢原作者的基础贡献。

---

## 📜 许可证

MIT 许可证 — 永远开源，永远免费。

<p align="center">
  用 ❤️ 为 AI 开发者社区打造
</p>
