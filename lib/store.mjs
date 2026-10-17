// The board store: one markdown file per card under <dir>/cards, list order and labels
// in <dir>/board.yaml. Every write takes the board lock, bumps the card's rev and
// lands through an atomic rename, so several agents and the UI can share one board.
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import {
  joinSections, nowStamp, parseCardFile, parseChecklist, parseComments, parseSections,
  serializeCardFile, serializeChecklist, serializeComments, slugify,
} from './markdown.mjs';

export const KINDS = ['agent', 'human', 'joint'];
export const STATUSES = ['open', 'done', 'archived'];
export const STEPS = 'Steps';
export const COMMENTS = 'Comments';
export const DEFAULT_TEMPLATE = ['Context', 'Why this matters', 'What to do', 'Steps', 'Success criteria', 'Tests', 'References'];
export const LABEL_COLORS = ['green', 'yellow', 'orange', 'red', 'purple', 'blue', 'sky', 'lime', 'pink', 'black', 'grey'];
const POS_STEP = 1000;
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

export class BoardError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

export function parseId(value) {
  const text = String(value ?? '').trim().replace(/^#/, '');
  if (!/^\d+$/.test(text)) throw new BoardError('bad_id', `card id must be a number, got "${value}"`);
  return Number(text);
}

export function fileName(id, title) {
  return `${String(id).padStart(4, '0')}-${slugify(title)}.md`;
}

function unique(values) {
  return [...new Set(values)];
}

function normalizeIds(values, field) {
  if (values === undefined || values === null) return [];
  const list = Array.isArray(values) ? values : String(values).split(/[,\s]+/).filter(Boolean);
  return unique(list.map(value => {
    try { return parseId(value); } catch { throw new BoardError('bad_id', `${field} must hold card ids, got "${value}"`); }
  }));
}

function normalizeLabels(values) {
  if (values === undefined || values === null) return [];
  const list = Array.isArray(values) ? values : String(values).split(',');
  return unique(list.map(value => String(value).trim()).filter(Boolean));
}

export class Board {
  constructor(dir) {
    this.dir = path.resolve(dir);
    this.cardsDir = path.join(this.dir, 'cards');
    this.configPath = path.join(this.dir, 'board.yaml');
    this.lockPath = path.join(this.dir, '.lock');
    this._cache = new Map();
  }

  static async init(dir, { name = 'Board', lists = [], labels = [], template = DEFAULT_TEMPLATE, gdignore } = {}) {
    const board = new Board(dir);
    await mkdir(board.cardsDir, { recursive: true });
    try { await stat(board.configPath); throw new BoardError('exists', `${board.configPath} already exists`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await board.saveConfig({ name, lists: lists.map(list => (typeof list === 'string' ? { id: slugify(list), name: list } : list)), labels, template });
    const hasGodot = await stat(path.join(path.dirname(board.dir), 'project.godot')).then(() => true, () => false);
    if (gdignore || (gdignore === undefined && hasGodot)) {
      await writeFile(path.join(board.dir, '.gdignore'), '');
    }
    return board;
  }

  async exists() {
    try { await stat(this.configPath); return true; } catch { return false; }
  }

  // ---------- config ----------

  async config() {
    let raw;
    try { raw = await readFile(this.configPath, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') throw new BoardError('no_board', `no board at ${this.dir} (missing board.yaml); run "trellis init" or the Trello importer first`);
      throw error;
    }
    const config = YAML.parse(raw) || {};
    config.name ||= 'Board';
    config.lists = (config.lists || []).map(list => ({ id: String(list.id), name: String(list.name ?? list.id), archived: Boolean(list.archived) }));
    config.labels = (config.labels || []).map(label => ({ name: String(label.name), color: String(label.color || 'grey') }));
    config.template = config.template || DEFAULT_TEMPLATE;
    return config;
  }

  async saveConfig(config) {
    const clean = {
      name: config.name,
      lists: config.lists.map(list => (list.archived ? { id: list.id, name: list.name, archived: true } : { id: list.id, name: list.name })),
      labels: config.labels,
      template: config.template,
    };
    await this._atomicWrite(this.configPath, YAML.stringify(clean, { lineWidth: 0 }));
  }

  async resolveList(ref, config) {
    config ||= await this.config();
    if (ref === undefined || ref === null || ref === '') throw new BoardError('bad_list', 'a list is required');
    const wanted = String(ref).trim().toLowerCase();
    const exact = config.lists.find(list => list.id.toLowerCase() === wanted || list.name.toLowerCase() === wanted);
    if (exact) return exact;
    // "M1" should pick "M1 - Foo" and never "M1.5 - Bar": a prefix ended by a word boundary wins.
    const bounded = config.lists.filter(list => {
      const name = list.name.toLowerCase();
      return name.startsWith(wanted) && /^[\s:\-–—]/.test(name.slice(wanted.length));
    });
    if (bounded.length === 1) return bounded[0];
    const partial = config.lists.filter(list => list.name.toLowerCase().includes(wanted) || list.id.includes(wanted));
    if (partial.length === 1) return partial[0];
    const known = config.lists.map(list => list.id).join(', ');
    throw new BoardError('bad_list', partial.length ? `list "${ref}" is ambiguous (${partial.map(list => list.id).join(', ')})` : `unknown list "${ref}"; lists: ${known}`);
  }

  // ---------- reading ----------

  async _files() {
    let names;
    try { names = await readdir(this.cardsDir); } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return names.filter(name => /^\d+-.*\.md$/.test(name)).sort();
  }

  async _read(name) {
    const file = path.join(this.cardsDir, name);
    const info = await stat(file);
    const cached = this._cache.get(name);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.card;
    const text = await readFile(file, 'utf8');
    const card = this._hydrate(parseCardFile(text), file);
    this._cache.set(name, { mtimeMs: info.mtimeMs, size: info.size, card });
    return card;
  }

  _hydrate({ meta, body }, file) {
    const { preamble, sections } = parseSections(body);
    const commentsSection = sections.find(section => section.name === COMMENTS);
    return {
      id: Number(meta.id),
      title: String(meta.title ?? ''),
      list: String(meta.list ?? ''),
      pos: Number(meta.pos ?? 0),
      kind: KINDS.includes(meta.kind) ? meta.kind : 'agent',
      status: STATUSES.includes(meta.status) ? meta.status : 'open',
      labels: normalizeLabels(meta.labels),
      blocked_by: normalizeIds(meta.blocked_by, 'blocked_by'),
      siblings: normalizeIds(meta.siblings, 'siblings'),
      rev: Number(meta.rev ?? 1),
      created: meta.created ? String(meta.created) : undefined,
      updated: meta.updated ? String(meta.updated) : undefined,
      closed: meta.closed ? String(meta.closed) : undefined,
      trello: meta.trello ? String(meta.trello) : undefined,
      file,
      preamble,
      sections: sections.filter(section => section.name !== COMMENTS),
      comments: commentsSection ? parseComments(commentsSection.body) : [],
    };
  }

  async all({ status = 'all' } = {}) {
    const cards = [];
    for (const name of await this._files()) {
      const card = await this._read(name);
      if (status === 'all' || card.status === status) cards.push(card);
    }
    return cards;
  }

  async get(ref) {
    const id = parseId(ref);
    const prefix = `${String(id).padStart(4, '0')}-`;
    const name = (await this._files()).find(file => file.startsWith(prefix));
    if (!name) throw new BoardError('not_found', `card #${id} not found`);
    return this._read(name);
  }

  async byTrello(shortLink) {
    return (await this.all()).find(card => card.trello === shortLink) || null;
  }

  /** Cards matching the filter, ordered by list order then position. */
  async query({ list, kind, label, status = 'open', q, blocked, since, ids } = {}) {
    const config = await this.config();
    const listOrder = new Map(config.lists.map((entry, index) => [entry.id, index]));
    let cards = await this.all();
    const openIds = new Set(cards.filter(card => card.status === 'open').map(card => card.id));
    if (status && status !== 'all') cards = cards.filter(card => card.status === status);
    if (list) { const target = await this.resolveList(list, config); cards = cards.filter(card => card.list === target.id); }
    if (kind) cards = cards.filter(card => card.kind === kind);
    if (label) cards = cards.filter(card => card.labels.some(entry => entry.toLowerCase() === String(label).toLowerCase()));
    if (ids && ids.length) { const wanted = new Set(normalizeIds(ids, 'ids')); cards = cards.filter(card => wanted.has(card.id)); }
    if (blocked) cards = cards.filter(card => card.blocked_by.some(id => openIds.has(id)));
    if (since) cards = cards.filter(card => (card.updated || '') >= since);
    if (q) {
      const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean);
      cards = cards.filter(card => {
        const haystack = `#${card.id} ${card.title}\n${cardText(card)}`.toLowerCase();
        return terms.every(term => haystack.includes(term));
      });
    }
    cards.sort((a, b) => (listOrder.get(a.list) ?? 1e9) - (listOrder.get(b.list) ?? 1e9) || a.pos - b.pos || a.id - b.id);
    return cards.map(card => ({ ...card, blocked_open: card.blocked_by.filter(id => openIds.has(id)) }));
  }

  async overview() {
    const config = await this.config();
    const cards = await this.all();
    const lists = config.lists.map(list => {
      const mine = cards.filter(card => card.list === list.id);
      const open = mine.filter(card => card.status === 'open');
      return {
        id: list.id, name: list.name, archived: list.archived,
        open: open.length, done: mine.filter(card => card.status === 'done').length,
        archived_cards: mine.filter(card => card.status === 'archived').length,
        kinds: Object.fromEntries(KINDS.map(kind => [kind, open.filter(card => card.kind === kind).length])),
      };
    });
    const open = cards.filter(card => card.status === 'open');
    return {
      name: config.name,
      lists,
      labels: config.labels,
      template: config.template,
      totals: {
        open: open.length, done: cards.filter(card => card.status === 'done').length,
        archived: cards.filter(card => card.status === 'archived').length,
        kinds: Object.fromEntries(KINDS.map(kind => [kind, open.filter(card => card.kind === kind).length])),
        blocked: open.filter(card => card.blocked_by.some(id => open.some(other => other.id === id))).length,
      },
    };
  }

  // ---------- writing ----------

  async withLock(fn) {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const handle = await open(this.lockPath, 'wx');
        await handle.writeFile(String(process.pid));
        await handle.close();
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const info = await stat(this.lockPath);
          if (Date.now() - info.mtimeMs > LOCK_STALE_MS) { await unlink(this.lockPath).catch(() => {}); continue; }
        } catch { continue; }
        if (Date.now() > deadline) throw new BoardError('locked', `board is locked by another process (${this.lockPath}); retry`);
        await new Promise(resolve => setTimeout(resolve, 25 + Math.random() * 50));
      }
    }
    try { return await fn(); } finally { await unlink(this.lockPath).catch(() => {}); }
  }

  async _atomicWrite(file, text) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(temporary, text, 'utf8');
    await rename(temporary, file);
  }

  async _write(card, { touch = true } = {}) {
    if (touch) { card.rev = (card.rev || 0) + 1; card.updated = nowStamp(); }
    const sections = card.comments.length
      ? [...card.sections, { name: COMMENTS, body: serializeComments(card.comments) }]
      : card.sections;
    const meta = {
      id: card.id, title: card.title, list: card.list, pos: card.pos, kind: card.kind, status: card.status,
      labels: card.labels, blocked_by: card.blocked_by, siblings: card.siblings, rev: card.rev,
      created: card.created, updated: card.updated, closed: card.closed, trello: card.trello,
    };
    const text = serializeCardFile(meta, joinSections(card.preamble, sections));
    const wanted = path.join(this.cardsDir, fileName(card.id, card.title));
    if (card.file && card.file !== wanted) { await rm(card.file, { force: true }); this._cache.delete(path.basename(card.file)); }
    card.file = wanted;
    await this._atomicWrite(wanted, text);
    this._cache.delete(path.basename(wanted));
    return card;
  }

  async _nextId() {
    let max = 0;
    for (const name of await this._files()) max = Math.max(max, Number(name.split('-')[0]));
    return max + 1;
  }

  async _validateRefs(ids, field, self) {
    for (const id of ids) {
      if (id === self) throw new BoardError('bad_ref', `${field} cannot include the card itself (#${id})`);
      try { await this.get(id); } catch { throw new BoardError('bad_ref', `${field} names card #${id}, which does not exist`); }
    }
  }

  async _ensureLabels(config, labels) {
    let changed = false;
    for (const name of labels) {
      if (!config.labels.some(label => label.name.toLowerCase() === name.toLowerCase())) {
        config.labels.push({ name, color: LABEL_COLORS[config.labels.length % LABEL_COLORS.length] });
        changed = true;
      }
    }
    if (changed) await this.saveConfig(config);
    return labels.map(name => config.labels.find(label => label.name.toLowerCase() === name.toLowerCase()).name);
  }

  async create({ title, list, kind = 'agent', labels, sections, steps, blocked_by, siblings, position = 'bottom', body, template = false, status = 'open', trello, created, updated, closed, pos, id: wantedId } = {}) {
    if (!title || !String(title).trim()) throw new BoardError('bad_title', 'a title is required');
    if (!KINDS.includes(kind)) throw new BoardError('bad_kind', `kind must be one of ${KINDS.join(', ')}`);
    if (!STATUSES.includes(status)) throw new BoardError('bad_status', `status must be one of ${STATUSES.join(', ')}`);
    return this.withLock(async () => {
      const config = await this.config();
      const target = await this.resolveList(list, config);
      const id = wantedId ? parseId(wantedId) : await this._nextId();
      if (wantedId) { let taken = false; try { await this.get(id); taken = true; } catch {} if (taken) throw new BoardError('exists', `card #${id} already exists`); }
      const card = {
        id, title: String(title).trim(), list: target.id, pos: 0, kind, status,
        labels: await this._ensureLabels(config, normalizeLabels(labels)),
        blocked_by: normalizeIds(blocked_by, 'blocked_by'), siblings: normalizeIds(siblings, 'siblings'),
        rev: 0, created: created || nowStamp(), updated, closed: status === 'open' ? undefined : (closed || nowStamp()), trello,
        file: undefined, preamble: '', sections: [], comments: [],
      };
      await this._validateRefs(card.blocked_by, 'blocked_by', id);
      await this._validateRefs(card.siblings, 'siblings', id);
      if (body) Object.assign(card, bodyToParts(body));
      if (template) for (const name of config.template) if (!findSection(card, name)) card.sections.push({ name, body: '' });
      for (const [name, text] of Object.entries(sections || {})) setSection(card, name, text);
      if (steps && steps.length) {
        const section = findSection(card, STEPS) || (card.sections.push({ name: STEPS, body: '' }), card.sections[card.sections.length - 1]);
        const items = parseChecklist(section.body) || [];
        section.body = serializeChecklist([...items, ...steps.map(text => ({ done: false, text: String(text) }))]);
      }
      card.pos = pos !== undefined ? Number(pos) : await this._placement(target.id, { position }, id);
      // An import keeps the source's last-activity time; a fresh card is stamped now.
      if (updated) { card.rev = 1; return this._write(card, { touch: false }); }
      return this._write(card);
    });
  }

  async update(ref, patch = {}, { rev } = {}) {
    return this.withLock(async () => {
      const card = await this.get(ref);
      if (rev !== undefined && rev !== null && Number(rev) !== card.rev) {
        throw new BoardError('conflict', `rev conflict on #${card.id}: you sent r${rev}, current is r${card.rev}; re-read the card before writing`, { current: card.rev });
      }
      const config = await this.config();
      if (patch.title !== undefined) { if (!String(patch.title).trim()) throw new BoardError('bad_title', 'title cannot be empty'); card.title = String(patch.title).trim(); }
      if (patch.kind !== undefined) { if (!KINDS.includes(patch.kind)) throw new BoardError('bad_kind', `kind must be one of ${KINDS.join(', ')}`); card.kind = patch.kind; }
      if (patch.status !== undefined) {
        if (!STATUSES.includes(patch.status)) throw new BoardError('bad_status', `status must be one of ${STATUSES.join(', ')}`);
        if (patch.status !== card.status) { card.status = patch.status; card.closed = patch.status === 'open' ? undefined : nowStamp(); }
      }
      if (patch.labels !== undefined) card.labels = await this._ensureLabels(config, normalizeLabels(patch.labels));
      if (patch.add_labels !== undefined) card.labels = unique([...card.labels, ...(await this._ensureLabels(config, normalizeLabels(patch.add_labels)))]);
      if (patch.remove_labels !== undefined) { const gone = new Set(normalizeLabels(patch.remove_labels).map(name => name.toLowerCase())); card.labels = card.labels.filter(name => !gone.has(name.toLowerCase())); }
      if (patch.blocked_by !== undefined) { card.blocked_by = normalizeIds(patch.blocked_by, 'blocked_by'); await this._validateRefs(card.blocked_by, 'blocked_by', card.id); }
      if (patch.siblings !== undefined) { card.siblings = normalizeIds(patch.siblings, 'siblings'); await this._validateRefs(card.siblings, 'siblings', card.id); }
      if (patch.body !== undefined) Object.assign(card, bodyToParts(patch.body));
      for (const [name, text] of Object.entries(patch.set_sections || {})) setSection(card, name, text);
      for (const [name, text] of Object.entries(patch.append || {})) {
        const section = findSection(card, name);
        if (section) section.body = section.body.trim() ? `${section.body.trim()}\n\n${String(text).trim()}` : String(text).trim();
        else setSection(card, name, text);
      }
      for (const name of patch.remove_sections || []) {
        const section = findSection(card, name);
        if (!section) throw new BoardError('no_section', `#${card.id} has no section "${name}"; sections: ${card.sections.map(entry => entry.name).join(', ')}`);
        card.sections.splice(card.sections.indexOf(section), 1);
      }
      return this._write(card);
    });
  }

  async move(ref, { list, position, before, after } = {}) {
    return this.withLock(async () => {
      const card = await this.get(ref);
      const config = await this.config();
      const target = list ? await this.resolveList(list, config) : config.lists.find(entry => entry.id === card.list);
      if (!target) throw new BoardError('bad_list', `card #${card.id} sits in unknown list "${card.list}"; pass a list`);
      const moved = target.id !== card.list;
      if (!moved && position === undefined && before === undefined && after === undefined) return { card, moved: false, index: 0, count: 0 };
      card.list = target.id;
      card.pos = await this._placement(target.id, { position: position ?? (moved && before === undefined && after === undefined ? 'bottom' : undefined), before, after }, card.id);
      await this._write(card);
      const siblings = (await this.all()).filter(entry => entry.list === target.id && entry.status === card.status).sort((a, b) => a.pos - b.pos || a.id - b.id);
      return { card, moved, index: siblings.findIndex(entry => entry.id === card.id) + 1, count: siblings.length, list: target };
    });
  }

  /** Position for a card entering `listId`; renumbers the list when no integer gap is left. */
  async _placement(listId, { position, before, after }, selfId) {
    const siblings = (await this.all()).filter(card => card.list === listId && card.id !== selfId).sort((a, b) => a.pos - b.pos || a.id - b.id);
    if (!siblings.length) return POS_STEP;
    const anchor = before ?? after;
    if (anchor !== undefined && anchor !== null) {
      const anchorId = parseId(anchor);
      const index = siblings.findIndex(card => card.id === anchorId);
      if (index < 0) throw new BoardError('bad_anchor', `card #${anchorId} is not in list "${listId}"`);
      const lowIndex = before !== undefined && before !== null ? index - 1 : index;
      const low = lowIndex >= 0 ? siblings[lowIndex].pos : null;
      const high = lowIndex + 1 < siblings.length ? siblings[lowIndex + 1].pos : null;
      if (low === null) return high - POS_STEP;
      if (high === null) return low + POS_STEP;
      if (high - low >= 2) return Math.floor((low + high) / 2);
      await this._renumber(siblings);
      return this._placement(listId, { before, after }, selfId);
    }
    if (position === 'top') return siblings[0].pos - POS_STEP;
    return siblings[siblings.length - 1].pos + POS_STEP;
  }

  async _renumber(cards) {
    let pos = POS_STEP;
    for (const card of cards) { card.pos = pos; pos += POS_STEP; await this._write(card, { touch: false }); }
  }

  async steps(ref, { section = STEPS, tick, untick, add, edit, remove } = {}, { rev } = {}) {
    return this.withLock(async () => {
      const card = await this.get(ref);
      if (rev !== undefined && rev !== null && Number(rev) !== card.rev) throw new BoardError('conflict', `rev conflict on #${card.id}: you sent r${rev}, current is r${card.rev}`, { current: card.rev });
      let target = findSection(card, section);
      if (!target) {
        if (!(add && add.length)) throw new BoardError('no_section', `#${card.id} has no "${section}" checklist; add items to create it`);
        target = { name: section, body: '' };
        card.sections.push(target);
      }
      const items = parseChecklist(target.body);
      if (items === null) throw new BoardError('not_checklist', `section "${target.name}" of #${card.id} is prose, not a checklist`);
      const at = (index, verb) => {
        const number = Number(index);
        if (!Number.isInteger(number) || number < 1 || number > items.length) throw new BoardError('bad_index', `cannot ${verb} step ${index}: "${target.name}" has ${items.length} items (1-based)`);
        return items[number - 1];
      };
      for (const index of tick || []) at(index, 'tick').done = true;
      for (const index of untick || []) at(index, 'untick').done = false;
      for (const entry of edit || []) at(entry.index, 'edit').text = String(entry.text);
      for (const index of [...(remove || [])].map(Number).sort((a, b) => b - a)) { at(index, 'remove'); items.splice(index - 1, 1); }
      for (const text of add || []) items.push({ done: false, text: String(text) });
      target.body = serializeChecklist(items);
      await this._write(card);
      return { card, section: target.name, items, done: items.filter(item => item.done).length, total: items.length };
    });
  }

  async comment(ref, { author = 'agent', text }) {
    if (!text || !String(text).trim()) throw new BoardError('bad_comment', 'comment text is required');
    return this.withLock(async () => {
      const card = await this.get(ref);
      const entry = { at: nowStamp(), author: String(author).trim().replace(/\s+/g, '-') || 'agent', text: String(text).trim() };
      card.comments.push(entry);
      await this._write(card);
      return { card, comment: entry, index: card.comments.length };
    });
  }

  // ---------- lists ----------

  async lists(action, { name, list, new_name, position, before, after } = {}) {
    return this.withLock(async () => {
      const config = await this.config();
      const place = (entries, entry) => {
        const others = entries.filter(other => other !== entry);
        let index = others.length;
        if (position === 'top') index = 0;
        else if (before !== undefined && before !== null) index = others.indexOf(config.lists.find(other => other === before) ?? before);
        else if (after !== undefined && after !== null) index = others.indexOf(after) + 1;
        others.splice(index < 0 ? others.length : index, 0, entry);
        return others;
      };
      const anchor = async ref => (ref === undefined || ref === null ? ref : this.resolveList(ref, config));
      before = await anchor(before);
      after = await anchor(after);
      if (action === 'create') {
        if (!name || !String(name).trim()) throw new BoardError('bad_list', 'a list name is required');
        let id = slugify(name, 40);
        while (config.lists.some(entry => entry.id === id)) id = `${id}-2`;
        const entry = { id, name: String(name).trim(), archived: false };
        config.lists = place(config.lists, entry);
        await this.saveConfig(config);
        return { list: entry, index: config.lists.indexOf(entry) + 1, count: config.lists.length };
      }
      const entry = await this.resolveList(list ?? name, config);
      if (action === 'rename') {
        if (!new_name || !String(new_name).trim()) throw new BoardError('bad_list', 'new_name is required');
        entry.name = String(new_name).trim();
      } else if (action === 'move') {
        config.lists = place(config.lists, entry);
      } else if (action === 'archive') {
        entry.archived = true;
      } else if (action === 'restore') {
        entry.archived = false;
      } else {
        throw new BoardError('bad_action', `unknown list action "${action}"; use create, rename, move, archive or restore`);
      }
      await this.saveConfig(config);
      return { list: entry, index: config.lists.indexOf(entry) + 1, count: config.lists.length };
    });
  }
}

// ---------- helpers on the in-memory card ----------

export function findSection(card, name) {
  const wanted = String(name).trim().toLowerCase();
  return card.sections.find(section => section.name.toLowerCase() === wanted) || null;
}

export function setSection(card, name, text) {
  const clean = String(name).trim();
  if (!clean || /\n/.test(clean)) throw new BoardError('bad_section', `"${name}" is not a section name`);
  if (clean.toLowerCase() === COMMENTS.toLowerCase()) throw new BoardError('bad_section', 'Comments is written with the comment tool, not as a section');
  const existing = findSection(card, clean);
  if (text === null) { if (existing) card.sections.splice(card.sections.indexOf(existing), 1); return; }
  if (existing) existing.body = String(text).trim();
  else card.sections.push({ name: clean, body: String(text).trim() });
}

export function bodyToParts(body) {
  const { preamble, sections } = parseSections(String(body));
  return { preamble, sections: sections.filter(section => section.name !== COMMENTS) };
}

export function stepsOf(card, name = STEPS) {
  const section = findSection(card, name);
  if (!section) return null;
  const items = parseChecklist(section.body);
  if (items === null) return null;
  return { section: section.name, items, done: items.filter(item => item.done).length, total: items.length };
}

export function cardText(card) {
  return joinSections(card.preamble, card.sections);
}

/** The card without bodies, for tables and the kanban view. */
export function summarize(card) {
  const steps = stepsOf(card);
  return {
    id: card.id, title: card.title, list: card.list, pos: card.pos, kind: card.kind, status: card.status,
    labels: card.labels, blocked_by: card.blocked_by, blocked_open: card.blocked_open || [], siblings: card.siblings,
    rev: card.rev, created: card.created, updated: card.updated, closed: card.closed, trello: card.trello,
    steps: steps ? { done: steps.done, total: steps.total } : null,
    comments: card.comments.length,
    sections: card.sections.map(section => section.name),
  };
}
