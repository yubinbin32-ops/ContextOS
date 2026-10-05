import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { executeAgent } from '../src/agent-service.mjs';
import { claimMicroDeliveries, createMicroJob, cancellationMarkerPath, enqueueMicroDelivery, readMicroJob, reportMicroJob, updateMicroJob } from '../src/micro-delivery.mjs';
import { sendMicroMessage, receiveMicroMessages } from '../src/micro-mailbox.mjs';

process.env.CONTEXTOS_AGENT_INPROCESS = '1';

test('CLI is pinned, source is not read by the dispatcher, and only structured report is returned', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-service-'));
  const usage = []; let count = 0;
  try {
    const opts = { projectRoot: root, name: 'worker', adapter: { command: 'worker', model: 'capable', cli: { output: {
      usage: {
        input: 'input_tokens', output: 'output_tokens', inputIncludesCache: false,
      },
      contextUsage: { input: 'input_tokens', cache: 'cache_read_tokens', window: 233000, inputIncludesCache: false },
    } } }, onUsage: (row) => usage.push(row),
      runner: async (config, args) => {
        count++; assert.equal(config.provider, 'cli'); assert.equal(args.provider, 'cli');
        return { ok: true, provider: 'cli-provider', actualModel: 'worker-actual', content: 'private execution flow',
          invocation: { providerLaunches: 1 }, agentReport: { summary: 'fixed', changes: [], checks: [], blockers: [], needsHost: true },
          contextUsage: { percent: 37.25, usedTokens: 86845, windowTokens: 233000, source: 'derived' },
          usageRaw: { input_tokens: 100, output_tokens: 20 }, providerUsage: { input_tokens: 100, output_tokens: 20 } };
      },
    };
    const first = await executeAgent({ task: 'bounded task', id: 'agent-once' }, opts);
    const replay = await executeAgent({ action: 'get', id: first.id }, opts);
    assert.equal(first.status, 'completed'); assert.deepEqual(first, replay); assert.equal(count, 1);
    assert.equal(first.report.summary, 'fixed');
    assert.deepEqual(first.report.cliUsage, { percent: 37.3, usedTokens: 86845, windowTokens: 233000, source: 'derived' });
    assert.deepEqual(replay.report.cliUsage, first.report.cliUsage);
    assert.ok(!JSON.stringify(first).includes('private execution flow'));
    assert.equal(usage.length, 1);
    assert.equal(usage[0].role, 'cli-agent'); assert.equal(usage[0].evidenceScope, 'task-aggregate');
    assert.equal(usage[0].provider, 'cli-provider');
    assert.equal(usage[0].requestedModel, 'capable'); assert.equal(usage[0].actualModel, 'worker-actual');
    assert.equal(usage[0].providerLaunches, 1);
    assert.equal(first.usageAccounting.status, 'recorded');
    assert.equal(readMicroJob(root, first.id).usageReceipt.usage.inputTokens, 100);
    assert.equal(readMicroJob(root, first.id).usageReceipt.usage.uncachedInputTokens, 100);
    assert.equal(readMicroJob(root, first.id).usageReceipt.usage.outputTokens, 20);
    assert.deepEqual(readMicroJob(root, first.id).cliUsage, first.report.cliUsage);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('resumed CLI sessions bill the invocation delta instead of cumulative provider usage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-service-'));
  const usage = [];
  try {
    const adapter = { command: 'worker', model: 'capable', cli: { output: { usage: {
      input: 'input_tokens', output: 'output_tokens', inputIncludesCache: false,
    } } } };
    const result = await executeAgent({ task: 'resume bounded task', id: 'agent-resume-delta' }, {
      projectRoot: root, name: 'worker', adapter, onUsage: (row) => usage.push(row),
      runner: async () => ({
        ok: true, actualModel: 'capable', content: 'done', invocation: { providerLaunches: 1 },
        agentReport: { summary: 'resumed', changes: [], checks: [], blockers: [], needsHost: false },
        usageRaw: { input_tokens: 109210, output_tokens: 7900 },
        usage: {
          prompt_tokens: 69951, completion_tokens: 6418, total_tokens: 76369,
          cached_input_tokens: 0, uncached_input_tokens: 69951, reasoning_tokens: 1200,
        },
      }),
    });
    assert.equal(result.status, 'completed');
    assert.equal(usage.length, 1);
    assert.equal(usage[0].usage.inputTokens, 69951, 'the delta mapping must not drop input tokens');
    assert.equal(usage[0].usage.uncachedInputTokens, 69951, 'cumulative resume totals must not be billed twice');
    assert.equal(usage[0].usage.outputTokens, 6418);
    assert.equal(usage[0].usage.reasoningTokens, 1200);
    assert.equal(usage[0].usage.reportedTotalTokens, null, 'a cumulative provider total is not a delta total');
    assert.deepEqual(usage[0].providerReportedUsage, { input_tokens: 109210, output_tokens: 7900 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('agent receives the private API evidence binding internally, including through batch, without exposing it in results', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-service-'));
  const apiMicro = { provider: 'private-provider', model: 'private-model', apiKey: 'do-not-return' };
  const seen = [];
  try {
    const result = await executeAgent({ action: 'batch', tasks: [{ id: 'agent-api-binding', task: 'bounded task' }] }, {
      projectRoot: root, roles: { micro: apiMicro }, name: 'worker', adapter: { command: 'worker', model: 'requested' },
      runner: async (_config, args) => {
        seen.push({ evidenceBroker: args.evidenceBroker, apiMicro: args.apiMicro });
        return { ok: true, invocation: { providerLaunches: 0 }, agentReport: { summary: 'done', needsHost: false } };
      },
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(seen, [{ evidenceBroker: true, apiMicro }]);
    assert.ok(!JSON.stringify(result).includes('do-not-return'));
    const stored = await executeAgent({ action: 'get', id: 'agent-api-binding' }, { projectRoot: root });
    assert.ok(!JSON.stringify(stored).includes('do-not-return'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('usage ledger provider stays a string when the configured CLI command is an argv array', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-service-'));
  const usage = [];
  try {
    await executeAgent({ task: 'bounded task', id: 'agent-array-command' }, {
      projectRoot: root, name: 'worker', adapter: { command: ['/opt/tools/worker-cli', '--json'], model: 'requested' },
      onUsage: (row) => usage.push(row),
      runner: async () => ({ ok: true, providerLaunches: 1, providerUsage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        agentReport: { summary: 'done', needsHost: false } }),
    });
    assert.equal(usage.length, 1);
    assert.equal(usage[0].provider, '/opt/tools/worker-cli');
    assert.equal(typeof usage[0].provider, 'string');
    const saved = readMicroJob(root, 'agent-array-command').usageReceipt;
    assert.equal(saved.usage, null);
    assert.deepEqual(saved.unmappedProviderUsage, { input_tokens: 3, output_tokens: 2, total_tokens: 5 });
    assert.equal(saved.providerReportedTotalTokens, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('failed returned CLI results preserve partial usage exactly once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-service-'));
  const usage = [];
  try {
    const result = await executeAgent({ task: 'bounded task', id: 'agent-returned-failure' }, {
      projectRoot: root, name: 'worker', adapter: { command: 'worker', model: 'requested', cli: { output: { usage: {
        input: 'input_tokens', output: 'output_tokens', inputIncludesCache: false,
      } } } }, onUsage: (row) => usage.push(row),
      runner: async () => ({ ok: false, error: 'CLI terminal rejected the task', usageRaw: { input_tokens: 30, output_tokens: 4 },
        providerUsage: { input_tokens: 30, output_tokens: 4 },
        providerUsageComplete: false, invocation: { providerLaunches: 1 }, actualModel: 'actual' }),
    });
    assert.equal(result.status, 'failed');
    assert.equal(usage.length, 1);
    assert.equal(usage[0].status, 'failed');
    assert.equal(usage[0].usage.inputTokens, 30);
    assert.equal(usage[0].usage.uncachedInputTokens, 30);
    assert.equal(usage[0].requestedModel, 'requested');
    assert.equal(usage[0].actualModel, 'actual');
    assert.equal(readMicroJob(root, result.id).usageReceipt.usage.outputTokens, 4);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('flat CLI role adapters retain failed terminal usage without double-counting thinking tokens', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-service-'));
  const usage = [];
  const terminalUsage = {
    input_tokens: 15951,
    output_tokens: 2810,
    thinking_tokens: 2681,
    cache_read_tokens: 0,
    total_tokens: 18761,
  };
  try {
    const result = await executeAgent({ task: 'bounded task', id: 'agy-terminal-denied' }, {
      projectRoot: root,
      name: 'agy',
      adapter: {
        command: 'agy',
        model: 'gemini-3.8-flash-high',
        output: { usage: {
          path: 'usage', input: 'input_tokens', output: 'output_tokens', cache: 'cache_read_tokens',
          reasoning: 'thinking_tokens', total: 'total_tokens',
          inputIncludesCache: true, reasoningIncludedInOutput: true,
        } },
      },
      onUsage: (row) => usage.push(row),
      runner: async () => ({
        ok: false,
        error: 'The CLI denied a required action; its success label does not establish completion.',
        provider: 'agy',
        actualModel: 'gemini-3.8-flash-high',
        requestedModel: 'gemini-3.8-flash-high',
        providerLaunches: 1,
        usageRaw: terminalUsage,
        providerUsage: {
          input_tokens: 15951, output_tokens: 2810, thinking_tokens: 2681,
          cache_read_tokens: 0, total_tokens: 18761,
        },
        providerUsageComplete: false,
        deniedActions: [{ action: 'RunCommand' }],
      }),
    });

    const saved = readMicroJob(root, result.id);
    assert.equal(result.status, 'failed');
    assert.equal(saved.status, 'failed');
    assert.equal(saved.report.needsHost, true);
    assert.deepEqual(result.deniedActions, [{ action: 'RunCommand' }]);
    assert.match(saved.report.blockers[0], /Permission denied.*RunCommand/);
    assert.equal(saved.usageReceipt.status, 'failed');
    assert.equal(saved.usageReceipt.actualModel, 'gemini-3.8-flash-high');
    assert.deepEqual(saved.usageReceipt.usage, {
      inputTokens: 15951, cachedInputTokens: 0, uncachedInputTokens: 15951,
      outputTokens: 2810, reasoningTokens: 2681, reportedTotalTokens: 18761,
    });
    assert.deepEqual(saved.usageReceipt.usageRaw, terminalUsage);
    assert.deepEqual(saved.usageReceipt.providerReportedUsage, terminalUsage);
    assert.equal(saved.usageReceipt.providerReportedTotalTokens, 18761);
    assert.equal(saved.usageReceipt.unmappedProviderUsage, null);
    assert.equal(saved.providerUsageComplete, false);
    assert.equal(usage.length, 1);
    assert.equal(usage[0].status, 'failed');
    assert.deepEqual(usage[0].usage, saved.usageReceipt.usage);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('CLI usage receipt stores provider raw usage separately and only trusts an explicitly mapped total', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-service-'));
  const usage = [];
  const rawUsage = { input: 20, cache: 6, output: 10, reasoning: 4, total: 36 };
  try {
    const result = await executeAgent({ task: 'bounded task', id: 'agent-raw-usage' }, {
      projectRoot: root, name: 'worker', adapter: { command: 'worker', model: 'requested', cli: { output: { usage: {
        input: 'input', cache: 'cache', output: 'output', reasoning: 'reasoning', total: 'total',
        inputIncludesCache: false, reasoningIncludedInOutput: true,
      } } } }, onUsage: (row) => usage.push(row),
      runner: async () => ({ ok: true, providerLaunches: 1, actualModel: 'actual', usageRaw: rawUsage,
        providerUsage: { prompt_tokens: 26, completion_tokens: 10, total_tokens: 36 },
        agentReport: { summary: 'done', needsHost: false } }),
    });
    const saved = readMicroJob(root, result.id).usageReceipt;
    assert.deepEqual(saved.usage, {
      inputTokens: 26, cachedInputTokens: 6, uncachedInputTokens: 20,
      outputTokens: 10, reasoningTokens: 4, reportedTotalTokens: 36,
    });
    assert.deepEqual(saved.usageRaw, rawUsage);
    assert.deepEqual(saved.providerReportedUsage, rawUsage);
    assert.equal(saved.providerReportedTotalTokens, 36);
    assert.deepEqual(usage[0].usage, saved.usage);
    assert.equal(usage[0].requestedModel, 'requested');
    assert.equal(usage[0].actualModel, 'actual');

    const noMappedTotal = await executeAgent({ task: 'bounded task', id: 'agent-unmapped-total' }, {
      projectRoot: root, name: 'worker', adapter: { command: 'worker', model: 'requested', cli: { output: { usage: {
        input: 'input', cache: 'cache', output: 'output', reasoning: 'reasoning',
        inputIncludesCache: false, reasoningIncludedInOutput: true,
      } } } },
      runner: async () => ({ ok: true, providerLaunches: 0, usageRaw: rawUsage,
        providerUsage: { prompt_tokens: 26, completion_tokens: 10, total_tokens: 36 },
        agentReport: { summary: 'done', needsHost: false } }),
    });
    const unmapped = readMicroJob(root, noMappedTotal.id).usageReceipt;
    assert.equal(unmapped.usage.reportedTotalTokens, null);
    assert.equal(unmapped.providerReportedTotalTokens, null);
    assert.equal(unmapped.providerReportedUsage.total, 36);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('thrown CLI errors retain observed usage without a duplicate meter callback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-service-'));
  const usage = [];
  try {
    const error = new Error('runner terminated after provider response');
    error.usage = { input_tokens: 41, output_tokens: 9 };
    error.usageRaw = { input_tokens: 41, output_tokens: 9 };
    error.invocation = { providerLaunches: 1 };
    error.actualModel = 'actual-after-error';
    const result = await executeAgent({ task: 'bounded task', id: 'agent-thrown-failure' }, {
      projectRoot: root, name: 'worker', adapter: { command: 'worker', model: 'requested-before-error', cli: { output: { usage: {
        input: 'input_tokens', output: 'output_tokens', inputIncludesCache: false,
      } } } },
      onUsage: (row) => usage.push(row), runner: async () => { throw error; },
    });
    assert.equal(result.status, 'failed');
    assert.equal(usage.length, 1);
    assert.equal(usage[0].status, 'failed');
    assert.deepEqual(usage[0].usage, {
      inputTokens: 41, cachedInputTokens: null, uncachedInputTokens: 41,
      outputTokens: 9, reasoningTokens: null, reportedTotalTokens: null,
    });
    assert.equal(usage[0].providerLaunches, 1);
    assert.equal(usage[0].requestedModel, 'requested-before-error');
    assert.equal(usage[0].actualModel, 'actual-after-error');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('usage ledger failure is an independent gap and cannot fail a persisted successful CLI result', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-service-'));
  try {
    const result = await executeAgent({ task: 'bounded task', id: 'agent-meter-gap' }, {
      projectRoot: root, name: 'worker',
      onUsage: async () => { throw new Error('disk unavailable'); },
      adapter: { command: 'worker', model: 'requested', cli: { output: { usage: {
        input: 'input_tokens', output: 'output_tokens', inputIncludesCache: false,
      } } } },
      runner: async () => ({ ok: true, content: 'done', invocation: { providerLaunches: 1 }, actualModel: 'actual',
        usageRaw: { input_tokens: 80, output_tokens: 10 }, providerUsage: { input_tokens: 80, output_tokens: 10 },
        agentReport: { summary: 'done', changes: [], checks: [], blockers: [], needsHost: false } }),
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.usageAccounting.status, 'gap');
    assert.equal(result.usageAccounting.evidencePersistedInJob, true);
    const stored = readMicroJob(root, result.id);
    assert.equal(stored.status, 'completed');
    assert.equal(stored.usageReceipt.usage.inputTokens, 80);
    assert.equal(stored.usageReceipt.usage.uncachedInputTokens, 80);
    assert.equal(stored.usageAccounting.status, 'gap');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('providerLaunches zero is retained as no-launch and is not metered as a provider call', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-service-'));
  let meterCalls = 0;
  try {
    const result = await executeAgent({ task: 'bounded task', id: 'agent-no-launch' }, {
      projectRoot: root, name: 'worker', adapter: { command: 'worker', model: 'requested' },
      onUsage: () => { meterCalls += 1; },
      runner: async () => ({ ok: false, error: 'configuration rejected before launch', providerUsage: null,
        invocation: { providerLaunches: 0 } }),
    });
    assert.equal(result.status, 'failed');
    assert.equal(meterCalls, 0);
    assert.equal(readMicroJob(root, result.id).usageReceipt.providerLaunches, 0);
    assert.equal(result.usageAccounting.status, 'not-launched');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('unknown provider launch count and usage stay unknown in the single task receipt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-service-'));
  const usage = [];
  try {
    const result = await executeAgent({ task: 'bounded task', id: 'agent-unknown-launch' }, {
      projectRoot: root, name: 'worker', adapter: { command: 'worker', model: 'requested' }, onUsage: (row) => usage.push(row),
      runner: async () => ({ ok: false, error: 'transport ended without a terminal receipt', providerUsage: null }),
    });
    assert.equal(result.status, 'failed');
    assert.equal(usage.length, 1);
    assert.equal(usage[0].providerLaunches, null);
    assert.equal(usage[0].usage, null);
    assert.equal(readMicroJob(root, result.id).usageReceipt.usage, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('zero launch with contradictory usage is retained as a metering gap, not counted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-service-'));
  let meterCalls = 0;
  try {
    const result = await executeAgent({ task: 'bounded task', id: 'agent-no-launch-usage' }, {
      projectRoot: root, name: 'worker', adapter: { command: 'worker', model: 'requested' },
      onUsage: () => { meterCalls += 1; },
      runner: async () => ({ ok: false, error: 'configuration rejected before launch', providerUsage: { input_tokens: 5 },
        invocation: { providerLaunches: 0 } }),
    });
    assert.equal(meterCalls, 0);
    assert.equal(result.usageAccounting.status, 'gap');
    assert.equal(readMicroJob(root, result.id).usageReceipt.usage, null);
    assert.deepEqual(readMicroJob(root, result.id).usageReceipt.unmappedProviderUsage, { input_tokens: 5 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('delivery modes queue only when their contract requires host delivery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-service-'));
  const pendingIds = () => {
    try { return JSON.parse(fs.readFileSync(path.join(root, '.contextos/micro-deliveries/queue.json'), 'utf8')).pending.map((item) => item.deliveryId); }
    catch { return []; }
  };
  const run = async ({ id, delivery, ok = true, needsHost = false, background = false }) => executeAgent({
    task: 'bounded task', id, delivery, background,
  }, {
    projectRoot: root, name: 'worker', adapter: { command: 'worker', model: 'requested' },
    runner: async (_config, args) => ({ ok, error: ok ? null : 'task failed', content: ok ? 'done' : 'failed',
      invocation: { providerLaunches: 0 }, delivery: args.delivery,
      agentReport: { summary: ok ? 'done' : 'failed', changes: [], checks: [], blockers: [], needsHost } }),
  });
  try {
    const immediate = await run({ id: 'delivery-immediate', delivery: 'immediate' });
    assert.equal(immediate.status, 'completed');
    assert.equal(immediate.report.summary, 'done');
    assert.equal(pendingIds().includes('delivery-immediate'), false);

    const deferred = await run({ id: 'delivery-defer', delivery: 'defer' });
    assert.equal(deferred.status, 'completed');
    assert.equal(deferred.report, null);
    assert.equal(deferred.deliveryStatus, 'deferred');
    assert.equal(pendingIds().includes('delivery-defer'), true);
    const deferredGet = await executeAgent({ action: 'get', id: 'delivery-defer' }, { projectRoot: root });
    assert.equal(deferredGet.report.summary, 'done');

    const autoQuiet = await run({ id: 'delivery-auto-quiet', delivery: 'auto', needsHost: false });
    assert.equal(autoQuiet.report.summary, 'done');
    assert.equal(pendingIds().includes('delivery-auto-quiet'), false);
    const autoHost = await run({ id: 'delivery-auto-host', delivery: 'auto', needsHost: true });
    assert.equal(autoHost.report, null);
    assert.equal(autoHost.deliveryStatus, 'deferred');
    assert.equal(pendingIds().includes('delivery-auto-host'), true);

    const quietSuccess = await run({ id: 'delivery-errors-success', delivery: 'errors-only' });
    assert.equal(quietSuccess.report, null);
    assert.equal(quietSuccess.deliveryStatus, 'quiet-success');
    assert.equal(pendingIds().includes('delivery-errors-success'), false);
    await run({ id: 'delivery-errors-failure', delivery: 'errors-only', ok: false });
    assert.equal(pendingIds().includes('delivery-errors-failure'), true);

    await executeAgent({ task: 'bounded task', id: 'delivery-already-queued', delivery: 'defer' }, {
      projectRoot: root, name: 'worker', adapter: { command: 'worker', model: 'requested' },
      runner: async (_config, args) => {
        enqueueMicroDelivery(root, { deliveryId: args.agentJobId, receiptId: args.agentJobId, content: 'earlier report' });
        return { ok: true, content: 'done', invocation: { providerLaunches: 0 }, agentReport: {
          summary: 'done', changes: [], checks: [], blockers: [], needsHost: false,
        } };
      },
    });
    assert.equal(pendingIds().filter((id) => id === 'delivery-already-queued').length, 1);

    const background = await run({ id: 'delivery-background-immediate', delivery: 'immediate', background: true });
    assert.equal(background.status, 'running');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pendingIds().includes('delivery-background-immediate'), true);
    const countBeforeGet = readMicroJob(root, background.id).status;
    const replay = await executeAgent({ action: 'get', id: background.id }, { projectRoot: root });
    assert.equal(replay.status, countBeforeGet);

    const quietBackground = await executeAgent({ task: 'bounded task', id: 'delivery-background-default-quiet', background: true }, {
      projectRoot: root, name: 'worker', adapter: { command: 'worker', model: 'requested' },
      runner: async (_config, options) => ({ ok: true, delivery: options.delivery, invocation: { providerLaunches: 0 },
        agentReport: { summary: 'quiet background result', changes: [], checks: [], blockers: [], needsHost: false } }),
    });
    assert.equal(quietBackground.status, 'running');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(readMicroJob(root, quietBackground.id).delivery, 'auto');
    assert.equal(pendingIds().includes(quietBackground.id), false);
    const quietReplay = await executeAgent({ action: 'get', id: quietBackground.id }, { projectRoot: root });
    assert.equal(quietReplay.report.summary, 'quiet background result');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('message retrieval peeks until the renderer acknowledges delivery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-service-'));
  try {
    createMicroJob(root, { jobId: 'agent-message-peek' });
    sendMicroMessage(root, 'agent-message-peek', 'Please inspect the changed test.');
    const first = await executeAgent({ action: 'messages', id: 'agent-message-peek' }, { projectRoot: root });
    const second = await executeAgent({ action: 'messages', id: 'agent-message-peek' }, { projectRoot: root });
    assert.equal(first.messageJobId, 'agent-message-peek');
    assert.equal(first.mode, 'peek');
    assert.equal(first.direction, 'worker-inbox');
    assert.deepEqual(second.messages, first.messages);
    assert.equal(first.messages[0].message, 'Please inspect the changed test.');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('compact jobs expose mailbox send state and distinguish waiting from informational changes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-mailbox-status-'));
  try {
    createMicroJob(root, { jobId: 'mailbox-changes' });
    updateMicroJob(root, 'mailbox-changes', {
      status: 'completed',
      report: {
        summary: 'changed files', changes: ['target.mjs'], checks: [], blockers: [], question: null,
        needsHost: false, needsHostReason: 'changes', waitingForHost: false, hostReason: null,
      },
    });
    const completed = await executeAgent({ action: 'get', id: 'mailbox-changes' }, { projectRoot: root });
    assert.deepEqual(completed.mailbox, {
      canSend: false, waitingForHost: false, needsHostReason: 'changes',
    });
    assert.equal(completed.report.needsHost, false);

    createMicroJob(root, { jobId: 'mailbox-question' });
    updateMicroJob(root, 'mailbox-question', {
      report: {
        summary: 'need a decision', changes: [], checks: [], blockers: [], question: 'Choose A or B',
        needsHost: true, needsHostReason: 'question', waitingForHost: true, hostReason: 'decision_required',
      },
    });
    const running = await executeAgent({ action: 'get', id: 'mailbox-question' }, { projectRoot: root });
    assert.deepEqual(running.mailbox, {
      canSend: true, waitingForHost: true, needsHostReason: 'question',
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a host reply acknowledges the current question and prevents terminal report replay', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-question-answered-'));
  try {
    const result = await executeAgent({ task: 'ask then finish', id: 'agent-question-answered' }, {
      projectRoot: root,
      name: 'worker',
      adapter: { command: 'worker', model: 'requested' },
      runner: async (_config, args) => {
        reportMicroJob(root, args.agentJobId, {
          summary: 'need a decision', changes: [], checks: [], blockers: [], question: 'Use A or B?',
        });
        const waiting = await executeAgent({ action: 'get', id: args.agentJobId }, { projectRoot: root });
        assert.equal(waiting.report.waitingForHost, true);
        sendMicroMessage(root, args.agentJobId, 'Use A');
        const acknowledged = await executeAgent({ action: 'get', id: args.agentJobId }, { projectRoot: root });
        assert.equal(acknowledged.report.questionAnswered, true);
        assert.equal(acknowledged.report.waitingForHost, false);
        return {
          ok: true,
          invocation: { providerLaunches: 0 },
          agentReport: {
            summary: 'continued after the reply', changes: [], checks: [], blockers: [],
            question: 'Use A or B?', needsHost: true,
          },
        };
      },
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.report.question, 'Use A or B?');
    assert.equal(result.report.questionAnswered, true);
    assert.equal(result.report.waitingForHost, false);
    assert.equal(result.report.needsHost, false);
    assert.equal(result.mailbox.waitingForHost, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a terminal empty report preserves the last meaningful worker report without waiting on the host', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-service-empty-report-'));
  try {
    const result = await executeAgent({ task: 'finish after reporting', id: 'agent-empty-terminal' }, {
      projectRoot: root,
      name: 'worker',
      adapter: { command: 'worker', model: 'requested' },
      runner: async (_config, args) => {
        reportMicroJob(root, args.agentJobId, JSON.stringify({
          summary: 'implemented summarizeOrders',
          changes: ['src/orders.mjs'],
          checks: ['npm test'],
          blockers: [],
          question: '',
        }));
        return {
          ok: true,
          invocation: { providerLaunches: 0 },
          agentReport: { needsHost: false, hostReason: '', answer: '' },
        };
      },
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.report.summary, 'implemented summarizeOrders');
    assert.deepEqual(result.report.changes, ['src/orders.mjs']);
    assert.deepEqual(result.report.checks, ['npm test']);
    assert.equal(result.report.needsHost, false);
    assert.equal(result.report.needsHostReason, 'changes');
    assert.equal(result.report.waitingForHost, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a CLI session id is persisted and exposed so a follow-up can resume the conversation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-session-'));
  try {
    const run = await executeAgent({ task: 'first turn', id: 'agent-resume' }, {
      projectRoot: root, name: 'worker', adapter: { command: 'worker', model: 'requested' },
      runner: async () => ({ ok: true, cliSessionId: 'conversation-42', providerLaunches: 1,
        agentReport: { summary: 'turn one', changes: [], checks: [], blockers: [], needsHost: false } }),
    });
    assert.equal(run.status, 'completed');
    const replay = await executeAgent({ action: 'get', id: 'agent-resume' }, { projectRoot: root });
    assert.equal(replay.cliSessionId, 'conversation-42');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('messages waitMs blocks for a host reply instead of making the worker poll', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-wait-'));
  try {
    createMicroJob(root, { jobId: 'agent-wait' });
    const waiting = executeAgent({ action: 'messages', id: 'agent-wait', waitMs: 1000 }, { projectRoot: root });
    setTimeout(() => sendMicroMessage(root, 'agent-wait', 'continue with option B'), 30);
    const result = await waiting;
    assert.equal(result.messageJobId, 'agent-wait');
    assert.equal(result.mode, 'wait');
    assert.equal(result.direction, 'worker-inbox');
    assert.deepEqual(result.messages.map((message) => message.message), ['continue with option B']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a worker can only send to its assigned job through the report root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-worker-send-'));
  const previous = {
    mode: process.env.CONTEXTOS_WORKER_MODE,
    reportRoot: process.env.CONTEXTOS_MICRO_REPORT_ROOT,
    reportJob: process.env.CONTEXTOS_MICRO_REPORT_JOB,
  };
  try {
    createMicroJob(root, { jobId: 'assigned-job' });
    process.env.CONTEXTOS_WORKER_MODE = '1';
    process.env.CONTEXTOS_MICRO_REPORT_ROOT = root;
    process.env.CONTEXTOS_MICRO_REPORT_JOB = 'assigned-job';
    await assert.rejects(
      executeAgent({ action: 'send', jobId: 'other-job', message: 'not allowed' }, { projectRoot: '/tmp' }),
      /assigned CLI task/
    );
    const queued = await executeAgent({ action: 'send', jobId: 'assigned-job', message: 'use the corrected contract' }, { projectRoot: '/tmp' });
    assert.equal(queued.queued, true);
    assert.equal(queued.direction, 'host-to-worker');
    assert.deepEqual(receiveMicroMessages(root, 'assigned-job').map((message) => message.message), ['use the corrected contract']);
  } finally {
    if (previous.mode === undefined) delete process.env.CONTEXTOS_WORKER_MODE; else process.env.CONTEXTOS_WORKER_MODE = previous.mode;
    if (previous.reportRoot === undefined) delete process.env.CONTEXTOS_MICRO_REPORT_ROOT; else process.env.CONTEXTOS_MICRO_REPORT_ROOT = previous.reportRoot;
    if (previous.reportJob === undefined) delete process.env.CONTEXTOS_MICRO_REPORT_JOB; else process.env.CONTEXTOS_MICRO_REPORT_JOB = previous.reportJob;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('agent wait returns a resumable partial snapshot when the window closes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-service-'));
  try {
    const opts = { projectRoot: root, name: 'worker', adapter: { command: 'worker' }, runner: async (_config, args) => new Promise((resolve) => {
      args.signal.addEventListener('abort', () => resolve({ ok: false, error: 'cancelled' }), { once: true });
    }) };
    const start = await executeAgent({ task: 'long task', background: true }, opts);
    const waited = await executeAgent({ action: 'wait', id: start.id, waitMs: 1 }, opts);
    assert.equal(waited.status, 'partial');
    assert.equal(waited.partial, true);
    assert.equal(waited.jobStatus, 'running');
    assert.equal(waited.window, 'expired');
    assert.equal(waited.doNotRedispatch, true);
    assert.deepEqual(waited.resume, { kind: 'agent', action: 'wait', jobId: start.id });
    assert.deepEqual(waited.continueWith, { action: 'wait', jobId: start.id, waitMs: 290000 });
    assert.match(waited.guidance, /do not dispatch the same task again/);
    const resumed = await executeAgent({ action: 'wait', resume: waited.resume, waitMs: 1 }, opts);
    assert.equal(resumed.jobStatus, 'running');
    await executeAgent({ action: 'cancel', id: start.id }, opts);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('agent wait settles a missing job instead of reporting a running window', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-service-'));
  try {
    const waited = await executeAgent({ action: 'wait', id: 'agent-never-created' }, { projectRoot: root });
    assert.equal(waited.status, 'missing');
    assert.equal(waited.terminal, true);
    assert.equal(waited.errorCode, 'JOB_NOT_FOUND');
    assert.equal(waited.resume, undefined);
    assert.match(waited.guidance, /agent\(\{action:"list"\}\)/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('background concurrent jobs return ids before they finish and cancelled jobs retain status', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-service-'));
  let finish;
  try {
    const opts = { projectRoot: root, name: 'worker', adapter: { command: 'worker' }, runner: async (_config, args) => new Promise((resolve) => {
      finish = () => resolve({ ok: true, agentReport: { summary: 'done', needsHost: false } });
      args.signal.addEventListener('abort', () => resolve({ ok: false, error: 'cancelled' }));
    }) };
    const start = await executeAgent({ task: 'bounded task', background: true }, opts);
    assert.equal(start.status, 'running');
    const cancel = await executeAgent({ action: 'cancel', id: start.id }, opts);
    assert.equal(cancel.cancellationRequested, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = await executeAgent({ action: 'get', id: start.id }, opts);
    assert.equal(result.status, 'cancelled');
    finish?.();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('agent cancel signals a detached lease pid and persists a cancellation marker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-service-'));
  const lease = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const signals = [];
  try {
    createMicroJob(root, { jobId: 'agent-detached-cancel', kind: 'agent' });
    updateMicroJob(root, 'agent-detached-cancel', { leasePid: lease.pid });
    const cancelled = await executeAgent({ action: 'cancel', id: 'agent-detached-cancel' }, {
      projectRoot: root,
      processAlive: () => true,
      killProcess: (pid, signal) => { signals.push([pid, signal]); },
    });
    assert.equal(cancelled.cancellationRequested, true);
    assert.equal(cancelled.cancellation.marker, true);
    assert.equal(cancelled.cancellation.signalled, process.platform !== 'win32');
    if (process.platform !== 'win32') assert.deepEqual(signals, [[lease.pid, 'SIGTERM']]);
    assert.equal(fs.existsSync(cancellationMarkerPath(root, 'agent-detached-cancel')), true);
    assert.equal(Boolean(readMicroJob(root, 'agent-detached-cancel').cancelRequestedAt), true);
  } finally {
    try { lease.kill('SIGKILL'); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a detached agent worker observes a cancellation marker written by another process', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-service-'));
  try {
    createMicroJob(root, {
      jobId: 'agent-marker-cancel',
      kind: 'agent',
      worker: {
        version: 1,
        args: { task: 'bounded task' },
        adapter: { command: 'worker' },
        name: 'worker',
        deliveryMode: 'defer',
      },
    });
    const run = executeAgent({ action: 'run', id: 'agent-marker-cancel', workerResume: true, background: false }, {
      projectRoot: root,
      runner: async (_config, args) => new Promise((resolve) => {
        args.signal.addEventListener('abort', () => resolve({ ok: false, error: 'cancelled' }), { once: true });
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    fs.mkdirSync(path.dirname(cancellationMarkerPath(root, 'agent-marker-cancel')), { recursive: true });
    fs.writeFileSync(cancellationMarkerPath(root, 'agent-marker-cancel'), `${JSON.stringify({ requestedAt: new Date().toISOString(), requestedBy: 'test' })}\n`);
    const result = await run;
    assert.equal(result.status, 'cancelled');
    assert.equal(readMicroJob(root, 'agent-marker-cancel').status, 'cancelled');
    assert.equal(fs.existsSync(cancellationMarkerPath(root, 'agent-marker-cancel')), false);
    assert.equal(claimMicroDeliveries(root, { maxItems: 10 }).some((item) => item.deliveryId === 'agent-marker-cancel'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('agent wait returns the terminal report in one bounded call', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-service-'));
  try {
    const opts = { projectRoot: root, name: 'worker', adapter: { command: 'worker' }, runner: async (_config, args) => new Promise((resolve) => {
      setTimeout(() => resolve({ ok: true, agentReport: { summary: 'waited', changes: [], checks: [], blockers: [], needsHost: false } }), 80);
      args.signal.addEventListener('abort', () => resolve({ ok: false, error: 'cancelled' }));
    }) };
    const start = await executeAgent({ task: 'bounded task', background: true }, opts);
    assert.equal(start.status, 'running');
    const waited = await executeAgent({ action: 'wait', id: start.id, waitMs: 3000 }, opts);
    assert.equal(waited.status, 'completed'); assert.equal(waited.terminal, true);
    assert.equal(waited.report.summary, 'waited');
    const replay = await executeAgent({ action: 'wait', id: start.id, waitMs: 5 }, opts);
    assert.equal(replay.status, 'completed'); assert.equal(replay.terminal, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('background processing exceptions are caught, persisted as failure receipts, and delivered', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-service-'));
  const usage = [];
  try {
    const start = await executeAgent({ task: 'bounded task', id: 'agent-background-exception', background: true }, {
      projectRoot: root, name: 'worker', adapter: { command: 'worker', model: 'requested', cli: { output: { usage: {
        input: 'input_tokens', output: 'output_tokens', inputIncludesCache: false,
      } } } }, onUsage: (row) => usage.push(row),
      runner: async () => {
        const result = { ok: true, invocation: { providerLaunches: 1 }, actualModel: 'actual',
          usageRaw: { input_tokens: 19, output_tokens: 3 }, providerUsage: { input_tokens: 19, output_tokens: 3 } };
        Object.defineProperty(result, 'agentReport', { get() { throw new Error('report extraction failed'); } });
        return result;
      },
    });
    assert.equal(start.status, 'running');
    await new Promise((resolve) => setImmediate(resolve));
    const replay = await executeAgent({ action: 'get', id: start.id }, { projectRoot: root });
    assert.equal(replay.status, 'failed');
    assert.equal(replay.executionAccounting.status, 'gap');
    assert.equal(usage.length, 1);
    assert.equal(usage[0].status, 'failed');
    assert.equal(usage[0].actualModel, 'actual');
    assert.equal(usage[0].usage.inputTokens, 19);
    assert.equal(usage[0].usage.uncachedInputTokens, 19);
    assert.equal(readMicroJob(root, start.id).usageReceipt.usageRaw.output_tokens, 3);
    const queue = JSON.parse(fs.readFileSync(path.join(root, '.contextos/micro-deliveries/queue.json'), 'utf8'));
    assert.ok(queue.pending.some((item) => item.deliveryId === start.id));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('batch status stays running for active work and becomes partial for failure or cancellation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-agent-service-'));
  let cancelSignal;
  try {
    const background = await executeAgent({ action: 'batch', background: true, tasks: [{ id: 'batch-active', task: 'one' }] }, {
      projectRoot: root, name: 'worker', adapter: { command: 'worker' },
      runner: async (_config, options) => new Promise((resolve) => {
        options.signal.addEventListener('abort', () => resolve({ ok: false, error: 'cancelled', providerLaunches: 0 }), { once: true });
      }),
    });
    assert.equal(background.status, 'running');
    await executeAgent({ action: 'cancel', id: 'batch-active' }, { projectRoot: root });

    const failed = await executeAgent({ action: 'batch', tasks: [{ id: 'batch-failed', task: 'one' }] }, {
      projectRoot: root, name: 'worker', adapter: { command: 'worker' },
      runner: async () => ({ ok: false, error: 'failed task', providerLaunches: 0 }),
    });
    assert.equal(failed.status, 'partial');

    const cancelledRun = executeAgent({ action: 'batch', tasks: [{ id: 'batch-cancelled', task: 'one' }] }, {
      projectRoot: root, name: 'worker', adapter: { command: 'worker' },
      runner: async (_config, options) => new Promise((resolve) => {
        cancelSignal = options.signal;
        options.signal.addEventListener('abort', () => resolve({ ok: false, error: 'cancelled', providerLaunches: 0 }), { once: true });
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    await executeAgent({ action: 'cancel', id: 'batch-cancelled' }, { projectRoot: root });
    assert.equal(cancelSignal.aborted, true);
    assert.equal((await cancelledRun).status, 'partial');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
