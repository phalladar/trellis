import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { convertDescription, importTrelloExport, inferKind, planImport } from '../import_trello.mjs';
import { relink } from '../relink_trello.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { Board } from '../lib/store.mjs';

const FIXTURE = new URL('./fixtures/trello_export.json', import.meta.url);

test('bold Trello headings become sections; fences and rules are respected', () => {
  const body = convertDescription('**Context**\n\nA.\n\n**Why this matters**: B.\n\n**Tests**\n\n```\n# keep\n**Bold in code**\n```\n\n---\n\n**Kiln addendum (2026-09-22)**\n\nC.\n\n**Context**\n\nD.\n\n---\n\n**Kiln addendum (2026-09-22)**\n\nE.\n\n**Additional steps**\n\n- f');
  assert.equal(body, '## Context\n\nA.\n\n## Why this matters\n\nB.\n\n## Tests\n\n```\n# keep\n**Bold in code**\n```\n\n## Kiln addendum (2026-09-22)\n\nC.\n\n### Context\n\nD.\n\n## Kiln addendum (2026-09-22) (2)\n\nE.\n\n### Additional steps\n\n- f');
  assert.equal(inferKind('Run and analyse M5 Q1: does the jam read?', 'M5 - Playtest'), 'human');
  assert.equal(inferKind('Cut a distributable playtest build for the three M5 testers', 'M5 - Playtest'), 'agent');
  assert.equal(inferKind('Replace the placeholder cue tones, and decide the music question', 'Polish'), 'joint');
  assert.equal(inferKind('Configure regional pricing for the Steam SKU', 'M7 - Early Access launch'), 'human');
  assert.equal(inferKind('Add achievement definitions and an evaluator', 'M7 - Early Access launch'), 'agent');
  assert.equal(inferKind('DECIDE: pick one', 'M1'), 'human');
  assert.equal(inferKind('Generate the Kiln', '3D Models'), 'joint');
  assert.equal(inferKind('Write the store page', 'Store and Business'), 'human');
  assert.equal(inferKind('Add a test', 'M1'), 'agent');
});

test('the plan keeps card numbers, short links, lists, checklists and comments', async () => {
  const plan = planImport(JSON.parse(await readFile(FIXTURE, 'utf8')));
  assert.equal(plan.name, 'FIRST PRINCIPLE (fixture)');
  assert.deepEqual(plan.lists.map(list => [list.id, list.archived]), [['decisions-and-design-spikes', false], ['m1-scaffold-remediation', false], ['m1-5-verticality-support', false], ['3d-models', false], ['old-lane', true]]);
  assert.deepEqual(plan.labels, [{ name: 'art', color: 'purple' }, { name: 'green', color: 'green' }]);
  const kiln = plan.cards.find(card => card.id === 207);
  assert.equal(kiln.trello, 'FoD9ycy9');
  assert.equal(kiln.kind, 'joint');
  assert.deepEqual(kiln.labels, ['art']);
  assert.match(kiln.body, /## What to do\n\n1\. Model the drum\.\n2\. Export the GLB\.\n\n## Steps\n\n- \[x\] Model the drum\n- \[ \] Export the GLB\n- \[ \] \[Verticality\] Confirm Ground-only\n\n## Success criteria/);
  assert.match(kiln.body, /## Attachments\n\n- \[reference\.png\]/);
  assert.deepEqual(kiln.comments.map(comment => [comment.author, comment.text]), [['owner', 'First comment.'], ['owner', 'Looks good, ship it.']]);
  assert.equal(plan.cards.find(card => card.id === 12).status, 'archived');
  assert.equal(plan.cards.find(card => card.id === 13).status, 'done', 'Trello\'s completion checkmark (dueComplete/dateCompleted) imports as done');
  assert.equal(plan.cards.find(card => card.id === 13).closed, '2026-08-03T09:00:00Z');
  assert.deepEqual(plan.cards.filter(card => card.list === 'm1-scaffold-remediation').map(card => [card.id, card.pos]), [[12, 2000], [13, 1000], [301, 3000]]);
  const deck = plan.cards.find(card => card.id === 300);
  assert.equal(deck.body, [
    '## Context', '', 'Top context.', '', '## What to do', '', '1. Do the thing.', '',
    '## Steps', '', '- [x] 1. Do the thing', '- [ ] [Verticality] 2. Do the other thing', '- [ ] [Verticality] already prefixed', '',
    '## NOT DONE THIS PASS — read before implementing', '', '- [ ] the hard bit', '',
    '## References', '', '- GAME_DESIGN.md §5', '',
    '## Interview addendum (2026-09-23)', '', 'The owner said so.', '', '### Context', '', 'Addendum context.', '', '### What to do', '', '2. Do the other thing.', '', '### Additional steps', '', '- extra', '',
    '## Implementation note (2026-09-24)', '', 'Shipped in abc123.', '', '### Context', '', 'Note context.',
  ].join('\n'));
  assert.deepEqual(plan.notes.skippedChecklists, ['#300 "ZZ DUPLICATE — delete me (see Steps above)" (1 items)']);
  assert.deepEqual(plan.notes.mergedChecklists, ['#300 "Steps (verticality addendum)" → Steps']);
  assert.deepEqual(plan.notes.renamedChecklists, ['#301 "What to do" → Steps']);
  assert.deepEqual(plan.notes.renamedSections, ['#301 "Steps" → "Steps (text)"']);
  const readme = plan.cards.find(card => card.id === 301);
  assert.match(readme.body, /## Context\n\nOnly a What to do checklist\.\n\n## Steps \(text\)\n\nProse that says steps\.\n\n## Steps\n\n- \[ \] 1\. Rewrite the row$/);
});

test('importing writes a board that the store reads back, and refuses to overwrite', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fp-import-'));
  try {
    const dir = path.join(root, 'board');
    const { text } = await importTrelloExport(FIXTURE, dir);
    assert.match(text, /cards: 7 \(1 done, 1 archived\)/);
    const board = new Board(dir);
    const kiln = await board.get(207);
    assert.equal(kiln.rev, 1);
    assert.equal(kiln.updated, '2026-09-23T10:00:00Z');
    assert.equal(kiln.comments.length, 2);
    assert.deepEqual(kiln.sections.map(section => section.name), ['Context', 'Why this matters', 'What to do', 'Steps', 'Success criteria', 'Tests', 'References', 'Verticality addendum (2026-09-22)', 'Attachments']);
    assert.match(kiln.sections.find(section => section.name === 'Tests').body, /^```powershell\n# run the checks/);
    assert.equal((await board.byTrello('FoD9ycy9')).id, 207);
    await assert.rejects(importTrelloExport(FIXTURE, dir), /already exists/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('relink rewrites trello.com card links into board card links and leaves unknown ones', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fp-relink-'));
  try {
    const dir = path.join(root, 'board');
    await importTrelloExport(FIXTURE, dir);
    await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, 'docs', 'NOTES.md'), 'See [the Kiln card](https://trello.com/c/FoD9ycy9/207-generate-the-kiln-3d-model) and https://trello.com/c/aB12cD34 and https://trello.com/c/Unknown1.\n');
    await writeFile(path.join(root, 'manifest.json'), '{ "work_item": "https://trello.com/c/FoD9ycy9/207-generate-the-kiln-3d-model" }\n');
    const dry = await relink({ boardDir: dir, root, targets: ['docs'], dryRun: true });
    assert.match(dry.text, /^Would rewrite 2 Trello card links in 1 files/);
    assert.match(await readFile(path.join(root, 'docs', 'NOTES.md'), 'utf8'), /trello\.com\/c\/FoD9ycy9/);
    const real = await relink({ boardDir: dir, root, targets: ['docs', 'manifest.json'] });
    assert.deepEqual(real.missing, ['Unknown1']);
    assert.equal(await readFile(path.join(root, 'docs', 'NOTES.md'), 'utf8'), 'See [the Kiln card](../board/cards/0207-generate-the-kiln-3d-model.md) and #150 and https://trello.com/c/Unknown1.\n');
    assert.equal(await readFile(path.join(root, 'manifest.json'), 'utf8'), '{ "work_item": "#207" }\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
