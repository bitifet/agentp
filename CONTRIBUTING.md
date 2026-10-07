# Contributing to agentp

## Introduction

agentp is a collection of three **zero-dependency** Node.js CLI tools that
extend [OpenCode](https://opencode.ai) v2:

- **`agentp`** — pipes prompt text into a running OpenCode session and streams the answer back to stdout.
- **`ocmux`** — manages per-project TUI windows in tmux (session picker, project switcher, create/rename/delete/annotate sessions) on top of a single **user-managed** OpenCode server.
- **`tgagentp`** — bridges a Telegram bot chat with OpenCode (multi-chat, multi-server, file sharing). *Experimental.*

The project aims to stay **zero npm dependencies** — everything uses only the
Node.js 18+ stdlib (`http`, `https`, `readline`, `url`, `child_process`, `fs`,
`path`, `crypto`, `os`). PRs introducing new dependencies will not be accepted
unless there is an exceptional justification.

**OpenCode v2 only.** OpenCode v1 support was removed in 2.0.0; there are no
legacy code paths. The HTTP client lives in `lib/opencode.js`.

## Development Setup

### Prerequisites

- Node.js >= 18
- npm (ships with Node.js)
- tmux (only needed for `ocmux` and `tgagentp`)
- an OpenCode v2 server for manual testing (`opencode serve`)

### Local Install

```bash
git clone <your-fork>
cd agentp
npm link          # registers bin/agentp, bin/ocmux, bin/tgagentp globally
# or
npm install -g .
```

## Code Map

```
agentp/
├── bin/
│   ├── agentp            — stdin-to-session pipe
│   ├── ocmux             — project/TUI window manager + interactive pickers
│   └── tgagentp          — Telegram bot bridge
├── lib/
│   ├── opencode.js       — OpenCode v2 HTTP/SSE client (shared by all three)
│   ├── ocmux.js          — tmux helpers (shared by ocmux + tgagentp)
│   ├── project-state.js  — `.ocmux.json` v2 schema + per-session reminders
│   ├── tui-cmd.js        — tmux send-keys passthrough (tgagentp)
│   ├── file-share.js     — telegram-shared directory + upload/download
│   └── telegram-*.js     — Telegram API + formatting helpers
├── tests/                — node:test suites (one per module)
├── docs/
│   ├── specification.md     — short pointer (superseded)
│   └── specification_v2.md  — current architecture reference
├── AGENTS.md             — agent/dev notes
├── CONTRIBUTING.md       — this file
└── package.json
```

## Coding Standards

- **CommonJS** (`require` / `module.exports`) — no ES modules.
- **2-space indentation**, single quotes, `const` over `let` (avoid `var`),
  `async/await` over `.then()`.
- **Semicolons are used** in `bin/` and `lib/` — except `lib/tui-cmd.js`, which
  is deliberately no-semicolons. Match the file you are editing.
- Comments are welcome and present throughout; keep them meaningful.

### Conventions

- **HTTP:** use `lib/opencode.js` helpers — never raw `http.request`.
- **tmux:** use `lib/ocmux.js` helpers (`_tmux` / exported wrappers) — never raw
  `spawnSync`.
- **State:** `.ocmux.json` I/O goes through `lib/project-state.js`
  (`readProjectState`, `writeProjectState`, `readAnnotations`, `writeAnnotation`,
  atomic writes). Never hand-roll reads/writes.
- **Logging:** `tgagentp` uses `log.info`/`log.error`/`log.debug` (never bare
  `console.log`). `agentp`/`ocmux` use `console.log` for CLI stdout (answers,
  lists, `--version`) and `console.error` for diagnostics.

### Architecture Rules

1. **Zero npm dependencies.** `package.json` `"dependencies"` must remain empty.
2. **`bin/` entry points stay thin**; business logic goes in `lib/`.
3. **`bin/tgagentp` is the largest file (~3000 lines).** Extract reusable logic
   into `lib/` when adding features.
4. **Mockable externals.** All network/subprocess/filesystem access must be
   interceptable (the existing test suites mock `http.request`,
   `child_process.spawnSync`, and `fs.*`).
5. **Sessions created via the API have no model** and will not execute prompts
   until one is set — always create them with `createSessionWithModel`.

## Running Tests

Tests use the built-in `node:test` runner (no extra dependencies). Every
external interface is mocked, so the suite runs fully in-process and is safe to
run alongside a live OpenCode instance.

```bash
npm test                                # all suites
node --test tests/opencode.test.js      # one file
node --test tests/ocmux.test.js
node --test tests/project-state.test.js
```

Mock boundaries are installed in `before()`/`after()` (opencode) or
`beforeEach()`/`afterEach()` (ocmux) hooks. Tests that share mocked state run
serially (`concurrency: false`).

### Adding Tests

1. Add them to the matching `tests/<module>.test.js`.
2. Use `describe`/`it`/`before`/`after` from `node:test` and `node:assert`.
3. Mock every external boundary.
4. Run the full suite before opening a PR.

## Pull Request Process

1. Fork the repo and branch from `main`.
2. Follow the coding standards above.
3. Run `npm test` — all suites must pass.
4. Update documentation when user-facing behavior changes:
   - `README.md` (usage/behavior),
   - `docs/specification_v2.md` (architecture),
   - `AGENTS.md` (test counts / non-obvious facts),
   - `CHANGELOG.md` (with every release).
5. Commit with a descriptive message (`fix:`, `feat:`, `refactor:`, `docs:` …).
6. Open a PR against `main` with a summary and testing instructions.

## Getting Help

- Open a GitHub issue for bugs or feature requests.
- For OpenCode-specific questions, refer to [opencode.ai](https://opencode.ai).
