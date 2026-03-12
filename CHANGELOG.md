# Changelog

## [3.9.3] — 2026-03-12

### Bug Fix — Issue #36 (Browser Sub-Agent Crash, TRUE Root Cause)
- **Root cause identified**: The "Cannot freeze array buffer views with elements" crash was NOT caused by WebSocket architecture or CDP session conflicts. It was caused by the MutationObserver **clicking the "Expand" button** during browser sub-agent startup, which opened the `BROWSER_SUBAGENT_TRAJECTORY` modal. The modal's state contains TypedArray screenshot data that AG IDE's state management (`Pin`/`Krt` in `workbench.desktop.main.js`) tried to deep-freeze — triggering the crash in the **renderer process** (not extension host).
- **Fixed**: Removed `'expand'` from the auto-click keyword list in `DOMObserver.js`. The "Expand" button is no longer auto-clicked, preventing the trajectory modal from opening prematurely during browser sub-agent initialization.
- **Reverted** all unnecessary architecture changes from v3.8.3–v3.9.2 (per-target WebSocket, burst mode, child process isolation, Object.freeze interceptor) since the crash was in the renderer process, not the extension host.

### Bug Fix — False Positive "Run" Clicks
- **Fixed**: The MutationObserver was clicking terminal menu items like "Run Task..." and "Run Active File" because the keyword `'run'` with prefix+space matching allowed any text starting with "run " up to 15 chars. Tightened matching for short keywords (< 5 chars) to allow at most `keyword + 4` chars total, preventing menu item false positives while still matching "Run" and "RunAlt+⏎".
- **Fixed**: Keyboard shortcut suffix matching now works for short keywords too (lowered threshold from `length >= 5` to `length >= 3`).

---

## [3.8.3] — 2026-03-12

### Bug Fix — Issue #36 (Browser Sub-Agent Crash, Root Cause)
- **Fixed** "Cannot freeze array buffer views with elements" crash when using the AG browser sub-agent. The v3.8.0 fix (target URL filter) only addressed the surface — the real conflict was at two deeper levels:
  1. **Whitelist target filter**: Switched `_isCandidate` from a blacklist (skip `http://`/`https://`) to a whitelist (only attach to `vscode-webview://` URLs). The blacklist leaked `about:blank` targets created by the browser sub-agent before navigation.
  2. **Removed `Target.setDiscoverTargets`**: Subscribing to target lifecycle events broadcast them to ALL CDP clients sharing the Electron debug port, interfering with AG's internal browser sub-agent target management. Now relies solely on heartbeat polling (`Target.getTargets`).

### Performance
- **Reduced** heartbeat interval from 30s to 10s to compensate for removing real-time target discovery events. New webview targets are now discovered within 10s instead of 30s.

---

## [3.8.0] — 2026-03-11

### Bug Fixes — Idle Failure (Root Cause)
- **Fixed** extension silently dying after 2+ minutes of idle. The fallback scan used `requestIdleCallback` which **never fires** in backgrounded Chromium webviews — the 10-second safety net was completely dead. Replaced with `setTimeout`.
- **Fixed** watchdog false-positive: the heartbeat declared the observer "dead" after 120s of no DOM mutations (idle = no scans = stale `__AA_LAST_SCAN`). The fallback interval now updates the timestamp on every tick, proving liveness even when idle.
- **Fixed** fallback interval lost on re-injection race: if re-injection returned `'already-active'`, the old interval was cleared but no new one was installed.

### Bug Fixes — Reliability
- **Fixed** heartbeat stacking after system sleep/resume. Replaced `setInterval` with recursive `setTimeout` — guarantees only one heartbeat runs at a time.
- **Added** WebSocket ping/pong keepalive (45s ping, 10s pong timeout) to detect zombie connections after laptop sleep.
- **Fixed** expand button cooldown key mismatch — `findButton` and `scanAndClick` used different key formats, silently bypassing the 30s cooldown.
- **Fixed** poll cycle re-entrancy — overlapping command executions when extension host is slow (3s timeout race).
- **Fixed** click leaks when toggled off: `_reinjectForSession` now respects `isPaused` state.
- **Removed** dead `activeCommands` variable in `startPolling()`.

### Bug Fixes — Issue #36 (Browser Sub-Agent Conflict)
- **Fixed** "Cannot freeze array buffer views with elements" error when using the browser sub-agent. The extension was attaching to **all** page targets including `http://`/`https://` pages opened by the sub-agent, causing competing CDP commands. Now filters out non-webview page targets.

### Diagnostics
- **Added** `SKIP_LONG_TEXT` diagnostic entry when a potential button match is dropped by the 50-character text filter — previously silently ignored.

### Dashboard
- **Fixed** command filter escaping vulnerability — replaced fragile inline `onclick` string concatenation with data-attribute event delegation.

---

## [3.7.8] — 2026-03-10

### Bug Fixes
- **Fixed** Accept button not being auto-clicked. Antigravity renders buttons like `<button>Accept<kbd>Alt+⏎</kbd></button>` where `textContent` concatenates to `"AcceptAlt+⏎"` (no space). The word boundary check treated `'a'` (from `Alt`) as a continuation of the keyword, silently skipping the match. Added keyboard shortcut suffix detection (`alt|ctrl|shift|cmd|meta`) as a fourth matching condition.
- **Fixed** Expand all / Collapse all infinite toggle loop. The `'expand'` keyword matched `"Expand all"` via `startsWith`, clicking it every 5s. On click, it toggled to "Collapse all" (triggering a DOM mutation), then back — creating an infinite cycle. Expand keywords now require **exact text match only**.
- **Removed** permanent `expandedOnce` session-lifetime suppression for expand buttons. Replaced with a 30s DOM-path-keyed cooldown that allows the same expand button to be re-clicked after the window expires.

### Diagnostics
- **Improved** heartbeat diagnostic output: `SKIP_DISABLED`, `SKIP_COOLDOWN`, and `CLICKED` events now display with type-specific formatting instead of a generic fallback that showed `undefined` fields.
- **Fixed** cooldown pruning: `maxAge` now uses `EXPAND_COOLDOWN_MS * 2` (60s) instead of the stale `COOLDOWN_MS * 3` (15s), preventing premature eviction of expand button cooldown entries.

---

## [3.0.0] — 2026-02-28

### Architecture: Event-Driven CDP (Zero-Polling)
- **Replaced** attach→evaluate→detach polling cycle with **persistent CDP sessions** (`Map<targetId, sessionId>`)
- **Replaced** periodic script injection with one-shot **MutationObserver** payload — reacts instantly when buttons appear in DOM
- **Connection Manager**: browser-level WebSocket stays open, uses `Target.targetCreated`/`Target.targetDestroyed` events for lifecycle
- **Self-healing**: automatic reconnection on WebSocket close, re-injection on execution context clear (webview navigation)
- **Heartbeat**: periodic health check + new target discovery every 30s

### Modularization
- **Split** monolithic 589-line `extension.js` into three modules:
  - `src/extension.js` — VS Code lifecycle, command polling, auto-fix patcher
  - `src/cdp/ConnectionManager.js` — persistent WebSocket, session pool, target management
  - `src/scripts/DOMObserver.js` — MutationObserver payload generator

### Robustness Improvements
- **Deferred Webview Guard**: DOM structure check moved inside `scanAndClick()` to avoid race condition with unhydrated React DOM on `targetCreated`
- **Sequential Polling**: Replaced `setInterval` + async lock with recursive `setTimeout` — eliminates lock corruption from overlapping cycles
- **Polling Hang Protection**: `Promise.race` with 3s timeout guarantees the command polling loop can never permanently hang
- **Sibling-Indexed Cooldowns**: `_domPath()` now includes nth-child sibling indices at every DOM level, preventing cooldown collisions when multiple identical buttons appear in a list
- **100ms Throttle**: MutationObserver fires scanAndClick within 100ms of first DOM change (down from 200ms)

### Localized Cooldowns
- **Moved** all cooldown state into the injected DOM script via closure-scoped `clickCooldowns` map
- **Eliminated** Node.js global `lastExpandTimes` map — cooldowns are fully per-element

### Continue Button Support (from v2.3.0)
- **Added** automatic clicking of the "Continue" button (agent invocation limit)

---

## [2.3.0] — 2026-02-28

### Continue Button Support
- **Added** automatic clicking of the "Continue" button that appears when the agent reaches its invocation limit for a single response.
- This enables fully unattended sessions — the agent now auto-resumes after hitting tool-call limits.

---

## [1.18.4] — 2026-02-23

### Browser-Level CDP Session Multiplexer
- **Fixed** critical compatibility issue with Electron 30+ / Chromium 120+. The legacy `/json/list` HTTP endpoint no longer exposes webview targets — all CDP evaluations were silently failing with `ReferenceError: document is not defined`.
- **Replaced** the entire CDP layer with a browser-level session multiplexer: connects via `/json/version`, enables `Target.setDiscoverTargets`, attaches to page targets with `Target.attachToTarget({ flatten: true })`, and evaluates scripts through session-tunneled `Runtime.evaluate`.
- **DOM access detection**: Automatically identifies which page targets have real DOM access (vs headless utility processes) before injecting the clicker script.

### Concurrent CDP Optimizations
- **Cooldown Illusion Fix**: Injected `CAN_EXPAND` variable directly into webview script to prevent DOM from clicking Expand while on cooldown.
- **Port Scanner Caching**: Caches active CDP port to eliminate unnecessary failing HTTP requests.
- **Dead Code Removal**: Deleted 120+ lines of deprecated `cdpSendMulti` and `clickBannerViaDom`.

### CDP Script Fix
- **Fixed** `SyntaxError: Unexpected string` in CDP template literal.
- **Per-target cooldowns**: Expand cooldown tracked per chat thread (`lastExpandTimes[targetId]`).
- **Concurrent broadcast**: `Promise.allSettled()` for simultaneous webview evaluation.

---

## [1.18.3] — 2026-02-21

### Webview Guard Architecture (OOPIF migration fix)
- **Webview Guard**: DOM-marker check (`.react-app-container`) prevents execution on main VS Code window
- **startsWith matching**: "Run Alt+d" matches `run`, but "Always run ^" dropdown doesn't
- **Priority reorder**: `run` and `accept` checked before `always allow`
- **Removed dangerous commands**: `chatEditing.acceptAllFiles`, `inlineChat.acceptChanges` etc. removed (caused sidebar interference)
- **Removed problematic texts**: `expand` (infinite click loop), `always run` (clicked dropdown toggle)

### CDP Auto-Fix
- **Detection**: Extension checks CDP port 9222 on activation
- **Auto-Fix Shortcut**: PowerShell patcher finds Antigravity shortcuts and adds `--remote-debugging-port=9222`
- **Manual Guide**: Links to GitHub README setup instructions

### Safety
- Script exits immediately on non-agent-panel targets
- Only Antigravity-specific VS Code commands in polling loop
- Clean logging — only actual button clicks are logged

---

## [2.1.0] — 2025-02-20

### Complete Rewrite (V2)
- **Replaced** 1,435-line CDP DOM scraper with hybrid architecture
- **Primary:** VS Code Commands API with async lock
- **Secondary:** Targeted CDP with Shadow DOM piercing for permission dialogs

### Removed
- All CDP DOM scraping code (1,435 lines)
- Settings panel UI (34KB)
- 18 main_scripts helper files
