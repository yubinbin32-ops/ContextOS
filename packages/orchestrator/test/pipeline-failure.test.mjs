import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { pipelinePipeline, verifyPipeline } from '../src/pipelines.mjs';
import { runCommand } from '../../process-host/src/runner.mjs';

test('pipeline preserves a Micro report instead of applying the generic ops clip', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-pipeline-micro-output-'));
  const body = `BEGIN\n${'m'.repeat(8000)}\nEND`;
  const ctx = {
    projectRoot,
    orchestrator: {
      dispatch: async () => body,
    },
  };

  try {
    const output = await pipelinePipeline(ctx, {
      steps: [{ ops: { capability: 'micro', action: 'run' } }],
    });
    assert.match(output, /## Step 1: micro/);
    assert.match(output, /END/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('pipeline returns a resumable partial result at the continuation window', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-pipeline-continuation-'));
  const calls = [];
  const ctx = {
    projectRoot,
    orchestrator: {
      dispatch: async (tool, input) => {
        calls.push({ tool, input });
        await new Promise((resolve) => setTimeout(resolve, 10));
        return '# ContextOS inspect\n\nok';
      },
    },
  };

  try {
    const output = await pipelinePipeline(ctx, {
      steps: [
        { inspect: { path: 'README.md' } },
        { inspect: { path: 'DECISION.md' } },
      ],
      budget: { maxDurationMs: 1 },
    });

    assert.equal(calls.length, 1);
    assert.match(output, /pipeline=PARTIAL/);
    assert.match(output, /partial=true resume=\{"kind":"pipeline","fromStep":2,"totalSteps":2\}/);
    assert.match(output, /completed steps are skipped/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('pipeline clamps in-call wait windows to the remaining continuation budget', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-pipeline-wait-budget-'));
  const waits = [];
  const ctx = {
    projectRoot,
    orchestrator: {
      dispatch: async (tool, input) => {
        waits.push({ tool, waitMs: input.waitMs });
        await new Promise((resolve) => setTimeout(resolve, 40));
        return '# ContextOS integrate\n- status=noop changed=0';
      },
    },
  };

  try {
    const output = await pipelinePipeline(ctx, {
      steps: [
        { tool: 'integrate', args: { jobId: 'agent-wait-budget-1', waitMs: 60000 } },
        { tool: 'integrate', args: { jobId: 'agent-wait-budget-2', waitMs: 60000 } },
      ],
      budget: { maxDurationMs: 30 },
    });

    assert.equal(waits.length, 1);
    assert.equal(waits[0].tool, 'integrate');
    assert.ok(waits[0].waitMs >= 1 && waits[0].waitMs <= 30, `wait must be bounded, got ${waits[0].waitMs}`);
    assert.match(output, /pipeline=PARTIAL/);
    assert.match(output, /resume=\{"kind":"pipeline","fromStep":2,"totalSteps":2\}/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('pipeline resume handle skips completed steps when the full flow is resent', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-pipeline-resume-'));
  fs.writeFileSync(path.join(projectRoot, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(projectRoot, 'b.txt'), 'b\n');
  const calls = [];
  const ctx = {
    projectRoot,
    orchestrator: {
      dispatch: async (tool, input) => {
        calls.push(input.path || tool);
        await new Promise((resolve) => setTimeout(resolve, 12));
        return `# ContextOS inspect\n\n${input.path || tool}`;
      },
    },
  };
  const steps = [
    { tool: 'inspect', args: { path: 'a.txt' } },
    { tool: 'inspect', args: { path: 'b.txt' } },
  ];

  try {
    const partial = await pipelinePipeline(ctx, { steps, budget: { maxDurationMs: 1 } });
    assert.equal(calls.length, 1);
    assert.match(partial, /resume=\{"kind":"pipeline","fromStep":2,"totalSteps":2\}/);

    const resumed = await pipelinePipeline(ctx, {
      steps,
      resume: { kind: 'pipeline', fromStep: 2, totalSteps: 2 },
      budget: { maxDurationMs: 1000 },
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1], 'b.txt');
    assert.match(resumed, /pipeline=OK/);
    assert.match(resumed, /actions=1\/1/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('pipeline accepts command shorthand and tool aliases as run_command steps', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-pipeline-command-'));
  const calls = [];
  const ctx = {
    projectRoot,
    orchestrator: {
      dispatch: async (tool, input) => {
        calls.push({ tool, input });
        return JSON.stringify({ ok: true, exitCode: 0, text: 'command ran' });
      },
    },
  };

  try {
    const output = await pipelinePipeline(ctx, {
      steps: [
        { command: { command: 'node --version', focus: 'version' } },
        { tool: 'command', args: { command: 'npm --version' } },
      ],
    });

    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.tool === 'ops'));
    assert.deepEqual(calls.map((call) => call.input.args.command), ['node --version', 'npm --version']);
    assert.ok(calls.every((call) => call.input.capability === 'run_command'));
    assert.match(output, /pipeline=OK/);
    assert.match(output, /command ran/);
    assert.match(output, /"exitCode":0/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('pipeline accepts ask as an inspect alias', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-pipeline-ask-alias-'));
  const calls = [];
  const ctx = {
    projectRoot,
    orchestrator: {
      dispatch: async (tool, input) => {
        calls.push({ tool, input });
        return '# ContextOS ask\n\nok';
      },
    },
  };

  try {
    const output = await pipelinePipeline(ctx, {
      steps: [
        { tool: 'ask', args: { inspect: [{ path: 'src/a.mjs', ranges: [[1, 2]] }] } },
        { tool: 'ask', args: { inspect: [{ path: 'src/b.mjs', ranges: [[1, 2]] }] } },
      ],
    });

    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.tool === 'inspect'));
    assert.deepEqual(calls.map((call) => call.input.inspect[0].path), ['src/a.mjs', 'src/b.mjs']);
    assert.match(output, /pipeline=OK/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('verify includes full stdout when full evidence is requested', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-pipeline-verify-output-'));
  const tail = 'VERIFY-FULL-STDOUT-TAIL';
  let runArgs = null;
  const ctx = {
    projectRoot,
    profile: {},
    caps: {
      run: async (args) => {
        runArgs = args;
        return {
          ok: true,
          data: {
            id: 'verify-receipt',
            command: 'echo hi',
            cwd: projectRoot,
            exitCode: 0,
            durationMs: 3,
            text: `${'v'.repeat(5200)}\n${tail}`,
          },
        };
      },
    },
    store: {
      current: { receipts: [] },
      currentPassingReceipt: () => null,
      attachReceipt: () => {},
    },
    tracer: { step: () => {} },
    actionEvidence: { verifications: [] },
  };

  try {
    const output = await verifyPipeline(ctx, { commands: ['echo hi'], full: true });
    assert.equal(runArgs.raw, true);
    assert.equal(runArgs.maxChars, Infinity);
    assert.match(output, new RegExp(tail));
    assert.doesNotMatch(output, /output truncated/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('pipeline command actions return stdout beyond the run_command preview limit', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-pipeline-command-output-'));
  const script = path.join(projectRoot, 'emit-long-output.mjs');
  const tail = 'PIPELINE-COMMAND-STDOUT-TAIL';
  fs.writeFileSync(script, `process.stdout.write('x'.repeat(5200) + '\\n${tail}\\n');\n`);
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
  const calls = [];
  const ctx = {
    projectRoot,
    orchestrator: {
      dispatch: async (tool, input) => {
        calls.push({ tool, input });
        const receipt = await runCommand({
          ...input.args,
          cwd: projectRoot,
          projectRoot,
        });
        return JSON.stringify(receipt);
      },
    },
  };

  try {
    const output = await pipelinePipeline(ctx, { steps: [{ command }] });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, 'ops');
    assert.equal(calls[0].input.capability, 'run_command');
    assert.equal(calls[0].input.args.raw, true);
    assert.equal(calls[0].input.args.maxChars, Infinity);
    assert.ok(output.length > 5000, `expected full command output, got ${output.length}`);
    assert.match(output, new RegExp(tail));
    assert.doesNotMatch(output, /\[output truncated\]/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('pipeline accepts type-based tool steps used by micro', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-pipeline-type-step-'));
  const calls = [];
  const ctx = {
    projectRoot,
    orchestrator: {
      dispatch: async (tool, input) => {
        calls.push({ tool, input });
        return '# ContextOS inspect\n\nok';
      },
    },
  };

  try {
    const output = await pipelinePipeline(ctx, {
      parallel: [
        { type: 'inspect', path: 'README.md', ranges: [[1, 2]] },
        { type: 'inspect', path: 'DECISION.md', ranges: [[1, 2]] },
      ],
    });

    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.tool === 'inspect'));
    assert.deepEqual(calls.map((call) => call.input.path), ['README.md', 'DECISION.md']);
    assert.deepEqual(calls.map((call) => call.input.ranges), [[[1, 2]], [[1, 2]]]);
    assert.match(output, /pipeline=OK/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

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
    assert.match(output, /## Step 1: parallel \[FAIL\]/);
    assert.match(output, /micro \[FAIL\]/);
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
    assert.match(output, /inspect[\s\S]*useful evidence/);
    assert.match(output, /run_command \[FAIL\]/);
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
    assert.match(output, /verify \[FAIL\]/);
    assert.match(output, /Micro-Triage/);
    assert.match(output, /replayBatch/);
    assert.match(output, /receipt receipt-triage-1/);
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
    assert.match(output, /receipt receipt-yaml-1/);
    assert.ok(output.length > 3000, `expected full failure evidence, got ${output.length}`);
    assert.doesNotMatch(output, /response truncated|action output truncated/);
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
    assert.match(output, /verify \[FAIL\]/);
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
    assert.match(output, /## Branch 1/);
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

test('pipeline runs more than eight parallel actions without a concurrency clamp', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-pipeline-parallel-'));
  const calls = [];
  let active = 0;
  let peak = 0;
  const ctx = {
    projectRoot,
    orchestrator: {
      dispatch: async (_tool, input) => {
        calls.push(input.path);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return `# ContextOS inspect\n\n${input.path}`;
      },
    },
  };

  try {
    const output = await pipelinePipeline(ctx, {
      parallel: Array.from({ length: 20 }, (_, index) => ({ inspect: { path: `a-${index + 1}.mjs` } })),
    });

    assert.equal(calls.length, 20);
    assert.ok(peak > 8, `expected more than 8 concurrent actions, got ${peak}`);
    assert.match(output, /a-20\.mjs/);
    assert.match(output, /pipeline=OK/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('pipeline preserves full step output beyond the old 4000-character cap', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-pipeline-full-output-'));
  const body = `# ContextOS inspect\n\n${'x'.repeat(5200)}\nFULL-OUTPUT-TAIL`;
  const ctx = {
    projectRoot,
    orchestrator: {
      dispatch: async () => body,
    },
  };

  try {
    const output = await pipelinePipeline(ctx, {
      parallel: [{ inspect: { path: 'src/large.mjs' } }],
    });

    assert.ok(output.includes(body));
    assert.ok(output.length > 5200);
    assert.doesNotMatch(output, /response truncated|action output truncated|os-response|os-budget|artifact=/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('pipeline renderer uses clean step boundaries without transport metadata', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-pipeline-render-'));
  const ctx = {
    projectRoot,
    orchestrator: {
      dispatch: async (tool) => tool === 'ops'
        ? JSON.stringify({
          id: 'receipt-clean',
          command: 'node --version',
          exitCode: 0,
          text: 'v22.22.1',
          logHandle: '.contextos/logs/receipt-clean.log',
        })
        : '# ContextOS inspect\n\nsource body',
    },
  };

  try {
    const output = await pipelinePipeline(ctx, {
      steps: [
        { inspect: { path: 'src/a.mjs' } },
        { parallel: [
          { inspect: { path: 'src/b.mjs' } },
          { command: { command: 'node --version' } },
        ] },
      ],
    });

    assert.match(output, /^# ContextOS pipeline/);
    assert.match(output, /## Step 1: inspect/);
    assert.match(output, /## Step 2: parallel/);
    assert.match(output, /### Action 2\.1: inspect/);
    assert.match(output, /### Action 2\.2: run_command/);
    assert.match(output, /v22\.22\.1/);
    assert.doesNotMatch(output, /receipt-clean|logHandle|exitCode/);
    assert.doesNotMatch(output, /inspect=OK|parallel#|step#|os-response|os-budget|receipt=/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
