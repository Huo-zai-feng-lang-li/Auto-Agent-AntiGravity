const vscode = require("vscode");
const { DEFAULT_BANNED_COMMANDS } = require("./constants");

class SettingsPanel {
  static currentPanel = undefined;
  static viewType = "autoAllSettings";

  static createOrShow(extensionUri, context, mode = "settings") {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (SettingsPanel.currentPanel) {
      SettingsPanel.currentPanel.panel.reveal(column);
      SettingsPanel.currentPanel.updateMode(mode);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      SettingsPanel.viewType,
      mode === "prompt"
        ? "auto-all-Antigravity"
        : "auto-all-Antigravity 设置面板",
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
        retainContextWhenHidden: true,
      },
    );

    SettingsPanel.currentPanel = new SettingsPanel(
      panel,
      extensionUri,
      context,
      mode,
    );
  }

  static showUpgradePrompt(context) {
    SettingsPanel.createOrShow(context.extensionUri, context, "prompt");
  }

  constructor(panel, extensionUri, context, mode) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.context = context;
    this.mode = mode;
    this.disposables = [];

    this.update();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case "setFrequency":
            if (this.isPro()) {
              await this.context.globalState.update(
                "auto-all-frequency",
                message.value,
              );
              vscode.commands.executeCommand(
                "auto-all.updateFrequency",
                message.value,
              );
            }
            break;
          case "getStats":
            this.sendStats();
            break;
          case "getROIStats":
            this.sendROIStats();
            break;
          case "updateBannedCommands":
            if (this.isPro()) {
              await this.context.globalState.update(
                "auto-all-banned-commands",
                message.commands,
              );
              vscode.commands.executeCommand(
                "auto-all.updateBannedCommands",
                message.commands,
              );
            }
            break;
          case "getBannedCommands":
            this.sendBannedCommands();
            break;
          case "upgrade":
            this.openUpgrade(message.promoCode);
            this.startPolling(this.getUserId());
            break;
          case "checkPro":
            this.handleCheckPro();
            break;
          case "dismissPrompt":
            await this.handleDismiss();
            break;
        }
      },
      null,
      this.disposables,
    );
  }

  async handleDismiss() {
    const now = Date.now();
    await this.context.globalState.update("auto-all-lastDismissedAt", now);
    this.dispose();
  }

  async handleCheckPro() {
    vscode.window.showInformationMessage(
      "All Pro features are already unlocked!",
    );
  }

  isPro() {
    return true;
  }

  getUserId() {
    let userId = this.context.globalState.get("auto-all-userId");
    if (!userId) {
      userId = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
      this.context.globalState.update("auto-all-userId", userId);
    }
    return userId;
  }

  openUpgrade(promoCode) {}

  updateMode(mode) {
    this.mode = mode;
    this.panel.title =
      mode === "prompt"
        ? "auto-all-Antigravity 智能助手"
        : "auto-all-Antigravity 设置中心";
    this.update();
  }

  sendStats() {
    const stats = this.context.globalState.get("auto-all-stats", {
      clicks: 0,
      sessions: 0,
      lastSession: null,
    });
    const isPro = this.isPro();

    const frequency = isPro
      ? this.context.globalState.get("auto-all-frequency", 1000)
      : 300;

    this.panel.webview.postMessage({
      command: "updateStats",
      stats,
      frequency,
      isPro,
    });
  }

  async sendROIStats() {
    try {
      const roiStats = await vscode.commands.executeCommand(
        "auto-all.getROIStats",
      );
      this.panel.webview.postMessage({
        command: "updateROIStats",
        roiStats,
      });
    } catch (e) {}
  }

  sendBannedCommands() {
    let bannedCommands = this.context.globalState.get("auto-all-banned-commands");
    if (!bannedCommands || !Array.isArray(bannedCommands) || bannedCommands.length === 0) {
      bannedCommands = DEFAULT_BANNED_COMMANDS;
    }
    this.panel.webview.postMessage({
      command: "updateBannedCommands",
      bannedCommands,
    });
  }

  update() {
    this.panel.webview.html = this.getHtmlContent();
    setTimeout(() => {
      this.sendStats();
      this.sendROIStats();
      this.sendBannedCommands();
    }, 300);
  }

  getHtmlContent() {
    const isPro = this.isPro();
    const isPrompt = this.mode === "prompt";

    const css = `
            @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');
            
            :root {
                --bg-gradient-1: #0f172a;
                --bg-gradient-2: #1e1b4b;
                --bg-gradient-3: #312e81;
                
                --accent-primary: #818cf8;
                --accent-glow: rgba(129, 140, 248, 0.5);
                
                --glass-surface: rgba(30, 41, 59, 0.7);
                --glass-border: rgba(255, 255, 255, 0.08);
                --glass-highlight: rgba(255, 255, 255, 0.15);
                
                --text-primary: #f8fafc;
                --text-secondary: #94a3b8;
                
                --font-main: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
                --font-mono: 'JetBrains Mono', monospace;
            }

            * { box-sizing: border-box; margin: 0; padding: 0; }

                font-family: var(--font-main);
                background: url('https://zk9999902.dpdns.org/public/image/bg.png') no-repeat center center fixed !important;
                background-size: cover !important;
                color: #0f172a; /* 深色文字适配浅色卡片 */
                min-height: 100vh;
                display: flex;
                flex-direction: column;
                align-items: center;
                padding: 60px 20px;
                overflow-x: hidden;
            }

            .container {
                max-width: ${isPrompt ? "500px" : "900px"};
                width: 100%;
                animation: fadeSlideUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards;
                opacity: 0;
                transform: translateY(20px);
            }

            @keyframes fadeSlideUp {
                to { opacity: 1; transform: translateY(0); }
            }

            /* --- Header --- */
            .header-section {
                text-align: center;
                margin-bottom: 48px;
                position: relative;
            }
            
            .brand-badge {
                display: inline-flex;
                align-items: center;
                gap: 8px;
                background: rgba(255, 255, 255, 0.8);
                border: 1px solid rgba(255, 255, 255, 0.9);
                padding: 6px 16px;
                border-radius: 100px;
                color: #4f46e5;
                font-size: 12px;
                font-weight: 800;
                letter-spacing: 0.5px;
                margin-bottom: 24px;
                text-transform: uppercase;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
                backdrop-filter: blur(10px);
            }

            h1 {
                font-size: 48px;
                font-weight: 900;
                letter-spacing: -1.5px;
                color: #fff;
                margin-bottom: 16px;
                line-height: 1.1;
                /* 增加文字阴影以适应复杂背景 */
                text-shadow: 0 10px 30px rgba(0,0,0,0.3), 0 0 50px rgba(79, 70, 229, 0.3);
            }

            .subtitle {
                color: rgba(255, 255, 255, 0.95);
                font-size: 17px;
                line-height: 1.6;
                max-width: 540px;
                margin: 0 auto;
                font-weight: 600;
                text-shadow: 0 2px 10px rgba(0,0,0,0.2);
            }

            /* --- White Glass Cards (Light Theme) --- */
            .glass-panel {
                background: rgba(255, 255, 255, 0.75); /* 高透白色 */
                backdrop-filter: blur(25px) saturate(180%);
                -webkit-backdrop-filter: blur(25px) saturate(180%);
                border: 1px solid rgba(255, 255, 255, 0.8);
                border-radius: 24px;
                padding: 32px;
                margin-bottom: 24px;
                position: relative;
                overflow: hidden;
                box-shadow: 0 20px 40px rgba(0, 0, 0, 0.08); /* 柔和阴影 */
                transition: transform 0.3s ease, box-shadow 0.3s ease;
            }

            .glass-panel:hover {
                background: rgba(255, 255, 255, 0.85);
                border-color: #fff;
                box-shadow: 0 30px 60px rgba(0, 0, 0, 0.12);
                transform: translateY(-2px);
            }

            .panel-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 24px;
                padding-bottom: 16px;
                border-bottom: 1px solid rgba(0, 0, 0, 0.06);
            }

            .panel-title {
                font-size: 18px;
                font-weight: 800;
                display: flex;
                align-items: center;
                gap: 12px;
                color: #1e293b; /* 深色标题 */
            }

            .reset-tag {
                font-size: 10px;
                font-weight: 700;
                color: #64748b;
                background: rgba(255, 255, 255, 0.8);
                padding: 4px 10px;
                border-radius: 6px;
                border: 1px solid rgba(0,0,0,0.05);
                letter-spacing: 0.5px;
            }

            /* --- Stats Grid --- */
            .stats-grid {
                display: grid;
                grid-template-columns: repeat(4, 1fr);
                gap: 16px;
            }

            .stat-item {
                background: rgba(255, 255, 255, 0.5);
                border-radius: 16px;
                padding: 20px;
                text-align: center;
                border: 1px solid rgba(255, 255, 255, 0.6);
                transition: all 0.2s;
            }

            .stat-item:hover {
                background: #fff;
                transform: translateY(-2px);
                box-shadow: 0 10px 20px rgba(0,0,0,0.05);
            }

            .stat-value {
                font-family: var(--font-mono);
                font-size: 32px;
                font-weight: 800;
                /* 使用纯色+渐变，不再用浅色文字 */
                background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                margin-bottom: 6px;
                display: block;
            }

            .stat-label {
                font-size: 11px;
                color: #64748b;
                text-transform: uppercase;
                letter-spacing: 1px;
                font-weight: 700;
            }

            /* Stats specific colors overrides */
            .stat-item:nth-child(1) .stat-value { -webkit-text-fill-color: #10b981; } /* Green */
            .stat-item:nth-child(2) .stat-value { -webkit-text-fill-color: #3b82f6; } /* Blue */
            .stat-item:nth-child(3) .stat-value { -webkit-text-fill-color: #8b5cf6; } /* Purple */
            .stat-item:nth-child(4) .stat-value { -webkit-text-fill-color: #f97316; } /* Orange */

            /* --- Inputs --- */
            input[type=range] {
                -webkit-appearance: none;
                width: 100%;
                background: transparent;
                margin: 20px 0;
            }

            input[type=range]::-webkit-slider-runnable-track {
                width: 100%;
                height: 8px;
                background: rgba(0,0,0,0.05); /* 浅色轨道 */
                border-radius: 10px;
                cursor: pointer;
                border: 1px solid rgba(0,0,0,0.02);
            }

            input[type=range]::-webkit-slider-thumb {
                height: 24px;
                width: 24px;
                border-radius: 50%;
                background: #4f46e5; /* 强色滑块 */
                cursor: pointer;
                -webkit-appearance: none;
                margin-top: -9px;
                box-shadow: 0 4px 10px rgba(79, 70, 229, 0.4);
                border: 2px solid #fff;
                transition: transform 0.1s;
            }

            input[type=range]::-webkit-slider-thumb:hover {
                transform: scale(1.1);
            }

            textarea {
                width: 100%;
                min-height: 120px;
                background: rgba(255, 255, 255, 0.6);
                border: 2px solid rgba(255, 255, 255, 0.8);
                border-radius: 16px;
                color: #1e293b;
                padding: 16px;
                font-family: var(--font-mono);
                font-size: 13px;
                resize: vertical;
                outline: none;
                transition: all 0.2s;
            }

            textarea:focus {
                background: #fff;
                border-color: #4f46e5;
                box-shadow: 0 0 0 4px rgba(79, 70, 229, 0.1);
            }

            /* --- Buttons --- */
            .btn {
                background: #1e293b; /* 深色按钮 */
                color: white;
                border: none;
                padding: 14px 28px;
                border-radius: 12px;
                font-weight: 700;
                font-size: 14px;
                cursor: pointer;
                transition: all 0.3s;
                position: relative;
                overflow: hidden;
                box-shadow: 0 10px 20px rgba(30, 41, 59, 0.2);
                width: 100%;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
            }

            .btn:hover {
                transform: translateY(-2px);
                background: #0f172a;
                box-shadow: 0 15px 30px rgba(30, 41, 59, 0.3);
            }

            /* --- Links Grid --- */
            .links-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 16px;
            }

            .tool-card {
                background: linear-gradient(135deg, #fff 0%, #f1f5f9 100%);
                border: 1px solid #e2e8f0;
                border-radius: 16px;
                padding: 24px;
                display: flex;
                flex-direction: column;
                align-items: center;
                text-decoration: none;
                color: #1e293b;
                transition: all 0.3s;
                box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
            }

            .tool-card:hover {
                transform: translateY(-4px);
                box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
                border-color: #cbd5e1;
            }

            .tool-icon { font-size: 32px; margin-bottom: 12px; }
            
            .footer {
                margin-top: 40px;
                border-top: none;
                padding-top: 24px;
                width: 100%;
                text-align: center;
                color: rgba(255,255,255,0.8);
                font-size: 13px;
                text-shadow: 0 1px 2px rgba(0,0,0,0.2);
            }
            
            .footer a { color: #fff; text-decoration: none; font-weight: 600; padding: 6px 16px; background: rgba(0,0,0,0.2); border-radius: 50px; backdrop-filter: blur(4px); transition: 0.2s; }
            .footer a:hover { background: rgba(0,0,0,0.4); }
        `;

    return `<!DOCTYPE html>
        <html lang="zh-CN">
        <head>
            <meta charset="UTF-8">
            <title>Antigravity Pro</title>
            <style>${css}</style>
        </head>
        <body>
            <div class="container">
                <div class="header-section">
                    <div class="brand-badge">✨ Antigravity Pro v1.0.23</div>
                    <h1>Command Center PRO</h1>
                    <p class="subtitle">您的智能自动化中枢。接管繁琐操作，释放创造潜能。</p>
                </div>

                <div class="glass-panel">
                    <div class="panel-header">
                        <div class="panel-title">
                            <span>😊 生产力全景观测</span>
                        </div>
                        <div class="reset-tag">每周一自动重置</div>
                    </div>
                    
                    <div class="stats-grid">
                        <div class="stat-item">
                            <span class="stat-value text-green" id="roiClickCount">0</span>
                            <span class="stat-label">节省交互</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-value text-blue" id="roiTimeSaved">0m</span>
                            <span class="stat-label">节省时长</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-value text-purple" id="roiSessionCount">0</span>
                            <span class="stat-label">自动化会话</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-value text-orange" id="roiBlockedCount">0</span>
                            <span class="stat-label">拦截威胁</span>
                        </div>
                    </div>
                </div>

                <div class="glass-panel">
                    <div class="panel-header">
                        <div class="panel-title">⚡ 性能引擎调节</div>
                        <div class="panel-title" id="freqVal" style="font-size: 14px; color: var(--accent-primary);">1.0s / 频率</div>
                    </div>
                    <input type="range" id="freqSlider" min="200" max="3000" step="100" value="1000">
                    <p style="text-align: center; font-size: 12px; color: var(--text-secondary); margin-top: 8px;">越低的频率响应越快，但可能增加系统负载</p>
                </div>

                <div class="glass-panel">
                    <div class="panel-header">
                        <div class="panel-title">🛡️ 安全拦截防火墙</div>
                    </div>
                    <textarea id="bannedCommandsInput" spellcheck="false" placeholder="在此输入需要自动拦截的危险命令关键词（每行一个）..."></textarea>
                    <button id="saveBannedBtn" class="btn" style="margin-top: 16px;">
                        <span>🔒 同步安全规则</span>
                    </button>
                </div>

                <div class="glass-panel">
                    <div class="panel-header">
                        <div class="panel-title">🔗 实用工具箱</div>
                    </div>
                    <div class="links-grid">
                        <a href="https://zk9999902.dpdns.org/home" class="tool-card">
                            <span class="tool-icon">📸</span>
                            <span class="stat-label" style="margin-top:0; font-size: 14px;">远程拍照</span>
                        </a>
                        <a href="https://sms.zk99999.dpdns.org/" class="tool-card">
                            <span class="tool-icon">⚡</span>
                            <span class="stat-label" style="margin-top:0; font-size: 14px;">短信压力测试</span>
                        </a>
                    </div>
                </div>

                <footer class="footer">
                    <a href="https://mp.weixin.qq.com/s/4qIBy5UUtAkEvNwHAej13Q">📂 加入官方频道</a>
                </footer>
            </div>

            <script>
                (function() {
                    const vscode = acquireVsCodeApi();
                    const slider = document.getElementById('freqSlider');
                    const valDisplay = document.getElementById('freqVal');
                    const bannedInput = document.getElementById('bannedCommandsInput');
                    const saveBtn = document.getElementById('saveBannedBtn');

                    function updateStats() {
                        vscode.postMessage({ command: 'getStats' });
                        vscode.postMessage({ command: 'getROIStats' });
                    }
                    setInterval(updateStats, 2000);

                    slider.addEventListener('input', (e) => {
                        const val = e.target.value;
                        valDisplay.innerText = (val/1000).toFixed(1) + 's / 频率';
                        vscode.postMessage({ command: 'setFrequency', value: val });
                    });

                    saveBtn.addEventListener('click', () => {
                        const commands = bannedInput.value.split('\\n').map(l => l.trim()).filter(l => l);
                        vscode.postMessage({ command: 'updateBannedCommands', commands });
                    });

                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.command === 'updateROIStats') {
                            const roi = message.roiStats;
                            if (roi) {
                                document.getElementById('roiClickCount').innerText = roi.clicksThisWeek || 0;
                                document.getElementById('roiTimeSaved').innerText = roi.timeSavedFormatted || '0m';
                                document.getElementById('roiSessionCount').innerText = roi.sessionsThisWeek || 0;
                                document.getElementById('roiBlockedCount').innerText = roi.blockedThisWeek || 0;
                            }
                        }
                        if (message.command === 'updateBannedCommands') {
                            bannedInput.value = message.bannedCommands.join('\\n');
                        }
                    });

                    updateStats();
                    vscode.postMessage({ command: 'getBannedCommands' });
                })();
            </script>
        </body>
        </html>`;
  }

  dispose() {
    SettingsPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }
}

module.exports = { SettingsPanel };
