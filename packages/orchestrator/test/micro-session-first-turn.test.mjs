import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Orchestrator } from '../src/index.mjs';

function createMockServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch (_) {}
      requests.push(body);
      const hasPreload = Array.isArray(body?.messages)
        && body.messages.some((message) => message.role === 'system' && message.content.includes('Preloaded OS context'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: hasPreload ? 'preloaded first answer' : 'first answer' } }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      }));
    });
  });
  return {
    requests,
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
