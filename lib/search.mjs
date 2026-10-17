// Ranked search over the cards. Each card becomes section-level chunks; every chunk gets
// a local embedding and a BM25 posting; a query ranks chunks both ways, fuses the two
// rankings (reciprocal rank fusion) and folds chunks back into cards. Exact filters by
// cited source file and GAME_DESIGN § sit beside the ranking, because an audit needs
// "every card that names belt_router.gd" as much as "cards about blocked exits".
//
// The index lives at <board>/.search/index.json, keyed by card id with a content hash, so
// a search re-embeds only the cards that changed since the last one and never reads a
// stale card. The embedder is injected (lib/embedder.mjs in production, a fake in tests).
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BoardError, STATUSES } from './store.mjs';

export const INDEX_VERSION = 1;
export const MODES = ['hybrid', 'semantic', 'lexical'];
/** Longest chunk handed to the embedder; bge-small reads about this much before truncating. */
export const CHUNK_CHARS = 1200;
const RRF_K = 60;
const SECOND_CHUNK_WEIGHT = 0.15;

// ---------- chunking ----------

/** Split text into pieces of at most `max` chars on line boundaries; an over-long line is cut at a space. */
export function splitText(text, max = CHUNK_CHARS) {
  const clean = String(text || '').trim();
  if (!clean) return [];
  const pieces = [];
  let current = '';
  const push = () => { if (current.trim()) pieces.push(current.trim()); current = ''; };
  for (const line of clean.split('\n')) {
    if (line.length > max) {
      push();
      let rest = line;
      while (rest.length > max) {
        let cut = rest.lastIndexOf(' ', max);
        if (cut < max / 2) cut = max;
        pieces.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      current = rest;
      continue;
    }
    if (current.length + line.length + 1 > max) push();
    current = current ? `${current}\n${line}` : line;
  }
  push();
  return pieces;
}

/** A card as chunks: its head (title, meta, preamble), then each section and the comments. */
export function chunkCard(card) {
  const chunks = [];
  const head = [`#${card.id} ${card.title}`, `list ${card.list} · kind ${card.kind} · status ${card.status}${card.labels.length ? ` · labels ${card.labels.join(', ')}` : ''}`];
  if (card.preamble) head.push(card.preamble);
  chunks.push({ section: '', text: head.join('\n') });
  for (const section of card.sections) {
    for (const piece of splitText(section.body)) chunks.push({ section: section.name, text: `${card.title} — ${section.name}\n${piece}` });
  }
  if (card.comments.length) {
    const text = card.comments.map(comment => `${comment.author}: ${comment.text}`).join('\n');
    for (const piece of splitText(text)) chunks.push({ section: 'Comments', text: `${card.title} — Comments\n${piece}` });
  }
  return chunks;
}

/** Everything searchable on a card, for the exact filters. */
export function cardFullText(card) {
  const parts = [`#${card.id} ${card.title}`, card.preamble];
  for (const section of card.sections) parts.push(`## ${section.name}`, section.body);
  for (const comment of card.comments) parts.push(comment.text);
  return parts.filter(Boolean).join('\n');
}

export function cardHash(card) {
  return createHash('sha1')
    .update(JSON.stringify([card.id, card.title, card.list, card.kind, card.status, card.labels, card.preamble, card.sections, card.comments]))
    .digest('hex');
}

// ---------- tokens and BM25 ----------

const SECTION_REF = /§\s?\d+(?:\.\d+)*/g;
const IDENTIFIER = /[a-z0-9]+(?:[._/-][a-z0-9]+)*/g;

/** Plurals only: the embedding side carries the rest of the morphology, and a bolder stemmer merges route with rout. */
function stem(word) {
  if (word.length <= 3 || /\d/.test(word)) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(word)) return word;
  if (/(sh|ch|x|z|ss)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/** Lower-cased tokens: `§5.8` whole; `belt_router.gd` whole and as belt, router, gd; words lightly stemmed. */
export function tokenize(text) {
  const out = [];
  const spaced = String(text).replace(/([a-z])([A-Z])/g, '$1 $2');
  const lower = spaced.toLowerCase();
  for (const match of lower.matchAll(SECTION_REF)) out.push(match[0].replace(/\s/g, ''));
  for (const match of lower.matchAll(IDENTIFIER)) {
    const token = match[0];
    const parts = token.split(/[._/-]/).filter(Boolean);
    if (parts.length > 1) {
      out.push(token);
      for (const part of parts) out.push(stem(part));
    } else {
      out.push(stem(token));
    }
  }
  return out;
}

export function buildLexicalIndex(texts) {
  const docs = texts.map(tokenize);
  const df = new Map();
  const tf = [];
  let total = 0;
  for (const tokens of docs) {
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
    for (const token of counts.keys()) df.set(token, (df.get(token) || 0) + 1);
    tf.push(counts);
    total += tokens.length;
  }
  return { n: docs.length, lengths: docs.map(tokens => tokens.length), avg: total / Math.max(1, docs.length), df, tf };
}

export function bm25Scores(index, query, { k1 = 1.2, b = 0.75 } = {}) {
  const scores = new Float64Array(index.n);
  for (const term of new Set(tokenize(query))) {
    const df = index.df.get(term);
    if (!df) continue;
    const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
    for (let i = 0; i < index.n; i++) {
      const f = index.tf[i].get(term);
      if (!f) continue;
      scores[i] += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + (b * index.lengths[i]) / index.avg));
    }
  }
  return scores;
}

// ---------- vectors ----------

export function encodeVector(vector) {
  return Buffer.from(Float32Array.from(vector).buffer).toString('base64');
}

export function decodeVector(text) {
  const buffer = Buffer.from(text, 'base64');
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/** Ranks (1-based) of the indices whose score passes `floor`, best first; ties keep index order. */
function rankOf(scores, floor = -Infinity) {
  const order = [];
  for (let i = 0; i < scores.length; i++) if (scores[i] > floor) order.push(i);
  order.sort((a, b) => scores[b] - scores[a] || a - b);
  const ranks = new Map();
  order.forEach((index, position) => ranks.set(index, position + 1));
  return ranks;
}

// ---------- filters ----------

export function sectionPattern(section) {
  const clean = String(section).replace(/^§\s*/, '').trim();
  if (!/^\d+(\.\d+)*$/.test(clean)) throw new BoardError('bad_section', `section must be a section number such as 5.8, got "${section}"`);
  return new RegExp(`§\\s?${clean.replace(/\./g, '\\.')}(?!\\.?\\d)`);
}

function evidenceLine(text, test) {
  for (const line of text.split('\n')) if (test(line)) return line.trim();
  return '';
}

// ---------- excerpts ----------

/** The chunk without its title prefix; a head chunk's body is the preamble, so a bare title yields no excerpt. */
function bodyOf(chunk) {
  const lines = chunk.text.split('\n');
  return chunk.section ? lines.slice(1).join('\n') : lines.slice(2).join('\n');
}

export function excerptOf(chunk, query, max = 160) {
  if (!max) return '';
  const wanted = new Set(tokenize(query));
  let best = '';
  let bestHits = -1;
  for (const raw of bodyOf(chunk).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const hits = wanted.size ? new Set(tokenize(line).filter(token => wanted.has(token))).size : 0;
    if (hits > bestHits) { best = line; bestHits = hits; }
  }
  return clip(best, max);
}

export function clip(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (!max || flat.length <= max) return flat;
  const cut = flat.lastIndexOf(' ', max);
  return `${flat.slice(0, cut > max / 2 ? cut : max).trimEnd()}…`;
}

// ---------- the index ----------

export class SearchIndex {
  /**
   * `embedder` is an object { model, dims, embedPassages(texts), embedQuery(text) } or an async
   * factory returning one; the factory runs on the first semantic search, not at start-up.
   */
  constructor(board, { embedder = null, file } = {}) {
    this.board = board;
    this.file = file || path.join(board.dir, '.search', 'index.json');
    this._embedderSource = embedder;
    this._embedder = null;
    this.data = null;
    this.chunks = null;
    this.lexical = null;
  }

  async embedder() {
    if (this._embedder) return this._embedder;
    if (!this._embedderSource) throw new BoardError('no_model', 'no embedder configured; use mode "lexical" or run "trellis reindex"');
    this._embedder = typeof this._embedderSource === 'function' ? await this._embedderSource() : this._embedderSource;
    return this._embedder;
  }

  async load() {
    if (this.data) return this.data;
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      if (parsed && parsed.version === INDEX_VERSION && parsed.cards) { this.data = parsed; return parsed; }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    this.data = { version: INDEX_VERSION, model: null, dims: null, built: null, cards: {} };
    return this.data;
  }

  async save() {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.data), 'utf8');
    await rename(temporary, this.file);
  }

  /**
   * Bring the index up to date with the cards on disk: re-chunk what changed, drop what is
   * gone, and embed every chunk without a vector when `embed` is set. Returns the counts.
   */
  async refresh({ embed = true, force = false } = {}) {
    const data = await this.load();
    const cards = await this.board.all();
    let embedder = null;
    if (embed) {
      embedder = await this.embedder();
      if (force || (data.model && data.model !== embedder.model)) {
        for (const entry of Object.values(data.cards)) for (const chunk of entry.chunks) chunk.vector = null;
      }
      data.model = embedder.model;
      data.dims = embedder.dims;
    }
    const seen = new Set();
    const counts = { cards: cards.length, chunks: 0, added: 0, changed: 0, removed: 0, embedded: 0, pending: 0 };
    const pending = [];
    for (const card of cards) {
      const key = String(card.id);
      seen.add(key);
      const hash = cardHash(card);
      const entry = data.cards[key];
      if (!entry || entry.hash !== hash) {
        if (entry) counts.changed++; else counts.added++;
        const chunks = chunkCard(card).map(chunk => {
          const previous = entry ? entry.chunks.find(old => old.text === chunk.text && old.vector) : null;
          return { section: chunk.section, text: chunk.text, vector: previous ? previous.vector : null };
        });
        data.cards[key] = { hash, chunks };
      }
      for (const chunk of data.cards[key].chunks) { counts.chunks++; if (!chunk.vector) pending.push(chunk); }
    }
    for (const key of Object.keys(data.cards)) if (!seen.has(key)) { delete data.cards[key]; counts.removed++; }
    if (embed && pending.length) {
      const vectors = await embedder.embedPassages(pending.map(chunk => chunk.text));
      pending.forEach((chunk, index) => { chunk.vector = encodeVector(vectors[index]); });
      counts.embedded = pending.length;
    } else {
      counts.pending = pending.length;
    }
    const dirty = counts.added || counts.changed || counts.removed || counts.embedded;
    if (dirty || !data.built) {
      data.built = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      await this.save();
      this.chunks = null;
      this.lexical = null;
    }
    return counts;
  }

  _flatten() {
    if (this.chunks) return this.chunks;
    const flat = [];
    for (const [key, entry] of Object.entries(this.data.cards)) {
      for (const chunk of entry.chunks) flat.push({ cardId: Number(key), section: chunk.section, text: chunk.text, vector: chunk.vector ? decodeVector(chunk.vector) : null });
    }
    this.chunks = flat;
    this.lexical = buildLexicalIndex(flat.map(chunk => chunk.text));
    return flat;
  }

  /** Cards passing the list/kind/label/status and the exact file/§ filters, in board order, with the evidence line. */
  async filter({ list, kind, label, status = 'all', files, section } = {}) {
    if (status && status !== 'all' && !STATUSES.includes(status)) throw new BoardError('bad_status', `status must be one of ${STATUSES.join(', ')}, all`);
    const needles = (files ? (Array.isArray(files) ? files : String(files).split(',')) : []).map(file => String(file).trim().toLowerCase()).filter(Boolean);
    const pattern = section ? sectionPattern(section) : null;
    const cards = await this.board.query({ list, kind, label, status });
    const kept = [];
    for (const card of cards) {
      let evidence = '';
      if (needles.length || pattern) {
        const text = cardFullText(card);
        const lower = text.toLowerCase();
        const file = needles.find(needle => lower.includes(needle));
        if (needles.length && !file) continue;
        if (pattern && !pattern.test(text)) continue;
        evidence = evidenceLine(text, line => (file ? line.toLowerCase().includes(file) : false) || (pattern ? pattern.test(line) : false));
      }
      kept.push({ card, evidence });
    }
    return kept;
  }

  async search({ query = '', k = 10, mode = 'hybrid', list, kind, label, status = 'all', files, section, excerpt = 160 } = {}) {
    if (!MODES.includes(mode)) throw new BoardError('bad_mode', `mode must be one of ${MODES.join(', ')}`);
    const text = String(query || '').trim();
    const limit = Math.max(1, Math.min(100, Number(k) || 10));
    const semantic = Boolean(text) && mode !== 'lexical';
    const lexical = Boolean(text) && mode !== 'semantic';
    const counts = await this.refresh({ embed: semantic });
    const kept = await this.filter({ list, kind, label, status, files, section });
    const hit = ({ card, sectionName = '', score = null, excerptText = '' }) => ({
      id: card.id, title: card.title, list: card.list, kind: card.kind, status: card.status, section: sectionName, score, excerpt: excerptText,
    });
    if (!text) {
      return {
        query: '', mode: 'filter', searched: kept.length, index: counts,
        hits: kept.slice(0, limit).map(({ card, evidence }) => hit({ card, excerptText: clip(evidence, excerpt) })),
      };
    }
    const allowed = new Map(kept.map(({ card }) => [card.id, card]));
    const flat = this._flatten();
    const candidates = [];
    for (let i = 0; i < flat.length; i++) if (allowed.has(flat[i].cardId)) candidates.push(i);
    const fused = new Map();
    const add = (ranks, source) => {
      for (const [index, rank] of ranks) fused.set(index, (fused.get(index) || 0) + 1 / (RRF_K + rank));
      return source;
    };
    if (semantic) {
      const missing = candidates.filter(index => !flat[index].vector);
      if (missing.length) throw new BoardError('no_vectors', `${missing.length} chunks have no embedding; run "node tools/board/cli.mjs reindex"`);
      const vector = await (await this.embedder()).embedQuery(text);
      const scores = new Float64Array(flat.length).fill(-Infinity);
      for (const index of candidates) scores[index] = dot(vector, flat[index].vector);
      add(rankOf(scores));
    }
    if (lexical) {
      const all = bm25Scores(this.lexical, text);
      const scores = new Float64Array(flat.length);
      for (const index of candidates) scores[index] = all[index];
      add(rankOf(scores, 0));
    }
    const perCard = new Map();
    for (const [index, score] of fused) {
      const entry = perCard.get(flat[index].cardId) || [];
      entry.push({ index, score });
      perCard.set(flat[index].cardId, entry);
    }
    const ranked = [];
    for (const [cardId, entries] of perCard) {
      entries.sort((a, b) => b.score - a.score);
      const score = entries[0].score + (entries[1] ? SECOND_CHUNK_WEIGHT * entries[1].score : 0);
      ranked.push({ cardId, score, best: flat[entries[0].index] });
    }
    ranked.sort((a, b) => b.score - a.score || a.cardId - b.cardId);
    const top = ranked[0] ? ranked[0].score : 1;
    return {
      query: text, mode, searched: kept.length, matched: ranked.length, index: counts,
      hits: ranked.slice(0, limit).map(entry => hit({
        card: allowed.get(entry.cardId),
        sectionName: entry.best.section,
        score: Number((entry.score / top).toFixed(2)),
        excerptText: excerptOf(entry.best, text, excerpt),
      })),
    };
  }
}
