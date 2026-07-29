const DEFAULT_ATTEMPTS = 6;
const DEFAULT_DELAY_MS = 500;

function getCDPStartupMode({ cdpAvailable, registryConfigured, skipPrompt }) {
  if (cdpAvailable) return "ready";
  if (registryConfigured) return "repair";
  if (skipPrompt) return "limited";
  return "first-setup";
}

async function waitForCDP(
  cdpHandler,
  {
    attempts = DEFAULT_ATTEMPTS,
    delayMs = DEFAULT_DELAY_MS,
    sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
  } = {},
) {
  if (!cdpHandler || attempts < 1) return false;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (await cdpHandler.isCDPAvailable()) return true;
    } catch (_) {}

    if (attempt < attempts) await sleep(delayMs);
  }

  return false;
}

module.exports = {
  getCDPStartupMode,
  waitForCDP,
};

