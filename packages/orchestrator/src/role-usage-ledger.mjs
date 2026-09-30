import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { weightedCostTokens as computeWeightedCostTokens, MICRO_WORKER_COST_DIVISOR, MICRO_COST_FORMULA } from './micro-provider.mjs';

const ROLES = ['main', 'api-micro', 'cli-agent'];
const METRICS = ['inputTokens', 'cachedInputTokens', 'uncachedInputTokens', 'outputTokens', 'reasoningTokens', 'reportedTotalTokens'];
const USAGE_ALIASES = {
  inputTokens: ['inputTokens', 'input_tokens', 'input'],
  cachedInputTokens: ['cachedInputTokens', 'cached_input_tokens', 'cached'],
  uncachedInputTokens: ['uncachedInputTokens', 'uncached_input_tokens'],
  outputTokens: ['outputTokens', 'output_tokens', 'output'],
  reasoningTokens: ['reasoningTokens', 'reasoning_tokens', 'reasoning'],
  reportedTotalTokens: ['reportedTotalTokens', 'totalTokens', 'total_tokens', 'total'],
};
const DIVISOR = MICRO_WORKER_COST_DIVISOR;
const LEDGER_RELATIVE_PATH = path.join('.contextos', 'logs', 'role-usage.jsonl');
const LOCK_ATTEMPTS = 100;
const LOCK_DELAY_MS = 20;

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function optionalString(value, field) {
  if (value === undefined || value === null) return null;
  return requireNonEmptyString(value, field);
}

function tokenCount(value, field) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer or null`);
  return value;
}

function normalizeUsage(value) {
  if (value === undefined || value === null) value = {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('usage must be an object or null');
  const usage = Object.fromEntries(METRICS.map((field) => {
    const aliases = USAGE_ALIASES[field];
    const provided = aliases.filter((alias) => value[alias] !== undefined && value[alias] !== null)
      .map((alias) => tokenCount(value[alias], `usage.${alias}`));
    if (new Set(provided).size > 1) throw new RangeError(`usage aliases for ${field} contain conflicting values`);
    return [field, provided[0] ?? null];
  }));
  if (usage.inputTokens !== null && usage.cachedInputTokens !== null && usage.cachedInputTokens > usage.inputTokens) {
    throw new RangeError('usage.cachedInputTokens cannot exceed usage.inputTokens');
  }
  const derivedUncached = usage.inputTokens !== null && usage.cachedInputTokens !== null
    ? usage.inputTokens - usage.cachedInputTokens : null;
  if (usage.uncachedInputTokens !== null && derivedUncached !== null && usage.uncachedInputTokens !== derivedUncached) {
    throw new RangeError('usage.uncachedInputTokens contradicts inputTokens minus cachedInputTokens');
  }
  if (usage.uncachedInputTokens === null && derivedUncached !== null) usage.uncachedInputTokens = derivedUncached;
  if (usage.outputTokens !== null && usage.reasoningTokens !== null && usage.reasoningTokens > usage.outputTokens) {
    throw new RangeError('usage.reasoningTokens cannot exceed usage.outputTokens');
  }
  if (usage.reportedTotalTokens !== null && usage.inputTokens !== null && usage.outputTokens !== null
      && usage.reportedTotalTokens !== usage.inputTokens + usage.outputTokens) {
    throw new RangeError('usage.reportedTotalTokens contradicts inputTokens plus outputTokens');
  }
  return usage;
}

function normalizeEvidence(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('usage evidence must be an object');
  if (!ROLES.includes(input.role)) throw new TypeError(`role must be one of: ${ROLES.join(', ')}`);
  const taskId = requireNonEmptyString(input.taskId, 'taskId');
  const parentTaskId = optionalString(input.parentTaskId, 'parentTaskId');
  const requestId = requireNonEmptyString(input.requestId, 'requestId');
  const status = requireNonEmptyString(input.status, 'status');
  const evidenceScope = input.evidenceScope ?? 'request';
  if (!['request', 'task-aggregate'].includes(evidenceScope)) {
    throw new TypeError('evidenceScope must be request or task-aggregate');
  }
  const provider = optionalString(input.provider, 'provider');
  const model = optionalString(input.model, 'model');
  const suppliedActualModel = optionalString(input.actualModel, 'actualModel');
  if (model !== null && suppliedActualModel !== null && model !== suppliedActualModel) {
    throw new RangeError('model and actualModel must identify the same observed model');
  }
  const actualModel = suppliedActualModel ?? model;
  const requestedModel = optionalString(input.requestedModel, 'requestedModel');
  const providerLaunches = input.providerLaunches === undefined || input.providerLaunches === null
    ? null : tokenCount(input.providerLaunches, 'providerLaunches');
  const startedAt = input.startedAt === undefined || input.startedAt === null
    ? null : requireNonEmptyString(input.startedAt, 'startedAt');
  const durationMs = input.durationMs === undefined || input.durationMs === null ? null : input.durationMs;
  if (durationMs !== null && (!Number.isSafeInteger(durationMs) || durationMs < 0)) {
    throw new TypeError('durationMs must be a non-negative safe integer or null');
  }
  return {
    role: input.role, taskId, parentTaskId, requestId, evidenceScope, provider, model: actualModel, actualModel, requestedModel,
    providerLaunches,
    usage: normalizeUsage(input.usage), startedAt, durationMs, status,
  };
}

function identityOf(evidence) {
  return JSON.stringify([evidence.role, evidence.taskId, evidence.requestId]);
}

function taskScopeOf(evidence) {
  return JSON.stringify([evidence.role, evidence.taskId]);
}

function semanticOf(row) {
  const evidence = normalizeEvidence(row);
  return JSON.stringify(evidence);
}

function parseLedger(contents) {
  if (!contents) return [];
  const rows = [];
  for (const [index, line] of contents.split('\n').entries()) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TypeError('row must be an object');
      rows.push(row);
    } catch (error) {
      throw new Error(`Usage ledger is malformed at line ${index + 1}: ${error.message}`);
    }
  }
  return rows;
}

async function acquireLock(lockPath) {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      return await fs.open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt + 1 === LOCK_ATTEMPTS) throw new Error('Timed out waiting for the role usage ledger lock');
      await delay(LOCK_DELAY_MS);
    }
  }
  throw new Error('Unable to acquire the role usage ledger lock');
}

async function withLedgerLock(lockPath, action) {
  const handle = await acquireLock(lockPath);
  try {
    return await action();
  } finally {
    await handle.close();
    await fs.unlink(lockPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function appendLine(filePath, row) {
  const handle = await fs.open(filePath, 'a', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(row)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Append one auditable role usage receipt. Conflicting evidence is retained but rejected. */
export async function appendRoleUsage(projectRoot, input) {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') throw new TypeError('projectRoot must be a non-empty string');
  const evidence = normalizeEvidence(input);
  const ledgerPath = path.resolve(projectRoot, LEDGER_RELATIVE_PATH);
  const lockPath = `${ledgerPath}.lock`;
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  return withLedgerLock(lockPath, async () => {
    const existing = parseLedger(await fs.readFile(ledgerPath, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    }));
    const identity = identityOf(evidence);
    const matching = existing.filter((row) => {
      try { return identityOf(normalizeEvidence(row)) === identity; } catch { return false; }
    });
    const taskRows = existing.filter((row) => {
      try { return taskScopeOf(normalizeEvidence(row)) === taskScopeOf(evidence); } catch { return false; }
    });
    const conflictingScope = taskRows.some((row) => {
      const prior = normalizeEvidence(row);
      return prior.evidenceScope !== evidence.evidenceScope
        || (evidence.evidenceScope === 'task-aggregate' && prior.requestId !== evidence.requestId);
    });
    const fingerprint = JSON.stringify(evidence);
    const matchingFingerprints = new Set(matching.map((row) => {
      try { return semanticOf(row); } catch { return null; }
    }));
    const hasConflict = conflictingScope || matching.some((row) => row.evidenceStatus === 'conflict') || matchingFingerprints.size > 1;
    if (matchingFingerprints.has(fingerprint)) {
      return { accepted: !hasConflict, appended: false, status: hasConflict ? 'conflict' : 'duplicate', ledgerPath };
    }
    if (matching.length > 0 || conflictingScope) {
      const row = { schemaVersion: 1, ...evidence, recordedAt: new Date().toISOString(), evidenceStatus: 'conflict' };
      await appendLine(ledgerPath, row);
      return { accepted: false, appended: true, status: 'conflict', ledgerPath, conflictIdentity: identity };
    }
    const row = { schemaVersion: 1, ...evidence, recordedAt: new Date().toISOString(), evidenceStatus: 'accepted' };
    await appendLine(ledgerPath, row);
    return { accepted: true, appended: true, status: 'appended', ledgerPath, record: row };
  });
}

function metricSummary(values) {
  const observed = values.filter((value) => value !== null);
  const knownSubtotal = observed.reduce((sum, value) => sum + value, 0);
  const unknownCount = values.length - observed.length;
  const complete = values.length > 0 && unknownCount === 0;
  return { totalTokens: complete ? knownSubtotal : null, knownSubtotal, complete, unknownCount, observationCount: values.length };
}

function zeroMetricSummary(reason) {
  return { totalTokens: 0, knownSubtotal: 0, complete: true, unknownCount: 0, observationCount: 0,
    observed: false, coverageStatus: 'declared-unused', coverageReason: reason };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('manifest must contain only JSON values');
  return encoded;
}

/** Hash a frozen, JSON-compatible experiment manifest using canonical key order. */
export function qualificationManifestSha256(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError('manifest must be a JSON object');
  }
  return createHash('sha256').update(stableJson(manifest)).digest('hex');
}

function declaredUnusedRoles(rows, options) {
  const declarations = options?.unusedRoles ?? {};
  if (!declarations || typeof declarations !== 'object' || Array.isArray(declarations)) {
    throw new TypeError('unusedRoles must be an object keyed by role');
  }
  const declaredRoles = Object.keys(declarations);
  for (const role of declaredRoles) {
    if (!ROLES.includes(role)) throw new TypeError(`unusedRoles contains an unknown role: ${role}`);
  }
  if (declaredRoles.length === 0) return new Map();

  const manifest = options.manifest;
  const manifestSha256 = options.manifestSha256;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError('unused-role declarations require the frozen manifest');
  }
  if (typeof manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(manifestSha256)
      || qualificationManifestSha256(manifest) !== manifestSha256.toLowerCase()) {
    throw new TypeError('unused-role declarations require the matching frozen manifest SHA-256');
  }
  const verified = new Map();
  for (const role of declaredRoles) {
    const declaration = declarations[role];
    if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
      throw new TypeError(`unusedRoles.${role} must include a reason and runtimeAdmission evidence`);
    }
    const reason = requireNonEmptyString(declaration.reason, `unusedRoles.${role}.reason`);
    const roleManifest = manifest.roles?.[role];
    if (!roleManifest || roleManifest.enabled !== false) {
      throw new TypeError(`frozen manifest must explicitly disable role ${role}`);
    }
    const admission = declaration.runtimeAdmission;
    if (!admission || typeof admission !== 'object' || Array.isArray(admission)) {
      throw new TypeError(`unusedRoles.${role} requires runtime admission evidence`);
    }
    if (admission.manifestSha256 !== manifestSha256) {
      throw new TypeError(`runtime admission for ${role} does not match the frozen manifest`);
    }
    const checkedAt = requireNonEmptyString(admission.checkedAt, `unusedRoles.${role}.runtimeAdmission.checkedAt`);
    if (!Number.isFinite(Date.parse(checkedAt))) {
      throw new TypeError(`unusedRoles.${role}.runtimeAdmission.checkedAt must be a timestamp`);
    }
    for (const surface of ['environmentRoute', 'toolRegistration']) {
      const proof = admission[surface];
      if (!proof || typeof proof !== 'object' || Array.isArray(proof) || proof.status !== 'disabled') {
        throw new TypeError(`unusedRoles.${role}.runtimeAdmission.${surface} must prove disabled`);
      }
      requireNonEmptyString(proof.source, `unusedRoles.${role}.runtimeAdmission.${surface}.source`);
      if (typeof proof.evidenceSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(proof.evidenceSha256)) {
        throw new TypeError(`unusedRoles.${role}.runtimeAdmission.${surface} requires an evidence SHA-256`);
      }
    }
    if (rows.some((row) => row?.role === role)) {
      throw new TypeError(`cannot declare role ${role} unused when usage or conflict receipts exist`);
    }
    verified.set(role, { reason, manifestSha256, runtimeAdmission: admission });
  }
  return verified;
}

function rawTokensFor(evidence) {
  const { inputTokens, outputTokens } = evidence.usage;
  return inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens;
}

function weightedCostFor(evidence) {
  return computeWeightedCostTokens({
    prompt_tokens: evidence.usage.inputTokens,
    cached_input_tokens: evidence.usage.cachedInputTokens,
    uncached_input_tokens: evidence.usage.uncachedInputTokens,
    completion_tokens: evidence.usage.outputTokens,
  });
}

function mainEquivalentFor(evidence, divisor) {
  const weighted = weightedCostFor(evidence);
  return weighted === null ? null : weighted / divisor;
}

function aggregateRows(rows) {
  const identities = new Map();
  let duplicatesIgnored = 0;
  for (const row of rows) {
    const evidence = normalizeEvidence(row);
    const identity = identityOf(evidence);
    if (!identities.has(identity)) identities.set(identity, { evidence, variants: new Map(), conflictFlag: false });
    const group = identities.get(identity);
    const fingerprint = JSON.stringify(evidence);
    if (group.variants.has(fingerprint)) duplicatesIgnored += 1;
    else group.variants.set(fingerprint, evidence);
    if (row.evidenceStatus === 'conflict') group.conflictFlag = true;
  }
  const taskScopes = new Map();
  for (const group of identities.values()) {
    for (const evidence of group.variants.values()) {
      const key = taskScopeOf(evidence);
      if (!taskScopes.has(key)) taskScopes.set(key, new Map());
      taskScopes.get(key).set(identityOf(evidence), evidence.evidenceScope);
    }
  }
  const conflictingTaskScopes = new Set();
  for (const [key, scopes] of taskScopes) {
    const values = [...scopes.values()];
    if (new Set(values).size > 1 || (values.includes('task-aggregate') && scopes.size > 1)) conflictingTaskScopes.add(key);
  }
  const usable = [];
  const conflicts = [];
  for (const [identity, group] of identities) {
    const evidenceVariants = [...group.variants.values()];
    const scopeConflict = evidenceVariants.some((row) => conflictingTaskScopes.has(taskScopeOf(row)));
    if (group.variants.size > 1 || group.conflictFlag || scopeConflict) {
      conflicts.push({ identity, reason: scopeConflict ? 'request and task aggregate evidence overlap' : 'conflicting evidence for one request identity', evidenceVariants });
    } else {
      usable.push(group.evidence);
    }
  }
  return { usable, conflicts, duplicatesIgnored, observedIdentityCount: identities.size };
}

function aggregateMetric(evidence, getter) {
  return metricSummary(evidence.map(getter));
}

function summarizeRole(role, evidence, conflicts) {
  const metrics = Object.fromEntries(METRICS.map((field) => [field,
    aggregateMetric(evidence, (row) => row.usage[field])]));
  const rawTokens = aggregateMetric(evidence, rawTokensFor);
  const weightedCostTokens = aggregateMetric(evidence, weightedCostFor);
  const divisor = role === 'main' ? 1 : DIVISOR;
  const mainEquivalentTokens = aggregateMetric(evidence, (row) => mainEquivalentFor(row, divisor));
  return {
    coverageStatus: conflicts.length > 0 ? 'observed-with-conflicts' : evidence.length > 0 ? 'observed' : 'unknown',
    requestCount: evidence.length,
    conflictedRequestCount: conflicts.length,
    ...metrics,
    rawTokens,
    weightedCostTokens,
    mainEquivalentTokens,
  };
}

function combineMetric(metrics) {
  const present = metrics.filter(Boolean);
  const totalObservations = present.reduce((sum, metric) => sum + metric.observationCount, 0);
  const unknownCount = present.reduce((sum, metric) => sum + metric.unknownCount, 0);
  const knownSubtotal = present.reduce((sum, metric) => sum + metric.knownSubtotal, 0);
  const complete = present.length > 0 && present.every((metric) => metric.complete);
  return { totalTokens: complete ? knownSubtotal : null, knownSubtotal, complete, unknownCount,
    observationCount: totalObservations, missingRoleCount: metrics.length - present.length };
}

/** Summarize append-only receipts without imputing missing fields or billing duplicates. */
export function summarizeRoleUsage(rows, options = {}) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object');
  const unused = declaredUnusedRoles(rows, options);
  const { usable, conflicts, duplicatesIgnored, observedIdentityCount } = aggregateRows(rows);
  const roles = {};
  for (const role of ROLES) {
    const evidence = usable.filter((row) => row.role === role);
    const roleConflicts = conflicts.filter((conflict) => conflict.evidenceVariants.some((row) => row.role === role));
    const declaration = unused.get(role);
    if (declaration) {
      const zeroMetrics = Object.fromEntries(METRICS.map((field) => [field, zeroMetricSummary(declaration.reason)]));
      roles[role] = {
        coverageStatus: 'declared-unused',
        coverageReason: declaration.reason,
        manifestSha256: declaration.manifestSha256,
        requestCount: 0,
        conflictedRequestCount: 0,
        ...zeroMetrics,
        rawTokens: zeroMetricSummary(declaration.reason),
        weightedCostTokens: zeroMetricSummary(declaration.reason),
        mainEquivalentTokens: zeroMetricSummary(declaration.reason),
      };
    } else {
      roles[role] = summarizeRole(role, evidence, roleConflicts);
    }
  }
  const totals = {};
  for (const field of METRICS) totals[field] = combineMetric(ROLES.map((role) => {
    const metric = roles[role][field];
    return metric.observationCount > 0 || metric.coverageStatus === 'declared-unused' ? metric : null;
  }));
  totals.rawTokens = combineMetric(ROLES.map((role) => {
    const metric = roles[role].rawTokens;
    return metric.observationCount > 0 || metric.coverageStatus === 'declared-unused' ? metric : null;
  }));
  for (const field of ['weightedCostTokens', 'mainEquivalentTokens']) {
    totals[field] = combineMetric(ROLES.map((role) => {
      const metric = roles[role][field];
      return metric.observationCount > 0 || metric.coverageStatus === 'declared-unused' ? metric : null;
    }));
  }
  const mainEquivalentContributions = Object.fromEntries(ROLES.map((role) => [role, roles[role].mainEquivalentTokens]));
  const presentRoles = ROLES.filter((role) => roles[role].requestCount > 0);
  const missingRoles = ROLES.filter((role) => roles[role].requestCount === 0
    && !roles[role].conflictedRequestCount && !unused.has(role));
  const mainEquivalentComplete = ROLES.every((role) => unused.has(role) || (roles[role].requestCount > 0
    && roles[role].mainEquivalentTokens.complete && roles[role].conflictedRequestCount === 0));
  const mainEquivalentKnownSubtotal = ROLES.reduce((sum, role) => sum + roles[role].mainEquivalentTokens.knownSubtotal, 0);
  const mainEquivalentTokens = mainEquivalentComplete
    ? ROLES.reduce((sum, role) => sum + roles[role].mainEquivalentTokens.totalTokens, 0)
    : null;
  return {
    schemaVersion: 1,
    roles,
    totals,
    mainEquivalent: {
      totalTokens: mainEquivalentTokens,
      knownSubtotal: mainEquivalentKnownSubtotal,
      complete: mainEquivalentComplete,
      divisor: DIVISOR,
      contributions: mainEquivalentContributions,
      missingRoles,
      formula: MICRO_COST_FORMULA,
      weights: { cachedInput: 0.1, uncachedInput: 2, output: 10 },
      declaredUnusedRoles: Object.fromEntries([...unused].map(([role, evidence]) => [role, {
        reason: evidence.reason,
        manifestSha256: evidence.manifestSha256,
      }])),
    },
    conflicts,
    duplicatesIgnored,
    observedIdentityCount,
    countedRequestCount: usable.length,
    presentRoles,
    formula: MICRO_COST_FORMULA,
  };
}

/** Read the append-only ledger without imputing or rewriting rows. */
export async function readRoleUsage(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') throw new TypeError('projectRoot must be a non-empty string');
  const ledgerPath = path.resolve(projectRoot, LEDGER_RELATIVE_PATH);
  const contents = await fs.readFile(ledgerPath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return { ledgerPath, rows: parseLedger(contents) };
}
