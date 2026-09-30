import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readPeakContextUsage, summarizeCodexStream } from '../../../scripts/adapters/codex-cli-bridge.mjs';

test('summarizeCodexStream reads the thread id, final message and turn usage', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } }),
  ].join('\n');
  const summary = summarizeCodexStream(stdout);
  assert.equal(summary.threadId, 'thread-1');
  assert.equal(summary.lastAgentMessage, 'final answer');
  assert.deepEqual(summary.usage, { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 });
});

test('readPeakContextUsage reports the peak per-request prompt, not the turn sum', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-codex-bridge-'));
  try {
    const day = path.join(root, '2026', '10', '03');
    fs.mkdirSync(day, { recursive: true });
    const rollout = [
      JSON.stringify({ payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 4000, cached_input_tokens: 1000 }, total_token_usage: { input_tokens: 4000 } } } }),
      JSON.stringify({ payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 120000, cached_input_tokens: 90000 }, total_token_usage: { input_tokens: 124000 } } } }),
      JSON.stringify({ payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 30000, cached_input_tokens: 20000 }, total_token_usage: { input_tokens: 154000 } } } }),
    ].join('\n');
    fs.writeFileSync(path.join(day, 'rollout-2026-10-03T00-00-00-thread-peak.jsonl'), `${rollout}\n`, 'utf8');

    const usage = readPeakContextUsage('thread-peak', { sessionsRoot: root, windowTokens: 233000 });
    assert.equal(usage.input_tokens, 120000);
    assert.equal(usage.cached_input_tokens, 90000);
    assert.equal(usage.window_tokens, 233000);
    assert.equal(readPeakContextUsage('missing-thread', { sessionsRoot: root }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
