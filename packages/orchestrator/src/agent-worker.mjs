import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeAgent } from './agent-service.mjs';
import { normalizeAgentReport } from './micro-agent-report.mjs';
import { claimMicroJob, enqueueMicroDelivery, readMicroJob, updateMicroJob } from './micro-delivery.mjs';
import { loadProfile } from './profile.mjs';
import { resolveMicroRoles } from './micro-role-config.mjs';
import { appendRoleUsage } from './role-usage-ledger.mjs';

async function persistWorkerFailure(projectRoot, jobId, error) {
  const existing = readMicroJob(projectRoot, jobId);
  if (!existing) return null;
  const message = error?.message || String(error);
  const report = existing.report || normalizeAgentReport({
    answer: `Detached CLI task failed before its result could be saved: ${message}`,
    needsHost: true,
  }, { jobId, status: 'failed' });
  const stillRunning = existing.status === 'running';
  let job = updateMicroJob(projectRoot, jobId, {
    ...(stillRunning ? { status: 'failed', report, error: message } : {}),
    executionAccounting: { status: 'gap', reason: 'Detached worker terminated unexpectedly after launch.' },
  }) || existing;
  let deliveryAccounting = job.deliveryAccounting || { status: 'not-requested' };
  if (stillRunning || job.status === 'failed') {
    try {
      const queued = enqueueMicroDelivery(projectRoot, {
        deliveryId: jobId,
        receiptId: jobId,
        content: JSON.stringify(report),
        hostSessionId: null,
      });
      deliveryAccounting = { status: queued.duplicate ? 'already-queued' : 'queued', deliveryId: jobId };
    } catch {
      deliveryAccounting = { status: 'gap', reason: 'The failure was saved, but its error report could not be queued.' };
    }
  }
  return updateMicroJob(projectRoot, jobId, { deliveryAccounting }) || job;
}

export async function runAgentWorker(projectRoot, jobId) {
  const root = path.resolve(projectRoot);
  const claimed = claimMicroJob(root, jobId);
  if (!claimed) throw new Error(`Unknown detached agent job '${jobId}'.`);
  const definition = claimed.worker;
  if (!definition || definition.version !== 1) throw new Error(`Agent job '${jobId}' has no valid persisted worker definition.`);
  const roles = resolveMicroRoles(loadProfile(root));
  return executeAgent({ action: 'run', id: jobId, workerResume: true, background: false }, {
    projectRoot: root,
    roles,
    onUsage: (row) => appendRoleUsage(root, row),
  });
}

export async function runAgentWorkerCli(projectRoot, jobId) {
  if (!projectRoot || !jobId) {
    process.stderr.write('Usage: node agent-worker.mjs <projectRoot> <jobId>\n');
    return 2;
  }
  try {
    await runAgentWorker(projectRoot, jobId);
    return 0;
  } catch (error) {
    try { await persistWorkerFailure(path.resolve(projectRoot), jobId, error); } catch {}
    process.stderr.write(`${error?.message || String(error)}\n`);
    return 1;
  }
}

const invokedAsWorker = path.basename(fileURLToPath(import.meta.url)) === 'agent-worker.mjs';
if (invokedAsWorker && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [projectRoot, jobId] = process.argv.slice(2);
  process.exitCode = await runAgentWorkerCli(projectRoot, jobId);
}
