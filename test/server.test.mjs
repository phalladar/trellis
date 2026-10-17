import assert from 'node:assert/strict';
import { once } from 'node:events';
import path from 'node:path';
import { test } from 'node:test';
import { createBoardServer } from '../server.mjs';
import { tempBoard } from './helpers.mjs';

async function withServer(fn) {
  const { root, dir, registryFile, board, cleanup } = await tempBoard();
  const server = createBoardServer({ boardDir: dir, registry: registryFile });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body) => {
    const response = await fetch(base + route, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    return { status: response.status, headers: response.headers, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() };
  };
  try { await fn({ base, call, board, root, dir }); } finally { server.close(); await cleanup(); }
}

test('the JSON API creates, patches, moves, ticks and comments', async () => {
  await withServer(async ({ call }) => {
    const board = await call('GET', '/api/board');
    assert.equal(board.status, 200);
    assert.deepEqual(board.body.lists.map(list => list.id), ['m0-start', 'm1-build', '3d-models']);
    const created = await call('POST', '/api/cards', { title: 'Wire it', list: 'M0', kind: 'agent', steps: ['a', 'b'] });
    assert.equal(created.status, 200);
    assert.equal(created.body.id, 1);
    const stale = await call('PATCH', '/api/cards/1', { rev: 42, title: 'x' });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.current, 1);
    const patched = await call('PATCH', '/api/cards/1', { rev: 1, kind: 'human', set_sections: { Context: 'hello' } });
    assert.equal(patched.body.kind, 'human');
    assert.deepEqual(patched.body.sections.map(section => section.name), ['Steps', 'Context']);
    const steps = await call('POST', '/api/cards/1/steps', { tick: [2] });
    assert.deepEqual([steps.body.done, steps.body.total], [1, 2]);
    const moved = await call('POST', '/api/cards/1/move', { list: '3D Models' });
    assert.deepEqual(moved.body, { id: 1, list: '3d-models', index: 1, count: 1 });
    const commented = await call('POST', '/api/cards/1/comments', { text: 'hi' });
    assert.equal(commented.body.comment.author, 'owner');
    const cards = await call('GET', '/api/cards?status=all&q=hello');
    assert.deepEqual(cards.body.map(card => card.id), [1]);
    const list = await call('POST', '/api/lists', { action: 'create', name: 'Polish', after: 'M0' });
    assert.equal(list.body.index, 2);
    assert.equal((await call('GET', '/api/cards/99')).status, 404);
    assert.equal((await call('GET', '/api/nothing')).status, 404);
  });
});

test('the JSON API initializes, remembers, switches and forgets board directories', async () => {
  await withServer(async ({ call, root, dir }) => {
    const secondDir = path.join(root, 'second-project');
    const created = await call('POST', '/api/boards/init', { dir: secondDir, name: 'Second Board', lists: ['Todo', 'Done'], here: true });
    assert.equal(created.status, 200);
    assert.equal(created.body.current, secondDir);
    assert.equal((await call('GET', '/api/board')).body.name, 'Second Board');

    const dirs = await call('GET', `/api/fs/dirs?path=${encodeURIComponent(root)}`);
    assert.equal(dirs.status, 200);
    assert.ok(dirs.body.dirs.some(entry => entry.name === 'second-project' && entry.hasBoard));

    const switched = await call('POST', '/api/boards/select', { dir });
    assert.equal(switched.status, 200);
    assert.equal((await call('GET', '/api/board')).body.name, 'Test');

    const forgot = await call('POST', '/api/boards/forget', { dir: secondDir });
    assert.equal(forgot.status, 200);
    assert.equal(forgot.body.boards.length, 1);
  });
});

test('static files, link redirects and traversal', async () => {
  await withServer(async ({ call, board }) => {
    assert.equal((await call('GET', '/')).status, 200);
    assert.equal((await call('GET', '/vendor/marked.esm.js')).status, 200);
    assert.equal((await call('GET', '/../package.json')).status, 404);
    await board.create({ title: 'From Trello', list: 'M0', trello: 'AbCd1234' });
    const redirect = await call('GET', '/c/AbCd1234/1-from-trello');
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/#card=1');
    assert.equal((await call('GET', '/c/Nope0000')).status, 404);
    assert.equal((await call('GET', '/card/1')).headers.get('location'), '/#card=1');
  });
});

test('a change on disk reaches event stream subscribers', async () => {
  await withServer(async ({ base, board }) => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = '';
    const readUntil = async pattern => {
      const deadline = Date.now() + 5000;
      while (!pattern.test(received) && Date.now() < deadline) { const { value, done } = await reader.read(); if (done) break; received += decoder.decode(value); }
      return pattern.test(received);
    };
    assert.ok(await readUntil(/event: hello/));
    await board.create({ title: 'Trigger', list: 'M0' });
    assert.ok(await readUntil(/event: change/), `no change event; got: ${received}`);
    controller.abort();
  });
});

test('a change on disk is recorded in the feed and emitted for an in-process host', async () => {
  const { dir, board, cleanup } = await tempBoard();
  const server = createBoardServer({ boardDir: dir });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async () => (await fetch(`${base}/api/activity`)).json();
  const post = async body => (await fetch(`${base}/api/activity`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    const [startup] = await once(server, 'activity', { signal: AbortSignal.timeout(5000) });
    assert.equal(startup.startup, true);
    const changed = once(server, 'activity', { signal: AbortSignal.timeout(5000) });
    await board.create({ title: 'Trigger', list: 'M0' });
    const [event] = await changed;
    assert.deepEqual(event.touched.map(({ entry }) => [entry.id, entry.created, entry.own]), [[1, true, false]]);
    let feed = await get();
    assert.deepEqual([feed.unread, feed.entries.length], [1, 1]);
    assert.deepEqual(await post({ seen: true }), { seenAt: (await get()).seenAt, unread: 1 });
    const own = once(server, 'activity', { signal: AbortSignal.timeout(5000) });
    await fetch(`${base}/api/cards`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Mine', list: 'M0' }) });
    await own;
    feed = await get();
    assert.deepEqual(feed.entries.map(entry => [entry.id, entry.own, entry.read]), [[2, true, true], [1, false, false]]);
    assert.equal(feed.unread, 1);
    await post({ read: [feed.entries[1].key] });
    assert.equal((await get()).unread, 0);
  } finally { server.close(); await cleanup(); }
});

test('the feed persists, and records what changed while no server ran', async () => {
  const { root, dir, board, cleanup } = await tempBoard();
  const activityFile = path.join(root, 'activity', 'feed.json');
  const start = async () => {
    const server = createBoardServer({ boardDir: dir, activityFile });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const [event] = await once(server, 'activity', { signal: AbortSignal.timeout(5000) });
    return { server, event };
  };
  try {
    await board.create({ title: 'Before', list: 'M0' });
    const first = await start();
    assert.deepEqual(first.event.touched, [], 'a fresh feed does not announce the board it starts on');
    first.server.close();
    await board.update(1, { status: 'done', set_sections: { 'Implementation note': 'n' } });
    const second = await start();
    assert.equal(second.event.startup, true);
    assert.deepEqual(second.event.touched.map(({ entry }) => [entry.id, entry.status, entry.sections]), [[1, { from: 'open', to: 'done' }, ['Implementation note']]]);
    assert.equal(second.server.activity.unread(), 1);
    second.server.close();
  } finally { await cleanup(); }
});
