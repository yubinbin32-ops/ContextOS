import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { summarizeRoleUsage } from './role-usage-ledger.mjs';

const LEDGER_PATH = path.join('.contextos', 'logs', 'role-usage.jsonl');
const LIMIT_FIELDS = ['requests', 'inputTokens', 'uncachedInputTokens', 'outputTokens', 'rawTokens', 'seconds'];
const queuedScopes = new Map();
const unrecordedScopes = new Set();

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unknown(message) {
  return { allowed: false, errorCode: 'API_MICRO_ACCOUNTING_UNKNOWN', error: message };
}

function exhausted(message) {
  return { allowed: false, errorCode: 'API_MICRO_BUDGET_EXHAUSTED', error: message };
}

function normalizeBudget(value) {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()
    || typeof value.taskId !== 'string' || !value.taskId.trim() || !isRecord(value.limits)) return null;
  const limits = {};
  for (const field of LIMIT_FIELDS) {
    const limit = value.limits[field];
    if (limit === undefined || limit === null) continue;
    if (field === 'seconds') {
      if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) return null;
    } else if (!Number.isSafeInteger(limit) || limit < 0) return null;
    limits[field] = limit;
  }
  if (!Object.keys(limits).length || Object.keys(value.limits).some((field) => !LIMIT_FIELDS.includes(field))) return null;
  return { id: value.id, taskId: value.taskId, limits };
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('API task-budget admission wait was aborted.');
  error.name = 'AbortError';
  return error;
}

function waitForTurn(previous, signal) {
  if (!signal) return previous;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => { cleanup(); reject(abortError(signal)); };
    signal.addEventListener('abort', onAbort, { once: true });
    previous.then(() => { cleanup(); resolve(); });
  });
}

async function queueScope(scopeKey, signal) {
  if (signal?.aborted) throw abortError(signal);
  const previous = queuedScopes.get(scopeKey) || Promise.resolve();
  let unlock;
  const held = new Promise((resolve) => { unlock = resolve; });
  const tail = previous.then(() => held);
  queuedScopes.set(scopeKey, tail);
  const cleanup = () => {
    if (queuedScopes.get(scopeKey) === tail) queuedScopes.delete(scopeKey);
  };
  try {
    await waitForTurn(previous, signal);
  } catch (error) {
    unlock();
    tail.then(cleanup);
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    unlock();
    tail.then(cleanup);
  };
}

async function readLedger(projectRoot) {
  const ledgerPath = path.resolve(projectRoot, LEDGER_PATH);
  const contents = await fs.readFile(ledgerPath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const rows = [];
  for (const [index, line] of contents.split('\n').entries()) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); }
    catch { throw new Error(`role usage ledger is malformed at line ${index + 1}`); }
    if (!isRecord(row)) throw new Error(`role usage ledger row ${index + 1} is not an object`);
    rows.push(row);
  }
  return rows;
}

function observedBudget(usageRows, limits) {
  let summary;
  try { summary = summarizeRoleUsage(usageRows); }
  catch { return unknown('The scoped role-usage ledger cannot be normalized safely.'); }
  const role = summary.roles?.['api-micro'];
  if (!role || summary.conflicts.length || role.conflictedRequestCount) {
    return unknown('The scoped API Micro ledger contains conflicting evidence.');
  }

  const uniqueRows = new Map();
  for (const row of usageRows) uniqueRows.set(row.requestId, row);
  const rows = [...uniqueRows.values()];
  const values = { requests: 0, inputTokens: 0, uncachedInputTokens: 0, outputTokens: 0, rawTokens: 0, seconds: 0 };

  if (limits.requests !== undefined && rows.length) {
    for (const row of rows) {
      if (!Number.isSafeInteger(row.providerLaunches) || row.providerLaunches < 0) {
        return unknown('A scoped API receipt has no trustworthy provider-launch count.');
      }
      values.requests += row.providerLaunches;
      if (!Number.isSafeInteger(values.requests)) return unknown('Scoped API provider-launch totals exceed safe accounting bounds.');
    }
  }

  const metricMap = {
    inputTokens: role.inputTokens,
    uncachedInputTokens: role.uncachedInputTokens,
    outputTokens: role.outputTokens,
    rawTokens: role.rawTokens,
  };
  for (const field of ['inputTokens', 'uncachedInputTokens', 'outputTokens', 'rawTokens']) {
    if (limits[field] === undefined || !rows.length) continue;
    const metric = metricMap[field];
    if (!metric?.complete || metric.totalTokens === null) {
      return unknown(`Scoped API ${field} usage is unknown; no additional request was dispatched.`);
    }
    if (!Number.isSafeInteger(metric.totalTokens) || metric.totalTokens < 0) {
      return unknown(`Scoped API ${field} totals exceed safe accounting bounds.`);
    }
    values[field] = metric.totalTokens;
  }

  if (limits.seconds !== undefined && rows.length) {
    if (rows.some((row) => !Number.isSafeInteger(row.durationMs) || row.durationMs < 0)) {
      return unknown('Scoped API request duration is unknown; no additional request was dispatched.');
    }
    const totalMs = rows.reduce((sum, row) => sum + row.durationMs, 0);
    if (!Number.isSafeInteger(totalMs)) return unknown('Scoped API duration totals exceed safe accounting bounds.');
    values.seconds = totalMs / 1000;
  }

  for (const field of LIMIT_FIELDS) {
    if (limits[field] !== undefined && values[field] >= limits[field]) {
      return exhausted(`The observed API Micro ${field} admission limit is reached; no additional provider request was dispatched.`);
    }
  }
  return { allowed: true, observed: values };
}

/**
 * Acquire a same-process, per-task admission turn and check the append-only
 * usage ledger before a provider request. These are admission thresholds: one
 * request can overshoot a token or duration limit. Cross-process callers must
 * use a unique taskId and a single active writer. The returned finish callback
 * must be called after that request's ledger write attempt.
 */
export async function acquireApiTaskBudget({ projectRoot, budget, signal, usageRecorderAvailable = true } = {}) {
  if (budget === undefined || budget === null) return { enabled: false, allowed: true, finish() {} };
  const normalized = normalizeBudget(budget);
  if (!normalized || typeof projectRoot !== 'string' || !projectRoot.trim()) {
    return { enabled: true, ...unknown('The API task-budget scope or limits are invalid.') };
  }
  if (!usageRecorderAvailable) return { enabled: true, ...unknown('No role-usage ledger writer is available for this task budget.') };

  const root = path.resolve(projectRoot);
  const scopeKey = `${root}\0${normalized.taskId}`;
  let release;
  try { release = await queueScope(scopeKey, signal); }
  catch (error) { throw error; }

  if (unrecordedScopes.has(scopeKey)) {
    release();
    return { enabled: true, ...unknown('A prior launched API request in this process could not be recorded.') };
  }
  let rows;
  try { rows = await readLedger(root); }
  catch {
    release();
    return { enabled: true, ...unknown('The role-usage ledger could not be read safely.') };
  }
  const scopedRows = rows.filter((row) => row.role === 'api-micro' && row.taskId === normalized.taskId);
  const admission = observedBudget(scopedRows, normalized.limits);
  if (!admission.allowed) {
    release();
    return { enabled: true, ...admission };
  }

  let finished = false;
  return {
    enabled: true,
    allowed: true,
    requestId: randomUUID(),
    taskId: normalized.taskId,
    observed: admission.observed,
    finish({ providerLaunches, usageRecorded } = {}) {
      if (finished) return;
      finished = true;
      if (providerLaunches !== 0 && usageRecorded !== true) unrecordedScopes.add(scopeKey);
      release();
    },
  };
}
