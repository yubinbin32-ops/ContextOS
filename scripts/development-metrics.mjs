/** Summarize real CLI usage; do not estimate missing model accounting. */
import fs from 'node:fs';
import { parseRolloutTelemetry } from '../packages/orchestrator/src/rollout-telemetry.mjs';
const run = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const events = fs.readFileSync(run.events, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const completed = events.filter((event) => event.type === 'turn.completed').at(-1);
const rollout = parseRolloutTelemetry(run.rollouts);
const usage = completed?.usage;
const fields = { inputTokens: 'input_tokens', cachedInputTokens: 'cached_input_tokens', outputTokens: 'output_tokens', reasoningOutputTokens: 'reasoning_output_tokens' };
const accountingMatches = Boolean(usage && rollout.ok && Object.entries(fields).every(([key, field]) => usage[field] === rollout.metrics[key]));
const items = events.filter((event) => event.type === 'item.completed').map((event) => event.item);
const mcp = items.filter((item) => item.type === 'mcp_tool_call');
const osCalls = mcp.filter((item) => item.server?.includes('contextos') && item.status === 'completed' && !item.error);
const trace = [];
const responseIds = new Set();
for (const file of run.rollouts) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const record = JSON.parse(line);
    if (record.type !== 'token_usage_record' || !record.payload?.response_id || responseIds.has(record.payload.response_id)) continue;
    responseIds.add(record.payload.response_id);
    trace.push(record.payload.usage);
  }
}
const complete = run.status === 0 && Boolean(completed) && accountingMatches;
const osUsed = run.arm === 'native' || osCalls.length > 0;
const qualityPass = run.quality?.pass === true && run.scopePass === true;
const metrics = rollout.ok ? { ...rollout.metrics, uncachedInputTokens: rollout.metrics.inputTokens - rollout.metrics.cachedInputTokens, peakInputWindowPercent: Number((100 * rollout.metrics.peakRequestInputTokens / rollout.metrics.modelContextWindow).toFixed(2)) } : null;
const report = { schemaVersion: 1, arm: run.arm, model: run.model, effort: run.effort, baseCommit: run.baseCommit, promptSha256: run.promptSha256, plugin: run.plugin, cliVersion: run.cliVersion, status: run.status, stopReason: run.stopReason || null, elapsedSeconds: run.elapsedSeconds, complete, accountingMatches, osUsed, quality: run.quality, scopePass: run.scopePass, validForComparison: complete && osUsed && qualityPass, metrics: complete ? metrics : null, observedPartialMetrics: complete ? null : metrics, requests: trace, tools: { commands: items.filter((item) => item.type === 'command_execution').length, fileChanges: items.filter((item) => item.type === 'file_change').length, osCalls: osCalls.length, osErrors: mcp.filter((item) => item.error).length }, warnings: rollout.warnings.map((warning) => warning.replaceAll(run.workspace, '<workspace>').replaceAll(run.home, '<codex-home>')) };
console.log(JSON.stringify(report, null, 2));
