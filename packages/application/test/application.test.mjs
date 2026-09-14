import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
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
