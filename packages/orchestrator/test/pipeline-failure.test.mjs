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
    assert.match(output, /pipeline=PARTIAL/);
    assert.match(output, /inspect=OK[\s\S]*useful evidence/);
    assert.match(output, /ops=FAIL/);
    assert.doesNotMatch(output, /pipeline=HALTED/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('pipeline hoists a child-level continueOnFailure control', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-pipeline-child-control-'));
  const ctx = {
    projectRoot,
    orchestrator: {
      dispatch: async (tool) => {
        if (tool === 'ops') {
          return JSON.stringify({ ok: false, exitCode: 1, error: 'No files matched the search pattern.' });
        }
        return '# ContextOS inspect\n\nuseful evidence';
      },
    },
  };

  try {
    const output = await pipelinePipeline(ctx, {
      parallel: [
        {
          tool: 'ops',
          args: { capability: 'run_command', args: { command: 'rg missing' } },
          continueOnFailure: true,
        },
        { inspect: { path: 'README.md' } },
      ],
    });

    assert.match(output, /pipeline=PARTIAL/);
    assert.match(output, /useful evidence/);
    assert.doesNotMatch(output, /pipeline=HALTED/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('pipeline propagates top-level refresh controls to child reads', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-pipeline-refresh-'));
  const calls = [];
  const ctx = {
    projectRoot,
    orchestrator: {
      dispatch: async (tool, input) => {
        calls.push({ tool, input });
        return '# ContextOS inspect\n\nfresh evidence';
      },
    },
  };

  try {
    await pipelinePipeline(ctx, {
      parallel: [{ inspect: { path: 'README.md' } }],
      refresh: true,
      dedupeReads: false,
    });

    assert.equal(calls[0].input.refresh, true);
    assert.equal(calls[0].input.dedupeReads, false);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('pipeline receipt mode preserves explore locators and the next action', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-pipeline-receipt-locator-'));
  const ctx = {
    projectRoot,
    orchestrator: {
      dispatch: async () => [
        '# ContextOS explore',
        '',
        '## Next',
        'change({ intent: "implement batch replay" })',
        '',
        '## Where to look',
        '- `src/batch-replay.mjs` (func replayBatch L1-L5)',
        '- `test/integration/batch-replay.test.mjs`',
      ].join('\n'),
    },
  };

  try {
    const output = await pipelinePipeline(ctx, {
      mode: 'receipt',
      parallel: [{ explore: { intent: 'locate batch replay' } }],
    });

    assert.match(output, /src\/batch-replay\.mjs/);
    assert.match(output, /change\(/);
    assert.ok(output.length < 1600, `receipt decision packet should stay bounded, got ${output.length}`);
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

test('pipeline failure projection surfaces the root cause under a YAML error label', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-pipeline-yaml-error-'));
  const noise = `failure evidence ${'x'.repeat(3000)}`;
  const ctx = {
    projectRoot,
    orchestrator: {
      dispatch: async () => [
        '# ContextOS verify',
        '',
        '## Verdict: FAIL',
        '- `npm test` -> exit 1 (350ms, receipt receipt-yaml-1)',
        '',
        '## Failures',
        '### `npm test`',
        '# Subtest: batch replay preserves idempotency',
        'not ok 1 - batch replay preserves idempotency',
        '  ---',
        "  error: |-",
        '    batch replay is not implemented',
        `    ${noise}`,
        "  stack: |-",
        '    replayBatch (file:///tmp/repo/src/batch-replay.mjs:3:9)',
        '  ...',
      ].join('\n'),
    },
  };

  try {
    const output = await pipelinePipeline(ctx, {
      parallel: [{ verify: { commands: ['npm test'] } }],
    });

    assert.match(output, /pipeline=HALTED/);
    assert.match(output, /batch replay is not implemented/);
    assert.match(output, /replayBatch/);
    assert.match(output, /receipt=receipt-yaml-1/);
    assert.ok(output.length < 1200, `pipeline failure should stay bounded, got ${output.length}`);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('pipeline explicit full output widens beyond the compact default budget', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-pipeline-full-'));
  const tail = 'FULL-EVIDENCE-TAIL';
  const ctx = {
    projectRoot,
    orchestrator: {
      dispatch: async () => `# ContextOS inspect\n\n${'x'.repeat(4200)}${tail}`,
    },
  };

  try {
    const output = await pipelinePipeline(ctx, {
      parallel: [{ inspect: { path: 'src/large.mjs' } }],
      budget: 'full',
      maxChars: 6000,
    });

    assert.match(output, /pipeline=OK/);
    assert.match(output, new RegExp(tail));
    assert.doesNotMatch(output, /response truncated/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('pipeline treats verify mode full as verification, not process control', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-pipeline-verify-full-'));
  const ctx = {
    projectRoot,
    orchestrator: {
      dispatch: async () => '# ContextOS verify\n\n## Verdict: FAIL\n- `npm test` -> exit 1\nAssertionError',
    },
  };

  try {
    const output = await pipelinePipeline(ctx, {
      parallel: [{ verify: { commands: ['npm test'], mode: 'full' } }],
    });

    assert.match(output, /pipeline=HALTED/);
    assert.match(output, /verify=FAIL/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('pipeline runs a predeclared failure branch without deciding on its own', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-pipeline-branch-'));
  const calls = [];
  const ctx = {
    projectRoot,
    orchestrator: {
      dispatch: async (tool, input) => {
        calls.push({ tool, input });
        if (tool === 'verify') {
          return '# ContextOS verify\n\n## Verdict: FAIL\n- `npm test` -> exit 1';
        }
        return JSON.stringify({ ok: true, content: 'triaged failure' });
      },
    },
  };

  try {
    const output = await pipelinePipeline(ctx, {
      steps: [{ verify: { commands: ['npm test'] } }],
      branches: [{
        when: { failed: true, tool: 'verify' },
        then: [{
          tool: 'ops',
          args: { capability: 'micro', action: 'run', args: { prompt: 'triage the failure' } },
        }],
      }],
      budget: { maxActions: 3 },
    });

    assert.deepEqual(calls.map((call) => call.tool), ['verify', 'ops']);
    assert.match(output, /pipeline=RECOVERED/);
    assert.match(output, /branch#1 OK/);
    assert.match(output, /triaged failure/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('pipeline stops at the predeclared maxActions budget', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-pipeline-budget-'));
  const calls = [];
  const ctx = {
    projectRoot,
    orchestrator: {
      dispatch: async (tool) => {
        calls.push(tool);
        return '# ContextOS inspect\n\nok';
      },
    },
  };

  try {
    const output = await pipelinePipeline(ctx, {
      steps: [
        { inspect: { path: 'a.mjs' } },
        { inspect: { path: 'b.mjs' } },
      ],
      budget: { maxActions: 1 },
    });

    assert.deepEqual(calls, ['inspect']);
    assert.match(output, /pipeline=HALTED/);
    assert.match(output, /budget exceeded: maxActions=1/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
