# agentp

[![npm version](https://img.shields.io/npm/v/agentp.svg)](https://www.npmjs.com/package/agentp)
[![npm license](https://img.shields.io/npm/l/agentp.svg)](https://www.npmjs.com/package/agentp)
[![npm downloads](https://img.shields.io/npm/dm/agentp.svg)](https://www.npmjs.com/package/agentp)
[![node version](https://img.shields.io/node/v/agentp.svg)](https://www.npmjs.com/package/agentp)

This package provides three CLI tools:

- **`agentp`** — pipes prompt text into a running OpenCode server and streams the assistant final answer back to stdout
- **`ocmux`** — manages OpenCode server + TUI sessions in tmux (create, switch, kill, list)
- **`tgagentp`** — bridges a Telegram bot chat with all running OpenCode servers (receives messages from Telegram, routes them to the active server, sends answers back). Supports slash commands for multi-server management, session switching, agent/model listing, including file sharing from the chat.

It is designed for prompt-driven workflows where you want to do things like:

- compose prompts with `cat`, `printf`, or heredocs
- submit them to OpenCode from scripts
- capture output in files or pipe to other tools
- **drive prompts directly from editors** like Vim/Neovim

## Author's note

These tools are built for my own daily workflow. They are heavily AI-assisted — including the tests — and I review things before shipping, but the real test is using them every day. Bugs happen; I value a working feature more than a flawless one. MIT license, no warranty. Issues, suggestions, and PRs are welcome.

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
- `--flush`: flush tgagentp's recorded buffer without prepending it to output
- `--getLast <n>`: retrieve last n assistant answers from session history
- `--session <name>`: target a specific session by name (exact or partial match)
- `--new`: create a new session with the given title (requires `--session`)
- `--version`: show version
- `--help`: show help message

By default, `--qa` auto-detects tgagentp (silently degrades if unavailable); standalone mode implies `--no-tg`.
With `--tg`, errors if tgagentp is unavailable.

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

From Vim/Neovim, forward the answer to your Telegram:

```vim
:'<,'>!agentp --qa --tg
```

(Works as long as `tgagentp` is running. The answer appears both in the editor
and in your Telegram chat.)

From Vim/Neovim, flush the recorded buffer without prepending context:

```vim
:'<,'>!agentp --qa --flush
```

Useful when you've finished a conversation thread and want to reset the recorded
context for a new topic.

Retrieve the last 3 assistant answers from session history:

```bash
agentp --getLast 3
```

Useful to grab recent answers without sending a new prompt.

## ocmux

Manage OpenCode server + TUI in tmux for project directories.

```bash
ocmux [-l] [<subcommand>] [<directory>]
```

Without arguments, searches upward from `<directory>` (default: `$PWD`) for `.ocmux.json` and switches to that server's tmux window.

Subcommands:

- **`serve [--git|--GIT] [--print-logs] [dir]`** — Create a server in `dir` (default: `$PWD`) and attach a TUI pane. Aliased as `new` for backwards compatibility (to be removed in 1.0). Errors if one already exists there. Warns if a parent directory already has a server.
  - `--git` resolves `dir` to the nearest parent with a `.git` entry (file or dir); errors if none is found.
  - `--GIT` resolves `dir` to the nearest parent with a `.git` directory only; errors if none is found.
  - `--print-logs` passes `--print-logs` to `opencode serve`, which prints server logs to stderr in the server tmux pane.
- **`kill [dir]`** — Kill the server found upward from `dir`. Removes its tmux window and state file.
- **`resurrect [--print-logs] [dir]`** — Recover a dead/crashed server: reads `.ocmux.json`, kills old tmux window, removes state file, then creates a fresh server + TUI in the same directory. Works even if no tmux window exists (stale state file).
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

1. Reads all stdin into a single prompt string.
2. Finds the most recently updated session, or creates one named `agentp`.
3. Sends the prompt via the session API (`POST /session/:id/message`).
4. Prints the assistant answer to stdout.
5. With `--tg` (or by default when `--qa` is given), forwards the answer to Telegram
   via the agentp gateway. The answer appears in your Telegram chat as if tgagentp
   itself had processed the request.
6. If tgagentp's [/record](#tgagentp) feature was active, the gateway response includes
   the recorded conversation buffer. In `--qa` mode, agentp prepends this buffer (with
   rulers) to its stdout so OpenCode receives the full Telegram context. Use `--flush`
   to clear the buffer without prepending.

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
| `/help [topic]` | Show general help or help for a topic (`servers`, `sessions`, `agents`, `models`, `allow`, `think`, `record`, `queue`) |
| `/servers` | List all running ocmux-served projects with URL + status (✅ idle / ⏳ busy) |
| `/servers switch <name> [--force]` | Switch active server; matches by full path, basename, or substring; `--force` takes over from another chat |
| `/serve <path>` | Start a server in an existing directory under `TGAGENTP_ROOT` |
| `/new <path>` | Create a directory, init git, and start a server under `TGAGENTP_ROOT` |
| `/sessions` | List recent sessions for the current server (max 50, with date headings) |
| `/sessions switch <number\|name>` | Switch active session by position or partial name match |
| `/agents` | List primary agents (▶ marker for the active one) |
| `/agents switch <name>` | Switch active agent — persists on session and refreshes TUI |
| `/models` | List connected providers with model counts, context limits, and costs |
| `/status` | Show current server path, URL, busy status, and active session |
| `/cancel` | Cancel the current AI response for the active server |
| `/think [on\|off\|switch]` | Toggle forwarding of model thinking messages to the chat |
| `/record [stop]` | Toggle recording of Telegram conversation for agentp context; `/record stop` clears and stops |
| `/queue <message>` | Queue a message when the server is busy; auto-sent when current task finishes |
| `/flush` | Clear all queued messages (manual and auto-queued) |
| `/resurrect` | Recover a dead server — restart processes in the same directory, reconnect chat |
| `/allow` | Approve a permission request once |
| `/reject` | Deny a permission request |
| `/always` | Approve and remember for the session |
| `/answer <number>` | Respond to a question asked by the AI (structured multiple-choice) |
| `/markdown [n]` | Send the original markdown of a recent response as a `.md` file; reply to a message to get that specific response |
| `/shutdown [force\|clear]` | (requires `--dev`) Stop tgagentp; `clear` also wipes saved connections |

#### TUI Command Passthrough

Messages starting with `//` are forwarded to the OpenCode TUI as raw keystrokes (not text sent to the AI):

- **`//<command>`** — Sends `/command` directly to the TUI prompt. Useful for TUI-level commands like `/init`, `/clear`, `/history`, etc. The AI response is captured and forwarded to Telegram (or a confirmation is sent if the command is quick).

### Chat-server ownership

Each server can be owned by at most one chat at a time. New chats start disconnected. Use `/servers switch <name>` to connect; `--force` takes over and notifies the previous owner. Connections are persisted to `/tmp/tgagentp-connections.json` and restored automatically on restart (server URL is re-discovered from `.ocmux.json`).

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
- Messages for the owning chat's active server are delivered immediately.
- Messages for non-active servers are queued per-server with debounced notifications (configurable via `TGAGENTP_DEBOUNCE_MS`); delivered on `/servers switch`.
- Server health detection pre-sends: if a server is unreachable, messages are auto-queued and delivered when it comes back. `/flush` clears all queues.
- When [/record](#tgagentp) is active, the gateway response includes the recorded conversation buffer. `agentp --qa` prepends this buffer (with rulers) to its stdout so the full Telegram context is available to OpenCode. Use `agentp --qa --flush` to flush the buffer without prepending.

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

### State persistence

Chat-to-server directory mappings are saved to `/tmp/tgagentp-connections.json` on every connection. On restart, tgagentp reads this file, discovers the server URL from each directory's `.ocmux.json`, and reconnects automatically with a welcome message. Use `/shutdown clear` (requires `--dev`) to wipe the saved state for a clean start.

### Environment variables

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | **Required.** Telegram bot token from @BotFather. |
| `OPENCODE_SERVER_PASSWORD` | Optional. OpenCode server HTTP Basic Auth password (also used for agentp gateway auth). |
| `OPENCODE_SERVER_USERNAME` | Optional. OpenCode server username (default: `opencode`). |
| `TGAGENTP_ALLOWED_CHAT_IDS` | Optional. Comma-separated Telegram chat IDs that are allowed to use the bot. |
| `TGAGENTP_PORT` | Optional. Agentp gateway listen port (default: `0` = random). |
| `TGAGENTP_DEBOUNCE_MS` | Optional. Debounce interval for queued-message notifications (default: `5000`). |
| `TGAGENTP_ROOT` | Optional. Root directory for `/serve` and `/new` commands (must be writable). |

## License

MIT
