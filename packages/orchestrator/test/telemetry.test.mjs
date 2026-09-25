import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { recordTelemetry, summarizeTelemetry } from '../src/telemetry.mjs';

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

