import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../../..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

test('plugin manifest forwards CONTEXTOS_HOME for isolated test homes', () => {
  const mcp = readJson('plugins/contextos/.mcp.json');
  const server = mcp.contextos;
  assert.ok(server, 'contextos server entry is required');
  assert.equal(server.env.CONTEXTOS_LEAN_SURFACE, '1');
  assert.ok(server.env_vars.includes('CONTEXTOS_HOME'), 'CONTEXTOS_HOME must be forwarded to the MCP process');
  assert.ok(server.env_vars.includes('CONTEXTOS_PROJECT_ROOT'));
  assert.ok(server.env_vars.includes('CONTEXTOS_DATA_DIR'));
});

test('plugin manifest points at the bundled MCP config', () => {
  const plugin = readJson('plugins/contextos/.codex-plugin/plugin.json');
  assert.equal(plugin.mcpServers, './.mcp.json');
});
