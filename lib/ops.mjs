// Operations shared by the MCP server and the CLI. Each returns { text, data }:
// text is the token-lean default, data feeds `format: "json"`.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createEmbedder } from './embedder.mjs';
import { cardsTable, overviewText, parseFields, relativeFile, renderCard, searchText } from './format.mjs';
import { boardsTable, normalizeBoardDir, projectRootFor, targetBoardDir } from './registry.mjs';
import { SearchIndex } from './search.mjs';
import { imageRefs } from './markdown.mjs';
import { Board, DEFAULT_TEMPLATE, IMAGE_TYPES, KINDS, STATUSES, summarize } from './store.mjs';

const json = value => JSON.stringify(value);

/** board_cards rows per page by default: about 1k tokens. */
export const DEFAULT_LIMIT = 30;
/** Images a board_card read attaches at most (the last ones shown, so the newest comments win). */
export const MAX_IMAGES = 6;
// The largest image an MCP client is sent; the Claude API refuses images over 5 MB.
const IMAGE_BYTES = 5_000_000;

/**
 * The board's own images that `text` (a rendered card) links to, as { label, path, mimeType,
 * data }. A link is resolved from the card file and must stay inside the board directory.
 */
async function cardImages(card, text, board, root) {
  const seen = new Set();
  const found = [];
  for (const { alt, src } of imageRefs(text)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) continue;
    let file;
    try { file = path.resolve(path.dirname(card.file), decodeURIComponent(src)); } catch { continue; }
    const mimeType = IMAGE_TYPES[path.extname(file).slice(1).toLowerCase().replace('jpeg', 'jpg')];
    if (!mimeType || seen.has(file) || !file.startsWith(board.dir + path.sep)) continue;
    seen.add(file);
    found.push({ label: alt || path.basename(file), file, mimeType });
  }
  const images = [];
  const skipped = [];
  for (const image of found.slice(-MAX_IMAGES)) {
    const where = relativeFile(image, root);
    const info = await stat(image.file).catch(() => null);
    if (!info) { skipped.push(`${image.label} missing (${where})`); continue; }
    if (info.size > IMAGE_BYTES) { skipped.push(`${image.label} too large to attach (${where})`); continue; }
    images.push({ label: image.label, path: where, mimeType: image.mimeType, data: (await readFile(image.file)).toString('base64') });
  }
  if (found.length > MAX_IMAGES) skipped.unshift(`${found.length - MAX_IMAGES} earlier image${found.length - MAX_IMAGES === 1 ? '' : 's'} not attached`);
  return { images, skipped };
}

export function makeOps(initialBoard, {
  root: initialRoot,
  author = 'agent',
  search: initialSearch,
  registry = null,
  embedder = () => createEmbedder(),
} = {}) {
  let currentBoard = initialBoard;
  const searches = new Map();
  if (initialSearch && initialBoard) searches.set(initialBoard.dir, initialSearch);

  const searchFor = board => {
    if (!searches.has(board.dir)) {
      searches.set(board.dir, new SearchIndex(board, { embedder }));
    }
    return searches.get(board.dir);
  };

  const rootFor = board => {
    if (board === initialBoard && initialRoot) return initialRoot;
    return projectRootFor(board.dir);
  };

  const resolveBoard = async boardRef => {
    if (!boardRef) return currentBoard;
    if (registry) {
      const resolved = await registry.resolve(boardRef);
      const valid = normalizeBoardDir(resolved) || resolved;
      return Board.open(valid);
    }
    const valid = normalizeBoardDir(boardRef) || path.resolve(String(boardRef));
    return Board.open(valid);
  };

  const ack = (card, rest = '') => `ok #${card.id} r${card.rev}${rest ? ` ${rest}` : ''}`;

  return {
    get board() { return currentBoard; },
    setBoard(nextBoard) { currentBoard = nextBoard; },

    async overview({ board: boardRef, format } = {}) {
      const target = await resolveBoard(boardRef);
      const data = await target.overview();
      return { data, text: format === 'json' ? json(data) : overviewText(data) };
    },

    async cards({ board: boardRef, list, kind, label, status = 'open', q, blocked, since, ids, fields, limit = DEFAULT_LIMIT, offset = 0, format } = {}) {
      if (kind && !KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
      if (status && status !== 'all' && !STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}, all`);
      const target = await resolveBoard(boardRef);
      const columns = parseFields(fields);
      const all = await target.query({ list, kind, label, status, q, blocked, since, ids });
      const page = all.slice(offset, offset + Math.max(1, limit));
      const data = { total: all.length, offset, count: page.length, cards: page.map(summarize) };
      return { data, text: format === 'json' ? json(data) : cardsTable(page, columns, { total: all.length, offset }) };
    },

    // `images` (default true) attaches the board images the rendered card links to, so a
    // screenshot pasted into a comment is seen, not just named.
    async card({ board: boardRef, id, sections, comments = 3, full, images = true, format } = {}) {
      const target = await resolveBoard(boardRef);
      const root = rootFor(target);
      const [card] = await target.query({ ids: [id], status: 'all' });
      if (!card) throw Object.assign(new Error(`card #${String(id).replace(/^#/, '')} not found`), { code: 'not_found' });
      const data = { ...summarize(card), file: relativeFile(card, root), preamble: card.preamble, sections: card.sections, comments: card.comments };
      const rendered = renderCard(card, { sections, comments, root, full, template: (await target.config()).template });
      const attached = images ? await cardImages(card, rendered, target, root) : { images: [], skipped: [] };
      const notes = attached.skipped.length ? `
(images: ${attached.skipped.join('; ')})` : '';
      return { data, images: attached.images, text: format === 'json' ? json(data) : rendered + notes };
    },

    async search({ board: boardRef, query, k, mode, list, kind, label, status, files, section, excerpt, format } = {}) {
      const target = await resolveBoard(boardRef);
      const data = await searchFor(target).search({ query, k, mode, list, kind, label, status, files, section, excerpt });
      return { data, text: format === 'json' ? json(data) : searchText(data) };
    },

    async reindex({ board: boardRef, force, lexical, format } = {}) {
      const target = await resolveBoard(boardRef);
      const root = rootFor(target);
      const idx = searchFor(target);
      const started = Date.now();
      const counts = await idx.refresh({ embed: !lexical, force });
      const data = { ...counts, model: idx.data.model, file: relativeFile({ file: idx.file }, root), seconds: Number(((Date.now() - started) / 1000).toFixed(1)) };
      const text = `ok index: ${data.cards} cards, ${data.chunks} chunks, ${data.embedded} embedded${data.pending ? `, ${data.pending} pending` : ''}${data.model ? ` (model ${data.model})` : ''}, ${data.seconds} s, ${data.file}`;
      return { data, text: format === 'json' ? json(data) : text };
    },

    async create({ board: boardRef, ...args }) {
      const target = await resolveBoard(boardRef);
      const root = rootFor(target);
      const card = await target.create(args);
      return { data: summarize(card), text: `${ack(card, `created in ${card.list} (${card.kind})`)} file: ${relativeFile(card, root)}` };
    },

    async update({ board: boardRef, id, rev, ...patch }) {
      const target = await resolveBoard(boardRef);
      const changed = Object.keys(patch).filter(key => patch[key] !== undefined);
      const card = await target.update(id, patch, { rev });
      return { data: summarize(card), text: ack(card, changed.length ? `updated ${changed.join(', ')}` : 'unchanged') };
    },

    async move({ board: boardRef, id, list, position, before, after }) {
      const target = await resolveBoard(boardRef);
      const result = await target.move(id, { list, position, before, after });
      if (!result.moved && !result.index) return { data: summarize(result.card), text: `ok #${result.card.id} unchanged` };
      return { data: { ...summarize(result.card), index: result.index, count: result.count }, text: ack(result.card, `→ ${result.card.list} ${result.index}/${result.count}`) };
    },

    async steps({ board: boardRef, id, rev, section, tick, untick, add, edit, remove }) {
      const target = await resolveBoard(boardRef);
      const result = await target.steps(id, { section, tick, untick, add, edit, remove }, { rev });
      return { data: { id: result.card.id, rev: result.card.rev, section: result.section, done: result.done, total: result.total, items: result.items }, text: ack(result.card, `${result.section} ${result.done}/${result.total}`) };
    },

    async comment({ board: boardRef, id, text, author: who }) {
      const target = await resolveBoard(boardRef);
      const result = await target.comment(id, { author: who || author, text });
      return { data: { id: result.card.id, rev: result.card.rev, index: result.index, comment: result.comment }, text: ack(result.card, `comment ${result.index} by ${result.comment.author}`) };
    },

    async lists({ board: boardRef, action, ...rest }) {
      const target = await resolveBoard(boardRef);
      const result = await target.lists(action, rest);
      return { data: result, text: `ok list ${result.list.id} "${result.list.name}"${result.list.archived ? ' (archived)' : ''} ${result.index}/${result.count}` };
    },

    async boards({ action = 'list', dir, name, lists, here, format } = {}) {
      if (!registry) throw new Error('no board registry configured');
      if (action === 'list') {
        if (currentBoard && (await currentBoard.exists())) {
          await registry.remember(currentBoard.dir, { setCurrent: !registry.current, touch: false });
        }
        const data = await registry.list({ includeStats: true });
        return { data, text: format === 'json' ? json(data) : boardsTable(data) };
      }
      if (action === 'switch' || action === 'use') {
        const entry = await registry.switch(dir);
        currentBoard = Board.open(entry.dir);
        return { data: entry, text: `ok active board "${entry.name}" (${entry.slug}) at ${entry.dir}` };
      }
      if (action === 'add') {
        const valid = normalizeBoardDir(dir);
        if (!valid) throw new Error(`no board at "${dir}" (missing board.yaml); run "init" first`);
        const entry = await registry.remember(valid, { name, setCurrent: !registry.current, touch: true });
        return { data: entry, text: `ok remembered "${entry.name}" (${entry.slug}) at ${entry.dir}` };
      }
      if (action === 'init') {
        const target = targetBoardDir(dir || process.cwd(), { here });
        const finalName = name || path.basename(projectRootFor(target)) || 'Board';
        const listNames = Array.isArray(lists) ? lists : (lists ? String(lists).split(',').map(s => s.trim()).filter(Boolean) : []);
        await Board.init(target, { name: finalName, lists: listNames, template: DEFAULT_TEMPLATE });
        const entry = await registry.remember(target, { name: finalName, setCurrent: true, touch: true });
        currentBoard = Board.open(entry.dir);
        return { data: entry, text: `ok board "${entry.name}" (${entry.slug}) created at ${entry.dir}` };
      }
      if (action === 'forget' || action === 'remove') {
        const entry = await registry.forget(dir);
        if (registry.current && normalizeBoardDir(registry.current)) {
          currentBoard = Board.open(registry.current);
        }
        return { data: entry, text: `ok forgot "${entry.name}" (${entry.slug}) at ${entry.dir}` };
      }
      throw new Error(`unknown boards action "${action}"; use list, switch, add, init or forget`);
    },
  };
}
