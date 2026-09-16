
(function () {
    "use strict";

    if (typeof window === 'undefined') return;

    // 重入保护：CDP 断线重连 / frameNavigated 重复注入会在同一 JS 上下文再次执行本 IIFE。
    // 若不清理，上一实例闭包里的选举广播、状态流订阅、DOM 循环都不会退出，造成多实例叠加
    // （重复订阅，并出现持续发心跳、压制新实例的“幽灵 leader”）。先彻底拆除上一实例。
    if (typeof window.__autoAllTeardown === 'function') {
        try { window.__autoAllTeardown(); } catch (e) { }
    }

    const Analytics = (function () {
        
        const TERMINAL_KEYWORDS = ['run', 'execute', 'command', 'terminal'];
        const SECONDS_PER_CLICK = 5;
        const TIME_VARIANCE = 0.2;

        const ActionType = {
            FILE_EDIT: 'file_edit',
            TERMINAL_COMMAND: 'terminal_command'
        };

        function createDefaultStats() {
            return {
                clicksThisSession: 0,
                blockedThisSession: 0,
                sessionStartTime: null,
                fileEditsThisSession: 0,
                terminalCommandsThisSession: 0,
                actionsWhileAway: 0,
                isWindowFocused: true,
                lastConversationUrl: null,
                lastConversationStats: null
            };
        }

        function getStats() {
            return window.__autoAllState?.stats || createDefaultStats();
        }

        function getStatsMutable() {
            return window.__autoAllState.stats;
        }

        function categorizeClick(buttonText) {
            const text = (buttonText || '').toLowerCase();
            for (const keyword of TERMINAL_KEYWORDS) {
                if (text.includes(keyword)) return ActionType.TERMINAL_COMMAND;
            }
            return ActionType.FILE_EDIT;
        }

        function trackClick(buttonText, log) {
            const stats = getStatsMutable();
            stats.clicksThisSession++;
            log(`[Stats] Click tracked. Total: ${stats.clicksThisSession}`);

            const category = categorizeClick(buttonText);
            if (category === ActionType.TERMINAL_COMMAND) {
                stats.terminalCommandsThisSession++;
                log(`[Stats] Terminal command. Total: ${stats.terminalCommandsThisSession}`);
            } else {
                stats.fileEditsThisSession++;
                log(`[Stats] File edit. Total: ${stats.fileEditsThisSession}`);
            }

            let isAway = false;
            if (!stats.isWindowFocused) {
                stats.actionsWhileAway++;
                isAway = true;
                log(`[Stats] Away action. Total away: ${stats.actionsWhileAway}`);
            }

            return { category, isAway, totalClicks: stats.clicksThisSession };
        }

        function trackBlocked(log) {
            const stats = getStatsMutable();
            stats.blockedThisSession++;
            log(`[Stats] Blocked. Total: ${stats.blockedThisSession}`);
        }

        function collectROI(log) {
            const stats = getStatsMutable();
            const collected = {
                clicks: stats.clicksThisSession || 0,
                blocked: stats.blockedThisSession || 0,
                sessionStart: stats.sessionStartTime
            };
            log(`[ROI] Collected: ${collected.clicks} clicks, ${collected.blocked} blocked`);
            stats.clicksThisSession = 0;
            stats.blockedThisSession = 0;
            stats.sessionStartTime = Date.now();
            return collected;
        }

        function getSessionSummary() {
            const stats = getStats();
            const clicks = stats.clicksThisSession || 0;
            const baseSecs = clicks * SECONDS_PER_CLICK;
            const minMins = Math.max(1, Math.floor((baseSecs * (1 - TIME_VARIANCE)) / 60));
            const maxMins = Math.ceil((baseSecs * (1 + TIME_VARIANCE)) / 60);

            return {
                clicks,
                fileEdits: stats.fileEditsThisSession || 0,
                terminalCommands: stats.terminalCommandsThisSession || 0,
                blocked: stats.blockedThisSession || 0,
                estimatedTimeSaved: clicks > 0 ? `${minMins}–${maxMins} minutes` : null
            };
        }

        function consumeAwayActions(log) {
            const stats = getStatsMutable();
            const count = stats.actionsWhileAway || 0;
            log(`[Away] Consuming away actions: ${count}`);
            stats.actionsWhileAway = 0;
            return count;
        }

        function isUserAway() {
            return !getStats().isWindowFocused;
        }

        function initializeFocusState(log) {
            const state = window.__autoAllState;
            if (state && state.stats) {
                
                state.stats.isWindowFocused = true;
                log('[Focus] Initialized (awaiting extension sync)');
            }
        }

        function initialize(log) {
            if (!window.__autoAllState) {
                window.__autoAllState = {
                    isRunning: false,
                    sessionID: 0,
                    currentMode: null,
                    startTimes: {},
                    bannedCommands: [],
                    isPro: false,
                    stats: createDefaultStats()
                };
                log('[Analytics] State initialized');
            } else if (!window.__autoAllState.stats) {
                window.__autoAllState.stats = createDefaultStats();
                log('[Analytics] Stats added to existing state');
            } else {
                const s = window.__autoAllState.stats;
                if (s.actionsWhileAway === undefined) s.actionsWhileAway = 0;
                if (s.isWindowFocused === undefined) s.isWindowFocused = true;
                if (s.fileEditsThisSession === undefined) s.fileEditsThisSession = 0;
                if (s.terminalCommandsThisSession === undefined) s.terminalCommandsThisSession = 0;
            }

            initializeFocusState(log);

            if (!window.__autoAllState.stats.sessionStartTime) {
                window.__autoAllState.stats.sessionStartTime = Date.now();
            }

            log('[Analytics] Initialized');
        }

        function setFocusState(isFocused, log) {
            const state = window.__autoAllState;
            if (!state || !state.stats) return;

            const wasAway = !state.stats.isWindowFocused;
            state.stats.isWindowFocused = isFocused;

            if (log) {
                log(`[Focus] Extension sync: focused=${isFocused}, wasAway=${wasAway}`);
            }
        }

        return {
            initialize,
            trackClick,
            trackBlocked,
            categorizeClick,
            ActionType,
            collectROI,
            getSessionSummary,
            consumeAwayActions,
            isUserAway,
            getStats,
            setFocusState
        };
    })();

    const log = (msg, isSuccess = false) => {
        
        console.log(`[autoAll] ${msg}`);
    };

    Analytics.initialize(log);

    const timerWorkerCode = `
        self.onmessage = function(e) {
            setTimeout(function() {
                self.postMessage({ id: e.data.id });
            }, e.data.ms);
        };
    `;
    let timerWorker = null;
    let timerCallbacks = new Map();
    let timerId = 0;

    function getTimerWorker() {
        if (!timerWorker && typeof Worker !== 'undefined' && typeof Blob !== 'undefined') {
            try {
                const blob = new Blob([timerWorkerCode], { type: 'application/javascript' });
                timerWorker = new Worker(URL.createObjectURL(blob));
                timerWorker.onmessage = function (e) {
                    const cb = timerCallbacks.get(e.data.id);
                    if (cb) {
                        timerCallbacks.delete(e.data.id);
                        cb();
                    }
                };
                timerWorker.onerror = function (err) {
                    log('[Timer] Worker error, falling back to setTimeout');
                    timerWorker = null;
                };
                log('[Timer] Web Worker initialized for background operation');
            } catch (err) {
                log('[Timer] Web Worker not available, using setTimeout fallback');
            }
        }
        return timerWorker;
    }

    function workerDelay(ms) {
        return new Promise(function (resolve) {
            const worker = getTimerWorker();
            if (worker) {
                const id = ++timerId;
                timerCallbacks.set(id, resolve);
                worker.postMessage({ id: id, ms: ms });
            } else {
                
                setTimeout(resolve, ms);
            }
        });
    }

    let cachedSearchRoots = null;
    let cachedRootsTimestamp = 0;
    const ROOTS_CACHE_DURATION = 2000;

    const getSearchRoots = (forceRefresh = false) => {
        const now = Date.now();
        if (!forceRefresh && cachedSearchRoots && (now - cachedRootsTimestamp < ROOTS_CACHE_DURATION)) {
            return cachedSearchRoots;
        }

        const roots = [document];
        const visited = new Set(roots);

        const collectRoots = (node) => {
            if (!node || !node.querySelectorAll) return;
            try {
                const frames = node.querySelectorAll('iframe, frame');
                for (let i = 0; i < frames.length; i++) {
                    try {
                        const fDoc = frames[i].contentDocument || frames[i].contentWindow?.document;
                        if (fDoc && !visited.has(fDoc)) {
                            visited.add(fDoc);
                            roots.push(fDoc);
                            collectRoots(fDoc);
                        }
                    } catch (e) { }
                }
                const shadowHosts = node.querySelectorAll('.antigravity-agent-side-panel, [class*="agentPanel"], #react-app, #chat');
                for (let i = 0; i < shadowHosts.length; i++) {
                    const sr = shadowHosts[i].shadowRoot;
                    if (sr && !visited.has(sr)) {
                        visited.add(sr);
                        roots.push(sr);
                    }
                }
            } catch (e) { }
        };

        collectRoots(document);
        cachedSearchRoots = roots;
        cachedRootsTimestamp = now;
        return roots;
    };

    const queryAll = (selector) => {
        const results = [];
        const roots = getSearchRoots();
        for (let i = 0; i < roots.length; i++) {
            try {
                const els = roots[i].querySelectorAll(selector);
                for (let j = 0; j < els.length; j++) results.push(els[j]);
            } catch (e) { }
        }
        return results;
    };

    const findFirst = (selector, predicate = isElementActive) => {
        const roots = getSearchRoots();
        for (let i = 0; i < roots.length; i++) {
            try {
                const els = roots[i].querySelectorAll(selector);
                for (let j = 0; j < els.length; j++) {
                    if (predicate(els[j])) return els[j];
                }
            } catch (e) { }
        }
        return null;
    };

    const findAny = (selector) => {
        const roots = getSearchRoots();
        for (let i = 0; i < roots.length; i++) {
            try {
                const element = roots[i].querySelector(selector);
                if (element?.isConnected) return element;
            } catch (e) { }
        }
        return null;
    };

    function findNearbyCommandText(el) {
        const commandSelectors = ['pre', 'code', 'pre code'];
        let commandText = '';

        let container = el.parentElement;
        let depth = 0;
        const maxDepth = 10; 

        while (container && depth < maxDepth) {
            
            let sibling = container.previousElementSibling;
            let siblingCount = 0;

            while (sibling && siblingCount < 5) {
                
                if (sibling.tagName === 'PRE' || sibling.tagName === 'CODE') {
                    const text = sibling.textContent.trim();
                    if (text.length > 0) {
                        commandText += ' ' + text;
                        log(`[BannedCmd] Found <${sibling.tagName}> sibling at depth ${depth}: "${text.substring(0, 100)}..."`);
                    }
                }

                for (const selector of commandSelectors) {
                    const codeElements = sibling.querySelectorAll(selector);
                    for (const codeEl of codeElements) {
                        if (codeEl && codeEl.textContent) {
                            const text = codeEl.textContent.trim();
                            if (text.length > 0 && text.length < 5000) {
                                commandText += ' ' + text;
                                log(`[BannedCmd] Found <${selector}> in sibling at depth ${depth}: "${text.substring(0, 100)}..."`);
                            }
                        }
                    }
                }

                sibling = sibling.previousElementSibling;
                siblingCount++;
            }

            if (commandText.length > 10) {
                break;
            }

            container = container.parentElement;
            depth++;
        }

        if (commandText.length === 0) {
            let btnSibling = el.previousElementSibling;
            let count = 0;
            while (btnSibling && count < 3) {
                for (const selector of commandSelectors) {
                    const codeElements = btnSibling.querySelectorAll ? btnSibling.querySelectorAll(selector) : [];
                    for (const codeEl of codeElements) {
                        if (codeEl && codeEl.textContent) {
                            commandText += ' ' + codeEl.textContent.trim();
                        }
                    }
                }
                btnSibling = btnSibling.previousElementSibling;
                count++;
            }
        }

        if (el.getAttribute('aria-label')) {
            commandText += ' ' + el.getAttribute('aria-label');
        }
        if (el.getAttribute('title')) {
            commandText += ' ' + el.getAttribute('title');
        }

        const result = commandText.trim().toLowerCase();
        if (result.length > 0) {
            log(`[BannedCmd] Extracted command text (${result.length} chars): "${result.substring(0, 150)}..."`);
        }
        return result;
    }

    function isCommandBanned(commandText) {
        const state = window.__autoAllState;
        const bannedList = state.bannedCommands || [];

        if (bannedList.length === 0) return false;
        if (!commandText || commandText.length === 0) return false;

        const lowerText = commandText.toLowerCase();

        for (const banned of bannedList) {
            const pattern = banned.trim();
            if (!pattern || pattern.length === 0) continue;

            try {
                
                if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
                    
                    const lastSlash = pattern.lastIndexOf('/');
                    const regexPattern = pattern.substring(1, lastSlash);
                    const flags = pattern.substring(lastSlash + 1) || 'i'; 

                    const regex = new RegExp(regexPattern, flags);
                    if (regex.test(commandText)) {
                        log(`[BANNED] Command blocked by regex: /${regexPattern}/${flags}`);
                        Analytics.trackBlocked(log);
                        return true;
                    }
                } else {
                    
                    const lowerPattern = pattern.toLowerCase();
                    if (lowerText.includes(lowerPattern)) {
                        log(`[BANNED] Command blocked by pattern: "${pattern}"`);
                        Analytics.trackBlocked(log);
                        return true;
                    }
                }
            } catch (e) {
                
                log(`[BANNED] Invalid regex pattern "${pattern}", using literal match: ${e.message}`);
                if (lowerText.includes(pattern.toLowerCase())) {
                    log(`[BANNED] Command blocked by pattern (fallback): "${pattern}"`);
                    Analytics.trackBlocked(log);
                    return true;
                }
            }
        }
        return false;
    }

    function isElementActive(el) {
        if (!el || !el.isConnected) return false;
        try {
            const win = el.ownerDocument?.defaultView || window;
            const style = win.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
            if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
            return true;
        } catch (e) {
            return true; // 即使在沙箱中无法获取样式，只要存在且在文档流中仍视为激活
        }
    }

    function isAcceptButton(el) {
        const text = (el.textContent || "").trim().toLowerCase();
        if (text.length === 0 || text.length > 50) return false;
        const patterns = ['accept', 'run', 'retry', 'apply', 'execute', 'confirm', 'allow once', 'allow'];
        const rejects = ['skip', 'reject', 'cancel', 'close', 'refine', 'ran ', 'ran command', '已运行', 'succeeded', 'completed'];
        if (rejects.some(r => text.includes(r))) return false;
        if (!patterns.some(p => text.includes(p))) return false;

        const isCommandButton = text.includes('run command') || text.includes('execute') || text.includes('run');

        if (isCommandButton) {
            const nearbyText = findNearbyCommandText(el);
            if (isCommandBanned(nearbyText)) {
                log(`[BANNED] Skipping button: "${text}" - command is banned`);
                return false;
            }
        }

        return isElementActive(el);
    }

    function isElementVisible(el) {
        return isElementActive(el);
    }

    async function waitForDisappear(el, timeout = 500) {
        // 不依赖 requestAnimationFrame：后台标签下 rAF 会被 Chromium 冻结导致永久挂起，
        // 改用 Web Worker 计时轮询，前后台行为一致。
        const startTime = Date.now();
        const stepMs = 50;
        while (Date.now() - startTime < timeout) {
            if (!isElementActive(el)) return true;
            await workerDelay(stepMs);
        }
        return !isElementActive(el);
    }

    async function performClick(selectors) {
        let clicked = 0;
        let verified = 0;
        const uniqueFound = [...new Set(queryAll(selectors.join(', ')))];

        for (const el of uniqueFound) {
            if (isAcceptButton(el)) {
                const buttonText = (el.textContent || "").trim();
                log(`Clicking: "${buttonText}"`);

                el.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
                clicked++;

                const disappeared = await waitForDisappear(el);

                if (disappeared) {
                    
                    Analytics.trackClick(buttonText, log);
                    verified++;
                    log(`[Stats] Click verified (button disappeared)`);
                } else {
                    log(`[Stats] Click not verified (button still visible after 500ms)`);
                }
            }
        }

        if (clicked > 0) {
            log(`[Click] Attempted: ${clicked}, Verified: ${verified}`);
        }
        return verified;
    }

    // ========================================================================
    // 网络层多会话自动确认（事件驱动 / 长连接订阅，覆盖后台未打开的会话）
    // 原理：IDE 后端 language server 为所有会话保留状态，与前端是否打开无关；
    // 通过 Connect RPC 订阅每个会话的状态流，收到 WAITING 步骤即回发确认，
    // 无需切换会话、不扫描后台 DOM、空闲时仅挂起长连接，CPU 占用趋近于零。
    // ========================================================================
    function createNetworkAutoAccept() {
        const LS_SERVICE = 'exa.language_server_pb.LanguageServerService';
        const WAITING = 'CORTEX_STEP_STATUS_WAITING';
        const ENUM_INTERVAL = 15000;   // 低频发现新会话
        const RECONNECT_DELAY = 1000; // 断线重连
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();

        // 仅需 {confirm:true} 的交互类型（字段名与 CascadeUserInteraction oneof 对齐）
        const CONFIRM_ONLY = {
            deploy: 1, openBrowserUrl: 1, runExtensionCode: 1, executeBrowserJavascript: 1,
            captureBrowserScreenshot: 1, clickBrowserPixel: 1, browserAction: 1,
            openBrowserSetup: 1, confirmBrowserSetup: 1, sendCommandInput: 1,
            readUrlContent: 1, mcp: 1
        };

        const ctx = {
            running: false, port: null, token: null,
            subs: new Map(),          // conversationId -> {ac, local, lastStat}
            handled: new Set(),       // conversationId#stepIndex 去重
            origFetch: null, fetchHooked: false, enumScheduled: false, enumRunning: false,
            // 跨页面 Leader 选举：同一 LS 端口只保留一个订阅者，消除多窗口重复订阅
            myId: genPageId(),        // 本页面固定唯一 id（固定长度十六进制，字典序即随机序）
            leaderMap: new Map(),     // port -> {id, ts} 已知 leader 心跳
            isLeader: false,          // 当前端口本页面是否为 leader（只有 leader 建订阅）
            engineOn: false,          // 订阅引擎是否在跑（enumerate + 各会话长连接）
            electionTimer: null, beatAt: 0, voteAt: 0, channel: null,
            lastPerfScan: 0,        // discoverPortFromPerf 冷却时间戳，避免每 1s 全量遍历 performance 资源
            trace: []                 // 诊断环形缓冲：记录状态帧/WAITING/确认链路，供排障抓现场
        };

        // 生成本页面唯一 id（固定 16 位 hex，保证跨页面字典序比较公平）
        function genPageId() {
            try {
                const a = new Uint8Array(8);
                if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(a);
                else for (let i = 0; i < 8; i++) a[i] = (Math.random() * 256) | 0;
                return Array.from(a, x => x.toString(16).padStart(2, '0')).join('');
            } catch (e) { return Date.now().toString(16).padStart(16, '0'); }
        }

        // 诊断环形缓冲：只保留最近 240 条关键事件，空闲不产生任何事件
        function pushTrace(o) {
            try {
                ctx.trace.push(Object.assign({ ms: Date.now() % 100000000 }, o));
                if (ctx.trace.length > 240) ctx.trace.shift();
            } catch (e) { }
        }

        // ---- Connect streaming envelope：1 字节 flag + 4 字节大端长度 + payload ----
        function encodeFrame(obj) {
            const json = encoder.encode(JSON.stringify(obj));
            const frame = new Uint8Array(5 + json.length);
            new DataView(frame.buffer).setUint8(0, 0);
            new DataView(frame.buffer).setUint32(1, json.length);
            frame.set(json, 5);
            return frame;
        }

        function rawFetch() { return ctx.origFetch || window.fetch.bind(window); }

        function captureFromRequest(url, headers) {
            const m = url.match(/(?:127\.0\.0\.1|localhost):(\d+)/);
            if (m) ctx.port = m[1];
            let t = null;
            if (headers) {
                if (typeof Headers !== 'undefined' && headers instanceof Headers) {
                    t = headers.get('x-codeium-csrf-token');
                } else {
                    t = headers['x-codeium-csrf-token'];
                }
            }
            if (t && t !== ctx.token) {
                ctx.token = t;
                scheduleEnumerate();
            }
            // 用户发起新对话/发消息意味着可能出现新会话，立即补一次枚举
            if (/StartCascade|SendUserCascadeMessage/.test(url)) scheduleEnumerate();
        }

        // hook fetch 仅用于捕获动态 port 与 csrf token（生产主路径由 cdp-handler
        // 的 addScriptToEvaluateOnNewDocument 早期注入 window.__cap，这里做附加兜底）
        function installFetchHook() {
            if (ctx.fetchHooked) return;
            ctx.origFetch = window.fetch.bind(window);
            ctx.fetchHooked = true;
            const orig = ctx.origFetch;
            window.fetch = function (input, init) {
                try {
                    const url = typeof input === 'string' ? input : (input && input.url) || '';
                    if (url.indexOf(LS_SERVICE) >= 0) captureFromRequest(url, init && init.headers);
                } catch (e) { }
                return orig(input, init);
            };
        }

        // 从 performance 资源记录中发现 language server 动态端口。
        // 冷却优化：electionTick 每 1s 调用本函数，但 performance.getEntriesByType('resource')
        // 在 IDE 页面可能有数千条资源，全量遍历+正则匹配有几毫秒开销。已有端口时 10s 冷却，
        // 减少 90% 遍历；LS 重启换端口最坏 10s 发现（可接受）。端口为空时不受冷却限制。
        const PERF_SCAN_COOLDOWN = 10000;
        function discoverPortFromPerf() {
            const now = Date.now();
            if (ctx.port && now - ctx.lastPerfScan < PERF_SCAN_COOLDOWN) return;
            ctx.lastPerfScan = now;
            try {
                const ports = [...new Set(
                    performance.getEntriesByType('resource')
                        .map(e => { const mm = e.name.match(/(?:127\.0\.0\.1|localhost):(\d+)/); return mm && mm[1]; })
                        .filter(Boolean)
                )];
                // resource 按时间升序，language server 可能重启换端口，取最新一个
                if (ports.length) ctx.port = ports[ports.length - 1];
            } catch (e) { }
        }

        function absorbEarlyCapture() {
            const cap = window.__cap;
            if (!cap) return;
            if (cap.token) ctx.token = cap.token;
            if (cap.port && !ctx.port) ctx.port = cap.port;
        }

        function baseUrl() { return `https://127.0.0.1:${ctx.port}/${LS_SERVICE}`; }
        function authHeaders(extra) { return Object.assign({ 'x-codeium-csrf-token': ctx.token }, extra || {}); }

        async function unary(method, bodyObj) {
            const resp = await rawFetch()(baseUrl() + '/' + method, {
                method: 'POST',
                headers: authHeaders({ 'content-type': 'application/json' }),
                body: JSON.stringify(bodyObj || {})
            });
            const text = await resp.text();
            let json = null;
            try { json = JSON.parse(text); } catch (e) { }
            return { status: resp.status, json, text };
        }

        // ---- 状态增量合并（对齐 IDE 内部按 indices 覆盖语义）----
        // 原地合并 steps 增量更新：直接修改 prev 数组，避免每帧 O(N) 分配+全量拷贝。
        // rec.local.trajectory.steps 是唯一引用，原地修改安全；大会话(数百步)下显著降低 GC 压力。
        function applyIndexed(prev, indices, items, total) {
            if (total != null && prev.length < total) prev.length = total;
            if (indices && items) {
                for (let k = 0; k < indices.length; k++) {
                    const idx = indices[k];
                    if (idx >= 0) prev[idx] = items[k];
                }
            }
            return prev;
        }

        function mergeUpdate(prev, u) {
            const next = Object.assign({}, prev);
            if (u.conversationId) next.conversationId = u.conversationId;
            if (u.status !== undefined) next.status = u.status;
            if (u.trajectoryId) next.trajectoryId = u.trajectoryId;
            let traj = prev.trajectory || { steps: [] };
            if (u.mainTrajectoryUpdate && u.mainTrajectoryUpdate.stepsUpdate) {
                const su = u.mainTrajectoryUpdate.stepsUpdate;
                traj = Object.assign({}, traj, {
                    steps: applyIndexed(traj.steps || [], su.indices, su.steps, su.totalLength)
                });
            }
            next.trajectory = traj;
            return next;
        }

        // requestedInteraction 缺省时，按步骤内容字段推断交互类型
        function inferKind(step) {
            if (step.runCommand) return 'runCommand';
            if (step.openBrowserUrl) return 'openBrowserUrl';
            if (step.executeBrowserJavascript) return 'executeBrowserJavascript';
            if (step.captureBrowserScreenshot) return 'captureBrowserScreenshot';
            if (step.clickBrowserPixel) return 'clickBrowserPixel';
            if (step.readUrlContent) return 'readUrlContent';
            if (step.sendCommandInput) return 'sendCommandInput';
            if (step.mcpTool) return 'mcp';
            if (step.runExtensionCode) return 'runExtensionCode';
            // 通用：任何顶层字段内嵌 filePermissionRequest（如 codeAction / listDirectory /
            // readFile / editFile 等）都视为文件/目录权限确认，避免新增步骤类型时漏支持。
            // 步骤对象通常仅 4-5 个字段，遍历开销可忽略；且 inferKind 仅在 WAITING 时调用（低频）。
            for (const k of Object.keys(step)) {
                const v = step[k];
                if (v && typeof v === 'object' && v.filePermissionRequest) return 'filePermission';
            }
            return null;
        }

        // 构造 CascadeUserInteraction 的平铺 oneof 字段；返回 null 表示无法自动处理
        function buildInteraction(step) {
            const reqKeys = step.requestedInteraction ? Object.keys(step.requestedInteraction) : [];
            const kind = reqKeys[0] || inferKind(step);
            if (!kind) return null;

            if (kind === 'runCommand') {
                // 命令详情优先顶层 runCommand，回退 requestedInteraction.runCommand（与前端确认条读取路径对齐）
                const rc = step.runCommand
                    || (step.requestedInteraction && step.requestedInteraction.runCommand)
                    || {};
                let cmd = rc.proposedCommandLine || rc.commandLine || rc.submittedCommandLine || '';
                // 前端兜底：commandLine 为空时用 command + args 拼（保持一致，避免空命令确认无效）
                if (!cmd && rc.command) {
                    const args = Array.isArray(rc.args) ? rc.args.map(a => String(a)).join(' ') : (rc.args || '');
                    cmd = (rc.command + ' ' + args).trim();
                }
                if (typeof isCommandBanned === 'function' && isCommandBanned(cmd)) return { banned: true };
                if (!cmd) return null; // 命令暂缺：不标记，后续帧补齐后可重试
                return {
                    field: 'runCommand',
                    payload: { confirm: true, proposedCommandLine: cmd, submittedCommandLine: cmd }
                };
            }
            if (kind === 'filePermission') {
                // requestedInteraction.filePermission 优先（显式请求），否则遍历顶层字段找
                // 内嵌的 filePermissionRequest（codeAction / listDirectory / readFile 等），
                // 与 inferKind 的通用识别逻辑对齐，避免新增类型时漏支持。
                let spec = (step.requestedInteraction && step.requestedInteraction.filePermission) || null;
                if (!spec) {
                    for (const k of Object.keys(step)) {
                        const v = step[k];
                        if (v && typeof v === 'object' && v.filePermissionRequest) { spec = v.filePermissionRequest; break; }
                    }
                }
                spec = spec || {};
                if (!spec.absolutePathUri) return null;
                return {
                    field: 'filePermission',
                    payload: { allow: true, scope: 'PERMISSION_SCOPE_ONCE', absolutePathUri: spec.absolutePathUri }
                };
            }
            // 表单类需按 schema 应答，明确不自动：返回 skip 让调用方只标记一次、不重试
            if (kind === 'elicitation') return { skip: true };
            if (CONFIRM_ONLY[kind]) return { field: kind, payload: { confirm: true } };
            // 其余（未知类型 / 字段暂缺）返回 null：不标记，后续帧补齐信息后仍可重试
            return null;
        }

        // 增量扫描 WAITING：只检查「本次更新的步骤 indices」+「之前信息暂缺待重试的步骤」，
        // 避免每帧 O(N) 全量遍历。WAITING 只能在被更新的步骤里产生；未更新的步骤状态不变。
        // pendingRetry 记录 buildInteraction 返回 null(信息暂缺)的步骤，下次该步骤更新或任何帧到达时重试。
        async function scanWaiting(cid, local, update, rec) {
            const steps = local && local.trajectory && local.trajectory.steps;
            if (!Array.isArray(steps)) return;
            if (!rec.pendingRetry) rec.pendingRetry = new Set();

            // 收集本次需要检查的索引：待重试 ∪ 本次更新的 indices
            const checkSet = new Set(rec.pendingRetry);
            const su = update && update.mainTrajectoryUpdate && update.mainTrajectoryUpdate.stepsUpdate;
            if (su && Array.isArray(su.indices)) {
                for (let k = 0; k < su.indices.length; k++) checkSet.add(su.indices[k]);
            }

            for (const i of checkSet) {
                const step = steps[i];
                if (!step || step.status !== WAITING) {
                    rec.pendingRetry.delete(i); // 不再是 WAITING，移出待重试
                    continue;
                }
                const key = cid + '#' + i;
                if (ctx.handled.has(key)) {
                    rec.pendingRetry.delete(i);
                    continue;
                }

                // 诊断：记录到达此处的 WAITING 步骤形态，定位“没点到”卡在哪一环
                pushTrace({
                    t: 'wait', cid: cid.slice(0, 8), idx: i,
                    req: step.requestedInteraction ? Object.keys(step.requestedInteraction) : null,
                    top: Object.keys(step), hasRC: !!step.runCommand
                });
                const built = buildInteraction(step);
                if (!built) {
                    // 信息暂时不足：加入待重试，后续该步骤更新时再试；留痕便于发现“永远补不齐”的类型
                    rec.pendingRetry.add(i);
                    pushTrace({ t: 'build', cid: cid.slice(0, 8), idx: i, r: 'null' });
                    continue;
                }
                if (built.banned || built.skip) {
                    // 命中黑名单 / 明确不自动（如 elicitation）：标记一次，避免每帧重复评估
                    ctx.handled.add(key);
                    rec.pendingRetry.delete(i);
                    pushTrace({ t: 'build', cid: cid.slice(0, 8), idx: i, r: built.banned ? 'banned' : 'skip' });
                    if (built.banned) log(`[Net] Banned command skipped @ conv ${cid.slice(0, 8)} step ${i}`);
                    continue;
                }
                ctx.handled.add(key);
                rec.pendingRetry.delete(i);
                try {
                    const trajId = local.trajectoryId;
                    const interaction = Object.assign(
                        { trajectoryId: trajId, stepIndex: i },
                        { [built.field]: built.payload }
                    );
                    const r = await unary('HandleCascadeUserInteraction', { cascadeId: cid, interaction });
                    pushTrace({ t: 'rpc', cid: cid.slice(0, 8), idx: i, f: built.field, s: r.status });
                    if (r.status === 200) {
                        Analytics.trackClick('net:' + built.field, log);
                        log(`[Net] Auto-confirmed ${built.field} @ conv ${cid.slice(0, 8)} step ${i}`);
                    } else {
                        ctx.handled.delete(key); // 失败允许后续重试
                        rec.pendingRetry.add(i);  // 失败也加入待重试
                        log(`[Net] Handle failed status=${r.status} body=${(r.text || '').slice(0, 160)}`);
                    }
                } catch (e) {
                    ctx.handled.delete(key);
                    rec.pendingRetry.add(i); // 异常也加入待重试
                    pushTrace({ t: 'rpc', cid: cid.slice(0, 8), idx: i, err: (e && e.message || '').slice(0, 80) });
                    log(`[Net] Handle error: ${e && e.message}`);
                }
            }
        }

        // 为单个会话建立状态流长连接（空闲挂起，零轮询；断线自动重连）
        function subscribe(cid) {
            if (!ctx.engineOn || ctx.subs.has(cid)) return;
            const rec = { ac: new AbortController(), local: null, lastStat: new Map() };
            ctx.subs.set(cid, rec);

            const loop = async () => {
                while (ctx.running && ctx.engineOn && ctx.subs.get(cid) === rec) {
                    try {
                        const resp = await rawFetch()(baseUrl() + '/StreamAgentStateUpdates', {
                            method: 'POST',
                            signal: rec.ac.signal,
                            headers: authHeaders({
                                'content-type': 'application/connect+json',
                                'connect-protocol-version': '1'
                            }),
                            body: encodeFrame({ conversationId: cid, subscriberId: 'autoall-' + cid.slice(0, 8) })
                        });
                        if (!resp.body) throw new Error('no stream body');
                        const reader = resp.body.getReader();
                        let buf = new Uint8Array(0);
                        while (true) {
                            const chunk = await reader.read();
                            if (chunk.done) break;
                            const merged = new Uint8Array(buf.length + chunk.value.length);
                            merged.set(buf, 0);
                            merged.set(chunk.value, buf.length);
                            buf = merged;
                            while (buf.length >= 5) {
                                const dv = new DataView(buf.buffer, buf.byteOffset);
                                const flag = dv.getUint8(0);
                                const len = dv.getUint32(1);
                                if (len > 64 * 1024 * 1024) { buf = new Uint8Array(0); break; }
                                if (buf.length < 5 + len) break;
                                const payload = buf.slice(5, 5 + len);
                                buf = buf.slice(5 + len);
                                if (flag !== 0) continue;
                                let msg = null;
                                try { msg = JSON.parse(decoder.decode(payload)); } catch (e) { continue; }
                                if (msg.update) {
                                    rec.local = mergeUpdate(rec.local || { conversationId: cid }, msg.update);
                                    traceStepChanges(cid, rec, msg.update);
                                    await scanWaiting(cid, rec.local, msg.update, rec);
                                }
                            }
                        }
                    } catch (e) {
                        if (!ctx.running || !ctx.engineOn || rec.ac.signal.aborted) return;
                    }
                    await workerDelay(RECONNECT_DELAY);
                }
            };
            loop();
        }

        // 仅记录“非 DONE 步骤”的状态跳变（如 RUNNING->WAITING），低频且能确认 WAITING 帧是否到达本层
        function traceStepChanges(cid, rec, update) {
            try {
                const su = update && update.mainTrajectoryUpdate && update.mainTrajectoryUpdate.stepsUpdate;
                if (!su || !Array.isArray(su.indices)) return;
                for (let k = 0; k < su.indices.length; k++) {
                    const st = su.steps && su.steps[k];
                    if (!st || !st.status || st.status === 'CORTEX_STEP_STATUS_DONE') continue;
                    const idx = su.indices[k];
                    const short = st.status.replace('CORTEX_STEP_STATUS_', '');
                    if (rec.lastStat.get(idx) !== st.status) {
                        rec.lastStat.set(idx, st.status);
                        pushTrace({ t: 'step', cid: cid.slice(0, 8), idx, st: short });
                    }
                }
            } catch (e) { }
        }

        function scheduleEnumerate() {
            if (ctx.enumScheduled || !ctx.running || !ctx.engineOn) return;
            ctx.enumScheduled = true;
            workerDelay(200).then(() => { ctx.enumScheduled = false; enumerate(); });
        }

        async function enumerate() {
            // 仅 leader 建订阅；in-flight 锁避免慢响应时重复枚举（枚举本身幂等）
            if (!ctx.running || !ctx.engineOn || ctx.enumRunning) return;
            ctx.enumRunning = true;
            try {
                discoverPortFromPerf();
                absorbEarlyCapture();
                if (!ctx.port || !ctx.token) return;
                const r = await unary('GetAllCascadeTrajectories', {});
                if (!ctx.engineOn) return; // await 期间已降级为 follower：丢弃本次结果，不再建订阅
                if (r.status !== 200 || !r.json) return;
                const sums = r.json.trajectorySummaries || {};
                const live = new Set(Object.keys(sums));
                // 清理已删除会话的订阅，避免对不存在的会话无限重连造成空转
                for (const cid of [...ctx.subs.keys()]) {
                    if (!live.has(cid)) {
                        const stale = ctx.subs.get(cid);
                        try { stale.ac.abort(); } catch (e) { }
                        ctx.subs.delete(cid);
                        // 同步清理该会话的去重键，避免会话删除后 handled 无限累积
                        const prefix = cid + '#';
                        for (const k of [...ctx.handled.keys()]) {
                            if (k.startsWith(prefix)) ctx.handled.delete(k);
                        }
                    }
                }
                for (const cid of live) subscribe(cid);
            } catch (e) { }
            finally { ctx.enumRunning = false; }
        }

        // 用 Web Worker 计时驱动枚举，后台标签下不被 Chromium 节流
        async function enumLoop() {
            while (ctx.running && ctx.engineOn) {
                await workerDelay(ENUM_INTERVAL);
                enumerate();
            }
        }

        // -------- 跨页面 Leader 选举（同一 LS 端口只保留一个订阅者）--------
        // 同源（vscode-file://vscode-app）多窗口共享一个 BroadcastChannel；
        // Bully 规则：固定长度随机 id 最小且心跳活跃者为 leader，崩溃后租约过期自动接管。
        const COORD_CH = 'autoall-coord-v1';
        const LEASE_MS = 6000, BEAT_MS = 2000, VOTE_MS = 1500, TICK_MS = 1000;

        function coordPost(type) {
            try {
                if (ctx.channel && ctx.port) {
                    ctx.channel.postMessage({ ch: 'aa', id: ctx.myId, port: ctx.port, type, ts: Date.now() });
                }
            } catch (e) { }
        }

        function onCoord(msg) {
            if (!msg || msg.ch !== 'aa' || !msg.port || msg.port !== ctx.port || msg.id === ctx.myId) return;
            // leader 主动退位：移除其记录，让其余页面尽快重选，而非等租约过期
            if (msg.type === 'yield') { ctx.leaderMap.delete(msg.port); return; }
            ctx.leaderMap.set(msg.port, { id: msg.id, ts: Date.now() });
            // 存在 id 更小的活跃对端时，本页面绝不能当 leader，立即降级
            if (msg.id < ctx.myId && ctx.isLeader) stepDown();
        }

        // 纯函数：当前端口本页面是否应担任 leader
        function shouldBeLeader(now) {
            const L = ctx.leaderMap.get(ctx.port);
            if (!L || now - L.ts > LEASE_MS) return true; // 无 leader 或租约过期 -> 可接管
            return L.id >= ctx.myId;                       // 现 leader id 更大 -> 本页面更有资格
        }

        function becomeLeader() {
            ctx.isLeader = true;
            pushTrace({ t: 'leader', lead: 1, port: ctx.port });
            log('[Net] Became subscription leader for this window');
            engineStart();
            ctx.beatAt = Date.now();
            coordPost('beat');
        }

        function stepDown() {
            if (!ctx.isLeader) return;
            ctx.isLeader = false;
            pushTrace({ t: 'leader', lead: 0 });
            log('[Net] Stepped down (another window leads subscriptions)');
            engineStop();
        }

        function electionTick() {
            discoverPortFromPerf();
            absorbEarlyCapture();
            if (!ctx.port) return;
            // LS 重启换端口：丢弃旧端口的选举记录，避免被残留 leader 压制
            if (ctx.lastPort && ctx.lastPort !== ctx.port) {
                ctx.leaderMap.delete(ctx.lastPort);
                if (ctx.isLeader) { engineStop(); ctx.isLeader = false; }
            }
            ctx.lastPort = ctx.port;
            const now = Date.now();
            const lead = shouldBeLeader(now);
            if (lead && !ctx.isLeader) { becomeLeader(); return; }
            if (!lead && ctx.isLeader) { stepDown(); return; }
            if (ctx.isLeader && now - ctx.beatAt >= BEAT_MS) { ctx.beatAt = now; coordPost('beat'); }
            else if (!ctx.isLeader && now - ctx.voteAt >= VOTE_MS) {
                const L = ctx.leaderMap.get(ctx.port);
                if (!L || now - L.ts > LEASE_MS) { ctx.voteAt = now; coordPost('vote'); }
            }
        }

        async function electionLoop() {
            while (ctx.running) {
                try { electionTick(); } catch (e) { }
                await workerDelay(TICK_MS);
            }
        }

        // 订阅引擎：仅 leader 运行（枚举 + 每会话长连接）
        function engineStart() {
            if (ctx.engineOn) return;
            ctx.engineOn = true;
            enumerate();
            enumLoop();
        }

        function engineStop() {
            if (!ctx.engineOn) return;
            ctx.engineOn = false;
            for (const [, rec] of ctx.subs) { try { rec.ac.abort(); } catch (e) { } }
            ctx.subs.clear();
            ctx.handled.clear();
        }

        function startElection() {
            try {
                ctx.channel = new BroadcastChannel(COORD_CH);
                ctx.channel.onmessage = ev => onCoord(ev && ev.data);
            } catch (e) { ctx.channel = null; }
            electionLoop();
        }

        function start() {
            if (ctx.running) return;
            ctx.running = true;
            installFetchHook();
            discoverPortFromPerf();
            absorbEarlyCapture();
            // 只读诊断视图（订阅数 / 端口 / token / leader 状态 / 链路 trace），供自查与排障
            if (window.__autoAllState) {
                window.__autoAllState.netDiag = {
                    subs: ctx.subs,
                    get port() { return ctx.port; },
                    get tokenState() { return ctx.token ? 'set' : 'none'; },
                    handledCount: () => ctx.handled.size,
                    get isLeader() { return ctx.isLeader; },
                    get engineOn() { return ctx.engineOn; },
                    myId: () => ctx.myId,
                    leaderInfo: () => {
                        const L = ctx.leaderMap.get(ctx.port);
                        return L ? { id: L.id.slice(0, 8), ageMs: Date.now() - L.ts } : null;
                    },
                    trace: () => ctx.trace.slice()
                };
            }
            startElection(); // 选举结果驱动 engineStart，不再无条件订阅
            log('[Net] Multi-conversation network auto-accept started');
        }

        function stop() {
            ctx.running = false;
            coordPost('yield');
            try { if (ctx.channel) ctx.channel.close(); } catch (e) { }
            ctx.channel = null;
            engineStop();
            log('[Net] Multi-conversation network auto-accept stopped');
        }

        return { start, stop };
    }
    let networkAutoAccept = null;

    async function unifiedLoop(sid) {
        log('[Loop] Unified Smart Loop STARTED');
        const state = window.__autoAllState;
        let cycle = 0;
        let actionCheckRequested = true;
        let actionCheckRunning = false;
        let wasWorking = false;
        const observers = [];

        const UNIVERSAL_BTN_SELECTORS = [
            'button', 
            '[class*="button"]', 
            '[class*="anysphere"]', 
            '[class*="apply"]', 
            '[class*="accept"]', 
            '[class*="execute"]',
            '[class*="confirm"]',
            '[class*="primary"]',
            '.bg-ide-button-background', // Antigravity specific
            '.interactive-input-execute', // VS Code standard
            '.chat-apply-button'
        ];

        const actionSelectors = state.currentMode === 'antigravity'
            ? [
                '#antigravity\\.agentPanel button',
                '.antigravity-agent-side-panel button',
                '.interactive-session button',
                '#antigravity\\.agentPanel [role="button"]',
                '.antigravity-agent-side-panel [role="button"]',
                '.interactive-session [role="button"]',
                '#antigravity\\.agentPanel [class*="button"], .antigravity-agent-side-panel [class*="button"], .interactive-session [class*="button"]',
                '#antigravity\\.agentPanel [class*="accept"], .antigravity-agent-side-panel [class*="accept"], .interactive-session [class*="accept"]',
                '#antigravity\\.agentPanel [class*="apply"], .antigravity-agent-side-panel [class*="apply"], .interactive-session [class*="apply"]',
                '#antigravity\\.agentPanel [class*="execute"], .antigravity-agent-side-panel [class*="execute"], .interactive-session [class*="execute"]',
                '#antigravity\\.agentPanel [class*="confirm"], .antigravity-agent-side-panel [class*="confirm"], .interactive-session [class*="confirm"]',
                '#antigravity\\.agentPanel .bg-ide-button-background, .antigravity-agent-side-panel .bg-ide-button-background, .interactive-session .bg-ide-button-background'
            ]
            : UNIVERSAL_BTN_SELECTORS;

        const requestActionCheck = () => { 
            actionCheckRequested = true; 
            cachedSearchRoots = null;
            cachedRootsTimestamp = 0;
        };

        const installActionObservers = () => {
            if (typeof MutationObserver === 'undefined') return;
            getSearchRoots(true).forEach(root => {
                if (!root) return;
                const observer = new MutationObserver(mutations => {
                    if (mutations.some(mutation => mutation.type === 'childList' || mutation.type === 'attributes')) {
                        if (getComposerMode() === 'working') wasWorking = true;
                        requestActionCheck();
                    }
                });
                observer.observe(root, {
                    subtree: true,
                    childList: true,
                    attributes: true,
                    attributeFilter: ['class', 'disabled', 'aria-disabled', 'style']
                });
                observers.push(observer);
            });
        };

        installActionObservers();

        function getComposerMode() {
            // Antigravity 为模型生成使用专用的同一个输入按钮切换 Send/Stop。
            const stop = findAny(
                '#antigravity\\.agentPanel [data-tooltip-id="input-send-button-stop-tooltip"], ' +
                '.antigravity-agent-side-panel [data-tooltip-id="input-send-button-stop-tooltip"], ' +
                '.interactive-session [data-tooltip-id="input-send-button-stop-tooltip"]'
            );
            if (stop) return 'working';

            const send = findAny(
                '#antigravity\\.agentPanel [data-tooltip-id="input-send-button-send-tooltip"], ' +
                '.antigravity-agent-side-panel [data-tooltip-id="input-send-button-send-tooltip"], ' +
                '.interactive-session [data-tooltip-id="input-send-button-send-tooltip"]'
            );
            return send ? 'done' : null;
        }

        function isWorking() {
            // 专用输入按钮存在时，只信任它；MCP 工具的加载器不属于模型生成。
            const composerMode = getComposerMode();
            if (composerMode !== null) return composerMode === 'working';

            // 旧界面没有专用按钮时，才使用受限的 Agent 面板回退检测。
            const cancelBtn = findFirst(
                '#antigravity\\.agentPanel [data-tooltip-id*="cancel"], .antigravity-agent-side-panel [data-tooltip-id*="cancel"], .interactive-session [data-tooltip-id*="cancel"], ' +
                '#antigravity\\.agentPanel .bg-red-500, .antigravity-agent-side-panel .bg-red-500, .interactive-session .bg-red-500, ' +
                '#antigravity\\.agentPanel button[aria-label*="Stop" i], .antigravity-agent-side-panel button[aria-label*="Stop" i], .interactive-session button[aria-label*="Stop" i], ' +
                '#antigravity\\.agentPanel button[title*="Stop" i], .antigravity-agent-side-panel button[title*="Stop" i], .interactive-session button[title*="Stop" i], ' +
                '#antigravity\\.agentPanel button[aria-label*="停止" i], .antigravity-agent-side-panel button[aria-label*="停止" i], .interactive-session button[aria-label*="停止" i], ' +
                '#antigravity\\.agentPanel button[title*="停止" i], .antigravity-agent-side-panel button[title*="停止" i], .interactive-session button[title*="停止" i], ' +
                '#antigravity\\.agentPanel button[aria-label*="Interrupt" i], .antigravity-agent-side-panel button[aria-label*="Interrupt" i], .interactive-session button[aria-label*="Interrupt" i]'
            );
            if (cancelBtn) return true;

            const spinner = findFirst(
                '#antigravity\\.agentPanel .animate-spin, .antigravity-agent-side-panel .animate-spin, .interactive-session .animate-spin, ' +
                '#antigravity\\.agentPanel .codicon-loading, .antigravity-agent-side-panel .codicon-loading, .interactive-session .codicon-loading, ' +
                '#antigravity\\.agentPanel [data-status="running"], .antigravity-agent-side-panel [data-status="running"], .interactive-session [data-status="running"], ' +
                '#antigravity\\.agentPanel [data-status="in_progress"], .antigravity-agent-side-panel [data-status="in_progress"], .interactive-session [data-status="in_progress"], ' +
                '#antigravity\\.agentPanel .progress-container.active, .antigravity-agent-side-panel .progress-container.active, .interactive-session .progress-container.active'
            );
            if (spinner) return true;

            return false;
        }

        function hasDoneIndicator() {
            const composerMode = getComposerMode();
            if (composerMode !== null) return composerMode === 'done';

            // 旧界面回退：Cancel 红块彻底销毁，且存在 Copy 图标或输入就绪。
            const isCancelling = findFirst(
                '#antigravity\\.agentPanel [data-tooltip-id*="cancel"], .antigravity-agent-side-panel [data-tooltip-id*="cancel"], .interactive-session [data-tooltip-id*="cancel"], ' +
                '#antigravity\\.agentPanel .bg-red-500, .antigravity-agent-side-panel .bg-red-500, .interactive-session .bg-red-500'
            );
            if (isCancelling) return false;

            return !!findFirst(
                '#antigravity\\.agentPanel .lucide-copy, .antigravity-agent-side-panel .lucide-copy, .interactive-session .lucide-copy, ' +
                '#antigravity\\.agentPanel svg.lucide-copy, .antigravity-agent-side-panel svg.lucide-copy, .interactive-session svg.lucide-copy, ' +
                '#antigravity\\.agentPanel [data-tooltip-id*="submit"], .antigravity-agent-side-panel [data-tooltip-id*="submit"], .interactive-session [data-tooltip-id*="submit"], ' +
                '#antigravity\\.agentPanel button[aria-label*="Send" i], .antigravity-agent-side-panel button[aria-label*="Send" i], .interactive-session button[aria-label*="Send" i]'
            );
        }

        function hasPendingAcceptButtons() {
            const elements = queryAll(actionSelectors.join(', '));
            for (const el of elements) {
                if (isAcceptButton(el)) return true;
            }
            return false;
        }

        while (state.isRunning && state.sessionID === sid) {
            cycle++;

            // 1. CLICK ACTIONS (自动化辅助点击)
            let clicked = 0;
            if (actionCheckRequested && !actionCheckRunning) {
                actionCheckRequested = false;
                actionCheckRunning = true;
                try {
                    // 自动接受独立于完成通知状态机，始终扫描 Agent 面板。
                    clicked = await performClick(actionSelectors);
                } finally {
                    actionCheckRunning = false;
                }
            }
            if (clicked > 0) {
                log(`[Loop] Cycle ${cycle}: Auto-accepted ${clicked} actions`);
            }

            // 2. 状态机：边沿触发（从 Working 状态转移到 Done 状态时，精确触发单次通知）
            const currentlyWorking = isWorking();

            if (currentlyWorking) {
                wasWorking = true;
            } else if (wasWorking) {
                // 刚跑完生成，且检测到正向完成标识（Copy 图标或发送就绪）
                if (!hasPendingAcceptButtons() && hasDoneIndicator()) {
                    log('[Event] AI Final Response Completed (Positive Indicator Detected)! Emitting TASK_COMPLETED...');
                    console.log('[AUTO_AGENT_EVENT:TASK_COMPLETED]');
                    wasWorking = false;
                }
            }

            // 3. 前台 DOM 兜底：只扫描当前可见会话，绝不切换会话标签。
            //    后台 / 未打开会话由网络层状态流长连接统一自动确认，
            //    避免循环切换大会话引发的重渲染卡顿。
            const loopLimit = window.__autoAllState.isPro ? 200 : 5000;
            await workerDelay(Math.max(window.__autoAllState.pollInterval || 1000, loopLimit));
        }
        observers.forEach(observer => observer.disconnect());
        log('[Loop] Unified Smart Loop STOPPED');
    }

    window.__autoAllUpdateBannedCommands = function (bannedList) {
        const state = window.__autoAllState;
        state.bannedCommands = Array.isArray(bannedList) ? bannedList : [];
        log(`[Config] Updated banned commands list: ${state.bannedCommands.length} patterns`);
        if (state.bannedCommands.length > 0) {
            log(`[Config] Banned patterns: ${state.bannedCommands.join(', ')}`);
        }
    };

    window.__autoAllGetStats = function () {
        const stats = Analytics.getStats();
        return {
            clicks: stats.clicksThisSession || 0,
            blocked: stats.blockedThisSession || 0,
            sessionStart: stats.sessionStartTime,
            fileEdits: stats.fileEditsThisSession || 0,
            terminalCommands: stats.terminalCommandsThisSession || 0,
            actionsWhileAway: stats.actionsWhileAway || 0
        };
    };

    window.__autoAllResetStats = function () {
        return Analytics.collectROI(log);
    };

    window.__autoAllGetSessionSummary = function () {
        return Analytics.getSessionSummary();
    };

    window.__autoAllGetAwayActions = function () {
        return Analytics.consumeAwayActions(log);
    };

    window.__autoAllSetFocusState = function (isFocused) {
        Analytics.setFocusState(isFocused, log);
    };

    window.__autoAllStart = function (config) {
        try {
            const ide = (config.ide || 'cursor').toLowerCase();
            const isPro = config.isPro !== false;
            const isBG = config.isBackgroundMode === true;

            if (config.bannedCommands) {
                window.__autoAllUpdateBannedCommands(config.bannedCommands);
            }

            log(`__autoAllStart called: ide=${ide}, isPro=${isPro}, isBG=${isBG}`);

            const state = window.__autoAllState;

            // 递增 sessionID 优雅使旧循环退出
            state.sessionID = (state.sessionID || 0) + 1;
            const sid = state.sessionID;

            state.isRunning = true;
            state.currentMode = ide;
            state.isPro = isPro;
            state.isBackgroundMode = isBG;
            state.pollInterval = config.pollInterval || 1000;

            if (!state.stats.sessionStartTime) {
                state.stats.sessionStartTime = Date.now();
            }

            log(`Agent Loaded (IDE: ${ide}, Multi-Tab: ${isBG}, isPro: ${isPro})`, true);
            unifiedLoop(sid);

            // 网络层多会话自动确认：单例常驻，覆盖当前未打开的后台会话。
            // 扩展会周期性调用 __autoAllStart（syncSessions），start() 内部幂等，
            // 不得在此重建实例，否则长连接反复断开重连、去重状态丢失。
            try {
                if (!networkAutoAccept) networkAutoAccept = createNetworkAutoAccept();
                networkAutoAccept.start();
            } catch (e) {
                log(`[Net] start error: ${e.message}`);
            }
            return "started";
        } catch (e) {
            log(`ERROR in __autoAllStart: ${e.message}`);
            console.error('[autoAll] Start error:', e);
        }
    };

    window.__autoAllStop = function () {
        window.__autoAllState.isRunning = false;
        try { if (networkAutoAccept) networkAutoAccept.stop(); } catch (e) { }
        log("Agent Stopped.");
    };

    // 本实例拆除函数：停掉网络层（选举广播 + 全部状态流订阅），并让在跑的 DOM 循环退出。
    // 由下一次重复注入本 IIFE 时在顶部调用，保证同一上下文永远只有一个活动实例。
    window.__autoAllTeardown = function () {
        try {
            if (window.__autoAllState) {
                window.__autoAllState.isRunning = false;
                window.__autoAllState.sessionID = (window.__autoAllState.sessionID || 0) + 1;
            }
        } catch (e) { }
        try { if (networkAutoAccept) networkAutoAccept.stop(); } catch (e) { }
    };

    log("Core Bundle Initialized.", true);
})();
