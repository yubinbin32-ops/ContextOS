import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFixtureProject } from '../../../scripts/fixture-project.mjs';
import { createV3Server } from '../src/v3-server.mjs';

test('compact edits recover from ownership conflicts using only the returned receipt', async () => {
  const fixture = createFixtureProject({ prefix: 'ctxos-change-recovery' });
  const server = createV3Server();
  const client = new Client({ name: 'change-recovery', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (args) => {
    const result = await client.callTool({ name: 'contextos', arguments: { action: 'change', args, projectRoot: fixture.root } });
    return result.content.map((c) => c.text || '').join('\n');
  };
  const file = path.join(fixture.root, 'src/recover.mjs');
  try {
    const initial = 'export const answer = 1;\n';
    const created = await call({ create: [{ path: 'src/recover.mjs', content: initial }],
      architecture: { blocks: [{ id: 'answer-owner', title: 'Answer ownership', paths: ['src/recover.mjs'] }], chains: [{ id: 'answer-chain', memberIds: ['answer-owner'] }] },
      verify: { commands: ['node --check src/recover.mjs'] } });
    const edits = [{ path: 'src/recover.mjs', oldText: 'answer = 1', newText: 'answer = 2' }];
    assert.match(created, /Verify: PASS/);
    const rejected = await call({ edits, architecture: { blocks: [{ id: 'wrong-owner', title: 'Wrong', paths: ['src/recover.mjs'] }], chains: [{ id: 'wrong-chain', memberIds: ['wrong-owner'] }] } });
    assert.match(rejected, /No files were modified/);
    assert.equal(fs.readFileSync(file, 'utf8'), initial);
    const receipt = JSON.parse(rejected.match(/^- ownership=(.+)$/m)[1]);
    const owner = receipt.find((r) => r.path === 'src/recover.mjs').owners[0];
    assert.equal(owner.id, 'answer-owner'); assert.equal(owner.title, 'Answer ownership');
    assert.deepEqual(owner.chainIds, ['answer-chain']);
    const accepted = await call({ edits, architecture: {
      blocks: [{ id: owner.id, title: owner.title, paths: ['src/recover.mjs'] }],
      chains: [{ id: owner.chainIds[0], memberIds: [owner.id] }],
    }, verify: { commands: ['node --check src/recover.mjs'] } });
    assert.match(accepted, /Verify: PASS/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'export const answer = 2;\n');
    await call({ edits: [{ path: 'src/recover.mjs', oldText: 'export const answer = 2;\n', newText: '' }], verify: { commands: ['node --check src/recover.mjs'] } });
    assert.equal(fs.readFileSync(file, 'utf8'), '');
  } finally { await client.close(); fixture.cleanup(); }
});
