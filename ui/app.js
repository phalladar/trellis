import { marked } from '/vendor/marked.esm.js';

marked.use({ gfm: true, breaks: false });

const ICON = {
  agent: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="5" width="11" height="8.5" rx="2"/><rect x="7.25" y="1.5" width="1.5" height="3.5"/><circle cx="6" cy="9.2" r="1.3" fill="var(--card)"/><circle cx="10" cy="9.2" r="1.3" fill="var(--card)"/></svg>',
  human: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="4.8" r="3"/><path d="M1.8 14.5c0-3.5 2.8-5.8 6.2-5.8s6.2 2.3 6.2 5.8z"/></svg>',
  joint: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.8" cy="4.6" r="2.5"/><path d="M.6 14.2c0-3 1.9-4.8 4.2-4.8s4.2 1.8 4.2 4.8z"/><rect x="9" y="6" width="6.5" height="5.5" rx="1.4"/><circle cx="11" cy="8.7" r=".9" fill="var(--card)"/><circle cx="13.5" cy="8.7" r=".9" fill="var(--card)"/><rect x="11.7" y="3.6" width="1.1" height="2.4"/></svg>',
};
const KIND_WORD = { agent: 'Agent', human: 'Human', joint: 'Joint' };
const KIND_HELP = { agent: 'an LLM can finish it alone', human: 'needs the owner', joint: 'agent builds, owner decides or approves' };

const state = {
  board: null, cards: [], q: '', kind: '', label: '', showDone: false, showArchived: false, blockedOnly: false,
  openId: null, card: null, editors: 0, staleWhileEditing: false, newCardList: null,
  // What to point at when the card next opens: { id, sections, status } (showBoardCard).
  highlight: null,
  // The feed entry whose changes the open card's banner describes: { id, key }.
  banner: null,
  // The bell's feed (GET /api/activity), whether it is open, its filter, and the seenAt it
  // was opened with, which splits New from Earlier until it closes.
  activity: { entries: [], seenAt: 0, unread: 0 }, activityOpen: false, activityFilter: 'all', newSince: 0,
  // Remembered boards and the directory switcher (GET /api/boards, GET /api/fs/dirs).
  boards: { current: null, boards: [] }, boardMenuOpen: false, dirBrowser: null, targetDir: '',
  // True while this page opens, creates or imports a board (switchBoard).
  switching: false,
  infoOpen: false,
};
let drag = null;

const $ = selector => document.querySelector(selector);
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child !== undefined && child !== null && child !== false) node.append(child.nodeType ? child : document.createTextNode(String(child)));
  return node;
}

async function api(method, url, body) {
  const response = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || response.statusText);
    Object.assign(error, { code: data.error?.code, current: data.error?.current });
    throw error;
  }
  return data;
}

let statusTimer = null;
function setStatus(text, isError = false) {
  const node = $('#status');
  node.textContent = text;
  node.classList.toggle('err', isError);
  clearTimeout(statusTimer);
  if (!isError) statusTimer = setTimeout(() => { node.textContent = ''; }, 2500);
}

async function attempt(label, fn) {
  try {
    const result = await fn();
    setStatus(label);
    return result;
  } catch (error) {
    setStatus(error.message, true);
    if (error.code === 'conflict') await openCard(state.openId, { force: true });
    return undefined;
  }
}

function shortPath(dir) {
  if (!dir) return '';
  return String(dir).replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

function kindBadge(kind, { help = false } = {}) {
  const badge = el('span', { class: `kind-badge kind-${kind}`, title: KIND_HELP[kind], html: `${ICON[kind]}<span>${KIND_WORD[kind]}</span>` });
  return help ? el('span', { class: 'legend-item' }, badge, ` ${KIND_HELP[kind]}`) : badge;
}

function renderInline(text) {
  const box = el('span', { html: marked.parseInline(text || '') });
  for (const link of box.querySelectorAll('a')) { link.target = '_blank'; link.rel = 'noopener'; }
  return box;
}

function labelChip(name, { onRemove } = {}) {
  const color = state.board?.labels.find(label => label.name === name)?.color || 'grey';
  const chip = el('span', { class: `chip label-${color}` }, name);
  if (onRemove) chip.append(el('span', { class: 'x', title: 'Remove label', onclick: event => { event.stopPropagation(); onRemove(); } }, '×'));
  return chip;
}

function listName(id) {
  return state.board?.lists.find(list => list.id === id)?.name || id;
}

function cardById(id) {
  return state.cards.find(card => card.id === id);
}

function refChip(id, { onRemove } = {}) {
  const target = cardById(id);
  const status = target ? target.status : 'missing';
  const chip = el('span', { class: `chip ref link ${status === 'open' ? 'open' : status}`, title: target ? `${target.title} (${listName(target.list)}, ${target.status})` : 'not found', onclick: event => { event.stopPropagation(); location.hash = `card=${id}`; } }, `#${id}`);
  if (onRemove) chip.append(el('span', { class: 'x', onclick: event => { event.stopPropagation(); onRemove(); } }, '×'));
  return chip;
}

// ---------- markdown ----------

function renderMarkdown(text) {
  const box = el('div', { html: marked.parse(text || '') });
  for (const link of box.querySelectorAll('a')) {
    const href = link.getAttribute('href') || '';
    if (href.startsWith('#card=')) continue;
    link.target = '_blank';
    link.rel = 'noopener';
  }
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.parentElement.closest('a, code, pre')) continue;
    if (!/#\d+/.test(node.nodeValue)) continue;
    const fragment = document.createDocumentFragment();
    let last = 0;
    for (const match of node.nodeValue.matchAll(/(^|[^\w&])#(\d+)\b/g)) {
      fragment.append(node.nodeValue.slice(last, match.index + match[1].length));
      fragment.append(el('a', { href: `#card=${match[2]}` }, `#${match[2]}`));
      last = match.index + match[0].length;
    }
    fragment.append(node.nodeValue.slice(last));
    node.replaceWith(fragment);
  }
  return box;
}

// ---------- board ----------

// One load at a time. A call while one runs waits for it and then one more, which every
// caller arriving meanwhile shares, so a burst of change events costs two loads, not one each.
let refreshing = null;
let refreshAgain = false;
function refresh() {
  if (refreshing) { refreshAgain = true; return refreshing; }
  refreshing = (async () => {
    try {
      do { refreshAgain = false; await loadBoard(); } while (refreshAgain);
    } finally { refreshing = null; }
  })();
  return refreshing;
}

async function loadBoard() {
  const query = state.q ? `&q=${encodeURIComponent(state.q)}` : '';
  [state.board, state.cards] = await Promise.all([api('GET', '/api/board'), api('GET', `/api/cards?status=all${query}`)]);
  render();
  if (state.openId !== null) await openCard(state.openId, { silent: true });
}

// ---------- loading ----------

// Marks the page as loading a board: the status says which, the board button names it at
// once and shows a spinner, and a bar runs under the toolbar while the lanes dim. The
// visual part waits LOADING_DELAY_MS so a quick switch does not flash. Returns the function
// that ends it; only the latest load's ends it, so overlapping switches cannot end early.
const LOADING_DELAY_MS = 150;
let loadingToken = 0;
let loadingTimer = null;
function beginLoading(name) {
  const token = ++loadingToken;
  const label = name ? `Opening ${name}…` : 'Loading board…';
  const status = $('#status');
  clearTimeout(statusTimer);
  status.textContent = label;
  status.classList.remove('err');
  if (name) $('#board-name').textContent = name;
  for (const node of [$('#board-button'), $('#lanes')]) node.setAttribute('aria-busy', 'true');
  clearTimeout(loadingTimer);
  loadingTimer = setTimeout(() => { if (token === loadingToken) document.body.classList.add('loading'); }, LOADING_DELAY_MS);
  return () => {
    if (token !== loadingToken) return;
    clearTimeout(loadingTimer);
    document.body.classList.remove('loading');
    for (const node of [$('#board-button'), $('#lanes')]) node.removeAttribute('aria-busy');
    if (status.textContent === label) status.textContent = '';
  };
}

function visibleCards(listId) {
  return state.cards
    .filter(card => card.list === listId)
    .filter(card => card.status === 'open' || (card.status === 'done' && state.showDone) || (card.status === 'archived' && state.showArchived))
    .filter(card => !state.kind || card.kind === state.kind)
    .filter(card => !state.label || (state.label.startsWith('!') ? !card.labels.includes(state.label.slice(1)) : card.labels.includes(state.label)))
    .filter(card => !state.blockedOnly || card.blocked_open.length)
    .sort((a, b) => a.pos - b.pos || a.id - b.id);
}

function render() {
  renderTitle();
  $('#board-name').textContent = state.board.name;
  $('#board-path').textContent = shortPath(state.board.root || state.board.dir);
  $('#board-button').title = `${state.board.name} — ${state.board.dir || ''}\nClick to switch or open a board directory`;
  const labelFilter = $('#label-filter');
  const current = labelFilter.value;
  labelFilter.replaceChildren(el('option', { value: '' }, 'Any label'), ...state.board.labels.map(label => el('option', { value: label.name }, label.name)),
    el('optgroup', { label: 'Hide a label' }, ...state.board.labels.map(label => el('option', { value: `!${label.name}` }, `Without ${label.name}`))));
  labelFilter.value = state.board.labels.some(label => label.name === current.replace(/^!/, '')) ? current : '';
  for (const kind of Object.keys(KIND_WORD)) {
    const button = $(`#kind-filter button[data-kind="${kind}"]`);
    button.innerHTML = `${ICON[kind]}<span>${KIND_WORD[kind]}</span>`;
    button.title = KIND_HELP[kind];
  }
  $('#legend').replaceChildren(...Object.keys(KIND_WORD).map(kind => kindBadge(kind, { help: true })), el('span', {}, `${state.board.totals.open} open · ${state.board.totals.done} done · ${state.board.totals.blocked} blocked`));

  const lanes = $('#lanes');
  lanes.replaceChildren();
  if (state.board.empty) {
    lanes.append(el('div', { class: 'empty-board' },
      el('div', {}, `No board at ${shortPath(state.board.dir)} yet.`),
      el('button', { type: 'button', class: 'primary', onclick: () => openBoardMenu() }, 'Open or create a board…')));
    return;
  }
  const lists = state.board.lists.filter(list => !list.archived || state.showArchived);
  if (!lists.length) {
    lanes.append(el('div', { class: 'empty-board' },
      el('div', {}, 'No lists yet.'),
      el('button', { type: 'button', class: 'primary', onclick: triggerAddList }, '+ Add a list')));
    return;
  }
  for (const list of lists) lanes.append(renderLane(list));
}

function renderLane(list) {
  const cards = visibleCards(list.id);
  const kinds = ['agent', 'human', 'joint'].map(kind => {
    const count = cards.filter(card => card.kind === kind && card.status === 'open').length;
    return count ? el('i', { style: `background: var(--${kind})`, title: `${count} ${kind}` }, count) : null;
  });
  const head = el('header', { class: 'lane-head', draggable: 'true' },
    el('h2', {}, list.name), el('span', { class: 'kinds' }, ...kinds), el('span', { class: 'count' }, cards.length),
    el('button', { class: 'ghost lane-menu', title: 'List actions', onclick: event => laneMenu(event, list) }, '⋯'));
  head.addEventListener('dragstart', event => { drag = { type: 'list', id: list.id }; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', `list:${list.id}`); });
  head.addEventListener('dragend', () => { drag = null; clearDropMarks(); });

  const body = el('div', { class: 'lane-cards' }, ...cards.map(renderCard));
  body.addEventListener('dragover', event => onCardDragOver(event, body));
  body.addEventListener('drop', event => onCardDrop(event, list, body));
  body.addEventListener('dragleave', event => { if (!body.contains(event.relatedTarget)) removePlaceholder(); });

  const footer = el('footer', {});
  if (state.newCardList === list.id) footer.append(newCardForm(list));
  else footer.append(el('button', { onclick: () => { state.newCardList = list.id; render(); setTimeout(() => $('.new-card input')?.focus(), 0); } }, '+ Add card'));

  const lane = el('section', { class: `lane${list.archived ? ' archived' : ''}`, dataset: { list: list.id } }, head, body, footer);
  lane.addEventListener('dragover', event => onLaneDragOver(event, lane));
  lane.addEventListener('drop', event => onLaneDrop(event, list));
  return lane;
}

function newCardForm(list) {
  let kind = 'agent';
  const input = el('input', { type: 'text', placeholder: 'Imperative title…' });
  const segmented = el('div', { class: 'segmented' });
  const paint = () => { for (const button of segmented.children) button.classList.toggle('on', button.dataset.kind === kind); };
  for (const key of Object.keys(KIND_WORD)) {
    segmented.append(el('button', { type: 'button', class: `kind-${key}`, dataset: { kind: key }, title: KIND_HELP[key], html: `${ICON[key]}<span>${KIND_WORD[key]}</span>`, onclick: () => { kind = key; paint(); } }));
  }
  paint();
  const submit = async () => {
    const title = input.value.trim();
    if (!title) return;
    const created = await attempt(`Created #?`, () => api('POST', '/api/cards', { title, list: list.id, kind }));
    state.newCardList = null;
    if (created) { setStatus(`Created #${created.id}`); await refresh(); location.hash = `card=${created.id}`; }
  };
  input.addEventListener('keydown', event => { if (event.key === 'Enter') submit(); if (event.key === 'Escape') { state.newCardList = null; render(); } });
  return el('div', { class: 'new-card' }, input, el('div', { class: 'row' }, segmented, el('button', { class: 'primary', onclick: submit }, 'Add'), el('button', { class: 'ghost', onclick: () => { state.newCardList = null; render(); } }, 'Cancel')));
}

function renderCard(card) {
  const meta = el('div', { class: 'card-meta' });
  for (const label of card.labels) meta.append(labelChip(label));
  if (card.steps && card.steps.total) {
    const percent = Math.round((card.steps.done / card.steps.total) * 100);
    meta.append(el('span', { class: `steps${percent === 100 ? ' complete' : ''}`, title: 'Steps' }, el('span', { class: 'bar' }, el('i', { style: `width:${percent}%` })), `${card.steps.done}/${card.steps.total}`));
  }
  if (card.blocked_open.length) meta.append(el('span', { class: 'blocked', title: 'Blocked by open cards' }, `⛔ ${card.blocked_open.map(id => `#${id}`).join(' ')}`));
  if (card.comments) meta.append(el('span', { title: 'Comments' }, `💬 ${card.comments}`));
  const node = el('article', { class: `card kind-${card.kind}${card.status !== 'open' ? ' done' : ''}`, draggable: 'true', dataset: { id: card.id }, onclick: () => { location.hash = `card=${card.id}`; } },
    el('div', { class: 'card-top' }, kindBadge(card.kind), el('span', { class: 'card-id' }, `#${card.id}`)),
    el('div', { class: 'card-title' }, card.title), meta);
  node.addEventListener('dragstart', event => { drag = { type: 'card', id: card.id }; node.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', `card:${card.id}`); event.stopPropagation(); });
  node.addEventListener('dragend', () => { node.classList.remove('dragging'); drag = null; removePlaceholder(); clearDropMarks(); });
  return node;
}

// ---------- drag and drop ----------

let placeholder = null;
function removePlaceholder() { placeholder?.remove(); placeholder = null; }
function clearDropMarks() { for (const lane of document.querySelectorAll('.lane')) lane.classList.remove('drop-before', 'drop-after'); }

function onCardDragOver(event, body) {
  if (drag?.type !== 'card') return;
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = 'move';
  placeholder ||= el('div', { class: 'placeholder' });
  const cards = [...body.querySelectorAll('.card:not(.dragging)')];
  const next = cards.find(card => event.clientY < card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2);
  if (next) body.insertBefore(placeholder, next); else body.append(placeholder);
}

async function onCardDrop(event, list, body) {
  if (drag?.type !== 'card') return;
  event.preventDefault();
  event.stopPropagation();
  const id = drag.id;
  const before = placeholder?.nextElementSibling?.dataset.id;
  const after = placeholder?.previousElementSibling?.dataset.id;
  removePlaceholder();
  const payload = { list: list.id };
  if (before) payload.before = Number(before);
  else if (after) payload.after = Number(after);
  else payload.position = 'bottom';
  await attempt(`Moved #${id}`, () => api('POST', `/api/cards/${id}/move`, payload));
  await refresh();
}

function onLaneDragOver(event, lane) {
  if (drag?.type !== 'list') { if (drag?.type === 'card') { event.preventDefault(); } return; }
  event.preventDefault();
  const rect = lane.getBoundingClientRect();
  clearDropMarks();
  lane.classList.add(event.clientX < rect.left + rect.width / 2 ? 'drop-before' : 'drop-after');
}

async function onLaneDrop(event, list) {
  if (drag?.type === 'card') {
    event.preventDefault();
    const id = drag.id;
    removePlaceholder();
    await attempt(`Moved #${id}`, () => api('POST', `/api/cards/${id}/move`, { list: list.id, position: 'bottom' }));
    return refresh();
  }
  if (drag?.type !== 'list' || drag.id === list.id) return;
  event.preventDefault();
  const lane = event.currentTarget;
  const before = lane.classList.contains('drop-before');
  clearDropMarks();
  await attempt(`Moved list`, () => api('POST', '/api/lists', { action: 'move', list: drag.id, [before ? 'before' : 'after']: list.id }));
  await refresh();
}

// ---------- list actions & prompt dialog ----------

function promptDialog({ title = 'Prompt', message = '', placeholder = '', defaultValue = '', confirmLabel = 'Save' } = {}) {
  return new Promise(resolve => {
    const dialog = el('div', { class: 'prompt-dialog', role: 'dialog', ariaLabel: title });
    const input = el('input', { type: 'text', placeholder, value: defaultValue });
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      dialog.remove();
      backdrop.remove();
      document.removeEventListener('keydown', onKeyDown);
    };
    const submit = () => {
      const val = input.value.trim();
      cleanup();
      resolve(val || null);
    };
    const cancel = () => {
      cleanup();
      resolve(null);
    };
    const form = el('form', { onsubmit: e => { e.preventDefault(); submit(); } },
      el('h3', {}, title),
      message ? el('p', { class: 'prompt-message' }, message) : null,
      input,
      el('div', { class: 'prompt-actions' },
        el('button', { type: 'button', class: 'ghost', onclick: cancel }, 'Cancel'),
        el('button', { type: 'submit', class: 'primary' }, confirmLabel),
      ),
    );
    dialog.append(form);
    const backdrop = el('div', { class: 'prompt-backdrop', onclick: cancel });
    const onKeyDown = event => {
      if (event.key === 'Escape') cancel();
    };
    document.addEventListener('keydown', onKeyDown);
    document.body.append(backdrop, dialog);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 10);
  });
}

let activeLaneMenu = null;
function closeLaneMenu() {
  if (activeLaneMenu) {
    activeLaneMenu.remove();
    activeLaneMenu = null;
  }
}
document.addEventListener('click', () => closeLaneMenu());

function laneMenu(event, list) {
  event.stopPropagation();
  closeLaneMenu();
  const menu = el('div', { class: 'lane-dropdown', role: 'menu' },
    el('button', {
      type: 'button',
      onclick: () => {
        closeLaneMenu();
        state.newCardList = list.id;
        render();
        setTimeout(() => $('.new-card input')?.focus(), 0);
      },
    }, '+ Add card'),
    el('button', {
      type: 'button',
      onclick: async () => {
        closeLaneMenu();
        const newName = await promptDialog({
          title: 'Rename list',
          defaultValue: list.name,
          confirmLabel: 'Rename',
        });
        if (newName && newName.trim() && newName.trim() !== list.name) {
          await attempt('Renamed', () => api('POST', '/api/lists', { action: 'rename', list: list.id, new_name: newName.trim() }));
          await refresh();
        }
      },
    }, 'Rename list…'),
    el('button', {
      type: 'button',
      class: list.archived ? '' : 'danger',
      onclick: async () => {
        closeLaneMenu();
        await attempt(list.archived ? 'Restored' : 'Archived', () => api('POST', '/api/lists', { action: list.archived ? 'restore' : 'archive', list: list.id }));
        await refresh();
      },
    }, list.archived ? 'Restore list' : 'Archive list'),
  );
  menu.addEventListener('click', e => e.stopPropagation());
  const header = event.currentTarget.closest('.lane-head');
  if (header) {
    header.append(menu);
    activeLaneMenu = menu;
  }
}

// ---------- board switcher & directory manager ----------

async function loadBoards() {
  state.boards = await api('GET', '/api/boards');
  if (!state.targetDir) state.targetDir = state.board?.root || state.boards.root || '~';
  if (state.boardMenuOpen) renderBoardMenu();
}

async function loadDirs(targetPath) {
  state.targetDir = targetPath;
  try {
    state.dirBrowser = await api('GET', `/api/fs/dirs?path=${encodeURIComponent(targetPath)}`);
  } catch {
    state.dirBrowser = null;
  }
  if (state.boardMenuOpen) renderDirBrowser();
}

async function openBoardMenu() {
  closeInfoModal();
  closeActivity();
  state.boardMenuOpen = true;
  $('#board-menu').hidden = false;
  $('#board-button').setAttribute('aria-expanded', 'true');
  state.targetDir = state.board?.root || '~';
  await Promise.all([loadBoards(), loadDirs(state.targetDir)]);
  renderBoardMenu();
  $('#board-dir-input')?.focus();
}

function closeBoardMenu({ focus = false } = {}) {
  if (!state.boardMenuOpen) return;
  state.boardMenuOpen = false;
  $('#board-menu').hidden = true;
  $('#board-button').setAttribute('aria-expanded', 'false');
  if (focus) $('#board-button').focus();
}

// Opening, creating or importing a board: shows the loading state from the click until the
// new board's cards are on screen, and loads them once. The server's 'switching' and 'board'
// events for a switch this page asked for are ignored while it runs (connectEvents).
async function switchBoard(name, request, doneLabel) {
  const done = beginLoading(name);
  state.switching = true;
  try {
    let result;
    try { result = await request(); } catch (error) { setStatus(error.message, true); return null; }
    state.boards = result;
    closeBoardMenu();
    closePanel();
    await Promise.all([refresh(), loadActivity()]);
    setStatus(doneLabel(state.board?.name || name || 'board'));
    return result;
  } finally {
    state.switching = false;
    done();
  }
}

async function selectBoardDir(dir, name) {
  return switchBoard(name, () => api('POST', '/api/boards/select', { dir }), boardName => `Opened ${boardName}`);
}

async function forgetBoardDir(dir, name) {
  const result = await attempt(`Forgot ${name}`, () => api('POST', '/api/boards/forget', { dir }));
  if (!result) return;
  state.boards = result;
  await Promise.all([refresh(), loadActivity()]);
  renderBoardMenu();
}

function renderDirBrowser() {
  const container = $('#dir-browser-slot');
  if (!container) return;
  container.replaceChildren();
  const info = state.dirBrowser;
  if (!info) return;

  const list = el('div', { class: 'dir-browser' });
  if (info.parent) {
    list.append(el('button', {
      type: 'button',
      class: 'dir-item',
      onclick: () => {
        const input = $('#board-dir-input');
        if (input) input.value = info.parent;
        loadDirs(info.parent);
      },
    }, el('span', {}, `↑ .. (${shortPath(info.parent)})`)));
  }
  for (const item of info.dirs) {
    list.append(el('button', {
      type: 'button',
      class: 'dir-item',
      onclick: () => {
        const input = $('#board-dir-input');
        if (input) input.value = item.path;
        loadDirs(item.path);
      },
    },
    el('span', {}, `📁 ${item.name}`),
    item.hasBoard ? el('span', { class: 'tag' }, 'Board') : null));
  }
  if (!info.dirs.length && !info.parent) {
    list.append(el('div', { style: 'padding:4px 8px;color:var(--muted);font-size:12px' }, 'No subdirectories'));
  }

  const actions = el('div', { class: 'dir-actions' });
  const targetPath = ($('#board-dir-input')?.value || state.targetDir || info.base).trim();
  const folderName = targetPath.split(/[\\/]/).filter(Boolean).pop() || 'Board';

  if (info.hasBoard && targetPath === info.base) {
    actions.append(el('div', { class: 'row' },
      el('span', { style: 'font-size:12px;color:var(--ok);font-weight:600;flex:1' }, `✓ Existing board found in ${shortPath(info.boardDir)}`),
      el('button', { type: 'button', class: 'primary', onclick: () => selectBoardDir(info.boardDir) }, 'Open board')));
  } else {
    const nameInput = el('input', { type: 'text', value: folderName, placeholder: 'Board name' });
    const listsInput = el('input', { type: 'text', value: 'Backlog, Next, Doing, Done', placeholder: 'Lists (comma-separated)' });
    const createBtn = el('button', {
      type: 'button',
      class: 'primary',
      onclick: async () => {
        const dir = ($('#board-dir-input')?.value || state.targetDir).trim();
        if (!dir) return;
        const name = nameInput.value.trim() || folderName;
        await switchBoard(name, () => api('POST', '/api/boards/init', { dir, name, lists: listsInput.value }), boardName => `Created ${boardName}`);
      },
    }, 'Create board here');

    const fileInput = el('input', {
      type: 'file',
      accept: '.json,application/json',
      onchange: async event => {
        const file = event.target.files?.[0];
        if (!file) return;
        const dir = ($('#board-dir-input')?.value || state.targetDir).trim();
        try {
          const data = JSON.parse(await file.text());
          const name = nameInput.value.trim() || undefined;
          await switchBoard(name || data.name, () => api('POST', '/api/boards/import', { dir, name, data }), boardName => `Imported ${boardName}`);
        } catch (error) {
          setStatus(`Import failed: ${error.message}`, true);
        }
      },
    });
    const importLabel = el('label', { class: 'file-label', title: 'Import a Trello JSON export into this directory' }, 'Import Trello JSON…', fileInput);

    actions.append(
      el('div', { style: 'font-size:12px;color:var(--muted)' }, `Initialize or import a board in ${shortPath(targetPath)}:`),
      el('div', { class: 'row' }, nameInput, listsInput),
      el('div', { class: 'row' }, createBtn, importLabel),
    );
  }

  container.append(list, actions);
}

function renderBoardMenu() {
  const menu = $('#board-menu');
  const head = el('header', { class: 'board-menu-head' },
    el('h2', {}, 'Boards & Directories'),
    el('button', { type: 'button', class: 'ghost', onclick: () => closeBoardMenu({ focus: true }) }, '✕'));

  const rememberedSection = el('div', { class: 'board-menu-section' }, el('h3', {}, 'Remembered boards'));
  const boardList = el('ul', { class: 'board-list' });
  for (const item of state.boards.boards || []) {
    const counts = item.totals ? `${item.totals.open} open · ${item.totals.done} done` : (item.exists ? '' : 'missing');
    const row = el('li', { class: `board-row${item.current ? ' current' : ''}` },
      el('button', {
        type: 'button',
        class: 'board-row-main',
        onclick: () => selectBoardDir(item.dir, item.name),
      },
      el('span', { class: 'board-row-top' },
        el('span', { class: 'board-row-name' }, item.current ? `✓ ${item.name}` : item.name),
        el('span', { class: 'board-row-slug' }, item.slug),
        el('span', { class: 'board-row-counts' }, counts)),
      el('span', { class: 'board-row-dir' }, shortPath(item.dir))),
      el('button', {
        type: 'button',
        class: 'forget',
        title: 'Forget this board (does not delete files)',
        onclick: event => { event.stopPropagation(); forgetBoardDir(item.dir, item.name); },
      }, '×'));
    boardList.append(row);
  }
  if (!(state.boards.boards || []).length) {
    boardList.append(el('li', { style: 'color:var(--muted);font-size:13px;padding:4px 2px' }, 'No boards remembered yet.'));
  }
  rememberedSection.append(boardList);

  let dirTimer = null;
  const dirInput = el('input', {
    id: 'board-dir-input',
    type: 'text',
    value: state.targetDir,
    placeholder: '/path/to/project or ~/development/my-app',
    autocomplete: 'off',
  });
  dirInput.addEventListener('input', () => {
    clearTimeout(dirTimer);
    dirTimer = setTimeout(() => loadDirs(dirInput.value.trim()), 150);
  });
  dirInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const val = dirInput.value.trim();
      if (val) selectBoardDir(val);
    }
  });
  const openBtn = el('button', {
    type: 'button',
    onclick: () => {
      const val = dirInput.value.trim();
      if (val) selectBoardDir(val);
    },
  }, 'Open');

  const dirSection = el('div', { class: 'board-menu-section' },
    el('h3', {}, 'Target any directory'),
    el('div', { class: 'dir-box' },
      el('div', { class: 'dir-input-row' }, dirInput, openBtn),
      el('div', { id: 'dir-browser-slot' })));

  const body = el('div', { class: 'board-menu-body' }, rememberedSection, dirSection);
  menu.replaceChildren(head, body);
  renderDirBrowser();
}

$('#board-button').addEventListener('click', event => {
  event.stopPropagation();
  if (state.boardMenuOpen) closeBoardMenu(); else openBoardMenu();
});
$('#board-menu').addEventListener('click', event => event.stopPropagation());
document.addEventListener('click', event => {
  if (state.boardMenuOpen && !event.target.closest('.board-picker')) closeBoardMenu();
});

// ---------- card panel ----------

async function openCard(id, { silent = false, force = false } = {}) {
  if (state.editors > 0 && !force) {
    if (silent) { state.staleWhileEditing = true; renderStaleNotice(); }
    return;
  }
  try {
    state.card = await api('GET', `/api/cards/${id}`);
  } catch (error) {
    setStatus(error.message, true);
    if (!silent) closePanel();
    return;
  }
  if (state.banner && state.banner.id !== id) state.banner = null;
  state.openId = id;
  state.editors = 0;
  state.staleWhileEditing = false;
  renderPanel();
}

function closePanel() {
  state.openId = null;
  state.card = null;
  state.editors = 0;
  state.banner = null;
  $('#panel').hidden = true;
  $('#scrim').hidden = true;
  if (location.hash.startsWith('#card=')) history.replaceState(null, '', location.pathname);
}

function renderStaleNotice() {
  const panel = $('#panel');
  if (!panel.querySelector('.notice') && state.staleWhileEditing) {
    panel.querySelector('.head')?.after(el('div', { class: 'notice' }, 'This card changed on disk while you were editing.', el('button', { onclick: () => openCard(state.openId, { force: true }) }, 'Reload')));
  }
}

function patchCard(label, patch) {
  return attempt(label, async () => { const card = await api('PATCH', `/api/cards/${state.card.id}`, { rev: state.card.rev, ...patch }); state.card = card; await refresh(); return card; });
}

// Copies the card's reference as the board writes it in text: `#207`.
function copyIdButton(id) {
  const button = el('button', { type: 'button', class: 'copy-id ghost', title: `Copy #${id}`, 'aria-label': `Copy card number #${id}`, html: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="9" rx="1.5"/><path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v6.5A1.5 1.5 0 0 0 4 11h.5"/></svg>' });
  button.addEventListener('click', async () => {
    try {
      // Synchronous inside the click, so no permission prompt can leave it pending.
      const scratch = el('textarea', { readonly: true, style: 'position:fixed;opacity:0' }, `#${id}`);
      document.body.append(scratch);
      scratch.select();
      const copied = document.execCommand('copy');
      scratch.remove();
      if (!copied) await navigator.clipboard.writeText(`#${id}`);
      button.classList.add('copied');
      setTimeout(() => button.classList.remove('copied'), 1200);
      setStatus(`Copied #${id}`);
    } catch (error) {
      setStatus(`Copy failed: ${error.message}`, true);
    }
  });
  return button;
}

function renderPanel() {
  const card = state.card;
  const panel = $('#panel');
  panel.hidden = false;
  $('#scrim').hidden = false;
  panel.replaceChildren();

  // head: id, kind, status, close
  const kindControl = el('div', { class: 'segmented' });
  for (const kind of Object.keys(KIND_WORD)) {
    kindControl.append(el('button', { type: 'button', class: `kind-${kind}${card.kind === kind ? ' on' : ''}`, title: KIND_HELP[kind], html: `${ICON[kind]}<span>${KIND_WORD[kind]}</span>`, onclick: () => card.kind !== kind && patchCard(`Kind: ${kind}`, { kind }) }));
  }
  const statusControl = el('div', { class: 'segmented status-control' });
  for (const status of ['open', 'done', 'archived']) {
    statusControl.append(el('button', { type: 'button', class: card.status === status ? 'on' : '', onclick: () => card.status !== status && patchCard(`Status: ${status}`, { status }) }, status[0].toUpperCase() + status.slice(1)));
  }
  panel.append(el('div', { class: 'head' }, el('span', { class: 'card-id' }, `#${card.id}`), copyIdButton(card.id), kindControl, statusControl, el('button', { class: 'close ghost', onclick: closePanel, title: 'Close (Esc)' }, '✕')));
  const bannerEntry = state.banner?.id === card.id ? state.activity.entries.find(entry => entry.key === state.banner.key) : null;
  if (bannerEntry) panel.append(changesBanner(bannerEntry));

  // title
  const title = el('h2', { title: 'Click to edit' }, card.title);
  title.addEventListener('click', () => {
    const input = el('input', { type: 'text', value: card.title });
    const commit = async () => { const value = input.value.trim(); if (value && value !== card.title) await patchCard('Title saved', { title: value }); else renderPanel(); };
    input.addEventListener('keydown', event => { if (event.key === 'Enter') commit(); if (event.key === 'Escape') renderPanel(); });
    input.addEventListener('blur', commit);
    title.replaceChildren(input);
    input.focus();
    input.select();
  });
  panel.append(title);

  // meta grid
  const listSelect = el('select', {}, ...state.board.lists.map(list => el('option', { value: list.id, selected: list.id === card.list }, list.name + (list.archived ? ' (archived)' : ''))));
  listSelect.addEventListener('change', () => attempt(`Moved to ${listName(listSelect.value)}`, async () => { await api('POST', `/api/cards/${card.id}/move`, { list: listSelect.value }); await refresh(); }));

  const labels = el('div', { class: 'chips' }, ...card.labels.map(name => labelChip(name, { onRemove: () => patchCard('Label removed', { remove_labels: [name] }) })));
  const labelInput = el('input', { type: 'text', list: 'label-options', placeholder: '+ label' });
  labelInput.addEventListener('keydown', event => { if (event.key === 'Enter' && labelInput.value.trim()) patchCard('Label added', { add_labels: [labelInput.value.trim()] }); });
  labels.append(labelInput, el('datalist', { id: 'label-options' }, ...state.board.labels.map(label => el('option', { value: label.name }))));

  const refs = (field, label) => {
    const box = el('div', { class: 'chips' }, ...card[field].map(id => refChip(id, { onRemove: () => patchCard(`${label} updated`, { [field]: card[field].filter(other => other !== id) }) })));
    const input = el('input', { type: 'text', placeholder: '+ #id', inputmode: 'numeric' });
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      const id = Number(input.value.replace('#', '').trim());
      if (id) patchCard(`${label} updated`, { [field]: [...card[field], id] });
    });
    box.append(input);
    return box;
  };
  panel.append(el('div', { class: 'meta-grid' },
    el('span', {}, 'List'), listSelect,
    el('span', {}, 'Labels'), labels,
    el('span', {}, 'Blocked by'), refs('blocked_by', 'Blockers'),
    el('span', {}, 'Siblings'), refs('siblings', 'Siblings')));

  // sections
  for (const section of card.sections) panel.append(renderSection(section));
  panel.append(renderAddSection());

  // comments
  const comments = el('div', { class: 'section', dataset: { section: 'Comments' } }, el('div', { class: 'section-head' }, el('h3', {}, `Comments (${card.commentList.length})`)));
  for (const comment of card.commentList) {
    comments.append(el('div', { class: 'comment' }, el('div', { class: 'who' }, el('b', {}, comment.author), ` · ${comment.at.replace('T', ' ').replace('Z', ' UTC')}`), el('div', { class: 'body' }, renderMarkdown(comment.text))));
  }
  const commentBox = el('textarea', { placeholder: 'Write a comment (markdown)…', style: 'min-height:80px' });
  const post = async () => {
    const text = commentBox.value.trim();
    if (!text) return;
    await attempt('Comment posted', async () => { await api('POST', `/api/cards/${card.id}/comments`, { text, author: 'owner' }); commentBox.value = ''; });
    await openCard(card.id, { force: true });
    await refresh();
  };
  commentBox.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) post(); });
  comments.append(el('div', { class: 'editor' }, commentBox, el('div', { class: 'row' }, el('button', { class: 'primary', onclick: post }, 'Post as owner'))));
  panel.append(comments);

  // footer
  const footer = el('div', { class: 'footer' }, el('span', {}, 'file: ', el('code', {}, card.file)), el('span', {}, `rev ${card.rev} · created ${card.created || '?'} · updated ${card.updated || '?'}${card.closed ? ` · closed ${card.closed}` : ''}`));
  if (card.trello) footer.append(el('span', {}, 'imported from ', el('a', { href: `https://trello.com/c/${card.trello}`, target: '_blank', rel: 'noopener' }, `trello.com/c/${card.trello}`)));
  panel.append(footer);
  renderStaleNotice();
  if (state.highlight?.id === card.id) {
    const highlight = state.highlight;
    state.highlight = null;
    requestAnimationFrame(() => pointAt(panel, highlight));
  }
}

const sectionIn = (panel, name) => panel.querySelector(`.section[data-section="${CSS.escape(name)}"]`);
const scrollBehavior = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

// Marks the sections that changed and the status control when the status moved. Scrolls to
// the first changed section, unless the panel opens with a banner of the changes, which
// stays in view and links to each one.
function pointAt(panel, { sections = [], status = false }) {
  const targets = sections.map(name => sectionIn(panel, name)).filter(Boolean);
  const statusControl = status ? panel.querySelector('.status-control') : null;
  for (const target of [...targets, statusControl].filter(Boolean)) target.classList.add('changed');
  if (panel.querySelector('.changes-banner')) panel.scrollTop = 0;
  else targets[0]?.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
}

function isChecklist(body) {
  const lines = body.split('\n').filter(line => line.trim());
  return lines.length > 0 && lines.every(line => /^[-*] \[( |x|X)\] /.test(line) || /^\s{2,}\S/.test(line));
}

function parseChecklist(body) {
  const items = [];
  for (const raw of body.split('\n')) {
    if (!raw.trim()) continue;
    const match = /^[-*] \[( |x|X)\] ?(.*)$/.exec(raw);
    if (match) items.push({ done: match[1] !== ' ', text: match[2].trim() });
    else if (items.length) items[items.length - 1].text += `\n${raw.trim()}`;
  }
  return items;
}

// Electron does not support window.prompt. Keep the heading editor in the panel,
// and count it as an edit so live updates and source reloads preserve the draft.
function renderAddSection() {
  const card = state.card;
  const box = el('div', { class: 'section add-section' });
  const add = el('button', { type: 'button', class: 'ghost', onclick: () => {
    state.editors += 1;
    let saving = false;
    const heading = el('input', { id: 'new-section-heading', type: 'text', required: true, placeholder: 'Implementation note' });
    const create = el('button', { type: 'submit', class: 'primary' }, 'Add section');
    const cancel = () => {
      if (saving) return;
      state.editors = Math.max(0, state.editors - 1);
      box.replaceChildren(add);
      add.focus();
      if (state.staleWhileEditing && state.editors === 0) openCard(card.id, { force: true });
    };
    const cancelButton = el('button', { type: 'button', class: 'ghost', onclick: cancel }, 'Cancel');
    const form = el('form', { class: 'editor' }, el('label', { for: 'new-section-heading' }, 'Section heading'), heading, el('div', { class: 'row' }, cancelButton, create));
    heading.addEventListener('input', () => heading.setCustomValidity(''));
    form.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (saving) return;
      const name = heading.value.trim();
      const error = !name ? 'Enter a section heading.'
        : /^comments$/i.test(name) ? 'Use the comment box to add comments.'
        : state.card.sections.some(section => section.name.toLowerCase() === name.toLowerCase()) ? 'This section already exists. Use its Edit button.'
        : '';
      heading.setCustomValidity(error);
      if (!form.reportValidity()) return;
      saving = true;
      heading.disabled = create.disabled = cancelButton.disabled = true;
      const result = await attempt('Section added', async () => {
        const updated = await api('PATCH', `/api/cards/${card.id}`, { rev: card.rev, set_sections: { [name]: '' } });
        state.editors = Math.max(0, state.editors - 1);
        state.card = updated;
        state.highlight = { id: card.id, sections: [name] };
        await refresh();
        return updated;
      });
      if (!result) {
        saving = false;
        heading.disabled = create.disabled = cancelButton.disabled = false;
      }
    });
    box.replaceChildren(form);
    heading.focus();
  } }, '+ Add section');
  box.append(add);
  return box;
}

function renderSection(section) {
  const card = state.card;
  const box = el('div', { class: 'section', dataset: { section: section.name } });
  const checklist = section.body.trim() === '' && /^steps$/i.test(section.name) ? [] : (isChecklist(section.body) ? parseChecklist(section.body) : null);
  const head = el('div', { class: 'section-head' }, el('h3', {}, section.name));
  const body = el('div', { class: 'section-body' });

  const startEditor = () => {
    state.editors += 1;
    const area = el('textarea', { value: section.body });
    area.value = section.body;
    const finish = () => { state.editors = Math.max(0, state.editors - 1); };
    const save = async () => { finish(); const changed = area.value.trim() !== section.body.trim(); if (changed) await patchCard(`Saved "${section.name}"`, { set_sections: { [section.name]: area.value } }); else renderPanel(); };
    const cancel = () => { finish(); if (state.staleWhileEditing) openCard(card.id, { force: true }); else renderPanel(); };
    area.addEventListener('keydown', event => { if (event.key === 'Escape') cancel(); if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save(); });
    const remove = async () => { if (window.confirm(`Delete section "${section.name}"?`)) { finish(); await patchCard('Section removed', { remove_sections: [section.name] }); } };
    body.replaceChildren(el('div', { class: 'editor' }, area, el('div', { class: 'row' }, el('button', { class: 'danger ghost', onclick: remove }, 'Delete section'), el('span', { style: 'flex:1' }), el('button', { class: 'ghost', onclick: cancel }, 'Cancel'), el('button', { class: 'primary', onclick: save }, 'Save'))));
    head.querySelector('button')?.remove();
    area.focus();
  };

  if (checklist) {
    const done = checklist.filter(item => item.done).length;
    head.querySelector('h3').append(' ', el('span', { class: 'progress' }, `${done}/${checklist.length}`));
    const list = el('ul', { class: 'checklist' });
    checklist.forEach((item, index) => {
      const number = index + 1;
      const checkbox = el('input', { type: 'checkbox', checked: item.done });
      checkbox.addEventListener('change', () => attempt(`Step ${number} ${checkbox.checked ? 'ticked' : 'unticked'}`, async () => { await api('POST', `/api/cards/${card.id}/steps`, { section: section.name, [checkbox.checked ? 'tick' : 'untick']: [number] }); await openCard(card.id, { force: true }); await refresh(); }));
      const text = el('span', { class: 't', title: 'Double-click to edit' }, renderInline(item.text.replace(/\n/g, ' ')));
      text.addEventListener('dblclick', () => {
        const input = el('input', { type: 'text', value: item.text, style: 'width:100%' });
        input.addEventListener('keydown', async event => {
          if (event.key === 'Escape') renderPanel();
          if (event.key === 'Enter' && input.value.trim()) { await attempt(`Step ${number} edited`, async () => { await api('POST', `/api/cards/${card.id}/steps`, { section: section.name, edit: [{ index: number, text: input.value.trim() }] }); }); await openCard(card.id, { force: true }); }
        });
        text.replaceChildren(input);
        input.focus();
      });
      const remove = el('button', { class: 'rm', title: 'Remove step', onclick: async () => { if (window.confirm(`Remove step ${number}?`)) { await attempt('Step removed', () => api('POST', `/api/cards/${card.id}/steps`, { section: section.name, remove: [number] })); await openCard(card.id, { force: true }); } } }, '×');
      list.append(el('li', { class: item.done ? 'done' : '' }, el('span', { class: 'n' }, `${number}.`), checkbox, text, remove));
    });
    const addInput = el('input', { type: 'text', placeholder: 'Add a step…' });
    const add = async () => { const value = addInput.value.trim(); if (!value) return; await attempt('Step added', () => api('POST', `/api/cards/${card.id}/steps`, { section: section.name, add: [value] })); await openCard(card.id, { force: true }); await refresh(); };
    addInput.addEventListener('keydown', event => { if (event.key === 'Enter') add(); });
    list.append(el('li', { class: 'add' }, addInput, el('button', { onclick: add }, 'Add')));
    body.append(list);
    head.append(el('button', { class: 'ghost', onclick: startEditor, title: 'Edit as text' }, 'Edit'));
  } else {
    if (section.body.trim()) body.append(renderMarkdown(section.body)); else { body.classList.add('empty'); body.textContent = 'Empty. Click Edit to write it.'; }
    head.append(el('button', { class: 'ghost', onclick: startEditor }, 'Edit'));
  }
  box.append(head, body);
  return box;
}

// ---------- activity (the bell) ----------

const VERB_GLYPH = { opened: '+', reopened: '↺', closed: '✓', archived: '▾' };

function verbOf(entry) {
  if (entry.created) return entry.status?.to === 'open' || !entry.status ? 'opened' : { done: 'closed', archived: 'archived' }[entry.status.to];
  return entry.status ? { open: 'reopened', done: 'closed', archived: 'archived' }[entry.status.to] : undefined;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const names = list => list.join(', ');

// What an entry did, as short phrases in reading order.
function describe(entry) {
  const parts = [];
  const verb = verbOf(entry);
  if (verb) parts.push(verb[0].toUpperCase() + verb.slice(1));
  if (entry.list) parts.push(`Moved to ${listName(entry.list.to)}`);
  if (entry.renamed !== undefined && entry.renamed !== null) parts.push(`Renamed from “${entry.renamed}”`);
  if (entry.kindFrom) parts.push(`Now ${KIND_WORD[entry.kind] ?? entry.kind}`);
  if (entry.labels) parts.push([...entry.labels.added.map(label => `+${label}`), ...entry.labels.removed.map(label => `−${label}`)].join(' '));
  if (entry.steps?.to) parts.push(entry.steps.from ? `Steps ${entry.steps.from.done}/${entry.steps.from.total} → ${entry.steps.to.done}/${entry.steps.to.total}` : `Steps ${entry.steps.to.done}/${entry.steps.to.total}`);
  const skip = name => entry.steps && /^steps$/i.test(name);
  if (!entry.created) {
    const added = entry.added.filter(name => !skip(name));
    const edited = entry.edited.filter(name => !skip(name));
    if (added.length) parts.push(`Added ${names(added)}`);
    if (edited.length) parts.push(`Edited ${names(edited)}`);
    if (entry.removed.length) parts.push(`Removed ${names(entry.removed)}`);
  }
  if (entry.commentCount) parts.push(`${plural(entry.commentCount, 'comment')} from ${names([...new Set(entry.comments.map(comment => comment.author))])}`);
  return parts.length ? parts : ['Changed'];
}

function glyphOf(entry) {
  const verb = verbOf(entry);
  if (verb) return VERB_GLYPH[verb];
  if (entry.commentCount && !entry.added.length && !entry.edited.length) return '”';
  if (entry.list) return '→';
  return '✎';
}

function ago(at, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const date = new Date(at);
  const days = Math.round(hours / 24);
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' });
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function renderTitle() {
  if (!state.board) return;
  document.title = `${state.activity.unread ? `(${state.activity.unread}) ` : ''}${state.board.name} — Trellis`;
}

function renderBadge() {
  // Unread entries: opening the feed leaves it, and reading them (or Mark all as read) clears it.
  const { unread } = state.activity;
  const badge = $('#activity-badge');
  badge.hidden = !unread;
  badge.textContent = unread > 99 ? '99+' : String(unread);
  $('#activity-button').setAttribute('aria-label', unread ? `Activity, ${plural(unread, 'unread change')}` : 'Activity');
  renderTitle();
}

async function loadActivity() {
  state.activity = await api('GET', '/api/activity?limit=150');
  renderBadge();
  if (state.activityOpen) renderActivity();
}

async function postActivity(body) {
  Object.assign(state.activity, await api('POST', '/api/activity', body));
  renderBadge();
}

async function markRead(keys) {
  for (const entry of state.activity.entries) if (keys === 'all' || keys.includes(entry.key)) entry.read = true;
  if (state.activityOpen) renderActivity();
  await postActivity({ read: keys }).catch(error => setStatus(error.message, true));
}

async function openActivity() {
  closeBoardMenu();
  closeInfoModal();
  state.activityOpen = true;
  state.newSince = state.activity.seenAt;
  $('#activity').hidden = false;
  $('#activity-button').setAttribute('aria-expanded', 'true');
  renderActivity();
  $('#activity .activity-list button')?.focus({ preventScroll: true });
  if (state.activity.entries[0]?.at > state.activity.seenAt) await postActivity({ seen: true }).catch(error => setStatus(error.message, true));
}

function closeActivity({ focus = false } = {}) {
  if (!state.activityOpen) return;
  state.activityOpen = false;
  $('#activity').hidden = true;
  $('#activity-button').setAttribute('aria-expanded', 'false');
  if (focus) $('#activity-button').focus();
}

function activityItem(entry) {
  const comment = entry.comments.at(-1);
  const row = el('button', { type: 'button', class: `entry${entry.read ? '' : ' unread'}${entry.own ? ' own' : ''}`, onclick: () => openEntry(entry) },
    el('span', { class: `glyph kind-${entry.kind}`, 'aria-hidden': 'true' }, glyphOf(entry)),
    el('span', { class: 'entry-body' },
      el('span', { class: 'entry-title' }, el('span', { class: 'card-id' }, `#${entry.id}`), ' ', entry.title),
      el('span', { class: 'entry-what' }, (entry.own ? 'You: ' : '') + describe(entry).join(' · ')),
      comment ? el('span', { class: 'entry-quote' }, el('b', {}, comment.author), ` ${comment.text}`) : null,
      el('span', { class: 'entry-when', title: new Date(entry.at).toLocaleString() }, ago(entry.at))),
    el('span', { class: 'dot', title: entry.read ? undefined : 'Unread', 'aria-label': entry.read ? undefined : 'Unread' }));
  return el('li', {}, row);
}

function renderActivity() {
  const box = $('#activity');
  const { entries, unread } = state.activity;
  const filter = state.activityFilter;
  const filterButton = (key, label) => el('button', { type: 'button', class: filter === key ? 'on' : '', 'aria-pressed': String(filter === key), onclick: () => { state.activityFilter = key; renderActivity(); } }, label);
  const head = el('header', { class: 'activity-head' },
    el('div', { class: 'activity-title' }, el('h2', {}, 'Activity'),
      el('button', { type: 'button', class: 'ghost link-button', disabled: !unread, onclick: () => markRead('all') }, 'Mark all as read')),
    el('div', { class: 'segmented' }, filterButton('all', 'All'), filterButton('unread', unread ? `Unread (${unread})` : 'Unread')));
  const shown = entries.filter(entry => filter === 'all' || !entry.read);
  const fresh = shown.filter(entry => !entry.own && entry.at > state.newSince);
  const earlier = shown.filter(entry => !fresh.includes(entry));
  const group = (label, items) => items.length ? [el('h3', {}, label), el('ul', { class: 'activity-list' }, ...items.map(activityItem))] : [];
  const body = el('div', { class: 'activity-body' },
    ...(shown.length ? [...group('New', fresh), ...group(fresh.length ? 'Earlier' : 'Recent', earlier)]
      : [el('p', { class: 'activity-empty' }, filter === 'unread' ? 'All caught up.' : 'Nothing has changed yet. Changes to cards, by an agent, the CLI, a pull or you, appear here.')]));
  const scroll = box.querySelector('.activity-body')?.scrollTop ?? 0;
  box.replaceChildren(head, body);
  body.scrollTop = scroll;
}

async function openEntry(entry) {
  closeActivity();
  if (!entry.read) markRead([entry.key]);
  await window.showBoardCard(entry.id, { sections: entry.sections, status: Boolean(entry.status) && !entry.created, entry: entry.key });
}

// The top of the card panel, when it was opened from the feed: what that entry changed.
function changesBanner(entry) {
  const comments = entry.comments.slice(-3);
  return el('div', { class: 'changes-banner', role: 'note' },
    el('div', { class: 'changes-head' }, el('b', {}, entry.own ? 'You changed this' : 'What changed'), el('span', { class: 'when', title: new Date(entry.at).toLocaleString() }, ago(entry.at)),
      el('button', { class: 'ghost', title: 'Dismiss', 'aria-label': 'Dismiss', onclick: () => { state.banner = null; renderPanel(); } }, '✕')),
    el('ul', {}, ...describe(entry).map(part => el('li', {}, part))),
    ...comments.map(comment => el('div', { class: 'changes-quote' }, el('b', {}, comment.author), ` ${comment.text}`)),
    entry.sections.length ? el('div', { class: 'changes-jump' }, 'Jump to', ...entry.sections.map(name => el('button', { type: 'button', class: 'ghost', onclick: () => {
      const target = sectionIn($('#panel'), name);
      if (!target) return;
      target.classList.remove('changed');
      void target.offsetWidth;
      target.classList.add('changed');
      target.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
    } }, name))) : null);
}

function renderInfoModal() {
  const box = $('#info-modal');
  const head = el('header', { class: 'info-head' },
    el('div', { class: 'info-title' },
      el('h2', {}, 'Trellis'),
      el('span', { class: 'info-version' }, 'v0.1.0')),
    el('button', { type: 'button', class: 'ghost icon-btn info-close-btn', 'aria-label': 'Close', onclick: () => closeInfoModal({ focus: true }) }, '✕'));

  const creator = el('p', { class: 'info-creator' }, 'Created by Joshua Auriemma');

  const webLink = el('p', {},
    el('a', { class: 'info-link', href: 'https://auriemmai.com', target: '_blank', rel: 'noopener noreferrer' }, 'https://auriemmai.com'));

  const licenseBox = el('div', { class: 'info-license-box' },
    el('div', { class: 'info-license-title' }, 'MIT License 2026'),
    el('pre', { class: 'info-license-text' },
`Copyright (c) 2026 Joshua Auriemma

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`));

  box.replaceChildren(head, creator, webLink, licenseBox);
}

function openInfoModal() {
  closeBoardMenu();
  closeActivity();
  state.infoOpen = true;
  $('#info-modal').hidden = false;
  $('#info-button').setAttribute('aria-expanded', 'true');
  renderInfoModal();
  $('#info-modal .info-close-btn')?.focus();
}

function closeInfoModal({ focus = false } = {}) {
  if (!state.infoOpen) return;
  state.infoOpen = false;
  $('#info-modal').hidden = true;
  $('#info-button').setAttribute('aria-expanded', 'false');
  if (location.hash === '#info' || location.hash === '#about') {
    history.replaceState(null, '', location.pathname + location.search);
  }
  if (focus) $('#info-button').focus();
}

$('#info-button').addEventListener('click', event => {
  event.stopPropagation();
  if (state.infoOpen) closeInfoModal();
  else openInfoModal();
});
$('#info-modal').addEventListener('click', event => event.stopPropagation());

$('#activity-button').addEventListener('click', event => { event.stopPropagation(); if (state.activityOpen) closeActivity(); else openActivity(); });
// Clicks inside the feed stay there: a re-render detaches the button clicked, which would
// otherwise read as a click outside.
$('#activity').addEventListener('click', event => event.stopPropagation());
document.addEventListener('click', event => {
  if (state.activityOpen && !event.target.closest('#activity') && !event.target.closest('#activity-button')) closeActivity();
  if (state.infoOpen && !event.target.closest('#info-modal') && !event.target.closest('#info-button')) closeInfoModal();
});
// Keep relative times fresh while the feed is open.
setInterval(() => { if (state.activityOpen) renderActivity(); }, 60_000);

// ---------- wiring ----------

function route() {
  if (location.hash === '#info' || location.hash === '#about') {
    openInfoModal();
    return;
  }
  if (state.infoOpen) closeInfoModal();
  const match = /^#card=(\d+)$/.exec(location.hash);
  if (match) openCard(Number(match[1]));
  else if (state.openId !== null) closePanel();
}

function connectEvents() {
  const source = new EventSource('/api/events');
  source.addEventListener('change', () => Promise.all([refresh(), loadActivity()]).catch(error => setStatus(error.message, true)));
  // A switch started elsewhere (the desktop menu, another tab) shows the loading state from
  // its 'switching' event until the new board is loaded. One this page started is
  // switchBoard's to finish, so both events are ignored while it runs.
  let externalDone = null;
  const eventData = event => { try { return JSON.parse(event.data); } catch { return {}; } };
  source.addEventListener('switching', event => {
    if (state.switching) return;
    externalDone = beginLoading(eventData(event).name);
  });
  source.addEventListener('board', event => {
    if (state.switching) return;
    const done = externalDone || beginLoading(eventData(event).name);
    externalDone = null;
    closePanel();
    Promise.all([refresh(), loadActivity(), loadBoards()]).catch(error => setStatus(error.message, true)).finally(done);
  });
  source.addEventListener('activity', () => loadActivity().catch(error => setStatus(error.message, true)));
  source.onerror = () => setStatus('Live updates disconnected; retrying…', true);
  source.addEventListener('hello', () => { if ($('#status').classList.contains('err')) setStatus('Live'); });
}

let searchTimer = null;
$('#search').addEventListener('input', event => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.q = event.target.value.trim(); refresh(); }, 200); });
$('#kind-filter').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  state.kind = button.dataset.kind;
  for (const other of $('#kind-filter').children) other.classList.toggle('on', other === button);
  render();
});
$('#label-filter').addEventListener('change', event => { state.label = event.target.value; render(); });
$('#show-done').addEventListener('change', event => { state.showDone = event.target.checked; render(); });
$('#show-archived').addEventListener('change', event => { state.showArchived = event.target.checked; render(); });
$('#show-blocked').addEventListener('change', event => { state.blockedOnly = event.target.checked; render(); });
async function triggerAddList() {
  const name = await promptDialog({
    title: 'Create new list',
    placeholder: 'e.g. In Review',
    confirmLabel: 'Create list',
  });
  if (name && name.trim()) {
    await attempt('List created', () => api('POST', '/api/lists', { action: 'create', name: name.trim() }));
    await refresh();
  }
}
$('#add-list').addEventListener('click', triggerAddList);
$('#scrim').addEventListener('click', closePanel);
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (activeLaneMenu) { closeLaneMenu(); return; }
  if (state.infoOpen) { closeInfoModal({ focus: true }); return; }
  if (state.boardMenuOpen) { closeBoardMenu({ focus: true }); return; }
  if (state.activityOpen) { closeActivity({ focus: true }); return; }
  if (state.openId !== null && !event.target.closest('textarea, input')) closePanel();
});
window.addEventListener('hashchange', route);
window.showInfo = openInfoModal;

// Trellis desktop calls this when a notification is clicked, and the bell when an entry is: open
// the card and point at what changed. The hash alone cannot, and setting it to the card
// already open does nothing. `entry` is the feed entry's key: it is marked read, and the
// panel opens with a banner of what it changed.
// Trellis desktop asks this before reloading for a change to the board tool's source.
window.boardEditing = () => state.editors > 0;

let loaded;
const ready = new Promise(resolve => { loaded = resolve; });
window.showBoardCard = async (id, { sections = [], status = false, entry } = {}) => {
  await ready;
  if (state.editors > 0) { setStatus(`Save or cancel your edit to open #${id}`, true); return; }
  if (entry) {
    if (!state.activity.entries.some(item => item.key === entry)) await loadActivity().catch(() => {});
    if (state.activity.entries.find(item => item.key === entry)?.read === false) markRead([entry]);
    state.banner = { id, key: entry };
  }
  state.highlight = { id, sections, status };
  if (location.hash === `#card=${id}`) await openCard(id); else location.hash = `card=${id}`;
};

const bootDone = beginLoading();
Promise.all([refresh(), loadActivity(), loadBoards()]).then(() => { bootDone(); route(); connectEvents(); loaded(); }).catch(error => { bootDone(); setStatus(error.message, true); $('#lanes').append(el('div', { class: 'empty-board' }, error.message)); });
