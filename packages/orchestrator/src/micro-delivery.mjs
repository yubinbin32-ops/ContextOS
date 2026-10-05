import { storeArtifact } from './artifact-store.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeAgentReport } from './micro-agent-report.mjs';

const DELIVERY_VERSION = 1;
const DEFAULT_LOCK_TIMEOUT_MS = 2000;
const DEFAULT_LOCK_STALE_MS = 30000;
const MAX_PENDING_DELIVERIES = 100;
const MAX_STORED_ANSWER_CHARS = 4000;
const DEFAULT_RESTORE_ITEMS = 3;
const DEFAULT_RESTORE_CHARS = 3200;
const LEASE_STALE_MS = 10 * 60 * 1000;
const DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DELIVERED_TOMBSTONES = 256;
const JOB_TTL_MS = 24 * 60 * 60 * 1000;

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(number)));
}

function clip(value, maxChars) {
  const text = String(value ?? '').trim();
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function deliveryDir(projectRoot) {
  return path.join(projectRoot, '.contextos', 'micro-deliveries');
}

function statePath(projectRoot) {
  return path.join(deliveryDir(projectRoot), 'queue.json');
}

function lockPath(projectRoot) {
  return path.join(deliveryDir(projectRoot), 'queue.lock');
}

function jobsDir(projectRoot) {
  return path.join(deliveryDir(projectRoot), 'jobs');
}

function validatedJobId(jobId) {
  const id = String(jobId || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(id)) throw new Error('Invalid Micro job id.');
  return id;
}

function jobPath(projectRoot, jobId) {
  return path.join(jobsDir(projectRoot), `${validatedJobId(jobId)}.json`);
}

export function cancellationMarkerPath(projectRoot, jobId) {
  return path.join(jobsDir(projectRoot), `${validatedJobId(jobId)}.cancel`);
}

function sleepSync(ms) {
  const wait = Math.max(1, Math.min(100, Math.floor(ms)));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
}

export function withQueueLock(projectRoot, callback, options = {}) {
  if (typeof callback !== 'function') throw new Error('Micro delivery queue lock requires a callback.');
  const dir = deliveryDir(projectRoot);
  const filePath = lockPath(projectRoot);
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS, 0, 60000);
  const staleMs = boundedInteger(options.staleMs, DEFAULT_LOCK_STALE_MS, 1000, 10 * 60 * 1000);
  const startedAt = Date.now();
  fs.mkdirSync(dir, { recursive: true });

  while (true) {
    try {
      const fd = fs.openSync(filePath, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');
      fs.closeSync(fd);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(filePath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.rmSync(filePath, { force: true });
          continue;
        }
      } catch (_) {}
      if (Date.now() - startedAt >= timeoutMs) throw new Error('Micro delivery queue is locked by another process.');
      sleepSync(Math.min(50, timeoutMs - (Date.now() - startedAt) || 1));
    }
  }

  try {
    return callback();
  } finally {
    try { fs.rmSync(filePath, { force: true }); } catch (_) {}
  }
}

function readState(projectRoot) {
  const filePath = statePath(projectRoot);
  if (!fs.existsSync(filePath)) return { version: DELIVERY_VERSION, pending: [], leased: [], delivered: [] };
  const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (state?.version !== DELIVERY_VERSION || !Array.isArray(state.pending) || !Array.isArray(state.leased)) {
    throw new Error('Micro delivery queue has an unsupported or invalid state file.');
  }
  // `delivered` was added without bumping the queue version so existing
  // projects migrate in place. It is a bounded idempotency ledger, not a
  // second answer store.
  const delivered = Array.isArray(state.delivered)
    ? state.delivered
      .map((entry) => typeof entry === 'string'
        ? { deliveryId: entry, deliveredAt: null }
        : entry)
      .filter((entry) => entry && String(entry.deliveryId || '').trim())
      .map((entry) => ({
        deliveryId: String(entry.deliveryId).trim(),
        sessionId: entry.sessionId ? String(entry.sessionId).slice(0, 120) : null,
        deliveredAt: entry.deliveredAt || null,
      }))
    : [];
  return { ...state, delivered };
}

function writeState(projectRoot, state) {
  const filePath = statePath(projectRoot);
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function normalizeDelivery(item) {
  if (!item || typeof item !== 'object') throw new Error('Micro delivery requires a result record.');
  const deliveryId = String(item.deliveryId || item.receiptId || '').trim();
  const receiptId = String(item.receiptId || deliveryId).trim();
  const content = clip(item.content, MAX_STORED_ANSWER_CHARS);
  if (!deliveryId || !receiptId || !content) throw new Error('Micro delivery requires an id, receipt, and non-empty answer.');
  return {
    deliveryId,
    receiptId,
    artifactId: item.artifactId ? String(item.artifactId).slice(0, 160) : null,
    sessionId: item.sessionId ? String(item.sessionId).slice(0, 120) : null,
    content,
    createdAt: item.createdAt || new Date().toISOString(),
  };
}

function recoverExpiredLeases(state, now = Date.now()) {
  const pendingBefore = state.pending.length;
  const leasedBefore = state.leased.length;
  const deliveredBefore = state.delivered.length;
  state.delivered = state.delivered.filter((entry) => {
    const deliveredAt = Date.parse(entry.deliveredAt || '');
    return !Number.isFinite(deliveredAt) || now - deliveredAt <= DELIVERY_TTL_MS;
  });
  state.pending = state.pending.filter((item) => {
    const createdAt = Date.parse(item.createdAt || '');
    return !Number.isFinite(createdAt) || now - createdAt <= DELIVERY_TTL_MS;
  });
  state.leased = state.leased.filter((item) => {
    const createdAt = Date.parse(item.createdAt || '');
    return !Number.isFinite(createdAt) || now - createdAt <= DELIVERY_TTL_MS;
  });
  const fresh = [];
  const activeLeases = [];
  for (const item of state.leased) {
    const claimedAt = Date.parse(item.claimedAt || '');
    const leaseProcessAlive = Number.isInteger(item.leasePid) ? isProcessAlive(item.leasePid) : true;
    if (!Number.isFinite(claimedAt) || now - claimedAt > LEASE_STALE_MS || !leaseProcessAlive) {
      const { claimedAt: _claimedAt, leasePid: _leasePid, ...delivery } = item;
      fresh.push(delivery);
    } else {
      activeLeases.push(item);
    }
  }
  if (fresh.length) {
    const knownIds = new Set([
      ...state.pending,
      ...activeLeases,
      ...state.delivered,
    ].map((item) => item.deliveryId));
    state.pending.push(...fresh.filter((item) => !knownIds.has(item.deliveryId)));
  }
  state.leased = activeLeases;
  return pendingBefore !== state.pending.length
    || leasedBefore !== state.leased.length
    || deliveredBefore !== state.delivered.length
    || fresh.length > 0;
}

export function enqueueMicroDelivery(projectRoot, item) {
  if (!projectRoot) throw new Error('Micro delivery requires a project root.');
  const delivery = normalizeDelivery(item);
  return withQueueLock(projectRoot, () => {
    const state = readState(projectRoot);
    const recoveredState = recoverExpiredLeases(state);
    const pendingOrLeased = [...state.pending, ...state.leased]
      .some((entry) => entry.deliveryId === delivery.deliveryId);
    const alreadyDelivered = state.delivered.some((entry) => entry.deliveryId === delivery.deliveryId);
    if (pendingOrLeased || alreadyDelivered) {
      if (recoveredState) writeState(projectRoot, state);
      return {
        queued: false,
        deliveryId: delivery.deliveryId,
        duplicate: true,
        ...(alreadyDelivered ? { delivered: true } : {}),
      };
    }
    if (state.pending.length + state.leased.length >= MAX_PENDING_DELIVERIES) {
      throw new Error(`Micro delivery queue is full (${MAX_PENDING_DELIVERIES} pending results).`);
    }
    state.pending.push(delivery);
    writeState(projectRoot, state);
    return { queued: true, deliveryId: delivery.deliveryId };
  });
}

function readJobFile(filePath) {
  try {
    const job = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return job && typeof job === 'object' ? job : null;
  } catch (_) {
    return null;
  }
}

function writeJob(projectRoot, job) {
  const filePath = jobPath(projectRoot, job.jobId);
  fs.mkdirSync(jobsDir(projectRoot), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(job, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
  return job;
}

function normalizeJobStatus(status) {
  // `partial` is a durable outcome (work retained for host continuation), not
  // a transient state: normalizing it to `running` left 290s-window jobs
  // looking live for 24h and later produced a false timeout delivery.
  return ['running', 'partial', 'completed', 'failed', 'cancelled'].includes(status) ? status : 'running';
}

function normalizeJob(projectRoot, job) {
  if (!job || typeof job !== 'object') return null;
  const jobId = String(job.jobId || '').trim();
  if (!jobId) return null;
  const status = normalizeJobStatus(job.status);
  const createdAt = job.createdAt || new Date().toISOString();
  const updatedAt = job.updatedAt || createdAt;
  const stale = Date.now() - Date.parse(updatedAt || createdAt) > JOB_TTL_MS;
  const leaseAlive = status !== 'running' || !Number.isInteger(job.leasePid) || isProcessAlive(job.leasePid);
  const cancelRequested = Boolean(job.cancelRequestedAt);
  if (status === 'running' && (stale || !leaseAlive)) {
    return {
      ...job,
      jobId,
      status: cancelRequested ? 'cancelled' : 'failed',
      error: cancelRequested
        ? 'Micro background job was cancelled.'
        : stale
          ? 'Micro background job expired before completion.'
          : 'Micro background worker exited before completion.',
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    ...job,
    jobId,
    status,
    createdAt,
    updatedAt,
    projectRoot,
  };
}

export function createMicroJob(projectRoot, job = {}) {
  if (!projectRoot) throw new Error('Micro job requires a project root.');
  const jobId = String(job.jobId || '').trim();
  if (!jobId) throw new Error('Micro job requires a jobId.');
  return withQueueLock(projectRoot, () => {
  const existing = readJobFile(jobPath(projectRoot, jobId));
  if (existing) return { created: false, job: existing };
  const now = new Date().toISOString();
  const record = normalizeJob(projectRoot, {
    ...job,
    jobId,
    status: 'running',
    createdAt: job.createdAt || now,
    updatedAt: now,
    leasePid: process.pid,
  });
  return { created: true, job: writeJob(projectRoot, record) };
  });
}

export function claimMicroJob(projectRoot, jobId, { leasePid = process.pid } = {}) {
  if (!projectRoot || !jobId) return null;
  return withQueueLock(projectRoot, () => {
    const existing = readJobFile(jobPath(projectRoot, String(jobId)));
    if (!existing || existing.status !== 'running') return null;
    return writeJob(projectRoot, {
      ...existing,
      jobId: String(jobId),
      status: 'running',
      leasePid,
      updatedAt: new Date().toISOString(),
    });
  });
}

export function updateMicroJob(projectRoot, jobId, patch = {}) {
  if (!projectRoot || !jobId) return null;
  const existing = readMicroJob(projectRoot, jobId);
  if (!existing) return null;
  const next = normalizeJob(projectRoot, {
    ...existing,
    ...patch,
    jobId,
    updatedAt: new Date().toISOString(),
  });
  return writeJob(projectRoot, next);
}

export function readMicroJob(projectRoot, jobId) {
  if (!projectRoot || !jobId) return null;
  const filePath = jobPath(projectRoot, String(jobId));
  const job = readJobFile(filePath);
  if (!job) return null;
  const normalized = normalizeJob(projectRoot, job);
  if (normalized && normalized.status !== job.status) {
    writeJob(projectRoot, normalized);
    if (['completed', 'failed', 'cancelled', 'partial'].includes(normalized.status)) {
      clearMicroJobCancellation(projectRoot, normalized.jobId);
    }
    // No terminal receipt means cost is unknown, not zero. Keep the failed
    // assignment in the same usage ledger as completed provider calls.
    const ledger = path.join(projectRoot, '.contextos', 'logs', 'micro-usage.jsonl');
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.appendFileSync(ledger, JSON.stringify({ at: normalized.updatedAt, receiptId: normalized.jobId, hostSessionId: normalized.hostSessionId || null, ok: false, usageSource: 'unavailable', providerUsageComplete: false, providerRequests: null, provider: normalized.provider || 'cli', estimatedCostUsd: null, error: normalized.error }) + '\n', { mode: 0o600 });
    if (normalized.status !== 'cancelled') {
      enqueueMicroDelivery(projectRoot, { deliveryId: normalized.jobId, receiptId: normalized.jobId, content: normalized.error });
    }
  }
  return normalized;
}

const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled', 'partial']);

export function requestMicroJobCancellation(projectRoot, jobId) {
  if (!projectRoot || !jobId) return { status: 'missing', requested: false, terminal: false, job: null };
  const existing = readJobFile(jobPath(projectRoot, jobId));
  if (!existing) return { status: 'missing', requested: false, terminal: false, job: null };
  const status = normalizeJobStatus(existing.status);
  if (TERMINAL_JOB_STATUSES.has(status)) {
    return { status, requested: false, terminal: true, job: normalizeJob(projectRoot, existing) };
  }
  const requestedAt = new Date().toISOString();
  fs.mkdirSync(jobsDir(projectRoot), { recursive: true });
  fs.writeFileSync(cancellationMarkerPath(projectRoot, jobId), `${JSON.stringify({ requestedAt, requestedBy: 'host' })}\n`, { mode: 0o600 });
  const updated = updateMicroJob(projectRoot, jobId, { cancelRequestedAt: requestedAt }) || normalizeJob(projectRoot, existing);
  return { status: updated?.status || status, requested: true, terminal: false, job: updated, requestedAt };
}

export function microJobCancellationRequested(projectRoot, jobId) {
  if (!projectRoot || !jobId) return null;
  try {
    const marker = JSON.parse(fs.readFileSync(cancellationMarkerPath(projectRoot, jobId), 'utf8'));
    return marker?.requestedAt || new Date().toISOString();
  } catch {}
  try {
    const job = readJobFile(jobPath(projectRoot, jobId));
    return job?.cancelRequestedAt || null;
  } catch {
    return null;
  }
}

export function clearMicroJobCancellation(projectRoot, jobId) {
  if (!projectRoot || !jobId) return;
  try { fs.rmSync(cancellationMarkerPath(projectRoot, jobId), { force: true }); } catch {}
}

const LEGACY_AGENT_JOB_PREFIXES = ['agent-', 'agy-', 'goal-'];

function isAgentJob(job) {
  if (job?.kind) return job.kind === 'agent';
  if (job?.worker || job?.adapter || job?.implementation) return true;
  const jobId = String(job?.jobId || '');
  return LEGACY_AGENT_JOB_PREFIXES.some((prefix) => jobId.startsWith(prefix));
}

export function listMicroJobs(projectRoot, { status = null, limit = 20, excludeAgentJobs = false } = {}) {
  if (!projectRoot) return [];
  let files = [];
  try {
    files = fs.readdirSync(jobsDir(projectRoot))
      .filter((name) => name.endsWith('.json'));
  } catch (_) {
    return [];
  }
  return files
    .map((name) => readMicroJob(projectRoot, name.replace(/\.json$/, '')))
    .filter(Boolean)
    .filter((job) => !status || job.status === status)
    .filter((job) => !excludeAgentJobs || !isAgentJob(job))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    .slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)));
}

export function claimMicroDeliveries(projectRoot, options = {}) {
  if (!projectRoot) return [];
  return withQueueLock(projectRoot, () => {
    const state = readState(projectRoot);
    const recoveredState = recoverExpiredLeases(state);
    const deliveredIds = new Set(state.delivered.map((entry) => entry.deliveryId));
    const pendingBeforeDedup = state.pending.length;
    state.pending = state.pending.filter((item) => !deliveredIds.has(item.deliveryId));
    const maxItems = boundedInteger(options.maxItems, DEFAULT_RESTORE_ITEMS, 1, 8);
    const maxChars = boundedInteger(options.maxChars, DEFAULT_RESTORE_CHARS, 300, 12000);
    const claimed = [];
    let usedChars = 0;
    const activeReceipts = new Set(options.activeReceiptIds || []);
    const eligible = item => options.createdBefore == null || Date.parse(item.createdAt) < options.createdBefore || activeReceipts.has(item.receiptId);
    while (state.pending.length && claimed.length < maxItems) {
      const index = state.pending.findIndex(eligible);
      if (index < 0) break;
      const item = state.pending[index];
      const remaining = maxChars - usedChars;
      if (claimed.length > 0 && remaining < item.content.length + 180) break;
      const content = clip(item.content, Math.max(120, Math.min(item.content.length, remaining - 180)));
      state.pending.splice(index, 1);
      const lease = { ...item, claimedAt: new Date().toISOString(), leasePid: process.pid };
      state.leased.push(lease);
      claimed.push({ ...lease, content, ...(content.length < item.content.length ? { truncated: true } : {}) });
      usedChars += content.length + 180;
    }
    if (claimed.length || recoveredState || pendingBeforeDedup !== state.pending.length) writeState(projectRoot, state);
    return claimed;
  });
}

export function completeMicroDeliveryClaims(projectRoot, deliveryIds = []) {
  const ids = new Set((Array.isArray(deliveryIds) ? deliveryIds : []).map(String));
  if (!projectRoot || !ids.size) return;
  withQueueLock(projectRoot, () => {
    const state = readState(projectRoot);
    const completed = state.leased.filter((item) => ids.has(item.deliveryId));
    state.leased = state.leased.filter((item) => !ids.has(item.deliveryId));
    // A successful host response is the acknowledgement boundary. Keeping a
    // small tombstone ledger makes a repeated provider/result callback
    // idempotent after the lease has already been consumed.
    if (completed.length) {
      state.pending = state.pending.filter((item) => !ids.has(item.deliveryId));
      const completedAt = new Date().toISOString();
      const completedIds = new Set(completed.map((item) => item.deliveryId));
      state.delivered = state.delivered.filter((item) => !completedIds.has(item.deliveryId));
      state.delivered.push(...completed
        .filter((item, index, items) => items.findIndex((other) => other.deliveryId === item.deliveryId) === index)
        .map((item) => ({
          deliveryId: item.deliveryId,
          sessionId: item.sessionId || null,
          deliveredAt: completedAt,
        })));
      state.delivered = state.delivered.slice(-MAX_DELIVERED_TOMBSTONES);
    }
    if (completed.length) writeState(projectRoot, state);
  });
}

export function releaseMicroDeliveryClaims(projectRoot, deliveryIds = []) {
  const ids = new Set((Array.isArray(deliveryIds) ? deliveryIds : []).map(String));
  if (!projectRoot || !ids.size) return;
  withQueueLock(projectRoot, () => {
    const state = readState(projectRoot);
    const returned = [];
    state.leased = state.leased.filter((item) => {
      if (!ids.has(item.deliveryId)) return true;
      const { claimedAt: _claimedAt, leasePid: _leasePid, ...delivery } = item;
      returned.push(delivery);
      return false;
    });
    const knownIds = new Set(state.pending.map((item) => item.deliveryId));
    state.pending.unshift(...returned.filter((item) => !knownIds.has(item.deliveryId)));
    writeState(projectRoot, state);
  });
}

/**
 * Remove deliveries owned by a persistent Micro session when that session is
 * explicitly closed or deleted. Unscoped one-shot deliveries are untouched.
 */
export function discardMicroDeliveriesForSession(projectRoot, sessionId) {
  const id = String(sessionId || '').trim();
  if (!projectRoot || !id) return { removed: 0 };
  return withQueueLock(projectRoot, () => {
    const state = readState(projectRoot);
    const matches = (item) => item.sessionId === id;
    const removed = state.pending.filter(matches).length
      + state.leased.filter(matches).length
      + state.delivered.filter(matches).length;
    if (!removed) return { removed: 0 };
    state.pending = state.pending.filter((item) => !matches(item));
    state.leased = state.leased.filter((item) => !matches(item));
    state.delivered = state.delivered.filter((item) => !matches(item));
    writeState(projectRoot, state);
    return { removed };
  });
}

export function renderMicroDeliveries(items = []) {
  if (!Array.isArray(items) || !items.length) return '';
  const sections = items.map((item) => {
    const ref = item.artifactId ? `; artifact=${item.artifactId}` : '';
    const clipped = item.truncated ? '; truncated=true' : '';
    return `### Deferred Micro result\n- receipt=${item.receiptId}${ref}${clipped}\n${item.content}`;
  });
  return `## Micro results recovered from a previous OS call\n${sections.join('\n\n')}`;
}

export function reportMicroJob(projectRoot, jobId, content) {
  const job = readMicroJob(projectRoot, jobId);
  if (!job || job.status !== 'running') throw new Error('Micro reports require a running assigned job.');
  const serialized = typeof content === 'string'
    ? content
    : (content && typeof content === 'object' ? JSON.stringify(content) : String(content ?? ''));
  const text = serialized.trim();
  if (!text || text.length > 3200) throw new Error('Report must contain 1–3200 characters.');
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  const artifact = storeArtifact(projectRoot, text, { id: `micro-report-${jobId}-${hash}`, kind: 'micro-report' });
  const report = normalizeAgentReport(text, {
    jobId,
    status: 'running',
    answeredQuestions: Array.isArray(job.answeredQuestions) ? job.answeredQuestions : [],
  });
  updateMicroJob(projectRoot, jobId, { report });
  return enqueueMicroDelivery(projectRoot, {
    deliveryId: `${jobId}-report-${hash}`, receiptId: jobId, artifactId: artifact.id, content: JSON.stringify(report),
  });
}
