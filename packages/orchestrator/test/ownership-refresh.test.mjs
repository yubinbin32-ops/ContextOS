import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ContextOSV2Service } from '../../mcp/src/v2-service.mjs';
import { Orchestrator } from '../src/index.mjs';

test('scoped explicit and automatic ownership refresh preserve untouched paths and remove stale symbols', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-owner-refresh-'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"owner-refresh","type":"module"}');
  fs.writeFileSync(path.join(root, 'edit.mjs'), 'export function oldName() { return 1; }\n');
  fs.writeFileSync(path.join(root, 'stable.mjs'), 'export function stableName() { return 2; }\n');
  const service = new ContextOSV2Service({ projectRoot: root });
  const orchestrator = new Orchestrator({ projectRoot: root, service });
  try {
    await service.block({ action: 'bind_auto', id: 'owner', blockData: { title: 'Shared owner', kind: 'component' }, paths: ['edit.mjs', 'stable.mjs'] });
    await service.chain({ action: 'compose', chainData: { id: 'owner-chain', title: 'Owner chain', memberIds: ['owner'] } });
    const before = await service.block({ action: 'open', id: 'owner', format: 'json' });
    const stable = before.artifactRefs.filter((r) => r.path === 'stable.mjs');
    for (const [oldName, newName, explicit] of [['oldName', 'newName', true], ['newName', 'finalName', false]]) {
      const result = await orchestrator.dispatch('change', {
        edits: [{ path: 'edit.mjs', target: oldName, replacement: newName }],
        ...(explicit ? { architecture: { blocks: [{ id: 'owner', title: 'Shared owner', paths: ['edit.mjs'] }], chains: [{ id: 'owner-chain', memberIds: ['owner'] }] } } : {}),
        verify: { commands: ['node --check edit.mjs'] },
      });
      assert.match(result, /Verify: PASS/);
      const after = await service.block({ action: 'open', id: 'owner', format: 'json' });
      assert.deepEqual(after.artifactRefs.filter((r) => r.path === 'stable.mjs'), stable);
      assert.deepEqual(after.artifactRefs.filter((r) => r.path === 'edit.mjs').map((r) => r.symbol), [newName]);
    }
  } finally { service.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
