import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Board } from '../lib/store.mjs';

export async function tempBoard({ name = 'Test', lists = ['M0 - Start', 'M1 - Build', '3D Models'] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'trellis-board-'));
  const dir = path.join(root, 'board');
  const registryFile = path.join(root, 'boards.json');
  const board = await Board.init(dir, { name, lists });
  return { root, dir, registryFile, board, cleanup: () => rm(root, { recursive: true, force: true }) };
}
