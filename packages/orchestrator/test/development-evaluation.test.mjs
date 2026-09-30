import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const metrics = fileURLToPath(new URL('../../../scripts/development-metrics.mjs', import.meta.url));
const usage = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
function report({ completed = true, mismatch = false, quality = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-actual-metrics-'));
  try {
    const rollout = path.join(root, 'rollout.jsonl'); const events = path.join(root, 'events.jsonl'); const run = path.join(root, 'run.json');
    const first = usage(200, 100, 10), second = usage(800, 600, 20);
    fs.writeFileSync(rollout, [
      { type: 'token_usage_record', payload: { response_id: 'one', usage: first, model_context_window: 2000 } },
      { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: first, total_token_usage: first, model_context_window: 2000 } } },
      { type: 'token_usage_record', payload: { response_id: 'two', usage: second } },
    ].map(JSON.stringify).join('\n'));
    const items = [{ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'contextos', status: 'completed' } }];
    if (completed) items.push({ type: 'turn.completed', usage: { ...usage(mismatch ? 2000 : 1000, 700, 30) } });
    fs.writeFileSync(events, items.map(JSON.stringify).join('\n'));
    fs.writeFileSync(run, JSON.stringify({ arm: 'contextos', model: 'gpt-6-luna', effort: 'max', status: completed ? 0 : -15, events, rollouts: [rollout], workspace: root, home: root, quality: { pass: quality }, scopePass: true }));
    return JSON.parse(execFileSync(process.execPath, [metrics, run], { encoding: 'utf8' }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('development accounting reconciles real CLI totals and deduplicates paired snapshots', () => {
  const r = report(); assert.equal(r.validForComparison, true); assert.equal(r.metrics.requestCount, 2);
  assert.equal(r.metrics.inputTokens, 1000); assert.equal(r.metrics.totalTokens, 1030);
  assert.equal(r.metrics.uncachedInputTokens, 300); assert.equal(r.metrics.peakRequestInputTokens, 800);
  assert.equal(r.metrics.peakInputWindowPercent, 40);
});
test('interrupted or contradictory usage cannot produce completed-task savings', () => {
  for (const input of [{ completed: false }, { mismatch: true }]) {
    const r = report(input); assert.equal(r.validForComparison, false); assert.equal(r.metrics, null);
    assert.ok(r.observedPartialMetrics); assert.equal(r.observedPartialMetrics.requestCount, 2);
  }
});
test('a cheaper but incorrect task is excluded even with complete token accounting', () => {
  const r = report({ quality: false }); assert.equal(r.complete, true); assert.equal(r.validForComparison, false);
});
