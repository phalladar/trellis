# Agent Instructions for Trellis

These instructions are for working on **Trellis** itself: its store, multi-board registry, HTTP server, Web UI, MCP server, CLI, hybrid search, and Electron desktop app.

- [README.md](README.md): installation, multi-board management, CLI, MCP configuration, Web UI, Desktop app, and Trello import.
- [DESIGN.md](DESIGN.md): architectural principles, token budget design, card file format, and registry model. Read it before changing tool schemas or file storage.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `lib/store.mjs` | `Board`: reads and writes card files, atomic write lock (`.lock`), `rev` checks, list ordering |
| `lib/registry.mjs` | `Registry`: remembers board directories in `~/.config/trellis/boards.json`, resolves slugs/paths, switches active boards |
| `lib/ops.mjs` | The eleven shared operations used by both the MCP server and the CLI |
| `lib/format.mjs` | Token-lean text formatting: TSV tables, budgeted card rendering (`CARD_BUDGET`) |
| `lib/search.mjs`, `lib/embedder.mjs` | Ranked hybrid search (BM25 + local CPU embeddings) |
| `lib/markdown.mjs` | Card Markdown front matter, section splitting, checklist and comment parsing |
| `lib/activity.mjs` | Per-board activity feed and card diffing for the Web UI bell and desktop notifications |
| `server.mjs` | HTTP server and JSON API on `127.0.0.1`; watches the active board and streams SSE updates; live board switching |
| `ui/` | Zero-build Web UI (`index.html`, `styles.css`, `app.js`), including the Board Switcher & Directory Manager |
| `mcp.mjs`, `cli.mjs` | MCP stdio server and CLI (`trellis`) over `lib/ops.mjs` |
| `import_trello.mjs`, `relink_trello.mjs` | Trello JSON importer and Markdown link rewriter |
| `desktop/` | Electron desktop app for macOS and Windows |
| `test/` | `node:test` test suites (`helpers.mjs` provides isolated `tempBoard()`) |

## Core Rules

- **Shared operations live in `lib/ops.mjs`**, called by both `mcp.mjs` and `cli.mjs`. Keep MCP tool schemas concise so agents do not pay unnecessary context overhead on every turn.
- **Keep outputs token-lean.** Writes return a one-line acknowledgement (`ok #42 r8 ...`), never the full card. Listings are tab-separated tables by default; JSON is only returned when `format: "json"` (or `--json`) is requested.
- **Every card write goes through `Board` (`lib/store.mjs`)** so the lockfile and `rev` counter are always respected.
- **Tests always use temporary directories and isolated registries.** Use `tempBoard()` from `test/helpers.mjs` or a temporary `TRELLIS_REGISTRY` path so running tests never mutates the user's `~/.config/trellis/boards.json`.

## Running Tests

```sh
npm test
```

Always run tests via `npm test` (which runs `node --test`). Search tests use a deterministic fake embedder, so no model download is required to run the test suite.
