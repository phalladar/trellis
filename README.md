# Trellis

**Trellis** is a local-first kanban board built for LLM agents and humans: cards are plain Markdown files in git, the web UI runs on `127.0.0.1`, a native desktop app wraps it for macOS and Windows, and an MCP server plus a CLI expose the same eleven operations with the smallest token footprint that still gets the job done.

Trellis can target **any directory** on your machine, remembers every board you open or initialize in `~/.config/trellis/boards.json`, and lets you switch between projects in one click or one command.

See [DESIGN.md](DESIGN.md) for the architecture and file format.

---

## Features

- **Plain Markdown in Git**: One card is one file (`board/cards/0042-card-slug.md`) with YAML front matter and `## ` Markdown sections. Diffable, greppable, branchable, and readable without tooling.
- **Multi-Board Directory Manager**: Target any repository or standalone directory (`trellis -C ~/code/my-app ...`), remember boards automatically, and switch between them from the CLI (`trellis use <slug|path>`), the Web UI header switcher, the Desktop app (`⌘1`–`⌘9`), or the MCP server (`board_boards`).
- **Token-Lean Agent Surface**:
  - Read only the sections you need (`sections: ["What to do", "Steps"]`) or inspect section token sizes first (`sections: ["meta"]`).
  - Partial writes (`board_steps`, `board_card_update` with section `append` / `set_sections`) return a one-line acknowledgement (`ok #42 r8 Steps 3/5`) instead of echoing the full card.
  - Optimistic concurrency via per-card `rev` counters and atomic lockfiles (`board/.lock`).
- **Hybrid Semantic + Lexical Search**: Section-level chunking with BM25 + local CPU embeddings (`Xenova/bge-small-en-v1.5` via `@huggingface/transformers`), cached incrementally per card hash in `board/.search/index.json`.
- **Card Kinds**: First-class visual and filter distinction between `agent` (autonomous LLM work), `human` (owner decisions/spikes), and `joint` (agent builds, human reviews).
- **Live Web UI & Electron Desktop App**: Drag-and-drop lanes and cards, inline section Markdown editors, live SSE updates when agents write on disk, per-card merged activity feed (bell) with "what changed" diff banners, and native OS notifications.
- **Trello Importer**: One-command migration from a Trello JSON export (`trellis import export.json`), preserving card `#id` numbers, shortlinks, lists, checklists, and comments.

---

## Quick Start

Requires **Node.js 22+**.

```sh
git clone https://github.com/joshauriemma/trellis.git
cd trellis
npm install

# Optional: link the `trellis` binary globally
npm link
```

### Initialize or open a board in any directory

```sh
# Create a new board in any project repository (creates <repo>/board/board.yaml)
trellis init ~/development/my-project --name "My Project" --lists "Backlog,In Progress,Review,Done"

# Or initialize right in the target directory itself (without a board/ subfolder)
trellis init ~/notes/roadmap --here --name "Roadmap"

# Start the local Web UI (http://127.0.0.1:8766/)
trellis serve
```

`TRELLIS_PORT` (or `BOARD_PORT`) changes the port. `TRELLIS_DIR` (or `BOARD_DIR`) pins a specific board directory via environment variable.

---

## Managing & Switching Between Boards

Trellis remembers every board you initialize, import, or open in `~/.config/trellis/boards.json` (override with `TRELLIS_REGISTRY`).

### From the CLI

```sh
trellis boards                        # List all remembered boards (* marks the active board)
trellis use my-project                # Switch active board by slug, name, or path
trellis use ~/development/other-repo  # Register and switch to another repo's board
trellis add ~/development/third-repo  # Remember a board without switching to it
trellis forget old-project            # Remove a board from the remembered list (keeps files on disk)

# Target a specific board for a single command without changing the active board:
trellis -C other-repo overview
trellis --dir ~/development/my-project cards
```

### How Trellis resolves the active board

1. Explicit `--dir` / `-C` flag (CLI) or `board` argument (MCP tool call)
2. `TRELLIS_DIR` or `BOARD_DIR` environment variable
3. The active board in `~/.config/trellis/boards.json` (set via `trellis use`, the Web UI switcher, or `board_boards`)
4. Nearest `board/board.yaml` or `board.yaml` walking upward from the current working directory
5. Most recently opened existing board in the registry

### From the Web UI

Click the **Board name button** in the top-left header to open the **Board Switcher**:
- Click any remembered board to switch immediately (live-reloads the board and SSE stream without restarting the server).
- Browse directories on disk with live path autocomplete to **Open** an existing board, **Create** a new board (with custom lists), or **Import** a Trello `.json` export directly from the browser.

---

## Connect an Agent (MCP)

All MCP clients run the stdio server `mcp.mjs`. Set `BOARD_AUTHOR` to identify the agent in card comments and the activity feed.

### Claude Code (`.mcp.json`)

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

### Cursor (`.cursor/mcp.json`)

Same JSON structure as above, placed in `.cursor/mcp.json` or configured globally in Cursor settings.

### Codex (`~/.codex/config.toml`)

```sh
codex mcp add board --env BOARD_AUTHOR=codex -- node /absolute/path/to/trellis/mcp.mjs
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.board]
command = "node"
args = ["/absolute/path/to/trellis/mcp.mjs"]
env = { BOARD_AUTHOR = "codex" }
```

### MCP Tools

Every card/list tool also accepts an optional `board` parameter (a remembered slug, board name, or directory path) to target a specific board for that call, and `board_boards` switches or manages remembered boards across the session.

| Tool | Description |
| --- | --- |
| `board_boards` | `list`, `switch`, `add`, `init`, or `forget` remembered board directories. |
| `board_overview` | Lists with open/done counts by kind, labels, and card section template. Call first. |
| `board_cards` | Filter or search cards; returns a tab-separated table (30 rows/page by default). |
| `board_card` | Read one card, or specific sections (`sections: ["meta"]` sizes every section). |
| `board_search` | Rank cards by hybrid semantic + lexical search, plus exact file or `§` section filters. |
| `board_card_create` | Create a card with kind, sections, checklist steps, labels, and relations. |
| `board_card_update` | Patch metadata; set, append, or remove individual sections; close or reopen. |
| `board_card_move` | Move a card to another list and/or position (`top`, `bottom`, `before`, `after`). |
| `board_steps` | Tick, untick, add, edit, or remove checklist items by 1-based index. |
| `board_comment` | Append a timestamped comment. |
| `board_lists` | Create, rename, move, archive, or restore lists. |

---

## Command Line Interface

Every MCP tool has a CLI twin:

```sh
trellis boards
trellis use my-project
trellis overview
trellis cards --list "In Progress" --kind agent
trellis cards --q "auth token" --fields id,title,updated
trellis card 42 --sections "What to do,Steps" --comments 0
trellis card 42 --sections meta                    # approximate token count per section
trellis card 42 --sections "Implementation note"   # prefix match across dated notes
trellis card 42 --full                             # bypass the 4k-token section budget
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

Pass `--json` on read commands for structured JSON output. Run `trellis help` for the full reference.

---

## Desktop App (Electron)

`desktop/` wraps the Trellis server and Web UI in a native Electron app for macOS and Windows. It runs the server in-process on a free localhost port, shares the same `~/.config/trellis/boards.json` registry as the CLI and MCP server, and raises native OS notifications when cards are opened, closed, or archived by agents.

```sh
cd desktop
npm install
npm start                    # Run from source
npm run dist:mac             # Build macOS .dmg and .zip in desktop/dist/
npm run dist:win             # Build Windows installer and .zip
```

- **Switch boards quickly**: Use the top-left Board Switcher in the window, **File → Open Board Folder…** (`⌘O` / `Ctrl+O`), or **File → Switch Board** (`⌘1`–`⌘9`).
- **Initialize on open**: Opening a folder that does not yet have a board offers to initialize one in `<folder>/board` right from the dialog.

---

## Importing from Trello

1. In Trello, open the board menu → **More** → **Print and export** → **Export as JSON**.
2. Run the importer targeting any directory (or import directly from the Web UI's Board Switcher):

   ```sh
   trellis import path/to/trello-export.json --dir ~/development/my-project --dry-run
   trellis import path/to/trello-export.json --dir ~/development/my-project
   ```

3. Optional: rewrite `https://trello.com/c/...` card links in your project's Markdown docs so they point to the local card files:

   ```sh
   trellis -C ~/development/my-project relink --dry-run
   trellis -C ~/development/my-project relink
   ```

Card numbers (`#207`) and Trello shortlinks survive the import, so `/c/<shortLink>` on the local web server redirects straight to the imported card.

---

## Tests

```sh
npm test
```

## License

[MIT](LICENSE)
