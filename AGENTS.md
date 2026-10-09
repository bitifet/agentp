# agentp — agent notes

## File layout

```
bin/agentp          — stdin → opencode session (~1100 lines)
bin/ocmux           — project/session router + registered TUI pickers (~2000 lines)
bin/tgagentp        — Telegram bot ↔ opencode TUI (~3050 lines)
lib/opencode.js     — OpenCode v2 HTTP/SSE API client (shared by agentp + ocmux + tgagentp)
lib/ocmux.js        — registered-TUI routing helpers
lib/project-state.js— `.ocmux.json` v2 schema (directory/session/server/annotations)
lib/tui-registry.js — ephemeral dedicated/shared tmux-pane TUI registrations
lib/tui-cmd.js      — tmux send-keys for TUI command passthrough (used by tgagentp)
lib/file-share.js   — telegram-shared directory + file upload/download helpers
lib/telegram-*.js   — Telegram API/format helpers (used by tgagentp)
tests/              — node:test, all external calls mocked, safe to run live
```

## Non-obvious facts

- **Zero npm dependencies.** `package.json` `"dependencies"` must stay empty. `package-lock.json` exists but has no deps.
- **CommonJS only** (`require`/`module.exports`). No ES modules.
- **OpenCode v2 only.** No v1/legacy code paths anywhere (`lib/opencode.js` is v2-only; `ocmux` targets `opencode --server <url> --session <id>`).
- **`.ocmux.json` is in `.gitignore`** — do not commit state files.
- **2-space indent. Single quotes.** `const` over `let`. `async/await` over `.then()`.
- `lib/tui-cmd.js` is no-semicolons style; `bin/` and other `lib/` files use semicolons. Match the file you're editing.
- **Comments** are present in both `bin/` and `lib/` files.
- **Logging:** `tgagentp` uses `log.info`/`log.error`/`log.debug` (never bare `console.log`). `agentp`/`ocmux` use `console.log` for CLI output (answers, server lists, --version).

## Testing

```bash
npm test              # node --test tests/*.test.js — 310 tests
node --test tests/opencode.test.js    # mock http.request
node --test tests/ocmux.test.js       # mock child_process + fs.*
node --test tests/file-share.test.js  # mock fs for telegram-shared dir ops
node --test tests/telegram-cmd.test.js # [Telegram]{"command":...} parsing
```

All tests run fully in-process. Mock boundaries are in `before()`/`after()` (opencode) or `beforeEach()`/`afterEach()` (ocmux) hooks. Tests within a describe block are serial (`concurrency: false`) when sharing mocked state.

## Versioning

- **Do not bump the version without approval.** (2.0.0 was explicitly approved.)
- **One version for all three tools; the major pairs with the targeted OpenCode
  major** (OpenCode 2.x ⇒ this project is 2.x). Minor = features, patch = fixes.
- Update `CHANGELOG.md` with a full summary for every release.

## Architecture quirks

- `lib/opencode.js` wraps `http.request` — all OpenCode API functions go through `makeRequest()` (handles 401, optional timeout, optional `cancelRef` for req.destroy).
- `lib/tui-registry.js` owns tmux pane operations and the private runtime registry; project state must never contain pane/socket/PID data.
- tgagentp is monolithic (~3050 lines). New features: extract into `lib/` when possible.
- Shared state lives in module-level variables (`chatStates`, `serverOwners`, `agentpQueues`).
- Server is **user-managed** (`opencode serve`); `ocmux`/`agentp` only health-check it (`checkServer`/connection errors). No per-project servers.
- The interactive menus share `windowFor()`/`renderList()` in `bin/ocmux` (scrollable viewport, `resize`-aware, tested with explicit cols/rows). Sessions created via the API have **no model** until set — always use `createSessionWithModel`.

## `//command` TUI passthrough (tgagentp)

`//init` in Telegram → strips `/` → `/init` → appends space → `/init ` → tmux `send-keys` (C-u, type with space, Enter). SSE listener connects before Enter to catch AI responses (15s timeout). On timeout sends confirmation (`✅ /init submitted.`).

## Logging (tgagentp)

- stdout: info messages (startup, discovery, session switches)
- stderr: errors (always) + trace/debug (`--verbose`)
- Default: `tgagentp 2>/dev/null`

## File sharing (tgagentp)

tgagentp detects `[Telegram]{...}` structured messages on their own line in agent responses and processes them before forwarding the response to the user.

**Upload (agent → Telegram):** Agent includes `[Telegram]{"command":"upload","path":"<relative-path>","msg":"<optional caption>"}` in its response. tgagentp reads the file from the project directory, sends it via `sendDocument`, and strips the line from the visible response. Paths are project-relative and must stay within the project root.

**Download (Telegram → agent):** When the user uploads a file or replies to a file message, tgagentp notifies the agent with the file ID and name. The agent can then request the file with `[Telegram]{"command":"download","fileId":"<id>","path":"<relative-destination>"}`. tgagentp downloads the file and saves it to the specified project-relative path.

**Help:** Agent sends `[Telegram]{"command":"help","topic":"<upload|download|help>"}` — tgagentp sends the help text back to the session (agent sees it on the next prompt). Omitting `"topic"` returns general help.

**Auto-greeting:** tgagentp automatically sends an awareness note to the session when the chat connects to a server or switches sessions, explaining the available commands.

## Key integration patterns

- Agentp gateway: tgagentp starts `POST /send` server on `127.0.0.1` (random port, written to `/tmp/tgagentp-port`). `agentp --tg` POSTs answers there for forwarding to Telegram.
- `/record` ring buffer (100 msgs / 100KB) — recorded context prepended by `agentp --qa`.
- TUIs are optional and user-placed. `ocmux tui` registers a project-dedicated tmux pane; `ocmux tui --shared` registers the single cross-project fallback. Routing is dedicated → shared → headless. There is no managed tmux session or per-project window.
