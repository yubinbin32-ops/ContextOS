import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isCuratedArchitecturePath } from '../src/pipelines.mjs';
import { workspaceFingerprint } from '../src/session-store.mjs';

test('reserved ContextOS state paths are not architecture sources', () => {
  assert.equal(isCuratedArchitecturePath('.contextos/state.sqlite'), false);
  assert.equal(isCuratedArchitecturePath('.contextos-smoke/state.sqlite'), false);
  assert.equal(isCuratedArchitecturePath('.contextos.tmp/module-index.json'), false);
  assert.equal(isCuratedArchitecturePath('src/runtime.mjs'), true);
});

test('reserved ContextOS state paths do not invalidate workspace fingerprints', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-state-paths-'));
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'runtime.mjs'), 'export const value = 1;\n', 'utf8');
    const first = workspaceFingerprint(root);

    fs.mkdirSync(path.join(root, '.contextos-smoke', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(root, '.contextos-smoke', 'logs', 'micro.jsonl'), 'derived\n', 'utf8');
    fs.mkdirSync(path.join(root, '.contextos.tmp'), { recursive: true });
    fs.writeFileSync(path.join(root, '.contextos.tmp', 'state.json'), 'derived\n', 'utf8');
    assert.equal(workspaceFingerprint(root), first);

    fs.writeFileSync(path.join(root, 'src', 'runtime.mjs'), 'export const value = 2;\n', 'utf8');
    assert.notEqual(workspaceFingerprint(root), first);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
