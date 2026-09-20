#!/usr/bin/env node
/**
 * Manual, from-zero ContextOS workflow verification.
 *
 * This intentionally uses the published MCP stdio surface instead of calling
 * the service classes directly, so tool schemas, project routing, receipts,
 * graph exports, and lifecycle gates are exercised together.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = process.cwd();
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-zero-project-'));
const projectId = 'manual-zero-project';
const serverPath = path.join(repoRoot, 'plugins/contextos/server/contextos-mcp.mjs');
const isolatedHome = path.join(projectRoot, '.home');
fs.mkdirSync(isolatedHome, { recursive: true });

const client = new Client({ name: 'contextos-zero-project-verifier', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: 'node',
  args: ['--no-warnings=ExperimentalWarning', serverPath],
  cwd: repoRoot,
  env: { ...process.env, CONTEXTOS_PROJECT_ROOT: projectRoot, HOME: isolatedHome },
});

let processId = null;
let stepNumber = 0;

function short(text, max = 220) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine;
}

function step(label) {
  stepNumber += 1;
  console.log(`[${String(stepNumber).padStart(2, '0')}] ${label}`);
}

async function call(name, args = {}) {
  const response = await client.callTool({
    name,
    arguments: { ...args, projectRoot: args.projectRoot || projectRoot },
  });
  const text = (response.content || [])
    .map((item) => item.type === 'text' ? item.text : JSON.stringify(item))
    .join('\n');
  if (response.isError) {
    const error = new Error(`${name} failed: ${text}`);
    error.toolResult = response;
    throw error;
  }
  return text;
}

async function callJson(name, args = {}) {
  const text = await call(name, args);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${name} did not return JSON: ${text}`);
  }
}

async function expectFailure(name, args, expectedText) {
  try {
    await call(name, args);
  } catch (error) {
    assert.match(error.message, expectedText);
    return error.message;
  }
  throw new Error(`${name} unexpectedly succeeded; expected failure containing ${expectedText}`);
}

const source = [
  'export function greet(name) {',
  '  return "Hello, " + name + "!";',
  '}',
  '',
].join('\n');

const tests = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { greet } from '../src/greeter.mjs';",
  '',
  "test('greets a person', () => {",
  "  assert.equal(greet('Ada'), 'Hello, Ada!');",
  '});',
  '',
].join('\n');

const probe = [
  'export function double(value) {',
  '  return value * 2;',
  '}',
  '',
].join('\n');

try {
  await client.connect(transport);

  step('Initialize a brand-new local project');
  const initText = await call('contextos_init', {
    mode: 'local',
    projectId,
  });
  assert.match(initText, /Initialized ContextOS/i);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(projectRoot, '.contextos/project.json'), 'utf8')).storage,
    'local'
  );

  step('Run doctor before any graph exists');
  const doctor = await call('contextos_doctor', {});
  assert.match(doctor, /Active Storage Mode/);
  assert.match(doctor, /local/);

  step('Read the initial resumption brief');
  const initialBrief = await call('os_context', { action: 'brief' });
  assert.match(initialBrief, /ContextOS Project Brief/);
  assert.match(initialBrief, /Create a Plan or start a lightweight Task/);

  step('Write project rules and a decision section');
  await call('knowledge', {
    action: 'rule_write',
    ruleData: {
      id: 'rule-zero-workflow',
      title: 'Zero Project Workflow',
      category: 'workflow',
      priority: 'high',
      summary: 'The zero-project verification must use the C-D-C-S lifecycle.',
      content: 'Use a Plan, a Task, real Receipts, Block coverage, and Sync.',
    },
  });
  await call('knowledge', {
    action: 'rule_write',
    ruleData: {
      id: 'rule-zero-tests',
      title: 'Zero Project Tests',
      category: 'testing',
      priority: 'high',
      summary: 'Every implementation task must have an executable check.',
      content: 'Run the focused test command and record its Receipt.',
    },
  });
  const ruleList = await callJson('knowledge', { action: 'rule_list', format: 'json' });
  assert.equal(ruleList.length, 2);
  const rule = await callJson('knowledge', { action: 'rule_open', ruleId: 'rule-zero-workflow', format: 'json' });
  assert.equal(rule.id, 'rule-zero-workflow');
  await call('knowledge', {
    action: 'decision_write',
    sectionId: 'DEC-001',
    sectionTitle: 'Use a zero-project verification harness',
    content: '### Context\nA clean project catches routing and lifecycle assumptions that unit tests miss.\n\n### Decision\nExercise the MCP surface from initialization through plan completion.',
  });
  const decision = await call('knowledge', { action: 'decision_open', sectionId: 'DEC-001' });
  assert.match(decision, /zero-project verification harness/);

  step('Create the development document and source files through code.create');
  await callJson('code', {
    action: 'create',
    path: 'docs/development.md',
    content: '# Greeting Service\n\nThe service exposes a pure greet function and is verified with node:test.\n',
    format: 'json',
  });
  const sourceCreate = await callJson('code', {
    action: 'create',
    path: 'src/greeter.mjs',
    content: source,
    format: 'json',
  });
  assert.equal(sourceCreate.filePath, 'src/greeter.mjs');
  await callJson('code', {
    action: 'create',
    path: 'test/greeter.test.mjs',
    content: tests,
    format: 'json',
  });
  await callJson('code', {
    action: 'create',
    path: 'scratch/probe.mjs',
    content: probe,
    format: 'json',
  });
  await callJson('code', {
    action: 'create',
    path: 'vendor/index.mjs',
    content: 'export const vendorVersion = "1.0.0";\n',
    format: 'json',
  });
  await callJson('code', {
    action: 'create',
    path: 'vendor/package-lock.json',
    content: '{\n  "name": "vendor",\n  "lockfileVersion": 3\n}\n',
    format: 'json',
  });
  await callJson('code', {
    action: 'create',
    path: 'config/app.json',
    content: '{\n  "service": "greeter"\n}\n',
    format: 'json',
  });
  await callJson('code', {
    action: 'create',
    path: 'tmp/obsolete.mjs',
    content: 'export const obsolete = true;\n',
    format: 'json',
  });

  step('Create a plan, a temporary plan, and two lifecycle tasks');
  const plan = await callJson('plan', {
    action: 'create',
    planData: {
      id: 'plan-zero',
      title: 'Zero Project Delivery',
      summary: 'Deliver and verify the greeting service.',
      phases: [
        {
          id: 'phase-build',
          name: 'Build and verify',
          order: 0,
          status: 'active',
        },
      ],
      checkpoints: [
        {
          id: 'cp-zero-release',
          title: 'Zero project verified',
          status: 'pending',
        },
      ],
    },
    format: 'json',
  });
  assert.equal(plan.id, 'plan-zero');
  const temporaryPlan = await callJson('plan', {
    action: 'create',
    planData: { id: 'plan-temporary', title: 'Temporary plan' },
    format: 'json',
  });
  assert.equal(temporaryPlan.id, 'plan-temporary');
  await call('plan', { action: 'delete', id: 'plan-temporary' });
  assert.equal((await callJson('plan', { action: 'list', format: 'json' })).length, 1);

  const mainTask = await callJson('task', {
    action: 'create',
    taskData: {
      id: 'task-main',
      planId: 'plan-zero',
      phaseId: 'phase-build',
      title: 'Implement greeting service',
      workingSet: {
        files: [
          'docs/development.md',
          'src/greeter.mjs',
          'test/greeter.test.mjs',
          'scratch/probe.mjs',
          'vendor/index.mjs',
          'config/app.json',
        ],
      },
      rules: ['rule-zero-workflow'],
    },
    format: 'json',
  });
  assert.equal(mainTask.id, 'task-main');

  const activateStart = await callJson('task', {
    action: 'start',
    taskData: {
      id: 'task-activate',
      planId: 'plan-zero',
      phaseId: 'phase-build',
      title: 'Exercise activate lifecycle',
      // Deliberately use the array form documented by the Skill.
      workingSet: ['docs/development.md'],
      rules: ['rule-zero-workflow'],
    },
    format: 'json',
  });
  const activateTask = activateStart.task;
  assert.equal(activateTask.id, 'task-activate');
  assert.equal(activateTask.status, 'active');
  assert.equal(activateStart.autoPlanId, null);
  const activateOpened = await callJson('task', {
    action: 'open',
    id: 'task-activate',
    format: 'json',
  });
  assert.deepEqual(activateOpened.workingSet.files, ['docs/development.md']);

  step('Bind the documentation block and exercise block actions');
  const docsBlock = await callJson('block', {
    action: 'bind_auto',
    id: 'block-docs',
    path: 'docs/development.md',
    format: 'json',
  });
  assert.equal(docsBlock.addedRefs[0].anchorKind, 'file');
  await call('block', {
    action: 'bind',
    id: 'block-docs',
    blockData: { summary: 'Development document for the zero project.' },
  });
  const tempBlock = await callJson('block', {
    action: 'bind_auto',
    id: 'block-temp',
    path: 'tmp/obsolete.mjs',
    format: 'json',
  });
  assert.equal(tempBlock.block.id, 'block-temp');
  await call('block', { action: 'delete', id: 'block-temp' });
  const blockListAfterDelete = await callJson('block', { action: 'list', format: 'json' });
  assert.ok(!blockListAfterDelete.some((block) => block.id === 'block-temp'));
  const blockSearch = await callJson('block', { action: 'search', query: 'document', format: 'json' });
  assert.ok(blockSearch.some((block) => block.id === 'block-docs'));

  step('Exercise task.start and task.finish on the small task');
  const activateFinish = await callJson('task', {
    action: 'finish',
    id: 'task-activate',
    checkData: {
      command: 'node --test test/greeter.test.mjs',
      description: 'Smoke test passed',
    },
    syncData: { blocks: ['block-docs'] },
    format: 'json',
  });
  assert.equal(activateFinish.task.status, 'completed');
  assert.equal(activateFinish.check.passed, true);
  const smokeReceipt = { id: activateFinish.check.receiptId };

  step('Develop the main task with rules, notes, probes, and reconcile');
  await call('task', { action: 'develop', id: 'task-main' });
  await call('task', { action: 'bind_rule', id: 'task-main', ruleId: 'rule-zero-tests' });
  await call('task', { action: 'unbind_rule', id: 'task-main', ruleId: 'rule-zero-tests' });
  await call('task', {
    action: 'update',
    id: 'task-main',
    taskData: { title: 'Implement and verify greeting service' },
    format: 'json',
  });
  await call('task', {
    action: 'note',
    id: 'task-main',
    kind: 'discovery',
    text: 'The greeting is intentionally implemented as a pure function.',
  });
  await callJson('task', {
    action: 'probe',
    id: 'task-main',
    hypothesis: 'The probe can be promoted after direct measurement.',
    script: 'scratch/probe.mjs',
    findings: 'The pure function is deterministic.',
    format: 'json',
  });
  await callJson('task', {
    action: 'graduate_probe',
    id: 'task-main',
    targetBlockId: 'block-scratch',
    files: ['scratch/probe.mjs'],
    format: 'json',
  });
  const reconciledTask = await callJson('task', {
    action: 'reconcile',
    id: 'task-main',
    format: 'json',
  });
  assert.ok(reconciledTask.workingSet.files.includes('scratch/probe.mjs'));

  step('Use AST outline/read/search and recover from a failed edit');
  const outline = await call('code', { action: 'outline', path: 'src/greeter.mjs' });
  assert.match(outline, /greet/);
  const read = await callJson('code', {
    action: 'read',
    path: 'src/greeter.mjs',
    selector: { symbol: 'greet' },
    format: 'json',
  });
  assert.match(read.code, /Hello/);
  await callJson('code', {
    action: 'edit',
    path: 'src/greeter.mjs',
    targetContent: 'return "Hello, " + name + "!";',
    replacementContent: 'return "Hi, " + name + "!";',
    format: 'json',
  });
  const failedReceipt = await callJson('run_command', {
    command: 'node --test test/greeter.test.mjs',
    maxChars: 800,
    timeoutMs: 30000,
  });
  assert.notEqual(failedReceipt.exitCode, 0);
  await callJson('code', {
    action: 'edit',
    path: 'src/greeter.mjs',
    targetContent: 'return "Hi, " + name + "!";',
    replacementContent: 'return "Hello, " + name + "!";',
    format: 'json',
  });
  const passingReceipt = await callJson('run_command', {
    command: 'node --test test/greeter.test.mjs',
    maxChars: 800,
    timeoutMs: 30000,
  });
  assert.equal(passingReceipt.exitCode, 0);
  await call('task', {
    action: 'check',
    id: 'task-main',
    checkData: {
      receiptId: passingReceipt.id,
      description: 'Greeting tests passed after recovery',
      passed: true,
    },
  });

  step('Prove the coverage gate blocks sync, then recover');
  const coverageFailure = await expectFailure(
    'task',
    {
      action: 'sync',
      id: 'task-main',
      syncData: { blocks: ['block-docs', 'block-scratch'] },
      format: 'json',
    },
    /Coverage gap|Uncovered files/
  );
  assert.match(coverageFailure, /src\/greeter\.mjs/);
  const failedTask = await callJson('task', { action: 'open', id: 'task-main', format: 'json' });
  assert.equal(failedTask.status, 'sync_failed');
  await call('task', { action: 'resume', id: 'task-main' });

  step('Bind the remaining source, test, dependency, and config blocks');
  const coreBlock = await callJson('block', {
    action: 'bind_auto',
    id: 'block-greeter-core',
    path: 'src/greeter.mjs',
    format: 'json',
  });
  assert.ok(coreBlock.addedRefs.some((ref) => ref.symbol === 'greet'));
  await callJson('block', {
    action: 'bind_auto',
    id: 'block-greeter-tests',
    path: 'test/greeter.test.mjs',
    format: 'json',
  });
  const vendorBlock = await callJson('block', {
    action: 'bind_auto',
    id: 'block-vendor',
    path: 'vendor',
    hashMode: 'manifest',
    manifest: 'vendor/package-lock.json',
    format: 'json',
  });
  assert.equal(vendorBlock.addedRefs[0].anchorKind, 'tree');
  assert.equal(vendorBlock.addedRefs[0].hashMode, 'manifest');
  await callJson('block', {
    action: 'bind_auto',
    id: 'block-config',
    path: 'config/app.json',
    format: 'json',
  });
  const allBlocks = await callJson('block', { action: 'list', format: 'json' });
  assert.equal(allBlocks.length, 6);
  const search = await call('code', { action: 'search', query: 'greet' });
  assert.match(search, /greet/);

  step('Sync the main task and complete the plan checkpoint');
  const mainSync = await callJson('task', {
    action: 'sync',
    id: 'task-main',
    syncData: { blocks: allBlocks.map((block) => block.id) },
    format: 'json',
  });
  assert.equal(mainSync.task.status, 'completed');
  assert.equal(mainSync.syncResult.coverage.coveragePercent, 100);
  await call('plan', {
    action: 'check',
    id: 'plan-zero',
    checkpointId: 'cp-zero-release',
    passed: true,
    evidenceRef: passingReceipt.id,
  });
  const completedPlan = await callJson('plan', {
    action: 'complete',
    id: 'plan-zero',
    planData: { completedSummary: 'Zero-project lifecycle verified.' },
    format: 'json',
  });
  assert.equal(completedPlan.status, 'completed');

  step('Exercise chain composition, links, unlink, delete, and validation');
  await call('chain', {
    action: 'compose',
    chainData: {
      id: 'chain-temporary',
      title: 'Temporary chain',
      kind: 'feature',
      memberIds: ['block-docs', 'block-greeter-core'],
    },
  });
  await call('chain', {
    action: 'link',
    linkData: {
      id: 'link-temporary',
      from: 'block-docs',
      to: 'block-greeter-core',
      kind: 'imports',
    },
  });
  assert.equal((await callJson('chain', { action: 'list', format: 'json' })).length, 1);
  const temporaryChain = await callJson('chain', { action: 'open', id: 'chain-temporary', format: 'json' });
  assert.equal(temporaryChain.id, 'chain-temporary');
  assert.equal((await callJson('chain', { action: 'links', format: 'json' })).length, 1);
  await call('chain', {
    action: 'unlink',
    linkData: { from: 'block-docs', to: 'block-greeter-core' },
  });
  await call('chain', { action: 'delete', id: 'chain-temporary' });
  assert.equal((await callJson('chain', { action: 'list', format: 'json' })).length, 0);

  const finalBlockIds = allBlocks.map((block) => block.id);
  await call('chain', {
    action: 'compose',
    chainData: {
      id: 'chain-greeter',
      title: 'Greeting feature',
      summary: 'Documentation, implementation, tests, dependency, and config.',
      kind: 'feature',
      memberIds: finalBlockIds,
    },
  });
  await call('chain', {
    action: 'link',
    linkData: {
      id: 'link-core-tests',
      from: 'block-greeter-core',
      to: 'block-greeter-tests',
      kind: 'calls',
      reason: 'The tests execute the public greet function.',
    },
  });
  await call('chain', {
    action: 'link',
    linkData: {
      id: 'link-core-vendor',
      from: 'block-greeter-core',
      to: 'block-vendor',
      kind: 'depends_on',
      reason: 'The dependency directory is part of the implementation boundary.',
    },
  });
  const chainValidation = await callJson('chain', { action: 'validate', format: 'json' });
  assert.equal(chainValidation.valid, true);
  const layoutValidation = await callJson('chain', { action: 'validate_layout', format: 'json' });
  assert.equal(layoutValidation.valid, true);

  step('Exercise os_context search/open/reconcile and process supervision');
  const searchContext = await call('os_context', { action: 'search', query: 'greeting' });
  assert.match(searchContext, /Greeting feature|Implement/);
  const openedPlan = await callJson('os_context', { action: 'open', entityId: 'plan:plan-zero', format: 'json' });
  assert.equal(openedPlan.status, 'completed');
  const openedTask = await callJson('os_context', { action: 'open', entityId: 'task:task-main', format: 'json' });
  assert.equal(openedTask.status, 'completed');
  const openedBlock = await callJson('os_context', { action: 'open', entityId: 'block:block-greeter-core', format: 'json' });
  assert.ok(openedBlock.artifactRefs.some((ref) => ref.symbol === 'greet'));
  const openedChain = await callJson('os_context', { action: 'open', entityId: 'chain:chain-greeter', format: 'json' });
  assert.equal(openedChain.id, 'chain-greeter');
  assert.match(await call('os_context', { action: 'reconcile' }), /already in sync/);

  assert.equal((await callJson('process', { action: 'list', format: 'json' })).length, 0);
  const startedProcess = await callJson('process', {
    action: 'start',
    id: 'manual-zero-process',
    command: 'node -e "console.log(\'ready\'); setInterval(() => {}, 1000)"',
  });
  processId = startedProcess.id;
  assert.equal(processId, 'manual-zero-process');
  assert.equal(startedProcess.status, 'running');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const processStatus = await callJson('process', { action: 'status', id: processId });
  assert.equal(processStatus.id, processId);
  const processLogs = await callJson('process', { action: 'logs', id: processId, lines: 20 });
  assert.ok(processLogs.lines.some((line) => line.includes('ready')));
  const stoppedProcess = await callJson('process', { action: 'stop', id: processId });
  assert.equal(stoppedProcess.status, 'stopped');
  processId = null;
  await call('process', { action: 'clear' });
  assert.equal((await callJson('process', { action: 'list', format: 'json' })).length, 0);

  step('Verify graph export and final resumption state');
  const graphPath = path.join(projectRoot, '.contextos/graph.json');
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  assert.equal(graph.schemaVersion, 3);
  assert.equal(graph.data.plans.find((item) => item.id === 'plan-zero').status, 'completed');
  assert.equal(graph.data.tasks.find((item) => item.id === 'task-main').status, 'completed');
  assert.equal(graph.data.tasks.find((item) => item.id === 'task-activate').status, 'completed');
  assert.equal(graph.data.blocks.length, 6);
  assert.equal(graph.data.chains.length, 1);
  assert.equal(graph.data.links.length, 2);
  assert.ok(!('artifacts' in graph.data));
  assert.ok(!('buildRuns' in graph.data));
  const finalBrief = await call('os_context', { action: 'brief' });
  assert.match(finalBrief, /ContextOS Project Brief/);
  assert.match(finalBrief, /Active Plan:\s+None/i);
  assert.match(finalBrief, /Current Task:\s+None/i);

  step('Exercise the safe local switch path');
  const switchText = await call('contextos_switch', { targetMode: 'local' });
  assert.match(switchText, /switched project.*LOCAL/i);
  await expectFailure(
    'contextos_switch',
    { targetMode: 'cloud' },
    /requires a cloudUrl/
  );

  console.log('\nManual zero-project verification passed.');
  console.log(`Project root: ${projectRoot}`);
  console.log(`Project id: ${projectId}`);
  console.log(`Smoke receipt: ${smokeReceipt.id}`);
  console.log(`Passing receipt: ${passingReceipt.id}`);
  console.log(`Graph revision: ${graph.graphRevision}`);
} finally {
  if (processId) {
    try {
      await call('process', { action: 'stop', id: processId });
    } catch {}
  }
  try {
    await client.close();
  } catch {}
}
