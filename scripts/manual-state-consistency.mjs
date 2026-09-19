import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContextOSV2Service } from '../packages/mcp/src/v2-service.mjs';

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-integrity-flow-'));
const projectId = 'manual-integrity-flow';
const serviceA = new ContextOSV2Service({ projectRoot, projectId });

try {
  await serviceA.plan({
    action: 'create',
    planData: {
      id: 'plan-integrity',
      title: 'Integrity Flow',
      phases: [
        {
          id: 'P0',
          order: 0,
          status: 'active',
          tasks: [
            {
              id: 'task-integrity',
              title: 'Concurrent journal writes',
              workingSet: { files: [] },
            },
          ],
        },
      ],
    },
  });
  await serviceA.task({ action: 'activate', id: 'task-integrity' });

  const serviceB = new ContextOSV2Service({ projectRoot, projectId });
  try {
    const writes = [];
    for (let index = 0; index < 12; index += 1) {
      const service = index % 2 === 0 ? serviceA : serviceB;
      writes.push(
        service.task({
          action: 'note',
          id: 'task-integrity',
          text: `concurrent-note-${index}`,
        })
      );
    }
    await Promise.all(writes);
  } finally {
    serviceB.close({ stopProcesses: false });
  }

  const task = serviceA.db.getTask('task-integrity');
  assert.equal(task.notes.length, 12, 'concurrent task notes were lost');

  serviceA.syncEngine.exportGraphToJson(projectId, projectRoot);
  const graphPath = path.join(projectRoot, '.contextos', 'graph.json');
  const revisionOne = fs.readFileSync(graphPath, 'utf8');
  serviceA.syncEngine.exportGraphToJson(projectId, projectRoot);
  const revisionTwo = JSON.parse(fs.readFileSync(graphPath, 'utf8')).graphRevision;
  fs.writeFileSync(graphPath, revisionOne, 'utf8');

  const staleReader = new ContextOSV2Service({ projectRoot, projectId });
  try {
    const conflictBrief = await staleReader.osContext({ action: 'brief' });
    assert.match(conflictBrief, /Graph state conflict/i);
    const conflictMessage = await staleReader.osContext({ action: 'reconcile' });
    assert.match(conflictMessage, /conflict/i);
    assert.equal(staleReader.stateConflict?.conflict, true, 'stale graph was not reported as a conflict');
    assert.equal(
      staleReader.db.getProject(projectId).graph_revision,
      revisionTwo,
      'stale graph rolled back the database revision'
    );
  } finally {
    staleReader.close({ stopProcesses: false });
  }

  serviceA.db.saveBlock({
    id: 'block-outbox-manual',
    projectId,
    title: 'Outbox recovery Block',
    artifactRefs: [{ path: 'src/outbox.js', hash: 'manual-outbox' }],
  });
  serviceA.syncEngine.queueGraphToJson(projectId);
  serviceA.syncEngine.flushGraphOutbox(projectId, projectRoot);
  assert.equal(serviceA.db.getGraphOutbox(projectId), null);
  assert.equal(
    JSON.parse(fs.readFileSync(graphPath, 'utf8')).data.blocks.some((block) => block.id === 'block-outbox-manual'),
    true
  );

  console.log('Manual state consistency flow passed.');
  console.log('- 12 concurrent task notes preserved.');
  console.log(`- stale graph conflict detected at revision ${revisionTwo}.`);
  console.log('- graph outbox flushed and cleared.');
} finally {
  serviceA.close({ stopProcesses: false });
  fs.rmSync(projectRoot, { recursive: true, force: true });
}
