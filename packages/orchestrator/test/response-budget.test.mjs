import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readArtifact } from '../src/artifact-store.mjs';
import {
  RESPONSE_BUDGETS,
  estimateTokens,
  finalizeResponse,
  fitResponse,
  projectMicroResult,
  recordMicroUsage,
  renderCompact,
  summarizeActionResult,
  summarizeCommandReceipt,
  summarizeMicroUsage,
} from '../src/response-budget.mjs';

function makeTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-response-'));
}

test('fitResponse enforces a hard default budget without creating artifacts', () => {
  const result = fitResponse('x'.repeat(30000), { tool: 'inspect' });
  assert.equal(result.meta.truncated, true);
  assert.equal(result.text.length, result.meta.chars);
  assert.ok(result.text.length <= RESPONSE_BUDGETS.inspect);
  assert.equal(result.meta.estimatedTokens, estimateTokens(result.text));
});

test('finalizeResponse stores only truncated payloads and returns an artifact reference', () => {
  const root = makeTempProject();
  try {
    const small = finalizeResponse('short', { projectRoot: root, tool: 'inspect' });
    assert.equal(small.meta.truncated, false);
    assert.equal(small.meta.artifactId, null);

    const large = finalizeResponse('BEGIN\n' + 'x'.repeat(30000) + '\nEND', {
      projectRoot: root,
      tool: 'inspect',
    });
    assert.equal(large.meta.truncated, true);
    assert.ok(large.meta.artifactId);
    assert.match(large.text, /artifact=/);
    const detail = readArtifact(root, large.meta.artifactId, {
      startLine: 3,
      endLine: 3,
    });
    assert.match(detail.text, /END/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('renderCompact emits compact JSON and explicit full mode is unbounded', () => {
  const compact = renderCompact({ a: 1, nested: { b: 2 } }, { tool: 'ops' });
  assert.equal(compact.text, '{"a":1,"nested":{"b":2}}');

  const full = renderCompact({ value: 'x'.repeat(10000) }, { tool: 'ops', full: true });
  assert.equal(full.meta.truncated, false);
  assert.equal(full.text.length, '{"value":"' .length + 10000 + '"}' .length);
});

test('advanced ops stay bounded unless full output is explicitly requested', () => {
  const bounded = finalizeResponse('x'.repeat(10000), { tool: 'ops' });
  assert.equal(bounded.meta.truncated, true);
  assert.ok(bounded.text.length <= RESPONSE_BUDGETS.ops);
  const full = finalizeResponse('x'.repeat(10000), { tool: 'ops', full: true });
  assert.equal(full.meta.truncated, false);
});

test('custom response budgets may tighten but not widen the tool budget', () => {
  const tightened = finalizeResponse('x'.repeat(5000), { tool: 'verify', maxChars: 200 });
  assert.equal(tightened.meta.truncated, true);
  assert.ok(tightened.text.length <= 240);

  const widened = finalizeResponse('x'.repeat(10000), { tool: 'verify', maxChars: 12000 });
  assert.equal(widened.meta.truncated, true);
  assert.ok(widened.text.length <= RESPONSE_BUDGETS.verify);

  const full = finalizeResponse('x'.repeat(10000), { tool: 'verify', maxChars: 12000, full: true });
  assert.equal(full.meta.truncated, false);
});

test('command receipts are compacted and action diagnostics stay bounded', () => {
  const summary = summarizeCommandReceipt({
    id: 'receipt-1',
    command: 'npm test',
    exitCode: 1,
    durationMs: 10,
    diagnostics: ['first', 'second', 'third'],
  }, { includeDiagnostics: true });
  assert.deepEqual(summary.diagnostics, ['first', 'second']);
  assert.match(summarizeActionResult(JSON.stringify({
    id: 'receipt-1',
    command: 'npm test',
    exitCode: 0,
    summary: 'ok',
  })), /"ok":true/);
});

test('projectMicroResult keeps the full Micro report by default', () => {
  const root = makeTempProject();
  try {
    const content = `BEGIN\n${'x'.repeat(2500)}\nEND`;
    const projected = projectMicroResult({ ok: true, content }, { projectRoot: root });
    assert.equal(projected.content, content);
    assert.equal(projected.chars, content.length);
    assert.equal(projected.truncated, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('projectMicroResult marks a truncated implement turn without an applied change as pending', () => {
  const root = makeTempProject();
  try {
    const projected = projectMicroResult({
      ok: true,
      content: 'Micro provider request budget exceeded',
      providerTruncated: true,
      finishReason: 'length',
      sessionId: 'sess-fixture',
      agentReport: { status: 'completed', summary: 'finished', changes: [], checks: [], blockers: [], needsHost: false },
      implementationEvidence: { applied: false, source: 'none', changedPaths: [], receiptIds: [] },
    }, { projectRoot: root });
    assert.equal(projected.ok, true, 'the retained session stays resumable');
    assert.equal(projected.partialReason, 'implementation-pending');
    assert.equal(projected.report.status, 'partial');
    assert.equal(projected.report.needsHost, true);
    assert.equal(projected.report.truncated, true);
    assert.equal(projected.implementationEvidence.applied, false);
    assert.match(projected.guidance, /Continue session sess-fixture/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('projectMicroResult keeps reasoning and tool traces out of model context', () => {
  const root = makeTempProject();
  try {
    const projected = projectMicroResult({
      ok: true,
      content: 'final answer',
      reasoning: 'private reasoning',
      usage: { total_tokens: 999 },
      providerUsage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      estimatedUsage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      usageSource: 'mixed',
      providerUsageCalls: 1,
      estimatedUsageCalls: 1,
      toolCalls: [{ name: 'inspect', arguments: '{"path":"secret"}' }],
    }, { projectRoot: root });

    assert.equal(projected.content, 'final answer');
    assert.ok(projected.receiptId);
    assert.ok(projected.artifactId);
    assert.match(readArtifact(root, projected.artifactId).text, /final answer/);
    assert.equal(projected.reasoning, undefined);
    assert.equal(projected.usage, undefined);
    assert.equal(projected.usageSource, 'mixed');
    assert.deepEqual(projected.providerUsage, { promptTokens: 12, completionTokens: 4, totalTokens: 16 });
    assert.deepEqual(projected.estimatedUsage, { promptTokens: 5, completionTokens: 1, totalTokens: 6 });
    assert.equal(projected.toolCalls, undefined);
    assert.equal(projected.invocation.toolCalls, 1);
    assert.equal(projected.invocation.toolRounds, null);

    const failed = projectMicroResult({
      ok: false,
      error: 'Micro provider token budget exceeded',
      budgetExceeded: 'providerTokens',
    }, { projectRoot: root });
    assert.equal(failed.budgetExceeded, 'providerTokens');
    assert.ok(failed.artifactId);

    const partial = projectMicroResult({
      ok: false,
      status: 'partial',
      partial: true,
      errorCode: 'MICRO_CONTINUATION_REQUIRED',
      error: 'Micro reached the host continuation window.',
      content: 'Partial progress',
      guidance: 'Continue with the same session.',
      resume: { kind: 'micro', action: 'send', sessionId: 'micro-partial' },
      sessionId: 'micro-partial',
    }, { projectRoot: root });
    assert.equal(partial.status, 'partial');
    assert.equal(partial.partial, true);
    assert.equal(partial.errorCode, 'MICRO_CONTINUATION_REQUIRED');
    assert.equal(partial.content, 'Partial progress');
    assert.equal(partial.guidance, 'Continue with the same session.');
    assert.deepEqual(partial.resume, { kind: 'micro', action: 'send', sessionId: 'micro-partial' });
    assert.equal(partial.sessionId, 'micro-partial');
    assert.equal(partial.error, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Micro receipt counters preserve unknown, measured zero, and positive counts', () => {
  const root = makeTempProject();
  try {
    const unknown = projectMicroResult({
      ok: true,
      provider: 'cli',
      content: 'terminal result',
      providerRequests: null,
      invocation: { providerRequests: null, toolRounds: null },
    }, { projectRoot: root });
    assert.equal(unknown.providerRequests, null);
    assert.equal(unknown.invocation.providerRequests, null);
    assert.equal(unknown.invocation.toolRounds, null);
    assert.equal(unknown.invocation.toolCalls, null);

    const zero = projectMicroResult({
      ok: true,
      provider: 'cli',
      content: 'measured idle result',
      providerRequests: 0,
      steps: 0,
      hostTurnsSaved: 0,
      invocation: { providerRequests: 0, toolRounds: 0, toolCalls: 0 },
    }, { projectRoot: root });
    assert.equal(zero.providerRequests, 0);
    assert.equal(zero.invocation.providerRequests, 0);
    assert.equal(zero.invocation.toolRounds, 0);
    assert.equal(zero.invocation.toolCalls, 0);

    const positive = projectMicroResult({
      ok: true,
      provider: 'cli',
      content: 'measured tool result',
      providerRequests: 2,
      steps: 3,
      hostTurnsSaved: 5,
      invocation: { providerRequests: 2, toolRounds: 3, toolCalls: 4 },
    }, { projectRoot: root });
    assert.equal(positive.providerRequests, 2);
    assert.equal(positive.invocation.providerRequests, 2);
    assert.equal(positive.invocation.toolRounds, 3);
    assert.equal(positive.invocation.toolCalls, 4);

    const api = projectMicroResult({
      ok: true,
      provider: 'api',
      content: 'API result',
      providerRequests: 0,
      providerUsageCalls: 2,
      steps: 0,
      invocation: { providerRequests: 0, toolRounds: 0 },
      toolCalls: [],
    }, { projectRoot: root });
    assert.equal(api.providerRequests, 0);
    assert.equal(api.invocation.providerRequests, 0);
    assert.equal(api.invocation.toolRounds, 0);
    assert.equal(api.invocation.toolCalls, 0);

    const entries = fs.readFileSync(path.join(root, '.contextos', 'logs', 'micro-usage.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(entries[0].providerRequests, null);
    assert.equal(entries[0].toolRounds, null);
    assert.equal(entries[0].toolCallCount, null);
    assert.equal(entries[1].providerRequests, 0);
    assert.equal(entries[1].toolRounds, 0);
    assert.equal(entries[1].toolCallCount, 0);
    assert.equal(entries[1].steps, 0);
    assert.equal(entries[1].hostTurnsSaved, 0);
    assert.equal(entries[1].hostTurnsSavedEvidence, 'explicit');
    assert.equal(entries[2].providerRequests, 2);
    assert.equal(entries[2].toolRounds, 3);
    assert.equal(entries[2].toolCallCount, 4);
    assert.equal(entries[2].steps, 3);
    assert.equal(entries[2].hostTurnsSaved, 5);
    assert.equal(entries[2].hostTurnsSavedEvidence, 'explicit');
    assert.equal(entries[3].toolCallCount, 0);
    assert.equal(entries[3].toolRounds, 0);
    assert.equal(entries[3].hostTurnsSaved, null);
    assert.equal(entries[3].hostTurnsSavedEvidence, 'unknown');
    assert.equal(entries[0].hostTurnsSavedEvidence, 'unknown');

    const ledgerPath = path.join(root, '.contextos', 'logs', 'micro-usage.jsonl');
    fs.appendFileSync(ledgerPath, JSON.stringify({
      receiptId: 'legacy-proxy', ok: true, usageSource: 'unavailable', hostTurnsSaved: 7,
    }) + '\n');
    fs.appendFileSync(ledgerPath, JSON.stringify({
      receiptId: 'current-unknown', ok: false, provider: 'cli', usageSource: 'unavailable', providerRequests: null,
    }) + '\n');
    const legacyEntry = JSON.parse(fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').at(-1));
    assert.equal(legacyEntry.receiptId, 'current-unknown');
    const priorEntry = JSON.parse(fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').at(-2));
    assert.equal(priorEntry.hostTurnsSavedEvidence, undefined, 'existing rows remain unchanged');

    const summary = summarizeMicroUsage(root);
    assert.equal(summary.toolCallCountUnknownCalls, 3);
    assert.equal(summary.toolRoundsUnknownCalls, 3);
    assert.equal(summary.stepsUnknownCalls, 3);
    assert.equal(summary.hostTurnsSaved, 5);
    assert.equal(summary.hostTurnsSavedExplicitCalls, 2);
    assert.equal(summary.hostTurnsSavedUnknownCalls, 3);
    assert.equal(summary.hostTurnsSavedLegacyProxy, 7);
    assert.equal(summary.hostTurnsSavedLegacyProxyCalls, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Micro counters accept only safe nonnegative integer values', () => {
  const root = makeTempProject();
  try {
    const maxSafe = Number.MAX_SAFE_INTEGER;
    const boundary = projectMicroResult({
      ok: true,
      provider: 'cli',
      content: 'boundary result',
      providerRequests: String(maxSafe),
      steps: maxSafe,
      hostTurnsSaved: maxSafe,
      invocation: {
        providerRequests: String(maxSafe),
        toolRounds: maxSafe,
        toolCalls: String(maxSafe),
      },
    }, { projectRoot: root });
    assert.equal(boundary.providerRequests, maxSafe);
    assert.equal(boundary.invocation.providerRequests, maxSafe);
    assert.equal(boundary.invocation.toolRounds, maxSafe);
    assert.equal(boundary.invocation.toolCalls, maxSafe);

    for (const invalid of [1.5, Infinity, NaN, -1, true, '', '  ', '1.5', '-1', '9007199254740992']) {
      const projected = projectMicroResult({
        ok: true,
        provider: 'cli',
        content: 'invalid count result',
        providerRequests: invalid,
        steps: invalid,
        hostTurnsSaved: invalid,
        invocation: { providerRequests: invalid, toolRounds: invalid, toolCalls: invalid },
      }, { projectRoot: root });
      assert.equal(projected.providerRequests, null, String(invalid));
      assert.equal(projected.invocation.providerRequests, null, String(invalid));
      assert.equal(projected.invocation.toolRounds, null, String(invalid));
      assert.equal(projected.invocation.toolCalls, null, String(invalid));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Micro provider usage is recorded separately from host usage', () => {
  const root = makeTempProject();
  try {
    recordMicroUsage(root, {
      ok: true,
      statusCode: 200,
      preset: 'triage',
      model: 'deepseek-v4.1-flash',
      providerHost: 'provider.example.test',
      durationMs: 25,
      usageSource: 'provider',
      providerUsage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      providerUsageCalls: 1,
      cost: { estimatedUsd: 0.001 },
      budget: { maxProviderTokens: 8000, maxCostUsd: 0.5 },
    }, 'micro-test-1');
    recordMicroUsage(root, {
      ok: false,
      statusCode: 500,
      preset: 'triage',
      model: 'deepseek-v4.1-flash',
      durationMs: 10,
      usageSource: 'estimated',
      estimatedUsage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 },
      estimatedUsageCalls: 1,
    }, 'micro-test-2');
    const summary = summarizeMicroUsage(root);
    assert.equal(summary.calls, 2);
    assert.equal(summary.ok, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.totalTokens, 15);
    assert.equal(summary.providerUsageCalls, 1);
    assert.equal(summary.estimatedUsageCalls, 1);
    assert.equal(summary.estimatedTotalTokens, 3);
    assert.equal(summary.usageUnavailableCalls, 0);
    assert.equal(summary.estimatedCostUsd, null);
    assert.equal(summary.costUnknownCalls, 1);
    assert.equal(summary.totalTokensComplete, false);
    assert.equal(summary.byPreset[0].preset, 'triage');
    assert.equal(summary.byModel[0].model, 'deepseek-v4.1-flash');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Micro usage records requested delivery, effective outcome, and preload metrics', () => {
  const root = makeTempProject();
  try {
    projectMicroResult({
      ok: true,
      receiptId: 'micro-metrics-defer',
      delivery: 'defer',
      content: 'deferred answer',
    }, { projectRoot: root });
    projectMicroResult({
      ok: true,
      receiptId: 'micro-metrics-auto-hidden',
      delivery: 'auto',
      needsHost: false,
      content: 'hidden success',
    }, { projectRoot: root });
    projectMicroResult({
      ok: true,
      receiptId: 'micro-metrics-auto-deferred',
      delivery: 'auto',
      needsHost: true,
      content: 'host-needed answer',
    }, { projectRoot: root });
    const hiddenSuccess = projectMicroResult({
      ok: true,
      receiptId: 'micro-metrics-errors-hidden',
      delivery: 'errors-only',
      content: 'hidden non-graph success',
      toolCalls: [],
    }, { projectRoot: root });
    assert.equal(hiddenSuccess.ok, true);
    assert.equal(hiddenSuccess.delivery, 'success-hidden');
    const failed = projectMicroResult({
      ok: true,
      receiptId: 'micro-metrics-errors-failure',
      delivery: 'errors-only',
      content: 'write failed',
      toolCalls: [{ name: 'run', arguments: JSON.stringify({ command: 'npm test' }), ok: false, error: 'exit 1' }],
    }, { projectRoot: root });
    assert.equal(failed.ok, false);
    assert.equal(failed.delivery, 'error');
    projectMicroResult({
      ok: true,
      receiptId: 'micro-metrics-preloaded',
      delivery: 'immediate',
      content: 'preloaded answer',
      preload: { ok: true, status: 'OK', artifactId: 'pipeline-preload-1', chars: 37 },
      usageSource: 'provider',
      providerUsage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 },
      providerUsageCalls: 1,
    }, { projectRoot: root });

    const entries = fs.readFileSync(path.join(root, '.contextos', 'logs', 'micro-usage.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(entries.map((entry) => [entry.requestedDelivery, entry.deliveryOutcome, entry.ok]), [
      ['defer', 'deferred', true],
      ['auto', 'success-hidden', true],
      ['auto', 'deferred', true],
      ['errors-only', 'success-hidden', true],
      ['errors-only', 'error', false],
      ['immediate', 'immediate', true],
    ]);
    assert.equal(entries[5].preloadAttached, true);
    assert.equal(entries[5].preloadChars, 37);

    const summary = summarizeMicroUsage(root);
    assert.deepEqual(summary.deliveryOutcomes, {
      immediate: 1,
      deferred: 2,
      'success-hidden': 2,
      error: 1,
    });
    assert.equal(summary.preloadCalls, 1);
    assert.equal(summary.preloadChars, 37);
    assert.equal(summary.providerUsageCalls, 1);
    assert.equal(summary.totalTokens, 14);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing task usage marks totals incomplete and unknown pricing stays unknown', () => {
 const root=makeTempProject();try {
  recordMicroUsage(root,{ok:false,provider:'cli',usageSource:'unavailable',cost:{estimatedUsd:null}},'missing');
  recordMicroUsage(root,{ok:true,provider:'api',usageSource:'provider',providerUsage:{prompt_tokens:7,completion_tokens:0,total_tokens:7},cost:{estimatedUsd:0,pricingConfigured:false},costEstimate:{rawTokens:7,weightedCostTokens:14,workerDivisor:7,mainEquivalentTokens:2}},'known');
  const summary=summarizeMicroUsage(root);
  assert.equal(summary.totalTokens,7);assert.equal(summary.weightedCostTokens,14);assert.equal(summary.weightedMainEquivalentTokens,2);assert.equal(summary.mainEquivalentTokens,1);
  assert.equal(summary.totalTokensComplete,false);assert.equal(summary.weightedCostTokensComplete,false);assert.equal(summary.mainEquivalentTokensComplete,false);
  assert.equal(summary.estimatedCostUsd,null);assert.equal(summary.costUnknownCalls,2);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('weighted cost uses cached, uncached, and output weights with a /7 worker equivalent', () => {
 const root=makeTempProject();try {
  recordMicroUsage(root,{ok:true,provider:'api',usageSource:'provider',providerUsage:{
    prompt_tokens:100,cached_input_tokens:40,uncached_input_tokens:60,completion_tokens:20,total_tokens:120,
  }},'weighted');
  const summary=summarizeMicroUsage(root);
  assert.equal(summary.totalTokens,120);
  assert.equal(summary.weightedCostTokens,324);
  assert.equal(summary.weightedMainEquivalentTokens,324/7);
  assert.equal(summary.mainEquivalentTokens,120/7);
  assert.equal(summary.weightedCostTokensComplete,true);
  assert.equal(summary.mainEquivalentTokensComplete,true);
  assert.match(summary.costFormula,/cached input \* 0\.1/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('projectMicroResult surfaces a provider completion cap as truncation', () => {
  const root = makeTempProject();
  try {
    const result = projectMicroResult({
      ok: true,
      content: 'partial report',
      providerTruncated: true,
      finishReason: 'length',
      sessionId: 'cap-session',
      providerUsage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }, { projectRoot: root });
    assert.equal(result.truncated, true);
    assert.equal(result.providerTruncated, true);
    assert.equal(result.finishReason, 'length');
    assert.match(result.guidance, /sessionAction:"continue"/);
    assert.match(result.guidance, /cap-session/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('projectMicroResult keeps the provider cache split in the projected usage', () => {
  const root = makeTempProject();
  try {
    const result = projectMicroResult({
      ok: true,
      content: 'answer',
      providerUsage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, cached_input_tokens: 900, uncached_input_tokens: 100 },
    }, { projectRoot: root });
    assert.equal(result.providerUsage.cachedInputTokens, 900);
    assert.equal(result.providerUsage.uncachedInputTokens, 100);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
