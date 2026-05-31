# agentp

[![npm version](https://img.shields.io/npm/v/agentp.svg)](https://www.npmjs.com/package/agentp)
[![npm license](https://img.shields.io/npm/l/agentp.svg)](https://www.npmjs.com/package/agentp)
[![npm downloads](https://img.shields.io/npm/dm/agentp.svg)](https://www.npmjs.com/package/agentp)
[![node version](https://img.shields.io/node/v/agentp.svg)](https://www.npmjs.com/package/agentp)

This package provides three CLI tools:

- **`agentp`** — pipes prompt text into a running OpenCode TUI session and streams the assistant final answer back to stdout
- **`ocmux`** — manages OpenCode server + TUI sessions in tmux (create, switch, kill, list)
- **`tgagentp`** — bridges a Telegram bot chat with an OpenCode TUI session (receives messages from Telegram, forwards them to OpenCode, sends answers back)

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
- `--version`: show version
- `--help`: show help message

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

- **`serve [--git|--GIT] [dir]`** — Create a server in `dir` (default: `$PWD`) and attach a TUI pane. Aliased as `new` for backwards compatibility. Errors if one already exists there. Warns if a parent directory already has a server.
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

1. Clears the current TUI prompt input.
2. Appends each line from stdin to the TUI prompt.
3. Submits the prompt.
4. Listens to the event stream and prints assistant text parts.
5. Stops when the session reaches idle state.

Operational hint:

- You can keep a separate `opencode attach` view open to see the full run context while `agentp` is used from shell scripts or editor buffers.

## tgagentp

Bridge a Telegram bot chat with an OpenCode TUI session.

```bash
tgagentp [options] [url]
```

Keeps running indefinitely. For each text message received from Telegram it:

1. Forwards the message text to the OpenCode server (same protocol as `agentp`).
2. Waits for the assistant to finish.
3. Sends the full answer back to the same Telegram chat.

Non-text Telegram updates (photos, stickers, etc.) are silently ignored.

### Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram and copy the token.
2. Export the token as an environment variable before starting `tgagentp`:

```bash
export TELEGRAM_BOT_TOKEN="your-bot-token-here"
```

3. Start `tgagentp`:

```bash
tgagentp
tgagentp 4096
tgagentp http://192.168.1.50:4096
```

### Options

- `--version`: show version
- `--help`: show help message

### Arguments

- `url`: OpenCode TUI server URL or port number (defaults to `4096`). Same format as `agentp`.

### Environment variables

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | **Required.** Telegram bot token from @BotFather. |
| `OPENCODE_SERVER_PASSWORD` | Optional. OpenCode server HTTP Basic Auth password. |
| `OPENCODE_SERVER_USERNAME` | Optional. OpenCode server username (default: `opencode`). |

## License

MIT
