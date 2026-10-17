import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { SearchIndex, chunkCard, clip, sectionPattern, splitText, tokenize } from '../lib/search.mjs';
import { tempBoard } from './helpers.mjs';

/** Hashed bag-of-words vectors: deterministic, no model, enough to exercise the pipeline. */
function fakeEmbedder(dims = 32) {
  const vector = text => {
    const out = new Float32Array(dims);
    for (const token of tokenize(text)) {
      let hash = 0;
      for (const char of token) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
      out[hash % dims] += 1;
    }
    const norm = Math.hypot(...out) || 1;
    return out.map(value => value / norm);
  };
  const embedder = {
    model: 'fake', dims, calls: 0,
    embedPassages: async texts => { embedder.calls += texts.length; return texts.map(vector); },
    embedQuery: async text => vector(text),
  };
  return embedder;
}

test('chunks, tokens, splits and section patterns', () => {
  const card = {
    id: 7, title: 'Make belt keys level-aware', list: 'm1', kind: 'agent', status: 'open', labels: ['art'], preamble: 'Preamble.',
    sections: [{ name: 'Context', body: 'A belt on a Deck.' }, { name: 'Empty', body: '' }],
    comments: [{ at: 'now', author: 'claude', text: 'A comment.' }],
  };
  const chunks = chunkCard(card);
  assert.deepEqual(chunks.map(chunk => chunk.section), ['', 'Context', 'Comments']);
  assert.match(chunks[0].text, /^#7 Make belt keys level-aware\nlist m1 · kind agent · status open · labels art\nPreamble\.$/);
  assert.equal(chunks[1].text, 'Make belt keys level-aware — Context\nA belt on a Deck.');
  assert.match(chunks[2].text, /Comments\nclaude: A comment\.$/);

  const long = Array.from({ length: 60 }, (_, index) => `line ${index} ${'x'.repeat(40)}`).join('\n');
  const pieces = splitText(long, 500);
  assert.ok(pieces.length > 4 && pieces.every(piece => piece.length <= 500), 'long sections split on lines under the limit');
  assert.equal(pieces.join('\n'), long, 'nothing is lost in the split');
  assert.deepEqual(splitText('a'.repeat(1300), 1200).map(piece => piece.length), [1200, 100], 'an over-long line is cut');

  const tokens = tokenize('The belts on simulation/systems/belt_router.gd (§5.8, § 8) are BeltRouter routes');
  for (const wanted of ['belt', 'simulation/systems/belt_router.gd', 'router', 'gd', '§5.8', '§8', 'route']) assert.ok(tokens.includes(wanted), `tokenizes ${wanted}`);
  assert.equal(tokenize('Belts').join(), 'belt');
  assert.equal(tokenize('DesignFormat').join(','), 'design,format');

  assert.match('GAME_DESIGN.md §5.8 doctrine', sectionPattern('5.8'));
  assert.match('see § 5.8', sectionPattern('§5.8'));
  assert.doesNotMatch('§5.80 and §5.8.1', sectionPattern('5.8'));
  assert.doesNotMatch('§5.8 only', sectionPattern('8'));
  assert.throws(() => sectionPattern('five'), /section must be/);
  assert.equal(clip('one two three four', 9), 'one two…');
});

test('ranks by words and meaning, filters exactly, and re-embeds only what changed', async () => {
  const { board, dir, cleanup } = await tempBoard();
  try {
    await board.create({ title: 'Make belt keys level-aware', list: 'M1', kind: 'agent', sections: { Context: 'A belt on a Deck is keyed by level. See simulation/systems/belt_router.gd and GAME_DESIGN.md §5.8.' } });
    await board.create({ title: 'Write the store page copy', list: 'M0', kind: 'human', sections: { Context: 'Steam page copy and screenshots.' } });
    await board.create({ title: 'Evaluate extending a drawn route', list: 'M1', kind: 'human', sections: { Context: "A run's open exit should begin a new route on a tap. GAME_DESIGN.md §8 gesture 3." } });
    const embedder = fakeEmbedder();
    const search = new SearchIndex(board, { embedder });

    const lexical = await search.search({ query: 'belt', mode: 'lexical' });
    assert.equal(lexical.hits[0].id, 1);
    assert.equal(lexical.matched, 1, 'lexical mode scores only cards that contain the words');
    assert.equal(embedder.calls, 0, 'a lexical search never touches the model');
    assert.equal(lexical.hits[0].section, 'Context');
    assert.match(lexical.hits[0].excerpt, /^A belt on a Deck/);
    const saved = JSON.parse(await readFile(`${dir}/.search/index.json`, 'utf8'));
    assert.equal(Object.keys(saved.cards).length, 3, 'the index is written beside the board');

    const hybrid = await search.search({ query: 'belt keyed by level' });
    assert.equal(hybrid.hits[0].id, 1);
    assert.equal(hybrid.hits[0].score, 1, 'scores are relative to the top hit');
    assert.equal(hybrid.matched, 3, 'semantic scoring ranks every candidate');
    const total = hybrid.index.chunks;
    assert.equal(embedder.calls, total, 'the first semantic search embeds every chunk');
    await search.search({ query: 'belt keyed by level' });
    assert.equal(embedder.calls, total, 'an unchanged board embeds nothing');

    await board.update(2, { append: { Context: 'Appended.' } });
    const after = await search.search({ query: 'store page' });
    assert.equal(after.hits[0].id, 2);
    assert.equal(after.index.changed, 1);
    assert.equal(embedder.calls, total + 1, 'only the changed section of the changed card is re-embedded');

    const byFile = await search.search({ files: ['belt_router.gd'] });
    assert.deepEqual(byFile.hits.map(hit => hit.id), [1]);
    assert.equal(byFile.mode, 'filter');
    assert.match(byFile.hits[0].excerpt, /belt_router\.gd/);
    assert.deepEqual((await search.search({ section: '5.8' })).hits.map(hit => hit.id), [1]);
    assert.deepEqual((await search.search({ section: '8' })).hits.map(hit => hit.id), [3], 'a section filter is exact');
    assert.deepEqual((await search.search({ query: 'belt', mode: 'lexical', section: '8' })).hits.map(hit => hit.id), [], 'filters narrow a ranked search');

    await board.update(2, { status: 'done' });
    assert.equal((await search.search({ query: 'copy', mode: 'lexical', status: 'open' })).searched, 2);
    assert.equal((await search.search({ query: 'copy', mode: 'lexical' })).searched, 3, 'status defaults to all');
    assert.equal((await search.search({ query: 'a', mode: 'lexical', k: 1 })).hits.length, 1);

    const bare = new SearchIndex(board);
    await assert.rejects(bare.search({ query: 'belt', mode: 'semantic' }), /no embedder/);
    assert.equal((await bare.search({ query: 'belt', mode: 'lexical' })).hits[0].id, 1, 'lexical search works with no model at all');
    await assert.rejects(search.search({ query: 'belt', mode: 'fuzzy' }), /mode must be/);

    const rebuilt = await search.refresh({ force: true });
    assert.equal(rebuilt.embedded, rebuilt.chunks, 'force re-embeds everything');
  } finally { await cleanup(); }
});
