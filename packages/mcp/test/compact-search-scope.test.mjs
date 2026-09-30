import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createV3Server } from '../src/v3-server.mjs';
import { createFixtureProject } from '../../../scripts/fixture-project.mjs';

test('compact search preserves args query and scopes both envelope and sibling paths', async () => {
  const fixture = createFixtureProject({ prefix: 'contextos-scoped-search' });
  fixture.write('src/selected.mjs', 'export const NEEDLE_SCOPE = 1;\n');
  fixture.write('src/unrelated.mjs', 'export const NEEDLE_SCOPE = 2;\n');
  const client = new Client({ name: 'search-scope-regression', version: '1' });
  const transports = InMemoryTransport.createLinkedPair();
  const server = createV3Server({ surface: 'lean' });
  await Promise.all([client.connect(transports[0]), server.connect(transports[1])]);
  try {
    for (const fields of [
      { args: { query: 'NEEDLE_SCOPE', paths: ['src/selected.mjs'] } },
      { query: 'NEEDLE_SCOPE', paths: ['src/selected.mjs'] },
      { args: { search: 'NEEDLE_SCOPE', path: 'src/selected.mjs' } },
    ]) {
      const result = await client.callTool({ name: 'contextos', arguments: {
        action: 'search', projectRoot: fixture.root, refresh: true, maxChars: 10000, ...fields,
      } });
      const text = result.content.map((item) => item.text || '').join('\n');
      assert.ok(!result.isError, text);
      assert.match(text, /src\/selected\.mjs/);
      assert.match(text, /NEEDLE_SCOPE/);
      assert.doesNotMatch(text, /src\/unrelated\.mjs|AST Outline/);
    }
  } finally { await client.close(); fixture.cleanup(); }
});
