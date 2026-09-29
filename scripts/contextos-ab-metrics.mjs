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
    '  --codex-home <dir>        Resolve codex exec --json streams to sessions/**/rollout-*.jsonl.',
    '  --micro-usage <file.jsonl> Micro usage log; repeat for multiple files.',
    '  --json                    Print one JSON object instead of a text summary.',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { label: null, rollouts: [], microUsage: [], codexHome: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--label') options.label = argv[++index];
    else if (token === '--rollout') options.rollouts.push(argv[++index]);
    else if (token === '--codex-home') options.codexHome = argv[++index];
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

function isCodexExecStream(records) {
  return records.some((record) => record.type === 'thread.started' || record.type === 'turn.completed');
}

function hasPerRequestUsage(records) {
  return records.some((record) => record.type === 'event_msg' && record.payload?.type === 'token_count');
}

function findSessionRollout(codexHome, threadId) {
  if (!codexHome || !threadId) return null;
  const sessionsRoot = path.join(path.resolve(codexHome), 'sessions');
  if (!fs.existsSync(sessionsRoot)) return null;
  const pending = [sessionsRoot];
  const matches = [];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) matches.push(entryPath);
    }
  }
  matches.sort();
  return matches[0] || null;
}

function resolveRolloutInput(filePath, { codexHome = null } = {}) {
  const requestedPath = path.resolve(filePath);
  const records = readJsonl(requestedPath);
  if (!isCodexExecStream(records)) {
    if (!hasPerRequestUsage(records)) {
      throw new Error(`${requestedPath}: rollout has no token_count usage; per-request metrics are unavailable`);
    }
    return { path: requestedPath, records, requestedPath };
  }

  const threadId = records.find((record) => record.type === 'thread.started')?.thread_id;
  if (!threadId) throw new Error(`${requestedPath}: codex exec stream is missing thread_id`);
  if (!codexHome) {
    throw new Error(`${requestedPath}: codex exec stream has no per-request usage; pass --codex-home <dir> to resolve thread ${threadId}`);
  }
  const sessionPath = findSessionRollout(codexHome, threadId);
  if (!sessionPath) {
    throw new Error(`${requestedPath}: no session rollout for thread ${threadId} under ${path.resolve(codexHome, 'sessions')}`);
  }
  const sessionRecords = readJsonl(sessionPath);
  if (!hasPerRequestUsage(sessionRecords)) {
    throw new Error(`${sessionPath}: session rollout has no token_count usage`);
  }
  return { path: sessionPath, records: sessionRecords, requestedPath };
}

function increment(map, key) {
  const name = key || '<unnamed>';
  map[name] = (map[name] || 0) + 1;
}

const DISCOVERY_COMMAND = /^\s*(sed|cat|rg|grep|ls|find|head|tail|wc|jq|awk|git\s+(status|log|diff|show|branch|rev-parse)|pwd|which|echo)\b/;
const VERIFY_COMMAND = /\b(npm\s+test|node\s+--test|pytest|npm\s+run\s+(test|build|lint)|tsc|eslint|vitest|jest)\b/;

// A turn is one host model request: the batch of tool calls it emitted before
// the next usage record. Decision turns change or check state; mechanical
// turns only gather information the next decision consumes.
function classifyCall(call, mcpActionByCallId) {
  const name = call.payload.name;
  const callId = String(call.payload.id || '').replace(/^fc_/, '');
  if (name === 'apply_patch') return 'mutation';
  if (name === 'update_plan') return 'planning';
  if (name === 'tool_search') return 'discovery';
  if (name === 'contextos') {
    const action = mcpActionByCallId.get(callId) || 'explore';
    if (action === 'change') return 'mutation';
    if (action === 'verify') return 'verification';
    if (action === 'ship') return 'closure';
    return 'discovery';
  }
  if (name === 'exec_command') {
    let command = '';
    try {
      command = JSON.parse(call.payload.arguments || '{}').cmd || '';
    } catch {
      command = '';
    }
    if (VERIFY_COMMAND.test(command)) return 'verification';
    if (DISCOVERY_COMMAND.test(command)) return 'discovery';
    return 'other';
  }
  return 'other';
}

function classifyTurn(kinds) {
  if (!kinds.length) return 'decision'; // final answer turn: no tool calls
  if (kinds.includes('mutation')) return 'mutation';
  if (kinds.includes('verification')) return 'verification';
  if (kinds.includes('closure')) return 'closure';
  if (kinds.every((kind) => kind === 'discovery' || kind === 'planning')) return 'mechanical';
  return 'other';
}

function collectRollout(filePath, { codexHome = null } = {}) {
  const resolved = resolveRolloutInput(filePath, { codexHome });
  const records = resolved.records;
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
  const mcpActionByCallId = new Map(
    mcpCalls.map((item) => [String(item.id || ''), item.arguments?.action || 'explore'])
  );

  const turns = [];
  let pendingCalls = [];
  for (const record of records) {
    if (record.type === 'response_item' && record.payload
      && ['function_call', 'custom_tool_call', 'tool_search_call'].includes(record.payload.type)) {
      pendingCalls.push(record);
      continue;
    }
    if (record.type === 'event_msg' && record.payload?.type === 'token_count' && record.payload.info) {
      const usage = record.payload.info.last_token_usage || {};
      const kinds = pendingCalls.map((call) => classifyCall(call, mcpActionByCallId));
      turns.push({
        toolCalls: pendingCalls.length,
        kinds,
        kind: classifyTurn(kinds),
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
      });
      pendingCalls = [];
    }
  }
  if (pendingCalls.length) {
    const kinds = pendingCalls.map((call) => classifyCall(call, mcpActionByCallId));
    turns.push({ toolCalls: pendingCalls.length, kinds, kind: classifyTurn(kinds), inputTokens: 0, outputTokens: 0 });
  }
  const turnKinds = {};
  for (const turn of turns) increment(turnKinds, turn.kind);
  const inputSeries = turns.map((turn) => turn.inputTokens).filter((value) => value > 0);
  const turnMetrics = {
    total: turns.length,
    decisionTurns: turns.filter((turn) => ['decision', 'mutation', 'verification', 'closure'].includes(turn.kind)).length,
    mechanicalTurns: turns.filter((turn) => turn.kind === 'mechanical').length,
    byKind: turnKinds,
    averageToolsPerTurn: turns.length
      ? Number((turns.reduce((sum, turn) => sum + turn.toolCalls, 0) / turns.length).toFixed(2))
      : 0,
    maxToolsPerTurn: turns.reduce((max, turn) => Math.max(max, turn.toolCalls), 0),
    contextGrowth: inputSeries.length ? inputSeries[inputSeries.length - 1] - inputSeries[0] : 0,
    inputSeries,
  };

  const failedItems = completedItems.filter((item) => item.status === 'failed');
  const failedByType = {};
  for (const item of failedItems) increment(failedByType, item.type);

  const timestamps = records
    .map((record) => record.timestamp)
    .filter((value) => typeof value === 'string')
    .sort();
  const telemetry = parseRolloutTelemetry([resolved.path], { projectRoot: process.cwd() });

  return {
    file: resolved.path,
    requestedFile: resolved.requestedPath,
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
    turns: turnMetrics,
    startedAt: timestamps[0] || null,
    endedAt: timestamps[timestamps.length - 1] || null,
  };
}

function collectMicroUsage(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      file: path.resolve(filePath),
      missing: true,
      total: {
        calls: 0,
        ok: 0,
        failed: 0,
        providerRequests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        estimatedUsageCalls: 0,
        toolRounds: 0,
        toolCallCount: 0,
        hostTurnsSaved: 0,
        executorCalls: 0,
        executorIdleCalls: 0,
        summarizerOnlyCalls: 0,
        byDelivery: {},
      },
    };
  }
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
    toolRounds: records.reduce((sum, record) => sum + (record.toolRounds || 0), 0),
    toolCallCount: records.reduce((sum, record) => sum + (record.toolCallCount || 0), 0),
    hostTurnsSaved: records.reduce((sum, record) => sum + (record.hostTurnsSaved || 0), 0),
    executorCalls: records.filter((record) => record.executionMode === 'executor').length,
    executorIdleCalls: records.filter((record) => record.executionMode === 'executor-idle').length,
    summarizerOnlyCalls: records.filter((record) => record.executionMode === 'summarizer-only' || record.summarizerOnly).length,
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
  const turnTotals = rollouts.reduce(
    (accumulator, entry) => {
      accumulator.total += entry.turns.total;
      accumulator.decisionTurns += entry.turns.decisionTurns;
      accumulator.mechanicalTurns += entry.turns.mechanicalTurns;
      accumulator.toolCalls += entry.turns.total * entry.turns.averageToolsPerTurn;
      accumulator.maxToolsPerTurn = Math.max(accumulator.maxToolsPerTurn, entry.turns.maxToolsPerTurn);
      accumulator.contextGrowth = Math.max(accumulator.contextGrowth, entry.turns.contextGrowth);
      for (const [kind, count] of Object.entries(entry.turns.byKind)) {
        accumulator.byKind[kind] = (accumulator.byKind[kind] || 0) + count;
      }
      return accumulator;
    },
    {
      total: 0,
      decisionTurns: 0,
      mechanicalTurns: 0,
      toolCalls: 0,
      maxToolsPerTurn: 0,
      contextGrowth: 0,
      byKind: {},
    }
  );
  turnTotals.averageToolsPerTurn = turnTotals.total
    ? Number((turnTotals.toolCalls / turnTotals.total).toFixed(2))
    : 0;
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
      toolRounds: 0,
      toolCallCount: 0,
      hostTurnsSaved: 0,
      executorCalls: 0,
      executorIdleCalls: 0,
      summarizerOnlyCalls: 0,
      byDelivery: {},
    }
  );
  const started = rollouts.map((entry) => entry.startedAt).filter(Boolean).sort()[0] || null;
  const ended = rollouts.map((entry) => entry.endedAt).filter(Boolean).sort().at(-1) || null;
  return {
    usage: usageTotals,
    toolCalls: toolTotals,
    failures,
    turns: turnTotals,
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
  const turns = summary.turns;
  lines.push(
    `turns=${turns.total} decision=${turns.decisionTurns} mechanical=${turns.mechanicalTurns} toolsPerTurn=${turns.averageToolsPerTurn} maxBatch=${turns.maxToolsPerTurn} contextGrowth=${turns.contextGrowth}`
  );
  lines.push(`turnKinds=${JSON.stringify(turns.byKind)}`);
  if (summary.micro.calls) {
    lines.push(
      `microTokens prompt=${summary.micro.promptTokens} completion=${summary.micro.completionTokens} total=${summary.micro.totalTokens} providerRequests=${summary.micro.providerRequests} toolRounds=${summary.micro.toolRounds} toolCalls=${summary.micro.toolCallCount} hostTurnsSaved=${summary.micro.hostTurnsSaved}`
    );
    lines.push(
      `microModes executor=${summary.micro.executorCalls} executorIdle=${summary.micro.executorIdleCalls} summarizerOnly=${summary.micro.summarizerOnlyCalls}`
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
  const rollouts = options.rollouts.map((filePath) => collectRollout(filePath, { codexHome: options.codexHome }));
  const microUsage = options.microUsage.map(collectMicroUsage);
  const summary = summarize(rollouts, microUsage);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ label: options.label, summary, rollouts, microUsage }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatSummary(options.label, summary, rollouts, microUsage)}\n`);
}

main();
