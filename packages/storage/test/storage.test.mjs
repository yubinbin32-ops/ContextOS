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

  assert.throws(
    () => db.saveBlock({
      id: 'block-ghost',
      projectId: 'proj-test',
      title: 'Ghost',
      artifactRefs: [],
    }),
    /Ghost Block rejected/
  );
  assert.throws(
    () => db.saveBlock({
      id: 'block-unhashed',
      projectId: 'proj-test',
      title: 'Unhashed',
      artifactRefs: [{ path: 'src/index.js', anchorKind: 'file', hash: '' }],
    }),
    /requires a verified hash/
  );
  assert.throws(
    () => db.db.prepare('DELETE FROM artifact_refs WHERE block_id = ?').run('block-1'),
    /cannot delete the final artifactRef/
  );
  assert.throws(
    () => db.db.prepare('UPDATE blocks SET artifact_ref_count = 0 WHERE id = ?').run('block-1'),
    /Ghost Block rejected/
  );
  assert.throws(
    () => db.db.prepare(`
      INSERT INTO artifact_refs (id, block_id, path, symbol, anchor_kind, hash, role)
      VALUES ('bad-ref', 'block-1', '', NULL, 'file', '', 'implementation')
    `).run(),
    /Invalid ArtifactRef/
  );

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

test('V2Database atomically adopts legacy contextos state without merging conflicts', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-project-adoption-'));
  const db = new V2Database(':memory:');
  try {
    db.ensureProject('contextos', tempDir);
    db.savePlan({
      id: 'plan-legacy',
      projectId: 'contextos',
      title: 'Legacy plan',
      priority: 'normal',
      status: 'active',
      summary: 'Created before the workspace identity was derived.',
      phases: [{ id: 'P0', order: 0, objective: 'Adopt identity', status: 'active', taskIds: ['task-legacy'] }],
      checkpoints: [],
    });
    db.saveTask({
      id: 'task-legacy',
      planId: 'plan-legacy',
      phaseId: 'P0',
      title: 'Legacy task',
      status: 'draft',
    });
    db.ensureProject('renamed-project', tempDir);

    const adopted = db.adoptLegacyProject('renamed-project', { repoRoot: tempDir });
    assert.equal(adopted.adopted, true);
    assert.equal(adopted.sourceCounts.plans, 1);
    assert.equal(db.getProject('contextos'), null);
    assert.equal(db.listPlans('renamed-project').length, 1);
    assert.equal(db.listTasks('plan-legacy')[0].id, 'task-legacy');
    assert.equal(db.isGraphDirty('renamed-project'), true);

    const repeated = db.adoptLegacyProject('renamed-project', { repoRoot: tempDir });
    assert.equal(repeated.adopted, false);
    assert.equal(db.listPlans('renamed-project').length, 1);

    db.ensureProject('contextos', tempDir);
    db.savePlan({
      id: 'plan-conflict-old',
      projectId: 'contextos',
      title: 'Old conflict',
      priority: 'normal',
      status: 'active',
      summary: '',
      phases: [],
      checkpoints: [],
    });
    assert.throws(
      () => db.adoptLegacyProject('renamed-project', { repoRoot: tempDir }),
      /both contain plans or graph state/
    );
    assert.ok(db.getPlan('plan-legacy'));
    assert.ok(db.getPlan('plan-conflict-old'));
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('SyncEngine rolls the database back when graph.json is reverted on disk', () => {
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
  // User runs `git checkout <commit-v1> -- .contextos/graph.json`, which
  // rewrites the file with a fresh mtime. Reverting the code must revert the OS.
  fs.writeFileSync(jsonPath, savedJsonV1, 'utf8');

  const reconcileResult = sync.reconcileExternalChange('proj-git', tempDir);
  assert.equal(reconcileResult.changed, true);
  assert.equal(reconcileResult.rolledBack, true);
  assert.equal(reconcileResult.revision, 1);

  // SQLite followed the revert: only the V1 block survives.
  const revertedBlocks = db.listBlocks('proj-git');
  assert.equal(revertedBlocks.length, 1);
  assert.ok(db.getBlock('block-base'));
  assert.equal(db.getBlock('block-v2'), null);
  assert.equal(db.getBlock('block-v3'), null);
  assert.equal(db.getProject('proj-git').graph_revision, 1);

  // 3b. Once the OS exports again, the file matches and reconcile is a no-op.
  db.saveBlock({
    id: 'block-v4',
    projectId: 'proj-git',
    title: 'Later Block',
    artifactRefs: [{ path: 'src/later.js', hash: 'h3' }],
  });
  const export4 = sync.exportGraphToJson('proj-git', tempDir);
  assert.equal(export4.graphRevision, 2);
  const stableResult = sync.reconcileExternalChange('proj-git', tempDir);
  assert.equal(stableResult.changed, false);
  assert.equal(stableResult.conflict, undefined);
  assert.equal(db.listBlocks('proj-git').length, 2);

  // 4. Invalid JSON simulation: Must NOT corrupt SQLite
  fs.writeFileSync(jsonPath, 'BROKEN JSON CONTENT {{{{', 'utf8');
  assert.throws(
    () => sync.reconcileExternalChange('proj-git', tempDir),
    /Invalid JSON syntax/
  );
  // SQLite must still have the valid state
  assert.equal(db.listBlocks('proj-git').length, 2);

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

test('replaceProjectState atomically replaces the complete local graph', () => {
  const db = new V2Database(':memory:');
  db.ensureProject('proj-replace', '/tmp/repo');
  db.savePlan({ id: 'old-plan', projectId: 'proj-replace', title: 'Old Plan' });
  db.saveBlock({ id: 'old-block', projectId: 'proj-replace', title: 'Old Block', artifactRefs: [{ path: 'src/old.js', hash: 'old-hash' }] });

  db.replaceProjectState('proj-replace', {
    project: { graphRevision: 9 },
    plans: [{ id: 'new-plan', title: 'New Plan', status: 'active' }],
    phases: [{ id: 'P0', planId: 'new-plan', order: 0, status: 'active', taskIds: ['new-task'] }],
    checkpoints: [{ id: 'new-cp', targetId: 'new-plan', title: 'New Checkpoint', status: 'passed' }],
    tasks: [{ id: 'new-task', planId: 'new-plan', phaseId: 'P0', title: 'New Task', status: 'completed' }],
    blocks: [{ id: 'new-block', title: 'New Block', artifactRefs: [{ path: 'src/new.js', hash: 'new-hash' }] }],
    chains: [{ id: 'new-chain', title: 'New Chain', memberIds: ['new-block'] }],
    links: [{ id: 'new-link', sourceId: 'new-block', targetId: 'new-block', kind: 'depends_on' }],
  });

  assert.equal(db.getPlan('old-plan'), null);
  assert.equal(db.getBlock('old-block'), null);
  assert.equal(db.getPlan('new-plan').phases[0].taskIds[0], 'new-task');
  assert.equal(db.getPlan('new-plan').checkpoints[0].id, 'new-cp');
  assert.equal(db.listTasks('new-plan')[0].id, 'new-task');
  assert.equal(db.listBlocks('proj-replace')[0].artifactRefs[0].path, 'src/new.js');
  assert.equal(db.listChains('proj-replace')[0].memberIds[0], 'new-block');
  assert.equal(db.listLinks('proj-replace')[0].from, 'new-block');
  assert.equal(db.getProject('proj-replace').graph_revision, 9);

  assert.throws(() => db.replaceProjectState('proj-replace', {
    plans: [{ id: 'bad-plan', title: 'Bad Plan' }],
    phases: [{ id: null, planId: 'bad-plan' }],
  }));
  assert.equal(db.getPlan('new-plan').title, 'New Plan');
  assert.equal(db.getBlock('new-block').title, 'New Block');
  db.close();
});

test('graph writes mark the project dirty so the boundary publishes once', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-storage-dirty-'));
  const db = new V2Database(path.join(tempDir, '.contextos', 'state.sqlite'));
  db.ensureProject('proj-sync', tempDir);
  const sync = new SyncEngine(db);

  assert.equal(db.isGraphDirty('proj-sync'), false, 'a fresh project is clean');

  // A plain database write, with no export call anywhere near it, still marks
  // the project dirty: the triggers own that, not the call site.
  db.saveBlock({
    id: 'block-a',
    projectId: 'proj-sync',
    title: 'Block A',
    artifactRefs: [{ path: 'src/a.js', hash: 'h0' }],
  });
  assert.equal(db.isGraphDirty('proj-sync'), true);

  const first = sync.publishIfDirty('proj-sync', tempDir);
  assert.equal(first.graphRevision, 1);
  assert.equal(db.isGraphDirty('proj-sync'), false, 'publishing clears the dirty flag');

  const second = sync.publishIfDirty('proj-sync', tempDir);
  assert.equal(second.changed, false);
  assert.equal(second.reason, 'clean');
  assert.equal(db.getProject('proj-sync').graph_revision, 1, 'a clean publish must not bump the revision');

  // Chains and links are captured too.
  db.saveChain({ id: 'chain-a', projectId: 'proj-sync', title: 'Chain A', memberIds: ['block-a'] });
  assert.equal(db.isGraphDirty('proj-sync'), true);
  const third = sync.publishIfDirty('proj-sync', tempDir);
  assert.equal(third.graphRevision, 2);

  const graph = JSON.parse(fs.readFileSync(path.join(tempDir, '.contextos', 'graph.json'), 'utf8'));
  assert.equal(graph.data.blocks.length, 1);
  assert.equal(graph.data.chains.length, 1);

  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('reopening a stable database does not mark the graph dirty', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-storage-reopen-'));
  const dbPath = path.join(tempDir, '.contextos', 'state.sqlite');
  const first = new V2Database(dbPath);
  first.ensureProject('proj-reopen', tempDir);
  first.saveBlock({
    id: 'block-reopen',
    projectId: 'proj-reopen',
    title: 'Reopen Block',
    artifactRefs: [{ path: 'src/reopen.js', hash: 'h-reopen' }],
  });
  const sync = new SyncEngine(first);
  sync.exportGraphToJson('proj-reopen', tempDir);
  assert.equal(first.isGraphDirty('proj-reopen'), false);
  first.close();

  const reopened = new V2Database(dbPath);
  assert.equal(reopened.isGraphDirty('proj-reopen'), false, 'idempotent migrations must not dirty the graph');
  reopened.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('importing an externally rewritten graph does not create a dirty export loop', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-storage-reconcile-'));
  const db = new V2Database(path.join(tempDir, '.contextos', 'state.sqlite'));
  db.ensureProject('proj-reconcile', tempDir);
  const sync = new SyncEngine(db);

  db.saveBlock({
    id: 'block-reconcile',
    projectId: 'proj-reconcile',
    title: 'Reconcile Block',
    artifactRefs: [{ path: 'src/reconcile.js', hash: 'h-reconcile' }],
  });
  const firstExport = sync.exportGraphToJson('proj-reconcile', tempDir);
  assert.equal(firstExport.graphRevision, 1);
  assert.equal(db.isGraphDirty('proj-reconcile'), false);

  const graphPath = path.join(tempDir, '.contextos', 'graph.json');
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  graph.exportedAt = new Date(Date.now() + 60_000).toISOString();
  fs.writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');

  const reconciled = sync.reconcileExternalChange('proj-reconcile', tempDir);
  assert.equal(reconciled.changed, true);
  assert.equal(reconciled.revision, 1);
  assert.equal(db.isGraphDirty('proj-reconcile'), false, 'importing the authoritative graph must not leave a dirty export');

  const stableRevision = db.getProject('proj-reconcile').graph_revision;
  const stableExportedAt = db.getProject('proj-reconcile').exported_at;
  const secondReconcile = sync.reconcileExternalChange('proj-reconcile', tempDir);
  assert.equal(secondReconcile.changed, false);
  assert.equal(db.getProject('proj-reconcile').graph_revision, stableRevision);
  assert.equal(db.getProject('proj-reconcile').exported_at, stableExportedAt);

  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
