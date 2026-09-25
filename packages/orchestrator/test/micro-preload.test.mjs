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

test('Micro preload keeps raw pipeline output in an artifact and returns a bounded summary', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-micro-preload-'));
  try {
    const raw = `# ContextOS inspect\n\n${'raw context line\n'.repeat(400)}`;
    const result = await runMicroPreload(createContext(root, async () => raw), {
      steps: [{ inspect: { path: 'src/large.mjs' } }],
      maxChars: 1200,
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'OK');
    assert.ok(result.artifactId, 'preload must create an artifact');
    assert.ok(result.summary.length <= 4000, 'summary must stay bounded');
    assert.match(result.summary, /artifact=/);
    assert.doesNotMatch(result.summary, /raw context line\nraw context line\nraw context line/);
    assert.match(readArtifact(root, result.artifactId).text, /raw context line/);
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
    assert.match(result.summary, /pipeline=FAIL/);
    assert.match(result.summary, /AssertionError/);
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
