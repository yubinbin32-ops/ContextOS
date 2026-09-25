import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readArtifact } from '../src/artifact-store.mjs';
import { normalizeMicroPreloadSpec, runMicroPreload } from '../src/micro-preload.mjs';

function createContext(root, dispatch) {
  return {
    projectRoot: root,
    orchestrator: { dispatch },
    caps: {},
    store: {},
    tracer: { step() {} },
    profile: {},
  };
}

test('Micro preload injects full bounded Pipeline evidence from its artifact', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-micro-preload-'));
  try {
    const raw = `# ContextOS inspect\n\n${'raw context line\n'.repeat(400)}`;
    const result = await runMicroPreload(createContext(root, async () => raw), {
      steps: [{ inspect: { path: 'src/large.mjs' } }],
      maxChars: 12000,
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');
    assert.ok(result.artifactId, 'preload must create an artifact');
    assert.ok(result.summary.length <= 12000, 'Micro evidence must stay within its explicit bound');
    assert.match(result.summary, /raw context line\nraw context line/);
    assert.equal(result.truncated, false);
    assert.equal(result.fullChars, result.chars);
    assert.match(readArtifact(root, result.artifactId).text, /raw context line/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Micro preload honors child evidence caps when reading the Pipeline artifact', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-micro-preload-child-cap-'));
  try {
    const raw = `# ContextOS inspect\n\n${'large source line\n'.repeat(400)}`;
    const result = await runMicroPreload(createContext(root, async () => raw), {
      steps: [{ inspect: { path: 'src/large.mjs', maxChars: 300 } }],
      maxChars: 1000,
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');
    assert.equal(result.truncated, false);
    assert.ok(result.summary.length <= 1000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Micro preload auto-bounds multi-step evidence without a dirty retry round', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-micro-preload-auto-bound-'));
  try {
    const raw = `# ContextOS inspect\n\n${'large architecture line\n'.repeat(400)}`;
    const result = await runMicroPreload(createContext(root, async () => raw), {
      steps: [
        { inspect: { path: 'src/a.mjs' } },
        { inspect: { path: 'src/b.mjs' } },
        { inspect: { path: 'src/c.mjs' } },
      ],
      maxChars: 1200,
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');
    assert.equal(result.truncated, false);
    assert.equal(result.projectedSteps, 3);
    assert.ok(result.summary.length <= 1200);
    assert.match(result.summary, /Micro preload truncated/);
    assert.ok(result.fullChars > result.chars);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Micro preload marks over-budget evidence so the provider call can be skipped', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-micro-preload-truncated-'));
  try {
    const raw = `# ContextOS inspect\n\n${'raw context line\n'.repeat(400)}`;
    const result = await runMicroPreload(createContext(root, async () => raw), {
      steps: [{ inspect: { paths: ['src/large.mjs'] } }],
      maxChars: 1200,
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'TRUNCATED');
    assert.equal(result.truncated, true);
    assert.ok(result.fullChars > result.chars);
    assert.match(result.error, /narrow the OS steps/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Micro preload accepts the search shorthand', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-micro-preload-search-'));
  try {
    const calls = [];
    const result = await runMicroPreload(createContext(root, async (tool, input) => {
      calls.push({ tool, input });
      return '# Search: `retention`\n\n## Textual matches\n- `src/a.mjs`:L1: retention';
    }), {
      steps: [{ search: { query: 'retention', globs: ['src/**/*.mjs'] } }],
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, 'ops');
    assert.equal(calls[0].input.capability, 'code');
    assert.equal(calls[0].input.action, 'search');
    assert.deepEqual(calls[0].input.args.globs, ['src/**/*.mjs']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Micro preload accepts a Pipeline definition attached at creation time', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-micro-preload-pipeline-alias-'));
  try {
    const spec = normalizeMicroPreloadSpec({
      pipeline: {
        parallel: [
          { inspect: { path: 'src/a.mjs' } },
          { search: { query: 'retention' } },
        ],
        maxChars: 2400,
        allowCommands: true,
      },
    });
    assert.deepEqual(spec.steps, [{ parallel: [
      { inspect: { path: 'src/a.mjs' } },
      { search: { query: 'retention' } },
    ] }]);
    assert.equal(spec.maxChars, 2400);
    assert.equal(spec.allowCommands, true);

    const result = await runMicroPreload(createContext(root, async () => '# ContextOS evidence\n\n- attached pipeline'), {
      pipeline: [{ inspect: { path: 'src/a.mjs' } }],
      maxChars: 1800,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');
    assert.match(result.summary, /attached pipeline/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Micro preload reuses unchanged read-only Pipeline evidence and refresh bypasses the cache', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-micro-preload-cache-'));
  try {
    let calls = 0;
    const dispatch = async () => {
      calls += 1;
      return '# ContextOS inspect\n\n- stable evidence';
    };
    const first = await runMicroPreload(createContext(root, dispatch), {
      pipeline: [{ inspect: { path: 'src/a.mjs' } }],
    });
    const second = await runMicroPreload(createContext(root, dispatch), {
      pipeline: [{ inspect: { path: 'src/a.mjs' } }],
    });
    const fresh = await runMicroPreload(createContext(root, dispatch), {
      pipeline: [{ inspect: { path: 'src/a.mjs' } }],
      refresh: true,
    });

    assert.equal(first.ok, true);
    assert.equal(first.cacheHit, false);
    assert.equal(first.pipelineRuns, 1);
    assert.equal(second.ok, true);
    assert.equal(second.cacheHit, true);
    assert.equal(second.pipelineRuns, 0);
    assert.equal(fresh.cacheHit, false);
    assert.equal(fresh.pipelineRuns, 1);
    assert.equal(calls, 2, 'the unchanged second request must reuse the first Pipeline result');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Micro preload collects test failures and continues to later evidence steps', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-micro-preload-failure-'));
  try {
    const calls = [];
    const result = await runMicroPreload(createContext(root, async (tool, input) => {
      calls.push({ tool, input });
      if (tool === 'verify') {
        return '# ContextOS verify\n\n## Verdict: FAIL\n- `npm test` -> exit 1\nAssertionError: expected 1 but got 2';
      }
      return '# ContextOS inspect\n\n## Inspection Result\n- relevant source';
    }), {
      allowCommands: true,
      onFailure: 'collect',
      steps: [
        { verify: { command: 'npm test' } },
        { inspect: { path: 'src/queue.mjs' } },
      ],
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'FAIL');
    assert.equal(calls.length, 2, 'failure collection must not stop the remaining evidence step');
    assert.match(result.summary, /Pipeline status: FAIL/);
    assert.match(result.summary, /AssertionError/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Micro preload requires steps and rejects Pipeline artifacts with no usable output', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-micro-preload-empty-'));
  try {
    const emptySteps = await runMicroPreload(createContext(root, async () => 'unused'), { steps: [] });
    assert.equal(emptySteps.ok, false);
    assert.equal(emptySteps.status, 'ERROR');
    assert.match(emptySteps.error, /requires steps/);

    const blankOutput = await runMicroPreload(createContext(root, async () => ''), {
      steps: [{ inspect: { path: 'src/blank.mjs' } }],
    });
    assert.equal(blankOutput.ok, false);
    assert.equal(blankOutput.status, 'ERROR');
    assert.match(blankOutput.error, /no usable Pipeline step output/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Micro preload rejects mutations, nested Micro, and unapproved commands', () => {
  assert.throws(
    () => normalizeMicroPreloadSpec({ steps: [{ change: { path: 'src/a.mjs' } }] }),
    /does not allow mutation/
  );
  assert.throws(
    () => normalizeMicroPreloadSpec({ steps: [{ tool: 'micro', args: { task: 'nested' } }] }),
    /does not allow tool 'micro'/
  );
  assert.throws(
    () => normalizeMicroPreloadSpec({ steps: [{ run: 'npm test' }] }),
    /requires allowCommands:true/
  );
  assert.throws(
    () => normalizeMicroPreloadSpec({ steps: [{ inspect: { path: 'a.mjs' } }], allowMutations: true }),
    /read-only/
  );
});
