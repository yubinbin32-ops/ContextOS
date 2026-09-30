import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const pluginMcpConfig = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../../plugins/contextos/.mcp.json', import.meta.url)), 'utf8'));

function filteredPluginServerEnv(parentEnv) {
  const server = pluginMcpConfig.contextos;
  const required = [
    'CONTEXTOS_API_MICRO_PROFILE', 'CONTEXTOS_API_MICRO_KEY', 'CONTEXTOS_DISABLE_API_MICRO',
    'CONTEXTOS_DISABLE_MICRO', 'CONTEXTOS_WORKER_MODE', 'CONTEXTOS_WORKER_ROOT',
    'CONTEXTOS_PROJECT_ROOT', 'CONTEXTOS_MICRO_REPORT_ROOT', 'CONTEXTOS_MICRO_REPORT_JOB',
  ];
  assert.ok(required.every((name) => server.env_vars.includes(name)), 'plugin must allowlist each expected API/worker binding');
  const inherited = new Set(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'SystemRoot', 'WINDIR', ...server.env_vars]);
  const env = Object.fromEntries([...inherited].filter((name) => parentEnv[name] !== undefined).map((name) => [name, parentEnv[name]]));
  return { ...env, ...(server.env || {}) };
}

test('fresh MCP evidence/command entry bypasses graph initialization and uses exact source and one execution', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-request-mcp-'));
  const cli = new Client({ name: 'request-entry-check', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [process.env.CONTEXTOS_TEST_ENTRYPOINT || fileURLToPath(new URL('../src/v3-server.mjs', import.meta.url))], env: { ...process.env, CONTEXTOS_HOME: path.join(root, 'empty-home'), CONTEXTOS_DISABLE_API_MICRO: '1' }, stderr: 'pipe' });
  try {
    fs.writeFileSync(path.join(root, 'a.mjs'), 'export const 中文 = "🙂";\n');
    await cli.connect(transport);
    const tools = await cli.listTools();
    assert.equal(tools.tools.length, 1); assert.equal(tools.tools[0].name, 'contextos');
    const missingApi = await cli.callTool({ name: 'contextos', arguments: { action: 'ask', args: { request: 'Find validation' }, projectRoot: root } });
    assert.equal(missingApi.isError, true);
    assert.equal(missingApi.structuredContent.errorCode, 'API_MICRO_NOT_CONFIGURED');
    assert.match(missingApi.content[0].text, /error=API_MICRO_NOT_CONFIGURED/);
    assert.match(missingApi.content[0].text, /MCP host/);
    const failedReplay = await cli.callTool({ name: 'contextos', arguments: { action: 'ask', args: { resultId: missingApi.structuredContent.resultId }, projectRoot: root } });
    assert.equal(failedReplay.structuredContent.errorCode, 'API_MICRO_NOT_CONFIGURED');
    const evidence = await cli.callTool({ name: 'contextos', arguments: { action: 'ask', args: { inspect: [{ path: 'a.mjs', ranges: [[1, 1], [1, 1]] }] }, projectRoot: root } });
    assert.equal(evidence.structuredContent.status, 'completed');
    assert.equal((evidence.content[0].text.match(/export const 中文/g) || []).length, 1);
    assert.ok(!fs.existsSync(path.join(root, '.contextos', 'project.json')));
    const resultId = evidence.structuredContent.resultId;
    fs.writeFileSync(path.join(root, 'a.mjs'), 'export const 中文 = "changed";\n');
    const stale = await cli.callTool({ name: 'contextos', arguments: { action: 'ask', args: { resultId }, projectRoot: root } });
    assert.equal(stale.structuredContent.status, 'partial'); assert.ok(!stale.content[0].text.includes('"🙂"'));
    const command = await cli.callTool({ name: 'contextos', arguments: { action: 'command', args: { id: 'mcp-once', command: 'pwd' }, projectRoot: root } });
    const replay = await cli.callTool({ name: 'contextos', arguments: { action: 'command', args: { action: 'get', id: 'mcp-once' }, projectRoot: root } });
    assert.equal(command.structuredContent.exitCode, 0);
    assert.equal(command.structuredContent.receiptId, replay.structuredContent.receiptId);
    assert.equal(fs.readdirSync(path.join(root, '.contextos', 'logs')).filter((name) => name.endsWith('.log')).length, 1);
  } finally { await cli.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('filtered plugin MCP child receives the task API profile/key and writes usage to the assigned parent ledger', async () => {
  const http = await import('node:http');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-child-api-'));
  const workspace = path.join(root, 'child'); fs.mkdirSync(workspace);
  const profile = path.join(root, 'private-api.json');
  const fixtureKey = 'fixture-private-key';
  let providerRequests = 0;
  let keyReachedProvider = false;
  const server = http.createServer((req, res) => {
    providerRequests += 1;
    keyReachedProvider = req.headers.authorization === `Bearer ${fixtureKey}`;
    req.resume(); res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ model: 'fixture-api', choices: [{ message: { role: 'assistant', content: JSON.stringify({ summary: 'No evidence found', selection: [], missing: ['No relevant source'] }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(profile, JSON.stringify({ micro: { url: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture-api', keyEnv: 'CONTEXTOS_API_MICRO_KEY' } }), { mode: 0o600 });
  const client = new Client({ name: 'child-api-check', version: '1' });
  const parentEnv = { ...process.env, CONTEXTOS_HOME: path.join(root, 'empty-home'), CONTEXTOS_WORKER_MODE: '1', CONTEXTOS_WORKER_ROOT: workspace,
    CONTEXTOS_PROJECT_ROOT: workspace, CONTEXTOS_MICRO_REPORT_ROOT: root, CONTEXTOS_MICRO_REPORT_JOB: 'assigned-child',
    CONTEXTOS_API_MICRO_PROFILE: profile, CONTEXTOS_API_MICRO_KEY: fixtureKey, CONTEXTOS_DISABLE_API_MICRO: '0',
    CONTEXTOS_DISABLE_MICRO: '1', CONTEXTOS_UNLISTED_TEST_SENTINEL: 'must-not-reach-mcp' };
  const env = filteredPluginServerEnv(parentEnv);
  assert.equal(env.CONTEXTOS_UNLISTED_TEST_SENTINEL, undefined, 'unlisted parent variables must not reach the plugin server');
  const transport = new StdioClientTransport({ command: process.execPath, args: [process.env.CONTEXTOS_TEST_ENTRYPOINT || fileURLToPath(new URL('../src/v3-server.mjs', import.meta.url))], env, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const response = await client.callTool({ name: 'contextos', arguments: { action: 'ask', args: { request: 'Locate the validation rule' }, projectRoot: workspace } });
    assert.equal(providerRequests, 1, 'the MCP child should make one request to the local provider stub');
    assert.equal(keyReachedProvider, true, 'the allowlisted standard key should reach the transport');
    assert.ok(!response.content[0].text.includes('Semantic evidence selection needs an injected transport'));
    const rows = fs.readFileSync(path.join(root, '.contextos', 'logs', 'role-usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1); assert.equal(rows[0].role, 'api-micro'); assert.equal(rows[0].parentTaskId, 'assigned-child');
    assert.equal(rows[0].model, 'fixture-api'); assert.equal(rows[0].usage.inputTokens, 10); assert.equal(rows[0].usage.outputTokens, 3);
    assert.equal(fs.existsSync(path.join(workspace, '.contextos', 'logs', 'role-usage.jsonl')), false);
    assert.ok(!JSON.stringify(rows).includes(fixtureKey));
  } finally {
    await client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
  }
});
