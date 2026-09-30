import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-worker-bundle-'));
const project = path.join(root, 'project');
const commandMarker = path.join(project, 'command-ran');
fs.mkdirSync(path.join(project, '.contextos'), { recursive: true });
fs.writeFileSync(path.join(project, 'target.mjs'), 'export const n=1;\n');
let requests = 0;
const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    requests += 1;
    const toolArgs = requests === 1
      ? { action: 'change', args: { edits: [{ path: 'target.mjs', target: 'n=1', replacement: 'n=2' }], architecture: { blocks: [{ id: 'block-target', title: 'Target module', paths: ['target.mjs'] }] } } }
      : requests === 2
        ? { action: 'verify', args: { commands: ['node --check target.mjs && touch command-ran'] } }
        : null;
    const message = toolArgs
      ? { tool_calls: [{ id: `api-${requests}`, type: 'function', function: { name: 'os', arguments: JSON.stringify(toolArgs) } }] }
      : { content: JSON.stringify({ summary: 'changed', changes: ['target.mjs'], checks: ['node --check'], blockers: [], question: null, needsHost: false }) };
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
fs.writeFileSync(path.join(project, '.contextos/profile.json'), JSON.stringify({ micro: { url: `http://127.0.0.1:${server.address().port}`, model: 'model-free-smoke' } }));
const client = new Client({ name: 'worker-bundle-smoke', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--no-warnings=ExperimentalWarning', path.resolve('plugins/contextos/server/contextos-mcp.mjs')],
  env: { ...process.env, CONTEXTOS_HOME: path.join(root, 'global') },
  stderr: 'pipe',
});
try {
  await client.connect(transport);
  const response = await client.callTool({
    name: 'contextos',
    arguments: {
      action: 'micro',
      projectRoot: project,
      args: {
        task: 'Implement n=2 and syntax check',
        execution: 'implement',
        context: { allowedPaths: ['target.mjs'], acceptance: ['n=2 and syntax check passes'] },
        invocation: { tools: { enabled: true, allowCommands: true, maxSteps: 4 }, provider: { maxRequests: 4 } },
      },
    },
  });
  const result = JSON.parse(response.content[0].text);
  assert.equal(result.ok, true, result.error);
  assert.equal(requests, 3);
  assert.equal(result.providerRequests, 3);
  assert.match(fs.readFileSync(path.join(project, 'target.mjs'), 'utf8'), /n=2/);
  assert.equal(fs.existsSync(commandMarker), true);
  console.log('Bundled API Micro implementation passed: OS change bound the file to a Block, verify ran the command, and the final report stayed bounded. No external model called.');
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
