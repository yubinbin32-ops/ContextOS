import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Orchestrator } from '../src/index.mjs';
import { createMicroJob } from '../src/micro-delivery.mjs';

function createMockServer() {
  const requests = [];
  let handler = (req, res, body) => {
    const hasPreload = body?.messages?.some((message) => message.role === 'system' && message.content.includes('Preloaded OS context'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: hasPreload ? 'preloaded first answer' : 'first answer' } }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    }));
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch (_) {}
      requests.push(body);
      handler(req, res, body);
    });
  });
  return {
    requests,
    setHandler: (next) => { handler = next; },
    listen: () => new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function createProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-micro-first-turn-'));
  fs.mkdirSync(path.join(root, '.contextos'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'fixture.mjs'), 'export const fixture = true;\n', 'utf8');
  return root;
}

test('Micro session runFirst combines preload, first provider turn, and deferred recovery', async () => {
  const root = createProject();
  const mock = createMockServer();
  const url = await mock.listen();
  let codeCalls = 0;
  try {
    fs.writeFileSync(path.join(root, '.contextos', 'profile.json'), `${JSON.stringify({
      micro: { url, model: 'mock-model', key: 'test-key' },
    }, null, 2)}\n`, 'utf8');
    const orchestrator = new Orchestrator({
      projectRoot: root,
      projectId: 'micro-first-turn',
      service: {
        projectId: 'micro-first-turn',
        osContext: async () => ({}),
        code: async ({ action }) => {
          codeCalls += 1;
          return action === 'read' ? '# preloaded fixture evidence\n' : '';
        },
        syncEngine: { publishIfDirty() {} },
      },
    });

    const first = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'micro',
      action: 'session',
      args: {
        sessionAction: 'create',
        sessionId: 'first-turn',
        objective: 'Answer from one bounded preload.',
        preset: 'custom',
        task: 'Analyze the preloaded fixture.',
        runFirst: true,
        delivery: 'defer',
        pipeline: {
          steps: [{ inspect: { path: 'src/fixture.mjs', maxChars: 600 } }],
          maxChars: 600,
        },
      },
    }));
    assert.equal(first.ok, true);
    assert.equal(first.created, true);
    assert.equal(first.delivery, 'deferred');
    assert.equal(first.session.turnCount, 1);
    assert.equal(first.preload.status, 'OK');
    assert.equal(codeCalls, 1, 'preload must execute in the same host call as the first turn');
    assert.equal(mock.requests.length, 1, 'runFirst must avoid a separate create-then-send host round');
    assert.ok(mock.requests[0].messages.some((message) => message.content.includes('Preloaded OS context')));

    const recovered = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'session',
      action: 'resume',
    }));
    assert.equal(recovered.microRecovered.length, 1);
    assert.equal(recovered.microRecovered[0].content, 'preloaded first answer');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.contextos', 'micro-sessions', 'first-turn.json'), 'utf8')).pending, null);
  } finally {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Micro session runFirst remains explicit and requires a task', async () => {
  const root = createProject();
  try {
    const orchestrator = new Orchestrator({
      projectRoot: root,
      projectId: 'micro-first-turn-validation',
      service: {
        projectId: 'micro-first-turn-validation',
        osContext: async () => ({}),
        syncEngine: { publishIfDirty() {} },
      },
    });
    await assert.rejects(
      () => orchestrator.dispatch('ops', {
        capability: 'micro',
        action: 'session',
        args: { sessionAction: 'create', sessionId: 'missing-task', runFirst: true },
      }),
      /runFirst requires a non-empty task/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Micro session continue/resume aliases reuse the retained session without a fresh task', async () => {
  const root = createProject();
  const mock = createMockServer();
  const url = await mock.listen();
  try {
    fs.writeFileSync(path.join(root, '.contextos', 'profile.json'), `${JSON.stringify({
      micro: { url, model: 'mock-model', key: 'test-key' },
    }, null, 2)}\n`, 'utf8');
    const orchestrator = new Orchestrator({
      projectRoot: root,
      projectId: 'micro-resume-alias',
      service: {
        projectId: 'micro-resume-alias',
        osContext: async () => ({}),
        syncEngine: { publishIfDirty() {} },
      },
    });

    const first = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'micro',
      action: 'session',
      args: {
        sessionAction: 'create',
        sessionId: 'alias-turn',
        preset: 'custom',
        task: 'First bounded turn.',
        runFirst: true,
        delivery: 'immediate',
      },
    }));
    assert.equal(first.session.turnCount, 1);

    const continued = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'micro',
      action: 'session',
      args: { sessionAction: 'continue', sessionId: 'alias-turn', delivery: 'immediate' },
    }));
    assert.equal(continued.ok, true);
    assert.equal(continued.session.turnCount, 2);

    const resumed = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'micro',
      action: 'session',
      args: { sessionAction: 'resume', sessionId: 'alias-turn', delivery: 'immediate' },
    }));
    assert.equal(resumed.ok, true);
    assert.equal(resumed.session.turnCount, 3);
    assert.equal(mock.requests.length, 3, 'aliases must reuse the retained session instead of creating a new one');
  } finally {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unsupported Micro actions fail before the runner or job catalog', async () => {
  const root = createProject();
  try {
    const orchestrator = new Orchestrator({
      projectRoot: root,
      projectId: 'micro-action-validation',
      service: {
        projectId: 'micro-action-validation',
        osContext: async () => ({}),
        syncEngine: { publishIfDirty() {} },
      },
    });
    for (const action of ['status', 'frobnicate']) {
      await assert.rejects(
        () => orchestrator.dispatch('ops', {
          capability: 'micro',
          action,
          args: { prompt: 'must not reach the provider or job listing' },
        }),
        new RegExp(`Unsupported micro action '${action}'`),
      );
    }
    const listed = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'micro',
      action: 'list',
      args: {},
    }));
    assert.equal(listed.ok, true);
    assert.ok(Array.isArray(listed.jobs));
    createMicroJob(root, { jobId: 'api-job', kind: 'micro', provider: 'api', createdAt: '2026-01-01T00:00:00.000Z' });
    createMicroJob(root, { jobId: 'cli-job', kind: 'micro', provider: 'cli', createdAt: '2026-01-02T00:00:00.000Z' });
    createMicroJob(root, { jobId: 'agent-123', kind: 'agent', provider: 'cli', createdAt: '2026-01-03T00:00:00.000Z' });
    createMicroJob(root, { jobId: 'goal-legacy', provider: 'cli', createdAt: '2026-01-04T00:00:00.000Z' });
    const filtered = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'micro',
      action: 'list',
      args: {},
    }));
    assert.deepEqual(filtered.jobs.map((job) => job.jobId).sort(), ['api-job', 'cli-job']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('partial Micro reports retain the advertised session for continue', async () => {
  const root = createProject();
  const mock = createMockServer();
  const url = await mock.listen();
  const heldResponses = [];
  mock.setHandler((req, res) => {
    if (mock.requests.length === 1) {
      heldResponses.push(res);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'continued partial answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    }));
  });
  try {
    fs.writeFileSync(path.join(root, '.contextos', 'profile.json'), `${JSON.stringify({
      micro: { url, model: 'mock-model', key: 'test-key' },
    }, null, 2)}\n`, 'utf8');
    const orchestrator = new Orchestrator({
      projectRoot: root,
      projectId: 'micro-partial-retention',
      service: {
        projectId: 'micro-partial-retention',
        osContext: async () => ({}),
        syncEngine: { publishIfDirty() {} },
      },
    });

    const partial = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'micro',
      action: 'run',
      args: { prompt: 'Analyze the current partial state.', withOS: false, timeoutMs: 50, delivery: 'immediate' },
    }));
    assert.equal(partial.ok, false);
    assert.equal(partial.status, 'partial');
    assert.ok(partial.session?.id);
    assert.equal(partial.resume.sessionId, partial.session.id);

    const continued = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'micro',
      action: 'session',
      args: { sessionAction: 'continue', sessionId: partial.session.id, delivery: 'immediate' },
    }));
    assert.equal(continued.ok, true);
    assert.equal(continued.session.turnCount, 2);
    assert.equal(mock.requests.length, 2);
  } finally {
    for (const response of heldResponses) response.destroy();
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('provider-truncated implement reports retain a completed session for continue', async () => {
  const root = createProject();
  const mock = createMockServer();
  const url = await mock.listen();
  mock.setHandler((req, res) => {
    const first = mock.requests.length === 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: { role: 'assistant', content: first ? 'truncated implementation report' : 'continued implementation answer' },
        finish_reason: first ? 'length' : 'stop',
      }],
      usage: { prompt_tokens: 12, completion_tokens: first ? 24 : 4, total_tokens: first ? 36 : 16 },
    }));
  });
  try {
    fs.writeFileSync(path.join(root, '.contextos', 'profile.json'), `${JSON.stringify({
      micro: { url, model: 'mock-model', key: 'test-key' },
    }, null, 2)}\n`, 'utf8');
    const orchestrator = new Orchestrator({
      projectRoot: root,
      projectId: 'micro-truncated-retention',
      service: {
        projectId: 'micro-truncated-retention',
        osContext: async () => ({}),
        syncEngine: { publishIfDirty() {} },
      },
    });

    const truncated = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'micro',
      action: 'run',
      args: {
        prompt: 'Implement the bounded fixture change.',
        execution: 'implement',
        context: { allowedPaths: ['src/fixture.mjs'] },
        withOS: true,
        delivery: 'immediate',
      },
    }));
    assert.equal(truncated.ok, true);
    assert.equal(truncated.providerTruncated, true);
    assert.equal(truncated.truncated, true);
    assert.match(truncated.guidance, /sessionAction:"continue"/);
    assert.ok(truncated.session?.id);
    const stored = JSON.parse(fs.readFileSync(path.join(root, '.contextos', 'micro-sessions', `${truncated.session.id}.json`), 'utf8'));
    assert.equal(stored.status, 'active');
    assert.equal(stored.turnCount, 1);
    assert.equal(stored.pending, null);

    const continued = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'micro',
      action: 'session',
      args: { sessionAction: 'continue', sessionId: truncated.session.id, delivery: 'immediate' },
    }));
    assert.equal(continued.ok, false);
    assert.equal(continued.errorCode, 'MICRO_IMPLEMENTATION_NOT_APPLIED');
    assert.equal(continued.implementationEvidence.applied, false);
    assert.equal(continued.session.status, 'active');
    assert.equal(continued.session.turnCount, 1);
    assert.equal(mock.requests.length, 2);
  } finally {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
