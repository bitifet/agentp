# Changelog

All notable changes to this project will be documented in this file.

## [0.11.2] - 2026-06-10

- `//command` raw TUI passthrough for Opencode TUI-level commands (`//init`, `//doctor`, etc.). Strips first `/` from `//cmd`, appends trailing space to select the as-you-type menu, sends via tmux `send-keys`. SSE listener catches AI responses (15s timeout); forwards answer to Telegram or sends confirmation.
- `/answer` command to respond to structured questions from the AI (multiple-choice via `question.asked` SSE event). Forwards question with numbered options to Telegram; `POST /session/:id/questions/:id` on response.
- File sharing: upload files from Telegram to `telegram-shared/uploads/` (auto-creates directory, adds to `.gitignore`, sends notification to agent). Download files via `POST /send-file` gateway endpoint (agent writes to `telegram-shared/downloads/`, tgagentp sends via Telegram `sendDocument` and cleans up).

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
