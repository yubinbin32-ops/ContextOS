import assert from 'node:assert/strict';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const { createJobApi, ConflictError } = await import(path.join(root, 'src/api.mjs'));

const events = [];
let attempts = 0;
let idCounter = 0;
const api = createJobApi({
  idFactory: () => `acceptance-job-${++idCounter}`,
  maxAttempts: 3,
  onEvent: (event) => events.push(event),
  handler: async (payload, context) => {
    attempts += 1;
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
    return { ok: true, value: payload.value };
  },
});

const first = api.submit({ idempotencyKey: 'same', payload: { mode: 'retry', value: 42 } });
const duplicate = api.submit({ idempotencyKey: 'same', payload: { mode: 'retry', value: 42 } });
assert.equal(first.id, duplicate.id);
assert.equal(first.deduped, false);
assert.equal(duplicate.deduped, true);
assert.throws(
  () => api.submit({ idempotencyKey: 'same', payload: { mode: 'retry', value: 43 } }),
  (error) => error instanceof ConflictError && error.code === 'IDEMPOTENCY_CONFLICT'
);

await api.drain();
assert.equal(api.status(first.id).status, 'succeeded');
assert.equal(api.status(first.id).attempts, 2);
assert.deepEqual(api.status(first.id).result, { ok: true, value: 42 });
assert.equal(events.filter((event) => event.type === 'job.succeeded').length, 1);
assert.equal(events.filter((event) => event.type === 'job.retry').length, 1);

const failed = api.submit({ idempotencyKey: 'failure', payload: { mode: 'fail', value: 0 } });
await api.drain();
assert.equal(api.status(failed.id).status, 'failed');
assert.equal(api.status(failed.id).attempts, 1);

const metrics = api.metrics();
assert.equal(metrics.submitted, 2);
assert.equal(metrics.deduplicated, 1);
assert.equal(metrics.succeeded, 1);
assert.equal(metrics.retried, 1);
assert.equal(metrics.failed, 1);
assert.ok(attempts >= 3);

console.log(JSON.stringify({ ok: true, metrics, eventCount: events.length }));
