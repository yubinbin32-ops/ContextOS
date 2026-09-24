import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { packageVersion } from './version.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = path.join(repoRoot, 'plugins', 'contextos', 'server', 'contextos-mcp.mjs');
const wasmPath = path.join(repoRoot, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm');
const grammarsDir = path.join(repoRoot, 'packages', 'code-intel', 'grammars');

assert.ok(fs.existsSync(bundlePath), 'MCP bundle is missing');
assert.ok(fs.existsSync(wasmPath), 'web-tree-sitter.wasm is missing');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-distribution-'));
const runtimeRoot = path.join(tempRoot, 'opt');
const runtimeDir = path.join(runtimeRoot, 'contextos');
const projectRoot = path.join(tempRoot, 'project');
const workDir = path.join(tempRoot, 'work');
fs.mkdirSync(runtimeDir, { recursive: true });
fs.mkdirSync(path.join(runtimeRoot, 'grammars'), { recursive: true });
fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
fs.mkdirSync(workDir, { recursive: true });

const runtimeBundle = path.join(runtimeDir, 'contextos-mcp.mjs');
fs.copyFileSync(bundlePath, runtimeBundle);
fs.copyFileSync(wasmPath, path.join(runtimeDir, 'web-tree-sitter.wasm'));
for (const entry of fs.readdirSync(grammarsDir, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.wasm')) {
    fs.copyFileSync(path.join(grammarsDir, entry.name), path.join(runtimeRoot, 'grammars', entry.name));
  }
}
fs.writeFileSync(
  path.join(projectRoot, 'src', 'sample.ts'),
  'export function greet(name: string) { return `hello ${name}`; }\n',
  'utf8',
);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [runtimeBundle],
  cwd: workDir,
  stderr: 'inherit',
});
const client = new Client({ name: 'contextos-distribution-smoke', version: packageVersion });

try {
  await client.connect(transport);
  const listing = await client.listTools();
  const names = listing.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['change', 'explore', 'inspect', 'ops', 'pipeline', 'ship', 'verify']);

  const result = await client.callTool({
    name: 'ops',
    arguments: {
      projectRoot,
      capability: 'code',
      action: 'search',
      args: { query: 'greet', root: 'src', maxResults: 5 },
    },
  });
  assert.equal(result.isError, undefined, 'AST search returned an MCP error');
  const text = (result.content || []).map((chunk) => chunk.text || '').join('\n');
  assert.match(text, /greet/);
  assert.match(text, /sample\.ts/);
  console.log('# Distribution Smoke Verification Passed!');
  console.log(`- Bundle: ${path.relative(repoRoot, bundlePath)}`);
  console.log('- Runtime layout: bundle + web-tree-sitter.wasm + grammars, no node_modules');
  console.log('- MCP initialize/tools and AST search: verified');
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
