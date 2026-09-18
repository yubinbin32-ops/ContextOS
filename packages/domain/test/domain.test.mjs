import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Plan,
  Phase,
  PlanCheckpoint,
  Task,
  Block,
  ArtifactRef,
  Chain,
  Link,
  DecisionDocument,
  Rule,
  assertBlockHasRealCode,
  assertCheckpointBelongsToPlan,
  checkTaskCoverage,
  assertPlanCanBeCompleted,
  InvariantViolationError,
} from '../src/index.mjs';

test('Plan and Checkpoints lifecycle', () => {
  const plan = new Plan({
    id: 'plan-1',
    projectId: 'proj-1',
    title: 'V2 Rebuild Plan',
    priority: 'high',
    summary: 'Rebuild ContextOS for V2',
  });

  const p0 = plan.addPhase({
    id: 'P0',
    order: 0,
    objective: 'Freeze Domain Models',
  });

  assert.equal(plan.phases.length, 1);
  assert.equal(p0.status, 'pending');
  p0.activate();
  assert.equal(p0.status, 'active');

  const cp = plan.addCheckpoint({
    id: 'cp-p0-verified',
    title: 'Domain models passed all unit tests',
    criteria: 'Zero failures in domain tests',
  });

  assert.equal(plan.checkpoints.length, 1);
  assert.equal(plan.canComplete(), false);

  assert.throws(
    () => plan.complete({ completedSummary: 'Done' }),
    /Cannot complete Plan/
  );

  cp.pass('test-receipt-001');
  assert.equal(cp.status, 'passed');
  assert.equal(plan.canComplete(), true);

  plan.complete({ completedSummary: 'P0 complete with domain models.' });
  assert.equal(plan.status, 'completed');
  assert.equal(plan.completedSummary, 'P0 complete with domain models.');
});

test('Task C-D-C-S state machine and context slice', () => {
  const task = new Task({
    id: 'task-p0-models',
    planId: 'plan-1',
    phaseId: 'P0',
    title: 'Implement domain models',
    contextSlice: {
      objective: 'Implement clean V2 entities',
      constraints: ['No ghost blocks', 'Checkpoint belongs only to plan'],
    },
  });

  assert.equal(task.status, 'draft');
  task.activate();
  assert.equal(task.status, 'active');

  task.addFileToWorkingSet('packages/domain/src/plan.mjs');
  task.addNote({ text: 'Created plan and phase classes', kind: 'journal' });
  assert.equal(task.notes.length, 1);

  // Move to checking
  task.startChecking();
  assert.equal(task.status, 'checking');

  task.addCheck({
    receiptId: 'receipt-test-1',
    description: 'Unit test runs successfully',
    passed: true,
  });

  // Move to syncing
  task.startSyncing();
  assert.equal(task.status, 'syncing');

  task.completeSync({
    createdBlockIds: ['block-domain-plan'],
    updatedBlockIds: [],
  });
  assert.equal(task.status, 'completed');
  assert.ok(task.syncResult.completedAt);
});

test('Ghost Block rejection invariant', () => {
  assert.throws(
    () =>
      new Block({
        id: 'block-ghost',
        projectId: 'proj-1',
        title: 'Ghost Block Without Code',
        artifactRefs: [],
      }),
    /Ghost Block rejected/
  );

  const validBlock = new Block({
    id: 'block-real',
    projectId: 'proj-1',
    title: 'Real Block',
    artifactRefs: [
      new ArtifactRef({
        path: 'packages/domain/src/plan.mjs',
        symbol: 'Plan',
        startLine: 1,
        endLine: 50,
        hash: 'abc1234',
      }),
    ],
  });

  assert.equal(validBlock.artifactRefs.length, 1);
  assertBlockHasRealCode(validBlock);

  assert.throws(
    () => validBlock.updateArtifactRefs([]),
    /Blocks cannot become ghosts/
  );
});

test('Task working set coverage invariant', () => {
  const task = new Task({
    id: 'task-1',
    planId: 'plan-1',
    phaseId: 'P0',
    title: 'Task 1',
    workingSet: {
      files: ['src/a.js', 'src/b.js'],
    },
  });

  const blockA = new Block({
    id: 'block-a',
    projectId: 'proj-1',
    title: 'Block A',
    artifactRefs: [
      new ArtifactRef({
        path: 'src/a.js',
        startLine: 1,
        endLine: 10,
        hash: 'hash-a',
      }),
    ],
  });

  // Only src/a.js is covered; src/b.js is missing
  const coverage1 = checkTaskCoverage(task, [blockA]);
  assert.equal(coverage1.isFullyCovered, false);
  assert.deepEqual(coverage1.uncoveredFiles, ['src/b.js']);

  const blockB = new Block({
    id: 'block-b',
    projectId: 'proj-1',
    title: 'Block B',
    artifactRefs: [
      new ArtifactRef({
        path: 'src/b.js',
        startLine: 1,
        endLine: 20,
        hash: 'hash-b',
      }),
    ],
  });

  // Now fully covered
  const coverage2 = checkTaskCoverage(task, [blockA, blockB]);
  assert.equal(coverage2.isFullyCovered, true);
  assert.equal(coverage2.uncoveredFiles.length, 0);
});

test('DecisionDocument narrative and section patching', () => {
  const initialDoc = `# Project Decisions

## [DEC-001] Adopt V2 Domain Architecture

Status: Accepted
Context: 0.4.1 legacy had confusing checkpoints and ghost blocks.
Decision: Redefine domain model.

## [DEC-002] Use Node SQLite DatabaseSync

Status: Accepted
Context: Built-in to Node 22.
`;

  const doc = new DecisionDocument(initialDoc);
  const sections = doc.listSections();
  assert.equal(sections.length, 2);
  assert.equal(sections[0].id, 'DEC-001');

  const sec1 = doc.getSection('DEC-001');
  assert.equal(sec1.title, 'Adopt V2 Domain Architecture');
  assert.ok(sec1.content.includes('Redefine domain model.'));

  // Upsert new section
  doc.upsertSection({
    id: 'DEC-003',
    title: 'Web-Tree-Sitter for AST',
    content: 'Status: Accepted\nContext: WASM tree sitter avoids native compilation.',
  });

  assert.equal(doc.listSections().length, 3);
  assert.ok(doc.toMarkdown().includes('[DEC-003] Web-Tree-Sitter'));

  // Update existing section
  doc.upsertSection({
    id: 'DEC-001',
    title: 'Adopt V2 Domain Architecture (Amended)',
    content: 'Status: Accepted\nUpdated note: Fully validated by P0 tests.',
  });

  assert.equal(doc.listSections().length, 3);
  const updatedSec1 = doc.getSection('DEC-001');
  assert.equal(updatedSec1.title, 'Adopt V2 Domain Architecture (Amended)');
});

test('Categorized Rule model', () => {
  const rule = new Rule({
    id: 'rule-api-01',
    title: 'API Versioning and Facades',
    category: 'api',
    summary: 'Keep MCP interfaces high-level and action-based.',
    content: 'Never create redundant micro-tools.',
  });

  assert.equal(rule.category, 'api');
  const summary = rule.toSummaryJSON();
  assert.equal(summary.content, undefined);
  const customCatRule = new Rule({ id: 'custom', title: 'Custom Rule', category: 'any-flexible-category' });
  assert.equal(customCatRule.category, 'any-flexible-category');
});

test('Task explicit rule binding, lifecycle, and toJSON serialization', () => {
  const task = new Task({
    id: 'task-rules-test',
    planId: 'plan-1',
    phaseId: 'P0',
    title: 'Test Rule Binding',
    rules: ['rule-surgical-code-editing'],
  });

  assert.deepEqual(task.rules, ['rule-surgical-code-editing']);
  assert.deepEqual(task.references.rules, ['rule-surgical-code-editing']);

  // Bind rule
  task.bindRule('rule-product-contract');
  assert.deepEqual(task.rules, ['rule-surgical-code-editing', 'rule-product-contract']);

  // Duplicate bind is a no-op
  task.bindRule('rule-product-contract');
  assert.equal(task.rules.length, 2);

  // Unbind rule
  task.unbindRule('rule-surgical-code-editing');
  assert.deepEqual(task.rules, ['rule-product-contract']);

  // Set rules
  task.setRules(['rule-command-sessions', 'rule-out-of-context-commands']);
  assert.deepEqual(task.rules, ['rule-command-sessions', 'rule-out-of-context-commands']);

  // Setter
  task.rules = ['rule-ui-aesthetic-precision'];
  assert.deepEqual(task.rules, ['rule-ui-aesthetic-precision']);
  assert.deepEqual(task.references.rules, ['rule-ui-aesthetic-precision']);

  // Serialization to JSON
  const json = task.toJSON();
  assert.deepEqual(json.rules, ['rule-ui-aesthetic-precision']);
  assert.deepEqual(json.references.rules, ['rule-ui-aesthetic-precision']);
});
