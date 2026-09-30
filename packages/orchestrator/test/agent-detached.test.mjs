import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeAgent } from '../src/agent-service.mjs';
import { createMicroJob, readMicroJob } from '../src/micro-delivery.mjs';

delete process.env.CONTEXTOS_AGENT_INPROCESS;

const workerPath = fileURLToPath(new URL('../src/agent-worker.mjs', import.meta.url));

function fakeCliAdapter(projectRoot, { delayMs = 350, summary = 'detached completed' } = {}) {
  const command = path.join(projectRoot, 'fake-cli.mjs');
  fs.writeFileSync(command, `#!/usr/bin/env node
setTimeout(() => {
  process.stdout.write(JSON.stringify({
    result: {
      status: 'SUCCESS',
      content: ${JSON.stringify(summary)},
      structured: {
        summary: ${JSON.stringify(summary)},
        changes: [],
        checks: ['fake cli completed'],
        blockers: [],
        needsHost: false,
      },
      usage: { input_tokens: 11, output_tokens: 3 },
    },
  }));
}, ${delayMs});
`, { mode: 0o755 });
  return {
    command,
    model: 'fake-model',
    args: ['--model', '{model}'],
    input: { format: 'text', template: '{task}' },
    output: {
      format: 'json',
      contentPath: 'result.content',
      structuredPath: 'result.structured',
      statusPath: 'result.status',
      successValues: ['SUCCESS'],
      usage: {
        path: 'result.usage',
        input: 'input_tokens',
        output: 'output_tokens',
        inputIncludesCache: false,
      },
    },
  };
}

test('detached dispatch returns running and the worker completes through the disk job record', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-detached-'));
  const jobId = 'agent-detached-complete';
  try {
    const adapter = fakeCliAdapter(root);
    const dispatched = await executeAgent({ task: 'run the fake CLI', id: jobId, background: true }, {
      projectRoot: root,
      name: 'fake',
      adapter,
    });
    assert.deepEqual(dispatched, { id: jobId, status: 'running' });
    assert.equal(readMicroJob(root, jobId).status, 'running');

    const early = await executeAgent({ action: 'wait', id: jobId, waitMs: 25 }, { projectRoot: root });
    assert.equal(early.status, 'partial');
    assert.equal(early.terminal, false);
    assert.deepEqual(early.resume, { kind: 'agent', action: 'wait', jobId });
    assert.match(early.guidance, /refresh the window/);

    const completed = await executeAgent({ action: 'wait', id: jobId, waitMs: 5000 }, { projectRoot: root });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.terminal, true);
    assert.equal(completed.report.summary, 'detached completed');
    const persisted = readMicroJob(root, jobId);
    assert.equal(persisted.status, 'completed');
    assert.equal(persisted.report.summary, 'detached completed');
    assert.equal(persisted.usageReceipt.usage.inputTokens, 11);
    assert.equal(persisted.usageReceipt.usage.outputTokens, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('detached worker top-level failures are persisted as failed jobs with an error report', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-detached-failure-'));
  const jobId = 'agent-detached-failure';
  try {
    createMicroJob(root, {
      jobId,
      provider: 'cli',
      adapter: 'broken',
      worker: { version: 2, args: { task: 'invalid worker definition' }, deliveryMode: 'auto' },
    });
    const child = spawn(process.execPath, [workerPath, root, jobId], { stdio: 'ignore', env: process.env });
    const exitCode = await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(exitCode, 1);
    const failed = readMicroJob(root, jobId);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /no valid persisted worker definition/);
    assert.equal(failed.report.needsHost, true);
    assert.ok(failed.report.summary || failed.report.answer);
    assert.equal(failed.executionAccounting.status, 'gap');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
