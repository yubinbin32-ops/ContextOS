import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const FILES = {
  'package.json': JSON.stringify({
    name: 'job-system-fixture',
    version: '0.0.0',
    type: 'module',
    scripts: { test: 'node --test test/*.test.mjs' },
  }, null, 2) + '\n',
  'src/errors.mjs': `export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.code = 'IDEMPOTENCY_CONFLICT';
    this.status = 409;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.code = 'NOT_FOUND';
    this.status = 404;
  }
}
`,
  'src/metrics.mjs': `export class Metrics {
  constructor() {
    this.counters = new Map();
  }

  increment(name, amount = 1) {
    this.counters.set(name, (this.counters.get(name) || 0) + amount);
  }

  snapshot() {
    return Object.fromEntries([...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
}
`,
  'src/retry-policy.mjs': `export function shouldRetry(error, attempt, { maxAttempts = 3 } = {}) {
  return attempt < maxAttempts && error?.retryable !== false;
}
`,
  'src/store.mjs': `import { NotFoundError } from './errors.mjs';

export class JobStore {
  constructor() {
    this.jobs = new Map();
  }

  create(record) {
    if (this.jobs.has(record.id)) throw new Error(\`Job already exists: ${'${record.id}'}\`);
    this.jobs.set(record.id, { ...record });
    return this.get(record.id);
  }

  get(id) {
    const record = this.jobs.get(id);
    if (!record) throw new NotFoundError(\`Job not found: ${'${id}'}\`);
    return { ...record };
  }

  update(id, patch) {
    const current = this.get(id);
    this.jobs.set(id, { ...current, ...patch });
    return this.get(id);
  }

  list() {
    return [...this.jobs.values()].map((record) => ({ ...record }));
  }
}
`,
  'src/job-runner.mjs': `import { shouldRetry } from './retry-policy.mjs';

export class JobRunner {
  constructor({ handler, maxAttempts = 3, metrics, onEvent } = {}) {
    if (typeof handler !== 'function') throw new Error('handler is required');
    this.handler = handler;
    this.maxAttempts = maxAttempts;
    this.metrics = metrics;
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
  }

  async run(job) {
    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        const result = await this.handler(job.payload, { attempt, job });
        this.metrics?.increment('succeeded');
        this.onEvent({ type: 'job.succeeded', jobId: job.id, attempt });
        return { status: 'succeeded', result, attempts: attempt };
      } catch (error) {
        if (shouldRetry(error, attempt, { maxAttempts: this.maxAttempts })) {
          this.metrics?.increment('retried');
          this.onEvent({ type: 'job.retry', jobId: job.id, attempt });
          continue;
        }
        this.metrics?.increment('failed');
        this.onEvent({ type: 'job.failed', jobId: job.id, attempt });
        return { status: 'failed', error: error.message, attempts: attempt };
      }
    }
  }
}
`,
  'src/job-queue.mjs': `export class JobQueue {
  constructor({ store, runner, metrics } = {}) {
    if (!store || !runner) throw new Error('store and runner are required');
    this.store = store;
    this.runner = runner;
    this.metrics = metrics;
    this.pending = [];
    this.draining = null;
  }

  enqueue(id) {
    this.pending.push(id);
    return id;
  }

  async drain() {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      while (this.pending.length) {
        const id = this.pending.shift();
        const job = this.store.get(id);
        const outcome = await this.runner.run(job);
        this.store.update(id, outcome);
      }
      return this.store.list();
    })().finally(() => { this.draining = null; });
    return this.draining;
  }
}
`,
  'src/api.mjs': `import crypto from 'node:crypto';
import { ConflictError, NotFoundError } from './errors.mjs';
import { JobQueue } from './job-queue.mjs';
import { JobRunner } from './job-runner.mjs';
import { Metrics } from './metrics.mjs';
import { JobStore } from './store.mjs';

function payloadKey(payload) {
  return JSON.stringify(payload, Object.keys(payload || {}).sort());
}

export function createJobApi({
  handler,
  maxAttempts = 3,
  store = new JobStore(),
  metrics = new Metrics(),
  onEvent,
  idFactory = () => crypto.randomUUID(),
} = {}) {
  const runner = new JobRunner({ handler, maxAttempts, metrics, onEvent });
  const queue = new JobQueue({ store, runner, metrics });
  const idempotency = new Map();

  return {
    submit({ idempotencyKey, payload } = {}) {
      if (!idempotencyKey) throw new Error('idempotencyKey is required');
      const fingerprint = payloadKey(payload);
      const previous = idempotency.get(idempotencyKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint) {
          throw new ConflictError(\`Idempotency key conflicts: ${'${idempotencyKey}'}\`);
        }
        metrics.increment('deduplicated');
        return { ...store.get(previous.jobId), deduped: true };
      }
      const id = idFactory();
      store.create({ id, payload, status: 'pending', attempts: 0, idempotencyKey });
      idempotency.set(idempotencyKey, { fingerprint, jobId: id });
      metrics.increment('submitted');
      queue.enqueue(id);
      return { ...store.get(id), deduped: false };
    },

    status(id) {
      return store.get(id);
    },

    async drain() {
      await queue.drain();
      return store.list();
    },

    metrics() {
      return metrics.snapshot();
    },
  };
}

export { ConflictError, NotFoundError };
`,
  'src/index.mjs': `export * from './api.mjs';
export * from './errors.mjs';
export * from './job-queue.mjs';
export * from './job-runner.mjs';
export * from './metrics.mjs';
export * from './retry-policy.mjs';
export * from './store.mjs';
`,
  'test/job-system.test.mjs': `import assert from 'node:assert/strict';
import test from 'node:test';
import { createJobApi } from '../src/api.mjs';

test('jobs submit, drain, and report retry attempts', async () => {
  let attempts = 0;
  const api = createJobApi({
    idFactory: () => 'job-1',
    handler: async (payload) => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('temporary');
        error.retryable = true;
        throw error;
      }
      return { echoed: payload.value };
    },
  });
  const job = api.submit({ idempotencyKey: 'key-1', payload: { value: 7 } });
  assert.equal(job.status, 'pending');
  await api.drain();
  assert.equal(api.status(job.id).status, 'succeeded');
  assert.equal(api.status(job.id).attempts, 2);
});

test('non-retryable jobs fail', async () => {
  const api = createJobApi({
    idFactory: () => 'job-2',
    handler: async () => { throw new Error('bad input'); },
  });
  const job = api.submit({ idempotencyKey: 'key-2', payload: {} });
  await api.drain();
  assert.equal(api.status(job.id).status, 'failed');
});
`,
};

export function createComplexSystemFixture(root) {
  for (const [relative, content] of Object.entries(FILES)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  fs.writeFileSync(path.join(root, '.gitignore'), '.contextos/\nnode_modules/\n', 'utf8');
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', [
    '-c', 'user.name=ContextOS',
    '-c', 'user.email=contextos@example.test',
    'commit', '-m', 'complex system fixture baseline',
  ], { cwd: root, stdio: 'ignore' });
  return root;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = path.resolve(process.argv[2] || '.');
  createComplexSystemFixture(root);
  console.log(root);
}
