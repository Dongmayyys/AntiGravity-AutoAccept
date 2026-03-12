// AntiGravity AutoAccept — CDP Connection Manager
// Child process isolation: all ws WebSocket instances live in a forked
// child process (cdp-worker.js). The main extension process has ZERO
// WebSocket instances, making it immune to the "Cannot freeze array
// buffer views with elements" crash (issue #36).

const http = require('http');
const path = require('path');
const { fork } = require('child_process');
const { buildDOMObserverScript } = require('../scripts/DOMObserver');

class ConnectionManager {
    constructor({ log, getPort, getCustomTexts }) {
        this.log = log;
        this.getPort = getPort;
        this.getCustomTexts = getCustomTexts;

        // Tracked targets (metadata only — no sockets in this process)
        this.sessions = new Map();          // targetId → { url, wsUrl }
        this.sessionUrls = new Map();       // targetId → url (compat)
        this.ignoredTargets = new Set();
        this.activeCdpPort = null;

        // Command filters
        this.blockedCommands = [];
        this.allowedCommands = [];
        this.autoAcceptFileEdits = true;

        // Lifecycle
        this.isRunning = false;
        this.isPaused = false;
        this.isConnecting = false;
        this.reconnectTimer = null;
        this.heartbeatTimer = null;
        this.onStatusChange = null;
        this.onClickTelemetry = null;
        this._sessionFailCounts = new Map();
        this._heartbeatRunning = false;
        this._injectionFailCounts = new Map();

        // Child process (owns all WebSocket instances)
        this._worker = null;
        this._pendingIpc = new Map();
        this._ipcId = 0;

        // Compat shim
        this._connected = false;
    }

    get ws() {
        return this._connected ? { readyState: 1 } : null;
    }

    // ─── Child Process Management ─────────────────────────────────────

    _ensureWorker() {
        if (this._worker && !this._worker.killed) return this._worker;

        const workerPath = path.join(__dirname, 'cdp-worker.js');
        this._worker = fork(workerPath, [], { silent: true });

        this._worker.on('message', (msg) => {
            if (msg.id && this._pendingIpc.has(msg.id)) {
                const handler = this._pendingIpc.get(msg.id);
                this._pendingIpc.delete(msg.id);
                clearTimeout(handler.timer);
                if (msg.error) {
                    handler.reject(new Error(msg.error));
                } else {
                    handler.resolve(msg.result || msg);
                }
            }
        });

        this._worker.on('exit', (code) => {
            this.log(`[CDP] Worker exited (code ${code})`);
            this._worker = null;
            for (const [id, handler] of this._pendingIpc) {
                clearTimeout(handler.timer);
                handler.reject(new Error('worker exited'));
            }
            this._pendingIpc.clear();
        });

        this._worker.on('error', (e) => {
            this.log(`[CDP] Worker error: ${e.message}`);
        });

        if (this._worker.stdout) {
            this._worker.stdout.on('data', (d) => this.log(`[Worker] ${d.toString().trim()}`));
        }
        if (this._worker.stderr) {
            this._worker.stderr.on('data', (d) => this.log(`[Worker ERR] ${d.toString().trim()}`));
        }

        this.log('[CDP] Worker process spawned');
        return this._worker;
    }

    _workerEval(wsUrl, expression) {
        return new Promise((resolve, reject) => {
            const worker = this._ensureWorker();
            const id = ++this._ipcId;
            const timer = setTimeout(() => {
                this._pendingIpc.delete(id);
                reject(new Error('ipc timeout'));
            }, 10000);
            this._pendingIpc.set(id, { resolve, reject, timer });
            worker.send({ type: 'eval', id, wsUrl, expression });
        });
    }

    _workerBurstInject(wsUrl, targetId, script, isPaused) {
        return new Promise((resolve, reject) => {
            const worker = this._ensureWorker();
            const id = ++this._ipcId;
            const timer = setTimeout(() => {
                this._pendingIpc.delete(id);
                reject(new Error('ipc timeout'));
            }, 15000);
            this._pendingIpc.set(id, { resolve, reject, timer });
            worker.send({ type: 'burst-inject', id, wsUrl, targetId, script, isPaused });
        });
    }

    _killWorker() {
        if (this._worker && !this._worker.killed) {
            try { this._worker.send({ type: 'shutdown' }); } catch (e) { }
            setTimeout(() => {
                if (this._worker && !this._worker.killed) {
                    this._worker.kill();
                }
            }, 1000);
        }
        this._worker = null;
    }

    // ─── Public API ───────────────────────────────────────────────────

    setCommandFilters(blocked, allowed) {
        this.blockedCommands = blocked || [];
        this.allowedCommands = allowed || [];
    }

    async pushFilterUpdate(blocked, allowed) {
        if (this.sessions.size === 0) return;
        const hasFilters = (blocked.length > 0 || allowed.length > 0);
        const expr = `
            window.__AA_BLOCKED = ${JSON.stringify(blocked)};
            window.__AA_ALLOWED = ${JSON.stringify(allowed)};
            window.__AA_HAS_FILTERS = ${hasFilters};
            'filters-updated';
        `;
        for (const [targetId, info] of this.sessions) {
            try {
                await this._workerEval(info.wsUrl, expr);
                this.log(`[CDP] Pushed filter update to ${targetId.substring(0, 6)}`);
            } catch (e) { }
        }
    }

    async reinjectAll() {
        if (this.sessions.size === 0) return;
        const script = buildDOMObserverScript(
            this.getCustomTexts(), this.blockedCommands, this.allowedCommands, this.autoAcceptFileEdits
        );
        for (const [targetId, info] of this.sessions) {
            try {
                const msg = await this._workerBurstInject(info.wsUrl, targetId, script, this.isPaused);
                const result = msg.result || 'unknown';
                this.log(`[CDP] Re-injected [${targetId.substring(0, 6)}] → ${result}`);
            } catch (e) {
                this.log(`[CDP] Reinject failed for ${targetId.substring(0, 6)}: ${e.message}`);
            }
        }
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.isPaused = false;
        this.log('[CDP] Connection manager starting (child process isolation)');
        this.connect();
    }

    pause() {
        this.isPaused = true;
        for (const [targetId, info] of this.sessions) {
            this._workerEval(info.wsUrl, 'window.__AA_PAUSED = true; "paused"')
                .then(() => this.log(`[CDP] Paused session ${targetId.substring(0, 6)}`))
                .catch(e => this.log(`[CDP] Pause failed for ${targetId.substring(0, 6)}: ${e.message}`));
        }
        this.log('[CDP] All sessions paused');
        if (this.onStatusChange) this.onStatusChange();
    }

    unpause() {
        this.isPaused = false;
        this.reinjectAll();
        this.log('[CDP] All sessions unpaused + re-injected');
        if (this.onStatusChange) this.onStatusChange();
    }

    stop() {
        this.isRunning = false;
        this.isPaused = false;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        clearTimeout(this.heartbeatTimer);
        this.heartbeatTimer = null;
        for (const [targetId, info] of this.sessions) {
            this._workerEval(info.wsUrl, `
                window.__AA_PAUSED = true;
                if (window.__AA_OBSERVER) { window.__AA_OBSERVER.disconnect(); window.__AA_OBSERVER = null; }
                'killed';
            `).catch(() => {});
        }
        this.sessions.clear();
        this.sessionUrls.clear();
        this.ignoredTargets.clear();
        this._sessionFailCounts.clear();
        this._injectionFailCounts.clear();
        this._connected = false;
        this._killWorker();
        this.log('[CDP] Connection manager stopped');
    }

    getSessionCount() { return this.sessions.size; }
    getActivePort() { return this.activeCdpPort; }

    // ─── Connection Lifecycle ─────────────────────────────────────────

    async connect() {
        if (!this.isRunning || this.isConnecting) return;
        this.isConnecting = true;

        try {
            const port = await this._findActivePort();
            if (!port) { this._scheduleReconnect(); return; }

            const targets = await this._getTargetList(port);
            if (!targets || targets.length === 0) {
                this.log('[CDP] No targets found');
                this._scheduleReconnect();
                return;
            }

            this._connected = true;
            if (this.onStatusChange) this.onStatusChange();

            const candidates = targets.filter(t => this._isCandidate(t));
            this.log(`[CDP] Found ${targets.length} targets, ${candidates.length} candidates`);

            await Promise.allSettled(candidates.map(t => this._handleNewTarget(t)));

            this.log(`[CDP] ${this.sessions.size} sessions active after initial scan`);
            this._scheduleHeartbeat();
        } catch (e) {
            this.log(`[CDP] Connection error: ${e.message}`);
            this._scheduleReconnect();
        } finally {
            this.isConnecting = false;
        }
    }

    // ─── Target Discovery ─────────────────────────────────────────────

    _isCandidate(targetInfo) {
        const type = targetInfo.type;
        const url = targetInfo.url || '';
        if (!url) return false;
        if (type === 'service_worker' || type === 'worker' || type === 'shared_worker') return false;
        if (url.startsWith('http://') || url.startsWith('https://') || url === 'about:blank') return false;
        return type === 'page' || type === 'iframe' ||
            url.includes('vscode-webview') || url.includes('webview');
    }

    async _handleNewTarget(targetInfo) {
        const { id: targetId, webSocketDebuggerUrl, type, url } = targetInfo;
        if (!targetId || !webSocketDebuggerUrl) return;
        const shortId = targetId.substring(0, 6);
        if (this.sessions.has(targetId) || this.ignoredTargets.has(targetId)) return;

        // URL dedup
        if (url) {
            for (const [existingTid, info] of this.sessions) {
                if (info.url && info.url === url) {
                    this.ignoredTargets.add(targetId);
                    return;
                }
            }
        }

        try {
            const script = buildDOMObserverScript(
                this.getCustomTexts(), this.blockedCommands, this.allowedCommands, this.autoAcceptFileEdits
            );
            const msg = await this._workerBurstInject(webSocketDebuggerUrl, targetId, script, this.isPaused);
            const result = msg.result || 'unknown';

            if (result !== 'observer-installed' && result !== 'already-active') {
                this.log(`[CDP] [${shortId}] Injection result: ${result}`);
                if (result === 'not-agent-panel' || result === 'no-window') {
                    this.ignoredTargets.add(targetId);
                } else {
                    const count = (this._injectionFailCounts.get(targetId) || 0) + 1;
                    this._injectionFailCounts.set(targetId, count);
                    if (count >= 3) this.ignoredTargets.add(targetId);
                }
                return;
            }

            this.sessions.set(targetId, { url: url || '', wsUrl: webSocketDebuggerUrl });
            this.sessionUrls.set(targetId, url || '');
            this.log(`[CDP] ✓ Injected [${shortId}] → ${result} (${(url || '').substring(0, 50)})`);
        } catch (e) {
            this.log(`[CDP] [${shortId}] Inject error: ${e.message}`);
        }
    }

    // ─── Health & Reconnection ────────────────────────────────────────

    _scheduleReconnect() {
        if (this.reconnectTimer || !this.isRunning) return;
        this.log('[CDP] Reconnecting in 3s...');
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.isRunning) this.connect();
        }, 3000);
    }

    _scheduleHeartbeat() {
        clearTimeout(this.heartbeatTimer);
        this.heartbeatTimer = setTimeout(async () => {
            await this._heartbeat();
            if (this.isRunning && (this.sessions.size > 0 || this._connected)) {
                this._scheduleHeartbeat();
            }
        }, 10000);
    }

    async _heartbeat() {
        if (this._heartbeatRunning) return;
        this._heartbeatRunning = true;
        try {
            const port = this.activeCdpPort;
            if (!port) { this._heartbeatRunning = false; return; }

            const targets = await this._getTargetList(port);
            if (!targets) { this._heartbeatRunning = false; return; }

            this.log(`[CDP] Heartbeat: ${targets.length} targets, ${this.sessions.size} sessions`);

            // Discover new targets
            const candidates = targets.filter(t =>
                this._isCandidate(t) && !this.sessions.has(t.id) && !this.ignoredTargets.has(t.id)
            );
            if (candidates.length > 0) {
                this.log(`[CDP] ${candidates.length} new targets found, injecting...`);
                await Promise.allSettled(candidates.map(t => this._handleNewTarget(t)));
            }

            // Prune gone targets
            const activeIds = new Set(targets.map(t => t.id));
            for (const [targetId] of this.sessions) {
                if (!activeIds.has(targetId)) {
                    this.sessions.delete(targetId);
                    this.sessionUrls.delete(targetId);
                    this._sessionFailCounts.delete(targetId);
                    this.log(`[CDP] Target [${targetId.substring(0, 6)}] gone, pruned`);
                }
            }

            // Health check existing sessions
            if (this.sessions.size === 0) { this._heartbeatRunning = false; return; }

            const entries = [...this.sessions.entries()];
            const results = await Promise.allSettled(
                entries.map(async ([targetId, info]) => {
                    const check = await this._workerEval(info.wsUrl,
                        '(() => { const c = window.__AA_CLICK_COUNT || 0; window.__AA_CLICK_COUNT = 0; const d = window.__AA_DIAG || []; window.__AA_DIAG = []; return { alive: !!window.__AA_PAUSED || (!!window.__AA_OBSERVER_ACTIVE && (Date.now() - (window.__AA_LAST_SCAN || 0)) < 120000), clickCount: c, diag: d }; })()'
                    );
                    const health = check.result?.result?.value || { alive: false, clickCount: 0, diag: null };
                    return { targetId, alive: health.alive, clickCount: health.clickCount, diag: health.diag };
                })
            );

            const dead = [];
            for (let i = 0; i < results.length; i++) {
                const { status, value } = results[i];
                const targetId = entries[i][0];
                const info = entries[i][1];
                const shortId = targetId.substring(0, 6);

                if (status === 'fulfilled') {
                    this._sessionFailCounts.delete(targetId);
                    if (this.onClickTelemetry && value.clickCount > 0) this.onClickTelemetry(value.clickCount);

                    if (value.diag && Array.isArray(value.diag) && value.diag.length > 0) {
                        for (const d of value.diag) {
                            if (d.action === 'BLOCKED') this.log(`[DIAG] [${shortId}] BLOCKED | matched=${d.matched} | cmd=${d.cmd || 'N/A'}`);
                            else if (d.action === 'CIRCUIT_BREAKER') this.log(`[DIAG] [${shortId}] ⚠️ CIRCUIT BREAKER | matched=${d.matched} | retries=${d.count}`);
                            else if (d.action === 'CLICKED') this.log(`[DIAG] [${shortId}] CLICKED | matched=${d.matched} | cmd=${d.cmd || 'N/A'} | near=${(d.near || '').substring(0, 60)}`);
                            else this.log(`[DIAG] [${shortId}] ${d.action} | ${JSON.stringify(d).substring(0, 100)}`);
                        }
                    }

                    if (!value.alive) {
                        this.log(`[CDP] Session [${shortId}] observer dead, re-injecting...`);
                        try {
                            const script = buildDOMObserverScript(
                                this.getCustomTexts(), this.blockedCommands, this.allowedCommands, this.autoAcceptFileEdits
                            );
                            const msg = await this._workerBurstInject(info.wsUrl, targetId, script, this.isPaused);
                            const result = msg.result || 'unknown';
                            if (result === 'not-agent-panel') {
                                dead.push(targetId); this.ignoredTargets.add(targetId);
                            } else if (result !== 'observer-installed' && result !== 'already-active') {
                                const fc = (this._sessionFailCounts.get(targetId) || 0) + 1;
                                this._sessionFailCounts.set(targetId, fc);
                                if (fc >= 3) dead.push(targetId);
                            } else {
                                this._sessionFailCounts.delete(targetId);
                                this.log(`[CDP] ✓ Re-injected [${shortId}] → ${result}`);
                            }
                        } catch (e) {
                            const fc = (this._sessionFailCounts.get(targetId) || 0) + 1;
                            this._sessionFailCounts.set(targetId, fc);
                            if (fc >= 3) dead.push(targetId);
                        }
                    }
                } else {
                    const fc = (this._sessionFailCounts.get(targetId) || 0) + 1;
                    this._sessionFailCounts.set(targetId, fc);
                    if (fc >= 3) { dead.push(targetId); this.log(`[CDP] Session [${shortId}] unreachable 3x, pruning`); }
                }
            }

            for (const tid of dead) {
                this.sessions.delete(tid);
                this.sessionUrls.delete(tid);
                this._sessionFailCounts.delete(tid);
            }
        } catch (e) { } finally { this._heartbeatRunning = false; }
    }

    // ─── Port & Target Discovery (HTTP only — no WebSocket) ───────────

    _pingPort(port) {
        return new Promise((resolve) => {
            const req = http.get({ hostname: '127.0.0.1', port, path: '/json/version', timeout: 800 }, (res) => {
                res.on('data', () => {});
                res.on('end', () => resolve(true));
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
        });
    }

    _getTargetList(port) {
        return new Promise((resolve) => {
            const req = http.get({ hostname: '127.0.0.1', port, path: '/json', timeout: 2000 }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
        });
    }

    async _findActivePort() {
        if (this.activeCdpPort && await this._pingPort(this.activeCdpPort)) return this.activeCdpPort;
        const configPort = this.getPort();
        if (await this._pingPort(configPort)) { this.activeCdpPort = configPort; return configPort; }
        return null;
    }

    // ─── Compat Shims ─────────────────────────────────────────────────
    _closeWebSocket() { }
    _clearPending() { }
}

module.exports = { ConnectionManager };
