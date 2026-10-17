import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { tempBoard } from './helpers.mjs';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));

test('the CLI mirrors the tools and switches between remembered boards', async () => {
  const { root, dir, registryFile, cleanup } = await tempBoard();
  const secondDir = path.join(root, 'other-repo', 'board');
  const cli = async (...args) => {
    try {
      const { stdout } = await run(process.execPath, [CLI, ...args], {
        env: { ...process.env, BOARD_DIR: dir, TRELLIS_REGISTRY: registryFile, BOARD_AUTHOR: 'codex' },
      });
      return stdout.trimEnd();
    } catch (error) {
      return `EXIT ${error.code}: ${error.stderr.trim()}`;
    }
  };
  // Run without a pinned board, from the project at root or (outside) from no project at all.
  const outside = path.dirname(root);
  const cliNoEnvDir = async (...args) => cliFrom(root, ...args);
  const cliFrom = async (cwd, ...args) => {
    const cleanEnv = { ...process.env, TRELLIS_REGISTRY: registryFile, BOARD_AUTHOR: 'codex' };
    delete cleanEnv.BOARD_DIR;
    delete cleanEnv.TRELLIS_DIR;
    try {
      const { stdout } = await run(process.execPath, [CLI, ...args], { cwd, env: cleanEnv });
      return stdout.trimEnd();
    } catch (error) {
      return `EXIT ${error.code}: ${error.stderr.trim()}`;
    }
  };
  try {
    assert.match(await cli('create', '--title', 'Wire the CLI', '--list', 'M0', '--kind', 'joint', '--steps', 'one', '--steps', 'two', '--section', 'Context=Some context'), /^ok #1 r1 created in m0-start \(joint\)/);
    assert.equal(await cli('steps', '1', '--tick', '1', '--add', 'three'), 'ok #1 r2 Steps 1/3');
    assert.equal(await cli('update', '1', '--append', 'Implementation note (2026-09-24)=Shipped.', '--status', 'done'), 'ok #1 r3 updated status, append');
    assert.equal(await cli('comment', '1', 'hello', 'world'), 'ok #1 r4 comment 1 by codex');
    assert.equal(await cli('cards', '--status', 'done', '--fields', 'id,kind,steps,comments'), 'id\tkind\tsteps\tcomments\n#1\tjoint\t1/3\t1');
    assert.match(await cli('card', '1', '--sections', 'Implementation note (2026-09-24)', '--comments', '0'), /## Implementation note \(2026-09-24\)\nShipped\.$/);
    assert.match(await cli('update', '1', '--rev', '1', '--title', 'x'), /^EXIT 1: error: rev conflict/);
    assert.match(await cli('nonsense'), /^EXIT 2: unknown command/);
    assert.match(await cli('overview'), /^Test · open 0 .* · done 1/);

    // Initialize a second board, list remembered boards, and switch between them.
    assert.match(await cliNoEnvDir('init', secondDir, '--name', 'Second Project', '--lists', 'Todo,Done'), /^ok board created at .* \(other-repo\)$/);
    assert.match(await cliNoEnvDir('boards'), /\*\tother-repo\tSecond Project\t0\t0/);
    assert.match(await cliFrom(outside, 'overview'), /^Second Project · open 0/);
    // Inside a project its own board wins over the active one.
    assert.match(await cliNoEnvDir('overview'), /^Test · open 0 .* · done 1/);
    assert.match(await cliNoEnvDir('use', dir), /^ok active board "Test"/);
    assert.match(await cliFrom(outside, 'overview'), /^Test · open 0 .* · done 1/);
    assert.match(await cliNoEnvDir('-C', 'other-repo', 'overview'), /^Second Project · open 0/);
  } finally { await cleanup(); }
});
