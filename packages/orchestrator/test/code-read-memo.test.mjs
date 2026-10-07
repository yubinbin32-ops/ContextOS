import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { Orchestrator } from '../src/index.mjs';
import { workspaceFingerprint } from '../src/session-store.mjs';

function createProject({ git = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-code-read-memo-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'fixture.mjs'), 'export const answer = 42;\n', 'utf8');
  if (git) {
    try {
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', [
        '-c', 'user.name=ContextOS',
        '-c', 'user.email=contextos@example.test',
        'commit', '-m', 'fixture baseline',
      ], { cwd: root, stdio: 'ignore' });
    } catch (_) {}
  }
  return root;
}

function createService(root, calls) {
  return {
    projectId: 'code-read-memo',
    async code(args) {
      calls.push(args);
      const content = fs.readFileSync(path.join(root, args.path), 'utf8');
      return `\`\`\`mjs\n// ${args.path} [L1-L${content.split(/\r?\n/).length - 1}] (hash: abc123)\n${content}\`\`\``;
    },
  };
}

test('low-level ops.code.read reuses a durable unchanged receipt across Orchestrators', async () => {
  const root = createProject();
  const calls = [];
  try {
    const first = await new Orchestrator({
      projectRoot: root,
      service: createService(root, calls),
      projectId: 'code-read-memo',
    }).dispatch('ops', {
      capability: 'code',
      action: 'read',
      args: { path: 'src/fixture.mjs' },
    });
    assert.match(first, /export const answer/);

    const second = await new Orchestrator({
      projectRoot: root,
      service: createService(root, calls),
      projectId: 'code-read-memo',
    }).dispatch('ops', {
      capability: 'code',
      action: 'read',
      args: { path: 'src/fixture.mjs' },
    });
    assert.match(second, /code read \(reused\)/);
    assert.doesNotMatch(second, /export const answer/);
    assert.equal(calls.length, 1, 'the second MCP request must not reread the source');

    fs.writeFileSync(path.join(root, 'src', 'fixture.mjs'), 'export const answer = 420;\n', 'utf8');
    const third = await new Orchestrator({
      projectRoot: root,
      service: createService(root, calls),
      projectId: 'code-read-memo',
    }).dispatch('ops', {
      capability: 'code',
      action: 'read',
      args: { path: 'src/fixture.mjs' },
    });
    assert.match(third, /export const answer = 420/);
    assert.equal(calls.length, 2, 'a changed file must invalidate the read receipt');

    const forced = await new Orchestrator({
      projectRoot: root,
      service: createService(root, calls),
      projectId: 'code-read-memo',
    }).dispatch('ops', {
      capability: 'code',
      action: 'read',
      args: { path: 'src/fixture.mjs', dedupeReads: false },
    });
    assert.match(forced, /export const answer = 420/);
    assert.equal(calls.length, 3, 'dedupeReads:false must provide an explicit escape hatch');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Micro withOS read calls use internal ContextOS dispatch and telemetry', async () => {
  const root = createProject();
  fs.mkdirSync(path.join(root, '.contextos'), { recursive: true });
  const requests = [];
  let providerCalls = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      providerCalls += 1;
      requests.push(JSON.parse(raw));
      const body = providerCalls === 1
        ? {
            choices: [{
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: 'inspect-1',
                  type: 'function',
                  function: {
                    name: 'os',
                    arguments: JSON.stringify({ action: 'inspect', path: 'src/fixture.mjs' }),
                  },
                }],
              },
            }],
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
          }
        : {
            choices: [{ message: { role: 'assistant', content: 'internal evidence consumed' } }],
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
          };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  fs.writeFileSync(path.join(root, '.contextos', 'profile.json'), JSON.stringify({
    micro: { url: `http://127.0.0.1:${port}`, model: 'test-model' },
  }) + '\n');
  const codeCalls = [];
  const service = {
    projectId: 'micro-internal-route',
    async code(args) {
      codeCalls.push(args);
      return 'bounded source from internal inspect';
    },
  };
  try {
    const result = JSON.parse(await new Orchestrator({
      projectRoot: root,
      service,
      projectId: 'micro-internal-route',
    }).dispatch('ops', {
      capability: 'micro',
      action: 'run',
      args: { prompt: 'inspect once', withOS: true },
    }));
    assert.equal(result.ok, true);
    assert.equal(result.content, 'internal evidence consumed');
    assert.equal(codeCalls.length, 1);
    assert.equal(requests.length, 2);
    const telemetry = fs.readFileSync(path.join(root, '.contextos', 'logs', 'telemetry.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(telemetry.some((entry) => entry.tool === 'inspect' && entry.internal === true));
    assert.ok(telemetry.some((entry) => entry.tool === 'ops' && entry.internal === false));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('low-level ops.code.search reuses a durable unchanged receipt without replaying the result', async () => {
  const root = createProject();
  const calls = [];
  const service = {
    projectId: 'code-search-memo',
    async code(args) {
      calls.push(args);
      return `# search ${args.query}\n- src/fixture.mjs:1 export const answer = 42;`;
    },
  };
  try {
    const first = await new Orchestrator({ projectRoot: root, service, projectId: 'code-search-memo' }).dispatch('ops', {
      capability: 'code',
      action: 'search',
      args: { query: 'answer' },
    });
    assert.match(first, /export const answer/);

    const second = await new Orchestrator({ projectRoot: root, service, projectId: 'code-search-memo' }).dispatch('ops', {
      capability: 'code',
      action: 'search',
      args: { query: 'answer' },
    });
    assert.match(second, /code search \(reused\)/);
    assert.doesNotMatch(second, /export const answer/);
    assert.equal(calls.length, 1);

    fs.writeFileSync(path.join(root, 'src', 'fixture.mjs'), 'export const answer = 420;\n', 'utf8');
    const third = await new Orchestrator({ projectRoot: root, service, projectId: 'code-search-memo' }).dispatch('ops', {
      capability: 'code',
      action: 'search',
      args: { query: 'answer' },
    });
    assert.match(third, /export const answer/);
    assert.equal(calls.length, 2, 'a source change must invalidate the search receipt');

    const forced = await new Orchestrator({ projectRoot: root, service, projectId: 'code-search-memo' }).dispatch('ops', {
      capability: 'code',
      action: 'search',
      args: { query: 'answer', dedupeReads: false },
    });
    assert.match(forced, /export const answer/);
    assert.equal(calls.length, 3, 'dedupeReads:false must force a fresh search');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repeated high-level explore reuses the unchanged discovery summary', async () => {
  const root = createProject();
  const calls = [];
  const service = {
    projectId: 'explore-memo',
    async osContext() { return {}; },
    async plan() { return []; },
    async code(args) {
      calls.push(args);
      return args.action === 'outline' ? '# outline\n- function answer()' : '# search';
    },
    async block() { return []; },
    async chain() { return []; },
    async knowledge() { return []; },
    syncEngine: { publishIfDirty() {} },
  };
  try {
    const first = await new Orchestrator({ projectRoot: root, service, projectId: 'explore-memo' }).dispatch('explore', {
      intent: 'locate answer',
      paths: ['src/fixture.mjs'],
    });
    assert.match(first, /ContextOS explore/);

    const callsAfterFirst = calls.length;
    const second = await new Orchestrator({ projectRoot: root, service, projectId: 'explore-memo' }).dispatch('explore', {
      intent: 'locate answer',
      paths: ['src/fixture.mjs'],
    });
    assert.match(second, /explore \(reused\)/);
    assert.doesNotMatch(second, /function answer/);
    assert.equal(calls.length, callsAfterFirst, 'unchanged exploration must not repeat internal code reads');

    const forced = await new Orchestrator({ projectRoot: root, service, projectId: 'explore-memo' }).dispatch('explore', {
      intent: 'locate answer',
      paths: ['src/fixture.mjs'],
      dedupeReads: false,
    });
    assert.match(forced, /ContextOS explore/);
    assert.equal(calls.length > callsAfterFirst, true, 'dedupeReads:false must force fresh exploration');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inspect pipeline reuses an unchanged receipt before rereading source', async () => {
  const root = createProject();
  const calls = [];
  try {
    const first = await new Orchestrator({
      projectRoot: root,
      service: createService(root, calls),
      projectId: 'inspect-memo',
    }).dispatch('inspect', { path: 'src/fixture.mjs' });
    assert.match(first, /export const answer/);

    const second = await new Orchestrator({
      projectRoot: root,
      service: createService(root, calls),
      projectId: 'inspect-memo',
    }).dispatch('inspect', { path: 'src/fixture.mjs' });
    assert.match(second, /unchanged.*reuse prior result/);
    assert.doesNotMatch(second, /export const answer/);
    assert.equal(calls.length, 1, 'inspect reuse must avoid the second source read');

    const refreshed = await new Orchestrator({
      projectRoot: root,
      service: createService(root, calls),
      projectId: 'inspect-memo',
    }).dispatch('inspect', { path: 'src/fixture.mjs', refresh: true });
    assert.match(refreshed, /export const answer/);
    assert.equal(calls.length, 2, 'refresh:true must force a fresh inspect');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parallel Pipeline inspect actions share one in-flight source read', async () => {
  const root = createProject();
  const calls = [];
  try {
    const result = await new Orchestrator({
      projectRoot: root,
      service: createService(root, calls),
      projectId: 'pipeline-read-memo',
    }).dispatch('pipeline', {
      steps: [{ parallel: [
        { inspect: { path: 'src/fixture.mjs' } },
        { inspect: { path: 'src/fixture.mjs' } },
      ] }],
    });
    assert.match(result, /pipeline=OK/);
    assert.equal(calls.length, 1, 'parallel duplicate inspect actions must share the in-flight read');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('non-git workspaces get bounded fingerprints for read reuse', () => {
  const root = createProject({ git: false });
  try {
    const first = workspaceFingerprint(root);
    assert.match(first, /^[0-9a-f]{64}$/);

    fs.mkdirSync(path.join(root, '.contextos'), { recursive: true });
    fs.writeFileSync(path.join(root, '.contextos', 'telemetry.jsonl'), 'derived state\n', 'utf8');
    assert.equal(workspaceFingerprint(root), first, 'ContextOS derived files must not invalidate source receipts');

    fs.writeFileSync(path.join(root, 'src', 'fixture.mjs'), 'export const answer = 43;\n', 'utf8');
    assert.notEqual(workspaceFingerprint(root), first, 'source changes must invalidate non-git receipts');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('state-changing ops actions are never served from the read memo', async () => {
  const root = createProject();
  const calls = [];
  const service = {
    projectId: 'code-read-memo',
    async plan(args) {
      calls.push(args);
      return `checkpoint ${args.checkpointId || 'unknown'} -> ${args.passed === false ? 'failed' : 'passed'}`;
    },
  };
  try {
    const run = () => new Orchestrator({ projectRoot: root, service, projectId: 'code-read-memo' }).dispatch('ops', {
      capability: 'plan',
      action: 'check',
      args: { planId: 'plan-1', checkpointId: 'cp-1', passed: true },
    });
    const first = await run();
    const second = await run();
    assert.doesNotMatch(second, /\(reused\)/, 'a checkpoint write must never be answered from the read memo');
    assert.equal(calls.length, 2, 'both identical check calls must actually run');
    assert.match(first, /passed/);
    assert.match(second, /passed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
