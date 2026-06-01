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
- `sendToSession(server, sessionId, text)` — `POST /session/:id/message`; returns concatenated text parts from response
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
- `POST /session/:id/message` — send message to session (returns parts synchronously)
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
