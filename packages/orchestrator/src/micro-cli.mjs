import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const active = new Set();
const get = (value, dotted) => typeof dotted === 'string' ? dotted.split('.').filter(Boolean).reduce((v, k) => v?.[k], value) : undefined;
const number = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const limit = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;

export function resolveCliExecutable(command) {
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
  if (cli.resumeArgs && (!Array.isArray(cli.resumeArgs) || !cli.resumeArgs.some(v => typeof v === 'string' && v.includes('{sessionId}')))) errors.push('resumeArgs must map {sessionId}');
  return errors;
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
  };
  return [
    'Complete this bounded assignment. Report actual changes, actual test commands/results, and remaining blockers. Never claim completion from a plan or a running test. Stop on denied required actions. Do not delegate again.',
    `Task manifest: ${JSON.stringify(contract)}`,
    options.execution === 'implement' ? 'Edit only allowedPaths in this isolated workspace. The host will independently review the diff and acceptance checks.' : 'Analysis task: do not edit project files.',
    'ContextOS is optional for bounded reads, batch commands and existing receipt recovery. Native tools are allowed. Do not scan generated bundles, node_modules, .git, build output, or unrelated files. Fetch only the missing dependency needed for this assignment. Await a started test instead of running it again.',
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
    if (options.execution === 'implement' && (workspace === fs.realpathSync(projectRoot) || !options.context?.allowedPaths?.length || !options.context?.acceptance?.length)) {
      return fail('CLI_IMPLEMENTATION_SCOPE_REQUIRED', 'Implementation needs a separate workspace, allowedPaths and acceptance criteria.');
    }
    if (options.inputTruncated) return fail('CLI_INPUT_TRUNCATED', 'Evidence is truncated; supply a narrower slice or references before dispatch.');
    task = taskContext(options, options.resolvedInput, workspace);
    if (task.length > limit(options.maxInputChars ?? config.maxInputChars, 16000)) return fail('CLI_CONTEXT_TOO_LARGE', 'Task context exceeds its configured limit; narrow evidence, do not silently truncate the assignment.');
  } catch (error) { return fail('CLI_CONTEXT_INVALID', error.message); }
  if (active.has(workspace)) return fail('CLI_BUSY', 'A CLI task is already running in this workspace. Await its receipt before starting another.');
  if (options.cliSessionId && !cli.resumeArgs) return fail('CLI_RESUME_UNSUPPORTED', 'The adapter has no verified resume mapping.');
  const sessionDir = path.join(projectRoot, '.contextos', 'micro-cli', 'sessions');
  const sessionFile = id => path.join(sessionDir, crypto.createHash('sha256').update(String(id)).digest('hex') + '.json');
  let priorSession = null;
  if (options.cliSessionId) {
    if (!['invocation', 'session'].includes(cli.output.usage?.aggregation)) return fail('CLI_RESUME_USAGE_UNVERIFIED', 'Verify resumed usage aggregation before enabling resume.');
    try { priorSession = JSON.parse(fs.readFileSync(sessionFile(options.cliSessionId), 'utf8')); }
    catch { return fail('CLI_RESUME_STATE_MISSING', 'The requested CLI session has no local task/usage binding.'); }
    if (priorSession.workspace !== workspace || priorSession.model !== model || priorSession.command !== executable) return fail('CLI_RESUME_SCOPE_MISMATCH', 'Resume must keep the same workspace, model and CLI.');
  }
  const vars = { task, model, thinking: options.thinking || config.thinking || 'high',
    mode: options.execution === 'implement' ? (cli.modes?.implement || '') : (cli.modes?.analyze || ''), workspace, sessionId: options.cliSessionId || '' };
  const argv = template([...cli.args, ...(options.cliSessionId ? cli.resumeArgs : [])], vars);
  const body = cli.input.format === 'text' ? template(cli.input.template ?? '{task}', vars) : JSON.stringify(template(cli.input.template, vars)) + '\n';
  if (!body || body === 'undefined\n') return fail('CLI_CONFIG_INVALID', 'Input mapping produced no task message.');
  const jobId = `cli-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const dir = path.join(projectRoot, '.contextos', 'micro-cli', jobId);
  const rawFile = path.join(dir, 'stream.log');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(rawFile, '', { mode: 0o600 });
  } catch (error) { return fail('CLI_LOG_UNAVAILABLE', error.message); }
  active.add(workspace);
  let child, killTimer;
  const maxBytes = limit(cli.maxOutputBytes, 4_000_000), timeout = limit(options.timeoutMs ?? config.timeoutMs, 120000);
  let rawBytes = 0, stdout = '', stderr = '', buffer = '', terminal = null, actualModel = null, parseError = null, stopReason = null;
  const records = [];
  const readRecord = record => {
    if (cli.output.modelPath) actualModel = get(record, cli.output.modelPath) || actualModel;
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
        env: { ...process.env, ...(cli.env || {}), CONTEXTOS_DISABLE_MICRO: '1', CONTEXTOS_WORKER_MODE: '1',
          CONTEXTOS_WORKER_ROOT: workspace, CONTEXTOS_PROJECT_ROOT: workspace }, stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => stop('timeout'), timeout);
      const abort = () => stop('cancelled');
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      child.stdin.on('error', () => {});
      child.on('error', error => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); resolve({ error }); });
      child.on('close', (code, signal) => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); resolve({ code, signal }); });
      child.stdout.on('data', chunk => {
        rawBytes += chunk.length;
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
        rawBytes += chunk.length;
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
    const rawUsage = cli.output.usage ? get(terminal, cli.output.usage.path) : null;
    const cumulative = normalizeCliUsage(rawUsage, cli.output.usage);
    let usage = cumulative;
    const cliSessionId = get(terminal, cli.output.sessionPath) || null;
    if (priorSession && cli.output.usage.aggregation === 'session') {
      usage = cumulative && priorSession.usage ? Object.fromEntries(Object.entries(cumulative).map(([key, value]) => [key, value - priorSession.usage[key]])) : null;
      if (usage && Object.values(usage).some(value => !Number.isFinite(value) || value < 0)) usage = null;
    }
    const extra = { jobId, logPath: path.relative(projectRoot, rawFile), actualModel, usageRaw: rawUsage,
      usage, providerUsage: usage, usageSource: usage ? 'provider' : 'unavailable', providerUsageCalls: usage ? 1 : 0,
      cliSessionId, cumulativeProviderUsage: cumulative, exitCode: exited.code ?? null,
      invocation: { providerLaunches: 1, providerRequests: null, toolRounds: null, shortCircuited: false },
      cost: { estimatedUsd: null, pricingConfigured: false, note: 'CLI billing/quota is controlled by its provider; no free-cost assumption.' } };
    if (exited.error) return fail('CLI_SPAWN_FAILED', exited.error.message, extra);
    if (priorSession && cliSessionId !== options.cliSessionId) return fail('CLI_RESUME_SESSION_MISMATCH', 'The CLI returned a different resumed conversation.', extra);
    if (priorSession && cumulative && !usage) return fail('CLI_RESUME_USAGE_INVALID', 'Cumulative usage decreased or its baseline was unavailable.', extra);
    if (stopReason || parseError) return fail(stopReason === 'timeout' ? 'CLI_TIMEOUT' : stopReason === 'cancelled' ? 'CLI_CANCELLED' : stopReason === 'output-limit' ? 'CLI_OUTPUT_LIMIT' : stopReason === 'log-unavailable' ? 'CLI_LOG_UNAVAILABLE' : 'CLI_PROTOCOL_ERROR', parseError || stopReason, extra);
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
        fs.writeFileSync(temporary, JSON.stringify({ workspace, model, command: executable, usage: cumulative, jobId }), { mode: 0o600 });
        fs.renameSync(temporary, file);
      } catch (error) {
        try { fs.unlinkSync(temporary); } catch {}
        return fail('CLI_SESSION_UNAVAILABLE', error.message, extra);
      }
    }
    const denied = get(terminal, cli.output.deniedPath);
    if ((Array.isArray(denied) && denied.length) || denied === true) return fail('CLI_PERMISSION_DENIED', 'The CLI denied a required action; its success label does not establish completion.', extra);
    const status = get(terminal, cli.output.statusPath);
    if (cli.output.statusPath && !(cli.output.successValues || ['SUCCESS']).includes(status)) return fail('CLI_TASK_FAILED', `CLI terminal status: ${status}`, extra);
    if (config.maxProviderTokens && usage?.total_tokens > config.maxProviderTokens) return fail('CLI_BUDGET_EXCEEDED', 'Reported total token budget exceeded; this CLI reports terminal usage, so the check is after execution.', extra);
    const structured = get(terminal, cli.output.structuredPath) ?? null;
    if (get(terminal, cli.output.blockedPath) === true) return fail('CLI_TASK_BLOCKED', 'The worker reported an incomplete assignment.', { ...extra, structured });
    const content = cli.output.format === 'text' ? stdout.trim() : (structured ? JSON.stringify(structured) : String(get(terminal, cli.output.contentPath) || '').trim());
    if (!content) return fail('CLI_EMPTY_RESULT', 'The CLI returned no usable final result.', extra);
    return { ...base, ...extra, ok: true, statusCode: 200, content, structured, durationMs: Date.now() - started,
      inputSource: options.inputSource || 'task', inputTruncated: false, summarizerOnly: false, independentVerificationRequired: options.execution === 'implement' };
  } finally {
    active.delete(workspace);
    if (stopReason && child?.pid) { try { process.platform !== 'win32' ? process.kill(-child.pid, 'SIGKILL') : child.kill('SIGKILL'); } catch {} }
    if (killTimer) clearTimeout(killTimer);
  }
}
