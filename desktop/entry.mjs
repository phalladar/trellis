// Trellis desktop entry point. When run from a repository checkout that contains the
// Trellis source, a packaged app can run that checkout's main.mjs, server and web UI
// directly so changes take effect without rebuilding.
import { app } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SOURCE_MARK = 'trellis:runs-from-source';

process.title = 'Trellis';
app.name = 'Trellis';
app.setName('Trellis');

const HERE = path.dirname(fileURLToPath(import.meta.url));

function settings() {
  try { return JSON.parse(readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')); } catch { return {}; }
}

function sourceMain() {
  // If running from an unpackaged source checkout, always run our own main.mjs
  if (existsSync(path.join(HERE, 'main.mjs')) && existsSync(path.join(HERE, '..', 'server.mjs'))) return null;
  if (!app.isPackaged || process.env.TRELLIS_PACKAGED) return null;
  const saved = settings();
  if (saved.runFromSource === false) return null;
  const boardDir = process.env.TRELLIS_DIR || process.env.BOARD_DIR || saved.boardDir;
  if (!boardDir) return null;
  const root = path.dirname(path.resolve(boardDir));
  const main = path.join(root, 'desktop', 'main.mjs');
  const ready = [main, path.join(root, 'server.mjs'), path.join(root, 'node_modules', 'yaml'), path.join(root, 'node_modules', 'marked')].every(file => existsSync(file));
  if (!ready) return null;
  try {
    const text = readFileSync(main, 'utf8');
    if (text.includes(SOURCE_MARK)) return main;
  } catch { /* ignore */ }
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
