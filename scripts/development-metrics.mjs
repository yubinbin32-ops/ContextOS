/** Summarize provider usage and completed-task evidence without imputing missing usage. */
import fs from 'node:fs';
import { parseRolloutTelemetry } from '../packages/orchestrator/src/rollout-telemetry.mjs';
const run = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const eventWarnings = [];
function records(file, warnings = eventWarnings) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  return lines.flatMap((line, index) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; }
    catch { warnings.push(`Malformed JSONL record ${index + 1}; accounting is incomplete.`); return []; }
  });
}
const events = records(run.events);
const completed = events.filter((event) => event.type === 'turn.completed').at(-1);
const rollout = parseRolloutTelemetry(run.rollouts);
const fields = { inputTokens: 'input_tokens', cachedInputTokens: 'cached_input_tokens', outputTokens: 'output_tokens', reasoningOutputTokens: 'reasoning_output_tokens' };
const completions = events.filter((event) => event.type === 'turn.completed');
const matches = (usage) => usage && rollout.ok && Object.entries(fields).every(([key,field]) => usage[field] === rollout.metrics[key]);
const summedUsage = Object.fromEntries(Object.values(fields).map((field) => [field, completions.reduce((n,event) => n + (event.usage?.[field] ?? NaN),0)]));
const accountingMode = matches(completed?.usage) ? 'cumulative-cli' : matches(summedUsage) ? 'per-turn-cli' : null;
const accountingMatches = accountingMode !== null;
const items = events.filter((event) => event.type === 'item.completed').map((event) => event.item).filter(Boolean);
const mcp = items.filter((item) => item.type === 'mcp_tool_call');
const osItems = mcp.filter((item) => item.server?.includes('contextos'));
function outcome(item) {
  const result = item.result || {};
  const structured = result.structured_content || result.structuredContent;
  if (structured?.operation === 'change') return structured;
  for (const chunk of result.content || []) {
    for (const line of (chunk.text || '').split('\n')) {
      if (!line.startsWith('status=')) continue;
      try { const parsed = JSON.parse(line.slice(7)); if (parsed.operation === 'change') return parsed; } catch {}
    }
  }
  return null;
}
const outcomes = osItems.map(outcome).filter(Boolean);
const osCalls = osItems.filter((item) => item.status === 'completed' && !item.error);
const verifiedMutations = outcomes.filter((result) => result.status === 'verified' && result.changed && result.verified).length;
const trace = [], responseIds = new Set();
let compactionRecords = 0;
const observedModels = new Set();
for (const file of run.rollouts) {
  for (const record of records(file)) {
    if (record.type === 'turn_context' && record.payload?.model) observedModels.add(record.payload.model);
    if (record.type === 'compacted' || (record.type === 'event_msg' && record.payload?.type === 'context_compaction')) compactionRecords++;
    if (record.type !== 'token_usage_record' || !record.payload?.response_id || responseIds.has(record.payload.response_id)) continue;
    responseIds.add(record.payload.response_id);
    trace.push(record.payload.usage);
  }
}
const modelVerified = observedModels.size === 1 && observedModels.has(run.model);
const complete = (!run.requireObservedModel || modelVerified) && !run.stopReason && run.status === 0 && trace.length > 0 && trace.length === rollout.metrics?.requestCount && Boolean(completed) && accountingMatches && !eventWarnings.length;
const nativeChanges = items.filter((item) => item.type === 'file_change').length;
const osUsed = run.arm === 'native' || (osCalls.length > 0 && (!run.requireOsMutation || verifiedMutations > 0)) || (run.allowNativeFallback === true && (nativeChanges > 0 || run.businessChanged?.length > 0));
const qualityPass = run.quality?.pass === true && run.scopePass === true;
const window = rollout.metrics?.modelContextWindow;
const metrics = rollout.ok ? { ...rollout.metrics, uncachedInputTokens: rollout.metrics.inputTokens - rollout.metrics.cachedInputTokens,
  peakInputWindowPercent: window > 0 ? Number((100 * rollout.metrics.peakRequestInputTokens / window).toFixed(2)) : null } : null;
const safe = (warning) => [run.workspace, run.home].filter(Boolean).reduce((text, value) => text.replaceAll(value, value === run.workspace ? '<workspace>' : '<codex-home>'), warning);
const report = { schemaVersion: 2, arm: run.arm, pairId: run.pairId ?? null, task: run.task, scenario: run.scenario, model: run.model, effort: run.effort,
  baseCommit: run.baseCommit, promptSha256: run.promptSha256, plugin: run.plugin, candidateSnapshot: run.candidateSnapshot, inputTree: run.inputTree, allowNativeFallback: run.allowNativeFallback,
  cliVersion: run.cliVersion, provider: run.provider, bounds: run.bounds, businessChanged: run.businessChanged,
  status: run.status, stopReason: run.stopReason || null, elapsedSeconds: run.elapsedSeconds, complete, accountingMatches, accountingMode, modelVerified, observedModels:[...observedModels], osUsed,
  quality: run.quality, scopePass: run.scopePass, workflowRoute:run.arm === 'native' ? 'native' : osCalls.length ? 'contextos' : 'native-fallback', validForComparison: complete && osUsed && qualityPass,
  metrics: complete ? metrics : null, observedPartialMetrics: complete ? null : metrics, requests: trace,
  tools: { commands: items.filter((item) => item.type === 'command_execution').length,
    fileChanges: items.filter((item) => item.type === 'file_change').length, osCalls: osCalls.length,
    osErrors: osItems.filter((item) => item.error || item.result?.isError || item.result?.is_error || outcome(item)?.errorCode).length,
    mutationRejections: outcomes.filter((result) => result.status === 'blocked').length,
    verifiedMutations, lastMutationStatus: outcomes.at(-1)?.status ?? null, compactionRecords },
  warnings: [...rollout.warnings, ...eventWarnings].map(safe) };
console.log(JSON.stringify(report, null, 2));
