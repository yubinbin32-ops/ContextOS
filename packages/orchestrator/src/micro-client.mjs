import { reportMicroJob } from './micro-delivery.mjs';
import { receiveMicroMessages, waitForMicroMessages } from './micro-mailbox.mjs';
import { scheduleMicro } from './micro-scheduler.mjs';
import { microMutation } from './micro-worker.mjs';
import { normalizeAgentReport } from './micro-agent-report.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArtifact } from './artifact-store.mjs';
import { selectMicroProvider, microCostEstimate } from './micro-provider.mjs';
import { runCliMicro } from './micro-cli.mjs';
import { microPreloadPrompt, microPreloadReceipt } from './micro-preload.mjs';

const HOST_CONTINUATION_MS = 290_000;
const MICRO_SKILL_FILES = Object.freeze([
  ['ContextOS skill guidance', 'contextos/SKILL.md'],
  ['ContextOS operations skill guidance', 'contextos-ops/SKILL.md'],
]);
const microSkillGuidanceCache = new Map();

export function loadMicroSkillGuidance({ projectRoot = process.cwd(), includeOps = true } = {}) {
  const cacheKey = `${path.resolve(projectRoot)}::${includeOps ? 'all' : 'core'}`;
  const cached = microSkillGuidanceCache.get(cacheKey);
  if (cached) return cached;
  const roots = [...new Set([
    path.resolve(projectRoot, 'plugins/contextos/skills'),
    fileURLToPath(new URL('../../../plugins/contextos/skills/', import.meta.url)),
    fileURLToPath(new URL('../skills/', import.meta.url)),
  ])];
  for (const root of roots) {
    try {
      const files = includeOps ? MICRO_SKILL_FILES : MICRO_SKILL_FILES.slice(0, 1);
      const sections = files.map(([title, relative]) => {
        const file = path.join(root, relative);
        return `## ${title}\n\n${fs.readFileSync(file, 'utf8').trim()}`;
      });
      const guidance = `\n\n${sections.join('\n\n')}`;
      microSkillGuidanceCache.set(cacheKey, guidance);
      return guidance;
    } catch (_) {
      // Try the next source/bundle-relative skill root.
    }
  }
  throw new Error('ContextOS skill guidance is unavailable for Micro.');
}

export const MICRO_PRESETS = Object.freeze({
  triage: {
    name: 'triage',
    system: 'Extract the root cause and repair direction. Max 3 lines.',
    format: 'text',
  },
  contract: {
    name: 'contract',
    system: 'List API contracts, signatures, and data-flow duties only.',
    format: 'text',
  },
  patch: {
    name: 'patch',
    system: 'Output only the repaired code. No prose or markdown fences.',
    format: 'code',
  },
  graph: {
    name: 'graph',
    system: 'Return only {"blocks":[{"id","title","kind","summary","paths","symbols"}],"chains":[{"id","title","kind","summary","memberIds"}]}. Use stable curated semantic ids, repository-relative paths, and only evidence-backed ownership. Never emit mod-* ids, kind:"module", name/files/chain aliases, or invent a Block just to cover a file.',
    format: 'json',
  },
  custom: {
    name: 'custom',
    system: 'Return only the requested result. No preamble.',
    format: 'text',
  },
  evidence: {
    name: 'evidence',
    system: 'Return only JSON with shape {"answer":string,"evidenceRefs":array,"confidence":"low|medium|high","unknowns":array}. No prose outside JSON.',
    format: 'json',
  },
});

export const MICRO_OS_TOOLS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'os',
      description: 'Read bounded repository context. Batch independent files or ranges into one action whenever possible.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['inspect', 'search', 'context', 'artifact'],
            description: 'inspect paths, search symbols/text, read project context, or read a bounded artifact slice',
          },
          path: { type: 'string', description: 'Single file path relative to repository root' },
          artifactId: { type: 'string', description: 'Artifact id when action is artifact' },
          paths: {
            type: 'array',
            description: 'Multiple file paths to inspect in one bounded action',
            items: { type: 'string' },
          },
          globs: {
            type: 'array',
            description: 'Glob patterns to resolve and inspect in one bounded action',
            items: { type: 'string' },
          },
          symbol: { type: 'string', description: 'Optional symbol selector for inspect' },
          startLine: { type: 'number', description: 'Optional inclusive start line for inspect' },
          endLine: { type: 'number', description: 'Optional inclusive end line for inspect' },
          query: { type: 'string', description: 'Search query when action is search' },
          grep: { type: 'string', description: 'Case-insensitive regex or literal filter when action is artifact' },
          contextLines: { type: 'number', description: 'Artifact grep context lines, 0-5' },
          contextAction: {
            type: 'string',
            enum: ['brief', 'plan_list'],
            description: 'Context query when action is context',
          },
          ranges: {
            type: 'array',
            description: 'Optional line ranges for inspect',
            items: {
              type: 'object',
              properties: {
                startLine: { type: 'number' },
                endLine: { type: 'number' },
              },
              required: ['startLine', 'endLine'],
            },
          },
          budget: {
            type: 'string',
            enum: ['compact', 'full'],
            description: 'Use compact unless the full slice is required for the immediate decision',
          },
          maxChars: {
            type: 'number',
            description: 'Maximum characters (default 2500, hard cap 4000 unless budget is full)',
          },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run',
      description: 'Run one bounded repository command when command execution was explicitly allowed. Prefer a focused test, lint, build, git diff, or diagnostic command.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to run inside the repository root' },
          cwd: { type: 'string', description: 'Optional repository-relative working directory' },
          maxChars: { type: 'number', description: 'Maximum returned characters (default 2500, hard cap 4000)' },
          timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'block',
      description: 'Read curated semantic Blocks or bind supplied code paths to a curated Block. Never create mod-* or module Blocks. No file edits or deletes are available.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'open', 'search', 'bind_auto'] },
          id: { type: 'string' },
          title: { type: 'string' },
          kind: { type: 'string' },
          summary: { type: 'string' },
          details: { type: 'string' },
          query: { type: 'string' },
          path: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' } },
          symbols: { type: 'array', items: { type: 'string' } },
          limit: { type: 'number' },
          offset: { type: 'number' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'chain',
      description: 'Read curated Chains or add Blocks to a Chain. Composition is additive; replacing members and deleting Chains are unavailable.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'open', 'compose'] },
          id: { type: 'string' },
          title: { type: 'string' },
          kind: { type: 'string' },
          summary: { type: 'string' },
          memberIds: { type: 'array', items: { type: 'string' } },
          limit: { type: 'number' },
          offset: { type: 'number' },
        },
        required: ['action'],
      },
    },
  },
]);

const MICRO_INPUT_LIMITS = Object.freeze({
  triage: 6000,
  contract: 12000,
  patch: 16000,
  graph: 12000,
  custom: 8000,
  evidence: 12000,
});

// Answer mode bounds a Micro report, but the bound must not silently cut the
// report the host asked for. These caps are ceilings, not targets: the model
// stops when the report is complete, and a provider stop at the ceiling is
// surfaced as `providerTruncated` so the host can continue the session.
const MICRO_ANSWER_TOKENS = Object.freeze({
  triage: 1024,
  contract: 2048,
  patch: 4096,
  graph: 2048,
  custom: 3072,
  evidence: 3072,
});

const MICRO_PROVIDER_TOKEN_BUDGETS = Object.freeze({
  triage: 8000,
  contract: 16000,
  patch: 24000,
  graph: 16000,
  custom: 8000,
  evidence: 12000,
});

const MICRO_BATCH_DEFAULT_CONCURRENCY = 4;
const MICRO_UNEXECUTED_TOOL_SYNTAX = Object.freeze([
  /\uFF5C\s*｜DSML｜\s*\uFF5C/i,
  /<\/?(?:tool_call|function_call)\b/i,
  /<\|(?:tool_call|function_call)\|>/i,
]);

function hasUnexecutedToolSyntax(content) {
  const text = String(content || '');
  return MICRO_UNEXECUTED_TOOL_SYNTAX.some((pattern) => pattern.test(text));
}

function positiveNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveInteger(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

/**
 * Normalize the bounded Micro invocation contract while keeping the original
 * flat fields backwards compatible. Delivery controls host visibility only;
 * provider request/tool limits are separate and are enforced before dispatch.
 */
export function normalizeMicroInvocation(config = {}, options = {}, presetKey = 'custom', { hasPreload = false } = {}) {
  const invocation = options.invocation && typeof options.invocation === 'object'
    ? options.invocation
    : {};
  const provider = invocation.provider && typeof invocation.provider === 'object'
    ? invocation.provider
    : {};
  const evidence = invocation.evidence && typeof invocation.evidence === 'object'
    ? invocation.evidence
    : {};
  const tools = invocation.tools && typeof invocation.tools === 'object'
    ? invocation.tools
    : {};
  const requestedWithOS = options.withOS === true;
  const toolsEnabled = tools.enabled === undefined ? requestedWithOS : tools.enabled === true;
  const allowCommands = tools.allowCommands === true || invocation.allowCommands === true;
  const explicitMaxRequests = provider.maxRequests
    ?? invocation.maxRequests
    ?? options.maxRequests
    ?? config.maxRequests;
  const maxRequests = positiveInteger(explicitMaxRequests,
    hasPreload && !toolsEnabled ? 1 : null);
  const maxInputTokens = positiveInteger(
    provider.maxInputTokens
      ?? invocation.maxInputTokens
      ?? options.maxInputTokens
      ?? config.maxInputTokens,
    null,
  );
  const maxOutputTokens = positiveInteger(
    provider.maxOutputTokens
      ?? invocation.maxOutputTokens
      ?? options.maxOutputTokens
      ?? config.maxOutputTokens,
    null,
  );
  const maxSteps = positiveInteger(
    tools.maxSteps ?? invocation.maxSteps ?? options.maxSteps ?? config.maxSteps,
    null,
  );
  return {
    evidenceMode: hasPreload ? (evidence.mode || 'pipeline') : (evidence.mode || 'none'),
    evidenceCacheHit: Boolean(options.preload?.cacheHit),
    maxRequests,
    maxInputTokens,
    maxOutputTokens,
    toolsEnabled,
    allowCommands,
    maxSteps,
    shortCircuited: false,
  };
}

function normalizeUsage(usage = {}) {
  const promptTokens = Number(usage.prompt_tokens) || 0;
  const completionTokens = Number(usage.completion_tokens) || 0;
  const totalTokens = Number(usage.total_tokens) || promptTokens + completionTokens;
  // Providers report cache hits under different keys in the
  // OpenAI-compatible responses this client consumes. The split matters
  // because cached input is priced far below fresh input.
  const reportedCache = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens);
  const cachedTokens = Number.isFinite(reportedCache) && reportedCache > 0
    ? Math.min(reportedCache, promptTokens)
    : 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    cached_input_tokens: cachedTokens,
    uncached_input_tokens: Math.max(0, promptTokens - cachedTokens),
  };
}

function addUsage(target, usage) {
  const normalized = normalizeUsage(usage);
  target.prompt_tokens += normalized.prompt_tokens;
  target.completion_tokens += normalized.completion_tokens;
  target.total_tokens += normalized.total_tokens;
  target.cached_input_tokens = (Number(target.cached_input_tokens) || 0) + normalized.cached_input_tokens;
  target.uncached_input_tokens = (Number(target.uncached_input_tokens) || 0) + normalized.uncached_input_tokens;
}

export function estimateMicroTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.ceil(String(text).length / 4);
}

export function resolveMicroBudget(config = {}, options = {}) {
  const invocation = options.invocation && typeof options.invocation === 'object'
    ? options.invocation
    : {};
  const provider = invocation.provider && typeof invocation.provider === 'object'
    ? invocation.provider
    : {};
  const tools = invocation.tools && typeof invocation.tools === 'object'
    ? invocation.tools
    : {};
  const source = {
    ...config,
    ...options,
    ...provider,
  };
  return {
    // Provider token and time budgets are opt-in only. A default budget used to
    // abort a legitimate multi-step task mid-flight, so no implicit limit kills
    // a Micro run anymore. presetKey stays in the signature for callers that
    // still pass a preset name.
    maxProviderTokens: positiveNumber(source.maxProviderTokens, null),
    maxCostUsd: positiveNumber(source.maxCostUsd, null),
    inputUsdPerMillion: positiveNumber(source.inputUsdPerMillion, null),
    cacheUsdPerMillion: positiveNumber(source.cacheUsdPerMillion, null),
    outputUsdPerMillion: positiveNumber(source.outputUsdPerMillion, null),
  };
}

export function resolveChatCompletionsUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const clean = rawUrl.trim().replace(/\/+$/, '');
  if (clean.endsWith('/chat/completions')) {
    return clean;
  }
  return `${clean}/chat/completions`;
}

/**
 * Applies output budgeting to tool outputs.
 * Respects budget: 'full' and custom maxChars, with clean truncation hints.
 */
export function applyOutputBudget(text, args = {}, defaultLimit = 2500) {
  const str = String(text ?? '');
  const isFull = args.budget === 'full' || args.maxChars === Infinity;
  if (isFull) {
    return str;
  }
  const rawMaxChars = Number(args.maxChars);
  const limit = Number.isFinite(rawMaxChars) && rawMaxChars > 0
    ? Math.min(Math.floor(rawMaxChars), 4000)
    : defaultLimit;

  if (str.length <= limit) {
    return str;
  }
  const cut = str.slice(0, limit);
  const omitted = str.length - limit;
  return `${cut}\n... (+${omitted} chars truncated, specify budget: "full" or larger maxChars for full output)`;
}

function summarizeMicroToolOutput(value) {
  try {
    const parsed = JSON.parse(String(value));
    if (parsed?.error || parsed?.ok === false) {
      return { ok: false, error: String(parsed.error || 'OS tool reported failure').slice(0, 500) };
    }
    return { ok: true, error: null };
  } catch (_) {
    return { ok: true, error: null };
  }
}

export const MICRO_AGENT_TOOLS = [
  { type: 'function', function: { name: 'os', description: 'Bounded repository work through ContextOS. inspect: {path, ranges:[[first,last]]} or {paths:[...]}; search: {query}; context: {}; artifact: {id}; change: {edits:[...], verify:[...]}; verify: {commands:[...]}; work: {inspect:[...], change:{...}, verify:{...}}; pipeline: {steps:[...]} or {parallel:[...]} for batching independent reads, searches and commands in one round; command stdout is included inline, so do not fetch the command receipt again unless the result says truncated; each step accepts {tool:"ask",args:{inspect:[{path,ranges:[[first,last]]}]}}, {tool:"inspect",args:{...}} or {type:"inspect",...}. Prefer pipeline or work whenever you already know three or more operations; never issue one inspect per file. Micro cannot delegate to micro or CLI agents.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['inspect', 'search', 'context', 'artifact', 'explore', 'work', 'change', 'verify', 'pipeline'] }, args: { type: 'object', description: 'Action payload. pipeline uses steps or parallel; work batches inspect/change/verify; change edits files within allowedPaths.' } }, required: ['action', 'args'] } } },
  MICRO_OS_TOOLS.find((tool) => tool.function.name === 'run'),
];

const MICRO_READ_ONLY_TOOLS = new Set(['os', 'inspect', 'search_code', 'os_context', 'artifact']);

function canonicalMicroValue(value) {
  if (Array.isArray(value)) return value.map(canonicalMicroValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalMicroValue(value[key])]));
}

function microReadMemoKey(name, args) {
  if (!MICRO_READ_ONLY_TOOLS.has(name)) return null;
  if (name === 'os' && !['inspect', 'search', 'context', 'artifact'].includes(args?.action)) return null;
  return `${name}:${JSON.stringify(canonicalMicroValue(args || {}))}`;
}

function parseMicroRangeSpec(value) {
  const asRange = (start, end) => {
    const first = Number(start);
    const second = Number(end);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second) || first < 1 || second < first) return null;
    return [[first, second]];
  };
  if (typeof value === 'string') {
    const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
    if (!parts.length) return null;
    const parsed = [];
    for (const part of parts) {
      const match = /^L?\s*(\d+)\s*(?:-|:|\.\.|\s)\s*L?\s*(\d+)$/i.exec(part);
      const one = match ? asRange(match[1], match[2]) : null;
      if (!one) return null;
      parsed.push(one[0]);
    }
    return parsed;
  }
  if (Array.isArray(value)) {
    if (value.length === 2 && value.every((entry) => Number.isFinite(Number(entry)))) {
      return asRange(value[0], value[1]);
    }
    const parsed = [];
    for (const entry of value) {
      const one = Array.isArray(entry) && entry.length >= 2
        ? asRange(entry[0], entry[1])
        : (entry && typeof entry === 'object' ? asRange(entry.startLine ?? entry.start, entry.endLine ?? entry.end) : null);
      if (!one) return null;
      parsed.push(one[0]);
    }
    return parsed.length ? parsed : null;
  }
  if (value && typeof value === 'object') {
    return asRange(value.startLine ?? value.start, value.endLine ?? value.end);
  }
  return null;
}

function normalizeMicroInspectArgs(args = {}) {
  const out = { ...args };
  const hasRanges = Array.isArray(out.ranges) ? out.ranges.length > 0 : out.ranges !== undefined && out.ranges !== null;
  const raw = hasRanges ? out.ranges : (out.lines ?? out.range);
  if (raw !== undefined && raw !== null) {
    const parsed = parseMicroRangeSpec(raw);
    if (parsed) out.ranges = parsed;
    else if (!hasRanges) out.ranges = raw;
    delete out.lines;
    delete out.range;
  }
  return out;
}

function microPipelineSteps(input = {}) {
  if (Array.isArray(input.steps)) return input.steps;
  if (Array.isArray(input.flow)) return input.flow;
  if (Array.isArray(input.actions)) return input.actions;
  if (Array.isArray(input.parallel)) return [{ parallel: input.parallel }];
  if (Array.isArray(input.chain)) return [{ chain: input.chain }];
  return [];
}

function microPipelineScan(input = {}, visit) {
  const walk = (step) => {
    if (Array.isArray(step)) {
      for (const item of step) walk(item);
      return;
    }
    if (!step || typeof step !== 'object') return;
    visit(step);
    for (const key of ['steps', 'flow', 'actions', 'parallel', 'chain']) {
      if (Array.isArray(step[key])) walk(step[key]);
    }
  };
  for (const step of microPipelineSteps(input)) walk(step);
}

function microPipelineMutationTargets(input = {}) {
  const targets = [];
  microPipelineScan(input, (step) => {
    const candidates = [];
    if (step.change && typeof step.change === 'object') candidates.push(step.change);
    if (step.work && typeof step.work === 'object') candidates.push(step.work);
    if (step.tool === 'change' || step.tool === 'work') candidates.push(step.args || {});
    if (step.tool === 'ship' || step.ship) candidates.push(step.args || step);
    for (const candidate of candidates) {
      const action = step.tool === 'work' || step.work ? 'work' : 'change';
      if (microMutation(action, candidate)) targets.push(...microMutationTargets(candidate));
    }
  });
  return [...new Set(targets)];
}

function microPipelineNeedsCommands(input = {}) {
  let needed = false;
  microPipelineScan(input, (step) => {
    if (step.tool === 'verify' || step.verify) needed = true;
    if (step.tool === 'run' || step.run) needed = true;
    if (step.tool === 'ops' && step.args?.capability === 'run_command') needed = true;
    if (step.ops?.capability === 'run_command') needed = true;
    if (step.work && typeof step.work === 'object'
      && ['verify', 'command', 'commands'].some((key) => step.work[key] !== undefined)) needed = true;
  });
  return needed;
}

function microPipelineDelegates(input = {}) {
  let delegated = false;
  microPipelineScan(input, (step) => {
    if (['agent', 'micro', 'integrate'].includes(step.tool)) delegated = true;
    if (step.agent || step.micro || step.integrate) delegated = true;
    if (step.ops?.capability === 'micro' || step.ops?.capability === 'agent') delegated = true;
  });
  return delegated;
}

function microDispatchRoute(name, args = {}) {
  if (name === 'os') {
    if (['work', 'change', 'verify', 'explore'].includes(args.action)) {
      const { action, ...input } = args;
      return [action, input];
    }
    if (args.action === 'pipeline') {
      const { action: _action, ...pipelineArgs } = args;
      const hasExplicitOutputBudget = pipelineArgs.budget !== undefined
        || pipelineArgs.mode !== undefined
        || pipelineArgs.maxChars !== undefined;
      return ['pipeline', hasExplicitOutputBudget ? pipelineArgs : { ...pipelineArgs, full: true }];
    }
    if (args.action === 'search') {
      const { action: _action, ...searchArgs } = args;
      return ['ops', { capability: 'code', action: 'search', args: searchArgs }];
    }
    if (args.action === 'context') {
      const { action: _action, ...contextArgs } = args;
      return ['ops', { capability: 'os_context', action: 'brief', args: contextArgs }];
    }
    if (args.action === 'artifact') {
      const { action: _action, ...artifactArgs } = args;
      return ['ops', { capability: 'artifact', action: 'read', args: artifactArgs }];
    }
    const { action: _action, ...inspectArgs } = args;
    return ['inspect', inspectArgs];
  }
  if (name === 'inspect') return ['inspect', args];
  if (name === 'search_code') return ['ops', { capability: 'code', action: 'search', args }];
  if (name === 'os_context') {
    if (args.action === 'plan_list') return ['ops', { capability: 'plan', action: 'list', args }];
    return ['ops', { capability: 'os_context', action: 'brief', args }];
  }
  if (name === 'artifact') return ['ops', { capability: 'artifact', action: 'read', args }];
  return null;
}

function microMutationTargets(args = {}) {
  const list = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
  const collect = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    return [
      ...list(value.edits),
      ...list(value.create),
      ...list(value.delete),
      ...list(value.deletes),
      ...(value.path ? [value.path] : []),
      ...(value.change ? collect(value.change) : []),
      ...(value.work ? collect(value.work) : []),
    ];
  };
  return collect(args)
    .map((target) => typeof target === 'string' ? target : target?.path)
    .filter((target) => typeof target === 'string' && target.trim());
}

function microPathAllowed(target, projectRoot, allowedPaths = []) {
  const root = path.resolve(projectRoot || process.cwd());
  const absolute = path.resolve(root, target);
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) return false;
  return allowedPaths.some((entry) => {
    const raw = String(entry).replace(/\\/g, '/').replace(/^\.\//, '');
    const allowed = raw.replace(/\/+$/, '');
    return relative === allowed || (raw.endsWith('/') && relative.startsWith(`${allowed}/`));
  });
}

const MICRO_CONTINUATION_VERSION = 1;
const MICRO_FINGERPRINT_LIMIT = 2000;

function continuationStatePath(projectRoot, sessionId) {
  const id = crypto.createHash('sha256').update(String(sessionId || '')).digest('hex');
  return path.join(path.resolve(projectRoot), '.contextos', 'micro-session-context', `${id}.json`);
}

function readContinuationState(projectRoot, sessionId) {
  if (!sessionId) return null;
  try {
    const state = JSON.parse(fs.readFileSync(continuationStatePath(projectRoot, sessionId), 'utf8'));
    return state?.version === MICRO_CONTINUATION_VERSION ? state : null;
  } catch (_) {
    return null;
  }
}

function persistContinuationState(projectRoot, sessionId, options = {}) {
  if (!sessionId) return null;
  const hasHistory = Array.isArray(options.history) && options.history.length > 0;
  const hasContext = options.context && Object.keys(options.context).length > 0;
  const hasReusableState = Boolean(hasHistory || options.execution || hasContext);
  if (!hasReusableState) return null;
  const previous = readContinuationState(projectRoot, sessionId) || {};
  const tools = options.invocation?.tools;
  const state = {
    version: MICRO_CONTINUATION_VERSION,
    execution: options.execution || previous.execution || null,
    withOS: options.withOS === undefined ? Boolean(previous.withOS) : Boolean(options.withOS),
    context: {
      ...(previous.context || {}),
      ...(options.context || {}),
      ...(options.context?.allowedPaths ? { allowedPaths: options.context.allowedPaths } : {}),
      ...(options.context?.acceptance ? { acceptance: options.context.acceptance } : {}),
    },
    invocation: {
      ...(previous.invocation || {}),
      ...(tools ? { tools: { ...(previous.invocation?.tools || {}), ...tools } } : {}),
    },
  };
  try {
    const target = continuationStatePath(projectRoot, sessionId);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, target);
    return state;
  } catch (_) {
    return null;
  }
}

function hydrateContinuationState(projectRoot, options = {}) {
  const prior = readContinuationState(projectRoot, options.sessionId);
  if (!prior) return options;
  const context = {
    ...(prior.context || {}),
    ...(options.context || {}),
    ...(options.context?.allowedPaths ? { allowedPaths: options.context.allowedPaths } : {}),
    ...(options.context?.acceptance ? { acceptance: options.context.acceptance } : {}),
  };
  const tools = options.invocation?.tools || prior.invocation?.tools;
  return {
    ...options,
    ...(options.execution === undefined && prior.execution ? { execution: prior.execution } : {}),
    ...(options.withOS === undefined && prior.withOS !== undefined ? { withOS: prior.withOS } : {}),
    ...(Object.keys(context).length ? { context } : {}),
    ...(tools ? { invocation: { ...(prior.invocation || {}), ...(options.invocation || {}), tools } } : {}),
  };
}

function fingerprintFile(fullPath) {
  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) return null;
    return `${stat.size}:${crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex')}`;
  } catch (error) {
    return error.code === 'ENOENT' ? 'missing' : null;
  }
}

function fingerprintImplementationPaths(projectRoot, allowedPaths = []) {
  const root = path.resolve(projectRoot);
  const files = new Map();
  const visit = (absolute) => {
    if (files.size >= MICRO_FINGERPRINT_LIMIT) return;
    let stat;
    try { stat = fs.statSync(absolute); } catch (error) {
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      files.set(relative, 'missing');
      return;
    }
    if (stat.isDirectory()) {
      let entries = [];
      try { entries = fs.readdirSync(absolute, { withFileTypes: true }); } catch (_) { return; }
      for (const entry of entries) {
        if (['.git', '.contextos', 'node_modules'].includes(entry.name)) continue;
        visit(path.join(absolute, entry.name));
      }
      return;
    }
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    files.set(relative, fingerprintFile(absolute));
  };
  for (const entry of allowedPaths) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    const normalized = entry.replace(/\\/g, '/').replace(/^\.\//, '');
    if (/[*?\[]/.test(normalized)) {
      try {
        for (const match of fs.globSync(normalized, { cwd: root })) visit(path.resolve(root, match));
      } catch (_) {}
      continue;
    }
    visit(path.resolve(root, normalized));
  }
  return files;
}

function implementationDiff(before, after) {
  const changedPaths = new Set();
  for (const file of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(file) !== after.get(file)) changedPaths.add(file);
  }
  return { changed: changedPaths.size > 0, changedPaths: [...changedPaths].sort() };
}

function changeReceiptEvidence(result) {
  const text = typeof result === 'string' ? result : JSON.stringify(result || '');
  let applied = false;
  let receiptId = text.match(/\breceipt(?:\s+|[=:~-])([A-Za-z0-9._-]+)/i)?.[1] || null;
  const status = text.match(/status=(\{[^\n]+\})/)?.[1];
  if (status) {
    try {
      const parsed = JSON.parse(status);
      applied = parsed.operation === 'change' && parsed.changed === true
        && ['applied', 'verified'].includes(parsed.status);
    } catch (_) {}
  }
  if (!applied && /(?:^|\n)# ContextOS change[\s\S]*?\n- (?:created|edited|deleted) `/.test(text)) applied = true;
  if (!receiptId) receiptId = text.match(/\breceipt=(?:receipt-)?([A-Za-z0-9._-]+)/i)?.[1] || null;
  return { applied, receiptId };
}

function expandMicroInspectGlobs(projectRoot, globs = []) {
  const root = path.resolve(projectRoot || process.cwd());
  const matches = [];
  for (const pattern of Array.isArray(globs) ? globs : []) {
    if (typeof pattern !== 'string' || !pattern.trim()) continue;
    let found = [];
    try {
      found = fs.globSync(pattern.trim(), { cwd: root });
    } catch (_) {
      continue;
    }
    for (const candidate of found) {
      const relative = String(candidate).split(path.sep).join('/');
      if (!relative || relative.startsWith('.contextos/') || relative.startsWith('node_modules/') || relative.startsWith('.git/')) continue;
      const absolute = path.resolve(root, relative);
      if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) continue;
      try {
        if (fs.statSync(absolute).isFile()) matches.push(relative);
      } catch (_) {}
    }
  }
  return [...new Set(matches)].sort().slice(0, 30);
}

/**
 * Safely execute an OS tool called by the micro model.
 */
export async function executeMicroTool(name, rawArgs, { caps, projectRoot, dispatch, allowCommands = false, allowedPaths = [], reportJobId = null, agentJobId = null, execution = 'analyze', signal = null } = {}) {
  let args = {};
  if (typeof rawArgs === 'string') {
    try {
      args = JSON.parse(rawArgs);
    } catch (_) {
      args = {};
    }
  } else if (rawArgs && typeof rawArgs === 'object') {
    args = rawArgs;
  }
  if (name === 'os' && args.args && typeof args.args === 'object') args = { ...args.args, action: args.action };
  if ((name === 'os' && args.action === 'inspect') || name === 'inspect') args = normalizeMicroInspectArgs(args);

  try {
    if (name === 'os' && args.action === 'pipeline') {
      if (microPipelineDelegates(args)) return JSON.stringify({ error: 'Micro pipeline cannot delegate to micro, CLI agents, or integration.' });
      const pipelineTargets = microPipelineMutationTargets(args);
      if (pipelineTargets.length && execution !== 'implement') {
        return JSON.stringify({ error: 'Analysis tasks cannot run mutation steps inside a pipeline. Use os change directly for bounded edits.' });
      }
      if (pipelineTargets.length && !allowedPaths.length) {
        return JSON.stringify({ error: 'Implementation pipeline mutations require allowedPaths.' });
      }
      if (pipelineTargets.some((target) => !microPathAllowed(target, projectRoot, allowedPaths))) {
        return JSON.stringify({ error: `Change exceeds assigned allowedPaths: ${allowedPaths.join(', ')}` });
      }
      if (microPipelineNeedsCommands(args) && !allowCommands) {
        return JSON.stringify({ error: 'Pipeline verification commands require invocation.tools.allowCommands:true.' });
      }
    }
    if (name === 'os' && microMutation(args.action, args) && execution !== 'implement') return JSON.stringify({ error: 'Analysis tasks cannot edit files.' });
    if (name === 'messages') {
      if (!agentJobId) return JSON.stringify({ error: 'No assigned message channel.' });
      return JSON.stringify({ messages: await waitForMicroMessages(projectRoot, agentJobId, { waitMs: args.waitMs, signal }) });
    }
    if (name === 'os' && (args.action === 'verify' || ['work', 'change'].includes(args.action) && ['verify', 'command', 'commands'].some((key) => args[key] !== undefined)) && !allowCommands) {
      return JSON.stringify({ error: 'Verification commands require invocation.tools.allowCommands:true.' });
    }
    if (name === 'os' && microMutation(args.action, args) && execution === 'implement') {
      if (!allowedPaths.length) return JSON.stringify({ error: 'Implementation changes require allowedPaths.' });
      const targets = microMutationTargets(args);
      if (!targets.length || targets.some((target) => !microPathAllowed(target, projectRoot, allowedPaths))) {
        return JSON.stringify({ error: `Change exceeds assigned allowedPaths: ${allowedPaths.join(', ')}` });
      }
    }
    if (name === 'os' && microMutation(args.action, args) && !allowCommands) args.verify = [];
    if (name === 'report') {
      if (!reportJobId) return JSON.stringify({ error: 'No assigned report channel.' });
      return JSON.stringify(reportMicroJob(projectRoot, reportJobId, args.content));
    }
    if (name === 'run') {
      if (!allowCommands) {
        return JSON.stringify({ error: 'Micro run tool requires invocation.tools.allowCommands:true.' });
      }
      const command = String(args.command || '').trim();
      if (!command) return JSON.stringify({ error: 'Micro run tool requires a non-empty command.' });
      const runArgs = {
        command,
        ...(args.cwd ? { cwd: args.cwd } : {}),
        maxChars: Number.isFinite(Number(args.maxChars)) ? Number(args.maxChars) : 2500,
        timeoutMs: Number.isFinite(Number(args.timeoutMs)) ? Number(args.timeoutMs) : 60000,
        mode: 'summary',
      };
      if (dispatch) {
        const result = await dispatch('ops', {
          capability: 'run_command',
          action: 'run',
          args: runArgs,
        });
        return typeof result === 'string' ? result : JSON.stringify(result);
      }
      if (typeof caps?.run === 'function') {
        const res = await caps.run(runArgs);
        if (res?.ok) return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
        return JSON.stringify({ error: res?.error || 'Micro run command failed.' });
      }
      return JSON.stringify({ error: 'Run capability not available' });
    }
    if (dispatch && MICRO_READ_ONLY_TOOLS.has(name)) {
      const route = microDispatchRoute(name, args);
      if (route) {
        const result = await dispatch(route[0], route[1]);
        return typeof result === 'string' ? result : JSON.stringify(result);
      }
    }
    if (name === 'os') {
      const routedName = args.action === 'search'
        ? 'search_code'
        : (args.action === 'context' ? 'os_context' : (args.action === 'artifact' ? 'artifact' : 'inspect'));
      return executeMicroTool(routedName, args, { caps, projectRoot, dispatch });
    }
    switch (name) {
      case 'artifact': {
        const artifactId = args.artifactId || args.id;
        const artifact = readArtifact(projectRoot || process.cwd(), artifactId, {
          startLine: args.startLine,
          endLine: args.endLine,
          grep: args.grep,
          contextLines: args.contextLines,
          maxChars: args.maxChars,
        });
        if (!artifact) return JSON.stringify({ error: `Artifact not found: ${artifactId || '(missing)'}` });
        return applyOutputBudget(JSON.stringify({
          id: artifact.id,
          range: artifact.range,
          returnedLines: artifact.returnedLines,
          totalLines: artifact.totalLines,
          truncated: artifact.truncated,
          text: artifact.text,
        }), args, 2500);
      }

      case 'inspect': {
        const requestedGlobs = Array.isArray(args.globs) ? args.globs : [];
        const inspectArgs = { ...args };
        delete inspectArgs.action;
        delete inspectArgs.paths;
        delete inspectArgs.globs;
        const requestedPaths = [
          ...(Array.isArray(args.paths) ? args.paths : []),
          ...(args.path ? [args.path] : []),
          ...expandMicroInspectGlobs(projectRoot, requestedGlobs),
        ].filter((value) => typeof value === 'string' && value.trim()).slice(0, 30);

        const inspectOne = async (targetPath) => {
          const singleArgs = { ...inspectArgs, path: targetPath, dedupeReads: false };
          if (typeof caps?.inspect === 'function') {
            const res = await caps.inspect(singleArgs);
            if (typeof res === 'string') return res;
            if (res?.data != null) return res.data;
            if (res?.error != null) return JSON.stringify({ error: res.error });
            return JSON.stringify(res);
          }
          if (typeof caps?.code === 'function') {
            const res = await caps.code({ action: 'read', ...singleArgs });
            if (res?.ok) return res.data;
            if (res?.error) return JSON.stringify({ error: res.error });
          }
          const root = path.resolve(projectRoot || process.cwd());
          const fullPath = path.resolve(root, targetPath || '');
          const relative = path.relative(root, fullPath);
          if (relative.startsWith('..') || path.isAbsolute(relative)) {
            return JSON.stringify({ error: 'Micro inspect path must resolve inside the project root' });
          }
          if (!fs.existsSync(fullPath)) {
            return JSON.stringify({ error: `File not found: ${targetPath}` });
          }
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split(/\r?\n/);
          let extracted = content;
          if (Array.isArray(inspectArgs.ranges) && inspectArgs.ranges.length > 0) {
            const slices = [];
            for (const r of inspectArgs.ranges) {
              const start = Math.max(1, r.startLine || 1);
              const end = Math.min(lines.length, r.endLine || lines.length);
              slices.push(`[L${start}-L${end}]\n${lines.slice(start - 1, end).join('\n')}`);
            }
            extracted = slices.join('\n\n');
          }
          return extracted;
        };

        if (requestedPaths.length > 1 || requestedGlobs.length > 0) {
          const sections = [];
          for (const targetPath of requestedPaths) {
            sections.push(`### ${targetPath}\n${await inspectOne(targetPath)}`);
          }
          const text = sections.length
            ? sections.join('\n\n')
            : JSON.stringify({ error: 'No inspect targets matched.' });
          return applyOutputBudget(text, inspectArgs, 2500);
        }

        const text = await inspectOne(requestedPaths[0] || args.path || '');
        return applyOutputBudget(text, inspectArgs, 2500);
      }

      case 'search_code': {
        if (!caps?.code) {
          return JSON.stringify({ error: 'Search capability not available' });
        }
        const searchArgs = { action: 'search', query: args.query || '' };
        if (Array.isArray(args.globs) && args.globs.length > 0) searchArgs.globs = args.globs;
        if (Number.isFinite(Number(args.maxResults))) searchArgs.maxResults = Number(args.maxResults);
        const res = await caps.code(searchArgs);
        if (!res.ok) return JSON.stringify({ error: res.error });
        return applyOutputBudget(res.data, args, 2500);
      }

      case 'os_context': {
        const contextAction = args.contextAction || args.action;
        if (contextAction === 'plan_list') {
          if (!caps?.plan) return JSON.stringify({ error: 'Plan capability not available' });
          const res = await caps.plan({ action: 'list', format: 'json' });
          if (!res.ok) return JSON.stringify({ error: res.error });
          const dataStr = typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2);
          return applyOutputBudget(dataStr, args, 2500);
        }
        if (!caps?.osContext) {
          return JSON.stringify({ error: 'OS context capability not available' });
        }
        const res = await caps.osContext({ action: 'brief', format: 'markdown' });
        if (!res.ok) return JSON.stringify({ error: res.error });
        return applyOutputBudget(res.data, args, 2500);
      }

      case 'block': {
        if (!caps?.block) return JSON.stringify({ error: 'Block capability not available; set withOS:true for an assigned graph chore.' });
        const action = String(args.action || '');
        if (!['list', 'open', 'search', 'bind_auto'].includes(action)) {
          return JSON.stringify({ error: `Micro Block action is not allowed: ${action || '(missing)'}` });
        }
        const id = String(args.id || '').trim();
        if (action === 'bind_auto') {
          if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(id) || id.toLowerCase().startsWith('mod-')) {
            return JSON.stringify({ error: 'bind_auto requires a stable curated Block id; mod-* ids are reserved for navigation only.' });
          }
          if (!String(args.title || '').trim() || !String(args.summary || '').trim()) {
            return JSON.stringify({ error: 'bind_auto requires a meaningful curated Block title and summary.' });
          }
          const blockData = {
            id,
            title: String(args.title).trim().slice(0, 160),
            ...(typeof args.kind === 'string' ? { kind: args.kind.slice(0, 80) } : {}),
            summary: String(args.summary).trim().slice(0, 1200),
            ...(typeof args.details === 'string' ? { details: args.details.slice(0, 2000) } : {}),
          };
          if (String(args.kind || '').toLowerCase() === 'module') {
            return JSON.stringify({ error: 'Curated Micro Blocks cannot use kind=module.' });
          }
          const rawPaths = [
            ...(typeof args.path === 'string' ? [args.path] : []),
            ...(Array.isArray(args.paths) ? args.paths : []),
          ];
          if (rawPaths.some((value) => typeof value !== 'string')) {
            return JSON.stringify({ error: 'Every Block path must be a repository-relative string.' });
          }
          const paths = [...new Set(rawPaths)];
          if (!paths.length) return JSON.stringify({ error: 'bind_auto requires at least one repository-relative path.' });
          if (paths.length > 30) return JSON.stringify({ error: 'bind_auto accepts at most 30 paths per call.' });
          if (paths.some((value) => path.isAbsolute(value) || value.split(/[\\/]/).includes('..'))) {
            return JSON.stringify({ error: 'Block paths must stay inside the repository root.' });
          }
          if (Array.isArray(args.symbols) && args.symbols.some((value) => typeof value !== 'string')) {
            return JSON.stringify({ error: 'Every Block symbol must be a string.' });
          }
          const symbols = Array.isArray(args.symbols) ? args.symbols : [];
          if (symbols.length > 60) return JSON.stringify({ error: 'bind_auto accepts at most 60 symbol anchors per call.' });
          const res = await caps.block({ action, id, blockData, paths, symbols, format: 'json' });
          return applyOutputBudget(JSON.stringify(res.ok ? { ok: true, result: res.data } : { error: res.error }), args, 1200);
        }
        const res = await caps.block({
          action,
          ...(id ? { id } : {}),
          ...(typeof args.query === 'string' ? { query: args.query } : {}),
          ...(Number.isFinite(Number(args.limit)) ? { limit: Number(args.limit) } : {}),
          ...(Number.isFinite(Number(args.offset)) ? { offset: Number(args.offset) } : {}),
          includeRefs: false,
          format: 'json',
        });
        return applyOutputBudget(JSON.stringify(res.ok ? res.data : { error: res.error }), args, 2000);
      }

      case 'chain': {
        if (!caps?.chain) return JSON.stringify({ error: 'Chain capability not available; set withOS:true for an assigned graph chore.' });
        const action = String(args.action || '');
        if (!['list', 'open', 'compose'].includes(action)) {
          return JSON.stringify({ error: `Micro Chain action is not allowed: ${action || '(missing)'}` });
        }
        const id = String(args.id || '').trim();
        if (action === 'compose') {
          if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(id)) {
            return JSON.stringify({ error: 'compose requires a stable Chain id.' });
          }
          if (!String(args.title || '').trim()) {
            return JSON.stringify({ error: 'compose requires a meaningful Chain title.' });
          }
          if (!Array.isArray(args.memberIds) || args.memberIds.some((value) => typeof value !== 'string')) {
            return JSON.stringify({ error: 'compose requires memberIds as an array of curated Block ids.' });
          }
          if (args.memberIds.some((value) => !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value) || value.toLowerCase().startsWith('mod-'))) {
            return JSON.stringify({ error: 'Chain members must use valid curated Block ids; mod-* ids are navigation hints only.' });
          }
          const memberIds = [...new Set(args.memberIds)];
          if (!memberIds.length) return JSON.stringify({ error: 'compose requires curated Block memberIds.' });
          if (memberIds.length > 50) return JSON.stringify({ error: 'compose accepts at most 50 Block members per call.' });
          const chainData = {
            id,
            title: String(args.title).trim().slice(0, 160),
            ...(typeof args.kind === 'string' ? { kind: args.kind.slice(0, 80) } : {}),
            ...(typeof args.summary === 'string' ? { summary: args.summary.slice(0, 1200) } : {}),
            memberIds,
          };
          const res = await caps.chain({ action, chainData, format: 'json' });
          return applyOutputBudget(JSON.stringify(res.ok ? { ok: true, result: res.data } : { error: res.error }), args, 1200);
        }
        const res = await caps.chain({
          action,
          ...(id ? { id } : {}),
          ...(Number.isFinite(Number(args.limit)) ? { limit: Number(args.limit) } : {}),
          ...(Number.isFinite(Number(args.offset)) ? { offset: Number(args.offset) } : {}),
          includeMembers: false,
          format: 'json',
        });
        return applyOutputBudget(JSON.stringify(res.ok ? res.data : { error: res.error }), args, 1800);
      }

      default:
        return JSON.stringify({ error: `Unknown micro tool: ${name}` });
    }
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}

export function resolveMicroInput(options = {}, { projectRoot = process.cwd(), maxInputChars = 20000 } = {}) {
  const limit = Number.isFinite(maxInputChars) && maxInputChars > 0 ? Math.floor(maxInputChars) : 20000;
  const finish = (text, source) => {
    const value = String(text ?? '');
    const truncated = value.length > limit;
    return {
      input: truncated ? `${value.slice(0, limit)}\n[input truncated: ${value.length - limit} chars omitted]` : value,
      source,
      truncated,
    };
  };

  if (options.input !== undefined && options.input !== null) {
    return finish(options.input, 'inline');
  }

  const receiptId = options.inputReceipt;
  if (receiptId) {
    if (!/^[A-Za-z0-9._-]+$/.test(String(receiptId))) {
      throw new Error('Invalid micro input receipt id');
    }
    return finish(fs.readFileSync(path.join(projectRoot, '.contextos', 'logs', `${receiptId}.log`), 'utf8'), 'receipt');
  }

  const artifactId = options.inputArtifact || options.artifactId || options.artifact;
  if (artifactId) {
    const artifact = readArtifact(projectRoot, artifactId, {
      maxChars: limit,
      lineNumbers: false,
    });
    if (!artifact) throw new Error(`Micro input artifact not found: ${artifactId}`);
    const resolved = finish(artifact.text, 'artifact');
    return { ...resolved, truncated: resolved.truncated || artifact.truncated === true };
  }

  if (!options.inputRef) return { input: '', source: null, truncated: false };
  const fullPath = path.isAbsolute(options.inputRef)
    ? path.resolve(options.inputRef)
    : path.resolve(projectRoot, options.inputRef);
  const relative = path.relative(path.resolve(projectRoot), fullPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Micro inputRef must resolve inside the project root');
  }
  return finish(fs.readFileSync(fullPath, 'utf8'), 'inputRef');
}

async function sendMicroRequest(endpoint, payloadObj, headers, timeoutMs, maxResponseChars = 2_000_000, signal = null) {
  const payload = JSON.stringify(payloadObj);
  const responseLimit = positiveNumber(maxResponseChars, 2_000_000);
  const reqHeaders = {
    ...headers,
    'Content-Length': Buffer.byteLength(payload),
  };
  const transport = endpoint.protocol === 'http:' ? http : https;

  return new Promise((resolve) => {
    let settled = false;
    const abort = () => { req.destroy(); finish({ ok: false, error: 'Micro task cancelled; interrupted provider usage is unknown.' }); };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    const req = transport.request(
      endpoint,
      {
        method: 'POST',
        headers: reqHeaders,
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > responseLimit) {
            req.destroy();
            finish({
              ok: false,
              statusCode: res.statusCode,
              error: `Micro response exceeded maxResponseChars=${responseLimit}`,
            });
          }
        });
        res.on('end', () => {
          if (settled) return;
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch (e) {
            return finish({
              ok: false,
              statusCode: res.statusCode,
              error: `Invalid JSON response: ${body.slice(0, 300)}`,
            });
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            const errMsg = parsed?.error?.message || parsed?.error || `HTTP ${res.statusCode}`;
            return finish({
              ok: false,
              statusCode: res.statusCode,
              error: typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg),
            });
          }

          if (parsed.error) {
            const errMsg = parsed.error.message || parsed.error;
            return finish({
              ok: false,
              statusCode: res.statusCode,
              error: typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg),
            });
          }

          finish({
            ok: true,
            statusCode: res.statusCode,
            data: parsed,
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      finish({
        ok: false,
        errorCode: 'MICRO_REQUEST_TIMEOUT',
        error: `Micro task timed out after ${timeoutMs}ms`,
      });
    });

    req.on('error', (err) => {
      finish({
        ok: false,
        error: err.message,
      });
    });

    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    req.write(payload);
    req.end();
  });
}

/**
 * Execute a micro task against an OpenAI-compatible completion endpoint.
 * Supports optional withOS tool-calling loop (ReAct loop).
 *
 * @param {object} config Micro configuration { url, model, key, sessionHeader, maxTokens, timeoutMs, ... }
 * @param {object} options Task options { prompt, input, system, preset, maxTokens, temperature, thinking, sessionId, history, withOS, maxSteps, caps, projectRoot }
 * @returns {Promise<object>} Result { ok, content, reasoning, usage, durationMs, withOS?, steps?, toolCalls?, error? }
 */
export async function runMicroTask(config = {}, options = {}) {
  if (process.env.CONTEXTOS_DISABLE_MICRO === '1') return { ok: false, errorCode: 'MICRO_DISABLED', error: 'Micro execution is disabled; no provider request was sent.', durationMs: 0, providerUsage: null };
  const projectRoot = path.resolve(options.projectRoot || config.projectRoot || process.cwd());
  options = hydrateContinuationState(projectRoot, options);
  const route = selectMicroProvider(config, options);
  if (!route.ok) return { ok: false, errorCode: 'MICRO_PROVIDER_INVALID', error: route.error, providerUsage: null };
  const apiImplementation = route.provider === 'api' && options.execution === 'implement';
  const apiToolsEnabled = options.withOS === true || options.invocation?.tools?.enabled === true;
  const apiWorkspace = options.workspace ? path.resolve(options.workspace) : null;
  const failApi = (errorCode, error) => {
    const result = {
      ok: false,
      errorCode,
      error,
      durationMs: 0,
      providerUsage: null,
      invocation: { providerLaunches: 0, providerRequests: 0 },
    };
    if (options.agentJobId || options.reportFormat === 'structured') {
      result.agentReport = normalizeAgentReport({ answer: error }, { jobId: options.agentJobId || null, status: 'failed' });
    }
    return { ...microCostEstimate(result, config), provider: route.provider, routing: route };
  };
  if (apiImplementation) {
    if (!Array.isArray(options.context?.allowedPaths) || options.context.allowedPaths.length === 0) {
      return failApi('API_MICRO_IMPLEMENTATION_SCOPE_REQUIRED', 'API Micro implementation requires context.allowedPaths; keep the change bounded.');
    }
    if (!apiToolsEnabled) return failApi('API_MICRO_TOOLS_REQUIRED', 'API Micro implementation requires OS tools; enable withOS or invocation.tools.enabled.');
    if (!options.orchestrator?.dispatch) return failApi('API_MICRO_OS_DISPATCH_REQUIRED', 'API Micro implementation requires the host OS dispatcher.');
    if (apiWorkspace && apiWorkspace !== projectRoot) return failApi('API_MICRO_WORKSPACE_UNSUPPORTED', 'API Micro edits the project root directly; a separate CLI workspace is not supported.');
  }
  const selected = route.provider === 'cli' ? { ...config, maxProviderTokens: config.cli?.maxProviderTokens ?? (config.url ? undefined : config.maxProviderTokens), ...config.cli?.settings } : { ...config };
  // The caller selects the provider before dispatch; a failure never silently launches the other role.
  const result = await scheduleMicro({ ...options, maxConcurrency: options.maxConcurrency ?? config.maxConcurrency }, async () => {
    let launched = false;
    try {
      const preload = typeof options.preparePreload === 'function' ? await options.preparePreload() : options.preload;
      if (preload && (preload.ok === false || preload.truncated)) return {
        ok: false, errorCode: 'MICRO_PRELOAD_FAILED', error: preload.truncated ? 'Micro preload evidence was truncated; narrow the OS steps before dispatch.' : (preload.error || `Micro preload ended with ${preload.status}`),
        budgetExceeded: Boolean(preload.truncated), inputSource:'preload',
        providerUsage: null, usageSource:'unavailable', preload: microPreloadReceipt(preload), invocation: {providerLaunches:0},
      };
      launched = true;
      const execution = await runSelectedMicroTask(selected, { ...options, preload, provider: route.provider });
      if (!preload) return execution;
      return {
        ...execution,
        preload: microPreloadReceipt(preload),
        invocation: {
          ...execution.invocation,
          evidenceMode: 'pipeline',
          evidenceCacheHit: Boolean(preload.cacheHit),
          pipelineRuns: (Number(preload.pipelineRuns) || 0) + (Number(execution.invocation?.pipelineRuns) || 0),
        },
      };
    } catch (error) {
      return { ok: false, errorCode: launched ? 'MICRO_EXECUTION_FAILED' : 'MICRO_IMPLEMENTATION_SCOPE_REQUIRED', error: error.message, providerUsage: null, ...(launched ? { providerUsageComplete: false } : {}) };
    }
  });
  if (options.agentJobId || options.execution === 'implement' || options.reportFormat === 'structured') {
    result.agentReport = normalizeAgentReport({ ...(result.structured || {}), ...(typeof result.needsHost === 'boolean' ? { needsHost: result.needsHost } : {}), answer: result.structured?.answer ?? result.content ?? result.error }, { jobId: options.agentJobId || null, status: result.ok ? 'completed' : 'failed' });
    if (result.ok) {
      // An explicit `needsHost:false` from the worker is a real answer; only an
      // absent routing decision is treated as needing host attention.
      if (result.needsHost === undefined && !result.structured) result.agentReport.needsHost = true;
      result.needsHost = result.agentReport.needsHost;
    }
  }
  return { ...microCostEstimate(result, config), provider: route.provider, routing: route };
}

async function runSelectedMicroTask(config = {}, options = {}) {
  if (process.env.CONTEXTOS_DISABLE_MICRO === '1') {
    return { ok: false, errorCode: 'MICRO_DISABLED', error: 'Micro execution is disabled for this evaluation; no provider request was sent.', durationMs: 0, providerUsage: null };
  }
  if (options.provider || config.provider) {
    if (!['api', 'cli'].includes(options.provider || config.provider)) return { ok: false, errorCode: 'MICRO_PROVIDER_INVALID', error: 'Micro provider must be api or cli; no provider was called.' };
  }
  const start = Date.now();
  const requestedDelivery = ['immediate', 'defer', 'errors-only', 'auto'].includes(options.delivery)
    ? options.delivery
    : 'immediate';
  const prompt = String(options.prompt ?? options.task ?? '').trim();
  const preloadContext = options.preload && typeof options.preload === 'object' ? options.preload : null;
  const preloadText = microPreloadPrompt(preloadContext);

  if (preloadContext && (preloadContext.ok === false || preloadContext.truncated)) {
    return {
      ok: false,
      error: preloadContext.truncated
        ? 'Micro preload evidence was truncated; narrow the OS steps before dispatch.'
        : (preloadContext.error || 'Micro preload failed; no provider request was sent.'),
      durationMs: Date.now() - start,
      model: options.model || config.model || null,
      preset: options.preset || config.preset || null,
      usageSource: 'unavailable',
      providerUsage: null,
      estimatedUsage: null,
      inputSource: 'preload',
      delivery: requestedDelivery,
    };
  }

  if ((options.provider || config.provider) === 'cli') {
    const cliSkillGuidance = options.system ?? (
      config.cli?.osInvocation && config.cli?.injectSkillGuidance !== false
        ? loadMicroSkillGuidance({
          projectRoot: options.projectRoot || config.projectRoot || process.cwd(),
        })
        : undefined
    );
    const cliMaxInputChars = options.maxInputChars ?? config.maxInputChars ?? (cliSkillGuidance ? 32000 : 16000);
    const resolved = resolveMicroInput(options, {
      projectRoot: options.projectRoot || config.projectRoot || process.cwd(),
      maxInputChars: cliMaxInputChars,
    });
    return runCliMicro({ ...config, model: options.model || config.cli?.model || config.model }, { ...options, system: cliSkillGuidance, maxInputChars: cliMaxInputChars, resolvedInput: resolved.input,
      inputSource: resolved.source, inputTruncated: resolved.truncated, preloadText });
  }

  const urlStr = resolveChatCompletionsUrl(options.url || config.url);
  if (!urlStr) {
    return {
      ok: false,
      error: 'Micro URL is not configured. Please set micro.url in .contextos/profile.json',
      durationMs: Date.now() - start,
      delivery: requestedDelivery,
    };
  }

  const model = options.model || config.model;
  if (!model) {
    return {
      ok: false,
      error: 'Micro model is not configured. Please set micro.model in .contextos/profile.json',
      durationMs: Date.now() - start,
      delivery: requestedDelivery,
    };
  }

  let endpoint;
  try {
    endpoint = new URL(urlStr);
  } catch (err) {
    return {
      ok: false,
      error: `Invalid Micro URL: ${urlStr} (${err.message})`,
      durationMs: Date.now() - start,
      delivery: requestedDelivery,
    };
  }

  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    return {
      ok: false,
      error: `Unsupported Micro URL protocol: ${endpoint.protocol}`,
      durationMs: Date.now() - start,
      delivery: requestedDelivery,
    };
  }

  // Resolve preset
  const presetKey = options.preset || config.preset;
  const preset = presetKey && MICRO_PRESETS[presetKey] ? MICRO_PRESETS[presetKey] : null;
  const invocation = normalizeMicroInvocation(config, options, presetKey || 'custom', {
    hasPreload: Boolean(preloadContext),
  });
  invocation.pipelineRuns = 0;

  // Resolve system prompt: the ContextOS skill guidance is the sole background prompt.
  const skillGuidance = loadMicroSkillGuidance({
    projectRoot: options.projectRoot || config.projectRoot || process.cwd(),
  });
  const systemPrompt = skillGuidance;
  const resolvedInput = resolveMicroInput(options, {
    projectRoot: options.projectRoot || config.projectRoot || process.cwd(),
    maxInputChars: options.maxInputChars
      ?? config.maxInputChars
      ?? MICRO_INPUT_LIMITS[presetKey]
      ?? MICRO_INPUT_LIMITS.custom,
  });
  const manifest = options.context ? {
    objective: prompt ? 'Complete the current user task.' : (options.context.objective || ''),
    workspace: path.resolve(options.workspace || options.projectRoot || config.projectRoot || process.cwd()),
    execution: options.execution || 'analyze', allowedPaths: options.context.allowedPaths || [],
    acceptance: options.context.acceptance || [], constraints: options.context.constraints || [],
    state: options.context.state || null, baseRevision: options.context.baseRevision || null,
    evidence: options.context.evidence || [],
    ...(options.context.instructions ? { instructions: options.context.instructions } : {}),
  } : null;
  const manifestText = manifest ? `Task manifest: ${JSON.stringify(manifest)}\nComplete only this assignment. Injected source/preload is already available: do not reread unchanged covered ranges. Fetch only named missing or changed evidence. OS call: os({action:"work",args:{inspect:[{path,ranges:[[first,last]]}]}}); use os action "change" for bounded edits and "verify" or the run tool for commands when allowed. Code changes must go through change. Stay within allowedPaths. Do not delegate again. Return JSON with summary, changes, checks (actual outcomes), blockers, question, needsHost; omit execution history.` : '';
  if (manifest && (resolvedInput.truncated || (manifestText.length + prompt.length + resolvedInput.input.length + preloadText.length) > (options.maxInputChars ?? config.maxInputChars ?? 16000))) return {
    ok: false, errorCode: resolvedInput.truncated ? 'MICRO_INPUT_TRUNCATED' : 'MICRO_CONTEXT_TOO_LARGE',
    error: 'The task context is incomplete or exceeds its limit; narrow the evidence before dispatch.',
    durationMs: Date.now() - start, providerUsage: null,
  };
  const inputSource = resolvedInput.source || (prompt ? 'task' : (preloadText ? 'preload' : 'none'));
  const preloadMeta = preloadContext
    ? {
        status: preloadContext.status || 'UNKNOWN',
        artifactId: preloadContext.artifactId || null,
        chars: preloadText.length,
        evidenceChars: Number(preloadContext.chars) || preloadText.length,
        fullChars: Number(preloadContext.fullChars) || preloadText.length,
        cacheHit: Boolean(preloadContext.cacheHit),
        pipelineRuns: Number(preloadContext.pipelineRuns) || 0,
        truncated: Boolean(preloadContext.truncated),
      }
    : null;
  const requireBulkInput = options.requireBulkInput ?? config.requireBulkInput ?? false;
  const allowBoundedOS = Boolean(invocation.toolsEnabled && (options.caps || options.projectRoot));
  if (requireBulkInput && !['inputRef', 'inputArtifact', 'inputReceipt'].includes(resolvedInput.source) && !preloadText && !allowBoundedOS) {
    return {
      ok: false,
      error: 'Micro requires inputRef, inputArtifact, or inputReceipt for this configuration. Do not inline the bulk input or pass only a task string.',
      durationMs: Date.now() - start,
      model,
      preset: presetKey || null,
      inputSource,
      delivery: requestedDelivery,
    };
  }

  const defaultInputInstruction = {
    triage: 'Analyze the following input and return the root cause and repair direction in max 3 lines.',
    contract: 'Extract the API contracts, signatures, and data-flow duties from the following input.',
    patch: 'Return only the repaired code for the following input.',
    graph: 'Return the requested graph JSON for the following input.',
    evidence: 'Analyze the following input and return only the requested evidence JSON.',
    custom: 'Analyze the following input and return only the requested result.',
  }[presetKey] || 'Analyze the following input and return only the requested result.';
  const effectivePrompt = prompt || (resolvedInput.input ? defaultInputInstruction : '');
  const withOS = Boolean(invocation.toolsEnabled && (options.caps || options.projectRoot));
  const effectiveSystemPrompt = systemPrompt;

  // Resolve messages
  let messages = [];
  if (Array.isArray(options.history) && options.history.length > 0) {
    messages = [...options.history];
    if (effectiveSystemPrompt && !messages.some((m) => m.role === 'system')) {
      messages.unshift({ role: 'system', content: effectiveSystemPrompt });
    }
    if (preloadText) messages.push({ role: 'system', content: preloadText });
    if (effectivePrompt || resolvedInput.input) {
      const userContent = effectivePrompt
        ? (resolvedInput.input ? `${effectivePrompt}\n\n<INPUT>\n${resolvedInput.input}\n</INPUT>` : effectivePrompt)
        : String(resolvedInput.input || '');
      messages.push({ role: 'user', content: userContent });
    }
  } else {
    if (effectiveSystemPrompt) {
      messages.push({ role: 'system', content: effectiveSystemPrompt });
    }
    if (preloadText) messages.push({ role: 'system', content: preloadText });
    const userContent = effectivePrompt
      ? (resolvedInput.input ? `${effectivePrompt}\n\n<INPUT>\n${resolvedInput.input}\n</INPUT>` : effectivePrompt)
      : String(resolvedInput.input ?? '');
    if (userContent || !preloadText) messages.push({ role: 'user', content: userContent });
  }

  if (manifestText) messages.push({ role: 'system', content: manifestText });

  // Parameters
  const rawMaxTokens = invocation.maxOutputTokens ?? options.maxTokens ?? config.maxTokens ?? null;
  const answerTokenCeiling = Number(rawMaxTokens) > 0
    ? Number(rawMaxTokens)
    : (MICRO_ANSWER_TOKENS[presetKey] || 3072);
  const maxTokens = options.outputMode === 'answer' ? answerTokenCeiling : rawMaxTokens;
  const temperature = options.temperature ?? config.temperature ?? 0.1;
  const thinking = options.thinking ?? config.thinking ?? 'low';
  const timeoutMs = options.timeoutMs ?? config.timeoutMs ?? 86_400_000;
  const taskTimeoutMs = positiveNumber(options.taskTimeoutMs ?? config.taskTimeoutMs, HOST_CONTINUATION_MS);
  const budget = resolveMicroBudget(config, options, presetKey || 'custom');

  // Headers
  const apiKey = options.key || config.key;
  const headers = {
    'Content-Type': 'application/json',
    ...(config.headers || {}),
    ...(options.headers || {}),
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const sessionHeader = options.sessionHeader || config.sessionHeader || 'x-opencode-session';
  const sessionId = options.sessionId
    || (Array.isArray(options.history) && options.history.length > 0 ? config.sessionId : null)
    || `sess-micro-${crypto.randomUUID()}`;
  headers[sessionHeader] = sessionId;
  persistContinuationState(options.projectRoot || process.cwd(), sessionId, options);
  const implementationBefore = options.execution === 'implement'
    ? fingerprintImplementationPaths(options.projectRoot, options.context?.allowedPaths || [])
    : null;

  // Tool calling setup
  const rawMaxSteps = Number(invocation.maxSteps);
  const maxSteps = withOS
    ? (Number.isFinite(rawMaxSteps) && rawMaxSteps > 0
        ? Math.floor(rawMaxSteps)
        : Infinity)
    : 1;

  const tools = withOS
    ? (options.tools ? [...options.tools] : (options.toolSurface === 'legacy' ? MICRO_OS_TOOLS : MICRO_AGENT_TOOLS).filter((tool) => (
        tool.function?.name !== 'run' || invocation.allowCommands
      )))
    : undefined;
  if (tools && (options.reportJobId || options.agentJobId)) tools.push({ type: 'function', function: { name: 'report', description: 'Report a material finding or blocker to the host on its next OS call. Skip routine progress.', parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } } });
  if (tools && options.agentJobId) tools.push({ type: 'function', function: { name: 'messages', description: 'After reporting a question, wait locally for a host reply without model polling. Regular OS results already include new messages.', parameters: { type: 'object', properties: { waitMs: { type: 'number', description: 'Optional reply wait, up to 60000ms.' } } } } });
  const toolExecutionTrace = [];
  let step = 0;
  let aggregatedUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_input_tokens: 0, uncached_input_tokens: 0 };
  let aggregatedCostUsd = 0;
  const providerUsageTotals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_input_tokens: 0, uncached_input_tokens: 0 };
  const estimatedUsageTotals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_input_tokens: 0, uncached_input_tokens: 0 };
  let providerUsageCalls = 0;
  let estimatedUsageCalls = 0;
  let deduplicatedToolCallCount = 0;
  let providerRequestCount = 0;
  let finalChoice = null;
  let lastFinishReason = null;
  let lastReasoning = '';

  const estimateRequestCost = (promptTokens, outputTokens, cachedTokens = 0) => {
    const inputRate = budget.inputUsdPerMillion || 0;
    const outputRate = budget.outputUsdPerMillion || 0;
    if (!inputRate && !outputRate) return 0;
    const cacheRate = budget.cacheUsdPerMillion ?? inputRate;
    const prompt = Math.max(0, Number(promptTokens) || 0);
    const cached = Math.min(Math.max(0, Number(cachedTokens) || 0), prompt);
    const uncached = prompt - cached;
    return (uncached * inputRate + cached * cacheRate + (Number(outputTokens) || 0) * outputRate) / 1_000_000;
  };
  const costSummary = () => ({
    estimatedUsd: Number(aggregatedCostUsd.toFixed(6)),
    pricingConfigured: Boolean(budget.inputUsdPerMillion || budget.outputUsdPerMillion),
    inputUsdPerMillion: budget.inputUsdPerMillion || null,
    cacheUsdPerMillion: budget.cacheUsdPerMillion ?? null,
    outputUsdPerMillion: budget.outputUsdPerMillion || null,
  });
  const usageDetails = () => ({
    usage: aggregatedUsage,
    providerUsage: providerUsageCalls ? { ...providerUsageTotals } : null,
    estimatedUsage: estimatedUsageCalls ? { ...estimatedUsageTotals } : null,
    usageSource: providerUsageCalls && estimatedUsageCalls
      ? 'mixed'
      : providerUsageCalls
        ? 'provider'
        : estimatedUsageCalls
          ? 'estimated'
          : 'unavailable',
    providerUsageCalls,
    estimatedUsageCalls,
    deduplicatedToolCallCount,
    providerRequests: providerRequestCount,
  });
  const recordResponseUsage = (reportedUsage, fallbackUsage) => {
    const hasProviderUsage = Boolean(reportedUsage
      && typeof reportedUsage === 'object'
      && ['prompt_tokens', 'completion_tokens', 'total_tokens'].some((key) => (
        reportedUsage[key] !== undefined
        && reportedUsage[key] !== null
        && reportedUsage[key] !== ''
        && Number.isFinite(Number(reportedUsage[key]))
        && Number(reportedUsage[key]) >= 0
      )));
    const effectiveUsage = hasProviderUsage ? reportedUsage : fallbackUsage;
    addUsage(aggregatedUsage, effectiveUsage);
    if (hasProviderUsage) {
      addUsage(providerUsageTotals, reportedUsage);
      providerUsageCalls += 1;
    } else {
      addUsage(estimatedUsageTotals, fallbackUsage);
      estimatedUsageCalls += 1;
    }
    aggregatedCostUsd += estimateRequestCost(
      effectiveUsage.prompt_tokens || 0,
      effectiveUsage.completion_tokens || 0,
      normalizeUsage(effectiveUsage).cached_input_tokens
    );
    return effectiveUsage;
  };

  const continuationFailure = (reason) => {
    const partialContent = String(finalChoice?.message?.content || lastReasoning || '').trim();
    const guidance = `Continue with micro({sessionAction:"send", sessionId:"${sessionId}", task:"Continue the previous task from its partial state."}) to refresh the 290s window.`;
    return {
      ok: false,
      status: 'partial',
      partial: true,
      errorCode: 'MICRO_CONTINUATION_REQUIRED',
      error: `Micro reached the host continuation window after ${Date.now() - start}ms (${reason}); partial work is retained.`,
      content: partialContent,
      guidance,
      resume: { kind: 'micro', action: 'send', sessionId },
      durationMs: Date.now() - start,
      steps: step,
      toolCalls: toolExecutionTrace,
      ...usageDetails(),
      cost: costSummary(),
      budget,
      preload: preloadMeta,
      invocation: {
        ...invocation,
        providerRequests: providerRequestCount,
        toolRounds: step,
        shortCircuited: true,
        shortCircuitReason: 'continuation',
      },
      delivery: requestedDelivery,
      withOS,
      executionMode: withOS ? (toolExecutionTrace.length > 0 ? 'executor' : 'executor-idle') : 'summarizer-only',
      summarizerOnly: !withOS,
      sessionId,
      sessionMode: options.sessionMode || 'isolated',
      model,
      preset: presetKey || null,
      inputSource,
      inputTruncated: resolvedInput.truncated,
    };
  };

  const budgetFailure = (kind, projected, limit) => ({
    ok: false,
    error: kind === 'cost'
      ? `Micro provider cost budget exceeded (projected $${projected.toFixed(6)} > $${limit.toFixed(6)}).`
      : kind === 'requests'
        ? `Micro provider request budget exceeded (projected ${projected} > ${limit}).`
        : kind === 'inputTokens'
          ? `Micro provider input budget exceeded (projected ${projected} > ${limit}).`
          : `Micro provider token budget exceeded (projected ${projected} > ${limit}).`,
    partial: true,
    guidance: 'Partial findings are included in steps and toolCalls. Reuse them or raise the budget for the same task; do not repeat the work from scratch.',
    durationMs: Date.now() - start,
    steps: step,
    toolCalls: toolExecutionTrace,
    ...usageDetails(),
    cost: costSummary(),
    budget,
    preload: preloadMeta,
    invocation: {
      ...invocation,
      providerRequests: providerRequestCount,
      toolRounds: step,
      shortCircuited: true,
      shortCircuitReason: kind,
    },
    delivery: requestedDelivery,
    withOS,
    executionMode: withOS ? (toolExecutionTrace.length > 0 ? 'executor' : 'executor-idle') : 'summarizer-only',
    summarizerOnly: !withOS,
    budgetExceeded: kind,
    budgetDecision: {
      action: kind === 'requests'
        ? 'narrow_or_raise_requests'
        : kind === 'inputTokens'
          ? 'narrow_or_raise_input'
          : kind === 'cost'
            ? 'narrow_or_raise_cost'
            : 'narrow_or_raise_provider_tokens',
      retrySafe: false,
      projected: Number(projected),
      limit: Number(limit),
      deficit: Math.max(0, Number(projected) - Number(limit)),
    },
    hint: kind === 'cost'
      ? `Raise maxCostUsd above $${Number(projected).toFixed(6)} or narrow the input before retrying.`
      : kind === 'requests'
        ? `Raise maxRequests above ${limit} only when a multi-step provider route is intentional; otherwise narrow the input.`
        : kind === 'inputTokens'
          ? `Raise maxInputTokens above ${limit} only when the evidence is necessary; otherwise narrow the preload/input.`
          : `Raise maxProviderTokens to at least ${Math.ceil(Number(projected) * 1.2)} or narrow the preload/input before retrying.`,
  });

  const gateRequest = (promptTokens, outputTokens, { bypassRequestLimit = false } = {}) => {
    if (Date.now() - start >= taskTimeoutMs) return continuationFailure('elapsed');
    if (invocation.maxInputTokens && promptTokens > invocation.maxInputTokens) {
      return budgetFailure('inputTokens', promptTokens, invocation.maxInputTokens);
    }
    if (!bypassRequestLimit && invocation.maxRequests && providerRequestCount >= invocation.maxRequests) {
      return budgetFailure('requests', providerRequestCount + 1, invocation.maxRequests);
    }
    return null;
  };

  const sendRequest = async (payload, promptTokens, outputTokens, { bypassRequestLimit = false } = {}) => {
    const rejected = gateRequest(promptTokens, outputTokens, { bypassRequestLimit });
    if (rejected) return { rejected };
    providerRequestCount += 1;
    return { response: await sendMicroRequest(endpoint, payload, headers, Math.max(1, Math.min(timeoutMs, taskTimeoutMs - (Date.now() - start))), options.maxResponseChars ?? config.maxResponseChars, options.signal) };
  };

  const readToolResults = new Map();

  while (true) {
    const projectedPromptTokens = estimateMicroTokens(messages);
    const projectedOutputTokens = Number(maxTokens) || 0;
    const inputRejected = gateRequest(projectedPromptTokens, projectedOutputTokens);
    if (inputRejected) return inputRejected;
    const projectedTotalTokens = aggregatedUsage.total_tokens + projectedPromptTokens + projectedOutputTokens;
    const projectedCostUsd = aggregatedCostUsd + estimateRequestCost(projectedPromptTokens, projectedOutputTokens);
    if (budget.maxProviderTokens && projectedTotalTokens > budget.maxProviderTokens) {
      return budgetFailure('providerTokens', projectedTotalTokens, budget.maxProviderTokens);
    }
    if (budget.maxCostUsd && projectedCostUsd > budget.maxCostUsd) {
      return budgetFailure('cost', projectedCostUsd, budget.maxCostUsd);
    }

    const payloadObj = {
      model,
      messages,
      ...(Number(maxTokens) > 0 ? { max_tokens: Math.floor(Number(maxTokens)) } : {}),
      temperature,
    };

    if (thinking && thinking !== 'none') {
      payloadObj.reasoning_effort = thinking;
    }

    if (tools && tools.length > 0) {
      payloadObj.tools = tools;
    }

    const sent = await sendRequest(payloadObj, projectedPromptTokens, projectedOutputTokens);
    if (sent.rejected) return sent.rejected;
    const res = sent.response;
    if (!res.ok) {
      if (res.errorCode === 'MICRO_REQUEST_TIMEOUT') return continuationFailure('provider-request');
      const resError = res.error;
      return {
        ok: false,
        statusCode: res.statusCode,
        error: resError,
        providerUsageComplete: false,
        durationMs: Date.now() - start,
        steps: step,
        toolCalls: toolExecutionTrace,
        ...usageDetails(),
        cost: costSummary(),
        invocation: {
          ...invocation,
          providerRequests: providerRequestCount,
          toolRounds: step,
          shortCircuited: false,
        },
        delivery: requestedDelivery,
        withOS,
        executionMode: withOS ? (toolExecutionTrace.length > 0 ? 'executor' : 'executor-idle') : 'summarizer-only',
        summarizerOnly: !withOS,
      };
    }

    const data = res.data;
    const choice = data.choices?.[0];
    recordResponseUsage(data.usage, {
      prompt_tokens: projectedPromptTokens,
      completion_tokens: estimateMicroTokens(choice?.message?.content || ''),
    });

    finalChoice = choice;
    if (choice?.finish_reason) lastFinishReason = choice.finish_reason;
    if (choice?.message?.reasoning_content) {
      lastReasoning = choice.message.reasoning_content;
    }

    const toolCalls = choice?.message?.tool_calls;
    if (withOS && Array.isArray(toolCalls) && toolCalls.length > 0) {
      if (step >= maxSteps) {
        // Step safety limit reached, feed limit notices and request final convergence without tools
        messages.push(choice.message);
        for (const call of toolCalls) {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({
              notice: 'Maximum tool execution steps limit reached. Please summarize and provide your final response now.',
            }),
          });
        }
        const finalPromptTokens = estimateMicroTokens(messages);
        const finalOutputTokens = Number(maxTokens) || 0;
        const finalInputRejected = gateRequest(finalPromptTokens, finalOutputTokens);
        if (finalInputRejected) return finalInputRejected;
        const finalProjectedTotal = aggregatedUsage.total_tokens + finalPromptTokens + finalOutputTokens;
        const finalProjectedCost = aggregatedCostUsd + estimateRequestCost(finalPromptTokens, finalOutputTokens);
        if (budget.maxProviderTokens && finalProjectedTotal > budget.maxProviderTokens) {
          return budgetFailure('providerTokens', finalProjectedTotal, budget.maxProviderTokens);
        }
        if (budget.maxCostUsd && finalProjectedCost > budget.maxCostUsd) {
          return budgetFailure('cost', finalProjectedCost, budget.maxCostUsd);
        }

        const finalRequest = await sendRequest({
          model,
          messages,
          ...(Number(maxTokens) > 0 ? { max_tokens: Math.floor(Number(maxTokens)) } : {}),
          temperature,
          reasoning_effort: 'none',
        }, finalPromptTokens, finalOutputTokens);
        if (finalRequest.rejected) return finalRequest.rejected;
        const finalRes = finalRequest.response;
        if (finalRes.ok && finalRes.data?.choices?.[0]) {
          finalChoice = finalRes.data.choices[0];
          if (finalChoice?.finish_reason) lastFinishReason = finalChoice.finish_reason;
          recordResponseUsage(finalRes.data.usage, {
            prompt_tokens: estimateMicroTokens(messages),
            completion_tokens: estimateMicroTokens(finalChoice.message?.content || ''),
          });
          if (finalChoice.message?.reasoning_content) {
            lastReasoning = finalChoice.message.reasoning_content;
          }
          if (budget.maxProviderTokens && aggregatedUsage.total_tokens > budget.maxProviderTokens) {
            return budgetFailure('providerTokens', aggregatedUsage.total_tokens, budget.maxProviderTokens);
          }
          if (budget.maxCostUsd && aggregatedCostUsd > budget.maxCostUsd) {
            return budgetFailure('cost', aggregatedCostUsd, budget.maxCostUsd);
          }
        } else if (!finalRes.ok) {
          return {
            ok: false,
            statusCode: finalRes.statusCode,
            error: finalRes.error,
            durationMs: Date.now() - start,
            steps: step,
            toolCalls: toolExecutionTrace,
            ...usageDetails(),
            delivery: requestedDelivery,
          };
        }
        break;
      }

      step += 1;
      // Append assistant message with tool calls
      messages.push(choice.message);

      // Execute each tool and append tool result
      for (const call of toolCalls) {
        const toolName = call.function?.name;
        const toolArgs = call.function?.arguments;
        let parsedToolArgs = {};
        try {
          parsedToolArgs = typeof toolArgs === 'string' ? JSON.parse(toolArgs) : (toolArgs || {});
        } catch (_) {}
        const osArgs = parsedToolArgs.args || parsedToolArgs;
        const mutationCall = toolName === 'os' && (microMutation(parsedToolArgs.action, osArgs)
          || parsedToolArgs.action === 'pipeline' && microPipelineMutationTargets(osArgs).length > 0);
        const memoKey = microReadMemoKey(toolName, parsedToolArgs);
        const pipelineToolCall = toolName === 'os'
          && (parsedToolArgs.action ?? parsedToolArgs.args?.action) === 'pipeline';
        let deduplicated = false;
        let resultStr;
        if (memoKey && readToolResults.has(memoKey)) {
          deduplicated = true;
          deduplicatedToolCallCount += 1;
          resultStr = JSON.stringify({
            ok: true,
            deduplicated: true,
            reuse: 'The same bounded read already ran in this Micro turn; use the earlier tool result.',
          });
        } else {
          resultStr = await executeMicroTool(toolName, toolArgs, {
            caps: options.caps,
            projectRoot: options.projectRoot,
            dispatch: options.orchestrator ? options.orchestrator.dispatch.bind(options.orchestrator) : undefined,
            allowCommands: invocation.allowCommands,
            allowedPaths: options.context?.allowedPaths || [],
            reportJobId: options.reportJobId || options.agentJobId,
            agentJobId: options.agentJobId,
            execution: options.execution,
            signal: options.signal,
          });
          const osArgs = parsedToolArgs.args || parsedToolArgs;
          if (toolName === 'run' || toolName === 'os' && (microMutation(parsedToolArgs.action, osArgs)
            || parsedToolArgs.action === 'verify' || parsedToolArgs.action === 'work' && ['verify', 'command', 'commands'].some((key) => osArgs[key] !== undefined))) readToolResults.clear();
          if (memoKey) readToolResults.set(memoKey, resultStr);
        }
        if (options.agentJobId && toolName !== 'messages') {
          try {
            const messages = receiveMicroMessages(options.projectRoot, options.agentJobId);
            if (messages.length) {
              try { resultStr = JSON.stringify({ ...JSON.parse(resultStr), microMessages: messages }); }
              catch { resultStr = JSON.stringify({ result: resultStr, microMessages: messages }); }
            }
          } catch {} // Preserve the action receipt when only mailbox access fails.
        }
        const resultStatus = summarizeMicroToolOutput(resultStr);
        const receipt = mutationCall ? changeReceiptEvidence(resultStr) : null;
        if (pipelineToolCall && resultStatus.ok !== false) {
          invocation.pipelineRuns = (Number(invocation.pipelineRuns) || 0) + 1;
        }
        toolExecutionTrace.push({
          id: call.id,
          name: toolName,
          arguments: toolArgs,
          preview: resultStr.slice(0, 150),
          ...(deduplicated ? { deduplicated: true } : {}),
          ...(mutationCall ? { mutation: true, applied: receipt?.applied === true, ...(receipt?.receiptId ? { changeReceiptId: receipt.receiptId } : {}) } : {}),
          ...resultStatus,
        });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: resultStr,
        });
      }
      continue;
    }

    // Done (no tool calls, or maxSteps reached)
    break;
  }

  let content = String(finalChoice?.message?.content ?? '').trim();
  const providerFinishReason = finalChoice?.finish_reason || lastFinishReason || null;
  const providerTruncated = ['length', 'max_tokens', 'max_output_tokens']
    .includes(String(providerFinishReason || '').toLowerCase());
  let fallbackError = null;
  let invalidOutputReason = !content
    ? 'empty'
    : (!withOS && hasUnexecutedToolSyntax(content) ? 'tool_call_syntax' : null);
  const providerHost = (() => {
    try {
      return new URL(endpoint).host;
    } catch (_) {
      return null;
    }
  })();

  if (invalidOutputReason) {
    content = '';
    const retryInstruction = invalidOutputReason === 'tool_call_syntax'
      ? 'Your previous response contained tool-call syntax, but no tools are available in this run. Return only the final requested result in plain text. Do not emit tool calls, function-call syntax, XML tool tags, or a plan to inspect files.'
      : 'Return only the final requested result now. Do not include reasoning, tool calls, or extra prose.';
    const fallbackMessages = [
      ...messages,
      {
        role: 'system',
        content: `${retryInstruction}${options.delivery === 'auto' ? deliveryPrompt : ''}`,
      },
    ];
    const fallbackMaxTokens = Number(maxTokens) > 0 ? Math.floor(Number(maxTokens)) : null;
    const fallbackProjectionTokens = fallbackMaxTokens ?? 4096;
    const fallbackPromptTokens = estimateMicroTokens(fallbackMessages);
    const fallbackInputRejected = gateRequest(
      fallbackPromptTokens,
      fallbackProjectionTokens,
      { bypassRequestLimit: true },
    );
    if (fallbackInputRejected) return fallbackInputRejected;
    const fallbackProjectedTotal = aggregatedUsage.total_tokens + fallbackPromptTokens + fallbackProjectionTokens;
    const fallbackProjectedCost = aggregatedCostUsd + estimateRequestCost(fallbackPromptTokens, fallbackProjectionTokens);
    if (budget.maxProviderTokens && fallbackProjectedTotal > budget.maxProviderTokens) {
      return budgetFailure('providerTokens', fallbackProjectedTotal, budget.maxProviderTokens);
    }
    if (budget.maxCostUsd && fallbackProjectedCost > budget.maxCostUsd) {
      return budgetFailure('cost', fallbackProjectedCost, budget.maxCostUsd);
    }

    const fallbackRequest = await sendRequest({
      model,
      messages: fallbackMessages,
      ...(fallbackMaxTokens ? { max_tokens: fallbackMaxTokens } : {}),
      temperature,
      reasoning_effort: 'none',
    }, fallbackPromptTokens, fallbackProjectionTokens, { bypassRequestLimit: true });
    if (fallbackRequest.rejected) return fallbackRequest.rejected;
    const fallbackRes = fallbackRequest.response;

    if (fallbackRes.ok && fallbackRes.data?.choices?.[0]) {
      finalChoice = fallbackRes.data.choices[0];
      if (finalChoice?.finish_reason) lastFinishReason = finalChoice.finish_reason;
      recordResponseUsage(fallbackRes.data.usage, {
        prompt_tokens: fallbackPromptTokens,
        completion_tokens: estimateMicroTokens(finalChoice.message?.content || ''),
      });
      if (finalChoice.message?.reasoning_content) lastReasoning = finalChoice.message.reasoning_content;
      content = String(finalChoice.message?.content ?? '').trim();
      if (!content) {
        invalidOutputReason = 'empty';
        fallbackError = 'Micro provider returned an empty fallback response.';
      } else if (!withOS && hasUnexecutedToolSyntax(content)) {
        invalidOutputReason = 'tool_call_syntax';
        fallbackError = 'the fallback response still contained tool-call syntax.';
        content = '';
      }
      if (budget.maxProviderTokens && aggregatedUsage.total_tokens > budget.maxProviderTokens) {
        return budgetFailure('providerTokens', aggregatedUsage.total_tokens, budget.maxProviderTokens);
      }
      if (budget.maxCostUsd && aggregatedCostUsd > budget.maxCostUsd) {
        return budgetFailure('cost', aggregatedCostUsd, budget.maxCostUsd);
      }
    } else {
      fallbackError = fallbackRes.ok ? 'Micro provider returned an empty fallback response.' : fallbackRes.error;
    }
  }

  if (!content) {
    return {
      ok: false,
      statusCode: 200,
      providerTruncated,
      finishReason: providerFinishReason,
      error: invalidOutputReason === 'tool_call_syntax'
        ? `Micro provider returned tool-call syntax while tools were disabled${fallbackError ? ` after final-answer retry: ${fallbackError}` : ''}.`
        : fallbackError
          ? `Micro provider returned an empty response after final-answer retry: ${fallbackError}`
          : 'Micro provider returned an empty response.',
      invalidOutput: invalidOutputReason,
      reasoning: lastReasoning,
      ...usageDetails(),
      cost: costSummary(),
      budget,
      invocation: {
        ...invocation,
        providerRequests: providerRequestCount,
        toolRounds: step,
        shortCircuited: false,
      },
      delivery: requestedDelivery,
      durationMs: Date.now() - start,
      model,
      providerHost,
      preset: presetKey || null,
      withOS,
      steps: step,
      inputSource,
      inputTruncated: resolvedInput.truncated,
      preload: preloadMeta,
      toolCalls: toolExecutionTrace,
    };
  }

  let structured = null;
  if (presetKey === 'evidence') {
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) structured = parsed;
    } catch (_) {}
  } else if (options.delivery === 'auto') {
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && typeof parsed.needsHost === 'boolean') {
        const answerText = typeof parsed.answer === 'string'
          ? parsed.answer
          : (preset?.format === 'json' && parsed.answer && typeof parsed.answer === 'object'
              ? JSON.stringify(parsed.answer)
              : '');
        if (!parsed.needsHost || answerText.trim()) {
          structured = { needsHost: parsed.needsHost, hostReason: typeof parsed.hostReason === 'string' ? parsed.hostReason.slice(0, 400) : null };
          content = answerText;
        }
      }
    } catch (_) {}
  }
  const evidenceRefs = Array.isArray(structured?.evidenceRefs)
    ? structured.evidenceRefs.slice(0, 12)
    : toolExecutionTrace.slice(-8).map((call) => {
        let parsed = {};
        try {
          parsed = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : (call.arguments || {});
        } catch (_) {}
        return {
          tool: call.name,
          path: parsed.path || null,
          paths: Array.isArray(parsed.paths) ? parsed.paths.slice(0, 12) : null,
          query: parsed.query || null,
        };
      });
  const confidence = typeof structured?.confidence === 'string' ? structured.confidence : null;
  const unknowns = Array.isArray(structured?.unknowns) ? structured.unknowns.slice(0, 12) : [];
  const hasHostAnswer = presetKey === 'evidence'
    ? typeof structured?.answer === 'string' && Boolean(structured.answer.trim())
    : Boolean(String(content || '').trim());
  const needsHost = typeof structured?.needsHost === 'boolean'
    && !(options.delivery === 'auto' && structured.needsHost && !hasHostAnswer)
      ? structured.needsHost
      : null;
  const hostReason = typeof structured?.hostReason === 'string' ? structured.hostReason.slice(0, 400) : null;
  const implementationAfter = implementationBefore
    ? fingerprintImplementationPaths(options.projectRoot, options.context?.allowedPaths || [])
    : null;
  const implementationDiffResult = implementationBefore
    ? implementationDiff(implementationBefore, implementationAfter || new Map())
    : { changed: false, changedPaths: [] };
  const appliedReceipts = toolExecutionTrace
    .filter((call) => call.mutation === true && call.applied === true)
    .map((call) => call.changeReceiptId || call.id)
    .filter(Boolean);
  const implementationEvidence = options.execution === 'implement'
    ? {
        applied: implementationDiffResult.changed,
        source: implementationDiffResult.changed ? 'diff' : (appliedReceipts.length ? 'unverified-receipt' : 'none'),
        changedPaths: implementationDiffResult.changedPaths,
        receiptIds: appliedReceipts,
      }
    : null;

  const result = {
    ok: true,
    statusCode: 200,
    content,
    providerTruncated,
    finishReason: providerFinishReason,
    structured,
    evidenceRefs,
    confidence,
    unknowns,
    needsHost,
    hostReason,
    reasoning: lastReasoning,
    ...(implementationEvidence ? { implementationEvidence } : {}),
    ...usageDetails(),
    cost: costSummary(),
    budget,
    invocation: {
      ...invocation,
      providerRequests: providerRequestCount,
      toolRounds: step,
      shortCircuited: false,
    },
    durationMs: Date.now() - start,
    model,
    providerHost,
    preset: presetKey || null,
    delivery: ['immediate', 'defer', 'errors-only', 'auto'].includes(options.delivery) ? options.delivery : 'immediate',
    withOS,
    executionMode: withOS ? (toolExecutionTrace.length > 0 ? 'executor' : 'executor-idle') : 'summarizer-only',
    summarizerOnly: !withOS,
    sessionId,
    sessionMode: options.sessionMode || 'isolated',
    batch: options.batch === true,
    steps: step,
    inputSource,
    inputTruncated: resolvedInput.truncated,
    preload: preloadMeta,
    toolCalls: toolExecutionTrace,
  };
  if (implementationEvidence && !implementationEvidence.applied && !providerTruncated) {
    return {
      ...result,
      ok: false,
      statusCode: 409,
      errorCode: 'MICRO_IMPLEMENTATION_NOT_APPLIED',
      error: 'Implementation finished without an applied source change receipt or workspace diff.',
    };
  }
  return result;
}

/**
 * Execute multiple micro tasks concurrently with complete error isolation.
 *
 * @param {object} config Micro configuration
 * @param {Array<object>} tasks Array of task descriptors
 * @param {object} globalOptions Default options applied across all tasks
 * @returns {Promise<object>} Aggregate results { ok, totalDurationMs, tasks: [...] }
 */
export async function runMicroTasksParallel(config = {}, tasks = [], globalOptions = {}) {
  const start = Date.now();
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return {
      ok: true,
      totalDurationMs: 0,
      tasks: [],
    };
  }

  // A batch is still one host round, but an unbounded Promise.all can create a
  // provider burst and preload every task at once. That makes Micro look like
  // a cheaper route while actually increasing retries, rate-limit failures,
  // and durable artifact churn. Keep the batch complete, but bound in-flight
  // provider calls. `maxConcurrency` is a scheduler hint, not a per-task input.
  const requestedConcurrency = Number(globalOptions?.maxConcurrency);
  const concurrency = Math.max(
      1,
      Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
        ? Math.floor(requestedConcurrency)
        : MICRO_BATCH_DEFAULT_CONCURRENCY
  );
  const { maxConcurrency: _maxConcurrency, ...taskDefaults } = globalOptions || {};
  const results = new Array(tasks.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const idx = nextIndex;
      nextIndex += 1;
      if (idx >= tasks.length) return;
      const task = tasks[idx] && typeof tasks[idx] === 'object' ? tasks[idx] : {};
      const taskId = task.id || `task-${idx + 1}`;
      const { maxConcurrency: _taskMaxConcurrency, ...taskInput } = task;
      try {
        const result = await runMicroTask(config, { ...taskDefaults, ...taskInput, batch: true });
        results[idx] = { id: taskId, ...result };
      } catch (error) {
        results[idx] = {
          id: taskId,
          ok: false,
          error: error?.message || String(error),
          durationMs: 0,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          cost: { estimatedUsd: 0 },
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  const totalDurationMs = Date.now() - start;
  const allOk = results.every((r) => r.ok);
  const usage = results.reduce((total, result) => {
    const current = result.usage || {};
    total.promptTokens += Number(current.prompt_tokens) || 0;
    total.completionTokens += Number(current.completion_tokens) || 0;
    total.totalTokens += Number(current.total_tokens) || 0;
    return total;
  }, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  const estimatedCostUsd = results.reduce((total, result) => total + (Number(result.cost?.estimatedUsd) || 0), 0);

  return {
    ok: allOk,
    totalDurationMs,
    usage,
    cost: { estimatedUsd: Number(estimatedCostUsd.toFixed(6)) },
    tasks: results,
  };
}
