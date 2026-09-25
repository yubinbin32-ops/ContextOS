import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Orchestrator } from '../src/index.mjs';
import { ContextOSV2Service } from '../../mcp/src/v2-service.mjs';

test('inspect resolves a top-level AST symbol selector without returning the file prologue', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-symbol-read-'));
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  const lines = [
    'export const prologueSentinel = true;',
    ...Array.from({ length: 80 }, (_, index) => `export const filler${index} = ${index};`),
    'export function selectedSymbol() {',
    '  return true;',
    '}',
  ];
  fs.writeFileSync(path.join(projectRoot, 'src', 'fixture.mjs'), lines.join('\n'));

  const service = new ContextOSV2Service({ projectRoot, projectId: 'symbol-selector-test' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'symbol-selector-test' });
  try {
    const result = await orchestrator.dispatch('inspect', {
      path: 'src/fixture.mjs',
      symbol: 'selectedSymbol',
      budget: 'full',
    });

    assert.match(result, /function selectedSymbol/);
    assert.doesNotMatch(result, /prologueSentinel/);
    assert.match(result, /L82-L84/);
  } finally {
    service.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
