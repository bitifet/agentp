# agentp — Specification (superseded)

This document described the **v1-era** architecture (one OpenCode server per
project, the `/tui/*` endpoints, `window_index`-based `.ocmux.json`, and the
`switch`/`model` subcommands). None of that is accurate any more.

See **[specification_v2.md](./specification_v2.md)** for the current design:

- a single, **user-managed** OpenCode v2 server (no per-project servers);
- the **project = directory / target = session** model with a v2 `.ocmux.json`
  (`directory`, `session`, `server`, `annotations`);
- `ocmux` project/TUI-window management and its interactive pickers;
- `agentp` resolution, deferred tickets (incl. `cancelled`) and `--qa` output;
- `lib/opencode.js` as the v2-only HTTP/SSE client.

For a quick start, see [../README.md](../README.md).
