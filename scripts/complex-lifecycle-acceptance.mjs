import assert from 'node:assert/strict';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const { createJobApi } = await import(path.join(root, 'src/api.mjs'));
const { buildAuditReport } = await import(path.join(root, 'src/audit-report.mjs'));
const { replayBatch } = await import(path.join(root, 'src/batch-replay.mjs'));

const events = [];
let idCounter = 0;
const api = createJobApi({
  idFactory: () => `acceptance-job-${++idCounter}`,
  onEvent: (event) => events.push(event),
  handler: async (payload, context) => {
    if (payload.mode === 'retry' && context.attempt < 2) {
      const error = new Error('temporary upstream');
      error.retryable = true;
      throw error;
    }
    if (payload.mode === 'fail') {
      const error = new Error('permanent failure');
      error.retryable = false;
      throw error;
    }
    return { value: payload.value };
  },
});

const replay = await replayBatch(api, [
  { idempotencyKey: 'retry-key', payload: { mode: 'retry', value: 7 } },
  { idempotencyKey: 'retry-key', payload: { mode: 'retry', value: 7 } },
  { idempotencyKey: 'retry-key', payload: { mode: 'retry', value: 7 } },
  { idempotencyKey: 'failure-key', payload: { mode: 'fail', value: 0 } },
  { idempotencyKey: 'retry-key', payload: { mode: 'retry', value: 8 }, expectConflict: true },
]);
const report = buildAuditReport({ metrics: replay.metrics, events, records: replay.records });

assert.equal(replay.conflicts, 1);
assert.equal(replay.records.length, 2);
assert.deepEqual(report.metrics, {
  deduplicated: 2,
  failed: 1,
  retried: 1,
  submitted: 2,
  succeeded: 1,
});
assert.deepEqual(report.events, { retry: 1, succeeded: 1, failed: 1 });
assert.equal(replay.records.find((record) => record.idempotencyKey === 'retry-key').attempts, 2);
assert.equal(replay.records.find((record) => record.idempotencyKey === 'failure-key').status, 'failed');

console.log(JSON.stringify({ ok: true, conflicts: replay.conflicts, metrics: report.metrics, events: report.events }));
