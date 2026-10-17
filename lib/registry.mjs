// Board registry: remembers board directories across the machine so the CLI, MCP
// server, web UI and desktop app can target any directory and switch between them.
// Persists in a single JSON file in the user's config folder (~/.config/trellis/boards.json
// by default, or TRELLIS_REGISTRY). When `file` is null, the registry lives in memory.
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { nowStamp, slugify } from './markdown.mjs';
import { Board, BoardError } from './store.mjs';

const VERSION = 1;
const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'project.godot', 'README.md', 'src'];

export function defaultConfigDir(env = process.env) {
  if (env.TRELLIS_HOME) return path.resolve(env.TRELLIS_HOME);
  if (process.platform === 'win32') return path.join(env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), 'trellis');
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'trellis');
}

export function defaultRegistryFile(env = process.env) {
  const override = env.TRELLIS_REGISTRY || env.BOARD_REGISTRY;
  return override ? path.resolve(override) : path.join(defaultConfigDir(env), 'boards.json');
}

export function defaultActivityDir(env = process.env) {
  if (env.TRELLIS_ACTIVITY_DIR) return path.resolve(env.TRELLIS_ACTIVITY_DIR);
  return path.join(defaultConfigDir(env), 'activity');
}

export function defaultModelsDir(env = process.env) {
  if (env.TRELLIS_MODELS_DIR) return path.resolve(env.TRELLIS_MODELS_DIR);
  return path.join(defaultConfigDir(env), 'models');
}

/**
 * Given a directory path, return the board directory if `<dir>/board.yaml` or
 * `<dir>/board/board.yaml` exists, otherwise null.
 */
export function normalizeBoardDir(candidate) {
  if (!candidate) return null;
  const full = path.resolve(String(candidate));
  if (existsSync(path.join(full, 'board.yaml'))) return full;
  if (existsSync(path.join(full, 'board', 'board.yaml'))) return path.join(full, 'board');
  return null;
}

/**
 * Walk up from `startDir` looking for a directory that holds `board.yaml` or `board/board.yaml`.
 */
export function findBoardUpwards(startDir = process.cwd()) {
  let current = path.resolve(startDir);
  for (;;) {
    const found = normalizeBoardDir(current);
    if (found) return found;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * The project root for a board directory: the parent when the board lives in `<root>/board`,
 * otherwise the board directory itself.
 */
export function projectRootFor(boardDir) {
  const resolved = path.resolve(boardDir);
  return path.basename(resolved) === 'board' ? path.dirname(resolved) : resolved;
}

/**
 * Decide where `init` or `import` should place `board.yaml` when targeting `targetDir`.
 * If `targetDir` looks like a repository root (has `.git`, `package.json`, etc.) and is not
 * already named `board`, place the board in `<targetDir>/board` unless `here: true`.
 */
export function targetBoardDir(targetDir, { here = false } = {}) {
  const resolved = path.resolve(String(targetDir));
  const existing = normalizeBoardDir(resolved);
  if (existing) return existing;
  if (here || path.basename(resolved) === 'board') return resolved;
  if (PROJECT_MARKERS.some(marker => existsSync(path.join(resolved, marker)))) {
    return path.join(resolved, 'board');
  }
  return resolved;
}

export class Registry {
  constructor(file = null) {
    this.file = file ? path.resolve(file) : null;
    this.current = null;
    this.boards = [];
    this._loaded = false;
  }

  async load() {
    if (!this.file) { this._loaded = true; return this; }
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (saved && saved.version === VERSION && Array.isArray(saved.boards)) {
        this.boards = saved.boards.map(entry => ({
          dir: path.resolve(String(entry.dir)),
          root: path.resolve(String(entry.root || projectRootFor(entry.dir))),
          name: String(entry.name || path.basename(projectRootFor(entry.dir)) || 'Board'),
          slug: String(entry.slug || slugify(entry.name || path.basename(projectRootFor(entry.dir)), 40)),
          addedAt: entry.addedAt ? String(entry.addedAt) : undefined,
          lastOpened: entry.lastOpened ? String(entry.lastOpened) : undefined,
        }));
        this.current = saved.current ? path.resolve(String(saved.current)) : (this.boards[0]?.dir || null);
      }
    } catch { /* no registry yet, or unreadable: start fresh */ }
    this._loaded = true;
    return this;
  }

  async save() {
    if (!this.file) return;
    this._saveQueue = (this._saveQueue || Promise.resolve()).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      const payload = { version: VERSION, current: this.current, boards: this.boards };
      await writeFile(temporary, JSON.stringify(payload, null, 2), 'utf8');
      await rename(temporary, this.file);
    });
    return this._saveQueue;
  }

  _uniqueSlug(base, selfDir) {
    const clean = slugify(base, 40) || 'board';
    let candidate = clean;
    for (let n = 2; this.boards.some(entry => entry.dir !== selfDir && entry.slug === candidate); n++) {
      candidate = `${clean}-${n}`;
    }
    return candidate;
  }

  /**
   * Record a board directory in the registry and optionally mark it as the active board.
   */
  async remember(candidate, { name, slug, setCurrent = true, touch = true } = {}) {
    if (!this._loaded) await this.load();
    const boardDir = normalizeBoardDir(candidate) || path.resolve(String(candidate));
    const root = projectRootFor(boardDir);
    let resolvedName = name;
    if (!resolvedName) {
      try {
        const config = await new Board(boardDir).config();
        resolvedName = config.name;
      } catch { /* board may not be initialized yet */ }
    }
    const existingIndex = this.boards.findIndex(entry => entry.dir === boardDir);
    const existing = existingIndex >= 0 ? this.boards[existingIndex] : null;
    const finalName = String(resolvedName || existing?.name || path.basename(root) || 'Board').trim();
    const folderSlug = path.basename(boardDir) === 'board' ? path.basename(root) : path.basename(boardDir);
    const finalSlug = this._uniqueSlug(slug || existing?.slug || folderSlug || finalName, boardDir);
    const now = nowStamp();
    const entry = {
      dir: boardDir,
      root,
      name: finalName,
      slug: finalSlug,
      addedAt: existing?.addedAt || now,
      lastOpened: touch ? now : (existing?.lastOpened || now),
    };
    if (existingIndex >= 0) this.boards.splice(existingIndex, 1);
    if (touch || existingIndex < 0) this.boards.unshift(entry);
    else this.boards.splice(existingIndex, 0, entry);
    if (setCurrent || !this.current) this.current = boardDir;
    await this.save();
    return entry;
  }

  /**
   * Find a remembered board entry by slug, name, directory, project root, or 1-based index.
   */
  findEntry(ref) {
    if (ref === undefined || ref === null || ref === '') return null;
    const raw = String(ref).trim();
    if (!raw) return null;
    const asPath = path.resolve(raw);
    const normalized = normalizeBoardDir(asPath);
    const exactPath = this.boards.find(entry => entry.dir === asPath || entry.root === asPath || (normalized && entry.dir === normalized));
    if (exactPath) return exactPath;
    const wanted = raw.toLowerCase();
    const exact = this.boards.find(entry =>
      entry.slug.toLowerCase() === wanted
      || entry.name.toLowerCase() === wanted
      || path.basename(entry.root).toLowerCase() === wanted
    );
    if (exact) return exact;
    if (/^\d+$/.test(raw)) {
      const idx = Number(raw) - 1;
      if (idx >= 0 && idx < this.boards.length) return this.boards[idx];
    }
    const partial = this.boards.filter(entry =>
      entry.slug.toLowerCase().includes(wanted)
      || entry.name.toLowerCase().includes(wanted)
      || entry.root.toLowerCase().includes(wanted)
    );
    if (partial.length === 1) return partial[0];
    return null;
  }

  /**
   * Resolve a user-supplied reference (path, slug, or board name) to a board directory path.
   */
  async resolve(ref, { cwd = process.cwd() } = {}) {
    if (!this._loaded) await this.load();
    if (!ref) return null;
    const raw = String(ref).trim();
    const candidatePath = path.resolve(cwd, raw);
    const onDisk = normalizeBoardDir(candidatePath);
    if (onDisk) return onDisk;
    const entry = this.findEntry(raw);
    if (entry) return entry.dir;
    return candidatePath;
  }

  /**
   * Switch the active board to a remembered board or an existing board directory on disk.
   */
  async switch(ref, { cwd = process.cwd() } = {}) {
    if (!this._loaded) await this.load();
    if (!ref || !String(ref).trim()) throw new BoardError('bad_board', 'a board path, slug or name is required');
    const resolved = await this.resolve(ref, { cwd });
    const valid = normalizeBoardDir(resolved);
    if (!valid) {
      const known = this.boards.map(entry => entry.slug).join(', ');
      throw new BoardError('no_board', `no board at "${ref}" (missing board.yaml)${known ? `; remembered boards: ${known}` : ''}`);
    }
    return this.remember(valid, { setCurrent: true, touch: true });
  }

  /**
   * Remove a board from the remembered list without deleting its files on disk.
   */
  async forget(ref, { cwd = process.cwd() } = {}) {
    if (!this._loaded) await this.load();
    const candidatePath = path.resolve(cwd, String(ref || '').trim());
    const normalized = normalizeBoardDir(candidatePath) || candidatePath;
    const entry = this.boards.find(item => item.dir === normalized || item.root === candidatePath) || this.findEntry(ref);
    if (!entry) throw new BoardError('not_found', `no remembered board matching "${ref}"`);
    this.boards = this.boards.filter(item => item.dir !== entry.dir);
    if (this.current === entry.dir) {
      const next = this.boards.find(item => Boolean(normalizeBoardDir(item.dir))) || this.boards[0] || null;
      this.current = next ? next.dir : null;
    }
    await this.save();
    return entry;
  }

  /**
   * List all remembered boards, optionally enriched with live card counts from disk.
   */
  async list({ includeStats = false } = {}) {
    if (!this._loaded) await this.load();
    let nameChanged = false;
    const items = [];
    for (const entry of this.boards) {
      const exists = Boolean(normalizeBoardDir(entry.dir));
      const item = { ...entry, exists, current: entry.dir === this.current };
      if (includeStats && exists) {
        try {
          const overview = await new Board(entry.dir).overview();
          if (overview.name && overview.name !== entry.name) {
            entry.name = overview.name;
            item.name = overview.name;
            nameChanged = true;
          }
          item.totals = overview.totals;
          item.lists = overview.lists.filter(list => !list.archived).length;
        } catch { /* ignore unreadable board */ }
      }
      items.push(item);
    }
    if (nameChanged) await this.save();
    return { current: this.current, boards: items };
  }
}

/**
 * Determine which board directory to operate on:
 *   1. Explicit `dir` argument (path, slug or name)
 *   2. `TRELLIS_DIR` or `BOARD_DIR` environment variable
 *   3. The active board in `registry` (`registry.current`), if set and present on disk
 *   4. A board in `cwd` or any parent directory (`findBoardUpwards(cwd)`)
 *   5. Most recent existing board in `registry`
 *   6. Fallback target in `cwd`
 */
export async function resolveActiveBoard({ dir, cwd = process.cwd(), env = process.env, registry = null } = {}) {
  const reg = registry || new Registry(defaultRegistryFile(env));
  await reg.load();
  const explicit = dir || env.TRELLIS_DIR || env.BOARD_DIR;
  if (explicit) {
    const resolved = await reg.resolve(explicit, { cwd });
    return { boardDir: normalizeBoardDir(resolved) || resolved, registry: reg, source: dir ? 'arg' : 'env' };
  }
  // The project you are in beats the remembered active board, so an agent started in one
  // repository never writes to the board another session last switched to.
  const upward = findBoardUpwards(cwd);
  if (upward) {
    return { boardDir: upward, registry: reg, source: 'cwd' };
  }
  if (reg.current && normalizeBoardDir(reg.current)) {
    return { boardDir: normalizeBoardDir(reg.current), registry: reg, source: 'registry' };
  }
  const existing = reg.boards.find(entry => Boolean(normalizeBoardDir(entry.dir)));
  if (existing) {
    return { boardDir: normalizeBoardDir(existing.dir), registry: reg, source: 'registry' };
  }
  return { boardDir: targetBoardDir(cwd), registry: reg, source: 'default' };
}

export function boardsTable(listResult) {
  const lines = ['active\tslug\tname\topen\tdone\tdir'];
  for (const board of listResult.boards) {
    const active = board.current ? '*' : '-';
    const open = board.totals ? String(board.totals.open) : (board.exists ? '?' : 'missing');
    const done = board.totals ? String(board.totals.done) : '-';
    lines.push([active, board.slug, board.name, open, done, board.dir].join('\t'));
  }
  if (!listResult.boards.length) lines.push('(no remembered boards)');
  return lines.join('\n');
}
