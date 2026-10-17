// Local web UI and JSON API for Trellis. Binds to 127.0.0.1 only. Pushes a
// server-sent event whenever a card file or board.yaml changes on disk, so edits
// made by an agent through the MCP server or the CLI appear in the browser at once.
// Supports switching between any board directory on disk and remembers them in the registry.
import { createReadStream, existsSync, watch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTrelloData, importTrelloExport } from './import_trello.mjs';
import { Activity, activityFileFor } from './lib/activity.mjs';
import { relativeFile } from './lib/format.mjs';
import {
  defaultActivityDir, defaultRegistryFile, normalizeBoardDir,
  projectRootFor, Registry, resolveActiveBoard, targetBoardDir,
} from './lib/registry.mjs';
import { Board, BoardError, DEFAULT_TEMPLATE, KINDS, STATUSES, summarize } from './lib/store.mjs';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BOARD_DIR = path.resolve(APP_DIR, 'board');
const HOST = '127.0.0.1';
const BODY_LIMIT = 15_000_000;
// A change to a card the web UI wrote this recently is the owner's own: recorded in the
// feed, but already read, so it never badges.
const OWN_MS = 5000;
// Resolved through Node rather than a fixed node_modules path, so the desktop app
// (desktop/), which bundles this server beside its own dependencies, finds it too.
const MARKED_FILE = fileURLToPath(import.meta.resolve('marked'));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };

function json(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(text);
}

function statusFor(error) {
  switch (error.code) {
    case 'not_found': return 404;
    case 'conflict':
    case 'exists': return 409;
    case 'locked': return 423;
    case 'no_board': return 503;
    default: return error instanceof BoardError ? 400 : 500;
  }
}

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new BoardError('too_large', 'request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new BoardError('bad_json', 'request body is not JSON'); }
}

async function serveFile(response, file) {
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  createReadStream(file).pipe(response);
}

function inside(base, relative) {
  const resolved = path.resolve(base, `.${relative}`);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) throw new BoardError('forbidden', 'path outside app');
  return resolved;
}

function expandHome(input) {
  const raw = String(input || '').trim();
  if (!raw || raw === '~') return homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(homedir(), raw.slice(2));
  return path.resolve(raw);
}

// `activityFile` keeps the activity feed across restarts; without one it lives in memory
// unless `activityDir` is provided (which creates one activity file per board directory).
export function createBoardServer({
  boardDir = DEFAULT_BOARD_DIR,
  appDir = APP_DIR,
  author = 'owner',
  activityFile = null,
  activityDir = null,
  registry = null,
} = {}) {
  const reg = registry instanceof Registry ? registry : new Registry(typeof registry === 'string' ? registry : null);
  const initialBoardDir = path.resolve(boardDir);
  let board = new Board(initialBoardDir);
  let root = projectRootFor(board.dir);
  const clients = new Set();
  let watchers = [];
  let debounce = null;
  const resolveActivityFile = dir => {
    if (activityFile && path.resolve(dir) === initialBoardDir) return activityFile;
    if (activityDir) return activityFileFor(dir, activityDir);
    return null;
  };
  let activity = new Activity(resolveActivityFile(board.dir));
  let activityLoaded = activity.load();
  const ownWrites = new Map();
  let recording = Promise.resolve();
  let started = false;
  let listening = false;

  function broadcast(event) {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(payload);
  }

  const own = id => { ownWrites.set(Number(id), Date.now()); };

  function stopWatching() {
    clearTimeout(debounce);
    debounce = null;
    for (const watcher of watchers) watcher.close();
    watchers = [];
  }

  // One diff at a time, so two quick changes never compare against the same fingerprint.
  // An in-process host hears each as an 'activity' event on the server (Trellis desktop raises
  // its notifications and sets its dock badge from it); `startup` marks the first diff, which
  // holds what changed while nothing was watching.
  function recordActivity() {
    const currentBoard = board;
    const currentActivity = activity;
    const currentLoaded = activityLoaded;
    recording = recording.then(async () => {
      if (currentBoard !== board) return;
      if (!(await currentBoard.exists())) return;
      await currentLoaded;
      const now = Date.now();
      for (const [id, at] of ownWrites) if (now - at > OWN_MS) ownWrites.delete(id);
      const touched = currentActivity.record(await currentBoard.all(), { now, own: new Set(ownWrites.keys()) });
      const startup = !started;
      started = true;
      if (touched.length || startup) await currentActivity.save();
      server.emit('activity', { touched, startup, unread: currentActivity.unread() });
    }).catch(() => { /* a card caught mid-write; the next change event reads it whole */ });
    return recording;
  }

  async function activityChanged() {
    await activity.save();
    broadcast({ type: 'activity', at: Date.now() });
    server.emit('activity', { touched: [], startup: false, unread: activity.unread() });
  }

  function startWatching() {
    stopWatching();
    const notify = () => {
      clearTimeout(debounce);
      debounce = setTimeout(async () => { await recordActivity(); broadcast({ type: 'change', at: Date.now() }); }, 120);
    };
    recordActivity();
    board.exists().then(exists => {
      if (exists) reg.remember(board.dir, { setCurrent: true, touch: false }).catch(() => {});
    });
    for (const target of [board.cardsDir, board.dir]) {
      try { watchers.push(watch(target, { persistent: false }, notify)); } catch { /* the directory may not exist yet */ }
    }
  }

  async function switchTo(nextDir, { remember = true, name } = {}) {
    const resolved = normalizeBoardDir(nextDir) || path.resolve(nextDir);
    stopWatching();
    board = new Board(resolved);
    root = projectRootFor(board.dir);
    activity = new Activity(resolveActivityFile(board.dir));
    activityLoaded = activity.load();
    ownWrites.clear();
    started = false;
    server.board = board;
    server.activity = activity;
    let entry = null;
    if (remember && (await board.exists())) {
      entry = await reg.remember(board.dir, { name, setCurrent: true, touch: true });
    }
    if (listening) startWatching();
    server.emit('board', { boardDir: board.dir, root, name: entry?.name });
    broadcast({ type: 'board', dir: board.dir, root, name: entry?.name, at: Date.now() });
    broadcast({ type: 'change', at: Date.now() });
    return entry;
  }

  const fullCard = card => ({ ...summarize(card), file: relativeFile(card, root), preamble: card.preamble, sections: card.sections, commentList: card.comments });

  const routes = {
    async 'GET /api/board'() {
      if (!(await board.exists())) {
        return {
          empty: true,
          dir: board.dir,
          root,
          name: path.basename(root) || 'Board',
          lists: [],
          labels: [],
          template: DEFAULT_TEMPLATE,
          totals: { open: 0, done: 0, archived: 0, kinds: Object.fromEntries(KINDS.map(k => [k, 0])), blocked: 0 },
          kinds: KINDS,
          statuses: STATUSES,
        };
      }
      const overview = await board.overview();
      return { ...overview, dir: board.dir, root, kinds: KINDS, statuses: STATUSES };
    },
    async 'GET /api/boards'() {
      if (await board.exists()) await reg.remember(board.dir, { setCurrent: true, touch: false });
      const listed = await reg.list({ includeStats: true });
      return { ...listed, current: board.dir, root };
    },
    async 'POST /api/boards/select'(_url, _id, body) {
      const target = body.dir ? expandHome(body.dir) : null;
      if (!target) throw new BoardError('bad_board', 'a directory, slug or board name is required');
      const entry = await reg.switch(body.dir);
      await switchTo(entry.dir, { remember: false });
      const listed = await reg.list({ includeStats: true });
      return { ...listed, current: board.dir, root, selected: entry };
    },
    async 'POST /api/boards/init'(_url, _id, body) {
      const baseDir = body.dir ? expandHome(body.dir) : root;
      const target = targetBoardDir(baseDir, { here: Boolean(body.here) });
      const rawLists = Array.isArray(body.lists)
        ? body.lists
        : String(body.lists ?? 'Backlog, Next, Doing, Done').split(',').map(s => s.trim()).filter(Boolean);
      const name = String(body.name || path.basename(projectRootFor(target)) || 'Board').trim();
      await Board.init(target, { name, lists: rawLists });
      const entry = await switchTo(target, { remember: true, name });
      const listed = await reg.list({ includeStats: true });
      return { ...listed, current: board.dir, root, created: entry };
    },
    async 'POST /api/boards/import'(_url, _id, body) {
      const baseDir = body.dir ? expandHome(body.dir) : root;
      const target = targetBoardDir(baseDir, { here: Boolean(body.here) });
      let report;
      if (body.data && typeof body.data === 'object') {
        report = await importTrelloData(body.data, target, { name: body.name });
      } else if (body.file) {
        report = await importTrelloExport(expandHome(body.file), target, { name: body.name });
      } else {
        throw new BoardError('bad_import', 'import requires Trello export JSON in "data" or a path in "file"');
      }
      const entry = await switchTo(target, { remember: true, name: report.plan.name });
      const listed = await reg.list({ includeStats: true });
      return { ...listed, current: board.dir, root, imported: entry, report: report.text };
    },
    async 'POST /api/boards/forget'(_url, _id, body) {
      if (!body.dir) throw new BoardError('bad_board', 'a board directory or slug is required');
      const removed = await reg.forget(body.dir);
      if (removed.dir === board.dir && reg.current && reg.current !== board.dir && normalizeBoardDir(reg.current)) {
        await switchTo(reg.current, { remember: false });
      }
      const listed = await reg.list({ includeStats: true });
      return { ...listed, current: board.dir, root, removed };
    },
    async 'GET /api/fs/dirs'(url) {
      const raw = url.searchParams.get('path') || root || homedir();
      const target = expandHome(raw);
      let baseDir = target;
      let prefix = '';
      try {
        const info = await stat(target);
        if (!info.isDirectory()) {
          baseDir = path.dirname(target);
          prefix = path.basename(target).toLowerCase();
        }
      } catch {
        baseDir = path.dirname(target);
        prefix = path.basename(target).toLowerCase();
      }
      const entries = await readdir(baseDir, { withFileTypes: true }).catch(() => []);
      const dirs = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') && !prefix.startsWith('.')) continue;
        if (prefix && !entry.name.toLowerCase().startsWith(prefix)) continue;
        const full = path.join(baseDir, entry.name);
        const existingBoard = normalizeBoardDir(full);
        dirs.push({ name: entry.name, path: full, hasBoard: Boolean(existingBoard), boardDir: existingBoard });
      }
      dirs.sort((a, b) => Number(b.hasBoard) - Number(a.hasBoard) || a.name.localeCompare(b.name));
      return {
        base: baseDir,
        parent: path.dirname(baseDir) !== baseDir ? path.dirname(baseDir) : null,
        hasBoard: Boolean(normalizeBoardDir(baseDir)),
        boardDir: normalizeBoardDir(baseDir),
        dirs: dirs.slice(0, 60),
      };
    },
    async 'GET /api/cards'(url) {
      if (!(await board.exists())) return [];
      const params = url.searchParams;
      const cards = await board.query({
        status: params.get('status') || 'all', list: params.get('list') || undefined, kind: params.get('kind') || undefined,
        label: params.get('label') || undefined, q: params.get('q') || undefined, blocked: params.get('blocked') === '1', since: params.get('since') || undefined,
      });
      return cards.map(summarize);
    },
    async 'GET /api/cards/:id'(url, id) {
      const [card] = await board.query({ ids: [id], status: 'all' });
      if (!card) throw new BoardError('not_found', `card #${id} not found`);
      return fullCard(card);
    },
    async 'POST /api/cards'(url, _id, body) { const card = await board.create(body); own(card.id); return fullCard(card); },
    async 'PATCH /api/cards/:id'(url, id, body) {
      const { rev, ...patch } = body;
      own(id);
      await board.update(id, patch, { rev });
      return fullCard((await board.query({ ids: [id], status: 'all' }))[0]);
    },
    async 'POST /api/cards/:id/move'(url, id, body) { own(id); const result = await board.move(id, body); return { id: result.card.id, list: result.card.list, index: result.index, count: result.count }; },
    async 'POST /api/cards/:id/steps'(url, id, body) { own(id); const { rev, ...rest } = body; const result = await board.steps(id, rest, { rev }); return { id: result.card.id, rev: result.card.rev, section: result.section, items: result.items, done: result.done, total: result.total }; },
    async 'POST /api/cards/:id/comments'(url, id, body) { own(id); const result = await board.comment(id, { author: body.author || author, text: body.text }); return { id: result.card.id, rev: result.card.rev, comment: result.comment, index: result.index }; },
    async 'GET /api/activity'(url) {
      await recording;
      return activity.view({ limit: Number(url.searchParams.get('limit')) || 100 });
    },
    // { seen: true } records that the feed was opened (it moves the New divider); { read:
    // [keys] | 'all' } clears entries' unread marks and the badge with them (an entry was
    // opened, or Mark all as read).
    async 'POST /api/activity'(url, _id, body) {
      await recording;
      if (body.seen) activity.markSeen();
      if (body.read === 'all' || Array.isArray(body.read)) activity.markRead(body.read);
      await activityChanged();
      const { seenAt, unread } = activity.view({ limit: 0 });
      return { seenAt, unread };
    },
    async 'POST /api/lists'(url, _id, body) { const { action, ...rest } = body; return board.lists(action, rest); },
  };

  function match(method, pathname) {
    for (const [key, handler] of Object.entries(routes)) {
      const [routeMethod, pattern] = key.split(' ');
      if (routeMethod !== method) continue;
      const regex = new RegExp(`^${pattern.replace(':id', '(\\d+)')}$`);
      const found = regex.exec(pathname);
      if (found) return { handler, id: found[1] ? Number(found[1]) : undefined };
    }
    return null;
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${HOST}`);
    try {
      if (url.pathname === '/api/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        response.write(`event: hello\ndata: {}\n\n`);
        clients.add(response);
        const heartbeat = setInterval(() => response.write(': ping\n\n'), 25_000);
        request.on('close', () => { clearInterval(heartbeat); clients.delete(response); });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        const route = match(request.method, url.pathname);
        if (!route) return json(response, 404, { error: { code: 'no_route', message: `no ${request.method} ${url.pathname}` } });
        const body = request.method === 'GET' ? undefined : await readBody(request);
        const result = await route.handler(url, route.id, body);
        return json(response, 200, result);
      }
      const trello = /^\/c\/([A-Za-z0-9]+)(?:\/.*)?$/.exec(url.pathname);
      if (trello) {
        const card = await board.byTrello(trello[1]);
        if (!card) { response.writeHead(404, { 'Content-Type': 'text/plain' }); return response.end(`no card imported from Trello short link ${trello[1]}`); }
        response.writeHead(302, { Location: `/#card=${card.id}` });
        return response.end();
      }
      const cardLink = /^\/card\/(\d+)$/.exec(url.pathname);
      if (cardLink) { response.writeHead(302, { Location: `/#card=${cardLink[1]}` }); return response.end(); }
      if (url.pathname === '/vendor/marked.esm.js') return serveFile(response, MARKED_FILE);
      const file = url.pathname === '/' ? '/index.html' : url.pathname;
      return serveFile(response, inside(path.join(appDir, 'ui'), file));
    } catch (error) {
      const status = statusFor(error);
      if (status === 500) console.error(error);
      return json(response, status, { error: { code: error.code || 'error', message: error.message, current: error.current } });
    }
  });

  server.on('listening', () => { listening = true; startWatching(); });
  server.on('close', () => { listening = false; stopWatching(); for (const client of clients) client.end(); clients.clear(); });
  server.board = board;
  server.activity = activity;
  server.registry = reg;
  server.switchBoard = switchTo;
  server.recorded = () => recording;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.TRELLIS_PORT || process.env.BOARD_PORT || 8766);
  const { boardDir, registry } = await resolveActiveBoard({ dir: process.argv[2] });
  const server = createBoardServer({
    boardDir,
    registry,
    activityDir: defaultActivityDir(),
  });
  if (await server.board.exists()) {
    await registry.remember(server.board.dir, { setCurrent: true });
  }
  server.listen(port, HOST, () => console.log(`Trellis: http://${HOST}:${port}/  (board: ${server.board.dir})`));
}
