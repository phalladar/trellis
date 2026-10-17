import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  boardsTable, findBoardUpwards, normalizeBoardDir,
  projectRootFor, Registry, resolveActiveBoard, targetBoardDir,
} from '../lib/registry.mjs';
import { Board } from '../lib/store.mjs';

test('discovers boards in a folder, its board/ subfolder, or any parent directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'trellis-reg-'));
  try {
    const repoA = path.join(root, 'alpha');
    const nested = path.join(repoA, 'src', 'components', 'deep');
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(repoA, 'package.json'), '{}');

    // A repository root with package.json defaults to <repo>/board on init.
    const initTarget = targetBoardDir(repoA);
    assert.equal(initTarget, path.join(repoA, 'board'));
    await Board.init(initTarget, { name: 'Alpha', lists: ['Todo', 'Done'] });

    assert.equal(normalizeBoardDir(repoA), initTarget);
    assert.equal(normalizeBoardDir(initTarget), initTarget);
    assert.equal(projectRootFor(initTarget), repoA);
    assert.equal(findBoardUpwards(nested), initTarget);
    assert.equal(targetBoardDir(path.join(root, 'standalone'), { here: true }), path.join(root, 'standalone'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('remembers, lists, switches and forgets boards across directories', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'trellis-multi-'));
  try {
    const regFile = path.join(root, 'config', 'boards.json');
    const dirA = path.join(root, 'alpha', 'board');
    const dirB = path.join(root, 'beta', 'board');
    const boardA = await Board.init(dirA, { name: 'Alpha Project', lists: ['Backlog', 'Done'] });
    const boardB = await Board.init(dirB, { name: 'Beta Service', lists: ['Todo', 'Done'] });
    await boardA.create({ title: 'First alpha task', list: 'Backlog' });
    await boardB.create({ title: 'First beta task', list: 'Todo' });
    await boardB.create({ title: 'Done beta task', list: 'Done', status: 'done' });

    const registry = new Registry(regFile);
    const entryA = await registry.remember(dirA);
    assert.equal(entryA.slug, 'alpha');
    assert.equal(registry.current, dirA);

    const entryB = await registry.remember( path.dirname(dirB) );
    assert.equal(entryB.slug, 'beta');
    assert.equal(registry.current, dirB);

    // Reload from disk and verify stats and switching by slug or name.
    const reloaded = new Registry(regFile);
    const listed = await reloaded.list({ includeStats: true });
    assert.equal(listed.current, dirB);
    assert.deepEqual(listed.boards.map(b => [b.slug, b.current, b.totals.open, b.totals.done]), [
      ['beta', true, 1, 1],
      ['alpha', false, 1, 0],
    ]);
    assert.match(boardsTable(listed), /\*\tbeta\tBeta Service\t1\t1/);

    await reloaded.switch('alpha');
    assert.equal(reloaded.current, dirA);

    await reloaded.switch('Beta Service');
    assert.equal(reloaded.current, dirB);

    // Priority resolution: explicit arg > env > remembered active board > upward cwd.
    const fromArg = await resolveActiveBoard({ dir: 'alpha', cwd: root, env: {}, registry: reloaded });
    assert.equal(fromArg.boardDir, dirA);
    assert.equal(fromArg.source, 'arg');

    const fromReg = await resolveActiveBoard({ cwd: path.join(root, 'alpha'), env: {}, registry: reloaded });
    assert.equal(fromReg.boardDir, dirB);
    assert.equal(fromReg.source, 'registry');

    const emptyReg = new Registry(path.join(root, 'config', 'empty.json'));
    const fromCwd = await resolveActiveBoard({ cwd: path.join(root, 'alpha'), env: {}, registry: emptyReg });
    assert.equal(fromCwd.boardDir, dirA);
    assert.equal(fromCwd.source, 'cwd');

    // Forgetting the active board falls back to the next remembered board.
    await reloaded.forget('beta');
    assert.equal(reloaded.current, dirA);
    assert.equal(reloaded.boards.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
