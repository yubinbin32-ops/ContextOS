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

const requests = [];
const provider = http.createServer((req, res) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    requests.push(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'deferred provider answer' } }],
      usage: { prompt_tokens: 31, completion_tokens: 7, total_tokens: 38 },
    }));
  });
});

const fixture = createFixtureProject({ prefix: 'ctxos-micro-direct-pipeline' });
let transport = null;
let client = null;

try {
  const url = await new Promise((resolve) => {
    provider.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${provider.address().port}`));
  });
  fs.mkdirSync(path.join(fixture.root, '.contextos'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, 'src', 'large-a.mjs'), `${'export const a = 1;\n'.repeat(500)}`);
  fs.writeFileSync(path.join(fixture.root, 'src', 'large-b.mjs'), `${'export const b = 2;\n'.repeat(500)}`);
  fs.writeFileSync(path.join(fixture.root, 'src', 'large-c.mjs'), `${'export const c = 3;\n'.repeat(500)}`);
  fs.writeFileSync(path.join(fixture.root, '.contextos', 'profile.json'), JSON.stringify({
    micro: { url, model: 'bundle-acceptance-model', key: 'test-key' },
  }, null, 2) + '\n');

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundlePath],
    cwd: repoRoot,
    stderr: 'inherit',
    env: { ...process.env, CONTEXTOS_LEAN_SURFACE: '0' },
  });
  client = new Client({ name: 'contextos-micro-direct-pipeline-acceptance', version: packageVersion });
  await client.connect(transport);

  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: { projectRoot: fixture.root, ...args } });
    const text = (result.content || []).map((chunk) => chunk.text || '').join('\n');
    assert.equal(Boolean(result.isError), false, `${name} failed: ${text}`);
    return text;
  };

  const deferred = JSON.parse(await call('ops', {
    capability: 'micro',
    action: 'run',
    args: {
      preset: 'triage',
      task: 'Summarize the relevant source contract for the next host decision.',
      delivery: 'defer',
      pipeline: {
        steps: [{ inspect: { path: 'src/math.mjs', ranges: [{ startLine: 1, endLine: 6 }] } }],
        maxChars: 2400,
      },
    },
  }));
  assert.equal(deferred.ok, true);
  assert.equal(deferred.delivery, 'deferred');
  assert.equal(deferred.preload?.status, 'OK', 'direct Pipeline preload must complete before the Micro request');
  assert.ok(deferred.preload?.artifactId, 'direct Pipeline must leave an evidence artifact');
  assert.equal(requests.length, 1, 'attached Pipeline must not cause a separate provider call');
  assert.ok(
    requests[0].messages.some((message) => message.role === 'system' && message.content.includes('Preloaded OS context')),
    'provider must receive the bounded Pipeline evidence'
  );

  const autoBound = JSON.parse(await call('ops', {
    capability: 'micro',
    action: 'run',
    args: {
      preset: 'triage',
      task: 'Summarize the bounded multi-file evidence.',
      pipeline: {
        steps: [
          { inspect: { path: 'src/large-a.mjs', fullFile: true } },
          { inspect: { path: 'src/large-b.mjs', fullFile: true } },
          { inspect: { path: 'src/large-c.mjs', fullFile: true } },
        ],
        maxChars: 1200,
      },
    },
  }));
  assert.equal(autoBound.ok, true, 'multi-step attached evidence should be auto-bounded');
  assert.equal(autoBound.preload?.status, 'OK');
  assert.equal(autoBound.preload?.truncated, false);
  assert.equal(autoBound.preload?.projectedSteps, 3);
  assert.ok(autoBound.preload?.chars <= 1200);
  assert.equal(requests.length, 2, 'auto-bounded evidence must still use one provider request');
  assert.match(
    autoBound.microRecovered?.[0]?.content || '',
    /deferred provider answer/,
    'the next top-level Micro call must recover the prior deferred answer'
  );

  const recovered = await call('explore', { intent: 'resume the pending host decision' });
  assert.doesNotMatch(recovered, /deferred provider answer/, 'a recovered delivery must not be replayed twice');

  const beforeSessionCreate = requests.length;
  const created = JSON.parse(await call('ops', {
    capability: 'micro',
    action: 'session',
    args: {
      sessionAction: 'create',
      sessionId: 'bundle-pipeline-session',
      preset: 'triage',
      pipeline: { steps: [{ inspect: { path: 'src/strings.mjs' } }], maxChars: 1800 },
    },
  }));
  assert.equal(created.ok, true);
  assert.equal(created.preload.status, 'OK');
  assert.equal(requests.length, beforeSessionCreate, 'session create with Pipeline must not call the provider prematurely');

  const firstSessionTurn = JSON.parse(await call('ops', {
    capability: 'micro',
    action: 'session',
    args: { sessionAction: 'send', sessionId: 'bundle-pipeline-session', task: 'consume the attached evidence' },
  }));
  assert.equal(firstSessionTurn.ok, true);
  assert.equal(requests.length, beforeSessionCreate + 1);
  assert.ok(
    requests.at(-1).messages.some((message) => message.role === 'system' && message.content.includes('Preloaded OS context')),
    'first persistent Micro turn must consume the attached Pipeline once'
  );
  await call('ops', {
    capability: 'micro',
    action: 'session',
    args: { sessionAction: 'send', sessionId: 'bundle-pipeline-session', task: 'continue without replaying evidence' },
  });
  assert.equal(requests.length, beforeSessionCreate + 2);
  assert.equal(
    requests.at(-1).messages.some((message) => message.role === 'system' && message.content.includes('Preloaded OS context')),
    false,
    'later persistent Micro turns must not replay the attached Pipeline'
  );

  const usagePath = path.join(fixture.root, '.contextos', 'logs', 'micro-usage.jsonl');
  const usageEntries = fs.readFileSync(usagePath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const usage = usageEntries.find((entry) => entry.requestedDelivery === 'defer');
  assert.ok(usage, 'deferred direct Micro usage must be recorded');
  assert.equal(usage.requestedDelivery, 'defer');
  assert.equal(usage.deliveryOutcome, 'deferred');
  assert.equal(usage.preloadAttached, true);
  assert.equal(usage.totalTokens, 38);

  console.log(JSON.stringify({
    ok: true,
    providerCalls: requests.length,
    delivery: deferred.delivery,
    recovered: /deferred provider answer/.test(autoBound.microRecovered?.[0]?.content || ''),
    autoBoundProjectedSteps: autoBound.preload.projectedSteps,
    preloadAttached: usage.preloadAttached,
    providerTokens: usage.totalTokens,
  }));
} finally {
  if (client) await client.close();
  if (transport) await transport.close();
  await new Promise((resolve) => provider.close(resolve));
  fixture.cleanup();
}
