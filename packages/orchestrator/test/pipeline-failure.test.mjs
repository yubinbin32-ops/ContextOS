import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { pipelinePipeline } from '../src/pipelines.mjs';

test('pipeline halts when a parallel action returns an inner failure', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-pipeline-failure-'));
  const calls = [];
  const ctx = {
    projectRoot,
    orchestrator: {
      dispatch: async (tool) => {
        calls.push(tool);
        if (tool === 'ops') {
          return JSON.stringify({ ok: false, error: 'Micro URL is not configured.' });
        }
        return '# ContextOS inspect\n\nok';
      },
    },
  };

  try {
    const output = await pipelinePipeline(ctx, {
      parallel: [
        { tool: 'ops', args: { capability: 'micro', action: 'run' } },
        { inspect: { path: 'README.md' } },
      ],
    });

    assert.deepEqual(calls.sort(), ['inspect', 'ops']);
    assert.match(output, /pipeline=HALTED/);
    assert.match(output, /parallel#1 FAIL/);
    assert.match(output, /ops=FAIL/);
    assert.match(output, /Micro URL is not configured/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('pipeline can collect exploratory failures without discarding successful evidence', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-pipeline-collect-'));
  const calls = [];
  const ctx = {
    projectRoot,
    orchestrator: {
      dispatch: async (tool) => {
        calls.push(tool);
        if (tool === 'ops') {
          return JSON.stringify({
            ok: false,
            exitCode: 1,
            error: 'No files matched the search pattern.',
          });
        }
        return '# ContextOS inspect\n\nuseful evidence';
      },
    },
  };

  try {
    const output = await pipelinePipeline(ctx, {
      parallel: [
        { tool: 'ops', args: { capability: 'run_command', args: { command: 'rg missing' } } },
        { inspect: { path: 'README.md' } },
      ],
      continueOnFailure: true,
    });

    assert.deepEqual(calls.sort(), ['inspect', 'ops']);
    assert.match(output, /pipeline=FAIL/);
    assert.match(output, /inspect=OK[\s\S]*useful evidence/);
    assert.match(output, /ops=FAIL/);
    assert.doesNotMatch(output, /pipeline=HALTED/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('pipeline failure projection keeps the Micro triage that the host paid for', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-pipeline-triage-'));
  const noise = Array.from({ length: 120 }, (_, index) => `failure evidence line ${index}`).join('\n');
  const ctx = {
    projectRoot,
    orchestrator: {
      dispatch: async () => [
        '# ContextOS verify',
        '',
        '## Next',
        'change({ intent: "<fix the failure>" }) to fix, then verify again',
        '',
        '## Verdict: FAIL',
        '- `npm test` → exit 1 (363ms, receipt receipt-triage-1)',
        '',
        '## 👉 Micro-Triage (工程诊断小脑)',
        '根因：`replayBatch` 仍是未实现桩，调用即抛出 `batch replay is not implemented`。',
        '修复方向：实现批量重放逻辑，保留幂等、终态与审计事件语义。',
        '',
        '## Failures',
        '### `npm test`',
        noise,
      ].join('\n'),
    },
  };

  try {
    const output = await pipelinePipeline(ctx, {
      parallel: [{ verify: { commands: ['npm test'] } }],
    });

    assert.match(output, /pipeline=HALTED/);
    assert.match(output, /verify=FAIL/);
    assert.match(output, /Micro-Triage/);
    assert.match(output, /replayBatch/);
    assert.match(output, /receipt=receipt-triage-1/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
