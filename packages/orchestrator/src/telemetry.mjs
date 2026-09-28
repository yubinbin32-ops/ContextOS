import fs from 'node:fs';
import path from 'node:path';
import { parseRolloutTelemetry, rolloutMetricsDelta } from './rollout-telemetry.mjs';

function telemetryPath(projectRoot) {
  return path.join(projectRoot, '.contextos', 'logs', 'telemetry.jsonl');
}

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.ceil(String(text).length / 4);
}

function normalizeScope(scope) {
  return scope === 'internal' || scope === 'external' ? scope : 'all';
}

function matchesScope(entry, scope) {
  if (scope === 'internal') return entry.internal === true;
  if (scope === 'external') return entry.internal !== true;
  return true;
}

const COMPARISON_FIELDS = [
  'calls',
  'estimatedTotalTokens',
  'peakContextChars',
  'replayChars',
  'truncated',
];

const ROUTE_KINDS = [
  'discovery',
  'mutation',
  'verification',
  'closure',
  'orchestration',
  'delegation',
  'diagnostic',
  'unknown',
];

function readEntries(projectRoot) {
  const filePath = telemetryPath(projectRoot);
  if (!fs.existsSync(filePath)) return [];
  const entries = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (_) {}
  }
  return entries;
}

export function recordTelemetry(projectRoot, {
  sessionId,
  tool,
  input = {},
  output = '',
  hostUsage = null,
  internal = false,
  routeKind = 'unknown',
  artifactId = null,
  truncated = false,
  durationMs = 0,
} = {}) {
  if (!projectRoot || !tool) return null;
  const inputText = JSON.stringify(input ?? {});
  const outputText = typeof output === 'string' ? output : JSON.stringify(output ?? '');
  const internalEntry = Boolean(internal);
  const normalizedRouteKind = ROUTE_KINDS.includes(routeKind) ? routeKind : 'unknown';
  const prior = readEntries(projectRoot).filter((entry) => (
    entry.sessionId === sessionId && (entry.internal === true) === internalEntry
  ));
  const priorOutputChars = prior.reduce((sum, entry) => sum + (Number(entry.outputChars) || 0), 0);
  const actualHostTokens = Number(hostUsage?.total_tokens ?? hostUsage?.totalTokens);
  const entry = {
    at: new Date().toISOString(),
    sessionId: sessionId || null,
    tool,
    internal: internalEntry,
    routeKind: normalizedRouteKind,
    inputChars: inputText.length,
    estimatedInputTokens: estimateTokens(inputText),
    outputChars: outputText.length,
    estimatedOutputTokens: estimateTokens(outputText),
    replayChars: priorOutputChars + outputText.length,
    ...(Number.isFinite(actualHostTokens) && actualHostTokens >= 0
      ? { actualTotalTokens: Math.floor(actualHostTokens) }
      : {}),
    artifactId,
    truncated: Boolean(truncated),
    durationMs: Math.max(0, Math.round(durationMs)),
  };
  try {
    const filePath = telemetryPath(projectRoot);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) {
    return null;
  }
  return entry;
}

export function summarizeTelemetry(projectRoot, { sessionId = null, limit = 500, scope = 'all' } = {}) {
  const normalizedScope = normalizeScope(scope);
  let entries = readEntries(projectRoot);
  if (sessionId) entries = entries.filter((entry) => entry.sessionId === sessionId);
  entries = entries.filter((entry) => matchesScope(entry, normalizedScope));
  entries = entries.slice(-Math.max(1, Number(limit) || 500));

  const byTool = new Map();
  let inputChars = 0;
  let outputChars = 0;
  let replayChars = 0;
  let estimatedInputTokens = 0;
  let estimatedOutputTokens = 0;
  let peakContextChars = 0;
  let cumulativeOutputChars = 0;
  let truncated = 0;
  let actualTokens = 0;
  let actualUsageCalls = 0;
  const routeCounts = Object.fromEntries(ROUTE_KINDS.map((kind) => [kind, 0]));

  for (const entry of entries) {
    const entryInputChars = Number(entry.inputChars) || 0;
    const entryOutputChars = Number(entry.outputChars) || 0;
    inputChars += entryInputChars;
    outputChars += entryOutputChars;
    replayChars += Number(entry.replayChars) || 0;
    estimatedInputTokens += Number(entry.estimatedInputTokens) || 0;
    estimatedOutputTokens += Number(entry.estimatedOutputTokens) || 0;
    const entryActualTokens = Number(entry.actualTotalTokens);
    if (Number.isFinite(entryActualTokens) && entryActualTokens >= 0) {
      actualTokens += entryActualTokens;
      actualUsageCalls += 1;
    }
    const routeKind = ROUTE_KINDS.includes(entry.routeKind) ? entry.routeKind : 'unknown';
    routeCounts[routeKind] += 1;
    peakContextChars = Math.max(peakContextChars, cumulativeOutputChars + entryInputChars + entryOutputChars);
    cumulativeOutputChars += entryOutputChars;
    if (entry.truncated) truncated += 1;
    const aggregate = byTool.get(entry.tool) || {
      tool: entry.tool,
      calls: 0,
      inputChars: 0,
      outputChars: 0,
      estimatedTokens: 0,
      truncated: 0,
    };
    aggregate.calls += 1;
    aggregate.inputChars += Number(entry.inputChars) || 0;
    aggregate.outputChars += Number(entry.outputChars) || 0;
    aggregate.estimatedTokens += (Number(entry.estimatedInputTokens) || 0) + (Number(entry.estimatedOutputTokens) || 0);
    if (entry.truncated) aggregate.truncated += 1;
    byTool.set(entry.tool, aggregate);
  }

  return {
    sessionId,
    scope: normalizedScope,
    calls: entries.length,
    inputChars,
    outputChars,
    replayChars,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens,
    actualTokens: entries.length > 0 && actualUsageCalls === entries.length ? actualTokens : null,
    actualUsageCalls,
    routeCounts,
    peakContextChars,
    peakEstimatedContextTokens: Math.ceil(peakContextChars / 4),
    truncated,
    topContributors: Array.from(byTool.values())
      .sort((a, b) => b.estimatedTokens - a.estimatedTokens)
      .slice(0, 6),
  };
}

function comparisonMetrics(summary) {
  return Object.fromEntries(COMPARISON_FIELDS.map((field) => [field, summary[field]]));
}

export function compareTelemetry(projectRoot, {
  leftSessionId,
  rightSessionId,
  leftRolloutPath,
  rightRolloutPath,
  limit = 500,
  scope = 'external',
} = {}) {
  const missing = [];
  const hasLeftSession = typeof leftSessionId === 'string' && Boolean(leftSessionId.trim());
  const hasRightSession = typeof rightSessionId === 'string' && Boolean(rightSessionId.trim());
  const hasLeftRollout = typeof leftRolloutPath === 'string' && Boolean(leftRolloutPath.trim());
  const hasRightRollout = typeof rightRolloutPath === 'string' && Boolean(rightRolloutPath.trim());
  if (!hasLeftSession && !hasLeftRollout) missing.push('leftSessionId or leftRolloutPath');
  if (!hasRightSession && !hasRightRollout) missing.push('rightSessionId or rightRolloutPath');
  if (missing.length) {
    throw new Error(`Telemetry compare requires ${missing.join(' and ')}`);
  }

  const normalizedScope = normalizeScope(scope);
  const left = hasLeftSession
    ? comparisonMetrics(summarizeTelemetry(projectRoot, {
      sessionId: leftSessionId,
      limit,
      scope: normalizedScope,
    }))
    : null;
  const right = hasRightSession
    ? comparisonMetrics(summarizeTelemetry(projectRoot, {
      sessionId: rightSessionId,
      limit,
      scope: normalizedScope,
    }))
    : null;
  const delta = left && right
    ? Object.fromEntries(COMPARISON_FIELDS.map((field) => [field, right[field] - left[field]]))
    : null;
  const result = { left, right, delta };

  if (hasLeftRollout || hasRightRollout) {
    const leftRollout = hasLeftRollout
      ? parseRolloutTelemetry({ paths: [leftRolloutPath] }, { projectRoot })
      : null;
    const rightRollout = hasRightRollout
      ? parseRolloutTelemetry({ paths: [rightRolloutPath] }, { projectRoot })
      : null;
    result.rollout = {
      left: leftRollout,
      right: rightRollout,
      delta: rolloutMetricsDelta(leftRollout, rightRollout),
    };
  }
  return result;
}
