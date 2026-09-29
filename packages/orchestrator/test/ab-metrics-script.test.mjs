import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(testDirectory, '../../../scripts/contextos-ab-metrics.mjs');

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
}

function runMetrics(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
  });
}

function tokenCount(inputTokens, outputTokens) {
  return {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: 0,
          output_tokens: outputTokens,
          reasoning_output_tokens: 0,
          total_tokens: inputTokens + outputTokens,
        },
        total_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: 0,
          output_tokens: outputTokens,
          reasoning_output_tokens: 0,
          total_tokens: inputTokens + outputTokens,
        },
        model_context_window: 200000,
      },
    },
  };
}

test('metrics resolves a codex exec stream to its per-request session rollout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-ab-metrics-'));
  try {
    const threadId = 'thread-01a0e925-test';
    const codexHome = path.join(root, 'codex-home');
    const sessionPath = path.join(codexHome, 'sessions', '2026', '09', '29', `rollout-${threadId}.jsonl`);
    const streamPath = path.join(root, 'exec.jsonl');
    writeJsonl(sessionPath, [tokenCount(1200, 80)]);
    writeJsonl(streamPath, [
      { type: 'thread.started', thread_id: threadId },
      { type: 'turn.completed', usage: { input_tokens: 1200, output_tokens: 80 } },
    ]);

    const result = runMetrics([
      '--label', 'TEST',
      '--rollout', streamPath,
      '--codex-home', codexHome,
      '--json',
    ]);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.summary.usage.requestCount, 1);
    assert.equal(parsed.summary.usage.inputTokens, 1200);
    assert.equal(parsed.rollouts[0].requestedFile, streamPath);
    assert.equal(parsed.rollouts[0].file, sessionPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('metrics treats a missing Micro usage log as zero calls', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-ab-metrics-'));
  try {
    const threadId = 'thread-01a0e925-missing-micro';
    const codexHome = path.join(root, 'codex-home');
    const sessionPath = path.join(codexHome, 'sessions', '2026', '09', '29', `rollout-${threadId}.jsonl`);
    const streamPath = path.join(root, 'exec.jsonl');
    const missingMicro = path.join(root, 'missing-micro-usage.jsonl');
    writeJsonl(sessionPath, [tokenCount(1200, 80)]);
    writeJsonl(streamPath, [
      { type: 'thread.started', thread_id: threadId },
      { type: 'turn.completed', usage: { input_tokens: 1200, output_tokens: 80 } },
    ]);

    const result = runMetrics([
      '--label', 'TEST',
      '--rollout', streamPath,
      '--codex-home', codexHome,
      '--micro-usage', missingMicro,
      '--json',
    ]);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.summary.micro.calls, 0);
    assert.equal(parsed.microUsage[0].missing, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('metrics rejects a codex exec stream without a codex home', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-ab-metrics-'));
  try {
    const streamPath = path.join(root, 'exec.jsonl');
    writeJsonl(streamPath, [
      { type: 'thread.started', thread_id: 'thread-without-home' },
      { type: 'turn.completed', usage: { input_tokens: 1200, output_tokens: 80 } },
    ]);

    const result = runMetrics(['--label', 'TEST', '--rollout', streamPath]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /pass --codex-home/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('metrics rejects rollout data without per-request usage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-ab-metrics-'));
  try {
    const rolloutPath = path.join(root, 'rollout.jsonl');
    writeJsonl(rolloutPath, [{ type: 'session_meta', payload: { id: 'session-without-usage' } }]);

    const result = runMetrics(['--label', 'TEST', '--rollout', rolloutPath]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no token_count usage/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
