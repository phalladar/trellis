import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tempBoard } from './helpers.mjs';

const SERVER = fileURLToPath(new URL('../mcp.mjs', import.meta.url));

test('the MCP server exposes eleven tools, manages boards and works over stdio', async () => {
  const { root, dir, registryFile, cleanup } = await tempBoard();
  const secondDir = path.join(root, 'beta', 'board');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, BOARD_DIR: dir, TRELLIS_REGISTRY: registryFile, BOARD_AUTHOR: 'claude' },
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), [
      'board_boards', 'board_card', 'board_card_create', 'board_card_move',
      'board_card_update', 'board_cards', 'board_comment', 'board_lists',
      'board_overview', 'board_search', 'board_steps',
    ]);
    assert.ok(JSON.stringify(tools).length < 16_000, 'tool schemas stay small');
    const text = async (name, args) => { const result = await client.callTool({ name, arguments: args }); return { text: result.content.map(part => part.text).join('\n'), isError: Boolean(result.isError) }; };

    const overview = await text('board_overview', {});
    assert.match(overview.text, /^Test · open 0/);
    const created = await text('board_card_create', { title: 'Add the Kiln recipe', list: 'M1', kind: 'agent', steps: ['Write it', 'Test it'], sections: { Context: 'None yet.' } });
    assert.match(created.text, /^ok #1 r1 created in m1-build \(agent\) file: board\/cards\/0001-add-the-kiln-recipe\.md$/);
    const card = await text('board_card', { id: '#1', sections: ['Steps'] });
    assert.match(card.text, /^#1 Add the Kiln recipe\nlist: m1-build \| kind: agent \| status: open \| rev: 1/);
    assert.match(card.text, /## Steps \(0\/2\)\n1\. \[ \] Write it\n2\. \[ \] Test it$/);
    const found = await text('board_search', { query: 'Kiln recipe', mode: 'lexical' });
    assert.match(found.text, /^"Kiln recipe" · lexical · 1 of 1 searched\nid\tlist\tkind\tstatus\ttitle\tsection\tscore\n#1\tm1-build\tagent\topen\tAdd the Kiln recipe\t\S+\t1\.00/);
    assert.equal((await text('board_steps', { id: 1, tick: [1] })).text, 'ok #1 r2 Steps 1/2');
    const stale = await text('board_card_update', { id: 1, rev: 1, title: 'nope' });
    assert.equal(stale.isError, true);
    assert.match(stale.text, /^error: rev conflict on #1/);
    assert.equal((await text('board_comment', { id: 1, text: 'hi' })).text, 'ok #1 r3 comment 1 by claude');
    assert.equal((await text('board_card_move', { id: 1, list: '3D Models', position: 'top' })).text, 'ok #1 r4 → 3d-models 1/1');
    const table = await text('board_cards', { fields: ['id', 'title', 'steps'] });
    assert.equal(table.text, 'id\ttitle\tsteps\n#1\tAdd the Kiln recipe\t1/2');
    assert.equal((await text('board_lists', { action: 'create', name: 'Polish' })).text, 'ok list polish "Polish" 4/4');

    // Initialize and switch between boards over MCP.
    assert.match((await text('board_boards', { action: 'init', dir: secondDir, name: 'Beta', lists: ['Todo', 'Done'] })).text, /^ok board "Beta" \(beta\) created/);
    assert.match((await text('board_overview', {})).text, /^Beta · open 0/);
    assert.match((await text('board_overview', { board: dir })).text, /^Test · open 1/);
    assert.match((await text('board_boards', { action: 'switch', dir })).text, /^ok active board "Test"/);
    assert.match((await text('board_boards', { action: 'list' })).text, /\*\t.*\tTest\t1\t0/);
  } finally {
    await client.close().catch(() => {});
    await cleanup();
  }
});
