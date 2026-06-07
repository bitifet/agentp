# Agentp: Turn OpenCode Into a Headless AI Engine for Your Editor, Terminal, and Telegram
OpenCode is great, but its TUI locks you in. You type in one window, watch it stream, and that's it. What if you could:

- Pipe a prompt straight from Vim and replace your selection with the answer?
- Queue messages from Telegram while it's busy and get replies threaded?
- Keep a permanent server per project in tmux and switch between them?
- Pull the last N answers from session history without sending a new prompt?
- Record your Telegram conversation and inject it as context into your next `agentp` call?

That's what **agentp** — a set of three zero-dependency Node.js CLI tools — does.

---

## The Three Tools

### `agentp` — The Pipe

Stdin in, answer out. That's the core loop.

```bash
printf "Summarize this file" | agentp
cat prompt.txt | agentp
```

From Vim/Neovim:

```vim
:'<,'>!agentp --qa
```

This replaces your visual selection with the answer. `--qa` preserves the prompt + answer with labels, so you keep the full context.

### `ocmux` — The Project Manager

Each project gets its own tmux window with a dedicated `opencode serve` + TUI pane. Auto-restarts dead panes, pins window names, stores state in `.ocmux.json` (discovered upward like `.git`).

```bash
ocmux serve ~/projects/myapp        # create (new window)
ocmux serve --print-logs ~/projects/myapp  # also print server logs to terminal
ocmux list                          # list all
ocmux list -l                       # list with full URLs
ocmux ~/projects/myapp              # switch (shows url)
ocmux                               # same as ocmux $(pwd)
ocmux kill ~/projects/myapp         # remove
ocmux kill                          # same as ocmux $(pwd)
```

`ocmux` also supports `--git` and `--GIT` flags for git base directory resolution: `--git` matches with either worktrees or repository roots, while `--GIT` requires an actual repository root (not a worktree).

When an opencode server crashes, `ocmux resurrect` reads `.ocmux.json`, kills the stale tmux window, and starts a fresh server + TUI in the same directory. Works even with a dead tmux window (stale state file).

### `tgagentp` — The Telegram Bridge

A Telegram bot that routes messages to your OpenCode servers. Multi-chat, multi-server, slash-commands for everything.

```bash
tgagentp                                  # default port 4096
tgagentp --think                          # start with thinking forwarding enabled
tgagentp --dev                            # enable /shutdown for remote restart
tgagentp 8080                             # custom port
TGAGENTP_ALLOWED_CHAT_IDS="123,-456" tgagentp  # restrict to specific chats
```

**Slash commands:**

| Command | What it does |
|---|---|
| `/help` | Show available commands |
| `/status` | Show current server, session, agent, and health |
| `/servers` | List/switch between ocmux projects |
| `/sessions` | List/switch/create/rename sessions |
| `/agents` | List/switch active agent |
| `/models` | List providers and models |
| `/allow` | Approve a tool permission once |
| `/reject` | Deny a tool permission |
| `/always` | Approve a permission and remember the choice |
| `/queue <msg>` | Queue message when busy — auto-sent after current task finishes (replies chain!) |
| `/record` | Record / pause / retrofill conversation for `agentp` context |
| `/flush` | Clear all queued messages (manual or auto-queued) |
| `/note <text>` | Save a note (not forwarded to agent — context via reply quoting) |
| `/think` | Toggle real-time thinking message forwarding |
| `/cancel` | Abort the running prompt |
| `/resurrect` | Restart a crashed server and reconnect the chat to the new instance |

Permission prompts from OpenCode (tool access requests) are forwarded automatically — respond with `/allow`, `/reject`, or `/always` directly in the chat.

---

### `agentp` and `ocmux` together

- `agentp` defaults to http://localhost:4096 (the opencode default). But it accepts a port or a full URL as a parameter.

- `ocmux` with no arguments switches the Opencode tmux session to the window of the current project (based on current directory) and prints the server URL.

- Both combined let you talk to the right OpenCode server without bothering with ports or URLs. Just `agentp $(ocmux)` or `agentp --qa $(ocmux)` if you want to get the full QA pair with rulers and you are done.


Now we can auto-switch to the right OpenCode server every time we use it no matter where we are in the filesystem, and even from Vim:

```vim
:'<,'>!agentp --qa $(ocmux)
```

> **Note:** You may think you can just run `ocmux` and pass the URL as a
> literal to `agentp`: Anyway the command will be recorded in your vim's
> command history.
> 
> But calling `ocmux` every time **it automatically switches the right TUI
> instance in the "Opencode" tmux session!!**.

---

## The Agentp Gateway

The killer integration: `agentp` and `tgagentp` talk to each other through a tiny HTTP gateway.

- **`agentp --tg`** — forwards the answer to your Telegram chat after every pipe (hard error if tgagentp not running).
- **`agentp --no-tg`** — explicitly disable Telegram forwarding (overrides auto-detection in `--qa` mode).
- **`agentp --qa`** — auto-detects tgagentp and sends the full QA pair (rulers + prompt + answer) if tgagentp is running.
- **`/record`** — buffers the Telegram conversation. On the next `agentp` call, the gateway returns the buffer, and `--qa` prepends it to stdout with rulers — so OpenCode sees the full Telegram thread as context. Retroactively buffer past messages with `/record N`.
- **`agentp --flush`** — clears the buffer without prepending.
- **`agentp --getLast 5`** — retrieves the last 5 assistant answers from session history (or QA pairs with `--getLast 5 --qa`).
- **Exclusive ownership** — each server belongs to at most one chat. New chats start disconnected. `/servers switch <name> --force` takes over and notifies the previous owner.
- **Auto-queue** — when a server is unreachable, messages are automatically queued and delivered when it comes back. `/flush` clears the queue.
- **Server health detection** — tgagentp periodically checks server connectivity. Dead servers are shown as ❌ unreachable in `/status`.
- **Multi-chat** — each Telegram chat or forum thread has independent server, session, and recorder state. Perfect for teams sharing one bot.
- **Message splitting** — long answers are split at 4096 characters (respecting newlines) to stay within Telegram limits.
- **State persistence** — chat-to-server directory mappings survive restarts via `/tmp/tgagentp-connections.json`. On reboot, tgagentp re-discovers the live server URL from `.ocmux.json` and reconnects automatically. `/shutdown clear` wipes the saved state.
- **Remote resurrect** — `/resurrect` restarts a crashed server from Telegram: calls `resurrectServer()` from the library, then transfers session state (`serverOwners`, active session/agent) to the new URL.

```vim
:'<,'>!agentp --qa --tg          " answer in editor + Telegram (hard error if no tgagentp)
:'<,'>!agentp --qa               " same + Telegram only if tgagentp detected
:'<,'>!agentp --qa --flush       " flush /record buffer
:'<,'>!agentp                    " only replaces. Useful for simple snippets.
:'<,'>!agentp --no-tg            " same as above, explicitly skip Telegram
```

**Environment variables:**

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot token from @BotFather |
| `TGAGENTP_ALLOWED_CHAT_IDS` | No | all | Comma-separated chat IDs to allow (e.g. `"123456,-789012"`) |
| `TGAGENTP_PORT` | No | random | Port for the agentp gateway (agentp --tg discovers it automatically) |
| `TGAGENTP_DEBOUNCE_MS` | No | 5000 | Debounce interval for queued-agentp Telegram notifications (ms) |
| `OPENCODE_SERVER_PASSWORD` | No | — | Password for authenticated OpenCode servers |

All of this with **zero npm dependencies** — just Node.js 18+ stdlib.

---

## Why This Setup Works

1. **Always-visible TUI, hands-free** — The dedicated TUI lives on a spare monitor, a virtual desktop, or a tmux window. You work elsewhere. The TUI shows the full picture without you touching it.
2. **Multi-project agility** — Each project gets its own server and TUI. Switch projects with a single `ocmux` command (or automatically via `ocmux` with no args), and the displayed TUI follows. Start a task in project A, switch to project B while A runs.
3. **Editor ↔ terminal ↔ Telegram loop** — Pipe from Vim with `agentp`, get the answer inline. Enable `--tg` (implicit with `--qa`) and the result also lands in Telegram — so even if you moved to another device or context, you know when it's done.
4. **Remote awareness** — tgagentp monitors progress, forwards permission prompts, and queues follow-ups from anywhere. `/record` recovers Telegram conversation context for your next `agentp` call. Notifications pop the moment a piped task finishes or needs input.
5. **Graceful degradation** — `--tg` in auto mode silently skips Telegram if tgagentp isn't running. Explicit `--tg` errors pre-send, warns post-send.
6. **Async processing** — tgagentp never blocks the polling loop. Commands stay responsive even while a prompt runs.

---

## Quick Start

```bash
npm install -g agentp

# Start a project server
ocmux serve ~/projects/myapp

# Pipe a prompt
printf "Explain this codebase" | agentp

# With Telegram (set up a bot with @BotFather first)
export TELEGRAM_BOT_TOKEN="your-token"
export OPENCODE_SERVER_PASSWORD="your-password"   # optional but recommended
tgagentp --think
```

---

## Links

- **GitHub:** [github.com/bitifet/agentp](https://github.com/bitifet/agentp)
- **npm:** [npmjs.com/package/agentp](https://www.npmjs.com/package/agentp)
- **OpenCode:** [github.com/anthropics/claude-code](https://github.com/anthropics/claude-code)

---

*Feedback? Issues? PRs welcome.*
