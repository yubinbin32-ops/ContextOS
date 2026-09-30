import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFixtureProject } from '../../../scripts/fixture-project.mjs';
import { createV3Server } from '../src/v3-server.mjs';

test('mutation outcomes distinguish rejection, verified repair, and rollback over real MCP', async () => {
  const fixture = createFixtureProject({ prefix: 'ctxos-mutation-status' });
  const client = new Client({ name: 'mutation-status', version: '1' });
  const server = createV3Server();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = (args) => client.callTool({ name: 'contextos', arguments: { action: 'change', args, projectRoot: fixture.root } });
  const filename = 'src/status.mjs', file = path.join(fixture.root, filename);
  try {
    const created = await call({ create: [{ path: filename, content: 'export const answer = 1;\n' }],
      architecture: { blocks: [{ id: 'status-owner', title: 'Status owner', paths: [filename] }], chains: [{ id: 'status-chain', memberIds: ['status-owner'] }] },
      verify: { commands: ['node --check src/status.mjs'] } });
    assert.equal(created.structuredContent.status, 'verified');
    assert.equal(created.structuredContent.changed, true);
    assert.equal(created.structuredContent.architectureReady, true);
    assert.doesNotMatch(created.content[0].text, /verified and shipped/);
    const blocked = await call({ edits: [{ path: filename, oldText: 'answer = 1', newText: 'answer = 2' }],
      architecture: { blocks: [{ id: 'wrong-owner', paths: [filename] }], chains: [{ id: 'wrong-chain', memberIds: ['wrong-owner'] }] } });
    assert.equal(blocked.isError, true);
    assert.equal(blocked.structuredContent.status, 'blocked');
    assert.equal(blocked.structuredContent.changed, false);
    assert.equal(blocked.structuredContent.errorCode, 'ARCHITECTURE_REJECTED');
    const verified = await call({ edits: [{ path: filename, oldText: 'answer = 1', newText: 'answer = 2' }], verify: { commands: ['node --check src/status.mjs'] } });
    assert.equal(verified.isError ?? false, false);
    assert.equal(verified.structuredContent.status, 'verified');
    assert.equal(verified.structuredContent.architectureReady, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'export const answer = 2;\n');
    const missing = await call({ edits: [{ path: filename, target: 'not present', replacement: '' }] });
    assert.equal(missing.structuredContent.errorCode, 'EDIT_REJECTED');
    assert.equal(missing.isError, true);
    const reverted = await call({ edits: [{ path: filename, oldText: 'answer = 2', newText: 'answer = ;' }], autoRevert: true,
      verify: { commands: ['node --check src/status.mjs'] } });
    assert.equal(reverted.structuredContent.status, 'reverted');
    assert.equal(reverted.structuredContent.changed, false);
    assert.equal(reverted.structuredContent.verified, false);
    assert.equal(reverted.isError, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'export const answer = 2;\n');
  } finally { await client.close(); fixture.cleanup(); }
});
