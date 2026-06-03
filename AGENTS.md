# agentp — agent notes

## Three binaries, all registered

- `bin/agentp` (Node.js) — registered in `package.json` `"bin"` — pipes stdin → opencode TUI
- `bin/ocmux` (Node.js) — registered in `package.json` `"bin"` — manages opencode tmux sessions
- `bin/tgagentp` (Node.js) — registered in `package.json` `"bin"` — bridges Telegram bot ↔ opencode TUI

## Package facts

- **Zero npm dependencies.** All scripts use only Node.js stdlib (`http`, `https`, `readline`, `url`, `child_process`, `fs`, `path`, `crypto`, `os`).
- **No tests, no CI, no lint, no formatter.** `npm test` is a stub that exits 1.
- **No lockfile.** Versions resolve at install time.
- **`"type": "commonjs"`**, requires Node >= 18.
- **Linux and macOS compatible.** All tools use portable Node.js APIs only.

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
- `updateSession(server, sessionId, title)` — `PATCH /session/:id`; returns the updated `Session` object
- `sendToSession(server, sessionId, text, agent?)` — `POST /session/:id/message`; returns concatenated text parts from response; optional `agent` to handle the message
- `selectSession(server, sessionId)` — `POST /session/:id/select`; tells the TUI to navigate to the given session (silently ignores 404 if the endpoint isn't available in older opencode versions)
- `listAgents(server)` — `GET /agent`; returns parsed JSON array of agent objects
- `listProviders(server)` — `GET /provider`; returns parsed JSON array of provider objects

## Shared `lib/ocmux.js`

Shared ocmux session discovery; used by both `bin/ocmux` and `bin/tgagentp`:

- `readState(file)` — parses `.ocmux.json`, returns `null` on error
- `statefileFor(dir)` — `path.join(dir, '.ocmux.json')`
- `tuiPaneId(windowIndex)` — returns pane ID if TUI process (`node`) is running, `null` if dead
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
- `PATCH /session/:id` — update session properties (`{ title }`)
- `POST /session/:id/select` — tell the TUI to navigate to a session (only with TUI attached)
- `POST /session/:id/message` — send message to session (returns parts synchronously; optional `agent` field)
- `GET /agent` — list available agents
- `GET /provider` — list connected providers/models

## OpenCode tmux session model (ocmux)

- Single tmux session named `"Opencode"`
- Windows named by full project directory path
- Server pane runs `opencode serve --port 0` (via send-keys → interactive shell for env var support), TUI pane runs `opencode attach --continue`
- Log file per project: `/tmp/opencode-serve-<hashDir(dir)>.log` — captured via `tee`, read by ocmux polling loop
- Per-project `.ocmux.json` with upward directory search (git-like)
- Auto-restarts dead TUI panes on switch (respawn-pane or split-window)
- Auto-zooms TUI pane on switch/create

## Commands

| Command | What |
|---|---|---|
| `npm link` | local dev install |
| `npm install -g .` | alternative local install |
| `agentp [--qa] [port]` | pipe stdin → opencode TUI, stream answer to stdout |
| `tgagentp [port]` | bridge Telegram bot ↔ opencode TUI (needs `TELEGRAM_BOT_TOKEN`) |
| `tgagentp --dev` | enable `/shutdown` command for remote restart |
| `ocmux serve [dir]` | start opencode serve in a tmux window (primary verb) |
| `ocmux new [dir]` | alias for `serve` (backwards compat, to be removed in 1.0) |
| `ocmux kill [dir]` | kill server + tmux window |
| `ocmux list [-l]` | list running servers |
| `ocmux [dir]` | switch to existing opencode tmux window |

## TODO

### Pending

*(none)*

### Done

- /agents switch <name> — switch active agent on the active session
- /sessions new [name] — create a new session, TUI follows via /session/:id/select
- /sessions rename <name> — rename the current active session
- Merge /session into /sessions (keep /session as alias)
- Case-insensitive matching for all switch subcommands (/servers, /sessions, /agents)
- Fix: /sessions filter includes sessions with directory (TUI sessions) + active session exception
- Fix: /sessions now shows the active session even without agent set (exception in filter)
- Fix: /sessions switch and /sessions new call selectSession (TUI navigation doesn't work — see With Issues)
- Fix: active session highlighted with ▶ bullet in session list
- Fix: discover TUI session on startup and server switch via `discoverActiveSession()`
- Message splitting (>4096 chars, breaks at newlines)
- Fix: tuiPaneId detects 'bun' (opencode 1.15.x) in addition to 'node'
- Fix: URL polling in ocmux doNew takes last match, not first (more robust with bun startup)
- lib/ocmux.js shared session discovery, refactor ocmux + tgagentp
- /cancel with true server-side SSE abort via cancelRef
- /shutdown (--dev mode) with Telegram offset acknowledgment

### With Issues

- `/sessions switch` and `/sessions new` — `selectSession` tries `POST /session/:id/select` and `POST /tui/select-session` but the TUI pane doesn't navigate to the session. Message routing (via `activeSessionId` + `sendToSession`) works correctly in the background. This is a known limitation — the TUI must be navigated manually to see the conversation in the UI. The underlying opencode API may lack the needed TUI navigation endpoints.

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
