import fs from 'node:fs';
import path from 'node:path';

function telemetryPath(projectRoot) {
  return path.join(projectRoot, '.contextos', 'logs', 'telemetry.jsonl');
}

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.ceil(String(text).length / 4);
}

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
  artifactId = null,
  truncated = false,
  durationMs = 0,
} = {}) {
  if (!projectRoot || !tool) return null;
  const inputText = JSON.stringify(input ?? {});
  const outputText = String(output ?? '');
  const prior = readEntries(projectRoot).filter((entry) => entry.sessionId === sessionId);
  const priorOutputChars = prior.reduce((sum, entry) => sum + (Number(entry.outputChars) || 0), 0);
  const entry = {
    at: new Date().toISOString(),
    sessionId: sessionId || null,
    tool,
    inputChars: inputText.length,
    estimatedInputTokens: estimateTokens(inputText),
    outputChars: outputText.length,
    estimatedOutputTokens: estimateTokens(outputText),
    replayChars: priorOutputChars + outputText.length,
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

export function summarizeTelemetry(projectRoot, { sessionId = null, limit = 500 } = {}) {
  let entries = readEntries(projectRoot);
  if (sessionId) entries = entries.filter((entry) => entry.sessionId === sessionId);
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

  for (const entry of entries) {
    const entryInputChars = Number(entry.inputChars) || 0;
    const entryOutputChars = Number(entry.outputChars) || 0;
    inputChars += entryInputChars;
    outputChars += entryOutputChars;
    replayChars += Number(entry.replayChars) || 0;
    estimatedInputTokens += Number(entry.estimatedInputTokens) || 0;
    estimatedOutputTokens += Number(entry.estimatedOutputTokens) || 0;
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
    calls: entries.length,
    inputChars,
    outputChars,
    replayChars,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens,
    peakContextChars,
    peakEstimatedContextTokens: Math.ceil(peakContextChars / 4),
    truncated,
    topContributors: Array.from(byTool.values())
      .sort((a, b) => b.estimatedTokens - a.estimatedTokens)
      .slice(0, 6),
  };
}

