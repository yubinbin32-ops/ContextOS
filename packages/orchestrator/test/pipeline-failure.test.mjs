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
