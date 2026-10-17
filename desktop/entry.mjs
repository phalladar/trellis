// Trellis desktop entry point. When run from a repository checkout that contains the
// Trellis source, a packaged app can run that checkout's main.mjs, server and web UI
// directly so changes take effect without rebuilding.
import { app } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SOURCE_MARK = 'trellis:runs-from-source';

app.setName('Trellis');

function settings() {
  try { return JSON.parse(readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')); } catch { return {}; }
}

function sourceMain() {
  if (!app.isPackaged || process.env.TRELLIS_PACKAGED || process.env.FOREMAN_PACKAGED) return null;
  const saved = settings();
  if (saved.runFromSource === false) return null;
  const boardDir = process.env.TRELLIS_DIR || process.env.BOARD_DIR || saved.boardDir;
  if (!boardDir) return null;
  const root = path.dirname(path.resolve(boardDir));
  for (const tool of [root, path.join(root, 'tools', 'board')]) {
    const main = path.join(tool, 'desktop', 'main.mjs');
    const ready = [main, path.join(tool, 'server.mjs'), path.join(tool, 'node_modules', 'yaml'), path.join(tool, 'node_modules', 'marked')].every(file => existsSync(file));
    if (!ready) continue;
    try {
      const text = readFileSync(main, 'utf8');
      if (text.includes(SOURCE_MARK) || text.includes('foreman:runs-from-source')) return main;
    } catch { /* ignore */ }
  }
  return null;
}

const main = sourceMain();
if (main) {
  try {
    await import(pathToFileURL(main).href);
  } catch (error) {
    console.error(`could not run Trellis from ${main}; running the packaged copy:`, error);
    await import('./main.mjs');
  }
} else {
  await import('./main.mjs');
}
