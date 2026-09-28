import fs from 'node:fs';
import path from 'node:path';

const USAGE_FIELDS = {
  inputTokens: [
    ['input_tokens'],
    ['inputTokens'],
  ],
  cachedInputTokens: [
    ['cached_input_tokens'],
    ['input_tokens_details', 'cached_tokens'],
    ['inputTokensDetails', 'cachedTokens'],
  ],
  outputTokens: [
    ['output_tokens'],
    ['outputTokens'],
  ],
  reasoningOutputTokens: [
    ['reasoning_output_tokens'],
    ['output_tokens_details', 'reasoning_tokens'],
    ['outputTokensDetails', 'reasoningTokens'],
  ],
  totalTokens: [
    ['total_tokens'],
    ['totalTokens'],
  ],
};

const CONTEXT_WINDOW_ALIASES = [
  ['model_context_window'],
  ['modelContextWindow'],
  ['highest_model_context_window'],
  ['highestModelContextWindow'],
];

const ROLLOUT_COMPARISON_FIELDS = [
  'requestCount',
  'inputTokens',
  'cachedInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
  'totalTokens',
  'peakRequestInputTokens',
  'modelContextWindow',
];

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function valueAtPath(value, keys) {
  let current = value;
  for (const key of keys) {
    if (!isObject(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function readIntegerAliases(value, aliases, label, diagnostics) {
  const observed = [];
  let invalid = false;
  for (const alias of aliases) {
    const candidate = valueAtPath(value, alias);
    if (candidate === undefined) continue;
    if (!Number.isSafeInteger(candidate) || candidate < 0) {
      diagnostics.push(`${label} at ${alias.join('.')} must be a non-negative safe integer`);
      invalid = true;
      continue;
    }
    observed.push({ alias: alias.join('.'), value: candidate });
  }
  if (!observed.length) {
    diagnostics.push(`${label} is missing (${aliases.map((alias) => alias.join('.')).join(' or ')})`);
    return null;
  }
  if (observed.some((entry) => entry.value !== observed[0].value)) {
    diagnostics.push(
      `${label} has contradictory aliases (${observed.map((entry) => `${entry.alias}=${entry.value}`).join(', ')})`
    );
    return null;
  }
  return invalid ? null : observed[0].value;
}

function extractUsage(value, diagnostics) {
  if (!isObject(value)) {
    diagnostics.push('usage is missing or is not an object');
    return null;
  }

  const usage = {
    inputTokens: readIntegerAliases(value, USAGE_FIELDS.inputTokens, 'input tokens', diagnostics),
    cachedInputTokens: readIntegerAliases(value, USAGE_FIELDS.cachedInputTokens, 'cached input tokens', diagnostics),
    outputTokens: readIntegerAliases(value, USAGE_FIELDS.outputTokens, 'output tokens', diagnostics),
    reasoningOutputTokens: readIntegerAliases(
      value,
      USAGE_FIELDS.reasoningOutputTokens,
      'reasoning output tokens',
      diagnostics
    ),
    totalTokens: readIntegerAliases(value, USAGE_FIELDS.totalTokens, 'total tokens', diagnostics),
  };

  if (Object.values(usage).some((entry) => entry === null)) return null;
  if (!Number.isSafeInteger(usage.inputTokens + usage.outputTokens)
    || usage.totalTokens !== usage.inputTokens + usage.outputTokens) {
    diagnostics.push(
      `total tokens ${usage.totalTokens} do not equal input tokens ${usage.inputTokens} plus output tokens ${usage.outputTokens}`
    );
    return null;
  }
  if (usage.cachedInputTokens > usage.inputTokens) {
    diagnostics.push(`cached input tokens ${usage.cachedInputTokens} exceed input tokens ${usage.inputTokens}`);
    return null;
  }
  if (usage.reasoningOutputTokens > usage.outputTokens) {
    diagnostics.push(`reasoning output tokens ${usage.reasoningOutputTokens} exceed output tokens ${usage.outputTokens}`);
    return null;
  }
  return usage;
}

function usageKey(usage) {
  return JSON.stringify([
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.outputTokens,
    usage.reasoningOutputTokens,
    usage.totalTokens,
  ]);
}

function extractContextWindow(value) {
  if (!isObject(value)) return null;
  const observed = [];
  for (const alias of CONTEXT_WINDOW_ALIASES) {
    const candidate = valueAtPath(value, alias);
    if (candidate === undefined) continue;
    if (!Number.isSafeInteger(candidate) || candidate <= 0) return { invalid: alias.join('.') };
    observed.push(candidate);
  }
  if (!observed.length) return null;
  if (observed.some((entry) => entry !== observed[0])) {
    return { invalid: 'contradictory model context window aliases' };
  }
  return { value: observed[0] };
}

function observeContextWindow(state, values) {
  for (const value of values) {
    const observed = extractContextWindow(value);
    if (!observed) continue;
    if (observed.invalid) {
      state.diagnostics.push(`invalid model context window (${observed.invalid})`);
      continue;
    }
    state.contextWindow = state.contextWindow === null
      ? observed.value
      : Math.max(state.contextWindow, observed.value);
  }
}

function parseRolloutDocument(content, source) {
  const state = {
    source,
    events: [],
    diagnostics: [],
    contextWindow: null,
  };
  const lines = String(content).split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const lineNumber = index + 1;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      state.diagnostics.push(`${source}:${lineNumber}: malformed JSON (${error.message})`);
      continue;
    }

    if (entry?.type === 'token_usage_record') {
      const diagnostics = [];
      const payload = isObject(entry.payload) ? entry.payload : {};
      const responseId = typeof payload.response_id === 'string' && payload.response_id.trim()
        ? payload.response_id
        : null;
      if (!responseId) diagnostics.push('token_usage_record is missing payload.response_id');
      const usage = payload.usage === undefined
        ? (diagnostics.push('token_usage_record is missing payload.usage'), null)
        : extractUsage(payload.usage, diagnostics);
      observeContextWindow(state, [payload, payload.usage]);
      state.events.push({
        kind: 'primary',
        source,
        lineNumber,
        responseId,
        usage,
        key: usage ? usageKey(usage) : null,
        valid: Boolean(responseId && usage),
        diagnostics,
      });
      continue;
    }

    if (entry?.type === 'event_msg' && entry.payload?.type === 'token_count') {
      const diagnostics = [];
      const payload = isObject(entry.payload) ? entry.payload : {};
      const info = isObject(payload.info) ? payload.info : null;
      if (!info) diagnostics.push('token_count is missing payload.info');
      const responseId = typeof info?.response_id === 'string' && info.response_id.trim()
        ? info.response_id
        : (typeof payload.response_id === 'string' && payload.response_id.trim() ? payload.response_id : null);
      const lastUsage = info?.last_token_usage;
      const usage = lastUsage === undefined
        ? (diagnostics.push('token_count is missing payload.info.last_token_usage'), null)
        : extractUsage(lastUsage, diagnostics);
      observeContextWindow(state, [payload, info]);
      state.events.push({
        kind: 'fallback',
        source,
        lineNumber,
        responseId,
        usage,
        key: usage ? usageKey(usage) : null,
        valid: Boolean(usage),
        diagnostics,
      });
    }
  }

  return state;
}

function normalizedPaths(input, projectRoot) {
  const paths = Array.isArray(input) ? input : input?.paths;
  const diagnostics = [];
  if (!Array.isArray(paths) || !paths.length) {
    diagnostics.push('paths must be a non-empty array of rollout JSONL file paths');
    return { paths: [], diagnostics };
  }
  const valid = new Set();
  for (let index = 0; index < paths.length; index += 1) {
    if (typeof paths[index] !== 'string' || !paths[index].trim()) {
      diagnostics.push(`paths[${index}] must be a non-empty string`);
      continue;
    }
    const value = paths[index].trim();
    const resolved = path.isAbsolute(value) ? path.normalize(value) : path.resolve(projectRoot, value);
    valid.add(resolved);
  }
  if (!valid.size) return { paths: [], diagnostics };
  return { paths: Array.from(valid).sort(), diagnostics };
}

function aggregateDocuments(documents, initialDiagnostics = [], records = 0) {
  const warnings = [...initialDiagnostics];
  const selectedRecords = [];
  const primaryById = new Map();
  const fallbackById = new Map();
  const primaryPools = new Map();
  let duplicateRecords = 0;
  let highestModelContextWindow = null;
  let incomplete = initialDiagnostics.length > 0;

  for (const document of documents) {
    warnings.push(...document.diagnostics);
    if (document.diagnostics.length) incomplete = true;
    if (document.contextWindow !== null) {
      highestModelContextWindow = highestModelContextWindow === null
        ? document.contextWindow
        : Math.max(highestModelContextWindow, document.contextWindow);
    }
  }

  for (const document of documents) {
    for (const event of document.events.filter((entry) => entry.kind === 'primary')) {
      warnings.push(...event.diagnostics.map((message) => `${event.source}:${event.lineNumber}: ${message}`));
      if (event.diagnostics.length) incomplete = true;
      if (!event.responseId) {
        incomplete = true;
        continue;
      }

      const existing = primaryById.get(event.responseId);
      if (existing) {
        duplicateRecords += 1;
        if (!existing.valid || !event.valid || existing.key !== event.key) {
          warnings.push(
            `${event.source}:${event.lineNumber}: contradictory duplicate token_usage_record response_id ${event.responseId}`
          );
          incomplete = true;
        }
        continue;
      }

      primaryById.set(event.responseId, event);
      if (!event.valid) {
        incomplete = true;
        continue;
      }
      selectedRecords.push({
        id: event.responseId,
        source: event.source,
        lineNumber: event.lineNumber,
        usage: event.usage,
      });
      const poolKey = `${event.source}\u0000${event.key}`;
      const pool = primaryPools.get(poolKey) || [];
      pool.push(event);
      primaryPools.set(poolKey, pool);
    }
  }

  for (const document of documents) {
    for (const event of document.events.filter((entry) => entry.kind === 'fallback')) {
      warnings.push(...event.diagnostics.map((message) => `${event.source}:${event.lineNumber}: ${message}`));
      if (event.diagnostics.length) incomplete = true;
      if (!event.valid) {
        incomplete = true;
        continue;
      }

      if (event.responseId) {
        const existing = primaryById.get(event.responseId);
        if (existing) {
          if (!existing.valid || existing.key !== event.key) {
            warnings.push(
              `${event.source}:${event.lineNumber}: token_count contradicts token_usage_record response_id ${event.responseId}`
            );
            incomplete = true;
          }
          existing.paired = true;
          continue;
        }
        const priorFallback = fallbackById.get(event.responseId);
        if (priorFallback) {
          duplicateRecords += 1;
          if (priorFallback.key !== event.key) {
            warnings.push(
              `${event.source}:${event.lineNumber}: contradictory token_count response_id ${event.responseId}`
            );
            incomplete = true;
          }
          continue;
        }
        fallbackById.set(event.responseId, event);
        selectedRecords.push({
          id: event.responseId,
          source: event.source,
          lineNumber: event.lineNumber,
          usage: event.usage,
        });
        continue;
      }

      const pool = primaryPools.get(`${event.source}\u0000${event.key}`) || [];
      const match = pool.find((entry) => !entry.paired);
      if (match) {
        match.paired = true;
        continue;
      }
      selectedRecords.push({
        id: `token_count:${event.source}:${event.lineNumber}`,
        source: event.source,
        lineNumber: event.lineNumber,
        usage: event.usage,
      });
    }
  }

  if (!selectedRecords.length) {
    incomplete = true;
    warnings.push('no complete request usage records were found');
  }
  if (highestModelContextWindow === null) {
    incomplete = true;
    warnings.push('model_context_window was not observed');
  }

  let metrics = null;
  if (!incomplete) {
    metrics = {
      requestCount: selectedRecords.length,
      inputTokens: selectedRecords.reduce((sum, record) => sum + record.usage.inputTokens, 0),
      cachedInputTokens: selectedRecords.reduce((sum, record) => sum + record.usage.cachedInputTokens, 0),
      outputTokens: selectedRecords.reduce((sum, record) => sum + record.usage.outputTokens, 0),
      reasoningOutputTokens: selectedRecords.reduce((sum, record) => sum + record.usage.reasoningOutputTokens, 0),
      totalTokens: selectedRecords.reduce((sum, record) => sum + record.usage.totalTokens, 0),
      peakRequestInputTokens: selectedRecords.reduce(
        (peak, record) => Math.max(peak, record.usage.inputTokens),
        0
      ),
      modelContextWindow: highestModelContextWindow,
    };
  }

  return {
    schemaVersion: 1,
    ok: metrics !== null,
    files: documents.map((document) => document.source),
    records,
    duplicateRecords,
    incomplete,
    warnings,
    metrics,
  };
}

export function parseRolloutJsonl(content, { source = '<memory>' } = {}) {
  if (typeof content !== 'string') {
    return aggregateDocuments([], [`${source}: rollout content must be a string`], 0);
  }
  const document = parseRolloutDocument(content, source);
  return aggregateDocuments([document], [], document.events.length);
}

export function rolloutMetricsDelta(left, right) {
  if (!left?.metrics || !right?.metrics) return null;
  return Object.fromEntries(ROLLOUT_COMPARISON_FIELDS.map((field) => [
    field,
    right.metrics[field] - left.metrics[field],
  ]));
}

export function parseRolloutTelemetry(input, { projectRoot = process.cwd() } = {}) {
  const normalized = normalizedPaths(input, projectRoot);
  if (!normalized.paths.length) {
    return aggregateDocuments([], normalized.diagnostics, 0);
  }

  const documents = [];
  let records = 0;
  for (const filePath of normalized.paths) {
    try {
      const document = parseRolloutDocument(fs.readFileSync(filePath, 'utf8'), filePath);
      records += document.events.length;
      documents.push(document);
    } catch (error) {
      documents.push({
        source: filePath,
        events: [],
        diagnostics: [`${filePath}: unable to read rollout file (${error.code || error.message})`],
        contextWindow: null,
      });
    }
  }
  return aggregateDocuments(documents, normalized.diagnostics, records);
}
