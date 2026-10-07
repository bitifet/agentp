# agentp

[![npm version](https://img.shields.io/npm/v/agentp.svg)](https://www.npmjs.com/package/agentp)
[![npm license](https://img.shields.io/npm/l/agentp.svg)](https://www.npmjs.com/package/agentp)
[![npm downloads](https://img.shields.io/npm/dm/agentp.svg)](https://www.npmjs.com/package/agentp)
[![node version](https://img.shields.io/node/v/agentp.svg)](https://www.npmjs.com/package/agentp)

This package provides three CLI tools:

- **`agentp`** — pipes prompt text into a running OpenCode server and streams the assistant final answer back to stdout
- **`ocmux`** — manages project TUI windows in tmux on top of a single user-managed OpenCode server (session picker, project switcher, create/rename/delete/annotate sessions)
- **`tgagentp`** — bridges a Telegram bot chat with all running OpenCode servers (receives messages from Telegram, routes them to the active server, sends answers back). Supports slash commands for multi-server management, session switching, agent/model listing, including file sharing from the chat.

It is designed for prompt-driven workflows where you want to do things like:

- compose prompts with `cat`, `printf`, or heredocs
- submit them to OpenCode from scripts
- capture output in files or pipe to other tools
- **drive prompts directly from editors** like Vim/Neovim

## Author's note

These tools are built for my own daily workflow. They are heavily AI-assisted — including the tests — and I review things before shipping, but the real test is using them every day. Bugs happen; I value a working feature more than a flawless one. MIT license, no warranty. Issues, suggestions, and PRs are welcome.

**Stability note:** `agentp` and `ocmux` are stable and used daily. `tgagentp` is still in a highly experimental stage — expect breaking changes and occasional bugs.

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
- **OpenCode v2** (`opencode serve`) — the server is user-managed; these tools only check it is reachable and complain otherwise.
- [tmux](https://github.com/tmux/tmux) when using `ocmux` (project TUI windows).

## Servers

The OpenCode server is **user-managed**: start it yourself (e.g. `opencode serve`).
`agentp` and `ocmux` only *check* that it is reachable and complain otherwise.

- Each project records the server it uses in `.ocmux.json` (`"server"`). If that
  server is not reachable:
  - `agentp` exits with `Error connecting to server: …`;
  - `ocmux` exits with `OpenCode server not reachable at <url>.`
- **Point somewhere else for one command** (without touching any file):

  ```bash
  cat prompt.txt | agentp --server http://127.0.0.1:4097
  # or the positional form:
  cat prompt.txt | agentp http://127.0.0.1:4097
  ```

- **Repoint an existing project** (e.g. the server moved to a new port/host) and
  relaunch its TUI on the stored session:

  ```bash
  ocmux serve --server http://127.0.0.1:4097 --force
  ```

  Without `--force`, `ocmux serve` refuses when `.ocmux.json` already exists.

- **Remote or containerized servers** work too: pass any host reachable over
  HTTP, e.g. a published Docker port (`--server http://192.168.1.50:4096`) or an
  SSH tunnel. Auth uses `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME`.
  The client speaks **HTTP only** (no `https://`). Note that `ocmux` launches the
  *local* `opencode --server <url>` for the TUI, so use a local OpenCode version
  compatible with the remote server.

## Usage

```bash
agentp [options] [url]
```

Options:

- `--qa`: print the original prompt and answer with labels (useful when used as a filter)
- `--defer [N]`: deferred execution — submit a prompt and get a ticket immediately (or wait up to N seconds for the answer and print it if it arrives); pipe the ticket back to retrieve the result later
- `--onlineTicket`: print deferred tickets on a single line (default: pretty-printed JSON)
- `--tg`: forward the answer to Telegram via tgagentp gateway (error if unreachable)
- `--no-tg`: do not forward to Telegram
- `--flush`: flush tgagentp's recorded buffer without prepending it to output
- `--getLast <n>`: retrieve last n assistant answers from session history
- `--session <name>`: target a specific session by name (exact or partial match)
- `--new`: create a new session with the given title (requires `--session`)
- `--server <url>`: use this OpenCode server instead of the one in `.ocmux.json` (e.g. `http://host:4096`)
- `--version`: show version
- `--help`: show help message

By default, `--qa` auto-detects tgagentp (silently degrades if unavailable); standalone mode implies `--no-tg`.
With `--tg`, errors if tgagentp is unavailable.

> **Telegram notification from deferred jobs:** Use `--defer --tg` (or
> `--defer N --tg`) to forward the answer to Telegram automatically when the
> background job completes. The detached child process runs the full `--tg`
> flow, including gateway detection and notification. If the gateway is
> unreachable at completion time, a warning is printed on stderr; the answer
> is still saved in the temp file and retrievable via ticket re-submission.

Arguments:

- `url`: OpenCode server URL or port number (defaults to `4096`). Examples: `4096`, `http://localhost:4096`, `http://192.168.1.50:4096`
- Omit it and agentp resolves the project itself: the nearest `.ocmux.json` (upward from the working directory) supplies the server URL, the project directory, and the target session id. `agentp $(ocmux)` still works as an override, but is no longer needed.

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

Deferred execution with `--defer`:

Submit a prompt and get a ticket to retrieve the result later:

```bash
# Submit a prompt and get a deferred ticket (optionally wait up to N seconds)
DEFERRED=$(printf "Refactor the authentication module" | agentp --defer)
# Output: agentp_ticket {
#            "ctime": "2026-08-03T14:30:00.000Z",
#            "path": "/tmp/agentp_deferred_20260803_1430_a1b2.tmp",
#            "server": "http://localhost:4096",
#            "sessionId": "ses_abc123"
#          }

# Or wait up to 60s for the answer; only get a ticket if it's not ready in time
DEFERRED=$(printf "Refactor the authentication module" | agentp --defer 60)

# Continue working... retrieve the result when ready
printf '%s\n' "$DEFERRED" | agentp --defer
# Output: (the agent's response)
```

`--defer` takes an optional numeric timeout in seconds (default `0`). With a
timeout, the invocation blocks until the answer arrives or the timeout expires:
if the answer arrives in time it is printed immediately; otherwise a ticket is
returned and the agent keeps working in the background.

The ticket is `agentp_ticket` followed by a JSON object with these fields:

- `ctime` — creation timestamp (ISO 8601). Only used to compute `elapsed`.
- `path` — path to the temp file holding the result.
- `server` — OpenCode server URL used by the deferred job.
- `sessionId` — OpenCode session ID used by the deferred job.
- `elapsed` — seconds since `ctime`, included only when the ticket is re-printed (not on first print).
- `defer` — the timeout requested at submission, included only when it was > 0.
- `cancelled` — always present (defaults to `false`). Set it to `true` and pipe the ticket back to cancel the running job (see below).

Tickets are printed as pretty-printed (multi-line) JSON for easier reading and
editing; pass `--onlineTicket` to print them on a single line instead:

```bash
printf "Refactor the auth module" | agentp --defer --onlineTicket
# Output: agentp_ticket {"ctime":"...","path":"/tmp/agentp_deferred_....tmp"}
```

Both formats are accepted when piping a ticket back to `agentp --defer`.

You can also append follow-up text after a not-yet-ready ticket to queue more
input into the original running task, similar to typing into the OpenCode TUI
while the agent is busy:

```bash
cat <<'EOF' | agentp --defer
agentp_ticket {
  "ctime": "2026-08-03T14:30:00.000Z",
  "path": "/tmp/agentp_deferred_...tmp",
  "server": "http://localhost:4096",
  "sessionId": "ses_abc123"
}
Also make sure the migration is reversible.
EOF
```

If the answer is already ready, the appended text is not sent to OpenCode; it is
printed after the returned answer so you can edit and re-submit it if needed. In
`--qa` output, it appears after the final ruler. If the answer is not ready, the
appended text is sent through OpenCode's async prompt endpoint for the ticket's
`server`/`sessionId`, stored with the ticket, and the ticket is re-printed with
updated `elapsed` without echoing the extra text in that interim output. When
the final answer is later retrieved with `--qa`, all stored follow-ups are
printed inside the prompt block under `📝` separators. Without `--qa`, stored
follow-ups are not printed. Older tickets without `server` and `sessionId` can
still retrieve results, but cannot queue follow-up text.

Piping a ticket back to `agentp --defer` ignores the `--defer` argument and uses
the ticket's own `defer` value as the timeout (default `0`):

- If the answer is ready, it is returned and the temp file is removed.
- If not, the ticket is re-printed with the elapsed time updated.

Cancel a running deferred job by flipping `cancelled` to `true` and piping the
ticket back (the equivalent of pressing `ESC` in the TUI window):

```bash
cat <<'EOF' | agentp --defer
agentp_ticket {
  "ctime": "2026-08-03T14:30:00.000Z",
  "path": "/tmp/agentp_deferred_...tmp",
  "server": "http://localhost:4096",
  "sessionId": "ses_abc123",
  "cancelled": true
}
EOF
# 🚫 Prompt cancelled.
```

`agentp` interrupts the session's execution (`POST /api/session/:id/interrupt`),
discards the ticket and its queued follow-ups, and prints
`🚫 Prompt cancelled` (with `(or already finished)` when there was nothing left
to interrupt).

Works as a Vim/Neovim filter with deferred execution:

```vim
" Submit selection, get ticket immediately, continue editing
:'<,'>!agentp --defer --qa

" Later, retrieve the result
:r !printf '%s\n' "$(cat <<'EOF'
agentp_ticket {"ctime":"2026-08-03T14:30:00.000Z","path":"/tmp/agentp_deferred_...tmp","server":"http://localhost:4096","sessionId":"ses_abc123"}
EOF
)" | agentp --defer
```

The deferred workflow:
1. Submit prompt with `--defer` → get a ticket (`agentp_ticket {...}`)
2. Continue working (the agent processes in background)
3. When ready, pipe the ticket back to `agentp --defer` to retrieve the result
4. If the agent is still processing, you get the ticket back with the elapsed time updated
5. If complete, you get the agent's response and the temp file is cleaned up

Useful for long-running tasks where you don't want to block your editor.

Retrieve the last 3 assistant answers from session history:

```bash
agentp --getLast 3
```

Useful to grab recent answers without sending a new prompt.

## ocmux

Manage **project TUI windows** in tmux on top of a single user-managed OpenCode
server. A project is a directory holding a `.ocmux.json` state file recording
the target session; an `Opencode` tmux session holds one window per project
(TUI only, pane 0).

```bash
ocmux [-l] [<subcommand>] [<directory>]
```

Without arguments (and with a TTY), opens an **interactive session picker** for
the project found upward from `<directory>` (default: `$PWD`):

- sessions are listed most-recently-viewed first
- `Enter`/`Space` switches (menu stays open) · `n` create (name input) ·
  `r` rename (edit in place) · `R` set a reminder · `d` delete (confirm) ·
  `a` switch agent · `m` switch model · `p` project switcher · `h` help ·
  `q`/`Ctrl+C` quit
- switching updates `.ocmux.json` and relaunches the TUI on the chosen session
  (`opencode --server <url> --session <id>`); silent on success
- new sessions inherit the model of the previously selected session (v2
  sessions created via the API have no model and won't run a prompt until set)

Reminders (`R`) are stored in the `.ocmux.json` `annotations` map; `agentp`
prepends a session's reminder to every prompt sent to it.

Subcommands:

- **`serve [--server <url>] [--git|--GIT] [dir]`** — create a project TUI window
  (checks the server is reachable first). Aliased as `new` for backwards
  compatibility. `--git`/`--GIT` resolve `dir` to the nearest parent with a
  `.git` entry / directory.
- **`session <id|title> [dir]`** — non-interactive session switch.
- **`list [-l]`** — list project windows (with `-l`, their server URL).
- **`model [ref]`** — switch the model of the selected session.
- **`kill [dir]`** — close the project's TUI window. **Keeps `.ocmux.json`**
  (session memory; marks it `stopped`).
- **`resurrect [dir]`** — recreate the project window from its state file.
- **`migrate`** — rewrite legacy (v1-style) `.ocmux.json` files to the v2 schema.

The old `switch` subcommand is gone: press **`p`** inside the session picker to
open the (read-only) project switcher instead. `ocmux` never starts or stops the
OpenCode server — run `opencode serve` yourself (see [Versioning](#versioning)
for the pairing policy).

Options: `-l` · `--version` · `-h` · `--` (treat the next argument as a directory).

Notes:

- If `<directory>` is not a valid path, `ocmux` matches it against the basenames
  of existing project windows (exact unique match).
- If the server is password-protected (`OPENCODE_SERVER_PASSWORD`), both
  `agentp` and `ocmux` send the required HTTP Basic Auth credentials.

### State file

`.ocmux.json` (in the project directory) stores `version`, `directory`,
`session`, and `server`. It is found by searching upward, like git. It is
gitignored — never commit it.

## How agentp Works

1. Reads all stdin into a single prompt string.
2. Resolves the target from the nearest `.ocmux.json`: server URL, project
   directory, and the stored session id (falls back to the most recently viewed
   session in that directory, or creates one pinned to the directory).
3. Focuses the project's TUI window, prepends the session annotation (if any),
   and sends the prompt via the v2 session API (`POST /api/session/:id/prompt`,
   delivering to that session regardless of what the TUI shows).
4. Attaches to the SSE stream first so no events are missed, and streams text
   until the session is quiescent after its terminal signal.
5. Prints the assistant answer to stdout (with `--qa`, a header with the project
   path and session id/title before the prompt/answer rulers).
6. With `--tg` (or by default when `--qa` is given), forwards the answer to
   Telegram via the agentp gateway. If tgagentp's [/record](#tgagentp) feature
   was active, the gateway response includes the recorded conversation buffer,
   which `--qa` prepends to stdout (use `--flush` to clear it).

Operational hint:

- You can keep a separate TUI view open to see the full run context while
  `agentp` is used from shell scripts or editor buffers:
  `opencode --server '<url>' --session '<id>'` (or `--continue` for the last
  session). `ocmux` manages these windows per project.

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
|---|---|---|
| `/help [topic]` | Show general help or help for a topic (`servers`, `sessions`, `agents`, `models`, `allow`, `think`, `record`, `queue`) |
| `/servers` | List all ocmux-served projects (▶ active, 🔌 disconnected, 💀 dead) |
| `/server <name>` | Switch active server; matches by full path, basename, or substring |
| `/server --force <name>` | Take over a server from another chat |
| `/resurrect [path]` | Restart a crashed server from its `.ocmux.json`; accepts optional directory path |
| `/sessions` | List sessions (numbered, newest first) |
| `/session <name-or-number>` | Switch to a session by name or position |
| `/session new [name]` | Create a new session |
| `/session rename <name>` | Rename the active session |
| `/agents` | List available agents/models |
| `/agent <name>` | Switch the active agent for subsequent messages (synced to server via API) |
| `/models` | List providers and models (▶ marks current) |
| `/model <providerID/modelID>` | Switch session model |
| `/allow` | Approve a permission request once |
| `/reject` | Deny a permission request |
| `/always` | Approve and remember for the session |
| `/answer <number>` | Respond to a question asked by the AI (structured multiple-choice) |
| `/markdown` | Send the original markdown of the last response as a `.md` file; reply to a message to get that specific response |
| `/shutdown [force\|clear]` | (requires `--dev`) Stop tgagentp; `clear` also wipes saved connections |

> **Note on model/agent switching:** Changing the model in the OpenCode TUI's prompt dropdown is a **local UI action** — it only takes effect server-side after a message is sent *through the TUI*. If you change the model in the TUI and then send a prompt via `agentp` or Telegram, the old model will still be used. Use `/agent <name>` or `/model <providerID/modelID>` from Telegram (or `tgagentp`) to change models — this explicitly calls the API and syncs correctly.

#### TUI Command Passthrough

Messages starting with `//` are forwarded to the OpenCode TUI as raw keystrokes (not text sent to the AI):

- **`//<command>`** — Sends `/command` directly to the TUI prompt. Useful for TUI-level commands like `/init`, `/clear`, `/history`, etc. The AI response is captured and forwarded to Telegram (or a confirmation is sent if the command is quick).

### Chat-server ownership

Each server can be owned by at most one chat at a time. New chats start disconnected. Use `/server <name>` to connect; `--force` takes over and notifies the previous owner. Connections are persisted to `/tmp/tgagentp-connections.json` and restored automatically on restart (server URL is re-discovered from `.ocmux.json`).

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
- Messages for non-active servers are queued per-server with debounced notifications (configurable via `TGAGENTP_DEBOUNCE_MS`); delivered on `/server <name>`.
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

## Versioning

The 1.x line was born with some internal inconsistency: early releases bumped
middle digits for small fixes, and `agentp`/`ocmux` were versioned independently
of the OpenCode they talked to. `2.0.0` marks a cleanup of that history — and a
single policy from now on:

> **agentp/ocmux/tgagentp share one version, and its major number is paired with
> the OpenCode major version they target.** OpenCode 2.x ⇒ this project lands in
> 2.x; if OpenCode ever ships a 3.0, a 3.x here targets it (the minor tracks
> features, the patch tracks fixes).

OpenCode v1 support was dropped in 2.0.0; the HTTP client (`lib/opencode.js`)
is v2-only and the tools assume `opencode serve` is user-managed.

## License

MIT
