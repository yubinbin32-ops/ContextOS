#!/usr/bin/env node
// Aggregate manual ContextOS A/B/C test metrics from Codex rollout JSONL and
// Micro provider usage logs. This is a reporting tool for human-run sessions;
// it never launches a session or infers missing usage.
import fs from 'node:fs';
import path from 'node:path';
import { parseRolloutTelemetry } from '../packages/orchestrator/src/rollout-telemetry.mjs';

function usage() {
  return [
    'Usage: node scripts/contextos-ab-metrics.mjs --label A --rollout <file.jsonl> [options]',
    '',
    'Options:',
    '  --label <name>            Group label used in the output (required).',
    '  --rollout <file.jsonl>    Rollout file; repeat for multiple files.',
    '  --micro-usage <file.jsonl> Micro usage log; repeat for multiple files.',
    '  --json                    Print one JSON object instead of a text summary.',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { label: null, rollouts: [], microUsage: [], json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--label') options.label = argv[++index];
    else if (token === '--rollout') options.rollouts.push(argv[++index]);
    else if (token === '--micro-usage') options.microUsage.push(argv[++index]);
    else if (token === '--json') options.json = true;
    else if (token === '--help' || token === '-h') options.help = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  return options;
}

function readJsonl(filePath) {
  const records = [];
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Rollout files can contain interleaved non-JSON log lines; they are not metrics.
    }
  }
  return records;
}

function increment(map, key) {
  const name = key || '<unnamed>';
  map[name] = (map[name] || 0) + 1;
}

function collectRollout(filePath) {
  const records = readJsonl(filePath);
  const responseItems = records.filter((record) => record.type === 'response_item' && record.payload);
  const completedItems = records
    .filter((record) => record.type === 'event_msg' && record.payload?.type === 'item_completed')
    .map((record) => record.payload.item)
    .filter(Boolean);

  const functionCalls = responseItems.filter((record) => record.payload.type === 'function_call');
  const customToolCalls = responseItems.filter((record) => record.payload.type === 'custom_tool_call');
  const toolSearches = responseItems.filter((record) => record.payload.type === 'tool_search_call');
  const toolNames = {};
  for (const call of functionCalls) increment(toolNames, call.payload.name);
  for (const call of customToolCalls) increment(toolNames, call.payload.name || call.payload.tool_name);
  for (const call of toolSearches) increment(toolNames, 'tool_search');

  const mcpCalls = completedItems.filter((item) => item.type === 'McpToolCall');
  const contextosCalls = mcpCalls.filter((item) => item.server === 'contextos');
  const contextosActions = {};
  for (const call of contextosCalls) increment(contextosActions, call.arguments?.action);

  const failedItems = completedItems.filter((item) => item.status === 'failed');
  const failedByType = {};
  for (const item of failedItems) increment(failedByType, item.type);

  const timestamps = records
    .map((record) => record.timestamp)
    .filter((value) => typeof value === 'string')
    .sort();
  const telemetry = parseRolloutTelemetry([filePath], { projectRoot: process.cwd() });

  return {
    file: path.resolve(filePath),
    telemetryOk: telemetry.ok,
    telemetryWarnings: telemetry.warnings,
    usage: telemetry.metrics,
    toolCalls: {
      total: functionCalls.length + customToolCalls.length + toolSearches.length,
      functionCall: functionCalls.length,
      customToolCall: customToolCalls.length,
      toolSearch: toolSearches.length,
      byName: toolNames,
    },
    mcpCalls: {
      total: mcpCalls.length,
      contextos: contextosCalls.length,
      contextosActions,
      byServer: mcpCalls.reduce((accumulator, item) => {
        increment(accumulator, item.server);
        return accumulator;
      }, {}),
    },
    failures: {
      total: failedItems.length,
      byType: failedByType,
    },
    startedAt: timestamps[0] || null,
    endedAt: timestamps[timestamps.length - 1] || null,
  };
}

function collectMicroUsage(filePath) {
  const records = readJsonl(filePath);
  const total = {
    calls: records.length,
    ok: records.filter((record) => record.ok === true).length,
    failed: records.filter((record) => record.ok === false).length,
    providerRequests: records.reduce((sum, record) => sum + (record.providerRequests || 0), 0),
    promptTokens: records.reduce((sum, record) => sum + (record.promptTokens || 0), 0),
    completionTokens: records.reduce((sum, record) => sum + (record.completionTokens || 0), 0),
    totalTokens: records.reduce((sum, record) => sum + (record.totalTokens || 0), 0),
    estimatedUsageCalls: records.filter((record) => record.usageSource !== 'provider').length,
    toolCallCount: records.reduce((sum, record) => sum + (record.toolCallCount || 0), 0),
    byDelivery: records.reduce((accumulator, record) => {
      increment(accumulator, record.deliveryOutcome || record.requestedDelivery);
      return accumulator;
    }, {}),
  };
  return { file: path.resolve(filePath), total };
}

function summarize(rollouts, microUsage) {
  const usageTotals = rollouts.reduce(
    (accumulator, entry) => {
      if (!entry.usage) return accumulator;
      accumulator.inputTokens += entry.usage.inputTokens;
      accumulator.cachedInputTokens += entry.usage.cachedInputTokens;
      accumulator.outputTokens += entry.usage.outputTokens;
      accumulator.reasoningOutputTokens += entry.usage.reasoningOutputTokens;
      accumulator.totalTokens += entry.usage.totalTokens;
      accumulator.requestCount += entry.usage.requestCount;
      accumulator.peakRequestInputTokens = Math.max(
        accumulator.peakRequestInputTokens,
        entry.usage.peakRequestInputTokens
      );
      accumulator.modelContextWindow = Math.max(
        accumulator.modelContextWindow,
        entry.usage.modelContextWindow || 0
      );
      return accumulator;
    },
    {
      requestCount: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      peakRequestInputTokens: 0,
      modelContextWindow: 0,
    }
  );
  const toolTotals = rollouts.reduce(
    (accumulator, entry) => {
      accumulator.total += entry.toolCalls.total;
      accumulator.functionCall += entry.toolCalls.functionCall;
      accumulator.customToolCall += entry.toolCalls.customToolCall;
      accumulator.toolSearch += entry.toolCalls.toolSearch;
      accumulator.contextosMcp += entry.mcpCalls.contextos;
      for (const [name, count] of Object.entries(entry.toolCalls.byName)) {
        accumulator.byName[name] = (accumulator.byName[name] || 0) + count;
      }
      for (const [action, count] of Object.entries(entry.mcpCalls.contextosActions)) {
        accumulator.contextosActions[action] = (accumulator.contextosActions[action] || 0) + count;
      }
      return accumulator;
    },
    {
      total: 0,
      functionCall: 0,
      customToolCall: 0,
      toolSearch: 0,
      contextosMcp: 0,
      byName: {},
      contextosActions: {},
    }
  );
  const failures = rollouts.reduce((sum, entry) => sum + entry.failures.total, 0);
  const micro = microUsage.reduce(
    (accumulator, entry) => {
      for (const [key, value] of Object.entries(entry.total)) {
        if (typeof value === 'number') accumulator[key] += value;
      }
      for (const [key, value] of Object.entries(entry.total.byDelivery)) {
        accumulator.byDelivery[key] = (accumulator.byDelivery[key] || 0) + value;
      }
      return accumulator;
    },
    {
      calls: 0,
      ok: 0,
      failed: 0,
      providerRequests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedUsageCalls: 0,
      toolCallCount: 0,
      byDelivery: {},
    }
  );
  const started = rollouts.map((entry) => entry.startedAt).filter(Boolean).sort()[0] || null;
  const ended = rollouts.map((entry) => entry.endedAt).filter(Boolean).sort().at(-1) || null;
  return {
    usage: usageTotals,
    toolCalls: toolTotals,
    failures,
    micro,
    startedAt: started,
    endedAt: ended,
    durationMs: started && ended ? Date.parse(ended) - Date.parse(started) : null,
  };
}

function formatSummary(label, summary, rollouts, microUsage) {
  const lines = [`[${label}]`];
  const usage = summary.usage;
  lines.push(
    `requests=${usage.requestCount} tools=${summary.toolCalls.total} contextos=${summary.toolCalls.contextosMcp} micro=${summary.micro.calls} failures=${summary.failures}`
  );
  lines.push(
    `tokens input=${usage.inputTokens} cached=${usage.cachedInputTokens} output=${usage.outputTokens} reasoning=${usage.reasoningOutputTokens} total=${usage.totalTokens}`
  );
  lines.push(`peakInput=${usage.peakRequestInputTokens} contextWindow=${usage.modelContextWindow}`);
  if (summary.micro.calls) {
    lines.push(
      `microTokens prompt=${summary.micro.promptTokens} completion=${summary.micro.completionTokens} total=${summary.micro.totalTokens} providerRequests=${summary.micro.providerRequests}`
    );
  }
  lines.push(`toolsByName=${JSON.stringify(summary.toolCalls.byName)}`);
  if (summary.toolCalls.contextosMcp) {
    lines.push(`contextosActions=${JSON.stringify(summary.toolCalls.contextosActions)}`);
  }
  if (summary.durationMs !== null) {
    lines.push(`duration=${Math.round(summary.durationMs / 1000)}s`);
  }
  lines.push(`rollouts=${rollouts.map((entry) => entry.file).join(',')}`);
  if (microUsage.length) lines.push(`microUsage=${microUsage.map((entry) => entry.file).join(',')}`);
  return lines.join('\n');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!options.label) throw new Error('--label is required');
  if (!options.rollouts.length) throw new Error('at least one --rollout is required');
  const rollouts = options.rollouts.map(collectRollout);
  const microUsage = options.microUsage.map(collectMicroUsage);
  const summary = summarize(rollouts, microUsage);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ label: options.label, summary, rollouts, microUsage }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatSummary(options.label, summary, rollouts, microUsage)}\n`);
}

main();
