import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Daemon } from '../src/osd.mjs';
import { IPCClient } from '../../../packages/protocol/src/index.mjs';

test('Daemon graph writes go through the OS sync path and publish graph.json', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-daemon-sync-'));
  const daemon = new Daemon({ projectRoot: tempDir, projectId: 'daemon-sync-proj' });
  const graphPath = path.join(tempDir, '.contextos', 'graph.json');
  const revision = () => (fs.existsSync(graphPath)
    ? JSON.parse(fs.readFileSync(graphPath, 'utf8')).graphRevision
    : 0);

  await daemon.handleMessage('block_save', {
    block: {
      id: 'block-daemon',
      projectId: 'daemon-sync-proj',
      title: 'Daemon Block',
      kind: 'service',
      summary: 'written through the daemon',
      artifactRefs: [{ path: 'src/daemon.js', hash: 'h-daemon' }],
    },
  });
  const afterBlock = revision();
  assert.ok(afterBlock >= 1, `graph.json must be exported after a block write (got ${afterBlock})`);

  await daemon.handleMessage('link_save', {
    link: { id: 'link-daemon', projectId: 'daemon-sync-proj', from: 'block-daemon', to: 'block-daemon', kind: 'calls' },
  });
  const afterLink = revision();
  assert.ok(afterLink > afterBlock, 'every graph write must advance the graph revision');

  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  assert.ok(graph.data.blocks.some((block) => block.id === 'block-daemon'));

  daemon.db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Daemon starts, handles IPC requests, and stops cleanly', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-daemon-test-'));
  const daemon = new Daemon({ projectRoot: tempDir, projectId: 'daemon-test-proj' });

  const { socketPath } = await daemon.start();
  assert.ok(fs.existsSync(socketPath));

  const client = new IPCClient({ socketPath });
  await client.connect();

  // 1. Ping
  const pingRes = await client.call('ping');
  assert.equal(pingRes.pong, true);

  // 2. Status
  const statusRes = await client.call('status');
  assert.equal(statusRes.projectId, 'daemon-test-proj');
  assert.equal(statusRes.planCount, 0);

  // 3. Save Plan
  await client.call('plan_save', {
    plan: {
      id: 'plan-d1',
      projectId: 'daemon-test-proj',
      title: 'Daemon Test Plan',
      priority: 'normal',
      phases: [{ id: 'P0', order: 0, status: 'active' }],
      checkpoints: [{ id: 'cp-d1', title: 'Check 1', status: 'pending' }],
    },
  });

  const plan = await client.call('plan_get', { planId: 'plan-d1' });
  assert.equal(plan.title, 'Daemon Test Plan');
  assert.equal(plan.phases.length, 1);

  // 4. Save Block
  await client.call('block_save', {
    block: {
      id: 'block-d1',
      projectId: 'daemon-test-proj',
      title: 'Daemon Block',
      artifactRefs: [{ path: 'test.js', symbol: 'testFn', hash: 'hash123' }],
    },
  });

  const block = await client.call('block_get', { blockId: 'block-d1' });
  assert.equal(block.title, 'Daemon Block');

  // 5. Sync Export
  const exportRes = await client.call('sync_export');
  // Saves already publish through the OS sync path, so the export only has to
  // produce a file at the current revision.
  assert.ok(exportRes.graphRevision >= 1);
  assert.ok(fs.existsSync(exportRes.targetFile));

  // Clean up
  client.close();
  await daemon.stop();

  assert.equal(fs.existsSync(socketPath), false);
  fs.rmSync(tempDir, { recursive: true, force: true });
});
