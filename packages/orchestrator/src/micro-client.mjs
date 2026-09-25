import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { readArtifact } from './artifact-store.mjs';
import { microPreloadPrompt } from './micro-preload.mjs';

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

const MICRO_ANSWER_TOKENS = Object.freeze({
  triage: 256,
  contract: 512,
  patch: 1024,
  graph: 768,
  custom: 512,
  evidence: 768,
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
const MICRO_BATCH_MAX_CONCURRENCY = 8;

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
    maxSteps,
    shortCircuited: false,
  };
}

function normalizeUsage(usage = {}) {
  const promptTokens = Number(usage.prompt_tokens) || 0;
  const completionTokens = Number(usage.completion_tokens) || 0;
  const totalTokens = Number(usage.total_tokens) || promptTokens + completionTokens;
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens };
}

function addUsage(target, usage) {
  const normalized = normalizeUsage(usage);
  target.prompt_tokens += normalized.prompt_tokens;
  target.completion_tokens += normalized.completion_tokens;
  target.total_tokens += normalized.total_tokens;
}

export function estimateMicroTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.ceil(String(text).length / 4);
}

export function resolveMicroBudget(config = {}, options = {}, presetKey = 'custom') {
  const source = {
    ...config,
    ...options,
    ...(options.invocation?.provider && typeof options.invocation.provider === 'object'
      ? options.invocation.provider
      : {}),
  };
  const defaultTokenBudget = MICRO_PROVIDER_TOKEN_BUDGETS[presetKey] || MICRO_PROVIDER_TOKEN_BUDGETS.custom;
  return {
    maxProviderTokens: positiveNumber(source.maxProviderTokens, defaultTokenBudget),
    maxCostUsd: positiveNumber(source.maxCostUsd, null),
    inputUsdPerMillion: positiveNumber(source.inputUsdPerMillion, null),
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

const MICRO_READ_ONLY_TOOLS = new Set(['os', 'inspect', 'search_code', 'os_context', 'artifact']);

function canonicalMicroValue(value) {
  if (Array.isArray(value)) return value.map(canonicalMicroValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalMicroValue(value[key])]));
}

function microReadMemoKey(name, args) {
  if (!MICRO_READ_ONLY_TOOLS.has(name)) return null;
  return `${name}:${JSON.stringify(canonicalMicroValue(args || {}))}`;
}

function microDispatchRoute(name, args = {}) {
  if (name === 'os') {
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
export async function executeMicroTool(name, rawArgs, { caps, projectRoot, dispatch } = {}) {
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

  try {
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

  if (options.inputArtifact) {
    const artifact = readArtifact(projectRoot, options.inputArtifact, {
      maxChars: limit,
      lineNumbers: false,
    });
    if (!artifact) throw new Error(`Micro input artifact not found: ${options.inputArtifact}`);
    return finish(artifact.text, 'artifact');
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

async function sendMicroRequest(endpoint, payloadObj, headers, timeoutMs, maxResponseChars = 2_000_000) {
  const payload = JSON.stringify(payloadObj);
  const responseLimit = positiveNumber(maxResponseChars, 2_000_000);
  const reqHeaders = {
    ...headers,
    'Content-Length': Buffer.byteLength(payload),
  };
  const transport = endpoint.protocol === 'http:' ? http : https;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
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
        error: `Micro task timed out after ${timeoutMs}ms`,
      });
    });

    req.on('error', (err) => {
      finish({
        ok: false,
        error: err.message,
      });
    });

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

  // Resolve system prompt
  const deliveryPrompt = options.delivery === 'auto'
    ? (presetKey === 'evidence'
        ? '\nFor host routing, include needsHost as a boolean and hostReason as a short string in the JSON. Set needsHost=true only when the host agent needs your answer to decide or perform the requested work; set it false when a success receipt or an error is sufficient. When false, keep answer, evidenceRefs, and unknowns empty and hostReason very short.'
        : '\nFor auto delivery, return only JSON with shape {"needsHost":boolean,"hostReason":string,"answer":string or a JSON value}. Keep answer concise and in the requested preset format: text/code as a string, JSON as a native JSON value. Set needsHost=true when the host needs the result on its next action; ContextOS will defer it for the next top-level OS call. Set needsHost=false only when a success receipt or error is sufficient; use an empty string or null for answer. Do not add prose outside the JSON.')
    : (options.delivery === 'errors-only'
        ? '\nThe requested curated graph writes are the deliverable. Ignore the preset response format. Only after at least one successful Block bind_auto or additive Chain compose, return "OK". If a write fails or you cannot complete that graph chore, return only the concise error and the action that failed; do not claim success without a successful write.'
        : (options.delivery === 'defer'
            ? '\nYour answer will be restored by ContextOS on a later call. Return only the concise result the host will need then.'
            : ''));
  const systemPrompt = `${options.system || preset?.system || config.system || ''}${deliveryPrompt}`;
  const resolvedInput = resolveMicroInput(options, {
    projectRoot: options.projectRoot || config.projectRoot || process.cwd(),
    maxInputChars: options.maxInputChars
      ?? config.maxInputChars
      ?? MICRO_INPUT_LIMITS[presetKey]
      ?? MICRO_INPUT_LIMITS.custom,
  });
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
  if (options.delivery === 'errors-only'
    && !(options.withOS && typeof options.caps?.block === 'function' && typeof options.caps?.chain === 'function')) {
    return {
      ok: false,
      error: 'Micro delivery errors-only requires withOS:true and ContextOS Block/Chain capabilities.',
      durationMs: Date.now() - start,
      model,
      preset: presetKey || null,
      delivery: 'errors-only',
    };
  }
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

  // Resolve messages
  let messages = [];
  if (Array.isArray(options.history) && options.history.length > 0) {
    messages = [...options.history];
    if (systemPrompt && !messages.some((m) => m.role === 'system')) {
      messages.unshift({ role: 'system', content: systemPrompt });
    }
    if (preloadText) messages.push({ role: 'system', content: preloadText });
    if (effectivePrompt || resolvedInput.input) {
      const userContent = effectivePrompt
        ? (resolvedInput.input ? `${effectivePrompt}\n\n<INPUT>\n${resolvedInput.input}\n</INPUT>` : effectivePrompt)
        : String(resolvedInput.input || '');
      messages.push({ role: 'user', content: userContent });
    }
  } else {
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    if (preloadText) messages.push({ role: 'system', content: preloadText });
    const userContent = effectivePrompt
      ? (resolvedInput.input ? `${effectivePrompt}\n\n<INPUT>\n${resolvedInput.input}\n</INPUT>` : effectivePrompt)
      : String(resolvedInput.input ?? '');
    if (userContent || !preloadText) messages.push({ role: 'user', content: userContent });
  }

  // Parameters
  const rawMaxTokens = invocation.maxOutputTokens ?? options.maxTokens ?? config.maxTokens ?? 1024;
  const maxTokens = options.outputMode === 'answer'
    ? Math.min(Number(rawMaxTokens) || 512, MICRO_ANSWER_TOKENS[presetKey] || 512)
    : rawMaxTokens;
  const temperature = options.temperature ?? config.temperature ?? 0.1;
  const thinking = options.thinking ?? config.thinking ?? 'low';
  const timeoutMs = options.timeoutMs ?? config.timeoutMs ?? 30000;
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

  // Tool calling setup
  const withOS = Boolean(invocation.toolsEnabled && (options.caps || options.projectRoot));
  const rawMaxSteps = Number(invocation.maxSteps);
  const DEFAULT_MAX_STEPS = 2;
  const SAFETY_MAX_STEPS = 4;
  const maxSteps = withOS
    ? (Number.isFinite(rawMaxSteps) && rawMaxSteps > 0
        ? Math.min(Math.floor(rawMaxSteps), SAFETY_MAX_STEPS)
        : DEFAULT_MAX_STEPS)
    : 1;

  const tools = withOS ? (options.tools || MICRO_OS_TOOLS) : undefined;
  const toolExecutionTrace = [];
  let step = 0;
  let aggregatedUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let aggregatedCostUsd = 0;
  const providerUsageTotals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const estimatedUsageTotals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let providerUsageCalls = 0;
  let estimatedUsageCalls = 0;
  let deduplicatedToolCallCount = 0;
  let providerRequestCount = 0;
  let finalChoice = null;
  let lastReasoning = '';

  const estimateRequestCost = (promptTokens, outputTokens) => {
    if (!budget.inputUsdPerMillion && !budget.outputUsdPerMillion) return 0;
    return (promptTokens * (budget.inputUsdPerMillion || 0) + outputTokens * (budget.outputUsdPerMillion || 0)) / 1_000_000;
  };
  const costSummary = () => ({
    estimatedUsd: Number(aggregatedCostUsd.toFixed(6)),
    pricingConfigured: Boolean(budget.inputUsdPerMillion || budget.outputUsdPerMillion),
    inputUsdPerMillion: budget.inputUsdPerMillion || null,
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
    aggregatedCostUsd += estimateRequestCost(effectiveUsage.prompt_tokens || 0, effectiveUsage.completion_tokens || 0);
    return effectiveUsage;
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

  const gateRequest = (promptTokens, outputTokens) => {
    if (invocation.maxInputTokens && promptTokens > invocation.maxInputTokens) {
      return budgetFailure('inputTokens', promptTokens, invocation.maxInputTokens);
    }
    if (invocation.maxRequests && providerRequestCount >= invocation.maxRequests) {
      return budgetFailure('requests', providerRequestCount + 1, invocation.maxRequests);
    }
    return null;
  };

  const sendRequest = async (payload, promptTokens, outputTokens) => {
    const rejected = gateRequest(promptTokens, outputTokens);
    if (rejected) return { rejected };
    providerRequestCount += 1;
    return { response: await sendMicroRequest(endpoint, payload, headers, timeoutMs, options.maxResponseChars ?? config.maxResponseChars) };
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
      max_tokens: maxTokens,
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
      return {
        ok: false,
        statusCode: res.statusCode,
        error: res.error,
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
      };
    }

    const data = res.data;
    const choice = data.choices?.[0];
    recordResponseUsage(data.usage, {
      prompt_tokens: projectedPromptTokens,
      completion_tokens: estimateMicroTokens(choice?.message?.content || ''),
    });

    finalChoice = choice;
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
          max_tokens: maxTokens,
          temperature,
          reasoning_effort: 'none',
        }, finalPromptTokens, finalOutputTokens);
        if (finalRequest.rejected) return finalRequest.rejected;
        const finalRes = finalRequest.response;
        if (finalRes.ok && finalRes.data?.choices?.[0]) {
          finalChoice = finalRes.data.choices[0];
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
        const memoKey = microReadMemoKey(toolName, parsedToolArgs);
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
            dispatch: options.orchestrator?.dispatch,
          });
          if (memoKey) readToolResults.set(memoKey, resultStr);
        }
        const resultStatus = summarizeMicroToolOutput(resultStr);
        toolExecutionTrace.push({
          id: call.id,
          name: toolName,
          arguments: toolArgs,
          preview: resultStr.slice(0, 150),
          ...(deduplicated ? { deduplicated: true } : {}),
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
  let fallbackError = null;
  let fallbackSkipped = null;
  const providerHost = (() => {
    try {
      return new URL(endpoint).host;
    } catch (_) {
      return null;
    }
  })();

  if (!content && invocation.maxRequests && providerRequestCount >= invocation.maxRequests) {
    fallbackSkipped = 'maxRequests';
    fallbackError = `Micro provider returned an empty response; final-answer retry skipped because maxRequests=${invocation.maxRequests} was reached.`;
  } else if (!content) {
    const fallbackMessages = [
      ...messages,
      {
        role: 'system',
        content: `Return only the final requested result now. Do not include reasoning, tool calls, or extra prose.${options.delivery === 'auto' ? deliveryPrompt : ''}`,
      },
    ];
    const fallbackMaxTokens = Math.max(Number(maxTokens) || 0, 4096);
    const fallbackPromptTokens = estimateMicroTokens(fallbackMessages);
    const fallbackInputRejected = gateRequest(fallbackPromptTokens, fallbackMaxTokens);
    if (fallbackInputRejected) return fallbackInputRejected;
    const fallbackProjectedTotal = aggregatedUsage.total_tokens + fallbackPromptTokens + fallbackMaxTokens;
    const fallbackProjectedCost = aggregatedCostUsd + estimateRequestCost(fallbackPromptTokens, fallbackMaxTokens);
    if (budget.maxProviderTokens && fallbackProjectedTotal > budget.maxProviderTokens) {
      return budgetFailure('providerTokens', fallbackProjectedTotal, budget.maxProviderTokens);
    }
    if (budget.maxCostUsd && fallbackProjectedCost > budget.maxCostUsd) {
      return budgetFailure('cost', fallbackProjectedCost, budget.maxCostUsd);
    }

    const fallbackRequest = await sendRequest({
      model,
      messages: fallbackMessages,
      max_tokens: fallbackMaxTokens,
      temperature,
      reasoning_effort: 'none',
    }, fallbackPromptTokens, fallbackMaxTokens);
    if (fallbackRequest.rejected) return fallbackRequest.rejected;
    const fallbackRes = fallbackRequest.response;

    if (fallbackRes.ok && fallbackRes.data?.choices?.[0]) {
      finalChoice = fallbackRes.data.choices[0];
      recordResponseUsage(fallbackRes.data.usage, {
        prompt_tokens: fallbackPromptTokens,
        completion_tokens: estimateMicroTokens(finalChoice.message?.content || ''),
      });
      if (finalChoice.message?.reasoning_content) lastReasoning = finalChoice.message.reasoning_content;
      content = String(finalChoice.message?.content ?? '').trim();
      if (!content) fallbackError = 'Micro provider returned an empty fallback response.';
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
      error: fallbackError
        ? `Micro provider returned an empty response after final-answer retry: ${fallbackError}`
        : 'Micro provider returned an empty response.',
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
      ...(fallbackSkipped ? { fallbackSkipped } : {}),
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

  return {
    ok: true,
    statusCode: 200,
    content,
    structured,
    evidenceRefs,
    confidence,
    unknowns,
    needsHost,
    hostReason,
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
    durationMs: Date.now() - start,
    model,
    providerHost,
    preset: presetKey || null,
    delivery: ['immediate', 'defer', 'errors-only', 'auto'].includes(options.delivery) ? options.delivery : 'immediate',
    withOS,
    sessionId,
    sessionMode: options.sessionMode || 'isolated',
    batch: options.batch === true,
    steps: step,
    inputSource,
    inputTruncated: resolvedInput.truncated,
    preload: preloadMeta,
    toolCalls: toolExecutionTrace,
  };
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
  const concurrency = Math.min(
    MICRO_BATCH_MAX_CONCURRENCY,
    Math.max(
      1,
      Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
        ? Math.floor(requestedConcurrency)
        : MICRO_BATCH_DEFAULT_CONCURRENCY
    )
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
