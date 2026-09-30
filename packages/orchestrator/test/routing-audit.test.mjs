import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Orchestrator } from '../src/index.mjs';
import { recordMicroUsage } from '../src/response-budget.mjs';
import { auditRouting } from '../src/routing-audit.mjs';
import { recordTelemetry } from '../src/telemetry.mjs';

function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-routing-audit-'));
  fs.mkdirSync(path.join(root, '.contextos', 'logs'), { recursive: true });
  return root;
}

test('routing audit keeps unavailable usage honest and aggregates delivery outcomes', () => {
  const root = tempProject();
  try {
    recordTelemetry(root, { sessionId: 'baseline', tool: 'inspect', input: {}, output: 'x'.repeat(40) });
    recordTelemetry(root, { sessionId: 'right', tool: 'inspect', input: {}, output: 'y'.repeat(20) });
    for (const [receiptId, deliveryOutcome, ok] of [
      ['defer-1', 'deferred', true],
      ['auto-1', 'success-hidden', true],
      ['error-1', 'error', false],
    ]) {
      recordMicroUsage(root, {
        ok,
        delivery: deliveryOutcome,
        usageSource: 'unavailable',
      }, receiptId, {
        hostSessionId: 'right',
        deliveryOutcome,
        okOverride: ok,
      });
    }

    const audit = auditRouting(root, { sessionId: 'right', baselineSessionId: 'baseline' });
    assert.equal(audit.micro.calls, 3);
    assert.equal(audit.micro.providerActualTokens, null);
    assert.equal(audit.micro.estimatedProviderTokens, null);
    assert.deepEqual(audit.micro.deliveryOutcomes, {
      immediate: 0,
      deferred: 1,
      'success-hidden': 1,
      error: 1,
    });
    assert.equal(audit.savings.actualPercent, null);
    assert.equal(audit.evidenceQuality.savings, 'unavailable');
    assert.equal(audit.evidenceQuality.providerTokens, 'unavailable');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('routing audit computes actual savings only when host and provider usage are complete', () => {
  const root = tempProject();
  try {
    recordTelemetry(root, { sessionId: 'baseline', tool: 'work', input: {}, output: 'left', hostUsage: { total_tokens: 100 } });
    recordTelemetry(root, { sessionId: 'right', tool: 'work', input: {}, output: 'right', hostUsage: { total_tokens: 70 } });
    recordMicroUsage(root, {
      ok: true,
      delivery: 'immediate',
      usageSource: 'provider',
      providerUsage: { total_tokens: 10 },
      providerUsageCalls: 2,
      deduplicatedToolCallCount: 3,
    }, 'left-micro', { hostSessionId: 'baseline', deliveryOutcome: 'immediate' });
    recordMicroUsage(root, {
      ok: true,
      delivery: 'defer',
      usageSource: 'provider',
      providerUsage: { total_tokens: 8 },
      providerUsageCalls: 1,
    }, 'right-micro', { hostSessionId: 'right', deliveryOutcome: 'deferred' });

    const audit = auditRouting(root, { sessionId: 'right', baselineSessionId: 'baseline' });
    assert.equal(audit.evidenceQuality.savings, 'actual');
    assert.equal(audit.savings.actualTokens, 32);
    assert.equal(audit.savings.actualPercent, 29.09);
    assert.equal(audit.micro.providerUsageEntries, 1);
    assert.equal(audit.micro.providerUsageCalls, 1);
    assert.equal(audit.micro.deduplicatedToolCallCount, 0);
    assert.equal(audit.baseline.micro.providerUsageCalls, 2);
    assert.equal(audit.delta.host.actualTokens, -30);
    assert.ok(audit.host.peakContextChars > 0);
    assert.ok(audit.internal.peakContextChars >= 0);
    assert.equal(audit.delta.micro.providerActualTokens, -2);
    assert.equal(audit.delta.micro.deduplicatedToolCallCount, -3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Orchestrator exposes a compact audit and bounds missing session ids', async () => {
  const root = tempProject();
  try {
    recordTelemetry(root, { sessionId: 'orch-session', tool: 'inspect', input: {}, output: 'ok' });
    const orchestrator = new Orchestrator({
      projectRoot: root,
      projectId: 'routing-audit-test',
      service: { projectId: 'routing-audit-test', syncEngine: { publishIfDirty() {} } },
    });
    const result = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'telemetry',
      action: 'audit',
      args: { sessionId: 'orch-session' },
    }));
    assert.equal(result.sessionId, 'orch-session');
    assert.equal(result.host.calls, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'entries'), false);
    await assert.rejects(
      () => orchestrator.dispatch('ops', { capability: 'telemetry', action: 'audit', args: {} }),
      /Telemetry audit requires sessionId/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Orchestrator records Pipeline children as internal work', async () => {
  const root = tempProject();
  try {
    const orchestrator = new Orchestrator({
      projectRoot: root,
      projectId: 'routing-audit-internal',
      service: {
        projectId: 'routing-audit-internal',
        osContext: async () => ({}),
        code: async () => '# bounded source',
        syncEngine: { publishIfDirty() {} },
      },
    });
    await orchestrator.dispatch('pipeline', {
      steps: [{ inspect: { path: 'src/example.mjs', maxChars: 120 } }],
      maxChars: 600,
    });
    const entries = fs.readFileSync(path.join(root, '.contextos', 'logs', 'telemetry.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(entries.some((entry) => entry.tool === 'inspect' && entry.internal === true));
    assert.ok(entries.some((entry) => entry.tool === 'pipeline' && entry.internal === false));
    const audit = auditRouting(root, { sessionId: orchestrator.store.current.id });
    assert.equal(audit.host.calls, 1);
    assert.equal(audit.internal.calls, 1);
    assert.equal(audit.host.routeCounts.orchestration, 1);
    assert.equal(audit.internal.routeCounts.discovery, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('routing audit warns about repeated host discovery without convergence', () => {
  const root = tempProject();
  try {
    for (let index = 0; index < 6; index += 1) {
      recordTelemetry(root, {
        sessionId: 'fanout',
        tool: 'inspect',
        input: { path: `src/${index}.mjs` },
        output: `read-${index}`,
        routeKind: 'discovery',
      });
    }
    const audit = auditRouting(root, { sessionId: 'fanout' });
    assert.equal(audit.host.routeCounts.discovery, 6);
    assert.match(audit.warnings.join('\n'), /discovery fan-out/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Orchestrator emits one bounded convergence hint at the discovery threshold', async () => {
  const root = tempProject();
  try {
    const orchestrator = new Orchestrator({
      projectRoot: root,
      projectId: 'routing-hint',
      service: {
        projectId: 'routing-hint',
        osContext: async () => ({}),
        code: async () => '# bounded source',
        syncEngine: { publishIfDirty() {} },
      },
    });
    for (let index = 0; index < 5; index += 1) {
      await orchestrator.dispatch('inspect', { path: `src/${index}.mjs`, maxChars: 120 });
    }
    const sixth = await orchestrator.dispatch('inspect', { path: 'src/5.mjs', maxChars: 120 });
    assert.match(sixth, /Batch known reads/);
    const seventh = await orchestrator.dispatch('inspect', { path: 'src/6.mjs', maxChars: 120 });
    // The one-shot routing nudge does not repeat; the separate convergence
    // hint may still be attached once the session stays in discovery.
    assert.doesNotMatch(seventh, /Batch known reads/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('personal cost savings remain separate from raw-token increases and unknown CLI requests', () => {
 const root=tempProject();try {
  recordTelemetry(root,{sessionId:'native-cost',tool:'work',input:{},output:'baseline',hostUsage:{total_tokens:100}});
  recordTelemetry(root,{sessionId:'micro-cost',tool:'work',input:{},output:'candidate',hostUsage:{total_tokens:65}});
  recordMicroUsage(root,{ok:true,provider:'cli',usageSource:'provider',providerUsage:{prompt_tokens:63,completion_tokens:7,total_tokens:70},providerUsageCalls:1,costEstimate:{rawTokens:70,weightedCostTokens:70,workerDivisor:7,mainEquivalentTokens:10}},'cheap-worker',{hostSessionId:'micro-cost'});
  const audit=auditRouting(root,{sessionId:'micro-cost',baselineSessionId:'native-cost'});
  assert.equal(audit.savings.actualTokens,-35);assert.equal(audit.savings.actualPercent,-35);
  assert.equal(audit.micro.weightedCostTokens,70);
  assert.equal(audit.personalCostEstimate.mainEquivalentTokens,75);assert.equal(audit.personalCostEstimate.savedPercent,25);
  assert.equal(audit.personalCostEstimate.workerDivisor,7);assert.match(audit.personalCostEstimate.formula,/cached input \* 0\.1/);
  assert.equal(audit.micro.providerRequests,null);assert.equal(audit.delta.micro.providerRequests,null);
  recordMicroUsage(root,{ok:false,provider:'cli',usageSource:'unavailable'},'interrupted',{hostSessionId:'micro-cost'});
  const incomplete=auditRouting(root,{sessionId:'micro-cost',baselineSessionId:'native-cost'});
  assert.equal(incomplete.personalCostEstimate.savedPercent,null);assert.equal(incomplete.savings.actualPercent,null);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
