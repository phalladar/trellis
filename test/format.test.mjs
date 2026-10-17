import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CARD_BUDGET, renderCard, sectionIndex } from '../lib/format.mjs';
import { makeOps } from '../lib/ops.mjs';
import { tempBoard } from './helpers.mjs';

const card = sections => ({
  id: 9, title: 'Integrate the models', list: 'm1', kind: 'joint', status: 'open', rev: 3, labels: [], blocked_by: [], siblings: [], comments: [],
  file: '/b/cards/0009.md', preamble: '', sections: sections.map(([name, body]) => ({ name, body })),
});
const big = 'x'.repeat(4000);

test('the section index sizes every section and groups dated or numbered tails', () => {
  const sections = card([['Context', 'a'.repeat(400)], ['Steps', '- [ ] one'], ['Implementation note (2026-09-24)', 'b'.repeat(40)], ['Implementation note (2026-10-01)', 'c'.repeat(40)], ['Carried requirements from #209', big], ['Carried requirements from #219', big], ['Belt pace addendum (2026-09-30)', 'd']]).sections;
  assert.equal(sectionIndex(sections), 'sections (≈tokens): Context 100 · Steps 3 · Implementation note … ×2 20 · Carried requirements from … ×2 2.0k · Belt pace addendum (2026-09-30) 1');
});

test('a default read keeps the template sections and elides what does not fit; full and prefixes reach the rest', () => {
  const sections = [['Context', 'ctx'], ['Steps', '- [ ] one']];
  for (let index = 0; index < 8; index++) sections.push([`Carried requirements from #${200 + index}`, big]);
  const wide = card(sections);
  assert.ok(sections.reduce((sum, [, body]) => sum + body.length, 0) > CARD_BUDGET);

  const text = renderCard(wide, { comments: 0 });
  assert.match(text, /\nsections \(≈tokens\): Context 1 · Steps 3 · Carried requirements from … ×8 8\.0k\n/);
  assert.match(text, /## Context\nctx/);
  assert.match(text, /## Steps \(0\/1\)\n1\. \[ \] one/);
  assert.equal((text.match(/## Carried requirements from #/g) || []).length, 3, 'the template sections count toward the budget');
  assert.match(text, /## \(5 more sections elided, ≈5\.0k tokens\)\nCarried requirements from … ×5 5\.0k\nRead them with sections/);

  assert.equal((renderCard(wide, { full: true, comments: 0 }).match(/## Carried/g) || []).length, 8);
  assert.equal((renderCard(wide, { sections: ['carried requirements'], comments: 0 }).match(/## Carried/g) || []).length, 8);
  assert.doesNotMatch(renderCard(wide, { sections: ['Steps'], comments: 0 }), /sections \(≈tokens\)|Carried/);
  assert.match(renderCard(wide, { sections: ['meta'] }), /\nsections \(≈tokens\): Context 1 .*×8 8\.0k$/);
  assert.match(renderCard(wide, { sections: ['nope'] }), /\(no section named or starting "nope"; sections \(≈tokens\): Context 1/);
});

test('an exact section name wins over a prefix, and a card within budget reads whole', () => {
  const small = card([['Implementation note', 'plain'], ['Implementation note (2026-09-24)', 'dated']]);
  assert.doesNotMatch(renderCard(small, { sections: ['Implementation note'] }), /dated/);
  assert.match(renderCard(small, { sections: ['Implementation note ('] }), /dated/);
  const text = renderCard(small, { comments: 0 });
  assert.match(text, /plain[\s\S]*dated/);
  assert.doesNotMatch(text, /sections \(≈tokens\)|elided/);
});

test('board_cards pages 30 rows by default', async () => {
  const { board, cleanup } = await tempBoard();
  try {
    for (let index = 0; index < 32; index++) await board.create({ title: `Card ${index}`, list: 'M1', kind: 'agent' });
    const { text } = await makeOps(board).cards({});
    assert.equal(text.split('\n').length, 32);
    assert.match(text, /\n… 2 more \(offset 30\)$/);
  } finally { await cleanup(); }
});
