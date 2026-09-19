import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContextOSV2Service } from '../packages/mcp/src/v2-service.mjs';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-tree-workflow-'));
const projectId = 'manual-tree-workflow';

try {
  fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'node_modules', 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'src', 'main.mjs'), 'export function main() { return 1; }\n', 'utf8');
  fs.writeFileSync(path.join(tempDir, 'node_modules', 'runtime', 'index.js'), 'module.exports = 1;\n', 'utf8');
  fs.writeFileSync(path.join(tempDir, 'resources', 'message.txt'), 'hello\n', 'utf8');
  fs.writeFileSync(path.join(tempDir, 'package-lock.json'), '{"lockfileVersion":3}\n', 'utf8');

  const service = new ContextOSV2Service({ projectRoot: tempDir, projectId });
  await service.plan({
    action: 'create',
    planData: {
      id: 'plan-manual-tree',
      title: 'Manual tree binding workflow',
      phases: [{ id: 'P0', name: 'Implement', order: 0, status: 'active' }],
    },
  });
  await service.task({
    action: 'create',
    taskData: {
      id: 'task-manual-tree',
      planId: 'plan-manual-tree',
      phaseId: 'P0',
      title: 'Bind source and directories',
      workingSet: {
        files: ['src/main.mjs', 'node_modules/runtime/index.js', 'resources/message.txt'],
      },
      rules: ['rule-product-contract', 'rule-surgical-code-editing'],
    },
  });
  await service.task({ action: 'activate', id: 'task-manual-tree' });

  const source = await service.block({
    action: 'bind_auto',
    id: 'block-main',
    path: 'src/main.mjs',
    format: 'json',
  });
  const dependencies = await service.block({
    action: 'bind_auto',
    id: 'block-node-dependencies',
    path: 'node_modules',
    hashMode: 'manifest',
    manifest: 'package-lock.json',
    blockData: { kind: 'dependency', title: 'Node Dependencies' },
    format: 'json',
  });
  const resources = await service.block({
    action: 'bind_auto',
    id: 'block-resources',
    path: 'resources',
    hashMode: 'content',
    blockData: { kind: 'resource', title: 'Resources' },
    format: 'json',
  });
  assert.equal(source.block.artifactRefs[0].anchorKind, 'symbol');
  assert.equal(dependencies.block.artifactRefs[0].hashMode, 'manifest');
  assert.equal(resources.block.artifactRefs[0].hashMode, 'content');

  const receipt = await service.runCommand({ command: 'node -e "console.log(\'manual tree workflow\')"' });
  assert.equal(receipt.exitCode, 0);
  await service.task({
    action: 'check',
    id: 'task-manual-tree',
    checkData: {
      receiptId: receipt.id,
      description: 'Manual tree workflow command passed',
      passed: true,
    },
  });
  service.taskService.startChecking('task-manual-tree');
  const synced = await service.task({
    action: 'sync',
    id: 'task-manual-tree',
    syncData: {
      blocks: [
        source.block,
        dependencies.block,
        resources.block,
      ],
    },
    format: 'json',
  });
  assert.equal(synced.task.status, 'completed');
  assert.equal(synced.syncResult.coverage.coveragePercent, 100);

  const graph = JSON.parse(fs.readFileSync(path.join(tempDir, '.contextos', 'graph.json'), 'utf8'));
  assert.equal(graph.schemaVersion, 3);
  assert.equal(graph.data.artifacts, undefined);
  assert.equal(graph.data.buildRuns, undefined);
  assert.equal(graph.data.blocks.find((block) => block.id === 'block-node-dependencies').artifactRefs[0].manifest, 'package-lock.json');

  console.log('Manual tree binding workflow passed.');
  console.log(`- Receipt: ${receipt.id}`);
  console.log(`- Graph revision: ${synced.graphRevision}`);
  service.close();
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
