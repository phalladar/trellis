// Import a Trello board JSON export (Board menu → More → Print and export → Export as JSON)
// into a board directory. Card numbers (#207) and short links survive; bold headings become
// sections; checklists become checkbox sections; comments come along; closed cards are archived.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Board, KINDS } from './lib/store.mjs';
import { slugify } from './lib/markdown.mjs';

const TEMPLATE_HEADINGS = ['context', 'why this matters', 'what to do', 'success criteria', 'tests', 'references', 'steps'];
const POS_STEP = 1000;

function stamp(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function createdFromTrelloId(id) {
  if (!/^[0-9a-f]{24}$/i.test(id || '')) return undefined;
  return stamp(new Date(parseInt(id.slice(0, 8), 16) * 1000));
}

function isSectionName(name) {
  const lower = name.toLowerCase();
  return TEMPLATE_HEADINGS.includes(lower) || /addendum|implementation note|closing note|deviation/i.test(name);
}

/**
 * Trello description markdown → card body with `## ` sections.
 *
 * The cards were written as a top block of bold headings (Context, What to do, ...) and
 * then, under `---` rules, addenda that repeat those headings for their own scope. The
 * top block's headings and each addendum heading become `## ` sections; the headings
 * inside an addendum become `### ` sub-headings, so every `## ` name stays unique and
 * a section read returns an addendum whole.
 */
export function convertDescription(desc) {
  const lines = String(desc || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const topNames = new Set();
  let inFence = false;
  let pastTop = false;      // set at the first rule or addendum heading
  let afterRule = false;    // the next heading opens a new addendum
  const uniqueTop = name => {
    let candidate = name;
    for (let n = 2; topNames.has(candidate.toLowerCase()); n++) candidate = `${name} (${n})`;
    topNames.add(candidate.toLowerCase());
    return candidate;
  };
  const push = (name, level, rest) => {
    const clean = name.trim().replace(/:$/, '');
    if (level === 2) out.push(`## ${uniqueTop(clean)}`);
    else out.push(`### ${clean}`);
    if (rest) out.push('', rest);
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; out.push(line); continue; }
    if (inFence) { out.push(line); continue; }
    if (/^-{3,}$/.test(line)) { pastTop = true; afterRule = true; continue; }
    let heading = null;
    let rest = '';
    let match;
    if ((match = /^\*\*(.+?)\*\*:?\s*$/.exec(line)) && !/\*\*.*\*\*.*\*\*/.test(line)) heading = match[1];
    else if ((match = /^\*\*([^*]+?)\*\*:\s+(\S.*)$/.exec(line)) && isSectionName(match[1])) { heading = match[1]; rest = match[2]; }
    else if ((match = /^#{1,2} (.+)$/.exec(line))) heading = match[1];
    if (heading === null) { if (line.trim()) afterRule = false; out.push(line); continue; }
    const addendumLike = /addendum|implementation note|closeout|execution record|completion note/i.test(heading);
    let level;
    if (addendumLike) { level = 2; pastTop = true; }
    else if (afterRule) level = 2;
    else if (!pastTop && !topNames.has(heading.trim().replace(/:$/, '').toLowerCase())) level = 2;
    else level = 3;
    afterRule = false;
    push(heading, level, rest);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function inferKind(title, listName) {
  const name = String(title || '').trim();
  const list = String(listName || '');
  if (/^(DECIDE|SPIKE)\b/i.test(name) || /^Decide\b/.test(name)) return 'human';
  if (/3d model/i.test(list)) return 'joint';
  if (/store and business|marketing|pre-launch|launch and live/i.test(list)) return 'human';
  if (/\$\d|\bprice\b|\bpricing\b|\bsteam page\b|\bstore page\b/i.test(name)) return 'human';
  // Work that needs people in a room, a played run or the owner's device.
  const build = /^(add|ship|write|journal|cut|implement|build|make|keep|author|record|freeze|open|place|gate|raise|route|give|show|replace|rewrite|extend|harden|prove|re-prove)\b/i.test(name);
  if (!build && /\b(session|sessions|played runs?|first-time players|testers|person [AB]|discard test|go\/no-go|owner interview)\b/i.test(name)) return 'human';
  if (/^run and analyse\b|^recruit\b|\bplaytesters?\b|\bfirst-contact session\b/i.test(name)) return 'human';
  if (/\b(and decide|owner (decides|approves|signs)|sign-?off)\b/i.test(name)) return 'joint';
  return 'agent';
}

function labelName(label) {
  return (label.name && label.name.trim()) || String(label.color || 'label').replace(/_(dark|light)$/, '');
}

function labelColor(label) {
  return String(label.color || 'grey').replace(/_(dark|light)$/, '') || 'grey';
}

export function planImport(data, { name } = {}) {
  if (!data || !Array.isArray(data.lists) || !Array.isArray(data.cards)) throw new Error('this file is not a Trello board export (expected "lists" and "cards" arrays)');
  const listIds = new Map();
  const lists = [...data.lists].sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0)).map(list => {
    let id = slugify(list.name, 40);
    while ([...listIds.values()].includes(id)) id = `${id}-2`;
    listIds.set(list.id, id);
    return { id, name: list.name, archived: Boolean(list.closed), trelloId: list.id };
  });
  const labelsByName = new Map();
  for (const label of data.labels || []) {
    const key = labelName(label);
    if (!labelsByName.has(key)) labelsByName.set(key, { name: key, color: labelColor(label) });
  }
  const checklists = new Map();
  for (const checklist of data.checklists || []) {
    if (!checklists.has(checklist.idCard)) checklists.set(checklist.idCard, []);
    checklists.get(checklist.idCard).push(checklist);
  }
  const comments = new Map();
  for (const action of data.actions || []) {
    if (action.type !== 'commentCard' || !action.data?.card?.id) continue;
    if (!comments.has(action.data.card.id)) comments.set(action.data.card.id, []);
    comments.get(action.data.card.id).push({
      at: stamp(action.date) || '1970-01-01T00:00:00Z',
      author: action.memberCreator?.id === data.idMemberCreator ? 'owner' : (action.memberCreator?.username || action.memberCreator?.fullName || 'trello').replace(/\s+/g, '-'),
      text: String(action.data.text || '').trim(),
    });
  }
  const byList = new Map();
  for (const card of data.cards) {
    if (!byList.has(card.idList)) byList.set(card.idList, []);
    byList.get(card.idList).push(card);
  }
  const cards = [];
  const skipped = [];
  const notes = { skippedChecklists: [], mergedChecklists: [], renamedChecklists: [], renamedSections: [] };
  const owner = (data.members || []).find(member => member.id === data.idMemberCreator)?.username;
  let fallbackId = Math.max(0, ...data.cards.map(card => Number(card.idShort) || 0));
  for (const [trelloListId, members] of byList) {
    const listId = listIds.get(trelloListId);
    if (!listId) { skipped.push(...members.map(card => `#${card.idShort} ${card.name} (list ${trelloListId} missing)`)); continue; }
    const listName = lists.find(list => list.id === listId).name;
    members.sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
    members.forEach((card, index) => {
      let body = convertDescription(card.desc);
      const parts = [];
      const extraChecklists = [];
      const stepItems = [];
      const cardChecklists = (checklists.get(card.id) || []).sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
      const hasSteps = cardChecklists.some(checklist => /^steps$/i.test((checklist.name || '').trim()));
      for (const checklist of cardChecklists) {
        const heading = (checklist.name || '').trim() || 'Steps';
        const items = [...(checklist.checkItems || [])].sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0))
          .map(item => ({ done: item.state === 'complete', text: String(item.name || '').replace(/\s*\n\s*/g, ' ').trim() }));
        if (/^zz\b.*delete me/i.test(heading)) { notes.skippedChecklists.push(`#${card.idShort} "${heading}" (${items.length} items)`); continue; }
        const addendumSteps = /^steps \((.+)\)$/i.exec(heading);
        if (/^steps$/i.test(heading)) { stepItems.push(...items); continue; }
        if (addendumSteps) {
          const topic = addendumSteps[1].replace(/\s*addendum\s*$/i, '').trim();
          const prefix = `[${topic.charAt(0).toUpperCase()}${topic.slice(1)}] `;
          stepItems.push(...items.map(item => ({ ...item, text: item.text.startsWith('[') ? item.text : prefix + item.text })));
          notes.mergedChecklists.push(`#${card.idShort} "${heading}" → Steps`);
          continue;
        }
        if (/^what to do$/i.test(heading) && !hasSteps) { stepItems.push(...items); notes.renamedChecklists.push(`#${card.idShort} "${heading}" → Steps`); continue; }
        extraChecklists.push({ heading, items });
      }
      const checklistSection = (heading, items) => `## ${heading}\n\n${items.map(item => `- [${item.done ? 'x' : ' '}] ${item.text}`).join('\n')}`;
      const insertAfter = (text, anchorPattern, section) => {
        const anchor = anchorPattern.exec(text);
        if (!anchor) return null;
        const rest = text.slice(anchor.index + anchor[0].length);
        const nextHeading = /\n## /.exec(rest);
        const cut = nextHeading ? anchor.index + anchor[0].length + nextHeading.index : text.length;
        return `${text.slice(0, cut).trimEnd()}\n\n${section}\n${text.slice(cut)}`;
      };
      // A prose section that shares a checklist's name gives way to the checklist.
      const renameProse = name => { const pattern = new RegExp(`^## ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'im'); if (pattern.test(body)) { body = body.replace(pattern, `## ${name} (text)`); notes.renamedSections.push(`#${card.idShort} "${name}" → "${name} (text)"`); } };
      if (stepItems.length || hasSteps) {
        renameProse('Steps');
        const section = checklistSection('Steps', stepItems);
        body = insertAfter(body, /^## What to do[ \t]*$/im, section) ?? `${body}\n\n${section}`;
      }
      for (const { heading, items } of extraChecklists) {
        renameProse(heading);
        const section = checklistSection(heading, items);
        body = insertAfter(body, /^## Steps[ \t]*$/im, section) ?? insertAfter(body, /^## What to do[ \t]*$/im, section) ?? `${body}\n\n${section}`;
      }
      parts.unshift(body);
      const attachments = (card.attachments || []).filter(attachment => attachment.url);
      if (attachments.length) parts.push(`## Attachments\n\n${attachments.map(attachment => `- [${attachment.name || attachment.url}](${attachment.url})`).join('\n')}`);
      const labels = (card.labels || []).map(labelName);
      for (const label of card.labels || []) if (!labelsByName.has(labelName(label))) labelsByName.set(labelName(label), { name: labelName(label), color: labelColor(label) });
      cards.push({
        id: Number(card.idShort) || ++fallbackId,
        title: String(card.name || '').trim() || `Card ${card.idShort}`,
        list: listId,
        pos: (index + 1) * POS_STEP,
        kind: inferKind(card.name, listName),
        status: card.closed ? 'archived' : (card.dueComplete || card.dateCompleted ? 'done' : 'open'),
        labels,
        body: parts.filter(Boolean).join('\n\n'),
        comments: (comments.get(card.id) || []).sort((a, b) => a.at.localeCompare(b.at)),
        trello: card.shortLink,
        created: createdFromTrelloId(card.id),
        updated: stamp(card.dateLastActivity),
        closed: card.closed ? (stamp(card.dateClosed) || stamp(card.dateLastActivity)) : (card.dueComplete || card.dateCompleted ? (stamp(card.dateCompleted) || stamp(card.dateLastActivity)) : undefined),
        due: card.due || undefined,
        members: (card.idMembers || []).length,
      });
    });
  }
  cards.sort((a, b) => a.id - b.id);
  return { name: name || data.name || 'Board', lists, labels: [...labelsByName.values()], cards, skipped, notes, owner };
}

function reportText(plan, boardDir, { dryRun }) {
  const lines = [];
  lines.push(`${dryRun ? 'Dry run: would import' : 'Imported'} "${plan.name}" → ${boardDir}`);
  lines.push(`lists: ${plan.lists.length} (${plan.lists.filter(list => list.archived).length} archived) · cards: ${plan.cards.length} (${plan.cards.filter(card => card.status === 'done').length} done, ${plan.cards.filter(card => card.status === 'archived').length} archived) · labels: ${plan.labels.length} · comments: ${plan.cards.reduce((sum, card) => sum + card.comments.length, 0)}`);
  const kinds = Object.fromEntries(KINDS.map(kind => [kind, plan.cards.filter(card => card.status === 'open' && card.kind === kind).length]));
  lines.push(`kind guessed for open cards: agent ${kinds.agent} · human ${kinds.human} · joint ${kinds.joint} (DECIDE/SPIKE → human, 3D Models → joint, business lists → human, rest → agent; review in the UI with the kind filter)`);
  lines.push('id\tlist\topen\tagent/human/joint');
  for (const list of plan.lists) {
    const mine = plan.cards.filter(card => card.list === list.id && card.status === 'open');
    lines.push([list.id, list.name + (list.archived ? ' (archived)' : ''), mine.length, KINDS.map(kind => mine.filter(card => card.kind === kind).length).join('/')].join('\t'));
  }
  const due = plan.cards.filter(card => card.due).length;
  const members = plan.cards.filter(card => card.members).length;
  const ignored = [];
  if (due) ignored.push(`${due} due dates`);
  if (members) ignored.push(`${members} member assignments`);
  if (ignored.length) lines.push(`ignored (not part of this board): ${ignored.join(', ')}`);
  if (plan.skipped.length) lines.push(`skipped: ${plan.skipped.join('; ')}`);
  if (plan.owner) lines.push(`comments by Trello user "${plan.owner}" (the board's creator) are attributed to "owner"`);
  if (plan.notes.skippedChecklists.length) lines.push(`checklists skipped as Trello-era junk: ${plan.notes.skippedChecklists.join('; ')}`);
  if (plan.notes.mergedChecklists.length) lines.push(`addendum step checklists merged into Steps with a [Topic] prefix: ${plan.notes.mergedChecklists.join('; ')}`);
  if (plan.notes.renamedChecklists.length) lines.push(`checklists that were the card's only checklist, renamed to Steps: ${plan.notes.renamedChecklists.join('; ')}`);
  if (plan.notes.renamedSections.length) lines.push(`prose sections renamed to make room for a checklist: ${plan.notes.renamedSections.join('; ')}`);
  lines.push('Trello exports carry at most the last 1,000 actions, so comments older than that are not included.');
  return lines.join('\n');
}

export async function importTrelloData(data, boardDir, { name, dryRun = false } = {}) {
  const plan = planImport(data, { name });
  if (!dryRun) {
    const board = new Board(boardDir);
    if (await board.exists()) throw new Error(`a board already exists at ${boardDir}; import into an empty directory or remove it first`);
    await Board.init(boardDir, { name: plan.name, lists: plan.lists.map(list => ({ id: list.id, name: list.name, archived: list.archived })), labels: plan.labels });
    for (const card of plan.cards) {
      const created = await board.create({
        id: card.id, title: card.title, list: card.list, pos: card.pos, kind: card.kind, status: card.status, labels: card.labels,
        body: card.body, trello: card.trello, created: card.created, updated: card.updated, closed: card.closed,
      });
      if (card.comments.length) {
        created.comments = card.comments;
        created.updated = card.updated || created.updated;
        await board._write(created, { touch: false });
        board._cache.delete(path.basename(created.file));
      }
    }
  }
  return { plan, text: reportText(plan, boardDir, { dryRun }) };
}

export async function importTrelloExport(file, boardDir, { name, dryRun = false } = {}) {
  const data = JSON.parse(await readFile(file, 'utf8'));
  return importTrelloData(data, boardDir, { name, dryRun });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, target] = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
  const dryRun = process.argv.includes('--dry-run');
  if (!file) { console.error('usage: trellis import <trello-export.json> [board-dir] [--dry-run]'); process.exit(2); }
  const boardDir = target || process.env.TRELLIS_DIR || process.env.BOARD_DIR || path.resolve(process.cwd(), 'board');
  try { console.log((await importTrelloExport(file, boardDir, { dryRun })).text); } catch (error) { console.error(`error: ${error.message}`); process.exit(1); }
}
