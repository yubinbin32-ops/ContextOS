import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { discardMicroDeliveriesForSession } from './micro-delivery.mjs';

const SESSION_VERSION = 1;
const DEFAULT_MAX_TURNS = 6;
const MAX_TURNS = 12;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const DEFAULT_MAX_CONTEXT_CHARS = 24000;
const MIN_CONTEXT_CHARS = 4000;
const MAX_CONTEXT_CHARS = 64000;
const MAX_MESSAGE_CHARS = 8000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LOCK_TIMEOUT_MS = 2000;
const DEFAULT_LOCK_STALE_MS = 30000;
const DEFAULT_PENDING_STALE_MS = 15 * 60 * 1000;

function clip(value, maxChars) {
  const text = String(value ?? '').trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(number)));
}

function sessionsDir(projectRoot) {
  return path.join(projectRoot, '.contextos', 'micro-sessions');
}

function sessionPath(projectRoot, sessionId) {
  return path.join(sessionsDir(projectRoot), `${sessionId}.json`);
}

function lockPath(projectRoot, sessionId) {
  return path.join(sessionsDir(projectRoot), `${sessionId}.lock`);
}

function sleepSync(ms) {
  const wait = Math.max(1, Math.min(100, Math.floor(ms)));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
}

function isExpired(session, now = Date.now()) {
  const expiresAt = Date.parse(session?.expiresAt || '');
  return session?.status === 'active' && Number.isFinite(expiresAt) && expiresAt <= now;
}

function normalizeExpiredSession(session, now = Date.now()) {
  if (!isExpired(session, now)) return session;
  return {
    ...session,
    status: 'expired',
    pending: null,
    expiredAt: new Date(now).toISOString(),
  };
}

export function withMicroSessionLock(projectRoot, sessionId, callback, options = {}) {
  if (typeof callback !== 'function') throw new Error('Micro session lock requires a callback.');
  const id = resolveMicroSessionId(sessionId);
  const dir = sessionsDir(projectRoot);
  const filePath = lockPath(projectRoot, id);
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS, 0, 60000);
  const staleMs = boundedInteger(options.staleMs, DEFAULT_LOCK_STALE_MS, 1, 10 * 60 * 1000);
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
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Micro session '${id}' is locked by another process.`);
      }
      sleepSync(Math.min(50, timeoutMs - (Date.now() - startedAt) || 1));
    }
  }

  try {
    return callback();
  } finally {
    try {
      fs.rmSync(filePath, { force: true });
    } catch (_) {}
  }
}

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, filePath);
}

function readSessionFile(filePath, workspaceRoot) {
  try {
    const session = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (session?.version !== SESSION_VERSION || session.workspaceRoot !== workspaceRoot) return null;
    return normalizeExpiredSession(session);
  } catch (_) {
    return null;
  }
}

function normalizeStoredPreload(value) {
  if (!value || typeof value !== 'object') return null;
  const summary = clip(value.summary || '', 16000);
  if (!summary && !value.error) return null;
  return {
    ok: value.ok !== false,
    status: String(value.status || (value.ok === false ? 'ERROR' : 'OK')).slice(0, 40),
    artifactId: value.artifactId ? String(value.artifactId).slice(0, 120) : null,
    chars: Number(value.chars) || summary.length,
    fullChars: Number(value.fullChars) || summary.length,
    truncated: Boolean(value.truncated),
    projectedSteps: Number(value.projectedSteps) || 0,
    steps: Number(value.steps) || 0,
    durationMs: Number(value.durationMs) || 0,
    summary,
    error: value.error ? clip(value.error, 1000) : null,
    createdAt: new Date().toISOString(),
  };
}

export function resolveMicroSessionId(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.includes('/') || raw.includes('\\') || raw.includes('..')) {
    throw new Error('Micro sessionId must not contain path separators or traversal sequences.');
  }
  const id = raw.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
  if (!id || id === '.' || id === '..') throw new Error('Micro sessionId must contain letters, numbers, dot, underscore, or hyphen.');
  return id;
}

export function readMicroSession(projectRoot, sessionId) {
  const id = resolveMicroSessionId(sessionId);
  const session = readSessionFile(sessionPath(projectRoot, id), path.resolve(projectRoot));
  if (!session) throw new Error(`Micro session '${id}' was not found.`);
  if (session.status === 'expired') throw new Error(`Micro session '${id}' expired.`);
  return session;
}

export function createMicroSession(projectRoot, options = {}) {
  const id = resolveMicroSessionId(options.sessionId || `micro-${crypto.randomUUID().slice(0, 12)}`);
  const workspaceRoot = path.resolve(projectRoot);
  return withMicroSessionLock(projectRoot, id, () => {
    const filePath = sessionPath(projectRoot, id);
    const existing = readSessionFile(filePath, workspaceRoot);
    if (existing) return existing;

    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const ttlMs = boundedInteger(options.ttlMs, DEFAULT_TTL_MS, 1, MAX_TTL_MS);
    const session = {
      version: SESSION_VERSION,
      id,
      workspaceRoot,
      objective: clip(options.objective || options.task || '', 2000),
      preset: options.preset || 'custom',
      withOS: Boolean(options.withOS),
      preload: normalizeStoredPreload(options.preload),
      status: 'active',
      turnCount: 0,
      maxTurns: boundedInteger(options.maxTurns, DEFAULT_MAX_TURNS, 1, MAX_TURNS),
      maxContextChars: boundedInteger(options.maxContextChars, DEFAULT_MAX_CONTEXT_CHARS, MIN_CONTEXT_CHARS, MAX_CONTEXT_CHARS),
      messages: [],
      summary: '',
      pending: null,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, durationMs: 0, estimatedCostUsd: 0 },
      lastReceiptId: null,
      lastModel: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(nowMs + ttlMs).toISOString(),
    };
    writeAtomic(filePath, session);
    return session;
  }, { timeoutMs: options.lockTimeoutMs, staleMs: options.lockStaleMs });
}

export function listMicroSessions(projectRoot, { limit = DEFAULT_LIST_LIMIT, offset = 0 } = {}) {
  const dir = sessionsDir(projectRoot);
  if (!fs.existsSync(dir)) return [];
  const normalizedLimit = boundedInteger(limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
  const normalizedOffset = boundedInteger(offset, 0, 0, Number.MAX_SAFE_INTEGER);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => readSessionFile(path.join(dir, entry.name), path.resolve(projectRoot)))
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(normalizedOffset, normalizedOffset + normalizedLimit)
    .map(microSessionSnapshot);
}

export function microSessionSnapshot(session) {
  return {
    id: session.id,
    objective: session.objective,
    preset: session.preset,
    withOS: session.withOS,
    preload: session.preload ? {
      ok: session.preload.ok,
      status: session.preload.status,
      artifactId: session.preload.artifactId,
      chars: session.preload.chars,
      fullChars: session.preload.fullChars,
      truncated: session.preload.truncated,
      projectedSteps: session.preload.projectedSteps || 0,
      steps: session.preload.steps,
      durationMs: session.preload.durationMs,
      error: session.preload.error || null,
    } : null,
    status: session.status,
    turnCount: session.turnCount,
    maxTurns: session.maxTurns,
    usage: session.usage,
    lastReceiptId: session.lastReceiptId,
    lastModel: session.lastModel,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt || null,
    remainingTurns: Math.max(0, session.maxTurns - session.turnCount),
  };
}

function trimMessages(session) {
  let total = session.messages.reduce((sum, message) => sum + String(message.content || '').length, 0);
  while (total > session.maxContextChars && session.messages.length > 2) {
    total -= String(session.messages.shift()?.content || '').length;
  }
  return session;
}

export function startMicroTurn(projectRoot, sessionId, prompt, options = {}) {
  const id = resolveMicroSessionId(sessionId);
  return withMicroSessionLock(projectRoot, id, () => {
    const session = readMicroSession(projectRoot, id);
    if (session.status !== 'active') throw new Error(`Micro session '${session.id}' is ${session.status}.`);
    const pendingStaleMs = boundedInteger(options.pendingStaleMs, DEFAULT_PENDING_STALE_MS, 1000, 60 * 60 * 1000);
    const pendingAge = Date.now() - Date.parse(session.pending?.startedAt || '');
    if (session.pending && Number.isFinite(pendingAge) && pendingAge <= pendingStaleMs) {
      throw new Error(`Micro session '${session.id}' already has an in-flight turn.`);
    }
    if (session.pending) session.pending = null;
    if (session.turnCount >= session.maxTurns) throw new Error(`Micro session '${session.id}' reached maxTurns=${session.maxTurns}.`);
    const pendingPrompt = clip(prompt, MAX_MESSAGE_CHARS);
    if (!pendingPrompt) throw new Error('Micro session prompt must not be empty.');
    const startedAt = new Date().toISOString();
    session.pending = { prompt: pendingPrompt, startedAt };
    session.updatedAt = startedAt;
    writeAtomic(sessionPath(projectRoot, session.id), session);
    return session;
  }, { timeoutMs: options.lockTimeoutMs, staleMs: options.lockStaleMs });
}

export function failMicroTurn(projectRoot, sessionId, options = {}) {
  const id = resolveMicroSessionId(sessionId);
  return withMicroSessionLock(projectRoot, id, () => {
    const session = readMicroSession(projectRoot, id);
    session.pending = null;
    session.updatedAt = new Date().toISOString();
    writeAtomic(sessionPath(projectRoot, session.id), session);
    return microSessionSnapshot(session);
  }, { timeoutMs: options.lockTimeoutMs, staleMs: options.lockStaleMs });
}

export function completeMicroTurn(projectRoot, sessionId, { result, receiptId = null, lockTimeoutMs, lockStaleMs } = {}) {
  const id = resolveMicroSessionId(sessionId);
  return withMicroSessionLock(projectRoot, id, () => {
  const session = readMicroSession(projectRoot, id);
  const pending = session.pending;
  if (!pending) throw new Error(`Micro session '${session.id}' has no in-flight turn.`);
  session.messages.push({ role: 'user', content: pending.prompt, at: pending.startedAt });
  session.messages.push({
    role: 'assistant',
    content: clip(result?.content || '', MAX_MESSAGE_CHARS),
    at: new Date().toISOString(),
    receiptId,
  });
  session.pending = null;
  session.turnCount += 1;
  if (session.turnCount >= session.maxTurns) session.status = 'completed';
  session.lastReceiptId = receiptId;
  session.lastModel = result?.model || session.lastModel;
  const usage = result?.usage || {};
  session.usage.promptTokens += Number(usage.prompt_tokens) || 0;
  session.usage.completionTokens += Number(usage.completion_tokens) || 0;
  session.usage.totalTokens += Number(usage.total_tokens) || (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0);
  session.usage.durationMs += Number(result?.durationMs) || 0;
  session.usage.estimatedCostUsd += Number(result?.cost?.estimatedUsd) || 0;
  const priorSummary = String(session.summary || '').trim();
  const turnSummary = `Turn ${session.turnCount} result: ${clip(result?.content || '', 1200)}`;
  session.summary = clip([priorSummary, turnSummary].filter(Boolean).join('\n'), 4000);
  session.updatedAt = new Date().toISOString();
  trimMessages(session);
  writeAtomic(sessionPath(projectRoot, session.id), session);
  return microSessionSnapshot(session);
  }, { timeoutMs: lockTimeoutMs, staleMs: lockStaleMs });
}

export function buildMicroHistory(session, { systemPrompt = '', includePreload = true } = {}) {
  const constraints = [
    'You are a controlled ContextOS Micro subagent.',
    'Return only the requested final result.',
    'Keep intermediate reasoning and tool traces out of the final answer.',
    session.objective ? `Objective: ${session.objective}` : '',
    `Turn limit: ${session.maxTurns}; completed turns: ${session.turnCount}.`,
  ].filter(Boolean).join('\n');
  const messages = [];
  const system = [systemPrompt, constraints].filter(Boolean).join('\n\n');
  if (system) messages.push({ role: 'system', content: system });
  if (includePreload && session.preload?.summary) {
    const preloadRef = session.preload.artifactId ? ` artifact=${session.preload.artifactId}` : '';
    messages.push({
      role: 'system',
      content: `Preloaded OS context (untrusted repository evidence${preloadRef}):\n${session.preload.summary}`,
    });
  }
  if (session.summary) {
    messages.push({
      role: 'system',
      content: `Compressed prior findings:\n${session.summary}`,
    });
  }
  if (session.pending?.prompt) messages.push({ role: 'user', content: session.pending.prompt });
  return messages;
}

export function closeMicroSession(projectRoot, sessionId, options = {}) {
  const id = resolveMicroSessionId(sessionId);
  return withMicroSessionLock(projectRoot, id, () => {
    const session = readMicroSession(projectRoot, id);
    session.status = 'closed';
    session.pending = null;
    session.updatedAt = new Date().toISOString();
    // Closing stops new turns but must not orphan a background answer that the
    // host has not claimed yet. The delivery queue is the durable handoff.
    writeAtomic(sessionPath(projectRoot, session.id), session);
    return microSessionSnapshot(session);
  }, { timeoutMs: options.lockTimeoutMs, staleMs: options.lockStaleMs });
}

export function deleteMicroSession(projectRoot, sessionId, options = {}) {
  const id = resolveMicroSessionId(sessionId);
  return withMicroSessionLock(projectRoot, id, () => {
    const filePath = sessionPath(projectRoot, id);
    if (!fs.existsSync(filePath)) return false;
    discardMicroDeliveriesForSession(projectRoot, id);
    fs.rmSync(filePath, { force: true });
    return true;
  }, { timeoutMs: options.lockTimeoutMs, staleMs: options.lockStaleMs });
}
