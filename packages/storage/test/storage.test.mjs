import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { V2Database, SyncEngine } from '../src/index.mjs';

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

test('SyncEngine export, external Git revert simulation, and atomic rollback', () => {
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

  // Reconcile external change
  const reconcileResult = sync.reconcileExternalChange('proj-git', tempDir);
  assert.equal(reconcileResult.changed, true);
  assert.equal(reconcileResult.revision, 1); // Exact rollback to revision 1!

  // Check that SQLite state was rolled back to Revision 1
  const currentBlocks = db.listBlocks('proj-git');
  assert.equal(currentBlocks.length, 1);
  assert.equal(currentBlocks[0].id, 'block-base');
  assert.equal(db.getBlock('block-v2'), null);
  assert.equal(db.getBlock('block-v3'), null);

  // 4. Invalid JSON simulation: Must NOT corrupt SQLite
  fs.writeFileSync(jsonPath, 'BROKEN JSON CONTENT {{{{', 'utf8');
  assert.throws(
    () => sync.reconcileExternalChange('proj-git', tempDir),
    /Invalid JSON syntax/
  );
  // SQLite must still have the valid state
  assert.equal(db.listBlocks('proj-git').length, 1);

  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
