import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { createFixtureProject } from './fixture-project.mjs';
import { packageVersion } from './version.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = path.join(repoRoot, 'plugins', 'contextos', 'server', 'contextos-mcp.mjs');
assert.ok(fs.existsSync(bundlePath), 'The shipped MCP bundle is missing');

const providerRequests = [];
const provider = http.createServer((req, res) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    providerRequests.push(body);
    const turn = providerRequests.length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (turn === 1) {
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'inspect-1', type: 'function', function: { name: 'inspect', arguments: JSON.stringify({ path: 'src/math.mjs' }) } }] } }],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
      }));
      return;
    }
    if (turn === 2) {
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'run-1', type: 'function', function: { name: 'run', arguments: JSON.stringify({ command: "node -e \"process.stdout.write('ok')\"", maxChars: 200 }) } }] } }],
        usage: { prompt_tokens: 25, completion_tokens: 8, total_tokens: 33 },
      }));
      return;
    }
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'Executor inspected the source and ran the command successfully.' } }],
      usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
    }));
  });
});

const fixture = createFixtureProject({ prefix: 'ctxos-micro-executor' });
let transport = null;
let client = null;

try {
  const url = await new Promise((resolve) => {
    provider.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${provider.address().port}`));
  });
  fs.mkdirSync(path.join(fixture.root, '.contextos'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, '.contextos', 'profile.json'), JSON.stringify({
    micro: { url, model: 'executor-acceptance-model', key: 'test-key' },
  }, null, 2) + '\n');
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundlePath],
    cwd: repoRoot,
    stderr: 'inherit',
    env: { ...process.env, CONTEXTOS_LEAN_SURFACE: '0', CONTEXTOS_HOME: path.join(fixture.root, '.contextos-home') },
  });
  client = new Client({ name: 'contextos-micro-executor-acceptance', version: packageVersion });
  await client.connect(transport);

  const result = await client.callTool({
    name: 'ops',
    arguments: {
      projectRoot: fixture.root,
      capability: 'micro',
      action: 'run',
      args: {
        preset: 'custom',
        task: 'Inspect src/math.mjs, run the assigned command, then report the result.',
        withOS: true,
        invocation: {
          provider: { maxRequests: 4 },
          tools: { enabled: true, allowCommands: true },
        },
        maxChars: 1200,
      },
    },
  });
  const text = (result.content || []).map((chunk) => chunk.text || '').join('\n');
  assert.equal(Boolean(result.isError), false, text);
  const projected = JSON.parse(text);
  assert.equal(projected.ok, true, text);
  assert.equal(projected.invocation.executionMode, 'executor');
  assert.ok(projected.invocation.toolRounds >= 2, `toolRounds=${projected.invocation.toolRounds}`);

  const usagePath = path.join(fixture.root, '.contextos', 'logs', 'micro-usage.jsonl');
  const usage = fs.readFileSync(usagePath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).at(-1);
  assert.equal(usage.executionMode, 'executor');
  assert.ok(usage.toolRounds >= 2, `usage.toolRounds=${usage.toolRounds}`);
  assert.ok(usage.toolCallCount >= 2, `usage.toolCallCount=${usage.toolCallCount}`);
  assert.equal(usage.providerRequests, 3);
  assert.equal(usage.totalTokens, 101);

  const hidden = await client.callTool({
    name: 'ops',
    arguments: {
      projectRoot: fixture.root,
      capability: 'micro',
      action: 'run',
      args: {
        preset: 'custom',
        task: 'Return a successful fire-and-forget result.',
        delivery: 'errors-only',
        invocation: {
          provider: { maxRequests: 1 },
          tools: { enabled: false },
        },
      },
    },
  });
  const hiddenText = (hidden.content || []).map((chunk) => chunk.text || '').join('\n');
  assert.equal(Boolean(hidden.isError), false, hiddenText);
  const hiddenProjected = JSON.parse(hiddenText);
  assert.equal(hiddenProjected.ok, true, hiddenText);
  assert.equal(hiddenProjected.delivery, 'success-hidden');
  assert.equal(Object.hasOwn(hiddenProjected, 'content'), false);

  console.log(JSON.stringify({
    ok: true,
    providerRequests: usage.providerRequests,
    toolRounds: usage.toolRounds,
    toolCalls: usage.toolCallCount,
    executionMode: usage.executionMode,
    totalTokens: usage.totalTokens,
    errorsOnlyDelivery: hiddenProjected.delivery,
  }));
} finally {
  if (client) await client.close();
  if (transport) await transport.close();
  await new Promise((resolve) => provider.close(resolve));
  fixture.cleanup();
}
