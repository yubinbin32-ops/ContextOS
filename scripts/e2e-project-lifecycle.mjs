/**
 * Self-contained manual C-D-C-S lifecycle verification.
 * It uses a temporary project and never mutates the host repository.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContextOSV2Service } from '../packages/mcp/src/v2-service.mjs';

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-e2e-lifecycle-'));
const projectId = 'e2e-lifecycle';
fs.mkdirSync(path.join(projectRoot, '.contextos'), { recursive: true });
fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
fs.mkdirSync(path.join(projectRoot, 'test'), { recursive: true });
fs.writeFileSync(
  path.join(projectRoot, '.contextos/project.json'),
  JSON.stringify({ id: projectId, storage: 'local' }, null, 2) + '\n',
  'utf8'
);
fs.writeFileSync(
  path.join(projectRoot, 'src/calc.mjs'),
  'export function add(a, b) {\n  return a + b;\n}\n',
  'utf8'
);
fs.writeFileSync(
  path.join(projectRoot, 'test/calc.test.mjs'),
  [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from '../src/calc.mjs';",
    '',
    "test('adds numbers', () => { assert.equal(add(2, 3), 5); });",
    '',
  ].join('\n'),
  'utf8'
);

const service = new ContextOSV2Service({ projectRoot, projectId });

try {
  console.log('>>> [1] Bootstrap');
  const brief = await service.osContext({ action: 'brief' });
  assert.match(brief, /ContextOS Project Brief/);

  console.log('>>> [2] Create Plan, Task and Blocks');
  await service.plan({
    action: 'create',
    planData: {
      id: 'plan-e2e',
      title: 'E2E Lifecycle',
      phases: [{
        id: 'P0',
        order: 0,
        objective: 'Verify the complete project lifecycle.',
        acceptance: ['Plan and task reach a verified terminal state.'],
        status: 'active',
      }],
      checkpoints: [{ id: 'cp-e2e', title: 'Lifecycle verified', status: 'pending' }],
    },
  });
  const task = await service.task({
    action: 'create',
    taskData: {
      id: 'task-e2e',
      planId: 'plan-e2e',
      phaseId: 'P0',
      title: 'Implement and verify add()',
      workingSet: { files: ['src/calc.mjs', 'test/calc.test.mjs'] },
    },
    format: 'json',
  });
  await service.task({ action: 'develop', id: task.id });
  await service.block({
    action: 'bind_auto',
    id: 'block-calc',
    paths: ['src/calc.mjs', 'test/calc.test.mjs'],
  });

  console.log('>>> [3] Surgical Read and Edit');
  const outline = await service.code({ action: 'outline', path: 'src/calc.mjs' });
  assert.match(outline, /add/);
  const edit = await service.code({
    action: 'edit',
    path: 'src/calc.mjs',
    targetContent: 'return a + b;',
    replacementContent: 'return a + b; // verified',
  });
  assert.ok(edit.newHash);

  console.log('>>> [4] Check with Receipt');
  const receipt = await service.runCommand({
    command: 'node --test test/calc.test.mjs',
  });
  assert.equal(receipt.exitCode, 0);
  await service.task({
    action: 'check',
    id: task.id,
    checkData: {
      receiptId: receipt.id,
      description: 'Node test passed',
      passed: true,
    },
  });

  console.log('>>> [5] Sync and Complete Plan');
  service.taskService.startChecking(task.id);
  const blocks = service.db.listBlocks(projectId);
  const sync = await service.task({
    action: 'sync',
    id: task.id,
    syncData: { blocks },
    format: 'json',
  });
  assert.equal(sync.task.status, 'completed');
  await service.plan({
    action: 'check',
    id: 'plan-e2e',
    checkpointId: 'cp-e2e',
    passed: true,
    evidenceRef: receipt.id,
  });
  const completed = await service.plan({
    action: 'complete',
    id: 'plan-e2e',
    planData: { completedSummary: 'Manual lifecycle verification passed.' },
    format: 'json',
  });
  assert.equal(completed.status, 'completed');

  const graph = JSON.parse(
    fs.readFileSync(path.join(projectRoot, '.contextos/graph.json'), 'utf8')
  );
  assert.equal(graph.data.plans.find((plan) => plan.id === 'plan-e2e').status, 'completed');
  assert.equal(graph.data.tasks.find((item) => item.id === task.id).status, 'completed');

  console.log('Manual E2E lifecycle flow passed.');
  console.log(`- receipt: ${receipt.id}`);
  console.log(`- graph revision: ${graph.graphRevision}`);
} finally {
  service.close({ stopProcesses: false });
  fs.rmSync(projectRoot, { recursive: true, force: true });
}
