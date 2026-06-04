# agentp

[![npm version](https://img.shields.io/npm/v/agentp.svg)](https://www.npmjs.com/package/agentp)
[![npm license](https://img.shields.io/npm/l/agentp.svg)](https://www.npmjs.com/package/agentp)
[![npm downloads](https://img.shields.io/npm/dm/agentp.svg)](https://www.npmjs.com/package/agentp)
[![node version](https://img.shields.io/node/v/agentp.svg)](https://www.npmjs.com/package/agentp)

This package provides three CLI tools:

- **`agentp`** — pipes prompt text into a running OpenCode TUI session and streams the assistant final answer back to stdout
- **`ocmux`** — manages OpenCode server + TUI sessions in tmux (create, switch, kill, list)
- **`tgagentp`** — bridges a Telegram bot chat with all running OpenCode TUI sessions (receives messages from Telegram, routes them to the active server, sends answers back). Supports slash commands for multi-server management, session switching, agent/model listing, and remote restart.

It is designed for prompt-driven workflows where you want to do things like:

- compose prompts with `cat`, `printf`, or heredocs
- submit them to OpenCode from scripts
- capture output in files or pipe to other tools
- **drive prompts directly from editors** like Vim/Neovim

## Install

From npm:

```bash
npm install -g agentp
```

For local development in this repo:

```bash
npm link
```

## Requirements

- Node.js 18+
- An OpenCode server session listening locally (default port: `4096`)

Notes:

- `agentp` connects to the OpenCode event endpoint over HTTP.
- In practice this means running `opencode serve` (or equivalent serve mode) so the port is open.
- `opencode attach` is optional but useful to monitor the full conversation in another terminal/tmux pane.
- If the OpenCode server is password-protected (`OPENCODE_SERVER_PASSWORD`), both `agentp` and `ocmux` automatically send the required HTTP Basic Auth credentials.

## Usage

```bash
agentp [options] [url]
```

Options:

- `--qa`: print the original prompt and answer with labels (useful when used as a filter)
- `--tg`: forward the answer to Telegram via tgagentp gateway (error if unreachable)
- `--no-tg`: do not forward to Telegram
- `--version`: show version
- `--help`: show help message

By default, `--qa` implies `--tg`; standalone mode implies `--no-tg`.

Arguments:

- `url`: OpenCode TUI server URL or port number (defaults to `4096`). Examples: `4096`, `http://localhost:4096`, `http://192.168.1.50:4096`

## Examples

Send a one-line prompt:

```bash
printf "Summarize the latest logs" | agentp
```

Type and send a multi-line prompt:

```bash
cat | agentp
# (press Ctrl+D to end input)
```

Send a multi-line prompt from a file:

```bash
cat prompt.txt | agentp
```

Use an explicit port:

```bash
cat prompt.txt | agentp 4096
```

Capture answer to a file:

```bash
cat prompt.txt | agentp > answer.txt
```

Connect to a remote OpenCode server:

```bash
cat prompt.txt | agentp http://192.168.1.50:4096
```

From Vim/Neovim, send the current visual selection and replace it in place with the assistant answer:

```vim
:'<,'>!agentp
```

From Vim/Neovim, send the current visual selection and keep the prompt with the answer:

```vim
:'<,'>!agentp --qa
```

## ocmux

Manage OpenCode server + TUI in tmux for project directories.

```bash
ocmux [-l] [<subcommand>] [<directory>]
```

Without arguments, searches upward from `<directory>` (default: `$PWD`) for `.ocmux.json` and switches to that server's tmux window.

Subcommands:

- **`serve [--git|--GIT] [dir]`** — Create a server in `dir` (default: `$PWD`) and attach a TUI pane. Aliased as `new` for backwards compatibility (to be removed in 1.0). Errors if one already exists there. Warns if a parent directory already has a server.
  - `--git` resolves `dir` to the nearest parent with a `.git` entry (file or dir); errors if none is found.
  - `--GIT` resolves `dir` to the nearest parent with a `.git` directory only; errors if none is found.
- **`kill [dir]`** — Kill the server found upward from `dir`. Removes its tmux window and state file.
- **`list`** — List all running servers with their directories, URLs, and status.

Options:

- `-l`: long output for default/serve commands (append `→ <dir>` after the URL)
- `--version`: show version
- `-h`: show help message
- `--`: treat the next argument as a directory even if it matches a subcommand name

Notes:

- If `<directory>` is not a valid path, `ocmux` tries to match it against the basenames of existing sessions (exact unique match).
- When using `--git`/`--GIT`, `ocmux` refuses to create a new server above an existing `.ocmux.json` found while searching for the git root.

### Requirements

- Node.js 18+
- [tmux](https://github.com/tmux/tmux) — session multiplexer
- `opencode` binary in PATH (the OpenCode CLI)

### State file

`ocmux` stores per-project state in `.ocmux.json` (contains URL, log path, window index). It searches upward from the target directory, similar to git.

## How agentp Works

1. Finds the most recently updated session, or creates one named `agentp`.
2. Sends the prompt via the session API (`POST /session/:id/message`).
3. Prints the assistant answer to stdout.
4. With `--tg`, forwards the answer to Telegram via the agentp gateway.

The session API ensures the request is processed even when no TUI is attached, and returns the full answer in a single HTTP response.

Operational hint:

- You can keep a separate `opencode attach` view open to see the full run context while `agentp` is used from shell scripts or editor buffers.

## tgagentp

Bridge a Telegram bot chat with OpenCode TUI sessions managed by `ocmux`.

```bash
tgagentp [options]
```

Keeps running indefinitely. On each text message from Telegram it:

1. Routes non-command messages to the current active server's TUI (same protocol as `agentp`).
2. Waits for the assistant to finish (background async — commands remain responsive).
3. Sends the full answer back to the same Telegram chat.

Non-text Telegram updates (photos, stickers, etc.) are silently ignored.

### Slash commands

| Command | Action |
|---|---|
| `/help [topic]` | Show general help or help for a topic (`servers`, `sessions`, `agents`, `models`) |
| `/servers` | List all running ocmux-served projects with URL + status (✅ idle / ⏳ busy) |
| `/servers switch <name>` | Switch active server; matches by full path, basename, or substring |
| `/sessions` | List recent sessions for the current server (max 50, with date headings) |
| `/sessions switch <number\|name>` | Switch active session by position or partial name match |
| `/agents` | List available agents (name, mode, model, description) |
| `/models` | List connected providers with model counts, context limits, and costs |
| `/status` | Show current server path, URL, busy status, and active session |
| `/cancel` | Cancel the current AI response for the active server |
| `/think [on\|off\|switch]` | Toggle forwarding of model thinking messages to the chat |
| `/shutdown [force]` | (requires `--dev`) Stop tgagentp; refuses if busy unless `force` is given |

### Per-server state

`tgagentp` tracks state independently per server URL: busy/idle status, pending response, active session ID, and cancellation token. Switching servers while one is busy stores the answer as pending — switching back delivers it.

### Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram and copy the token.
2. Export the token and start `tgagentp`:

```bash
export TELEGRAM_BOT_TOKEN="your-bot-token-here"
tgagentp
```

### Options

- `--version`: show version
- `--help`: show help message
- `--verbose`: show detailed logs (errors, trace, debug) on stderr
- `--think`: start with thinking messages enabled (default: off)
- `--dev`: enable `/shutdown` command for remote restart (run via `while true; do tgagentp --dev; done`)

### Agentp gateway

tgagentp starts a tiny HTTP server on `127.0.0.1` that accepts `POST /send` requests from `agentp --tg`. This enables cross-tool interoperability: answers obtained through `agentp` (from scripts, editors, or pipes) are forwarded to your Telegram chat.

- Port is randomly assigned by default; overridable via `TGAGENTP_PORT`.
- Port is written to `/tmp/tgagentp-port` for agentp discovery.
- Authentication reuses `OPENCODE_SERVER_PASSWORD`.
- Messages for the active server are delivered immediately.
- Messages for non-active servers are queued and delivered on `/servers switch`.
- Debounced Telegram notification on queue (configurable via `TGAGENTP_DEBOUNCE_MS`).

### Logging

Informational messages (startup, discovery, session switches) go to **stdout**. Errors, warnings, and trace/debug messages go to **stderr**. With `--verbose`, detailed
trace/debug messages are also printed to stderr.

For a clean console with only essential info:

```bash
tgagentp 2>/dev/null
```

To capture everything (info + errors) to a log file:

```bash
tgagentp 2>/var/log/tgagentp.log
```

### Telemetry

A startup greeting is sent to the last known chat on boot — includes /status-style server info. The chat ID is persisted at `/tmp/tgagentp-startup-chat`.

### Environment variables

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | **Required.** Telegram bot token from @BotFather. |
| `OPENCODE_SERVER_PASSWORD` | Optional. OpenCode server HTTP Basic Auth password (also used for agentp gateway auth). |
| `OPENCODE_SERVER_USERNAME` | Optional. OpenCode server username (default: `opencode`). |
| `TGAGENTP_ALLOWED_CHAT_IDS` | Optional. Comma-separated Telegram chat IDs that are allowed to use the bot. |
| `TGAGENTP_PORT` | Optional. Agentp gateway listen port (default: `0` = random). |
| `TGAGENTP_DEBOUNCE_MS` | Optional. Debounce interval for queued-message notifications (default: `5000`). |

## License

MIT
