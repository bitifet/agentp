# Changelog

All notable changes to this project will be documented in this file.

## [0.11.7] - 2026-06-13

### New Features

- **`/serve` and `/new` commands:** Remote project management via Telegram. `/serve <path>` starts a server in an existing directory under `TGAGENTP_ROOT`. `/new <path>` creates a directory, initializes git, and starts a server. Both commands auto-connect the chat to the new server. Requires `TGAGENTP_ROOT` environment variable.
- **`TGAGENTP_ROOT` startup validation:** tgagentp validates `TGAGENTP_ROOT` at startup; if missing or invalid, `/serve` and `/new` are gracefully disabled (no crash). `/help` shows an enablement hint when the root is not configured. `/help serve` and `/help new` show how to enable them.
- **`/think` immediate effect:** Thinking text is now always buffered in server state (even when disabled). Toggling `/think on` during a request flushes any already-received thinking text immediately, instead of only taking effect on the next request.

### Bug Fixes

- **`tests/agentp.test.js` fixed:** Direct mocking of `process.stdout.write` broke `node:test`'s suite detection (all 24 tests reported as a single failure with `suites: 0`). Switched to `Writable` stream via `Object.defineProperty` for stdout that captures AND passes through, preserving both test output capture and test runner recognition.

## [0.11.6] - 2026-06-11

### New Features

- **Download on reply:** Reply to a previously sent file in Telegram to automatically download it to the repository. The bot detects the reply to a file message, downloads the file, and saves it to the project directory.
- **`!!` wildcard:** Use `!!` in any command to reference the previous user message. For example: `/queue !!` queues the previous message, `/note !!` sends it as a note. The wildcard is resolved before command processing, so it works with all commands.

## [0.11.5] - 2026-06-11

### Bug Fixes

- **Permission requests:** Fix bug where only the first permission request in a processing iteration was forwarded to Telegram. Subsequent permission requests were silently dropped because the SSE listener was destroyed immediately after `sendToSession` returned, before the session had finished processing. The listener is now kept alive until the session goes idle (or the 90-second safety timeout), matching the TUI behavior.
- **`/note` queue:** `/note` now queues the message when the server is busy, instead of rejecting it with "Server is busy". Previously, only unreachable servers queued notes; busy servers rejected them. Now notes are queued consistently with regular messages.
- **Telegram read receipts in groups:** Documented as a known Telegram API limitation. Bots cannot send read receipts, and in supergroups the second tick (delivery to all members) may not appear even though the bot is receiving messages.

### Code Quality

- **Extracted Telegram modules:** `lib/telegram-api.js` (5 functions) and `lib/telegram-format.js` (3 functions) extracted from `bin/tgagentp` (235 lines removed). Both modules have full test coverage (12 + 17 tests).
- **CLI tests:** `tests/agentp.test.js` with 24 tests covering argument parsing, session selection, output formatting, and gateway integration. All 137 tests pass.

## [0.11.4] - 2026-06-11

### New Features

- `agentp --session <name>` — target a specific session by exact or partial name match.
- `agentp --new` — create a new session with the given title (requires `--session`).

### Bug Fixes

- Fix session detection after TUI `/new`: use `time.created` as fallback when `time.updated` is missing (newly created sessions with no messages yet have `time.updated === 0`). Previously `agentp` would filter these out and create a new "agentp" session instead of using the TUI's active session.

## [0.11.3] - 2026-06-11

### File Sharing (New Feature)

- Upload files from Telegram to `telegram-shared/uploads/` — auto-creates directory, adds to `.gitignore`, sends notification to agent respecting busy/idle queue.
- Download files via `POST /send-file` gateway endpoint — agent writes to `telegram-shared/downloads/`, tgagentp sends via Telegram `sendDocument` (multipart/form-data) and cleans up.
- New `lib/file-share.js` module with `ensureSharedDir`, `saveUploadedFile`, `formatFileSize` helpers.
- 8 tests for file-share module (directory creation, .gitignore, filename sanitization, size formatting).

### Bug Fixes

- Fix file download endpoint variable shadowing (`serverDir` function shadowed by `const serverDir`), causing all file sends to fail with "file not found".
- Fix dangerous file cleanup: only delete files from `telegram-shared/downloads/` after sending, preventing accidental deletion of project files.
- Fix race condition on upload: add `fsyncSync` after `writeFileSync` and retry loop (5 retries × 100ms) to verify file exists before notifying agent.
- Fix `/servers` list: normalize `serverOwners` URLs when checking ownership (handles `127.0.0.1` vs `localhost` mismatch), so connected servers correctly show `·` instead of `🔌`.

### UI Improvements

- `/servers` list: `🔌` for disconnected servers, `·` for connected to other chat, `▶` for your server.
- `/sessions` list: `🔌` for inactive sessions, `▶` for active session (consistency with `/servers`).

## [0.11.2] - 2026-06-10

- `//command` raw TUI passthrough for Opencode TUI-level commands (`//init`, `//doctor`, etc.). Strips first `/` from `//cmd`, appends trailing space to select the as-you-type menu, sends via tmux `send-keys`. SSE listener catches AI responses (15s timeout); forwards answer to Telegram or sends confirmation.
- `/answer` command to respond to structured questions from the AI (multiple-choice via `question.asked` SSE event). Forwards question with numbered options to Telegram; `POST /session/:id/questions/:id` on response.

## [0.11.1] - 2026-06-09

- Auto-switch tmux window to the active chat's server on every non-command message and `/note`, matching the behavior of direct `agentp` usage. Both the main message dispatch and `/note` handler now call `activateServer()` before processing, so the TUI follows the conversation across topics and chats.

## [0.11.0] - 2026-06-09

### Important Fixes

- `/status`, `/cancel`, `/shutdown` no longer crash with `null.replace` when used from Telegram topic threads (`getChatState` without `threadId` creates wrong state entry with `serverBase: null`).
- Stale SSE listener leak: `processMessageAsync` now destroys previous `_cancelRef`/`_sessionReq` before overwriting them, preventing forwarding of session events to stale chats.
- Agentp gateway: fix `flushRecorded()` call passing wrong argument type (`owningChatId` object instead of destructured `chatId`/`threadId`).
- Agentp gateway: restore `serverOwners` after restart by populating from `STARTUP_CHAT_FILE` on first message.
- Fix SSE log lines in `listenForSessionEvents` missing timestamps — added optional `logFn` parameter.
- Fix `isServerAlive()` not exported from shared lib — extracted from `bin/tgagentp` into `lib/opencode.js` with test coverage.

### New Commands

- `/disconnect` — clears `serverBase`, removes ownership, deletes connection from file.
- `/note` — forwards message to agent prepended with awareness paragraph ("reply with only 'Ack', do not take action").
- `/comment` — renamed from `/note`, stays as no-op (message stays in chat, not forwarded).
- `/flush` — clears both message queue and agentp gateway queue.
- `/force-switch` (top-level + `/servers force-switch`) — two-phase matching, bypasses ownership check.
- `/resurrect` (tgagentp) — invokes `resurrectServer()` from library, transfers session state to new server URL.

### Server Health & Queue

- Pre-send health check via `isServerAlive()` (5s timeout `GET /session`): auto-queues messages when server unreachable.
- Connection error detection in `processMessageAsync` catch: marks `serverDead`, requeues failed message.
- Queue drain in `finally` skips processing when `serverDead` (prevents infinite loop).
- `/status` shows `❌ unreachable` when server is dead.

### Startup & Ownership

- Startup pruning (Phase 2): only one chat per URL survives on restart; non-thread chats prioritized over topics.
- Connection persistence in `/tmp/tgagentp-connections.json` with health check before restore message.
- Stale `serverOwners` entries cleared when switching away from a server.
- Group migration handler (`migrate_to_chat_id`/`migrate_from_chat_id`) — auto-updates connections + allowlist when topics enabled.

### Session & Discovery

- `/record N` retrofill from ring buffer, `/record pause [N]`, `/record continue`, `/record flush`, `/record stop`.
- Always-on ring buffer (50 msgs) with state transitions (active/paused/inactive).
- agentp `--getLast n`: retrieve last n QA pairs from session history (user prompts + assistant answers), formatted with rulers.
- `/sessions new [name]` — create session, TUI follows via `/session/:id/select`.
- `/sessions rename <name>` — rename current active session.
- Case-insensitive matching for all switch subcommands (`/servers`, `/sessions`, `/agents`).
- Discover TUI session on startup and server switch via `discoverActiveSession()`.

### Testing (Phase 1a+1b)

- `tests/opencode.test.js`: 62 tests for `lib/opencode.js` API functions — URL/method/headers, parse responses, error handling, all `http.request` mocked.
- `tests/ocmux.test.js`: 35 tests for `lib/ocmux.js` — `readState`, `statefileFor`, `hashDir`, `tuiPaneId`, `windowByDir`, `listServers`, `activateServer`, `resurrectServer`, all `spawnSync`/`execSync`/`fs` mocked.
- `CONTRIBUTING.md` created with dev setup, coding standards, test architecture, PR process.
- `npm test` configured to run `node --test tests/*.test.js`.

### Infrastructure

- `ocmux resurrect` command + `lib/ocmux.js` `resurrectServer()` function — recovers dead/crashed servers by re-creating window + TUI.
- `--dev` mode in tgagentp: structured message traffic log to `/tmp/tgagentp-msg.log` (JSON lines with timestamps, chat IDs, direction).
- `isServerAlive()` extracted to shared `lib/opencode.js`.

## [0.10.0] - 2026-06-04

- `/queue` command: queue messages when server is busy, auto-sent after current task finishes, preserves replyTo chain.
- `/record` command with ring buffer (100 msgs / 100KB), `/record stop` to clear; gateway returns `{ buffered }` JSON.
- agentp `--flush`: flush tgagentp's recorded buffer without prepending to stdout.
- agentp `--getLast n`: retrieve last n assistant answers from session history.
- agentp `--qa` prepends recorded Telegram context (with rulers) to stdout.
- `getSession()` in lib/opencode: `GET /session/:id` with fallback to session list.
- `makeRequest` optional timeout parameter (used only for getSession; all other calls wait indefinitely).
- Minimum 3-backtick code fence for reply quoting.

## [0.9.0] - 2026-06-04

- agentp `--tg`/`--no-tg` flags: gateway forwards answer to Telegram; auto mode silently degrades.
- Agentp resilience: 5s HTTP timeout, pre-send gate check, post-send warning.
- Full `--qa` output (rulers + prompt + answer) forwarded to Telegram.
- Rulers changed from `—` to `─`, shortened to 17 chars.

## [0.8.0] - 2026-06-03

- Fix `/servers` crash: `serverBase is not defined` error.
- Logging rebalance: stdout for info, stderr for errors/debug with `--verbose` flag (`2>/dev/null` for clean console).
- `/shutdown force`: refuse shutdown when busy unless `force` flag given.
- `/think [on|off|switch]`: toggle real-time forwarding of model thinking messages; `--think` CLI flag.
- Reply quoting: when replying to a Telegram message, prepend quoted text with safe backtick fencing.
- Reply chaining: answers use `reply_to_message_id` to appear as replies.
- TUI navigation: `POST /tui/select-session` tried first (works in opencode 1.15.13).

## [0.1.0] - 2026-05-08

- Initial release.
- Add project documentation and usage examples.
