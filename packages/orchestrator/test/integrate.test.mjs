import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createV3Server } from '../../mcp/src/v3-server.mjs';
import { createMicroJob, updateMicroJob } from '../src/micro-delivery.mjs';

async function boot() {
  const server = createV3Server();
  const client = new Client({ name: 'integrate-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const textOf = (result) => (result.content || []).map((chunk) => chunk.text ?? '').join('\n');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-integrate-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-integrate-ws-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"integrate-fixture","private":true,"type":"module"}\n');
  fs.writeFileSync(path.join(root, 'src', 'math.mjs'), 'export const add = (a, b) => a - b;\n');
  fs.writeFileSync(path.join(workspace, 'src', 'math.mjs'), 'export const add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(workspace, 'src', 'extra.mjs'), 'export const extra = true;\n');
  return {
    root,
    workspace,
    cleanup: () => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(workspace, { recursive: true, force: true }); },
  };
}

test('integrate merges a completed isolated implementation and carries worker checks', async () => {
  const f = fixture();
  const client = await boot();
  try {
    createMicroJob(f.root, { jobId: 'agent-integrate-fixture', provider: 'cli', adapter: 'fixture' });
    updateMicroJob(f.root, 'agent-integrate-fixture', {
      status: 'completed',
      report: { checks: ['node --check src/math.mjs && node --check src/extra.mjs'] },
      implementation: {
        workspace: f.workspace,
        allowedPaths: ['src/math.mjs', 'src/extra.mjs'],
        acceptance: ['addition stays correct'],
        verify: ['node --check src/math.mjs && node --check src/extra.mjs'],
      },
    });
    const result = await client.callTool({
      name: 'contextos',
      arguments: { action: 'integrate', args: { jobId: 'agent-integrate-fixture' }, projectRoot: f.root },
    });
    const text = textOf(result);
    assert.ok(!result.isError, text);
    assert.match(text, /# ContextOS integrate/);
    assert.match(text, /status=applied changed=2/);
    assert.match(text, /src\/math\.mjs/);
    assert.match(text, /Worker checks: `node --check src\/math\.mjs/);
    assert.match(text, /Host verification: skipped/);
    assert.match(text, /Architecture: auto-bound new paths/);
    assert.match(fs.readFileSync(path.join(f.root, 'src', 'math.mjs'), 'utf8'), /a \+ b/);
    assert.ok(fs.existsSync(path.join(f.root, 'src', 'extra.mjs')));
    const replay = await client.callTool({
      name: 'contextos',
      arguments: { action: 'integrate', args: { jobId: 'agent-integrate-fixture' }, projectRoot: f.root },
    });
    assert.match(textOf(replay), /status=noop changed=0/);
  } finally {
    await client.close();
    f.cleanup();
  }
});

test('integrate waits for a running implementation job in the same call', async () => {
  const f = fixture();
  const client = await boot();
  try {
    createMicroJob(f.root, { jobId: 'agent-integrate-running', provider: 'cli', adapter: 'fixture' });
    updateMicroJob(f.root, 'agent-integrate-running', {
      status: 'running',
      implementation: {
        workspace: f.workspace,
        allowedPaths: ['src/math.mjs', 'src/extra.mjs'],
        acceptance: ['addition stays correct'],
        verify: ['node --check src/math.mjs && node --check src/extra.mjs'],
      },
    });
    setTimeout(() => updateMicroJob(f.root, 'agent-integrate-running', {
      status: 'completed',
      report: { checks: ['node --check src/math.mjs && node --check src/extra.mjs'] },
    }), 25);
    const result = await client.callTool({
      name: 'contextos',
      arguments: { action: 'integrate', args: { jobId: 'agent-integrate-running', waitMs: 5000 }, projectRoot: f.root },
    });
    const text = textOf(result);
    assert.ok(!result.isError, text);
    assert.match(text, /status=applied changed=2/);
    assert.match(text, /Host verification: skipped/);
  } finally {
    await client.close();
    f.cleanup();
  }
});

test('integrate runs worker verification only when the host explicitly requests it', async () => {
  const f = fixture();
  const client = await boot();
  try {
    createMicroJob(f.root, { jobId: 'agent-integrate-explicit-verify', provider: 'cli', adapter: 'fixture' });
    updateMicroJob(f.root, 'agent-integrate-explicit-verify', {
      status: 'completed',
      implementation: {
        workspace: f.workspace,
        allowedPaths: ['src/math.mjs', 'src/extra.mjs'],
        acceptance: ['addition stays correct'],
        verify: ['node --check src/math.mjs && node --check src/extra.mjs'],
      },
    });
    const result = await client.callTool({
      name: 'contextos',
      arguments: { action: 'integrate', args: { jobId: 'agent-integrate-explicit-verify', verify: true }, projectRoot: f.root },
    });
    const text = textOf(result);
    assert.ok(!result.isError, text);
    assert.match(text, /Host verification: `node --check src\/math\.mjs/);
    assert.match(text, /verify: PASS/);
  } finally {
    await client.close();
    f.cleanup();
  }
});

test('integrate refuses jobs without an isolated implementation scope', async () => {
  const f = fixture();
  const client = await boot();
  try {
    createMicroJob(f.root, { jobId: 'agent-analyze-fixture', provider: 'cli', adapter: 'fixture' });
    updateMicroJob(f.root, 'agent-analyze-fixture', { status: 'completed' });
    const result = await client.callTool({
      name: 'contextos',
      arguments: { action: 'integrate', args: { jobId: 'agent-analyze-fixture' }, projectRoot: f.root },
    });
    assert.match(textOf(result), /INTEGRATE_SCOPE_REQUIRED/);
  } finally {
    await client.close();
    f.cleanup();
  }
});

test('integrate walks directory entries in allowedPaths recursively and reports absent paths', async () => {
  const f = fixture();
  const client = await boot();
  try {
    createMicroJob(f.root, { jobId: 'agent-integrate-directory', provider: 'cli', adapter: 'fixture' });
    updateMicroJob(f.root, 'agent-integrate-directory', {
      status: 'completed',
      report: { checks: ['node --check src/math.mjs'] },
      implementation: {
        workspace: f.workspace,
        allowedPaths: ['src', 'absent/path.mjs'],
        acceptance: ['directory entries are walked recursively'],
        verify: ['node --check src/math.mjs'],
      },
    });
    const result = await client.callTool({
      name: 'contextos',
      arguments: { action: 'integrate', args: { jobId: 'agent-integrate-directory' }, projectRoot: f.root },
    });
    const text = textOf(result);
    assert.ok(!result.isError, text);
    assert.match(text, /# ContextOS integrate/);
    assert.match(text, /status=applied changed=2/);
    assert.match(text, /src\/math\.mjs/);
    assert.match(text, /Skipped: `absent\/path\.mjs`/);
    assert.match(fs.readFileSync(path.join(f.root, 'src', 'math.mjs'), 'utf8'), /a \+ b/);
    assert.ok(fs.existsSync(path.join(f.root, 'src', 'extra.mjs')));
    const replay = await client.callTool({
      name: 'contextos',
      arguments: { action: 'integrate', args: { jobId: 'agent-integrate-directory' }, projectRoot: f.root },
    });
    const replayText = textOf(replay);
    assert.match(replayText, /status=noop changed=0/);
    assert.match(replayText, /Skipped: `absent\/path\.mjs` \(absent from both the isolated workspace and the project\)/);
  } finally {
    await client.close();
    f.cleanup();
  }
});

test('integrate reviews an in-place implementation from its snapshot and reverts it byte-for-byte', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-integrate-inplace-'));
  const client = await boot();
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"inplace-fixture","private":true,"type":"module"}\n');
    fs.writeFileSync(path.join(root, 'src', 'math.mjs'), 'export const add = (a, b) => a + b;\n');
    createMicroJob(root, { jobId: 'agent-inplace-fixture', provider: 'cli', adapter: 'fixture' });
    updateMicroJob(root, 'agent-inplace-fixture', {
      status: 'completed',
      report: { checks: ['node --check src/math.mjs'] },
      implementation: {
        mode: 'in-place',
        workspace: root,
        allowedPaths: ['src/math.mjs'],
        acceptance: ['addition stays correct'],
        verify: ['node --check src/math.mjs'],
        before: { 'src/math.mjs': { exists: true, content: 'export const add = (a, b) => a - b;\n' } },
      },
    });
    const applied = await client.callTool({
      name: 'contextos',
      arguments: { action: 'integrate', args: { jobId: 'agent-inplace-fixture' }, projectRoot: root },
    });
    const appliedText = textOf(applied);
    assert.ok(!applied.isError, appliedText);
    assert.match(appliedText, /status=applied changed=1 mode=in-place/);
    assert.match(appliedText, /Worker checks: `node --check src\/math\.mjs`/);
    assert.match(appliedText, /Revert: integrate\(\{jobId:"agent-inplace-fixture", revert:true\}\)/);
    assert.match(fs.readFileSync(path.join(root, 'src', 'math.mjs'), 'utf8'), /a \+ b/);
    const reverted = await client.callTool({
      name: 'contextos',
      arguments: { action: 'integrate', args: { jobId: 'agent-inplace-fixture', revert: true }, projectRoot: root },
    });
    const revertedText = textOf(reverted);
    assert.ok(!reverted.isError, revertedText);
    assert.match(revertedText, /status=reverted changed=1 mode=in-place/);
    assert.equal(fs.readFileSync(path.join(root, 'src', 'math.mjs'), 'utf8'), 'export const add = (a, b) => a - b;\n');
    const replay = await client.callTool({
      name: 'contextos',
      arguments: { action: 'integrate', args: { jobId: 'agent-inplace-fixture', revert: true }, projectRoot: root },
    });
    assert.match(textOf(replay), /status=noop changed=0 mode=in-place/);
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
