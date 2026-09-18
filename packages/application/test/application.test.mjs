import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { V2Database, SyncEngine } from '../../../packages/storage/src/index.mjs';
import { PlanService, TaskService, KnowledgeService } from '../src/index.mjs';

test('PlanService manages plan lifecycle and checkpoints', () => {
  const db = new V2Database(':memory:');
  db.ensureProject('proj-app-test', '/tmp/repo');
  const planService = new PlanService(db);

  const plan = planService.createPlan({
    id: 'plan-app-1',
    projectId: 'proj-app-test',
    title: 'App Test Plan',
    phases: [{ id: 'P0', order: 0, status: 'active' }],
    checkpoints: [{ id: 'cp-app-1', title: 'Verify P0 Checkpoint', status: 'pending' }],
  });

  assert.equal(plan.title, 'App Test Plan');

  // Checkpoint cannot complete while pending
  assert.throws(
    () => planService.completePlan('plan-app-1', { completedSummary: 'All done' }),
    /Cannot complete Plan/
  );

  // Pass checkpoint
  planService.checkCheckpoint('plan-app-1', 'cp-app-1', {
    passed: true,
    evidenceRef: 'receipt-123',
  });

  // Now plan completes successfully
  const completed = planService.completePlan('plan-app-1', {
    completedSummary: 'P0 completed cleanly.',
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.completedSummary, 'P0 completed cleanly.');

  db.close();
});

test('TaskService enforces C-D-C-S flow and coverage gate', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-app-test-'));
  const db = new V2Database(path.join(tempDir, '.contextos', 'state.sqlite'));
  db.ensureProject('proj-app-task', tempDir);
  const syncEngine = new SyncEngine(db);
  const planService = new PlanService(db);
  const taskService = new TaskService(db, syncEngine);

  planService.createPlan({
    id: 'plan-app-1',
    projectId: 'proj-app-task',
    title: 'Parent Plan',
    phases: [{ id: 'P0', order: 0, status: 'active' }],
  });

  const task = taskService.createTask({
    id: 'task-app-1',
    planId: 'plan-app-1',
    phaseId: 'P0',
    title: 'Implement feature X',
    workingSet: {
      files: ['src/feature.js'],
    },
  });

  assert.equal(task.status, 'draft');
  taskService.activateTask('task-app-1');
  taskService.addNote('task-app-1', { text: 'Started coding feature X' });
  taskService.addCheck('task-app-1', { description: 'Unit tests passing', passed: true });
  taskService.startChecking('task-app-1');

  // 1. Attempt sync WITHOUT covering src/feature.js in blocks: MUST FAIL!
  assert.throws(
    () =>
      taskService.syncTask('task-app-1', {
        blocks: [
          {
            id: 'block-other',
            projectId: 'proj-app-task',
            title: 'Other Block',
            artifactRefs: [{ path: 'src/other.js', hash: 'h1' }],
          },
        ],
        projectRoot: tempDir,
        projectId: 'proj-app-task',
      }),
    /Task sync failed: Working set code has no Block coverage/
  );

  // Resume task after coverage gap was identified, fix coverage and re-check
  taskService.resumeTask('task-app-1');
  taskService.startChecking('task-app-1');

  // 2. Now sync WITH covering src/feature.js: MUST SUCCEED!
  const syncResult = taskService.syncTask('task-app-1', {
    blocks: [
      {
        id: 'block-feature-x',
        projectId: 'proj-app-task',
        title: 'Feature X Block',
        summary: 'Feature X implementation',
        artifactRefs: [{ path: 'src/feature.js', symbol: 'featureX', hash: 'h2' }],
      },
    ],
    projectRoot: tempDir,
    projectId: 'proj-app-task',
  });

  assert.equal(syncResult.task.status, 'completed');
  assert.ok(syncResult.graphRevision > 0);

  // Verify graph.json was written
  const jsonFile = path.join(tempDir, '.contextos', 'graph.json');
  assert.ok(fs.existsSync(jsonFile));

  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('KnowledgeService manages single Decision and categorized Rules', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-know-test-'));

  // 1. Single Decision narrative
  KnowledgeService.patchDecisionSection(tempDir, {
    id: 'DEC-001',
    title: 'Storage Strategy',
    content: 'Status: Accepted\nContext: WAL mode SQLite + Git graph.json',
  });

  const { document } = KnowledgeService.getDecision(tempDir);
  const sec = document.getSection('DEC-001');
  assert.equal(sec.title, 'Storage Strategy');
  assert.ok(sec.content.includes('WAL mode SQLite'));

  // 2. Categorized Rule
  KnowledgeService.saveRule(tempDir, {
    id: 'api-guidelines',
    title: 'API Guidelines',
    category: 'api',
    summary: 'Consolidate to 9 facades',
    content: 'Do not create separate micro-tools.',
  });

  const rules = KnowledgeService.listRules(tempDir);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, 'api-guidelines');
  assert.equal(rules[0].category, 'api');

  const fullRule = KnowledgeService.getRule(tempDir, 'api-guidelines');
  assert.equal(fullRule.title, 'API Guidelines');
  assert.ok(fullRule.content.includes('Do not create separate micro-tools.'));

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('TaskService detects host native modifications via mtime + SHA256 comparison and reconciles workingSet and AST outlines', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-host-mod-test-'));
  const db = new V2Database(path.join(tempDir, '.contextos', 'state.sqlite'));
  db.ensureProject('proj-host-mod', tempDir);
  const syncEngine = new SyncEngine(db);
  const planService = new PlanService(db);
  const taskService = new TaskService(db, syncEngine);

  // 1. Create source file on disk
  const srcDir = path.join(tempDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  const serviceFile = path.join(srcDir, 'service.js');
  const initialContent = 'export class MyService {\n  compute() {\n    return 1;\n  }\n}\n';
  fs.writeFileSync(serviceFile, initialContent, 'utf8');

  // 2. Create Block covering src/service.js
  const initialHash = crypto.createHash('sha256').update(initialContent, 'utf8').digest('hex').slice(0, 16);
  db.saveBlock({
    id: 'block-service',
    projectId: 'proj-host-mod',
    title: 'Service Block',
    summary: 'Core service implementation',
    artifactRefs: [
      {
        path: 'src/service.js',
        symbol: 'MyService',
        hash: initialHash,
      },
    ],
  });

  planService.createPlan({
    id: 'plan-host-1',
    projectId: 'proj-host-mod',
    title: 'Host Modification Plan',
    phases: [{ id: 'P0', order: 0, status: 'active' }],
  });

  // 3. Create and activate Task
  const task = taskService.createTask(
    {
      id: 'task-host-1',
      planId: 'plan-host-1',
      phaseId: 'P0',
      title: 'Work on Service',
      workingSet: {
        files: ['src/service.js'],
      },
    },
    tempDir
  );

  taskService.activateTask('task-host-1', tempDir);
  const activeTask = taskService.getTask('task-host-1');
  assert.ok(activeTask.baseline.fileSnapshots['src/service.js']);
  assert.equal(activeTask.baseline.fileSnapshots['src/service.js'].hash, initialHash);

  // 4. Simulate Host Native Modification: external IDE directly edits file on disk
  await new Promise((r) => setTimeout(r, 50)); // Ensure mtime differs
  const modifiedContent = 'export class MyService {\n  compute() {\n    return 42;\n  }\n  extra() {\n    return 100;\n  }\n}\n';
  fs.writeFileSync(serviceFile, modifiedContent, 'utf8');

  // 5. Trigger reconciliation (e.g. taskService.reconcileTask or syncTask)
  const reconciled = taskService.reconcileTask('task-host-1', tempDir, 'proj-host-mod');

  // Verify file remained/reconciled in workingSet
  assert.ok(reconciled.workingSet.files.includes('src/service.js'));
  const newHash = crypto.createHash('sha256').update(modifiedContent, 'utf8').digest('hex').slice(0, 16);
  assert.equal(reconciled.baseline.fileSnapshots['src/service.js'].hash, newHash);
  assert.equal(reconciled.baseline.fileSnapshots['src/service.js'].modifiedLocally, true);

  // Verify task note was added
  assert.ok(reconciled.notes.some((n) => n.text.includes('[Host Native Modification]')));

  // Verify AST outline and locators were refreshed seamlessly
  assert.ok(reconciled.contextSlice.locators.some((l) => l.symbol === 'MyService.extra'));

  // Verify Block artifactRef hash was updated in DB
  const updatedBlock = db.getBlock('block-service');
  assert.equal(updatedBlock.artifactRefs[0].hash, newHash);

  // 6. Verify mtime-only change (touch without content change) does NOT trigger false modification
  const currentSnapshotHash = reconciled.baseline.fileSnapshots['src/service.js'].hash;
  const now = new Date(Date.now() + 5000);
  fs.utimesSync(serviceFile, now, now);
  const rechecked = taskService.reconcileTask('task-host-1', tempDir, 'proj-host-mod');
  assert.equal(rechecked.baseline.fileSnapshots['src/service.js'].hash, currentSnapshotHash);

  // 7. Complete Task with checks and sync
  taskService.addCheck('task-host-1', { description: 'Host modification verified', passed: true });
  taskService.startChecking('task-host-1');
  const synced = taskService.syncTask('task-host-1', {
    blocks: [updatedBlock],
    projectRoot: tempDir,
    projectId: 'proj-host-mod',
  });
  assert.equal(synced.task.status, 'completed');

  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('TaskService handles external file deletion and non-git project modifications', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-ext-mod-'));
  const db = new V2Database(path.join(tempDir, '.contextos', 'state.sqlite'));
  db.ensureProject('proj-ext-mod', tempDir);
  const syncEngine = new SyncEngine(db);
  const planService = new PlanService(db);
  const taskService = new TaskService(db, syncEngine);

  // 1. Create file in src/
  const srcDir = path.join(tempDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  const file1 = path.join(srcDir, 'file1.js');
  fs.writeFileSync(file1, 'export function foo() { return 1; }\n', 'utf8');

  planService.createPlan({
    id: 'plan-ext-1',
    projectId: 'proj-ext-mod',
    title: 'Ext Plan',
    phases: [{ id: 'P0', order: 0, status: 'active' }],
  });

  const task = taskService.createTask(
    {
      id: 'task-ext-1',
      planId: 'plan-ext-1',
      phaseId: 'P0',
      title: 'Ext Task',
      workingSet: { files: ['src/file1.js'] },
    },
    tempDir
  );

  taskService.activateTask('task-ext-1', tempDir);
  assert.ok(taskService.getTask('task-ext-1').baseline.fileSnapshots['src/file1.js']);

  // 2. Simulate external file deletion
  fs.unlinkSync(file1);
  const afterDelete = taskService.reconcileTask('task-ext-1', tempDir, 'proj-ext-mod');
  assert.equal(afterDelete.baseline.fileSnapshots['src/file1.js'], undefined);
  assert.ok(afterDelete.notes.some((n) => n.text.includes('Detected external deletion')));

  // 3. Simulate creating a new source file in a non-git project directory
  const file2 = path.join(srcDir, 'handler.py');
  fs.writeFileSync(file2, 'def handle():\n    return True\n', 'utf8');

  const afterNewFile = taskService.reconcileTask('task-ext-1', tempDir, 'proj-ext-mod');
  assert.ok(afterNewFile.workingSet.files.includes('src/handler.py'));
  assert.ok(afterNewFile.baseline.fileSnapshots['src/handler.py']);
  assert.equal(afterNewFile.baseline.fileSnapshots['src/handler.py'].modifiedLocally, true);
  assert.ok(afterNewFile.contextSlice.locators.some((l) => l.symbol === 'handle'));

  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('TaskService manages explicit rule bindings and task updates', () => {
  const db = new V2Database(':memory:');
  db.ensureProject('proj-rule-test', '/tmp');
  const syncEngine = new SyncEngine(db);
  const planService = new PlanService(db);
  const taskService = new TaskService(db, syncEngine);

  planService.createPlan({
    id: 'plan-rule-test',
    projectId: 'proj-rule-test',
    title: 'Rule Test Plan',
    phases: [{ id: 'P0', order: 0, status: 'active' }],
  });

  const task = taskService.createTask({
    id: 'task-app-rule',
    planId: 'plan-rule-test',
    phaseId: 'P0',
    projectId: 'proj-rule-test',
    title: 'Rule Test Task',
    rules: ['rule-surgical-code-editing'],
  });

  assert.deepEqual(task.rules, ['rule-surgical-code-editing']);

  // Bind rule
  const bound = taskService.bindRule('task-app-rule', 'rule-product-contract');
  assert.deepEqual(bound.rules, ['rule-surgical-code-editing', 'rule-product-contract']);
  // Verify persistence in DB
  const retrieved1 = taskService.getTask('task-app-rule');
  assert.deepEqual(retrieved1.rules, ['rule-surgical-code-editing', 'rule-product-contract']);

  // Unbind rule
  const unbound = taskService.unbindRule('task-app-rule', 'rule-surgical-code-editing');
  assert.deepEqual(unbound.rules, ['rule-product-contract']);
  const retrieved2 = taskService.getTask('task-app-rule');
  assert.deepEqual(retrieved2.rules, ['rule-product-contract']);

  // Update task
  const updated = taskService.updateTask('task-app-rule', {
    title: 'Updated Rule Test Task',
    rules: ['rule-ui-aesthetic-precision', 'rule-command-sessions'],
  });
  assert.equal(updated.title, 'Updated Rule Test Task');
  assert.deepEqual(updated.rules, ['rule-ui-aesthetic-precision', 'rule-command-sessions']);

  // Update task using references.rules object
  const updatedViaRefs = taskService.updateTask('task-app-rule', {
    references: { rules: ['rule-cdcs-workflow'] },
  });
  assert.deepEqual(updatedViaRefs.rules, ['rule-cdcs-workflow']);
  assert.deepEqual(updatedViaRefs.references.rules, ['rule-cdcs-workflow']);

  db.close();
});

test('PlanService instantiates and persists embedded tasks with rules in createPlan', () => {
  const db = new V2Database(':memory:');
  db.ensureProject('proj-plan-tasks', '/tmp');
  const planService = new PlanService(db);

  const plan = planService.createPlan({
    id: 'plan-with-tasks',
    projectId: 'proj-plan-tasks',
    title: 'Plan with embedded tasks',
    phases: [
      {
        id: 'phase-p0',
        name: 'Phase 0 - Foundation',
        order: 0,
        tasks: [
          {
            id: 'task-auto-1',
            title: 'Setup Domain Entities',
            rules: ['rule-product-contract', 'rule-surgical-code-editing'],
          },
          {
            id: 'task-auto-2',
            title: 'Setup Service Layer',
            rules: ['rule-out-of-context-commands'],
          },
          'task-auto-string-id',
        ],
      },
    ],
  });

  assert.equal(plan.phases.length, 1);
  assert.deepEqual(plan.phases[0].taskIds, ['task-auto-1', 'task-auto-2', 'task-auto-string-id']);

  // Verify tasks were persisted to DB with bound rules
  const t1 = db.getTask('task-auto-1');
  assert.ok(t1);
  assert.equal(t1.title, 'Setup Domain Entities');
  assert.deepEqual(t1.rules, ['rule-product-contract', 'rule-surgical-code-editing']);

  const t2 = db.getTask('task-auto-2');
  assert.ok(t2);
  assert.equal(t2.title, 'Setup Service Layer');
  assert.deepEqual(t2.rules, ['rule-out-of-context-commands']);

  const t3 = db.getTask('task-auto-string-id');
  assert.ok(t3);
  assert.equal(t3.id, 'task-auto-string-id');

  db.close();
});



