import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  claimMicroDeliveries,
  completeMicroDeliveryClaims,
  createMicroJob,
  enqueueMicroDelivery,
  listMicroJobs,
  readMicroJob,
  renderMicroDeliveries,
  reportMicroJob,
  updateMicroJob,
} from '../src/micro-delivery.mjs';
import { projectMicroResult } from '../src/response-budget.mjs';
import { Orchestrator } from '../src/index.mjs';
import { ContextOSV2Service } from '../../mcp/src/v2-service.mjs';

function tempProject(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, '.contextos'), { recursive: true });
  return root;
}

test('Micro delivery queues a result once and recovers it on the next OS call', () => {
  const root = tempProject('contextos-micro-delivery-');
  try {
    const queued = projectMicroResult({
      ok: true,
      receiptId: 'micro-deferred-1',
      preset: 'triage',
      delivery: 'defer',
      content: 'deferred root cause',
      providerUsage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      usageSource: 'provider',
    }, { projectRoot: root });
    assert.equal(queued.ok, true);
    assert.equal(queued.delivery, 'deferred');

    const duplicate = enqueueMicroDelivery(root, {
      deliveryId: 'micro-deferred-1',
      receiptId: 'micro-deferred-1',
      content: 'deferred root cause',
    });
    assert.equal(duplicate.duplicate, true);

    const claims = claimMicroDeliveries(root, { maxItems: 3, maxChars: 1000 });
    assert.equal(claims.length, 1);
    assert.equal(claims[0].content, 'deferred root cause');
    assert.match(renderMicroDeliveries(claims), /micro-deferred-1/);
    completeMicroDeliveryClaims(root, claims.map((item) => item.deliveryId));
    assert.deepEqual(claimMicroDeliveries(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Micro background jobs persist running and terminal state', () => {
  const root = tempProject('contextos-micro-job-');
  try {
    const created = createMicroJob(root, { jobId: 'job-1', preset: 'triage' });
    assert.equal(created.created, true);
    assert.equal(readMicroJob(root, 'job-1').status, 'running');
    assert.deepEqual(
      listMicroJobs(root, { status: 'running' }).map((job) => job.jobId),
      ['job-1'],
    );

    const completed = updateMicroJob(root, 'job-1', {
      status: 'completed',
      receiptId: 'micro-job-1',
      delivery: 'deferred',
    });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.receiptId, 'micro-job-1');
    assert.deepEqual(listMicroJobs(root, { status: 'running' }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('worker reports update job state without forcing host attention for informational changes', () => {
  const root = tempProject('contextos-micro-report-');
  try {
    createMicroJob(root, { jobId: 'job-report' });
    const changes = reportMicroJob(root, 'job-report', {
      summary: 'changed files', changes: ['src/a.mjs'], checks: [], blockers: [], question: '',
    });
    assert.equal(changes.queued, true);
    const changesJob = readMicroJob(root, 'job-report');
    assert.equal(changesJob.report.needsHost, false);
    assert.equal(changesJob.report.needsHostReason, 'changes');
    assert.equal(changesJob.report.waitingForHost, false);

    const question = reportMicroJob(root, 'job-report', JSON.stringify({
      summary: 'need a decision', changes: [], checks: [], blockers: [], question: 'A or B?',
    }));
    assert.equal(question.queued, true);
    const questionJob = readMicroJob(root, 'job-report');
    assert.equal(questionJob.report.needsHost, true);
    assert.equal(questionJob.report.needsHostReason, 'question');
    assert.equal(questionJob.report.waitingForHost, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Orchestrator attaches deferred Micro results to the next top-level OS response', async () => {
  const root = tempProject('contextos-micro-delivery-orchestrator-');
  try {
    projectMicroResult({
      ok: true,
      receiptId: 'micro-next-os',
      delivery: 'defer',
      content: 'answer for the next host decision',
    }, { projectRoot: root });
    const orchestrator = new Orchestrator({
      projectRoot: root,
      projectId: 'micro-delivery-orchestrator',
      service: {
        projectId: 'micro-delivery-orchestrator',
        osContext: async () => ({}),
        syncEngine: { publishIfDirty() {} },
      },
    });
    const response = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'session',
      action: 'resume',
    }));
    assert.equal(response.microRecovered[0].receiptId, 'micro-next-os');
    assert.equal(response.microRecovered[0].content, 'answer for the next host decision');
    assert.deepEqual(claimMicroDeliveries(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('auto needsHost=true is recovered once by the next top-level OS call', async () => {
  const root = tempProject('contextos-micro-delivery-auto-top-level-');
  try {
    const projected = projectMicroResult({
      ok: true,
      receiptId: 'micro-auto-next-top-level',
      delivery: 'auto',
      needsHost: true,
      content: 'host decision is required',
    }, { projectRoot: root });
    assert.equal(projected.delivery, 'deferred');

    const orchestrator = new Orchestrator({ projectRoot: root, projectId: 'auto-top-level', service: {} });
    const internal = await orchestrator._context().orchestrator.dispatch('ops', {
      capability: 'session',
      action: 'resume',
    });
    assert.doesNotMatch(internal, /micro-auto-next-top-level/);
    const first = await orchestrator.dispatch('ops', {
      capability: 'session',
      action: 'resume',
    });
    assert.match(first, /micro-auto-next-top-level/);

    const second = await orchestrator.dispatch('ops', {
      capability: 'session',
      action: 'resume',
    });
    assert.doesNotMatch(second, /micro-auto-next-top-level/);
    assert.deepEqual(claimMicroDeliveries(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('top-level exceptions release claimed Micro results without loss or duplication', async () => {
  const root = tempProject('contextos-micro-delivery-exception-');
  try {
    projectMicroResult({
      ok: true,
      receiptId: 'micro-exception-recovery',
      delivery: 'defer',
      content: 'must survive a failed host call',
    }, { projectRoot: root });
    const orchestrator = new Orchestrator({ projectRoot: root, projectId: 'exception-recovery', service: {} });
    await assert.rejects(
      () => orchestrator.dispatch('ops', { capability: 'unknown-capability', action: 'explode' }),
      /Unknown capability/
    );

    const recovered = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'session',
      action: 'resume',
    }));
    assert.deepEqual(recovered.microRecovered.map((item) => item.receiptId), ['micro-exception-recovery']);
    const next = await orchestrator.dispatch('ops', {
      capability: 'session',
      action: 'resume',
    });
    assert.doesNotMatch(next, /micro-exception-recovery/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('re-projecting a consumed deferred result is idempotent', () => {
  const root = tempProject('contextos-micro-delivery-idempotent-');
  try {
    const result = {
      ok: true,
      receiptId: 'micro-consumed-once',
      delivery: 'defer',
      content: 'one answer only',
    };
    projectMicroResult(result, { projectRoot: root });
    const pendingDuplicate = projectMicroResult(result, { projectRoot: root });
    assert.equal(pendingDuplicate.duplicate, true);
    assert.equal(pendingDuplicate.delivered, undefined);
    const claim = claimMicroDeliveries(root);
    assert.equal(claim.length, 1);
    completeMicroDeliveryClaims(root, claim.map((item) => item.deliveryId));

    const duplicate = projectMicroResult(result, { projectRoot: root });
    assert.equal(duplicate.delivery, 'deferred');
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.delivered, true);
    assert.deepEqual(claimMicroDeliveries(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Micro auto delivery hides independent success and defers only an answer the host needs', () => {
  const root = tempProject('contextos-micro-auto-delivery-');
  try {
    const hidden = projectMicroResult({
      ok: true,
      receiptId: 'micro-auto-hidden',
      delivery: 'auto',
      needsHost: false,
      content: 'irrelevant success prose',
    }, { projectRoot: root });
    assert.equal(hidden.ok, true);
    assert.equal(hidden.delivery, 'success-hidden');
    assert.equal(hidden.needsHost, false);

    const deferred = projectMicroResult({
      ok: true,
      receiptId: 'micro-auto-deferred',
      delivery: 'auto',
      needsHost: true,
      content: 'the host needs this finding',
    }, { projectRoot: root });
    assert.equal(deferred.ok, true);
    assert.equal(deferred.delivery, 'deferred');
    assert.equal(claimMicroDeliveries(root).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('late read-only Micro evidence is not skipped when withOS is explicit', async () => {
  const root = tempProject('contextos-micro-late-with-os-');
  fs.writeFileSync(path.join(root, '.contextos', 'profile.json'), JSON.stringify({
    micro: { url: 'http://127.0.0.1:1/v1', model: 'unreachable-test-model', timeoutMs: 100 },
  }));
  const service = new ContextOSV2Service({ projectRoot: root, projectId: 'late-with-os' });
  try {
    const orchestrator = new Orchestrator({ service, projectRoot: root, projectId: 'late-with-os' });
    await orchestrator.dispatch('change', {
      edits: [{ path: 'src/late.mjs', fullFile: true, replacement: 'export const late = true;\n' }],
    });
    await orchestrator.dispatch('verify', { command: 'node --check src/late.mjs' });

    const result = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'micro',
      action: 'run',
      args: {
        preset: 'evidence',
        task: 'perform an explicit OS-assisted post-verify audit',
        withOS: true,
        pipeline: { steps: [{ inspect: { path: 'src/late.mjs' } }], maxChars: 1200 },
      },
    }));
    assert.notEqual(result.reason, 'late-read-only-evidence');
    assert.equal(result.ok, false);
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Micro errors-only hides successful non-graph work and exposes failed tool calls', () => {
  const root = tempProject('contextos-micro-errors-only-');
  try {
    const missingWrite = projectMicroResult({
      ok: true,
      receiptId: 'micro-errors-missing',
      delivery: 'errors-only',
      content: 'I inspected the graph',
      toolCalls: [],
    }, { projectRoot: root });
    assert.equal(missingWrite.ok, true);
    assert.equal(missingWrite.delivery, 'success-hidden');

    const failedWrite = projectMicroResult({
      ok: true,
      receiptId: 'micro-errors-failed',
      delivery: 'errors-only',
      content: 'write failed',
      toolCalls: [{
        name: 'block',
        arguments: JSON.stringify({ action: 'bind_auto' }),
        preview: JSON.stringify({ ok: false, error: 'stale anchor' }),
        ok: false,
      }],
    }, { projectRoot: root });
    assert.equal(failedWrite.ok, false);
    assert.equal(failedWrite.delivery, 'error');
    assert.match(failedWrite.error, /stale anchor/);

    const successfulWrite = projectMicroResult({
      ok: true,
      receiptId: 'micro-errors-success',
      delivery: 'errors-only',
      content: 'OK',
      toolCalls: [{
        name: 'chain',
        arguments: JSON.stringify({ action: 'compose' }),
        preview: JSON.stringify({ ok: true, result: 'Chain composed' }),
        ok: true,
      }],
    }, { projectRoot: root });
    assert.equal(successfulWrite.ok, true);
    assert.equal(successfulWrite.delivery, 'success-hidden');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
