import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadProfile } from './profile.mjs';
import { executeCommand } from './command-service.mjs';
import { resolveMicroRoles } from './micro-role-config.mjs';
import { createEvidenceTransport } from './api-transports.mjs';
import { acquireApiTaskBudget } from './api-task-budget.mjs';
import { requestEvidence } from './micro-broker.mjs';
import { deliverEvidence, mergeLineRanges, normalizeEvidencePath, workspaceIdentity } from './evidence-core.mjs';

const resultsDir = (root) => path.join(root, '.contextos', 'request-results');
const MAX_KNOWN_NOTE_CHARS = 2_000;
const MAX_KNOWN_REFERENCES = 32;
const MAX_ARTIFACT_CHAIN_DEPTH = 8;
const MAX_ARTIFACT_CHAIN_COUNT = 64;
const MAX_EXPANDED_ARTIFACT_RECORDS = 256;
const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const resultPath = (root, id) => {
  if (!/^result-[a-zA-Z0-9-]+$/.test(id || '')) throw new Error('Invalid evidence result id.');
  return path.join(resultsDir(root), `${id}.json`);
};

function storeResult(root, result, id = `result-${crypto.randomUUID()}`) {
  fs.mkdirSync(resultsDir(root), { recursive: true });
  // Source delivery is an explicit host-side receipt. Stored source is not
  // assumed to have reached the caller until the renderer records its blocks.
  const data = { ...result, resultId: id, sourceDelivery: [] };
  fs.writeFileSync(resultPath(root, id), JSON.stringify(data), { mode: 0o600 });
  return data;
}

function validateSourceDelivery(value, resultId) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_EXPANDED_ARTIFACT_RECORDS) {
    throw invalidArtifactReference(`Evidence result ${resultId} has invalid source-delivery metadata.`, 'EVIDENCE_RESULT_INVALID');
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some((key) => !['path', 'contentHash', 'ranges'].includes(key))
      || typeof entry.path !== 'string' || typeof entry.contentHash !== 'string' || !HASH_PATTERN.test(entry.contentHash)
      || !Array.isArray(entry.ranges)) {
      throw invalidArtifactReference(`Evidence result ${resultId} has invalid source-delivery metadata.`, 'EVIDENCE_RESULT_INVALID');
    }
    const sourcePath = normalizeEvidencePath(entry.path);
    if (sourcePath !== entry.path) {
      throw invalidArtifactReference(`Evidence result ${resultId} has a non-normalized source-delivery path.`, 'EVIDENCE_RESULT_INVALID');
    }
    const ranges = entry.ranges.length ? parseRangeList(entry.ranges, `source-delivery ranges for ${sourcePath}`) : [];
    return { path: sourcePath, contentHash: entry.contentHash, ranges };
  });
}

function mergeSourceDelivery(entries) {
  const merged = new Map();
  for (const entry of entries) {
    const key = `${entry.path}\0${entry.contentHash}`;
    const current = merged.get(key) || { path: entry.path, contentHash: entry.contentHash, ranges: [], empty: false };
    if (entry.ranges.length) current.ranges.push(...entry.ranges);
    else current.empty = true;
    merged.set(key, current);
  }
  return [...merged.values()].map(({ empty, ranges, ...entry }) => ({
    ...entry,
    ranges: empty ? [] : mergeLineRanges(ranges),
  }));
}

function exactSourceLines(text) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') continue;
    lines.push(text.slice(start, index + 1));
    start = index + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

function measureUniqueSourceBlocks(records) {
  const files = new Map();
  for (const record of records) {
    if (!record || typeof record.path !== 'string' || typeof record.contentHash !== 'string'
      || typeof record.text !== 'string' || !Array.isArray(record.ranges)) return null;
    let ranges;
    try { ranges = record.ranges.length ? mergeLineRanges(parseRangeList(record.ranges, 'rendered source ranges')) : []; }
    catch { return null; }
    const lines = exactSourceLines(record.text);
    const expectedLines = ranges.reduce((sum, range) => sum + range.end - range.start + 1, 0);
    if (expectedLines !== lines.length) return null;
    const key = JSON.stringify([record.path, record.contentHash]);
    const file = files.get(key) || new Map();
    let offset = 0;
    for (const range of ranges) {
      for (let line = range.start; line <= range.end; line += 1) {
        const text = lines[offset++];
        if (file.has(line) && file.get(line) !== text) return null;
        file.set(line, text);
      }
    }
    files.set(key, file);
  }
  let bytes = 0;
  let chars = 0;
  for (const lines of files.values()) {
    for (const text of lines.values()) {
      bytes += Buffer.byteLength(text, 'utf8');
      chars += Array.from(text).length;
    }
  }
  return { bytes, chars };
}

function safeAuditEvent(event) {
  const budgetKeys = ['evidenceRecords', 'evidenceBytes', 'searchResults', 'searchBytes', 'searchPaths', 'readRequests', 'toolCalls'];
  const auditPath = (value) => {
    if (typeof value !== 'string') return undefined;
    try { return normalizeEvidencePath(value); } catch { return undefined; }
  };
  const budget = (value) => Object.fromEntries(budgetKeys.filter((key) => Number.isSafeInteger(value?.[key]) && value[key] >= 0)
    .map((key) => [key, value[key]]));
  const ranges = (value) => Array.isArray(value) ? value.filter((range) => Number.isSafeInteger(range?.start)
    && Number.isSafeInteger(range?.end) && range.start > 0 && range.end >= range.start)
    .map(({ start, end }) => ({ start, end })) : [];
  const usage = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const allowed = new Set(['input', 'input_tokens', 'prompt_tokens', 'output', 'output_tokens', 'completion_tokens',
      'total', 'total_tokens', 'cached_input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']);
    const entries = Object.entries(value).filter(([key, count]) => allowed.has(key) && Number.isFinite(count));
    return entries.length ? Object.fromEntries(entries) : null;
  };
  const enumValue = (value, allowed) => {
    if (value === null || value === undefined) return null;
    return typeof value === 'string' && allowed.has(value) ? value : 'unknown';
  };
  const completion = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (value.protocol === 'chat') return {
      protocol: 'chat',
      finishReason: enumValue(value.finishReason, new Set(['stop', 'length', 'tool_calls', 'function_call', 'content_filter'])),
    };
    if (value.protocol === 'responses') return {
      protocol: 'responses',
      status: enumValue(value.status, new Set(['completed', 'incomplete', 'failed', 'cancelled', 'queued', 'in_progress'])),
      incompleteReason: enumValue(value.incompleteReason, new Set(['max_output_tokens', 'content_filter'])),
    };
    return { protocol: 'unknown' };
  };
  if (event?.kind === 'parent' && ['ask', 'command'].includes(event.action)) {
    const safeId = (value, prefix) => typeof value === 'string'
      && new RegExp(`^${prefix}-[a-zA-Z0-9-]{8,128}$`).test(value) ? value : undefined;
    return { kind: 'parent', action: event.action,
      ...(safeId(event.resultId, 'result') ? { resultId: safeId(event.resultId, 'result') } : {}),
      ...(safeId(event.commandId, 'command') ? { commandId: safeId(event.commandId, 'command') } : {}),
      ...(safeId(event.receiptId, 'receipt') ? { receiptId: safeId(event.receiptId, 'receipt') } : {}) };
  }
  if (event?.kind === 'transport' && Number.isSafeInteger(event.seq)) {
    const allowedTools = new Set(['search', 'read', 'select']);
    const offeredToolNames = [...new Set((Array.isArray(event.offeredToolNames) ? event.offeredToolNames : [])
      .filter((name) => allowedTools.has(name)))];
    return { kind: 'transport', seq: event.seq,
      status: ['completed', 'failed', 'local_failed'].includes(event.status) ? event.status : 'unknown',
      model: typeof event.model === 'string' && /^[a-z0-9][a-z0-9._:+-]{0,127}$/i.test(event.model) ? event.model : null,
      offeredToolNames,
      usage: usage(event.usage),
      completion: completion(event.completion) };
  }
  if (event?.kind === 'selection' && Number.isSafeInteger(event.seq)) {
    const categories = new Set(['not_submitted', 'arguments_not_object', 'references_not_array',
      'refs_references_conflict', 'refs_not_array', 'compact_reference_invalid', 'unknown_evidence_handle',
      'compact_ranges_invalid', 'empty_references', 'evidence_verification_failed', 'model_reported_gap', 'workflow_gap', 'none']);
    return { kind: 'selection', seq: event.seq,
      status: ['complete', 'partial', 'failed'].includes(event.status) ? event.status : 'unknown',
      referenceCount: Number.isSafeInteger(event.referenceCount) && event.referenceCount >= 0 ? event.referenceCount : null,
      verifiedRecords: Number.isSafeInteger(event.verifiedRecords) && event.verifiedRecords >= 0 ? event.verifiedRecords : null,
      missingCount: Number.isSafeInteger(event.missingCount) && event.missingCount >= 0 ? event.missingCount : null,
      failureCategory: categories.has(event.failureCategory) ? event.failureCategory : 'unknown' };
  }
  if (event?.kind !== 'tool' || !Number.isSafeInteger(event.seq) || !['search', 'read', 'select'].includes(event.name)) return null;
  const items = Array.isArray(event.items) ? event.items.slice(0, 256).flatMap((item) => {
    const sourcePath = auditPath(item?.path);
    if (!sourcePath || typeof item.hash !== 'string' || !HASH_PATTERN.test(item.hash)) return [];
    return [{ path: sourcePath, ranges: ranges(item.ranges), hash: item.hash,
      bytes: Number.isSafeInteger(item.bytes) && item.bytes >= 0 ? item.bytes : null, reused: item.reused === true }];
  }) : [];
  const missing = Array.isArray(event.missing) ? event.missing.slice(0, 128).map((item) => ({
    ...(auditPath(item?.path) ? { path: auditPath(item.path) } : {}),
    ...(item?.range && ranges([item.range]).length ? { range: ranges([item.range])[0] } : {}),
  })) : [];
  const status = ['complete', 'partial', 'failed', 'submitted', 'unknown'].includes(event.status) ? event.status : 'unknown';
  const missingCategories = [...new Set((Array.isArray(event.missingCategories) ? event.missingCategories : [])
    .filter((category) => new Set(['path_not_found', 'unsafe_path', 'range_out_of_bounds', 'hash_mismatch',
      'budget_exceeded', 'not_file', 'invalid_request', 'unknown']).has(category)))];
  return { kind: 'tool', seq: event.seq, name: event.name, status, items, missing,
    ...(missingCategories.length ? { missingCategories } : {}),
    ...(new Set(['object', 'json_object', 'array', 'json_array', 'invalid_json', 'missing', 'null', 'json_null',
      'string', 'json_string', 'number', 'json_number', 'boolean', 'json_boolean']).has(event.argsShape)
      ? { argsShape: event.argsShape } : {}),
    ...(new Set(['object', 'json_object', 'json_non_object', 'invalid_json', 'missing', 'non_string', 'unknown'])
      .has(event.argumentsParseStatus) ? { argumentsParseStatus: event.argumentsParseStatus } : {}),
    argumentsBytes: Number.isSafeInteger(event.argumentsBytes) && event.argumentsBytes >= 0 ? event.argumentsBytes : null,
    ...(typeof event.argumentsSha256 === 'string' && HASH_PATTERN.test(event.argumentsSha256)
      ? { argumentsSha256: event.argumentsSha256 } : {}),
    ...(new Set(['arguments_not_object', 'references_not_array', 'refs_references_conflict', 'refs_not_array',
      'compact_reference_invalid', 'unknown_evidence_handle', 'compact_ranges_invalid',
      'tool_not_offered', 'search_mode_not_offered']).has(event.failureCategory)
      ? { failureCategory: event.failureCategory } : {}),
    bytes: Number.isSafeInteger(event.bytes) && event.bytes >= 0 ? event.bytes : null,
    reused: event.reused === true, budget: { before: budget(event.budget?.before), after: budget(event.budget?.after) } };
}

function auditDiagnostics(enabled, events, failed) {
  if (!enabled) return {};
  return { diagnostics: {
    auditStatus: failed ? 'failed' : (events ? 'recorded' : 'empty'),
    ...(failed ? { auditMissing: ['Micro audit trace could not be persisted; evidence delivery and provider requests continued unchanged.'] } : {}),
  } };
}

function artifactGap(reason, pathValue) {
  return { ...(pathValue ? { path: pathValue } : {}), reason };
}

function artifactFailure(id, errorCode, reason) {
  return { status: 'failed', errorCode, resultId: id, records: [], missing: [artifactGap(reason)] };
}

function parseRangeList(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array of inclusive line ranges.`);
  for (const range of value) {
    if (Array.isArray(range)) {
      if (range.length !== 2) throw new TypeError(`${label} ranges must contain exactly [start,end].`);
    } else if (!range || typeof range !== 'object' || Array.isArray(range)
      || Object.keys(range).some((key) => !['start', 'end'].includes(key))) {
      throw new TypeError(`${label} ranges must use only {start,end} fields.`);
    }
  }
  return mergeLineRanges(value);
}

function validateRecovery(recovery) {
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)
    || Object.keys(recovery).some((key) => key !== 'inspect') || !Array.isArray(recovery.inspect)) {
    throw new TypeError('recovery must be {inspect:[{path,ranges?}]} with no other fields.');
  }
  if (recovery.inspect.length > 64) throw new RangeError('recovery.inspect is limited to 64 path requests.');
  const requests = recovery.inspect.map((request) => {
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).some((key) => !['path', 'ranges', 'contentHash'].includes(key))) {
      throw new TypeError('Each recovery.inspect item must contain only path, ranges, and optional contentHash.');
    }
    const relative = normalizeEvidencePath(request.path);
    if (request.contentHash !== undefined && (typeof request.contentHash !== 'string' || !HASH_PATTERN.test(request.contentHash))) {
      throw new TypeError(`recovery contentHash for ${relative} must be a SHA-256 hex digest.`);
    }
    return {
      path: relative,
      ranges: request.ranges === undefined ? null : parseRangeList(request.ranges, `recovery ranges for ${relative}`),
      contentHash: request.contentHash,
    };
  });
  const grouped = new Map();
  for (const request of requests) {
    const group = grouped.get(request.path) || { path: request.path, ranges: [], all: false, hashes: new Set() };
    if (request.contentHash) group.hashes.add(request.contentHash);
    if (request.ranges === null) group.all = true;
    else group.ranges.push(...request.ranges);
    grouped.set(request.path, group);
  }
  return [...grouped.values()].map((group) => ({
    path: group.path,
    ranges: group.all ? null : mergeLineRanges(group.ranges),
    contentHash: group.hashes.size === 1 ? [...group.hashes][0] : undefined,
    conflictingHashes: group.hashes.size > 1,
  }));
}

function rangesSubtract(ranges, covered) {
  let remaining = ranges.map((range) => ({ ...range }));
  for (const cover of mergeLineRanges(covered)) {
    const next = [];
    for (const item of remaining) {
      if (cover.end < item.start || cover.start > item.end) {
        next.push(item);
        continue;
      }
      if (cover.start > item.start) next.push({ start: item.start, end: cover.start - 1 });
      if (cover.end < item.end) next.push({ start: cover.end + 1, end: item.end });
    }
    remaining = next;
  }
  return remaining;
}

function intersectRanges(ranges, within) {
  const intersections = [];
  for (const wanted of ranges) {
    for (const cover of within) {
      const start = Math.max(wanted.start, cover.start);
      const end = Math.min(wanted.end, cover.end);
      if (start <= end) intersections.push({ start, end });
    }
  }
  return mergeLineRanges(intersections);
}

function loadStoredResult(root, id, identity) {
  let result;
  try { result = JSON.parse(fs.readFileSync(resultPath(root, id), 'utf8')); }
  catch (error) {
    const reason = error?.code === 'ENOENT'
      ? `Evidence result ${String(id)} is not present in this workspace; use a resultId created here.`
      : `Evidence result ${String(id)} could not be read: ${error?.message || 'invalid result file'}`;
    const failure = new Error(reason);
    failure.code = error?.code === 'ENOENT' ? 'EVIDENCE_RESULT_NOT_FOUND' : 'EVIDENCE_RESULT_INVALID';
    throw failure;
  }
  if (!result || typeof result !== 'object' || result.workspaceId !== identity.workspaceId) {
    const failure = new Error(`Evidence result ${String(id)} belongs to a different or unverified workspace.`);
    failure.code = 'EVIDENCE_RESULT_WORKSPACE_MISMATCH';
    throw failure;
  }
  const records = result.records || result.evidence;
  if (!Array.isArray(records)) {
    const failure = new Error(`Evidence result ${String(id)} has no verifiable source records.`);
    failure.code = 'EVIDENCE_RESULT_INVALID';
    throw failure;
  }
  return { ...result, records, sourceDelivery: validateSourceDelivery(result.sourceDelivery, id) };
}

function validateStoredRecord(record, identity, resultId) {
  if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !record.id
    || typeof record.path !== 'string' || typeof record.contentHash !== 'string' || !HASH_PATTERN.test(record.contentHash)
    || !Array.isArray(record.ranges)) {
    throw new Error(`Evidence result ${resultId} contains a source record without a verifiable id, path, SHA-256 hash, or ranges.`);
  }
  const normalizedPath = normalizeEvidencePath(record.path);
  if (normalizedPath !== record.path) throw new Error(`Evidence result ${resultId} contains a non-normalized source path.`);
  const ranges = record.ranges.length ? parseRangeList(record.ranges, `stored ranges for ${record.path}`) : [];
  const expectedId = crypto.createHash('sha256').update(JSON.stringify([
    'contextos-evidence-v1', identity.workspaceId, normalizedPath, record.contentHash, ranges,
  ])).digest('hex');
  if (record.id !== expectedId) throw new Error(`Evidence result ${resultId} has an id that does not bind its workspace, path, hash, and ranges.`);
  return { ...record, workspaceId: identity.workspaceId, path: normalizedPath, ranges };
}

function invalidArtifactReference(message, code = 'INVALID_EVIDENCE_REFERENCE') {
  return Object.assign(new Error(message), { code });
}

function validateReusedReference(reference, parentId) {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)
    || Object.keys(reference).some((key) => !['resultId', 'id', 'path', 'contentHash', 'ranges'].includes(key))
    || typeof reference.resultId !== 'string' || !/^result-[a-zA-Z0-9-]+$/.test(reference.resultId)
    || typeof reference.id !== 'string' || !reference.id
    || typeof reference.path !== 'string' || typeof reference.contentHash !== 'string' || !HASH_PATTERN.test(reference.contentHash)
    || !Array.isArray(reference.ranges)) {
    throw invalidArtifactReference(`Evidence result ${parentId} contains an invalid reused reference.`);
  }
  const normalizedPath = normalizeEvidencePath(reference.path);
  if (normalizedPath !== reference.path) throw invalidArtifactReference(`Evidence result ${parentId} contains a non-normalized reused path.`);
  const ranges = reference.ranges.length ? parseRangeList(reference.ranges, `reused ranges in ${parentId}`) : [];
  return { resultId: reference.resultId, id: reference.id, path: normalizedPath,
    contentHash: reference.contentHash, ranges };
}

function makeArtifactTraversal() {
  return { cache: new Map(), active: new Set(), loaded: new Set(), expanded: 0 };
}

function loadArtifactInTraversal(root, resultId, identity, traversal) {
  if (!traversal.cache.has(resultId)) {
    if (traversal.loaded.size >= MAX_ARTIFACT_CHAIN_COUNT) {
      throw invalidArtifactReference(`Evidence reuse chain exceeds ${MAX_ARTIFACT_CHAIN_COUNT} stored results.`, 'EVIDENCE_REUSE_LIMIT');
    }
    traversal.loaded.add(resultId);
    traversal.cache.set(resultId, loadStoredResult(root, resultId, identity));
  }
  return traversal.cache.get(resultId);
}

function ensureRangesCovered(wanted, covered, description) {
  if (!wanted.length || !covered.length) {
    if (!wanted.length && !covered.length) return;
    throw invalidArtifactReference(`${description} do not match stored source ranges.`, 'INVALID_EVIDENCE_REFERENCE_RANGE');
  }
  const uncovered = rangesSubtract(wanted, covered);
  if (uncovered.length) {
    const range = uncovered[0];
    throw invalidArtifactReference(`${description} exceed stored source coverage at ${range.start}-${range.end}.`, 'INVALID_EVIDENCE_REFERENCE_RANGE');
  }
}

function resolveStoredCitation(root, reference, identity, traversal, depth = 0) {
  if (depth > MAX_ARTIFACT_CHAIN_DEPTH) {
    throw invalidArtifactReference(`Evidence reuse chain exceeds ${MAX_ARTIFACT_CHAIN_DEPTH} links.`, 'EVIDENCE_REUSE_LIMIT');
  }
  if (traversal.active.has(reference.resultId)) {
    throw invalidArtifactReference(`Evidence reuse cycle detected at ${reference.resultId}.`, 'EVIDENCE_REUSE_CYCLE');
  }
  traversal.active.add(reference.resultId);
  try {
    const result = loadArtifactInTraversal(root, reference.resultId, identity, traversal);
    const rawSource = result.records.find((record) => record?.id === reference.id);
    if (rawSource) {
      const source = validateStoredRecord(rawSource, identity, reference.resultId);
      if (source.path !== reference.path || source.contentHash !== reference.contentHash) {
        throw invalidArtifactReference(`Reused evidence ${reference.id} does not match its stored path and content hash.`);
      }
      ensureRangesCovered(reference.ranges, source.ranges, `Reused evidence ranges for ${source.path}`);
      return [{ source, origin: { resultId: reference.resultId, id: source.id, path: source.path,
        contentHash: source.contentHash, ranges: reference.ranges } }];
    }

    if (result.reused !== undefined && !Array.isArray(result.reused)) {
      throw invalidArtifactReference(`Evidence result ${reference.resultId} has a malformed reused-reference list.`);
    }
    const links = (result.reused || []).filter((item) => item?.id === reference.id
      && item?.path === reference.path && item?.contentHash === reference.contentHash)
      .map((item) => validateReusedReference(item, reference.resultId));
    if (!links.length) {
      throw invalidArtifactReference(`Evidence result ${reference.resultId} does not contain referenced evidence ${reference.id}.`);
    }
    const linkCoverage = mergeLineRanges(links.flatMap((item) => item.ranges));
    ensureRangesCovered(reference.ranges, linkCoverage, `Reused evidence ranges for ${reference.path}`);
    const resolved = [];
    let remaining = reference.ranges;
    for (const link of links) {
      const selected = reference.ranges.length ? intersectRanges(remaining, link.ranges) : [];
      if (reference.ranges.length && !selected.length) continue;
      const leaf = resolveStoredCitation(root, { ...link, ranges: selected }, identity, traversal, depth + 1);
      resolved.push(...leaf);
      if (selected.length) remaining = rangesSubtract(remaining, selected);
    }
    return resolved;
  } finally {
    traversal.active.delete(reference.resultId);
  }
}

function collectArtifactEvidence(root, resultId, identity, { path: pathFilter, id: idFilter, contentHash } = {}, traversal = makeArtifactTraversal()) {
  if (traversal.active.has(resultId)) {
    throw invalidArtifactReference(`Evidence reuse cycle detected at ${resultId}.`, 'EVIDENCE_REUSE_CYCLE');
  }
  traversal.active.add(resultId);
  try {
    const result = loadArtifactInTraversal(root, resultId, identity, traversal);
    const rawRecords = result.records.filter((record) => (!pathFilter || record?.path === pathFilter)
      && (!idFilter || record?.id === idFilter) && (!contentHash || record?.contentHash === contentHash));
    const expanded = [];
    for (const raw of rawRecords) {
      const source = validateStoredRecord(raw, identity, resultId);
      expanded.push({ source, origin: { resultId, id: source.id, path: source.path,
        contentHash: source.contentHash, ranges: source.ranges } });
    }

    if (result.reused !== undefined && !Array.isArray(result.reused)) {
      throw invalidArtifactReference(`Evidence result ${resultId} has a malformed reused-reference list.`);
    }
    const links = (result.reused || []).filter((item) => (!pathFilter || item?.path === pathFilter)
      && (!idFilter || item?.id === idFilter) && (!contentHash || item?.contentHash === contentHash));
    for (const rawLink of links) {
      const link = validateReusedReference(rawLink, resultId);
      const resolved = resolveStoredCitation(root, link, identity, traversal, 1);
      expanded.push(...resolved);
    }

    const unique = new Map();
    for (const entry of expanded) {
      if (++traversal.expanded > MAX_EXPANDED_ARTIFACT_RECORDS) {
        throw invalidArtifactReference(`Evidence reuse expands beyond ${MAX_EXPANDED_ARTIFACT_RECORDS} source records.`, 'EVIDENCE_REUSE_LIMIT');
      }
      const key = `${entry.origin.resultId}\0${entry.origin.id}`;
      const prior = unique.get(key);
      if (!prior) unique.set(key, entry);
      else if (entry.origin.ranges.length) {
        prior.origin.ranges = mergeLineRanges([...prior.origin.ranges, ...entry.origin.ranges]);
        prior.source.ranges = mergeLineRanges([...prior.source.ranges, ...entry.source.ranges]);
      }
    }
    return [...unique.values()];
  } finally {
    traversal.active.delete(resultId);
  }
}

function collectSourceDelivery(root, resultId, identity, traversal = makeArtifactTraversal(), depth = 0) {
  if (depth > MAX_ARTIFACT_CHAIN_DEPTH) {
    throw invalidArtifactReference(`Evidence source-delivery chain exceeds ${MAX_ARTIFACT_CHAIN_DEPTH} links.`, 'EVIDENCE_REUSE_LIMIT');
  }
  if (traversal.active.has(resultId)) {
    throw invalidArtifactReference(`Evidence source-delivery cycle detected at ${resultId}.`, 'EVIDENCE_REUSE_CYCLE');
  }
  const cacheKey = `source-delivery:${resultId}`;
  if (traversal.cache.has(cacheKey)) return traversal.cache.get(cacheKey).map((entry) => ({ ...entry, ranges: [...entry.ranges] }));
  traversal.active.add(resultId);
  try {
    const result = loadArtifactInTraversal(root, resultId, identity, traversal);
    const evidence = collectArtifactEvidence(root, resultId, identity);
    const storedCoverage = (sourcePath, contentHash) => evidence.filter((item) => item.origin.path === sourcePath
      && item.origin.contentHash === contentHash);
    const output = [];
    for (const delivered of result.sourceDelivery) {
      const matches = storedCoverage(delivered.path, delivered.contentHash);
      if (!matches.length) {
        throw invalidArtifactReference(`Evidence result ${resultId} records delivered source outside its stored artifact.`, 'EVIDENCE_RESULT_INVALID');
      }
      if (delivered.ranges.length) {
        const covered = mergeLineRanges(matches.flatMap((item) => item.origin.ranges));
        if (rangesSubtract(delivered.ranges, covered).length) {
          throw invalidArtifactReference(`Evidence result ${resultId} records delivered lines outside its stored artifact.`, 'EVIDENCE_RESULT_INVALID');
        }
      } else if (!matches.some((item) => item.origin.ranges.length === 0)) {
        throw invalidArtifactReference(`Evidence result ${resultId} records an empty-file delivery outside its stored artifact.`, 'EVIDENCE_RESULT_INVALID');
      }
      output.push(delivered);
    }

    for (const rawLink of result.reused || []) {
      const link = validateReusedReference(rawLink, resultId);
      const inherited = collectSourceDelivery(root, link.resultId, identity, traversal, depth + 1)
        .filter((item) => item.path === link.path && item.contentHash === link.contentHash);
      for (const item of inherited) {
        const ranges = link.ranges.length ? intersectRanges(item.ranges, link.ranges)
          : (item.ranges.length ? [] : []);
        if (ranges.length || (!item.ranges.length && !link.ranges.length)) {
          output.push({ path: link.path, contentHash: link.contentHash, ranges });
        }
      }
    }
    const merged = mergeSourceDelivery(output);
    traversal.cache.set(cacheKey, merged);
    return merged.map((entry) => ({ ...entry, ranges: [...entry.ranges] }));
  } finally {
    traversal.active.delete(resultId);
  }
}

function sourceRangesCovered(wanted, candidates) {
  if (!wanted.length) return candidates.some((candidate) => candidate.ranges.length === 0);
  return rangesSubtract(wanted, mergeLineRanges(candidates.flatMap((candidate) => candidate.ranges))).length === 0;
}

function secureStoredResultPath(root, resultId) {
  const directory = fs.realpathSync(resultsDir(root));
  if (directory === root || !directory.startsWith(`${root}${path.sep}`)) {
    throw invalidArtifactReference('Evidence result storage escapes the assigned workspace.', 'EVIDENCE_RESULT_WORKSPACE_MISMATCH');
  }
  const candidate = resultPath(root, resultId);
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw invalidArtifactReference('Evidence result is not a regular workspace file.', 'EVIDENCE_RESULT_INVALID');
  }
  const file = fs.realpathSync(candidate);
  if (!file.startsWith(`${directory}${path.sep}`)) {
    throw invalidArtifactReference('Evidence result storage escapes the assigned workspace.', 'EVIDENCE_RESULT_WORKSPACE_MISMATCH');
  }
  return { directory, file };
}

/**
 * Record only source blocks that a trusted host renderer actually returned.
 * The caller supplies the canonical project root and result id separately;
 * workspace fields from a result payload are never used as a write target.
 */
export async function recordEvidenceDelivery(projectRoot, resultId, renderedRecords) {
  let temporaryFile;
  try {
    if (!Array.isArray(renderedRecords) || renderedRecords.length > MAX_EXPANDED_ARTIFACT_RECORDS) {
      throw invalidArtifactReference('Rendered source delivery must be a bounded array of exact records.', 'EVIDENCE_DELIVERY_INVALID');
    }
    const root = fs.realpathSync(projectRoot);
    const identity = workspaceIdentity(root);
    const initialPath = secureStoredResultPath(root, resultId);
    let result = loadStoredResult(root, resultId, identity);
    // Validate prior receipts before extending them; malformed state never falls
    // back to treating the complete artifact as delivered.
    collectSourceDelivery(root, resultId, identity);
    const additions = [];
    const verifiedRenderedRecords = [];
    for (const record of renderedRecords) {
      if (!record || typeof record !== 'object' || Array.isArray(record)
        || typeof record.path !== 'string' || typeof record.contentHash !== 'string' || !HASH_PATTERN.test(record.contentHash)
        || typeof record.text !== 'string' || !Array.isArray(record.ranges)) {
        throw invalidArtifactReference('Renderer supplied a source block without verifiable path, hash, ranges, and text.', 'EVIDENCE_DELIVERY_INVALID');
      }
      const sourcePath = normalizeEvidencePath(record.path);
      const ranges = record.ranges.length ? parseRangeList(record.ranges, `rendered ranges for ${sourcePath}`) : [];
      const candidates = collectArtifactEvidence(root, resultId, identity, { path: sourcePath, contentHash: record.contentHash });
      const candidate = candidates.find((item) => sourceRangesCovered(ranges, [{ ranges: item.origin.ranges }]))
        || candidates.find((item) => sourceRangesCovered(ranges, [{ ranges: item.source.ranges }]));
      if (!candidate) {
        throw invalidArtifactReference(`Rendered source ${sourcePath} is not covered by result ${resultId}.`, 'EVIDENCE_DELIVERY_INVALID');
      }
      const verified = await deliverEvidence({
        projectRoot: identity.workspace,
        availableRecords: [candidate.source],
        references: [{ id: candidate.source.id, path: candidate.source.path,
          contentHash: candidate.source.contentHash, ranges }],
      });
      const exact = verified.records?.[0];
      if (verified.missing?.length || verified.records?.length !== 1 || exact.path !== sourcePath
        || exact.contentHash !== record.contentHash || JSON.stringify(exact.ranges) !== JSON.stringify(ranges)
        || exact.text !== record.text) {
        throw invalidArtifactReference(`Rendered source ${sourcePath} no longer matches its exact stored evidence.`, 'EVIDENCE_DELIVERY_STALE');
      }
      additions.push({ path: sourcePath, contentHash: record.contentHash, ranges });
      verifiedRenderedRecords.push(exact);
    }
    const renderedMetrics = measureUniqueSourceBlocks(verifiedRenderedRecords);
    if (!additions.length) return { recorded: true, count: 0, renderedSourceBytes: 0, renderedSourceChars: 0 };

    // Reload after asynchronous hash checks so simultaneous deliveries in this
    // process merge against the latest receipt instead of replacing its ranges.
    result = loadStoredResult(root, resultId, identity);
    collectSourceDelivery(root, resultId, identity);
    const sourceDelivery = mergeSourceDelivery([...result.sourceDelivery, ...additions]);
    const allEvidence = collectArtifactEvidence(root, resultId, identity);
    for (const delivered of sourceDelivery) {
      const candidates = allEvidence.filter((item) => item.origin.path === delivered.path
        && item.origin.contentHash === delivered.contentHash);
      if (!candidates.length || !sourceRangesCovered(delivered.ranges, candidates.map((item) => ({ ranges: item.origin.ranges })))) {
        throw invalidArtifactReference('Source-delivery receipt is not covered by the stored evidence artifact.', 'EVIDENCE_DELIVERY_INVALID');
      }
    }
    const updated = { ...result, sourceDelivery };
    const { directory, file } = secureStoredResultPath(root, resultId);
    if (directory !== initialPath.directory || file !== initialPath.file) {
      throw invalidArtifactReference('Evidence result storage changed during delivery recording.', 'EVIDENCE_RESULT_INVALID');
    }
    temporaryFile = path.join(directory, `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temporaryFile, JSON.stringify(updated), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.chmodSync(temporaryFile, 0o600);
    fs.renameSync(temporaryFile, file);
    temporaryFile = undefined;
    fs.chmodSync(file, 0o600);
    return {
      recorded: true,
      count: additions.length,
      renderedSourceBytes: renderedMetrics?.bytes ?? null,
      renderedSourceChars: renderedMetrics?.chars ?? null,
    };
  } catch (error) {
    if (temporaryFile) try { fs.unlinkSync(temporaryFile); } catch {}
    return { recorded: false, errorCode: error?.code || 'EVIDENCE_DELIVERY_UNRECORDED' };
  }
}

function publicArtifactRecord(record) {
  return {
    id: record.id, path: record.path, ranges: record.ranges, text: record.text,
    contentHash: record.contentHash, bytes: record.bytes, chars: record.chars,
    missing: record.missing || [],
    ...(record.sourceEvidenceId ? { sourceEvidenceId: record.sourceEvidenceId } : {}),
  };
}

async function readResult(root, id, recovery) {
  let identity;
  try { identity = workspaceIdentity(root); }
  catch (error) { return artifactFailure(id, error.code || 'EVIDENCE_WORKSPACE_ERROR', error.message); }
  let result;
  try { result = loadStoredResult(root, id, identity); }
  catch (error) { return artifactFailure(id, error.code || 'EVIDENCE_RESULT_INVALID', error.message); }

  let requests;
  try { requests = recovery === undefined ? null : validateRecovery(recovery); }
  catch (error) { return artifactFailure(id, 'INVALID_EVIDENCE_RECOVERY', error.message); }
  const records = [];
  const missing = [];
  const normalizedRecords = [];
  if (!requests) try {
    // Whole-result replay contains only records stored directly on this result.
    for (const record of result.records) {
      if (!record || typeof record.path !== 'string') continue;
      normalizedRecords.push(validateStoredRecord(record, identity, id));
    }
  } catch (error) { return artifactFailure(id, 'EVIDENCE_RESULT_INVALID', error.message); }

  let references = [];
  if (requests) {
    if (!requests.length) missing.push(artifactGap('No recovery paths were supplied.'));
    for (const request of requests) {
      if (request.conflictingHashes) {
        missing.push(artifactGap('Recovery requested multiple content hashes for one path; request a single stored version.', request.path));
        continue;
      }
      let candidates;
      try {
        candidates = collectArtifactEvidence(root, id, identity, { path: request.path }).map(({ source }) => source);
      } catch (error) {
        missing.push(artifactGap(error.message, request.path));
        continue;
      }
      if (!candidates.length) {
        missing.push(artifactGap('Requested path is not included in this evidence result.', request.path));
        continue;
      }
      const hashes = [...new Set(candidates.map((record) => record.contentHash))];
      if ((request.contentHash && !hashes.includes(request.contentHash)) || (!request.contentHash && hashes.length > 1)) {
        missing.push(artifactGap('Stored evidence has a different or ambiguous content hash; request a fresh source inspection.', request.path));
        continue;
      }
      const version = request.contentHash || hashes[0];
      const sameVersion = candidates.filter((record) => record.contentHash === version);
      for (const record of sameVersion) {
        if (!normalizedRecords.some((known) => known.id === record.id)) normalizedRecords.push(record);
      }
      const covered = mergeLineRanges(sameVersion.flatMap((record) => record.ranges));
      const wanted = request.ranges || covered;
      if (!wanted.length) {
        missing.push(artifactGap('This result has no line coverage for the requested path.', request.path));
        continue;
      }
      const uncovered = rangesSubtract(wanted, covered);
      for (const range of uncovered) {
        missing.push(artifactGap(`Requested lines ${range.start}-${range.end} are outside the ranges stored in this result.`, request.path));
      }
      let remaining = intersectRanges(wanted, covered);
      for (const original of sameVersion) {
        const selected = intersectRanges(remaining, original.ranges);
        if (!selected.length) continue;
        references.push({ id: original.id, path: original.path, contentHash: original.contentHash, ranges: selected });
        remaining = rangesSubtract(remaining, selected);
      }
    }
  } else {
    for (const record of normalizedRecords) {
      if (!record.ranges.length) continue;
      references.push({ id: record.id, path: record.path, contentHash: record.contentHash, ranges: record.ranges });
    }
  }

  const verified = await deliverEvidence({ projectRoot: identity.workspace, availableRecords: normalizedRecords, references });
  records.push(...verified.records.map(publicArtifactRecord));
  missing.push(...verified.missing);
  if (!requests) {
    // Preserve legacy whole-result retrieval, while replacing every record with freshly verified
    // exact text. Empty-file records have no line range and are handled explicitly below.
    const emptyRecords = normalizedRecords.filter((record) => record.ranges.length === 0);
    if (emptyRecords.length) {
      const empty = await deliverEvidence({ projectRoot: identity.workspace, availableRecords: emptyRecords,
        references: emptyRecords.map((record) => ({ id: record.id, path: record.path, contentHash: record.contentHash, ranges: [] })) });
      records.push(...empty.records.map(publicArtifactRecord));
      missing.push(...empty.missing);
    }
  }
  const allMissing = requests ? missing : [...(result.missing || []), ...missing];
  const status = requests
    ? (missing.length ? 'partial' : 'completed')
    : (missing.length ? 'partial' : (result.status === 'complete' ? 'completed' : result.status || 'completed'));
  const accounting = {
    ...(result.accounting && typeof result.accounting === 'object' ? result.accounting : {}),
    materializedEvidenceBytes: records.reduce((sum, record) => sum + (Number.isSafeInteger(record.bytes) ? record.bytes : Buffer.byteLength(record.text || '', 'utf8')), 0),
    materializedEvidenceChars: records.reduce((sum, record) => sum + (Number.isSafeInteger(record.chars) ? record.chars : Array.from(record.text || '').length), 0),
    renderedSourceBytes: null,
    renderedSourceChars: null,
  };
  const output = { ...result, status, resultId: id, accounting,
    records, missing: allMissing };
  delete output.evidence;
  return output;
}

function validateKnownDescriptor(known) {
  let input = known;
  if (typeof input === 'string' || Array.isArray(input)) input = { notes: input };
  if (!input || typeof input !== 'object') throw new TypeError('known must be a short note, an array of notes, or an object with notes, paths, and refs/references.');
  const keys = Object.keys(input);
  if (keys.some((key) => !['notes', 'paths', 'refs', 'references'].includes(key))
    || (input.refs !== undefined && input.references !== undefined)) {
    throw new TypeError('known accepts only notes, paths, and one of refs or references; raw source text and unknown fields are not evidence.');
  }
  let notes = [];
  if (input.notes !== undefined) {
    const values = Array.isArray(input.notes) ? input.notes : [input.notes];
    if (values.some((note) => typeof note !== 'string')) throw new TypeError('known.notes must be a string or an array of strings.');
    if (values.length > MAX_KNOWN_REFERENCES) throw new RangeError(`known.notes is limited to ${MAX_KNOWN_REFERENCES} entries.`);
    if (values.reduce((sum, note) => sum + Array.from(note).length, 0) > MAX_KNOWN_NOTE_CHARS) {
      throw new RangeError(`known.notes is limited to ${MAX_KNOWN_NOTE_CHARS} Unicode characters.`);
    }
    notes = values.map((note) => note.trim()).filter(Boolean);
  }
  let paths = [];
  if (input.paths !== undefined) {
    if (!Array.isArray(input.paths) || input.paths.length > 64 || input.paths.some((item) => typeof item !== 'string')) {
      throw new TypeError('known.paths must be an array of at most 64 relative workspace paths.');
    }
    paths = [...new Set(input.paths.map((item) => normalizeEvidencePath(item)))];
  }
  const refs = input.refs ?? input.references ?? [];
  if (!Array.isArray(refs) || refs.length > MAX_KNOWN_REFERENCES) {
    throw new RangeError(`known.refs must be an array of at most ${MAX_KNOWN_REFERENCES} artifact references.`);
  }
  const normalized = refs.map((reference) => {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)
      || Object.keys(reference).some((key) => !['resultId', 'id', 'evidenceId', 'path', 'contentHash', 'ranges', 'workspaceId'].includes(key))) {
      throw new TypeError('Each known reference may contain only resultId, id/evidenceId, path, contentHash, ranges, and workspaceId.');
    }
    if (reference.id !== undefined && reference.evidenceId !== undefined && reference.id !== reference.evidenceId) {
      throw new TypeError('Known reference id and evidenceId must match when both are supplied.');
    }
    const evidenceId = reference.id ?? reference.evidenceId;
    if (typeof reference.resultId !== 'string' || !/^result-[a-zA-Z0-9-]+$/.test(reference.resultId)
      || (evidenceId !== undefined && (typeof evidenceId !== 'string' || !evidenceId.trim()))) {
      throw new TypeError('Each known reference requires a local resultId; optional id/evidenceId narrows it to one stored record.');
    }
    if (reference.path !== undefined && typeof reference.path !== 'string') throw new TypeError('Known reference path must be a relative string.');
    if (reference.contentHash !== undefined && (typeof reference.contentHash !== 'string' || !HASH_PATTERN.test(reference.contentHash))) {
      throw new TypeError('Known reference contentHash must be a SHA-256 hex digest.');
    }
    if (reference.workspaceId !== undefined && (typeof reference.workspaceId !== 'string' || !HASH_PATTERN.test(reference.workspaceId))) {
      throw new TypeError('Known reference workspaceId must be a SHA-256 hex digest.');
    }
    if (evidenceId === undefined && reference.path === undefined
      && (reference.contentHash !== undefined || reference.ranges !== undefined)) {
      throw new TypeError('known.refs with contentHash or ranges must also specify path when id/evidenceId is omitted.');
    }
    return {
      resultId: reference.resultId,
      ...(evidenceId !== undefined ? { id: evidenceId } : {}),
      ...(reference.path !== undefined ? { path: normalizeEvidencePath(reference.path) } : {}),
      ...(reference.contentHash !== undefined ? { contentHash: reference.contentHash } : {}),
      ...(reference.workspaceId !== undefined ? { workspaceId: reference.workspaceId } : {}),
      ...(reference.ranges !== undefined ? { ranges: parseRangeList(reference.ranges, 'known reference ranges') } : {}),
    };
  });
  const grouped = new Map();
  for (const reference of normalized) {
    const selector = reference.id ? `id:${reference.id}` : `artifact:${reference.path || '*'}:${reference.contentHash || '*'}`;
    const key = `${reference.resultId}\0${selector}`;
    const group = grouped.get(key) || { ...reference, ranges: [], all: false };
    for (const field of ['path', 'contentHash', 'workspaceId']) {
      if (group[field] && reference[field] && group[field] !== reference[field]) {
        throw new TypeError(`Repeated known reference ${reference.id} has conflicting ${field} values.`);
      }
      group[field] ||= reference[field];
    }
    if (reference.ranges === undefined) group.all = true;
    else group.ranges.push(...reference.ranges);
    grouped.set(key, group);
  }
  return { notes, paths, refs: [...grouped.values()].map(({ all, ranges, ...reference }) => ({
    ...reference,
    ...(!all ? { ranges: mergeLineRanges(ranges) } : {}),
  })) };
}

async function resolveKnownContext(root, known, signal) {
  const identity = workspaceIdentity(root);
  const descriptor = validateKnownDescriptor(known);
  const records = [];
  const references = [];
  const missing = [];
  const traversal = makeArtifactTraversal();
  for (const reference of descriptor.refs) {
    if (reference.workspaceId && reference.workspaceId !== identity.workspaceId) {
      throw Object.assign(new Error('Known evidence reference belongs to a different workspace.'), { code: 'EVIDENCE_RESULT_WORKSPACE_MISMATCH' });
    }
    const candidates = collectArtifactEvidence(root, reference.resultId, identity, {
      path: reference.path, id: reference.id, contentHash: reference.contentHash,
    }, traversal);
    if (!candidates.length) {
      throw Object.assign(new Error(`Known evidence reference ${reference.id || reference.path || '(whole artifact)'} does not match a record in ${reference.resultId}.`), { code: 'INVALID_KNOWN_REFERENCE' });
    }
    const groups = new Map();
    for (const candidate of candidates) {
      const key = `${candidate.origin.path}\0${candidate.origin.contentHash}`;
      const group = groups.get(key) || { path: candidate.origin.path, contentHash: candidate.origin.contentHash, candidates: [] };
      group.candidates.push(candidate);
      groups.set(key, group);
    }
    const paths = new Map();
    for (const group of groups.values()) {
      const versions = paths.get(group.path) || new Set();
      versions.add(group.contentHash);
      paths.set(group.path, versions);
    }
    const ambiguousPath = [...paths].find(([pathValue, versions]) => versions.size > 1 && !reference.contentHash);
    if (ambiguousPath) {
      throw Object.assign(new Error(`Known evidence artifact ${reference.resultId} contains multiple versions of ${ambiguousPath[0]}; specify path and contentHash.`), { code: 'INVALID_KNOWN_REFERENCE' });
    }
    for (const group of groups.values()) {
      const covered = mergeLineRanges(group.candidates.flatMap((candidate) => candidate.origin.ranges));
      const wanted = reference.ranges || covered;
      const uncovered = rangesSubtract(wanted, covered);
      if (uncovered.length) {
        const range = uncovered[0];
        throw Object.assign(new Error(`Known evidence ranges for ${group.path} exceed the ranges stored in ${reference.resultId} at ${range.start}-${range.end}.`), { code: 'INVALID_KNOWN_REFERENCE_RANGE' });
      }
      const delivered = collectSourceDelivery(root, reference.resultId, identity, traversal)
        .find((item) => item.path === group.path && item.contentHash === group.contentHash);
      const deliveredRanges = delivered?.ranges || [];
      const selectedRanges = intersectRanges(wanted, deliveredRanges);
      const unseenRanges = wanted.length ? rangesSubtract(wanted, deliveredRanges) : [];
      for (const range of unseenRanges) {
        missing.push({ path: group.path, range,
          reason: `Lines ${range.start}-${range.end} are stored in ${reference.resultId} but were not delivered to the caller; request them as fresh evidence or use resultId+inspect.` });
      }
      const emptyFileDelivered = wanted.length === 0 && Boolean(delivered) && delivered.ranges.length === 0
        && group.candidates.some((candidate) => candidate.origin.ranges.length === 0);
      if (wanted.length === 0 && !emptyFileDelivered) {
        missing.push({ path: group.path,
          reason: `Empty-file evidence is stored in ${reference.resultId} but was not delivered to the caller; use resultId+inspect to retrieve it.` });
      }
      for (const candidate of group.candidates) {
        const ranges = candidate.origin.ranges.length
          ? intersectRanges(selectedRanges, candidate.origin.ranges)
          : (emptyFileDelivered ? [] : null);
        if (ranges === null || (!ranges.length && candidate.origin.ranges.length)) continue;
        const origin = { ...candidate.origin, ranges };
        references.push(origin);
        const verified = await deliverEvidence({ projectRoot: identity.workspace, availableRecords: [candidate.source], references: [
          { id: candidate.source.id, path: candidate.source.path, contentHash: candidate.source.contentHash, ranges },
        ], signal });
        if (verified.missing.length) {
          missing.push(...verified.missing.map((item) => ({ ...item, reason: `Known evidence is stale or unavailable: ${item.reason}` })));
          continue;
        }
        records.push(...verified.records);
      }
    }
  }
  return { workspaceId: identity.workspaceId, notes: descriptor.notes, paths: descriptor.paths, references, records, missing };
}

function missingKnownSelection(result, knownContext) {
  const unavailable = Array.isArray(knownContext?.missing) ? knownContext.missing : [];
  const selected = Array.isArray(result?.selection?.references) ? result.selection.references : [];
  const output = [];
  for (const gap of unavailable) {
    if (typeof gap?.path !== 'string') continue;
    for (const reference of selected) {
      if (reference?.path !== gap.path) continue;
      let selectedRanges = [];
      try { selectedRanges = Array.isArray(reference.ranges) && reference.ranges.length ? parseRangeList(reference.ranges, 'selected known ranges') : []; }
      catch { continue; }
      if (gap.range && Number.isSafeInteger(gap.range.start) && Number.isSafeInteger(gap.range.end)) {
        const selectedGap = intersectRanges([gap.range], selectedRanges);
        const delivered = mergeLineRanges((result.records || []).filter((record) => record?.path === gap.path)
          .flatMap((record) => Array.isArray(record.ranges) ? record.ranges : []));
        for (const range of rangesSubtract(selectedGap, delivered)) {
          output.push({ path: gap.path, range,
            reason: gap.reason || 'Selected lines were not included in the verified evidence delivery.' });
        }
      } else if (!selectedRanges.length && !(result.records || []).some((record) => record?.path === gap.path
        && Array.isArray(record.ranges) && record.ranges.length === 0)) {
        output.push({ path: gap.path,
          reason: gap.reason || 'Selected empty-file evidence was not included in the verified evidence delivery.' });
      }
    }
  }
  const existing = new Set((result.missing || []).map((item) => JSON.stringify(item)));
  return output.filter((item) => !existing.has(JSON.stringify(item)));
}

function publicResult(result) {
  // Provider conversation state, raw traces and reasoning stay internal.
  const { state, calls, toolResults, reasoning, ...data } = result;
  if (data.micro) {
    const { state: ignoredState, calls: ignoredCalls, content: ignoredContent, reasoning: ignoredReasoning, ...micro } = data.micro;
    data.micro = micro;
  }
  return data;
}

export async function requestContextOS(action, args = {}, {
  projectRoot, profile = loadProfile(projectRoot), transport, broker = requestEvidence,
  command = executeCommand, agent, signal, onUsage,
} = {}) {
  const root = fs.realpathSync(projectRoot);
  if (args.maxChars !== undefined && (!Number.isSafeInteger(args.maxChars) || args.maxChars < 256)) {
    throw new RangeError('maxChars must be an integer of at least 256 Unicode characters.');
  }
  const roles = resolveMicroRoles(profile);
  const taskId = args.taskId || crypto.randomUUID();
  const auditEnabled = roles.micro?.audit === true;
  const auditDir = path.join(root, '.contextos', 'micro-audit');
  const auditFile = path.join(auditDir, `${crypto.randomUUID()}.ndjson`);
  let auditEvents = 0;
  let auditFailed = false;
  const writeAudit = async (event) => {
    if (!auditEnabled || auditFailed) return;
    const safe = safeAuditEvent(event);
    if (!safe) return;
    try {
      fs.mkdirSync(path.dirname(auditDir), { recursive: true, mode: 0o700 });
      const parent = fs.realpathSync(path.dirname(auditDir));
      if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) throw new Error('audit parent escapes workspace');
      fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
      const directory = fs.realpathSync(auditDir);
      if (directory !== root && !directory.startsWith(`${root}${path.sep}`)) throw new Error('audit directory escapes workspace');
      fs.chmodSync(directory, 0o700);
      fs.appendFileSync(auditFile, `${JSON.stringify(safe)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.chmodSync(auditFile, 0o600);
      auditEvents += 1;
    } catch { auditFailed = true; }
  };
  const withAuditDiagnostics = (result) => {
    if (!auditEnabled) return result;
    const diagnostics = auditDiagnostics(true, auditEvents, auditFailed).diagnostics;
    return { ...result, diagnostics: { ...(result.diagnostics || {}), ...diagnostics } };
  };
  const writeParentAudit = async (parentAction, result = {}) => writeAudit({
    kind: 'parent', action: parentAction,
    ...(typeof result.resultId === 'string' ? { resultId: result.resultId } : {}),
    ...(typeof result.id === 'string' ? { commandId: result.id } : {}),
    ...(typeof result.receipt?.id === 'string' ? { receiptId: result.receipt.id } : {}),
  });
  const withAuditParent = async (parentAction, result) => {
    await writeParentAudit(parentAction, result);
    return withAuditDiagnostics(result);
  };
  let requestNumber = 0;
  const meteringGaps = [];
  const recordUsage = async (row) => {
    if (typeof onUsage !== 'function') return false;
    try {
      const recorded = await onUsage(row);
      if (recorded?.accepted === false) {
        meteringGaps.push(`Usage receipt could not be persisted for ${row.requestId}; usage accounting is incomplete.`);
      }
      return recorded?.accepted === true;
    } catch {
      meteringGaps.push(`Usage receipt could not be persisted for ${row.requestId}; usage accounting is incomplete.`);
      return false;
    }
  };
  const withMeteringGaps = (result) => meteringGaps.length ? { ...result, missing: [...(result.missing || []), ...meteringGaps] } : result;
  const configured = roles.micro && (roles.micro.url || roles.micro.baseUrl) && roles.micro.model;
  let localTransport = transport;
  const api = transport || (configured && process.env.CONTEXTOS_DISABLE_API_MICRO !== '1' ? async (payload) => {
    localTransport ||= createEvidenceTransport({
      ...roles.micro,
      ...(roles.micro.maxOutputTokens != null
        ? { maxOutputTokens: roles.micro.maxOutputTokens }
        : roles.micro.maxTokens != null
          ? { maxOutputTokens: roles.micro.maxTokens }
          : {}),
    });
    return localTransport(payload);
  } : null);
  const tracked = api ? async (payload) => {
    const sequence = ++requestNumber;
    const admission = await acquireApiTaskBudget({ projectRoot: root, budget: roles.micro?.taskBudget, signal,
      usageRecorderAvailable: typeof onUsage === 'function' });
    if (admission.enabled && !admission.allowed) {
      await writeAudit({ kind: 'transport', seq: sequence, status: 'local_failed', model: null, usage: null,
        offeredToolNames: payload.tools?.map((tool) => tool?.function?.name) });
      const error = new Error(admission.error || 'API Micro task budget admission failed.');
      error.code = admission.errorCode;
      error.invocation = { providerLaunches: 0 };
      throw error;
    }
    const budgeted = admission.enabled === true;
    const requestId = budgeted ? admission.requestId : `${taskId}:${sequence}`;
    const usageTaskId = budgeted ? admission.taskId : taskId;
    const startedAt = new Date().toISOString();
    const started = Date.now();
    let providerLaunches;
    let usageRecorded = false;
    const persistUsage = async ({ model, usage, status, completion: completionData }) => {
      if (providerLaunches === 0) return;
      usageRecorded = await recordUsage({ role: 'api-micro', taskId: usageTaskId, requestId,
        model: model ?? null, requestedModel: roles.micro?.model ?? null,
        provider: roles.micro?.provider || roles.micro?.transport || 'api', usage: usage ?? null,
        startedAt, durationMs: Date.now() - started, status,
        ...(budgeted ? { providerLaunches: providerLaunches ?? null } : {}),
      });
      await writeAudit({ kind: 'transport', seq: sequence, status, model: model ?? null, usage: usage ?? null,
        completion: completionData ?? null,
        offeredToolNames: payload.tools?.map((tool) => tool?.function?.name) });
    };
    let response;
    try { response = await api(payload); }
    catch (error) {
      providerLaunches = error.invocation?.providerLaunches;
      await persistUsage({ model: error.model, usage: error.usage, status: 'failed' });
      admission.finish({ providerLaunches, usageRecorded });
      throw error;
    }
    providerLaunches = response.invocation?.providerLaunches;
    await persistUsage({ model: response.model, usage: response.usage, completion: response.completion,
      status: response.ok === false ? 'failed' : 'completed' });
    admission.finish({ providerLaunches, usageRecorded });
    if (response.ok === false) {
      const error = new Error(response.error || 'API Micro request failed.');
      error.usage = response.usage ?? null;
      error.model = response.model ?? null;
      error.invocation = response.invocation;
      error.code = response.errorCode;
      throw error;
    }
    return response;
  } : null;
  if (action === 'ask') {
    if (args.resultId) {
      if (own(args, 'known')) return withAuditParent('ask', artifactFailure(args.resultId, 'INVALID_EVIDENCE_RECOVERY', 'resultId recovery cannot be combined with known; use known references on a new semantic request.'));
      if (own(args, 'inspect') && own(args, 'recovery')) return withAuditParent('ask', artifactFailure(args.resultId, 'INVALID_EVIDENCE_RECOVERY', 'Specify either inspect or recovery, not both.'));
      const recovery = own(args, 'recovery') ? args.recovery : (own(args, 'inspect') ? { inspect: args.inspect } : undefined);
      return withAuditParent('ask', await readResult(root, args.resultId, recovery));
    }
    if (own(args, 'recovery')) return withAuditParent('ask', artifactFailure(undefined, 'INVALID_EVIDENCE_RECOVERY', 'recovery requires a stored resultId.'));
    if (own(args, 'known') && own(args, 'inspect')) return withAuditParent('ask', artifactFailure(undefined, 'INVALID_KNOWN_CONTEXT', 'known is for semantic requests; exact inspect already reads its requested source ranges directly.'));
    let knownContext;
    if (own(args, 'known')) {
      try { knownContext = await resolveKnownContext(root, args.known, signal); }
      catch (error) { return withAuditParent('ask', artifactFailure(undefined, error.code || 'INVALID_KNOWN_CONTEXT', error.message)); }
    }
    const result = await broker(args, { projectRoot: root, config: roles.micro || {}, transport: tracked, signal, knownContext,
      ...(auditEnabled ? { onTrace: writeAudit } : {}) });
    const unresolvedKnown = missingKnownSelection(result, knownContext);
    const persistedResult = publicResult(withMeteringGaps({
      ...result,
      status: unresolvedKnown.length && result.status !== 'failed' ? 'partial' : (result.status === 'complete' ? 'completed' : result.status),
      ...(unresolvedKnown.length ? { missing: [...(result.missing || []), ...unresolvedKnown] } : {}),
      taskId,
    }));
    const resultId = `result-${crypto.randomUUID()}`;
    await writeParentAudit('ask', { resultId });
    return storeResult(root, publicResult(withAuditDiagnostics(persistedResult)), resultId);
  }
  if (action === 'command') {
    const result = await command(args, { projectRoot: root, transport: tracked, signal });
    const publicData = publicResult(withMeteringGaps(result));
    await writeParentAudit('command', publicData);
    return publicResult(withAuditDiagnostics(publicData));
  }
  if (action === 'agent') {
    if (!agent) throw new Error('CLI task dispatcher is unavailable.');
    const name = args.adapter || roles.agents?.default;
    const adapter = roles.agents?.adapters?.[name];
    const requiresAdapter = !args.action || ['run', 'batch'].includes(args.action);
    if (!adapter && requiresAdapter) return { status: 'failed', errorCode: 'AGENT_NOT_CONFIGURED', missing: ['Configure a CLI adapter under agents.adapters, then select agents.default. API Micro is a separate service.'] };
    return agent(args, { projectRoot: root, roles, adapter, name, signal });
  }
  throw new Error(`Unknown request action '${action}'.`);
}

export function renderRequestResult(result, { maxChars = 12000, onReportDelivered, onMessagesDelivered, onSourceDelivered, onSourceMetrics } = {}) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 256) throw new RangeError('maxChars must be an integer of at least 256 Unicode characters.');
  const limit = maxChars;
  const chars = (value) => Array.from(value).length;
  const status = result.status || (result.ok === false ? 'failed' : 'completed');
  const records = result.records || result.evidence || [];
  const reused = Array.isArray(result.reused) ? result.reused : [];
  const recovery = result.resultId
    ? `result=${result.resultId} with larger maxChars`
    : result.id ? `command=${result.id} with larger maxChars` : 'the stored result with larger maxChars';
  const formatGap = (gap) => {
    if (typeof gap === 'string') return gap;
    if (!gap || typeof gap !== 'object') return 'unclassified gap';
    const range = gap.range ?? gap.ranges;
    return [gap.path, range == null ? null : JSON.stringify(range), gap.reason || gap.message]
      .filter(Boolean).join(' ');
  };
  const sourceGap = (record) => `source path=${record.path || 'unknown'} ranges=${JSON.stringify(record.ranges || [])} omitted; recover ${recovery}`;
  const reusedGap = (reference) => `Reused evidence reference omitted by delivery budget: path=${reference.path || 'unknown'} ranges=${JSON.stringify(reference.ranges || [])}; fetch result=${reference.resultId || result.resultId || 'unknown'} with larger maxChars`;
  const missingFromResult = (Array.isArray(result.missing) ? result.missing : []).map(formatGap);
  const sourceBlocks = records.map((record) => ({
    record,
    block: `\n\n${record.path} ${JSON.stringify(record.ranges || [])} hash=${record.contentHash || 'unknown'}\n${record.text || ''}`,
  }));
  const reusedBlocks = reused.map((reference) => ({
    reference,
    block: `\nreused result=${reference.resultId || 'unknown'} ${reference.path || 'unknown'} ${JSON.stringify(reference.ranges || [])} hash=${reference.contentHash || 'unknown'}`,
  }));
  const potentialOmissions = [
    result.summary ? 'summary' : null,
    result.analysis ? 'analysis' : null,
    result.report ? 'report' : null,
    result.jobs ? 'jobs' : null,
    result.messages?.length ? `messages[${result.messages.length}]` : null,
    result.log?.length ? `log-lines[${result.log.length}]` : null,
    result.reports?.length ? `reports[${result.reports.length}]` : null,
  ].filter(Boolean);
  const statusGrowthReserve = status === 'failed' || status === 'partial'
    ? 0 : chars(`status=partial resultStatus=${status}`) - chars(`status=${status}`);
  const omissionNoticeReserve = potentialOmissions.length
    ? chars(`\nomitted details[${potentialOmissions.length}]; larger maxChars`)
    : 0;
  const coreLimit = limit - statusGrowthReserve - omissionNoticeReserve;
  const selectedSources = new Set();
  const selectedReused = new Set();
  const deliveredSources = [];
  const deliveredReports = [];
  let deliveredMessages = [];

  const composeCore = () => {
    const gaps = [
      ...sourceBlocks.filter((item) => !selectedSources.has(item.record)).map((item) => sourceGap(item.record)),
      ...reusedBlocks.filter((item) => !selectedReused.has(item.reference)).map((item) => reusedGap(item.reference)),
      ...missingFromResult,
    ];
    const shownStatus = status === 'failed' ? 'failed' : gaps.length ? 'partial' : status;
    const statusLine = `status=${shownStatus}${shownStatus !== status ? ` resultStatus=${status}` : ''}${result.resultId ? ` result=${result.resultId}` : ''}${result.id ? ` id=${result.id}` : ''}`;
    const header = [
      statusLine,
      result.errorCode ? `error=${result.errorCode}` : null,
      result.receipt ? `receipt=${result.receipt.id} exit=${result.receipt.exitCode} log=${result.receipt.logHandle || 'unavailable'}` : null,
      result.coverage && !result.coverage.complete ? `log coverage=partial selected=${result.coverage.selectedLines}/${result.coverage.totalLines}` : null,
    ].filter(Boolean).join('\n');
    const blocks = [
      ...reusedBlocks.filter((item) => selectedReused.has(item.reference)).map((item) => item.block),
      ...sourceBlocks.filter((item) => selectedSources.has(item.record)).map((item) => item.block),
    ];
    const prefix = [header, ...blocks].filter(Boolean).join('');
    const label = gaps.length ? `missing[${gaps.length}]` : '';
    const separator = prefix && label ? '\n' : '';
    const detailAvailable = coreLimit - chars(prefix) - chars(separator) - chars(label);
    let gapText = label;
    if (gaps.length && detailAvailable >= 0) {
      const fullDetails = `: ${gaps.join('; ')}`;
      if (chars(fullDetails) <= detailAvailable) gapText += fullDetails;
      else {
        const tailFor = (count) => `; ${count} more gap detail(s) omitted; recover ${recovery} for exact ranges`;
        const shown = [];
        for (const gap of gaps) {
          const omitted = gaps.length - shown.length - 1;
          const candidate = `: ${[...shown, gap].join('; ')}${omitted ? tailFor(omitted) : ''}`;
          if (chars(candidate) > detailAvailable) break;
          shown.push(gap);
        }
        const omitted = gaps.length - shown.length;
        if (shown.length) gapText += `: ${shown.join('; ')}${omitted ? tailFor(omitted) : ''}`;
        else if (omitted && chars(tailFor(omitted)) <= detailAvailable) gapText += tailFor(omitted);
      }
    }
    return [prefix, gapText].filter(Boolean).join('\n');
  };

  // Keep source blocks whole and leave room for a compact omission count and
  // any status-line growth before admitting each block.
  for (const { record } of sourceBlocks) {
    selectedSources.add(record);
    const candidate = composeCore();
    if (chars(candidate) <= coreLimit) deliveredSources.push(record);
    else selectedSources.delete(record);
  }
  for (const { reference } of reusedBlocks) {
    selectedReused.add(reference);
    if (chars(composeCore()) > coreLimit) selectedReused.delete(reference);
  }

  let output = composeCore();
  const omittedDetails = [];
  const appendOptional = (label, block) => {
    if (chars(output) + chars(block) + statusGrowthReserve + omissionNoticeReserve <= limit) {
      output += block;
      return true;
    }
    omittedDetails.push(label);
    return false;
  };
  let omittedLogLines = 0;
  for (let index = 0; index < (result.log || []).length; index += 1) {
    const item = result.log[index];
    const block = `\nL${item.line}: ${item.text}`;
    if (chars(output) + chars(block) + statusGrowthReserve + omissionNoticeReserve > limit) {
      omittedLogLines = result.log.length - index;
      break;
    }
    output += block;
  }
  if (omittedLogLines) omittedDetails.push(`log-lines[${omittedLogLines}]`);
  if (result.summary) appendOptional('summary', `\nsummary=${result.summary}`);
  if (result.analysis) appendOptional('analysis', `\nMicro interpretation: ${result.analysis}`);
  if (result.report) appendOptional('report', `\nreport=${JSON.stringify(result.report)}`);
  if (result.jobs) appendOptional('jobs', `\njobs=${JSON.stringify(result.jobs)}`);
  if (result.messages?.length) {
    const messageBlock = `\nmessages=${JSON.stringify(result.messages)}`;
    if (appendOptional(`messages[${result.messages.length}]`, messageBlock)) deliveredMessages = result.messages.map((item) => item.id);
  }
  let omittedReports = 0;
  for (const report of result.reports || []) {
    const block = `\nreport=${report.content}`;
    if (chars(output) + chars(block) + statusGrowthReserve + omissionNoticeReserve <= limit) {
      output += block;
      deliveredReports.push(report.id);
    } else omittedReports += 1;
  }
  if (omittedReports) omittedDetails.push(`reports[${omittedReports}]`);
  if (omittedDetails.length) {
    const labels = omittedDetails.join(',');
    const notices = [
      `\ndisplay details omitted=${labels}; recover ${recovery}`,
      `\nomitted ${labels}; larger maxChars`,
      `\nomitted details[${omittedDetails.length}]; larger maxChars`,
    ];
    const notice = notices.find((candidate) => chars(output) + chars(candidate) + statusGrowthReserve <= limit);
    if (notice) output += notice;
  }

  const hasDeliveryGaps = sourceBlocks.some((item) => !selectedSources.has(item.record))
    || reusedBlocks.some((item) => !selectedReused.has(item.reference))
    || missingFromResult.length > 0 || omittedDetails.length > 0;
  const renderedStatus = status === 'failed' ? 'failed' : hasDeliveryGaps ? 'partial' : status;
  const renderedStatusLine = `status=${renderedStatus}${renderedStatus !== status ? ` resultStatus=${status}` : ''}${result.resultId ? ` result=${result.resultId}` : ''}${result.id ? ` id=${result.id}` : ''}`;
  output = output.replace(/^status=[^\n]*/, renderedStatusLine);
  if (chars(output) > limit) throw new Error('Evidence renderer exceeded its character budget.');

  for (const record of deliveredSources) {
    try { onSourceDelivered?.(record); } catch { /* delivery tracking cannot change rendered output */ }
  }
  const renderedMetrics = measureUniqueSourceBlocks(deliveredSources);
  try {
    onSourceMetrics?.({
      renderedSourceBytes: renderedMetrics?.bytes ?? null,
      renderedSourceChars: renderedMetrics?.chars ?? null,
    });
  } catch { /* metrics cannot change rendered output */ }
  for (const id of deliveredReports) onReportDelivered?.(id);
  if (deliveredMessages.length) onMessagesDelivered?.(deliveredMessages);
  return output;
}
