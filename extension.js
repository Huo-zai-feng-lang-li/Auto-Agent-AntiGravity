const vscode = require("vscode");
const path = require("path");

const { SettingsPanel } = require("./main_scripts/settings-panel");
const {
  DEFAULT_BANNED_COMMANDS,
  DEFAULT_POLL_FREQUENCY,
} = require("./main_scripts/constants");
const {
  getCDPStartupMode,
  waitForCDP,
} = require("./main_scripts/cdp-startup-policy");
const {
  shouldNotifyTaskCompletion,
} = require("./main_scripts/notification-policy");

function getSettingsPanel() {
  return SettingsPanel;
}

const GLOBAL_STATE_KEY = "auto-all-enabled-global";
const PRO_STATE_KEY = "auto-all-isPro";
const FREQ_STATE_KEY = "auto-all-frequency";
const BANNED_COMMANDS_KEY = "auto-all-banned-commands";
const ROI_STATS_KEY = "auto-all-roi-stats";
const SECONDS_PER_CLICK = 5;

const LOCK_KEY = "auto-all-instance-lock";
const HEARTBEAT_KEY = "auto-all-instance-heartbeat";
const INSTANCE_ID = Math.random().toString(36).substring(7);

let isEnabled = false;
let isPro = false;
let isLockedOut = false;
let pollFrequency = 2000;
let bannedCommands = [];
let savedIsEnabledState = false; // 保存用户之前的状态，用于 CDP 连接成功后恢复

let backgroundModeEnabled = false;
let savedBackgroundModeState = false; // 保存用户之前的多标签模式状态
const BACKGROUND_DONT_SHOW_KEY = "auto-all-background-dont-show";
const BACKGROUND_MODE_KEY = "auto-all-background-mode";
const VERSION_7_0_KEY = "auto-all-version-7.0-notification-shown";

let pollTimer;
let statsCollectionTimer;
let statusBarItem;
let outputChannel;
let currentIDE = "unknown";
let globalContext;
let isConnectionLimited = false;

let cdpHandler;
let relauncher;
let globalTaskNotifier;

// CDP health tracking for auto-recovery
let hadCDPConnection = false;
let lastRelaunchPromptTime = 0;
const RELAUNCH_PROMPT_COOLDOWN = 60000; // 1 minute cooldown

function log(message) {
  try {
    const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
    const logLine = `[${timestamp}] ${message}`;
    console.log(logLine);
  } catch (e) {
    console.error("Logging failed:", e);
  }
}

function detectIDE() {
  const appName = vscode.env.appName || "";
  const nameLow = appName.toLowerCase();
  if (nameLow.includes("cursor")) return "Cursor";
  if (nameLow.includes("antigravity")) return "Antigravity";
  if (nameLow.includes("windsurf")) return "Windsurf";
  if (nameLow.includes("trae")) return "Trae";
  return "Code";
}

async function activate(context) {
  globalContext = context;
  console.log("Auto-Agent-AntiGravity: Activator called.");

  try {
    statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    statusBarItem.command = "auto-all.cycleState";
    statusBarItem.text = "$(zap) 关闭";
    statusBarItem.tooltip = "Auto-Agent-AntiGravity: Loading...";
    context.subscriptions.push(statusBarItem);
    // 始终显示状态栏，让用户知道连接状态
    statusBarItem.show();

    console.log("Auto-Agent-AntiGravity: Status bar item created and shown.");
  } catch (sbError) {
    console.error("CRITICAL: Failed to create status bar items:", sbError);
  }

  try {
    // 保存用户之前的状态，但不立即恢复（等 CDP 连接成功后再恢复）
    savedIsEnabledState = context.globalState.get(GLOBAL_STATE_KEY, false);
    isEnabled = false; // 先设为关闭，等 CDP 连接成功后再根据保存的状态决定
    isPro = context.globalState.get(PRO_STATE_KEY, false);
    isPro = true;

    if (isPro) {
      pollFrequency = context.globalState.get(FREQ_STATE_KEY, 1000);
    } else {
      pollFrequency = 300;
    }

    // 保存多标签模式状态，但不立即恢复
    savedBackgroundModeState = context.globalState.get(
      BACKGROUND_MODE_KEY,
      false,
    );
    backgroundModeEnabled = false; // 先设为关闭，等 CDP 连接成功后再恢复

    const config = vscode.workspace.getConfiguration("auto-all");
    bannedCommands = context.globalState.get(
      BANNED_COMMANDS_KEY,
      config.get("bannedCommands", DEFAULT_BANNED_COMMANDS),
    );

    currentIDE = detectIDE();

    outputChannel = vscode.window.createOutputChannel("Auto-Agent-AntiGravity");
    context.subscriptions.push(outputChannel);

    log(`Auto-Agent-AntiGravity: Activating...`);
    log(
      `Auto-Agent-AntiGravity: Detected environment: ${currentIDE.toUpperCase()}`,
    );

    vscode.window.onDidChangeWindowState(async (e) => {
      if (cdpHandler && cdpHandler.setFocusState) {
        await cdpHandler.setFocusState(e.focused);
      }

      if (e.focused && isEnabled) {
        log(
          `[Away] Window focus detected by VS Code API. Checking for away actions...`,
        );

        setTimeout(() => checkForAwayActions(context), 500);
      }
    });

    try {
      const { CDPHandler } = require("./main_scripts/cdp-handler");
      const {
        Relauncher,
        BASE_CDP_PORT,
      } = require("./main_scripts/relauncher");
      const { TaskNotifier } = require("./main_scripts/taskNotifier");
      globalTaskNotifier = new TaskNotifier(log);

      // Reduce scan range for faster startup check (9000-9002 is usually enough to know if it's working)
      cdpHandler = new CDPHandler(BASE_CDP_PORT, BASE_CDP_PORT + 2, log);
      if (cdpHandler.setProStatus) {
        cdpHandler.setProStatus(isPro);
      }

      // 仅在 AI 模型回答完成且 IDE 失焦时发送全局置顶通知
      let lastCompletedNotifyTime = 0;
      cdpHandler.setOnTaskCompletedCallback(() => {
        const config = vscode.workspace.getConfiguration("auto-all");
        const notifyEnabled = globalContext.globalState.get(
          "auto-all-notify-enabled",
          config.get("enableNotification", true)
        );
        const now = Date.now();
        const isFocused = vscode.window.state.focused;
        const shouldNotify = shouldNotifyTaskCompletion({
          notifyEnabled,
          isFocused,
          now,
          lastNotifiedAt: lastCompletedNotifyTime,
          cooldownMs: 5000,
        });

        if (!shouldNotify) {
          if (!notifyEnabled) {
            log("[Event] TASK_COMPLETED ignored because notifications are disabled.");
          } else if (isFocused) {
            log("[Event] TASK_COMPLETED ignored because the IDE is focused.");
          } else {
            log("[Event] TASK_COMPLETED notification throttled (within 5s cooldown).");
          }
          return;
        }
        lastCompletedNotifyTime = now;

        log("[Event] Triggering desktop notification for task completion");
        const notifyStyle = globalContext.globalState.get("auto-all-notify-style", "image");
        globalTaskNotifier.notify({
          title: "🎉 任务完成",
          message: "思考与生成已完成 · 点击切回 IDE",
          playSound: true,
          style: notifyStyle,
        });
      });

      try {
        const logPath = path.join(context.extensionPath, "auto-all-cdp.log");
        cdpHandler.setLogFile(logPath);
        log(`CDP logging to: ${logPath}`);
      } catch (e) {
        log(`Failed to set log file: ${e.message}`);
      }

      relauncher = new Relauncher(log);
      log(`CDP handlers initialized for ${currentIDE}.`);
    } catch (err) {
      log(`Failed to initialize CDP handlers: ${err.message}`);
      vscode.window.showErrorMessage(
        `Auto-Agent-AntiGravity 错误: ${err.message}`,
      );
    }

    updateStatusBar();
    log("Status bar updated with current state.");

    context.subscriptions.push(
      vscode.commands.registerCommand("auto-all.toggle", () =>
        handleToggle(context),
      ),
      vscode.commands.registerCommand("auto-all.cycleState", () =>
        handleCycleState(context),
      ),
      vscode.commands.registerCommand("auto-all.relaunch", () =>
        handleRelaunch(),
      ),
      vscode.commands.registerCommand("auto-all.toggleNotification", async () => {
        const config = vscode.workspace.getConfiguration("auto-all");
        const current = context.globalState.get(
          "auto-all-notify-enabled",
          config.get("enableNotification", true)
        );
        const nextState = !current;
        await context.globalState.update("auto-all-notify-enabled", nextState);
        try {
          await config.update("enableNotification", nextState, vscode.ConfigurationTarget.Global);
        } catch (e) {}
        vscode.window.showInformationMessage(
          `Auto-Agent-AntiGravity: 任务完成桌面通知已 ${nextState ? "开启 🔔" : "关闭 🔕"}`
        );
      }),
      vscode.commands.registerCommand("auto-all.updateFrequency", (freq) =>
        handleFrequencyUpdate(context, freq),
      ),
      vscode.commands.registerCommand("auto-all.toggleBackground", () =>
        handleBackgroundToggle(context),
      ),
      vscode.commands.registerCommand(
        "auto-all.updateBannedCommands",
        (commands) => handleBannedCommandsUpdate(context, commands),
      ),
      vscode.commands.registerCommand(
        "auto-all.getBannedCommands",
        () => bannedCommands,
      ),
      vscode.commands.registerCommand("auto-all.getROIStats", async () => {
        const stats = await loadROIStats(context);
        let liveStats = { clicks: 0, blocked: 0 };

        if (cdpHandler) {
          try {
            liveStats = await cdpHandler.getStats();
          } catch (e) {
            log(`Failed to get live stats: ${e.message}`);
          }
        }

        const totalClicks = stats.clicksThisWeek + (liveStats.clicks || 0);
        const totalBlocked = stats.blockedThisWeek + (liveStats.blocked || 0);

        const timeSavedSeconds = totalClicks * SECONDS_PER_CLICK;
        const timeSavedMinutes = Math.round(timeSavedSeconds / 60);

        return {
          clicksThisWeek: totalClicks,
          blockedThisWeek: totalBlocked,
          sessionsThisWeek: stats.sessionsThisWeek,
          timeSavedMinutes,
          timeSavedFormatted:
            timeSavedMinutes >= 60
              ? `${(timeSavedMinutes / 60).toFixed(1)}小时`
              : `${timeSavedMinutes}分钟`,
        };
      }),
      vscode.commands.registerCommand("auto-all.openSettings", () => {
        const panel = getSettingsPanel();
        if (panel) {
          panel.createOrShow(context.extensionUri, context);
        } else {
          vscode.window.showErrorMessage("Failed to load Settings Panel.");
        }
      }),
      vscode.commands.registerCommand("auto-all.resetCDPSettings", async () => {
        await context.globalState.update(CDP_SKIP_PROMPT_KEY, false);
        vscode.window.showInformationMessage(
          "✅ CDP 设置已重置。下次启动 IDE 时将重新提示配置。",
        );
      }),
    );

    try {
      await checkEnvironmentAndStart();
    } catch (err) {
      log(`Error in environment check: ${err.message}`);
    }

    showVersionNotification(context);

    log("Auto-Agent-AntiGravity: Activation complete");
  } catch (error) {
    console.error("ACTIVATION CRITICAL FAILURE:", error);
    log(`ACTIVATION CRITICAL FAILURE: ${error.message}`);
    vscode.window.showErrorMessage(
      `Auto-Agent-AntiGravity 激活失败: ${error.message}`,
    );
  }
}

async function ensureCDPOrPrompt(showPrompt = false) {
  if (!cdpHandler) return;

  log("Checking for active CDP session...");
  const cdpAvailable = await cdpHandler.isCDPAvailable();
  log(`Environment check: CDP Available = ${cdpAvailable}`);

  if (cdpAvailable) {
    log("CDP is active and available.");
  } else {
    log("CDP not found on expected ports (9000-9030).");

    if (showPrompt && relauncher) {
      log("Prompting user for relaunch...");
      await relauncher.showRelaunchPrompt();
    } else {
      log(
        "Skipping relaunch prompt (startup). User can click status bar to trigger.",
      );
    }
  }
}

const CDP_SKIP_PROMPT_KEY = "auto-all-cdp-skip-prompt";
const CDP_REGISTRY_CONFIGURED_KEY = "auto-all-cdp-registry-configured";
const CDP_PORT = 9000;

/**
 * 配置 Windows 注册表，让所有启动方式都带上 CDP 参数
 * 增强逻辑：尝试从快捷方式同步完整参数（包括 GPU 设置等），实现参数继承
 */
async function configureWindowsRegistry() {
  if (process.platform !== "win32") {
    log("Not Windows, skipping registry configuration.");
    return { success: false, reason: "not-windows" };
  }

  const ideName = currentIDE.toLowerCase();
  const registryPaths = [
    `HKCU\\Software\\Classes\\${ideName}\\shell\\open\\command`,
    `HKCU\\Software\\Classes\\${ideName}-url\\shell\\open\\command`,
    `HKCU\\Software\\Classes\\Applications\\${ideName}.exe\\shell\\open\\command`,
  ];

  const { execSync } = require("child_process");
  let configured = false;

  // 1. 尝试从快捷方式获取“完美参数串”（包含 GPU 参数、CDP 参数等）
  let bestArgs = null;
  if (relauncher) {
    try {
      const shortcuts = await relauncher.findIDEShortcuts();
      // 找一个参数最长的快捷方式，通常意味着包含用户配置
      const richShortcut = shortcuts
        .filter((s) => s.args && s.args.length > 0)
        .sort((a, b) => b.args.length - a.args.length)[0];

      if (richShortcut) {
        log(`Found rich shortcut arguments to sync: ${richShortcut.args}`);
        bestArgs = richShortcut.args;
      }
    } catch (e) {
      log(`Error fetching shortcut args: ${e.message}`);
    }
  }

  // 如果没找到快捷方式参数，使用默认的 CDP 参数
  if (!bestArgs) {
    bestArgs = `--remote-debugging-port=${CDP_PORT}`;
  }

  // 确保参数里肯定有 CDP 端口
  if (!bestArgs.includes("--remote-debugging-port")) {
    bestArgs = `--remote-debugging-port=${CDP_PORT} ${bestArgs}`;
  }

  for (const regPath of registryPaths) {
    try {
      // 读取当前注册表值
      const result = execSync(`reg query "${regPath}" /ve`, {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"], // 忽略 stderr 防止抛错中断
      });

      // 解析当前命令
      const match = result.match(/REG_SZ\s+(.+)/);
      if (!match) continue;

      let currentCmd = match[1].trim();

      // 提取 EXE 路径
      const exeMatch = currentCmd.match(/^(".*?\.exe"|[^ ]+\.exe)/i);
      if (exeMatch) {
        const exePath = exeMatch[1];

        // 构造新命令：EXE + 完美参数 + "%1"
        // 注意：注册表里的 %1 代表文件路径，必须保留
        const newCmd = `${exePath} ${bestArgs} "%1"`.trim();

        if (currentCmd === newCmd) {
          log(`Registry ${regPath} is already perfect.`);
          continue;
        }

        // Use reg.exe instead of PowerShell for instant execution (no startup delay)
        // Note: reg add /ve means set (Default) value. /d is data. /f is force overwrite.
        // We need to be careful with quotes in the command string.
        try {
          // Escape quotes for cmd/reg: double quote becomes backslash-quote or recursive quoting
          // But execSync takes a string. simple approach: use single quotes for JS string, and care internal quotes
          // actually reg.exe expects quotes around the value if it contains spaces.
          // Command: reg add "Path" /ve /d "NewCmd" /f
          const safeCmdProp = newCmd.replace(/"/g, '\\"');
          const regAddCmd = `reg add "${regPath}" /ve /d "${safeCmdProp}" /f`;

          execSync(regAddCmd, {
            encoding: "utf8",
            timeout: 5000,
            stdio: "ignore" 
          });
          log(`Updated registry: ${regPath} => ${bestArgs}`);
          configured = true;
        } catch (writeErr) {
          // 忽略写入错误，可能是没有该键值
        }
      }
    } catch (e) {
      // reg query 失败通常意味着键不存在，忽略
    }
  }

  return {
    success: configured,
    reason: configured ? "configured" : "no-paths-found",
  };
}

async function checkEnvironmentAndStart() {
  isConnectionLimited = false;
  log("Initializing Auto-Agent-AntiGravity environment...");

  // CDP may start slightly after the extension host. Give it a short grace period.
  const cdpAvailable = await waitForCDP(cdpHandler);
  log(`CDP availability check: ${cdpAvailable}`);

  if (cdpAvailable) {
    // CDP 可用，标记注册表已配置（可能是用户手动配置的）
    await globalContext.globalState.update(CDP_REGISTRY_CONFIGURED_KEY, true);
    log("CDP available. Extension ready to work.");

    // 标记 CDP 已连接成功
    hadCDPConnection = true;

    // CDP 连接成功后，恢复用户之前保存的状态
    if (savedIsEnabledState) {
      isEnabled = true;
      backgroundModeEnabled = savedBackgroundModeState;
      log(
        `CDP connected. Restored previous state: enabled=${isEnabled}, backgroundMode=${backgroundModeEnabled}`,
      );
    }

    // CDP 连接成功，显示状态栏
    if (statusBarItem) {
      statusBarItem.show();
      log("Status bar shown after CDP connection.");
    }
  } else if (relauncher) {
    // CDP 不可用
    const registryConfigured = globalContext.globalState.get(
      CDP_REGISTRY_CONFIGURED_KEY,
      false,
    );
    const skipPrompt = globalContext.globalState.get(
      CDP_SKIP_PROMPT_KEY,
      false,
    );
    const startupMode = getCDPStartupMode({
      cdpAvailable,
      registryConfigured,
      skipPrompt,
    });

    if (startupMode === "repair") {
      // 注册表虽然标记为已配置，但 CDP 依然不通。
      // 可能性 1: IDE 更新导致注册表被重置 (高频场景)
      // 可能性 2: 用户通过命令行或其他不走注册表的方式启动 (常见场景)

      log(
        "Registry marked configured but CDP dead. Initiating active specific repair...",
      );

      // 尝试再次检测并修复注册表
      const repairResult = await configureWindowsRegistry();

      if (repairResult.success) {
        // 这里的 success=true 意味着我们刚刚执行了写入操作 (发现注册表里缺参数)
        // 说明环境确实坏了（通常是 IDE 更新导致的），现在修好了
        log("Active Repair: Registry was broken and has been fixed.");

        vscode.window
          .showWarningMessage(
            "⚡ Auto-Agent: 检测到连接参数丢失（可能是 IDE 更新导致），已尝试自动修复。",
            "立即重启生效",
          )
          .then((selection) => {
            if (selection === "立即重启生效") handleRelaunch();
          });
      } else {
        // 注册表看起来是好的，但还是不通。说明启动方式绕过了注册表 (如 code . 或 第三方工具)
        log(
          "Active Repair: Registry looks fine. Launch method likely bypassed it.",
        );

        // 给用户一个显式的修复入口，而不是只改状态栏
        vscode.window
          .showInformationMessage(
            "⚡ Auto-Agent: 当前启动方式未包含智能连接参数，AI 自动化将受限。",
            "重启并修复",
            "忽略",
          )
          .then((selection) => {
            if (selection === "重启并修复") handleRelaunch();
          });

        // 同时也显示在状态栏
        // vscode.window.setStatusBarMessage(
        //   "⚡ auto-all: 连接受限 (点击状态栏修复)",
        //   8000,
        // );
        isConnectionLimited = true;
      }
    } else if (startupMode === "limited") {
      log(
        "CDP not available, but user chose to skip. Running in limited mode.",
      );
      vscode.window.setStatusBarMessage(
        "⚡ auto-all: CDP 未启用，部分功能受限",
        5000,
      );
      // CDP 不可用时不显示状态栏
    } else {
      // 首次安装：自动配置注册表并重启
      log("First time setup: Configuring registry and restarting...");

      vscode.window.showInformationMessage(
        "⚡ Auto-Agent-AntiGravity: 首次配置中，将自动重启一次以启用完整功能...",
      );

      // 1. 配置注册表
      const regResult = await configureWindowsRegistry();
      log(`Registry configuration result: ${JSON.stringify(regResult)}`);

      // 2. 标记已配置
      await globalContext.globalState.update(CDP_REGISTRY_CONFIGURED_KEY, true);

      // 3. 重启 IDE
      const result = await relauncher.relaunchWithCDP();
      if (result.success && result.action === "relaunched") {
        log("First-time relaunch initiated. This should only happen once!");
        return;
      } else if (!result.success) {
        log(`Auto-relaunch failed: ${result.message}`);
        // 即使重启失败，也标记为已配置，避免重复尝试
        vscode.window.showWarningMessage(
          `⚠️ 自动配置失败: ${result.message}\n\n请手动在快捷方式目标后添加 --remote-debugging-port=9000 参数。`,
        );
      }
    }
  }

  // Only start polling if enabled
  if (isEnabled) {
    await startPolling();
    startStatsCollection(globalContext);

    // [Self-Healing] 静默自愈机制
    // 如果当前 CDP 是通的，说明我们有权限。
    // 此时要“趁机”把注册表和所有快捷方式都修一遍，防止 IDE 更新导致断链。
    if (cdpAvailable) {
      setTimeout(async () => {
        log("[Self-Healing] Starting silent environment repair...");
        try {
          // 1. 修复注册表 (覆盖双击文件打开的场景)
          await configureWindowsRegistry();

          // 2. 修复所有快捷方式 (覆盖任务栏、桌面混用的场景)
          if (relauncher) {
            const fixedCount = await relauncher.configureAllShortcuts();
            if (fixedCount > 0) {
              log(`[Self-Healing] Silently fixed ${fixedCount} shortcuts.`);
            }
          }
          log("[Self-Healing] Repair complete. Persistence ensured.");
        } catch (e) {
          log(`[Self-Healing] Failed: ${e.message}`);
        }
      }, 5000); // 延时 5 秒，避免拖慢启动速度
    }
  }
  updateStatusBar();
}

async function handleToggle(context) {
  log("=== handleToggle CALLED ===");
  log(`  Previous isEnabled: ${isEnabled}`);

  try {
    isEnabled = !isEnabled;
    log(`  New isEnabled: ${isEnabled}`);

    await context.globalState.update(GLOBAL_STATE_KEY, isEnabled);
    log(`  GlobalState updated`);

    log("  Calling updateStatusBar...");
    updateStatusBar();

    if (isEnabled) {
      log("Auto-Agent-AntiGravity: Enabled");

      ensureCDPOrPrompt(true).then(() => startPolling());
      startStatsCollection(context);
      incrementSessionCount(context);
    } else {
      log("Auto-Agent-AntiGravity: Disabled");

      if (cdpHandler) {
        cdpHandler
          .getSessionSummary()
          .then((summary) => showSessionSummaryNotification(context, summary))
          .catch(() => {});
      }

      collectAndSaveStats(context).catch(() => {});
      stopPolling().catch(() => {});
      hadCDPConnection = false; // Reset for next session
    }

    log("=== handleToggle COMPLETE ===");
  } catch (e) {
    log(`Error toggling: ${e.message}`);
    log(`Error stack: ${e.stack}`);
  }
}

async function handleRelaunch() {
  // 重启前强制设置为开启状态，确保重启后自动连接
  if (globalContext) {
    await globalContext.globalState.update(GLOBAL_STATE_KEY, true);
    isEnabled = true; // 立即更新内存状态
  }

  if (!relauncher) {
    vscode.window.showErrorMessage("重启器未初始化。");
    return;
  }

  log("Initiating Relaunch...");
  const result = await relauncher.relaunchWithCDP();
  if (!result.success) {
    vscode.window.showErrorMessage(`重启失败: ${result.message}`);
  }
}

async function handleFrequencyUpdate(context, freq) {
  pollFrequency = freq;
  await context.globalState.update(FREQ_STATE_KEY, freq);
  log(`Poll frequency updated to: ${freq}ms`);
  if (isEnabled) {
    await syncSessions();
  }
}

async function handleBannedCommandsUpdate(context, commands) {
  if (!isPro) {
    log("Banned commands customization requires Pro");
    return;
  }
  bannedCommands = Array.isArray(commands) ? commands : [];
  await context.globalState.update(BANNED_COMMANDS_KEY, bannedCommands);
  log(`Banned commands updated: ${bannedCommands.length} patterns`);
  if (bannedCommands.length > 0) {
    log(
      `Banned patterns: ${bannedCommands.slice(0, 5).join(", ")}${bannedCommands.length > 5 ? "..." : ""}`,
    );
  }
  if (isEnabled) {
    await syncSessions();
  }
}

async function handleBackgroundToggle(context) {
  log("Background toggle clicked");

  if (!isPro) {
    vscode.window
      .showInformationMessage("多标签模式是高级功能。", "了解更多")
      .then((choice) => {
        if (choice === "了解更多") {
          const panel = getSettingsPanel();
          if (panel) panel.createOrShow(context.extensionUri, context);
        }
      });
    return;
  }

  const dontShowAgain = context.globalState.get(
    BACKGROUND_DONT_SHOW_KEY,
    false,
  );

  if (!dontShowAgain && !backgroundModeEnabled) {
    const choice = await vscode.window.showInformationMessage(
      "开启多标签模式？\n\n" +
        "这将允许扩展同时在所有开启的对话标签页中工作。" +
        "它会自动切换标签页为您点击“接受”。\n\n" +
        "在工作期间，您可能会看到标签页快速切换。",
      { modal: true },
      "开启",
      "不再显示并开启",
      "取消",
    );

    if (choice === "取消" || !choice) {
      log("Background mode cancelled by user");
      return;
    }

    if (choice === "不再显示并开启") {
      await context.globalState.update(BACKGROUND_DONT_SHOW_KEY, true);
      log("Background mode: Dont show again set");
    }

    backgroundModeEnabled = true;
    await context.globalState.update(BACKGROUND_MODE_KEY, true);
    log("Background mode enabled");
  } else {
    backgroundModeEnabled = !backgroundModeEnabled;
    await context.globalState.update(
      BACKGROUND_MODE_KEY,
      backgroundModeEnabled,
    );
    log(`Background mode toggled: ${backgroundModeEnabled}`);

    if (!backgroundModeEnabled && cdpHandler) {
      cdpHandler.hideBackgroundOverlay().catch(() => {});
    }
  }

  updateStatusBar();

  if (isEnabled) {
    syncSessions().catch(() => {});
  }
}

async function handleCycleState(context) {
  log("=== handleCycleState CALLED ===");
  log(
    `  Current state: isEnabled=${isEnabled}, backgroundModeEnabled=${backgroundModeEnabled}`,
  );

  // Cycle: OFF → ON+Single → ON+Multi → OFF
  if (!isEnabled) {
    // OFF → ON + Single Tab
    isEnabled = true;
    backgroundModeEnabled = false;
    await context.globalState.update(GLOBAL_STATE_KEY, true);
    await context.globalState.update(BACKGROUND_MODE_KEY, false);
    log("  Cycled to: ON + Single Tab");

    ensureCDPOrPrompt(true).then(() => startPolling());
    startStatsCollection(context);
    incrementSessionCount(context);
  } else if (!backgroundModeEnabled) {
    // ON + Single → ON + Multi-Tab
    backgroundModeEnabled = true;
    await context.globalState.update(BACKGROUND_MODE_KEY, true);
    log("  Cycled to: ON + Multi-Tab");

    if (isEnabled) {
      syncSessions().catch(() => {});
    }
  } else {
    // ON + Multi-Tab → OFF
    isEnabled = false;
    backgroundModeEnabled = false;
    await context.globalState.update(GLOBAL_STATE_KEY, false);
    await context.globalState.update(BACKGROUND_MODE_KEY, false);
    log("  Cycled to: OFF");

    if (cdpHandler) {
      cdpHandler
        .getSessionSummary()
        .then((summary) => showSessionSummaryNotification(context, summary))
        .catch(() => {});
      cdpHandler.hideBackgroundOverlay().catch(() => {});
    }

    collectAndSaveStats(context).catch(() => {});
    stopPolling().catch(() => {});
    hadCDPConnection = false; // Reset for next session
  }

  updateStatusBar();
  log("=== handleCycleState COMPLETE ===");
}

async function syncSessions() {
  if (cdpHandler && !isLockedOut) {
    log(
      `CDP: Syncing sessions (Mode: ${backgroundModeEnabled ? "Background" : "Simple"})...`,
    );
    try {
      await cdpHandler.start({
        isPro,
        isBackgroundMode: backgroundModeEnabled,
        pollInterval: pollFrequency,
        ide: currentIDE,
        bannedCommands: bannedCommands,
      });

      // CDP health check for auto-recovery
      const connectionCount = cdpHandler.getConnectionCount();

      if (connectionCount > 0) {
        hadCDPConnection = true;
      } else if (hadCDPConnection && isEnabled) {
        // We HAD connections but lost them - Antigravity probably restarted without CDP
        const now = Date.now();
        if (now - lastRelaunchPromptTime > RELAUNCH_PROMPT_COOLDOWN) {
          lastRelaunchPromptTime = now;
          log(
            "CDP connection lost! Antigravity may have restarted. Prompting for relaunch...",
          );
          if (relauncher) {
            relauncher.showRelaunchPrompt();
          }
        }
      }
    } catch (err) {
      log(`CDP: Sync error: ${err.message}`);
    }
  }
}

async function startPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  log("Auto-Agent-AntiGravity: Monitoring session...");

  const poll = async () => {
    if (!isEnabled) {
      pollTimer = undefined;
      return;
    }

    const lockKey = `${currentIDE.toLowerCase()}-instance-lock`;
    const activeInstance = globalContext.globalState.get(lockKey);
    const myId = globalContext.extension.id;

    if (activeInstance && activeInstance !== myId) {
      const lastPing = globalContext.globalState.get(`${lockKey}-ping`);
      if (lastPing && Date.now() - lastPing < 15000) {
        if (!isLockedOut) {
          log(
            `CDP Control: Locked by another instance (${activeInstance}). Standby mode.`,
          );
          isLockedOut = true;
          updateStatusBar();
        }
        pollTimer = setTimeout(poll, 5000);
        return;
      }
    }

    globalContext.globalState.update(lockKey, myId);
    globalContext.globalState.update(`${lockKey}-ping`, Date.now());

    if (isLockedOut) {
      log("CDP Control: Lock acquired. Resuming control.");
      isLockedOut = false;
      updateStatusBar();
    }

    await syncSessions();
    const delay = cdpHandler?.getConnectionCount() > 0 ? 30000 : 5000;
    pollTimer = setTimeout(poll, delay);
  };

  await poll();
}

async function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (statsCollectionTimer) {
    clearInterval(statsCollectionTimer);
    statsCollectionTimer = null;
  }
  if (cdpHandler) await cdpHandler.stop();
  log("Auto-Agent-AntiGravity: Polling stopped");
}

function getWeekStart() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const diff = now.getDate() - dayOfWeek;
  const weekStart = new Date(now.setDate(diff));
  weekStart.setHours(0, 0, 0, 0);
  return weekStart.getTime();
}

async function loadROIStats(context) {
  const defaultStats = {
    weekStart: getWeekStart(),
    clicksThisWeek: 0,
    blockedThisWeek: 0,
    sessionsThisWeek: 0,
  };

  let stats = context.globalState.get(ROI_STATS_KEY, defaultStats);

  const currentWeekStart = getWeekStart();
  if (stats.weekStart !== currentWeekStart) {
    log(`ROI Stats: New week detected. Showing summary and resetting.`);

    if (stats.clicksThisWeek > 0) {
      await showWeeklySummaryNotification(context, stats);
    }

    stats = { ...defaultStats, weekStart: currentWeekStart };
    await context.globalState.update(ROI_STATS_KEY, stats);
  }

  return stats;
}

async function showWeeklySummaryNotification(context, lastWeekStats) {
  const timeSavedSeconds = lastWeekStats.clicksThisWeek * SECONDS_PER_CLICK;
  const timeSavedMinutes = Math.round(timeSavedSeconds / 60);

  let timeStr;
  if (timeSavedMinutes >= 60) {
    timeStr = `${(timeSavedMinutes / 60).toFixed(1)} hours`;
  } else {
    timeStr = `${timeSavedMinutes} minutes`;
  }

  const message = `📊 上周，Auto-Agent-AntiGravity 通过自动点击 ${lastWeekStats.clicksThisWeek} 个按钮，为你节省了约 ${timeStr}！`;

  let detail = "";
  if (lastWeekStats.sessionsThisWeek > 0) {
    detail += `恢复了 ${lastWeekStats.sessionsThisWeek} 个卡住的会话。`;
  }
  if (lastWeekStats.blockedThisWeek > 0) {
    detail += `拦截了 ${lastWeekStats.blockedThisWeek} 个危险命令。`;
  }

  const choice = await vscode.window.showInformationMessage(
    message,
    { detail: detail.trim() || undefined },
    "查看详情",
  );

  if (choice === "查看详情") {
    const panel = getSettingsPanel();
    if (panel) {
      panel.createOrShow(context.extensionUri, context);
    }
  }
}

async function showSessionSummaryNotification(context, summary) {
  log(
    `[Notification] showSessionSummaryNotification called with: ${JSON.stringify(summary)}`,
  );
  if (!summary || summary.clicks === 0) {
    log(`[Notification] Session summary skipped: no clicks`);
    return;
  }
  log(`[Notification] Showing session summary for ${summary.clicks} clicks`);

  const lines = [
    `✅ 本次运行统计:`,
    `• ${summary.clicks} 次自动操作`,
    `• ${summary.terminalCommands} 个终端命令`,
    `• ${summary.fileEdits} 次文件修改`,
    `• ${summary.blocked} 次干扰拦截`,
  ];

  if (summary.estimatedTimeSaved) {
    lines.push(`\n⏱ 预计节省时间: ~${summary.estimatedTimeSaved}分钟`);
  }

  const message = lines.join("\n");

  vscode.window
    .showInformationMessage(
      `🤖 Auto-Agent-AntiGravity: 本次会话处理了 ${summary.clicks} 个动作`,
      { detail: message },
      "查看统计",
    )
    .then((choice) => {
      if (choice === "查看统计") {
        const panel = getSettingsPanel();
        if (panel) panel.createOrShow(context.extensionUri, context);
      }
    });
}

async function showAwayActionsNotification(context, actionsCount) {
  // 用户明确要求：不需要离开期间处理动作的通知，仅保留模型回复完成通知
  log(
    `[Notification] showAwayActionsNotification skipped by user preference (count: ${actionsCount})`,
  );
}

async function showBackgroundModeUpsell(context) {
  if (isPro) return;

  const UPSELL_COOLDOWN_KEY = "auto-all-bg-upsell-last";
  const UPSELL_COOLDOWN_MS = 1000 * 60 * 30;

  const lastUpsell = context.globalState.get(UPSELL_COOLDOWN_KEY, 0);
  const now = Date.now();

  if (now - lastUpsell < UPSELL_COOLDOWN_MS) return;

  await context.globalState.update(UPSELL_COOLDOWN_KEY, now);

  const choice = await vscode.window.showInformationMessage(
    `💡 Auto-Agent-AntiGravity 本可以自动处理此标签页切换。`,
    { detail: "开启多标签模式，让所有 Agent 并行工作，无需手动切换标签页。" },
    "开启多标签模式",
    "暂不开启",
  );

  if (choice === "开启多标签模式") {
    const panel = getSettingsPanel();
    if (panel) panel.createOrShow(context.extensionUri, context);
  }
}

let lastAwayCheck = Date.now();
async function checkForAwayActions(context) {
  log(
    `[Away] checkForAwayActions called. cdpHandler=${!!cdpHandler}, isEnabled=${isEnabled}`,
  );
  if (!cdpHandler || !isEnabled) {
    log(
      `[Away] Skipping check: cdpHandler=${!!cdpHandler}, isEnabled=${isEnabled}`,
    );
    return;
  }

  try {
    log(`[Away] Calling cdpHandler.getAwayActions()...`);
    const awayActions = await cdpHandler.getAwayActions();
    log(`[Away] Got awayActions: ${awayActions}`);
    if (awayActions > 0) {
      log(
        `[Away] Detected ${awayActions} actions while user was away. Showing notification...`,
      );
      await showAwayActionsNotification(context, awayActions);
    } else {
      log(`[Away] No away actions to report`);
    }
  } catch (e) {
    log(`[Away] Error checking away actions: ${e.message}`);
  }
}

async function collectAndSaveStats(context) {
  if (!cdpHandler) return;

  try {
    const browserStats = await cdpHandler.resetStats();

    if (browserStats.clicks > 0 || browserStats.blocked > 0) {
      const currentStats = await loadROIStats(context);
      currentStats.clicksThisWeek += browserStats.clicks;
      currentStats.blockedThisWeek += browserStats.blocked;

      await context.globalState.update(ROI_STATS_KEY, currentStats);
      log(
        `ROI Stats collected: +${browserStats.clicks} clicks, +${browserStats.blocked} blocked (Total: ${currentStats.clicksThisWeek} clicks, ${currentStats.blockedThisWeek} blocked)`,
      );
    }
  } catch (e) {}
}

async function incrementSessionCount(context) {
  const stats = await loadROIStats(context);
  stats.sessionsThisWeek++;
  await context.globalState.update(ROI_STATS_KEY, stats);
  log(`ROI Stats: Session count incremented to ${stats.sessionsThisWeek}`);
}

function startStatsCollection(context) {
  if (statsCollectionTimer) clearInterval(statsCollectionTimer);

  statsCollectionTimer = setInterval(() => {
    if (isEnabled) {
      collectAndSaveStats(context);
      checkForAwayActions(context);
    }
  }, 30000);

  log("ROI Stats: Collection started (every 30s)");
}

function updateStatusBar() {
  if (!statusBarItem) return;

  if (isConnectionLimited) {
    statusBarItem.text = "$(warning) 连接受限";
    statusBarItem.tooltip = "检测到连接受限\n\n点击立即一键修复 (自动重启)";
    statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    return;
  }
  statusBarItem.backgroundColor = undefined;

  // Create rich markdown tooltip
  const createTooltip = (state, action) => {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.appendMarkdown(`**Auto-Agent-AntiGravity:** ${state}\n\n`);
    md.appendMarkdown(`→ ${action}\n\n`);
    md.appendMarkdown(`[⚙️ 打开设置](command:auto-all.openSettings)`);
    return md;
  };

  // 如果 CDP 未连接，强制显示关闭状态
  if (!hadCDPConnection) {
    statusBarItem.text = "$(zap) 关闭";
    statusBarItem.tooltip = createTooltip(
      "未连接",
      "CDP 未连接，请使用桌面图标启动以携带参数",
    );
    return;
  }

  if (!isEnabled) {
    statusBarItem.text = "$(zap) 关闭";
    statusBarItem.tooltip = createTooltip("已关闭", "点击开启 (单标签模式)");
  } else if (!backgroundModeEnabled) {
    statusBarItem.text = "⚡ 开启";
    statusBarItem.tooltip = createTooltip(
      "开启 (单标签模式)",
      "点击进入多标签模式",
    );
  } else {
    statusBarItem.text = "⚡ 多模式";
    statusBarItem.tooltip = createTooltip("开启 (多标签模式)", "点击关闭");
  }
}

async function checkInstanceLock() {
  if (isPro) return true;
  if (!globalContext) return true;

  const lockId = globalContext.globalState.get(LOCK_KEY);
  const lastHeartbeat = globalContext.globalState.get(HEARTBEAT_KEY, 0);
  const now = Date.now();

  if (!lockId || now - lastHeartbeat > 10000) {
    await globalContext.globalState.update(LOCK_KEY, INSTANCE_ID);
    await globalContext.globalState.update(HEARTBEAT_KEY, now);
    return true;
  }

  if (lockId === INSTANCE_ID) {
    await globalContext.globalState.update(HEARTBEAT_KEY, now);
    return true;
  }

  return false;
}

async function showVersionNotification(context) {
  const hasShown = context.globalState.get(VERSION_7_0_KEY, false);
  if (hasShown) return;

  const title = "🚀 Welcome to AUTO ALL AntiGravity!";
  const body = `All Pro Features Unlocked. Free Forever.

✅ Multi-Tab Mode — Run multiple conversations in parallel, auto-alls in all tabs.

⚡ Instant Polling — Fastest possible response time for auto-alling.

🛡️ Dangerous Command Blocking — Built-in protection with customizable blocklist.

📊 Session Insights — Track auto-alls, time saved, and blocked commands.

☕ Support development: ko-fi.com/ai_dev_2024`;
  const btnDashboard = "View Dashboard";
  const btnGotIt = "Let's Go!";

  await context.globalState.update(VERSION_7_0_KEY, true);

  const selection = await vscode.window.showInformationMessage(
    `${title}\n\n${body}`,
    { modal: true },
    btnGotIt,
    btnDashboard,
  );

  if (selection === btnDashboard) {
    const panel = getSettingsPanel();
    if (panel) panel.createOrShow(context.extensionUri, context);
  }
}

function deactivate() {
  stopPolling();
  if (cdpHandler) {
    cdpHandler.stop();
  }
}

module.exports = { activate, deactivate };
