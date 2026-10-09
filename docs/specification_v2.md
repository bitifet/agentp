# agentp 2.x — Project, Session, and TUI Specification

Status: **Current**

## 1. Runtime model

OpenCode 2 uses a shared service/data store. Sessions belong to locations and
carry `location.directory`; a server URL does not identify a project.

The tools therefore use these identities:

- **Project:** canonical directory.
- **Prompt target:** OpenCode session ID in that directory.
- **Display:** an optional, explicitly registered tmux pane.

The OpenCode server is user-managed. `agentp` and `ocmux` health-check it but do
not start or stop it.

## 2. Project state

The nearest `.ocmux.json`, found by walking upward from the working directory,
is the durable source of truth:

```json
{
  "version": 2,
  "directory": "/home/user/project",
  "session": "ses_abc",
  "server": "http://localhost:4096",
  "annotations": {},
  "broadcast": ["ses_abc", "ses_def"]
}
```

`directory`, `session`, and `server` route prompts. `annotations` stores optional
per-session reminders. `broadcast` exists only with at least two selected main
sessions. Writes use a temporary file plus atomic rename.

No tmux socket, pane ID, process ID, or TUI assignment belongs in project state.
Those values are ephemeral and machine-local.

## 3. TUI runtime registry

`ocmux tui` registers its current `$TMUX_PANE`. The registry lives at:

```text
$OCMUX_RUNTIME_DIR/ocmux-tuis.json                 (test/override)
$XDG_RUNTIME_DIR/agentp/ocmux-tuis.json            (normal)
/tmp/agentp-<uid>/ocmux-tuis.json                  (fallback)
```

The directory is mode `0700` and registry files are mode `0600` where the
platform permits it. Updates are lock-protected and atomically renamed.

Each instance records:

- opaque instance ID;
- random verification token;
- tmux socket and pane ID;
- dedicated/shared mode;
- last directory, server, and session;
- the directory and session currently displayed (so routing can skip a
  respawn that would change nothing);
- foreground wrapper PID and current child PID (diagnostic only);
- registration/update timestamps.

The pane itself receives `@ocmux_tui_id` and `@ocmux_tui_token` tmux options.
Before a destructive pane operation, both must match the protected registry.
This prevents a stale registration from respawning an unrelated pane. Pane IDs
remain useful after `move-window`, `join-pane`, or `break-pane` within the same
tmux server; recording the socket disambiguates multiple tmux servers.

There are two assignment slots:

- one dedicated TUI per canonical project directory;
- exactly one shared TUI across all projects and server URLs.

There is no `--global` alias.

## 4. TUI routing

When `ocmux` selects or inspects a session, it resolves the display in order:

1. live TUI dedicated to the target directory;
2. the one live shared TUI;
3. no display (headless success).

A stale/dead dedicated registration is ignored, so routing falls back to the
shared registration. A stale shared registration yields headless operation.
Display failure is a warning and never rolls back the durable session choice.

The shared TUI is deliberately not server-scoped. When a selected project uses
a different server, the same pane reconnects to that server.

## 5. Foreground TUI wrapper

`ocmux tui [--shared] [directory]`:

1. Requires `$TMUX` and `$TMUX_PANE`.
2. Resolves `.ocmux.json`, server, directory, and session. A shared TUI may run
   without a state file, in which case it uses the current directory and the
   default server (`$OCMUX_SERVER` or `http://localhost:4096`).
3. Health-checks the server and validates the session, creating one with a
   model when necessary.
4. Marks and registers the current pane.
5. Stops the displaced wrapper for the same dedicated/shared slot, preserving
   its pane.
6. Spawns `opencode` as a foreground child with inherited stdio:

   ```text
   opencode --server <url> --session <id> <directory>
   ```

7. Forwards `SIGHUP`, `SIGTERM`, and `SIGINT` to the child.
8. On child exit, unregisters only when instance ID and token still match.

Token-conditional cleanup prevents an old wrapper from deleting a replacement's
new registration.

## 6. Switching a registered TUI

OpenCode exposes no HTTP operation for steering one specific TUI client. A
registered pane is therefore switched with:

```text
tmux -S <socket> respawn-pane -k -t <pane> -c <directory> \
  "<ocmux> tui [--shared] --server <url> --session-id <id> -- <directory>"
```

The new `ocmux tui` process re-registers the pane and hosts the new OpenCode
child. Server-side session execution continues while the old client disconnects.
Client-local state—draft prompt, scroll position, dialogs, and tabs—is lost.

Routing is idempotent: the registry records the directory and session the pane
currently displays, so a switch to the same project/session is skipped without
respawning.

Native TUI navigation is temporary inspection and is not observable through
the OpenCode HTTP API. The next ocmux selection restores the canonical target.

## 7. Commands

### `ocmux serve [dir]`

Initializes `.ocmux.json`, selecting the newest main session in the directory
or creating one with a model. It creates no tmux session, window, or pane.
`--force --server <url>` repoints existing state and refreshes the routed TUI.

### `ocmux tui [--shared] [--server <url>] [dir]`

Registers and hosts a dedicated or shared TUI as described above. `--shared`
is valid only for this command. `--server` overrides the project's recorded
server for the launched wrapper; when `--shared` runs without a state file it
falls back to the default server. Management modes are:

- `ocmux tui --list` — prune stale entries and print every live registration;
- `ocmux tui [dir] --status` — inspect the dedicated slot for that project;
- `ocmux tui --shared --status` — inspect the shared slot;
- `ocmux tui [dir] --detach` — unregister the dedicated slot;
- `ocmux tui --shared --detach` — unregister the shared slot.

`--detach` clears the pane's verification options but does not stop OpenCode or
destroy the pane. Management modes do not require running inside tmux.

### `ocmux`

Opens the current project's session picker. Picking writes that project's
session and refreshes its routed TUI. Merely opening the picker also routes the
applicable TUI to the project's stored session (skipped when it already shows
it), so starting `ocmux` in a project switches the display even without picking
a row. When the recorded server is unreachable but the default server answers,
`ocmux` offers on a TTY to repoint the project to the default and rewrites
`server`. Session creation, rename/delete,
annotations, agent/model choice, broadcast selection, search, and project
inspection operate through OpenCode's API. Deleting the session currently
selected adopts the session under the cursor as the new current (state write,
TUI refresh, and list highlight); deleting any other session leaves the current
selection unchanged. In broadcast mode `d` deletes just the cursor session
while `D` (Shift+d) deletes every selected session at once — after confirming,
broadcast mode ends and the row under the cursor becomes the new current.

### `ocmux session <id|title> [dir]`

Non-interactively writes the selected session and refreshes its routed TUI.

### Project switcher (`p`)

Configured projects are discovered from `/api/project` plus session locations;
only directories containing `.ocmux.json` are included. This captures worktrees
that are locations but not separate OpenCode project records.

By default the switcher only inspects sessions through the routed TUI and never
writes another project's state. `--all-projects` lets the outer session picker
move to another project and subsequently update that project's state.

### `ocmux list [-l]`

Lists configured projects, selected sessions, and display status:

- `project` — a live dedicated TUI wins;
- `shared` — the live shared fallback applies;
- `headless` — no live registration.

`-l` also prints the server URL.

The old managed-window `kill` and `resurrect` commands do not exist.

## 8. `agentp`

`agentp` resolves project/session/server from explicit options and the nearest
state file, then sends directly to the session API. It does not focus, move, or
refresh a TUI; TUI routing is an explicit consequence of ocmux session
selection, not prompt submission.

## 9. Failure behavior

- Missing/unreachable server: command fails before registration or switching.
- Missing TUI: session selection succeeds headlessly.
- Dead pane or mismatched token: registration is pruned and fallback routing is
  attempted on the next resolution.
- Failed `respawn-pane`: selected state remains valid and a warning is printed.
- Manual OpenCode exit: foreground wrapper removes its own registration.
- Replaced wrapper exits late: token check prevents it removing the new owner.
- tmux restart/reboot: pane checks invalidate and prune old runtime entries.
- Multiple tmux servers: recorded `-S <socket>` targets the correct one.

## 10. Security boundaries

- `.ocmux.json` never identifies a process or pane to terminate.
- Destructive pane operations require matching registry and pane tokens.
- Commands are built from validated server/session/directory values with shell
  quoting; no command string is read from project state.
- Runtime registry and lock files are private to the user.
- Wrapper/child PIDs are diagnostic only and are never used as durable identity
  or as the target of a destructive operation.
