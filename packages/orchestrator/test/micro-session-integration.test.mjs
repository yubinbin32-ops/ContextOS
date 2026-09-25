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
      choices: [{ message: { role: 'assistant', content: `answer-${requests.length}` } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch (_) {}
      requests.push({ url: req.url, headers: req.headers, body });
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-micro-session-integration-'));
  fs.mkdirSync(path.join(root, '.contextos'), { recursive: true });
  return root;
}

test('Orchestrator micro sessions preserve multi-turn state and return only final results', async () => {
  const root = createProject();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-micro-session-home-'));
  const previousHome = process.env.CONTEXTOS_HOME;
  process.env.CONTEXTOS_HOME = home;
  const mock = createMockServer();
  const url = await mock.listen();

  try {
    fs.writeFileSync(path.join(root, '.contextos', 'profile.json'), JSON.stringify({
      micro: { url, model: 'mock-model', key: 'test-key' },
    }, null, 2) + '\n');
    const orchestrator = new Orchestrator({
      projectRoot: root,
      projectId: 'micro-integration',
      service: {
        projectId: 'micro-integration',
        osContext: async () => ({}),
        syncEngine: { publishIfDirty() {} },
      },
    });

    const created = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'micro',
      action: 'session',
      args: {
        sessionAction: 'create',
        sessionId: 'ms-1',
        objective: 'Maintain a compact multi-turn worker.',
        preset: 'custom',
        maxTurns: 3,
      },
    }));
    assert.equal(created.ok, true);
    assert.equal(created.session.turnCount, 0);

    const first = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'micro',
      action: 'session',
      args: { sessionAction: 'send', sessionId: 'ms-1', task: 'first turn' },
    }));
    assert.equal(first.ok, true);
    assert.equal(first.content, 'answer-1');
    assert.equal(first.session.turnCount, 1);
    assert.equal('reasoning' in first, false);
    assert.equal('toolCalls' in first, false);

    const second = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'micro',
      action: 'session',
      args: { sessionAction: 'send', sessionId: 'ms-1', task: 'second turn' },
    }));
    assert.equal(second.ok, true);
    assert.equal(second.content, 'answer-2');
    assert.equal(second.session.turnCount, 2);

    const secondMessages = mock.requests[1].body.messages;
    assert.ok(secondMessages.some((message) => message.role === 'system' && message.content.includes('answer-1')));
    assert.ok(secondMessages.some((message) => message.role === 'user' && message.content === 'second turn'));

    const usageLines = fs.readFileSync(path.join(root, '.contextos', 'logs', 'micro-usage.jsonl'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean);
    assert.equal(usageLines.length, 2, 'each completed Micro turn must be recorded exactly once');
    const usageEntries = usageLines.map((line) => JSON.parse(line));
    assert.ok(usageEntries.every((entry) => entry.sessionMode === 'persistent'));

    mock.setHandler((req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'mock failure' } }));
    });
    const failed = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'micro',
      action: 'session',
      args: { sessionAction: 'send', sessionId: 'ms-1', task: 'failed turn' },
    }));
    assert.equal(failed.ok, false);
    assert.match(failed.error, /mock failure/);
    assert.equal(failed.session.turnCount, 2);

    const persisted = JSON.parse(fs.readFileSync(path.join(root, '.contextos', 'micro-sessions', 'ms-1.json'), 'utf8'));
    assert.equal(persisted.pending, null);
    assert.equal(persisted.turnCount, 2);
  } finally {
    if (previousHome === undefined) delete process.env.CONTEXTOS_HOME;
    else process.env.CONTEXTOS_HOME = previousHome;
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
