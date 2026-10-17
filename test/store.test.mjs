import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { stepsOf } from '../lib/store.mjs';
import { tempBoard } from './helpers.mjs';

test('create, read, sections, steps, comments and revs', async () => {
  const { board, cleanup } = await tempBoard();
  try {
    const card = await board.create({ title: 'Generate the Kiln', list: '3D Models', kind: 'joint', labels: ['art'], sections: { Context: 'x' }, steps: ['a', 'b'] });
    assert.equal(card.id, 1);
    assert.equal(card.rev, 1);
    assert.match(path.basename(card.file), /^0001-generate-the-kiln\.md$/);
    assert.deepEqual((await board.config()).labels, [{ name: 'art', color: 'green' }]);

    const steps = await board.steps(1, { tick: [1], add: ['c'], edit: [{ index: 2, text: 'b2' }] });
    assert.deepEqual(steps.items, [{ done: true, text: 'a' }, { done: false, text: 'b2' }, { done: false, text: 'c' }]);
    await assert.rejects(board.steps(1, { tick: [9] }), /has 3 items/);
    await assert.rejects(board.steps(1, { section: 'Context', tick: [1] }), /prose, not a checklist/);

    await board.update(1, { append: { 'Implementation note (2026-09-24)': 'Done.' }, set_sections: { Context: 'y' }, status: 'done' });
    const after = await board.get(1);
    assert.equal(after.rev, 3);
    assert.equal(after.status, 'done');
    assert.ok(after.closed);
    assert.deepEqual(after.sections.map(section => section.name), ['Context', 'Steps', 'Implementation note (2026-09-24)']);
    assert.equal(after.sections[0].body, 'y');

    await board.comment(1, { author: 'claude', text: 'hello' });
    const text = await readFile((await board.get(1)).file, 'utf8');
    assert.match(text, /## Comments\n\n### \S+ claude\n\nhello/);
    assert.equal(stepsOf(await board.get(1)).done, 1);
  } finally { await cleanup(); }
});

test('stale rev is refused and titles rename the file', async () => {
  const { board, cleanup } = await tempBoard();
  try {
    const card = await board.create({ title: 'First title', list: 'M0' });
    await assert.rejects(board.update(card.id, { title: 'x' }, { rev: 99 }), error => error.code === 'conflict' && error.current === 1);
    await board.update(card.id, { title: 'Second title' }, { rev: 1 });
    assert.deepEqual(await readdir(board.cardsDir), ['0001-second-title.md']);
  } finally { await cleanup(); }
});

test('relations must point at existing cards and never at the card itself', async () => {
  const { board, cleanup } = await tempBoard();
  try {
    const a = await board.create({ title: 'A', list: 'M0' });
    await assert.rejects(board.create({ title: 'B', list: 'M0', blocked_by: [42] }), /does not exist/);
    const b = await board.create({ title: 'B', list: 'M0', blocked_by: [a.id] });
    await assert.rejects(board.update(b.id, { siblings: [b.id] }), /itself/);
    const [blocked] = await board.query({ blocked: true });
    assert.equal(blocked.id, b.id);
    await board.update(a.id, { status: 'done' });
    assert.equal((await board.query({ blocked: true })).length, 0);
  } finally { await cleanup(); }
});

test('moves order cards and renumber when the gap closes', async () => {
  const { board, cleanup } = await tempBoard();
  try {
    const ids = [];
    for (const title of ['a', 'b', 'c']) ids.push((await board.create({ title, list: 'M0' })).id);
    const order = async () => (await board.query({ list: 'M0' })).map(card => card.id);
    assert.deepEqual(await order(), ids);
    await board.move(ids[2], { position: 'top' });
    assert.deepEqual(await order(), [ids[2], ids[0], ids[1]]);
    await board.move(ids[0], { after: ids[1] });
    assert.deepEqual(await order(), [ids[2], ids[1], ids[0]]);
    // Squeeze between the same two neighbours until integer room runs out.
    for (let round = 0; round < 12; round++) {
      const current = await order();
      await board.move(current[2], { before: current[1] });
    }
    const cards = await board.query({ list: 'M0' });
    assert.equal(new Set(cards.map(card => card.pos)).size, 3, 'positions stay distinct');
    const moved = await board.move(ids[1], { list: '3D Models' });
    assert.equal(moved.card.list, '3d-models');
    assert.equal(moved.index, 1);
    await assert.rejects(board.move(ids[0], { before: ids[1] }), /not in list/);
  } finally { await cleanup(); }
});

test('query filters by list, kind, label, text, since and status', async () => {
  const { board, cleanup } = await tempBoard();
  try {
    const a = await board.create({ title: 'Kiln drum', list: 'M0', kind: 'human', labels: ['art'], sections: { Context: 'refiner mention' } });
    const b = await board.create({ title: 'Belt keys', list: 'M1', kind: 'agent' });
    await board.update(b.id, { status: 'archived' });
    assert.deepEqual((await board.query({ kind: 'human' })).map(card => card.id), [a.id]);
    assert.deepEqual((await board.query({ label: 'ART' })).map(card => card.id), [a.id]);
    assert.deepEqual((await board.query({ q: 'refiner kiln' })).map(card => card.id), [a.id]);
    assert.deepEqual((await board.query({ q: 'belt', status: 'all' })).map(card => card.id), [b.id]);
    assert.deepEqual((await board.query({ list: 'm1', status: 'archived' })).map(card => card.id), [b.id]);
    assert.equal((await board.query({ since: '2999-01-01' })).length, 0);
    await assert.rejects(board.query({ list: 'nope' }), /unknown list/);
  } finally { await cleanup(); }
});

test('lists can be created, renamed, moved, archived and restored', async () => {
  const { board, cleanup } = await tempBoard();
  try {
    await board.lists('create', { name: 'M0.5 - Between', after: 'M0' });
    assert.deepEqual((await board.config()).lists.map(list => list.id), ['m0-start', 'm0-5-between', 'm1-build', '3d-models']);
    await board.lists('move', { list: 'M0.5', position: 'top' });
    assert.equal((await board.config()).lists[0].id, 'm0-5-between');
    await board.lists('rename', { list: 'm0-5-between', new_name: 'Half step' });
    await board.lists('archive', { list: 'Half step' });
    assert.equal((await board.config()).lists[0].archived, true);
    await board.lists('restore', { list: 'Half step' });
    assert.equal((await board.config()).lists[0].archived, false);
    assert.equal((await board.resolveList('M1')).id, 'm1-build');
  } finally { await cleanup(); }
});

test('parallel writers all land under the lock', async () => {
  const { board, cleanup } = await tempBoard();
  try {
    const card = await board.create({ title: 'Busy', list: 'M0' });
    await Promise.all(Array.from({ length: 8 }, (_, index) => board.comment(card.id, { author: `w${index}`, text: `c${index}` })));
    const after = await board.get(card.id);
    assert.equal(after.comments.length, 8);
    assert.equal(after.rev, 9);
  } finally { await cleanup(); }
});
