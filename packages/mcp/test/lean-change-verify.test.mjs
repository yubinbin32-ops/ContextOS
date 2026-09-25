import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createFixtureProject } from '../../../scripts/fixture-project.mjs';
import { packageVersion } from '../../../scripts/version.mjs';
import { createV3Server } from '../src/v3-server.mjs';

test('lean contextos change forwards object verify commands', async () => {
  const fixture = createFixtureProject({ prefix: 'ctxos-lean-change-verify' });
  const server = createV3Server();
  const client = new Client({ name: 'contextos-lean-change-verify', version: packageVersion });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = await client.callTool({
      name: 'contextos',
      arguments: {
        action: 'change',
        args: {
          create: [{ path: 'src/lean-verify.mjs', content: 'export const verified = true;\n' }],
          verify: { commands: ['node --check src/lean-verify.mjs'] },
        },
        projectRoot: fixture.root,
      },
    });
    const text = (result.content || []).map((chunk) => chunk.text ?? '').join('\n');

    assert.ok(!result.isError, text);
    assert.match(text, /`node --check src\/lean-verify\.mjs`/);
    assert.match(text, /Verify: PASS/);
    assert.doesNotMatch(text, /- `` → exit/);
  } finally {
    await client.close();
    fixture.cleanup();
  }
});
