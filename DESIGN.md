# Trellis: Architecture & Design

Trellis is a local kanban board whose cards are Markdown files in git, served by a zero-build web app and an Electron desktop app, with an MCP server and CLI shaped to cost as few tokens as possible. It can target any directory and keeps a per-user registry of boards so humans and LLM agents can switch between projects effortlessly.

## 1. The problem it solves

Cloud kanban connectors (such as Trello's API/MCP) spend context window tokens on the wrong things:

- Reading one card returns its whole description, every metadata field, 24-character hex IDs, URL slugs, and nested member objects as verbose JSON.
- Updating a description means sending the entire description back. Appending one implementation note to a 15k-character card costs 15k characters out and 15k back.
- Listing cards often dumps the entire board at once or paginates clumsily.
- Cloud description character limits force long specifications or audit trails into external files.
- Checklists live on separate endpoints, requiring extra round-trips per card.

Being local fixes latency and offline availability. The token cost is a property of the API shape, so the API shape is where Trellis focuses its design.

## 2. Principles

1. **Short stable IDs.** A card is `#207`. Trello's `idShort` survives import, so existing references still mean the same card. Lists are slugs such as `in-progress`.
2. **Sections are the unit of reading and writing.** A card's body (`Context`, `Why this matters`, `What to do`, `Steps`, `Success criteria`, `Tests`, `References`) is a set of `## ` headings. An agent can read only `What to do` and `Steps`, replace only `Context`, or append an implementation note without touching the rest. A section name may be a prefix (`Implementation note` reads every dated note), `["meta"]` sizes every section in tokens before the agent chooses, and an unnarrowed read of an outsized card keeps the template sections and names what it elided so no default call blows up the context window.
3. **Patch in, ack out.** Writes carry only the change and return one line (`ok #207 r15 Steps 5/9`), never the full card echo.
4. **Tables, not JSON.** Listings are tab-separated with a header row and `-` for empty fields (~20 tokens per card row). `format: "json"` is available for programmatic callers.
5. **Optimistic concurrency (`rev`).** Every card carries an integer `rev`, incremented on every write. If a caller supplies the `rev` it last read and another writer updated the card in the meantime, the write is rejected with the current `rev`.
6. **A small tool surface, three ways in.** MCP clients inject tool definitions into context on every turn, so Trellis exposes eleven focused tools with compact schemas. The exact same operations are available via the `trellis` CLI, and the underlying files are plain Markdown that can be read with standard tools (`grep`, `sed`, `git diff`).
7. **Target any directory, remember every board.** A board is self-contained inside its directory (`board.yaml` + `cards/`). A lightweight registry in `~/.config/trellis/boards.json` remembers every board directory you open or initialize so the CLI, MCP server, Web UI, and Desktop app can list and switch between boards by slug, name, or path.

## 3. Data model

```
<board-dir>/
  board.yaml                 # board name, list order, labels, section template
  cards/
    0001-initial-setup.md
    0002-....md
```

When initialized inside a repository root (a directory with `.git`, `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, or `project.godot`), Trellis places the board in `<repo>/board/` by default (or directly in `<dir>/` with `--here`).

### `board.yaml`

```yaml
name: My Project
lists:
  - id: backlog
    name: Backlog
  - id: in-progress
    name: In Progress
  - id: archived-lane
    name: Archived lane
    archived: true
labels:
  - name: backend
    color: blue
template: [Context, Why this matters, What to do, Steps, Success criteria, Tests, References]
```

Array order is lane order. A list's `id` is the slug of its name at creation and never changes when renamed, so cards do not need to be rewritten when a lane is renamed.

### A card file

~~~~markdown
---
id: 42
title: Implement token bucket rate limiter
list: in-progress
pos: 3000
kind: agent
status: open
labels: [backend]
blocked_by: [40]
siblings: [41]
rev: 4
created: 2026-10-10T12:00:00Z
updated: 2026-10-17T09:12:00Z
---

## Context

Current middleware in `src/http/server.ts` has no per-IP rate limiting.

## What to do

1. Add token bucket state store.
2. Wire middleware into public routes.

## Steps

- [x] Add token bucket state store
- [ ] Wire middleware into public routes

## Tests

```sh
npm test
```

## Comments

### 2026-10-17T09:12:33Z claude

Store unit tests passing; wiring routes next.
~~~~

| Field | Meaning |
| --- | --- |
| `id` | Integer, unique within the board, never reused. Filename is `<id zero-padded to 4>-<slug>.md`. |
| `list` | A list `id` from `board.yaml`. |
| `pos` | Integer order within the list. New cards step by 1000; cards dropped between two cards take the midpoint; when integer gaps close, the list renumbers in steps of 1000 without bumping card `rev`s. |
| `kind` | `agent`, `human`, or `joint`. |
| `status` | `open`, `done`, or `archived`. `closed` records the timestamp when a card leaves `open`. |
| `labels` | Label names from `board.yaml`. Unknown labels on write are automatically registered with the next palette color. |
| `blocked_by` | IDs of cards that must be completed first. Validated to exist. UI and listings surface only blockers that are still `open`. |
| `siblings` | IDs of related cards. |
| `rev` | Incremented on every write to the card. |
| `trello` | Optional Trello `shortLink` preserved from Trello JSON imports. |

## 4. Board Registry (`lib/registry.mjs`)

Remembered boards are stored in `~/.config/trellis/boards.json` (or `$TRELLIS_REGISTRY`):

```json
{
  "version": 1,
  "current": "/Users/you/development/alpha/board",
  "boards": [
    {
      "dir": "/Users/you/development/alpha/board",
      "root": "/Users/you/development/alpha",
      "name": "Alpha",
      "slug": "alpha",
      "addedAt": "2026-10-17T12:00:00.000Z",
      "lastOpened": "2026-10-17T13:00:00.000Z"
    }
  ]
}
```

- Every board gets a short unique `slug` derived from its project folder or board name (`alpha`, `beta`, etc.).
- Any operation in `lib/ops.mjs` can target the active board or override it per call via `board` (slug, name, or path).
- `server.mjs` supports hot-switching the active board at runtime (`POST /api/boards/select`, `POST /api/boards/init`, `POST /api/boards/import`), swapping the file watcher and activity feed and broadcasting a `board` SSE event to connected browsers.

## 5. Concurrency & Operations (`lib/store.mjs`, `lib/ops.mjs`)

Every write operation:
1. Acquires the board lock (`<board-dir>/.lock`, exclusive create, stale after 10 seconds),
2. Reads the latest card state from disk,
3. Verifies `rev` if provided by the caller,
4. Applies the patch, bumps `rev` and `updated`,
5. Writes to a temporary file and atomically renames it into place,
6. Releases the lock.

## 6. Hybrid Search (`lib/search.mjs`, `lib/embedder.mjs`)

`board_search` chunks each card by `## ` section with the card title prefixed to each chunk. Each chunk is indexed with BM25 tokens and a 384-dimensional local embedding (`Xenova/bge-small-en-v1.5`). Rankings are combined via Reciprocal Rank Fusion ($k = 60$) and folded back to cards. Content hashes in `<board-dir>/.search/index.json` ensure only modified cards are re-embedded on subsequent queries.
