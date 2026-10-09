# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [2.1.1] - 2026-10-09

The **broadcast UX polish** release. Broadcast mode gained `D` (Shift+d) to
delete the whole selection in one confirmation, and every picker prompt
(create/rename/reminder/delete/delete-all) now lives on the status bar, which
flips to **light yellow** while a question is active. The `Broadcast to
sessions:` info line caps at 480 characters (or the terminal width) with a
leading `...` instead of wrapping. Outside the picker, `ocmux tui --shared`
now works without a `.ocmux.json`, an unreachable recorded server falls back
to a live default after a confirmation prompt, and opening the picker routes
the TUI to the project's stored session.

### Fixed

- **`ocmux tui --shared` required a project.** The cross-project fallback now
  starts without a `.ocmux.json`, using the current directory and the default
  server (`$OCMUX_SERVER` or `http://localhost:4096`). No state file is created.
- **Opening `ocmux` in a project did not switch the TUI.** Entering the session
  picker now routes the applicable dedicated/shared TUI to the project's stored
  session, so you no longer have to re-pick the already-selected row. The
  registry records the displayed directory/session and the respawn is skipped
  when they already match, so an unchanged TUI is not restarted.
- **Deleting the current session left nothing highlighted.** After confirming a
  `d` deletion, ocmux now adopts the session under the cursor as the new
  current: it is written to `.ocmux.json`, refreshed in the TUI, and marked with
  the current-session highlight. Deleting a different session leaves the
  current selection untouched.

### Added

- **Server fallback prompt.** When `.ocmux.json` points at an unreachable
  server but the default server answers, `ocmux` offers (on a TTY) to repoint
  the project to the default; confirming rewrites `server` in `.ocmux.json`.
- **`D` deletes the whole broadcast selection.** In broadcast mode,
  `D` (Shift+d) asks to delete every selected session at once — handy to drop
  a selection you no longer want to prompt — instead of removing only the
  cursor session with `d`. Confirming ends broadcast mode and adopts the row
  under the cursor as the new current; cancelling keeps the selection intact.

### Changed

- **Session-picker prompts moved to the status bar.** The `d` delete
  confirmation and the `n`/`r`/`R` name/reminder prompts now appear on the
  inverted status bar with their essential keys on the right
  (`Enter: create/rename/save · Esc: cancel`, `y: delete · n/Esc: cancel`)
  instead of a hard-to-notice line at the bottom of the list area.
- **Prompts flip the status bar to light yellow.** While a question is active
  (create/rename/reminder/delete/delete-all), the bar changes from brown to the
  same light yellow as the session-list pointer (`\x1b[30;103m`), so the change
  of state is obvious at a glance; the normal bars keep the brown background.
- **Broadcast list caps itself at one line.** The `Broadcast to sessions: …`
  info line holds up to 480 characters of names (or the terminal width,
  whichever is smaller) and truncates from the beginning (leading `...`) past
  that, so a long selection never wraps the footer and the tail stays
  readable.

## [2.1.0] - 2026-10-09

The **user-placed TUI** release. OpenCode panes can now live anywhere in tmux,
with project-dedicated and shared fallback registrations replacing the managed
`Opencode` session and one-window-per-project layout.

### Fixed

- **Registered TUI panes disappearing on session switch.** The generated
  respawn command uses `-- <directory>`, but the CLI parser incorrectly applied
  that marker to the earlier `tui` positional argument. The replacement wrapper
  exited immediately and tmux removed its pane. Forced directory arguments are
  now associated with the token immediately following `--`.

### Added

- **User-placed registered TUIs.** `ocmux tui` registers its current tmux pane
  as the dedicated TUI for the current project and runs OpenCode as a foreground
  child; `ocmux tui --shared` registers the single fallback TUI used by every
  project. Replacing a registration stops the previous wrapper without deleting
  its pane, and manually closing OpenCode unregisters the pane. Registrations
  live in a private runtime registry rather than `.ocmux.json` and use tmux
  socket + pane ID + a random pane token, so panes may be moved between tmux
  windows/sessions safely. `ocmux tui --list`, `--status`, and `--detach`
  inspect or remove runtime registrations without requiring pane destruction.
- **Dedicated → shared → headless routing.** Every ocmux session selection first
  refreshes a live project-dedicated TUI, otherwise the one shared TUI, and
  otherwise succeeds without a display. The shared pane reconnects across both
  project directories and OpenCode server URLs. `--shared` is the only shared
  registration spelling; there is no `--global` alias.
- **Model picker starts where you are.** `m` now opens the model list with the
  cursor on the session's **current model** (normal and broadcast mode), and the
  models are **sorted by provider then id** — so a broadcast change starts from
  the model already in use instead of the top of the list.
- **The project switcher is now a foldable tree.** `Space` folds/unfolds a
  project's sessions (fetched once per project, main sessions only, most recent
  first; `▸`/`▾` mark the fold state). Navigating and `/` search cover the
  sessions too, and a project header stays visible when one of its unfolded
  sessions matches the filter.
  - `Enter` on a **project row** still focuses it and shows its current session.
  - `Enter`/`Space` on a **session row** shows that session in the project's
    TUI. This is a **view selector only**: `.ocmux.json` is never written, so
    `agentp` keeps prompting the stored session.
- **The project switcher inspects by default; `--all-projects` unlocks it.**
  Selecting another project (or one of its sessions) now only moves the *view*
  — leaving the switcher always returns to the project `ocmux` was started in,
  and nothing is ever written to another project's `.ocmux.json`. Since `agentp`
  sends prompts to whatever the state file **of the directory it runs in**
  records, the default is safe and unambiguous: you can look around, but your
  own project is what `agentp` keeps targeting. The new **`--all-projects`**
  flag opts into the multi-project mode: the picker follows the switcher to the
  selected project, and a session picked there updates *that* project's
  `.ocmux.json` — the file `agentp` reads when it runs in that directory.
- **The session list says where you are.** The title bar is now
  `ocmux — <project> sessions` (basename of the project directory) instead of
  the fixed `ocmux — sessions`, so a list is never mistaken for another
  project's.

### Changed

- **No managed `Opencode` tmux session or per-project windows.** `ocmux serve`
  now initializes `.ocmux.json` and its selected session only. Project listing
  and the foldable project picker discover configured directories through
  OpenCode projects plus session locations, while `list` reports each project's
  `project`, `shared`, or `headless` display route. The old `kill` and
  `resurrect` window commands were removed.
- **Prompt submission no longer moves terminal focus.** `agentp` targets the
  project session directly through the API; display routing happens only when
  the user switches through `ocmux`.
- **One brown/light-yellow theme for the list chrome.** The title bar and the
  bottom status bar (key hints + search line) are now drawn **black on
  brown/dark-yellow** instead of reverse video; the cursor pointer `▶` is
  **light-yellow**; and the info-panel labels are **brown**, turning
  **light-yellow** when the pointed row is the session currently selected in the
  TUI (they were plain bold white before). The pointer is painted outside the
  row's own styling so it stays visible on reverse-video rows.

### Fixed

- **agentp reads durable OpenCode turn output.** Direct session sends now use
  `POST /api/experimental/session/:id/wait` and then reconstruct the answer from
  projected session messages after the admitted prompt ID, avoiding truncation
  from SSE silence gaps, long runs, missed deltas, and the previous 90-second
  safety cutoff. Older servers without the wait route fall back to polling for a
  durable idle marker.
- **SSE listeners are stricter about session scope.** Targeted listeners no
  longer finish or reset completion because another session emitted activity or
  was interrupted, and `session.text.ended` now replaces incomplete delta-built
  text in the returned answer.
- **ocmux explains moved sessions.** If the session recorded in `.ocmux.json`
  still exists but has moved to another directory, the session picker now shows
  where it moved and suggests opening that directory as its own project.
- **ocmux loads every listed session page.** Session listing now follows
  OpenCode pagination cursors instead of silently dropping sessions past the
  first page.

## [2.0.1] - 2026-10-08

The **broadcast** release. Fixes deferred/explicit broadcast delivery, hardens
broadcast-mode UX, and adds `/` incremental search to every interactive list.

### Added

- **`/` incremental search** in the session picker, the model/agent pickers and
  the project switcher. Typing filters the list live (case-insensitive,
  space-separated tokens are ANDed); the inverted bottom line becomes
  `Search: <pattern>▏` with `Enter: confirm · Esc: cancel` pinned to the right.
  `Enter` keeps the filter and returns to normal navigation, `ESC` clears it,
  `/` resumes editing it, `Backspace` on an already-empty search also exits it,
  and arrows still move through the filtered list.
- **Consistent menu exits.** `q`/`ESC` only closes the *current* menu and returns
  to the previous one everywhere except the session picker itself (which still
  quits on `q`); **`Ctrl+C` fully exits `ocmux` from any menu**, including help,
  input/confirm prompts, the broadcast mode and the project switcher.
- **`h` help overlay in every menu** — the model/agent pickers and the project
  switcher now have the same `h` help screen the session picker already had.
- **Broadcast-mode keys**: `h` opens a broadcast-specific help overlay, `d`
  deletes the cursor session (confirm) while staying in broadcast mode, and `m`
  applies one model to **all** selected sessions (usable to bulk-change models
  without sending a prompt).

### Fixed

- **Deferred broadcast was silently single-session.** `agentp --defer` resolved
  one `targetSessionId` before spawning the child, so the ticket carried only
  one session and the prompt only reached one target. Broadcast tickets now
  carry `sessionIds` (no misleading single `sessionId`) and the detached child
  receives `--resolved-session-ids`, keeping the full target list.
- **Broadcast sends now run independently and concurrently.** Each session waits
  for *its own* busy state; one rate-limited/stalled target no longer blocks the
  others. Per-session reminders are applied, and cancelling broadcast stops
  waiting without interrupting a running model.
- **Broadcast output**: `--qa` now includes the user prompt; each reply has its
  own `💬 <name> [<id>]` section (no bogus single heading); failed/incomplete
  targets are reported as a detailed sublist (name, id, error, timestamp).
  Cancelling a broadcast ticket interrupts every listed session.
- **Broadcast exit** returns the TUI to the stored session; in broadcast mode
  `ESC`/`q` now cancel back to the session list (only `Ctrl+C` quits), and
  deselecting down to a single session selects that remaining session
  (previously the menu could highlight a session the TUI was no longer on).

## [2.0.0] - 2026-10-07

The **project/session** release. OpenCode v2 only; the server is user-managed;
`ocmux` manages project TUI windows and a single source of truth (`.ocmux.json`).

> **Versioning:** from 2.0.0 on, the three tools share one version whose major
> number pairs with the targeted OpenCode major (OpenCode 2.x ⇒ this project 2.x).

### Breaking changes

- **OpenCode v1 support removed.** `lib/opencode.js` is v2-only (endpoints under
  `/api`, `{data}` envelopes, `{id,type,data}` SSE). Legacy `/tui/*` helpers and
  legacy SSE listeners are gone.
- **The server is user-managed.** `ocmux` no longer starts/stops OpenCode
  servers; run `opencode serve` yourself. `ocmux serve` only creates a TUI
  window (and health-checks the server). `ocmux kill` closes the window and keeps
  `.ocmux.json`.
- **`.ocmux.json` v2 schema:** `{ version, directory, session, server, annotations }`.
  Old files are read for back-compat (`url` → `server`, directory from location);
  `ocmux migrate` rewrites them.
- **Removed subcommands/flags:** `ocmux switch` (use `p` in the picker),
  `ocmux model` (use `m`), `--print-logs`, `--last`. `agentp` positional URL is
  kept; add `--server <url>`.
- **agentp no longer needs `$(ocmux)`.** It resolves the server, project
  directory and target session from the nearest `.ocmux.json`.

### New Features

- **Project/session model.** `agentp` reads the nearest `.ocmux.json` for the
  server URL, the project directory (used to scope session listings) and the
  stored session; `--session`/`--new` still override. `--getLast` is scoped too.
- **`ocmux` interactive session picker** (per project): `Enter` switches (stays
  open), `n` creates (name input; inherits the previous session's model),
  `r` renames **in place** (readline-style caret editing), `R` sets a per-session
  **reminder**, `d` deletes (confirm), `a` switches the agent (primary agents
  only), `m` switches the model, `p` opens the project switcher, `h` help,
  `q` quit. Sessions are listed most-recently-viewed first with a last-view
  **time column**, an **animated spinner** for running sessions, a centered
  inverted heading, and a scrollable, **resize-aware** viewport.
- **Info footer** under the inverted key-hint bar: title, location and a
  responsive grid (model, agent, `BUSY`/`IDLE` + time in status, tokens, cost,
  context limit, outcome).
- **Per-session reminders.** Stored in `.ocmux.json` (`annotations`); `agentp`
  prepends a session's reminder to every prompt sent to it.
- **agentp `--qa` header** — prints `📂 <project dir>` and `💬 <title> [<id>]`
  (fresh sends and ticket retrievals).
- **Cancellable deferred tickets.** Tickets now carry `cancelled: false`; flip
  it to `true` and pipe the ticket back to interrupt the prompt
  (`POST /api/session/:id/interrupt`, the `ESC` equivalent), discard the ticket
  and print a confirmation.
- **agentp focuses the target project's TUI window** before sending, so the
  prompt streams in view even when the window/session differed.
- **agentp `--server <url>`** and **`ocmux serve --server <url> --force`** to
  point at a different (possibly remote/containerized) server.
- New `lib/opencode.js` helpers: `createSessionWithModel`, `deleteSession`,
  `interruptSession`, `getActiveSessions`, `sortSessionsByRecency`.
- New `lib/project-state.js` with atomic `.ocmux.json` read/write.

### Bug Fixes

- **Empty answers from API-created sessions** — v2 sessions created via the API
  have **no model** and will not execute a prompt until one is set;
  `createSessionWithModel` inherits from a reference session / the server default.
- **Rename applied server-side but not refreshed** — v2 returns `204` on the
  title `PATCH`; `updateSession` now accepts it and re-reads the session.
- **Duplicate `--qa` header** — the detached child already embeds the header, so
  retrieval no longer prepends a second copy.
- **Truncated long answers (improved).** `listenV2` defers completion on ANY
  stream activity (including sub-agent/child-session events) and verifies the
  session idle marker; the quiescence window is now 15s, tunable via
  `AGENTP_COMPLETION_GRACE_MS`. A fully-silent gap longer than the window can
  still truncate — see `docs/specification_v2.md` §13.3 for the planned fix.
- Per-step assistant text segments are separated by a blank line.
- `ocmux kill` now matches the window by name (not the stale `window_index`).
- `ocmux` menus no longer overflow the terminal (scrollable, resize-aware).

## [1.14.0] - 2026-10-02

### New Features

- **`ocmux model [ref]`** — switch the model of the newest session on the current project's server
  - With no `ref`: interactive model picker (arrow/`j`/`k`, Enter to switch; TTY required)
  - With `ref`: switch directly; `ref` accepts full (`providerID/modelID`), partial, and `#variant` forms, and matches case- and separator-insensitively against the canonical label, the bare id, and the friendly display name (e.g. `"Kimi K2"`, `"Deep Seek"`); multiple matches open the picker (or error with the candidates when not a TTY)
  - On success prints the server URL on stdout, so `agentp $(ocmux model <ref>)` switches the model before the next prompt — no TUI dummy prompt needed
  - Backed by new `lib/opencode.js` helpers: `listModels` (v2 `GET /api/model`, legacy from providers), `switchModel` (v2 `POST /api/session/:id/model`, legacy `PATCH`), `parseModelRef`, `resolveModelRef`; v2-only behavior degrades gracefully on older servers

### Changed

- **agentp / tgagentp now support OpenCode v2 servers** — the v2 HTTP API broke the legacy protocol in three ways: endpoints moved under `/api`, responses are wrapped in a `{data}` envelope, and the SSE event schema changed from `{type, properties}` to `{id, type, data}` (text streams via `session.text.delta`, completion via `session.execution.succeeded|failed|interrupted`). `lib/opencode.js` now auto-detects v2 (one `GET /api/info` probe per server, cached) and speaks both protocols:
  - v2: `listSessions`/`createSession` unwrap `{data}`; `sendToSession` attaches to the event stream first, then posts to `/session/{id}/prompt` and returns the streamed answer; `updateSession` routes agent/model through the dedicated `/agent` and `/model` endpoints; `respondToPermission` uses `/session/{id}/permission/{requestID}/reply` with the v2 `decision` enum; async delivery uses `delivery: "queue"`; `respondToQuestion` uses the form reply endpoint; TUI navigation (`selectSession`) is a no-op on v2 (no HTTP equivalent)
  - legacy (0.x/1.x) code paths are untouched — servers running older OpenCode behave exactly as before
  - `sendText` on v2 delivers to the active session (no `/tui/*` endpoints exist)
  - Added `detectV2`, `apiBase`, `parseBody`, `listenV2` exports; `_setApiVersion`/`_resetApiCache` test hooks
- Updated test count in `AGENTS.md` (now 255 tests: 53 + 8 + 50 + 93 + 12 + 22 + 17)

### Bug Fixes

- **`ocmux` broken with OpenCode v2** — starting a new server+TUI window failed after updating OpenCode
  - `opencode serve` now prints `server listening on http://...` (the `opencode ` prefix is gone); the URL regex now accepts both formats
  - OpenCode v2 removed the `attach` subcommand; the TUI is started with `opencode --server <url> --continue` on v2 while older versions keep using `opencode attach --continue <url>` (detected via `opencode --version`, with legacy fallback when undetectable)
  - Servers started with `opencode serve` now require HTTP Basic auth; with `OPENCODE_SERVER_PASSWORD` exported, the serve/TUI panes inherit it and no extra handling is needed
- **agentp failed to connect to OpenCode v2 servers** with `Unexpected token '<' ... is not valid JSON` because v2 serves the web UI (HTML) at the legacy API paths — resolved by the v2 protocol support above

## [1.13.0] - 2026-08-12

### Changed

- **`agentp --defer` refinement** — new `agentp_ticket` format, optional timeout, pretty printing, and follow-up prompt support
  - `--defer [N]` now accepts an optional numeric timeout in seconds (default `0`): wait up to N seconds for the answer and print it if it arrives in time; otherwise return a ticket immediately
  - New ticket format: `agentp_ticket` + JSON `{ctime, path, server, sessionId, elapsed, defer}` (replaces the old `<agentp-deferred>path</agentp-deferred>` marker)
  - Tickets are printed as pretty-printed (multi-line) JSON for easier reading/editing; `--onlineTicket` prints the same ticket on a single line (both formats are accepted when piping a ticket back)
  - `ctime` tracks creation time; `elapsed` is only printed on re-submission (0 when `ctime` is missing/unparseable)
  - `defer` is printed only when the submission timeout was > 0
  - Re-submitting a ticket ignores the CLI `--defer` value and uses the ticket's own `defer`; a ready answer is returned and the temp file removed; otherwise the ticket is re-printed with updated `elapsed`
  - A ticket followed by additional text queues that text into the original running session via OpenCode's async prompt endpoint when the deferred answer is not ready yet
  - Queued deferred follow-ups are stored with the ticket and injected into the final `--qa` prompt block under `📝` separators when the answer is retrieved; interim ticket output does not echo them
  - If the answer is already ready, appended text is not sent to OpenCode and is printed after the returned answer so it can be edited/re-submitted

### New Features

- **`ocmux switch`** — interactive session picker
  - Shows all running servers in an interactive menu (alt screen, TTY required) with columns `dirname | status | url | full path`
  - `j`/`k` or arrow keys move the cursor; `Enter`/`Space` switches to the selected server's tmux window while keeping the menu open; `q`/`Ctrl+C` exits
  - The row matching the tmux-active window is highlighted across the full line width; it is re-queried from tmux on every redraw, so the highlight tracks both menu activations and external window switches
  - Prints the URL of the last selected server on exit
  - Errors (exit 1) when no TTY or no servers
- **`ocmux` command-substitution safety** — default no-server lookup now prints the primary error line to stdout, so `agentp $(ocmux)` fails safely instead of falling back to `agentp`'s default server when no project server exists

### Bug Fixes

- **Broken non-deferred runs:** `tgError is not defined` (a scoping regression from the deferred-execution refactor) broke every run without `--defer`; error messages were also incorrectly written to stdout instead of stderr. Both fixed in `bin/agentp`.
- **Stale test expectation:** `tests/agentp.test.js` hardcoded version `0.12.0`; now reads `package.json` version.
- **Flaky `npm test`:** the agentp test harness forwarded captured stdout writes to the real stdout, which could interleave with the test runner's own stdout framing under parallel load and corrupt its IPC parse (`Unable to deserialize cloned data...`, ~1/3 of `npm test` runs). Captured stdout is now swallowed, making the suite deterministic.

### Documentation

- README: `--defer [N]` usage, `agentp_ticket` format, deferred follow-ups, `$(ocmux)` URL hint, command-substitution safety, `ocmux switch`, and `--defer --tg` as the supported pattern for Telegram notifications from deferred jobs
- `docs/specification.md`: `--defer [N]` behavior, ticket format, `ocmux switch` behavior
- Updated `--help` text in `bin/agentp` and `bin/ocmux`

## [1.12.1] - 2026-08-03

### New Features

- **`agentp --defer`** — Deferred execution mode for non-blocking prompt execution
  - Submit a prompt and get an immediate ticket (`<agentp-deferred>path</agentp-deferred>`)
  - Continue working while the agent processes in the background
  - Retrieve the result later by piping the ticket back to `agentp --defer`
  - Identity filter when still processing (returns input unchanged)
  - Works with all existing flags (`--qa`, `--tg`, `--session`, `--flush`, etc.)
  - Works as a Vim/Neovim filter for non-blocking editor integration

### Bug Fixes

- **Deferred execution reliability:** Fixed race condition where empty output files were treated as ready
  - Empty output files now treated as "still processing" (identity filter)
  - Proper error handling in child process: errors written to output file and lock released
  - Lock file cleanup on errors to prevent stale locks

### Documentation

- Updated README with `--defer` usage examples and Author's note clarifying stability levels
- Updated help text and command reference

## [0.12.0-pre01] - 2026-06-30

### Breaking Changes

The Telegram command API now follows a consistent pattern: **singular for switching/acting, plural for listing/querying**.

| Plural (list) | Singular (switch) |
|---|---|
| `/servers` | `/server <name>` |
| `/sessions` | `/session <name>` |
| `/agents` | `/agent <name>` |
| `/models` | `/model <name>` (already in 0.11.11) |

**Migrations:**
- `/servers switch <name>` → `/server <name>` (or `/server --force <name>` for force-switch)
- `/sessions switch <name>` → `/session <name>` or `/session new [name]` or `/session rename <name>`
- `/agents switch <name>` → `/agent <name>`
- `/force-switch <name>` → `/server --force <name>`

Old subcommand syntax still works via backward-compatible redirects. `/force-switch` removed.

### New Commands

- **`/server <name>`** — switch to a server (replaces `/servers switch <name>`). Add `--force` to take over from another chat.
- **`/session <name-or-number>`** — switch to a session by name or position (replaces `/sessions switch <name>`). Subcommands: `new [name]`, `rename <name>`.
- **`/agent <name>`** — switch the active agent (replaces `/agents switch <name>`).

### Bug Fixes

- **`/resurrect` killing the wrong window:** `resurrectServer` now checks the `kill-window` return value and throws on failure. Also skips kill when the stored window index doesn't match the directory and no window is found for it — preventing accidental kills of unrelated project servers.
- **Port collision after resurrect:** `startServer` now captures the new tmux window index from `new-window -P` output directly, instead of calling `windowByDir()` which could return a stale old-window index if the old window wasn't properly killed. This prevented two windows from sharing the same `.ocmux.json` (same URL/port in `/servers` list).
- **Verification loop:** After killing the old window, `resurrectServer` waits up to 2 seconds for it to actually disappear before starting the new server.

### Improvements

- `/help server`, `/help agent`, `/help session` — dedicated help topics for all new singular commands.
- Main `/help` screen updated with all new commands, old aliases removed.

### Changed

- `cmdForceSwitch` removed (replaced by `cmdServer` with `--force` flag).
- All `/help X` topics updated to reference new commands.

## [0.11.11] - 2026-06-30

### New Commands

- **`/model <providerID/modelID>`** — switch the active session model from Telegram. Resolves partial provider names (e.g. `go` → `opencode-go`). Uses `POST /session/:id/prompt_async` with `model` + `noReply: true` — fires the internal `ModelSwitchedEvent` to persist the change on the server.
- **`/shutdown <exitCode>`** — accept optional numeric exit code (default 0) for use in `while cmd ; do ... ; done` loops.

### Improvements

- **Persistent per-session SSE monitor:** A long-lived SSE listener (`startSessionMonitor`) now catches `question.asked`, `permission_asked`, `permission_replied` events from any source (tgagentp, `agentp --tg`, TUI). Previously only tgagentp's own prompts forwarded these events.
- **`/models` rewrite:**
  - Provider list with model counts per provider
  - Drill-down: `/models <provider>` lists all models for that provider
  - Current model marked with ▶ (detected from `listSessions()` → session model, with fallback to agent's explicit model)
  - Model info: context limit, input/output costs in parentheses
  - Uses `listSessions()` for detection instead of `GET /session/{id}` (faster, auth-compatible)
- **Startup stale-update drain** — skips stale Telegram updates from previous sessions at startup.
- **`/help model`** topic — documents the new `/model` command.

### Bug Fixes

- **Session model field detection:** The API returns `{ providerID, id }` not `{ providerID, modelID }` on session objects. Fixed `cmdModels` to use `m.modelID || m.id`.
- **Auto-discovery on demand:** `cmdModels` and `cmdModel` auto-discover the active session when `activeSessionId` is null, fixing "No active session" after connection restoration.

### Changed

- `sendToSessionAsync()` accepts optional `model` and `noReply` parameters.

## [0.11.10] - 2026-06-27

### Bug Fixes

- **Symlink path resolution:** `windowByDir()` in `lib/ocmux.js` now compares both the search directory and tmux window names via `fs.realpathSync()`. This fixes "tmux window not found" errors when the current directory is accessed through a symlink (`process.cwd()` returns realpath, tmux stores the symlink path).
- **Stale `.ocmux.json` fallback:** When `ocmux` (default mode) finds a state file whose tmux window no longer exists, it now skips it and searches the parent directory for a valid server. This prevents stale child `.ocmux.json` files (from resurrect bugs, deleted windows, etc.) from blocking access to working parent servers.
- **New server window naming:** `doNew()`, `startServer()`, and `resurrectServer()` now normalize the target directory with `fs.realpathSync()` before creating the tmux window, ensuring consistent naming regardless of how the user navigated to the directory.

### Documentation

- **Model/agent switching:** README now documents `/agents list` and `/agents switch <name>` commands, and explains why TUI model dropdown changes don't propagate to agentp/tgagentp prompts.

## [0.11.9] - 2026-06-21

### New Features

- **`[Telegram]{...}` agent protocol:** Structured commands in agent responses for file sharing and help. Replaces the old `telegram-shared/` mailbox and `POST /send-file` HTTP endpoint. Commands: `upload` (agent sends file to Telegram), `download` (agent pulls file from Telegram), `help` (agent requests documentation, response sent back to session).
- **Auto-greeting:** tgagentp now sends an awareness note to the session on server connect and session change, informing the agent about the available `[Telegram]{...}` commands. Includes the current session name.
- **`/markdown` command:** Send the original markdown of the most recent response as a `.md` file. Reply to any message to get the markdown that generated that specific response (works even if split into multiple Telegram messages). Entirely in-memory — no disk I/O.

### Bug Fixes

- **State key normalization:** `getState()` now normalizes URL keys (trailing slashes, `127.0.0.1` vs `localhost`), preventing session state from being silently lost when URLs differ in format.
- **Session switch fix:** `setActiveSessionForChat` was being called with `chatId` (number) instead of `chatState` (object), causing session state to be written to a phantom numeric key.
- **Session filtering:** `/sessions` now only shows primary-agent sessions (not subagent sessions), matching what appears in the TUI.
- **Greeting improvements:** Help command responses now go to the session (agent sees them), not inline in the user-visible response. Greeting text clarified to prevent agents from using CLI tools to fulfill commands.
- **Download-on-reply:** When replying to a file message, the fileId is now sent to both the user's Telegram chat and the agent's session (previously only the user saw it).
- **Thinking buffer leak:** Post-response thinking flush now checks `thinkingEnabled`, preventing thinking messages from being sent when disabled.

### Changed

- **`sendLongMessage` returns message IDs:** Enables `/markdown` to look up original responses by replied-to message.
- **No more `telegram-shared/` auto-saving:** Uploaded files are no longer auto-saved to disk; tgagentp sends fileId to the agent, which can pull files on demand via the `download` command.
- **`ocmux --port 0` removed:** Was redundant with opencode's default. Removed from both `bin/ocmux` and `lib/ocmux.js`.
- **Server state machine:** New `serverStatus()`, `listDeadServers()`, `startServer()` in `lib/ocmux.js`. `/servers` now shows dead servers (💀). `/serve` detects dead `.ocmux.json` and suggests `/resurrect`. Dead-server messages now suggest `/resurrect` instead of `ocmux serve`.
- **`/resurrect` improvements:** Now accepts optional directory argument (`/resurrect <path>`). Was previously blocked by the disconnected command guard.

## [0.11.7] - 2026-06-13

### New Features

- **`/serve` and `/new` commands:** Remote project management via Telegram. `/serve <path>` starts a server in an existing directory under `TGAGENTP_ROOT`. `/new <path>` creates a directory, initializes git, and starts a server. Both commands auto-connect the chat to the new server.
- **`TGAGENTP_ROOT` validation:** Validated at startup; if missing or invalid, `/serve` and `/new` are gracefully disabled (no crash). `/help` shows an enablement hint.
- **`/think` immediate effect:** Thinking text always buffered in server state; toggling `/think on` during a request flushes any already-received thinking immediately.

### Bug Fixes

- **`tests/agentp.test.js` fixed:** Direct mocking of `process.stdout.write` broke `node:test`'s suite detection. Switched to `Writable` stream via `Object.defineProperty`.

## [0.11.6] - 2026-06-11

### New Features

- **Download on reply:** Reply to a previously sent file in Telegram to automatically download it to the repository. The bot detects the reply to a file message, downloads the file, and saves it to the project directory.
- **`!!` wildcard:** Use `!!` in any command to reference the previous user message. For example: `/queue !!` queues the previous message, `/note !!` sends it as a note. The wildcard is resolved before command processing, so it works with all commands.

## [0.11.5] - 2026-06-11

### Bug Fixes

- **Permission requests:** Fix bug where only the first permission request in a processing iteration was forwarded to Telegram. Subsequent permission requests were silently dropped because the SSE listener was destroyed immediately after `sendToSession` returned, before the session had finished processing. The listener is now kept alive until the session goes idle (or the 90-second safety timeout), matching the TUI behavior.
- **`/note` queue:** `/note` now queues the message when the server is busy, instead of rejecting it with "Server is busy". Previously, only unreachable servers queued notes; busy servers rejected them. Now notes are queued consistently with regular messages.
- **Telegram read receipts in groups:** Documented as a known Telegram API limitation. Bots cannot send read receipts, and in supergroups the second tick (delivery to all members) may not appear even though the bot is receiving messages.

### Code Quality

- **Extracted Telegram modules:** `lib/telegram-api.js` (5 functions) and `lib/telegram-format.js` (3 functions) extracted from `bin/tgagentp` (235 lines removed). Both modules have full test coverage (12 + 17 tests).
- **CLI tests:** `tests/agentp.test.js` with 24 tests covering argument parsing, session selection, output formatting, and gateway integration. All 137 tests pass.

## [0.11.4] - 2026-06-11

### New Features

- `agentp --session <name>` — target a specific session by exact or partial name match.
- `agentp --new` — create a new session with the given title (requires `--session`).

### Bug Fixes

- Fix session detection after TUI `/new`: use `time.created` as fallback when `time.updated` is missing (newly created sessions with no messages yet have `time.updated === 0`). Previously `agentp` would filter these out and create a new "agentp" session instead of using the TUI's active session.

## [0.11.3] - 2026-06-11

### File Sharing (New Feature)

- Upload files from Telegram to `telegram-shared/uploads/` — auto-creates directory, adds to `.gitignore`, sends notification to agent respecting busy/idle queue.
- Download files via `POST /send-file` gateway endpoint — agent writes to `telegram-shared/downloads/`, tgagentp sends via Telegram `sendDocument` (multipart/form-data) and cleans up.
- New `lib/file-share.js` module with `ensureSharedDir`, `saveUploadedFile`, `formatFileSize` helpers.
- 8 tests for file-share module (directory creation, .gitignore, filename sanitization, size formatting).

### Bug Fixes

- Fix file download endpoint variable shadowing (`serverDir` function shadowed by `const serverDir`), causing all file sends to fail with "file not found".
- Fix dangerous file cleanup: only delete files from `telegram-shared/downloads/` after sending, preventing accidental deletion of project files.
- Fix race condition on upload: add `fsyncSync` after `writeFileSync` and retry loop (5 retries × 100ms) to verify file exists before notifying agent.
- Fix `/servers` list: normalize `serverOwners` URLs when checking ownership (handles `127.0.0.1` vs `localhost` mismatch), so connected servers correctly show `·` instead of `🔌`.

### UI Improvements

- `/servers` list: `🔌` for disconnected servers, `·` for connected to other chat, `▶` for your server.
- `/sessions` list: `🔌` for inactive sessions, `▶` for active session (consistency with `/servers`).

## [0.11.2] - 2026-06-10

- `//command` raw TUI passthrough for Opencode TUI-level commands (`//init`, `//doctor`, etc.). Strips first `/` from `//cmd`, appends trailing space to select the as-you-type menu, sends via tmux `send-keys`. SSE listener catches AI responses (15s timeout); forwards answer to Telegram or sends confirmation.
- `/answer` command to respond to structured questions from the AI (multiple-choice via `question.asked` SSE event). Forwards question with numbered options to Telegram; `POST /session/:id/questions/:id` on response.

## [0.11.1] - 2026-06-09

- Auto-switch tmux window to the active chat's server on every non-command message and `/note`, matching the behavior of direct `agentp` usage. Both the main message dispatch and `/note` handler now call `activateServer()` before processing, so the TUI follows the conversation across topics and chats.

## [0.11.0] - 2026-06-09

### Important Fixes

- `/status`, `/cancel`, `/shutdown` no longer crash with `null.replace` when used from Telegram topic threads (`getChatState` without `threadId` creates wrong state entry with `serverBase: null`).
- Stale SSE listener leak: `processMessageAsync` now destroys previous `_cancelRef`/`_sessionReq` before overwriting them, preventing forwarding of session events to stale chats.
- Agentp gateway: fix `flushRecorded()` call passing wrong argument type (`owningChatId` object instead of destructured `chatId`/`threadId`).
- Agentp gateway: restore `serverOwners` after restart by populating from `STARTUP_CHAT_FILE` on first message.
- Fix SSE log lines in `listenForSessionEvents` missing timestamps — added optional `logFn` parameter.
- Fix `isServerAlive()` not exported from shared lib — extracted from `bin/tgagentp` into `lib/opencode.js` with test coverage.

### New Commands

- `/disconnect` — clears `serverBase`, removes ownership, deletes connection from file.
- `/note` — forwards message to agent prepended with awareness paragraph ("reply with only 'Ack', do not take action").
- `/comment` — renamed from `/note`, stays as no-op (message stays in chat, not forwarded).
- `/flush` — clears both message queue and agentp gateway queue.
- `/force-switch` (top-level + `/servers force-switch`) — two-phase matching, bypasses ownership check.
- `/resurrect` (tgagentp) — invokes `resurrectServer()` from library, transfers session state to new server URL.

### Server Health & Queue

- Pre-send health check via `isServerAlive()` (5s timeout `GET /session`): auto-queues messages when server unreachable.
- Connection error detection in `processMessageAsync` catch: marks `serverDead`, requeues failed message.
- Queue drain in `finally` skips processing when `serverDead` (prevents infinite loop).
- `/status` shows `❌ unreachable` when server is dead.

### Startup & Ownership

- Startup pruning (Phase 2): only one chat per URL survives on restart; non-thread chats prioritized over topics.
- Connection persistence in `/tmp/tgagentp-connections.json` with health check before restore message.
- Stale `serverOwners` entries cleared when switching away from a server.
- Group migration handler (`migrate_to_chat_id`/`migrate_from_chat_id`) — auto-updates connections + allowlist when topics enabled.

### Session & Discovery

- `/record N` retrofill from ring buffer, `/record pause [N]`, `/record continue`, `/record flush`, `/record stop`.
- Always-on ring buffer (50 msgs) with state transitions (active/paused/inactive).
- agentp `--getLast n`: retrieve last n QA pairs from session history (user prompts + assistant answers), formatted with rulers.
- `/sessions new [name]` — create session, TUI follows via `/session/:id/select`.
- `/sessions rename <name>` — rename current active session.
- Case-insensitive matching for all switch subcommands (`/servers`, `/sessions`, `/agents`).
- Discover TUI session on startup and server switch via `discoverActiveSession()`.

### Testing (Phase 1a+1b)

- `tests/opencode.test.js`: 62 tests for `lib/opencode.js` API functions — URL/method/headers, parse responses, error handling, all `http.request` mocked.
- `tests/ocmux.test.js`: 35 tests for `lib/ocmux.js` — `readState`, `statefileFor`, `hashDir`, `tuiPaneId`, `windowByDir`, `listServers`, `activateServer`, `resurrectServer`, all `spawnSync`/`execSync`/`fs` mocked.
- `CONTRIBUTING.md` created with dev setup, coding standards, test architecture, PR process.
- `npm test` configured to run `node --test tests/*.test.js`.

### Infrastructure

- `ocmux resurrect` command + `lib/ocmux.js` `resurrectServer()` function — recovers dead/crashed servers by re-creating window + TUI.
- `--dev` mode in tgagentp: structured message traffic log to `/tmp/tgagentp-msg.log` (JSON lines with timestamps, chat IDs, direction).
- `isServerAlive()` extracted to shared `lib/opencode.js`.

## [0.10.0] - 2026-06-04

- `/queue` command: queue messages when server is busy, auto-sent after current task finishes, preserves replyTo chain.
- `/record` command with ring buffer (100 msgs / 100KB), `/record stop` to clear; gateway returns `{ buffered }` JSON.
- agentp `--flush`: flush tgagentp's recorded buffer without prepending to stdout.
- agentp `--getLast n`: retrieve last n assistant answers from session history.
- agentp `--qa` prepends recorded Telegram context (with rulers) to stdout.
- `getSession()` in lib/opencode: `GET /session/:id` with fallback to session list.
- `makeRequest` optional timeout parameter (used only for getSession; all other calls wait indefinitely).
- Minimum 3-backtick code fence for reply quoting.

## [0.9.0] - 2026-06-04

- agentp `--tg`/`--no-tg` flags: gateway forwards answer to Telegram; auto mode silently degrades.
- Agentp resilience: 5s HTTP timeout, pre-send gate check, post-send warning.
- Full `--qa` output (rulers + prompt + answer) forwarded to Telegram.
- Rulers changed from `—` to `─`, shortened to 17 chars.

## [0.8.0] - 2026-06-03

- Fix `/servers` crash: `serverBase is not defined` error.
- Logging rebalance: stdout for info, stderr for errors/debug with `--verbose` flag (`2>/dev/null` for clean console).
- `/shutdown force`: refuse shutdown when busy unless `force` flag given.
- `/think [on|off|switch]`: toggle real-time forwarding of model thinking messages; `--think` CLI flag.
- Reply quoting: when replying to a Telegram message, prepend quoted text with safe backtick fencing.
- Reply chaining: answers use `reply_to_message_id` to appear as replies.
- TUI navigation: `POST /tui/select-session` tried first (works in opencode 1.15.13).

## [0.1.0] - 2026-05-08

- Initial release.
- Add project documentation and usage examples.
