# agentp v2 — Project/Session Model Specification

Status: **Draft for review** · Target version: 1.16.0 · Supersedes the state/session
model described in `docs/specification.md`.

---

## 1. Motivation

OpenCode v2 changed the runtime model in ways that invalidate the original
per-project-server design:

- A single OpenCode **data store** (`~/.local/share/opencode/opencode.db`) holds
  *all* sessions for *all* projects. Sessions carry `location.directory` +
  `projectID`.
- Any server process can list/create/operate sessions in **any** location:
  `GET /api/session?directory=…`, `POST /api/session` with `location`,
  `POST /api/session/:id/move`.
- `GET /api/session` **without** a `directory` filter returns sessions from
  **every** project known to the store (verified live: all three running
  servers returned the same 50 sessions; scoped queries returned 11 / 2 / 50).

Consequence: the server URL **no longer identifies a project**, so
`agentp $(ocmux)` intermittently routes prompts to the wrong project's session
(response renders in the wrong TUI window). The project directory is the correct
routing key; the session ID is the correct target.

The v2 model keeps things simple and predictable:

> **A project is a directory. A target is a session in that directory.
> `agentp` reads both from the nearest `.ocmux.json`.**

---

## 2. Design summary

| Concern | v1 (current) | v2 (this spec) |
|---|---|---|
| Server | one per project | **user-started; tool only health-checks it** (see §11.1) |
| tmux window | server pane + TUI pane | **TUI only** (pane 0) |
| Project key | server URL / tmux window name | **directory** |
| Target | newest session globally | **session ID stored in `.ocmux.json`** |
| `ocmux` (no args) | switch to project server, print URL | interactive **session** picker for current project |
| `ocmux switch` | interactive session picker | interactive **project** (TUI window) picker |
| `agentp $(ocmux)` | required | **not needed** (kept as override only) |
| `.ocmux.json` | `{url, logfile, window_index}` | `{version, directory, session, server?}` |

### 2.1 Guiding principles

1. **`.ocmux.json` is the single source of truth** for a project's directory and
   selected session.
2. **One shared server per profile.** Profile = OpenCode binary + data dir, so a
   work install and a home/dev install can coexist on separate servers.
3. **`ocmux switch` is read-only** with respect to `.ocmux.json` — it is a
   visual/navigation tool for moving between project TUI windows.
4. **Session switching always keeps the TUI in sync** by relaunching it on the
   chosen session (`opencode --server <url> --session <id>`).
5. **`agentp` works without command substitution**; it resolves everything from
   the working directory upward.

---

## 3. `.ocmux.json` — new schema

Placed at the **project root** (found by upward search, git-like).

```json
{
  "version": 2,
  "directory": "/home/user/projects/myapp",
  "session": "ses_1bd64adb1ffe4zekSiy9oRoJAN",
  "server": "http://127.0.0.1:4097"
}
```

| Field | Required | Meaning |
|---|---|---|
| `version` | yes (written) | Schema version; absent/`1` ⇒ legacy file. |
| `directory` | yes (written) | Absolute, realpath'd project root. Guard against file moves: if `realpath(dirname(file)) !== directory`, warn and repair. |
| `session` | yes (written) | OpenCode session ID to target. May be absent until first `ocmux serve`/`agentp` run. |
| `server` | no | Cached shared-server URL. **Not authoritative** — the global server state wins. Kept for self-containment/offline diagnostics. |

**Legacy tolerance (read):** old files `{url, logfile, window_index}` must still
parse. On read:

- `directory` ← dirname of the file.
- `server` ← legacy `url` (or the global state).
- `session` ← resolved on demand (newest scoped to `directory`, preferring the
  session the TUI last viewed).

**Atomic writes:** write `.<name>.tmp` then `rename()`; never partial-write.
One writer at a time is the norm (ocmux); agentp may bootstrap-write only when it
created the session.

### 3.1 Global server state — REMOVED

Per §11.1, the server is user-managed and out of scope. There is **no** managed
global server state file and **no** `ensureServer()`. Each project records the
server URL it uses in its own `.ocmux.json.server` (or relies on the default /
`OPENCODE_SERVER_URL`).

### 3.2 Server resolution precedence (check-only)

1. `--server` / positional URL argument (back-compat with `agentp $(ocmux)`).
2. `$OPENCODE_SERVER_URL` (optional convenience).
3. `.ocmux.json.server` (or legacy `url`).
4. `http://localhost:4096` (legacy default).

The resolved server is **health-checked** (`GET /api/info`); on failure the tool
exits 1 with a hint to start `opencode serve`. It is never started or managed.

### 3.3 Directory resolution (project)

1. `--directory <path>`.
2. Directory of the nearest `.ocmux.json`, searching upward from `cwd`.
3. `fs.realpathSync(cwd)`.

### 3.4 Session resolution (target)

1. `--session <id|name>` or `--new <name>` (explicit override; not persisted).
2. `.ocmux.json.session`, **if it still exists on the server** (validated).
3. Newest session **scoped to `directory`**, preferring max `time.viewed`,
   tie-broken by `time.updated`.
4. Create a new session in `directory` (`location`). **agentp never writes
   `.ocmux.json`** — session persistence belongs to `ocmux`; agentp only records
   the resolved session in the deferred ticket (which already carries it).

---

## 4. New behavior — `ocmux`

### 4.1 Command surface

| Command | Behavior | Writes `.ocmux.json`? |
|---|---|---|
| `ocmux` | Ensure project window (server health-checked); **interactive session picker** for the current project; switch TUI to the chosen session. Silent on success. | **Yes** (`session`) |
| `ocmux switch` | **Interactive project picker** across all project TUI windows; focus windows. Purely visual/navigation. | **No** |
| `ocmux serve [dir]` | Create/open the project TUI window; create state file and pick/create a session. No picker. Health-checks the server. | **Yes** |
| `ocmux session <id\|name>` | Non-interactive session switch for the current project (scripts/agentp-adjacent). | **Yes** |
| `ocmux list [-l]` | List projects (windows) with their selected session and status. | No |
| `ocmux model [ref]` | Switch the model of the **selected session** of the current project (no more URL-printing contract). | No |
| `ocmux kill <dir>` | Close the project's TUI window **but keep `.ocmux.json`** (mark `status: "stopped"`). | updates |
| `ocmux resurrect [dir]` | Recreate a project TUI window (kept as an alias for recovery). | maybe |

There is **no `ocmux down`/`up`** — the server is user-managed (§11.1).

Retained flags: `--git`, `--GIT`, `-l`, `--print-logs`, `--version`, `-h`.
`serve` aliases: `new` (deprecated).

### 4.2 `ocmux` (no arguments) — session picker

1. Resolve project dir via upward `.ocmux.json` search (error with a clear hint
   if none — run `ocmux serve`).
2. Health-check the server recorded in `.ocmux.json` (complain if down).
3. Ensure the project TUI window exists; if it is not showing
   `state.session`, relaunch it (see §5).
4. If `stdin.isTTY`: open an alt-screen picker listing sessions
   `GET /api/session?directory=<dir>`, **most recently viewed first**:
   - rows: `title | age (by viewed) | current(*)`, cursor on the current session
   - `Enter`/`Space` switches to the row but **stays open**; `n` creates (name
     input, blank = auto-title); `r` renames; `d` deletes (y/N); `h` toggles
     help; `q`/`Ctrl+C` quits
   - a fixed bottom bar shows the key hints
   - On select/create: atomic write of `session`, relaunch TUI, keep window
     focused.
5. If **not** a TTY: focus the window and print the selected session ID on
   stdout (non-interactive).

Output contract: prints the chosen session ID on stdout at the end (no longer a
URL). `agentp` does not depend on this.

### 4.3 `ocmux switch` — project picker (read-only)

- Lists every tmux window in the `Opencode` session that has a `.ocmux.json`
  (project windows), plus their selected session.
- Highlights the tmux-active window (live `activeWindowIndex()`).
- `Enter`/`Space` focuses a window and keeps the menu open; `q` quits.
- **Must never write `.ocmux.json`.** The dead-TUI restart path may *read* the
  state file, but only to know which session to relaunch with.

### 4.4 Window layout (shared-server model)

```
tmux session: Opencode
├── window "__server__"        (optional; server log view)  ← excluded from switch/list
├── window /home/user/proj-a   pane 0: TUI (opencode --server <url> --session <id>)
└── window /home/user/proj-b   pane 0: TUI (opencode --server <url> --session <id>)
```

- Project windows contain **only the TUI** (pane 0). The old "pane 0 = server,
  pane 1+ = TUI" assumption is dropped (see §6.4 for the transition shim).
- The server runs detached (or in the `__server__`/`opencode service`), logging to
  `agentp-server-<profileHash>.log`.

---

## 5. TUI session switching

OpenCode v2 exposes **no reachable HTTP endpoint to steer a TUI** (verified:
`/tui/*` is not a v2 namespace; `tui.session.select` exists as a client event
but has no public emitter). Therefore switching is done by **relaunching the TUI
process**:

```
tmux respawn-pane -k -t <tuiPane> "opencode --server '<url>' --session '<id>'"
```

- If the pane is missing: `split-window`/`new-window` with `cwd = directory`,
  then zoom.
- **Validate the session exists first** (`getSession`). `--session` *creates* the
  session if the ID is unknown, which we do not want for a stale state file.
- While the previous session's execution keeps running server-side, the relaunch
  only detaches the *view*; note this in docs.
- If OpenCode ever ships a TUI-steering endpoint, prefer publishing
  `tui.session.select` (directory-scoped) and keep the relaunch as fallback.

---

## 6. Changes to the codebase

### 6.1 `lib/opencode.js`

- `listSessions(server, directory)` — already accepts `directory`; ensure **all**
  callers pass it.
- `createSession(server, title, location)` — add `location` to the POST body
  (`POST /api/session` supports `location`).
- `listenV2` — insert a `"\n\n"` separator between assistant text segments:
  on `session.text.started`, if `collected` is non-empty, append `"\n\n"` before
  the next delta. Fixes run-on per-step narration. (Optional `--final` mode to
  emit only the last segment.)
- `selectSession` — keep the v2 no-op, with an explicit comment pointing at §5.

### 6.2 New state helpers (`lib/ocmux.js` or a new `lib/project-state.js`)

- `findProjectStatefile(startDir)` — upward search.
- `readProjectState(dirOrFile)` — parse + legacy normalization.
- `writeProjectState(dir, patch)` — atomic merge write.
- `resolveProject({ server, directory })` — resolve dir/session/server using
  §3.2–§3.4.
- `checkServer(server)` — `GET /api/info`; throws a clear "start `opencode serve`"
  error when unreachable. No lifecycle management.
- `listProjects()` — windows with `.ocmux.json`, with selected session.
- `relaunchTui(windowIndex, dir, server, session)` — the §5 command; tested via
  a mocked `_tmux`.
- `activateProject(dir)` — focus + zoom; restart dead TUI using the stored
  session (read-only).

### 6.3 `bin/ocmux`

- Restructure `main()` dispatch:
  - `ocmux` (default) → session picker (§4.2).
  - `switch` → project picker (§4.3).
  - `serve`/`new` → `cmdNew` rewritten for shared server + TUI-only window.
  - add `session`, `down`; repurpose `resurrect`.
  - `list` shows projects + selected sessions.
  - `model` targets the selected session (drop the URL-printing contract).
- Remove/retire per-project server startup from `startServer` (server pane,
  `tee` log polling) in favor of `ensureServer()`.
- Keep `--git`/`--GIT` and directory resolution semantics.

### 6.4 `lib/ocmux.js` transition shim

- `tuiPaneId(windowIndex)` currently returns the first non-zero pane; in the new
  layout the TUI is pane 0. During migration, support **both**:
  - layout v2: TUI is pane 0 (or the only pane);
  - layout v1: pane 0 is server, TUI is pane 1+ (tolerate until `ocmux migrate`).
- `windowByDir`/`windowNameByIndex`/`activeWindowIndex` unchanged.

### 6.5 `bin/agentp`

- Replace `resolveTargetSession` boilerplate with `resolveProject` + session
  precedence (§3.4). `resolveTargetSession(server, dir, { sessionName, newSession, preferredSession })`.
- Pass `directory` to **every** `listSessions` call (`resolveTargetSession`,
  `--getLast`).
- **Never writes `.ocmux.json`** (ocmux owns session persistence).
- Keep positional URL arg as override; still accept `agentp $(ocmux)` (the URL is
  now just a server override; directory/session come from the state file).
- Deferred tickets: unchanged shape (`server`, `sessionId`); store the resolved
  session ID.
- Output-separator fix is inherited from `lib/opencode.js`.

### 6.6 `bin/tgagentp` (follow-up workstream)

- Connection entries already store `dir`; add `session`. Resolve server from the
  global state + `.ocmux.json`; target `session` for messages.
- `/servers switch` = project switch (windows); add a session switch command
  (e.g. `/session <n>`) mirroring `ocmux`.
- Scope all `listSessions` by `projectDir` (lines ~602/767 currently unscoped).
- Larger surface — can land after `ocmux`/`agentp`.

### 6.7 Docs

- Update `README.md` (usage, `agentp` no longer needs `$(ocmux)`; `ocmux`
  session/project pickers).
- Update `docs/specification.md` → point to this file; reconcile state schema.
- `CHANGELOG.md` full summary. **Do not bump version without approval.**

---

## 7. Edge cases & risks (analysis)

1. **In-TUI session drift (highest risk).** The user can create/switch sessions
   *inside* the TUI (`session.new`, tabs). `.ocmux.json.session` then disagrees
   with what is displayed, and `agentp` would target the stale session.
   - Mitigation A (recommended): `ocmux` is the canonical switcher; in-TUI
     navigation is treated as inspection. Provide `ocmux sync`/`--adopt` to
     adopt the TUI's current session (newest `time.viewed` in the directory).
   - Mitigation B: `agentp` warns when `state.session !== newest-viewed` in the
     same directory.
2. **`--session` creates if missing.** A stale/deleted stored ID would be
   silently recreated. Always validate with `getSession` before relaunch/send.
3. **Session moved/deleted.** `POST /api/session/:id/move` changes
   `location.directory`; `delete` removes it. Detect 404/mismatch → fall back to
   §3.4.3 and repair the file.
4. **Relaunch is disruptive.** Loses scrollback and in-TUI state; if the same
   session is running a prompt, the view detaches (execution continues). Document
   it; skip relaunch when the TUI is already on the target session.
5. **`ocmux switch` writes.** Ensure every code path it can reach (activate,
   restart dead TUI, zoom) is read-only for `.ocmux.json`. Add a test asserting
   no write.
6. **Persistence races.** Atomic writes + read-once at start. `agentp` must not
   rewrite `session` while `ocmux` is switching.
7. **No `.ocmux.json`.** `ocmux` offers `serve`; `agentp` prints a clear error and
   exits 1 (as today). Define the exact message.
8. **Empty project (no sessions).** Picker offers `n` (create). `agentp`
   bootstraps a session in `directory` and (optionally) persists it.
9. **Nested projects / parent state.** Upward search precedence is nearest file.
   `--git`/`--GIT` unchanged. Validate `directory` matches realpath; repair if
   the file moved.
10. **Multiple profiles (work vs home).** One server per profile keyed by data
    dir/binary. Global state namespaced; never share across profiles.
11. **Isolation.** A shared server lets any client reach any project. The store is
    already shared, so this is not a regression; document it. True isolation
    requires a separate `XDG_DATA_HOME`.
12. **Server restart / port change.** Global state is authoritative; per-project
    cached `server` may be stale. Health-check before use; refresh on success.
13. **`ocmux model` contract change.** Previously printed the URL for
    `agentp $(ocmux model …)`. With `agentp` self-resolving, it should instead
    switch the selected session's model and print a human confirmation.
14. **`resurrect`/`kill` semantics.** `kill` removes a project window + state;
    with a shared server this is lighter. `resurrect` recreates a window. Define
    whether killing keeps session memory (proposal: remove state, matching today).
15. **Window layout migration.** Old windows have a server pane; new ones do not.
    The transition shim (§6.4) handles both until `ocmux migrate` runs.
16. **Run-on output (separate but included).** `listenV2` concatenates text
    deltas across steps with no separator — fixes §6.1.
17. **Built-in background service.** `opencode service start|stop|status` exists
    and may own the shared server. Option: delegate lifecycle to it and have
    `ocmux` only manage TUIs. Recommend evaluating after Phase 1; keep
    `ensureServer()` abstract so the backend can change.
18. **`opencode --session` semantics.** Confirmed present: "Session ID to
    continue, or to create if it does not exist" — hence the validate-first rule.

### 7.1 Things easy to miss

- `agentp` must still accept the legacy URL positional for back-compat, but must
  **not** let it determine the project (directory comes from state/cwd).
- `tgagentp` is a first-class consumer of `.ocmux.json`; keep the schema in one
  place so all three tools agree.
- `.ocmux.json` is gitignored — never commit it; `ocmux migrate` must not create
  tracked files.
- The tmux `__server__` window must be excluded from `switch`/`list` counts.

---

## 8. Implementation plan — workstreams ("subagents")

Each workstream is a self-contained unit suitable for delegation to a
`general` subagent (implementation) with an `explore` subagent for audits.
Workstreams A–B are prerequisites; C and D can run in parallel after A; E–F
follow. G runs last.

### Subagent A — Core state & resolution (`core-state`)

- **Goal:** Centralize `.ocmux.json` read/write/migration and server/dir/session
  resolution; make it the single contract shared by all CLIs.
- **Deliverables:**
  - New `lib/project-state.js` (or additions to `lib/ocmux.js`):
    `findProjectStatefile`, `readProjectState`, `writeProjectState`,
    `resolveProject`, `serverStatePath/readServerState/writeServerState`.
  - Legacy normalization + atomic writes.
  - Unit tests: legacy parse, moved-file repair, precedence table, atomic write.
- **Depends on:** nothing.
- **Checkpoints:** all precedence cases covered; no partial writes under a
  simulated crash; legacy files never throw.

### Subagent B — ~~Server lifecycle~~ (removed)

Per §11.1 the server is user-managed. Only a read-only `checkServer()` remains
(folded into workstream A). No lifecycle workstream.

### Subagent C — `ocmux` CLI rework (`ocmux-cli`)

- **Goal:** New command surface (§4): session picker, project picker, serve,
  session, kill, down, list, model; TUI relaunch (§5).
- **Deliverables:** `bin/ocmux` dispatch + `lib/ocmux.js` `relaunchTui`,
  `listProjects`, `activateProject`, transition shim (§6.4).
- **Depends on:** A, B.
- **Checkpoints:** `ocmux` picker updates `session` + relaunches TUI; `ocmux
  switch` writes nothing (test); TUI-only layout works; v1 layout tolerated.

### Subagent D — `agentp` integration (`agentp-integration`)

- **Goal:** Self-resolving project/session; scoped listing; output fix.
- **Deliverables:** `resolveTargetSession(server, dir, opts)`; directory passed
  everywhere; bootstrap persistence; `--getLast` scoping; text-segment separator;
  legacy URL arg preserved.
- **Depends on:** A (shared resolution).
- **Checkpoints:** with two projects and a global store, prompts hit the stored
  session of the correct directory; `--session`/`--new` override without
  persisting; run-on output fixed.

### Subagent E — `tgagentp` integration (`tgagentp-integration`)

- **Goal:** Target the same project/session; scope listings.
- **Deliverables:** connection `session` field; session switch command; scoped
  `listSessions`; server resolution via A/B.
- **Depends on:** A, B, D (patterns).
- **Checkpoints:** Telegram message lands in the stored session; `/servers
  switch` maps to project windows; no unscoped listing remains.

### Subagent F — Tests, docs, changelog (`tests-docs`)

- **Goal:** Regression + migration coverage; user-facing docs.
- **Deliverables:** `tests/project-state.test.js`; updates to
  `tests/agentp.test.js`, `tests/ocmux.test.js`; `README.md`; align
  `docs/specification.md`; `CHANGELOG.md` entry (no version bump).
- **Depends on:** A–E (can start on A early).
- **Checkpoints:** full suite green; docs show `agentp` without `$(ocmux)`; state
  schema documented in one place.

### Subagent G — Integration verification (`integration-verify`)

- **Goal:** End-to-end acceptance and a smooth transition.
- **Deliverables:** a manual/automated checklist run against a live OpenCode v2
  with ≥2 projects:
  1. `ocmux serve` for two dirs creates two TUI windows on one shared server.
  2. `ocmux` in project A picks a session; `.ocmux.json.session` updates; TUI
     relaunches on it.
  3. `ocmux switch` focuses B without touching either state file.
  4. `agentp --qa <<< "..."` from A targets A's session; from B targets B's;
     responses appear in the correct window.
  5. Switch session inside the TUI, then verify `ocmux sync`/warning behavior.
  6. `--defer` ticket round-trip targets the same session.
  7. Legacy file migration; server restart/port change; `ocmux down`.
- **Depends on:** A–F.
- **Checkpoints:** checklist fully green; no wrong-window routing; rollback
   documented.

### 8.1 Suggested execution order

```
A ──▶ C ──┐
   └──▶ D ──┴──▶ F ──▶ G
            E ──┘   (deferred)
```

Parallelization: C and D after A; E deferred; F continuously; G last.

---

## 9. Migration & rollout

1. **Read path first:** ship legacy-tolerant readers (A) before any writer
   changes. Old and new files both work.
2. **Migration command:** `ocmux migrate [--dry-run]`:
   - health-check the server;
   - for each project window: rewrite `.ocmux.json` to v2 (directory = realpath,
     session = current/newest scoped, server = the server it already used);
   - optionally retire per-project server panes.
3. **Compatibility window:** keep the v1 layout shim (§6.4) until all windows are
   migrated.
4. **Rollback:** because `.ocmux.json` and code are versioned and the store is
   untouched, reverting the binary restores v1 behavior; migration can be
   re-run. Keep a `.ocmux.json.bak` during migrate.
5. **Release:** update CHANGELOG; version bump **only on maintainer approval**
   (per `AGENTS.md`).

---

## 10. Acceptance criteria (definition of done)

- [ ] `agentp` resolves server/directory/session from the nearest `.ocmux.json`
      and works without `$(ocmux)`.
- [ ] No code path calls `listSessions` without a `directory`.
- [ ] `createSession` sets `location`.
- [ ] `ocmux` (no args) updates `session` and switches the TUI to it.
- [ ] `ocmux switch` never writes `.ocmux.json` (tested).
- [ ] A session deleted/moved is detected and repaired; no silent recreation.
- [ ] Run-on assistant text is separated into paragraphs.
- [ ] Full test suite green; migration and legacy reads covered.
- [ ] `README.md`, `docs/specification.md`, `CHANGELOG.md` updated.

---

## 11. Decisions (resolved 2026-10-07)

0. **OpenCode v1 is dropped.** `lib/opencode.js` is v2-only; the legacy
   `/tui/*`, legacy SSE listeners and legacy endpoint paths were removed.
1. **Server is OUT OF SCOPE.** ocmux/agentp do **not** start, stop, restart, or
   supervise the server. The user starts `opencode serve` manually. The tools
   only **check** that the configured server is reachable and **complain**
   (exit 1 with a clear hint) otherwise. There is no `ensureServer()`, no
   `ocmux up`/`down`, and no managed global server state.
   - Note: a server's launch directory is only its *default location*; it can
     serve any location via `directory`/`location` parameters.
2. **No in-TUI drift handling.** The TUI is used **only for viewing** (reasoning
   + colored markdown). Sessions are never switched inside the TUI. `.ocmux.json`
   is authoritative; no `ocmux sync`/adoption logic.
3. **`kill` keeps `.ocmux.json`.** Closing a project removes the tmux window/TUI
   but preserves the state file (session memory). `kill` may mark it
   `"status": "stopped"`; `list`/`switch` derive/defunct status from tmux window
   existence. There is no server to kill — only the TUI window.
4. **`ocmux` (no args) prints nothing** on success; it is the interactive session
   switcher. Any diagnostics go to stderr. The `switch` subcommand was removed;
   **`p`** in the picker opens the project switcher.
4b. **Session picker keys:** `Enter` switch (stays open) · `n` create · `r`
   rename (readline-style caret editing) · `d` delete · `a` annotate · `p`
   projects · `h` help · `q` quit.
5. **tgagentp is deferred** to a follow-up release (workstream E).
6. **Server URL source:** per-project `.ocmux.json.server`, overridable by
   `--server`/`OPENCODE_SERVER_URL`; default `http://localhost:4096`. Recorded by
   `ocmux serve` and never managed thereafter.

---

## 12. Appendix — verified v2 facts (2026-10-06)

- OpenCode v2.0.21; API under `/api`; Basic auth via `OPENCODE_SERVER_PASSWORD`.
- Store: `~/.local/share/opencode/opencode.db`.
- `GET /api/session?directory=<realpath>` is exact-match (subdir/trailing slash ⇒
  empty). Cross-location access works from any server.
- `POST /api/session` payload supports `location`.
- `GET /api/session/active` lists sessions with running executions.
- `session.viewed` / `time.viewed` track the TUI's last-viewed session.
- No reachable HTTP TUI-steering endpoint (`/tui/*` ⇒ 405/catch-all);
  `tui.session.select` is a directory-scoped client event with no public emitter.
- `opencode --session/-s <id>` opens (or creates) a session in the TUI.
- `opencode service` manages a built-in background server.

---

## 13. Future improvements

### 13.1 Per-session annotations (`a` key in the session picker)

**Status: IMPLEMENTED (2026-10-07).**

The `a` key in the `ocmux` session picker attaches a short **annotation** to the
selected session (e.g. *"Remember to work in the worktree foobar"*). Annotated
sessions are marked with `◈`. `agentp` prepends the annotation (plus a blank
line) to **every prompt** sent to that session, so steering context survives
across invocations.

Persistence: an `annotations.json` **sidecar** next to `.ocmux.json`
(project-scoped), mapping `sessionID → text`; empty text removes the entry.
Written atomically (tmp + rename).

Integration points (implemented):
- `lib/project-state.js`: `readAnnotations(dir)`, `writeAnnotation(dir, id, text)`.
- `bin/ocmux` session picker: `a` key → input mode (reuses the rename input
  with caret editing, ESC cancels); documented in the `h` help menu.
- `bin/agentp`: after session resolution, prepends `annotation + "\n\n"` to the
  prompt before `sendToSession`.

Known limitation: follow-ups queued via a deferred **ticket** do not re-inject
the annotation (the ticket carries only `server`/`sessionId`). If needed later,
the annotation can be looked up from the ticket's session on the server.

### 13.2 Completion hardening (annotated)

`listenV2` still resolves after a **silent** grace window (default 5000ms). A
sub-agent that goes completely silent for longer than that (e.g. a long `bash`
tool without events) can still truncate an answer. Candidates for the next pass:
- wait on `GET /api/experimental/session/:id/wait` ("Wait for a session agent
  loop to become idle") after the terminal signal;
- explicit child-session tracking (`parentID`) so sub-agent runs keep the parent
  "working" regardless of event silence.
