import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ContextOSV2Service } from '../../mcp/src/v2-service.mjs';
import { Orchestrator } from '../src/index.mjs';

const workspace = () => fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-ops-usage-'));

test('ops usage records main-role tokens and reports weighted main-equivalent cost', async () => {
  const root = workspace();
  const service = new ContextOSV2Service({ projectRoot: root });
  const orchestrator = new Orchestrator({ projectRoot: root, service, projectId: 'ops-usage' });
  try {
    const recorded = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'usage',
      action: 'record',
      args: {
        taskId: 'task-1',
        requestId: 'request-main-1',
        status: 'completed',
        provider: 'host',
        model: 'host-model',
        usage: { input: 1000, cached: 200, output: 100 },
      },
    }));
    assert.equal(recorded.accepted, true);
    assert.equal(recorded.status, 'appended');

    const report = JSON.parse(await orchestrator.dispatch('ops', { capability: 'usage', action: 'report' }));
    assert.equal(report.roles.main.rawTokens.totalTokens, 1100);
    assert.equal(report.mainEquivalent.contributions.main.totalTokens, 2620);
    assert.equal(report.mainEquivalent.complete, false);
    assert.equal(report.roles['api-micro'].rawTokens.totalTokens, null);

    const rows = fs.readFileSync(path.join(root, '.contextos', 'logs', 'role-usage.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].role, 'main');
    assert.equal(rows[0].usage.uncachedInputTokens, 800);
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
