# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

- Rename package and CLI command from `aprompt` to `agentp`.
- Extract shared OpenCode client logic into `lib/opencode.js`.
- Add `tgagentp` — bridge a Telegram bot chat with an OpenCode TUI session.

## [0.9.0] - 2026-06-04

- `/record` command: ring buffer (100 msgs / 100KB), `/record stop` to clear; gateway returns `{ buffered }` JSON.
- agentp `--flush`: flush tgagentp's recorded buffer without prepending to stdout.
- agentp `--qa` prepends recorded Telegram context (with rulers) to stdout.
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
