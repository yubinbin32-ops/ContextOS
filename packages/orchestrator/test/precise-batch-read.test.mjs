import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Orchestrator } from '../src/index.mjs';
import { ContextOSV2Service } from '../../mcp/src/v2-service.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-precise-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"precise-read-fixture","type":"module"}');
  for (const name of ['first', 'second']) {
    fs.writeFileSync(path.join(root, `src/${name}.mjs`), Array.from({ length: 150 }, (_, i) => `export const ${name}_${i + 1} = ${i + 1};`).join('\n'));
  }
  const service = new ContextOSV2Service({ projectRoot: root });
  return { root, service, orchestrator: new Orchestrator({ projectRoot: root, service }) };
}

test('parallel inspections preserve explicitly requested ranges for large files', async () => {
  const { root, service, orchestrator } = fixture();
  try {
    const result = await orchestrator.dispatch('pipeline', {
      mode: 'full', maxChars: 5000,
      parallel: [
        { inspect: { path: 'src/first.mjs', ranges: [[90, 91]], maxChars: 1800 } },
        { inspect: { path: 'src/second.mjs', startLine: 120, endLine: 121, maxChars: 1800 } },
      ],
    });
    assert.match(result, /first_90 = 90/);
    assert.match(result, /second_120 = 120/);
    assert.doesNotMatch(result, /first_1 = 1;/);
  } finally { service.close?.(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('non-contiguous source slices preserve original line numbers and markers', async () => {
  const { root, service, orchestrator } = fixture();
  try {
    const result = await orchestrator.dispatch('inspect', { path: 'src/first.mjs', ranges: [[2, 3], [90, 91]], maxChars: 4000 });
    assert.match(result, /^\s*2 \| export const first_2 = 2;/m);
    assert.match(result, /^\s*90 \| export const first_90 = 90;/m);
    assert.match(result, /^\/\/ \[L90-L91\]$/m);
    assert.doesNotMatch(result, /^\s*5 \| export const first_90/m);
  } finally { service.close?.(); fs.rmSync(root, { recursive: true, force: true }); }
});
