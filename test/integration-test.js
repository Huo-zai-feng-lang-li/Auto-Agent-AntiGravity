const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { CDPHandler } = require('../main_scripts/cdp-handler');
const {
  shouldNotifyTaskCompletion,
} = require('../main_scripts/notification-policy');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

async function testEventDrivenRendererLoop() {
  const source = read('main_scripts/full_cdp_script.js');
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /new MutationObserver/);
  assert.match(source, /attributeFilter: \['class', 'disabled', 'aria-disabled', 'style'\]/);
  assert.match(source, /Math\.max\(window\.__autoAllState\.pollInterval \|\| 1000, limit\)/);
}

async function testPendingCommandsAreRejectedOnDisconnect() {
  const handler = new CDPHandler();
  let rejected = false;
  const timer = setTimeout(() => {}, 10000);
  handler.pendingMessages.set(1, {
    pageId: 'page-1',
    timer,
    resolve: () => {},
    reject: () => { rejected = true; },
  });

  handler.rejectPendingForPage('page-1', new Error('closed'));

  assert.equal(handler.pendingMessages.size, 0);
  assert.equal(rejected, true);
}

async function testHostPollingIsSingleFlight() {
  const source = read('extension.js');
  assert.doesNotMatch(source, /pollTimer = setInterval\(async/);
  assert.match(source, /setTimeout\(poll, delay\)/);
  assert.match(source, /getConnectionCount\(\) > 0 \? 30000 : 5000/);
}

async function testTaskCompletionNotificationPolicy() {
  const base = {
    notifyEnabled: true,
    isFocused: false,
    now: 10_000,
    lastNotifiedAt: 0,
    cooldownMs: 5_000,
  };

  assert.equal(shouldNotifyTaskCompletion(base), true);
  assert.equal(
    shouldNotifyTaskCompletion({ ...base, notifyEnabled: false }),
    false,
  );
  assert.equal(
    shouldNotifyTaskCompletion({ ...base, isFocused: true, alwaysNotify: false }),
    false,
  );
  assert.equal(
    shouldNotifyTaskCompletion({ ...base, isFocused: true, alwaysNotify: true }),
    true,
  );
  assert.equal(
    shouldNotifyTaskCompletion({ ...base, lastNotifiedAt: 7_000 }),
    false,
  );
}

async function testTaskCompletionCallbackUsesLiveFocusState() {
  const source = read('extension.js');
  assert.match(
    source,
    /const isFocused = vscode\.window\.state\.focused[\s\S]*?shouldNotifyTaskCompletion\([\s\S]*?\bisFocused,\s*now/,
  );
}

async function testConfiguredEnvironmentDoesNotAutoRelaunch() {
  const policyPath = path.join(root, 'main_scripts', 'cdp-startup-policy.js');
  assert.equal(
    fs.existsSync(policyPath),
    true,
    'CDP startup recovery policy must exist',
  );

  const { getCDPStartupMode, waitForCDP } = require(policyPath);
  assert.equal(
    getCDPStartupMode({
      cdpAvailable: true,
      registryConfigured: true,
      skipPrompt: false,
    }),
    'ready',
  );
  assert.equal(
    getCDPStartupMode({
      cdpAvailable: false,
      registryConfigured: true,
      skipPrompt: false,
    }),
    'repair',
  );
  assert.equal(
    getCDPStartupMode({
      cdpAvailable: false,
      registryConfigured: false,
      skipPrompt: true,
    }),
    'limited',
  );
  assert.equal(
    getCDPStartupMode({
      cdpAvailable: false,
      registryConfigured: false,
      skipPrompt: false,
    }),
    'first-setup',
  );

  let checks = 0;
  const delays = [];
  const available = await waitForCDP(
    {
      async isCDPAvailable() {
        checks += 1;
        return checks === 3;
      },
    },
    {
      attempts: 3,
      delayMs: 25,
      sleep: async delay => delays.push(delay),
    },
  );

  assert.equal(available, true);
  assert.equal(checks, 3);
  assert.deepEqual(delays, [25, 25]);

  const unavailable = await waitForCDP(
    { isCDPAvailable: async () => false },
    { attempts: 2, delayMs: 10, sleep: async () => {} },
  );
  assert.equal(unavailable, false);

  const source = read('extension.js');
  const configuredBranch = source.match(
    /if \(startupMode === "repair"\) \{([\s\S]*?)\n\s*\} else if \(startupMode === "limited"\)/,
  );
  assert.ok(configuredBranch, 'configured CDP recovery branch must exist');
  assert.doesNotMatch(configuredBranch[1], /relaunchWithCDP/);
  assert.match(source, /waitForCDP\(cdpHandler\)/);
  assert.doesNotMatch(source, /auto-all-last-auto-relaunch-time/);
  assert.match(
    source,
    /首次安装：自动配置注册表并重启[\s\S]*?relauncher\.relaunchWithCDP\(\)/,
  );
}

async function main() {
  await testEventDrivenRendererLoop();
  await testPendingCommandsAreRejectedOnDisconnect();
  await testHostPollingIsSingleFlight();
  await testTaskCompletionNotificationPolicy();
  await testTaskCompletionCallbackUsesLiveFocusState();
  await testConfiguredEnvironmentDoesNotAutoRelaunch();
  console.log('Auto-Agent performance regression tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
