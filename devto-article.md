# Agentp: Turn OpenCode Into a Headless AI Engine for Your Editor, Terminal, and Telegram

I've always felt out of step with the prevailing trends.

Before the AI explosion, the mantra was "ship fast" — the Minimum Viable Product. If you weren't first, you were nobody. Quality, testing, documentation? Nice-to-haves. I could never stomach shipping "human slop" just to be first.

Now we're in the AI era, and suddenly everyone is alarmed about "AI slop." And I find myself out of step again — because from where I stand, the AI helps me produce the opposite. My documentation is better. I write more tests than I could have imagined before. The code is cleaner. Even the worst AI-generated test is harmless: the most it can do is be useless. Unlike buggy production code rushed out to win a race, it won't break anything.

The same goes for tooling. Every few years — sometimes months — a new IDE becomes the baseline, and if you haven't switched you're suddenly irrelevant. I use Neovim and tmux. Not because they're trendy, but because I spent years evolving a workflow that works across physical terminals, remote servers, and whatever machine I happen to be sitting at. I'm not about to throw that away for a shinier editor.

That's the mindset behind **agentp**. I started building these tools for my own daily workflow — not to ship a product, but to solve real friction I was feeling every day. OpenCode is great, but its TUI locks you in. I wanted to:

- Pipe a prompt straight from Vim and replace my selection with the answer.
- Talk to my projects from Telegram while away from the keyboard.
- Queue messages while a server is busy and get threaded replies.
- Keep a permanent server per project in tmux and switch between them.
- Record a Telegram conversation and inject it as context into the next prompt.

agentp grew from there — piece by piece, idea by idea — into a set of three zero-dependency Node.js CLI tools. It's heavily AI-assisted, including the tests. I review every stage before shipping, but the real test is using it every day. Bugs happen; I value a working feature more than a flawless one.

---

## The Three Tools

### `agentp` — The Pipe

Stdin in, answer out. That's the core loop.

```bash
printf "Summarize this file" | agentp
cat prompt.txt | agentp

# Target a specific session by name (partial match works)
cat prompt.txt | agentp --session "My Task"
cat prompt.txt | agentp --session "New Task" --new   # create if not found

# Pull the last N answers without sending a new prompt
agentp --getLast 5
agentp --getLast 3 --qa    # full QA pairs with rulers
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

`ocmux --last` prints the URL of the active tmux window — useful when calling `agentp` from outside the project directory.

When an opencode server crashes, `ocmux resurrect` reads `.ocmux.json`, kills the stale tmux window, and starts a fresh server + TUI in the same directory. Works even with a dead tmux window (stale state file).

### `tgagentp` — The Telegram Bridge

A Telegram bot that routes messages to your OpenCode servers. Multi-chat, multi-server, slash-commands for everything.

```bash
tgagentp                                  # default port 4096
tgagentp --think                          # start with thinking forwarding enabled
tgagentp --dev                            # enable /shutdown for remote restart
TGAGENTP_ROOT=/srv/projects tgagentp      # enable /serve and /new commands
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
| `/serve <path>` | Start a server in an existing project (requires `TGAGENTP_ROOT`) |
| `/new <path>` | Create a directory, init git, and start a server (requires `TGAGENTP_ROOT`) |
| `/allow` | Approve a tool permission once |
| `/reject` | Deny a tool permission |
| `/always` | Approve a permission and remember the choice |
| `/answer <number>` | Respond to a structured question from the AI |
| `//<command>` | Send a raw TUI command (e.g., `//init`, `//clear`) — answer or confirmation forwarded |
| `/queue <msg>` | Queue message when busy — auto-sent after current task finishes (replies chain!) |
| `/record` | Record / pause / retrofill conversation for `agentp` context |
| `/flush` | Clear all queued messages (manual or auto-queued) |
| `/note <text>` | Forward context for agent awareness (agent replies "Ack", info informs future responses) |
| `/comment <text>` | Save a comment in chat (not forwarded to agent — context via reply quoting) |
| `/think` | Toggle real-time thinking message forwarding |
| `/cancel` | Abort the running prompt |
| `/disconnect` | Disconnect from current server, clear ownership and connection file |
| `/force-switch <server>` | Switch server bypassing ownership check (two-phase matching) |
| `/resurrect` | Restart a crashed server and reconnect the chat to the new instance |

Permission prompts from OpenCode (tool access requests) are forwarded automatically — respond with `/allow`, `/reject`, or `/always` directly in the chat.

When the AI asks a structured question (e.g., tool configuration), tgagentp forwards it as a numbered multiple-choice poll — respond with `/answer <number>`. If the command produces a quick answer, it arrives immediately; otherwise a confirmation (`✅ /init submitted.`) is sent.

**File sharing:** Upload files and photos to Telegram, and they're saved to `telegram-shared/uploads/` in the project directory — automatically created with a `.gitignore`. The agent is notified when idle. Download files back by replying to a file message or by having the agent write to `telegram-shared/downloads/` — tgagentp sends them via `sendDocument` and cleans up after.

**`!!` wildcard:** Use `!!` in any command to reference the previous user message. For example, `/queue !!` queues your last message, `/note !!` sends it as a note.

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
- **Auto tmux switch** — every message or `/note` from any chat/topic automatically selects and zooms the corresponding server's tmux window, so the TUI follows the conversation across topics.
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
| `TGAGENTP_ROOT` | No | — | Root directory for `/serve` and `/new` commands (must be writable) |
| `TGAGENTP_PORT` | No | random | Port for the agentp gateway (agentp --tg discovers it automatically) |
| `TGAGENTP_DEBOUNCE_MS` | No | 5000 | Debounce interval for queued-agentp Telegram notifications (ms) |
| `OPENCODE_SERVER_PASSWORD` | No | — | Password for authenticated OpenCode servers |

All of this with **zero npm dependencies** — just Node.js 18+ stdlib.

---

## Why This Setup Works

1. **Always-visible TUI, hands-free** — The dedicated TUI lives on a spare monitor, a virtual desktop, or a tmux window. You work elsewhere. The TUI shows the full picture without you touching it.
2. **Multi-project agility** — Each project gets its own server and TUI. Switch projects with a single `ocmux` command (or automatically via `ocmux` with no args), and the displayed TUI follows. The same auto-switch works from Telegram: every message or `/note` selects the right tmux window, so the TUI follows you across topics. Start a task in project A, switch to project B while A runs.
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
