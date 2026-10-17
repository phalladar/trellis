#!/usr/bin/env node
// Command line for Trellis, for agents with a shell and for people. Mirrors the MCP tools
// and adds multi-board directory management (boards, use/switch, add, forget, serve, mcp).
//   trellis overview
//   trellis boards
//   trellis use my-project
//   trellis cards --list "Backlog" --kind joint
//   trellis card 207 --sections "What to do,Steps"
//   trellis steps 207 --tick 1,2 --add "Review in app"
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { importTrelloExport } from './import_trello.mjs';
import { createEmbedder } from './lib/embedder.mjs';
import { makeOps } from './lib/ops.mjs';
import {
  defaultActivityDir, defaultRegistryFile, normalizeBoardDir,
  projectRootFor, Registry, resolveActiveBoard, targetBoardDir,
} from './lib/registry.mjs';
import { SearchIndex } from './lib/search.mjs';
import { Board, DEFAULT_TEMPLATE } from './lib/store.mjs';
import { createBoardServer as createMcpServer } from './mcp.mjs';
import { relink } from './relink_trello.mjs';
import { createBoardServer as createWebServer } from './server.mjs';

const USAGE = `trellis — local markdown kanban for LLM agents and humans

usage: trellis <command> [options]     (--dir / -C, TRELLIS_DIR / BOARD_DIR, BOARD_AUTHOR override defaults)

  boards [--json]                                list remembered boards across projects (* = active)
  use <dir|slug|name>                            switch the active board to a directory or remembered slug
  add <dir> [--name NAME]                        remember an existing board directory
  forget <dir|slug|name>                         remove a board from the remembered list (keeps files)
  init [dir] [--name NAME] [--lists "A,B,C"] [--here]
  import <trello-export.json> [dir] [--name NAME] [--dry-run] [--here]
  relink [--dry-run] [--all] [file|dir ...]      rewrite trello.com card links in docs to board cards
  serve [--port 8766] [--dir DIR]                run the local web UI on http://127.0.0.1:8766/
  mcp [--dir DIR]                                run the stdio MCP server
  overview [--json]
  cards [--list L] [--kind K] [--label L] [--status open|done|archived|all] [--q "words"]
        [--blocked] [--since ISO] [--ids 1,2] [--fields id,list,...] [--limit N (default 30)] [--offset N] [--json]
  card <id> [--sections "A,B"] [--full] [--comments N] [--json]
        a card over ~4k tokens shows its template sections and elides the rest unless --full;
        a section name may be a prefix; --sections meta lists the sections with their sizes
  search "query" [--k N] [--mode hybrid|semantic|lexical] [--list L] [--kind K] [--label L] [--status S|all]
         [--files a.ts,b.ts] [--section 5.8] [--excerpt N] [--json]     ranked by meaning and words; filters alone list citing cards
  reindex [--force] [--lexical] [--json]         build the search index (fetches the model on first run)
  create --title T --list L --kind agent|human|joint [--labels a,b] [--steps "x" --steps "y"]
         [--section "Name=body"]... [--section-file "Name=path"]... [--blocked-by 1,2] [--siblings 3] [--top] [--template]
  update <id> [--rev N] [--title T] [--kind K] [--status S] [--labels a,b] [--add-labels a] [--remove-labels b]
         [--blocked-by 1,2] [--siblings 3] [--set "Name=body"]... [--set-file "Name=path"]...
         [--append "Name=text"]... [--append-file "Name=path"]... [--remove-section Name]... [--body-file path]
  move <id> [--list L] [--top|--bottom|--before ID|--after ID]
  steps <id> [--section Name] [--tick 1,2] [--untick 3] [--edit "3=new text"]... [--remove 4] [--add "text"]...
  comment <id> "text" [--author NAME]
  lists <create|rename|move|archive|restore> [--name N] [--list L] [--new-name N] [--top|--bottom|--before L|--after L]
`;

const csv = value => (value === undefined ? undefined : String(value).split(',').map(entry => entry.trim()).filter(Boolean));
const numbers = value => csv(value)?.map(Number);
const pairs = async (values, fromFile) => {
  if (!values) return undefined;
  const out = {};
  for (const value of values) {
    const index = value.indexOf('=');
    if (index < 0) throw new Error(`expected Name=value, got "${value}"`);
    const name = value.slice(0, index).trim();
    const rest = value.slice(index + 1);
    out[name] = fromFile ? await readFile(rest.trim(), 'utf8') : rest;
  }
  return out;
};

// Extract global `--dir` / `-C` / `--board` before command dispatch so `trellis -C foo overview`
// and `trellis overview --dir foo` both work.
function extractGlobalDir(argv) {
  const out = [];
  let dir;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--dir' || arg === '-C' || arg === '--board') && i + 1 < argv.length) {
      dir = argv[++i];
    } else if (arg.startsWith('--dir=')) {
      dir = arg.slice('--dir='.length);
    } else if (arg.startsWith('--board=')) {
      dir = arg.slice('--board='.length);
    } else {
      out.push(arg);
    }
  }
  return { dir, args: out };
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env, cwd = process.cwd() } = {}) {
  const { dir: globalDir, args } = extractGlobalDir(argv);
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help' || command === '-h') { stdout.write(USAGE); return 0; }

  const registry = new Registry(defaultRegistryFile(env));
  const { boardDir } = await resolveActiveBoard({ dir: globalDir, cwd, env, registry });
  const author = env.BOARD_AUTHOR || 'agent';
  const board = new Board(boardDir);
  if (await board.exists()) {
    await registry.remember(board.dir, { setCurrent: !registry.current, touch: false });
  }
  const ops = makeOps(board, {
    author,
    registry,
    search: new SearchIndex(board, { embedder: () => createEmbedder({ quiet: false }) }),
    embedder: () => createEmbedder({ quiet: false }),
  });
  const parse = (options, allowPositionals = true) => parseArgs({ args: rest, options: { json: { type: 'boolean' }, ...options }, allowPositionals });
  const emit = result => stdout.write(`${result.text}\n`);
  const string = { type: 'string' };
  const many = { type: 'string', multiple: true };
  const flag = { type: 'boolean' };

  try {
    switch (command) {
      case 'boards':
      case 'list-boards': {
        const { values } = parse({});
        emit(await ops.boards({ action: 'list', format: values.json ? 'json' : 'text' }));
        return 0;
      }
      case 'use':
      case 'switch': {
        const { positionals } = parse({});
        const target = positionals[0] || globalDir;
        if (!target) throw new Error('use needs a directory path, slug or board name');
        const entry = await registry.switch(target, { cwd });
        stdout.write(`ok active board "${entry.name}" (${entry.slug}) at ${entry.dir}\n`);
        return 0;
      }
      case 'add': {
        const { values, positionals } = parse({ name: string });
        const target = positionals[0] || globalDir || cwd;
        const valid = normalizeBoardDir(path.resolve(cwd, target));
        if (!valid) throw new Error(`no board at "${target}" (missing board.yaml); run "trellis init" first`);
        const entry = await registry.remember(valid, { name: values.name, setCurrent: !registry.current, touch: true });
        stdout.write(`ok remembered "${entry.name}" (${entry.slug}) at ${entry.dir}\n`);
        return 0;
      }
      case 'forget':
      case 'remove': {
        const { positionals } = parse({});
        const target = positionals[0] || globalDir;
        if (!target) throw new Error('forget needs a directory path, slug or board name');
        const entry = await registry.forget(target, { cwd });
        stdout.write(`ok forgot "${entry.name}" (${entry.slug}) at ${entry.dir}\n`);
        return 0;
      }
      case 'init': {
        const { values, positionals } = parse({ name: string, lists: string, here: flag });
        const explicitTarget = positionals[0] || globalDir || env.TRELLIS_DIR || env.BOARD_DIR;
        const target = explicitTarget
          ? (positionals[0] || globalDir ? targetBoardDir(path.resolve(cwd, explicitTarget), { here: values.here }) : path.resolve(cwd, explicitTarget))
          : targetBoardDir(cwd, { here: values.here });
        const name = values.name || path.basename(projectRootFor(target)) || 'Board';
        await Board.init(target, { name, lists: csv(values.lists) || [], template: DEFAULT_TEMPLATE });
        const entry = await registry.remember(target, { name, setCurrent: true, touch: true });
        stdout.write(`ok board created at ${target} (${entry.slug})\n`);
        return 0;
      }
      case 'import': {
        const { values, positionals } = parse({ name: string, 'dry-run': flag, here: flag });
        if (!positionals[0]) throw new Error('import needs the path to a Trello JSON export');
        const explicitTarget = positionals[1] || globalDir || env.TRELLIS_DIR || env.BOARD_DIR;
        const target = explicitTarget
          ? (positionals[1] || globalDir ? targetBoardDir(path.resolve(cwd, explicitTarget), { here: values.here }) : path.resolve(cwd, explicitTarget))
          : boardDir;
        const report = await importTrelloExport(positionals[0], target, { name: values.name, dryRun: values['dry-run'] });
        if (!values['dry-run']) {
          await registry.remember(target, { name: report.plan.name, setCurrent: true, touch: true });
        }
        stdout.write(`${report.text}\n`);
        return 0;
      }
      case 'relink': {
        const { values, positionals } = parse({ 'dry-run': flag, all: flag });
        stdout.write(`${(await relink({ boardDir, root: projectRootFor(boardDir), targets: positionals.length ? positionals : undefined, all: values.all, dryRun: values['dry-run'] })).text}\n`);
        return 0;
      }
      case 'serve': {
        const { values } = parse({ port: string });
        const port = Number(values.port || env.TRELLIS_PORT || env.BOARD_PORT || 8766);
        const server = createWebServer({ boardDir, registry, activityDir: defaultActivityDir(env) });
        if (await server.board.exists()) await registry.remember(server.board.dir, { setCurrent: true });
        await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
        stdout.write(`Trellis: http://127.0.0.1:${port}/  (board: ${server.board.dir})\n`);
        return 0;
      }
      case 'mcp': {
        const server = await createMcpServer({ boardDir, author, registry });
        await server.connect(new StdioServerTransport());
        return 0;
      }
      case 'overview': {
        const { values } = parse({});
        emit(await ops.overview({ format: values.json ? 'json' : 'text' }));
        return 0;
      }
      case 'cards': {
        const { values } = parse({ list: string, kind: string, label: string, status: string, q: string, blocked: flag, since: string, ids: string, fields: string, limit: string, offset: string });
        emit(await ops.cards({ list: values.list, kind: values.kind, label: values.label, status: values.status, q: values.q, blocked: values.blocked, since: values.since, ids: csv(values.ids), fields: csv(values.fields), limit: values.limit ? Number(values.limit) : undefined, offset: values.offset ? Number(values.offset) : 0, format: values.json ? 'json' : 'text' }));
        return 0;
      }
      case 'card': {
        const { values, positionals } = parse({ sections: string, comments: string, full: flag });
        emit(await ops.card({ id: positionals[0], sections: csv(values.sections), full: values.full, comments: values.comments === undefined ? 3 : Number(values.comments), format: values.json ? 'json' : 'text' }));
        return 0;
      }
      case 'create': {
        const { values } = parse({ title: string, list: string, kind: string, labels: string, steps: many, section: many, 'section-file': many, 'blocked-by': string, siblings: string, top: flag, template: flag });
        emit(await ops.create({ title: values.title, list: values.list, kind: values.kind, labels: csv(values.labels), steps: values.steps, sections: { ...(await pairs(values.section)), ...(await pairs(values['section-file'], true)) }, blocked_by: csv(values['blocked-by']), siblings: csv(values.siblings), position: values.top ? 'top' : 'bottom', template: values.template }));
        return 0;
      }
      case 'update': {
        const { values, positionals } = parse({ rev: string, title: string, kind: string, status: string, labels: string, 'add-labels': string, 'remove-labels': string, 'blocked-by': string, siblings: string, set: many, 'set-file': many, append: many, 'append-file': many, 'remove-section': many, 'body-file': string });
        const setSections = { ...(await pairs(values.set)), ...(await pairs(values['set-file'], true)) };
        const appendSections = { ...(await pairs(values.append)), ...(await pairs(values['append-file'], true)) };
        emit(await ops.update({
          id: positionals[0], rev: values.rev ? Number(values.rev) : undefined, title: values.title, kind: values.kind, status: values.status,
          labels: csv(values.labels), add_labels: csv(values['add-labels']), remove_labels: csv(values['remove-labels']),
          blocked_by: csv(values['blocked-by']), siblings: csv(values.siblings),
          set_sections: Object.keys(setSections).length ? setSections : undefined,
          append: Object.keys(appendSections).length ? appendSections : undefined,
          remove_sections: values['remove-section'], body: values['body-file'] ? await readFile(values['body-file'], 'utf8') : undefined,
        }));
        return 0;
      }
      case 'move': {
        const { values, positionals } = parse({ list: string, top: flag, bottom: flag, before: string, after: string });
        emit(await ops.move({ id: positionals[0], list: values.list, position: values.top ? 'top' : values.bottom ? 'bottom' : undefined, before: values.before, after: values.after }));
        return 0;
      }
      case 'steps': {
        const { values, positionals } = parse({ section: string, tick: string, untick: string, edit: many, remove: string, add: many, rev: string });
        const edit = values.edit?.map(entry => { const index = entry.indexOf('='); if (index < 0) throw new Error(`--edit expects "index=text", got "${entry}"`); return { index: Number(entry.slice(0, index)), text: entry.slice(index + 1) }; });
        emit(await ops.steps({ id: positionals[0], section: values.section, tick: numbers(values.tick), untick: numbers(values.untick), edit, remove: numbers(values.remove), add: values.add, rev: values.rev ? Number(values.rev) : undefined }));
        return 0;
      }
      case 'comment': {
        const { values, positionals } = parse({ author: string });
        emit(await ops.comment({ id: positionals[0], text: positionals.slice(1).join(' '), author: values.author }));
        return 0;
      }
      case 'lists': {
        const { values, positionals } = parse({ name: string, list: string, 'new-name': string, top: flag, bottom: flag, before: string, after: string });
        emit(await ops.lists({ action: positionals[0], name: values.name, list: values.list, new_name: values['new-name'], position: values.top ? 'top' : values.bottom ? 'bottom' : undefined, before: values.before, after: values.after }));
        return 0;
      }
      case 'search': {
        const { values, positionals } = parse({ k: string, mode: string, list: string, kind: string, label: string, status: string, files: string, section: string, excerpt: string });
        emit(await ops.search({ query: positionals.join(' '), k: values.k ? Number(values.k) : undefined, mode: values.mode, list: values.list, kind: values.kind, label: values.label, status: values.status, files: csv(values.files), section: values.section, excerpt: values.excerpt === undefined ? undefined : Number(values.excerpt), format: values.json ? 'json' : 'text' }));
        return 0;
      }
      case 'reindex': {
        const { values } = parse({ force: flag, lexical: flag });
        emit(await ops.reindex({ force: values.force, lexical: values.lexical, format: values.json ? 'json' : 'text' }));
        return 0;
      }
      default:
        stderr.write(`unknown command "${command}"\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    stderr.write(`error: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
