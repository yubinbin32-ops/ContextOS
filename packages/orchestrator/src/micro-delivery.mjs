import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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

function sleepSync(ms) {
  const wait = Math.max(1, Math.min(100, Math.floor(ms)));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
}

function withQueueLock(projectRoot, callback, options = {}) {
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
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function processIsAlive(pid) {
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
    const leaseProcessAlive = Number.isInteger(item.leasePid) ? processIsAlive(item.leasePid) : true;
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
    while (state.pending.length && claimed.length < maxItems) {
      const item = state.pending[0];
      const remaining = maxChars - usedChars;
      if (claimed.length > 0 && remaining < 200) break;
      const content = clip(item.content, Math.max(120, Math.min(item.content.length, remaining - 180)));
      state.pending.shift();
      const lease = { ...item, claimedAt: new Date().toISOString(), leasePid: process.pid };
      state.leased.push(lease);
      claimed.push({ ...lease, content });
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
    return `### Deferred Micro result\n- receipt=${item.receiptId}${ref}\n${item.content}`;
  });
  return `## Micro results recovered from a previous OS call\n${sections.join('\n\n')}`;
}
