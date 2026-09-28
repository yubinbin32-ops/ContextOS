import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createComplexSystemFixture } from './complex-system-fixture.mjs';

const EXTRA_FILES = {
  'src/batch-replay.mjs': `export async function replayBatch() {
  throw new Error('batch replay is not implemented');
}
`,
  'src/audit-report.mjs': `export function buildAuditReport() {
  throw new Error('audit report is not implemented');
}
`,
  'test/integration/batch-replay.test.mjs': `import assert from 'node:assert/strict';
import test from 'node:test';
import { createJobApi } from '../../src/api.mjs';
import { buildAuditReport } from '../../src/audit-report.mjs';
import { replayBatch } from '../../src/batch-replay.mjs';

test('batch replay preserves idempotency, terminal state, and audit events', async () => {
  const events = [];
  let idCounter = 0;
  const api = createJobApi({
    idFactory: () => \`batch-job-\${++idCounter}\`,
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
});
`,
  'test/fixtures/large-failure-context.mjs': `export const expected = {
  contract: 'durable replay',
  evidence: ${JSON.stringify('failure evidence '.repeat(80))},
};
`,
};

export function createComplexLifecycleFixture(root, { noisyFailure = false } = {}) {
  createComplexSystemFixture(root);
  const packagePath = path.join(root, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  packageJson.scripts.test = 'node --test test/*.test.mjs test/integration/*.test.mjs';
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
  const extraFiles = noisyFailure
    ? {
        ...EXTRA_FILES,
        'src/batch-replay.mjs': `const diagnostic = 'failure evidence '.repeat(120);
export async function replayBatch() {
  throw new Error(\`batch replay is not implemented\\n\${diagnostic}\`);
}
`,
      }
    : EXTRA_FILES;
  for (const [relative, content] of Object.entries(extraFiles)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', [
    '-c', 'user.name=ContextOS',
    '-c', 'user.email=contextos@example.test',
    'commit', '-m', 'complex lifecycle fixture baseline',
  ], { cwd: root, stdio: 'ignore' });
  return root;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const root = path.resolve(args.find((value) => !value.startsWith('--')) || '.');
  createComplexLifecycleFixture(root, { noisyFailure: args.includes('--noisy-failure') });
  console.log(root);
}
