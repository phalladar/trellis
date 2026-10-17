// Card file format: YAML front matter, then a markdown body whose `## ` headings
// are addressable sections. A section made only of `- [ ]` items is a checklist.
// The `## Comments` section holds `### <timestamp> <author>` entries.
import YAML from 'yaml';

const META_ORDER = [
  'id', 'title', 'list', 'pos', 'kind', 'status', 'labels', 'blocked_by', 'siblings',
  'rev', 'created', 'updated', 'closed', 'trello',
];

export function parseCardFile(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') throw new Error('card file has no front matter');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error('card file has unterminated front matter');
  const meta = YAML.parse(lines.slice(1, end).join('\n')) || {};
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '');
  return { meta, body };
}

export function serializeCardFile(meta, body) {
  const ordered = {};
  for (const key of META_ORDER) {
    const value = meta[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    ordered[key] = value;
  }
  for (const key of Object.keys(meta)) {
    if (!(key in ordered) && meta[key] !== undefined && meta[key] !== null && !META_ORDER.includes(key)) ordered[key] = meta[key];
  }
  const document = new YAML.Document(ordered);
  for (const pair of document.contents.items) if (YAML.isSeq(pair.value)) pair.value.flow = true;
  const frontMatter = document.toString({ lineWidth: 0, flowCollectionPadding: false }).trimEnd();
  const trimmed = body.trim();
  return `---\n${frontMatter}\n---\n${trimmed ? `\n${trimmed}\n` : ''}`;
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^## (.+?)\s*$/;

/** Split a body into its preamble and `## ` sections; headings inside code fences are text. */
export function parseSections(body) {
  const sections = [];
  const preamble = [];
  let current = null;
  let inFence = false;
  for (const line of body.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    const heading = inFence ? null : HEADING.exec(line);
    if (heading) {
      current = { name: heading[1].trim(), lines: [] };
      sections.push(current);
      continue;
    }
    (current ? current.lines : preamble).push(line);
  }
  return {
    preamble: preamble.join('\n').trim(),
    sections: sections.map(section => ({ name: section.name, body: section.lines.join('\n').trim() })),
  };
}

export function joinSections(preamble, sections) {
  const parts = [];
  if (preamble && preamble.trim()) parts.push(preamble.trim());
  for (const section of sections) {
    const body = (section.body || '').trim();
    parts.push(body ? `## ${section.name}\n\n${body}` : `## ${section.name}`);
  }
  return parts.join('\n\n');
}

const ITEM = /^[-*] \[( |x|X)\] ?(.*)$/;

/** Items of a checklist section, or null when the section is prose. An empty section is an empty checklist. */
export function parseChecklist(body) {
  const items = [];
  for (const raw of body.split('\n')) {
    if (!raw.trim()) continue;
    const match = ITEM.exec(raw);
    if (match) {
      items.push({ done: match[1] !== ' ', text: match[2].trim() });
    } else if (items.length && /^\s{2,}\S/.test(raw)) {
      items[items.length - 1].text += `\n${raw.trim()}`;
    } else {
      return null;
    }
  }
  return items;
}

export function serializeChecklist(items) {
  return items
    .map(item => `- [${item.done ? 'x' : ' '}] ${item.text.split('\n').join('\n  ')}`)
    .join('\n');
}

const ENTRY = /^### (\S+) (.+?)\s*$/;

export function parseComments(body) {
  const comments = [];
  let current = null;
  for (const line of body.split('\n')) {
    const entry = ENTRY.exec(line);
    if (entry) {
      current = { at: entry[1], author: entry[2].trim(), lines: [] };
      comments.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return comments.map(comment => ({ at: comment.at, author: comment.author, text: comment.lines.join('\n').trim() }));
}

export function serializeComments(comments) {
  return comments.map(comment => `### ${comment.at} ${comment.author}\n\n${comment.text.trim()}`).join('\n\n');
}

export function slugify(text, max = 60) {
  const slug = String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (slug.slice(0, max).replace(/-+$/g, '')) || 'card';
}

export function nowStamp(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
