// After a Trello import, rewrite trello.com card links in repository documents so they
// point at the board card instead. Markdown links become relative links to the card
// file; bare URLs become "#<id>". Links whose short link was not imported are left alone.
//   trellis relink [--dry-run] [--all] [file|dir ...]
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRootFor, resolveActiveBoard } from './lib/registry.mjs';
import { Board } from './lib/store.mjs';

export const DEFAULT_DOCS = ['README.md', 'ROADMAP.md', 'DESIGN.md', 'CHANGELOG.md', 'docs'];
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.venv', '__pycache__', '.next', '.cache']);
const LINK = /\[([^\]]*)\]\(https?:\/\/trello\.com\/c\/([A-Za-z0-9]+)(?:\/[^)\s]*)?\)/g;
const BARE = /https?:\/\/trello\.com\/c\/([A-Za-z0-9]+)(?:\/[\w.-]*)?/g;

async function collectMarkdown(dir, skipDir, out = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (skipDir && path.resolve(full) === path.resolve(skipDir)) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await collectMarkdown(full, skipDir, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

async function targetFiles(targets, root, boardDir, { all = false } = {}) {
  if (!targets || !targets.length) {
    if (all) return collectMarkdown(root, boardDir);
    const topEntries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const topMd = topEntries.filter(entry => entry.isFile() && entry.name.endsWith('.md')).map(entry => path.join(root, entry.name));
    const docsDir = path.join(root, 'docs');
    const docsMd = await collectMarkdown(docsDir, boardDir);
    return [...new Set([...topMd, ...docsMd])];
  }
  const out = [];
  for (const target of targets) {
    const full = path.resolve(root, target);
    let info;
    try { info = await stat(full); } catch { continue; }
    if (info.isDirectory()) {
      await collectMarkdown(full, boardDir, out);
    } else {
      out.push(full); // a file named explicitly is rewritten whatever its extension (manifests, scripts)
    }
  }
  return out;
}

export function relinkText(text, file, cards) {
  const byShort = new Map(cards.filter(card => card.trello).map(card => [card.trello, card]));
  let replaced = 0;
  const missing = new Set();
  const cardLink = card => path.relative(path.dirname(file), card.file).split(path.sep).join('/');
  let out = text.replace(LINK, (whole, label, short) => {
    const card = byShort.get(short);
    if (!card) { missing.add(short); return whole; }
    replaced++;
    return `[${label}](${cardLink(card)})`;
  });
  out = out.replace(BARE, (whole, short) => {
    const card = byShort.get(short);
    if (!card) { missing.add(short); return whole; }
    replaced++;
    return `#${card.id}`;
  });
  return { text: out, replaced, missing: [...missing] };
}

export async function relink({ boardDir, root, targets, all = false, dryRun = false } = {}) {
  const board = new Board(boardDir);
  const projectRoot = root ? path.resolve(root) : projectRootFor(board.dir);
  const cards = await board.all();
  const report = [];
  const missing = new Set();
  for (const file of await targetFiles(targets, projectRoot, board.dir, { all })) {
    const before = await readFile(file, 'utf8');
    const result = relinkText(before, file, cards, projectRoot);
    for (const short of result.missing) missing.add(short);
    if (!result.replaced) continue;
    if (!dryRun) await writeFile(file, result.text, 'utf8');
    report.push({ file: path.relative(projectRoot, file).split(path.sep).join('/'), replaced: result.replaced });
  }
  const lines = report.map(entry => `${entry.file}\t${entry.replaced}`);
  lines.unshift(`${dryRun ? 'Would rewrite' : 'Rewrote'} ${report.reduce((sum, entry) => sum + entry.replaced, 0)} Trello card links in ${report.length} files`);
  if (missing.size) lines.push(`left alone (no imported card carries these short links): ${[...missing].join(', ')}`);
  return { report, missing: [...missing], text: lines.join('\n') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const all = args.includes('--all');
  const files = args.filter(arg => !arg.startsWith('--'));
  try {
    const { boardDir } = await resolveActiveBoard();
    console.log((await relink({ boardDir, targets: files.length ? files : undefined, all, dryRun })).text);
  } catch (error) { console.error(`error: ${error.message}`); process.exit(1); }
}
