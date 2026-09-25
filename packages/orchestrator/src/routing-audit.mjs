import { summarizeMicroUsage } from './response-budget.mjs';
import { summarizeTelemetry } from './telemetry.mjs';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

function requiredId(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Telemetry audit requires ${name}; call session.status first and pass args.${name}`);
  }
  return value.trim();
}

function boundedLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(number)));
}

function deliveryOutcomes(summary) {
  return {
    immediate: Number(summary.deliveryOutcomes?.immediate) || 0,
    deferred: Number(summary.deliveryOutcomes?.deferred) || 0,
    'success-hidden': Number(summary.deliveryOutcomes?.['success-hidden']) || 0,
    error: Number(summary.deliveryOutcomes?.error) || 0,
  };
}

function hostSnapshot(summary) {
  const calls = Number(summary.calls) || 0;
  return {
    calls,
    estimatedTokens: Number(summary.estimatedTotalTokens) || 0,
    peakContextChars: Number(summary.peakContextChars) || 0,
    peakEstimatedContextTokens: Number(summary.peakEstimatedContextTokens) || 0,
    replayChars: Number(summary.replayChars) || 0,
    actualTokens: calls === 0
      ? 0
      : (summary.actualTokens === null ? null : Number(summary.actualTokens) || 0),
    actualUsageCalls: Number(summary.actualUsageCalls) || 0,
    routeCounts: summary.routeCounts || {},
  };
}

function routingWarnings(snapshot) {
  const warnings = [];
  const counts = snapshot.host.routeCounts || {};
  const discoveryCalls = Number(counts.discovery) || 0;
  const mutationCalls = Number(counts.mutation) || 0;
  const closureCalls = Number(counts.closure) || 0;
  if (snapshot.host.calls >= 6 && discoveryCalls >= 5 && mutationCalls === 0 && closureCalls === 0) {
    warnings.push('discovery fan-out: batch known reads/searches into one work or Pipeline call before another host turn');
  }
  if (snapshot.host.calls > 0 && snapshot.internal.calls > Math.max(3, snapshot.host.calls * 4)) {
    warnings.push('internal Pipeline fan-out is high; narrow steps and avoid repeating the same artifact/read');
  }
  if ((snapshot.micro.deliveryOutcomes?.error || 0) > 0) {
    warnings.push('Micro delivery errors are present; do not retry the same oversized route without narrowing it');
  }
  return warnings;
}

function microSnapshot(summary, sessionId) {
  const calls = Number(summary.calls) || 0;
  const providerUsageCalls = Number(summary.providerUsageCalls) || 0;
  const estimatedUsageCalls = Number(summary.estimatedUsageCalls) || 0;
  const providerUsageEntries = Number(summary.providerUsageEntries) || 0;
  const estimatedUsageEntries = Number(summary.estimatedUsageEntries) || 0;
  const mixedUsageEntries = Number(summary.mixedUsageEntries) || 0;
  const unavailableCalls = Number(summary.usageUnavailableCalls) || 0;
  const actualComplete = calls > 0
    && providerUsageEntries === calls
    && estimatedUsageEntries === 0
    && mixedUsageEntries === 0
    && unavailableCalls === 0;
  const estimatedComplete = calls > 0
    && estimatedUsageEntries === calls
    && providerUsageEntries === 0
    && mixedUsageEntries === 0
    && unavailableCalls === 0;
  const providerUsage = calls === 0
    ? 'none'
    : actualComplete
      ? 'actual'
      : providerUsageCalls > 0
        ? 'partial'
        : estimatedComplete
          ? 'estimated'
          : 'unavailable';
  return {
    sessionId,
    calls,
    providerActualTokens: calls === 0 ? 0 : (actualComplete ? Number(summary.totalTokens) || 0 : null),
    estimatedProviderTokens: calls === 0 ? 0 : (estimatedComplete ? Number(summary.estimatedTotalTokens) || 0 : null),
    providerUsage,
    providerUsageCalls,
    estimatedUsageCalls,
    deduplicatedToolCallCount: Number(summary.deduplicatedToolCallCount) || 0,
    providerRequests: Number(summary.providerRequests) || 0,
    pipelineRuns: Number(summary.pipelineRuns) || 0,
    preloadCacheHits: Number(summary.preloadCacheHits) || 0,
    toolRounds: Number(summary.toolRounds) || 0,
    shortCircuitedCalls: Number(summary.shortCircuitedCalls) || 0,
    providerUsageEntries,
    estimatedUsageEntries,
    mixedUsageEntries,
    usageUnavailableCalls: unavailableCalls,
    preloadChars: Number(summary.preloadChars) || 0,
    deliveryOutcomes: deliveryOutcomes(summary),
  };
}

function snapshot(projectRoot, sessionId, limit) {
  const host = hostSnapshot(summarizeTelemetry(projectRoot, {
    sessionId,
    limit,
    scope: 'external',
  }));
  const internal = hostSnapshot(summarizeTelemetry(projectRoot, {
    sessionId,
    limit,
    scope: 'internal',
  }));
  const micro = microSnapshot(
    summarizeMicroUsage(projectRoot, { hostSessionId: sessionId, limit }),
    sessionId
  );
  return { sessionId, host, internal, micro };
}

function deltaNumber(right, left) {
  return right === null || left === null ? null : right - left;
}

function deltaDelivery(right, left) {
  return Object.fromEntries(Object.keys(right).map((key) => [key, right[key] - left[key]]));
}

function deltaSnapshot(right, left) {
  return {
    host: {
      calls: right.host.calls - left.host.calls,
      estimatedTokens: right.host.estimatedTokens - left.host.estimatedTokens,
      peakContextChars: right.host.peakContextChars - left.host.peakContextChars,
      peakEstimatedContextTokens: right.host.peakEstimatedContextTokens - left.host.peakEstimatedContextTokens,
      replayChars: right.host.replayChars - left.host.replayChars,
      actualTokens: deltaNumber(right.host.actualTokens, left.host.actualTokens),
    },
    internal: {
      calls: right.internal.calls - left.internal.calls,
      estimatedTokens: right.internal.estimatedTokens - left.internal.estimatedTokens,
      peakContextChars: right.internal.peakContextChars - left.internal.peakContextChars,
      peakEstimatedContextTokens: right.internal.peakEstimatedContextTokens - left.internal.peakEstimatedContextTokens,
      replayChars: right.internal.replayChars - left.internal.replayChars,
      actualTokens: deltaNumber(right.internal.actualTokens, left.internal.actualTokens),
    },
    micro: {
      calls: right.micro.calls - left.micro.calls,
      providerActualTokens: deltaNumber(right.micro.providerActualTokens, left.micro.providerActualTokens),
      estimatedProviderTokens: deltaNumber(right.micro.estimatedProviderTokens, left.micro.estimatedProviderTokens),
      deduplicatedToolCallCount: right.micro.deduplicatedToolCallCount - left.micro.deduplicatedToolCallCount,
      providerRequests: right.micro.providerRequests - left.micro.providerRequests,
      pipelineRuns: right.micro.pipelineRuns - left.micro.pipelineRuns,
      preloadCacheHits: right.micro.preloadCacheHits - left.micro.preloadCacheHits,
      toolRounds: right.micro.toolRounds - left.micro.toolRounds,
      shortCircuitedCalls: right.micro.shortCircuitedCalls - left.micro.shortCircuitedCalls,
      deliveryOutcomes: deltaDelivery(right.micro.deliveryOutcomes, left.micro.deliveryOutcomes),
    },
  };
}

function totalTokens(snapshot, hostField, microField) {
  const host = snapshot.host[hostField];
  const micro = snapshot.micro[microField];
  return host === null || micro === null ? null : host + micro;
}

function percent(saved, baseline) {
  if (saved === null || baseline === null || baseline <= 0) return null;
  return Number(((saved / baseline) * 100).toFixed(2));
}

function savings(baseline, right) {
  const hostComparable = baseline.host.calls > 0 && right.host.calls > 0;
  const baselineActual = hostComparable
    ? totalTokens(baseline, 'actualTokens', 'providerActualTokens')
    : null;
  const rightActual = hostComparable
    ? totalTokens(right, 'actualTokens', 'providerActualTokens')
    : null;
  const baselineEstimated = hostComparable
    ? totalTokens(baseline, 'estimatedTokens', 'estimatedProviderTokens')
    : null;
  const rightEstimated = hostComparable
    ? totalTokens(right, 'estimatedTokens', 'estimatedProviderTokens')
    : null;
  const actualTokens = baselineActual === null || rightActual === null ? null : baselineActual - rightActual;
  const estimatedTokens = baselineEstimated === null || rightEstimated === null ? null : baselineEstimated - rightEstimated;
  return {
    actualTokens,
    actualPercent: percent(actualTokens, baselineActual),
    estimatedTokens,
    estimatedPercent: percent(estimatedTokens, baselineEstimated),
  };
}

function evidenceQuality(snapshot, baseline, result) {
  const hostTokens = snapshot.host.calls === 0
    ? 'none'
    : snapshot.host.actualTokens === null
      ? (snapshot.host.actualUsageCalls > 0 ? 'partial' : 'estimated')
      : 'actual';
  let savingsQuality = 'unavailable';
  if (baseline) {
    if (result.savings.actualPercent !== null) savingsQuality = 'actual';
    else if (result.savings.estimatedPercent !== null) savingsQuality = 'proxy';
  }
  return {
    hostTokens,
    providerTokens: snapshot.micro.providerUsage,
    savings: savingsQuality,
  };
}

/**
 * Compare one OS routing session with an optional baseline without returning
 * raw logs, source bodies, provider prompts, or Micro answers.
 */
export function auditRouting(projectRoot, { sessionId, baselineSessionId = null, limit = DEFAULT_LIMIT } = {}) {
  const rightId = requiredId(sessionId, 'sessionId');
  const baselineId = baselineSessionId == null ? null : requiredId(baselineSessionId, 'baselineSessionId');
  const bounded = boundedLimit(limit);
  const right = snapshot(projectRoot, rightId, bounded);
  const baseline = baselineId ? snapshot(projectRoot, baselineId, bounded) : null;
  const result = {
    sessionId: rightId,
    host: right.host,
    internal: right.internal,
    micro: right.micro,
    warnings: routingWarnings(right),
    savings: baseline
      ? savings(baseline, right)
      : { actualTokens: null, actualPercent: null, estimatedTokens: null, estimatedPercent: null },
  };
  result.evidenceQuality = evidenceQuality(right, baseline, result);
  if (baseline) {
    result.baseline = baseline;
    result.delta = deltaSnapshot(right, baseline);
  }
  return result;
}

export const summarizeRoutingAudit = auditRouting;
