# agentp — agent notes

## Two binaries, both registered

- `bin/agentp` (Node.js) — registered in `package.json` `"bin"` — pipes stdin → opencode TUI
- `bin/ocmux` (Node.js) — registered in `package.json` `"bin"` — manages opencode tmux sessions

## Package facts

- **Zero npm dependencies.** Both scripts use only Node.js stdlib (`http`, `readline`, `url`, `child_process`, `fs`, `path`, `crypto`, `os`).
- **No tests, no CI, no lint, no formatter.** `npm test` is a stub that exits 1.
- **No lockfile.** Versions resolve at install time.
- **`"type": "commonjs"`**, requires Node >= 18.
- **Linux and macOS compatible.** Both tools use portable Node.js APIs only.

## `.ocmux.json`

Runtime state file created by `bin/ocmux` (contains URL, log path, and window index). **Not in `.gitignore`** — avoid committing it.

## OpenCode HTTP protocol (agentp)

These endpoints are consumed but not documented elsewhere in the repo:

- `POST /tui/clear-prompt`
- `POST /tui/append-prompt`
- `POST /tui/submit-prompt`
- `GET /event` (SSE stream)

## OpenCode tmux session model (ocmux)

- Single tmux session named `"Opencode"`
- Windows named by full project directory path
- Server pane runs `opencode serve --port 0`, TUI pane runs `opencode attach --continue`
- Per-project `.ocmux.json` with upward directory search (git-like)
- Auto-restarts dead TUI panes on switch
- Auto-zooms TUI pane on switch/create

## Commands

| Command | What |
|---|---|
| `npm link` | local dev install |
| `npm install -g .` | alternative local install |
| `agentp [--qa] [port]` | pipe stdin → opencode TUI, stream answer to stdout |
| `ocmux new [dir]` | start opencode serve in a tmux window |
| `ocmux kill [dir]` | kill server + tmux window |
| `ocmux list [-l]` | list running servers |
| `ocmux [dir]` | switch to existing opencode tmux window |
