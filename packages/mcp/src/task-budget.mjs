import crypto from "node:crypto";

const budgets = new Map();

function snapshot(entry) {
  return {
    taskContextId: entry.id,
    budgetChars: entry.budgetChars,
    consumedChars: entry.consumedChars,
    remainingChars: Math.max(0, entry.budgetChars - entry.consumedChars),
    responses: entry.responses,
    controlRemainingChars: Math.max(0, entry.controlBudgetChars-entry.controlConsumedChars),
    sourceSyncRevision: entry.sourceSyncRevision ?? null,
    sourceRevision: entry.sourceRevision ?? null,
  };
}

export function startTaskBudget({ projectRoot = ".", taskContextId = null, budgetChars = 12000 } = {}) {
  if (taskContextId && budgets.has(taskContextId)) {
    const existing = budgets.get(taskContextId);
    if (existing.projectRoot === projectRoot) return snapshot(existing);
  }
  const entry = {
    id: taskContextId || `task_${crypto.randomUUID()}`,
    projectRoot,
    budgetChars: Math.max(100, Math.floor(Number(budgetChars) || 12000)),
    consumedChars: 0,
    responses: 0,
    controlBudgetChars: 2000,
    controlConsumedChars: 0,
    sourceSyncRevision: null,
    sourceRevision: null,
  };
  budgets.set(entry.id, entry);
  return snapshot(entry);
}

export function taskBudget(taskContextId) {
  const entry = taskContextId ? budgets.get(taskContextId) : null;
  return entry ? snapshot(entry) : null;
}

export function setTaskSourceBaseline(taskContextId, { sourceSyncRevision = null, sourceRevision = null } = {}) {
  const entry = taskContextId ? budgets.get(taskContextId) : null;
  if (!entry) return null;
  if (entry.sourceSyncRevision === null) entry.sourceSyncRevision = sourceSyncRevision;
  if (entry.sourceRevision === null) entry.sourceRevision = sourceRevision;
  return snapshot(entry);
}

export function taskSourceBaseline(taskContextId) {
  const entry = taskContextId ? budgets.get(taskContextId) : null;
  if (!entry) return null;
  return {
    taskContextId: entry.id,
    sourceSyncRevision: entry.sourceSyncRevision,
    sourceRevision: entry.sourceRevision,
  };
}

function truncateMarkdown(markdown, maxChars, suffix) {
  const text = String(markdown ?? "");
  if (text.length <= maxChars) return text;
  const marker = `\n\n${suffix}`;
  if (maxChars <= marker.length) return marker.slice(0, maxChars);
  return `${text.slice(0, maxChars - marker.length)}${marker}`;
}

function compactState(data, entry) {
  return {
    taskContextId: entry.id,
    graphRevision: data?.graphRevision ?? null,
    sourceSyncRevision: data?.sourceSync?.revision ?? data?.sourceSyncRevision ?? null,
    sourceRevision: data?.sourceSync?.sourceRevision ?? data?.sourceRevision ?? null,
    success: typeof data?.success === "boolean" ? data.success : null,
    valid: typeof data?.valid === "boolean" ? data.valid : null,
    changed: data?.sourceSync?.changed ?? data?.changed ?? false,
    executionId: data?.executionId ?? null,
    changeSetId: data?.changeSetId ?? null,
    truncated: true,
    reason: "detail projection exceeded the remaining task budget",
  };
}

export function boundTaskResponse({ taskContextId, markdown, data, includeStructured = false, critical = false } = {}) {
  const entry = taskContextId ? budgets.get(taskContextId) : null;
  if (!entry) return { markdown, structured: includeStructured ? data : undefined, budget: null };

  const before = snapshot(entry);
  const suffix = `[task budget ${before.remainingChars} chars remaining; keep taskContextId=${entry.id} for focused expansion]`;
  const markdownText = String(markdown ?? "");
  const structuredText = includeStructured ? JSON.stringify(data ?? {}) : "";
  const available = before.remainingChars + (critical ? before.controlRemainingChars : 0);
  let boundedMarkdown = markdownText;
  let structured;
  if (!includeStructured) {
    boundedMarkdown = truncateMarkdown(markdownText, available, suffix);
  } else if (markdownText.length + structuredText.length <= available) {
    structured = data;
  } else {
    const receipt = { ...compactState(data, entry), budget: snapshot(entry) };
    structured = JSON.stringify(receipt).length <= available
      ? receipt
      : compactState(data, entry);
  }
  if (includeStructured) {
    if (JSON.stringify(structured).length > available) structured = undefined;
    const structuredChars = structured === undefined ? 0 : JSON.stringify(structured).length;
    boundedMarkdown = truncateMarkdown(markdownText, Math.max(0, available - structuredChars), suffix);
  }
  const returnedChars = boundedMarkdown.length + (structured === undefined ? 0 : JSON.stringify(structured).length);
  const normalCharged = Math.min(before.remainingChars, returnedChars);
  entry.consumedChars += normalCharged;
  entry.controlConsumedChars += Math.max(0,returnedChars-normalCharged);
  entry.responses += 1;
  const after = snapshot(entry);
  return { markdown: boundedMarkdown, structured, budget: after };
}

export function resetTaskBudgets() {
  budgets.clear();
}
