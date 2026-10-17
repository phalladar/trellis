// Trellis: the board as a desktop app (trellis:runs-from-source). It runs the same server as
// `npm start` (../server.mjs) inside Electron's main process, on a free 127.0.0.1 port so it
// never collides with a board server already running on 8766, and shows its web UI in a window.
// Supports targeting any directory, creating new boards, and switching between remembered boards.
import { app, BrowserWindow, dialog, Menu, nativeTheme, Notification, shell } from 'electron';
import { existsSync, watch } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cardFromNotificationId, notificationId } from './notification-id.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FROM_SOURCE = !existsSync(path.join(HERE, 'board', 'server.mjs'));
const SERVER = FROM_SOURCE ? path.join(HERE, '..', 'server.mjs') : path.join(HERE, 'board', 'server.mjs');
const LIB_DIR = path.join(path.dirname(SERVER), 'lib');
const ACTIVITY = path.join(LIB_DIR, 'activity.mjs');
const REGISTRY = path.join(LIB_DIR, 'registry.mjs');
const STORE = path.join(LIB_DIR, 'store.mjs');
// --smoke loads the board in a hidden window, prints how many lanes rendered and quits.
const SMOKE = process.argv.includes('--smoke');
const RELAUNCHED = process.argv.includes('--relaunched');
const SETTINGS = () => path.join(app.getPath('userData'), 'settings.json');

app.setName('Trellis');

let settings = {};
let server = null;
let origin = null;
let window = null;
let activityFileFor = null;
let verbOf = null;
let registryMod = null;
let storeMod = null;
let registry = null;

const shown = [];
const highlights = new Map();
const MAX_SHOWN = 50;

async function loadSettings() {
  try { settings = JSON.parse(await readFile(SETTINGS(), 'utf8')); } catch { settings = {}; }
}

async function saveSettings() {
  try {
    await mkdir(path.dirname(SETTINGS()), { recursive: true });
    await writeFile(SETTINGS(), JSON.stringify(settings, null, 2));
  } catch (error) { console.error('could not save settings:', error.message); }
}

async function chooseBoardDir(reason) {
  const result = await dialog.showOpenDialog(window ?? undefined, {
    title: 'Open or create board folder',
    message: reason ?? 'Choose any project repository or board folder.',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const chosen = result.filePaths[0];
  const existing = registryMod.normalizeBoardDir(chosen);
  if (existing) return existing;

  const target = registryMod.targetBoardDir(chosen);
  const projectName = path.basename(registryMod.projectRootFor(target)) || 'Board';
  const confirm = await dialog.showMessageBox(window ?? undefined, {
    type: 'question',
    buttons: ['Create Board', 'Choose Another Folder…', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: `Create a new board for "${projectName}"?`,
    detail: `No board.yaml was found in ${chosen}. Trellis can initialize a new board at ${target} with default lists (Backlog, Next, Doing, Done).`,
  });
  if (confirm.response === 0) {
    await storeMod.Board.init(target, { name: projectName, lists: ['Backlog', 'Next', 'Doing', 'Done'] });
    return target;
  }
  if (confirm.response === 1) return chooseBoardDir(reason);
  return null;
}

async function resolveInitialBoardDir() {
  for (const candidate of [process.env.TRELLIS_DIR, process.env.BOARD_DIR, settings.boardDir]) {
    const dir = registryMod.normalizeBoardDir(candidate);
    if (dir) return dir;
  }
  const resolved = await registryMod.resolveActiveBoard({ registry });
  const existing = registryMod.normalizeBoardDir(resolved.boardDir);
  if (existing) return existing;
  return (await chooseBoardDir('Choose a project folder to open or initialize a board. Trellis remembers every board you open.')) || resolved.boardDir;
}

// ---------- notifications ----------

const MAX_SEPARATE = 3;

function showCard(id, highlight = {}) {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  if (id === undefined) return;
  const detail = JSON.stringify({ sections: highlight.sections ?? [], status: Boolean(highlight.status), entry: highlight.entry });
  const script = `window.showBoardCard ? window.showBoardCard(${Number(id)}, ${detail}) : (location.hash = 'card=${Number(id)}')`;
  const run = () => window.webContents.executeJavaScript(script).catch(() => {});
  if (window.webContents.isLoading()) window.webContents.once('did-finish-load', run); else run();
}

function keep(notification, highlight) {
  shown.push(notification);
  if (highlight) highlights.set(notification.id, highlight);
  while (shown.length > MAX_SHOWN) highlights.delete(shown.shift().id);
  notification.on('click', () => showCard(cardFromNotificationId(notification.id), highlights.get(notification.id)));
}

function notify({ title, body, change }) {
  const notification = new Notification({ title, body, silent: false, id: change ? notificationId(change.id) : undefined });
  keep(notification, change);
  notification.show();
}

async function reattachHistory() {
  if (process.platform !== 'darwin' || typeof Notification.getHistory !== 'function') return;
  try {
    for (const notification of await Notification.getHistory()) {
      if (cardFromNotificationId(notification.id) !== undefined) keep(notification);
    }
  } catch { /* an unsigned build has no history */ }
}

function announce({ touched, startup, unread }) {
  if (process.platform === 'darwin' && !SMOKE) app.setBadgeCount(unread);
  if (startup || settings.notifications === false || SMOKE || !Notification.isSupported()) return;
  if (window && !window.isDestroyed() && window.isFocused()) return;
  const changes = touched
    .filter(({ entry, change }) => !entry.own && (change.created || change.status) && verbOf(entry))
    .map(({ entry }) => ({ id: entry.id, title: entry.title, verb: verbOf(entry), status: !entry.created, sections: entry.sections, entry: entry.key }));
  if (!changes.length) return;
  if (changes.length <= MAX_SEPARATE) {
    for (const change of changes) notify({ title: `#${change.id} ${change.verb}`, body: change.title, change });
    return;
  }
  const counts = {};
  for (const change of changes) counts[change.verb] = (counts[change.verb] ?? 0) + 1;
  notify({ title: `${changes.length} cards changed`, body: Object.entries(counts).map(([verb, count]) => `${count} ${verb}`).join(', ') });
}

async function startServer(boardDir) {
  const { createBoardServer } = await import(pathToFileURL(SERVER).href);
  const activityDir = path.join(app.getPath('userData'), 'activity');
  const next = createBoardServer({
    boardDir,
    registry,
    activityDir,
    activityFile: activityFileFor(boardDir, activityDir),
  });
  next.on('activity', event => { if (next === server) announce(event); });
  next.on('board', async ({ boardDir: nextDir }) => {
    settings.boardDir = nextDir;
    updateWindowTitle();
    await buildMenu();
    if (!SMOKE) await saveSettings();
  });
  await new Promise((resolve, reject) => {
    next.once('error', reject);
    next.listen(0, '127.0.0.1', resolve);
  });
  if (server) await new Promise(resolve => server.close(resolve));
  server = next;
  next.recorded().then(() => { if (next === server) announce({ touched: [], startup: true, unread: next.activity.unread() }); });
  origin = `http://127.0.0.1:${server.address().port}`;
  settings.boardDir = boardDir;
  if (await next.board.exists()) {
    await registry.remember(boardDir, { setCurrent: true, touch: true });
  }
  await buildMenu();
  if (!SMOKE) await saveSettings();
}

function sameOrigin(url) {
  try { return new URL(url).origin === origin; } catch { return false; }
}

function openExternal(url) {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
}

function rememberWindow() {
  if (!window || window.isDestroyed()) return;
  settings.maximized = window.isMaximized();
  if (!settings.maximized && !window.isMinimized()) settings.bounds = window.getBounds();
}

function updateWindowTitle() {
  if (!window || window.isDestroyed()) return;
  window.setTitle(`Trellis — ${settings.boardDir}${FROM_SOURCE && app.isPackaged ? ' (from source)' : ''}`);
}

function createWindow() {
  const bounds = settings.bounds ?? { width: 1440, height: 900 };
  window = new BrowserWindow({
    ...bounds,
    minWidth: 640,
    minHeight: 420,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#15181d' : '#f4f5f7',
    title: 'Trellis',
    ...(process.platform === 'darwin' ? {} : { icon: path.join(HERE, 'build', 'icon-win.png') }),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (SMOKE) {
    window.webContents.once('did-finish-load', async () => {
      await new Promise(resolve => setTimeout(resolve, 1500));
      const lanes = await window.webContents.executeJavaScript("document.querySelectorAll('#lanes > *').length");
      const cards = await window.webContents.executeJavaScript("document.querySelectorAll('#lanes [data-id], #lanes .card').length");
      console.log(`smoke: ${origin} board=${settings.boardDir} lanes=${lanes} cards=${cards} server=${SERVER}`);
      app.exit(lanes > 0 ? 0 : 1);
    });
  } else {
    if (settings.maximized) window.maximize();
    window.once('ready-to-show', () => (RELAUNCHED ? window.showInactive() : window.show()));
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!sameOrigin(url)) openExternal(url);
    return { action: sameOrigin(url) ? 'allow' : 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (sameOrigin(url)) return;
    event.preventDefault();
    openExternal(url);
  });
  window.on('page-title-updated', event => event.preventDefault());

  window.on('resize', rememberWindow);
  window.on('move', rememberWindow);
  window.on('close', () => { if (!SMOKE) { rememberWindow(); saveSettings(); } });
  window.on('closed', () => { window = null; });

  loadBoard();
}

function loadBoard() {
  if (!window) return;
  updateWindowTitle();
  window.loadURL(`${origin}/`);
}

// ---------- running from source ----------
const TOOL = path.join(HERE, '..');
const WATCHED = /\.(mjs|js|css|html|svg|json)$/;
const SETTLE_MS = 400;
let pending = null;
let pendingTimer = null;

async function busy() {
  if (!window || window.isDestroyed() || window.webContents.isLoading()) return false;
  return window.webContents.executeJavaScript('Boolean(window.boardEditing?.())').catch(() => false);
}

async function relaunch() {
  rememberWindow();
  await saveSettings();
  const args = process.argv.slice(1).filter(arg => arg !== '--relaunched');
  app.relaunch({ args: [...args, '--relaunched'] });
  app.exit(0);
}

function sourceChanged(kind) {
  if (pending !== 'relaunch') pending = kind;
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(async function apply() {
    if (await busy()) { pendingTimer = setTimeout(apply, 2000); return; }
    const what = pending;
    pending = null;
    console.log(`source changed: ${what}`);
    if (what === 'relaunch') relaunch();
    else window?.webContents.reloadIgnoringCache();
  }, SETTLE_MS);
}

function watchSource() {
  const follow = (dir, kind, { recursive = false, only = null } = {}) => {
    try {
      watch(dir, { recursive, persistent: false }, (_event, name) => {
        if (!name || !WATCHED.test(name) || (only && !only.includes(name))) return;
        sourceChanged(kind);
      });
    } catch (error) { console.error(`cannot watch ${dir}:`, error.message); }
  };
  follow(path.join(TOOL, 'ui'), 'reload', { recursive: true });
  follow(path.join(TOOL, 'lib'), 'relaunch');
  follow(TOOL, 'relaunch', { only: ['server.mjs'] });
  follow(HERE, 'relaunch', { only: ['main.mjs', 'notification-id.mjs'] });
}

async function switchBoardDir(dir) {
  if (!dir) return;
  try {
    if (server?.switchBoard) {
      await server.switchBoard(dir, { remember: true });
      updateWindowTitle();
      await buildMenu();
    } else {
      await startServer(dir);
      loadBoard();
    }
  } catch (error) {
    dialog.showErrorBox('Could not open that board', error.message);
  }
}

async function promptSwitchBoard() {
  const dir = await chooseBoardDir();
  if (dir) await switchBoardDir(dir);
}

async function buildMenu() {
  const isMac = process.platform === 'darwin';
  const listed = registry ? await registry.list() : { boards: [] };
  const recentItems = listed.boards.slice(0, 9).map((entry, idx) => ({
    label: `${entry.name} (${entry.dir})`,
    type: 'checkbox',
    checked: entry.dir === settings.boardDir,
    accelerator: `CmdOrCtrl+${idx + 1}`,
    click: () => switchBoardDir(entry.dir),
  }));

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open or Create Board Folder…', accelerator: 'CmdOrCtrl+O', click: promptSwitchBoard },
        {
          label: 'Switch Board',
          submenu: recentItems.length
            ? recentItems
            : [{ label: 'No Remembered Boards', enabled: false }],
        },
        { label: 'Show Board Folder', click: () => settings.boardDir && shell.openPath(settings.boardDir) },
        { label: 'Open in Browser', click: () => origin && shell.openExternal(`${origin}/`) },
        { type: 'separator' },
        {
          label: 'Notify When Cards Open or Close',
          type: 'checkbox',
          checked: settings.notifications !== false,
          click: item => { settings.notifications = item.checked; saveSettings(); },
        },
        ...(app.isPackaged ? [{
          label: 'Run From Source',
          type: 'checkbox',
          checked: settings.runFromSource !== false,
          click: item => { settings.runFromSource = item.checked; relaunch(); },
        }] : []),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'dev.trellis.app' : process.execPath);

  app.whenReady().then(async () => {
    if (!app.isPackaged && process.platform === 'darwin') app.dock?.setIcon(path.join(HERE, 'build', 'icon.png'));
    ({ activityFileFor, verbOf } = await import(pathToFileURL(ACTIVITY).href));
    registryMod = await import(pathToFileURL(REGISTRY).href);
    storeMod = await import(pathToFileURL(STORE).href);
    registry = new registryMod.Registry(registryMod.defaultRegistryFile());
    await registry.load();
    await loadSettings();
    const boardDir = await resolveInitialBoardDir();
    if (!boardDir) return app.quit();
    try {
      await startServer(boardDir);
    } catch (error) {
      dialog.showErrorBox('Could not start Trellis', error.message);
      return app.quit();
    }
    createWindow();
    reattachHistory();
    if (FROM_SOURCE && !SMOKE) watchSource();
    app.on('activate', () => { if (!window) createWindow(); });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { server?.close(); });
}
