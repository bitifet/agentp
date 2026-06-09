# agentp — agent notes

## Three binaries, all registered

- `bin/agentp` (Node.js) — registered in `package.json` `"bin"` — pipes stdin → opencode session
- `bin/ocmux` (Node.js) — registered in `package.json` `"bin"` — manages opencode tmux sessions
- `bin/tgagentp` (Node.js) — registered in `package.json` `"bin"` — bridges Telegram bot ↔ opencode TUI

## Package facts

- **Zero npm dependencies.** All scripts use only Node.js stdlib (`http`, `https`, `readline`, `url`, `child_process`, `fs`, `path`, `crypto`, `os`).
- **Tests via `node:test`** — run `npm test` (alias `node --test tests/*.test.js`). All external calls mocked; safe to run alongside live OpenCode.
- **No lockfile.** Versions resolve at install time.
- **`"type": "commonjs"`**, requires Node >= 18.
- **Linux and macOS compatible.** All tools use portable Node.js APIs only.

## Versioning policy

- **Do not bump the version in `package.json` without approval.**
- When a version bump feels warranted, append a pre-release suffix instead: `0.11.0-pre01`, `0.11.0-pre02`, etc.
- Update the **`CHANGELOG.md`** with the full summary of changes since the last published version (tagged on npm).
- The human maintainer reviews pre-releases and decides when to cut a final release (strip the suffix, tag, publish to npm).

## Logging conventions (tgagentp)

- **stdout** — informational messages (startup, discovery, session switches)
- **stderr** — errors (always shown) + trace/debug (only with `--verbose` flag)
- Default usage for clean console: `tgagentp 2>/dev/null`
- The `log` helper object at the top of `bin/tgagentp` provides `log.info()`, `log.error()`, and `log.debug()`.

## `.ocmux.json`

Runtime state file created by `bin/ocmux` (contains URL, log path, and window index). **Not in `.gitignore`** — avoid committing it.

## Shared `lib/opencode.js`

Extracted from `bin/agentp`; used by both `agentp` and `tgagentp`:

- `getAuthHeaders()` — reads `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME`
- `makeRequest(options, data)` — thin `http.request` wrapper returning a Promise
- `buildJsonRequest(url, method, body)` — builds request options for JSON POST/GET (no Content-Type/Length for bodyless requests)
- `clearPrompt(server)`, `appendPrompt(server, text)`, `submitPrompt(server)` — TUI prompt endpoints
- `sendText(server, text)` — convenience: clear + append + submit in one call
- `listenForFinalAnswer(server, onText?, cancelRef?)` — SSE event stream listener; `cancelRef` allows true server-side abort via `req.destroy()`
- `listSessions(server, directory?)` — `GET /session`; returns parsed JSON array; optional `?directory=` filter
- `createSession(server, title?)` — `POST /session`; returns the created `Session` object; optional `title`
- `updateSession(server, sessionId, title, agent?)` — `PATCH /session/:id`; returns the updated `Session` object; optional `agent` to set the session's agent
- `sendToSession(server, sessionId, text, agent?, cancelRef?)` — `POST /session/:id/message`; returns concatenated text parts from response; optional `agent`, optional `cancelRef` for aborting the request
- `sendToSessionAsync(server, sessionId, text, agent?)` — `POST /session/:id/prompt_async`; returns 204; non-blocking, answer delivered via SSE
- `respondToPermission(server, sessionId, permissionId, response)` — `POST /session/:id/permissions/:id`
- `selectSession(server, sessionId)` — `POST /session/:id/select`; tells the TUI to navigate to the given session (silently ignores 404 if the endpoint isn't available in older opencode versions)
- `listAgents(server)` — `GET /agent`; returns parsed JSON array of agent objects
- `listProviders(server)` — `GET /provider`; returns parsed JSON array of provider objects
- `isServerAlive(url)` — health check: `GET /session` with 5s timeout; resolves `true` (any response) or `false` (error/timeout)
- `listenForSessionEvents(server, sessionId, callbacks, cancelRef?)` — SSE listener for session events (text parts, permissions, thinking, session.idle)

## Shared `lib/ocmux.js`

Shared ocmux session discovery; used by both `bin/ocmux` and `bin/tgagentp`:

- `readState(file)` — parses `.ocmux.json`, returns `null` on error
- `statefileFor(dir)` — `path.join(dir, '.ocmux.json')`
- `tuiPaneId(windowIndex)` — returns pane ID of the TUI pane (pane index != 0), `null` if dead
- `windowByDir(dir)` — returns window index by name match
- `windowNameByIndex(idx)` — reverse: name from index
- `activeWindowIndex()` — returns index of currently selected tmux window
- `paneCount(windowIndex)` — number of panes in a window
- `listServers()` — scans all tmux windows for `.ocmux.json` state files; returns `{ url, dir, index, status }` array
- `activateServer(dir, index, url)` — pin window name, restart dead TUI pane, select window, zoom pane

## OpenCode HTTP protocol

These endpoints are consumed but not documented elsewhere in the repo:

- `POST /tui/clear-prompt`
- `POST /tui/append-prompt`
- `POST /tui/submit-prompt`
- `GET /event` (SSE stream)
- `GET /session` — list sessions (optional `?directory=` filter)
- `POST /session` — create a new session (optional `{ title? }` body)
- `PATCH /session/:id` — update session properties (`{ title }`, optional `{ agent }`)
- `POST /session/:id/select` — tell the TUI to navigate to a session (only with TUI attached)
- `POST /session/:id/message` — send message to session (returns parts synchronously; optional `agent` field)
- `POST /session/:id/prompt_async` — send message to session (returns 204; answer via SSE)
- `GET /agent` — list available agents
- `GET /provider` — list connected providers/models

## Agentp gateway (tgagentp ↔ agentp interop)

- tgagentp starts a tiny HTTP server (POST /send) on `127.0.0.1`, port from `TGAGENTP_PORT` (default 0 = random).
- Port is written to `/tmp/tgagentp-port` for agentp discovery.
- Validates `Authorization` header against `OPENCODE_SERVER_PASSWORD`.
- agentp `--tg` reads the port file and POSTs `{ text, server }` to the gateway.
- Messages for the active server are delivered immediately; others are queued per-server.
- Debounced Telegram notification (configurable via `TGAGENTP_DEBOUNCE_MS`, default 5000ms).
- Queued messages are flushed on `/servers switch`.
- Gateway response includes `{ buffered: [...] }` — recorded conversation messages (see `/record` command) flushed on each POST.
- agentp `--qa` prepends the buffered context to stdout; `--flush` bypasses prepending but still triggers the flush.

## OpenCode tmux session model (ocmux)

- Single tmux session named `"Opencode"`
- Windows named by full project directory path
- Server pane runs `opencode serve --port 0` (via send-keys → interactive shell for env var support), TUI pane runs `opencode attach --continue`; `ocmux serve --print-logs` adds `--print-logs` to the serve command
- Log file per project: `/tmp/opencode-serve-<hashDir(dir)>.log` — captured via `tee`, read by ocmux polling loop
- Per-project `.ocmux.json` with upward directory search (git-like)
- Auto-restarts dead TUI panes on switch (respawn-pane or split-window)
- Auto-zooms TUI pane on switch/create

## Commands

| Command | What |
|---|---|---|
| `npm link` | local dev install |
| `npm install -g .` | alternative local install |
| `agentp [--qa] [--tg|--no-tg] [--flush] [--getLast n] [port]` | pipe stdin → opencode session, stream answer to stdout (uses session API). `--tg` forwards answer to Telegram; `--flush` clears recorded buffer; `--getLast n` retrieves last n answers (or QA pairs with `--qa`). URL via `ocmux` or explicit. |
| `tgagentp [port]` | bridge Telegram bot ↔ opencode TUI (needs `TELEGRAM_BOT_TOKEN`); multi-chat/thread support, each with independent server/session/recorder |
| `tgagentp --dev` | enable `/shutdown` command, verbose logging, and structured message traffic log to `/tmp/tgagentp-msg.log` (JSON lines with timestamps, chat IDs, directions) |
| `tgagentp --think` | start with thinking message forwarding enabled |
| `tgagentp --verbose` | detailed logs (errors, trace, debug) on stderr |
| `ocmux serve [--print-logs] [dir]` | start opencode serve in a tmux window (primary verb) |
| `ocmux new [dir]` | alias for `serve` (backwards compat, to be removed in 1.0) |
| `ocmux kill [dir]` | kill server + tmux window |
| `ocmux list [-l]` | list running servers |
| `ocmux resurrect [--print-logs] [dir]` | recover dead server: kill old window, remove state file, create fresh server + TUI |
| `ocmux [dir]` | switch to existing opencode tmux window |

## TODO

### Test Suite Roadmap

| Phase | Module | Boundary to mock | Scope | Status |
|---|---|---|---|---|---|
| **1a** | `lib/opencode.js` | `http.request` | Every API function: URL/method/headers, parse responses, error handling | ✅ Done |
| **1b** | `lib/ocmux.js` | `spawnSync`, `execSync`, `fs` | `readState`, `statefileFor`, `hashDir`, `tuiPaneId`, `windowByDir`, `listServers`, `activateServer`, `resurrectServer` | ✅ Done |
| **2** | `bin/agentp` | `lib/opencode.js` functions | Stdin pipe, `--qa` formatting, `--getLast N`, `--flush`, `--tg` gateway forwarding | ⏳ Pending |
| **3** | `bin/ocmux` | `lib/ocmux.js` + `tmux` + `fs` | `serve`, `kill`, `resurrect`, `list`, `switch`, `--git`/`--GIT` resolution | ⏳ Pending |
| **4** | `bin/tgagentp` | Telegram API + `lib/opencode.js` + `lib/ocmux.js` + `fs` | Extract `processUpdate()` from event loop; test all slash commands, ownership model (disconnected guard, `--force`, takeover notification), gateway routing, state persistence | ⏳ Pending |

Key refactors needed before Phase 4:
- Extract per-update logic into `processUpdate(update, context)` function (pure-ish, testable without running the loop)
- Make polling loop stoppable (`while (running)` + `stop()` callback)
- Make dependencies injectable (`getChatState`, `cmds`, etc.)

### Done

- **Phase 1a+1b:** `lib/opencode.js` + `lib/ocmux.js` unit tests — 86 tests, all passing — 0.13.0
- `/disconnect` command — clears `serverBase`, removes ownership, deletes connection from file — 0.13.0
- Startup pruning (Phase 2): only owner per URL survives on restart; non-thread chats prioritized over topics — 0.13.0
- Stale SSE listener fix: destroy previous `_cancelRef`/`_sessionReq` before starting new ones — prevents forwarding to old chats — 0.13.0
- `/shutdown` works without a server connection — 0.13.0
- `/status`, `/cancel`, `/shutdown` no longer crash with `null.replace` from topic threads — 0.13.0
- `--dev` mode: structured message traffic log to `/tmp/tgagentp-msg.log` (JSON lines) — 0.12.1
- Startup restoration health check: verify `isServerAlive` before showing "✅ restored" — prevents false-positive — 0.12.1
- `/resurrect` fallback: when tmux window is gone and `listServers` returns empty, derive directory from `connections.json` — 0.12.1
- `isServerAlive()` extracted from `bin/tgagentp` into `lib/opencode.js` (+ test coverage) — 0.12.1
- Group migration handler (`migrate_to_chat_id` / `migrate_from_chat_id`) — auto-updates connections + allowlist when topics enabled — 0.12.1
- `/force-switch` command (top-level + `/servers force-switch`) — two-phase matching, bypasses ownership check — 0.12.1
- Stale `serverOwners` entries cleared when switching away from a server — 0.12.1
- `ocmux resurrect` — new command (and `lib/ocmux.js` `resurrectServer()` function) to recover from dead/crashed opencode servers by reading `.ocmux.json` and re-creating server + TUI — 0.12.0
- `tgagentp /resurrect` — invokes `resurrectServer()` from the library, transfers session state to the new server URL — 0.12.0

- `/record` refactor: `/record N` (retrofill from ring), `/record pause [N]`, `/record continue`, `/record flush`, `/record stop`, always-on ring buffer (50 msgs), state transitions (active/paused/inactive) — 0.11.0
- `/comment` — no-op command (renamed from `/note`): ignores message (not forwarded to agent); reply-to quoting handles context — 0.11.0 / renamed 0.13.0
- `/note` — forwards message to agent prepended with awareness paragraph ("reply with only 'Ack' and do not take any action") — 0.13.0
- `/flush` — clears both message queue and agentp gateway queue — 0.11.0
- `isServerAlive()` health check (5s timeout GET /session) — 0.11.0
- Pre-send health check: auto-queues messages when server is unreachable, reconnection detection flushes queue — 0.11.0
- Connection error detection in `processMessageAsync` catch: marks `serverDead`, requeues failed message — 0.11.0
- Queue drain in `finally` skips processing when `serverDead` (prevents infinite loop) — 0.11.0
- `/status` shows `❌ unreachable` when server is dead — 0.11.0
- `/record` command with ring buffer (100 msgs / 100KB), gateway returns `{ buffered }`, agentp `--qa` prepends recorded context, `--flush` flushes without prepending — 0.10.0
- `agentp --getLast n` — retrieve last n QA pairs (user prompts + assistant answers) from session history, formatted with rulers (same format as `--qa`) — 0.10.0
- agentp `--qa` full context forwarding to Telegram (rulers, prompt, answer) — 0.9.0
- agentp resilience: 5s HTTP timeout, pre-send gate check, post-send warning (not hard error) for `--tg`; auto mode silently degrades — 0.9.0
- tgagentp: `lockedChatId` set at startup to fix race condition with agentp gateway — 0.9.0
- tgagentp: per-chat state refactor (multi-chat support); each chat has independent server/session/recorder; auto-activates tmux window on incoming message — 0.11.0
- tgagentp: server error handler + try-catch in gateway handler (no crash on socket errors) — 0.9.0
- agentp `--tg`/`--no-tg` — gateway forwards answer to Telegram via tgagentp HTTP server; per-server queue with debounced notifications; auto-flush on server switch
- agentp session API migration — uses `POST /session/:id/message` instead of TUI endpoints
- ocmux `--print-logs` flag — pass-through to `opencode serve --print-logs` (prints server logs to stderr in the server pane)
- /agents lists only primary agents with ▶ active marker
- /agents switch calls `updateSession(agent)` to persist agent on session + `selectSession` to refresh TUI
- Logging rebalance: stdout for info, stderr for errors/debug/trace, `--verbose` flag, `2>/dev/null` default usage
- `/shutdown force` — refuses shutdown when busy unless `force` flag is given; goodbye message includes state
- `/think [on|off|switch]` — toggle real-time forwarding of model thinking messages to the chat; `--think` CLI flag to start enabled
- Event-driven permission handling (`POST /session/:id/prompt_async` + SSE listener + `/allow`, `/reject`, `/always` commands) — included in v0.7.0
- TUI navigation on `/sessions switch` and `/sessions new` — `POST /tui/select-session` now works in opencode 1.15.13 (was: tried second, never reached)
- /sessions new [name] — create a new session, TUI follows via /session/:id/select
- /sessions rename <name> — rename the current active session
- Merge /session into /sessions (keep /session as alias)
- Case-insensitive matching for all switch subcommands (/servers, /sessions, /agents)
- Fix: /sessions filter includes sessions with directory (TUI sessions) + active session exception
- Fix: /sessions now shows the active session even without agent set (exception in filter)
- Fix: /sessions switch and /sessions new call selectSession (TUI navigation didn't work in opencode < 1.15.x)
- Fix: active session highlighted with ▶ bullet in session list
- Fix: discover TUI session on startup and server switch via `discoverActiveSession()`
- Message splitting (>4096 chars, breaks at newlines)
- Fix: tuiPaneId detects 'bun' (opencode 1.15.x) in addition to 'node'
- Fix: URL polling in ocmux doNew takes last match, not first (more robust with bun startup)
- lib/ocmux.js shared session discovery, refactor ocmux + tgagentp
- /cancel with true server-side SSE abort via cancelRef
- /shutdown (--dev mode) with Telegram offset acknowledgment
- Fix: SSE log lines in `listenForSessionEvents` missing timestamps — added optional `logFn` parameter with timestamped default — 0.11.0
- Fix: agentp gateway drops messages after restart (`serverOwners` empty) — restore from `STARTUP_CHAT_FILE` + populate on first message — 0.11.0
- Fix: `flushRecorded(owningChatId)` passes object as `chatId` — destructure to `owningChatId.chatId, owningChatId.threadId` so `getChatState` key matches — 0.11.0
- `isServerAlive()` extracted from `bin/tgagentp` into `lib/opencode.js` (moved into shared lib + test coverage) — 0.12.1
- `--dev` mode: comprehensive message traffic log to `/tmp/tgagentp-msg.log` (JSON lines with timestamps, chat IDs, direction, from); also enables verbose logging — 0.12.1
- Startup restoration health check: verify `isServerAlive` before showing "✅ restored" — prevents false-positive restore when server is already dead — 0.12.1
- `/resurrect` fallback: when tmux window is gone and `listServers` returns empty, attempt to derive directory from `connections.json` — 0.12.1

### Verified

- Password auth support (OPENCODE_SERVER_PASSWORD) for agentp, ocmux, tgagentp
- agentp HTTP Basic Auth headers on all requests (POST and SSE)
- agentp clear 401 error reporting
- ocmux interactive shells (send-keys) for env var propagation
- tgagentp Telegram bridge bot with long-polling
- Markdown→HTML converter (**bold**, *italic*, `code`, code blocks, headings, tables)
- Chat allowlist (TGAGENTP_ALLOWED_CHAT_IDS)
- Slash command system (/help, /servers, /sessions, /session, /agents, /agents switch, /models, /status, /cancel, /shutdown)
- Per-server state tracking (busy/idle, pendingResponse, activeSessionId, activeAgentName, taskId)
- Background async processing (non-commands fire without await)
- /servers switch activates tmux window (pin, restart TUI, select, zoom)
- Startup greeting with /status-style info persisted via temp file
- Fix port mismatch bug: truncate stale log file before send-keys in doNew
- Update README with full tgagentp features (slash commands, --dev, env vars)
- Update AGENTS.md with lib/ocmux.js, missing API endpoints, current architecture
- Single-user lock: first chat to connect owns the session
- Fix startup greeting markdown not being converted to HTML

*(Keep this TODO up to date: move items between categories as their status changes.)*
