import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseRolloutJsonl, parseRolloutTelemetry } from '../src/rollout-telemetry.mjs';
import { compareTelemetry, recordTelemetry, summarizeTelemetry } from '../src/telemetry.mjs';

function rolloutUsage(inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens) {
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: cachedInputTokens },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: reasoningOutputTokens },
    total_tokens: inputTokens + outputTokens,
  };
}

function tokenUsageRecord(responseId, usage, cumulative = usage, contextWindow = null) {
  return {
    type: 'token_usage_record',
    payload: {
      response_id: responseId,
      usage,
      turn_token_usage: cumulative,
      thread_token_usage: cumulative,
      ...(contextWindow ? { model_context_window: contextWindow } : {}),
    },
  };
}

function tokenCount(lastTokenUsage, totalTokenUsage, modelContextWindow) {
  return {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: lastTokenUsage,
        total_token_usage: totalTokenUsage,
        model_context_window: modelContextWindow,
      },
    },
  };
}

function writeRollout(root, name, entries) {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
  return filePath;
}

test('telemetry tracks per-call cost, replay growth, and top contributors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-telemetry-'));
  try {
    recordTelemetry(root, {
      sessionId: 's1',
      tool: 'inspect',
      input: { path: 'a.mjs' },
      output: 'a'.repeat(400),
      durationMs: 10,
    });
    recordTelemetry(root, {
      sessionId: 's1',
      tool: 'pipeline',
      input: { parallel: [{ run: 'npm test' }] },
      output: 'b'.repeat(200),
      artifactId: 'art-pipeline',
      truncated: true,
      durationMs: 20,
    });
    recordTelemetry(root, {
      sessionId: 'other',
      tool: 'ship',
      input: {},
      output: 'c',
    });

    const summary = summarizeTelemetry(root, { sessionId: 's1' });
    assert.equal(summary.calls, 2);
    assert.equal(summary.outputChars, 600);
    assert.equal(summary.replayChars, 1000);
    assert.ok(summary.peakContextChars > summary.outputChars);
    assert.equal(summary.peakEstimatedContextTokens, Math.ceil(summary.peakContextChars / 4));
    assert.equal(summary.truncated, 1);
    assert.equal(summary.topContributors[0].tool, 'inspect');
    assert.equal(summary.topContributors.find((entry) => entry.tool === 'pipeline').truncated, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('telemetry compare returns compact metrics and right-minus-left deltas', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-telemetry-compare-'));
  try {
    recordTelemetry(root, {
      sessionId: 'left',
      tool: 'inspect',
      input: { a: '1234' },
      output: 'abcd',
    });
    recordTelemetry(root, {
      sessionId: 'right',
      tool: 'inspect',
      input: { b: '12345678' },
      output: 'abcdefgh',
    });
    recordTelemetry(root, {
      sessionId: 'right',
      tool: 'pipeline',
      input: { c: '12' },
      output: 'ij',
      truncated: true,
    });

    assert.deepEqual(compareTelemetry(root, {
      leftSessionId: 'left',
      rightSessionId: 'right',
    }), {
      left: {
        calls: 1,
        estimatedTotalTokens: 4,
        peakContextChars: 16,
        replayChars: 4,
        truncated: 0,
      },
      right: {
        calls: 2,
        estimatedTotalTokens: 10,
        peakContextChars: 24,
        replayChars: 18,
        truncated: 1,
      },
      delta: {
        calls: 1,
        estimatedTotalTokens: 6,
        peakContextChars: 8,
        replayChars: 14,
        truncated: 1,
      },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('telemetry compare rejects missing session IDs before deriving metrics', () => {
  assert.throws(
    () => compareTelemetry('/tmp/does-not-matter', { rightSessionId: 'right' }),
    /leftSessionId/
  );
  assert.throws(
    () => compareTelemetry('/tmp/does-not-matter', { leftSessionId: 'left' }),
    /rightSessionId/
  );
});

test('telemetry keeps complete host usage separate from character estimates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-telemetry-actual-'));
  try {
    recordTelemetry(root, {
      sessionId: 'actual',
      tool: 'work',
      input: {},
      output: 'answer',
      hostUsage: { total_tokens: 42 },
    });
    const summary = summarizeTelemetry(root, { sessionId: 'actual' });
    assert.equal(summary.actualTokens, 42);
    assert.equal(summary.actualUsageCalls, 1);

    recordTelemetry(root, {
      sessionId: 'actual',
      tool: 'verify',
      input: {},
      output: 'second',
    });
    const incomplete = summarizeTelemetry(root, { sessionId: 'actual' });
    assert.equal(incomplete.actualTokens, null);
    assert.equal(incomplete.actualUsageCalls, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('telemetry separates internal Pipeline work from host-visible replay', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-telemetry-scope-'));
  try {
    recordTelemetry(root, {
      sessionId: 'session',
      tool: 'inspect',
      input: {},
      output: 'host-visible',
    });
    recordTelemetry(root, {
      sessionId: 'session',
      tool: 'inspect',
      input: {},
      output: 'internal-child',
      internal: true,
    });
    recordTelemetry(root, {
      sessionId: 'session',
      tool: 'pipeline',
      input: {},
      output: 'host-visible-2',
    });

    const external = summarizeTelemetry(root, { sessionId: 'session', scope: 'external' });
    const internal = summarizeTelemetry(root, { sessionId: 'session', scope: 'internal' });
    const all = summarizeTelemetry(root, { sessionId: 'session' });
    assert.equal(external.calls, 2);
    assert.equal(external.replayChars, 'host-visible'.length * 2 + 'host-visible-2'.length);
    assert.equal(internal.calls, 1);
    assert.equal(internal.replayChars, 'internal-child'.length);
    assert.equal(all.calls, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rollout telemetry freezes its report schema and uses request usage instead of cumulative totals', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-rollout-schema-'));
  try {
    const first = rolloutUsage(10, 2, 3, 1);
    const second = rolloutUsage(20, 4, 5, 2);
    const firstTotal = first;
    const secondTotal = rolloutUsage(30, 6, 8, 3);
    const rolloutPath = writeRollout(root, 'thread.jsonl', [
      tokenUsageRecord('response-1', first, firstTotal),
      tokenUsageRecord('response-2', second, secondTotal),
      tokenUsageRecord('response-2', second, secondTotal),
      tokenCount(firstTotal, firstTotal, 128000),
      tokenCount(second, secondTotal, 256000),
    ]);

    const result = parseRolloutTelemetry([rolloutPath]);
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.ok, true);
    assert.deepEqual(result.files, [rolloutPath]);
    assert.equal(result.records, 5);
    assert.equal(result.duplicateRecords, 1);
    assert.equal(result.incomplete, false);
    assert.deepEqual(result.metrics, {
      requestCount: 2,
      inputTokens: 30,
      cachedInputTokens: 6,
      outputTokens: 8,
      reasoningOutputTokens: 3,
      totalTokens: 38,
      peakRequestInputTokens: 20,
      modelContextWindow: 256000,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rollout telemetry uses token_count only for requests missing a token_usage_record', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-rollout-fallback-'));
  try {
    const first = rolloutUsage(10, 2, 3, 1);
    const second = rolloutUsage(20, 4, 5, 2);
    const firstTotal = first;
    const secondTotal = rolloutUsage(30, 6, 8, 3);
    const rolloutPath = writeRollout(root, 'fallback.jsonl', [
      tokenUsageRecord('response-1', first, firstTotal),
      tokenCount(first, firstTotal, 128000),
      tokenCount(second, secondTotal, 256000),
    ]);

    const result = parseRolloutTelemetry({ paths: [rolloutPath] });
    assert.equal(result.ok, true);
    assert.equal(result.records, 3);
    assert.equal(result.metrics.requestCount, 2);
    assert.equal(result.metrics.inputTokens, 30);
    assert.equal(result.metrics.outputTokens, 8);
    assert.equal(result.metrics.totalTokens, 38);
    assert.equal(result.metrics.peakRequestInputTokens, 20);
    assert.equal(result.metrics.modelContextWindow, 256000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rollout telemetry fails closed for malformed, incomplete, and contradictory usage', () => {
  const incomplete = parseRolloutJsonl([
    tokenUsageRecord('response-incomplete', {
      input_tokens: 10,
      output_tokens: 2,
    }),
  ].map((entry) => JSON.stringify(entry)).join('\n'), { source: 'incomplete.jsonl' });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.incomplete, true);
  assert.equal(incomplete.metrics, null);
  assert.match(incomplete.warnings.join('\n'), /cached input tokens/);

  const contradictory = parseRolloutJsonl([
    tokenUsageRecord('response-duplicate', rolloutUsage(10, 2, 3, 1)),
    tokenUsageRecord('response-duplicate', rolloutUsage(10, 2, 4, 1)),
  ].map((entry) => JSON.stringify(entry)).join('\n'), { source: 'contradictory.jsonl' });
  assert.equal(contradictory.ok, false);
  assert.equal(contradictory.incomplete, true);
  assert.equal(contradictory.metrics, null);
  assert.match(contradictory.warnings.join('\n'), /contradictory duplicate/);
});

test('telemetry compare attaches rollout reports separately from character estimates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-rollout-compare-'));
  try {
    recordTelemetry(root, {
      sessionId: 'left',
      tool: 'inspect',
      input: { a: '1234' },
      output: 'abcd',
    });
    recordTelemetry(root, {
      sessionId: 'right',
      tool: 'inspect',
      input: { b: '12345678' },
      output: 'abcdefgh',
    });
    const leftUsage = rolloutUsage(10, 2, 3, 1);
    const rightUsage = rolloutUsage(20, 4, 5, 2);
    const leftRolloutPath = writeRollout(root, 'left.jsonl', [
      tokenUsageRecord('left-response', leftUsage, leftUsage, 128000),
    ]);
    const rightRolloutPath = writeRollout(root, 'right.jsonl', [
      tokenUsageRecord('right-response', rightUsage, rightUsage, 256000),
    ]);

    const result = compareTelemetry(root, {
      leftSessionId: 'left',
      rightSessionId: 'right',
      leftRolloutPath,
      rightRolloutPath,
    });
    assert.equal(result.left.estimatedTotalTokens, 4);
    assert.equal(result.right.estimatedTotalTokens, 6);
    assert.equal(result.delta.estimatedTotalTokens, 2);
    assert.equal(result.rollout.left.metrics.totalTokens, 13);
    assert.equal(result.rollout.right.metrics.totalTokens, 25);
    assert.deepEqual(result.rollout.delta, {
      requestCount: 0,
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 2,
      reasoningOutputTokens: 1,
      totalTokens: 12,
      peakRequestInputTokens: 10,
      modelContextWindow: 128000,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
