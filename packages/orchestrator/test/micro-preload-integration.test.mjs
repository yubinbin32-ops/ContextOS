import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Orchestrator } from '../src/index.mjs';

function createMockServer() {
  const requests = [];
  let handler = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'preload analyzed' } }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    }));
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch (_) {}
      requests.push({ body });
      handler(req, res, body);
    });
  });
  return {
    requests,
    setHandler(fn) { handler = fn; },
    listen: () => new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function createProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-micro-preload-integration-'));
  fs.mkdirSync(path.join(root, '.contextos'), { recursive: true });
  return root;
}

test('Orchestrator preloads session context once and keeps raw pipeline output out of the host response', async () => {
  const root = createProject();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-micro-preload-home-'));
  const previousHome = process.env.CONTEXTOS_HOME;
  process.env.CONTEXTOS_HOME = home;
  const mock = createMockServer();
  const url = await mock.listen();
  let codeCalls = 0;

  try {
    fs.writeFileSync(path.join(root, '.contextos', 'profile.json'), JSON.stringify({
      micro: { url, model: 'mock-model', key: 'test-key' },
    }, null, 2) + '\n');
    const raw = `# ContextOS inspect\n\n${'raw pipeline output\n'.repeat(300)}`;
    const orchestrator = new Orchestrator({
      projectRoot: root,
      projectId: 'micro-preload-integration',
      service: {
        projectId: 'micro-preload-integration',
        osContext: async () => ({}),
        code: async ({ action }) => {
          codeCalls += 1;
          return action === 'read' ? raw : '';
        },
        syncEngine: { publishIfDirty() {} },
      },
    });

    const created = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'micro',
      action: 'session',
      args: {
        sessionAction: 'create',
        sessionId: 'preload-ms',
        preset: 'custom',
        preload: {
          steps: [{ inspect: { path: 'src/large.mjs' } }],
          maxChars: 1000,
        },
      },
    }));
    assert.equal(created.ok, true);
    assert.equal(created.preload.status, 'OK');
    assert.ok(created.preload.artifactId);
    assert.doesNotMatch(JSON.stringify(created), /raw pipeline output\nraw pipeline output\nraw pipeline output/);
    assert.equal(mock.requests.length, 0, 'session creation must not dispatch a provider request');

    mock.setHandler((req, res, body) => {
      const preloadMessage = body.messages.find((message) => message.role === 'system' && message.content.includes('Preloaded OS context'));
      assert.ok(preloadMessage, 'first session turn must receive preloaded evidence');
      assert.match(preloadMessage.content, /artifact=/);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'preload analyzed' } }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      }));
    });

    const first = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'micro',
      action: 'session',
      args: { sessionAction: 'send', sessionId: 'preload-ms', task: 'analyze preload' },
    }));
    assert.equal(first.ok, true);
    assert.equal(first.content, 'preload analyzed');
    assert.equal(codeCalls, 1, 'preload must execute exactly once');

    const second = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'micro',
      action: 'session',
      args: { sessionAction: 'send', sessionId: 'preload-ms', task: 'continue' },
    }));
    assert.equal(second.ok, true);
    assert.equal(codeCalls, 1, 'later session turns must reuse the stored preload');
    assert.equal(mock.requests.length, 2);

    const third = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'micro',
      action: 'session',
      args: { sessionAction: 'send', sessionId: 'preload-ms', task: 'third turn' },
    }));
    const fourth = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'micro',
      action: 'session',
      args: { sessionAction: 'send', sessionId: 'preload-ms', task: 'fourth turn' },
    }));
    assert.equal(third.ok, true);
    assert.equal(fourth.ok, true);
    assert.equal(fourth.session.turnCount, 4);
    assert.equal(codeCalls, 1, 'four-turn session must not rerun preload');
    assert.equal(mock.requests.length, 4);
  } finally {
    if (previousHome === undefined) delete process.env.CONTEXTOS_HOME;
    else process.env.CONTEXTOS_HOME = previousHome;
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Orchestrator direct Micro preload returns a receipt instead of raw pipeline output', async () => {
  const root = createProject();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-micro-preload-direct-home-'));
  const previousHome = process.env.CONTEXTOS_HOME;
  process.env.CONTEXTOS_HOME = home;
  const mock = createMockServer();
  const url = await mock.listen();

  try {
    fs.writeFileSync(path.join(root, '.contextos', 'profile.json'), JSON.stringify({
      micro: { url, model: 'mock-model', key: 'test-key' },
    }, null, 2) + '\n');
    const raw = `# ContextOS inspect\n\n${'direct raw context\n'.repeat(250)}`;
    const orchestrator = new Orchestrator({
      projectRoot: root,
      projectId: 'micro-preload-direct',
      service: {
        projectId: 'micro-preload-direct',
        osContext: async () => ({}),
        code: async ({ action }) => (action === 'read' ? raw : ''),
        syncEngine: { publishIfDirty() {} },
      },
    });

    const result = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'micro',
      action: 'run',
      args: {
        preset: 'custom',
        task: 'analyze direct preload',
        preload: {
          steps: [{ inspect: { path: 'src/direct.mjs' } }],
          maxChars: 1000,
        },
      },
    }));

    assert.equal(result.ok, true);
    assert.equal(result.preload.status, 'OK');
    assert.ok(result.preload.artifactId);
    assert.doesNotMatch(JSON.stringify(result), /direct raw context\ndirect raw context\ndirect raw context/);
    assert.equal(mock.requests.length, 1);
    assert.ok(mock.requests[0].body.messages.some((message) => message.role === 'system' && message.content.includes('Preloaded OS context')));
  } finally {
    if (previousHome === undefined) delete process.env.CONTEXTOS_HOME;
    else process.env.CONTEXTOS_HOME = previousHome;
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
