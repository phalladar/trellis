// Compact text projections. Every read tool returns these by default because a
// tab-separated line costs a fraction of the tokens of the same card as JSON.
import path from 'node:path';
import { parseChecklist } from './markdown.mjs';
import { DEFAULT_TEMPLATE, KINDS, stepsOf } from './store.mjs';

export const CARD_FIELDS = ['id', 'list', 'kind', 'status', 'title', 'steps', 'labels', 'blocked', 'siblings', 'updated', 'rev', 'comments'];
export const DEFAULT_FIELDS = ['id', 'list', 'kind', 'title', 'steps', 'blocked'];

function cell(card, field) {
  switch (field) {
    case 'id': return `#${card.id}`;
    case 'steps': { const steps = stepsOf(card); return steps ? `${steps.done}/${steps.total}` : '-'; }
    case 'labels': return card.labels.length ? card.labels.join(',') : '-';
    case 'blocked': return card.blocked_open && card.blocked_open.length ? card.blocked_open.map(id => `#${id}`).join(',') : '-';
    case 'siblings': return card.siblings.length ? card.siblings.map(id => `#${id}`).join(',') : '-';
    case 'updated': return (card.updated || '-').slice(0, 10);
    case 'comments': return String(card.comments.length);
    case 'rev': return `r${card.rev}`;
    default: return String(card[field] ?? '-').replace(/\s+/g, ' ');
  }
}

export function parseFields(fields) {
  if (!fields) return DEFAULT_FIELDS;
  const list = Array.isArray(fields) ? fields : String(fields).split(',');
  const clean = list.map(field => String(field).trim().toLowerCase()).filter(Boolean);
  const unknown = clean.filter(field => !CARD_FIELDS.includes(field));
  if (unknown.length) throw new Error(`unknown fields: ${unknown.join(', ')}; choose from ${CARD_FIELDS.join(', ')}`);
  return clean;
}

export function cardsTable(cards, fields = DEFAULT_FIELDS, { total, offset = 0 } = {}) {
  const lines = [fields.join('\t')];
  for (const card of cards) lines.push(fields.map(field => cell(card, field)).join('\t'));
  if (total !== undefined && total > offset + cards.length) lines.push(`… ${total - offset - cards.length} more (offset ${offset + cards.length})`);
  if (!cards.length) lines.push('(no cards)');
  return lines.join('\n');
}

export function relativeFile(card, root) {
  return root ? path.relative(root, card.file).split(path.sep).join('/') : card.file;
}

export function metaLine(card) {
  const parts = [`list: ${card.list}`, `kind: ${card.kind}`, `status: ${card.status}`, `rev: ${card.rev}`];
  if (card.labels.length) parts.push(`labels: ${card.labels.join(', ')}`);
  if (card.blocked_by.length) {
    const open = card.blocked_open || [];
    parts.push(`blocked_by: ${card.blocked_by.map(id => `#${id}`).join(' ')}${open.length ? ` (open: ${open.map(id => `#${id}`).join(' ')})` : ' (all done)'}`);
  }
  if (card.siblings.length) parts.push(`siblings: ${card.siblings.map(id => `#${id}`).join(' ')}`);
  if (card.comments.length) parts.push(`comments: ${card.comments.length}`);
  if (card.updated) parts.push(`updated: ${card.updated}`);
  if (card.closed) parts.push(`closed: ${card.closed}`);
  if (card.trello) parts.push(`trello: ${card.trello}`);
  return parts.join(' | ');
}

/** Section text a default board_card read renders before it elides the rest, in characters (~4k tokens). */
export const CARD_BUDGET = 16000;

const approxTokens = chars => {
  const tokens = Math.ceil(chars / 4);
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(tokens < 10000 ? 1 : 0)}k`;
};

// A dated or numbered tail: "Implementation note (2026-09-24)", "Carried requirements from #209".
const groupKey = name => name.replace(/[\s(#—–-]*\d[\d\s:#–-]*\)?\s*$/, '');

/**
 * One line naming every section with its size in approximate tokens. Sections that share a
 * name up to a dated or numbered tail collapse into `Name … ×N`, and that name is a prefix
 * `sections` accepts.
 */
export function sectionIndex(sections) {
  const keys = sections.map(section => groupKey(section.name));
  const groups = new Map();
  sections.forEach((section, index) => {
    const key = keys.filter(other => other === keys[index]).length > 1 && keys[index] !== section.name ? keys[index] : `=${section.name}`;
    const group = groups.get(key) || { name: key.startsWith('=') ? section.name : `${key} …`, count: 0, chars: 0 };
    group.count += 1;
    group.chars += section.body.length;
    groups.set(key, group);
  });
  const parts = [...groups.values()].map(group => `${group.name}${group.count > 1 ? ` ×${group.count}` : ''} ${approxTokens(group.chars)}`);
  return `sections (≈tokens): ${parts.length ? parts.join(' · ') : 'none'}`;
}

/** Sections named exactly, else every section the name starts (case-insensitive), in request order. */
function pickSections(card, wanted) {
  const picked = [];
  const missing = [];
  for (const name of wanted) {
    if (name === 'meta') continue;
    const exact = card.sections.filter(section => section.name.toLowerCase() === name);
    const matches = exact.length ? exact : card.sections.filter(section => section.name.toLowerCase().startsWith(name));
    if (!matches.length) missing.push(name);
    for (const section of matches) if (!picked.includes(section)) picked.push(section);
  }
  return { picked, missing };
}

/** The default read's sections: the template's always, then the rest in order while they fit CARD_BUDGET. */
function budgetSections(card, template) {
  const core = new Set(template.map(name => name.toLowerCase()));
  let used = (card.preamble || '').length;
  for (const section of card.sections) if (core.has(section.name.toLowerCase())) used += section.body.length;
  const shown = [];
  const elided = [];
  let full = false;
  for (const section of card.sections) {
    if (core.has(section.name.toLowerCase())) shown.push(section);
    else if (!full && used + section.body.length <= CARD_BUDGET) { shown.push(section); used += section.body.length; }
    else { elided.push(section); full = true; }
  }
  return { shown, elided };
}

function renderSection(section) {
  const items = parseChecklist(section.body);
  if (items && items.length) {
    const done = items.filter(item => item.done).length;
    const body = items.map((item, index) => `${index + 1}. [${item.done ? 'x' : ' '}] ${item.text.replace(/\n/g, '\n   ')}`).join('\n');
    return `## ${section.name} (${done}/${items.length})\n${body}`;
  }
  return `## ${section.name}\n${section.body || '(empty)'}`;
}

/**
 * The card as terse markdown. `sections` narrows it (an exact name, or a prefix matching every
 * section it starts; ["meta"] is the header and the section index alone). With no `sections`,
 * a card over CARD_BUDGET keeps its template sections and elides the rest unless `full`.
 * `comments` is how many recent comments to include.
 */
export function renderCard(card, { sections, comments = 3, root, full = false, template = DEFAULT_TEMPLATE } = {}) {
  const out = [`#${card.id} ${card.title}`, metaLine(card), `file: ${relativeFile(card, root)}`];
  const wanted = sections && sections.length ? sections.map(name => String(name).trim().toLowerCase()) : null;
  if (wanted && wanted.every(name => name === 'meta')) return [...out, sectionIndex(card.sections)].join('\n');
  if (wanted) {
    const { picked, missing } = pickSections(card, wanted);
    for (const section of picked) out.push('', renderSection(section));
    if (missing.length) out.push('', `(no section named or starting ${missing.map(name => `"${name}"`).join(', ')}; ${sectionIndex(card.sections)})`);
  } else {
    const { shown, elided } = full ? { shown: card.sections, elided: [] } : budgetSections(card, template);
    if (elided.length) out.push(sectionIndex(card.sections));
    if (card.preamble) out.push('', card.preamble);
    for (const section of shown) out.push('', renderSection(section));
    if (elided.length) {
      const chars = elided.reduce((sum, section) => sum + section.body.length, 0);
      out.push('', `## (${elided.length} more sections elided, ≈${approxTokens(chars)} tokens)\n${sectionIndex(elided).replace(/^sections \(≈tokens\): /, '')}\nRead them with sections: [name or prefix], or full: true.`);
    }
  }
  const count = Math.max(0, Number(comments) || 0);
  if (count && card.comments.length) {
    const shown = card.comments.slice(-count);
    const start = card.comments.length - shown.length;
    out.push('', `## Comments (${card.comments.length}${shown.length < card.comments.length ? `, last ${shown.length}` : ''})`);
    shown.forEach((comment, index) => out.push(`${start + index + 1}. [${comment.at} ${comment.author}] ${comment.text.replace(/\n/g, '\n   ')}`));
  }
  return out.join('\n');
}

/** A search result: a header, one tab-separated line per hit, and its excerpt indented beneath. */
export function searchText(result) {
  const head = result.query
    ? `"${result.query}" · ${result.mode} · ${result.hits.length} of ${result.searched} searched`
    : `filter · ${result.hits.length} of ${result.searched} matching`;
  const lines = [head, 'id\tlist\tkind\tstatus\ttitle\tsection\tscore'];
  for (const hit of result.hits) {
    const section = hit.section || (result.query ? '(title)' : '-');
    lines.push([`#${hit.id}`, hit.list, hit.kind, hit.status, hit.title, section, hit.score === null ? '-' : hit.score.toFixed(2)].join('\t'));
    if (hit.excerpt) lines.push(`    ${hit.excerpt}`);
  }
  if (!result.hits.length) lines.push('(no cards)');
  return lines.join('\n');
}

export function overviewText(overview) {
  const kinds = KINDS.map(kind => `${kind} ${overview.totals.kinds[kind]}`).join(' · ');
  const lines = [
    `${overview.name} · open ${overview.totals.open} (${kinds} · blocked ${overview.totals.blocked}) · done ${overview.totals.done} · archived ${overview.totals.archived}`,
    'id\tname\topen\tagent/human/joint\tdone',
  ];
  for (const list of overview.lists) {
    lines.push([list.id, list.name + (list.archived ? ' (archived)' : ''), list.open, KINDS.map(kind => list.kinds[kind]).join('/'), list.done].join('\t'));
  }
  lines.push(`labels: ${overview.labels.length ? overview.labels.map(label => `${label.name} (${label.color})`).join(', ') : 'none'}`);
  lines.push(`template: ${overview.template.join(', ')}`);
  lines.push('kinds: agent = an LLM can finish it alone · human = needs the owner · joint = agent builds, owner decides or approves');
  return lines.join('\n');
}
