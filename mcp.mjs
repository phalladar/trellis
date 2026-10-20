#!/usr/bin/env node
// MCP server (stdio) for Trellis. Eleven terse tools over lib/ops.mjs.
// TRELLIS_DIR / BOARD_DIR points at a specific board directory (otherwise resolves from cwd
// or the remembered active board in ~/.config/trellis/boards.json);
// BOARD_AUTHOR names this client in comments (claude, codex, cursor, ...).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CARD_FIELDS } from './lib/format.mjs';
import { DEFAULT_LIMIT, makeOps } from './lib/ops.mjs';
import { defaultRegistryFile, Registry, resolveActiveBoard } from './lib/registry.mjs';
import { MODES } from './lib/search.mjs';
import { Board, KINDS, STATUSES } from './lib/store.mjs';

const kind = z.enum(KINDS);
const status = z.enum(STATUSES);
const id = z.union([z.number().int(), z.string()]).describe('card id, e.g. 207 or "#207"');
const ids = z.array(z.union([z.number().int(), z.string()]));
const format = z.enum(['text', 'json']).optional().describe('text (default, compact) or json');
const boardArg = z.string().optional().describe('board directory, slug or name (default: active board)');
const KIND_HELP = 'kind: agent = an LLM can finish it alone; human = needs the owner (decision, played session, purchase); joint = agent builds, owner decides or approves.';

export async function createBoardServer({
  boardDir = process.env.TRELLIS_DIR || process.env.BOARD_DIR,
  author = process.env.BOARD_AUTHOR || 'agent',
  registry = null,
} = {}) {
  const reg = registry instanceof Registry ? registry : new Registry(typeof registry === 'string' ? registry : defaultRegistryFile());
  const resolved = boardDir
    ? { boardDir: await reg.resolve(boardDir), registry: reg }
    : await resolveActiveBoard({ registry: reg });
  const board = new Board(resolved.boardDir);
  if (await board.exists()) await reg.remember(board.dir, { setCurrent: true, touch: false });
  const ops = makeOps(board, { author, registry: reg });
  const server = new McpServer({ name: 'trellis', version: '0.2.0' });

  const run = fn => async args => {
    try {
      const { text, images = [] } = await fn(args ?? {});
      const content = [{ type: 'text', text }];
      for (const image of images) content.push({ type: 'text', text: `[${image.label}] ${image.path}` }, { type: 'image', data: image.data, mimeType: image.mimeType });
      return { content };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `error: ${error.message}` }] };
    }
  };
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

  server.registerTool('board_overview', {
    description: 'Board summary: every list (swimlane) with open counts by kind and done counts, labels, and the section template. A few hundred tokens. Call this before anything else.',
    inputSchema: { board: boardArg, format },
    annotations: read,
  }, run(ops.overview));

  server.registerTool('board_boards', {
    description: 'List, switch, initialize or forget remembered board directories across projects. Actions: list (default), switch (dir/slug/name), add (dir), init (dir, name, lists), forget (dir/slug/name).',
    inputSchema: {
      action: z.enum(['list', 'switch', 'add', 'init', 'forget']).optional().describe('default list'),
      dir: z.string().optional().describe('directory path, remembered slug or board name'),
      name: z.string().optional().describe('init/add: board display name'),
      lists: z.array(z.string()).optional().describe('init: initial list names'),
      here: z.boolean().optional().describe('init: place board.yaml directly in dir rather than dir/board'),
      format,
    },
    annotations: write,
  }, run(ops.boards));

  server.registerTool('board_cards', {
    description: `List or search cards as a tab-separated table (header row first; "-" = none). Default: open cards, fields ${'id,list,kind,title,steps,blocked'}, ${DEFAULT_LIMIT} rows (~1k tokens). Filter first (list, kind, q, ids); a bare call pages through the whole board. Read bodies with board_card.`,
    inputSchema: {
      board: boardArg,
      list: z.string().optional().describe('list id or name (unique substring ok)'),
      kind: kind.optional(),
      label: z.string().optional(),
      status: z.enum([...STATUSES, 'all']).optional().describe('default open'),
      q: z.string().optional().describe('all words must appear in title or body (case-insensitive)'),
      blocked: z.boolean().optional().describe('only cards with a blocker that is still open'),
      since: z.string().optional().describe('only cards updated at or after this ISO date/time'),
      ids: ids.optional().describe('only these card ids'),
      fields: z.array(z.enum(CARD_FIELDS)).optional().describe(`columns; any of ${CARD_FIELDS.join(', ')}`),
      limit: z.number().int().min(1).max(1000).optional().describe(`default ${DEFAULT_LIMIT}`),
      offset: z.number().int().min(0).optional(),
      format,
    },
    annotations: read,
  }, run(ops.cards));

  server.registerTool('board_card', {
    description: `Read one card: header line, meta, file path, then its sections as markdown (checklists numbered for board_steps) and the last N comments. Narrow with sections, e.g. ["What to do","Steps"]; ["meta"] returns only the header and every section's size. With no sections, a card over ~4k tokens shows its template sections, then elides the rest by name and size; pass full: true for all of it.`,
    inputSchema: {
      board: boardArg,
      id,
      sections: z.array(z.string()).optional().describe('section names, or prefixes matching every section they start (e.g. "Implementation note"); default all, within the size limit'),
      full: z.boolean().optional().describe('with no sections, return every section however large'),
      comments: z.number().int().min(0).optional().describe('how many recent comments; default 3, 0 for none'),
      images: z.boolean().optional().describe('attach images the shown text links to (pasted screenshots); default true'),
      format,
    },
    annotations: read,
  }, run(ops.card));

  server.registerTool('board_search', {
    description: 'Ranked search over cards by meaning and by words: a local embedding of every card section fused with BM25. Returns the top k cards with list, kind, status, the best-matching section, a score relative to the top hit and one excerpt line. files (cited source paths, e.g. ["src/router.ts"]) and section (a § number, e.g. "5.8", exact) are exact filters that also work without a query; list/kind/label/status filter like board_cards, but status defaults to all because done cards hold the decisions. mode lexical needs no model. The first semantic search fetches a ~35 MB model and indexes every card; later searches re-embed only changed cards.',
    inputSchema: {
      board: boardArg,
      query: z.string().optional().describe('a question or phrase; omit to list by filters alone'),
      k: z.number().int().min(1).max(100).optional().describe('default 10'),
      mode: z.enum(MODES).optional().describe('default hybrid'),
      list: z.string().optional().describe('list id or name'),
      kind: kind.optional(),
      label: z.string().optional(),
      status: z.enum([...STATUSES, 'all']).optional().describe('default all'),
      files: z.array(z.string()).optional().describe('keep cards whose text cites any of these paths or names'),
      section: z.string().optional().describe('keep cards citing this § section number, e.g. "5.8"'),
      excerpt: z.number().int().min(0).max(600).optional().describe('excerpt length per hit; default 160, 0 for none'),
      format,
    },
    annotations: read,
  }, run(ops.search));

  server.registerTool('board_card_create', {
    description: `Create a card. Body is markdown sections ("## Heading"); the board's template sections are Context, Why this matters, What to do, Steps, Success criteria, Tests, References. ${KIND_HELP}`,
    inputSchema: {
      board: boardArg,
      title: z.string().min(1).describe('imperative, e.g. "Add the Kiln recipe"'),
      list: z.string().describe('list id or name'),
      kind,
      labels: z.array(z.string()).optional(),
      sections: z.record(z.string()).optional().describe('heading → markdown body'),
      steps: z.array(z.string()).optional().describe('items for the Steps checklist'),
      blocked_by: ids.optional().describe('ids of cards that must finish first'),
      siblings: ids.optional().describe('ids of related cards'),
      position: z.enum(['top', 'bottom']).optional().describe('default bottom'),
      template: z.boolean().optional().describe('also create the empty template sections'),
    },
    annotations: write,
  }, run(ops.create));

  server.registerTool('board_card_update', {
    description: `Patch a card; only the fields you pass change. set_sections replaces or creates whole sections; append adds text to the end of a section (addenda, implementation notes); remove_sections deletes. Pass rev (from board_card) to refuse a stale write. status "done" closes the card. ${KIND_HELP}`,
    inputSchema: {
      board: boardArg,
      id,
      rev: z.number().int().optional().describe('expected current rev; write is refused on mismatch'),
      title: z.string().optional(),
      kind: kind.optional(),
      status: status.optional(),
      labels: z.array(z.string()).optional().describe('replace all labels'),
      add_labels: z.array(z.string()).optional(),
      remove_labels: z.array(z.string()).optional(),
      blocked_by: ids.optional().describe('replace the blocker list'),
      siblings: ids.optional().describe('replace the sibling list'),
      set_sections: z.record(z.string()).optional().describe('heading → new markdown body'),
      append: z.record(z.string()).optional().describe('heading → markdown to append (section is created if missing)'),
      remove_sections: z.array(z.string()).optional(),
      body: z.string().optional().describe('replace the whole description (all sections); comments are kept. Prefer set_sections.'),
    },
    annotations: { ...write, idempotentHint: true },
  }, run(ops.update));

  server.registerTool('board_card_move', {
    description: 'Move a card to another list and/or position. Give list, position (top|bottom), or before/after another card id. Moving to a new list without a position puts it at the bottom.',
    inputSchema: {
      board: boardArg,
      id,
      list: z.string().optional(),
      position: z.enum(['top', 'bottom']).optional(),
      before: id.optional(),
      after: id.optional(),
    },
    annotations: { ...write, idempotentHint: true },
  }, run(ops.move));

  server.registerTool('board_steps', {
    description: 'Edit a checklist (default section "Steps") by 1-based item index as shown by board_card. Tick only when the evidence is confirmed; a step deliberately not done stays unticked with the reason edited into its text.',
    inputSchema: {
      board: boardArg,
      id,
      section: z.string().optional().describe('checklist section; default Steps'),
      tick: z.array(z.number().int().min(1)).optional(),
      untick: z.array(z.number().int().min(1)).optional(),
      edit: z.array(z.object({ index: z.number().int().min(1), text: z.string() })).optional(),
      remove: z.array(z.number().int().min(1)).optional(),
      add: z.array(z.string()).optional().describe('appended as unticked items'),
      rev: z.number().int().optional(),
    },
    annotations: write,
  }, run(ops.steps));

  server.registerTool('board_comment', {
    description: `Add a comment to a card. Author defaults to "${author}" (BOARD_AUTHOR).`,
    inputSchema: { board: boardArg, id, text: z.string().min(1), author: z.string().optional() },
    annotations: write,
  }, run(ops.comment));

  server.registerTool('board_lists', {
    description: 'Manage lists (swimlanes): create (name, optional position/before/after), rename (list, new_name), move (list, position|before|after), archive, restore (list).',
    inputSchema: {
      board: boardArg,
      action: z.enum(['create', 'rename', 'move', 'archive', 'restore']),
      name: z.string().optional().describe('create: the new list name'),
      list: z.string().optional().describe('rename/move/archive/restore: list id or name'),
      new_name: z.string().optional(),
      position: z.enum(['top', 'bottom']).optional(),
      before: z.string().optional().describe('list id or name'),
      after: z.string().optional().describe('list id or name'),
    },
    annotations: write,
  }, run(ops.lists));

  return server;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const server = await createBoardServer();
  await server.connect(new StdioServerTransport());
}
