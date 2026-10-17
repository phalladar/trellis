import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Activity, COMMENTS, MERGE_MS, verbOf } from '../lib/activity.mjs';

const card = (id, { status = 'open', list = 'm0', title = `Card ${id}`, sections = {}, comments = [], labels = [], kind = 'agent' } = {}) => ({
  id, title, list, status, kind, labels,
  sections: Object.entries(sections).map(([name, body]) => ({ name, body })),
  comments: comments.map(([author, text]) => ({ author, text, at: '' })),
});

test('the first read of a board records nothing', () => {
  const feed = new Activity();
  assert.deepEqual(feed.record([card(1), card(2)], { now: 0 }), []);
  assert.equal(feed.entries.length, 0);
});

test("a card's note, ticks, comment and close within the merge window are one entry", () => {
  const feed = new Activity();
  feed.record([card(1, { sections: { Steps: '- [ ] a\n- [ ] b', Context: 'c' } })], { now: 0 });
  feed.record([card(1, { sections: { Steps: '- [x] a\n- [x] b', Context: 'c', 'Implementation note': 'n' } })], { now: 1000 });
  feed.markSeen(1500);
  const [{ entry, change }] = feed.record([card(1, { status: 'done', sections: { Steps: '- [x] a\n- [x] b', Context: 'c', 'Implementation note': 'n' }, comments: [['codex', 'Done; see the note.']] })], { now: 61_000 });
  assert.deepEqual(change.status, { from: 'open', to: 'done' });
  assert.equal(feed.entries.length, 1);
  assert.equal(verbOf(entry), 'closed');
  assert.deepEqual(entry.sections, ['Steps', 'Implementation note', COMMENTS]);
  assert.deepEqual([entry.added, entry.edited], [['Implementation note'], ['Steps']]);
  assert.deepEqual(entry.steps, { from: { done: 0, total: 2 }, to: { done: 2, total: 2 } });
  assert.deepEqual([entry.commentCount, entry.comments[0].author], [1, 'codex']);
  // Merged after the feed was opened, it is still unread: opening the feed is not reading it.
  assert.equal(feed.unread(), 1);
});

test('a change after the merge window starts a new entry, newest first', () => {
  const feed = new Activity();
  feed.record([card(1), card(2)], { now: 0 });
  feed.record([card(1, { list: 'm1' }), card(2)], { now: 1 });
  feed.record([card(1, { list: 'm1' }), card(2, { title: 'Renamed' })], { now: 2 });
  feed.record([card(1, { list: 'm1', status: 'archived' }), card(2, { title: 'Renamed' })], { now: 2 + MERGE_MS + 1 });
  assert.deepEqual(feed.entries.map(entry => [entry.id, verbOf(entry) ?? null]), [[1, 'archived'], [2, null], [1, null]]);
  assert.deepEqual(feed.entries[1].renamed, 'Card 2');
  assert.deepEqual(feed.entries[2].list, { from: 'm0', to: 'm1' });
});

test('a change undone within the window leaves nothing to say about it', () => {
  const feed = new Activity();
  feed.record([card(1)], { now: 0 });
  feed.record([card(1, { list: 'm1', labels: ['ui'] })], { now: 1 });
  const [{ entry }] = feed.record([card(1, { labels: ['ui'] })], { now: 2 });
  assert.equal(entry.list, undefined);
  assert.deepEqual(entry.labels, { added: ['ui'], removed: [] });
});

test("the owner's own writes are recorded read, and an agent's write to the same card makes it unread", () => {
  const feed = new Activity();
  feed.record([card(1)], { now: 0 });
  feed.record([card(1, { sections: { Context: 'mine' } })], { now: 1, own: new Set([1]) });
  assert.deepEqual([feed.entries[0].own, feed.entries[0].read, feed.unread()], [true, true, 0]);
  feed.record([card(1, { sections: { Context: 'mine' }, comments: [['claude', 'Read it.']] })], { now: 2 });
  assert.deepEqual([feed.entries[0].own, feed.entries[0].read, feed.unread()], [false, false, 1]);
  feed.markRead('all');
  assert.equal(feed.view().unread, 0);
});

test('a new card is opened, without sections to point at', () => {
  const feed = new Activity();
  feed.record([], { now: 0 });
  feed.record([card(3, { sections: { Context: 'x' } }), card(4, { status: 'done' })], { now: 1 });
  assert.deepEqual(feed.entries.map(entry => [entry.id, verbOf(entry), entry.sections]), [[4, 'closed', []], [3, 'opened', []]]);
});
