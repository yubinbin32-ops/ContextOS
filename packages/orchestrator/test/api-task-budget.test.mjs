import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendRoleUsage } from '../src/role-usage-ledger.mjs';
import { acquireApiTaskBudget } from '../src/api-task-budget.mjs';

const workspace = () => fs.mkdtemp(path.join(os.tmpdir(), 'os-api-task-budget-'));
const budget = (taskId, limits) => ({ id: `budget-${taskId}`, taskId, limits });

async function append(root, taskId, requestId, overrides = {}) {
  return appendRoleUsage(root, {
    role: 'api-micro', taskId, requestId, provider: 'fixture', model: 'fixture-model',
    requestedModel: 'fixture-model', providerLaunches: 1, startedAt: '2026-10-02T00:00:00.000Z',
    durationMs: 125, status: 'completed',
    usage: { inputTokens: 11, cachedInputTokens: 3, uncachedInputTokens: 8, outputTokens: 4, reportedTotalTokens: 15 },
    ...overrides,
  });
}

test('task budget is default-off and an empty scoped ledger is an observed zero baseline', async () => {
  const root = await workspace();
  try {
    const disabled = await acquireApiTaskBudget({ projectRoot: root });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.allowed, true);
    assert.equal(typeof disabled.finish, 'function');

    const fresh = await acquireApiTaskBudget({ projectRoot: root,
      budget: budget('empty-ledger', { requests: 1, rawTokens: 20 }) });
    assert.equal(fresh.allowed, true);
    assert.deepEqual(fresh.observed, { requests: 0, inputTokens: 0, uncachedInputTokens: 0, outputTokens: 0, rawTokens: 0, seconds: 0 });
    fresh.finish({ providerLaunches: 0, usageRecorded: false });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('completed usage at any configured admission line blocks the next dispatch', async () => {
  const root = await workspace();
  const taskId = 'positive-observed';
  try {
    const admitted = await acquireApiTaskBudget({ projectRoot: root,
      budget: budget(taskId, { requests: 2, inputTokens: 11, uncachedInputTokens: 8, outputTokens: 4, rawTokens: 15, seconds: 1 }) });
    assert.equal(admitted.allowed, true);
    assert.match(admitted.requestId, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(admitted.observed, { requests: 0, inputTokens: 0, uncachedInputTokens: 0, outputTokens: 0, rawTokens: 0, seconds: 0 });
    await append(root, taskId, admitted.requestId);
    admitted.finish({ providerLaunches: 1, usageRecorded: true });

    const blocked = await acquireApiTaskBudget({ projectRoot: root,
      budget: budget(taskId, { requests: 1, inputTokens: 11, uncachedInputTokens: 8, outputTokens: 4, rawTokens: 15, seconds: 0.125 }) });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.errorCode, 'API_MICRO_BUDGET_EXHAUSTED');
    assert.match(blocked.error, /requests admission limit is reached/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('observed token and request-duration limits are checked independently', async (t) => {
  await t.test('input token threshold', async () => {
    const root = await workspace();
    const taskId = 'input-threshold';
    try {
      await append(root, taskId, 'input-observed');
      const result = await acquireApiTaskBudget({ projectRoot: root,
        budget: budget(taskId, { requests: 5, inputTokens: 11 }) });
      assert.equal(result.errorCode, 'API_MICRO_BUDGET_EXHAUSTED');
      assert.match(result.error, /inputTokens admission limit is reached/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  await t.test('recorded API duration threshold', async () => {
    const root = await workspace();
    const taskId = 'duration-threshold';
    try {
      await append(root, taskId, 'duration-observed');
      const result = await acquireApiTaskBudget({ projectRoot: root,
        budget: budget(taskId, { requests: 5, seconds: 0.125 }) });
      assert.equal(result.errorCode, 'API_MICRO_BUDGET_EXHAUSTED');
      assert.match(result.error, /seconds admission limit is reached/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

test('explicit measured zero remains distinct from missing usage', async () => {
  const root = await workspace();
  const taskId = 'known-zero';
  try {
    await append(root, taskId, 'zero-request', {
      providerLaunches: 0, durationMs: 0, status: 'local_failed',
      usage: { inputTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0, outputTokens: 0, reportedTotalTokens: 0 },
    });
    const result = await acquireApiTaskBudget({ projectRoot: root,
      budget: budget(taskId, { requests: 1, inputTokens: 10, uncachedInputTokens: 10, outputTokens: 10, rawTokens: 10, seconds: 1 }) });
    assert.equal(result.allowed, true);
    assert.deepEqual(result.observed, { requests: 0, inputTokens: 0, uncachedInputTokens: 0, outputTokens: 0, rawTokens: 0, seconds: 0 });
    result.finish({ providerLaunches: 0, usageRecorded: false });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('unknown token metrics and conflicting ledger evidence fail closed', async (t) => {
  await t.test('unknown', async () => {
    const root = await workspace();
    const taskId = 'unknown-metric';
    try {
      await append(root, taskId, 'unknown-request', { usage: { inputTokens: null, outputTokens: null }, providerLaunches: 1 });
      const result = await acquireApiTaskBudget({ projectRoot: root, budget: budget(taskId, { inputTokens: 100 }) });
      assert.equal(result.errorCode, 'API_MICRO_ACCOUNTING_UNKNOWN');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  await t.test('unknown provider launch count', async () => {
    const root = await workspace();
    const taskId = 'unknown-launches';
    try {
      await append(root, taskId, 'launch-count-unknown', { providerLaunches: null });
      const result = await acquireApiTaskBudget({ projectRoot: root, budget: budget(taskId, { requests: 10 }) });
      assert.equal(result.errorCode, 'API_MICRO_ACCOUNTING_UNKNOWN');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  await t.test('conflict', async () => {
    const root = await workspace();
    const taskId = 'conflict';
    try {
      await append(root, taskId, 'same-request');
      await append(root, taskId, 'same-request', { usage: { inputTokens: 12, cachedInputTokens: 3, uncachedInputTokens: 9, outputTokens: 4, reportedTotalTokens: 16 } });
      const result = await acquireApiTaskBudget({ projectRoot: root, budget: budget(taskId, { requests: 5 }) });
      assert.equal(result.errorCode, 'API_MICRO_ACCOUNTING_UNKNOWN');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

test('same-scope admissions queue, then re-read the ledger before allowing another request', async () => {
  const root = await workspace();
  const taskId = 'serialized';
  try {
    const limits = { requests: 1 };
    const first = await acquireApiTaskBudget({ projectRoot: root, budget: budget(taskId, limits) });
    let secondSettled = false;
    const secondPromise = acquireApiTaskBudget({ projectRoot: root, budget: budget(taskId, limits) })
      .then((result) => { secondSettled = true; return result; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secondSettled, false, 'the second caller waits rather than racing the first HTTP request');

    await append(root, taskId, first.requestId);
    first.finish({ providerLaunches: 1, usageRecorded: true });
    const second = await secondPromise;
    assert.equal(second.errorCode, 'API_MICRO_BUDGET_EXHAUSTED');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('an unrecorded launched request makes later admission unknown', async () => {
  const root = await workspace();
  const taskId = 'recording-gap';
  try {
    const first = await acquireApiTaskBudget({ projectRoot: root, budget: budget(taskId, { requests: 5 }) });
    first.finish({ providerLaunches: 1, usageRecorded: false });
    const next = await acquireApiTaskBudget({ projectRoot: root, budget: budget(taskId, { requests: 5 }) });
    assert.equal(next.errorCode, 'API_MICRO_ACCOUNTING_UNKNOWN');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('malformed ledger is not treated as zero usage', async () => {
  const root = await workspace();
  const ledgerPath = path.join(root, '.contextos', 'logs', 'role-usage.jsonl');
  try {
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
    await fs.writeFile(ledgerPath, '{invalid\n');
    const result = await acquireApiTaskBudget({ projectRoot: root, budget: budget('malformed', { requests: 1 }) });
    assert.equal(result.errorCode, 'API_MICRO_ACCOUNTING_UNKNOWN');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
