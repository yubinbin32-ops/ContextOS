import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendRoleUsage, qualificationManifestSha256, summarizeRoleUsage } from '../src/role-usage-ledger.mjs';

async function temporaryProject(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'role-usage-ledger-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const usageRow = (overrides = {}) => ({
  role: 'main', taskId: 'task-1', requestId: 'request-1', provider: 'provider-x', model: 'model-y',
  usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningTokens: 5 },
  startedAt: '2026-10-01T00:00:00.000Z', durationMs: 1200, status: 'completed', ...overrides,
});

function unusedAdmission(manifest, roles = ['api-micro', 'cli-agent']) {
  const manifestSha256 = qualificationManifestSha256(manifest);
  const unusedRoles = Object.fromEntries(roles.map((role) => [role, {
    reason: `${role} is disabled for this frozen arm`,
    runtimeAdmission: {
      manifestSha256,
      checkedAt: '2026-10-01T00:00:00.000Z',
      environmentRoute: {
        status: 'disabled', source: 'isolated-environment-snapshot', evidenceSha256: 'a'.repeat(64),
      },
      toolRegistration: {
        status: 'disabled', source: 'runtime-tool-inventory', evidenceSha256: 'b'.repeat(64),
      },
    },
  }]));
  return { manifest, manifestSha256, unusedRoles };
}

test('summarizes raw diagnostics and weighted main-equivalent cost', () => {
  const summary = summarizeRoleUsage([
    usageRow(),
    usageRow({ role: 'api-micro', taskId: 'task-1', requestId: 'api-1', usage: {
      inputTokens: 70, cachedInputTokens: 20, outputTokens: 14, reasoningTokens: 4,
    } }),
    usageRow({ role: 'cli-agent', taskId: 'task-1', requestId: 'cli-1', usage: {
      inputTokens: 35, cachedInputTokens: 5, outputTokens: 7, reasoningTokens: 2,
    } }),
  ]);
  assert.equal(summary.roles.main.uncachedInputTokens.totalTokens, 60);
  assert.equal(summary.roles.main.rawTokens.totalTokens, 120);
  assert.equal(summary.roles.main.weightedCostTokens.totalTokens, 324);
  assert.equal(summary.roles.main.mainEquivalentTokens.totalTokens, 324);
  assert.equal(summary.roles.main.reasoningTokens.totalTokens, 5);
  assert.equal(summary.totals.rawTokens.totalTokens, 246);
  assert.equal(summary.totals.weightedCostTokens.totalTokens, 696.5);
  assert.equal(summary.totals.cachedInputTokens.totalTokens, 65);
  assert.equal(summary.totals.outputTokens.totalTokens, 41);
  assert.equal(summary.totals.reasoningTokens.totalTokens, 11);
  assert.equal(summary.mainEquivalent.totalTokens, 324 + 242 / 7 + 130.5 / 7);
  assert.equal(summary.mainEquivalent.complete, true);
  assert.match(summary.mainEquivalent.formula, /cached input \* 0\.1/);
});

test('unknown fields remain null and prevent a complete weighted main-equivalent total', () => {
  const summary = summarizeRoleUsage([
    usageRow({ usage: { inputTokens: 10, cachedInputTokens: null, outputTokens: null } }),
    usageRow({ role: 'api-micro', requestId: 'api-1', usage: { inputTokens: null, outputTokens: 5 } }),
  ]);
  assert.equal(summary.roles.main.inputTokens.totalTokens, 10);
  assert.equal(summary.roles.main.cachedInputTokens.totalTokens, null);
  assert.equal(summary.roles.main.outputTokens.totalTokens, null);
  assert.equal(summary.roles.main.rawTokens.totalTokens, null);
  assert.equal(summary.roles.main.weightedCostTokens.totalTokens, null);
  assert.equal(summary.roles.main.rawTokens.knownSubtotal, 0);
  assert.equal(summary.mainEquivalent.totalTokens, null);
  assert.equal(summary.mainEquivalent.complete, false);
  assert.deepEqual(summary.mainEquivalent.missingRoles, ['cli-agent']);
});

test('explicit unused roles count as declared zero only with frozen manifest and runtime admission proof', () => {
  const manifest = {
    schemaVersion: 1,
    candidate: 'frozen-r0',
    roles: { main: { enabled: true }, 'api-micro': { enabled: false }, 'cli-agent': { enabled: false } },
  };
  const summary = summarizeRoleUsage([usageRow()], unusedAdmission(manifest));
  assert.equal(summary.roles.main.rawTokens.totalTokens, 120);
  assert.equal(summary.roles['api-micro'].coverageStatus, 'declared-unused');
  assert.equal(summary.roles['api-micro'].rawTokens.totalTokens, 0);
  assert.equal(summary.roles['api-micro'].rawTokens.observed, false);
  assert.equal(summary.roles['cli-agent'].coverageReason, 'cli-agent is disabled for this frozen arm');
  assert.equal(summary.totals.rawTokens.totalTokens, 120);
  assert.equal(summary.mainEquivalent.totalTokens, 324);
  assert.deepEqual(summary.mainEquivalent.missingRoles, []);
  assert.equal(summary.mainEquivalent.declaredUnusedRoles['api-micro'].manifestSha256,
    qualificationManifestSha256(manifest));
});

test('unused-role declarations fail closed without matching manifest and runtime admission evidence', () => {
  const manifest = {
    schemaVersion: 1,
    roles: { main: { enabled: true }, 'api-micro': { enabled: false }, 'cli-agent': { enabled: false } },
  };
  const valid = unusedAdmission(manifest);
  const { unusedRoles, ...withoutDeclarations } = valid;
  assert.throws(() => summarizeRoleUsage([usageRow()], { ...withoutDeclarations, unusedRoles: {
    'api-micro': { reason: 'disabled' },
  } }), /runtime admission/);

  assert.throws(() => summarizeRoleUsage([usageRow()], {
    ...valid, manifestSha256: 'c'.repeat(64),
  }), /matching frozen manifest/);

  const runtimeEnabled = structuredClone(valid);
  runtimeEnabled.unusedRoles['api-micro'].runtimeAdmission.toolRegistration.status = 'enabled';
  assert.throws(() => summarizeRoleUsage([usageRow()], runtimeEnabled), /must prove disabled/);

  const manifestEnabled = structuredClone(manifest);
  manifestEnabled.roles['api-micro'].enabled = true;
  assert.throws(() => summarizeRoleUsage([usageRow()], unusedAdmission(manifestEnabled)), /explicitly disable/);
});

test('unused-role declarations cannot override any observed usage or conflict receipt', () => {
  const manifest = {
    schemaVersion: 1,
    roles: { main: { enabled: true }, 'api-micro': { enabled: false }, 'cli-agent': { enabled: false } },
  };
  const options = unusedAdmission(manifest);
  const api = usageRow({ role: 'api-micro', requestId: 'api-1' });
  assert.throws(() => summarizeRoleUsage([usageRow(), api], options), /when usage or conflict receipts exist/);
  assert.throws(() => summarizeRoleUsage([usageRow(), { ...api, evidenceStatus: 'conflict' }], options), /when usage or conflict receipts exist/);
});

test('failed requests retain and count usage observed before failure', () => {
  const summary = summarizeRoleUsage([usageRow({ status: 'failed', usage: {
    inputTokens: 30, cachedInputTokens: 10, outputTokens: 8, reasoningTokens: 3,
  } })]);
  assert.equal(summary.roles.main.rawTokens.totalTokens, 38);
  assert.equal(summary.roles.main.weightedCostTokens.totalTokens, 121);
  assert.equal(summary.roles.main.uncachedInputTokens.totalTokens, 20);
  assert.equal(summary.roles.main.requestCount, 1);
});

test('append is idempotent for identical evidence and retains/rejects conflicts', async (t) => {
  const root = await temporaryProject(t);
  const first = await appendRoleUsage(root, usageRow());
  const repeated = await appendRoleUsage(root, usageRow());
  assert.equal(first.status, 'appended');
  assert.equal(repeated.status, 'duplicate');
  assert.equal(repeated.appended, false);
  const conflict = await appendRoleUsage(root, usageRow({ usage: {
    inputTokens: 101, cachedInputTokens: 40, outputTokens: 20, reasoningTokens: 5,
  } }));
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.accepted, false);
  assert.equal(conflict.appended, true);
  const conflictRepeat = await appendRoleUsage(root, usageRow({ usage: {
    inputTokens: 101, cachedInputTokens: 40, outputTokens: 20, reasoningTokens: 5,
  } }));
  assert.equal(conflictRepeat.status, 'conflict');
  assert.equal(conflictRepeat.appended, false);
  const ledger = await fs.readFile(path.join(root, '.contextos/logs/role-usage.jsonl'), 'utf8');
  const rows = ledger.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].evidenceStatus, 'conflict');
  const summary = summarizeRoleUsage(rows);
  assert.equal(summary.conflicts.length, 1);
  assert.equal(summary.countedRequestCount, 0);
  assert.equal(summary.roles.main.rawTokens.totalTokens, null);
});

test('contradictory token accounting is rejected before writing', async (t) => {
  const root = await temporaryProject(t);
  await assert.rejects(appendRoleUsage(root, usageRow({ usage: {
    inputTokens: 100, cachedInputTokens: 40, uncachedInputTokens: 61, outputTokens: 20,
  } })), /contradicts/);
  await assert.rejects(appendRoleUsage(root, usageRow({ usage: {
    inputTokens: 10, cachedInputTokens: 11, outputTokens: 20,
  } })), /cannot exceed/);
  await assert.rejects(appendRoleUsage(root, usageRow({ usage: {
    inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, reasoningTokens: 3,
  } })), /cannot exceed/);
  await assert.rejects(fs.readFile(path.join(root, '.contextos/logs/role-usage.jsonl'), 'utf8'), { code: 'ENOENT' });
});

test('accepts snake_case transport usage and rejects contradictory aliases', async (t) => {
  const root = await temporaryProject(t);
  const appended = await appendRoleUsage(root, usageRow({ usage: {
    input_tokens: 50, cached_input_tokens: 20, output_tokens: 12, reasoning_tokens: 4,
  } }));
  assert.equal(appended.record.usage.inputTokens, 50);
  assert.equal(appended.record.usage.cachedInputTokens, 20);
  assert.equal(appended.record.usage.uncachedInputTokens, 30);
  assert.equal(appended.record.usage.outputTokens, 12);
  await assert.rejects(appendRoleUsage(root, usageRow({ requestId: 'request-2', usage: {
    inputTokens: 50, input_tokens: 51, outputTokens: 12,
  } })), /aliases.*conflicting/);
});

test('accepts provider-normalized usage fields and preserves provider total without imputing components', async (t) => {
  const root = await temporaryProject(t);
  const appended = await appendRoleUsage(root, usageRow({ usage: {
    input: 4, cached: 1, output: 6, reasoning: 2, total: 10,
  } }));
  assert.equal(appended.record.usage.inputTokens, 4);
  assert.equal(appended.record.usage.cachedInputTokens, 1);
  assert.equal(appended.record.usage.uncachedInputTokens, 3);
  assert.equal(appended.record.usage.outputTokens, 6);
  assert.equal(appended.record.usage.reasoningTokens, 2);
  assert.equal(appended.record.usage.reportedTotalTokens, 10);
  assert.equal(await appendRoleUsage(root, usageRow({ requestId: 'unknown-components', usage: { total: 77 } })).then((r) => r.record.usage.inputTokens), null);
  await assert.rejects(appendRoleUsage(root, usageRow({ requestId: 'contradictory-total', usage: {
    input: 4, output: 6, total: 11,
  } })), /reportedTotalTokens contradicts/);
});

test('preserves requested and actual model identities without assuming they match', async (t) => {
  const root = await temporaryProject(t);
  const actual = await appendRoleUsage(root, usageRow({
    model: null,
    actualModel: 'provider-returned-model',
    requestedModel: 'profile-requested-model',
    providerLaunches: 1,
  }));
  assert.equal(actual.record.model, 'provider-returned-model');
  assert.equal(actual.record.actualModel, 'provider-returned-model');
  assert.equal(actual.record.requestedModel, 'profile-requested-model');
  assert.equal(actual.record.providerLaunches, 1);

  const conflictingIdentity = await appendRoleUsage(root, usageRow({
    model: null,
    actualModel: 'different-returned-model',
    requestedModel: 'profile-requested-model',
    providerLaunches: 1,
  }));
  assert.equal(conflictingIdentity.status, 'conflict');
  assert.equal(conflictingIdentity.accepted, false);
  await assert.rejects(appendRoleUsage(root, usageRow({
    model: 'one-model', actualModel: 'another-model', requestedModel: 'requested-model',
  })), /same observed model/);
});

test('retains parent task attribution and keeps API requests separate from the CLI task aggregate', async (t) => {
  const root = await temporaryProject(t);
  const api = usageRow({
    role: 'api-micro', taskId: 'child-api-task', parentTaskId: 'parent-cli-task', requestId: 'api-request-1',
    evidenceScope: 'request', usage: { input: 80, cached: 20, output: 16, reasoning: 4 },
  });
  const cli = usageRow({
    role: 'cli-agent', taskId: 'parent-cli-task', requestId: 'parent-cli-task:aggregate',
    evidenceScope: 'task-aggregate', usage: { input: 120, cached: 30, output: 24, reasoning: 6 },
  });
  const apiReceipt = await appendRoleUsage(root, api);
  const duplicateApiReceipt = await appendRoleUsage(root, api);
  const cliReceipt = await appendRoleUsage(root, cli);
  assert.equal(apiReceipt.record.parentTaskId, 'parent-cli-task');
  assert.equal(duplicateApiReceipt.status, 'duplicate');
  assert.equal(cliReceipt.status, 'appended');
  const rows = (await fs.readFile(path.join(root, '.contextos/logs/role-usage.jsonl'), 'utf8'))
    .trim().split('\n').map(JSON.parse);
  const summary = summarizeRoleUsage(rows);
  assert.equal(summary.roles['api-micro'].rawTokens.totalTokens, 96);
  assert.equal(summary.roles['cli-agent'].rawTokens.totalTokens, 144);
  assert.equal(summary.roles['api-micro'].weightedCostTokens.totalTokens, 282);
  assert.equal(summary.roles['cli-agent'].weightedCostTokens.totalTokens, 423);
  assert.equal(summary.totals.weightedCostTokens.totalTokens, 705);
  assert.equal(summary.totals.rawTokens.totalTokens, 240);
  assert.equal(summary.countedRequestCount, 2);
  assert.equal(summary.conflicts.length, 0);
});

test('task aggregate usage cannot be added alongside per-request evidence for the same role/task', async (t) => {
  const root = await temporaryProject(t);
  await appendRoleUsage(root, usageRow());
  const aggregate = await appendRoleUsage(root, usageRow({
    requestId: 'task-aggregate', evidenceScope: 'task-aggregate', usage: {
      inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningTokens: 5,
    },
  }));
  assert.equal(aggregate.status, 'conflict');
  assert.equal(aggregate.accepted, false);
  const rows = (await fs.readFile(path.join(root, '.contextos/logs/role-usage.jsonl'), 'utf8'))
    .trim().split('\n').map(JSON.parse);
  const summary = summarizeRoleUsage(rows);
  assert.equal(summary.roles.main.rawTokens.totalTokens, null);
  assert.equal(summary.roles.main.conflictedRequestCount, 2);
  assert.ok(summary.conflicts.every((conflict) => conflict.reason === 'request and task aggregate evidence overlap'));
});

test('summarizer ignores identical duplicate rows supplied directly', () => {
  const row = { schemaVersion: 1, ...usageRow(), recordedAt: '2026-10-01T00:00:00.000Z', evidenceStatus: 'accepted' };
  const summary = summarizeRoleUsage([row, { ...row, recordedAt: '2026-10-01T00:01:00.000Z' }]);
  assert.equal(summary.roles.main.rawTokens.totalTokens, 120);
  assert.equal(summary.duplicatesIgnored, 1);
  assert.equal(summary.countedRequestCount, 1);
});
