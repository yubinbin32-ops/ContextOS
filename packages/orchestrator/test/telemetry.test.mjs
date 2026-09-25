import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { compareTelemetry, recordTelemetry, summarizeTelemetry } from '../src/telemetry.mjs';

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
