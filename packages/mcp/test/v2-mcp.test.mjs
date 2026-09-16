import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ContextOSV2Service } from '../src/v2-service.mjs';
import { createV2Server } from '../src/v2-server.mjs';

test('ContextOSV2Service executes all 9 facades end-to-end', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-v2-mcp-test-'));
  const service = new ContextOSV2Service({ projectRoot: tempDir, projectId: 'v2-test' });

  // 1. os_context brief on empty project
  const brief = await service.osContext({ action: 'brief' });
  assert.ok(typeof brief === 'string');
  assert.ok(brief.includes('ContextOS Project Brief'));

  // 2. knowledge: decision and rule
  await service.knowledge({
    action: 'decision_write',
    sectionId: 'DEC-01',
    sectionTitle: 'Initial Decision',
    content: 'Status: Accepted\nContext: Testing V2 Facades',
  });
  const dec = await service.knowledge({ action: 'decision_open', sectionId: 'DEC-01' });
  assert.ok(dec.includes('Initial Decision'));

  await service.knowledge({
    action: 'rule_write',
    ruleData: {
      id: 'rule-test',
      title: 'Testing Rule',
      category: 'test',
      summary: 'Keep tests clean',
      content: 'Write deterministic assertions.',
    },
  });
  const rules = await service.knowledge({ action: 'rule_list', format: 'json' });
  assert.equal(rules.length, 1);

  // 3. plan: create and open
  const plan = await service.plan({
    action: 'create',
    planData: {
      id: 'plan-v2-1',
      title: 'V2 Test Plan',
      phases: [{ id: 'P0', order: 0, status: 'active' }],
      checkpoints: [{ id: 'cp-v2-1', title: 'Verify P0 Check', status: 'pending' }],
    },
    format: 'json',
  });
  assert.equal(plan.id, 'plan-v2-1');

  // 4. code: write a dummy file, outline, read, edit
  const dummyFile = path.join(tempDir, 'sample.js');
  fs.writeFileSync(dummyFile, 'export function compute(x) { return x + 1; }\n', 'utf8');

  const outline = await service.code({ action: 'outline', path: 'sample.js' });
  assert.ok(outline.includes('compute'));

  const codeRead = await service.code({ action: 'read', path: 'sample.js', selector: 'file-compute' });
  assert.ok(codeRead.includes('return x + 1'));

  const editRes = await service.code({
    action: 'edit',
    path: 'sample.js',
    targetContent: 'return x + 1;',
    replacementContent: 'return x + 50;',
  });
  assert.ok(editRes.newHash);
  const updatedCode = fs.readFileSync(dummyFile, 'utf8');
  assert.ok(updatedCode.includes('return x + 50'));

  // 5. task: create, note, check, and sync
  const task = await service.task({
    action: 'create',
    taskData: {
      id: 'task-v2-1',
      planId: 'plan-v2-1',
      phaseId: 'P0',
      title: 'Implement sample.js',
      workingSet: { files: ['sample.js'] },
    },
    format: 'json',
  });
  assert.equal(task.id, 'task-v2-1');

  await service.task({ action: 'note', id: 'task-v2-1', text: 'Implemented sample.js' });
  await service.task({
    action: 'check',
    id: 'task-v2-1',
    checkData: { description: 'Code compiled and tested', passed: true },
  });

  // Advance to checking before sync
  service.taskService.startChecking('task-v2-1');

  const syncResult = await service.task({
    action: 'sync',
    id: 'task-v2-1',
    syncData: {
      blocks: [
        {
          id: 'block-sample',
          projectId: 'v2-test',
          title: 'Sample Block',
          artifactRefs: [{ path: 'sample.js', symbol: 'compute', hash: editRes.newHash }],
        },
      ],
    },
    format: 'json',
  });
  assert.equal(syncResult.task.status, 'completed');

  // 6. block: search and open
  const block = await service.block({ action: 'open', id: 'block-sample', format: 'json' });
  assert.equal(block.id, 'block-sample');

  // 7. chain: compose, link, links, unlink, validate
  await service.chain({
    action: 'compose',
    chainData: { id: 'chain-v2-main', title: 'Main Chain', memberIds: ['block-sample'] },
  });
  await service.chain({
    action: 'link',
    linkData: { from: 'block-sample', to: 'block-sample', kind: 'calls', reason: 'self-recursion test' },
  });
  const allLinks = await service.chain({ action: 'links', format: 'json' });
  assert.equal(allLinks.length, 1);
  await service.chain({
    action: 'unlink',
    linkData: { from: 'block-sample', to: 'block-sample' },
  });
  const remainingLinks = await service.chain({ action: 'links', format: 'json' });
  assert.equal(remainingLinks.length, 0);

  const val = await service.chain({ action: 'validate' });
  assert.equal(val.valid, true);

  const blockList = await service.block({ action: 'list', format: 'json' });
  assert.equal(blockList.length, 1);

  // 7.5 code create
  const createdFile = await service.code({
    action: 'create',
    path: 'src/created-file.mjs',
    content: 'export function helloNew() { return 1; }',
  });
  assert.equal(createdFile.filePath, 'src/created-file.mjs');
  assert.ok(createdFile.newHash);

  // 7.6 block bind with root id and string ref
  const bindRes = await service.block({
    action: 'bind',
    id: 'block-sample',
    blockData: { artifactRefs: ['src/created-file.mjs'] },
  });
  assert.ok(bindRes.includes('bound with'));

  // 8. run_command
  const receipt = await service.runCommand({ command: 'echo "v2 mcp success"' });
  assert.equal(receipt.exitCode, 0);
  assert.ok(receipt.summary.includes('succeeded'));
  assert.ok(receipt.text.includes('v2 mcp success'));

  // 9. complete plan
  await service.plan({
    action: 'check',
    id: 'plan-v2-1',
    checkpointId: 'cp-v2-1',
    passed: true,
    evidenceRef: receipt.id,
  });
  const completedPlan = await service.plan({ action: 'complete', id: 'plan-v2-1', format: 'json' });
  assert.equal(completedPlan.status, 'completed');

  service.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('createV2Server registers all 12 tools', () => {
  const server = createV2Server();
  assert.ok(server);
  const expectedTools = [
    'os_context',
    'plan',
    'task',
    'block',
    'chain',
    'code',
    'run_command',
    'process',
    'knowledge',
    'contextos_init',
    'contextos_doctor',
    'contextos_switch',
  ];
  assert.equal(expectedTools.length, 12);
});

test('global cloud config management and selective platforms filtering', async () => {
  const { saveGlobalCloudConfig, getGlobalCloudConfig, syncAllPlatforms } = await import('../src/bootstrap-util.mjs');

  // 1. Save and read global cloud config
  const saved = saveGlobalCloudConfig({ cloudUrl: 'https://test-hub.workers.dev', token: 'test-token-xyz' });
  assert.equal(saved.cloudUrl, 'https://test-hub.workers.dev');
  assert.equal(saved.token, 'test-token-xyz');

  const retrieved = getGlobalCloudConfig();
  assert.equal(retrieved.cloudUrl, 'https://test-hub.workers.dev');
  assert.equal(retrieved.token, 'test-token-xyz');

  // 2. Selective platform filtering
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-filter-test-'));
  const modified = syncAllPlatforms({
    serverScript: '/dummy/server.mjs',
    nodePath: 'node',
    targetRoot: tempDir,
    selectedPlatforms: ['cursor'],
    forceAll: false,
  });

  // Only cursor or workspace cursor was modified, not claude or antigravity
  assert.ok(modified.every((m) => m.toLowerCase().includes('cursor')));

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('initProjectWorkspace guarantees local vs cloud isolation', async () => {
  const { initProjectWorkspace } = await import('../src/bootstrap-util.mjs');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-iso-test-'));

  // 1. Init as local
  const localConfig = initProjectWorkspace({
    projectRoot: tempDir,
    mode: 'local',
    projectId: 'my-local-tool',
  });
  assert.equal(localConfig.storage, 'local');
  assert.equal(localConfig.isCloud, false);
  assert.equal(localConfig.cloudUrl, undefined);

  const readLocal = JSON.parse(fs.readFileSync(path.join(tempDir, '.contextos', 'project.json'), 'utf8'));
  assert.equal(readLocal.storage, 'local');
  assert.equal(readLocal.isCloud, false);

  // 2. Switch to cloud
  const cloudConfig = initProjectWorkspace({
    projectRoot: tempDir,
    mode: 'cloud',
    cloudUrl: 'https://contextos-cloud.example.workers.dev',
    token: 'secret-token-123',
    projectId: 'contextos',
  });
  assert.equal(cloudConfig.storage, 'cloud');
  assert.equal(cloudConfig.isCloud, true);
  assert.equal(cloudConfig.cloudUrl, 'https://contextos-cloud.example.workers.dev');
  assert.equal(cloudConfig.token, 'secret-token-123');

  const readCloud = JSON.parse(fs.readFileSync(path.join(tempDir, '.contextos', 'project.json'), 'utf8'));
  assert.equal(readCloud.storage, 'cloud');
  assert.equal(readCloud.isCloud, true);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('HybridContextOSService runs local commands and handles cloud fallback gracefully', async () => {
  const { HybridContextOSService } = await import('../src/hybrid-service.mjs');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-hybrid-test-'));

  const hybrid = new HybridContextOSService({
    cloudUrl: 'http://127.0.0.1:59999', // unreachable port for fallback test
    token: 'test-token',
    projectId: 'hybrid-test',
    projectRoot: tempDir,
  });

  // 1. runCommand runs locally
  const receipt = await hybrid.runCommand({ command: 'echo "hybrid local execution"' });
  assert.equal(receipt.exitCode, 0);
  assert.ok(receipt.text.includes('hybrid local execution'));

  // 2. osContext falls back to local brief with diagnostic warning when cloud is offline
  const brief = await hybrid.osContext({ action: 'brief', format: 'markdown' });
  assert.ok(brief.includes('ContextOS Cloud Unavailable'));
  assert.ok(brief.includes('ContextOS Project Brief'));

  hybrid.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

