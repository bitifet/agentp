# Agentp: Turn OpenCode Into a Headless AI Engine for Your Editor, Terminal, and Telegram
OpenCode is great, but its TUI locks you in. You type in one window, watch it stream, and that's it. What if you could:

- Pipe a prompt straight from Vim and replace your selection with the answer?
- Queue messages from Telegram while it's busy and get replies threaded?
- Keep a permanent tmux server per project and switch between them?
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
ocmux serve ~/projects/myapp   # create
ocmux list                      # list all
ocmux ~/projects/myapp          # switch (shows url)
ocmux                           # same as ocmux $(pwd)
ocmux kill ~/projects/myapp     # remove
ocmux kill                      # same as ocmux $(pwd)
```

### `tgagentp` — The Telegram Bridge

A Telegram bot that routes messages to your OpenCode servers. Multi-server aware, slash-commands for everything.

**Slash commands:**

| Command | What it does |
|---|---|
| `/servers` | List/switch between ocmux projects |
| `/sessions` | List/switch/create/rename sessions |
| `/agents` | List/switch active agent |
| `/models` | List providers and models |
| `/queue <msg>` | Queue message when busy — auto-sent after current task finishes (replies chain!) |
| `/record` | Record conversation for `agentp` context injection |
| `/think` | Toggle real-time thinking message forwarding |
| `/cancel` | Abort the running prompt |

---

### `agentp` and `ocmux` toghether

- `agentp` defaults to http://localhost:4096 (the opencode default). But it accepts a port or a full URL as a parameter.

- `ocmux` with no arguments switches the Opencode tmux session to the window of the current project (based on current directory) and prints the server URL.

- Both combined let you talk to the right OpenCode server without bothering with ports or URLs. Just `agentp $(ocmux)` or `agentp --qa $(ocmux)` if you want to get the full QA pair with rulers and you are done.


Now we can auto-swithch to the right OpenCode server every time we use it no matter where we are in the filesystem, and even from Vim:

```vim
:'<,'>!agentp --qa $(ocmux)
```


---

## The Agentp Gateway

The killer integration: `agentp` and `tgagentp` talk to each other through a tiny HTTP gateway.

- **`agentp --tg`** forwards the answer to your Telegram chat after every pipe.
- **`agentp --qa`** auto-detects tgagentp and sends the full QA pair (rulers + prompt + answer).
- **`/record`** buffers the Telegram conversation. On the next `agentp` call, the gateway returns the buffer, and `--qa` prepends it to stdout with rulers — so OpenCode sees the full Telegram thread as context.
- **`agentp --flush`** clears the buffer without prepending.
- **`agentp --getLast 5`** retrieves the last 5 assistant answers from session history.

```vim
:'<,'>!agentp --qa --tg          " answer in editor + Telegram
:'<,'>!agentp --qa --flush       " flush recorded buffer
```

All of this with **zero npm dependencies** — just Node.js 18+ stdlib.

---

## Why This Setup Works

1. **Session API, not TUI hooks** — messages go through `POST /session/:id/message`, which returns synchronously. No fragile TUI scraping.
2. **Per-project tmux isolation** — each project gets its own `opencode serve` process. Switch with a single command.
3. **Graceful degradation** — `--tg` in auto mode silently skips Telegram if tgagentp isn't running. Explicit `--tg` errors pre-send, warns post-send.
4. **10s HTTP timeout on every request** — nothing ever hangs.
5. **Async processing** — tgagentp never blocks the polling loop. Commands stay responsive even while a prompt runs.

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
tgagentp
```

If your OpenCode server is password-protected, set `OPENCODE_SERVER_PASSWORD`.

---

## Links

- **GitHub:** [github.com/bitifet/agentp](https://github.com/bitifet/agentp)
- **npm:** [npmjs.com/package/agentp](https://www.npmjs.com/package/agentp)
- **OpenCode:** [github.com/anthropics/claude-code](https://github.com/anthropics/claude-code)

---

*Feedback? Issues? PRs welcome.*
