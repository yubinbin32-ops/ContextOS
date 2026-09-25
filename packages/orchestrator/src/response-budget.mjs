import fs from 'node:fs';
import path from 'node:path';
import { storeArtifact } from './artifact-store.mjs';

export const RESPONSE_BUDGETS = Object.freeze({
  default: 4000,
  explore: 3000,
  inspect: 12000,
  work: 16000,
  change: 2500,
  verify: 5000,
  ship: 1600,
  pipeline: 4000,
  ops: 5000,
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
  metadata = {},
} = {}) {
  const raw = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
  const toolBudget = RESPONSE_BUDGETS[tool] ?? RESPONSE_BUDGETS.default;
  const requested = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : toolBudget;
  // Custom budgets may tighten a response, but widening it requires the explicit
  // full escape hatch. This prevents an optimistic caller from turning an OS
  // call into an unbounded transcript copy.
  const budget = full ? Infinity : Math.min(requested, toolBudget);
  const clipped = clipText(raw, budget, { label: 'response', keepTail: true });
  const truncated = clipped.length < raw.length;
  let artifact = null;

  if ((truncated || forceArtifact) && projectRoot) {
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

  const meta = {
    chars: clipped.length,
    estimatedTokens: estimateTokens(clipped),
    fullChars: raw.length,
    truncated,
    forcedArtifact: Boolean(forceArtifact && artifact),
    receiptId,
    artifactId: artifact?.id || null,
  };
  const suffix = artifact
    ? `\n<!-- os-response tool=${tool} artifact=${artifact.id} fullChars=${raw.length} -->`
    : '';
  return { text: `${clipped}${suffix}`, meta };
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
    } catch (_) {
      // Fall through to textual clipping.
    }
  }
  return clipText(text, maxChars, { label: 'action output' });
}

export function recordMicroUsage(projectRoot, result, receiptId) {
  if (!projectRoot || !result || typeof result !== 'object') return null;
  const usage = result.usage || {};
  const cost = result.cost || {};
  const budget = result.budget || {};
  const entry = {
    at: new Date().toISOString(),
    receiptId: receiptId || result.receiptId || null,
    ok: Boolean(result.ok),
    statusCode: Number.isFinite(Number(result.statusCode)) ? Number(result.statusCode) : null,
    preset: result.preset || null,
    model: result.model || null,
    providerHost: result.providerHost || null,
    inputSource: result.inputSource || null,
    inputTruncated: Boolean(result.inputTruncated),
    withOS: Boolean(result.withOS),
    preload: Boolean(result.preload),
    preloadStatus: result.preload?.status || null,
    preloadArtifactId: result.preload?.artifactId || null,
    preloadChars: Number(result.preload?.chars) || 0,
    sessionId: result.sessionId || null,
    sessionMode: result.sessionMode || null,
    batch: Boolean(result.batch),
    steps: Number(result.steps) || 0,
    toolCallCount: Array.isArray(result.toolCalls) ? result.toolCalls.length : 0,
    toolNames: Array.isArray(result.toolCalls) ? result.toolCalls.map((call) => call.name).filter(Boolean) : [],
    durationMs: Number(result.durationMs) || 0,
    promptTokens: Number(usage.prompt_tokens) || 0,
    completionTokens: Number(usage.completion_tokens) || 0,
    totalTokens: Number(usage.total_tokens) || 0,
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

export function summarizeMicroUsage(projectRoot, { limit = 500 } = {}) {
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
  entries = entries.slice(-Math.max(1, Number(limit) || 500));
  const byPreset = new Map();
  const byModel = new Map();
  const totals = { calls: entries.length, ok: 0, failed: 0, withOSCalls: 0, preloadCalls: 0, preloadChars: 0, batchCalls: 0, persistentSessionCalls: 0, toolCallCount: 0, steps: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0, durationMs: 0 };
  for (const entry of entries) {
    if (entry.ok) totals.ok += 1;
    else totals.failed += 1;
    if (entry.withOS) totals.withOSCalls += 1;
    if (entry.preload) totals.preloadCalls += 1;
    totals.preloadChars += Number(entry.preloadChars) || 0;
    if (entry.batch) totals.batchCalls += 1;
    if (entry.sessionMode === 'persistent') totals.persistentSessionCalls += 1;
    totals.toolCallCount += Number(entry.toolCallCount) || 0;
    totals.steps += Number(entry.steps) || 0;
    totals.promptTokens += Number(entry.promptTokens) || 0;
    totals.completionTokens += Number(entry.completionTokens) || 0;
    totals.totalTokens += Number(entry.totalTokens) || 0;
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
    byPreset: [...byPreset.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    byModel: [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens),
  };
}

export function persistMicroArtifact(projectRoot, result) {
  if (!projectRoot || !result || typeof result !== 'object') return { receiptId: null, artifactId: null };
  const receiptId = result.receiptId || `micro-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  recordMicroUsage(projectRoot, result, receiptId);
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

export function projectMicroResult(result, { projectRoot, full = false, maxChars = RESPONSE_BUDGETS.micro } = {}) {
  const persisted = persistMicroArtifact(projectRoot, result);
  const { receiptId, artifactId } = persisted || {};
  if (!result?.ok) {
    return {
      ok: false,
      receiptId,
      artifactId,
      error: clipText(result?.error || 'Micro task failed', maxChars, { label: 'micro error' }),
      ...(result?.budgetExceeded ? { budgetExceeded: result.budgetExceeded } : {}),
    };
  }
  if (full) return { ...result, receiptId, artifactId };
  const content = result.content || '';
  const projected = clipText(content, maxChars, { label: 'micro answer', keepTail: false });
  return {
    ok: true,
    receiptId,
    artifactId,
    chars: content.length,
    truncated: projected.length < content.length,
    content: projected,
    ...(Array.isArray(result.evidenceRefs) && result.evidenceRefs.length
      ? { evidenceRefs: result.evidenceRefs.slice(0, 5) }
      : {}),
    ...(result.confidence ? { confidence: result.confidence } : {}),
    ...(Array.isArray(result.unknowns) && result.unknowns.length
      ? { unknowns: result.unknowns.slice(0, 5) }
      : {}),
  };
}
