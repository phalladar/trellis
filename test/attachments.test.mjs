import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fingerprint } from '../lib/activity.mjs';
import { collapseImages, imageRefs } from '../lib/markdown.mjs';
import { makeOps } from '../lib/ops.mjs';
import { createBoardServer } from '../server.mjs';
import { tempBoard } from './helpers.mjs';

const MCP = fileURLToPath(new URL('../mcp.mjs', import.meta.url));
// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('markdown images are found and collapse to their alt text', () => {
  const text = 'See ![Image1](../attachments/0001/ab.png) and ![](x.jpg "t") then [a link](z.png)';
  assert.deepEqual(imageRefs(text), [{ alt: 'Image1', src: '../attachments/0001/ab.png' }, { alt: '', src: 'x.jpg' }]);
  assert.equal(collapseImages('look ![Image1](../attachments/0001/ab.png) here'), 'look [Image1] here');
});

test('attach stores an image by content under its card, once, and refuses anything else', async () => {
  const { board, dir, cleanup } = await tempBoard();
  try {
    const card = await board.create({ title: 'Fix the header', list: 'M0', kind: 'agent' });
    const first = await board.attach(card.id, PNG);
    assert.match(first.path, /^attachments\/0001\/[0-9a-f]{16}\.png$/);
    assert.equal(first.ref, `../${first.path}`);
    assert.equal(first.type, 'image/png');
    assert.deepEqual(await readFile(path.join(dir, first.path)), PNG);
    assert.equal((await board.attach(card.id, PNG)).path, first.path);
    assert.deepEqual(await readdir(path.join(dir, 'attachments', '0001')), [path.basename(first.path)]);
    assert.equal((await board.get(card.id)).rev, 1, 'attaching does not write the card');
    await assert.rejects(board.attach(card.id, Buffer.from('<svg/>')), { code: 'bad_attachment' });
    await assert.rejects(board.attach(card.id, Buffer.alloc(0)), { code: 'bad_attachment' });
    await assert.rejects(board.attach(99, PNG), { code: 'not_found' });
  } finally { await cleanup(); }
});

test('the server uploads an image, serves it from the active board, and keeps paths inside it', async () => {
  const { dir, registryFile, board, cleanup } = await tempBoard();
  const server = createBoardServer({ boardDir: dir, registry: registryFile });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await board.create({ title: 'Fix the header', list: 'M0', kind: 'agent' });
    const upload = await fetch(`${base}/api/cards/1/attachments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: `data:image/png;base64,${PNG.toString('base64')}` }) });
    assert.equal(upload.status, 200);
    const body = await upload.json();
    assert.match(body.ref, /^\.\.\/attachments\/0001\/[0-9a-f]{16}\.png$/);
    const served = await fetch(`${base}/${body.path}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);
    const bad = await fetch(`${base}/api/cards/1/attachments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: Buffer.from('hello').toString('base64') }) });
    assert.equal(bad.status, 400);
    assert.notEqual((await fetch(`${base}/attachments/..%2Fboard.yaml`)).status, 200);
  } finally { server.close(); await cleanup(); }
});

test('a card read attaches the images its shown text links to, and the feed names them', async () => {
  const { board, root, cleanup } = await tempBoard();
  try {
    await board.create({ title: 'Fix the header', list: 'M0', kind: 'agent' });
    const { ref, path: where } = await board.attach(1, PNG);
    await board.comment(1, { author: 'owner', text: `Broken here [x] ![Image1](${ref})\n\nand ![Image2](../../outside.png)` });
    const ops = makeOps(board, { root });
    const read = await ops.card({ id: 1 });
    assert.equal(read.images.length, 1, 'a link outside the board is not read');
    assert.deepEqual({ ...read.images[0], data: undefined }, { label: 'Image1', path: `board/${where}`, mimeType: 'image/png', data: undefined });
    assert.equal(Buffer.from(read.images[0].data, 'base64').compare(PNG), 0);
    assert.match(read.text, /!\[Image1\]\(\.\.\/attachments\/0001\//);
    assert.deepEqual((await ops.card({ id: 1, images: false })).images, []);
    assert.deepEqual((await ops.card({ id: 1, comments: 0 })).images, [], 'only images in the shown text');
    assert.equal(fingerprint([await board.get(1)])[1].comments[0].text, 'Broken here [x] [Image1] and [Image2]');
  } finally { await cleanup(); }
});

test('board_card over MCP returns pasted images as image content', async () => {
  const { dir, registryFile, board, cleanup } = await tempBoard();
  await board.create({ title: 'Fix the header', list: 'M0', kind: 'agent' });
  const { ref } = await board.attach(1, PNG);
  await board.comment(1, { author: 'owner', text: `Look: ![Image1](${ref})` });
  const client = new Client({ name: 'test', version: '0.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [MCP], env: { ...process.env, BOARD_DIR: dir, TRELLIS_REGISTRY: registryFile } }));
    const result = await client.callTool({ name: 'board_card', arguments: { id: 1 } });
    assert.deepEqual(result.content.map(part => part.type), ['text', 'text', 'image']);
    assert.match(result.content[1].text, /^\[Image1\] board\/attachments\/0001\/[0-9a-f]{16}\.png$/);
    assert.equal(result.content[2].mimeType, 'image/png');
    assert.equal(result.content[2].data, PNG.toString('base64'));
  } finally {
    await client.close().catch(() => {});
    await cleanup();
  }
});
