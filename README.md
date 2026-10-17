# Trellis — Local-First Markdown Kanban Board & Token-Lean MCP Server for AI Coding Agents

**Trellis** is an **agent-first, local-first kanban board and task tracker** built for developers who build alongside AI coding agents (**Claude Code**, **OpenAI Codex**, **Cursor**, **Windsurf**, **Cline**, **Copilot**, and more).

Every card is a plain **Markdown file in Git** (`board/cards/0042-card-slug.md`). Humans get a fast, zero-build **local Web UI** (`127.0.0.1`) and a native **macOS & Windows Desktop App** with live Server-Sent Events (SSE) updates as agents work. Agents get a **Model Context Protocol (MCP) server** and **CLI** engineered from the ground up to use the **smallest possible token footprint**.

Trellis can target **any directory** on your machine, remembers every project board in `~/.config/trellis/boards.json`, and lets both you and your agents switch across repositories in a single click or command.

---

## Why I Built Trellis (The Story)

When working across half a dozen local repositories with AI coding agents, I kept hitting the same wall:

1. **Scattered Markdown files don't scale.** A `TODO.md` or `PLAN.md` in each repo works for a weekend, then turns into a graveyard of stale checklists with no swimlanes, no search, no blocker tracking, and no way to see what changed while an agent was running in the background.
2. **Cloud kanban MCP servers burn through your context window.** Connecting an agent to Trello, Jira, or Linear via MCP sounds great until you watch what actually enters the prompt: reading a couple of cards dumps thousands of tokens of verbose JSON, 24-character hex UUIDs, URL slugs, nested user objects, and redundant metadata. Worse, appending a two-line implementation note requires reading the entire card description and echoing the entire description back on write.
3. **Cloud boards don't live with your code.** They require API keys, network round-trips, and browser tabs detached from your local branches.

I wanted a way to **track my work locally across all of my projects**, keep every task as diffable, greppable Markdown right inside the repo (or any standalone folder), and make sure it was **agent-first**—shipping with an MCP server that treats **context window tokens as a scarce resource**.

That's **Trellis**.

---

## Why Agents Love Trellis: Token-Efficiency by Design

Most MCP servers are thin wrappers over verbose REST APIs. Trellis was designed backwards from the LLM context window:

| Operation | Typical Cloud Kanban MCP | Trellis MCP (`trellis-mcp`) |
| --- | --- | --- |
| **Card Identifiers** | `"65f8a9c0e4b0a12d4c8e9f01"` (24-char UUIDs) | `#42` (short, stable integers that survive Trello imports) |
| **Listing 30 Cards** | ~4,500+ tokens of nested JSON arrays | **~600 tokens** — compact TSV table (`id`, `list`, `kind`, `title`, `steps`, `blocked`) |
| **Inspecting a Large Card** | Dumps the entire card body into context | Pass `sections: ["meta"]` to see token sizes per section, then read only `sections: ["What to do", "Steps"]` |
| **Updating a Card / Ticking a Step** | Re-send full description; echoes full JSON card back | Surgical section patch (`append` / `set_sections` / `board_steps`); returns a **1-line ack**: `ok #42 r8 Steps 3/5` |
| **Tool Schema Overhead** | Dozens of sprawling endpoint schemas injected every turn | **11 focused tools** with terse schemas shared identically with the `trellis` CLI |
| **Concurrent Agent Safety** | Last write silently overwrites | Per-card `rev` counter + atomic file lock (`board/.lock`) rejects stale writes cleanly |

> Deep dive into the token budget, lockfile protocol, and card format in **[DESIGN.md](DESIGN.md)**.

---

## Key Features

- **Plain Markdown in Git**: One card = one file (`board/cards/0042-card-slug.md`) with clean YAML front matter and `## ` Markdown sections (`Context`, `What to do`, `Steps`, `Tests`, etc.). Diffable, branchable, greppable, and readable in any editor.
- **Multi-Project Board Registry**: Target any repo or directory (`trellis -C ~/code/my-app ...`). Trellis remembers every board in `~/.config/trellis/boards.json` so you can switch projects from the CLI (`trellis use <slug>`), Web UI header, Desktop shortcuts (`⌘1`–`⌘9`), or MCP (`board_boards`).
- **Agent / Human / Joint Card Kinds**: First-class distinction between `agent` (autonomous LLM tasks), `human` (owner decisions, manual playtests, credentials), and `joint` (agent implements, human reviews/approves).
- **Local Hybrid Semantic + Lexical Search**: Section-level chunking combining **BM25** with **local CPU embeddings** (`Xenova/bge-small-en-v1.5` via `@huggingface/transformers`). Zero external API keys, incrementally cached by content hash in `board/.search/index.json`.
- **Live Zero-Build Web UI & Native Desktop App**: Drag-and-drop lanes and cards, inline section Markdown editors, live SSE reload the instant an agent updates a card on disk, per-card activity bell with "what changed" diff banners, and native macOS/Windows OS notifications.
- **One-Command Trello Migration**: Import any Trello JSON export (`trellis import export.json`), preserving original `#id` card numbers, shortlinks, lists, checklists, comments, and even rewriting `https://trello.com/c/...` links across your repo's docs (`trellis relink`).

---

## Quick Start

Requires **Node.js 22+**.

```sh
git clone https://github.com/phalladar/trellis.git
cd trellis
npm install

# Link `trellis`, `trellis-mcp`, and `trellis-server` globally on your PATH
npm link
```

### Initialize a board in any project and launch the UI

```sh
# Create a board inside any project repo (creates <repo>/board/board.yaml + cards/)
trellis init ~/development/my-project --name "My Project" --lists "Backlog,In Progress,Review,Done"

# Or initialize directly in a folder without a board/ subdirectory
trellis init ~/notes/roadmap --here --name "Roadmap"

# Launch the local Web UI at http://127.0.0.1:8766/
trellis serve
```

> **Tip:** Set `TRELLIS_PORT` (or `BOARD_PORT`) to customize the port, and `TRELLIS_DIR` (or `BOARD_DIR`) to pin a specific board directory via environment variable.

---

## Installing the MCP Server in Your AI Coding Tool

All MCP clients run Trellis's stdio server (`mcp.mjs`, or `trellis-mcp` if you ran `npm link`).

- Set `BOARD_AUTHOR` so card comments and activity diffs attribute work to the right agent (`claude`, `codex`, `cursor`, `windsurf`, etc.).
- You do **not** need to hardcode a board path per repo if you don't want to: `mcp.mjs` automatically resolves the nearest `board/board.yaml` from the current working directory, falls back to your active board in `~/.config/trellis/boards.json`, and allows the agent to switch or query any remembered project via the `board` parameter or `board_boards` tool.
- If you want to pin an MCP config to a specific project directory, add `"TRELLIS_DIR": "/path/to/project/board"` to `env`.

### 1. Claude Code (Anthropic CLI)

**One-liner via CLI:**

```sh
claude mcp add board -e BOARD_AUTHOR=claude -- node /absolute/path/to/trellis/mcp.mjs
```

*(If you ran `npm link`, you can replace `node /absolute/path/to/trellis/mcp.mjs` with `trellis-mcp`.)*

**Or in `.mcp.json` (project root) / `~/.claude.json` (global):**

```json
{
  "mcpServers": {
    "board": {
      "command": "node",
      "args": ["/absolute/path/to/trellis/mcp.mjs"],
      "env": {
        "BOARD_AUTHOR": "claude"
      }
    }
  }
}
```

### 2. OpenAI Codex CLI

**One-liner via CLI:**

```sh
codex mcp add board --env BOARD_AUTHOR=codex -- node /absolute/path/to/trellis/mcp.mjs
```

**Or in `~/.codex/config.toml`:**

```toml
[mcp_servers.board]
command = "node"
args = ["/absolute/path/to/trellis/mcp.mjs"]
env = { BOARD_AUTHOR = "codex" }
```

### 3. Cursor

Add to `.cursor/mcp.json` in your project root, or `~/.cursor/mcp.json` for global access across all workspaces:

```json
{
  "mcpServers": {
    "board": {
      "command": "node",
      "args": ["/absolute/path/to/trellis/mcp.mjs"],
      "env": {
        "BOARD_AUTHOR": "cursor"
      }
    }
  }
}
```

### 4. Windsurf (Codeium)

Open Windsurf MCP settings or edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "board": {
      "command": "node",
      "args": ["/absolute/path/to/trellis/mcp.mjs"],
      "env": {
        "BOARD_AUTHOR": "windsurf"
      }
    }
  }
}
```

### 5. VS Code / GitHub Copilot (Agent Mode)

Add to `.vscode/mcp.json` in your workspace (or your global VS Code `settings.json` under `mcp.servers`):

```json
{
  "servers": {
    "board": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/trellis/mcp.mjs"],
      "env": {
        "BOARD_AUTHOR": "copilot"
      }
    }
  }
}
```

### 6. Cline / Roo Code (VS Code Extensions)

Open **MCP Servers → Configure MCP Servers** (`cline_mcp_settings.json` or `mcp_settings.json`):

```json
{
  "mcpServers": {
    "board": {
      "command": "node",
      "args": ["/absolute/path/to/trellis/mcp.mjs"],
      "env": {
        "BOARD_AUTHOR": "cline"
      },
      "disabled": false
    }
  }
}
```

### 7. Zed Editor

Add to your Zed `settings.json` (`~/.config/zed/settings.json`):

```json
{
  "context_servers": {
    "board": {
      "command": {
        "path": "node",
        "args": ["/absolute/path/to/trellis/mcp.mjs"],
        "env": {
          "BOARD_AUTHOR": "zed"
        }
      }
    }
  }
}
```

### 8. Continue.dev

Create `.continue/mcpServers/trellis.yaml`:

```yaml
name: Trellis Board
version: 0.1.0
schema: v1
mcpServers:
  - name: board
    command: node
    args:
      - /absolute/path/to/trellis/mcp.mjs
    env:
      BOARD_AUTHOR: continue
```

### 9. Claude Desktop App

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "board": {
      "command": "node",
      "args": ["/absolute/path/to/trellis/mcp.mjs"],
      "env": {
        "BOARD_AUTHOR": "claude-desktop"
      }
    }
  }
}
```

---

## The 11 MCP Tools

Every card and list tool accepts an optional `board` parameter (a remembered slug, board name, or directory path) to target a specific project for a single call, and `board_boards` switches or manages boards across the session.

| Tool | Token Profile | What It Does |
| --- | --- | --- |
| `board_overview` | ~150–300 tokens | **Call first.** Lists every swimlane with open/done counts by kind (`agent`, `human`, `joint`), labels, and the card section template. |
| `board_boards` | ~50–150 tokens | `list`, `switch`, `add`, `init`, or `forget` remembered board directories across all your projects. |
| `board_cards` | ~20 tokens/row | Filter cards by `list`, `kind`, `label`, `status`, `blocked`, `since`, `ids`, or `q` keyword; returns a compact TSV table. |
| `board_card` | Budgeted (`<=4k`) | Read one card, or request specific `sections` (`["What to do", "Steps"]`). Pass `sections: ["meta"]` to preview token sizes per section first. |
| `board_search` | ~25 tokens/hit | Hybrid semantic (local embeddings) + lexical (BM25) search across card chunks, plus `--files` or `§` section filters. |
| `board_card_create` | 1-line ack | Create a card with `kind`, Markdown `sections`, checklist `steps`, `labels`, `blocked_by`, and `siblings`. |
| `board_card_update` | 1-line ack | Patch metadata; `set_sections`, `append` to, or `remove_sections` on individual `## ` headings; mark `done` or `archived`. |
| `board_card_move` | 1-line ack | Move a card to another swimlane and/or position (`top`, `bottom`, `before`, `after`). |
| `board_steps` | 1-line ack | Tick, untick, add, edit, or remove checklist items by 1-based index (`ok #42 r8 Steps 3/5`). |
| `board_comment` | 1-line ack | Append a timestamped author comment (`### 2026-10-17T09:12:33Z claude`). |
| `board_lists` | 1-line ack | Create, rename, reorder, archive, or restore board swimlanes. |

---

## Managing Multiple Projects & Switching Boards

Trellis keeps a lightweight registry in `~/.config/trellis/boards.json` (override with `TRELLIS_REGISTRY`) that remembers every board you initialize, import, or open.

### From the CLI

```sh
trellis boards                        # List all remembered boards (* marks the active board)
trellis use my-project                # Switch active board by slug, name, or path
trellis use ~/development/other-repo  # Register and switch to another repo's board
trellis add ~/development/third-repo  # Remember a board without switching to it
trellis forget old-project            # Remove from registry (leaves files untouched on disk)

# Target another board for a single command without changing the global active board:
trellis -C other-repo overview
trellis --dir ~/development/my-project cards --list "In Progress"
```

### How Trellis Resolves the Active Board

1. Explicit `--dir` / `-C` flag (CLI) or `board` argument (MCP tool call)
2. `TRELLIS_DIR` or `BOARD_DIR` environment variable
3. Active board in `~/.config/trellis/boards.json` (set via `trellis use`, the Web UI switcher, Desktop app, or `board_boards`)
4. Nearest `board/board.yaml` or `board.yaml` walking upward from `process.cwd()`
5. Most recently opened existing board in the registry

### From the Web UI & Desktop App

Click the **Board name button** in the top-left header to open the **Board Switcher**:
- Click any remembered board to switch immediately (hot-swaps the file watcher and SSE stream without restarting the server).
- Browse directories on disk with live path autocomplete to **Open** an existing board, **Create** a new board with custom swimlanes, or **Import** a Trello `.json` export right from the browser.

---

## Command Line Interface (`trellis`)

Every MCP operation has a 1-to-1 CLI twin for terminal workflows and shell scripts:

```sh
trellis boards
trellis use my-project
trellis overview
trellis cards --list "In Progress" --kind agent
trellis cards --q "auth token" --fields id,title,updated
trellis card 42 --sections "What to do,Steps" --comments 0
trellis card 42 --sections meta                    # Approximate token count per section
trellis card 42 --sections "Implementation note"   # Prefix match across dated notes
trellis card 42 --full                             # Bypass the 4k-token section budget
trellis search "how are stale locks handled" --k 8
trellis search --files store.mjs --status all --k 50
trellis reindex
trellis create --title "Add rate limiter" --list Backlog --kind agent --steps "Implement" --steps "Test"
trellis update 42 --append "Implementation note (2026-10-17)=Shipped." --status done
trellis update 42 --set-file "Context=notes.md"
trellis steps 42 --tick 1,2 --add "Verify in staging"
trellis move 42 --list Review --before 19
trellis comment 42 "Ready for review."
trellis lists create --name "QA" --after Review
```

Pass `--json` on any read command for structured JSON output. Run `trellis help` for the complete flag reference.

---

## What a Card File Looks Like on Disk

Cards live in `<board-dir>/cards/<0000-id>-<slug>.md`. You can edit them via MCP, CLI, the Web/Desktop UI, or straight in Vim/VS Code:

````markdown
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
````

---

## Native Desktop App (macOS & Windows)

`desktop/` wraps the Trellis server and Web UI in a native Electron application. It runs the server in-process on a free localhost port, shares `~/.config/trellis/boards.json` with the CLI and MCP server, and fires native OS notifications when agents open, update, complete, or archive cards.

```sh
cd desktop
npm install
npm start                    # Launch Desktop app from source
npm run dist:mac             # Build macOS .dmg and .zip in desktop/dist/
npm run dist:win             # Build Windows installer and .zip
```

The `dist:*` scripts only package the app; they don't launch it. Open the build with `open desktop/dist/mac-arm64/Trellis.app` (or install from the `.dmg`).

- **Keyboard-driven switching**: Use **File → Open Board…** (`⌘O` / `Ctrl+O`), **File → Create Board…** (`⌘N` / `Ctrl+N`), or jump directly between your top boards with `⌘1`–`⌘9`.

---

## Migrating from Trello in 30 Seconds

1. In Trello, open **Board Menu → More → Print and export → Export as JSON**.
2. Run the importer targeting any project directory (or use the **Import** tab in the Web UI Board Switcher):

   ```sh
   trellis import path/to/trello-export.json --dir ~/development/my-project --dry-run
   trellis import path/to/trello-export.json --dir ~/development/my-project
   ```

3. Optional: automatically rewrite `https://trello.com/c/...` card links in your repository's Markdown documentation to point to the local card files:

   ```sh
   trellis -C ~/development/my-project relink --dry-run
   trellis -C ~/development/my-project relink
   ```

Original Trello card numbers (`#207`) and shortlinks survive the import, so visiting `/c/<shortLink>` on the local Trellis web server redirects straight to the migrated card.

---

## Running Tests

```sh
npm test
```

All test suites run in isolated temporary directories and use a deterministic test embedder, so `npm test` completes quickly offline without touching `~/.config/trellis/boards.json`.

## License

Created by [Joshua Auriemma](https://auriemmai.com) under the [MIT License (2026)](LICENSE).
