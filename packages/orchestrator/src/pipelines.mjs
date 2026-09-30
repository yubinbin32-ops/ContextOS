import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fitSections, resolveBudget } from './context-budget.mjs';
import { RESPONSE_BUDGETS, estimateTokens, finalizeResponse, recordMicroUsage, summarizeActionResult } from './response-budget.mjs';
import { observe } from './observer.mjs';
import { ModuleIndex } from './module-index.mjs';
import { workspaceFingerprint } from './session-store.mjs';
import { extractIdentifiers, extractPaths, tokenize } from './intent-router.mjs';
import { redactSecrets } from '../../process-host/src/sanitizer.mjs';
import { CodeTools } from '../../code-intel/src/code-tools.mjs';

const OUTLINE_CLIP = 1200;
// Files at or below this size are cheap to inline whole; above it, a
// path-only inspect returns an outline instead of a truncated head.
const INSPECT_INLINE_MAX_CHARS = 2500;
const INSPECT_BATCH_INLINE_MAX_CHARS = 32000;
const INSPECT_BATCH_INLINE_MAX_FILES = 24;
const SMALL_WORKSPACE_MAX_CHARS = 16000;
const SMALL_WORKSPACE_MAX_FILES = 24;
const SMALL_WORKSPACE_CRITICAL_MAX_FILES = SMALL_WORKSPACE_MAX_FILES;
const DECISION_SOURCE_FILE_MAX_CHARS = 8000;
const DECISION_SOURCE_TOTAL_MAX_CHARS = 18000;
const INSPECT_RECOVERY_MAX_CHARS = 16000;
const INSPECT_RECOVERY_OUTPUT_MAX_CHARS = 32000;
const MAX_INSPECT_RANGE_LINES = 240;
const MAX_FOCUS_SEARCH_IDENTIFIERS = 4;
const MAX_FOCUS_PATH_CANDIDATES = 16;
const MAX_FOCUS_SLICE_SYMBOLS = 4;
const SEARCH_CLIP = 360;
const PIPELINE_DEFAULT_OUTPUT_CLIP = 2800;
const PIPELINE_EXPLORE_OUTPUT_CLIP = 18000;
const PIPELINE_MAX_OUTPUT_CLIP = 4000;
const PIPELINE_RECEIPT_OUTPUT_CLIP = 2600;
const PIPELINE_RECEIPT_RESPONSE_BUDGET = 4000;
// A pipeline containing explore is the host's first decision package. Its
// purpose is to make the next mutation possible without a second read loop;
// keeping it at the generic response budget recreates the very cost it should
// remove. Generic inspect-only pipelines remain bounded at 4000.
const PIPELINE_DECISION_RESPONSE_BUDGET = 24000;
const PIPELINE_DEFAULT_PARALLEL_CONCURRENCY = 4;
const PIPELINE_MAX_PARALLEL_CONCURRENCY = 8;
const MICRO_TRIAGE_MIN_CHARS = 2000;
const PROCESS_VERIFY_MODES = new Set(['serve', 'list', 'status', 'logs', 'stop', 'clear', 'query']);

function normalizeParallelConcurrency(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) return PIPELINE_DEFAULT_PARALLEL_CONCURRENCY;
  return Math.min(PIPELINE_MAX_PARALLEL_CONCURRENCY, Math.max(1, Math.floor(requested)));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function isReceiptMode(mode) {
  return mode === 'receipt' || mode === 'receipt-first';
}

function requestsFullOutput(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.budget === 'full' || value.full === true) return true;
  if (Array.isArray(value)) return value.some(requestsFullOutput);
  return Object.values(value).some(requestsFullOutput);
}

function requestsContinueOnFailure(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.continueOnFailure === true) return true;
  if (Array.isArray(value)) return value.some(requestsContinueOnFailure);
  return Object.values(value).some(requestsContinueOnFailure);
}

function outputLength(value) {
  if (typeof value === 'string') return value.length;
  if (value == null) return 0;
  try {
    return JSON.stringify(value).length;
  } catch (_) {
    return String(value).length;
  }
}

function verifyCommandsFromInput(verify, profile = {}) {
  if (verify === true) return Array.isArray(profile.verify) ? profile.verify.filter(Boolean) : [];
  if (typeof verify === 'string') return verify ? [verify] : [];
  if (Array.isArray(verify)) return verify.filter((command) => typeof command === 'string' && command.trim());
  if (verify && typeof verify === 'object') {
    if (Array.isArray(verify.commands)) return verify.commands.filter((command) => typeof command === 'string' && command.trim());
    if (typeof verify.command === 'string' && verify.command.trim()) return [verify.command];
  }
  return [];
}

function actionFailed(action, result, receipts = []) {
  if (!action || typeof result !== 'string') return false;

  const { tool, input = {} } = action;
  // A rendered body is user-controlled data for inspect/search/run_command.
  // Read only the status envelope defined by the dispatched action.
  const visible = result.replace(/```[\s\S]*?```/g, '');
  const lines = visible.split(/\r?\n/);
  const headings = lines
    .map((line) => line.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/)?.[1]?.trim())
    .filter(Boolean);

  // A child response can be clipped before its status heading reaches the
  // aggregate Pipeline. Verification state is durable in the session, so use
  // matching receipts as the source of truth and reserve text parsing for the
  // human-readable fallback.
  if (['verify', 'change', 'work'].includes(tool) && Array.isArray(receipts)) {
    const requested = input.commands ?? input.verify;
    const commands = Array.isArray(requested)
      ? requested.filter((command) => typeof command === 'string' && command.trim())
      : (typeof requested === 'string' && requested.trim() ? [requested] : []);
    if (typeof input.command === 'string' && input.command.trim()) commands.push(input.command);
    if (commands.length && receipts.some((receipt) => (
      commands.includes(receipt?.command) && Number(receipt?.exitCode) !== 0
    ))) return true;
  }

  if (tool === 'verify' && PROCESS_VERIFY_MODES.has(input.mode)) return false;
  if (tool === 'verify' || tool === 'change') {
    const failuresIndex = headings.indexOf('Failures');
    const statusHeadings = failuresIndex < 0 ? headings : headings.slice(0, failuresIndex);
    const expected = tool === 'verify' ? /^Verdict:\s*FAIL$/i : /^Verify:\s*FAIL$/i;
    return statusHeadings.some((heading) => expected.test(heading));
  }
  if (tool === 'ship') {
    return /^ContextOS ship\s+—\s+BLOCKED\b/i.test(headings[0] || '');
  }
  if (tool === 'pipeline' || tool === 'work') {
    const statusLine = lines.map((line) => line.trim()).find((line) => line && !line.startsWith('# '));
    return statusLine ? /^(?:pipeline|work)=(?:HALTED|FAIL)\b/i.test(statusLine) : false;
  }
  if (tool === 'ops' && input.capability === 'micro') {
    try {
      const receipt = JSON.parse(result);
      return receipt?.ok === false;
    } catch (_) {
      return false;
    }
  }
  if (tool === 'ops' && input.capability === 'run_command') {
    try {
      const receipt = JSON.parse(result);
      return Number.isFinite(Number(receipt?.exitCode)) && Number(receipt.exitCode) !== 0;
    } catch (_) {
      return false;
    }
  }
  return false;
}

// Micro triage is the most compressed actionable statement about a failure.
// Summary and failure projections must keep it even when the raw evidence is
// clipped, otherwise the host pays for a provider call it never gets to read.
function extractMicroTriage(text) {
  const match = /^##\s*[^\n]*Micro-Triage[^\n]*\n([\s\S]*?)(?=\n##\s|$)/m.exec(String(text || ''));
  if (!match) return null;
  const body = match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  return body ? clip(body, 700) : null;
}

// Once Micro has already reduced a failure to a diagnosis, the raw log is
// redundant in the host window. Keep the identifying lines and a locator so
// the caller can still open the receipt when it needs the full evidence.
function isFailureYamlLabel(line) {
  return /^(?:error|stack|code|location|failureType):\s*(?:\|-|>|-)?\s*$/i.test(line);
}

function isFailureStackFrame(line) {
  return /^(?:at\s+)?\S.*(?:\(|at\s+).*:\d+:\d+\)?$/.test(line);
}

export function extractFailureEvidence(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const test = lines.find((line) => /^not ok\b/i.test(line));
  const causes = [];
  const stackFrames = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isFailureYamlLabel(line)) {
      const next = lines[index + 1];
      if (next && !isFailureYamlLabel(next)) causes.push(next);
      continue;
    }
    if (/AssertionError|(?:^|\b)(?:Error|Expected):|Expected\s+|not implemented|panicked at/i.test(line)) {
      causes.push(line);
    }
    if (isFailureStackFrame(line)) stackFrames.push(line);
  }
  return {
    test: test || null,
    cause: causes[0] || null,
    stackFrame: stackFrames[0] || null,
    fallback: lines.filter((line) => !isFailureYamlLabel(line)).slice(0, 2),
  };
}

function compactFailureEvidence(text, { maxChars = 400 } = {}) {
  const evidence = extractFailureEvidence(text);
  const parts = [evidence.test, evidence.cause, evidence.stackFrame]
    .filter(Boolean)
    .filter((line, index, values) => values.indexOf(line) === index);
  const head = parts.length ? parts.join('\n') : evidence.fallback.join('\n');
  // Clip the evidence first: appending the locator before clipping let a long
  // assertion line consume the whole budget and drop the locator.
  return `${clip(head, maxChars)}\n[raw failure log kept in the verification receipt; pass full:true to expand]`;
}

function resolveActionOutputLimit(action, { mode = 'summary', aggregateBudget } = {}) {
  if (!action || typeof action !== 'object') {
    return mode === 'full' && !Number.isFinite(aggregateBudget)
      ? PIPELINE_MAX_OUTPUT_CLIP
      : PIPELINE_DEFAULT_OUTPUT_CLIP;
  }

  const nested = [action.inspect, action.verify, action.change, action.ship]
    .find((value) => value && typeof value === 'object');
  const opsNested = [
    action.ops,
    action.run,
    action.run_command,
    action.search,
    action.block,
    action.chain,
    action.plan,
    action.task,
  ].find((value) => value && typeof value === 'object');
  const toolName = typeof action.tool === 'string' ? action.tool : action.action;
  const isOpsAction = toolName === 'ops'
    || Object.prototype.hasOwnProperty.call(action, 'ops')
    || ['run', 'run_command', 'search', 'block', 'chain', 'plan', 'task']
      .some((key) => Object.prototype.hasOwnProperty.call(action, key));
  if (isOpsAction && action.raw !== true && opsNested?.raw !== true) {
    const requested = typeof action.maxChars === 'number'
      ? action.maxChars
      : (typeof opsNested?.maxChars === 'number' ? opsNested.maxChars : RESPONSE_BUDGETS.ops);
    return Math.min(Math.max(1, Math.floor(requested)), RESPONSE_BUDGETS.ops);
  }
  if (isReceiptMode(mode)) return PIPELINE_RECEIPT_OUTPUT_CLIP;
  const requested = typeof action.maxChars === 'number'
    ? action.maxChars
    : (typeof nested?.maxChars === 'number' ? nested.maxChars : null);
  const defaultClip = toolName === 'explore'
    ? PIPELINE_EXPLORE_OUTPUT_CLIP
    : PIPELINE_DEFAULT_OUTPUT_CLIP;

  if (mode === 'full') {
    const aggregateLimit = Number.isFinite(aggregateBudget)
      ? Math.max(1, Math.floor(aggregateBudget))
      : Infinity;
    if (Number.isFinite(requested) && requested > 0) {
      return Math.min(Math.floor(requested), aggregateLimit);
    }
    return aggregateLimit;
  }

  if (Number.isFinite(requested) && requested > 0) {
    return Math.min(Math.floor(requested), toolName === 'explore' ? PIPELINE_EXPLORE_OUTPUT_CLIP : PIPELINE_MAX_OUTPUT_CLIP);
  }
  if (nested?.budget === 'full') return toolName === 'explore' ? PIPELINE_EXPLORE_OUTPUT_CLIP : PIPELINE_MAX_OUTPUT_CLIP;
  return defaultClip;
}

function explicitActionMaxChars(action) {
  if (!action || typeof action !== 'object') return null;
  const nested = [
    action.args,
    action.inspect,
    action.verify,
    action.change,
    action.ship,
    action.ops,
    action.run,
    action.run_command,
    action.search,
    action.block,
    action.chain,
    action.plan,
    action.task,
  ].find((value) => value && typeof value === 'object' && !Array.isArray(value));
  const value = typeof action.maxChars === 'number'
    ? action.maxChars
    : (typeof nested?.maxChars === 'number' ? nested.maxChars : null);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function compactOutlineData(text) {
  if (typeof text !== 'string') return '';
  const lines = text.split(/\r?\n/);
  const symbols = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^[-*]\s+\*\*([a-zA-Z]+)\*\*\s+`([^`]+)`\s+\[(L\d+-L\d+)\]/);
    if (match) {
      const [, kind, name, range] = match;
      symbols.push(`${kind} ${name} ${range}`);
    }
  }
  if (symbols.length) {
    const slice = symbols.slice(0, 8);
    return `(${slice.join(', ')}${symbols.length > 8 ? ` +${symbols.length - 8}` : ''})`;
  }
  return clip(text, 200);
}

function stripOuterCodeFence(text) {
  let value = String(text ?? '');
  const match = value.match(/^\s*```[^\n]*\n([\s\S]*?)\n```\s*$/);
  if (match) value = match[1];
  return value
    .split(/\r?\n/)
    .filter((line, index) => !(index === 0 && /^\s*\/\/\s+.+\[L\d+-L\d+\]\s+\(hash:\s*[^)]+\)\s*$/.test(line)))
    .join('\n');
}

function compactTestContract(text, maxChars = 420) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /^(?:test\(|assert\.|await assert\.|const (?:report|replay)\b)/.test(line));
  return clip(lines.join(' | '), maxChars);
}

const INDEX_IMPORT_EXTENSIONS = ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.json'];

function resolveIndexedImport(projectRoot, fromPath, source, index) {
  const raw = String(source || '').trim();
  if (!raw || (!raw.startsWith('.') && !raw.startsWith('/'))) return null;
  const base = path.resolve(projectRoot, path.dirname(fromPath), raw);
  const candidates = [];
  if (path.extname(base)) {
    candidates.push(base);
  } else {
    for (const extension of INDEX_IMPORT_EXTENSIONS) candidates.push(base + extension);
    for (const extension of INDEX_IMPORT_EXTENSIONS) candidates.push(path.join(base, `index${extension}`));
  }
  for (const candidate of candidates) {
    const relative = path.relative(projectRoot, candidate).split(path.sep).join('/');
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    if (index.entries.has(relative)) return relative;
  }
  return null;
}

function collectExploreClosure(projectRoot, seeds, index, limits = {}) {
  const maxDependencies = Number.isFinite(limits.maxDependencies) ? Math.max(1, Math.floor(limits.maxDependencies)) : 6;
  const maxCallers = Number.isFinite(limits.maxCallers) ? Math.max(1, Math.floor(limits.maxCallers)) : 4;
  const maxTests = Number.isFinite(limits.maxTests) ? Math.max(1, Math.floor(limits.maxTests)) : 2;
  const seedSet = new Set(seeds);
  const dependencies = new Set();

  for (const seed of seeds) {
    const entry = index.entries.get(seed);
    for (const source of entry?.imports || []) {
      const resolved = resolveIndexedImport(projectRoot, seed, source, index);
      if (resolved && resolved !== seed) dependencies.add(resolved);
      if (dependencies.size >= maxDependencies) break;
    }
    if (dependencies.size >= maxDependencies) break;
  }

  const related = new Set([...seedSet, ...dependencies]);
  const callers = new Set();
  const tests = new Set();
  for (const [candidate, entry] of index.entries) {
    const imports = (entry?.imports || [])
      .map((source) => resolveIndexedImport(projectRoot, candidate, source, index))
      .filter(Boolean);
    if (!imports.some((target) => related.has(target))) continue;
    const isTest = /(^|\/)(__tests__|test|tests|spec)(\/|$)|\.(?:test|spec)\.[^/]+$/i.test(candidate);
    if (isTest) tests.add(candidate);
    else if (!related.has(candidate)) callers.add(candidate);
    if (callers.size >= maxCallers && tests.size >= maxTests) break;
  }

  return {
    dependencies: Array.from(dependencies),
    callers: Array.from(callers),
    tests: Array.from(tests),
  };
}

function clip(text, max, { withHint = false } = {}) {
  const value = typeof text === 'string' ? text : JSON.stringify(text ?? '', null, 2);
  if (max === Infinity || value.length <= max) return value;
  const hint = withHint
    ? '\n[TRUNCATED: budget exceeded. Action required: specify \'ranges: [{startLine, endLine}]\' or pass \'budget: "full"\' to receive the entire content]'
    : '';
  const cutLen = Math.max(0, max - 24 - hint.length);
  return `${value.slice(0, cutLen)}\n... (+${value.length - cutLen} chars omitted)${hint}`;
}

function stringify(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function countOccurrences(content, target) {
  if (typeof content !== 'string' || typeof target !== 'string' || !target) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(target, offset)) !== -1) {
    count += 1;
    offset += target.length;
  }
  return count;
}

function stripInspectMetadata(target) {
  if (typeof target !== 'string') return target;
  const lines = target.split(/\r?\n/);
  if (lines.length > 1 && /^\/\/ .+ \[L\d+-L\d+\] \(hash: [0-9a-f]+\)$/.test(lines[0].trim())) {
    return lines.slice(1).join('\n');
  }
  return target;
}

function resolvePreviewPath(projectRoot, inputPath) {
  if (typeof inputPath !== 'string' || !inputPath) {
    return { error: 'path is required' };
  }
  const fullPath = path.resolve(projectRoot, inputPath);
  const relativePath = path.relative(projectRoot, fullPath).split(path.sep).join('/');
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return { error: `path '${inputPath}' is outside project root` };
  }
  return { fullPath, relativePath };
}

function previewEdit(projectRoot, spec = {}, store = null) {
  let specPath = spec.path;
  let specSymbol = spec.symbol;
  if (spec.slot && store) {
    const slotData = store.getSlot(spec.slot);
    if (slotData) {
      specPath = slotData.path || specPath;
      specSymbol = slotData.symbol || specSymbol;
    }
  }
  const resolved = resolvePreviewPath(projectRoot, specPath);
  const fallback = {
    filePath: resolved.relativePath || specPath || '(missing)',
    before: typeof spec.target === 'string' ? spec.target : '',
    after: typeof spec.replacement === 'string' ? spec.replacement : (spec.fullFile && typeof spec.content === 'string' ? spec.content : (spec.append || '')),
    matches: 0,
    unique: false,
  };
  if (resolved.error) return { ...fallback, error: resolved.error };
  if (!fs.existsSync(resolved.fullPath)) return { ...fallback, error: 'file not found' };

  if (spec.fullFile) {
    const content = fs.readFileSync(resolved.fullPath, 'utf8');
    return {
      filePath: resolved.relativePath,
      before: content,
      after: typeof spec.replacement === 'string' ? spec.replacement : (spec.content ?? ''),
      matches: 1,
      unique: true,
      scope: 'fullFile',
    };
  }

  if (spec.append) {
    return {
      filePath: resolved.relativePath,
      before: '(end of file)',
      after: spec.append,
      matches: 1,
      unique: true,
      scope: 'append',
    };
  }

  try {
    const content = fs.readFileSync(resolved.fullPath, 'utf8');
    const target = stripInspectMetadata(typeof spec.target === 'string' ? spec.target : '');
    let before = target;
    let scopeLabel = null;
    if (spec.startLine !== undefined || spec.endLine !== undefined) {
      const lines = content.split(/\r?\n/);
      const startLine = Math.max(1, Math.min(Number(spec.startLine) || 1, lines.length));
      const endLine = Math.max(startLine, Math.min(Number(spec.endLine) || lines.length, lines.length));
      if (!before) before = lines.slice(startLine - 1, endLine).join('\n');
      scopeLabel = `L${startLine}-L${endLine}`;
    }

    CodeTools.edit(resolved.relativePath, content, {
      targetContent: target || null,
      replacementContent: spec.replacement ?? '',
      startLine: spec.startLine ?? null,
      endLine: spec.endLine ?? null,
      symbol: specSymbol ?? null,
      append: spec.append ?? null,
    });

    const matches = target ? countOccurrences(content, target) : 1;
    return {
      ...fallback,
      before,
      after: spec.replacement ?? '',
      matches,
      unique: matches === 1,
      scope: scopeLabel,
    };
  } catch (error) {
    return { ...fallback, error: error.message };
  }
}

function renderEditPreview(preview, index) {
  const matchLabel = `${preview.matches} match${preview.matches === 1 ? '' : 'es'}`;
  const lines = [
    `### Edit ${index + 1}`,
    `- File: \`${preview.filePath}\``,
    `- Target unique: ${preview.unique ? 'true' : 'false'} (${matchLabel}${preview.scope ? ` in ${preview.scope}` : ''})`,
  ];
  if (preview.error) lines.push(`- Error: ${preview.error}`);
  lines.push(
    '- Before:',
    '```text',
    preview.before,
    '```',
    '- After:',
    '```text',
    preview.after,
    '```'
  );
  return lines.join('\n');
}

function overlapScore(tokens, text) {
  if (!tokens.size) return 0;
  const haystack = tokenize(text);
  let score = 0;
  for (const token of tokens) {
    if (haystack.has(token)) score += 1;
  }
  return score;
}

function decisionHeadings(projectRoot, limit = 3) {
  const docPath = path.join(projectRoot, 'DECISION.md');
  if (!fs.existsSync(docPath)) return [];
  try {
    const content = fs.readFileSync(docPath, 'utf8');
    const matches = content.match(/^## \[(DEC-\d+)\]\s+(.+)$/gm) || [];
    return matches.slice(-limit).map((line) => line.replace(/^##\s+/, '- '));
  } catch (_) {
    return [];
  }
}

function suggestVerify(profile) {
  return profile.verify.length ? profile.verify[0] : null;
}

function receiptStatus(receipt) {
  if (receipt.exitCode === 0) return 'passed';
  return receipt.status === 'superseded' ? 'superseded' : 'unresolved';
}

function normalizeVerificationCommand(value) {
  const command = String(value || '').trim().replace(/\s+/g, ' ');
  return command.replace(/^npm\s+run\s+test\b/, 'npm test');
}

function sameReceiptCommand(left, right) {
  const leftCommand = normalizeVerificationCommand(left?.command);
  const rightCommand = normalizeVerificationCommand(right?.command);
  if (!leftCommand || leftCommand !== rightCommand) return false;
  if (!left?.cwd || !right?.cwd) return true;
  return path.resolve(left.cwd) === path.resolve(right.cwd);
}

function effectiveReceiptStatus(receipt, receipts = []) {
  if (receipt?.exitCode === 0) return 'passed';
  if (receipt?.status === 'superseded') return 'superseded';
  const index = receipts.indexOf(receipt);
  if (index < 0) return 'unresolved';
  const laterPass = receipts.slice(index + 1).some((candidate) =>
    candidate?.exitCode === 0 && sameReceiptCommand(receipt, candidate)
  );
  return laterPass ? 'superseded' : 'unresolved';
}

// Chinese intents carry latin keywords ("coverage", "sync") that never look
// like identifiers but are still worth one workspace symbol search.
// Words that are already part of a supplied path are skipped: searching for
// "packages" only returns noise.
function latinQueries(text = '', exclude = '') {
  const haystack = String(exclude).toLowerCase();
  return Array.from(tokenize(text))
    .filter((token) => /^[a-z][a-z0-9_-]{4,}$/.test(token))
    .filter((token) => !haystack.includes(token))
    .slice(0, 2);
}

function isTestPath(filePath = '') {
  return /(^|\/)(__tests__|test|tests|spec)(\/|$)|\.(?:test|spec)\.[^/]+$/i.test(String(filePath));
}

function isTestContractPath(filePath = '') {
  return isTestPath(filePath) && !/(^|\/)fixtures?\//i.test(String(filePath));
}

function isImplementationSource(filePath = '') {
  return /\.(?:mjs|cjs|js|jsx|ts|tsx|py|go|rs|java|rb|php|swift|kt|cs|cpp|c|h)$/i.test(String(filePath))
    && !isTestPath(filePath);
}

function uniquePaths(values = []) {
  return Array.from(new Set(values
    .map((value) => String(value || '').replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter(Boolean)));
}

function parseOutlineSymbols(text) {
  const symbols = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.trim().match(/^[-*]\s+\*\*([a-zA-Z]+)\*\*\s+`([^`]+)`\s+\[L(\d+)-L(\d+)\]/);
    if (!match) continue;
    const [, kind, display, startLine, endLine] = match;
    const name = display.split('(')[0].trim().split('.').pop();
    if (!name) continue;
    symbols.push({
      kind,
      name,
      display,
      startLine: Number(startLine),
      endLine: Number(endLine),
      line,
    });
  }
  return symbols;
}

function selectFocusSymbols(outlineText, { identifiers = [], tokens = [] } = {}) {
  const terms = Array.from(new Set([...identifiers, ...tokens]
    .map((value) => String(value || '').toLowerCase())
    .filter((value) => value.length >= 4)))
    .slice(0, 24);
  const candidates = parseOutlineSymbols(outlineText)
    .filter((symbol) => ['func', 'function', 'method', 'constructor'].includes(symbol.kind));
  const scored = candidates.map((symbol) => {
    const name = symbol.name.toLowerCase();
    const haystack = `${symbol.display} ${symbol.line}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (name === term) score += 24;
      else if (name.includes(term)) score += 12;
      else if (haystack.includes(term)) score += 4;
    }
    if (symbol.kind === 'func' || symbol.kind === 'method' || symbol.kind === 'function') score += 1;
    if (symbol.name === 'constructor' || symbol.name.startsWith('_')) score -= 3;
    return { ...symbol, score };
  }).sort((left, right) => (
    right.score - left.score
    || left.startLine - right.startLine
  ));
  const matched = scored.filter((symbol) => symbol.score > 0);
  const selected = (matched.length ? matched : scored).slice(0, MAX_FOCUS_SLICE_SYMBOLS);
  return { symbols: selected, matched: matched.length > 0 };
}

async function resolveExploreFocus({ caps, index, intent = '', identifiers = [] }) {
  const discoveredFiles = index.discover({ limit: 800 });
  const intentTokens = Array.from(tokenize(intent))
    .filter((token) => token.length >= 4)
    .filter((token) => !['implement', 'implementation', 'including', 'relevant', 'public', 'package', 'exports', 'tests'].includes(token))
    .slice(0, 16);
  const pathScores = discoveredFiles
    .map((filePath) => {
      const normalized = filePath.toLowerCase();
      let score = 0;
      for (const token of intentTokens) {
        if (!normalized.includes(token)) continue;
        score += token.includes('-') ? 4 : 2;
      }
      return { filePath, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.filePath.length - right.filePath.length)
    .slice(0, MAX_FOCUS_PATH_CANDIDATES)
    .map((entry) => entry.filePath);

  const searchPaths = [];
  for (const identifier of identifiers.slice(0, MAX_FOCUS_SEARCH_IDENTIFIERS)) {
    const search = await caps.code({
      action: 'search',
      query: identifier,
      format: 'json',
      limit: 4,
    });
    if (!search.ok || !search.data || typeof search.data !== 'object') continue;
    for (const symbol of Array.isArray(search.data.symbols) ? search.data.symbols : []) {
      if (symbol?.path) searchPaths.push(symbol.path);
    }
    for (const hit of Array.isArray(search.data.text) ? search.data.text : []) {
      if (hit?.path) searchPaths.push(hit.path);
    }
  }

  return {
    discoveredFiles,
    tokens: intentTokens,
    paths: uniquePaths([...pathScores, ...searchPaths]).slice(0, MAX_FOCUS_PATH_CANDIDATES),
  };
}

function computeNext({ session, changedCount, profile, stage, intent = '' }) {
  const receipts = session?.receipts || [];
  const green = receipts.some((receipt) => receipt.exitCode === 0);
  const editedHere = (session?.touchedFiles || []).some((entry) => entry.source === 'edit');

  if (stage === 'change' || (editedHere && !green)) {
    const command = suggestVerify(profile);
    return command
      ? `verify(${JSON.stringify({ commands: [command] })})`
      : 'verify({"commands":["<your command>"]}) — set `verify` in .contextos/profile.json to auto-infer';
  }
  if (green) return 'done: verified; finalize unless a concrete requirement or failing check still needs work. Do not rerun the command.';
  if (changedCount > 0) {
    const command = suggestVerify(profile);
    return command
      ? `verify(${JSON.stringify({ commands: [command] })}) — dirty files exist with no receipt yet`
      : 'verify({"commands":["<your command>"]}) — dirty files exist with no receipt yet';
  }
  return `change(${JSON.stringify({ intent: intent || '<what you want to change>' })}) — pass edits: [{ path, target, replacement }]`;
}

export async function explorePipeline(ctx, input = {}) {
  const { caps, store, tracer, projectRoot, profile } = ctx;
  const intent = input.intent || input.task || '';

  const obs = await observe({ projectRoot, store });
  const session = store.ensureSession(intent);
  tracer.step('observe', { gitAvailable: obs.gitAvailable, reconciled: obs.reconciled });

  const explicitPaths = Array.isArray(input.paths) ? input.paths.filter(Boolean) : [];
  const paths = explicitPaths.length ? explicitPaths : extractPaths(intent);
  const identifiers = extractIdentifiers(intent);
  const tokens = tokenize(`${intent} ${paths.join(' ')} ${identifiers.join(' ')}`);

  const dirty = [...obs.untracked, ...obs.changed];
  const testContractLines = [];

  let activePlan = null;
  try {
    const plansRes = await caps.plan({ action: 'list', format: 'json', status: 'active', limit: 25, offset: 0 });
    const plans = Array.isArray(plansRes.data?.plans)
      ? plansRes.data.plans
      : (Array.isArray(plansRes.data) ? plansRes.data : []);
    if (plansRes.ok) {
      activePlan = plans
        .filter((plan) => plan.status === 'active')
        .sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')))
        .at(-1) || null;
    }
  } catch (_) {}

  const nowLines = [];
  if (activePlan) {
    const passedCps = (activePlan.checkpoints || []).filter((cp) => cp.status === 'passed').length;
    const totalCps = (activePlan.checkpoints || []).length;
    const currentPhase = activePlan.phases?.find((p) => p.status === 'in_progress' || p.status === 'active')?.id || activePlan.phases?.[0]?.id || 'P1';
    const totalPhases = activePlan.phases?.length || 1;
    nowLines.push(
      `- Active Plan: \`${activePlan.id}\` "${activePlan.title}" (Phase: ${currentPhase}/${totalPhases}, Checkpoints: ${passedCps}/${totalCps} passed)`
    );
  }
  nowLines.push(
    `- Session: \`${session.id}\` (${session.status})`,
    `- Intent: ${intent || '(none yet)'}`,
    `- Code dirty: ${dirty.length ? dirty.slice(0, 6).map((p) => `\`${p}\``).join(', ') : 'clean'}${dirty.length > 6 ? ` (+${dirty.length - 6})` : ''}`
  );
  if (session.touchedFiles.length) {
    const recentTouches = [...session.touchedFiles]
      .filter((entry) => entry.lastTouchedAt || entry.firstSeenAt)
      .sort((a, b) => Date.parse(b.lastTouchedAt || b.firstSeenAt) - Date.parse(a.lastTouchedAt || a.firstSeenAt))
      .slice(0, 6);
    if (recentTouches.length) {
      nowLines.push(`- Session touch history: ${recentTouches.map((entry) => `\`${entry.path}\``).join(', ')}`);
    }
  }
  if (session.receipts.length) {
    const last = session.receipts[session.receipts.length - 1];
    const olderFailed = session.receipts.slice(0, -1).filter((r) => r.exitCode !== 0 && r.status !== 'superseded');
    const maskInfo = olderFailed.length > 0 ? ` (${olderFailed.length} older failed receipt${olderFailed.length > 1 ? 's' : ''} masked)` : '';
    nowLines.push(`- Last receipt: \`${last.command}\` exit ${last.exitCode} (${last.id || 'n/a'}, ${receiptStatus(last)})${maskInfo}`);
  }
  const whereLines = [];

  // ModuleIndex is a navigation aid only. Its derived IDs are not Blocks and never determine semantic ownership.
  const index = new ModuleIndex({ projectRoot });
  index.bootstrapIfEmpty();
  index.ensure([...paths, ...dirty].slice(0, 12));
  const focus = await resolveExploreFocus({ caps, index, intent, identifiers });
  index.ensure(focus.paths.slice(0, 40));

  // Paths may point at a directory: expand it into the module's real files
  // instead of asking the AST engine to outline a folder.
  const resolvedPaths = [];
  for (const target of paths) {
    const fullPath = path.join(projectRoot, target);
    if (!fs.existsSync(fullPath)) continue;
    if (fs.statSync(fullPath).isDirectory()) {
      for (const file of focus.discoveredFiles) {
        if (file.startsWith(`${target.replace(/\/+$/, '')}/`) && !file.includes('node_modules')) {
          resolvedPaths.push(file);
        }
      }
    } else {
      resolvedPaths.push(target);
    }
  }
  for (const file of focus.paths) {
    if (!resolvedPaths.includes(file) && fs.existsSync(path.join(projectRoot, file))) {
      resolvedPaths.push(file);
    }
  }

  const modules = index.lookup(`${intent} ${paths.join(' ')}`);
  for (const module of modules) {
    const files = module.files.slice(0, 2).map((file) => `\`${file}\``).join(', ');
    const remaining = module.files.length > 2 ? ' (+' + (module.files.length - 2) + ')' : '';
    whereLines.push('- ' + (module.directory || 'workspace') + ' — ' + files + remaining + ' (derived navigation only; not Block ownership)');
    if (!focus.paths.length || resolvedPaths.length < 6) {
      for (const f of module.files) {
        if (!resolvedPaths.includes(f)) resolvedPaths.push(f);
      }
    }
  }
  // If resolvedPaths is still empty (e.g. non-English intent, vague prompt, or fresh workspace),
  // fallback to the top source files in index.entries so the agent is never left blind.
  if (resolvedPaths.length === 0 && index.entries.size > 0) {
    const allFiles = Array.from(index.entries.keys()).filter((f) => !f.includes('node_modules'));
    const srcFiles = allFiles.filter((f) => f.startsWith('src/') || f.startsWith('lib/') || f.startsWith('packages/'));
    const candidates = srcFiles.length > 0 ? srcFiles : allFiles;
    for (const f of candidates.slice(0, 5)) {
      resolvedPaths.push(f);
    }
  }

  // Small repositories are the common case for focused feature work and bug
  // fixes. If the whole relevant source/test surface fits in one bounded
  // package, inline it once instead of forcing the host to reconstruct it with
  // one inspect call per file. Large repositories keep the existing narrow
  // entry-point behavior.
  const bundleCandidates = Array.from(index.entries.keys())
    .filter((file) => !file.includes('node_modules'))
    .filter((file) => !file.startsWith('.contextos/') && !file.startsWith('dist/'))
    .filter((file) => /\.(?:mjs|cjs|js|jsx|ts|tsx|py|go|rs|java|rb|php|swift|kt|cs|cpp|c|h)$/i.test(file)
      || /^(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle)$/i.test(file))
    .filter((file) => /^(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle)$/i.test(file)
      || /^(?:src|lib|app|packages|test|tests|__tests__)\//.test(file)
      || /(?:^|\/)(?:test|tests|__tests__)\//.test(file)
      || /\.(?:test|spec)\.[^/]+$/i.test(file));
  let bundleChars = 0;
  for (const file of bundleCandidates) {
    try {
      bundleChars += fs.statSync(path.join(projectRoot, file)).size;
    } catch (_) {}
  }
  const smallWorkspaceBundle = bundleCandidates.length > 0
    && bundleCandidates.length <= SMALL_WORKSPACE_MAX_FILES
    && bundleChars <= SMALL_WORKSPACE_MAX_CHARS;
  if (smallWorkspaceBundle) {
    for (const file of bundleCandidates) {
      if (!resolvedPaths.includes(file)) resolvedPaths.push(file);
    }
  }

  const filePaths = Array.from(new Set(resolvedPaths)).slice(
    0,
    smallWorkspaceBundle
      ? SMALL_WORKSPACE_CRITICAL_MAX_FILES
      : (input.depth === 'deep' || focus.paths.length ? 10 : 6)
  );
  const outlineByPath = new Map();

  if (filePaths.length) {
    for (const [fileIndex, target] of filePaths.entries()) {
      const outline = await caps.code({ action: 'outline', path: target });
      if (outline.ok) {
        outlineByPath.set(target, outline.data);
        if (smallWorkspaceBundle) {
          if (fileIndex < 3) whereLines.push(`- \`${target}\` ${compactOutlineData(outline.data)}`);
        } else if (input.depth === 'deep') {
          whereLines.push(`- \`${target}\`\n${clip(outline.data, OUTLINE_CLIP)}`);
        } else {
          whereLines.push(`- \`${target}\` ${compactOutlineData(outline.data)}`);
        }
      } else {
        whereLines.push(`- \`${target}\`: ${outline.error}`);
      }
    }
    tracer.step('outline', { paths: filePaths });
  }
  if (smallWorkspaceBundle) {
    whereLines.push(
      `- Small workspace bundle (${filePaths.length} files, ${bundleChars} chars): `
      + filePaths.map((file) => `\`${file}\``).join(', ')
      + '. All selected source bodies and test contracts are inlined below; do not list or reread the repository.'
    );
  }

  // Small target files are usually the stubs or protocol shells the host must
  // edit. Inline every bounded stub, not just the first high-relevance hit:
  // leaving one implementation stub hidden makes the host fall back to a
  // whole-repo native dump before it can construct the edit.
  const criticalCandidates = [];
  const intentTokens = tokenize(intent);
  for (const target of filePaths) {
    let fileChars = 0;
    try {
      const stat = fs.statSync(path.join(projectRoot, target));
      if (stat.isFile()) fileChars = stat.size;
    } catch (_) {}
    const focusIndex = focus.paths.indexOf(target);
    const focusTarget = focusIndex >= 0;
    const maxInlineChars = smallWorkspaceBundle
      ? SMALL_WORKSPACE_MAX_CHARS
      : (focusTarget ? DECISION_SOURCE_FILE_MAX_CHARS : INSPECT_INLINE_MAX_CHARS);
    if (fileChars === 0 || fileChars > maxInlineChars) continue;
    const relevance = overlapScore(intentTokens, `${target} ${outlineByPath.get(target) || ''}`);
    const read = (smallWorkspaceBundle || focusTarget)
      ? await caps.code({ action: 'read', path: target, fullFile: true })
      : await caps.code({ action: 'read', path: target, startLine: 1, endLine: 200 });
    if (!read.ok || !read.data) continue;
    const stub = /not implemented|not yet implemented|unimplemented|todo|fixme/i.test(read.data);
    const isTest = isTestPath(target);
    criticalCandidates.push({ target, fileChars, read: read.data, relevance, stub, isTest, focusTarget, focusIndex });
  }
  criticalCandidates.sort((left, right) => (
    Number(right.focusTarget) - Number(left.focusTarget)
    || Number(right.stub) - Number(left.stub)
    || Number(right.isTest) - Number(left.isTest)
    || right.relevance - left.relevance
    || left.fileChars - right.fileChars
  ));
  const criticalLines = [];
  const focusSliceLines = [];
  const includedFocusSliceTargets = new Set();
  const criticalLimit = smallWorkspaceBundle ? SMALL_WORKSPACE_CRITICAL_MAX_FILES : 8;
  const includedCriticalTargets = new Set();
  let criticalChars = 0;
  let focusSliceChars = 0;
  for (const candidate of criticalCandidates.slice(0, criticalLimit)) {
    const { target, fileChars, read, stub, focusTarget } = candidate;
    if (smallWorkspaceBundle && isTestPath(target)) continue;
    const nextCriticalChars = criticalChars + String(read).length;
    if (!smallWorkspaceBundle
      && criticalLines.length > 0
      && nextCriticalChars > DECISION_SOURCE_TOTAL_MAX_CHARS) {
      continue;
    }
    const fence = path.extname(target).slice(1) || 'text';
    const readLimit = smallWorkspaceBundle
      ? Math.max(fileChars + 64, 512)
      : (focusTarget ? DECISION_SOURCE_FILE_MAX_CHARS : INSPECT_INLINE_MAX_CHARS);
    criticalLines.push(
      `- \`${target}\` (${fileChars} chars${stub ? ', implementation stub' : ''})\n\`\`\`${fence}\n${clip(stripOuterCodeFence(read), readLimit)}\n\`\`\``
    );
    includedCriticalTargets.add(target);
    criticalChars = nextCriticalChars;
  }
  if (criticalLines.length) tracer.step('critical_slices', { count: criticalLines.length });

  // Large focused files cannot be inlined whole. Return the exact methods
  // named by the intent instead of declaring the whole edit surface missing.
  for (const target of filePaths) {
    const focusIndex = focus.paths.indexOf(target);
    if (focusIndex < 0 || !isImplementationSource(target)) continue;
    let fileChars = 0;
    try {
      const stat = fs.statSync(path.join(projectRoot, target));
      if (stat.isFile()) fileChars = stat.size;
    } catch (_) {}
    if (fileChars === 0 || fileChars <= DECISION_SOURCE_FILE_MAX_CHARS) continue;
    const selected = selectFocusSymbols(outlineByPath.get(target), {
      identifiers,
      tokens: intentTokens,
    });
    if (!selected.symbols.length) continue;
    const slices = [];
    let fileSliceChars = 0;
    let fileComplete = true;
    for (const symbol of selected.symbols) {
      if (focusSliceChars + fileSliceChars >= DECISION_SOURCE_TOTAL_MAX_CHARS) {
        fileComplete = false;
        break;
      }
      const read = await caps.code({
        action: 'read',
        path: target,
        symbol: symbol.name,
      });
      if (!read.ok || !read.data) {
        fileComplete = false;
        continue;
      }
      const rawBody = stripOuterCodeFence(read.data);
      const bodyLimit = DECISION_SOURCE_FILE_MAX_CHARS - 256;
      const complete = rawBody.length <= bodyLimit;
      const body = complete
        ? rawBody
        : clip(rawBody, bodyLimit, { withHint: true });
      if (fileSliceChars + body.length > DECISION_SOURCE_FILE_MAX_CHARS) {
        fileComplete = false;
        continue;
      }
      slices.push({ symbol, body, complete });
      if (!complete) fileComplete = false;
      fileSliceChars += body.length;
    }
    if (!slices.length) continue;
    const partialSymbols = slices.filter((slice) => !slice.complete).map((slice) => slice.symbol.name);
    focusSliceLines.push(
      `- \`${target}\` (${fileChars} chars; focused symbols: ${slices.map((slice) => `\`${slice.symbol.name}\``).join(', ')}`
      + `${partialSymbols.length ? `; partial: ${partialSymbols.map((name) => `\`${name}\``).join(', ')}` : ''}`
      + `${selected.matched ? '' : '; fallback outline order'})\n`
      + slices.map((slice) => {
        const fence = path.extname(target).slice(1) || 'text';
        return `\`\`\`${fence}\n${slice.body}\n\`\`\``;
      }).join('\n\n')
    );
    if (fileComplete) includedFocusSliceTargets.add(target);
    focusSliceChars += fileSliceChars;
  }
  if (focusSliceLines.length) {
    tracer.step('focus_slices', {
      count: focusSliceLines.length,
      chars: focusSliceChars,
    });
  }

  // A map without dependency edges still forces the host to rediscover the
  // edit surface. Return one-hop imports, reverse callers, and test entries in
  // the same bounded response so the next host decision can mutate directly.
  const closure = collectExploreClosure(projectRoot, filePaths, index, {
    maxDependencies: 6,
    maxCallers: 4,
    maxTests: 2,
  });
  if (smallWorkspaceBundle) {
    for (const target of filePaths) {
      if (isTestContractPath(target)) closure.tests.push(target);
    }
  }
  closure.tests = [...new Set(closure.tests)].filter(isTestContractPath);
  if (closure.dependencies.length || closure.callers.length || closure.tests.length) {
    const closureLines = [];
    if (closure.dependencies.length) {
      closureLines.push(`- Direct imports: ${closure.dependencies.map((file) => `\`${file}\``).join(', ')}`);
    }
    if (closure.callers.length) {
      closureLines.push(`- Direct callers: ${closure.callers.map((file) => `\`${file}\``).join(', ')}`);
    }
    if (closure.tests.length) {
      closureLines.push(`- Test entry: ${closure.tests.map((file) => `\`${file}\``).join(', ')}`);
      for (const testFile of closure.tests.slice(0, smallWorkspaceBundle ? 4 : 2)) {
        const testRead = await caps.code({ action: 'read', path: testFile, startLine: 1, endLine: 80 });
        if (testRead.ok && testRead.data) {
          const testContract = clip(stripOuterCodeFence(testRead.data), 4200, { withHint: true });
          const testFence = path.extname(testFile).slice(1) || 'text';
          testContractLines.push(
            `- Test contract \`${testFile}\`: ${compactTestContract(testRead.data)}\n`
            + `\`\`\`${testFence}\n${testContract}\n\`\`\``
          );
        }
      }
    }
    for (const dependency of closure.dependencies.slice(0, 2)) {
      const outline = await caps.code({ action: 'outline', path: dependency });
      if (outline.ok) closureLines.push(`- Import symbols \`${dependency}\`: ${compactOutlineData(outline.data)}`);
    }
    whereLines.push(...closureLines);
    tracer.step('dependency_closure', {
      dependencies: closure.dependencies.length,
      callers: closure.callers.length,
      tests: closure.tests.length,
    });
  }

  // Pre-slicing and Action Slots:
  // Provide instant code previews so the agent never suffers from Read-Blindness,
  // and register actionable slots [S1], [S2] to eliminate parameter alignment errors.
  const isQuery = /[?？]/.test(intent) || /(在哪|谁在调用|为什么|怎么实现|在哪里)/.test(intent) || /^(where|who|why|how)\b/i.test(intent.trim());
  const sliceLines = [];
  const slots = {};
  let slotIdx = 1;

  if (!isQuery && input.depth === 'deep') {
    for (const target of filePaths.slice(0, 1)) {
      const read = await caps.code({ action: 'read', path: target, startLine: 1, endLine: 40 });
      if (read.ok && read.data) {
        sliceLines.push(`### \`${target}\`\n\`\`\`text\n${clip(read.data, 240)}\n\`\`\``);
      }
    }
    for (const target of filePaths.slice(0, 3)) {
      const slotId = `S${slotIdx++}`;
      slots[slotId] = { path: target, action: 'edit' };
    }
  }

  const slotLines = [];
  for (const [sId, sData] of Object.entries(slots)) {
    slotLines.push(`- [${sId}] Edit \`${sData.path}\` -> \`change({ slot: "${sId}", append: "..." })\` or \`change({ slot: "${sId}", symbol: "...", replacement: "..." })\``);
  }
  if (!isQuery && Object.keys(slots).length > 0) {
    const defaultVerify = profile.verify && profile.verify.length ? profile.verify[0] : 'npm test';
    const verifySlotId = `S${slotIdx++}`;
    slots[verifySlotId] = { action: 'verify', command: defaultVerify };
    slotLines.push(`- [${verifySlotId}] Verify -> in-situ in \`change({ verify: "${defaultVerify}" })\` or \`verify({ command: "${defaultVerify}" })\``);
  }

  store.setSlots(slots);

  const blocks = await caps.blocks();
  const chains = await caps.chains();
  const architectureState = blocks.ok && chains.ok
    ? (Array.isArray(blocks.data) && blocks.data.length === 0
        && Array.isArray(chains.data) && chains.data.length === 0
        ? 'empty'
        : 'ready')
    : 'unknown';
  if (blocks.ok && blocks.data.length) {
    const scored = blocks.data
      .map((block) => ({
        block,
        score: overlapScore(tokens, `${block.title} ${block.summary || ''} ${(block.artifactRefs || []).map((r) => r.path).join(' ')}`),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 1);
    for (const { block } of scored) {
      const refs = Array.from(new Set((block.artifactRefs || []).map((ref) => ref.path))).slice(0, 2);
      whereLines.push(`- curated [${block.id}] **${block.title}** — ${refs.length ? refs.map((p) => `\`${p}\``).join(', ') : 'no refs'}`);
    }
    tracer.step('blocks', { candidates: scored.length, total: blocks.data.length });
  }

  if (isQuery) {
    const searchQueries = Array.from(new Set([...identifiers, ...latinQueries(intent, paths.join(" "))]));
    for (const query of searchQueries.slice(0, 2)) {
      const search = await caps.code({ action: 'search', query });
      if (!search.ok || /No symbol or text match/i.test(search.data)) continue;
      whereLines.push(`- symbols \`${query}\`: ${clip(search.data, SEARCH_CLIP)}`);
    }
  }

  if (!whereLines.length) {
    whereLines.push('- No code or curated Block matched. ModuleIndex is derived navigation only; bind a semantic Block and add it to a Chain when ownership must persist.');
  }

  const rulesLines = [];
  const rules = await caps.rules();
  if (rules.ok && rules.data.length) {
    const scored = rules.data
      .map((rule) => ({ rule, score: overlapScore(tokens, `${rule.title} ${rule.category} ${rule.summary || ''}`) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);
    for (const { rule } of scored) {
      rulesLines.push(`- \`${rule.id}\` **${rule.title}** (${rule.category}) — ${clip(rule.summary || '', 120)}`);
    }
  }

  const memoryLines = [];
  for (const note of (session.notes || []).slice(-1)) {
    memoryLines.push(`- (${note.kind}) ${clip(note.text, 160)}`);
  }
  if (!memoryLines.length) {
    const headings = decisionHeadings(projectRoot);
    if (headings.length) memoryLines.push(headings[0]);
  }

  const implementationFocus = focus.paths.filter((filePath) => isImplementationSource(filePath));
  const publicSurfaceModules = uniquePaths([
    ...implementationFocus,
    ...criticalCandidates.map((candidate) => candidate.target),
  ]).filter((filePath) => isImplementationSource(filePath));
  const missingDecisionPaths = implementationFocus.filter((filePath) => (
    !includedCriticalTargets.has(filePath) && !includedFocusSliceTargets.has(filePath)
  ));
  const decisionComplete = smallWorkspaceBundle
    || (implementationFocus.length > 0 && missingDecisionPaths.length === 0);

  const criticalReadByTarget = new Map(criticalCandidates.map((candidate) => [candidate.target, candidate.read]));
  const entrypointPaths = filePaths
    .filter((filePath) => isImplementationSource(filePath))
    .filter((filePath) => /(^|\/)(index|main)\.(?:mjs|js|cjs|ts|tsx)$/i.test(filePath))
    .slice(0, 2);
  const publicSurfaceLines = [];
  const publicSurfaceGaps = [];
  for (const entrypoint of entrypointPaths) {
    let entryText = criticalReadByTarget.get(entrypoint);
    if (!entryText) {
      const entryRead = await caps.code({ action: 'read', path: entrypoint, fullFile: true });
      if (entryRead.ok) entryText = entryRead.data;
    }
    if (!entryText) continue;
    const entryDir = path.posix.dirname(entrypoint);
    const missingExports = publicSurfaceModules.filter((filePath) => {
      if (filePath === entrypoint) return false;
      const relative = path.posix.relative(entryDir, filePath);
      const normalized = relative.startsWith('.') ? relative : `./${relative}`;
      const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return !new RegExp(`from\\s+['"]${escaped}['"]`).test(entryText);
    });
    if (missingExports.length) {
      publicSurfaceGaps.push(...missingExports);
      publicSurfaceLines.push(
        `- \`${entrypoint}\` does not re-export decision-package module(s): ${missingExports.map((file) => `\`${file}\``).join(', ')}. Include the entrypoint update in the same change only when these modules expose public API.`
      );
    } else {
              publicSurfaceLines.push(`- \`${entrypoint}\` re-exports every decision-package module.`);
    }
  }

  const nextLines = [`👉 ${computeNext({ session, changedCount: dirty.length, profile, stage: 'explore', intent })}`];
  if (smallWorkspaceBundle) {
    nextLines.push('The complete small-workspace source/test bundle is already in this response. Go directly to change/work; do not run `rg --files`, `cat`, `sed`, or per-file inspect first.');
  } else if (!decisionComplete && missingDecisionPaths.length) {
    nextLines.push(
      `Decision package is partial: the exact source for ${missingDecisionPaths.slice(0, 3).map((file) => `\`${file}\``).join(', ')} is not inlined. `
      + 'Use one bounded `inspect({path, full:true})` recovery read for the named file, then mutate; do not scan unrelated modules.'
    );
  } else if (decisionComplete) {
    nextLines.push('The focused implementation source is already in this response. Go directly to change/work; do not reconstruct it with per-file reads.');
  }
  const stubTargets = criticalCandidates
    .filter((candidate) => candidate.stub)
    .map((candidate) => `\`${candidate.target}\``);
  if (stubTargets.length) {
    nextLines.push(`Exact implementation stubs are already included: ${stubTargets.join(', ')}. Build \`change\` directly; do not dump source with native \`rg\`/\`cat\`.`);
  }
  if (publicSurfaceGaps.length) {
    nextLines.push('Public surface gap detected: include the entrypoint/barrel update in the same change when the new capability is public.');
  }

  const requestedBudget = Number(input.maxChars);
  const budget = smallWorkspaceBundle
    ? Math.max(resolveBudget(input.depth, ctx.profile?.budget), PIPELINE_EXPLORE_OUTPUT_CLIP)
    : (Number.isFinite(requestedBudget) && requestedBudget > 0
        ? Math.min(Math.floor(requestedBudget), PIPELINE_EXPLORE_OUTPUT_CLIP)
        : resolveBudget(input.depth, ctx.profile?.budget));
  const decisionLines = [
    `- read_complete=${decisionComplete ? 'true' : 'false'}`,
    `- do_not_reread=${decisionComplete ? 'true' : 'false'}`,
    `- native_mutation=forbidden${decisionComplete ? '-after-read-complete' : ''}`,
    '- after_read_complete=change_or_work_only',
    `- architecture=${architectureState}${architectureState === 'empty' ? '; change must bind blocks/chains (chain.memberIds=block ids; use semantic kinds, never kind:"module")' : ''}`,
    `- files=${filePaths.length}`,
    decisionComplete
      ? '- next=change({edits,verify,architecture})'
      : '- next=inspect({path,full:true}) for the named missing target, then change({edits,verify})',
  ];
  if (!decisionComplete && missingDecisionPaths.length) {
    decisionLines.push(`- missing=${missingDecisionPaths.slice(0, 4).join(',')}`);
  }
  const sections = [
    {
      key: 'decision',
      title: 'Decision Package',
      priority: -1,
      lines: decisionLines,
    },
    { key: 'next', title: 'Next', priority: 1, lines: nextLines },
    { key: 'now', title: 'Now', priority: 2, lines: nowLines },
  ];
  if (slotLines.length) {
    sections.push({ key: 'slots', title: 'Available Action Slots (Pick a slot or pass directly)', priority: 3, lines: slotLines });
  }
  if (criticalLines.length) {
    sections.push({ key: 'critical', title: 'Critical slices (bounded)', priority: 0, lines: criticalLines });
  }
  if (focusSliceLines.length) {
    sections.push({ key: 'focus-slices', title: 'Focused symbol slices (bounded)', priority: 0, lines: focusSliceLines });
  }
  if (testContractLines.length) {
    sections.push({ key: 'test-contract', title: 'Test contract', priority: 0, lines: testContractLines });
  }
  if (publicSurfaceLines.length) {
    sections.push({ key: 'public-surface', title: 'Public surface', priority: 0, lines: publicSurfaceLines });
  }
  sections.push(
    { key: 'where', title: 'Where to look', priority: 4, lines: whereLines }
  );
  if (sliceLines.length) {
    sections.push({ key: 'slices', title: 'Code Slices (Direct Preview)', priority: 5, lines: sliceLines });
  }
  sections.push(
    { key: 'rules', title: 'Applicable rules', priority: 6, lines: rulesLines },
    { key: 'memory', title: 'Memory', priority: 7, lines: memoryLines }
  );

  const { text, meta } = fitSections(sections, { maxChars: budget });

  tracer.step('explore.response', { budget, ...meta });
  return `# ContextOS explore\n\n${text}\n\n<!-- budget ${meta.used}/${meta.maxChars} chars; dropped: ${meta.dropped.join(',') || 'none'} -->`;
}


function normalizeGraphPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function isCuratedArchitectureBlock(block) {
  const id = String(block?.id || '');
  const title = String(block?.title || '');
  return Boolean(id)
    && !id.startsWith('mod-')
    && block?.kind !== 'module'
    && !/^derived module\b/i.test(title);
}

function blockCoversGraphPath(block, filePath) {
  const normalized = normalizeGraphPath(filePath);
  return (block?.artifactRefs || []).some((ref) => {
    const binding = normalizeGraphPath(ref.path);
    return ref.anchorKind === 'tree'
      ? normalized === binding || normalized.startsWith(binding + '/')
      : normalized === binding;
  });
}

function graphBindingsOverlap(left, right) {
  const a = normalizeGraphPath(left);
  const b = normalizeGraphPath(right);
  return Boolean(a && b) && (
    a === b
    || a.startsWith(`${b}/`)
    || b.startsWith(`${a}/`)
  );
}

const NON_ARCHITECTURE_PREFIXES = [
  'dist/',
  'plugins/contextos/server/',
];

function isReservedStatePath(filePath) {
  const normalized = normalizeGraphPath(filePath);
  const root = normalized.split('/')[0] || '';
  return root === '.contextos' || root.startsWith('.contextos-') || root.startsWith('.contextos.');
}

const NON_ARCHITECTURE_EXTENSIONS = new Set([
  '.md',
  '.json',
  '.lock',
  '.toml',
  '.yaml',
  '.yml',
]);

export function isCuratedArchitecturePath(filePath) {
  const normalized = normalizeGraphPath(filePath);
  if (!normalized) return false;
  if (isReservedStatePath(normalized)) return false;
  if (NON_ARCHITECTURE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return false;
  if (NON_ARCHITECTURE_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase())) return false;
  if (new Set(['LICENSE', 'CHANGELOG']).has(path.posix.basename(normalized).toUpperCase())) return false;
  return true;
}

function analyzeArchitectureCoverage(paths, blocks, chains) {
  const memberships = new Map();
  for (const chain of chains || []) {
    for (const memberId of chain.memberIds || chain.member_ids || []) {
      const list = memberships.get(memberId) || [];
      list.push(chain.id);
      memberships.set(memberId, list);
    }
  }

  return [...new Set((paths || []).map(normalizeGraphPath))].filter(isCuratedArchitecturePath).map((filePath) => {
    const owners = (blocks || []).filter((block) =>
      isCuratedArchitectureBlock(block) && blockCoversGraphPath(block, filePath)
    );
    if (owners.length === 0) return { path: filePath, owners: [], chains: [], issue: 'missing-block' };
    if (owners.length > 1) {
      return { path: filePath, owners: owners.map((block) => block.id), chains: [], issue: 'multiple-blocks' };
    }
    const ownerId = owners[0].id;
    const chainIds = memberships.get(ownerId) || [];
    return {
      path: filePath,
      owners: [ownerId],
      chains: chainIds,
      issue: chainIds.length ? null : 'missing-chain',
    };
  });
}

function formatArchitectureGap(gap) {
  const tick = String.fromCharCode(96);
  const file = tick + gap.path + tick;
  if (gap.issue === 'missing-block') {
    return '- ' + file + ': no curated Block owner; add it under architecture.blocks.';
  }
  if (gap.issue === 'multiple-blocks') {
    return '- ' + file + ': multiple curated Block owners (' + gap.owners.join(', ') + '); keep exactly one.';
  }
  if (gap.issue === 'missing-chain') {
    return '- ' + file + ': Block ' + gap.owners[0] + ' is not a member of a Chain; compose the membership.';
  }
  return '- ' + file + ': architecture could not be verified.';
}

async function bindChangedArchitecture(caps, changedPaths, architecture, { dryRun = false } = {}) {
  if (architecture !== undefined && architecture !== null
      && (typeof architecture !== 'object' || Array.isArray(architecture))) {
    return { ok: false, error: 'architecture must be an object with blocks and chains arrays.', refreshed: 0, bound: 0, composed: 0, gaps: [] };
  }

  const initialBlocksResult = await caps.blocks();
  const initialChainsResult = await caps.chains();
  if (!initialBlocksResult.ok || !initialChainsResult.ok) {
    return {
      ok: false,
      error: 'could not read current Block/Chain graph: ' + (initialBlocksResult.error || initialChainsResult.error),
      refreshed: 0,
      bound: 0,
      composed: 0,
      gaps: [],
    };
  }

  const initialBlocks = initialBlocksResult.data || [];
  const blockSpecs = Array.isArray(architecture?.blocks) ? architecture.blocks : [];
  const chainSpecs = Array.isArray(architecture?.chains) ? architecture.chains : [];
  const blockById = new Map(initialBlocks.map((block) => [block.id, block]));
  const errors = [];
  const preparedBlocks = [];
  const preparedChains = [];

  for (const spec of blockSpecs) {
    const id = String(spec?.id || '').trim();
    const existing = blockById.get(id);
    const title = String(spec?.title || spec?.name || existing?.title || id).trim();
    const kind = String(spec?.kind || existing?.kind || 'component').trim();
    const semanticKind = kind === 'module' ? 'component' : kind;
    const rawPaths = spec?.paths ?? spec?.path ?? spec?.files ?? spec?.file;
    const pathValues = Array.isArray(rawPaths) ? rawPaths : rawPaths == null ? [] : [rawPaths];
    const paths = pathValues
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    if (!id || !title || !semanticKind || !paths.length) {
      errors.push('each architecture Block needs id, title, paths, and optional kind (kind defaults to component)');
      continue;
    }
    if (id.startsWith('mod-') || /^derived module\b/i.test(title)) {
      errors.push(
        'derived module identity is not a semantic Block: ' + id
        + '; use a semantic kind such as component, service, engine, gateway, api, ui, tooling, verification, or testing'
        + ' ("module" and "mod-*" ids are reserved for AST-derived ModuleIndex entries)'
      );
      continue;
    }
    const blockData = { title, kind: semanticKind };
    const summary = spec.summary ?? spec.responsibility ?? existing?.summary;
    const details = spec.details ?? existing?.details;
    if (summary !== undefined) blockData.summary = summary;
    if (details !== undefined) blockData.details = details;
    preparedBlocks.push({ id, paths, symbols: spec.symbols, blockData });
  }

  for (const spec of chainSpecs) {
    const id = String(spec?.id || '').trim();
    const title = String(spec?.title || spec?.name || id).trim();
    const rawMemberIds = spec?.memberIds ?? spec?.member_ids ?? spec?.blocks;
    const memberIds = Array.isArray(rawMemberIds)
      ? [...new Set(rawMemberIds.map((value) => String(value || '').trim()).filter(Boolean))]
      : [];
    if (!id || !title || !memberIds.length) {
      errors.push('each architecture Chain needs id, title, and memberIds');
      continue;
    }
    const chainData = { ...spec, id, title, memberIds };
    delete chainData.member_ids;
    delete chainData.replaceMembers;
    preparedChains.push({ chainData, replaceMembers: spec.replaceMembers === true });
  }

  // Validate the complete graph payload before issuing any write.  Without
  // this preflight, a valid Block could be persisted before a later Chain
  // references a missing/derived/non-curated member, leaving a half-applied
  // architecture update for the next host turn to diagnose.
  const explicitOwners = new Map();
  const conflictKeys = new Set();
  for (const block of preparedBlocks) {
    for (const rawPath of block.paths) {
      const normalized = normalizeGraphPath(rawPath);
      if (!normalized) continue;
      const existingOwner = explicitOwners.get(normalized);
      if (existingOwner && existingOwner !== block.id) {
        const key = `${existingOwner}:${block.id}:${normalized}`;
        if (!conflictKeys.has(key)) {
          errors.push(`path ${normalized} is assigned to multiple Blocks: ${existingOwner}, ${block.id}`);
          conflictKeys.add(key);
        }
      } else {
        explicitOwners.set(normalized, block.id);
      }
      const existingConflicts = initialBlocks.filter((existing) => (
        existing.id !== block.id
        && isCuratedArchitectureBlock(existing)
        && (existing.artifactRefs || []).some((ref) => graphBindingsOverlap(ref.path, normalized))
      ));
      for (const existing of existingConflicts) {
        const key = `${existing.id}:${block.id}:${normalized}`;
        if (conflictKeys.has(key)) continue;
        errors.push(`path ${normalized} is already owned by Block ${existing.id}`);
        conflictKeys.add(key);
      }
    }
  }

  const blocksAfterPreparation = new Map(initialBlocks.map((block) => [block.id, block]));
  for (const block of preparedBlocks) {
    blocksAfterPreparation.set(block.id, { id: block.id, ...block.blockData });
  }
  const chainsById = new Map((initialChainsResult.data || []).map((chain) => [chain.id, chain]));
  for (const { chainData, replaceMembers } of preparedChains) {
    const existing = chainsById.get(chainData.id);
    const requestedMembers = Array.isArray(chainData.memberIds) ? chainData.memberIds : [];
    const memberIds = [...new Set(replaceMembers
      ? requestedMembers
      : [...(existing?.memberIds || []), ...requestedMembers])];
    const derivedMembers = memberIds.filter((memberId) => String(memberId).toLowerCase().startsWith('mod-'));
    const missingMembers = memberIds.filter((memberId) => !blocksAfterPreparation.has(memberId));
    const nonCuratedMembers = memberIds.filter((memberId) => {
      const block = blocksAfterPreparation.get(memberId);
      return block && !isCuratedArchitectureBlock(block);
    });
    if (derivedMembers.length) {
      errors.push('Chain ' + chainData.id + ' cannot include derived ModuleIndex ids: ' + derivedMembers.join(', ') + '.');
    }
    if (missingMembers.length) {
      errors.push('Chain ' + chainData.id + ' cannot include missing Block(s): ' + missingMembers.join(', ') + '.');
    }
    if (nonCuratedMembers.length) {
      errors.push('Chain ' + chainData.id + ' cannot include non-curated module Block(s): ' + nonCuratedMembers.join(', ') + '.');
    }
  }

  // A changed Block without Chain membership is an incomplete architecture
  // decision: the host would need another call solely to repair the graph.
  // Compose uncovered prepared Blocks into one deterministic additive Chain.
  const chainMembersAfterPreparation = new Map();
  for (const chain of initialChainsResult.data || []) {
    chainMembersAfterPreparation.set(
      chain.id,
      new Set(Array.isArray(chain.memberIds) ? chain.memberIds : [])
    );
  }
  for (const { chainData, replaceMembers } of preparedChains) {
    const existingMembers = chainMembersAfterPreparation.get(chainData.id) || new Set();
    const requestedMembers = Array.isArray(chainData.memberIds) ? chainData.memberIds : [];
    chainMembersAfterPreparation.set(
      chainData.id,
      new Set(replaceMembers
        ? requestedMembers
        : [...existingMembers, ...requestedMembers])
    );
  }
  const coveredBlockIds = new Set(
    [...chainMembersAfterPreparation.values()].flatMap((members) => [...members])
  );
  const uncoveredPreparedBlocks = preparedBlocks
    .map((block) => block.id)
    .filter((id) => !coveredBlockIds.has(id));
  if (uncoveredPreparedBlocks.length) {
    const existingChangedSurface = preparedChains.find(
      (entry) => entry.chainData.id === 'chain-changed-surface'
    );
    if (existingChangedSurface) {
      existingChangedSurface.chainData.memberIds = [
        ...new Set([
          ...(existingChangedSurface.chainData.memberIds || []),
          ...uncoveredPreparedBlocks,
        ]),
      ];
    } else {
      preparedChains.push({
        chainData: {
          id: 'chain-changed-surface',
          title: 'Changed surface',
          memberIds: uncoveredPreparedBlocks,
        },
        replaceMembers: false,
      });
    }
  }

  if (errors.length) {
    return { ok: false, error: errors.join('; '), refreshed: 0, bound: 0, composed: 0, gaps: [] };
  }
  if (dryRun) {
    return { ok: true, refreshed: 0, bound: 0, composed: 0, gaps: [] };
  }

  const explicitPaths = new Set(preparedBlocks.flatMap((block) => block.paths.map(normalizeGraphPath)));
  let bound = 0;
  let refreshed = 0;
  let composed = 0;

  for (const spec of preparedBlocks) {
    const payload = {
      action: 'bind_auto',
      id: spec.id,
      paths: spec.paths,
      symbols: spec.symbols,
      replacePaths: true,
      blockData: spec.blockData,
      format: 'json',
    };
    let result = await caps.block(payload);
    if (!result.ok && Array.isArray(spec.symbols) && spec.symbols.length) {
      // A stale symbol hint must not invalidate the whole architecture
      // transaction. Retry at file level; the strict service contract still
      // rejects explicit symbol mismatch when called directly.
      result = await caps.block({ ...payload, symbols: undefined });
    }
    if (result.ok) bound += 1;
    else errors.push('Block ' + spec.id + ': ' + result.error);
  }

  const refreshGroups = new Map();
  for (const filePath of changedPaths || []) {
    const normalized = normalizeGraphPath(filePath);
    if (explicitPaths.has(normalized)) continue;
    const owners = initialBlocks.filter((block) =>
      isCuratedArchitectureBlock(block) && blockCoversGraphPath(block, normalized)
    );
    if (owners.length !== 1) continue;
    const group = refreshGroups.get(owners[0].id) || [];
    group.push(normalized);
    refreshGroups.set(owners[0].id, group);
  }

  for (const [id, paths] of refreshGroups) {
    const result = await caps.block({
      action: 'bind_auto',
      id,
      paths,
      replacePaths: true,
      format: 'json',
    });
    if (result.ok) refreshed += 1;
    else errors.push('Block ' + id + ' refresh: ' + result.error);
  }

  for (const spec of preparedChains) {
    const result = await caps.chain({
      action: 'compose',
      chainData: spec.chainData,
      replaceMembers: spec.replaceMembers,
      format: 'json',
    });
    if (result.ok) composed += 1;
    else errors.push('Chain ' + spec.chainData.id + ': ' + result.error);
  }

  const finalBlocksResult = await caps.blocks();
  const finalChainsResult = await caps.chains();
  if (!finalBlocksResult.ok || !finalChainsResult.ok) {
    errors.push('could not verify updated Block/Chain graph');
    return { ok: false, error: errors.join('; '), refreshed, bound, composed, gaps: [] };
  }
  const coverage = analyzeArchitectureCoverage(
    changedPaths,
    finalBlocksResult.data || [],
    finalChainsResult.data || []
  );
  return {
    ok: errors.length === 0,
    error: errors.join('; '),
    refreshed,
    bound,
    composed,
    coverage,
    gaps: coverage.filter((entry) => entry.issue),
  };
}

export async function changePipeline(ctx, input = {}) {
  const { caps, store, tracer, profile } = ctx;
  const shipRequest = input.ship === true
    ? {}
    : (typeof input.ship === 'string'
      ? { summary: input.ship }
      : (input.ship && typeof input.ship === 'object' && !Array.isArray(input.ship) ? input.ship : null));
  const creates = Array.isArray(input.create) ? [...input.create] : [];
  const rawEdits = Array.isArray(input.edits) ? [...input.edits] : [];
  const rawDeletes = Array.isArray(input.delete)
    ? [...input.delete]
    : (Array.isArray(input.deletes) ? [...input.deletes] : []);
  const deletes = rawDeletes.map((spec) => (typeof spec === 'string' ? { path: spec } : spec));

  if (input.path && typeof input.content === 'string' && input.fullFile !== true) {
    creates.push({
      path: input.path,
      content: input.content,
      overwrite: input.overwrite ?? true,
    });
  }

  if (input.slot || input.append || input.symbol || input.replacement || input.target || input.fullFile) {
    if (!rawEdits.length && (input.path || input.slot)) {
      rawEdits.push({
        slot: input.slot,
        path: input.path,
        target: input.target,
        replacement: input.replacement ?? (input.fullFile ? input.content : undefined),
        symbol: input.symbol,
        append: input.append,
        startLine: input.startLine,
        endLine: input.endLine,
        fullFile: input.fullFile,
      });
    }
  }

  // Resolve slots for each edit
  const edits = rawEdits.map((spec) => {
    let filePath = spec.path || (typeof input.path === 'string' ? input.path : undefined);
    let symbol = spec.symbol;
    if (spec.slot) {
      const slotData = store.getSlot(spec.slot);
      if (slotData) {
        filePath = slotData.path || filePath;
        symbol = slotData.symbol || symbol;
      }
    }
    return {
      ...spec,
      path: filePath,
      symbol,
    };
  });
  const resultLines = [];
  const touched = [];

  if (input.dryRun === true) {
    const previewLines = [];

    creates.forEach((spec, index) => {
      const resolved = resolvePreviewPath(ctx.projectRoot, spec?.path);
      if (resolved.error) {
        previewLines.push(`### Create ${index + 1}\n- File: \`${spec?.path || '(missing)'}\`\n- Error: ${resolved.error}`);
        return;
      }
      const exists = fs.existsSync(resolved.fullPath);
      const before = exists ? fs.readFileSync(resolved.fullPath, 'utf8') : '';
      const wouldCreate = exists ? (spec?.overwrite ? 'true (overwrite)' : 'false (file already exists)') : 'true';
      previewLines.push(
        [
          `### Create ${index + 1}`,
          `- File: \`${resolved.relativePath}\``,
          `- Target unique: n/a (create)`,
          `- Would create: ${wouldCreate}`,
          '- Before:',
          '```text',
          before,
          '```',
          '- After:',
          '```text',
          spec?.content ?? '',
          '```',
        ].join('\n')
      );
    });

    deletes.forEach((spec, index) => {
      const resolved = resolvePreviewPath(ctx.projectRoot, spec?.path);
      if (resolved.error) {
        previewLines.push(`### Delete ${index + 1}\n- File: \`${spec?.path || '(missing)'}\`\n- Error: ${resolved.error}`);
        return;
      }
      const exists = fs.existsSync(resolved.fullPath);
      const isFile = exists && fs.statSync(resolved.fullPath).isFile();
      const before = isFile ? fs.readFileSync(resolved.fullPath, 'utf8') : '';
      previewLines.push(
        [
          `### Delete ${index + 1}`,
          `- File: \`${resolved.relativePath}\``,
          `- Would delete: ${isFile ? 'true' : 'false (missing or non-file)'}`,
          '- Before:',
          '```text',
          before,
          '```',
          '- After:',
          '```text',
          '(deleted)',
          '```',
        ].join('\n')
      );
    });

    edits.forEach((spec, index) => {
      previewLines.push(renderEditPreview(previewEdit(ctx.projectRoot, spec, store), index));
    });

    if (!previewLines.length) {
      previewLines.push('No edits, creates, or deletes supplied.');
    }

    const { text } = fitSections(
      [{ key: 'preview', title: 'Preview', priority: 0, lines: previewLines }],
      { maxChars: resolveBudget(input.depth, ctx.profile?.budget) }
    );
    return `# ContextOS change (dry run)\n\n${text}`;
  }

  if (!creates.length && !edits.length && !deletes.length) {
    if (input.verify !== undefined || (Array.isArray(input.commands) && input.commands.length)) {
      return verifyPipeline(ctx, input);
    }
    if (input.architecture && typeof input.architecture === 'object' && !Array.isArray(input.architecture)) {
      const architectureResult = await bindChangedArchitecture(caps, [], input.architecture);
      tracer.step('architecture_state_only', {
        ok: architectureResult.ok,
        bound: architectureResult.bound,
        composed: architectureResult.composed,
        refreshed: architectureResult.refreshed,
        gaps: architectureResult.gaps?.length || 0,
      });
      const lines = [
        '- Architecture: ' + architectureResult.refreshed + ' existing Block(s) refreshed, '
          + architectureResult.bound + ' curated Block(s) bound, '
          + architectureResult.composed + ' Chain(s) composed.',
      ];
      if (architectureResult.error) lines.push('- Architecture update needs attention: ' + clip(architectureResult.error, 300));
      for (const gap of (architectureResult.gaps || []).slice(0, 6)) lines.push(formatArchitectureGap(gap));
      if ((architectureResult.gaps || []).length > 6) lines.push('- (' + (architectureResult.gaps.length - 6) + ' more architecture gap(s))');
      return [
        '# ContextOS change',
        '',
        '## Next',
        architectureResult.ok
          ? 'done: architecture state is bound; continue with code edits or verification only if required.'
          : '👉 fix the architecture contract error, then retry the same change call.',
        '',
        '## Result',
        ...lines,
      ].join('\n');
    }
    const targets = (Array.isArray(input.paths) && input.paths.length ? input.paths : extractPaths(input.intent || '')).slice(0, 2);
    const previewLines = [];
    for (const target of targets) {
      const read = await caps.code({ action: 'read', path: target, startLine: 1, endLine: 60 });
      previewLines.push(read.ok ? `- \`${target}\`\n${clip(read.data, OUTLINE_CLIP)}` : `- \`${target}\`: ${read.error}`);
    }
    if (!previewLines.length) {
      previewLines.push('Pass `edits: [{ path, target, replacement }]`, `create: [{ path, content }]`, or `delete: [{ path }]`, or call `explore` first to locate the target.');
    }
    if (input.architecture && typeof input.architecture === 'object') {
      // A state-only architecture payload is a common false positive: the
      // caller believes ownership was bound, but nothing was applied.
      previewLines.push('NOT applied: `architecture` is only bound together with `edits`, `create`, or `delete`. For a state-only update use `ops({ capability: "block", action: "bind_auto" })` and `ops({ capability: "chain", action: "compose" })`.');
    }
    const { text } = fitSections(
      [
        { key: 'next', title: 'Next', priority: 0, lines: ['👉 change({ edits: [{ path, target, replacement }] }) or change({ delete: [{ path }] })'] },
        { key: 'preview', title: 'Preview', priority: 1, lines: previewLines },
      ],
      { maxChars: resolveBudget(input.depth, ctx.profile?.budget) }
    );
    return `# ContextOS change (propose)\n\n${text}`;
  }

  const changes = [
    ...creates.map((spec) => ({
      kind: 'create',
      path: spec?.path,
      content: spec?.content ?? '',
      overwrite: Boolean(spec?.overwrite),
    })),
    ...edits.map((spec) => ({
      kind: 'edit',
      path: spec?.path,
      target: stripInspectMetadata(spec?.target ?? spec?.targetContent),
      replacement: spec?.replacement ?? spec?.replacementContent ?? (spec?.fullFile ? spec?.content : ''),
      startLine: spec?.startLine,
      endLine: spec?.endLine,
      symbol: spec?.symbol,
      append: spec?.append,
      fullFile: Boolean(spec?.fullFile),
    })),
    ...deletes.map((spec) => ({
      kind: 'delete',
      path: spec?.path,
    })),
  ];

  if (input.architecture && typeof input.architecture === 'object' && !Array.isArray(input.architecture)) {
    const architecturePreflight = await bindChangedArchitecture(
      caps,
      changes.map((change) => change.path).filter(Boolean),
      input.architecture,
      { dryRun: true }
    );
    if (!architecturePreflight.ok) {
      const lines = [
        '- Architecture contract rejected before changeset: ' + clip(architecturePreflight.error || 'invalid contract', 300),
        '- No files were modified. Fix the Block/Chain payload, then retry the same change call.',
      ];
      tracer.step('architecture_preflight', { ok: false, error: architecturePreflight.error || 'invalid contract' });
      return [
        '# ContextOS change',
        '',
        '## Next',
        '👉 fix the architecture contract error, then retry the same change call; no files were modified.',
        '',
        '## Result',
        ...lines,
      ].join('\n');
    }
    tracer.step('architecture_preflight', { ok: true });
  }

  const backups = new Map();
  const originallyMissing = new Set();
  if (input.autoRevert === true && input.verify) {
    const mutationPaths = [...creates, ...edits, ...deletes]
      .map((spec) => spec?.path)
      .filter(Boolean);
    for (const filePath of mutationPaths) {
      const fullPath = path.resolve(ctx.projectRoot, filePath);
      const relative = path.relative(ctx.projectRoot, fullPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      if (backups.has(fullPath) || originallyMissing.has(fullPath)) continue;
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        backups.set(fullPath, {
          content: fs.readFileSync(fullPath, 'utf8'),
          mode: fs.statSync(fullPath).mode,
        });
      } else {
        originallyMissing.add(fullPath);
      }
    }
  }

  const changeset = changes.length
    ? await caps.code({ action: 'changeset', changes, format: 'json' })
    : { ok: true, data: { files: [] } };
  if (!changeset.ok) {
    tracer.step('changeset', { ok: false, error: changeset.error });
    const hint = /TargetContent not found/i.test(changeset.error || '')
      ? ' Use exact source text without the `// path [Lx-Ly] (hash: ...)` metadata line, or set `fullFile:true` for a whole-file replacement.'
      : '';
    resultLines.push(`- ✗ changeset rejected: ${changeset.error}${hint}`);
    const { text } = fitSections(
      [
        { key: 'next', title: 'Next', priority: 0, lines: ['Fix the changeset error, then retry `change`; no files were modified.'] },
        { key: 'result', title: 'Result', priority: 1, lines: resultLines },
      ],
      { maxChars: resolveBudget(input.depth, ctx.profile?.budget) }
    );
    return `# ContextOS change\n\n${text}`;
  }

  const changedFiles = Array.isArray(changeset.data?.files) ? changeset.data.files : [];
  for (const file of changedFiles) {
    const action = file.deleted ? 'deleted' : (file.created ? 'created' : 'edited');
    resultLines.push(`- ${action} \`${file.path}\` (hash ${file.newHash || 'n/a'}, ${(file.locators || []).length} locators re-anchored)`);
    touched.push(file.path);
  }
  tracer.step('changeset', { ok: true, files: touched });

  let session = store.touch(
    changedFiles.map((file) => ({
      path: file.path,
      source: file.deleted ? 'delete' : 'edit',
      ...(file.deleted ? { deleted: true } : {}),
    })),
    'edit'
  );
  const verifyLines = [];
  const failureLines = [];
  let verifyPassed = true;

  const verifyCommands = verifyCommandsFromInput(input.verify, profile);

  if (verifyCommands.length) {
    if (verifyCommands && verifyCommands.length) {
      const fingerprint = workspaceFingerprint(ctx.projectRoot);
      for (const cmd of verifyCommands) {
        const res = await caps.run({
          command: cmd,
          cwd: input.cwd,
          maxLogBytes: input.maxLogBytes,
          timeoutMs: input.timeoutMs ?? profile.timeoutMs,
        });
        if (!res.ok) {
          verifyPassed = false;
          verifyLines.push(`- \`${cmd}\` → ✗ ${res.error}`);
          continue;
        }
        const receipt = res.data;
        receipt.stateHash = fingerprint;
        store.attachReceipt(receipt);
        session = store.current;
        const label = redactSecrets(cmd);
        verifyLines.push(`- \`${label}\` → exit ${receipt.exitCode} (${receipt.durationMs}ms, receipt ${receipt.id})`);
        if (receipt.exitCode !== 0) {
          verifyPassed = false;
          const diag = receipt.diagnostics && receipt.diagnostics.length
            ? receipt.diagnostics.join('\n\n---\n\n')
            : (receipt.errors && receipt.errors.length ? receipt.errors.slice(0, 5).join('\n') : clip(receipt.summary || 'failed', 240));
          failureLines.push(`### \`${label}\`\n${diag}`);
        }
        tracer.step('change_verify', { command: cmd, exitCode: receipt.exitCode });
      }

      if (!verifyPassed && input.autoRevert === true) {
        for (const fullPath of originallyMissing) {
          try {
            if (fs.existsSync(fullPath)) fs.rmSync(fullPath, { force: true });
          } catch (_) {}
        }
        for (const [fullPath, backup] of backups) {
          try { fs.writeFileSync(fullPath, backup.content, { encoding: 'utf8', mode: backup.mode }); } catch (_) {}
        }
        resultLines.push(`- ↺ autoReverted disk changes due to verify failure`);
      } else if (verifyPassed) {
        resultLines.push('- verify: PASS (receipt attached; do not rerun this command)');
      }
    }
  }

  const liveChangedPaths = changedFiles.filter((file) => !file.deleted).map((file) => file.path);
  if (!verifyPassed && (liveChangedPaths.length || input.architecture)) {
    resultLines.push('- Architecture binding skipped because verification failed.');
  } else if (liveChangedPaths.length || input.architecture) {
    const architectureResult = await bindChangedArchitecture(caps, liveChangedPaths, input.architecture);
    tracer.step('architecture', {
      ok: architectureResult.ok,
      refreshed: architectureResult.refreshed,
      bound: architectureResult.bound,
      composed: architectureResult.composed,
      gaps: architectureResult.gaps?.length || 0,
    });
    resultLines.push(
      '- Architecture: ' + architectureResult.refreshed + ' existing Block(s) refreshed, '
      + architectureResult.bound + ' curated Block(s) bound, '
      + architectureResult.composed + ' Chain(s) composed.'
    );
    if (architectureResult.error) {
      resultLines.push('- Architecture update needs attention: ' + clip(architectureResult.error, 240));
    }
    for (const gap of (architectureResult.gaps || []).slice(0, 6)) {
      resultLines.push(formatArchitectureGap(gap));
    }
    if ((architectureResult.gaps || []).length > 6) {
      resultLines.push('- (' + (architectureResult.gaps.length - 6) + ' more architecture gap(s))');
    }
  }

  if (shipRequest) {
    if (!verifyCommands.length) {
      resultLines.push('- Ship skipped: provide verify in the same change call.');
    } else if (!verifyPassed) {
      resultLines.push('- Ship skipped because verification failed.');
    } else {
      try {
        const shipped = await shipPipeline(ctx, { ...shipRequest });
        const closure = String(shipped)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(0, 4)
          .join(' | ');
        resultLines.push(`- Ship: ${clip(closure, 600)}`);
      } catch (error) {
        resultLines.push(`- Ship blocked: ${clip(error.message, 300)}`);
      }
    }
  }

  const nextLines = verifyCommands.length
    ? (verifyPassed
        ? ['done: verified and shipped; finalize now. Do not make speculative follow-up edits without a failing check or unmet requirement.']
        : [`👉 change(${JSON.stringify({ intent: input.intent || '<fix the failure>' })}) to repair and verify again`])
    : [`👉 ${computeNext({ session, changedCount: touched.length, profile, stage: 'change', intent: input.intent })}`];

  const touchedLines = touched.slice(-8).map((filePath) => `- \`${filePath}\` (edit)`);

  const sections = [
    { key: 'next', title: 'Next', priority: 0, lines: nextLines },
    { key: 'result', title: 'Result', priority: 1, lines: resultLines },
  ];
  if (verifyLines.length) {
    sections.push({
      key: 'verdict',
      title: verifyPassed ? 'Verify: PASS' : 'Verify: FAIL',
      priority: 2,
      lines: verifyLines,
    });
  }
  if (failureLines.length) {
    sections.push({ key: 'failures', title: 'Failures', priority: 3, lines: failureLines });
  }
  sections.push({ key: 'touched', title: 'Touched', priority: 4, lines: touchedLines });

  const { text } = fitSections(sections, { maxChars: resolveBudget(input.depth, ctx.profile?.budget) });
  return `# ContextOS change\n\n${text}`;
}

const INSPECT_SKIP_DIRS = new Set(['.git', '.contextos', 'node_modules', 'dist', 'build', 'coverage', 'tmp']);

function normalizeInspectTargetPath(projectRoot, target) {
  const raw = String(target || '').trim();
  if (!raw) return raw;
  const root = path.resolve(projectRoot);
  const normalizedRaw = raw.replace(/\\/g, '/');
  const candidate = path.isAbsolute(normalizedRaw)
    ? path.resolve(normalizedRaw)
    : path.resolve(root, normalizedRaw);
  const relative = path.relative(root, candidate).split(path.sep).join('/');
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return raw;
  return relative;
}

function expandInspectTargets(projectRoot, target) {
  const raw = String(target || '');
  const normalized = raw.replace(/\\/g, '/');
  const base = normalized.replace(/\/\*\*?$/, '');
  const fullPath = path.resolve(projectRoot, base || '.');
  const relative = path.relative(path.resolve(projectRoot), fullPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return [raw];
  let stat;
  try {
    stat = fs.statSync(fullPath);
  } catch (_) {
    return [raw];
  }
  if (!stat.isDirectory()) return [normalizeInspectTargetPath(projectRoot, raw)];

  const files = [];
  const walk = (directory, depth = 0) => {
    if (files.length >= 30 || depth > 4) return;
    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (files.length >= 30) break;
      if (entry.name.startsWith('.') || INSPECT_SKIP_DIRS.has(entry.name)) continue;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(child, depth + 1);
      else if (entry.isFile()) files.push(path.relative(projectRoot, child).split(path.sep).join('/'));
    }
  };
  walk(fullPath);
  return files.length ? files : [`${base}/`];
}

function expandInspectGlobs(projectRoot, globs = []) {
  const matches = [];
  for (const pattern of Array.isArray(globs) ? globs : []) {
    if (typeof pattern !== 'string' || !pattern.trim()) continue;
    let found = [];
    try {
      found = fs.globSync(pattern.trim(), { cwd: projectRoot });
    } catch (_) {
      continue;
    }
    for (const candidate of found) {
      const relative = String(candidate).split(path.sep).join('/');
      if (!relative || relative.startsWith('.contextos/') || relative.startsWith('node_modules/') || relative.startsWith('.git/')) continue;
      const absolute = path.resolve(projectRoot, relative);
      if (!absolute.startsWith(`${path.resolve(projectRoot)}${path.sep}`)) continue;
      try {
        if (fs.statSync(absolute).isFile()) matches.push(relative);
      } catch (_) {}
    }
  }
  return [...new Set(matches)].sort().slice(0, 30);
}

function readReceiptStillValid(projectRoot, relativePath, receipt) {
  if (!receipt || receipt.mtimeMs === undefined || receipt.size === undefined) return false;
  try {
    const stat = fs.statSync(path.join(projectRoot, relativePath));
    return stat.isFile()
      && Number(stat.mtimeMs) === Number(receipt.mtimeMs)
      && Number(stat.size) === Number(receipt.size);
  } catch (_) {
    return false;
  }
}

function numberCodeLines(text, fallbackStartLine = 1) {
  const lines = String(text ?? '').split('\n');
  const headerIndex = lines.findIndex((line) => /\[L(\d+)-L(\d+)\]/.test(line));
  const match = headerIndex >= 0 ? /\[L(\d+)-L(\d+)\]/.exec(lines[headerIndex]) : null;
  let lineNumber = match ? Number(match[1]) : fallbackStartLine;
  const bodyStart = headerIndex >= 0 ? headerIndex + 1 : 0;
  const closingFence = lines.lastIndexOf('```');
  const bodyEnd = closingFence > bodyStart ? closingFence : lines.length;
  const numbered = lines.slice(bodyStart, bodyEnd).map((line) => {
    const range = /^\/\/ \[L(\d+)-L(\d+)\]$/.exec(line.trim());
    if (range) {
      lineNumber = Number(range[1]);
      return line;
    }
    return `${String(lineNumber++).padStart(4, ' ')} | ${line}`;
  });
  return [...lines.slice(0, bodyStart), ...numbered, ...lines.slice(bodyEnd)]
    .filter((line, index, values) => line !== '' || index === values.length - 1).join('\n');
}

export async function inspectPipeline(ctx, input = {}) {
  if (input.inspect && typeof input.inspect === 'object' && !Array.isArray(input.inspect)) {
    input = { ...input.inspect, ...input };
  }
  if (Array.isArray(input.inspect)) {
    const specs = input.inspect
      .map((entry) => (typeof entry === 'string' ? { path: entry } : entry))
      .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
    const arrayPaths = uniquePaths(specs.map((entry) => entry.path));
    const arrayRanges = specs
      .filter((entry) => entry.path && Array.isArray(entry.ranges) && entry.ranges.length)
      .map((entry) => ({ path: entry.path, ranges: entry.ranges }));
    const singleSymbol = specs.length === 1 ? specs[0].symbol : undefined;
    input = {
      ...input,
      paths: input.paths?.length ? input.paths : arrayPaths,
      ranges: input.ranges?.length ? input.ranges : arrayRanges,
      symbol: input.symbol || singleSymbol,
      inspect: undefined,
    };
  }
  const { caps, store } = ctx;
  let targetPath = input.path;
  let symbol = input.symbol;

  if (input.slot) {
    const slotData = store.getSlot(input.slot);
    if (slotData) {
      targetPath = slotData.path || targetPath;
      symbol = slotData.symbol || symbol;
    }
  }
  if (targetPath) targetPath = normalizeInspectTargetPath(ctx.projectRoot, targetPath);

  const requestedBudget = input.budget || input.depth;
  const paths = (Array.isArray(input.paths) && input.paths.length
    ? input.paths
    : (targetPath ? [targetPath] : []))
    .map((target) => normalizeInspectTargetPath(ctx.projectRoot, target));
  const globPaths = expandInspectGlobs(ctx.projectRoot, input.globs);
  let requestedPaths = [...paths, ...globPaths];
  let symbolCandidates = [];
  if (!requestedPaths.length && symbol) {
    const search = await caps.code({
      action: 'search',
      query: symbol,
      format: 'json',
      limit: 6,
    });
    if (search.ok && search.data && typeof search.data === 'object') {
      symbolCandidates = uniquePaths([
        ...(Array.isArray(search.data.symbols) ? search.data.symbols.map((entry) => entry?.path) : []),
        ...(Array.isArray(search.data.text) ? search.data.text.map((entry) => entry?.path) : []),
      ]).slice(0, 3);
      requestedPaths = symbolCandidates.slice(0, 1);
    }
  }
  requestedPaths = uniquePaths(requestedPaths.map((target) => normalizeInspectTargetPath(ctx.projectRoot, target)));
  const queryRangeEntries = [];
  if (!symbol && typeof input.query === 'string' && input.query.trim() && requestedPaths.length) {
    for (const target of uniquePaths(requestedPaths).slice(0, 4)) {
      const search = await caps.codeJson({
        action: 'search',
        query: input.query,
        root: target,
        limit: 12,
      });
      if (!search.ok || !search.data || typeof search.data !== 'object') continue;
      const ranges = (Array.isArray(search.data.symbols) ? search.data.symbols : [])
        .filter((entry) => entry?.path === target)
        .map((entry) => ({
          startLine: Number(entry.startLine),
          endLine: Number(entry.endLine),
        }))
        .filter((range) => Number.isFinite(range.startLine) && Number.isFinite(range.endLine));
      if (ranges.length) queryRangeEntries.push({ path: target, ranges });
    }
  }
  const inspectPaths = requestedPaths
    .flatMap((target) => expandInspectTargets(ctx.projectRoot, target))
    .map((target) => normalizeInspectTargetPath(ctx.projectRoot, target));
  const inspectFileChars = inspectPaths.map((target) => {
    try {
      const stat = fs.statSync(path.join(ctx.projectRoot, target));
      return stat.isFile() ? stat.size : 0;
    } catch (_) {
      return 0;
    }
  });
  const normalizeRanges = (values) => (Array.isArray(values) ? values : []).flatMap((range) => {
    const start = Array.isArray(range)
      ? Number(range[0])
      : Number(range?.startLine ?? range?.start);
    const end = Array.isArray(range)
      ? Number(range[1])
      : Number(range?.endLine ?? range?.end);
    return Number.isFinite(start) && Number.isFinite(end) && end >= start
      ? [{ startLine: start, endLine: end }]
      : [];
  });
  const perPathRanges = new Map();
  for (const entry of (Array.isArray(input.ranges) ? input.ranges : [])) {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') continue;
    const normalized = normalizeRanges(entry.ranges);
    const rangePath = normalizeInspectTargetPath(ctx.projectRoot, entry.path);
    if (normalized.length && rangePath) perPathRanges.set(rangePath.replace(/^\.\//, ''), normalized);
  }
  for (const entry of queryRangeEntries) {
    const normalized = normalizeRanges(entry.ranges);
    if (!normalized.length) continue;
    const existing = perPathRanges.get(entry.path) || [];
    perPathRanges.set(entry.path, [...existing, ...normalized]);
  }
  const hasPerPathRanges = perPathRanges.size > 0;
  const directRanges = hasPerPathRanges ? [] : normalizeRanges(input.ranges);
  const allRanges = hasPerPathRanges
    ? [...perPathRanges.values()].flat()
    : directRanges;
  const totalInspectChars = inspectFileChars.reduce((sum, chars) => sum + chars, 0);
  // A batch request is a map request for large files. Small bounded batches
  // are safe to inline whole: refusing them costs more than the bytes saved
  // because the host falls back to one native read per file.
  const batchRead = inspectPaths.length > 1;
  const smallBatchRead = batchRead
    && inspectPaths.length <= INSPECT_BATCH_INLINE_MAX_FILES
    && inspectFileChars.every((chars) => chars > 0 && chars <= INSPECT_INLINE_MAX_CHARS)
    && totalInspectChars <= INSPECT_BATCH_INLINE_MAX_CHARS;
  const smallRangeFile = !batchRead
    && inspectFileChars.length === 1
    && inspectFileChars[0] > 0
    && inspectFileChars[0] <= INSPECT_INLINE_MAX_CHARS;
  const hasExplicitTarget = Boolean(symbol)
    || input.startLine !== undefined
    || input.endLine !== undefined
    || allRanges.length > 0;
  const requestedFull = (
    input.full === true
    || requestedBudget === 'full'
    || input.fullFile === true
  ) && (!batchRead || smallBatchRead);
  const readPolicy = typeof store?.readPolicy === 'function'
    ? store.readPolicy()
    : (store?.current?.readPolicy || null);
  const requestedRangeLines = (() => {
    let maxLines = 0;
    for (const range of allRanges) {
      const start = Number(range?.startLine);
      const end = Number(range?.endLine);
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        maxLines = Math.max(maxLines, end - start + 1);
      }
    }
    const start = Number(input.startLine);
    const end = Number(input.endLine);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      maxLines = Math.max(maxLines, end - start + 1);
    }
    return maxLines;
  })();
  const postDecision = ctx.internal !== true && readPolicy?.decisionPackageSeen === true;
  const boundedSmallRead = smallBatchRead || smallRangeFile;
  const oversizedRange = postDecision
    && !symbol
    && requestedRangeLines > MAX_INSPECT_RANGE_LINES
    && !(smallRangeFile || smallBatchRead);
  const directedExpansion = postDecision && hasExplicitTarget;
  const firstInspectPath = uniquePaths(inspectPaths)[0] || null;
  const fullExpansionPaths = Array.isArray(readPolicy?.fullExpansionPaths)
    ? readPolicy.fullExpansionPaths
    : [];
  const repeatedFullExpansion = requestedFull
    && postDecision
    && !hasExplicitTarget
    && firstInspectPath
    && fullExpansionPaths.includes(firstInspectPath);
  // A decision package is a cache, not a wall. New paths must remain readable:
  // if exploration missed the edit surface, one bounded full read is cheaper
  // than forcing the host through many 80-line slices. Repeated full reads of
  // the same path are still refused so the OS does not become a replay loop.
  const decisionGated = repeatedFullExpansion || oversizedRange;
  const isFull = requestedFull && !decisionGated;
  const explicitMaxChars = typeof input.maxChars === 'number' && input.maxChars > 0 ? input.maxChars : null;
  const explicitInspectMaxChars = explicitMaxChars
    ? Math.min(explicitMaxChars, INSPECT_RECOVERY_OUTPUT_MAX_CHARS)
    : null;
  const contentMaxChars = isFull
    ? (explicitInspectMaxChars ?? INSPECT_RECOVERY_OUTPUT_MAX_CHARS)
    : (explicitInspectMaxChars ?? RESPONSE_BUDGETS.inspect);

  if (!requestedPaths.length) {
    const globHint = Array.isArray(input.globs) && input.globs.length
      ? `No files matched globs: ${input.globs.join(', ')}.`
      : (symbol
          ? `No declaration or text match found for symbol \`${symbol}\`. Pass a path or a broader symbol query.`
          : 'No target path provided. Pass `path`, `paths`, `globs`, or `slot` (e.g. `slot: "S1"`).');
    return `# ContextOS inspect\n\n${globHint}`;
  }

  const isOutline = input.mode === 'outline' || Boolean(input.outline);
  const outLines = [];
  let fullExpansionPath = null;
  let directedExpansionPath = null;
  for (let p of inspectPaths) {
    const fullP = path.join(ctx.projectRoot, p);
    if (!fs.existsSync(fullP) && fs.existsSync(`${fullP}.log`)) {
      p = `${p}.log`;
    }
    // A path-only read of a large file would otherwise inline a truncated
    // head: expensive and useless for deciding what to change. Small files are
    // returned whole; large files default to an outline plus a locator, and
    // the caller asks for the exact symbol or range it needs.
    let fileChars = 0;
    try {
      const stat = fs.statSync(fullP);
      if (stat.isFile()) fileChars = stat.size;
    } catch (_) {}
    const effectiveRanges = hasPerPathRanges
      ? (perPathRanges.get(p) || perPathRanges.get(p.replace(/^\.\//, '')) || null)
      : (directRanges.length ? directRanges : null);
    const effectiveStartLine = hasPerPathRanges ? undefined : input.startLine;
    const effectiveEndLine = hasPerPathRanges ? undefined : input.endLine;
    const forceOutline = requestedBudget === 'shallow'
      || (batchRead && !smallBatchRead && !hasExplicitTarget)
      || decisionGated;
    const preferOutline = !isOutline
      && !isFull
      && (forceOutline || (!input.fullFile && !hasExplicitTarget && !explicitMaxChars && fileChars > INSPECT_INLINE_MAX_CHARS));
    let outlineHandled = false;
    if (isOutline || preferOutline) {
      const outlineKey = `outline:${p}`;
      let outlinePromise = ctx.turnMemo instanceof Map ? ctx.turnMemo.get(outlineKey) : null;
      if (!outlinePromise) {
        outlinePromise = caps.code({
          action: 'outline',
          path: p,
        });
        if (ctx.turnMemo instanceof Map) ctx.turnMemo.set(outlineKey, outlinePromise);
      }
      const outline = await outlinePromise;
      if (outline.ok) {
        // The implicit outline is a map, not a transcript: keep it near the
        // 300-token target. Explicit outline/full requests keep the larger cap.
        const outlineCap = preferOutline ? Math.min(contentMaxChars, OUTLINE_CLIP) : contentMaxChars;
        const locator = preferOutline
          ? `\n[body not inlined (${fileChars} chars); pass symbol, ranges, or full:true to read it]`
          : '';
        outLines.push(`### \`${p}\` (AST Outline)\n${clip(outline.data, outlineCap, { withHint: true })}${locator}`);
        outlineHandled = true;
      } else if (isOutline) {
        outLines.push(`### \`${p}\`: ✗ ${outline.error}`);
        outlineHandled = true;
      }
    }
    if (!outlineHandled) {
      const explicitReadBudget = Boolean(
        input.budget
        || input.maxChars
        || input.fullFile
        || (input.depth && input.depth !== 'normal')
      );
      const allowReadReuse = input.dedupeReads !== false
        && input.refresh !== true
        && !requestsFullOutput(input)
        && !explicitReadBudget;
      const range = effectiveRanges
        ? JSON.stringify(effectiveRanges)
        : { startLine: effectiveStartLine, endLine: effectiveEndLine };
      const priorByStat = allowReadReuse && typeof store?.findLatestReadReceipt === 'function'
        ? store.findLatestReadReceipt({ path: p, range, symbol })
        : null;
      if (priorByStat && readReceiptStillValid(ctx.projectRoot, p, priorByStat)) {
        const hash = String(priorByStat.hash || '').slice(0, 12);
        outLines.push(`### \`${p}\` unchanged (hash: ${hash || 'known'}; reuse prior result${priorByStat.receiptId ? ` from ${priorByStat.receiptId}` : ''})`);
        continue;
      }
      const readKey = allowReadReuse
        ? JSON.stringify({
            path: p,
            symbol: symbol || null,
            startLine: effectiveStartLine ?? null,
            endLine: effectiveEndLine ?? null,
            ranges: effectiveRanges || null,
            budget: input.budget || null,
            maxChars: input.maxChars ?? null,
            fullFile: isFull || input.fullFile || false,
          })
        : null;
      let readPromise = readKey && ctx.turnMemo instanceof Map ? ctx.turnMemo.get(readKey) : null;
      if (!readPromise) {
        readPromise = caps.code({
          action: 'read',
          path: p,
          symbol: symbol || undefined,
          startLine: effectiveStartLine,
          endLine: effectiveEndLine,
          ranges: effectiveRanges || undefined,
          budget: isFull ? 'full' : input.budget,
          maxChars: input.maxChars,
          fullFile: isFull || input.fullFile || false,
        });
        if (readKey && ctx.turnMemo instanceof Map) ctx.turnMemo.set(readKey, readPromise);
      }
      const read = await readPromise;
      if (read.ok) {
        if (isFull) fullExpansionPath = p;
        if (directedExpansion && !decisionGated) directedExpansionPath = p;
        const hash = crypto.createHash('sha256').update(String(read.data ?? '')).digest('hex');
        const prior = allowReadReuse && typeof store?.findReadReceipt === 'function'
          ? store.findReadReceipt({ path: p, hash, range, symbol })
          : null;
        if (prior) {
          outLines.push(`### \`${p}\` unchanged (hash: ${hash.slice(0, 12)}; reuse prior result${prior.receiptId ? ` from ${prior.receiptId}` : ''})`);
          } else {
            outLines.push(`### \`${p}\`${symbol ? ` (${symbol})` : ''}\n${clip(numberCodeLines(read.data, effectiveRanges?.[0]?.startLine || effectiveStartLine || 1), contentMaxChars, { withHint: true })}`);
            if (typeof store?.recordReadReceipt === 'function') {
              let fileStat = null;
              try {
                const stat = fs.statSync(path.join(ctx.projectRoot, p));
                if (stat.isFile()) fileStat = stat;
              } catch (_) {}
              store.recordReadReceipt({
                path: p,
                hash,
                range,
                symbol,
                receiptId: read.receiptId || null,
                mtimeMs: fileStat?.mtimeMs,
                size: fileStat?.size,
              });
            }
          }
      } else {
        outLines.push(`### \`${p}\`: ✗ ${read.error}`);
      }
    }
  }

  if (decisionGated && typeof store?.recordPathOnlyFullDenied === 'function') {
    try {
      const reason = oversizedRange
        ? 'oversized-range'
        : (repeatedFullExpansion ? 'repeated-full-expansion' : 'path-only-full');
      store.recordPathOnlyFullDenied({ path: inspectPaths[0] || null, reason });
    } catch (_) {}
  }
  if (fullExpansionPath && typeof store?.recordFullExpansion === 'function') {
    try {
      store.recordFullExpansion({ path: fullExpansionPath });
    } catch (_) {}
  }
  if (directedExpansionPath && typeof store?.recordDirectedExpansion === 'function') {
    try {
      store.recordDirectedExpansion({ path: directedExpansionPath });
    } catch (_) {}
  }

  const budget = isFull
    ? Infinity
    : (explicitInspectMaxChars ?? resolveBudget(requestedBudget, ctx.profile?.budget));
  const { text } = fitSections(
    [{ key: 'inspect', title: 'Inspection Result', priority: 0, lines: outLines }],
    { maxChars: budget }
  );
  const gateReason = oversizedRange
    ? `the requested range spans ${requestedRangeLines} lines (limit ${MAX_INSPECT_RANGE_LINES})`
    : 'this file was already expanded in full after the decision package; reuse the prior result or inspect a narrower symbol/range';
  const gateNotice = decisionGated
    ? [
        `> Read policy: ${gateReason}; the request was downgraded to an outline.`,
        '> Use `symbol` or a bounded `ranges` slice for inspection. Whole-file replacement belongs in `change`/`work` edit payloads, not in an inspect read; then continue with `change`/`work`.',
      ].join('\n')
    : '';
  return `# ContextOS inspect\n\n${gateNotice ? `${gateNotice}\n\n` : ''}${text}`;
}

export async function verifyPipeline(ctx, input = {}) {
  const { caps, store, tracer, profile } = ctx;
  const mode = input.mode === 'summary' ? 'once' : (input.mode || 'once');
  const isFull = input.full === true || mode === 'full' || input.budget === 'full';

  if (mode === 'logs' && input.id && /^[A-Za-z0-9._-]+$/.test(input.id)) {
    const logPath = path.join(ctx.projectRoot, '.contextos', 'logs', `${input.id}.log`);
    if (fs.existsSync(logPath)) {
      const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);
      const filtered = input.grep
        ? lines.filter((line) => line.toLowerCase().includes(String(input.grep).toLowerCase()))
        : lines;
      const limit = Math.max(1, Number(input.lines) || 50);
      const selected = filtered.slice(-limit);
      tracer.step('receipt_logs', { id: input.id, lines: selected.length });
      return `# ContextOS verify (logs)\n\n- Receipt: \`${input.id}\`\n- Log: \`.contextos/logs/${input.id}.log\`\n- Lines: ${selected.length}/${filtered.length}\n\n\`\`\`text\n${selected.join('\n')}\n\`\`\``;
    }
  }

  if (PROCESS_VERIFY_MODES.has(mode)) {
    const res = await caps.process({
      action: mode === 'serve' ? 'start' : mode,
      command: input.command || (input.commands || [])[0],
      id: input.id,
      lines: input.lines ?? 50,
      grep: input.grep,
      maxLogBytes: input.maxLogBytes,
    });
    const body = res.ok ? stringify(res.data) : `✗ ${res.error}`;
    tracer.step('process', { mode, ok: res.ok });
    return `# ContextOS verify (${mode})\n\n${clip(body, resolveBudget(input.depth, ctx.profile?.budget))}`;
  }

  // A single `command` is accepted as a one-element list: agents type it far more often than `commands`.
  const explicit = Array.isArray(input.commands) && input.commands.length
    ? input.commands
    : (input.command ? [input.command] : null);
  const rawCommands = explicit || profile.verify || [];
  const commands = Array.isArray(rawCommands) ? rawCommands : (typeof rawCommands === 'string' ? [rawCommands] : []);
  if ((!Array.isArray(rawCommands) && typeof rawCommands !== 'string')
    || commands.some((command) => typeof command !== 'string' || !command.trim())) {
    return '# ContextOS verify\n\n## Verdict: FAIL\n- Invalid verification command: `commands` must be an array of non-empty strings and `command` must be a non-empty string.';
  }
  if (!commands.length) {
    return '# ContextOS verify\n\nNo verification command available. Pass `command: "npm test"` (or `commands: [...]`) or set `verify` in `.contextos/profile.json`.';
  }

  const commandLines = [];
  const failureLines = [];
  const fingerprint = workspaceFingerprint(ctx.projectRoot);
  let passed = true;

  for (const command of commands) {
    const cached = store.currentPassingReceipt(command, input.cwd || null, fingerprint);
    if (cached) {
      const label = redactSecrets(command);
      commandLines.push(`- \`${label}\` -> cached PASS (${cached.id || 'receipt'})`);
      tracer.step('run.cached', { command, receiptId: cached.id || null });
      continue;
    }
    const res = await caps.run({
      command,
      cwd: input.cwd,
      maxChars: input.maxChars ?? profile.maxChars,
      maxLogBytes: input.maxLogBytes,
      timeoutMs: input.timeoutMs ?? profile.timeoutMs,
    });
    if (!res.ok) {
      passed = false;
      commandLines.push(`- \`${command}\` → ✗ ${res.error}`);
      continue;
    }
    const receipt = res.data;
    receipt.stateHash = fingerprint;
    store.attachReceipt(receipt);
    const label = redactSecrets(command);
    commandLines.push(`- \`${label}\` → exit ${receipt.exitCode} (${receipt.durationMs}ms, receipt ${receipt.id})`);
    if (receipt.exitCode !== 0) {
      passed = false;
      const diag = receipt.diagnostics && receipt.diagnostics.length
        ? receipt.diagnostics.join('\n\n---\n\n')
        : (receipt.errors && receipt.errors.length ? receipt.errors.slice(0, 5).join('\n') : clip(receipt.summary || 'no stderr captured', 600));
      failureLines.push(`### \`${label}\`\n${diag}`);
    }
    tracer.step('run', { command, exitCode: receipt.exitCode });
  }

  const triageLines = [];
  const failureEvidence = failureLines.join('\n\n');
  const obviousRootCause = /(?:not implemented|unimplemented|syntaxerror|cannot find module|module_not_found)/i.test(failureEvidence);
  const explicitTriage = input.autoTriage === true;
  const profileTriage = profile?.autoTriage === true;
  const evidenceWorthTriage = !obviousRootCause
    && !isFull
    && failureEvidence.length > MICRO_TRIAGE_MIN_CHARS;
  const autoTriage = input.autoTriage === false
    ? false
    : (explicitTriage
        || evidenceWorthTriage
        || (profileTriage && !obviousRootCause && !isFull));
  const triageEvidence = failureEvidence.length > 6000
    ? `${failureEvidence.slice(0, 4800)}\n\n...[middle omitted]...\n\n${failureEvidence.slice(-1000)}`
    : failureEvidence;
  if (autoTriage && !passed && failureLines.length && profile?.micro?.url && profile?.micro?.model && typeof caps?.micro === 'function') {
    try {
      const triageRes = await caps.micro(
        {
          preset: 'triage',
          prompt: '分析以下测试/构建失败日志，给出最简诊断与修复建议：',
          input: triageEvidence,
          invocation: {
            tools: { enabled: false },
            provider: { maxRequests: 1 },
          },
        },
        profile.micro
      );
      if (triageRes.ok && triageRes.data) {
        recordMicroUsage(ctx.projectRoot, triageRes.data, triageRes.data.receiptId, {
          hostSessionId: tracer?.sessionId || null,
          requestedDelivery: 'immediate',
          deliveryOutcome: 'immediate',
        });
      }
      if (triageRes.ok && triageRes.data?.ok && triageRes.data?.content) {
        triageLines.push(triageRes.data.content.trim());
        tracer.step('micro.triage', {
          durationMs: triageRes.data.durationMs,
          evidenceChars: triageEvidence.length,
        });
      }
    } catch (error) {
      triageLines.push(`Micro triage unavailable: ${error.message}`);
      tracer.step('micro.triage.error', { error: error.message });
    }
  }

  const session = store.current;
  const nextLines = [
    passed
      ? 'done: verified; finalize now unless a concrete requirement or failing check still needs work. Do not rerun this command.'
      : `👉 change(${JSON.stringify({ intent: input.intent || '<fix the failure>' })}) to fix, then verify again`,
  ];

  const verifySections = [
    { key: 'next', title: 'Next', priority: 0, lines: nextLines },
    { key: 'verdict', title: passed ? 'Verdict: PASS' : 'Verdict: FAIL', priority: 1, lines: commandLines },
  ];
  if (triageLines.length) {
    verifySections.push({ key: 'triage', title: '👉 Micro-Triage (工程诊断小脑)', priority: 1.5, lines: triageLines });
  }
  // Triage already carries the diagnosis; do not also spend host context on
  // the raw TAP body it was derived from.
  const projectedFailureLines = triageLines.length && !isFull
    ? failureLines.map((block) => compactFailureEvidence(block))
    : failureLines;
  verifySections.push({ key: 'failures', title: 'Failures', priority: 2, lines: projectedFailureLines });

  const { text } = fitSections(
    verifySections,
    { maxChars: isFull ? Infinity : resolveBudget(input.depth, ctx.profile?.budget) }
  );
  return `# ContextOS verify\n\n${text}${session ? `\n\n<!-- session ${session.id}, ${session.receipts.length} receipts -->` : ''}`;
}

function normalizeReceiptIds(input = {}) {
  const raw = input.receiptIds ?? input.receiptId;
  const values = raw === undefined || raw === null
    ? []
    : (Array.isArray(raw) ? raw : [raw]);
  return [...new Set(values
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim()))];
}

function importPassingReceipts(store, input, projectRoot) {
  const requested = normalizeReceiptIds(input);
  if (!requested.length) return { requested, imported: [], invalid: [] };

  const current = store.current;
  const currentReceipts = current?.receipts || [];
  const currentById = new Map(currentReceipts
    .filter((receipt) => receipt?.id)
    .map((receipt) => [receipt.id, receipt]));
  const fingerprint = workspaceFingerprint(projectRoot);
  const imported = [];
  const invalid = [];

  for (const id of requested) {
    const historical = !currentById.has(id)
      && typeof store.findHistoricalReceipt === 'function'
      ? store.findHistoricalReceipt(id)
      : null;
    const receipt = currentById.get(id) || historical;
    const valid = receipt
      && receipt.exitCode === 0
      && receipt.status === 'passed'
      && receipt.stateHash === fingerprint
      && (!receipt.cwd || path.resolve(receipt.cwd) === path.resolve(projectRoot));
    if (!valid) {
      invalid.push({
        id,
        reason: !receipt ? 'not-found' : 'state-changed-or-not-passing',
      });
      continue;
    }
    if (!currentById.has(id)) store.attachReceipt(receipt);
    imported.push(id);
  }

  return { requested, imported, invalid };
}

export async function shipPipeline(ctx, input = {}) {
  const { caps, store, tracer, projectRoot, profile } = ctx;
  if (!store.current && input.dryRun !== true) {
    return '# ContextOS ship\n\n- No open session. Nothing to close.';
  }
  const obs = await observe({ projectRoot, store });
  let session = store.current || store.ensureSession(input.summary || 'session');
  tracer.step('observe', { gitAvailable: obs.gitAvailable, reconciled: obs.reconciled });

  if (input.dryRun === true) {
    const touched = session.touchedFiles || [];
    const receipts = session.receipts || [];
    const summaryLines = [
      `- Session \`${session.id}\` will remain open`,
      `- Planned summary: ${input.summary || session.intent || 'session closed'}`,
      `- Touched files: ${touched.length}`,
      `- Receipts: ${receipts.length}`,
    ];
    const touchedLines = touched.slice(-10).map((entry) => `- \`${entry.path}\` (${entry.source})`);
    const receiptLines = receipts
      .slice(-5)
      .map((receipt) => `- [${receiptStatus(receipt).toUpperCase()}] \`${redactSecrets(receipt.command || '')}\` exit ${receipt.exitCode} (${receipt.id})`);
    tracer.step('dry_run', { touched: touched.length, receipts: receipts.length });

    const { text } = fitSections(
      [
        { key: 'summary', title: 'Planned closure', priority: 0, lines: summaryLines },
        { key: 'touched', title: 'Touched', priority: 1, lines: touchedLines },
        { key: 'receipts', title: 'Receipts', priority: 2, lines: receiptLines },
      ],
      { maxChars: resolveBudget(input.depth, ctx.profile?.budget) }
    );
    return `# ContextOS ship (dry run)\n\n${text}`;
  }

  const receiptReuse = importPassingReceipts(store, input, projectRoot);
  session = store.current || session;
  const shipVerifyCommands = verifyCommandsFromInput(input.verify, profile);
  const wantsVerify = shipVerifyCommands.length > 0;
  const extraLines = [];

  if (receiptReuse.invalid.length) {
    const details = receiptReuse.invalid.map(({ id, reason }) => '- ' + id + ': ' + reason);
    return [
      '# ContextOS ship — BLOCKED (receipt contract)',
      '',
      '- Requested receipt reuse was rejected; stale or unknown evidence was not imported.',
      ...details,
      '- Re-run verify for the current workspace state, then ship with the new passing receipt.',
    ].join('\n');
  }
  if (receiptReuse.imported.length) {
    extraLines.push(
      '- Reused passing receipt(s): ' + receiptReuse.imported.join(', ')
        + ' (state hash matches current workspace).'
    );
  }

  const currentFingerprint = workspaceFingerprint(ctx.projectRoot);
  const hasCurrentPass = (command) => (session.receipts || []).some((receipt) =>
    receipt.exitCode === 0
    && sameReceiptCommand(receipt, { command, cwd: null })
    && receipt.stateHash === currentFingerprint
  );
  const commandsToRun = shipVerifyCommands.filter((command) => !hasCurrentPass(command));
  if (wantsVerify && commandsToRun.length) {
    const commands = commandsToRun;
    for (const command of commands) {
      const res = await caps.run({ command, maxChars: profile.maxChars, timeoutMs: profile.timeoutMs });
      if (res.ok) {
        res.data.stateHash = workspaceFingerprint(ctx.projectRoot);
        store.attachReceipt(res.data);
        extraLines.push(`- \`${redactSecrets(command)}\` → exit ${res.data.exitCode} (receipt ${res.data.id})`);
      } else {
        extraLines.push(`- \`${redactSecrets(command)}\` → ✗ ${res.error}`);
      }
    }
    session = store.current;
  }

  const sessionReceipts = session.receipts || [];
  const green = sessionReceipts.filter((receipt) => receipt.exitCode === 0);
  const superseded = sessionReceipts.filter((receipt) => effectiveReceiptStatus(receipt, sessionReceipts) === 'superseded');
  const unresolved = sessionReceipts.filter((receipt) => effectiveReceiptStatus(receipt, sessionReceipts) === 'unresolved');
  const lastPassIndex = sessionReceipts.reduce((last, receipt, index) => receipt.exitCode === 0 ? index : last, -1);
  const blockingUnresolved = sessionReceipts.filter((receipt, index) =>
    index > lastPassIndex && effectiveReceiptStatus(receipt, sessionReceipts) === 'unresolved'
  );
  const unverified = green.length === 0 && unresolved.length === 0;
  const allowUnverified = input.allowUnverified === true || input.force === true;
  const hasWork = (session.touchedFiles || []).length > 0 || (session.receipts || []).length > 0;

  if (profile.strict && !allowUnverified && (unverified || blockingUnresolved.length > 0)) {
    return [
      '# ContextOS ship — BLOCKED (strict profile)',
      '',
      unverified
        ? '- No passing receipt in this session.'
        : `- ${blockingUnresolved.length} unresolved failing receipt(s) remain in this session.`,
      '- Run `verify({ commands: [...] })` until the relevant command passes, or relax `strict` in `.contextos/profile.json`.',
      '- The session remains open for repair.',
      ...(extraLines.length ? ['', '## Attempted', ...extraLines] : []),
    ].join('\n');
  }

  if (!allowUnverified && hasWork && (unverified || blockingUnresolved.length > 0)) {
    return [
      '# ContextOS ship — BLOCKED (verification evidence)',
      '',
      unverified
        ? '- No passing receipt in this session; the session remains open.'
        : `- ${blockingUnresolved.length} unresolved failing receipt(s) remain in this session; the session remains open.`,
      '- Next: run `verify({ commands: ["<test command>"] })` before closure.',
      '- If closure is intentionally unverified, pass `allowUnverified: true` explicitly.',
      ...(extraLines.length ? ['', '## Attempted', ...extraLines] : []),
    ].join('\n');
  }

  const attributablePaths = (session.touchedFiles || [])
    .filter((entry) => entry.deleted !== true)
    .map((entry) => entry.path);
  const architecturePaths = attributablePaths.filter(isCuratedArchitecturePath);

  // A final explicit architecture payload is a compact closure escape hatch:
  // callers can bind the curated Block and compose its Chain in the same host
  // round as ship instead of issuing several low-level ops calls after code is
  // already verified. The mutation path still supports the preferred
  // change/work architecture payload; this only closes the remaining gap.
  let architectureUpdate = null;
  if (input.architecture !== undefined) {
    architectureUpdate = await bindChangedArchitecture(caps, architecturePaths, input.architecture);
    tracer.step('architecture_update', {
      ok: architectureUpdate.ok,
      bound: architectureUpdate.bound,
      composed: architectureUpdate.composed,
      refreshed: architectureUpdate.refreshed,
      gaps: architectureUpdate.gaps?.length || 0,
    });
  }

  const known = await caps.blocks();
  const chainResult = await caps.chains();
  const curatedBlocks = known.ok && Array.isArray(known.data)
    ? known.data.filter((block) => !String(block.id || '').startsWith('mod-'))
    : [];
  const chains = chainResult.ok && Array.isArray(chainResult.data) ? chainResult.data : [];
  const coverage = analyzeArchitectureCoverage(architecturePaths, curatedBlocks, chains);
  const architectureGaps = coverage.filter((entry) => entry.issue);
  const architectureUnavailable = !known.ok || !chainResult.ok
    || !Array.isArray(known.data) || !Array.isArray(chainResult.data);
  const isStrictArchitecture = Boolean(profile.strict || profile.strictArchitecture);
  // An explicit architecture payload is a contract, not an advisory hint.
  // Keep ordinary ship advisory, but never close a session after silently
  // dropping or incompletely applying the ownership supplied by the caller.
  const hasArchitectureContract = input.architecture !== undefined;
  if ((isStrictArchitecture || hasArchitectureContract)
    && (architectureUnavailable || architectureGaps.length > 0 || architectureUpdate?.ok === false)) {
    const details = architectureUnavailable
      ? ['- Could not read the Block/Chain graph: ' + (known.error || chainResult.error || 'invalid response')]
      : architectureGaps.map(formatArchitectureGap);
    if (architectureUpdate?.ok === false && architectureUpdate.error) {
      details.push('- Explicit architecture update failed: ' + architectureUpdate.error);
    }
    return [
      `# ContextOS ship — BLOCKED (${hasArchitectureContract ? 'explicit architecture contract' : 'architecture governance gate'})`,
      '',
      '- Every architecture-tracked source path needs exactly one curated Block owner and membership in at least one Chain.',
      ...details,
      '',
      '- Bind a semantic Block with block.bind_auto and add membership with chain.compose. chain.link records a directed relationship, not membership.',
      ...(extraLines.length ? ['', '## Attempted', ...extraLines] : []),
    ].join('\n');
  }

  const index = new ModuleIndex({ projectRoot });
  index.ensure(architecturePaths);
  const attribution = index.attribute(architecturePaths);
  const architectureGapCounts = {
    missingBlock: architectureGaps.filter((gap) => gap.issue === 'missing-block').length,
    multipleBlocks: architectureGaps.filter((gap) => gap.issue === 'multiple-blocks').length,
    missingChain: architectureGaps.filter((gap) => gap.issue === 'missing-chain').length,
  };
  const isFullDiagnostics = input.full === true || input.diagnostics === true;
  const renderedGaps = architectureGaps.length
    ? (isFullDiagnostics || architectureGaps.length <= 5
        ? architectureGaps.map(formatArchitectureGap)
        : [
            ...architectureGaps.slice(0, 5).map(formatArchitectureGap),
            `- (${architectureGaps.length - 5} additional architecture gap(s) omitted; pass diagnostics:true or full:true)`,
          ])
    : ['- Every architecture-tracked source path has exactly one curated Block owner and Chain membership.'];

  const architectureLines = architectureUnavailable
    ? ['- Gap counts unavailable: Block/Chain graph could not be read (' + (known.error || chainResult.error || 'invalid response') + ').']
    : [
        ...(architectureUpdate?.error ? ['- Explicit architecture update: ' + clip(architectureUpdate.error, 240)] : []),
        '- Gap counts: missing curated Block ' + architectureGapCounts.missingBlock
          + '; multiple curated Block owners ' + architectureGapCounts.multipleBlocks
          + '; owner without Chain membership ' + architectureGapCounts.missingChain + '.',
        ...renderedGaps,
      ];
  const missingBlockGaps = architectureGaps.filter((entry) => entry.issue === 'missing-block');
  const moduleIndexHintLines = architectureUnavailable
    ? []
    : (isFullDiagnostics
        ? missingBlockGaps.map((gap) => {
            const moduleId = attribution.get(gap.path) || 'unclassified';
            return '- ' + gap.path + ' → module hint ' + moduleId + ' (navigation only; not ownership; no Block was created)';
          })
        : (missingBlockGaps.length <= 3
            ? missingBlockGaps.map((gap) => {
                const moduleId = attribution.get(gap.path) || 'unclassified';
                return '- ' + gap.path + ' → module hint ' + moduleId + ' (navigation only; not ownership; no Block was created)';
              })
            : [
                ...missingBlockGaps.slice(0, 3).map((gap) => {
                  const moduleId = attribution.get(gap.path) || 'unclassified';
                  return '- ' + gap.path + ' → module hint ' + moduleId + ' (navigation only; not ownership; no Block was created)';
                }),
                '- (' + (missingBlockGaps.length - 3) + ' additional ModuleIndex navigation hint(s) omitted; pass diagnostics:true or full:true)',
              ]));
  tracer.step('architecture', {
    touched: architecturePaths.length,
    complete: architectureGaps.length === 0 && !architectureUnavailable,
    gaps: architectureGaps.length,
    ...architectureGapCounts,
  });

  const graph = input.exportGraph === true || profile.shipExportsGraph === true
    ? await caps.exportGraph()
    : { ok: true, data: { skipped: true } };
  tracer.step('graph', { ok: graph.ok });

  if (input.decision?.id) {
    const written = await caps.knowledge({
      action: 'decision_write',
      sectionId: input.decision.id,
      sectionTitle: input.decision.title || input.decision.id,
      content: input.decision.content || '',
    });
    tracer.step('decision', { id: input.decision.id, ok: written.ok });
  }

  const closed = store.close(input.summary || session.intent || 'session closed');

  const summaryLines = [
    `- Session: \`${closed.id}\` closed`,
    `- Touched: ${closed.touchedFiles.length} | Passing receipts: ${green.length}${unverified ? ' (unverified, advisory mode)' : ''}`,
    `- Superseded failures: ${superseded.length} | Unresolved failures: ${blockingUnresolved.length}`,
    '- Curated architecture: ' + (architectureUnavailable ? 'Block/Chain graph unavailable' : architectureGaps.length + ' gap(s) across ' + architecturePaths.length + ' changed file(s)'),
  ];
  // A reopened session starts with no receipts even when the same workspace was
  // already verified. Point at the existing re-attach path instead of leaving
  // the caller to close as "unverified".
  if (green.length === 0 && !input.receiptIds && !input.receiptId) {
    summaryLines.push('- No passing receipt in this session. If the same workspace passed in a prior session, re-attach it with `ship({ receiptIds: ["<receiptId>"] })`; stale receipts are rejected by state hash.');
  }
  const touchedLines = closed.touchedFiles.slice(-5).map((entry) => `- \`${entry.path}\` (${entry.source})`);
  const evidenceLines = [
    ...extraLines,
    ...(closed.receipts || [])
      .slice(-3)
      .map((receipt) => `- [${receiptStatus(receipt).toUpperCase()}] \`${redactSecrets(receipt.command || '')}\` exit ${receipt.exitCode} (${receipt.id})`),
  ];
  const graphLines = [];
  if (!graph.data?.skipped) {
    graphLines.push(graph.ok
      ? `- graph.json exported${graph.data?.graphRevision ? ` (rev ${graph.data.graphRevision})` : ''}`
      : `- graph export pending: ${graph.error}`);
  }

  const { text } = fitSections(
    [
      { key: 'summary', title: 'Closure', priority: 0, lines: summaryLines },
      { key: 'architecture', title: 'Curated architecture diagnostics', priority: 1, lines: architectureLines },
      { key: 'evidence', title: 'Evidence', priority: 2, lines: evidenceLines },
      { key: 'touched', title: 'Touched', priority: 3, lines: touchedLines },
      { key: 'module-index', title: 'Module index hints (navigation only)', priority: 4, lines: moduleIndexHintLines },
      { key: 'graph', title: 'Graph', priority: 5, lines: graphLines },
    ],
    { maxChars: resolveBudget(input.depth, ctx.profile?.budget) }
  );
  return `# ContextOS ship\n\n${text}`;
}

function normalizeAction(action, projectRoot) {
  if (!action || typeof action !== 'object') {
    throw new Error(`Invalid action in pipeline: expected object, got ${typeof action}`);
  }
  let tool = typeof action.tool === 'string' ? action.tool : (typeof action.action === 'string' ? action.action : null);
  let args;

  if (tool) {
    const suppliedArgs = action.args;
    if (suppliedArgs === undefined) {
      args = { ...action };
      delete args.tool;
      delete args.action;
      delete args.args;
    } else if (suppliedArgs && typeof suppliedArgs === 'object') {
      args = { ...suppliedArgs };
    } else if (typeof suppliedArgs === 'string') {
      args = tool === 'verify'
        ? { command: suppliedArgs }
        : (tool === 'search' ? { query: suppliedArgs } : { path: suppliedArgs, intent: suppliedArgs });
    } else {
      args = {};
    }
    if (action.maxChars !== undefined && args.maxChars === undefined) args.maxChars = action.maxChars;
    if (action.raw !== undefined && args.raw === undefined) args.raw = action.raw;
    if (action.mode !== undefined && args.mode === undefined) args.mode = action.mode;
  } else {
    args = { ...action };
  }

  // Shorthand keys:
  if (!tool) {
    if ('inspect' in action) {
      tool = 'inspect';
      args = typeof action.inspect === 'string'
        ? { path: action.inspect }
        : (Array.isArray(action.inspect) ? { paths: action.inspect } : { ...action.inspect });
      if (action.maxChars !== undefined && args.maxChars === undefined) args.maxChars = action.maxChars;
      if (action.raw !== undefined && args.raw === undefined) args.raw = action.raw;
    } else if ('change' in action) {
      tool = 'change';
      args = typeof action.change === 'string' ? { path: action.change } : { ...action.change };
      if (action.maxChars !== undefined && args.maxChars === undefined) args.maxChars = action.maxChars;
      if (action.raw !== undefined && args.raw === undefined) args.raw = action.raw;
    } else if ('verify' in action) {
      tool = 'verify';
      args = typeof action.verify === 'string'
        ? { command: action.verify }
        : (action.verify === true ? {} : (Array.isArray(action.verify) ? { commands: action.verify } : { ...action.verify }));
      if (action.maxChars !== undefined && args.maxChars === undefined) args.maxChars = action.maxChars;
      if (action.raw !== undefined && args.raw === undefined) args.raw = action.raw;
    } else if ('ship' in action) {
      tool = 'ship';
      args = typeof action.ship === 'string' ? { summary: action.ship } : { ...action.ship };
      if (action.maxChars !== undefined && args.maxChars === undefined) args.maxChars = action.maxChars;
      if (action.raw !== undefined && args.raw === undefined) args.raw = action.raw;
    } else if ('run' in action || 'run_command' in action) {
      tool = 'ops';
      const cmd = action.run || action.run_command;
      const cmdArgs = typeof cmd === 'string' ? { command: cmd } : { ...cmd };
      if (action.raw !== undefined) cmdArgs.raw = action.raw;
      if (action.maxChars !== undefined) cmdArgs.maxChars = action.maxChars;
      if (action.mode !== undefined) cmdArgs.mode = action.mode;
      args = {
        capability: 'run_command',
        args: cmdArgs,
      };
    } else if ('search' in action) {
      tool = 'ops';
      const searchSpec = action.search && typeof action.search === 'object' && !Array.isArray(action.search)
        ? action.search
        : { query: action.search };
      args = {
        capability: 'code',
        action: 'search',
        args: { ...searchSpec },
      };
      if (action.maxChars !== undefined && args.args.maxChars === undefined) args.args.maxChars = action.maxChars;
      if (action.raw !== undefined && args.args.raw === undefined) args.args.raw = action.raw;
    } else if ('block' in action) {
      tool = 'ops';
      args = {
        capability: 'block',
        ...(typeof action.block === 'object' ? action.block : { action: 'open', id: action.block }),
      };
    } else if ('chain' in action && !Array.isArray(action.chain)) {
      tool = 'ops';
      args = {
        capability: 'chain',
        ...(typeof action.chain === 'object' ? action.chain : { action: 'open', id: action.chain }),
      };
    } else if ('plan' in action) {
      tool = 'ops';
      args = {
        capability: 'plan',
        ...(typeof action.plan === 'object' ? action.plan : { action: 'open', id: action.plan }),
      };
    } else if ('task' in action) {
      tool = 'ops';
      args = {
        capability: 'task',
        ...(typeof action.task === 'object' ? action.task : { action: 'open', id: action.task }),
      };
    } else if ('ops' in action) {
      tool = 'ops';
      args = { ...action.ops };
    } else if ('explore' in action) {
      tool = 'explore';
      args = typeof action.explore === 'string' ? { intent: action.explore } : { ...action.explore };
    }
  }

  if (tool === 'run' || tool === 'run_command') {
    const commandArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    tool = 'ops';
    args = { capability: 'run_command', ...commandArgs };
  }

  if (tool === 'search') {
    const searchArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    tool = 'ops';
    args = {
      capability: 'code',
      action: 'search',
      args: searchArgs,
    };
  }

  if (!tool) {
    const keys = Object.keys(action).slice(0, 8).join(',') || 'none';
    throw new Error(`Could not determine tool. Use {action:"inspect",args:{...}} or {tool:"ops",args:{capability,...}}. Supported shorthand keys: inspect, change, verify, ship, run, search, block, chain, plan, task, ops, explore. Got keys: ${keys}`);
  }

  return {
    tool,
    input: {
      ...args,
      projectRoot: args.projectRoot || projectRoot,
    },
  };
}

function applyPipelineControls(normalized, input = {}) {
  if (!normalized?.input || typeof normalized.input !== 'object') return normalized;
  for (const key of ['refresh', 'dedupeReads']) {
    if (input[key] !== undefined && normalized.input[key] === undefined) {
      normalized.input[key] = input[key];
    }
  }
  return normalized;
}

function collectPipelineActionSpecs(steps, output = []) {
  const visit = (step) => {
    if (!step) return;
    if (Array.isArray(step)) {
      for (const item of step) visit(item);
      return;
    }
    if (Array.isArray(step.parallel)) {
      for (const item of step.parallel) visit(item);
      return;
    }
    if (Array.isArray(step.chain)) {
      for (const item of step.chain) visit(item);
      return;
    }
    output.push(step);
  };
  visit(steps);
  return output;
}

function countPipelineTool(steps, toolName, projectRoot) {
  return collectPipelineActionSpecs(steps).reduce((count, step) => {
    try {
      return count + (normalizeAction(step, projectRoot).tool === toolName ? 1 : 0);
    } catch (_) {
      return count;
    }
  }, 0);
}

function pipelineHasBaselineVerify(steps, profile, projectRoot) {
  const configured = Array.isArray(profile?.verify)
    ? profile.verify
        .filter((command) => typeof command === 'string' && command.trim())
        .map(normalizeVerificationCommand)
    : [];
  for (const step of collectPipelineActionSpecs(steps)) {
    let normalized;
    try {
      normalized = normalizeAction(step, projectRoot);
    } catch (_) {
      continue;
    }
    if (normalized.tool !== 'verify') continue;
    const input = normalized.input || {};
    const explicitCommands = [
      ...verifyCommandsFromInput(input.commands ?? input.verify, {}),
      ...(typeof input.command === 'string' && input.command.trim() ? [input.command] : []),
    ];
    if (!explicitCommands.length) return true;
    const normalizedExplicit = explicitCommands.map(normalizeVerificationCommand);
    if (configured.some((command) => normalizedExplicit.includes(command))) return true;
  }
  return false;
}

function inspectHasExplicitTarget(input = {}) {
  return Boolean(input.symbol)
    || input.startLine !== undefined
    || input.endLine !== undefined
    || (Array.isArray(input.ranges) && input.ranges.length > 0);
}

function guardBatchInspectAction(normalized, enabled) {
  if (!enabled || normalized?.tool !== 'inspect' || !normalized.input || typeof normalized.input !== 'object') {
    return normalized;
  }
  // Explicit symbols/ranges are already bounded; preserve them without a hidden opt-in.
  if (inspectHasExplicitTarget(normalized.input)) return normalized;
  const requestedMax = Number(normalized.input.maxChars);
  return {
    ...normalized,
    input: {
      ...normalized.input,
      budget: 'shallow',
      full: false,
      maxChars: Math.min(
        Number.isFinite(requestedMax) && requestedMax > 0 ? Math.floor(requestedMax) : RESPONSE_BUDGETS.inspect,
        RESPONSE_BUDGETS.inspect
      ),
    },
  };
}

function applyDecisionPackageControls(normalized, enabled) {
  if (!enabled || !normalized?.input || typeof normalized.input !== 'object') return normalized;
  const input = { ...normalized.input };
  if (normalized.tool === 'explore' && input.maxChars === undefined) {
    input.maxChars = PIPELINE_EXPLORE_OUTPUT_CLIP;
  }
  if (normalized.tool === 'inspect' && input.maxChars === undefined) {
    input.maxChars = PIPELINE_MAX_OUTPUT_CLIP;
  }
  input.allowWiden = true;
  return { ...normalized, input };
}

export async function workPipeline(ctx, input = {}) {
  const steps = [];
  const nestedFull = input.full === true;
  const nestedMaxChars = Number.isFinite(input.maxChars) && input.maxChars > 0 ? Math.floor(input.maxChars) : null;
  const preflight = [];
  const probes = input.inspect ?? input.read;
  if (probes !== undefined) {
    const rawProbes = Array.isArray(probes) ? probes : [probes];
    preflight.push(...rawProbes.map((probe) => {
      if (typeof probe === 'string') {
        return {
          action: 'inspect',
          args: {
            path: probe,
            allowExplicitBatchInspect: true,
            ...(nestedFull ? { full: true } : {}),
            ...(nestedMaxChars ? { maxChars: nestedMaxChars } : {}),
          },
        };
      }
      if (!probe || typeof probe !== 'object' || Array.isArray(probe)) {
        throw new Error('work.inspect entries must be paths or inspect argument objects');
      }
      return {
        action: 'inspect',
        args: {
          ...probe,
          allowExplicitBatchInspect: true,
          ...(nestedFull && probe.full === undefined ? { full: true } : {}),
          ...(nestedMaxChars && probe.maxChars === undefined ? { maxChars: nestedMaxChars } : {}),
        },
      };
    }));
  }

  if (input.search !== undefined) {
    const rawSearches = Array.isArray(input.search) ? input.search : [input.search];
    for (const entry of rawSearches) {
      const spec = typeof entry === 'string'
        ? { query: entry }
        : (entry && typeof entry === 'object' && !Array.isArray(entry) ? { ...entry } : null);
      if (!spec || typeof spec.query !== 'string' || !spec.query.trim()) {
        throw new Error('work.search entries must be query strings or search argument objects with a query');
      }
      const requestedPaths = Array.isArray(spec.paths)
        ? spec.paths.filter((value) => typeof value === 'string' && value.trim())
        : (typeof spec.paths === 'string' && spec.paths.trim() ? [spec.paths] : []);
      if (typeof spec.path === 'string' && spec.path.trim() && spec.root === undefined) {
        spec.root = spec.path;
      }
      delete spec.path;
      delete spec.paths;
      const roots = requestedPaths.length ? requestedPaths : [spec.root];
      for (const root of roots) {
        const searchSpec = { ...spec };
        if (root !== undefined && root !== null && String(root).trim()) searchSpec.root = root;
        else delete searchSpec.root;
        const searchAction = { search: searchSpec };
        if (nestedMaxChars) searchAction.maxChars = nestedMaxChars;
        preflight.push(searchAction);
      }
    }
  }
  if (preflight.length) steps.push({ parallel: preflight });

  const commands = verifyCommandsFromInput(input.commands ?? input.verify, ctx.profile);
  if (!commands.length && typeof input.command === 'string' && input.command.trim()) {
    commands.push(input.command);
  }

  const mutation = { ...input };
  delete mutation.inspect;
  delete mutation.read;
  delete mutation.search;
  delete mutation.verify;
  delete mutation.commands;
  delete mutation.command;
  delete mutation.depth;
  delete mutation.branches;
  delete mutation.budget;
  delete mutation.continueOnFailure;
  const mutationKeys = ['create', 'edits', 'delete', 'deletes', 'path', 'slot', 'append', 'symbol', 'replacement', 'replacementContent', 'target', 'targetContent', 'content', 'overwrite', 'fullFile', 'architecture'];
  const hasMutation = mutationKeys.some((key) => mutation[key] !== undefined);
  if (hasMutation) {
    if (commands.length) mutation.verify = commands;
    steps.push({ action: 'change', args: mutation });
  } else if (commands.length) {
    steps.push({ action: 'verify', args: { commands, command: input.command, depth: input.depth, full: input.full, maxChars: input.maxChars } });
  }

  if (!steps.length) {
    return '# ContextOS work\n- No work supplied. Pass inspect, create/edits, and/or verify in one call.';
  }

  const responseBudget = Number.isFinite(input.maxChars) && input.maxChars > 0
    ? Math.floor(input.maxChars)
    : (RESPONSE_BUDGETS.work || RESPONSE_BUDGETS.inspect);
  const result = await pipelinePipeline(ctx, {
    steps,
    mode: input.mode || (input.full === true ? 'full' : 'summary'),
    maxChars: responseBudget,
    branches: input.branches,
    budget: input.budget,
    continueOnFailure: input.continueOnFailure,
    decisionPackage: !hasMutation && preflight.length > 0,
  });
  return result
    .replace(/^# ContextOS pipeline/, '# ContextOS work')
    .replace(/^pipeline=/m, 'work=');
}

function extractDecisionCoveredPaths(output = '') {
  const covered = new Set();
  const source = String(output);
  const patterns = [
    /^- `([^`\n]+)` \([^)]*\)/gm,
    /^- Test contract `([^`\n]+)`:/gm,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const candidate = String(match[1] || '').trim().replace(/^\.\//, '');
      if (!candidate || (!candidate.includes('/') && !candidate.includes('.'))) continue;
      covered.add(candidate);
    }
  }
  return covered;
}

function requestedInspectPaths(input = {}) {
  return [
    input.path,
    ...(Array.isArray(input.paths) ? input.paths : []),
    ...(Array.isArray(input.globs) ? input.globs : []),
  ]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim().replace(/^\\.\//, ''));
}

function inspectCoveredByDecision(normalized, coveredPaths) {
  if (normalized?.tool !== 'inspect' || !coveredPaths?.size) return false;
  if (normalized.input?.allowExplicitBatchInspect === true) return false;
  const requested = requestedInspectPaths(normalized.input);
  return requested.length > 0 && requested.every((target) => coveredPaths.has(target));
}

export async function pipelinePipeline(ctx, input = {}) {
  let steps = input.steps || input.flow || input.actions;
  if (!steps) {
    if (input.parallel) steps = [{ parallel: input.parallel }];
    else if (input.chain) steps = [{ chain: input.chain }];
    else steps = [];
  }
  if (!Array.isArray(steps) || !steps.length) {
    return '# ContextOS pipeline\n- No steps provided in pipeline. Pass `steps: [...]`, `chain: [...]`, or `parallel: [...]`.';
  }

  let autoBaselineVerify = false;
  const initialExploreCount = countPipelineTool(steps, 'explore', ctx.projectRoot);
  const initialMutationCount = ['change', 'work', 'ship']
    .reduce((count, toolName) => count + countPipelineTool(steps, toolName, ctx.projectRoot), 0);
  if (initialExploreCount > 0
    && !pipelineHasBaselineVerify(steps, ctx.profile, ctx.projectRoot)
    && initialMutationCount === 0
    && input.autoVerify !== false) {
    const commands = verifyCommandsFromInput(true, ctx.profile);
    if (commands.length) {
      steps = [...steps, {
        tool: 'verify',
        args: {
          commands,
          ...(input.autoTriage !== undefined ? { autoTriage: input.autoTriage } : {}),
        },
      }];
      autoBaselineVerify = true;
    }
  }

  const explicitlyFull = input.full === true || input.budget === 'full' || input.mode === 'full';
  const nestedFull = requestsFullOutput(steps);
  const mode = input.mode || (explicitlyFull ? 'full' : 'summary');
  const receiptMode = isReceiptMode(mode);
  const exploreActionCount = countPipelineTool(steps, 'explore', ctx.projectRoot);
  const decisionPackage = !receiptMode && (exploreActionCount > 0 || input.decisionPackage === true) && input.decisionPackage !== false;
  // An explicit aggregate summary wins over a nested action's full-output
  // request. Otherwise one inspect can expand the entire courier response.
  const renderFull = !receiptMode && (mode === 'full' || (nestedFull && input.mode !== 'summary'));
  const responseBudget = input.maxChars ?? (mode === 'full'
    ? Infinity
    : (receiptMode
        ? PIPELINE_RECEIPT_RESPONSE_BUDGET
        : (decisionPackage ? PIPELINE_DECISION_RESPONSE_BUDGET : RESPONSE_BUDGETS.pipeline)));
  const actionBudgetOptions = {
    mode: renderFull ? 'full' : mode,
    aggregateBudget: renderFull && mode !== 'full'
      ? Math.max(1, responseBudget - 256)
      : responseBudget,
  };
  const results = [];
  let halted = false;
  let haltReason = null;
  let failureCount = 0;
  let executedActions = 0;
  let decisionExploreSeen = false;
  let decisionCoveredPaths = new Set();
  const batchStartedAt = Date.now();
  const batchInspectCount = countPipelineTool(steps, 'inspect', ctx.projectRoot);
  const forceBatchInspectOutline = batchInspectCount > 1;
  const continueOnFailure = input.continueOnFailure === true
    || requestsContinueOnFailure(steps)
    || autoBaselineVerify;
  const branches = Array.isArray(input.branches) ? input.branches : [];
  const batchBudget = input.budget && typeof input.budget === 'object' && !Array.isArray(input.budget)
    ? input.budget
    : {};
  const maxActions = Number.isFinite(Number(batchBudget.maxActions))
    ? Math.max(1, Math.floor(Number(batchBudget.maxActions)))
    : null;
  const maxFailures = Number.isFinite(Number(batchBudget.maxFailures))
    ? Math.max(1, Math.floor(Number(batchBudget.maxFailures)))
    : null;
  const maxDurationMs = Number.isFinite(Number(batchBudget.maxDurationMs))
    ? Math.max(1, Math.floor(Number(batchBudget.maxDurationMs)))
    : null;

  function budgetStop() {
    if (maxDurationMs && Date.now() - batchStartedAt > maxDurationMs) {
      return `budget exceeded: maxDurationMs=${maxDurationMs}`;
    }
    if (maxActions && executedActions >= maxActions) {
      return `budget exceeded: maxActions=${maxActions}`;
    }
    if (maxFailures && failureCount >= maxFailures) {
      return `budget exceeded: maxFailures=${maxFailures}`;
    }
    return null;
  }

  for (let i = 0; i < steps.length; i++) {
    const stopReason = budgetStop();
    if (stopReason) {
      halted = true;
      haltReason = stopReason;
      break;
    }
    const step = steps[i];
    const stepNum = i + 1;

    // Parallel group: Array or { parallel: [...] }
    if (Array.isArray(step) || (step && Array.isArray(step.parallel))) {
      const items = Array.isArray(step) ? step : step.parallel;
      const parallelConcurrency = normalizeParallelConcurrency(
        input.parallelConcurrency ?? input.maxConcurrency
      );
      const subResults = await mapWithConcurrency(items, parallelConcurrency, async (action, idx) => {
        try {
          const normalized = applyDecisionPackageControls(
            guardBatchInspectAction(applyPipelineControls(normalizeAction(action, ctx.projectRoot), input), forceBatchInspectOutline),
            decisionPackage
          );
          const res = await ctx.orchestrator.dispatch(normalized.tool, normalized.input);
          const isFail = actionFailed(normalized, res, ctx.store?.current?.receipts);
          return {
            index: idx + 1,
            tool: normalized.tool,
            ok: !isFail,
            output: res,
            maxChars: resolveActionOutputLimit(action, actionBudgetOptions),
            requestedMaxChars: explicitActionMaxChars(action),
          };
        } catch (err) {
          return { index: idx + 1, tool: action?.tool || 'unknown', ok: false, error: err.message };
        }
      });
      executedActions += items.length;
      const parallelOk = subResults.every((r) => r.ok);
      results.push({
        step: stepNum,
        kind: 'parallel',
        items: subResults,
        ok: parallelOk,
      });
      if (!parallelOk) {
        failureCount += subResults.filter((item) => !item.ok).length;
        if (!continueOnFailure) {
          halted = true;
          haltReason = `Parallel step ${stepNum} contains failed action(s)`;
          break;
        }
      }
      continue;
    }

    // Serial chain group: { chain: [...] }
    if (step && Array.isArray(step.chain)) {
      const items = step.chain;
      const subResults = [];
      let chainFailed = false;

      for (let j = 0; j < items.length; j++) {
        const stopReason = budgetStop();
        if (stopReason) {
          halted = true;
          haltReason = stopReason;
          break;
        }
        const action = items[j];
        try {
          const normalized = applyDecisionPackageControls(
            guardBatchInspectAction(applyPipelineControls(normalizeAction(action, ctx.projectRoot), input), forceBatchInspectOutline),
            decisionPackage
          );
          const res = await ctx.orchestrator.dispatch(normalized.tool, normalized.input);
          executedActions += 1;
          const isFail = actionFailed(normalized, res, ctx.store?.current?.receipts);
          subResults.push({
            index: j + 1,
            tool: normalized.tool,
            ok: !isFail,
            output: res,
            maxChars: resolveActionOutputLimit(action, actionBudgetOptions),
            requestedMaxChars: explicitActionMaxChars(action),
          });
          if (isFail) {
            chainFailed = true;
            failureCount += 1;
            haltReason = `Chain step ${j + 1} (${normalized.tool}) failed verification/gate`;
            if (!continueOnFailure) break;
          }
        } catch (err) {
          subResults.push({ index: j + 1, tool: action.tool || 'unknown', ok: false, error: err.message });
          chainFailed = true;
          failureCount += 1;
          haltReason = `Chain step ${j + 1} (${action.tool || 'action'}) threw error: ${err.message}`;
          if (!continueOnFailure) break;
        }
      }

      results.push({
        step: stepNum,
        kind: 'chain',
        items: subResults,
        ok: !chainFailed,
      });

      if (chainFailed && !continueOnFailure) {
        halted = true;
        break;
      }
      continue;
    }

    try {
      const normalized = guardBatchInspectAction(applyPipelineControls(normalizeAction(step, ctx.projectRoot), input), forceBatchInspectOutline);
      if (inspectCoveredByDecision(normalized, decisionCoveredPaths)) {
        const skippedOutput = `# ContextOS inspect\n\n- Skipped redundant inspect: the prior explore decision package already contains ${requestedInspectPaths(normalized.input).map((target) => `\`${target}\``).join(', ')}.\n- Next: mutate with change/work; do not replay the artifact.`;
        results.push({
          step: stepNum,
          kind: 'single',
          tool: normalized.tool,
          ok: true,
          output: skippedOutput,
          maxChars: skippedOutput.length,
          requestedMaxChars: null,
        });
        executedActions += 1;
        continue;
      }
      const res = await ctx.orchestrator.dispatch(normalized.tool, normalized.input);
      executedActions += 1;
      if (normalized.tool === 'explore' && /\bread_complete=true\b/.test(String(res ?? ''))) {
        decisionExploreSeen = true;
        decisionCoveredPaths = extractDecisionCoveredPaths(res);
      }
      const isFail = actionFailed(normalized, res, ctx.store?.current?.receipts);
      results.push({
        step: stepNum,
        kind: 'single',
        tool: normalized.tool,
        ok: !isFail,
        output: res,
        maxChars: resolveActionOutputLimit(step, actionBudgetOptions),
        requestedMaxChars: explicitActionMaxChars(step),
      });
      if (isFail) {
        failureCount += 1;
        if (!continueOnFailure) {
          halted = true;
          haltReason = `Step ${stepNum} (${normalized.tool}) failed verification/gate`;
          break;
        }
      }
    } catch (err) {
      results.push({
        step: stepNum,
        kind: 'single',
        tool: step.tool || 'unknown',
        ok: false,
        error: err.message,
      });
      failureCount += 1;
      if (!continueOnFailure) {
        halted = true;
        haltReason = `Step ${stepNum} threw error: ${err.message}`;
        break;
      }
    }
  }

  function failedActionEntries() {
    const entries = [];
    for (const result of results) {
      if (result.kind === 'parallel' || result.kind === 'chain') {
        for (const item of result.items) {
          if (!item.ok) entries.push({ step: result.step, ...item });
        }
      } else if (!result.ok) {
        entries.push({ step: result.step, ...result });
      }
    }
    return entries;
  }

  function branchMatches(when = {}) {
    if (!when || typeof when !== 'object' || Array.isArray(when)) return false;
    const failedEntries = failedActionEntries();
    if (when.failed === true && failureCount === 0) return false;
    if (when.status === 'failed' && failureCount === 0) return false;
    if (when.status === 'passed' && failureCount > 0) return false;
    if (when.step !== undefined && !failedEntries.some((entry) => Number(entry.step) === Number(when.step))) {
      return false;
    }
    if (when.tool !== undefined && !failedEntries.some((entry) => String(entry.tool) === String(when.tool))) {
      return false;
    }
    return true;
  }

  const branchResults = [];
  for (const branch of branches) {
    if (!branch || typeof branch !== 'object' || Array.isArray(branch)) continue;
    if (!branchMatches(branch.when)) continue;
    const actions = Array.isArray(branch.then) ? branch.then : (branch.then ? [branch.then] : []);
    if (!actions.length) continue;
    const subResults = [];
    for (const action of actions) {
      const stopReason = budgetStop();
      if (stopReason) {
        halted = true;
        haltReason = stopReason;
        break;
      }
      try {
        const normalized = applyDecisionPackageControls(
          guardBatchInspectAction(applyPipelineControls(normalizeAction(action, ctx.projectRoot), input), forceBatchInspectOutline),
          decisionPackage
        );
        const res = await ctx.orchestrator.dispatch(normalized.tool, normalized.input);
        executedActions += 1;
        const isFail = actionFailed(normalized, res, ctx.store?.current?.receipts);
        subResults.push({
          index: subResults.length + 1,
          tool: normalized.tool,
          ok: !isFail,
          output: res,
          maxChars: resolveActionOutputLimit(action, actionBudgetOptions),
          requestedMaxChars: explicitActionMaxChars(action),
        });
        if (isFail) {
          failureCount += 1;
          haltReason = `Branch action ${subResults.length} (${normalized.tool}) failed verification/gate`;
        }
      } catch (err) {
        subResults.push({
          index: subResults.length + 1,
          tool: action?.tool || 'unknown',
          ok: false,
          error: err.message,
        });
        failureCount += 1;
        haltReason = `Branch action ${subResults.length} threw error: ${err.message}`;
      }
    }
    branchResults.push({
      index: branchResults.length + 1,
      kind: 'branch',
      when: branch.when || null,
      items: subResults,
      ok: subResults.length > 0 && subResults.every((item) => item.ok),
    });
  }
  if (branchResults.some((branch) => branch.ok)) {
    halted = false;
    haltReason = null;
  }

  const totalActions = results.reduce((sum, result) => {
    if (result.kind === 'parallel' || result.kind === 'chain') return sum + result.items.length;
    return sum + 1;
  }, 0) + branchResults.reduce((sum, result) => sum + result.items.length, 0);
  const totalSteps = steps.length + branchResults.reduce((sum, result) => sum + result.items.length, 0);
  const weightedActionUnits = totalActions + exploreActionCount * 4;
  const summaryUnitBudget = Number.isFinite(responseBudget)
    ? (responseBudget < 800
        ? Math.max(140, Math.min(260, Math.floor(responseBudget / Math.max(2, weightedActionUnits + 1))))
        : Math.max(400, Math.min(
            PIPELINE_MAX_OUTPUT_CLIP,
            Math.floor(responseBudget / Math.max(1, weightedActionUnits))
          )))
    : PIPELINE_DEFAULT_OUTPUT_CLIP;
  const summaryBudgetFor = (toolName) => Math.max(
    400,
    Math.min(
      toolName === 'explore' ? PIPELINE_EXPLORE_OUTPUT_CLIP : PIPELINE_MAX_OUTPUT_CLIP,
      summaryUnitBudget * (toolName === 'explore' ? 5 : 1)
    )
  );

  function artifactRef(output) {
    const match = String(output || '').match(/(?:artifact=|os-response[^\n]*artifact=)([A-Za-z0-9._-]+)/);
    return match ? ` artifact=${match[1]}` : '';
  }

  function compactReceiptText(text, maxChars) {
    const lines = String(text)
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    const selected = [];
    let capture = false;
    for (const line of lines) {
      if (/^##\s+(?:Next|Where to look|Result|Verify|Touched|Now)/i.test(line)) {
        capture = true;
        selected.push(line);
        continue;
      }
      if (/^##\s+/.test(line)) {
        capture = false;
        continue;
      }
      if (capture && (/^[-*]/.test(line) || /^(?:change\(|👉)/.test(line))) {
        selected.push(line);
        continue;
      }
      if (/^(?:👉|Next:|verify:|receipt=|artifact=|done:|edited\s|Architecture:|Ship:)/i.test(line)) {
        selected.push(line);
      }
    }
    return clip(selected.join(' | ') || lines.slice(0, 4).join(' | '), Math.min(maxChars, 320));
  }

  function formatReceiptOutput(output, budget = PIPELINE_RECEIPT_OUTPUT_CLIP) {
    const text = typeof output === 'string'
      ? output
      : (typeof output === 'object' && output !== null
          ? (output.text || output.summary || JSON.stringify(output))
          : String(output ?? ''));
    const receipt = text.match(/\breceipt[ =:-]+([A-Za-z0-9._-]+)/i);
    const artifact = text.match(/\bartifact[ =:-]+([A-Za-z0-9._-]+)/i);
    const verdict = text.match(/Verdict:\s*(PASS|FAIL)/i);
    const exitCode = text.match(/\bexit\s+(-?\d+)/i);
    // Ship output is intentionally clipped in receipt mode. Preserve the
    // architecture gate as a tiny machine-readable fact so a bounded receipt
    // cannot look successful while silently carrying missing ownership.
    const architectureGaps = text.match(/Curated architecture:\s*(\d+)\s+gap/i);
    const missingBlocks = text.match(/missing curated Block\s+(\d+)/i);
    const missingChains = text.match(/owner without Chain membership\s+(\d+)/i);
    const parts = [];
    if (receipt) parts.push(`receipt=${receipt[1]}`);
    if (artifact) parts.push(`artifact=${artifact[1]}`);
    if (verdict) parts.push(`verdict=${verdict[1].toUpperCase()}`);
    if (exitCode) parts.push(`exit=${exitCode[1]}`);
    if (architectureGaps) parts.push(`architectureGaps=${architectureGaps[1]}`);
    if (missingBlocks) parts.push(`missingBlocks=${missingBlocks[1]}`);
    if (missingChains) parts.push(`missingChains=${missingChains[1]}`);
    const locatorSummary = compactReceiptText(text, budget);
    if (parts.length) return clip(`${parts.join(' ')} | ${locatorSummary}`, budget);
    return locatorSummary;
  }

  function formatPipelineOutput(output, budget = summaryBudgetFor('inspect')) {
    if (!output) return '';
    if (receiptMode) return formatReceiptOutput(output, budget);
    if (renderFull) {
      if (typeof output === 'string') return clip(output, budget);
      if (typeof output === 'object') {
        if (output.text) return clip(output.text, budget);
        if (output.summary) return clip(output.summary, budget);
        return clip(JSON.stringify(output, null, 2), budget);
      }
      return clip(String(output), budget);
    }
    const summary = summarizeActionResult(output, {
      maxChars: budget,
      includeDiagnostics: true,
    });
    return `${artifactRef(output)}${summary}`.trim();
  }

  function isCompleteExploreDecision(item) {
    if (item?.tool !== 'explore') return false;
    const output = String(item.output ?? '');
    return /\bread_complete=true\b/.test(output)
      && /\bnext=change\(/.test(output)
      && !/\[response truncated\b/.test(output)
      && !/<!--\s*os-response\b[^\n]*\bartifact=/.test(output);
  }

  function actionRenderBudget(item) {
    if (renderFull) {
      return item.maxChars ?? responseBudget ?? PIPELINE_MAX_OUTPUT_CLIP;
    }
    if (isCompleteExploreDecision(item)) {
      return Math.min(
        item.maxChars ?? PIPELINE_EXPLORE_OUTPUT_CLIP,
        responseBudget ?? PIPELINE_EXPLORE_OUTPUT_CLIP
      );
    }
    return Math.min(
      item.maxChars ?? PIPELINE_MAX_OUTPUT_CLIP,
      summaryBudgetFor(item.tool)
    );
  }

  function renderPipelineActionDetail(item) {
    const budget = actionRenderBudget(item);
    const detail = formatPipelineOutput(item.output, budget);
    if (!detail) return '';
    // Preserve Markdown and line-oriented source for decision-package actions.
    // Flattening fences with " | " makes a bounded package look corrupted and
    // forces the host to reread it through a different tool.
    if (item.tool === 'explore' || item.tool === 'inspect') return `\n${detail}`;
    return detail.replace(/\r?\n/g, ' | ');
  }

  function formatPipelineFailure(item) {
    const output = typeof item?.output === 'string' ? item.output : '';
    const source = item?.error || output || 'verification/gate';
    const lines = String(source)
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    const header = lines.find((value) => /(?:Verdict|Verify):\s*FAIL/i.test(value));
    const evidence = extractFailureEvidence(source);
    const detail = evidence.cause
      || evidence.stackFrame
      || lines.find((value) => /AssertionError|(?:Error|Expected):|Expected\s+/i.test(value))
      || lines.find((value) => /not ok|exit\s+[1-9]/i.test(value));
    const triage = extractMicroTriage(source);
    // A bounded Pipeline failure is still actionable state, not just a status.
    // Preserve the receipt/artifact locator so the next host turn can inspect
    // the existing evidence instead of rerunning the same verification.
    const receipt = String(source).match(/\breceipt(?:\s+|[=:~-])([A-Za-z0-9._-]+)/i)?.[1];
    const artifact = String(source).match(/\bartifact\s*[=:]\s*([A-Za-z0-9._-]+)/i)?.[1];
    const next = lines.find((value) => /change\(|next:\s/i.test(value));
    const sessionReceipts = Array.isArray(ctx.store?.current?.receipts)
      ? ctx.store.current.receipts
      : [];
    const fallbackReceipts = sessionReceipts
      .filter((entry) => Number(entry?.exitCode) !== 0 && entry?.id)
      .slice(-3)
      .map((entry) => `receipt=${entry.id}`);
    const references = [
      receipt ? `receipt=${receipt}` : null,
      artifact ? `artifact=${artifact}` : null,
      next ? `next=${clip(next, 180)}` : null,
      ...(receipt ? [] : fallbackReceipts),
    ];
    // Keep the triage block ahead of raw failure noise: it is the only part of
    // a large failing log that was already reduced by Micro.
    const body = triage
      ? `Micro-Triage: ${triage}`
      : [detail, evidence.stackFrame].filter(Boolean).filter((line, index, values) => values.indexOf(line) === index).join(' | ');
    return clip([header, body, ...references].filter(Boolean).join(' | ') || source, triage ? 900 : 500);
  }

  const recovered = branchResults.some((branch) => branch.ok);
  const pipelineStatus = halted
    ? 'HALTED'
    : (failureCount
        ? (recovered ? 'RECOVERED' : (continueOnFailure ? 'PARTIAL' : 'FAIL'))
        : 'OK');
  const lines = [`pipeline=${pipelineStatus} actions=${totalActions}/${totalSteps}${receiptMode ? ' mode=receipt' : ''}`];
  if (halted && haltReason) lines.push(`stop=${haltReason}`);

  for (const r of results) {
    if (r.kind === 'parallel') {
      const body = r.items.map((item) => {
        const detail = item.ok
          ? renderPipelineActionDetail(item)
          : ` FAIL: ${formatPipelineFailure(item)}`;
        return `${item.tool}=${item.ok ? 'OK' : 'FAIL'}${detail ? ` ${detail}` : ''}`;
      }).join(' ; ');
      lines.push(`parallel#${r.step} ${r.ok ? 'OK' : 'FAIL'} :: ${body}`);
    } else if (r.kind === 'chain') {
      const body = r.items.map((item) => {
        const detail = item.ok
          ? renderPipelineActionDetail(item)
          : ` FAIL: ${formatPipelineFailure(item)}`;
        return `${item.tool}=${item.ok ? 'OK' : 'FAIL'}${detail ? ` ${detail}` : ''}`;
      }).join(' -> ');
      lines.push(`chain#${r.step} ${r.ok ? 'OK' : (halted ? 'HALTED' : 'FAIL')} :: ${body}`);
    } else {
      const detail = r.ok
        ? (halted ? '' : renderPipelineActionDetail(r))
        : ` FAIL: ${formatPipelineFailure(r)}`;
      lines.push(`step#${r.step} ${r.tool}=${r.ok ? 'OK' : 'FAIL'}${detail ? ` ${detail}` : ''}`);
    }
  }
  for (const r of branchResults) {
    const body = r.items.map((item) => {
      const detail = item.ok
        ? renderPipelineActionDetail(item)
        : ` FAIL: ${formatPipelineFailure(item)}`;
      return `${item.tool}=${item.ok ? 'OK' : 'FAIL'}${detail ? ` ${detail}` : ''}`;
    }).join(' -> ');
    lines.push(`branch#${r.index} ${r.ok ? 'OK' : 'FAIL'} :: ${body}`);
  }

  const summaryTruncated = !renderFull && results.some((result) => {
    const items = result.items || [result];
    return items.some((item) => {
      if (!item?.ok) return false;
      const completeExplore = isCompleteExploreDecision(item);
      if (/\bos-response\b[^\n]*\bartifact=/.test(String(item.output ?? '')) && !completeExplore) {
        return true;
      }
      return outputLength(item.output) > actionRenderBudget(item);
    });
  });
  const exploreIncomplete = results.some((result) => {
    const items = result.items || [result];
    return items.some((item) => {
      if (item?.tool !== 'explore') return false;
      const output = String(item.output || '');
      if (/\bread_complete=false\b/.test(output)) return true;
      return /\bread_complete=true\b/.test(output) && !isCompleteExploreDecision(item);
    });
  });
  const decisionReady = decisionPackage
    && !exploreIncomplete
    && !summaryTruncated
    && lines.join('\n').length <= responseBudget;
  if (decisionReady) {
    for (let index = 0; index < lines.length; index += 1) {
      lines[index] = lines[index].replace(/\s+artifact=[A-Za-z0-9._-]+/g, '');
    }
    lines[0] += ' decision=complete';
    lines.push('decision=complete read_complete=true do_not_reread=true native_mutation=forbidden after_read_complete=change_or_work_only next=change({edits,verify,architecture}); after_pass=finalize_without_speculative_edits');
  } else if (decisionPackage && exploreIncomplete) {
    lines[0] += ' decision=partial';
    lines.push('decision=partial read_complete=false; perform the named bounded recovery read, then mutate or verify.');
  }
  const raw = lines.join('\n');
  const artifactContent = {
    status: pipelineStatus,
    totalActions,
    steps: results,
    branches: branchResults,
  };
  const { text, meta } = finalizeResponse(raw, {
    projectRoot: ctx.projectRoot,
    tool: 'pipeline',
    maxChars: responseBudget,
    full: mode === 'full' && !Number.isFinite(responseBudget),
    allowWiden: (explicitlyFull || decisionPackage) && !receiptMode,
    forceArtifact: input.forceArtifact === true || summaryTruncated,
    artifactContent,
  });
  return `${text}\n\n<!-- os-budget ${meta.chars} chars ~${meta.estimatedTokens} tokens${meta.truncated ? ' truncated' : ''}${receiptMode ? ' mode=receipt' : ''} -->`;
}
