# agentp — agent notes

## What it is

Single-file Node.js CLI (`bin/agentp`) that pipes stdin into a running OpenCode TUI session and streams the assistant answer to stdout. Zero npm dependencies, CommonJS, no build step.

## Entrypoint

`bin/agentp` — the only source file. No other modules.

## Commands

| Action | Command |
|---|---|
| Dev install | `npm link` or `npm install -g .` |
| Run | `printf "prompt" \| agentp` |

No tests, no lint, no typecheck, no codegen. `npm test` is a noop placeholder.

## Requirements

- Node.js 18+
- `opencode --serve` running locally (default port `4096`). See `.ocmux.json` for the local server URL/log path.
- `opencode --attach` optional but useful to monitor conversations.

## Architecture

- Communicates with OpenCode via HTTP: `/tui/clear-prompt`, `/tui/append-prompt`, `/tui/submit-prompt`, `/event` (SSE).
- Default server `http://localhost:4096`; override as positional arg with a port number (`agentp 4097`) or full URL (`agentp http://host:4096`)
- `--qa` flag prints human/agent separator rows before streaming output.
- Streams assistant `text` parts from SSE, filters out user echo by tracking `message.updated` events with role `user`.
- Stops on `session.idle` event.

## Gotchas

- Stdin is consumed line-byline via `readline`. Each line is sent as a separate `append-prompt` request (no batching).
- The script does NOT handle OpenCode not being running — it will crash with a connection error.
- No test suite exists; manual testing via `printf "hi" | node bin/agentp`.
