import { microDeliveryPrompt, parseMicroRouting } from './micro-reporting.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const get = (value, dotted) => typeof dotted === 'string' ? dotted.split('.').filter(Boolean).reduce((v, k) => v?.[k], value) : undefined;
const number = value => {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) return null;
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
};
const limit = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const CLI_FINGERPRINT_LIMIT = 2000;

function cliFileFingerprint(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return `${stat.size}:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
  } catch (error) {
    return error.code === 'ENOENT' ? 'missing' : null;
  }
}

function fingerprintCliImplementationPaths(projectRoot, allowedPaths = []) {
  const root = path.resolve(projectRoot);
  const files = new Map();
  const visit = (absolute) => {
    if (files.size >= CLI_FINGERPRINT_LIMIT) return;
    let stat;
    try { stat = fs.statSync(absolute); } catch (error) {
      files.set(path.relative(root, absolute).split(path.sep).join('/'), 'missing');
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
    files.set(path.relative(root, absolute).split(path.sep).join('/'), cliFileFingerprint(absolute));
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

function cliImplementationDiff(before, after) {
  const changedPaths = new Set();
  for (const file of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(file) !== after.get(file)) changedPaths.add(file);
  }
  return { applied: changedPaths.size > 0, changedPaths: [...changedPaths].sort() };
}

function resolveCliExecutable(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const candidates = command.includes('/') || command.includes('\\') ? [command] : [
    ...(process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, command)),
    path.join(os.homedir(), '.local', 'bin', command),
  ];
  if (process.platform === 'win32') candidates.push(...candidates.filter(p => !path.extname(p)).map(p => p + '.exe'));
  return candidates.find(candidate => { try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch { return false; } }) || null;
}

export function validateCliAdapter(cli = {}) {
  const errors = [];
  if (!cli.command) errors.push('cli.command is required');
  if (!Array.isArray(cli.args) || cli.args.some(v => typeof v !== 'string')) errors.push('cli.args must be a string array');
  if (!cli.args?.some?.(v => v.includes('{model}'))) errors.push('cli.args must explicitly map {model}');
  if (!['text', 'json', 'jsonl'].includes(cli.output?.format)) errors.push('cli.output.format must be text, json or jsonl');
  if (!['text', 'json', 'jsonl'].includes(cli.input?.format)) errors.push('cli.input.format must be text, json or jsonl');
  if (cli.output?.format === 'jsonl' && (!cli.output.terminal?.path || !cli.output.terminal.value)) errors.push('JSONL needs an explicit terminal event mapping');
  if (cli.output?.format !== 'text' && !cli.output?.contentPath) errors.push('cli.output.contentPath is required');
  if (cli.output?.usage && typeof cli.output.usage.inputIncludesCache !== 'boolean') errors.push('usage.inputIncludesCache must declare cache semantics');
  if (cli.output?.usage?.reasoning && typeof cli.output.usage.reasoningIncludedInOutput !== 'boolean') errors.push('usage.reasoningIncludedInOutput must declare reasoning semantics');
  if (cli.output?.contextUsage) {
    const context = cli.output.contextUsage;
    if (!context.path || typeof context.path !== 'string') errors.push('contextUsage.path is required');
    if (!context.percent) {
      if (!context.input || typeof context.input !== 'string') errors.push('contextUsage.input is required without a direct percent mapping');
      if (!(number(context.window ?? context.contextWindow) > 0)) errors.push('contextUsage.window must be a positive token count');
      if (typeof context.inputIncludesCache !== 'boolean') errors.push('contextUsage.inputIncludesCache must declare cache semantics');
    }
  }
  if (cli.resumeArgs && (!Array.isArray(cli.resumeArgs) || !cli.resumeArgs.some(v => typeof v === 'string' && v.includes('{sessionId}')))) errors.push('resumeArgs must map {sessionId}');
  return errors;
}

function hasFullPermissionGrant(cli = {}) {
  return Array.isArray(cli.args) && cli.args.includes('--dangerously-skip-permissions');
}

export function cliDoctor(config = {}) {
  const cli = config.cli || {};
  const errors = validateCliAdapter(cli);
  const executable = resolveCliExecutable(cli.command);
  return {
    ok: errors.length === 0 && Boolean(executable) && Boolean(config.model), provider: 'cli',
    checks: [
      { name: 'adapter', ok: errors.length === 0, value: errors.length ? errors.join('; ') : 'mapped' },
      { name: 'installed', ok: Boolean(executable), value: executable },
      { name: 'model', ok: Boolean(config.model), value: config.model || null },
      { name: 'permission_grant', ok: hasFullPermissionGrant(cli) ? true : null, value: hasFullPermissionGrant(cli) ? 'full (preconfigured)' : 'not declared' },
      { name: 'context_usage', ok: cli.output?.contextUsage ? true : null, value: cli.output?.contextUsage ? 'mapped' : 'not mapped' },
      { name: 'authentication', ok: null, value: 'not probed; existing CLI login is reused' },
    ],
    note: 'Local inspection makes no model request. Use probe:true for one explicit end-to-end check.',
  };
}

function template(value, vars) {
  if (typeof value === 'string') return value.replace(/\{(task|model|thinking|mode|sessionId|workspace)\}/g, (_, name) => vars[name] ?? '');
  if (Array.isArray(value)) return value.map(item => template(item, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, template(v, vars)]));
  return value;
}

export function normalizeCliUsage(raw, mapping) {
  if (!raw || !mapping) return null;
  const input = number(get(raw, mapping.input)), output = number(get(raw, mapping.output));
  const cache = mapping.cache ? number(get(raw, mapping.cache)) : 0;
  const reasoning = mapping.reasoning ? number(get(raw, mapping.reasoning)) : 0;
  if ([input, output, cache, reasoning].some(v => v === null)) return null;
  if (mapping.inputIncludesCache && cache > input) return null;
  const prompt_tokens = input + (mapping.inputIncludesCache ? 0 : cache);
  const completion_tokens = output + (mapping.reasoningIncludedInOutput === false ? reasoning : 0);
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens,
    cached_input_tokens: cache, uncached_input_tokens: prompt_tokens - cache, reasoning_tokens: reasoning };
}

/**
 * Resolve CLI context occupancy from a real provider usage record. A direct
 * percentage mapping is trusted when present; otherwise the percentage is
 * derived from the maximum observed request's input plus cached prefix and an
 * explicitly configured context window.
 */
export function normalizeCliContextUsage(raw, mapping) {
  if (!raw || typeof raw !== 'object' || !mapping || typeof mapping !== 'object') return null;
  const windowTokens = number(mapping.window ?? mapping.contextWindow);
  const directPercent = mapping.percent ? number(get(raw, mapping.percent)) : null;
  if (directPercent !== null) {
    return {
      percent: Math.round(directPercent * 10) / 10,
      usedTokens: mapping.used ? number(get(raw, mapping.used)) : null,
      windowTokens,
      source: 'provider',
    };
  }
  const input = number(get(raw, mapping.input));
  const cache = mapping.cache ? number(get(raw, mapping.cache)) : 0;
  if (input === null || cache === null || !(windowTokens > 0)) return null;
  if (mapping.inputIncludesCache === true && cache > input) return null;
  const usedTokens = input + (mapping.inputIncludesCache === true ? 0 : cache);
  return {
    percent: Math.round((usedTokens / windowTokens) * 1000) / 10,
    usedTokens,
    windowTokens,
    source: 'derived',
  };
}

function pruneCliSessions(sessionDir, keep = 5) {
  let names = [];
  try {
    names = fs.readdirSync(sessionDir).filter((name) => name.endsWith('.json'));
  } catch (_) {
    return [];
  }
  const ranked = names.map((name) => {
    const filePath = path.join(sessionDir, name);
    let mtime = 0;
    try { mtime = fs.statSync(filePath).mtimeMs; } catch (_) {}
    return { name, filePath, mtime };
  }).sort((a, b) => b.mtime - a.mtime);
  const evicted = [];
  for (const stale of ranked.slice(Math.max(1, keep))) {
    try { fs.rmSync(stale.filePath, { force: true }); evicted.push(stale.name); } catch (_) {}
  }
  return evicted;
}

function hasEvidenceResultId(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return false;
  if (Array.isArray(value)) return value.slice(0, 64).some((item) => hasEvidenceResultId(item, depth + 1));
  if (typeof value.resultId === 'string' && /^result-[a-zA-Z0-9-]+$/.test(value.resultId)) return true;
  return ['refs', 'references', 'evidence'].some((key) => hasEvidenceResultId(value[key], depth + 1));
}

function taskContext(options, input, workspace) {
  const manifest = options.context || {};
  const task = String(options.prompt ?? options.task ?? '').trim();
  const history = options.cliSessionId ? [] : (Array.isArray(options.history) ? options.history : []);
  const objective = task || manifest.objective || history.at(-1)?.content;
  if (!objective) throw new Error('CLI Micro needs a task or an explicit context objective.');
  const contract = {
    objective, workspace, execution: options.execution || 'analyze',
    allowedPaths: manifest.allowedPaths || [], acceptance: manifest.acceptance || [],
    constraints: manifest.constraints || [], state: manifest.state || null, baseRevision: manifest.baseRevision || null,
    evidence: manifest.evidence || [],
    ...(manifest.instructions ? { instructions: manifest.instructions } : {}),
  };
  const hasResolvedBody = Boolean(String(input || '').trim() || String(options.preloadText || '').trim());
  const hasResultId = hasEvidenceResultId(manifest.evidence);
  const evidenceProvenance = hasResolvedBody
    ? 'Resolved input/preload text is included in this child task. Only text actually present in that body counts as supplied source; evidence references and result IDs in the manifest are metadata and do not imply that their source text was injected.'
    : 'No source body was resolved from manifest evidence. Paths, hashes, notes and result IDs in the manifest are metadata only; do not treat them as source already read.';
  const resultRecovery = hasResultId
    ? 'If a listed resultId contains source needed for this task, recover only the needed current text with contextos({action:"ask",args:{resultId:"result-...",inspect:[{path:"known-file",ranges:[[first,last]]}]},projectRoot:workspace}); contextos({action:"ask",args:{resultId:"result-..."},projectRoot:workspace}) recovers the full saved result. Do not skip retrieval or claim known source solely because a parent or another thread received that result.'
    : '';
  const knownEvidenceRule = 'For a semantic ask, use known only for source text available in this child task context; a path, note, resultId, or parent-thread claim alone is not previously read source.';
  return [
    'Role: ContextOS child worker. Complete the injected assignment, using its known tool recipes directly. Respect repository instructions and required CLI tool loading; do not load general capability/setup references unless a concrete missing contract requires them. Report actual changes, test outcomes and blockers; never a plan or running test as complete. Do not delegate again.',
    options.osInvocation ? `Verified ContextOS call mapping: ${options.osInvocation}` : '',
    `Task manifest: ${JSON.stringify(contract)}`,
    evidenceProvenance,
    resultRecovery,
    knownEvidenceRule,
    options.execution === 'implement' ? 'Edit only allowedPaths in this isolated workspace. The host will independently review the diff and acceptance checks.' : 'Analysis task: do not edit project files.',
    'ContextOS is this worker\'s primary development surface; native tools are the fallback for a quick single command or read that needs no OS evidence, architecture or delegation. Code modifications must go through contextos({action:"change",...}) so the canvas stays current. Run required checks with contextos({action:"command",args:{command,id}}), read exact source with ask, and recover prior output with the same command id. If a native tool is denied, continue through ContextOS when the task allows it; report a blocker only when the required path itself fails. Do not scan generated bundles, node_modules, .git, build output, or unrelated files. Fetch only the missing dependency needed for this assignment. Await a started test instead of running it again.',
    options.evidenceBroker
      ? 'Use contextos({action:"ask",args:{inspect:[{path:"known-file",ranges:[[first,last]]}]},projectRoot:workspace}) for exact source. For missing semantic evidence use ask args={request:"specific question",purpose:"why it is needed"}; API Micro is a lean OS-capable assistant. Use command args={command:"check",id:"unique-check-id"}; get the same command id to recover output without rerunning. args is always an object. Request only evidence not present in the resolved input/preload body. Native reads are allowed when already available.'
      : 'Call contract: contextos({action:"work",args:{inspect:[{path:"known-file",ranges:[[first,last]]}]},projectRoot:workspace}). args is always an object; action is never put in args as a string. If only a read pipeline is assigned, execute it once and continue from that evidence; request just the named missing or changed dependency.',
    microDeliveryPrompt(options.delivery),
    options.agentJobId ? `You are child job ${options.agentJobId}. OS responses include new host messages. For a question or blocker, use ${options.evidenceBroker ? 'agent' : 'micro'} args={action:"report",jobId:"${options.agentJobId}",content:"concise structured JSON: summary,changes,checks,blockers,question"} and then wait for the reply with args={action:"messages",jobId:"${options.agentJobId}",waitMs:600000}. Do not poll in a tight loop. Reserve the mailbox for a question or blocker; do not send a routine completion report through it. Finish with the complete structured report in your final response; set needsHost=true only for a question, blocker, failure, cancellation, or explicit host decision, otherwise set needsHost=false; omit reasoning and execution history.` : '',
    options.reportJobId && !options.agentJobId ? `To report a material finding or blocker before finishing, call ContextOS with action=micro, args={action:'report',jobId:'${options.reportJobId}',content:'concise finding'}, projectRoot=the assigned workspace. Routine progress needs no report.` : '',
    options.system || '', input || '',
    options.preloadText || '',
    history.length ? `Bounded prior task messages: ${JSON.stringify(history)}` : '',
  ].filter(Boolean).join('\n\n');
}

export async function runCliMicro(config = {}, options = {}) {
  const started = Date.now(), cli = config.cli || {};
  const model = options.model || config.model;
  const base = { provider: 'cli', model, delivery: options.delivery || 'immediate', withOS: Boolean(options.withOS),
    sessionId: options.sessionId || null, sessionMode: options.sessionMode || 'isolated', providerUsage: null,
    estimatedUsage: null, usageSource: 'unavailable', providerRequests: null, executionMode: options.execution === 'implement' ? 'cli-implementation' : 'cli-analysis' };
  const fail = (errorCode, error, extra = {}) => ({ ...base, ok: false, errorCode, error, durationMs: Date.now() - started, ...extra });
  if (process.env.CONTEXTOS_DISABLE_MICRO === '1') return fail('MICRO_DISABLED', 'Micro execution is disabled.');
  if (process.env.CONTEXTOS_WORKER_MODE === '1') return fail('NESTED_MICRO_DISABLED', 'A Micro worker cannot dispatch another Micro.');
  const errors = validateCliAdapter(cli);
  if (!model || errors.length) return fail('CLI_CONFIG_INVALID', errors.join('; ') || 'micro.model is required');
  const executable = resolveCliExecutable(cli.command);
  if (!executable) return fail('CLI_NOT_INSTALLED', `Selected CLI '${cli.command}' is not installed; use setup to install and configure it.`);
  const projectRoot = path.resolve(options.projectRoot || config.projectRoot || process.cwd());
  let workspace, task;
  try {
    workspace = fs.realpathSync(options.workspace || projectRoot);
    if (options.inputTruncated) return fail('CLI_INPUT_TRUNCATED', 'Evidence is truncated; supply a narrower slice or references before dispatch.');
  } catch (error) { return fail('CLI_CONTEXT_INVALID', error.message); }
  if (options.cliSessionId && !cli.resumeArgs) return fail('CLI_RESUME_UNSUPPORTED', 'The adapter has no verified resume mapping.');
  const sessionDir = path.join(projectRoot, '.contextos', 'micro-cli', 'sessions');
  const sessionFile = id => path.join(sessionDir, crypto.createHash('sha256').update(String(id)).digest('hex') + '.json');
  let priorSession = null;
  if (options.cliSessionId) {
    if (!['invocation', 'session'].includes(cli.output.usage?.aggregation)) return fail('CLI_RESUME_USAGE_UNVERIFIED', 'Verify resumed usage aggregation before enabling resume.');
    try { priorSession = JSON.parse(fs.readFileSync(sessionFile(options.cliSessionId), 'utf8')); }
    catch { return fail('CLI_RESUME_STATE_MISSING', 'The requested CLI session has no local task/usage binding.'); }
    if (priorSession.workspace !== workspace || priorSession.model !== model || priorSession.command !== executable) return fail('CLI_RESUME_SCOPE_MISMATCH', 'Resume must keep the same workspace, model and CLI.');
    const priorContext = priorSession.context && typeof priorSession.context === 'object' ? priorSession.context : null;
    const priorTools = priorSession.invocation?.tools && typeof priorSession.invocation.tools === 'object' ? priorSession.invocation.tools : null;
    options = {
      ...options,
      ...(options.execution === undefined && priorSession.execution ? { execution: priorSession.execution } : {}),
      ...(options.withOS === undefined && priorSession.withOS !== undefined ? { withOS: priorSession.withOS } : {}),
      ...(priorContext ? { context: { ...priorContext, ...(options.context || {}) } } : {}),
      ...(priorTools ? { invocation: { ...(priorSession.invocation || {}), ...(options.invocation || {}), tools: { ...priorTools, ...(options.invocation?.tools || {}) } } } : {}),
    };
    base.executionMode = options.execution === 'implement' ? 'cli-implementation' : 'cli-analysis';
  }
  try {
    if (options.execution === 'implement' && (workspace === fs.realpathSync(projectRoot) || !options.context?.allowedPaths?.length || !options.context?.acceptance?.length)) {
      return fail('CLI_IMPLEMENTATION_SCOPE_REQUIRED', 'Implementation needs a separate workspace, allowedPaths and acceptance criteria.');
    }
    task = taskContext({ ...options, osInvocation: cli.osInvocation }, options.resolvedInput, workspace);
    if (task.length > limit(options.maxInputChars ?? config.maxInputChars, 16000)) return fail('CLI_CONTEXT_TOO_LARGE', 'Task context exceeds its configured limit; narrow evidence, do not silently truncate the assignment.');
  } catch (error) { return fail('CLI_CONTEXT_INVALID', error.message); }
  const implementationBefore = options.execution === 'implement'
    ? fingerprintCliImplementationPaths(workspace, options.context?.allowedPaths || [])
    : null;
  const vars = { task, model, thinking: options.thinking || config.thinking || 'high',
    mode: options.execution === 'implement' ? (cli.modes?.implement || '') : (cli.modes?.analyze || ''), workspace, sessionId: options.cliSessionId || '' };
  const argv = template([...cli.args, ...(options.cliSessionId ? cli.resumeArgs : [])], vars);
  const body = cli.input.format === 'text' ? template(cli.input.template ?? '{task}', vars) : JSON.stringify(template(cli.input.template, vars)) + '\n';
  if (!body || body === 'undefined\n') return fail('CLI_CONFIG_INVALID', 'Input mapping produced no task message.');
  const jobId = `cli-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const dir = path.join(projectRoot, '.contextos', 'micro-cli', jobId);
  const rawFile = path.join(dir, 'stream.log');
  const apiProfileFile = options.evidenceBroker ? path.join(dir, 'api-role.json') : null;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(rawFile, '', { mode: 0o600 });
    if (apiProfileFile) fs.writeFileSync(apiProfileFile, JSON.stringify({ micro: options.apiMicro ?? null }), { mode: 0o600 });
  } catch (error) { return fail('CLI_LOG_UNAVAILABLE', error.message); }
  let child, killTimer;
  const maxBytes = limit(cli.maxOutputBytes, 4_000_000), timeout = limit(options.timeoutMs ?? config.timeoutMs, 86_400_000);
  let rawBytes = 0, stdout = '', stderr = '', buffer = '', terminal = null, actualModel = null, parseError = null, stopReason = null, contextUsagePeak = null;
  const records = [];
  const stepUsagePath = cli.output.usage?.stepPath || cli.output.contextUsage?.path || null;
  let stepUsage = null;
  const readRecord = record => {
    if (cli.output.modelPath) actualModel = get(record, cli.output.modelPath) || actualModel;
    if (stepUsagePath) {
      const candidate = get(record, stepUsagePath);
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        const stepNumber = (key) => (key ? number(get(candidate, key)) : null);
        const input = stepNumber(cli.output.usage?.input), cache = stepNumber(cli.output.usage?.cache);
        const output = stepNumber(cli.output.usage?.output), reasoning = stepNumber(cli.output.usage?.reasoning);
        if ([input, cache, output, reasoning].some(value => value !== null)) {
          stepUsage = stepUsage || { input: 0, cache: 0, output: 0, reasoning: 0, steps: 0 };
          stepUsage.input += input || 0; stepUsage.cache += cache || 0;
          stepUsage.output += output || 0; stepUsage.reasoning += reasoning || 0;
          stepUsage.steps += 1;
        }
      }
    }
    if (cli.output.contextUsage?.path) {
      const candidate = get(record, cli.output.contextUsage.path);
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        const normalized = normalizeCliContextUsage(candidate, cli.output.contextUsage);
        if (normalized) {
          const percent = normalized.percent;
          const peakPercent = contextUsagePeak?.percent;
          const usedTokens = normalized.usedTokens;
          const peakUsed = contextUsagePeak?.usedTokens;
          const higher = usedTokens !== null && usedTokens !== undefined
            && peakUsed !== null && peakUsed !== undefined
            ? usedTokens > peakUsed
            : percent !== null && percent !== undefined
              && (peakPercent === null || peakPercent === undefined || percent > peakPercent);
          if (!contextUsagePeak || higher) contextUsagePeak = normalized;
        }
      }
    }
    if (cli.output.format === 'json' || get(record, cli.output.terminal?.path) === cli.output.terminal?.value) {
      terminal = cli.output.resultPath ? get(record, cli.output.resultPath) : record;
      records.push(terminal);
    }
  };
  const stop = reason => {
    if (stopReason) return;
    stopReason = reason;
    try { process.platform !== 'win32' ? process.kill(-child.pid, 'SIGTERM') : child.kill(); } catch {}
    killTimer = setTimeout(() => { try { process.platform !== 'win32' ? process.kill(-child.pid, 'SIGKILL') : child.kill('SIGKILL'); } catch {} }, 1000);
    killTimer.unref();
  };
  try {
    const exited = await new Promise(resolve => {
      child = spawn(executable, argv, { cwd: workspace, shell: false, detached: process.platform !== 'win32',
        // Worker mode blocks nested CLI/Micro dispatch; API Micro `ask` stays
        // available so the CLI can retrieve evidence through OS.
        env: { ...process.env, ...(cli.env || {}), CONTEXTOS_WORKER_MODE: '1',
          ...(apiProfileFile ? { CONTEXTOS_API_MICRO_PROFILE: apiProfileFile } : {}),
          CONTEXTOS_WORKER_ROOT: workspace, CONTEXTOS_PROJECT_ROOT: workspace,
          CONTEXTOS_MICRO_REPORT_ROOT: projectRoot, CONTEXTOS_MICRO_REPORT_JOB: options.agentJobId || options.reportJobId || '' }, stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => stop('timeout'), timeout);
      const abort = () => stop('cancelled');
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      child.stdin.on('error', () => {});
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.on('error', error => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); resolve({ error }); });
      child.on('close', (code, signal) => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); resolve({ code, signal }); });
      child.stdout.on('data', chunk => {
        rawBytes += Buffer.byteLength(chunk);
        if (rawBytes > maxBytes) { stop('output-limit'); return; }
        try { fs.appendFileSync(rawFile, chunk); } catch { stop('log-unavailable'); }
        stdout += chunk;
        if (cli.output.format !== 'jsonl') return;
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
          if (!line) continue;
          try {
            readRecord(JSON.parse(line));
            if (terminal && cli.input.keepOpen === true) child.stdin.end();
          } catch (error) { parseError = error.message; stop('protocol-error'); }
        }
      });
      child.stderr.on('data', chunk => {
        rawBytes += Buffer.byteLength(chunk);
        if (rawBytes > maxBytes) { stop('output-limit'); return; }
        stderr = (stderr + chunk).slice(-2000);
      });
      child.stdin.write(body);
      if (cli.input.keepOpen !== true) child.stdin.end();
    });
    if (cli.output.format === 'jsonl' && buffer.trim() && !parseError) {
      try { readRecord(JSON.parse(buffer)); } catch (error) { parseError = error.message; }
    }
    if (cli.output.format === 'json') { try { readRecord(JSON.parse(stdout)); } catch (error) { parseError = error.message; } }
    const terminalUsageRaw = cli.output.usage ? get(terminal, cli.output.usage.path) : null;
    // A host may abort a long CLI call before its terminal record arrives; the
    // step stream still carries real provider usage, so account it instead of
    // reporting a metering gap.
    const partialUsageRaw = !terminalUsageRaw && stepUsage?.steps
      ? {
          ...(cli.output.usage.input ? { [cli.output.usage.input]: stepUsage.input } : {}),
          ...(cli.output.usage.cache ? { [cli.output.usage.cache]: stepUsage.cache } : {}),
          ...(cli.output.usage.output ? { [cli.output.usage.output]: stepUsage.output } : {}),
          ...(cli.output.usage.reasoning ? { [cli.output.usage.reasoning]: stepUsage.reasoning } : {}),
        }
      : null;
    const rawUsage = terminalUsageRaw || partialUsageRaw;
    const cumulative = normalizeCliUsage(rawUsage, cli.output.usage);
    const contextUsage = contextUsagePeak;
    let usage = cumulative;
    const cliSessionId = get(terminal, cli.output.sessionPath) || null;
    if (priorSession && cli.output.usage.aggregation === 'session') {
      usage = cumulative && priorSession.usage ? Object.fromEntries(Object.entries(cumulative).map(([key, value]) => [key, value - priorSession.usage[key]])) : null;
      if (usage && Object.values(usage).some(value => !Number.isFinite(value) || value < 0)) usage = null;
    }
    const extra = { jobId, logPath: path.relative(projectRoot, rawFile), actualModel, usageRaw: rawUsage, partialUsage: Boolean(partialUsageRaw),
      usage, providerUsage: usage, usageSource: usage ? 'provider' : 'unavailable', providerUsageCalls: usage ? 1 : 0,
      contextUsage,
      cliSessionId, cumulativeProviderUsage: cumulative, exitCode: exited.code ?? null,
      invocation: { providerLaunches: 1, providerRequests: null, toolRounds: null, shortCircuited: false },
      cost: { estimatedUsd: null, pricingConfigured: false, note: 'CLI billing/quota is controlled by its provider; no free-cost assumption.' } };
    if (exited.error) return fail('CLI_SPAWN_FAILED', exited.error.message, extra);
    if (priorSession && cliSessionId !== options.cliSessionId) return fail('CLI_RESUME_SESSION_MISMATCH', 'The CLI returned a different resumed conversation.', extra);
    if (priorSession && cumulative && !usage) return fail('CLI_RESUME_USAGE_INVALID', 'Cumulative usage decreased or its baseline was unavailable.', extra);
    if (stopReason || parseError) {
      extra.providerUsageComplete = false;
      return fail(stopReason === 'timeout' ? 'CLI_TIMEOUT' : stopReason === 'cancelled' ? 'CLI_CANCELLED' : stopReason === 'output-limit' ? 'CLI_OUTPUT_LIMIT' : stopReason === 'log-unavailable' ? 'CLI_LOG_UNAVAILABLE' : 'CLI_PROTOCOL_ERROR', parseError || stopReason, extra);
    }
    if (exited.code !== 0) return fail('CLI_EXIT_FAILED', `CLI exited with code ${exited.code}. ${stderr.slice(-600)}`, extra);
    if (cli.output.format !== 'text' && (!terminal || records.length !== 1)) return fail('CLI_TERMINAL_MISSING', 'Expected one terminal task result; no automatic retry was made.', extra);
    if (cli.output.modelPath && !actualModel) return fail('CLI_MODEL_UNVERIFIED', 'The configured model mapping produced no actual model.', extra);
    if (actualModel && actualModel !== model) return fail('CLI_MODEL_MISMATCH', `Requested ${model}, received ${actualModel}.`, extra);
    if (cliSessionId) {
      // Bind only an identity-checked terminal result. Failed tasks still advance
      // a valid usage baseline so a later resume cannot charge them twice.
      const file = sessionFile(cliSessionId), temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(temporary, JSON.stringify({ workspace, model, command: executable, usage: cumulative, jobId,
          execution: options.execution || 'analyze',
          context: options.context || null,
          withOS: Boolean(options.withOS),
          invocation: options.invocation || null }), { mode: 0o600 });
        fs.renameSync(temporary, file);
        // Keep at most five completed CLI conversations resumable; the host can
        // continue the newest ones, and older ones are dropped automatically.
        pruneCliSessions(sessionDir, 5);
      } catch (error) {
        try { fs.unlinkSync(temporary); } catch {}
        return fail('CLI_SESSION_UNAVAILABLE', error.message, extra);
      }
    }
    const denied = get(terminal, cli.output.deniedPath);
    const deniedActions = Array.isArray(denied) ? denied : denied === true ? [denied] : [];
    const deniedDetail = (item) => {
      const text = typeof item === 'string' ? item : JSON.stringify(item);
      return text.length > 240 ? `${text.slice(0, 240)}...` : text;
    };
    const osPermissionDenied = denied === true || deniedActions.some((item) => /contextos|mcp\(contextos/i.test(deniedDetail(item)));
    const status = get(terminal, cli.output.statusPath);
    if (cli.output.statusPath && !(cli.output.successValues || ['SUCCESS']).includes(status)) return fail('CLI_TASK_FAILED', `CLI terminal status: ${status}`, extra);
    if (config.maxProviderTokens && usage?.total_tokens > config.maxProviderTokens) return fail('CLI_BUDGET_EXCEEDED', 'Reported total token budget exceeded; this CLI reports terminal usage, so the check is after execution.', extra);
    const structured = get(terminal, cli.output.structuredPath) ?? null;
    if (get(terminal, cli.output.blockedPath) === true) return fail('CLI_TASK_BLOCKED', 'The worker reported an incomplete assignment.', { ...extra, structured });
    if (osPermissionDenied) {
      const detail = deniedActions.slice(0, 3).map(deniedDetail).join(', ');
      return fail(
        'CLI_PERMISSION_DENIED',
        `The CLI denied a required ContextOS action${detail ? `: ${detail}` : ''}; the worker cannot complete through its OS path.`,
        { ...extra, deniedActions },
      );
    }
    const content = cli.output.format === 'text' ? stdout.trim() : (structured ? JSON.stringify(structured) : String(get(terminal, cli.output.contentPath) || '').trim());
    if (!content) return fail('CLI_EMPTY_RESULT', 'The CLI returned no usable final result.', extra);
    if (options.execution === 'implement') {
      const implementationAfter = fingerprintCliImplementationPaths(workspace, options.context?.allowedPaths || []);
      const implementationEvidence = cliImplementationDiff(implementationBefore || new Map(), implementationAfter);
      if (!implementationEvidence.applied) {
        return fail('MICRO_IMPLEMENTATION_NOT_APPLIED', 'Implementation finished without an applied workspace diff.', {
          ...extra,
          implementationEvidence: { ...implementationEvidence, source: 'diff' },
        });
      }
      extra.implementationEvidence = { ...implementationEvidence, source: 'diff' };
    }
    // Parse an explicit routing decision regardless of delivery mode: an
    // immediate task still needs the worker's real needsHost answer, while a
    // broker envelope only rewrites content for deferred deliveries.
    const routing = parseMicroRouting(content, structured);
    const routingContent = options.delivery === 'auto'
      ? routing
      : (routing ? { ...routing, content } : null);
    return { ...base, ...extra, ok: true, statusCode: 200, content, structured, ...routingContent, durationMs: Date.now() - started,
      ...(deniedActions.length ? { deniedActions, permissionWarning: `Native tool denial observed; the task continued through ContextOS: ${deniedActions.slice(0, 3).map(deniedDetail).join(', ')}` } : {}),
      inputSource: options.inputSource || 'task', inputTruncated: false, summarizerOnly: false, independentVerificationRequired: options.execution === 'implement' };
  } finally {
    if (stopReason && child?.pid) { try { process.platform !== 'win32' ? process.kill(-child.pid, 'SIGKILL') : child.kill('SIGKILL'); } catch {} }
    if (killTimer) clearTimeout(killTimer);
    if (apiProfileFile) fs.rmSync(apiProfileFile, { force: true });
  }
}
