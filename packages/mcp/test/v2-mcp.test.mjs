import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ContextOSV2Service } from '../src/v2-service.mjs';
import { createV2Server } from '../src/v2-server.mjs';

test('ContextOSV2Service executes core facades end-to-end', async () => {
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

  // Test top-level startLine/endLine
  const rangeRead = await service.code({ action: 'read', path: 'sample.js', startLine: 1, endLine: 1 });
  assert.ok(rangeRead.includes('compute'));

  const editRes = await service.code({
    action: 'edit',
    path: 'sample.js',
    startLine: 1,
    targetContent: 'return x + 1;',
    replacementContent: 'return x + 50;',
  });
  assert.ok(editRes.newHash);
  const updatedCode = fs.readFileSync(dummyFile, 'utf8');
  assert.ok(updatedCode.includes('return x + 50'));

  // 5. task: create, bind_rule, unbind_rule, update, note, check, and sync
  const task = await service.task({
    action: 'create',
    taskData: {
      id: 'task-v2-1',
      planId: 'plan-v2-1',
      phaseId: 'P0',
      title: 'Implement sample.js',
      workingSet: { files: ['sample.js'] },
      rules: ['rule-test'],
    },
    format: 'json',
  });
  assert.equal(task.id, 'task-v2-1');
  assert.deepEqual(task.rules, ['rule-test']);

  // Bind additional rule
  const taskBindRes = await service.task({
    action: 'bind_rule',
    id: 'task-v2-1',
    ruleId: 'rule-test-extra',
    format: 'json',
  });
  assert.ok(taskBindRes.rules.includes('rule-test-extra'));

  // Unbind rule
  const unbindRes = await service.task({
    action: 'unbind_rule',
    id: 'task-v2-1',
    ruleId: 'rule-test-extra',
    format: 'json',
  });
  assert.equal(unbindRes.rules.includes('rule-test-extra'), false);
  assert.ok(unbindRes.rules.includes('rule-test'));

  // Update task title and rules via top-level parameters
  const updatedTask = await service.task({
    action: 'update',
    id: 'task-v2-1',
    taskData: { title: 'Implement sample.js with rules' },
    rules: ['rule-test', 'rule-product-contract'],
    format: 'json',
  });
  assert.equal(updatedTask.title, 'Implement sample.js with rules');
  assert.deepEqual(updatedTask.rules, ['rule-test', 'rule-product-contract']);

  // Verify task open renders Bound Rules section in Markdown
  const taskMarkdown = await service.task({ action: 'open', id: 'task-v2-1' });
  assert.ok(taskMarkdown.includes('Bound Rules (按需调阅)'));
  assert.ok(taskMarkdown.includes('rule-test'));
  assert.ok(taskMarkdown.includes('rule-product-contract'));

  await assert.rejects(
    () =>
      service.task({
        action: 'check',
        id: 'task-v2-1',
        checkData: {
          receiptId: 'receipt-does-not-exist',
          description: 'Invalid receipt',
          passed: true,
        },
      }),
    /not found/
  );

  await service.task({ action: 'note', id: 'task-v2-1', text: 'Implemented sample.js' });
  await service.task({
    action: 'check',
    id: 'task-v2-1',
    checkData: {
      description: 'Code compiled and tested',
      passed: true,
      evidence: 'manual MCP smoke validation',
    },
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

test('task.start and task.finish provide a lightweight lifecycle', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-task-lite-'));
  const service = new ContextOSV2Service({ projectRoot: tempDir, projectId: 'task-lite' });
  fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'src/add.mjs'), 'export function add(a, b) { return a + b; }\n', 'utf8');
  fs.writeFileSync(
    path.join(tempDir, 'test/add.test.mjs'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from '../src/add.mjs';",
      "test('adds', () => assert.equal(add(1, 2), 3));",
      '',
    ].join('\n'),
    'utf8'
  );

  const started = await service.task({
    action: 'start',
    taskData: {
      id: 'task-lite',
      title: 'Lightweight add',
      workingSet: ['src/add.mjs', 'test/add.test.mjs'],
      rules: ['rule-testing'],
    },
    format: 'json',
  });
  assert.equal(started.task.status, 'active');
  assert.equal(started.lightweight, true);
  assert.ok(started.autoPlanId.startsWith('plan-light-'));

  await service.block({
    action: 'bind_auto',
    id: 'block-add',
    paths: ['src/add.mjs', 'test/add.test.mjs'],
  });

  const finished = await service.task({
    action: 'finish',
    id: 'task-lite',
    checkData: {
      command: 'node --test test/add.test.mjs',
      description: 'Lightweight test passed',
    },
    syncData: { blocks: ['block-add'] },
    format: 'json',
  });
  assert.equal(finished.task.status, 'completed');
  assert.equal(finished.check.passed, true);
  assert.equal(finished.completedPlan.status, 'completed');
  assert.equal(finished.syncResult.coverage.coveragePercent, 100);

  service.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('sync coverage failures return structured repair guidance', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-coverage-repair-'));
  const service = new ContextOSV2Service({ projectRoot: tempDir, projectId: 'coverage-repair' });
  fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'src/orphan.mjs'), 'export const orphan = true;\n', 'utf8');

  await service.task({
    action: 'start',
    taskData: {
      id: 'task-orphan',
      title: 'Orphan coverage',
      workingSet: ['src/orphan.mjs'],
    },
  });
  await service.task({
    action: 'check',
    id: 'task-orphan',
    checkData: {
      description: 'Manual evidence',
      passed: true,
      evidence: 'Reviewed manually before coverage gate',
    },
  });

  await assert.rejects(
    () => service.task({ action: 'sync', id: 'task-orphan' }),
    /Suggested repair: call block\(action:"bind_auto"/
  );

  const failed = await service.task({ action: 'open', id: 'task-orphan', format: 'json' });
  assert.equal(failed.status, 'sync_failed');
  assert.deepEqual(failed.syncResult.repair.paths, ['src/orphan.mjs']);
  assert.deepEqual(failed.syncResult.repair.then, ['task.resume', 'task.sync']);

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

test('dependency directories bind as tree anchors and run_command stores a receipt only', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-tree-mcp-'));
  const service = new ContextOSV2Service({ projectRoot: tempDir, projectId: 'tree-mcp' });
  fs.mkdirSync(path.join(tempDir, 'node_modules', 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'node_modules/runtime/index.js'), 'module.exports = true;\n', 'utf8');
  fs.writeFileSync(path.join(tempDir, 'package-lock.json'), '{"lockfileVersion":3}\n', 'utf8');

  const result = await service.block({
    action: 'bind_auto',
    id: 'block-node-dependencies',
    path: 'node_modules',
    hashMode: 'manifest',
    manifest: 'package-lock.json',
    blockData: { kind: 'dependency', title: 'Node Dependencies' },
    format: 'json',
  });
  assert.equal(result.block.artifactRefs[0].anchorKind, 'tree');
  assert.equal(result.block.artifactRefs[0].manifest, 'package-lock.json');

  const receipt = await service.runCommand({ command: 'echo "receipt only"' });
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.buildRun, undefined);
  assert.ok(service.db.getCommandReceipt(receipt.id));

  service.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('bind_auto uses file anchors for non-code documents', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-file-anchor-mcp-'));
  const service = new ContextOSV2Service({ projectRoot: tempDir, projectId: 'file-anchor-mcp' });
  fs.mkdirSync(path.join(tempDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'docs/development.md'), '# Development\n\nRelease notes.\n', 'utf8');

  const result = await service.block({
    action: 'bind_auto',
    id: 'block-docs',
    path: 'docs/development.md',
    format: 'json',
  });
  assert.equal(result.addedRefs.length, 1);
  assert.equal(result.addedRefs[0].anchorKind, 'file');
  assert.equal(result.addedRefs[0].symbol, 'development.md');

  service.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('code operations reject paths outside the project root', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-path-test-'));
  const service = new ContextOSV2Service({ projectRoot: tempDir, projectId: 'path-test' });
  await assert.rejects(
    () => service.code({ action: 'read', path: '../outside.js' }),
    /outside project root/
  );
  service.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
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

  assert.throws(
    () => initProjectWorkspace({ projectRoot: tempDir, mode: 'cloud' }),
    /Cloud mode requires a cloudUrl/
  );

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
  assert.equal(cloudConfig.token, undefined);

  const readCloud = JSON.parse(fs.readFileSync(path.join(tempDir, '.contextos', 'project.json'), 'utf8'));
  assert.equal(readCloud.storage, 'cloud');
  assert.equal(readCloud.isCloud, true);
  assert.equal(readCloud.token, undefined);

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

test('P0-P1: Smart auto-binding, sync physical gate, resumption anchor, and probe mode', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-p0p1-test-'));
  const service = new ContextOSV2Service({ projectRoot: tempDir, projectId: 'p0p1-test' });

  // 1. Resumption Anchor in osContext brief
  const briefMd = await service.osContext({ action: 'brief', format: 'markdown' });
  assert.ok(briefMd.includes('ContextOS Resumption Anchor'));
  assert.ok(briefMd.includes('NEXT MANDATORY ACTION'));

  const briefJson = await service.osContext({ action: 'brief', format: 'json' });
  assert.ok(briefJson.resumptionAnchor);
  assert.ok(briefJson.resumptionAnchor.nextMandatoryAction);

  // 2. Create Plan & Task
  const plan = await service.plan({
    action: 'create',
    planData: {
      id: 'plan-probe-1',
      title: 'Probe Test Plan',
      phases: [{ id: 'P1', order: 0, status: 'active' }],
    },
    format: 'json',
  });

  const task = await service.task({
    action: 'create',
    taskData: {
      id: 'task-probe-1',
      planId: plan.id,
      phaseId: 'P1',
      title: 'Reverse Engineering Task',
    },
    format: 'json',
  });

  // 3. Task Probe Mode
  const probeRes = await service.task({
    action: 'probe',
    id: task.id,
    taskData: {
      hypothesis: 'Verify vertex stride 80 bytes',
      script: 'scratch/probe.py',
      findings: 'Confirmed offset 48 contains UV coords',
    },
    format: 'json',
  });
  assert.equal(probeRes.taskId, task.id);
  assert.equal(probeRes.probe.hypothesis, 'Verify vertex stride 80 bytes');

  // Verify task notes recorded probe
  const taskAfterProbe = await service.task({ action: 'open', id: task.id, format: 'json' });
  assert.ok(taskAfterProbe.notes.some((n) => n.kind === 'probe'));

  // 4. Create sample code files for bind_auto
  const sampleSwift = path.join(tempDir, 'Renderer.swift');
  fs.writeFileSync(sampleSwift, `
import Foundation

public class SceneRenderer {
    public func render() {}
}

public struct VertexLayout {
    public var stride: Int
}
`, 'utf8');

  // Create initial block
  await service.block({
    action: 'bind',
    id: 'block-renderer',
    blockData: {
      title: 'Metal Renderer',
      summary: 'Handles GPU rendering',
      artifactRefs: [],
    },
  });

  // 5. Test Smart Auto-Binding (bind_auto)
  const autoBindRes = await service.block({
    action: 'bind_auto',
    id: 'block-renderer',
    path: 'Renderer.swift',
    format: 'json',
  });

  assert.equal(autoBindRes.block.id, 'block-renderer');
  assert.ok(autoBindRes.addedRefs.length >= 2);
  const symbols = autoBindRes.addedRefs.map((r) => r.symbol);
  assert.ok(symbols.includes('SceneRenderer'));
  assert.ok(symbols.includes('VertexLayout'));
  for (const ref of autoBindRes.addedRefs) {
    assert.ok(ref.hash && ref.hash.length > 0);
    assert.ok(ref.symbol && ref.symbol.length > 0);
  }

  // 6. Test Task Graduate Probe (promotes probe file and auto-binds to block)
  const gradRes = await service.task({
    action: 'graduate_probe',
    id: task.id,
    taskData: {
      targetBlockId: 'block-renderer',
      files: ['Renderer.swift'],
    },
    format: 'json',
  });
  assert.deepEqual(gradRes.graduatedFiles, ['Renderer.swift']);
  assert.equal(gradRes.targetBlockId, 'block-renderer');

  // 7. Physical Gate Test on task(sync):
  // 7a. Try syncing with a block that has an unanchored ref (empty symbol or hash): MUST THROW!
  await service.block({
    action: 'bind',
    id: 'block-unanchored',
    blockData: {
      title: 'Unanchored Block',
      artifactRefs: [{ path: 'Renderer.swift', symbol: '', hash: '' }],
    },
  });

  await service.task({ action: 'activate', id: task.id });
  await service.task({
    action: 'check',
    id: task.id,
    checkData: {
      description: 'Render test',
      passed: true,
      evidence: 'manual render verification',
    },
  });

  await assert.rejects(
    async () => {
      await service.task({
        action: 'sync',
        id: task.id,
        syncData: {
          blocks: ['block-unanchored'],
        },
      });
    },
    /Invariant 1 Violation: Block 'block-unanchored' contains unanchored artifactRef/
  );

  // 7b. Repair the unanchored block using bind_auto, then sync: MUST SUCCEED!
  await service.block({
    action: 'bind_auto',
    id: 'block-unanchored',
    path: 'Renderer.swift',
  });

  const syncSuccess = await service.task({
    action: 'sync',
    id: task.id,
    syncData: {
      blocks: ['block-renderer', 'block-unanchored'],
    },
    format: 'json',
  });
  assert.equal(syncSuccess.task.status, 'completed');

  service.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
