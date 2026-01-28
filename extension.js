const vscode = require("vscode");
const path = require("path");

const { SettingsPanel } = require("./main_scripts/settings-panel");
const {
  DEFAULT_BANNED_COMMANDS,
  DEFAULT_POLL_FREQUENCY,
} = require("./main_scripts/constants");

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

let backgroundModeEnabled = false;
const BACKGROUND_DONT_SHOW_KEY = "auto-all-background-dont-show";
const BACKGROUND_MODE_KEY = "auto-all-background-mode";
const VERSION_7_0_KEY = "auto-all-version-7.0-notification-shown";

let pollTimer;
let statsCollectionTimer;
let statusBarItem;
let outputChannel;
let currentIDE = "unknown";
let globalContext;

let cdpHandler;
let relauncher;

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
    statusBarItem.text = "$(sync~spin)";
    statusBarItem.tooltip = "Auto-Agent-AntiGravity: Loading...";
    context.subscriptions.push(statusBarItem);
    statusBarItem.show();

    console.log("Auto-Agent-AntiGravity: Status bar items created and shown.");
  } catch (sbError) {
    console.error("CRITICAL: Failed to create status bar items:", sbError);
  }

  try {
    isEnabled = context.globalState.get(GLOBAL_STATE_KEY, false);
    isPro = context.globalState.get(PRO_STATE_KEY, false);
    isPro = true;

    if (isPro) {
      pollFrequency = context.globalState.get(FREQ_STATE_KEY, 1000);
    } else {
      pollFrequency = 300;
    }

    backgroundModeEnabled = context.globalState.get(BACKGROUND_MODE_KEY, false);

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

      cdpHandler = new CDPHandler(BASE_CDP_PORT, BASE_CDP_PORT + 10, log);
      if (cdpHandler.setProStatus) {
        cdpHandler.setProStatus(isPro);
      }

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
              ? `${(timeSavedMinutes / 60).toFixed(1)} 小时`
              : `${timeSavedMinutes} 分钟`,
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
 * 只在 Windows 平台执行
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
  ];

  const { execSync } = require("child_process");
  let configured = false;

  for (const regPath of registryPaths) {
    try {
      // 读取当前注册表值
      const result = execSync(`reg query "${regPath}" /ve`, {
        encoding: "utf8",
        timeout: 5000,
      });

      if (result.includes("--remote-debugging-port")) {
        log(`Registry ${regPath} already has CDP flag.`);
        continue;
      }

      // 解析当前命令
      const match = result.match(/REG_SZ\s+(.+)/);
      if (!match) continue;

      let currentCmd = match[1].trim();

      // 在 exe 路径后插入 CDP 参数
      const exeMatch = currentCmd.match(/^(".*?\.exe")\s*(.*)/i);
      if (exeMatch) {
        const newCmd =
          `${exeMatch[1]} --remote-debugging-port=${CDP_PORT} ${exeMatch[2]}`.trim();

        // 使用 PowerShell 修改注册表（避免转义问题）
        const psCmd = `Set-ItemProperty -Path "HKCU:\\Software\\Classes\\${ideName}\\shell\\open\\command" -Name "(default)" -Value '${newCmd.replace(/'/g, "''")}'`;
        execSync(`powershell -Command "${psCmd}"`, {
          encoding: "utf8",
          timeout: 10000,
        });

        log(`Updated registry: ${regPath}`);
        configured = true;
      }
    } catch (e) {
      log(`Registry path ${regPath} not found or failed: ${e.message}`);
    }
  }

  return {
    success: configured,
    reason: configured ? "configured" : "no-paths-found",
  };
}

async function checkEnvironmentAndStart() {
  log("Initializing Auto-Agent-AntiGravity environment...");

  // Always check CDP availability on startup (even if disabled)
  const cdpAvailable = cdpHandler ? await cdpHandler.isCDPAvailable() : false;
  log(`CDP availability check: ${cdpAvailable}`);

  if (cdpAvailable) {
    // CDP 可用，标记注册表已配置（可能是用户手动配置的）
    await globalContext.globalState.update(CDP_REGISTRY_CONFIGURED_KEY, true);
    log("CDP available. Extension ready to work.");
  } else if (relauncher) {
    // CDP 不可用，检查是否已经配置过注册表
    const registryConfigured = globalContext.globalState.get(
      CDP_REGISTRY_CONFIGURED_KEY,
      false,
    );
    const skipPrompt = globalContext.globalState.get(
      CDP_SKIP_PROMPT_KEY,
      false,
    );

    if (registryConfigured) {
      // 注册表已配置但 CDP 仍不可用，可能是用户没有通过正确方式启动
      // 或者是系统问题，不再打扰用户
      log(
        "Registry was configured but CDP still unavailable. User may have launched differently.",
      );
      vscode.window.setStatusBarMessage(
        "⚡ auto-all: 请通过桌面快捷方式启动 IDE 以启用完整功能",
        8000,
      );
    } else if (skipPrompt) {
      log(
        "CDP not available, but user chose to skip. Running in limited mode.",
      );
      vscode.window.setStatusBarMessage(
        "⚡ auto-all: CDP 未启用，部分功能受限",
        5000,
      );
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
  if (pollTimer) clearInterval(pollTimer);
  log("Auto-Agent-AntiGravity: Monitoring session...");

  await syncSessions();

  pollTimer = setInterval(async () => {
    if (!isEnabled) return;

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
  }, 5000);
}

async function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
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
    lines.push(`\n⏱ 预计节省时间: ~${summary.estimatedTimeSaved} 分钟`);
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
  log(
    `[Notification] showAwayActionsNotification called with: ${actionsCount}`,
  );
  if (!actionsCount || actionsCount === 0) {
    log(`[Notification] Away actions skipped: count is 0 or undefined`);
    return;
  }
  log(
    `[Notification] Showing away actions notification for ${actionsCount} actions`,
  );

  const message = `📣 在你离开期间，Auto-Agent-AntiGravity 处理了 ${actionsCount} 个动作。`;
  const detail = `Agent 在你专注于其他事情时保持了自主运行。`;

  vscode.window
    .showInformationMessage(message, { detail }, "查看仪表盘")
    .then((choice) => {
      if (choice === "查看仪表盘") {
        const panel = getSettingsPanel();
        if (panel) panel.createOrShow(context.extensionUri, context);
      }
    });
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

  // Create rich markdown tooltip
  const createTooltip = (state, action) => {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.appendMarkdown(`**Auto-Agent-AntiGravity:** ${state}\n\n`);
    md.appendMarkdown(`→ ${action}\n\n`);
    md.appendMarkdown(`[⚙️ 打开设置](command:auto-all.openSettings)`);
    return md;
  };

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
