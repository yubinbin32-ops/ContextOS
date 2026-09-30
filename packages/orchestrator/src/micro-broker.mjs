import { randomBytes } from 'node:crypto';
import {
  collectEvidence,
  deliverEvidence,
  listWorkspacePaths,
  mergeLineRanges,
  normalizeEvidencePath,
  searchWorkspace,
  workspaceIdentity,
} from './evidence-core.mjs';

const DEFAULT_MAX_TRANSPORT_INVOCATIONS = 48;
const DEFAULT_MAX_TOOL_CALLS = 192;
const DEFAULT_MAX_BATCH_READS = 64;
const DEFAULT_MAX_READ_REQUESTS = 128;
const DEFAULT_MAX_EVIDENCE_RECORDS = 128;
const DEFAULT_MAX_EVIDENCE_BYTES = 65_536;
const DEFAULT_MAX_SEARCH_RESULTS = 48;
const DEFAULT_MAX_SEARCH_BYTES = 24_576;
const DEFAULT_MAX_SEARCH_HYDRATION_HITS = 4;
const DEFAULT_MAX_SEARCH_HYDRATION_WINDOW_LINES = 5;
const DEFAULT_MAX_SEARCH_HYDRATION_BYTES = 12_288;
const MAX_SEARCH_PATH_RESULTS_PER_CALL = 12;
const HARD_MAX_TRANSPORT_INVOCATIONS = 256;
const HARD_MAX_TOOL_CALLS = 1024;
const HARD_MAX_BATCH_READS = 512;
const HARD_MAX_READ_REQUESTS = 4_096;
const HARD_MAX_EVIDENCE_RECORDS = 4_096;
const HARD_MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const HARD_MAX_SEARCH_RESULTS = 2_000;
const HARD_MAX_SEARCH_BYTES = 2 * 1024 * 1024;
const HARD_MAX_SEARCH_HYDRATION_HITS = 4;
const HARD_MAX_SEARCH_HYDRATION_WINDOW_LINES = 8;
const HARD_MAX_SEARCH_HYDRATION_BYTES = HARD_MAX_EVIDENCE_BYTES;

const SELECT_RANGES_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      start: { type: 'integer' },
      end: { type: 'integer' },
    },
    required: ['start', 'end'],
    additionalProperties: false,
  },
};

const makeSearchTool = (modes) => ({
  type: 'function',
  function: {
    name: 'search',
    description: modes.length === 1 && modes[0] === 'paths'
      ? 'Find bounded relative paths without reading source contents. Use mode paths and a few literal path-name substrings. Results are discovery hints only, not source evidence; use read for exact ranges, then select.'
      : 'Search source lines or workspace paths. Content mode matches literal line substrings; paths mode lists bounded safe source-like paths without reading contents. Queries are OR-ed. Scope with paths when known; results are discovery hints and are not proof unless exact source records are included.',
    parameters: {
      type: 'object',
      properties: {
        mode: modes.length === 1
          ? { type: 'string', const: modes[0] }
          : { type: 'string', enum: modes, description: 'Defaults to content. Use paths for file-name discovery.' },
        queries: { type: 'array', items: { type: 'string', ...(modes.length === 1 && modes[0] === 'paths' ? { maxLength: 160 } : {}) },
          minItems: 1, ...(modes.length === 1 && modes[0] === 'paths' ? { maxItems: 8 } : {}) },
        paths: { type: 'array', items: { type: 'string', ...(modes.length === 1 && modes[0] === 'paths' ? { maxLength: 512 } : {}) },
          description: 'Optional relative file or directory scopes.', ...(modes.length === 1 && modes[0] === 'paths' ? { maxItems: 8 } : {}) },
        limit: { type: 'integer', minimum: 1, ...(modes.length === 1 && modes[0] === 'paths'
          ? { maximum: MAX_SEARCH_PATH_RESULTS_PER_CALL } : {}) },
        cursor: { type: 'integer', minimum: 0, description: 'Continue a prior bounded path page with its nextCursor.' },
      },
      required: ['queries', ...(modes.length === 1 && modes[0] === 'paths' ? ['mode'] : [])],
      additionalProperties: false,
    },
  },
});

const BROKER_TOOLS = [
  makeSearchTool(['content', 'paths']),
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Batch-read uncovered exact inclusive 1-based ranges. If a range is already covered by verified known evidence, the result returns its reference metadata under alreadyCovered; cite it directly instead of rereading it.',
      parameters: {
        type: 'object',
        properties: {
          requests: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                ranges: {
                  type: 'array',
                  minItems: 1,
                  items: {
                    oneOf: [
                      { type: 'array', minItems: 2, maxItems: 2, items: { type: 'integer', minimum: 1 } },
                      { type: 'object', properties: { start: { type: 'integer', minimum: 1 }, end: { type: 'integer', minimum: 1 } }, required: ['start', 'end'], additionalProperties: false },
                    ],
                  },
                },
                contentHash: { type: 'string' },
              },
              required: ['path', 'ranges'],
              additionalProperties: false,
            },
          },
        },
        required: ['requests'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select',
      description: 'Call select when current evidence is sufficient or more search is unavailable. Prefer refs: copy a short ref handle from a current evidence record; use {id: ref, ranges} only for a verified subrange. Handles are valid only in this ask; never guess one. Legacy full references are accepted but not preferred. State concrete remaining gaps.',
      parameters: {
        type: 'object',
        properties: {
          refs: {
            type: 'array',
            items: {
              oneOf: [
                { type: 'string', description: 'A ref handle copied from a record in this ask; selects that full verified record.' },
                {
                  type: 'object',
                  properties: { id: { type: 'string' }, ranges: SELECT_RANGES_SCHEMA },
                  required: ['id'],
                  additionalProperties: false,
                },
              ],
            },
          },
          references: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                path: { type: 'string' },
                contentHash: { type: 'string' },
                ranges: SELECT_RANGES_SCHEMA,
              },
              required: ['id', 'path', 'contentHash', 'ranges'],
              additionalProperties: false,
            },
          },
          summary: { type: 'string' },
          missing: { type: 'array', items: { type: 'string' } },
        },
        required: ['refs'],
        additionalProperties: false,
      },
    },
  },
];
const BROKER_TOOLS_READ_SELECT = BROKER_TOOLS.filter((tool) => tool.function.name !== 'search');
const BROKER_TOOLS_SELECT_ONLY = BROKER_TOOLS.filter((tool) => tool.function.name === 'select');
const BROKER_TOOLS_CONTENT_ONLY = [makeSearchTool(['content']), ...BROKER_TOOLS_READ_SELECT];
const BROKER_TOOLS_PATHS_ONLY = [makeSearchTool(['paths']), ...BROKER_TOOLS_READ_SELECT];

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function parseToolArgs(value) {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function toolArgsShape(value) {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return 'json_array';
      if (parsed === null) return 'json_null';
      if (typeof parsed === 'object') return 'json_object';
      return `json_${typeof parsed}`;
    } catch { return 'invalid_json'; }
  }
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

function list(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function gap(reason, path) {
  return { ...(typeof path === 'string' && path ? { path } : {}), reason: String(reason) };
}

function normalizeModelMissing(value) {
  return list(value).filter((item) => item !== undefined && item !== null && String(item).trim())
    .map((item) => typeof item === 'object' && typeof item.reason === 'string'
      ? item
      : gap(typeof item === 'string' ? item : JSON.stringify(item)));
}

function normalizeReferences(selection) {
  if (Array.isArray(selection)) return selection;
  if (!selection || typeof selection !== 'object') return [];
  if (Array.isArray(selection.references)) return selection.references;
  if (Array.isArray(selection.citations)) return selection.citations;
  return [];
}

function mergeCompactReferences(references) {
  const grouped = new Map();
  for (const reference of references) {
    const key = JSON.stringify([reference.id, reference.path, reference.contentHash]);
    const group = grouped.get(key) || { ...reference, ranges: [], empty: false };
    if (reference.ranges.length) group.ranges.push(...reference.ranges);
    else group.empty = true;
    grouped.set(key, group);
  }
  return [...grouped.values()].map(({ empty, ranges, ...reference }) => ({
    ...reference,
    ranges: empty ? [] : mergeLineRanges(ranges),
  }));
}

function normalizeSelectionSubmission(selection, evidenceHandles) {
  const value = Array.isArray(selection) ? { references: selection } : selection;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, references: [], missing: [gap('Selection arguments must be a JSON object.')],
      failureCategory: 'arguments_not_object', summary: '' };
  }
  const hasCompact = own(value, 'refs');
  const hasLegacy = own(value, 'references') || own(value, 'citations');
  if (hasCompact && hasLegacy) {
    return { valid: false, references: [], missing: [gap('Select must use refs or legacy references, not both.')],
      failureCategory: 'refs_references_conflict', summary: '' };
  }
  if (!hasCompact && !hasLegacy) {
    return { valid: false, references: [], missing: [gap('Selection refs must be an array.')],
      failureCategory: 'refs_not_array', summary: '' };
  }
  const summary = typeof value.summary === 'string' ? value.summary : '';
  const missing = normalizeModelMissing(value.missing);
  const failure = { category: undefined };
  if (hasLegacy) {
    const legacyReferences = own(value, 'references') ? value.references : value.citations;
    if (!Array.isArray(legacyReferences)) {
      return { valid: false, references: [], missing: [...missing, gap('Selection references must be an array.')],
        failureCategory: 'references_not_array', summary };
    }
    return { valid: true, references: legacyReferences, missing, summary };
  }
  if (!Array.isArray(value.refs)) {
    return { valid: false, references: [], missing: [...missing, gap('Selection refs must be an array.')],
      failureCategory: 'refs_not_array', summary };
  }

  const references = [];
  for (const item of value.refs) {
    const compactObject = item && typeof item === 'object' && !Array.isArray(item);
    if (typeof item !== 'string' && !compactObject) {
      missing.push(gap('Each compact selection ref must be a current evidence handle or {id, ranges}.'));
      failure.category ||= 'compact_reference_invalid';
      continue;
    }
    if (compactObject && (Object.keys(item).some((key) => !['id', 'ranges'].includes(key))
      || typeof item.id !== 'string')) {
      missing.push(gap('Compact selection objects accept only a known string id and optional ranges.'));
      failure.category ||= 'compact_reference_invalid';
      continue;
    }
    const handle = typeof item === 'string' ? item : item.id;
    const record = evidenceHandles.get(handle);
    if (!record) {
      missing.push(gap('Unknown or expired evidence handle; use a ref returned in this request.'));
      failure.category ||= 'unknown_evidence_handle';
      continue;
    }
    let ranges = record.ranges;
    if (compactObject && own(item, 'ranges')) {
      if (!Array.isArray(item.ranges)) {
        missing.push(gap('Compact selection ranges must be an array of inclusive line ranges.', record.path));
        failure.category ||= 'compact_ranges_invalid';
        continue;
      }
      if (!item.ranges.length) {
        missing.push(gap('Compact subranges must include at least one covered line.', record.path));
        failure.category ||= 'compact_ranges_invalid';
        continue;
      }
      try { ranges = mergeLineRanges(item.ranges); }
      catch {
        missing.push(gap('Compact selection ranges must be valid inclusive 1-based line ranges.', record.path));
        failure.category ||= 'compact_ranges_invalid';
        continue;
      }
    }
    references.push({ id: record.id, path: record.path, contentHash: record.contentHash, ranges });
  }
  return {
    valid: true,
    references: mergeCompactReferences(references),
    missing,
    summary,
    ...(failure.category ? { failureCategory: failure.category } : {}),
  };
}

function configuredLimit(args, config, name, fallback, hardMaximum) {
  const requested = args?.budget?.[name] ?? config?.budget?.[name];
  if (requested === undefined || requested === null) return fallback;
  const numeric = Number(requested);
  if (!Number.isSafeInteger(numeric) || numeric < 1) return fallback;
  return Math.min(numeric, hardMaximum);
}

function requestText(args) {
  const value = args?.request ?? args?.prompt ?? args?.task ?? args?.query;
  return typeof value === 'string' ? value.trim() : '';
}

function publicRecord(record) {
  return {
    id: record.id,
    path: record.path,
    ranges: record.ranges,
    text: record.text,
    contentHash: record.contentHash,
    bytes: record.bytes,
    chars: record.chars,
    missing: record.missing,
    ...(record.sourceEvidenceId ? { sourceEvidenceId: record.sourceEvidenceId } : {}),
  };
}

function toolRecord(record, evidenceHandleFor) {
  const output = publicRecord(record);
  const ref = evidenceHandleFor?.(record);
  return ref ? { ...output, ref } : output;
}

function makeAccounting({
  invocations,
  toolCalls,
  responses,
  maxInvocations,
  maxToolCalls,
  maxBatchReads,
  readRequests,
  maxReadRequests,
  evidenceRecords,
  maxEvidenceRecords,
  maxEvidenceBytes,
  evidenceBytes,
  evidenceChars,
  materializedEvidenceBytes,
  materializedEvidenceChars,
  renderedSourceBytes,
  renderedSourceChars,
  maxSearchResults,
  searchResults,
  maxSearchBytes,
  searchBytes,
  searchPaths,
  maxSearchHydrationHits,
  maxSearchHydrationWindowLines,
  maxSearchHydrationBytes,
  searchHydrationHits,
  searchHydrationRecords,
  searchHydrationBytes,
}) {
  const hasCompleteUsage = (usage) => {
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return false;
    const input = usage.input ?? usage.input_tokens ?? usage.prompt_tokens;
    const output = usage.output ?? usage.output_tokens ?? usage.completion_tokens;
    return Number.isFinite(input) && Number.isFinite(output);
  };
  const allUsageObserved = responses.length > 0 && responses.every((response) => hasCompleteUsage(response.usage));
  const anyUsageObserved = responses.some((response) => response.usage && typeof response.usage === 'object'
    && Object.values(response.usage).some((value) => Number.isFinite(value)));
  return {
    transportInvocations: invocations,
    toolCalls,
    maxTransportInvocations: maxInvocations,
    maxToolCalls,
    maxBatchReads,
    readRequests,
    maxReadRequests,
    evidenceRecords,
    maxEvidenceRecords,
    maxEvidenceBytes,
    evidenceBytes,
    evidenceChars,
    materializedEvidenceBytes,
    materializedEvidenceChars,
    renderedSourceBytes,
    renderedSourceChars,
    maxSearchResults,
    searchResults,
    maxSearchBytes,
    searchBytes,
    searchPaths,
    maxSearchHydrationHits,
    maxSearchHydrationWindowLines,
    maxSearchHydrationBytes,
    searchHydrationHits,
    searchHydrationRecords,
    searchHydrationBytes,
    providerResponses: responses,
    usage: allUsageObserved ? responses.map((response) => response.usage) : null,
    usageStatus: responses.length === 0 ? 'not_requested' : (allUsageObserved ? 'reported' : (anyUsageObserved ? 'partial' : 'unknown')),
  };
}

function configuredByteLimit(args, config, name, fallback, hardMaximum) {
  const requested = args?.budget?.[name] ?? config?.budget?.[name];
  if (requested === undefined || requested === null) return fallback;
  const numeric = Number(requested);
  if (!Number.isSafeInteger(numeric) || numeric < 0) return fallback;
  return Math.min(numeric, hardMaximum);
}

function configuredCountLimit(args, config, name, fallback, hardMaximum) {
  const requested = args?.budget?.[name] ?? config?.budget?.[name];
  if (requested === undefined || requested === null) return fallback;
  const numeric = Number(requested);
  if (!Number.isSafeInteger(numeric) || numeric < 1) return fallback;
  return Math.min(numeric, hardMaximum);
}

function failedResult(error, accounting = null) {
  return {
    status: 'failed',
    summary: '',
    workspace: null,
    workspaceId: null,
    records: [],
    missing: [gap(error?.message || error || 'Evidence request failed.')],
    notices: [],
    accounting,
  };
}

function searchOutput(result, existingRecords = [], evidenceHandleFor) {
  const records = Array.isArray(result.records) ? result.records : [];
  const results = result.results.map((hit) => {
    const hasHydratedRecord = [...records, ...existingRecords].some((record) => record.path === hit.path
      && record.contentHash === hit.contentHash
      && (record.ranges || []).some((range) => range.start <= hit.line && range.end >= hit.line));
    if (!hasHydratedRecord || !Object.hasOwn(hit, 'snippet')) return hit;
    const { snippet: _snippet, ...metadata } = hit;
    return metadata;
  });
  return {
    status: result.status,
    results,
    ...(records.length ? { records: records.map((record) => toolRecord(record, evidenceHandleFor)) } : {}),
    missing: result.missing,
    ...(result.notices?.length ? { notices: result.notices } : {}),
  };
}

function pathSearchOutput(result) {
  return {
    status: result.status,
    mode: 'paths',
    paths: result.paths,
    missing: result.missing,
    truncated: result.truncated === true,
    ...(Number.isSafeInteger(result.nextCursor) ? { nextCursor: result.nextCursor } : {}),
  };
}

function classifyReadMissing(item) {
  const reason = String(item?.reason ?? item ?? '').toLocaleLowerCase();
  if (/enoent|no such file|does not exist|not found/.test(reason)) return 'path_not_found';
  if (/escape|unsafe path|symlink resolves outside|absolute paths/.test(reason)) return 'unsafe_path';
  if (/requested line \d+ is outside|outside the \d+-line file/.test(reason)) return 'range_out_of_bounds';
  if (/content hash|hash mismatch|stale|multiple content versions/.test(reason)) return 'hash_mismatch';
  if (/budget|limit reached|limit is|not processed/.test(reason)) return 'budget_exceeded';
  if (/not a regular file|not a file|not a directory/.test(reason)) return 'not_file';
  if (/must be|invalid|line ranges|line range/.test(reason)) return 'invalid_request';
  return 'unknown';
}

function readOutput(result, evidenceHandleFor) {
  return {
    status: result.status,
    records: result.records.map((record) => toolRecord(record, evidenceHandleFor)),
    missing: result.missing,
    ...(result.notices?.length ? { notices: result.notices } : {}),
  };
}

function safeModelPath(value) {
  const normalized = normalizeEvidencePath(value);
  const parts = normalized.split('/');
  const lower = parts.at(-1).toLowerCase();
  const restricted = new Set([
    '.git', '.contextos', 'node_modules', 'vendor', 'dist', 'build', 'coverage',
    'generated', '__generated__', 'target', 'release', '.next', '.cache',
  ]);
  if (parts.some((part) => restricted.has(part))
    || /^\.env(?:\.|$)/i.test(lower)
    || ['id_rsa', 'id_ed25519', 'credentials.json', 'secrets.json'].includes(lower)
    || lower.endsWith('.lock')
    || /(?:\.generated\.[^.]+|\.min\.(?:js|css)|\.bundle\.js|\.map)$/i.test(lower)) {
    throw new Error('Model tools cannot read dependency, generated, or secret-like paths.');
  }
  return normalized;
}

function recordCoversRange(record, pathValue, contentHash, range) {
  const ranges = (Array.isArray(record) ? record : [record])
    .filter((item) => item.path === pathValue && item.contentHash === contentHash)
    .flatMap((item) => item.ranges || []);
  return subtractRanges([range], ranges).length === 0;
}

function subtractRanges(ranges, covered) {
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

function intersectRanges(ranges, covered) {
  const intersections = [];
  for (const wanted of ranges) {
    for (const available of covered) {
      const start = Math.max(wanted.start, available.start);
      const end = Math.min(wanted.end, available.end);
      if (start <= end) intersections.push({ start, end });
    }
  }
  return mergeLineRanges(intersections);
}

function recordReferences(records, pathValue, contentHash, ranges, evidenceHandleFor) {
  return records.filter((record) => record.path === pathValue && record.contentHash === contentHash)
    .map((record) => ({
      ref: evidenceHandleFor?.(record),
      id: record.id,
      path: record.path,
      contentHash: record.contentHash,
      ranges: intersectRanges(ranges, record.ranges || []),
    }))
    .filter((reference) => reference.ranges.length);
}

async function hydrateSearchCandidates({
  projectRoot,
  hits,
  existingRecords,
  maxHits,
  windowLines,
  maxHydrationBytes,
  maxEvidenceBytesRemaining,
  maxEvidenceRecordsRemaining,
  signal,
}) {
  const notices = [];
  const missing = [];
  const candidates = Array.isArray(hits) ? hits : [];
  const selectedHits = candidates.slice(0, Math.max(0, maxHits));
  if (candidates.length > selectedHits.length) {
    notices.push(gap(`Automatic search hydration is capped at ${selectedHits.length} hit(s); use read for additional candidates.`));
  }
  if (!selectedHits.length) {
    return { records: [], missing, notices, hitsConsidered: 0, bytes: 0 };
  }
  if (maxEvidenceRecordsRemaining <= 0 || maxEvidenceBytesRemaining <= 0) {
    missing.push(gap('Cumulative evidence budget is exhausted; search candidates cannot be hydrated.', selectedHits[0]?.path));
    return { records: [], missing, notices, hitsConsidered: selectedHits.length, bytes: 0 };
  }
  if (maxHydrationBytes <= 0) {
    notices.push(gap('Automatic search hydration byte limit is exhausted; use read for a narrower range.', selectedHits[0]?.path));
    return { records: [], missing, notices, hitsConsidered: selectedHits.length, bytes: 0 };
  }

  const requests = [];
  const unique = new Set();
  for (const hit of selectedHits) {
    let relative;
    try { relative = safeModelPath(hit?.path); } catch (error) {
      missing.push(gap(error.message, typeof hit?.path === 'string' ? hit.path : undefined));
      continue;
    }
    if (!Number.isSafeInteger(hit?.line) || hit.line < 1) {
      missing.push(gap('Search hit has no valid line number for bounded hydration.', relative));
      continue;
    }
    if (typeof hit.contentHash !== 'string' || !hit.contentHash) {
      missing.push(gap('Search hit has no content hash; search the current file again before reading.', relative));
      continue;
    }
    // Include line 1 under the same per-hit line, byte, and hash bounds.
    const range = { start: hit.line, end: hit.line + windowLines - 1 };
    if (recordCoversRange(existingRecords, relative, hit.contentHash, range)) continue;
    const key = JSON.stringify([relative, hit.contentHash, range.start, range.end]);
    if (unique.has(key)) continue;
    unique.add(key);
    requests.push({ path: relative, expectedContentHash: hit.contentHash, ranges: [[range.start, range.end]] });
  }
  if (!requests.length) {
    return { records: [], missing, notices, hitsConsidered: selectedHits.length, bytes: 0 };
  }

  const read = await collectEvidence({ projectRoot, requests, signal });
  missing.push(...read.missing);
  notices.push(...(read.notices || []));
  let hydrationBytesRemaining = maxHydrationBytes;
  let evidenceBytesRemaining = maxEvidenceBytesRemaining;
  let evidenceRecordsRemaining = maxEvidenceRecordsRemaining;
  const records = [];
  for (const record of read.records) {
    if (evidenceRecordsRemaining <= 0) {
      missing.push(gap(`Cumulative evidence record budget reached; search candidate was not hydrated.`, record.path));
      continue;
    }
    if (record.bytes > evidenceBytesRemaining) {
      missing.push(gap(`Cumulative evidence byte budget reached; candidate needs ${record.bytes} bytes with ${evidenceBytesRemaining} remaining.`, record.path));
      continue;
    }
    if (record.bytes > hydrationBytesRemaining) {
      notices.push(gap(`Automatic search hydration byte limit reached; candidate needs ${record.bytes} bytes with ${hydrationBytesRemaining} remaining; use a narrower read.`, record.path));
      continue;
    }
    records.push(record);
    evidenceRecordsRemaining -= 1;
    evidenceBytesRemaining -= record.bytes;
    hydrationBytesRemaining -= record.bytes;
  }
  return {
    records,
    missing,
    notices,
    hitsConsidered: selectedHits.length,
    bytes: records.reduce((sum, record) => sum + record.bytes, 0),
  };
}

function baseResult(identity, fields) {
  return {
    status: fields.status,
    ...(fields.errorCode ? { errorCode: fields.errorCode } : {}),
    summary: fields.summary || '',
    workspace: identity.workspace,
    workspaceId: identity.workspaceId,
    records: fields.records || [],
    ...(fields.reused?.length ? { reused: fields.reused } : {}),
    missing: fields.missing || [],
    notices: fields.notices || [],
    accounting: fields.accounting || null,
    ...(fields.selection ? { selection: fields.selection } : {}),
  };
}

/**
 * Resolve a semantic source request in a short isolated transport context, then verify and
 * deliver only exact current filesystem evidence. Exact inspect arrays bypass the model.
 */
export async function requestEvidence(args = {}, {
  projectRoot,
  config = {},
  transport,
  signal,
  knownContext,
  onTrace,
} = {}) {
  let identity;
  try {
    identity = workspaceIdentity(projectRoot);
  } catch (error) {
    return failedResult(error);
  }

  if (own(args, 'inspect')) {
    if (!Array.isArray(args.inspect)) {
      return baseResult(identity, {
        status: 'failed',
        missing: [gap('inspect must be an array of exact {path,ranges} reads.')],
        accounting: {
          transportInvocations: 0, toolCalls: 0, maxTransportInvocations: 0,
          maxToolCalls: 0, providerResponses: [], usage: null, usageStatus: 'not_requested',
          evidenceRecords: 0, evidenceBytes: 0, evidenceChars: 0,
          materializedEvidenceBytes: 0, materializedEvidenceChars: 0,
          renderedSourceBytes: null, renderedSourceChars: null,
        },
      });
    }
    try {
      const result = await collectEvidence({ projectRoot: identity.workspace, requests: args.inspect, signal });
      const missing = result.missing.slice();
      if (!args.inspect.length) missing.push(gap('No exact inspect paths were supplied.'));
      return baseResult(identity, {
        status: missing.length ? 'partial' : 'complete',
        summary: typeof args.request === 'string' ? args.request : '',
        records: result.records.map(publicRecord),
        missing,
        notices: result.notices,
        accounting: {
          transportInvocations: 0, toolCalls: 0, maxTransportInvocations: 0,
          maxToolCalls: 0, providerResponses: [], usage: null, usageStatus: 'not_requested',
          evidenceRecords: result.records.length,
          evidenceBytes: result.bytes,
          evidenceChars: result.chars,
          materializedEvidenceBytes: result.bytes,
          materializedEvidenceChars: result.chars,
          renderedSourceBytes: null,
          renderedSourceChars: null,
        },
      });
    } catch (error) {
      return baseResult(identity, {
        status: 'failed',
        missing: [gap(error.message)],
        accounting: {
          transportInvocations: 0, toolCalls: 0, maxTransportInvocations: 0,
          maxToolCalls: 0, providerResponses: [], usage: null, usageStatus: 'not_requested',
          evidenceRecords: 0, evidenceBytes: 0, evidenceChars: 0,
          materializedEvidenceBytes: 0, materializedEvidenceChars: 0,
          renderedSourceBytes: null, renderedSourceChars: null,
        },
      });
    }
  }

  if (typeof transport !== 'function') {
    return baseResult(identity, {
      status: 'failed',
      errorCode: 'API_MICRO_NOT_CONFIGURED',
      missing: [gap('API Micro is unavailable in this process. Configure its API profile and allow its profile/credential environment variables in the MCP host; exact inspect remains available.')],
      accounting: {
        transportInvocations: 0, toolCalls: 0,
        maxTransportInvocations: configuredLimit(args, config, 'maxTransportInvocations', DEFAULT_MAX_TRANSPORT_INVOCATIONS, HARD_MAX_TRANSPORT_INVOCATIONS),
        maxToolCalls: configuredLimit(args, config, 'maxToolCalls', DEFAULT_MAX_TOOL_CALLS, HARD_MAX_TOOL_CALLS),
        providerResponses: [], usage: null, usageStatus: 'not_requested',
        evidenceRecords: 0, evidenceBytes: 0, evidenceChars: 0,
        materializedEvidenceBytes: 0, materializedEvidenceChars: 0,
        renderedSourceBytes: null, renderedSourceChars: null,
      },
    });
  }

  const request = requestText(args);
  if (!request) {
    return baseResult(identity, {
      status: 'failed',
      missing: [gap('A natural-language request is required when inspect is not supplied.')],
      accounting: {
        transportInvocations: 0, toolCalls: 0,
        maxTransportInvocations: configuredLimit(args, config, 'maxTransportInvocations', DEFAULT_MAX_TRANSPORT_INVOCATIONS, HARD_MAX_TRANSPORT_INVOCATIONS),
        maxToolCalls: configuredLimit(args, config, 'maxToolCalls', DEFAULT_MAX_TOOL_CALLS, HARD_MAX_TOOL_CALLS),
        providerResponses: [], usage: null, usageStatus: 'not_requested',
        evidenceRecords: 0, evidenceBytes: 0, evidenceChars: 0,
        materializedEvidenceBytes: 0, materializedEvidenceChars: 0,
        renderedSourceBytes: null, renderedSourceChars: null,
      },
    });
  }

  const maxTransportInvocations = configuredLimit(args, config, 'maxTransportInvocations', DEFAULT_MAX_TRANSPORT_INVOCATIONS, HARD_MAX_TRANSPORT_INVOCATIONS);
  const maxToolCalls = configuredLimit(args, config, 'maxToolCalls', DEFAULT_MAX_TOOL_CALLS, HARD_MAX_TOOL_CALLS);
  const maxBatchReads = configuredCountLimit(args, config, 'maxBatchReads', DEFAULT_MAX_BATCH_READS, HARD_MAX_BATCH_READS);
  const maxReadRequests = configuredCountLimit(args, config, 'maxReadRequests', DEFAULT_MAX_READ_REQUESTS, HARD_MAX_READ_REQUESTS);
  const maxEvidenceRecords = configuredCountLimit(args, config, 'maxEvidenceRecords', DEFAULT_MAX_EVIDENCE_RECORDS, HARD_MAX_EVIDENCE_RECORDS);
  const maxEvidenceBytes = configuredByteLimit(args, config, 'maxEvidenceBytes', DEFAULT_MAX_EVIDENCE_BYTES, HARD_MAX_EVIDENCE_BYTES);
  const maxSearchResults = configuredCountLimit(args, config, 'maxSearchResults', DEFAULT_MAX_SEARCH_RESULTS, HARD_MAX_SEARCH_RESULTS);
  const maxSearchBytes = configuredByteLimit(args, config, 'maxSearchBytes', DEFAULT_MAX_SEARCH_BYTES, HARD_MAX_SEARCH_BYTES);
  const maxSearchHydrationHits = configuredCountLimit(args, config, 'maxSearchHydrationHits', DEFAULT_MAX_SEARCH_HYDRATION_HITS, HARD_MAX_SEARCH_HYDRATION_HITS);
  const maxSearchHydrationWindowLines = configuredCountLimit(args, config, 'searchHydrationWindowLines', DEFAULT_MAX_SEARCH_HYDRATION_WINDOW_LINES, HARD_MAX_SEARCH_HYDRATION_WINDOW_LINES);
  const maxSearchHydrationBytes = Math.min(
    configuredByteLimit(args, config, 'maxSearchHydrationBytes', DEFAULT_MAX_SEARCH_HYDRATION_BYTES, HARD_MAX_SEARCH_HYDRATION_BYTES),
    maxEvidenceBytes,
  );
  const responses = [];
  const workflowMissing = [];
  const workflowNotices = [];
  const availableRecords = new Map();
  const evidenceHandles = new Map();
  const handlesByRecordId = new Map();
  const handleScope = randomBytes(8).toString('hex');
  let handleSequence = 0;
  const evidenceHandleFor = (record) => {
    if (!record || typeof record.id !== 'string') return null;
    const verified = availableRecords.get(record.id);
    if (!verified || verified.path !== record.path || verified.contentHash !== record.contentHash) return null;
    let handle = handlesByRecordId.get(record.id);
    if (!handle) {
      handle = `e${handleScope}_${(++handleSequence).toString(36)}`;
      handlesByRecordId.set(record.id, handle);
      evidenceHandles.set(handle, verified);
    }
    return handle;
  };
  const searchedHashes = new Map();
  const knownPaths = new Set();
  const knownUnavailable = [];
  let readRequests = 0;
  let evidenceRecords = 0;
  let evidenceBytes = 0;
  let evidenceChars = 0;
  let searchResults = 0;
  let searchBytes = 0;
  let searchPaths = 0;
  let searchHydrationHits = 0;
  let searchHydrationRecords = 0;
  let searchHydrationBytes = 0;
  const preloadedRecords = new Map();
  const preloadedOrigins = new Map();
  for (const candidate of [...list(args.knownPaths), ...list(args.paths), ...list(knownContext?.paths)]) {
    try { knownPaths.add(safeModelPath(candidate)); } catch {}
  }
  const suppliedKnownRecords = Array.isArray(knownContext?.records) ? knownContext.records : [];
  if (suppliedKnownRecords.length) {
    const references = suppliedKnownRecords.map((record) => ({
      id: record?.id,
      path: record?.path,
      contentHash: record?.contentHash,
      ranges: record?.ranges,
    }));
    const verified = await deliverEvidence({
      projectRoot: identity.workspace,
      availableRecords: suppliedKnownRecords,
      references,
      signal,
    });
    workflowNotices.push(...(knownContext.missing || []), ...verified.missing.map((item) => ({
      ...item,
      reason: `Preloaded evidence is stale or unavailable: ${item.reason}`,
    })));
    knownUnavailable.push(...(knownContext.missing || []), ...verified.missing);
    for (const record of verified.records) {
      if (availableRecords.has(record.id)) continue;
      if (evidenceRecords >= maxEvidenceRecords || evidenceBytes + record.bytes > maxEvidenceBytes) {
        workflowNotices.push(gap('A verified known reference exceeds the current evidence budget; narrow its ranges or increase the evidence budget.', record.path));
        continue;
      }
      let relative;
      try { relative = safeModelPath(record.path); }
      catch (error) {
        workflowNotices.push(gap(error.message, record.path));
        continue;
      }
      availableRecords.set(record.id, record);
      evidenceHandleFor(record);
      preloadedRecords.set(record.id, record);
      const supplied = suppliedKnownRecords.find((candidate) => candidate?.id === record.sourceEvidenceId);
      const originId = supplied?.sourceEvidenceId || supplied?.id || record.sourceEvidenceId || record.id;
      const origins = (knownContext?.references || []).filter((reference) => reference.id === originId
        && reference.path === record.path && reference.contentHash === record.contentHash);
      if (origins.length) preloadedOrigins.set(record.id, origins);
      knownPaths.add(relative);
      const hashes = searchedHashes.get(relative) || new Set();
      hashes.add(record.contentHash);
      searchedHashes.set(relative, hashes);
      evidenceRecords += 1;
      evidenceBytes += record.bytes;
      evidenceChars += record.chars;
    }
  } else if (knownContext?.missing?.length) {
    workflowNotices.push(...knownContext.missing);
    knownUnavailable.push(...knownContext.missing);
  }
  let invocations = 0;
  let toolCalls = 0;
  let state;
  let nextToolResults = [];
  let finalSummary = '';
  let selectedReferences = null;
  let selectedMissing = [];
  let selectionCompleted = false;
  let selectionFailureCategory;
  let transportFailed = false;
  let transportErrorCode;
  let traceSequence = 0;

  const budgetSnapshot = () => ({
    evidenceRecords, evidenceBytes, searchResults, searchBytes, searchPaths, readRequests, toolCalls,
  });
  const trace = async (event) => {
    if (typeof onTrace !== 'function') return;
    try { await onTrace({ seq: ++traceSequence, ...event }); } catch { /* audit must never affect evidence delivery */ }
  };
  const traceTool = async (name, result, before, selectionArgs, diagnostics = {}) => {
    const items = [];
    const addItem = (record, reused = false) => {
      if (typeof record?.path !== 'string' || typeof record?.contentHash !== 'string') return;
      const ranges = Array.isArray(record.ranges) ? record.ranges.filter((range) => Number.isSafeInteger(range?.start)
        && Number.isSafeInteger(range?.end) && range.start > 0 && range.end >= range.start).map(({ start, end }) => ({ start, end })) : [];
      if (!ranges.length) return;
      items.push({ path: record.path, ranges, hash: record.contentHash,
        bytes: Number.isSafeInteger(record.bytes) ? record.bytes : null, reused });
    };
    for (const record of result?.records || []) addItem(record, false);
    for (const record of result?.alreadyCovered || []) addItem(record, true);
    for (const hit of result?.results || []) {
      if (typeof hit?.path !== 'string' || typeof hit?.contentHash !== 'string' || !Number.isSafeInteger(hit.line)) continue;
      if (items.some((item) => item.path === hit.path && item.hash === hit.contentHash
        && item.ranges.some((range) => range.start <= hit.line && range.end >= hit.line))) continue;
      items.push({ path: hit.path, ranges: [{ start: hit.line, end: hit.line }], hash: hit.contentHash, bytes: null, reused: false });
    }
    if (Array.isArray(selectionArgs?.references)) {
      for (const reference of selectionArgs.references) addItem(reference, true);
    }
    const missing = (Array.isArray(result?.missing) ? result.missing : Array.isArray(selectionArgs?.missing) ? selectionArgs.missing : [])
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({ ...(typeof item.path === 'string' ? { path: item.path } : {}),
        ...(item.range && Number.isSafeInteger(item.range.start) && Number.isSafeInteger(item.range.end)
          ? { range: { start: item.range.start, end: item.range.end } } : {}) }));
    const missingCategories = name === 'read'
      ? [...new Set((Array.isArray(result?.missing) ? result.missing : []).map(classifyReadMissing))]
      : [];
    await trace({
      kind: 'tool', name, status: result?.status || (selectionArgs ? 'submitted' : 'unknown'),
      items, missing, bytes: items.every((item) => Number.isSafeInteger(item.bytes))
        ? items.reduce((sum, item) => sum + item.bytes, 0) : null,
      reused: items.some((item) => item.reused), budget: { before, after: budgetSnapshot() },
      ...(missingCategories.length ? { missingCategories } : {}),
      ...(diagnostics.argsShape ? { argsShape: diagnostics.argsShape } : {}),
      ...(typeof diagnostics.argumentsParseStatus === 'string' ? { argumentsParseStatus: diagnostics.argumentsParseStatus } : {}),
      ...(Number.isSafeInteger(diagnostics.argumentsBytes) && diagnostics.argumentsBytes >= 0
        ? { argumentsBytes: diagnostics.argumentsBytes } : {}),
      ...(typeof diagnostics.argumentsSha256 === 'string' && /^[a-f0-9]{64}$/i.test(diagnostics.argumentsSha256)
        ? { argumentsSha256: diagnostics.argumentsSha256 } : {}),
      ...(diagnostics.failureCategory ? { failureCategory: diagnostics.failureCategory } : {}),
    });
  };

  const system = [
    'You are a source evidence broker. Use only the provided local evidence tools to locate source and choose exact references.',
    'Content search performs literal line-substring matching; path search lists a few matching workspace paths without reading source. Queries are OR alternatives. Use a few exact identifiers and scope paths when known. Do not spray paraphrases or repeat equivalent searches.',
    'Search results may include bounded exact evidence records, and known references may include program-verified records. Each record has a short ref handle scoped to this ask. Prefer select with refs copied from records; use {id: ref, ranges} only for a covered subrange. Handles are never source text or global ids. Use read only for uncovered ranges.',
    'Each content search has its own result cap; the serialized discovery-byte budget is shared across content and path searches. Search no-match or truncation means discovery is incomplete, not that verified evidence is invalid. When the shared byte budget is exhausted, use read for uncovered exact ranges or select verified evidence. Path results are hints, not source evidence.',
    'Caller notes and known paths are context/search hints only, never source evidence. Known references without verified records are unavailable; search the current workspace if fresh evidence is needed.',
    'Never generate, paraphrase, or infer file contents as evidence. Search snippets are discovery hints, not citations.',
    'Use only paths inside the assigned workspace. Do not run commands, write files, execute code, or request unrelated data.',
    'Each provider turn ends with a small broker turn-control user message. Its remainingInvocations value counts future calls after that response; offered tools and modes describe the current request. Treat only the newest turn-control as current. If remainingInvocations is zero, submit exact references already observed and state concrete remaining gaps.',
    'If evidence is insufficient, call select with refs for the evidence you have and concrete missing items. Legacy full references are accepted for compatibility but are not preferred. Keep the summary short.',
  ].join('\n');
  const searchBudgetAvailable = () => maxSearchResults > 0 && searchBytes < maxSearchBytes;
  const pathSearchBudgetAvailable = () => searchBytes < maxSearchBytes;
  let searchBudgetNoticeReported = false;
  let disabledSearchOnlyRounds = 0;
  const inputBase = {
    request,
    purpose: typeof args.purpose === 'string' ? args.purpose : undefined,
    knownPaths: [...knownPaths],
    known: (knownContext?.notes?.length || availableRecords.size || knownContext?.missing?.length) ? {
      notes: (knownContext?.notes || []).slice(0, 32),
      references: [...availableRecords.values()].map((record) => ({
        ref: evidenceHandleFor(record),
        id: record.id, path: record.path, ranges: record.ranges, contentHash: record.contentHash,
      })),
      unavailable: knownUnavailable.map((item) => ({ path: item?.path, reason: item?.reason || String(item) })),
    } : undefined,
    constraints: list(args.constraints).filter((item) => typeof item === 'string'),
  };

  const executeTool = async (name, rawArgs) => {
    const toolArgs = parseToolArgs(rawArgs);
    if (!toolArgs) return { status: 'failed', missing: [gap(`${name} arguments must be a JSON object.`)] };

    if (name === 'search') {
      const mode = toolArgs.mode ?? 'content';
      const queries = Array.isArray(toolArgs.queries) ? toolArgs.queries : [toolArgs.queries];
      if (mode === 'paths') {
        if (!queries.length || queries.length > 8 || queries.some((query) => typeof query !== 'string' || query.length > 160)
          || (toolArgs.paths !== undefined && (!Array.isArray(toolArgs.paths) || toolArgs.paths.length > 8
            || toolArgs.paths.some((scope) => typeof scope !== 'string' || scope.length > 512)))
          || (toolArgs.cursor !== undefined && (!Number.isSafeInteger(toolArgs.cursor) || toolArgs.cursor < 0))) {
          return { status: 'failed', errorCode: 'PATH_SEARCH_ARGUMENTS_INVALID',
            missing: [gap('Path search accepts up to eight short literal queries, eight relative path scopes, and a non-negative integer cursor.')], truncated: true };
        }
        const remainingBytesForPaths = Math.max(0, maxSearchBytes - searchBytes);
        if (!remainingBytesForPaths) {
          const notice = gap(`Path discovery is exhausted by the shared ${maxSearchBytes}-byte discovery budget.`);
          workflowNotices.push(notice);
          return { status: 'partial', errorCode: 'PATH_SEARCH_BUDGET_EXHAUSTED', paths: [], missing: [notice], truncated: true };
        }
        const askedLimit = Number(toolArgs.limit) || MAX_SEARCH_PATH_RESULTS_PER_CALL;
        const limit = Math.min(askedLimit, MAX_SEARCH_PATH_RESULTS_PER_CALL);
        const result = await listWorkspacePaths({ projectRoot: identity.workspace, queries, paths: toolArgs.paths,
          limit, cursor: toolArgs.cursor, config, signal });
        const visiblePaths = [];
        for (const relativePath of result.paths) {
          const bytes = Buffer.byteLength(JSON.stringify({ path: relativePath }), 'utf8');
          if (searchBytes + bytes > maxSearchBytes) {
            result.missing.push(gap(`Shared discovery byte budget reached (${maxSearchBytes}); narrow the path scope.`));
            result.truncated = true;
            break;
          }
          visiblePaths.push(relativePath);
          searchBytes += bytes;
          searchPaths += 1;
        }
        if (visiblePaths.length < result.paths.length) result.truncated = true;
        workflowNotices.push(...result.missing);
        return pathSearchOutput({ ...result, paths: visiblePaths,
          status: result.missing.length ? 'partial' : result.status });
      }
      if (mode !== 'content') {
        return { status: 'failed', errorCode: 'SEARCH_MODE_INVALID', missing: [gap('Search mode must be content or paths.')] };
      }
      const remainingBytes = Math.max(0, maxSearchBytes - searchBytes);
      if (!maxSearchResults || !remainingBytes) {
        const notice = gap(!maxSearchResults
          ? 'Content search is disabled by config.budget.maxSearchResults; use available path discovery, read exact uncovered ranges, or select verified evidence.'
          : `Search byte budget was exhausted (${maxSearchBytes} serialized bytes); read exact uncovered ranges or select the verified evidence already available.`);
        if (!searchBudgetNoticeReported) {
          workflowNotices.push(notice);
          searchBudgetNoticeReported = true;
        }
        return { status: 'partial', errorCode: 'SEARCH_BUDGET_EXHAUSTED', results: [], missing: [notice] };
      }
      const askedLimit = Number(toolArgs.limit) || maxSearchResults;
      const limit = Math.max(1, Math.min(askedLimit, maxSearchResults));
      const paths = Array.isArray(toolArgs.paths) ? toolArgs.paths : undefined;
      const result = await searchWorkspace({ projectRoot: identity.workspace, queries, paths, limit, config, signal });
      const discoveryMissing = result.missing.slice();
      const visibleHits = [];
      for (const hit of result.results) {
        const serializedBytes = Buffer.byteLength(JSON.stringify(hit), 'utf8');
        if (searchBytes + serializedBytes > maxSearchBytes) {
          const missing = gap(`Search result byte budget reached (${maxSearchBytes}); narrow the query or raise config.budget.maxSearchBytes.`);
          result.missing.push(missing);
          break;
        }
        visibleHits.push(hit);
        searchBytes += serializedBytes;
        searchResults += 1;
        const hashes = searchedHashes.get(hit.path) || new Set();
        hashes.add(hit.contentHash);
        searchedHashes.set(hit.path, hashes);
      }
      const hydration = await hydrateSearchCandidates({
        projectRoot: identity.workspace,
        hits: visibleHits,
        existingRecords: [...availableRecords.values()],
        maxHits: Math.max(0, maxSearchHydrationHits - searchHydrationHits),
        windowLines: maxSearchHydrationWindowLines,
        maxHydrationBytes: Math.max(0, maxSearchHydrationBytes - searchHydrationBytes),
        maxEvidenceBytesRemaining: Math.max(0, maxEvidenceBytes - evidenceBytes),
        maxEvidenceRecordsRemaining: Math.max(0, maxEvidenceRecords - evidenceRecords),
        signal,
      });
      searchHydrationHits += hydration.hitsConsidered;
      const hydratedRecords = [];
      for (const record of hydration.records) {
        if (availableRecords.has(record.id)) continue;
        availableRecords.set(record.id, record);
        evidenceHandleFor(record);
        hydratedRecords.push(record);
        evidenceRecords += 1;
        evidenceBytes += record.bytes;
        evidenceChars += record.chars;
      }
      searchHydrationRecords += hydratedRecords.length;
      searchHydrationBytes += hydratedRecords.reduce((sum, record) => sum + record.bytes, 0);
      result.records = hydratedRecords;
      result.missing.push(...hydration.missing);
      result.notices = [...(result.notices || []), ...hydration.notices];
      const evidenceBudgetMissing = hydration.missing.filter((item) => /Cumulative evidence (?:record|byte) budget reached/.test(item.reason));
      workflowMissing.push(...evidenceBudgetMissing);
      workflowNotices.push(...discoveryMissing, ...result.notices, ...hydration.notices);
      return searchOutput({
        ...result,
        results: visibleHits,
        status: result.missing.length ? 'partial' : result.status,
      }, [...availableRecords.values()], evidenceHandleFor);
    }

    if (name === 'read') {
      if (!Array.isArray(toolArgs.requests)) return { status: 'failed', missing: [gap('read requests must be an array.')] };
      const remainingRequestCount = Math.max(0, maxReadRequests - readRequests);
      const allowedBatchSize = Math.min(maxBatchReads, remainingRequestCount);
      const batch = toolArgs.requests.slice(0, allowedBatchSize);
      readRequests += batch.length;
      const requests = [];
      const localMissing = [];
      const alreadyCovered = [];
      for (const item of batch) {
        let relative;
        try {
          relative = safeModelPath(item?.path);
          if (!Array.isArray(item?.ranges) || item.ranges.length === 0) {
            localMissing.push(gap('Model reads require explicit line ranges; exact full-file inspect is a caller operation.', relative));
            continue;
          }
          const wantedRanges = mergeLineRanges(item.ranges);
          const contentHash = item.contentHash ?? null;
          const discovered = searchedHashes.get(relative);
          const priorRecords = [...availableRecords.values()].filter((record) => record.path === relative);
          const pathHashes = new Set([...(discovered || []), ...priorRecords.map((record) => record.contentHash)]);
          if (contentHash && pathHashes.size && !pathHashes.has(contentHash)) {
            localMissing.push(gap('Requested content hash was not returned by search; search the current file again.', relative));
            continue;
          }
          if (!contentHash && pathHashes.size > 1) {
            localMissing.push(gap('Search saw multiple content versions; include the selected contentHash or search again.', relative));
            continue;
          }
          const selectedHash = contentHash || (pathHashes.size === 1 ? [...pathHashes][0] : null);
          const existingForPath = priorRecords.filter((record) => !selectedHash || record.contentHash === selectedHash);
          const coveredRanges = mergeLineRanges(existingForPath.flatMap((record) => record.ranges || []));
          alreadyCovered.push(...recordReferences(existingForPath, relative, selectedHash || existingForPath[0]?.contentHash,
            wantedRanges, evidenceHandleFor));
          const uncovered = subtractRanges(wantedRanges, coveredRanges);
          if (!uncovered.length) continue;
          requests.push({
            path: relative,
            ranges: uncovered,
            ...(selectedHash ? { expectedContentHash: selectedHash } : {}),
          });
        } catch (error) {
          localMissing.push(gap(error.message, typeof item?.path === 'string' ? item.path : undefined));
        }
      }
      if (toolArgs.requests.length > batch.length) {
        const reason = remainingRequestCount < maxBatchReads
          ? `Cumulative read request budget reached (${maxReadRequests}); raise config.budget.maxReadRequests or narrow the request.`
          : `Batch read limit is ${maxBatchReads}; ${toolArgs.requests.length - batch.length} request(s) were not processed.`;
        localMissing.push(gap(reason));
      }
      let result = {
        status: localMissing.length ? 'partial' : 'complete',
        records: [], missing: [], bytes: 0, chars: 0,
      };
      if (requests.length) {
        result = await collectEvidence({ projectRoot: identity.workspace, requests, signal });
      }
      result.missing.unshift(...localMissing);
      if (result.missing.length) result.status = 'partial';
      const visibleRecords = [];
      for (const record of result.records) {
        if (availableRecords.has(record.id)) continue;
        if (evidenceRecords >= maxEvidenceRecords) {
          result.missing.push(gap(`Cumulative evidence record budget reached (${maxEvidenceRecords}); raise config.budget.maxEvidenceRecords or narrow the ranges.`, record.path));
          continue;
        }
        if (evidenceBytes + record.bytes > maxEvidenceBytes) {
          result.missing.push(gap(`Cumulative evidence byte budget reached (${maxEvidenceBytes}); this range needs ${record.bytes} bytes with ${maxEvidenceBytes - evidenceBytes} remaining. Raise config.budget.maxEvidenceBytes or request narrower ranges.`, record.path));
          continue;
        }
        availableRecords.set(record.id, record);
        evidenceHandleFor(record);
        visibleRecords.push(record);
        evidenceRecords += 1;
        evidenceBytes += record.bytes;
        evidenceChars += record.chars;
      }
      if (result.missing.length) result.status = 'partial';
      // Search warnings describe discovery attempts. Keep them visible in this
      // result and the final notices, but don't let an early no-hit/truncation
      // invalidate a later program-verified selection by itself.
      workflowNotices.push(...result.missing, ...(result.notices || []));
      return {
        ...readOutput({ ...result, records: visibleRecords }, evidenceHandleFor),
        reusedIds: result.records.filter((record) => availableRecords.has(record.id) && !visibleRecords.includes(record)).map((record) => record.id),
        ...(alreadyCovered.length ? { alreadyCovered } : {}),
      };
    }

    if (name === 'select') {
      const submission = normalizeSelectionSubmission(toolArgs, evidenceHandles);
      selectedReferences = submission.references;
      selectedMissing = submission.missing;
      selectionFailureCategory = submission.failureCategory;
      finalSummary = submission.summary;
      selectionCompleted = true;
      return { status: submission.failureCategory ? 'partial' : 'submitted', referenceCount: selectedReferences.length };
    }

    return { status: 'failed', missing: [gap(`Unsupported evidence tool: ${String(name)}.`)] };
  };

  for (let step = 0; step < maxTransportInvocations; step += 1) {
    if (signal?.aborted) {
      workflowMissing.push(gap('Evidence request was cancelled before selection completed.'));
      break;
    }
    let output;
    invocations += 1;
    const contentSearchEnabled = searchBudgetAvailable();
    const pathsSearchEnabled = pathSearchBudgetAvailable();
    const finalInvocation = invocations === maxTransportInvocations;
    const roundTools = finalInvocation ? BROKER_TOOLS_SELECT_ONLY
      : (contentSearchEnabled && pathsSearchEnabled ? BROKER_TOOLS
        : (contentSearchEnabled ? BROKER_TOOLS_CONTENT_ONLY
          : (pathsSearchEnabled ? BROKER_TOOLS_PATHS_ONLY : BROKER_TOOLS_READ_SELECT)));
    const offeredToolNames = new Set(roundTools.map((tool) => tool.function.name));
    const offeredSearchTool = roundTools.find((tool) => tool.function.name === 'search');
    const offeredModeSchema = offeredSearchTool?.function?.parameters?.properties?.mode;
    const offeredSearchModes = new Set(offeredModeSchema
      ? (Array.isArray(offeredModeSchema.enum) ? offeredModeSchema.enum : [offeredModeSchema.const])
      : []);
    const turnControl = `Broker turn control: remainingInvocations=${maxTransportInvocations - invocations}; offeredTools=${[...offeredToolNames].join(',')}; offeredSearchModes=${[...offeredSearchModes].join(',') || 'none'}; maxContentResultsPerSearch=${maxSearchResults}; remainingSearchBytes=${Math.max(0, maxSearchBytes - searchBytes)}; totalSearchResults=${searchResults}; final=${finalInvocation}.`;
    const input = JSON.stringify(inputBase);
    try {
      output = await transport({
        system,
        input,
        tools: roundTools,
        turnControl,
        state,
        toolResults: nextToolResults,
        ...(config.thinking ?? config.micro?.thinking ? { thinking: config.thinking ?? config.micro.thinking } : {}),
        signal,
      });
    } catch (error) {
      transportFailed = true;
      transportErrorCode = error?.code || error?.errorCode || 'API_MICRO_TRANSPORT_FAILED';
      responses.push({ model: typeof error?.model === 'string' ? error.model : null, usage: error?.usage ?? null });
      workflowMissing.push(gap(`Evidence transport failed: ${error?.message || 'unknown transport error'}`));
      break;
    }

    const response = output && typeof output === 'object' ? output : {};
    const observedUsage = own(response, 'usage') && response.usage !== undefined ? response.usage : null;
    responses.push({ model: typeof response.model === 'string' ? response.model : null, usage: observedUsage });
    if (response.ok === false) {
      const launched = response.invocation?.providerLaunches !== 0;
      transportFailed = true;
      transportErrorCode = response.errorCode || 'API_MICRO_TRANSPORT_FAILED';
      workflowMissing.push(gap(`${launched ? 'Provider request failed' : 'Local transport setup failed'}${response.errorCode ? ` (${response.errorCode})` : ''}: ${response.error || 'no error detail returned.'}`));
      break;
    }
    if (response.state !== undefined) state = response.state;
    if (typeof response.summary === 'string') finalSummary = response.summary;
    if (response.missing !== undefined) selectedMissing.push(...normalizeModelMissing(response.missing));

    const calls = Array.isArray(response.calls) ? response.calls : [];
    if (calls.length === 0) {
      const submission = normalizeSelectionSubmission(response.selection, evidenceHandles);
      selectedReferences = submission.references;
      if (selectedReferences.length || response.selection) {
        selectionCompleted = true;
        selectedMissing.push(...submission.missing);
        selectionFailureCategory = submission.failureCategory;
        await traceTool('select', { status: submission.failureCategory ? 'partial' : 'submitted', missing: submission.missing },
          budgetSnapshot(), { references: selectedReferences, missing: submission.missing },
          { failureCategory: submission.failureCategory });
      }
      break;
    }

    const roundToolResults = [];
    const selections = [];
    for (const call of calls) {
      if (toolCalls >= maxToolCalls) {
        workflowMissing.push(gap(`Evidence tool-call budget reached (${maxToolCalls}).`));
        break;
      }
      if (!call || typeof call.name !== 'string') {
        workflowMissing.push(gap('Transport returned a tool call without a tool name.'));
        continue;
      }
      const before = budgetSnapshot();
      toolCalls += 1;
      if (call.name === 'select') {
        const selectionArgs = parseToolArgs(call.args);
        const argsShape = call.argsParseStatus === 'invalid_json' ? 'invalid_json' : toolArgsShape(call.args);
        const submission = normalizeSelectionSubmission(selectionArgs, evidenceHandles);
        const failureCategory = !selectionArgs ? 'arguments_not_object'
          : submission.failureCategory;
        if (failureCategory) selectionFailureCategory = failureCategory;
        await traceTool('select', { status: failureCategory ? 'failed' : 'submitted' }, before,
          { references: submission.references, missing: submission.missing }, {
            argsShape,
            ...(typeof call.argsParseStatus === 'string' ? { argumentsParseStatus: call.argsParseStatus } : {}),
            ...(Number.isSafeInteger(call.argumentsBytes) ? { argumentsBytes: call.argumentsBytes } : {}),
            ...(typeof call.argumentsSha256 === 'string' ? { argumentsSha256: call.argumentsSha256 } : {}),
            ...(failureCategory ? { failureCategory } : {}),
          });
        selections.push({ call, selectionArgs: submission });
        continue;
      }
      const rawToolArgs = parseToolArgs(call.args);
      const requestedSearchMode = call.name === 'search' ? (rawToolArgs?.mode ?? 'content') : undefined;
      const toolWasOffered = offeredToolNames.has(call.name)
        && (call.name !== 'search' || offeredSearchModes.has(requestedSearchMode));
      if (!toolWasOffered) {
        const failureCategory = call.name === 'search' && offeredToolNames.has('search')
          ? 'search_mode_not_offered' : 'tool_not_offered';
        const result = {
          status: 'failed',
          errorCode: failureCategory === 'search_mode_not_offered' ? 'SEARCH_MODE_NOT_OFFERED' : 'TOOL_NOT_OFFERED',
          missing: [gap(failureCategory === 'search_mode_not_offered'
            ? `Search mode '${requestedSearchMode}' was not offered in this round; use mode paths or select the available evidence.`
            : `Tool '${call.name}' was not offered in this round; use only the listed tools.`)],
        };
        workflowMissing.push(...result.missing);
        await traceTool(call.name, result, before, undefined, { failureCategory });
        const id = typeof call.id === 'string' && call.id ? call.id : null;
        if (!id) workflowMissing.push(gap(`Transport ${call.name} call did not include a tool call id.`));
        else roundToolResults.push({ toolCallId: id, name: call.name, result });
        continue;
      }
      let result;
      if (call.name !== 'search' && call.name !== 'read') {
        result = { status: 'failed', missing: [gap(`Unsupported evidence tool: ${call.name}.`)] };
        workflowMissing.push(...result.missing);
      } else {
        try {
          result = await executeTool(call.name, call.args);
        } catch (error) {
          result = { status: 'failed', missing: [gap(error?.message || 'Evidence tool failed.')] };
          if (call.name === 'search') workflowNotices.push(...result.missing);
          else workflowMissing.push(...result.missing);
        }
      }
      if (call.name === 'search' && result.status === 'failed') workflowNotices.push(...(result.missing || []));
      if (call.name === 'search' || call.name === 'read') await traceTool(call.name, result, before);
      const id = typeof call.id === 'string' && call.id ? call.id : null;
      if (!id) {
        workflowMissing.push(gap(`Transport ${call.name} call did not include a tool call id.`));
        continue;
      }
      roundToolResults.push({ toolCallId: id, name: call.name, result });
    }

    if (selections.length) {
      const selectionArgs = selections[0].selectionArgs;
      if (!selectionArgs?.valid) {
        selectedMissing.push(...(selectionArgs?.missing || [gap('Selection arguments must be a JSON object.')]));
        if (selectionArgs?.failureCategory) selectionFailureCategory = selectionArgs.failureCategory;
        selectedReferences = [];
      } else {
        selectedReferences = selectionArgs.references;
        selectedMissing.push(...selectionArgs.missing);
        if (selectionArgs.failureCategory) selectionFailureCategory = selectionArgs.failureCategory;
        finalSummary = selectionArgs.summary || finalSummary;
      }
      if (selections.length > 1) workflowMissing.push(gap('Multiple selections were returned; only the first was used.'));
      selectionCompleted = true;
      break;
    }

    nextToolResults = roundToolResults;
    if (toolCalls >= maxToolCalls && step + 1 < maxTransportInvocations) {
      workflowMissing.push(gap(`Evidence tool-call budget reached (${maxToolCalls}).`));
      break;
    }
    // A provider may ignore the path-only search schema after content search
    // is exhausted. Allow one correction round, then stop repeated invalid calls.
    if (!contentSearchEnabled && roundToolResults.length > 0
      && roundToolResults.every((item) => item.name === 'search' && item.result?.errorCode === 'SEARCH_MODE_NOT_OFFERED')) {
      disabledSearchOnlyRounds += 1;
      if (disabledSearchOnlyRounds >= 2) {
        workflowMissing.push(gap('Content search was unavailable across repeated rounds; no path search, read, or valid selection was submitted.'));
        break;
      }
    } else if (roundToolResults.some((item) => item.name !== 'search')) {
      disabledSearchOnlyRounds = 0;
    }
  }

  if (!selectionCompleted) {
    workflowMissing.push(gap('The evidence broker did not receive a valid citation selection.'));
  }
  if (invocations >= maxTransportInvocations && !selectionCompleted) {
    workflowMissing.push(gap(`Transport invocation budget reached (${maxTransportInvocations}); raise the request budget to continue.`));
  }

  let delivery = {
    records: [],
    missing: [],
    status: 'partial',
  };
  if (selectionCompleted) {
    try {
      delivery = await deliverEvidence({
        projectRoot: identity.workspace,
        availableRecords: [...availableRecords.values()],
        references: selectedReferences || [],
        signal,
      });
    } catch (error) {
      delivery.missing = [gap(error?.message || 'Could not verify selected evidence.')];
    }
  }
  // Known records have already been delivered to the caller. Keep their exact citation
  // provenance in `reused`, and return only newly needed source ranges as text.
  const reused = [];
  if (selectionCompleted && delivery.records?.length && preloadedRecords.size) {
    const gapRanges = new Map();
    const reusedRanges = new Map();
    const keyFor = (record) => `${record.path}\0${record.contentHash}`;
    for (const delivered of delivery.records) {
      const sameVersion = [...preloadedRecords.values()].filter((record) =>
        record.path === delivered.path && record.contentHash === delivered.contentHash);
      if (!sameVersion.length) {
        const key = keyFor(delivered);
        const group = gapRanges.get(key) || { path: delivered.path, contentHash: delivered.contentHash, ranges: [], empty: false };
        group.ranges.push(...(delivered.ranges || []));
        group.empty ||= !(delivered.ranges || []).length;
        gapRanges.set(key, group);
        continue;
      }

      const covered = mergeLineRanges(sameVersion.flatMap((record) => record.ranges || []));
      if (!(delivered.ranges || []).length && sameVersion.some((record) => !(record.ranges || []).length)) {
        const key = keyFor(delivered);
        const group = reusedRanges.get(key) || { path: delivered.path, contentHash: delivered.contentHash, ranges: [], empty: true };
        group.empty = true;
        reusedRanges.set(key, group);
        continue;
      }
      const overlap = intersectRanges(delivered.ranges || [], covered);
      const uncovered = subtractRanges(delivered.ranges || [], covered);
      if (overlap.length) {
        const key = keyFor(delivered);
        const group = reusedRanges.get(key) || { path: delivered.path, contentHash: delivered.contentHash, ranges: [], empty: false };
        group.ranges.push(...overlap);
        reusedRanges.set(key, group);
      }
      if (uncovered.length) {
        const key = keyFor(delivered);
        const group = gapRanges.get(key) || { path: delivered.path, contentHash: delivered.contentHash, ranges: [], empty: false };
        group.ranges.push(...uncovered);
        gapRanges.set(key, group);
      }
    }

    const knownOrigins = Array.isArray(knownContext?.references) ? knownContext.references : [];
    for (const group of reusedRanges.values()) {
      const matchingRecords = [...preloadedRecords.values()].filter((record) =>
        record.path === group.path && record.contentHash === group.contentHash
        && (group.empty ? !(record.ranges || []).length : (record.ranges || []).length > 0));
      const emitted = new Set();
      for (const record of matchingRecords) {
        const sourceId = record.sourceEvidenceId || record.id;
        const origins = preloadedOrigins.get(record.id) || knownOrigins.filter((reference) => reference.id === sourceId
          && reference.path === group.path && reference.contentHash === group.contentHash);
        const originList = origins.length ? origins : [{ id: sourceId, path: group.path, contentHash: group.contentHash,
          ranges: record.ranges || [] }];
        for (const origin of originList) {
          const ranges = group.empty ? [] : intersectRanges(group.ranges, origin.ranges || []);
          if (!group.empty && !ranges.length) continue;
          const originKey = `${origin.resultId || ''}\0${origin.id}\0${group.path}\0${group.contentHash}`;
          if (emitted.has(originKey)) {
            const previous = reused.find((item) => `${item.resultId || ''}\0${item.id}\0${item.path}\0${item.contentHash}` === originKey);
            if (previous && ranges.length) previous.ranges = mergeLineRanges([...previous.ranges, ...ranges]);
            continue;
          }
          emitted.add(originKey);
          reused.push({ ...(origin.resultId ? { resultId: origin.resultId } : {}), id: origin.id,
            path: group.path, contentHash: group.contentHash, ranges });
        }
      }
    }

    const newReferences = [];
    for (const group of gapRanges.values()) {
      const ranges = mergeLineRanges(group.ranges);
      const matching = [...availableRecords.values()].filter((record) =>
        record.path === group.path && record.contentHash === group.contentHash);
      if (group.empty && !ranges.length) {
        newReferences.push(...matching.filter((record) => !(record.ranges || []).length).map((record) => ({
          id: record.id, path: record.path, contentHash: record.contentHash, ranges: [],
        })));
      } else {
        newReferences.push(...recordReferences(matching, group.path, group.contentHash, ranges));
      }
    }
    if (newReferences.length) {
      try {
        const remaining = await deliverEvidence({ projectRoot: identity.workspace,
          availableRecords: [...availableRecords.values()], references: newReferences, signal });
        delivery = { ...delivery, records: remaining.records, missing: [...(delivery.missing || []), ...remaining.missing] };
      } catch (error) {
        delivery = { ...delivery, records: [], missing: [...(delivery.missing || []), gap(error?.message || 'Could not verify uncovered selected evidence.')] };
      }
    } else {
      delivery = { ...delivery, records: [] };
    }
  }

  const missing = [...workflowMissing, ...selectedMissing, ...(delivery.missing || [])];
  if (selectionCompleted && !(selectedReferences || []).length) {
    missing.push(gap('No evidence references were selected; source cannot be delivered without citations.'));
  }
  if (!selectionCompleted && signal?.aborted) missing.push(gap('The request was cancelled before evidence could be selected.'));
  const records = (delivery.records || []).map(publicRecord);
  const materializedEvidenceBytes = records.reduce((sum, record) => sum + record.bytes, 0);
  const materializedEvidenceChars = records.reduce((sum, record) => sum + record.chars, 0);
  const accounting = makeAccounting({
    invocations,
    toolCalls,
    responses,
    maxInvocations: maxTransportInvocations,
    maxToolCalls,
    maxBatchReads,
    readRequests,
    maxReadRequests,
    evidenceRecords,
    maxEvidenceRecords,
    maxEvidenceBytes,
    evidenceBytes,
    evidenceChars,
    materializedEvidenceBytes,
    materializedEvidenceChars,
    renderedSourceBytes: null,
    renderedSourceChars: null,
    maxSearchResults,
    searchResults,
    maxSearchBytes,
    searchBytes,
    searchPaths,
    maxSearchHydrationHits,
    maxSearchHydrationWindowLines,
    maxSearchHydrationBytes,
    searchHydrationHits,
    searchHydrationRecords,
    searchHydrationBytes,
  });
  const requestWasFailed = transportFailed || (responses.length > 0
    && responses.every((response) => response.model === null && response.usage === null)
    && workflowMissing.some((item) => String(item.reason).includes('transport failed')));
  const finalStatus = requestWasFailed ? 'failed' : (missing.length ? 'partial' : 'complete');
  const finalSelectionFailure = selectionFailureCategory || (!selectionCompleted ? 'not_submitted'
    : (!(selectedReferences || []).length ? 'empty_references'
      : (delivery.missing?.length ? 'evidence_verification_failed'
        : (selectedMissing.length ? 'model_reported_gap' : (workflowMissing.length ? 'workflow_gap' : 'none')))));
  await trace({ kind: 'selection', status: finalStatus,
    referenceCount: (selectedReferences || []).length, verifiedRecords: records.length,
    missingCount: missing.length, failureCategory: finalSelectionFailure });

  return baseResult(identity, {
    status: finalStatus,
    ...(requestWasFailed ? { errorCode: transportErrorCode || 'API_MICRO_TRANSPORT_FAILED' } : {}),
    summary: finalSummary,
    records,
    ...(reused.length ? { reused } : {}),
    missing,
    notices: workflowNotices,
    accounting,
    selection: selectionCompleted ? { references: selectedReferences || [] } : undefined,
  });
}
