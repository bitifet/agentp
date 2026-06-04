# Changelog

All notable changes to this project will be documented in this file.

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
