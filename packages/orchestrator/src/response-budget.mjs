import fs from 'node:fs';
import path from 'node:path';
import { storeArtifact } from './artifact-store.mjs';
import { enqueueMicroDelivery } from './micro-delivery.mjs';

const MICRO_REQUESTED_DELIVERIES = new Set(['immediate', 'defer', 'errors-only', 'auto']);
const MICRO_DELIVERY_OUTCOMES = new Set(['immediate', 'deferred', 'success-hidden', 'error']);

function normalizeMicroRequestedDelivery(value) {
  return MICRO_REQUESTED_DELIVERIES.has(value) ? value : 'immediate';
}

function normalizeMicroDeliveryOutcome(value) {
  return MICRO_DELIVERY_OUTCOMES.has(value) ? value : null;
}

function inferMicroDeliveryOutcome(result = {}) {
  if (!result?.ok) return 'error';
  if (MICRO_DELIVERY_OUTCOMES.has(result.delivery)) return result.delivery;
  if (result.delivery === 'defer') return 'deferred';
  if (result.delivery === 'errors-only') return 'success-hidden';
  if (result.delivery === 'auto' && result.needsHost === true) return 'deferred';
  if (result.delivery === 'auto' && result.needsHost === false) return 'success-hidden';
  return 'immediate';
}

function preloadCharCount(preload) {
  if (!preload || typeof preload !== 'object' || Array.isArray(preload)) return 0;
  const chars = Number(preload.chars);
  if (Number.isFinite(chars) && chars >= 0) return Math.floor(chars);
  return typeof preload.summary === 'string' ? preload.summary.length : 0;
}

export const RESPONSE_BUDGETS = Object.freeze({
  default: 4000,
  explore: 3000,
  // Source bodies stay in artifacts; default host output should be a slice,
  // not an accidental file dump. Callers can request full:true explicitly.
  inspect: 8000,
  work: 8000,
  change: 2500,
  verify: 5000,
  ship: 1600,
  pipeline: 2800,
  // Advanced capability calls are diagnostic plumbing, not a second transcript.
  // Keep the default small; callers that truly need the body can opt into
  // full:true and fetch the artifact explicitly.
  ops: 2000,
  micro: 1600,
});

export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.ceil(String(text).length / 4);
}

export function compactJson(value) {
  return JSON.stringify(value);
}

export function clipText(value, maxChars = RESPONSE_BUDGETS.default, { label = 'details', keepTail = false } = {}) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : Infinity;
  if (text.length <= limit) return text;

  const suffix = `\n[${label} truncated: ${text.length - limit} chars omitted; fetch the receipt/artifact for full output]`;
  if (limit <= suffix.length) {
    return text.slice(0, limit);
  }
  if (!keepTail) {
    return `${text.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
  }
  const separator = '\n...\n';
  const contentBudget = Math.max(0, limit - suffix.length - separator.length);
  const head = Math.max(0, Math.floor(contentBudget * 0.55));
  const tail = Math.max(0, contentBudget - head);
  return `${text.slice(0, head)}${separator}${text.slice(-tail)}${suffix}`;
}

export function fitResponse(text, { tool = 'default', maxChars, receiptId = null, detailRefs = [] } = {}) {
  const budget = maxChars ?? RESPONSE_BUDGETS[tool] ?? RESPONSE_BUDGETS.default;
  const output = clipText(text, budget, { label: 'response', keepTail: true });
  const meta = {
    chars: output.length,
    estimatedTokens: estimateTokens(output),
    truncated: output.length < String(text).length,
    receiptId,
    detailRefs,
  };
  return { text: output, meta };
}

export function finalizeResponse(text, {
  projectRoot,
  tool = 'default',
  maxChars,
  full = false,
  forceArtifact = false,
  artifactContent = null,
  receiptId = null,
  summary = null,
  routingHint = null,
  metadata = {},
} = {}) {
  const raw = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
  const toolBudget = RESPONSE_BUDGETS[tool] ?? RESPONSE_BUDGETS.default;
  const requested = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : toolBudget;
  // Custom budgets may tighten a response, but widening it requires the explicit
  // full escape hatch. This prevents an optimistic caller from turning an OS
  // call into an unbounded transcript copy.
  const budget = full ? Infinity : Math.min(requested, toolBudget);
  const hintText = routingHint && budget !== Infinity
    ? `\n[ContextOS route hint: ${String(routingHint).slice(0, 180)}]`
    : '';
  const contentBudget = hintText ? Math.max(0, budget - hintText.length) : budget;
  const clippedContent = clipText(raw, contentBudget, { label: 'response', keepTail: true });
  const initialClipped = `${clippedContent}${hintText}`;
  const initiallyTruncated = initialClipped.length < raw.length;
  let artifact = null;

  if ((initiallyTruncated || forceArtifact) && projectRoot) {
    artifact = storeArtifact(projectRoot, artifactContent ?? raw, {
      kind: `response:${tool}`,
      metadata: {
        tool,
        receiptId,
        summary,
        ...metadata,
      },
    });
  }

  const suffix = artifact
    ? `\n<!-- os-response tool=${tool} artifact=${artifact.id} fullChars=${raw.length} -->`
    : '';
  // The artifact locator is part of the host response. Reserve its space
  // after the id is known so bookkeeping cannot make a bounded response grow
  // past its declared budget.
  const finalContentBudget = artifact && budget !== Infinity
    ? Math.max(0, budget - suffix.length)
    : contentBudget;
  const finalContent = clipText(raw, finalContentBudget, { label: 'response', keepTail: true });
  const clipped = `${finalContent}${hintText}`;
  const finalText = `${clipped}${suffix}`;
  const meta = {
    chars: finalText.length,
    estimatedTokens: estimateTokens(finalText),
    fullChars: raw.length,
    truncated: finalText.length < raw.length,
    forcedArtifact: Boolean(forceArtifact && artifact),
    receiptId,
    artifactId: artifact?.id || null,
  };
  return { text: finalText, meta };
}

export function renderCompact(value, { projectRoot, tool = 'ops', maxChars, full = false, metadata = {} } = {}) {
  const raw = typeof value === 'string' ? value : compactJson(value);
  return finalizeResponse(raw, { projectRoot, tool, maxChars, full, metadata });
}

export function summarizeCommandReceipt(receipt = {}, { includeDiagnostics = false, maxDiagnostics = 2 } = {}) {
  const ok = Number(receipt.exitCode) === 0;
  const summary = {
    ok,
    exitCode: receipt.exitCode,
    durationMs: receipt.durationMs,
    receiptId: receipt.id || null,
  };
  if (receipt.summary) summary.summary = receipt.summary;
  if (receipt.distinctFiles?.length) summary.files = receipt.distinctFiles.slice(0, 8);
  if (receipt.logHandle) summary.log = receipt.logHandle;
  if (!ok && includeDiagnostics) {
    const diagnostics = Array.isArray(receipt.diagnostics) && receipt.diagnostics.length
      ? receipt.diagnostics
      : (Array.isArray(receipt.errors) ? receipt.errors : []);
    if (diagnostics.length) summary.diagnostics = diagnostics.slice(0, maxDiagnostics);
  }
  return summary;
}

export function summarizeActionResult(output, { maxChars = 900, includeDiagnostics = false } = {}) {
  if (output == null) return '';
  if (typeof output === 'object') {
    if (output.text && typeof output.text === 'string') return clipText(output.text, maxChars, { label: 'action output' });
    if (output.summary && typeof output.summary === 'string') return clipText(output.summary, maxChars, { label: 'action summary' });
    return clipText(compactJson(output), maxChars, { label: 'action output' });
  }

  const text = String(output);
  if (text.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if ('exitCode' in parsed && ('summary' in parsed || 'text' in parsed)) {
        return clipText(compactJson(summarizeCommandReceipt(parsed, { includeDiagnostics })), maxChars, { label: 'action output' });
      }
      if (typeof parsed?.ok === 'boolean') {
        const detail = [parsed.content, parsed.error, parsed.summary]
          .find((value) => typeof value === 'string' && value.trim());
        if (detail) {
          const receipt = parsed.receiptId ? ` receipt=${parsed.receiptId}` : '';
          const providerTokens = Number(parsed.providerUsage?.total_tokens);
          const usage = Number.isFinite(providerTokens) && providerTokens > 0
            ? ` providerTokens=${providerTokens}`
            : '';
          return clipText(`${parsed.ok ? 'OK' : 'FAIL'}: ${detail}${receipt}${usage}`, maxChars, { label: 'action output' });
        }
      }
    } catch (_) {
      // Fall through to textual clipping.
    }
  }
  return clipText(text, maxChars, { label: 'action output' });
}

export function recordMicroUsage(projectRoot, result, receiptId, {
  hostSessionId = null,
  requestedDelivery = null,
  deliveryOutcome = null,
  okOverride = null,
} = {}) {
  if (!projectRoot || !result || typeof result !== 'object') return null;
  const usage = result.providerUsage || {};
  const estimatedUsage = result.estimatedUsage || {};
  const cost = result.cost || {};
  const budget = result.budget || {};
  const preload = result.preload && typeof result.preload === 'object' && !Array.isArray(result.preload)
    ? result.preload
    : null;
  const invocation = result.invocation && typeof result.invocation === 'object'
    ? result.invocation
    : {};
  const toolCallCount = Array.isArray(result.toolCalls) ? result.toolCalls.length : 0;
  const toolRounds = Number(invocation.toolRounds ?? result.steps) || 0;
  const executionMode = result.executionMode
    || (!result.withOS
      ? 'summarizer-only'
      : (toolCallCount > 0 ? 'executor' : 'executor-idle'));
  const entry = {
    at: new Date().toISOString(),
    receiptId: receiptId || result.receiptId || null,
    ok: okOverride === null ? Boolean(result.ok) : Boolean(okOverride),
    requestedDelivery: normalizeMicroRequestedDelivery(requestedDelivery ?? result.requestedDelivery ?? result.delivery),
    deliveryOutcome: normalizeMicroDeliveryOutcome(deliveryOutcome)
      || normalizeMicroDeliveryOutcome(result.deliveryOutcome)
      || inferMicroDeliveryOutcome(result),
    statusCode: Number.isFinite(Number(result.statusCode)) ? Number(result.statusCode) : null,
    preset: result.preset || null,
    model: result.model || null,
    providerHost: result.providerHost || null,
    inputSource: result.inputSource || null,
    inputTruncated: Boolean(result.inputTruncated),
    withOS: Boolean(result.withOS),
    preload: Boolean(preload),
    preloadAttached: Boolean(preload),
    preloadStatus: preload?.status || null,
    preloadArtifactId: preload?.artifactId || null,
    preloadChars: preloadCharCount(preload),
    preloadCacheHit: Boolean(preload?.cacheHit || invocation.evidenceCacheHit),
    pipelineRuns: Number(invocation.pipelineRuns ?? preload?.pipelineRuns) || 0,
    sessionId: result.sessionId || null,
    sessionMode: result.sessionMode || null,
    batch: Boolean(result.batch),
    steps: Number(result.steps) || 0,
    executionMode,
    summarizerOnly: executionMode === 'summarizer-only',
    hostTurnsSaved: Number(result.hostTurnsSaved ?? toolRounds) || 0,
    toolCallCount,
    toolNames: Array.isArray(result.toolCalls) ? result.toolCalls.map((call) => call.name).filter(Boolean) : [],
    durationMs: Number(result.durationMs) || 0,
    usageSource: result.usageSource || (result.providerUsage ? 'provider' : 'unavailable'),
    providerUsageCalls: Number(result.providerUsageCalls) || 0,
    estimatedUsageCalls: Number(result.estimatedUsageCalls) || 0,
    deduplicatedToolCallCount: Number(result.deduplicatedToolCallCount) || 0,
    providerRequests: Number(result.providerRequests ?? invocation.providerRequests)
      || (Number(result.providerUsageCalls) || 0) + (Number(result.estimatedUsageCalls) || 0),
    toolRounds,
    shortCircuited: Boolean(invocation.shortCircuited),
    shortCircuitReason: invocation.shortCircuitReason || null,
    promptTokens: result.providerUsage ? Number(usage.prompt_tokens) || 0 : null,
    completionTokens: result.providerUsage ? Number(usage.completion_tokens) || 0 : null,
    totalTokens: result.providerUsage ? Number(usage.total_tokens) || 0 : null,
    estimatedPromptTokens: result.estimatedUsage ? Number(estimatedUsage.prompt_tokens) || 0 : null,
    estimatedCompletionTokens: result.estimatedUsage ? Number(estimatedUsage.completion_tokens) || 0 : null,
    estimatedTotalTokens: result.estimatedUsage ? Number(estimatedUsage.total_tokens) || 0 : null,
    hostSessionId: hostSessionId || result.hostSessionId || null,
    estimatedCostUsd: Number(cost.estimatedUsd) || 0,
    maxProviderTokens: Number(budget.maxProviderTokens) || null,
    maxCostUsd: Number(budget.maxCostUsd) || null,
    budgetExceeded: result.budgetExceeded || null,
  };
  const filePath = path.join(projectRoot, '.contextos', 'logs', 'micro-usage.jsonl');
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
    if (fs.statSync(filePath).size > 2_000_000) {
      const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(filePath, `${lines.slice(-5000).join('\n')}\n`, 'utf8');
    }
  } catch (_) {
    return null;
  }
  return entry;
}

export function summarizeMicroUsage(projectRoot, { limit = 500, hostSessionId = null } = {}) {
  const filePath = path.join(projectRoot, '.contextos', 'logs', 'micro-usage.jsonl');
  let entries = [];
  try {
    entries = fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (_) {
    entries = [];
  }
  if (hostSessionId) entries = entries.filter((entry) => entry.hostSessionId === hostSessionId);
  entries = entries.slice(-Math.max(1, Number(limit) || 500));
  const byPreset = new Map();
  const byModel = new Map();
  const deliveryOutcomes = {
    immediate: 0,
    deferred: 0,
    'success-hidden': 0,
    error: 0,
  };
  const totals = {
    calls: entries.length,
    ok: 0,
    failed: 0,
    withOSCalls: 0,
    executorCalls: 0,
    executorIdleCalls: 0,
    summarizerOnlyCalls: 0,
    hostTurnsSaved: 0,
    preloadCalls: 0,
    preloadChars: 0,
    preloadCacheHits: 0,
    pipelineRuns: 0,
    batchCalls: 0,
    persistentSessionCalls: 0,
    toolCallCount: 0,
    steps: 0,
    providerUsageCalls: 0,
    estimatedUsageCalls: 0,
    deduplicatedToolCallCount: 0,
    providerRequests: 0,
    toolRounds: 0,
    shortCircuitedCalls: 0,
    providerUsageEntries: 0,
    estimatedUsageEntries: 0,
    mixedUsageEntries: 0,
    usageUnavailableCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedPromptTokens: 0,
    estimatedCompletionTokens: 0,
    estimatedTotalTokens: 0,
    estimatedCostUsd: 0,
    durationMs: 0,
  };
  for (const entry of entries) {
    const deliveryOutcome = normalizeMicroDeliveryOutcome(entry.deliveryOutcome);
    if (deliveryOutcome) deliveryOutcomes[deliveryOutcome] += 1;
    if (entry.ok) totals.ok += 1;
    else totals.failed += 1;
    if (entry.withOS) totals.withOSCalls += 1;
    if (entry.executionMode === 'executor') totals.executorCalls += 1;
    else if (entry.executionMode === 'executor-idle') totals.executorIdleCalls += 1;
    else if (entry.executionMode === 'summarizer-only' || entry.summarizerOnly) totals.summarizerOnlyCalls += 1;
    totals.hostTurnsSaved += Number(entry.hostTurnsSaved) || 0;
    if (entry.preloadAttached ?? entry.preload) totals.preloadCalls += 1;
    totals.preloadChars += Number(entry.preloadChars) || 0;
    if (entry.preloadCacheHit) totals.preloadCacheHits += 1;
    totals.pipelineRuns += Number(entry.pipelineRuns) || 0;
    if (entry.batch) totals.batchCalls += 1;
    if (entry.sessionMode === 'persistent') totals.persistentSessionCalls += 1;
    totals.toolCallCount += Number(entry.toolCallCount) || 0;
    totals.steps += Number(entry.steps) || 0;
    const hasProviderUsage = entry.usageSource === 'provider' || entry.usageSource === 'mixed';
    const hasEstimatedUsage = entry.usageSource === 'estimated' || entry.usageSource === 'mixed';
    if (hasProviderUsage && hasEstimatedUsage) totals.mixedUsageEntries += 1;
    else if (hasProviderUsage) totals.providerUsageEntries += 1;
    else if (hasEstimatedUsage) totals.estimatedUsageEntries += 1;
    totals.providerUsageCalls += Number(entry.providerUsageCalls) || 0;
    totals.estimatedUsageCalls += Number(entry.estimatedUsageCalls) || 0;
    totals.deduplicatedToolCallCount += Number(entry.deduplicatedToolCallCount) || 0;
    totals.providerRequests += Number(entry.providerRequests) || 0;
    totals.toolRounds += Number(entry.toolRounds) || 0;
    if (entry.shortCircuited) totals.shortCircuitedCalls += 1;
    if (hasProviderUsage) {
      totals.promptTokens += Number(entry.promptTokens) || 0;
      totals.completionTokens += Number(entry.completionTokens) || 0;
      totals.totalTokens += Number(entry.totalTokens) || 0;
    }
    if (hasEstimatedUsage) {
      totals.estimatedPromptTokens += Number(entry.estimatedPromptTokens) || 0;
      totals.estimatedCompletionTokens += Number(entry.estimatedCompletionTokens) || 0;
      totals.estimatedTotalTokens += Number(entry.estimatedTotalTokens) || 0;
    }
    if (!hasProviderUsage && !hasEstimatedUsage) totals.usageUnavailableCalls += 1;
    totals.estimatedCostUsd += Number(entry.estimatedCostUsd) || 0;
    totals.durationMs += Number(entry.durationMs) || 0;
    const presetKey = entry.preset || 'custom';
    const modelKey = entry.model || 'unknown';
    const preset = byPreset.get(presetKey) || { preset: presetKey, calls: 0, totalTokens: 0 };
    preset.calls += 1;
    preset.totalTokens += Number(entry.totalTokens) || 0;
    byPreset.set(presetKey, preset);
    const model = byModel.get(modelKey) || { model: modelKey, calls: 0, totalTokens: 0 };
    model.calls += 1;
    model.totalTokens += Number(entry.totalTokens) || 0;
    byModel.set(modelKey, model);
  }
  return {
    ...totals,
    deliveryOutcomes,
    byPreset: [...byPreset.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    byModel: [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens),
  };
}

export function persistMicroArtifact(projectRoot, result, {
  recordUsage = true,
  hostSessionId = null,
  requestedDelivery = null,
  deliveryOutcome = null,
  okOverride = null,
} = {}) {
  if (!projectRoot || !result || typeof result !== 'object') return { receiptId: null, artifactId: null };
  const receiptId = result.receiptId || `micro-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (recordUsage) {
    recordMicroUsage(projectRoot, result, receiptId, { hostSessionId, requestedDelivery, deliveryOutcome, okOverride });
  }
  const artifactId = `micro-${receiptId}`;
  const logDir = path.join(projectRoot, '.contextos', 'logs');
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const detail = JSON.stringify({ ...result, receiptId }, null, 2) + '\n';
    fs.writeFileSync(path.join(logDir, `${receiptId}.log`), detail, 'utf8');
    storeArtifact(projectRoot, detail, {
      id: artifactId,
      kind: 'micro-result',
      metadata: { receiptId, preset: result.preset || null },
    });
  } catch (_) {
    return { receiptId, artifactId: null };
  }
  return { receiptId, artifactId };
}

function projectProviderUsage(result) {
  const project = (usage) => usage && typeof usage === 'object'
    ? {
        promptTokens: Number(usage.prompt_tokens) || 0,
        completionTokens: Number(usage.completion_tokens) || 0,
        totalTokens: Number(usage.total_tokens) || 0,
      }
    : null;
  const invocation = result?.invocation && typeof result.invocation === 'object'
    ? result.invocation
    : {};
  return {
    usageSource: result?.usageSource || 'unavailable',
    providerUsage: project(result?.providerUsage),
    estimatedUsage: project(result?.estimatedUsage),
    providerUsageCalls: Number(result?.providerUsageCalls) || 0,
    estimatedUsageCalls: Number(result?.estimatedUsageCalls) || 0,
    providerRequests: Number(result?.providerRequests ?? invocation.providerRequests)
      || (Number(result?.providerUsageCalls) || 0) + (Number(result?.estimatedUsageCalls) || 0),
    invocation: {
      evidenceMode: invocation.evidenceMode || (result?.preload ? 'pipeline' : 'none'),
      evidenceCacheHit: Boolean(invocation.evidenceCacheHit || result?.preload?.cacheHit),
      pipelineRuns: Number(invocation.pipelineRuns ?? result?.preload?.pipelineRuns) || 0,
      executionMode: result?.executionMode || invocation.executionMode || null,
      allowCommands: Boolean(invocation.allowCommands),
      providerRequests: Number(invocation.providerRequests ?? result?.providerRequests)
        || (Number(result?.providerUsageCalls) || 0) + (Number(result?.estimatedUsageCalls) || 0),
      toolRounds: Number(invocation.toolRounds ?? result?.steps) || 0,
      shortCircuited: Boolean(invocation.shortCircuited),
      ...(invocation.shortCircuitReason ? { shortCircuitReason: invocation.shortCircuitReason } : {}),
    },
  };
}

function graphToolCalls(result) {
  return (Array.isArray(result?.toolCalls) ? result.toolCalls : [])
    .filter((call) => ['block', 'chain'].includes(call?.name))
    .map((call) => {
      let args = {};
      let output = {};
      try { args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : (call.arguments || {}); } catch (_) {}
      try { output = typeof call.preview === 'string' ? JSON.parse(call.preview) : (call.preview || {}); } catch (_) {}
      const isMutation = (call.name === 'block' && args.action === 'bind_auto')
        || (call.name === 'chain' && args.action === 'compose');
      return { call, args, output, isMutation, error: call.error || output?.error || (call.ok === false ? 'OS reported failure' : null) };
    })
}

export function projectMicroResult(result, { projectRoot, hostSessionId = null, full = false, maxChars = RESPONSE_BUDGETS.micro } = {}) {
  const requestedDelivery = normalizeMicroRequestedDelivery(result?.requestedDelivery ?? result?.delivery);
  const effectiveHostSessionId = hostSessionId || result?.hostSessionId || null;
  const persisted = persistMicroArtifact(projectRoot, result, { recordUsage: false, hostSessionId: effectiveHostSessionId });
  const { receiptId, artifactId } = persisted || {};
  const recordOutcome = (deliveryOutcome, okOverride = deliveryOutcome !== 'error') => {
    recordMicroUsage(projectRoot, result, receiptId, {
      hostSessionId: effectiveHostSessionId,
      requestedDelivery,
      deliveryOutcome,
      okOverride,
    });
  };
  if (!result?.ok) {
    const projected = {
      ok: false,
      receiptId,
      artifactId,
      ...projectProviderUsage(result),
      error: clipText(result?.error || 'Micro task failed', maxChars, { label: 'micro error' }),
      ...(result?.budgetExceeded ? { budgetExceeded: result.budgetExceeded } : {}),
    };
    recordOutcome('error', false);
    return projected;
  }

  let delivery = requestedDelivery;
  let deliveryFallback;
  if (delivery === 'auto') {
    if (typeof result.needsHost === 'boolean') delivery = result.needsHost ? 'defer' : 'errors-only';
    else {
      delivery = 'immediate';
      deliveryFallback = 'Micro did not provide needsHost; returned its answer to avoid losing it.';
    }
  }

  // Evidence results are JSON internally, but returning that JSON as `content`
  // and then returning its parsed fields duplicates the same payload to the host.
  const evidenceAnswer = result.preset === 'evidence' && typeof result.structured?.answer === 'string'
    ? result.structured.answer.trim()
    : '';
  const content = evidenceAnswer || (result.content || '');

  if (requestedDelivery === 'errors-only') {
    const graphCalls = graphToolCalls(result);
    const failedCall = graphCalls.find((entry) => entry.error || entry.output?.ok === false);
    if (failedCall) {
      const projected = {
        ok: false,
        delivery: 'error',
        receiptId,
        artifactId,
        ...projectProviderUsage(result),
        error: clipText(`Micro ${failedCall.call.name} ${failedCall.args.action} failed: ${failedCall.error || 'OS reported failure'}`, maxChars, { label: 'micro error' }),
      };
      recordOutcome('error', false);
      return projected;
    }
    if (!graphCalls.some((entry) => entry.isMutation)) {
      const projected = {
        ok: false,
        delivery: 'error',
        receiptId,
        artifactId,
        ...projectProviderUsage(result),
        error: `errors-only requires at least one curated Block bind or additive Chain composition.${artifactId ? ` Micro result is available in artifact ${artifactId}.` : ' No result artifact could be persisted.'}`,
        ...(!artifactId && content ? { content: clipText(content, maxChars, { label: 'micro answer', keepTail: false }) } : {}),
      };
      recordOutcome('error', false);
      return projected;
    }
  }

  if (delivery === 'defer') {
    try {
      const deferredContent = result.preset === 'evidence' && evidenceAnswer
        ? compactJson({
            answer: evidenceAnswer,
            evidenceRefs: (Array.isArray(result.evidenceRefs) ? result.evidenceRefs : []).slice(0, 5),
            ...(result.confidence ? { confidence: result.confidence } : {}),
            ...(Array.isArray(result.unknowns) && result.unknowns.length ? { unknowns: result.unknowns.slice(0, 5) } : {}),
            ...(result.hostReason ? { hostReason: result.hostReason } : {}),
          })
        : content;
      const queued = enqueueMicroDelivery(projectRoot, {
        deliveryId: receiptId,
        receiptId,
        artifactId,
        sessionId: result.sessionId || null,
        content: deferredContent,
      });
      const projected = {
        ok: true,
        delivery: 'deferred',
        receiptId,
        artifactId,
        queuedDeliveryId: queued.deliveryId,
        chars: deferredContent.length,
        ...projectProviderUsage(result),
        ...(queued.duplicate ? { duplicate: true } : {}),
        ...(queued.delivered ? { delivered: true } : {}),
      };
      recordOutcome('deferred', true);
      return projected;
    } catch (error) {
      delivery = 'immediate';
      deliveryFallback = `Could not queue Micro result (${error.message}); returned it immediately.`;
    }
  }

  if (delivery === 'errors-only') {
    const projected = {
      ok: true,
      delivery: 'success-hidden',
      receiptId,
      artifactId,
      chars: content.length,
      ...(requestedDelivery === 'auto' ? { needsHost: false } : {}),
      ...projectProviderUsage(result),
    };
    recordOutcome('success-hidden', true);
    return projected;
  }

  if (full) {
    const projected = {
      ...result,
      content: result.content || '',
      receiptId,
      artifactId,
      delivery: 'immediate',
      ...(deliveryFallback ? { deliveryFallback } : {}),
    };
    recordOutcome('immediate', true);
    return projected;
  }
  const projected = clipText(content, maxChars, { label: 'micro answer', keepTail: false });
  const response = {
    ok: true,
    delivery: 'immediate',
    receiptId,
    artifactId,
    chars: content.length,
    truncated: projected.length < content.length,
    content: projected,
    ...(deliveryFallback ? { deliveryFallback } : {}),
    ...(requestedDelivery === 'auto' && result.needsHost === true ? { needsHost: true } : {}),
    ...projectProviderUsage(result),
    ...(Array.isArray(result.evidenceRefs) && result.evidenceRefs.length
      ? { evidenceRefs: result.evidenceRefs.slice(0, 5) }
      : {}),
    ...(result.confidence ? { confidence: result.confidence } : {}),
    ...(Array.isArray(result.unknowns) && result.unknowns.length
      ? { unknowns: result.unknowns.slice(0, 5) }
      : {}),
  };
  recordOutcome('immediate', true);
  return response;
}
