import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import worker from '../../../worker.js';
import { runSwitch } from '../src/system-tools.mjs';
import { V2Database } from '../../storage/src/database.mjs';

class FakeStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  first() {
    return this.database.prepare(this.sql).get(...this.params) || null;
  }

  all() {
    return { results: this.database.prepare(this.sql).all(...this.params) };
  }

  run() {
    const result = this.database.prepare(this.sql).run(...this.params);
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }
}

class FakeD1 {
  constructor() {
    this.database = new DatabaseSync(':memory:');
    this.database.exec('PRAGMA foreign_keys = ON;');
  }

  exec(sql) {
    this.database.exec(sql);
  }

  prepare(sql) {
    return new FakeStatement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      for (const statement of statements) statement.run();
      this.database.exec('COMMIT;');
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }
}

function request(path, { method = 'GET', token = 'secret', origin = null, body = null } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (origin) headers.Origin = origin;
  return new Request(`https://cloud.test${path}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
}

function completeSnapshot() {
  return {
    schemaVersion: 4,
    project: { id: 'project-1', name: 'Project One', root: '/tmp/project-1', graphRevision: 7 },
    changeSequence: 7,
    plans: [{ id: 'plan-1', title: 'Plan One', status: 'active', priority: 'high', summary: 'summary' }],
    phases: [{ id: 'phase-1', planId: 'plan-1', order: 1, objective: 'objective', status: 'active', taskIds: ['task-1'], deliverables: ['d'], acceptance: ['a'] }],
    checkpoints: [{ id: 'cp-1', targetType: 'plan', targetId: 'plan-1', phaseId: 'phase-1', title: 'Checkpoint One', criteria: 'criteria', status: 'passed', evidenceRefs: ['receipt-1'], completedAt: '2026-01-01T00:00:00.000Z' }],
    tasks: [{ id: 'task-1', planId: 'plan-1', phaseId: 'phase-1', title: 'Task One', status: 'completed', contextSlice: { objective: 'slice' }, workingSet: { files: ['src/a.js'] }, references: { rules: ['rule-1'] }, baseline: { fileSnapshots: {} }, notes: [{ text: 'note' }], checks: [{ passed: true }], syncResult: { graphRevision: 7 } }],
    blocks: [{ id: 'block-1', kind: 'service', title: 'Block One', summary: 'block summary', body: 'body', artifactRefs: [{ id: 'ref-1', path: 'src/a.js', symbol: 'a', startLine: 1, endLine: 2, hash: 'abc', role: 'implementation' }] }],
    chains: [{ id: 'chain-1', title: 'Chain One', chainType: 'linear', purpose: 'chain purpose', memberIds: ['block-1'] }],
    links: [{ id: 'link-1', sourceId: 'block-1', targetId: 'block-1', kind: 'depends_on', label: 'self' }],
  };
}

async function json(response) {
  return response.json();
}

test('cloud requires a configured token and rejects URL query tokens', async () => {
  const db = new FakeD1();
  const env = { DB: db, AUTH_TOKEN: 'secret' };
  const missing = await worker.fetch(request('/api/v2/health', { token: null }), env, {});
  assert.equal(missing.status, 401);

  const query = await worker.fetch(request('/api/v2/health?token=secret', { token: null }), env, {});
  assert.equal(query.status, 401);

  const authorized = await worker.fetch(request('/api/v2/health'), env, {});
  assert.equal(authorized.status, 200);
  assert.equal((await json(authorized)).authRequired, true);
});

test('cloud defaults closed when no token is configured unless explicitly opened', async () => {
  const db = new FakeD1();
  const closed = await worker.fetch(request('/api/v2/health', { token: null }), { DB: db }, {});
  assert.equal(closed.status, 401);

  const open = await worker.fetch(request('/api/v2/health', { token: null }), { DB: db, ALLOW_OPEN_ACCESS: 'true' }, {});
  assert.equal(open.status, 200);
});

test('cloud CORS only reflects explicitly allowed origins', async () => {
  const env = { DB: new FakeD1(), AUTH_TOKEN: 'secret', ALLOWED_ORIGINS: 'https://app.example.com' };
  const allowed = await worker.fetch(request('/api/v2/health', { origin: 'https://app.example.com' }), env, {});
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.example.com');

  const denied = await worker.fetch(request('/api/v2/health', { origin: 'https://evil.example.com' }), env, {});
  assert.equal(denied.headers.get('access-control-allow-origin'), null);

  const preflight = await worker.fetch(request('/api/v2/health', { method: 'OPTIONS', origin: 'https://app.example.com' }), env, {});
  assert.equal(preflight.status, 204);
});

test('cloud snapshot round-trip preserves the complete graph contract', async () => {
  const env = { DB: new FakeD1(), AUTH_TOKEN: 'secret' };
  const snapshot = completeSnapshot();
  const pushed = await worker.fetch(request('/api/v2/snapshot?projectId=project-1', { method: 'POST', body: snapshot }), env, {});
  assert.equal(pushed.status, 200);
  const pushResult = await json(pushed);
  assert.deepEqual(pushResult.counts, {
    plans: 1, phases: 1, checkpoints: 1, tasks: 1, blocks: 1, artifactRefs: 1, chains: 1, links: 1,
  });

  const pulledResponse = await worker.fetch(request('/api/v2/snapshot?projectId=project-1'), env, {});
  assert.equal(pulledResponse.status, 200);
  const pulled = await json(pulledResponse);
  assert.equal(pulled.schemaVersion, 4);
  assert.equal(pulled.project.graphRevision, 7);
  assert.equal(pulled.plans[0].id, 'plan-1');
  assert.deepEqual(pulled.phases[0].taskIds, ['task-1']);
  assert.deepEqual(pulled.checkpoints[0].evidenceRefs, ['receipt-1']);
  assert.deepEqual(pulled.tasks[0].contextSlice, { objective: 'slice' });
  assert.deepEqual(pulled.blocks[0].artifactRefs[0].path, 'src/a.js');
  assert.deepEqual(pulled.chains[0].memberIds, ['block-1']);
  assert.deepEqual(pulled.chainMembers, [{ chainId: 'chain-1', blockId: 'block-1', order: 0 }]);
  assert.equal(pulled.links[0].sourceId, 'block-1');
  assert.equal(pulled.links[0].targetId, 'block-1');
});

test('cloud snapshot replacement rolls back on a mid-batch failure', async () => {
  const env = { DB: new FakeD1(), AUTH_TOKEN: 'secret' };
  const valid = completeSnapshot();
  await worker.fetch(request('/api/v2/snapshot?projectId=project-1', { method: 'POST', body: valid }), env, {});

  const invalid = { ...valid, phases: [{ id: null, planId: 'plan-1' }] };
  const failed = await worker.fetch(request('/api/v2/snapshot?projectId=project-1', { method: 'POST', body: invalid }), env, {});
  assert.equal(failed.status, 400);

  const pulled = await json(await worker.fetch(request('/api/v2/snapshot?projectId=project-1'), env, {}));
  assert.equal(pulled.plans.length, 1);
  assert.equal(pulled.blocks.length, 1);
  assert.equal(pulled.tasks.length, 1);
});

test('local-to-cloud migration fails closed when the local graph cannot be read', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-cloud-fail-closed-'));
  const dotContextos = path.join(root, '.contextos');
  fs.mkdirSync(path.join(dotContextos, 'state.sqlite'), { recursive: true });
  fs.writeFileSync(path.join(dotContextos, 'project.json'), JSON.stringify({ id: 'project-fail-closed' }), 'utf8');

  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error('fetch must not be called');
  };
  try {
    await assert.rejects(
      () => runSwitch({ projectRoot: root, targetMode: 'cloud', cloudUrl: 'https://cloud.test', token: 'secret', projectId: 'project-fail-closed' }),
      /local graph could not be read/,
    );
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local-cloud-local switch preserves the complete graph contract', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-cloud-roundtrip-'));
  const dotContextos = path.join(root, '.contextos');
  const projectId = 'project-roundtrip';
  fs.mkdirSync(dotContextos, { recursive: true });
  fs.writeFileSync(path.join(dotContextos, 'project.json'), JSON.stringify({
    id: projectId,
    storage: 'local',
    isCloud: false,
  }), 'utf8');

  const db = new V2Database(path.join(dotContextos, 'state.sqlite'));
  db.ensureProject(projectId, root);
  db.setGraphRevision(projectId, 11);
  db.savePlan({
    id: 'plan-roundtrip',
    projectId,
    title: 'Roundtrip Plan',
    status: 'active',
    ruleRefs: ['rule-one'],
    phases: [{ id: 'phase-roundtrip', order: 2, taskIds: ['task-roundtrip'], acceptance: ['accepted'] }],
    checkpoints: [{ id: 'cp-roundtrip', title: 'Roundtrip Checkpoint', status: 'passed' }],
  });
  db.saveTask({
    id: 'task-roundtrip',
    planId: 'plan-roundtrip',
    phaseId: 'phase-roundtrip',
    title: 'Roundtrip Task',
    contextSlice: { objective: 'preserve me' },
    references: { rules: ['rule-one'] },
  });
  db.saveBlock({
    id: 'block-roundtrip',
    projectId,
    title: 'Roundtrip Block',
    kind: 'service',
    details: 'body must survive',
    history: [{ action: 'bound' }],
    artifactRefs: [{
      path: 'src/tree',
      anchorKind: 'tree',
      hash: 'tree-hash',
      hashMode: 'manifest',
      manifest: 'manifest.txt',
      role: 'implementation',
    }],
  });
  db.saveChain({
    id: 'chain-roundtrip',
    projectId,
    title: 'Roundtrip Chain',
    summary: 'purpose must survive',
    kind: 'pipeline',
    memberIds: ['block-roundtrip'],
    metadata: { source: 'test' },
  });
  db.saveLink({
    id: 'link-roundtrip',
    projectId,
    from: 'block-roundtrip',
    to: 'block-roundtrip',
    kind: 'depends_on',
    reason: 'reason must survive',
    provenance: 'authored',
    confidence: 0.75,
  });
  db.close();

  const env = { DB: new FakeD1(), AUTH_TOKEN: 'secret' };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => worker.fetch(new Request(url, init), env, {});
  try {
    await runSwitch({ projectRoot: root, targetMode: 'cloud', cloudUrl: 'https://cloud.test', token: 'secret', projectId });
    const emptyDb = new V2Database(path.join(dotContextos, 'state.sqlite'));
    emptyDb.replaceProjectState(projectId, { project: { graphRevision: 11 } });
    emptyDb.close();

    await runSwitch({ projectRoot: root, targetMode: 'local', token: 'secret' });
    const restored = new V2Database(path.join(dotContextos, 'state.sqlite'));
    const block = restored.getBlock('block-roundtrip');
    const chain = restored.getChain('chain-roundtrip');
    const link = restored.getLink('link-roundtrip');
    assert.equal(block.details, 'body must survive');
    assert.deepEqual(block.history, [{ action: 'bound' }]);
    assert.deepEqual(block.artifactRefs[0], {
      path: 'src/tree',
      symbol: null,
      anchorKind: 'tree',
      startLine: null,
      endLine: null,
      hash: 'tree-hash',
      role: 'implementation',
      hashMode: 'manifest',
      manifest: 'manifest.txt',
    });
    assert.equal(chain.summary, 'purpose must survive');
    assert.equal(chain.kind, 'pipeline');
    assert.deepEqual(chain.metadata, { source: 'test' });
    assert.equal(link.reason, 'reason must survive');
    assert.equal(link.provenance, 'authored');
    assert.equal(link.confidence, 0.75);
    assert.equal(restored.getPlan('plan-roundtrip').phases[0].taskIds[0], 'task-roundtrip');
    assert.equal(restored.listTasks('plan-roundtrip')[0].contextSlice.objective, 'preserve me');
    restored.close();
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
