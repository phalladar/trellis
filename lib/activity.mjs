// The board's activity feed: what changed on each card, for the bell in the web UI and for
// Foreman's notifications. The server fingerprints every card on each change on disk and
// diffs against the last fingerprint, so a write from an agent, the CLI, a pull or the
// owner's own panel is recorded alike. Changes to one card that follow each other within
// MERGE_MS become one entry, the way a social app's notification jewel groups them, and the
// entry rises to the top again unread. The feed, the fingerprint and what the owner has
// seen and read persist in one JSON file outside the repository (per machine, per board),
// so changes made while nothing was watching appear on the next start.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stepsOf } from './store.mjs';

export const VERBS = { created: 'opened', open: 'reopened', done: 'closed', archived: 'archived' };
// The comments block is not a section on disk, but the card panel shows it as one.
export const COMMENTS = 'Comments';
export const MERGE_MS = 10 * 60 * 1000;
export const MAX_ENTRIES = 300;
const EXCERPT = 140;
const VERSION = 1;

const hash = text => createHash('sha1').update(text).digest('base64').slice(0, 12);
const excerpt = text => { const line = String(text).replace(/\s+/g, ' ').trim(); return line.length > EXCERPT ? `${line.slice(0, EXCERPT - 1)}…` : line; };

// What the feed compares: plain JSON, so it persists as is.
export function fingerprint(cards) {
  const prints = {};
  for (const card of cards) {
    const steps = stepsOf(card);
    prints[card.id] = {
      title: card.title, list: card.list, status: card.status, kind: card.kind, labels: [...card.labels],
      sections: Object.fromEntries(card.sections.map(section => [section.name, hash(section.body.trim())])),
      steps: steps ? { done: steps.done, total: steps.total } : null,
      comments: card.comments.map(comment => ({ author: comment.author, text: excerpt(comment.text) })),
    };
  }
  return prints;
}

// One change per card that differs between two fingerprints. A card that disappeared is
// not reported: cards are archived, never deleted, through the board.
export function diff(before, after) {
  const changes = [];
  for (const [key, card] of Object.entries(after)) {
    const id = Number(key);
    const old = before[key];
    if (!old) {
      changes.push({ id, title: card.title, kind: card.kind, created: true, status: { from: null, to: card.status }, sections: [], added: [], edited: [], removed: [], comments: [] });
      continue;
    }
    const change = { id, title: card.title, kind: card.kind, sections: [], added: [], edited: [], removed: [], comments: [] };
    let any = false;
    if (old.status !== card.status) { change.status = { from: old.status, to: card.status }; any = true; }
    if (old.title !== card.title) { change.renamed = old.title; any = true; }
    if (old.list !== card.list) { change.list = { from: old.list, to: card.list }; any = true; }
    if (old.kind !== card.kind) { change.kindFrom = old.kind; any = true; }
    const labelsAdded = card.labels.filter(label => !old.labels.includes(label));
    const labelsRemoved = old.labels.filter(label => !card.labels.includes(label));
    if (labelsAdded.length || labelsRemoved.length) { change.labels = { added: labelsAdded, removed: labelsRemoved }; any = true; }
    for (const [name, digest] of Object.entries(card.sections)) {
      if (!(name in old.sections)) change.added.push(name);
      else if (old.sections[name] !== digest) change.edited.push(name);
    }
    change.removed = Object.keys(old.sections).filter(name => !(name in card.sections));
    change.sections = [...change.added, ...change.edited].sort((a, b) => Object.keys(card.sections).indexOf(a) - Object.keys(card.sections).indexOf(b));
    if (change.added.length || change.edited.length || change.removed.length) any = true;
    if (old.steps?.done !== card.steps?.done || old.steps?.total !== card.steps?.total) { change.steps = { from: old.steps, to: card.steps }; any = true; }
    if (card.comments.length > old.comments.length) {
      change.comments = card.comments.slice(old.comments.length);
      change.sections.push(COMMENTS);
      any = true;
    }
    if (any) changes.push(change);
  }
  return changes.sort((a, b) => a.id - b.id);
}

const union = (a, b) => [...a, ...b.filter(item => !a.includes(item))];

// Folds a later change to the same card into its entry.
function merge(entry, change) {
  entry.title = change.title;
  entry.kind = change.kind;
  if (change.status) {
    const from = entry.status ? entry.status.from : change.status.from;
    entry.status = from === change.status.to && !entry.created ? null : { from, to: change.status.to };
  }
  if (change.renamed !== undefined) {
    const from = entry.renamed ?? change.renamed;
    entry.renamed = from === change.title ? undefined : from;
  }
  if (change.list) {
    const from = entry.list ? entry.list.from : change.list.from;
    entry.list = from === change.list.to ? undefined : { from, to: change.list.to };
  }
  if (change.kindFrom !== undefined) {
    const from = entry.kindFrom ?? change.kindFrom;
    entry.kindFrom = from === change.kind ? undefined : from;
  }
  if (change.labels) {
    const added = union((entry.labels?.added ?? []).filter(label => !change.labels.removed.includes(label)), change.labels.added);
    const removed = union((entry.labels?.removed ?? []).filter(label => !change.labels.added.includes(label)), change.labels.removed);
    entry.labels = added.length || removed.length ? { added, removed } : undefined;
  }
  // A section added and then edited stays added; one added and then removed was never there.
  const addedThenRemoved = entry.added.filter(name => change.removed.includes(name));
  entry.added = union(entry.added, change.added).filter(name => !addedThenRemoved.includes(name));
  entry.edited = union(entry.edited, change.edited).filter(name => !entry.added.includes(name) && !change.removed.includes(name));
  entry.removed = union(entry.removed, change.removed).filter(name => !addedThenRemoved.includes(name) && !change.added.includes(name));
  entry.sections = union(entry.sections, change.sections).filter(name => name === COMMENTS || entry.added.includes(name) || entry.edited.includes(name));
  if (change.steps) entry.steps = { from: entry.steps ? entry.steps.from : change.steps.from, to: change.steps.to };
  entry.comments = [...entry.comments, ...change.comments].slice(-5);
  entry.commentCount = (entry.commentCount ?? 0) + change.comments.length;
}

// The verb a notification names: set when a card was created or its status moved.
export function verbOf(entry) {
  if (entry.created) return entry.status?.to === 'open' ? VERBS.created : VERBS[entry.status?.to];
  return entry.status ? VERBS[entry.status.to] : undefined;
}

export class Activity {
  constructor(file = null) {
    this.file = file;
    this.entries = [];
    this.seenAt = 0;
    this.prints = null;
    this.next = 1;
  }

  async load() {
    if (!this.file) return this;
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (saved.version !== VERSION) return this;
      this.entries = saved.entries ?? [];
      this.seenAt = saved.seenAt ?? 0;
      this.prints = saved.prints ?? null;
      this.next = saved.next ?? this.entries.length + 1;
    } catch { /* no feed yet, or an unreadable one: start fresh */ }
    return this;
  }

  async save() {
    if (!this.file) return;
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({ version: VERSION, seenAt: this.seenAt, next: this.next, entries: this.entries, prints: this.prints }));
    await rename(temp, this.file);
  }

  // Diffs the board against the last fingerprint and records what changed. `own` is the set
  // of card ids the owner just wrote through the web UI: recorded, but already read, so it
  // never badges. The first read of a board with no saved fingerprint records
  // nothing, so a fresh feed never announces the board's whole history. Returns the entries
  // this update touched, each with `change`, the part of it that is new now.
  record(cards, { now = Date.now(), own = new Set() } = {}) {
    const after = fingerprint(cards);
    const before = this.prints;
    this.prints = after;
    if (!before) return [];
    const touched = [];
    for (const change of diff(before, after)) {
      const mine = own.has(change.id);
      const recent = this.entries.find(entry => entry.id === change.id);
      let entry;
      if (recent && now - recent.at <= MERGE_MS) {
        entry = recent;
        merge(entry, change);
        entry.at = now;
        entry.own = entry.own && mine;
        if (!mine) entry.read = false;
        this.entries.splice(this.entries.indexOf(entry), 1);
      } else {
        entry = { key: (this.next++).toString(36), id: change.id, since: now, at: now, own: mine, read: mine, title: change.title, kind: change.kind, created: Boolean(change.created), status: null, sections: [], added: [], edited: [], removed: [], comments: [], commentCount: 0 };
        merge(entry, change);
      }
      this.entries.unshift(entry);
      touched.push({ entry, change });
    }
    this.entries.length = Math.min(this.entries.length, MAX_ENTRIES);
    return touched;
  }

  // The badge: entries not yet opened. The owner's own are recorded read, so never count.
  unread() {
    return this.entries.filter(entry => !entry.read).length;
  }

  view({ limit = 100 } = {}) {
    return { seenAt: this.seenAt, unread: this.unread(), entries: this.entries.slice(0, limit) };
  }

  // When the feed was last opened: what came after it is grouped as New. It does not clear
  // the badge; only reading does.
  markSeen(now = Date.now()) { this.seenAt = now; }

  markRead(keys) {
    for (const entry of this.entries) if (keys === 'all' || keys.includes(entry.key)) entry.read = true;
  }
}

// Where a host keeps the feed of one board: a file per board folder under `base`, which is
// outside the repository (Foreman's app data, or tools/board/.activity/, git-ignored).
export function activityFileFor(boardDir, base) {
  return path.join(base, `${createHash('sha1').update(path.resolve(boardDir)).digest('hex').slice(0, 12)}.json`);
}
