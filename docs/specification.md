# agentp — Specification

## Overview

Three zero-dependency Node.js CLI tools that augment OpenCode with project-level server management (tmux) and a Telegram bridge.

- **`agentp`** — pipe stdin → OpenCode session → stdout answer
- **`ocmux`** — manage per-project OpenCode servers in tmux
- **`tgagentp`** — Telegram bot bridge with multi-chat, multi-server support

All tools share `lib/opencode.js` (HTTP session API client) and `lib/ocmux.js` (tmux management). Zero npm dependencies — only Node.js 18+ stdlib.

---

## File Reference

### `package.json`

**Version:** 0.11.2

Fields:
- `"bin"` — registers `agentp`, `ocmux`, `tgagentp`
- `"files"` — whitelist for npm publish: `bin/`, `lib/`, `README.md`
- `"type": "commonjs"`
- `"engines": { "node": ">=18" }`

### `bin/agentp` — Stdin-to-OpenCode pipe

Reads stdin, sends to the most recent or named OpenCode session, streams answer to stdout.

**Options:**

| Flag | Effect |
|---|---|
| `--qa` | Print prompt/answer with rulers; auto-detect tgagentp |
| `--tg` | Forward answer via tgagentp gateway (error if unavailable) |
| `--no-tg` | Explicitly disable Telegram forwarding |
| `--flush` | Flush recorded buffer without prepending |
| `--getLast N` | Retrieve last N assistant answers from session history |

**Protocol:**

1. Reads all stdin → string
2. Calls `listSessions(server)` → finds most recently updated session (or creates one named `agentp`)
3. Calls `sendToSession(server, sessionId, text, agent?, cancelRef?)` → returns concatenated text parts
4. Prints answer to stdout
5. If `--tg` or `--qa` (auto-detect):
   - POSTs `{ text, server }` to tgagentp gateway at `http://localhost:<port>/send`
   - Gateway response includes `{ buffered }` — recorded conversation messages
   - `--qa` prepends buffered context to stdout; `--flush` skips prepending

**HTTP timeout:** 5 seconds. Pre-send gate check + post-send warning for `--tg`.

### `bin/ocmux` — Tmux server manager

Manages per-project OpenCode servers in a persistent `Opencode` tmux session.

**Subcommands:**

| Command | Description |
|---|---|
| `serve [dir]` | Create server + TUI pane in a new tmux window |
| `new [dir]` | Alias for `serve` (deprecated) |
| `kill [dir]` | Kill server, remove tmux window + `.ocmux.json` |
| `resurrect [dir]` | Recover dead server: kill old window, remove state file, create fresh server + TUI |
| `list [-l]` | List all running servers |
| _(no arg)_ | Switch to existing server (searches upward for `.ocmux.json`) |

**Flags:** `--git`, `--GIT`, `--print-logs`, `-l`, `--version`

**Window layout:**

- Pane 0: server (`opencode serve --port 0 2>&1 | tee <logfile>`)
- Pane 1+: TUI (`opencode attach --continue '<url>'`)
- Log: `/tmp/opencode-serve-<hashDir(dir)>.log`
- State: `<dir>/.ocmux.json` (contains `url`, `logfile`, `window_index`)

**State file discovery:** Upward from target directory, git-like.

### `bin/tgagentp` — Telegram bridge

Long-polling Telegram bot that routes messages to OpenCode servers.

**Options:**

| Flag | Effect |
|---|---|
| `--dev` | Enable `/shutdown` for remote restart, verbose logging, and structured message traffic log to `/tmp/tgagentp-msg.log` |
| `--think` | Start with thinking forwarding enabled |
| `--verbose` | Detailed logs on stderr |

**Environment variables:**

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot token from @BotFather |
| `TGAGENTP_ALLOWED_CHAT_IDS` | No | all | Comma-separated allowed chat IDs |
| `TGAGENTP_PORT` | No | random | Agentp gateway HTTP port |
| `TGAGENTP_DEBOUNCE_MS` | No | 5000 | Debounce for queued-agentp Telegram notifications |
| `OPENCODE_SERVER_PASSWORD` | No | — | HTTP Basic Auth for OpenCode + gateway |
| `OPENCODE_SERVER_USERNAME` | No | opencode | HTTP Basic Auth username |

### `lib/opencode.js` — HTTP session API client

Shared by `bin/agentp` and `bin/tgagentp`. Functions:

| Function | HTTP | Description |
|---|---|---|
| `getAuthHeaders()` | — | Reads `OPENCODE_SERVER_PASSWORD/USERNAME` |
| `makeRequest(options, data)` | — | Thin `http.request` wrapper |
| `buildJsonRequest(url, method, body)` | — | Builds request options |
| `sendText(server, text)` | POST /tui/* | Convenience: clear + append + submit prompt |
| `listenForFinalAnswer(server, onText?, cancelRef?)` | GET /event | SSE listener; `cancelRef` enables abort |
| `listSessions(server, directory?)` | GET /session | Returns parsed JSON array |
| `createSession(server, title?)` | POST /session | Creates a session |
| `updateSession(server, id, title, agent?)` | PATCH /session/:id | Updates session properties |
| `sendToSession(server, id, text, agent?, cancelRef?)` | POST /session/:id/message | Synchronous message; optional abort |
| `sendToSessionAsync(server, id, text, agent?)` | POST /session/:id/prompt_async | Non-blocking (204); answer via SSE |
| `respondToPermission(server, id, permissionId, response)` | POST /session/:id/permissions/:id | Permission response |
| `respondToQuestion(server, id, questionId, answer)` | POST /session/:id/questions/:id | Question response |
| `selectSession(server, id)` | POST /session/:id/select | TUI navigation |
| `listAgents(server)` | GET /agent | Returns parsed array |
| `listProviders(server)` | GET /provider | Returns parsed array |
| `isServerAlive(url)` | GET /session (5s timeout) | Health check, resolves true/false |
| `listenForSessionEvents(server, id, callbacks, cancelRef?)` | GET /event | SSE with structured events |

### `lib/ocmux.js` — Tmux management library

Shared by `bin/ocmux` and `bin/tgagentp`. Functions:

| Function | Description |
|---|---|
| `readState(file)` | Parses `.ocmux.json`; returns `null` on error |
| `statefileFor(dir)` | `path.join(dir, '.ocmux.json')` |
| `tuiPaneId(windowIndex)` | Returns pane ID of TUI pane (pane index != 0); `null` if dead |
| `windowByDir(dir)` | Returns tmux window index matching directory name |
| `windowNameByIndex(idx)` | Returns window name at given index |
| `activeWindowIndex()` | Returns index of currently selected tmux window |
| `paneCount(windowIndex)` | Number of panes in a window |
| `listServers()` | Scans all tmux windows for `.ocmux.json`; returns `{ url, dir, index, status }` |
| `activateServer(dir, index, url)` | Pin window name, restart dead TUI pane, select window, zoom |
| `hashDir(dir)` | MD5 hash (first 12 chars) |
| `logfileFor(dir)` | `/tmp/opencode-serve-<hash>.log` |
| `sleep(seconds)` | `execSync sleep` |
| `ensureSession()` | Create `Opencode` tmux session if missing |
| `pinWindowName(windowIndex)` | Disable tmux auto-rename for the window |
| `resurrectServer(dir, printLogs)` | Kill old window, remove state file, create fresh server + TUI; returns `{ url, dir }` |

---

## Persistence / State Files

### `{project_dir}/.ocmux.json`

Per-project state file created by `ocmux serve`:

```json
{
  "url": "http://localhost:40999",
  "logfile": "/tmp/opencode-serve-abc123.log",
  "window_index": 5
}
```

- **url:** The server's listen URL (assigned by `--port 0` — changes on every restart)
- **logfile:** Path to the server's tee'd log output (used for URL polling during startup)
- **window_index:** The tmux window index within the `Opencode` session

Discovered by upward directory search from the current/target directory (git-like). Used by `ocmux`, `tgagentp`, and `agentp` for server discovery.

### `/tmp/tgagentp-port`

Created by tgagentp on startup. Contains the HTTP port number of the agentp gateway. Read by `agentp --tg` to discover the gateway.

```
49152
```

### `/tmp/tgagentp-connections.json`

Created and maintained by tgagentp. Persists chat↔server directory mappings across restarts.

```json
{
  "connections": [
    {
      "chatId": "123456789",
      "threadId": null,
      "dir": "/home/user/projects/myapp"
    },
    {
      "chatId": "987654321",
      "threadId": "42",
      "dir": "/home/user/projects/other"
    }
  ]
}
```

- **chatId:** Telegram chat ID (string)
- **threadId:** Telegram forum topic ID or `null`
- **dir:** Project directory (where `.ocmux.json` lives)

On restart, tgagentp reads this file, reads `.ocmux.json` from each `dir` to discover the fresh URL, and reconnects. If `.ocmux.json` is missing, the chat starts disconnected.

**Lifecycle:**
- Written on every `/servers switch` (via `setServerForChat`)
- Removed for displaced chats on force-takeover (via `removeConnection`)
- Removed for pruned chats on restart (secondary per URL)
- Cleared on `/shutdown clear` (via `clearConnections`)
- Updated on group migration (regular group → supergroup, e.g. enabling topics): all `chatId` references in the file are replaced with the new ID

### `/tmp/opencode-serve-<hashDir(dir)>.log`

Server log file. Continuously written by `tee` in the server pane. Polled by `doNew`/`resurrectServer` for URL extraction during startup:

```
opencode server listening on http://localhost:40999
```

---

## Inter-Process Communication

### Agentp Gateway (tgagentp ↔ agentp)

tgagentp starts an HTTP server on `127.0.0.1:<port>` (random by default, configurable via `TGAGENTP_PORT`). `agentp --tg` POSTs answers to this gateway.

**Endpoint:** `POST /send`

**Request:**
```json
{
  "text": "Answer from OpenCode",
  "server": "http://localhost:40999"
}
```

**Headers:**
- `Authorization: Basic <base64>` — verified against `OPENCODE_SERVER_PASSWORD`

**Response:**
```json
{
  "buffered": [
    {"role": "user", "text": "What is X?"},
    {"role": "assistant", "text": "X is..."}
  ]
}
```

**Flow:**
1. Gateway looks up `serverOwners` map to find which chat owns the target server
2. If found and it's the active server for that chat → forwards immediately via `sendLongMessage`
3. If not the active server → debounce-queues with notification after `TGAGENTP_DEBOUNCE_MS`
4. Returns recorded conversation buffer (if any) — `agentp --qa` prepends this to stdout
5. If no owner found (no chat connected to that server) → returns buffered data, drops the message

### Tmux Session Model (ocmux)

All servers live in a single tmux session named `Opencode`. Each project gets one window:

```
Session: Opencode
├── Window 3: /home/user/project-a
│   ├── Pane 0: opencode serve --port 0 ...   (server)
│   └── Pane 1: opencode attach --continue ...  (TUI, zoomed)
├── Window 4: /home/user/project-b
│   ├── Pane 0: opencode serve --port 0 ...
│   └── Pane 1: opencode attach --continue ...
```

Window names are the full project directory path. Pane 0 is always the server; pane 1+ is the TUI. The TUI pane is zoomed on switch/create. Dead TUI panes are auto-restarted on switch.

---

## Chat-Server Ownership Model (tgagentp)

### States

- **Disconnected:** `chatState.serverBase === null`. Only `/help`, `/servers`, `/start` work.
- **Connected:** `chatState.serverBase === <url>`. Server is owned by this chat.
- **Force-taken:** Previous owner gets `serverBase = null` and a Telegram notification.

### Data Structures

```javascript
serverOwners = {
  "http://localhost:40999": { chatId: "123", threadId: null },
  "http://localhost:41000": { chatId: "456", threadId: "42" },
}
```

Maps server URL → owning chat. Used by the agentp gateway to route forwarded messages. Updated on every `/servers switch` and on startup restoration.

```javascript
chatStates = {
  "123": {
    chatId: "123",
    threadId: null,
    serverBase: "http://localhost:40999",
    recording: { active: false, paused: false, messages: [], bytes: 0 },
    ring: { messages: [], bytes: 0 },
  },
  "456:42": {
    chatId: "456",
    threadId: 42,
    serverBase: null,
    ...
  },
}
```

Keyed by `convKey(chatId, threadId)` → `${chatId}:t${threadId}` (or just `chatId` for non-thread chats). Created on first message from each chat.

### Connection Flow

1. **First message** → `getChatState` creates state with `serverBase: null`
2. **`/servers switch <name>`** → `cmdServers`:
   - Finds server directory by name match
   - Checks `serverOwners` — warns if owned by different chat (unless `--force`)
   - Calls `setServerForChat(chatState, url)`:
     - Iterates all `chatStates`, sets `serverBase = null` for any other chat on same URL
     - Sets `chatState.serverBase = url`
     - Sets `serverOwners[url] = { chatId, threadId }`
     - Saves connection to `/tmp/tgagentp-connections.json`
     - Activates tmux window
     - Flushes agentp queue for this server
3. **Restart** → reads `/tmp/tgagentp-connections.json`, restores each connection:
   - Phase 1: restores all chat states (`cs.serverBase`) and populates `serverOwners`
   - `serverOwners` picks non-thread (private chat) over topic threads as owner per URL
   - Phase 2: prunes secondary connections — only the owner per URL survives, others have `serverBase` cleared and connection removed from file
   - Phase 3: "Bot started" notification sent only to owner per URL (first-to-notify wins)
4. **`/force-switch <name>`** → same as `/servers switch --force <name>`: bypasses ownership check, takes over server, notifies previous owner
5. **`/disconnect`** → clears `serverBase`, removes ownership, deletes connection from file

### Disconnected Guard

Both command and non-command paths in the message loop check `cs.serverBase`:

- Commands: only `/help`, `/servers`, `/force-switch`, `/start`, `/comment`, `/shutdown` pass through without a server
- Non-commands: `🔌 Not connected. Use /servers to see available servers.`

---

## `//command` TUI Passthrough

Messages starting with `//` are forwarded to the TUI as raw keystrokes (not AI text). The `//` prefix is stripped, a trailing space is appended to activate the TUI as-you-type menu, and `tmux send-keys` sends the keys to the TUI pane. An SSE listener connects before the Enter key to catch the AI response.

**Flow:**
1. Chat message: `//init`
2. Strips `//` → `init`
3. Prepends `/` → `/init`
4. Appends space → `/init ` (selects TUI menu item)
5. `tmux send-keys` to TUI pane: `C-u` (clear line), type `/init `, Enter
6. SSE listener starts before Enter (15s timeout)
7. If AI responds: forwards full answer to Telegram
8. If timeout: sends `✅ /init submitted.` confirmation

**Busy guard:** `//command` is blocked when `st.busy` is true (same "use /cancel" message as regular messages).

**Commands that trigger AI responses:** `//init`, `//clear`, `//history` (and any other TUI command that produces an AI answer). Quick commands like `/exit` timeout without an answer.

---

## Question Handling

When the AI asks a structured multiple-choice question (via `question.asked` SSE event), tgagentp forwards the question to Telegram with numbered options.

**Notification format:**
```
❓ **Question from the AI**

What would you like to test?

1. Option A
2. Option B
3. Option C

Use /answer <number> to respond.
```

**Response:**
- `/answer <number>` → `POST /session/:id/questions/:id` with the selected option's value
- Only one question can be pending at a time per server
- The question is stored per-server in `chatStates.pendingQuestion`

---

## Logging Conventions (tgagentp)

- **stdout** — informational messages (startup, discovery, session switches)
- **stderr** — errors (always shown) + trace/debug (only `--verbose` flag)
- Default usage: `tgagentp 2>/dev/null`

### Dev Mode Message Log

When `--dev` is active, tgagentp writes a structured JSON-lines message traffic log to `/tmp/tgagentp-msg.log`:

```
{"ts":"2026-06-09 06:25:01","type":"in","chatId":-1004291964025,"from":"user","text":"/status"}
{"ts":"2026-06-09 06:25:01","type":"out","chatId":-1004291964025,"from":"assistant","text":"**Server:** ..."}
```

Each line contains a timestamp, direction (`in`/`out`), chat ID, sender, and text content.

---

## Error Handling

### Server Health (tgagentp)

```javascript
// Pre-send check
if (st.serverDead) {
  const alive = await isServerAlive(url);  // GET /session, 5s timeout
  if (alive) { st.serverDead = false; }
}
if (st.serverDead) {
  // Auto-queue the message
  st.messageQueue.push({ text, replyTo });
  // Notify user with options (ocmux serve, /servers switch, /flush)
}
```

Health check runs before every non-command message. Dead servers cause auto-queue with user notification. Connection errors in `processMessageAsync` mark `serverDead = true` and requeue.

### Busy Server

When `st.busy` is true, non-command messages are dropped with a "⏳ Busy" notice. Use `/queue <message>` to explicitly queue.

### Gateway Errors

- Missing owning chat → return buffered data, drop message
- Socket errors → caught by try-catch in gateway handler (no crash)
- HTTP timeout (5s) in agentp → post-send warning (not hard error)
