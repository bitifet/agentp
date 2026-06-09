# agentp — agent notes

## File layout

```
bin/agentp          — stdin → opencode session (350 lines)
bin/ocmux           — tmux server manager (582 lines)
bin/tgagentp        — Telegram bot ↔ opencode TUI (2134 lines)
lib/opencode.js     — HTTP session API client (shared by agentp + tgagentp)
lib/ocmux.js        — tmux management helpers (shared by ocmux + tgagentp)
lib/tui-cmd.js      — tmux send-keys for TUI command passthrough (used by tgagentp)
tests/              — node:test, all external calls mocked, safe to run live
```

## Non-obvious facts

- **Zero npm dependencies.** `package.json` `"dependencies"` must stay empty. `package-lock.json` exists but has no deps.
- **CommonJS only** (`require`/`module.exports`). No ES modules.
- **`.ocmux.json` is in `.gitignore`** — do not commit state files.
- **2-space indent. Single quotes.** `const` over `let`. `async/await` over `.then()`.
- `lib/tui-cmd.js` is no-semicolons style; `bin/` and other `lib/` files use semicolons. Match the file you're editing.
- **Comments** are present in both `bin/` and `lib/` files.
- **Logging:** `tgagentp` uses `log.info`/`log.error`/`log.debug` (never bare `console.log`). `agentp`/`ocmux` use `console.log` for CLI output (answers, server lists, --version).

## Testing

```bash
npm test              # node --test tests/*.test.js — 97 tests (62 + 35)
node --test tests/opencode.test.js   # mock http.request
node --test tests/ocmux.test.js      # mock child_process + fs.*
```

All tests run fully in-process. Mock boundaries are in `before()`/`after()` (opencode) or `beforeEach()`/`afterEach()` (ocmux) hooks. Tests within a describe block are serial (`concurrency: false`) when sharing mocked state.

## Versioning

- **Do not bump version without approval.**
- Pre-release suffix: `0.11.2-pre01`, `0.11.2-pre02`, etc.
- Update `CHANGELOG.md` with a full summary.
- Maintainer strips the suffix for final releases.

## Architecture quirks

- `lib/opencode.js` wraps `http.request` — all OpenCode API functions go through `makeRequest()` (handles 401, optional timeout, optional `cancelRef` for req.destroy).
- `lib/ocmux.js` wraps `child_process.spawnSync` via `_tmux()` helper — all tmux interactions must go through this, never raw spawn.
- tgagentp is monolithic (~2134 lines). New features: extract into `lib/` when possible.
- Shared state lives in module-level variables (`chatStates`, `serverOwners`, `agentpQueues`).
- `activateServer()` is safe to call repeatedly: it checks `activeWindowIndex()` internally and is a no-op on the same window.

## `//command` TUI passthrough (tgagentp)

`//init` in Telegram → strips `/` → `/init` → appends space → `/init ` → tmux `send-keys` (C-u, type with space, Enter). SSE listener connects before Enter to catch AI responses (15s timeout). Falls back to `tmux capture-pane` diff for commands that produce TUI-only output (no AI response).

## Logging (tgagentp)

- stdout: info messages (startup, discovery, session switches)
- stderr: errors (always) + trace/debug (`--verbose`)
- Default: `tgagentp 2>/dev/null`

## Key integration patterns

- Agentp gateway: tgagentp starts `POST /send` server on `127.0.0.1` (random port, written to `/tmp/tgagentp-port`). `agentp --tg` POSTs answers there for forwarding to Telegram.
- `/record` ring buffer (100 msgs / 100KB) — recorded context prepended by `agentp --qa`.
- Tmux session name: `"Opencode"`. Windows named by full project directory path. Server is pane 0, TUI is pane 1+.
