import assert from 'node:assert/strict';
import { test } from 'node:test';
import { joinSections, parseCardFile, parseChecklist, parseComments, parseSections, serializeCardFile, serializeChecklist, serializeComments, slugify } from '../lib/markdown.mjs';

test('card file round-trips front matter and body', () => {
  const text = serializeCardFile({ id: 7, title: 'Do a thing', labels: ['art', 'ux'], blocked_by: [1, 2], siblings: [], rev: 3 }, '## Context\n\nHello');
  assert.equal(text, '---\nid: 7\ntitle: Do a thing\nlabels: [art, ux]\nblocked_by: [1, 2]\nrev: 3\n---\n\n## Context\n\nHello\n');
  const { meta, body } = parseCardFile(text);
  assert.deepEqual(meta, { id: 7, title: 'Do a thing', labels: ['art', 'ux'], blocked_by: [1, 2], rev: 3 });
  assert.equal(body, '## Context\n\nHello\n');
});

test('sections split on ## headings but not inside code fences', () => {
  const body = 'intro\n\n## Tests\n\n```powershell\n## not a heading\n# also not\n```\n\n## References\n\n- a';
  const { preamble, sections } = parseSections(body);
  assert.equal(preamble, 'intro');
  assert.deepEqual(sections.map(section => section.name), ['Tests', 'References']);
  assert.match(sections[0].body, /## not a heading/);
  assert.equal(joinSections(preamble, sections), body);
});

test('checklists parse items with continuation lines and reject prose', () => {
  const items = parseChecklist('- [x] one\n- [ ] two\n  continued here\n- [ ] three');
  assert.deepEqual(items, [{ done: true, text: 'one' }, { done: false, text: 'two\ncontinued here' }, { done: false, text: 'three' }]);
  assert.equal(serializeChecklist(items), '- [x] one\n- [ ] two\n  continued here\n- [ ] three');
  assert.equal(parseChecklist('Some prose\n- [ ] then an item'), null);
  assert.deepEqual(parseChecklist(''), []);
});

test('comments parse entries with author and timestamp', () => {
  const text = serializeComments([{ at: '2026-09-24T10:00:00Z', author: 'claude', text: 'Hi\n\nthere' }, { at: '2026-09-24T11:00:00Z', author: 'owner', text: 'ok' }]);
  assert.deepEqual(parseComments(text), [{ at: '2026-09-24T10:00:00Z', author: 'claude', text: 'Hi\n\nthere' }, { at: '2026-09-24T11:00:00Z', author: 'owner', text: 'ok' }]);
});

test('slugify makes safe file names', () => {
  assert.equal(slugify('Generate the Kiln 3D model'), 'generate-the-kiln-3d-model');
  assert.equal(slugify('DECIDE: which unlock — mechanism?'), 'decide-which-unlock-mechanism');
  assert.equal(slugify('!!!'), 'card');
});
