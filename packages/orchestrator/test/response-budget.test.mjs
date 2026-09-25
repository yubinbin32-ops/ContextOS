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

test('projectMicroResult keeps reasoning and tool traces out of model context', () => {
  const root = makeTempProject();
  try {
    const projected = projectMicroResult({
      ok: true,
      content: 'final answer',
      reasoning: 'private reasoning',
      usage: { total_tokens: 999 },
      toolCalls: [{ name: 'inspect', arguments: '{"path":"secret"}' }],
    }, { projectRoot: root });

    assert.equal(projected.content, 'final answer');
    assert.ok(projected.receiptId);
    assert.ok(projected.artifactId);
    assert.match(readArtifact(root, projected.artifactId).text, /final answer/);
    assert.equal(projected.reasoning, undefined);
    assert.equal(projected.usage, undefined);
    assert.equal(projected.toolCalls, undefined);

    const failed = projectMicroResult({
      ok: false,
      error: 'Micro provider token budget exceeded',
      budgetExceeded: 'providerTokens',
    }, { projectRoot: root });
    assert.equal(failed.budgetExceeded, 'providerTokens');
    assert.ok(failed.artifactId);
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
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      cost: { estimatedUsd: 0.001 },
      budget: { maxProviderTokens: 8000, maxCostUsd: 0.5 },
    }, 'micro-test-1');
    recordMicroUsage(root, {
      ok: false,
      statusCode: 500,
      preset: 'triage',
      model: 'deepseek-v4.1-flash',
      durationMs: 10,
      usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 },
    }, 'micro-test-2');
    const summary = summarizeMicroUsage(root);
    assert.equal(summary.calls, 2);
    assert.equal(summary.ok, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.totalTokens, 18);
    assert.equal(summary.estimatedCostUsd, 0.001);
    assert.equal(summary.byPreset[0].preset, 'triage');
    assert.equal(summary.byModel[0].model, 'deepseek-v4.1-flash');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
