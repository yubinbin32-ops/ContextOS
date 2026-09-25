import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { Orchestrator } from '../src/index.mjs';
import { SessionStore } from '../src/session-store.mjs';
import { ContextOSV2Service } from '../../mcp/src/v2-service.mjs';

function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-receipt-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'historical-receipt-fixture',
    scripts: { test: 'node --check src/math.mjs' },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'src', 'math.mjs'), 'export function add(a, b) {\n  return a + b;\n}\n');
  try {
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', [
      '-c', 'user.name=ContextOS',
      '-c', 'user.email=contextos@example.test',
      'commit', '-m', 'fixture baseline',
    ], { cwd: dir, stdio: 'ignore' });
  } catch (_) {}
  return dir;
}

async function verifyAndClose(projectRoot) {
  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });
  const output = await orchestrator.dispatch('verify', {
    commands: ['node --check src/math.mjs'],
  });
  assert.match(output, /Verdict: PASS/);
  const store = new SessionStore({ projectRoot, projectId: 'fixture' });
  const receiptId = store.current?.receipts?.at(-1)?.id;
  assert.ok(receiptId, 'verify must leave a receipt id');
  const closed = await orchestrator.dispatch('ship', { summary: '关闭已验证会话' });
  assert.match(closed, /Passing receipts: 1/);
  service.close();
  return receiptId;
}

test('ship reuses an explicit passing receipt from a closed session', async () => {
  const projectRoot = makeTempProject();
  let service;
  try {
    const receiptId = await verifyAndClose(projectRoot);
    service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
    const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });
    await orchestrator.dispatch('inspect', { path: 'src/math.mjs' });
    const shipped = await orchestrator.dispatch('ship', {
      summary: '跨会话复用验证',
      receiptId,
    });
    assert.match(shipped, /Reused passing receipt/);
    assert.match(shipped, /Passing receipts: 1/);
  } finally {
    service?.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('ship rejects a historical receipt after the workspace fingerprint changes', async () => {
  const projectRoot = makeTempProject();
  let service;
  try {
    const receiptId = await verifyAndClose(projectRoot);
    fs.appendFileSync(path.join(projectRoot, 'src', 'math.mjs'), '\nexport const changed = true;\n');
    service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
    const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });
    await orchestrator.dispatch('inspect', { path: 'src/math.mjs' });
    const blocked = await orchestrator.dispatch('ship', {
      summary: '拒绝过期凭证',
      receiptId,
    });
    assert.match(blocked, /BLOCKED \(receipt contract\)/);
    assert.match(blocked, /state-changed-or-not-passing/);
  } finally {
    service?.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
