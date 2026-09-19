import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { V2Database, SyncEngine, withProjectWriteLock } from '../src/index.mjs';

test('V2Database basic CRUD and relations', () => {
  const db = new V2Database(':memory:');
  const project = db.ensureProject('proj-test', '/tmp/repo');
  assert.equal(project.id, 'proj-test');

  // 1. Save Plan with Phases and Checkpoints
  db.savePlan({
    id: 'plan-1',
    projectId: 'proj-test',
    title: 'Test Plan',
    priority: 'high',
    status: 'active',
    summary: 'Plan summary',
    phases: [
      { id: 'P0', order: 0, objective: 'Init', status: 'active' },
      { id: 'P1', order: 1, objective: 'Develop', status: 'pending' },
    ],
    checkpoints: [
      { id: 'cp-1', title: 'Verify P0', status: 'pending' },
    ],
  });

  const fetchedPlan = db.getPlan('plan-1');
  assert.equal(fetchedPlan.title, 'Test Plan');
  assert.equal(fetchedPlan.phases.length, 2);
  assert.equal(fetchedPlan.phases[0].id, 'P0');
  assert.equal(fetchedPlan.checkpoints.length, 1);
  assert.equal(fetchedPlan.checkpoints[0].id, 'cp-1');

  db.saveTask({
    id: 'task-plan-preserve',
    planId: 'plan-1',
    phaseId: 'P0',
    title: 'Task must survive plan updates',
    status: 'active',
  });
  fetchedPlan.status = 'active';
  fetchedPlan.summary = 'Updated plan summary';
  db.savePlan(fetchedPlan);
  assert.equal(db.getTask('task-plan-preserve').status, 'active');

  // 2. Save Block with ArtifactRefs
  db.saveBlock({
    id: 'block-1',
    projectId: 'proj-test',
    title: 'Block 1',
    summary: 'Block 1 summary',
    artifactRefs: [
      { path: 'src/index.js', symbol: 'main', startLine: 1, endLine: 20, hash: 'h1' },
      { path: 'src/utils.js', symbol: 'helper', startLine: 5, endLine: 15, hash: 'h2' },
    ],
  });

  const fetchedBlock = db.getBlock('block-1');
  assert.equal(fetchedBlock.title, 'Block 1');
  assert.equal(fetchedBlock.artifactRefs.length, 2);
  assert.equal(fetchedBlock.artifactRefs[0].symbol, 'main');

  // 3. Save Chain and Link
  db.saveChain({
    id: 'chain-1',
    projectId: 'proj-test',
    title: 'Chain 1',
    kind: 'leaf',
    memberIds: ['block-1'],
  });

  db.saveLink({
    id: 'link-1',
    projectId: 'proj-test',
    from: 'block-1',
    to: 'block-2',
    kind: 'calls',
  });

  assert.equal(db.listChains('proj-test').length, 1);
  assert.equal(db.listLinks('proj-test').length, 1);

  db.close();
});

test('SyncEngine export rejects stale Git rollback and preserves newer database state', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-storage-test-'));
  const dbPath = path.join(tempDir, '.contextos', 'state.sqlite');
  const db = new V2Database(dbPath);
  db.ensureProject('proj-git', tempDir);

  const sync = new SyncEngine(db);

  // 1. Initial State: Revision 1
  db.saveBlock({
    id: 'block-base',
    projectId: 'proj-git',
    title: 'Base Block',
    artifactRefs: [{ path: 'src/base.js', hash: 'h0' }],
  });

  const export1 = sync.exportGraphToJson('proj-git', tempDir);
  assert.equal(export1.graphRevision, 1);
  const jsonPath = path.join(tempDir, '.contextos', 'graph.json');
  assert.ok(fs.existsSync(jsonPath));
  const savedJsonV1 = fs.readFileSync(jsonPath, 'utf8');

  // 2. Further developments: Revision 2 & Revision 3
  db.saveBlock({
    id: 'block-v2',
    projectId: 'proj-git',
    title: 'New Feature Block',
    artifactRefs: [{ path: 'src/feature.js', hash: 'h1' }],
  });
  const export2 = sync.exportGraphToJson('proj-git', tempDir);
  assert.equal(export2.graphRevision, 2);

  db.saveBlock({
    id: 'block-v3',
    projectId: 'proj-git',
    title: 'Another Feature Block',
    artifactRefs: [{ path: 'src/another.js', hash: 'h2' }],
  });
  const export3 = sync.exportGraphToJson('proj-git', tempDir);
  assert.equal(export3.graphRevision, 3);
  assert.equal(db.listBlocks('proj-git').length, 3);

  // 3. Simulate Git Revert to V1:
  // User runs `git checkout <commit-v1> -- .contextos/graph.json`
  fs.writeFileSync(jsonPath, savedJsonV1, 'utf8');

  // Reconcile an older graph. This is a conflict, not an implicit rollback.
  const reconcileResult = sync.reconcileExternalChange('proj-git', tempDir);
  assert.equal(reconcileResult.changed, false);
  assert.equal(reconcileResult.conflict, true);
  assert.equal(reconcileResult.graphRevision, 1);
  assert.equal(reconcileResult.databaseRevision, 3);

  // Check that SQLite state was preserved at Revision 3.
  const currentBlocks = db.listBlocks('proj-git');
  assert.equal(currentBlocks.length, 3);
  assert.ok(db.getBlock('block-base'));
  assert.ok(db.getBlock('block-v2'));
  assert.ok(db.getBlock('block-v3'));

  // 4. Invalid JSON simulation: Must NOT corrupt SQLite
  fs.writeFileSync(jsonPath, 'BROKEN JSON CONTENT {{{{', 'utf8');
  assert.throws(
    () => sync.reconcileExternalChange('proj-git', tempDir),
    /Invalid JSON syntax/
  );
  // SQLite must still have the valid state
  assert.equal(db.listBlocks('proj-git').length, 3);

  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('V2Database persists directory bindings and omits the legacy artifact ledger', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-tree-db-'));
  const db = new V2Database(path.join(tempDir, '.contextos', 'state.sqlite'));
  db.ensureProject('proj-tree-bindings', tempDir);

  db.saveBlock({
    id: 'block-dependencies',
    projectId: 'proj-tree-bindings',
    title: 'Dependencies',
    kind: 'dependency',
    artifactRefs: [{
      path: 'node_modules',
      anchorKind: 'tree',
      hashMode: 'manifest',
      manifest: 'package-lock.json',
      hash: 'lock-hash',
      role: 'dependency',
    }],
  });
  db.savePlan({
    id: 'plan-tree-bindings',
    projectId: 'proj-tree-bindings',
    title: 'Tree Bindings',
    phases: [{ id: 'P0', order: 0, status: 'active' }],
  });
  db.saveTask({
    id: 'task-tree-bindings',
    planId: 'plan-tree-bindings',
    phaseId: 'P0',
    title: 'Bind dependencies',
    status: 'completed',
    contextSlice: {
      objective: 'Represent dependencies as one boundary',
      locators: [{ path: 'node_modules/runtime/index.js', symbol: 'runtime' }],
    },
    baseline: {
      fileSnapshots: {
        'node_modules/runtime/index.js': { hash: 'ephemeral' },
      },
    },
  });

  const fetched = db.getBlock('block-dependencies');
  assert.equal(fetched.artifactRefs[0].anchorKind, 'tree');
  assert.equal(fetched.artifactRefs[0].hashMode, 'manifest');
  assert.equal(fetched.artifactRefs[0].manifest, 'package-lock.json');

  const sync = new SyncEngine(db);
  sync.exportGraphToJson('proj-tree-bindings', tempDir);
  const graph = JSON.parse(fs.readFileSync(path.join(tempDir, '.contextos', 'graph.json'), 'utf8'));
  assert.equal(graph.schemaVersion, 3);
  assert.equal(graph.data.artifacts, undefined);
  assert.equal(graph.data.buildRuns, undefined);
  assert.equal(graph.data.blocks[0].artifactRefs[0].hashMode, 'manifest');
  assert.equal(graph.data.tasks[0].contextSlice.objective, 'Represent dependencies as one boundary');
  assert.equal(graph.data.tasks[0].contextSlice.locators, undefined);
  assert.equal(graph.data.tasks[0].baseline, undefined);

  const imported = new V2Database(':memory:');
  new SyncEngine(imported).importGraphFromJson(JSON.stringify(graph), tempDir);
  assert.equal(imported.getBlock('block-dependencies').artifactRefs[0].manifest, 'package-lock.json');
  const legacyTables = imported.db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('artifact_records', 'artifact_links', 'build_runs')"
  ).all();
  assert.deepEqual(legacyTables, []);

  db.close();
  imported.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Project write lock serializes async writers', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-lock-test-'));
  const events = [];
  const run = (name, delay) =>
    withProjectWriteLock(tempDir, async () => {
      events.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      events.push(`${name}:end`);
    });

  await Promise.all([run('a', 30), run('b', 5)]);
  const aStart = events.indexOf('a:start');
  const aEnd = events.indexOf('a:end');
  const bStart = events.indexOf('b:start');
  const bEnd = events.indexOf('b:end');
  assert.ok(aStart >= 0 && bStart >= 0 && aEnd >= 0 && bEnd >= 0);
  assert.ok(aEnd < bStart || bEnd < aStart, `Writers interleaved: ${events.join(', ')}`);
  assert.equal(fs.existsSync(path.join(tempDir, '.contextos', 'project.lock')), false);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Graph outbox recovers a queued export after an interrupted writer', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-outbox-test-'));
  const db = new V2Database(path.join(tempDir, '.contextos', 'state.sqlite'));
  db.ensureProject('proj-outbox', tempDir);
  const sync = new SyncEngine(db);

  db.saveBlock({
    id: 'block-outbox',
    projectId: 'proj-outbox',
    title: 'Outbox Block',
    artifactRefs: [{ path: 'src/outbox.js', hash: 'hash-outbox' }],
  });
  const queued = sync.queueGraphToJson('proj-outbox');
  assert.equal(queued.targetRevision, 1);
  assert.ok(db.getGraphOutbox('proj-outbox'));

  const recovered = sync.recoverGraphOutbox('proj-outbox', tempDir);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.graphRevision, 1);
  assert.equal(db.getProject('proj-outbox').graph_revision, 1);
  assert.equal(db.getGraphOutbox('proj-outbox'), null);

  const graph = JSON.parse(fs.readFileSync(path.join(tempDir, '.contextos', 'graph.json'), 'utf8'));
  assert.equal(graph.graphRevision, 1);
  assert.equal(graph.data.blocks[0].id, 'block-outbox');

  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Graph export does not leak tasks from another project', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-project-isolation-'));
  const db = new V2Database(path.join(tempDir, '.contextos', 'state.sqlite'));
  db.ensureProject('proj-one', tempDir);
  db.ensureProject('proj-two', tempDir);
  const sync = new SyncEngine(db);

  db.savePlan({
    id: 'plan-one',
    projectId: 'proj-one',
    title: 'One',
    phases: [{ id: 'P0', taskIds: ['task-one'] }],
  });
  db.saveTask({
    id: 'task-one',
    planId: 'plan-one',
    phaseId: 'P0',
    title: 'Task One',
  });
  db.savePlan({
    id: 'plan-two',
    projectId: 'proj-two',
    title: 'Two',
    phases: [{ id: 'P0', taskIds: ['task-two'] }],
  });
  db.saveTask({
    id: 'task-two',
    planId: 'plan-two',
    phaseId: 'P0',
    title: 'Task Two',
  });

  sync.exportGraphToJson('proj-one', tempDir);
  const graph = JSON.parse(fs.readFileSync(path.join(tempDir, '.contextos', 'graph.json'), 'utf8'));
  assert.deepEqual(graph.data.tasks.map((task) => task.id), ['task-one']);

  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
