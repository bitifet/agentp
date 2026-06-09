# Contributing to agentp

## Introduction

agentp is a collection of three zero-dependency Node.js CLI tools that extend [OpenCode](https://opencode.ai) with per-project tmux server management (`ocmux`), a stdin-to-session pipe (`agentp`), and a Telegram bot bridge (`tgagentp`).

The project aims to stay **zero npm dependencies** — all tools use only the Node.js 18+ stdlib (`http`, `https`, `readline`, `url`, `child_process`, `fs`, `path`, `crypto`, `os`). PRs introducing new dependencies will not be accepted unless there is an exceptional justification.

## Development Setup

### Prerequisites

- Node.js >= 18
- npm (ships with Node.js)
- tmux (optional, only needed for `ocmux` and `tgagentp` features)

### Local Install

```bash
git clone <your-fork>
cd agentp
npm link          # registers bin/agentp, bin/ocmux, bin/tgagentp globally
# or
npm install -g .  # alternative
```

After linking, all three binaries are available globally. Run `tgagentp --help` or refer to `README.md`.

### Code Map

```
agentp/
├── bin/
│   ├── agentp        — Stdin-to-OpenCode pipe
│   ├── ocmux         — Tmux server manager
│   └── tgagentp      — Telegram bot bridge
├── lib/
│   ├── opencode.js   — HTTP session API client (shared by agentp + tgagentp)
│   └── ocmux.js      — Tmux management (shared by ocmux + tgagentp)
├── tests/
│   ├── opencode.test.js  — Unit tests for lib/opencode.js
│   └── ocmux.test.js     — Unit tests for lib/ocmux.js
├── docs/
│   └── specification.md  — Technical architecture reference
├── AGENTS.md             — Development notes and TODO
├── CONTRIBUTING.md       — This file
└── package.json
```

## Coding Standards

### Style

- **CommonJS** (`require` / `module.exports`) — no ES modules
- **No semicolons** — the project uses ASI (automatic semicolon insertion)
- **No comments** in production code — let the code speak; use descriptive variable/function names
- **2-space indentation**
- Single quotes for strings
- `const` over `let`; avoid `var`
- Arrow functions for callbacks and closures

### Conventions

- Async functions: use `async/await`, avoid raw `.then()`
- Error handling: use try-catch at call sites; log errors via `log.error()`
- Logging: use the `log` helper (`log.info`, `log.error`, `log.debug`) — never `console.log`
- HTTP: use `lib/opencode.js` request helpers instead of raw `http.request`
- Tmux: use `lib/ocmux.js` helpers instead of raw `spawnSync`

### Architecture Rules

1. **Zero npm dependencies.** The `package.json` `"dependencies"` field must remain empty.
2. **`bin/`** files are entry points — keep them thin. Business logic goes in `lib/`.
3. **`bin/tgagentp`** is the largest file (~2000 lines). When adding new features, extract reusable logic into `lib/` when possible.
4. **Shared state** (e.g., `chatStates`, `serverOwners`) is held in module-level variables in `bin/tgagentp` and `lib/ocmux.js`. Be mindful of mutation.
5. **All external calls must be mockable.** `lib/opencode.js` tests mock `http.request`; `lib/ocmux.js` tests mock `child_process.spawnSync` and `fs.*`.

## Running Tests

Tests use Node.js built-in test runner (`node:test`) — zero additional dependencies.

```bash
# Run all tests
npm test

# Run a specific test file
node --test tests/opencode.test.js
node --test tests/ocmux.test.js

# Run with verbose output
node --test tests/opencode.test.js | bunyan  # or just grep for results
```

All external interfaces are mocked — tests run entirely in-process without touching the network, tmux, or the filesystem. They are safe to run alongside a live OpenCode instance.

### Test Architecture

Tests are structured in phases (see `AGENTS.md` for the full plan):

| Phase | Module | Boundary Mocked |
|-------|--------|----------------|
| 1a | `lib/opencode.js` | `http.request` |
| 1b | `lib/ocmux.js` | `child_process.spawnSync`, `child_process.execSync`, `fs.*` |

Each test file uses `node:test`'s `mock` API in `before()`/`after()` hooks to install and tear down mocks. Tests within a describe block run serially (`concurrency: false`) when they share mocked state.

### Adding Tests

1. Place new tests in `tests/<module>.test.js`
2. Use `describe`, `it`, `before`, `after` from `node:test`
3. Use `node:assert` for assertions
4. Mock all external boundaries (network, filesystem, subprocesses)
5. Run the full suite before submitting a PR

## Pull Request Process

1. **Fork the repo** and create a feature branch from `main`.
2. **Make your changes** following the coding standards above.
3. **Run `npm test`** and ensure all tests pass.
4. **Update documentation** if your change affects user-facing behavior:
   - Help text in `bin/tgagentp` (the `cmdHelp` function)
   - `docs/specification.md` for architecture changes
   - Command table in `devto-article.md` (if adding/changing a slash command)
   - `AGENTS.md` Done section (move items in/out as appropriate)
5. **Commit with a descriptive message** following the existing style (e.g., `fix: ...`, `feat: ...`, `refactor: ...`, `docs: ...`).
6. **Open a pull request** against `main`. Include a summary of the change and any testing instructions.

### Review Process

- Maintainers review within a few business days
- Focus areas: mock correctness, zero-dependency rule, architectural consistency
- Large changes may be asked to split into smaller PRs
- All PRs must pass the test suite before merging

## Getting Help

- Open an issue on GitHub for bugs or feature requests
- Tag questions with `question` label for general help
- For OpenCode-specific questions, refer to [opencode.ai](https://opencode.ai)
