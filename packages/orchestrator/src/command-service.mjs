import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runCommand } from '../../process-host/src/runner.mjs';

// The MCP host injects its own transport flags into this server's process
// environment. They describe how this server renders results, not how a child
// command should behave: a leaked CONTEXTOS_TEXT_ONLY_RESULTS silently strips
// structured output from nested ContextOS calls and breaks test suites that
// assert on it.
export function commandChildEnv(parentEnv = process.env) {
  const env = { ...parentEnv };
  delete env.CONTEXTOS_TEXT_ONLY_RESULTS;
  return env;
}

const running = new Map();
const safeId = (id) => typeof id === 'string' && /^[a-zA-Z0-9._-]{1,120}$/.test(id) && id !== '.' && id !== '..';
const key = (root, id) => `${root}\0${id}`;
const file = (root, id) => path.join(root, '.contextos', 'commands', `${id}.json`);

function save(root, result) {
  const target = file(root, result.id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  const serialized = JSON.stringify(result);
  fs.writeFileSync(temp, serialized, { mode: 0o600 });
  fs.renameSync(temp, target);
  return JSON.parse(serialized);
}

export function getCommandResult(projectRoot, id, options = {}) {
  const root = fs.realpathSync(projectRoot);
  if (!safeId(id)) throw new Error('Invalid command result id.');
  const target = file(root, id);
  if (!fs.existsSync(target)) return { id, status: 'missing', error: 'No command with this id; nothing was executed.' };
  const result = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (result.status === 'running') {
    try { process.kill(result.ownerPid, 0); }
    catch { return save(root, { ...result, status: 'interrupted', missing: ['Execution owner exited before a final receipt was saved. Do not assume the command did not run.'] }); }
  }
  if ((options.full === true || options.ranges) && result.receipt) {
    if (!result.receipt.logHandle) return { ...result, missing: [...(result.missing || []), 'No durable execution log is available for recovery.'] };
    const target = fs.realpathSync(path.resolve(root, result.receipt.logHandle));
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Execution log is outside its workspace.');
    const text = fs.readFileSync(target, 'utf8');
    if (result.receipt.logHash && crypto.createHash('sha256').update(text).digest('hex') !== result.receipt.logHash) {
      return { ...result, log: [], missing: [...(result.missing || []), 'Stored execution log changed after its receipt was saved; original evidence is unavailable.'] };
    }
    const lines = text.split(/(?<=\n)/);
    const ranges = options.full === true ? [[1, lines.length]] : options.ranges;
    if (!Array.isArray(ranges) || ranges.some(range => !Array.isArray(range) || range.length !== 2 || !Number.isSafeInteger(range[0]) || !Number.isSafeInteger(range[1]) || range[0] < 1 || range[1] < range[0])) throw new Error('Log ranges require inclusive 1-based integer pairs.');
    const selected = new Set(); const missing = [...(result.missing || [])];
    for (const [start, end] of ranges) {
      for (let index = start; index <= Math.min(end, lines.length); index++) selected.add(index);
      if (end > lines.length) missing.push(`Execution log ends at line ${lines.length}; requested lines ${Math.max(start, lines.length + 1)}-${end} are unavailable.`);
    }
    return { ...result, log: [...selected].sort((a,b) => a-b).map(line => ({ line, text: lines[line-1] })), missing,
      coverage: { complete: selected.size === lines.length && !result.receipt.logTruncated, selectedLines: selected.size, totalLines: lines.length } };
  }
  return result;
}

export function cancelCommand(projectRoot, id) {
  const root = fs.realpathSync(projectRoot);
  const active = running.get(key(root, id));
  if (!active) return { ...getCommandResult(root, id), cancellationRequested: false };
  active.controller.abort(new Error('Command cancelled by caller.'));
  return { ...getCommandResult(root, id), cancellationRequested: true };
}

function logCandidates(text, maxChars = 6000) {
  const lines = text.split(/(?<=\n)/);
  const chosen = new Set();
  for (let i = 0; i < lines.length; i++) {
    // Test descriptions are data, including passing tests about failures.
    if (/^\s*(?:# Subtest:|ok \d+\b)/.test(lines[i])) continue;
    if (/^\s*not ok \d+\b/.test(lines[i])) {
      for (let n = i; n < Math.min(lines.length, i + 80); n++) {
        chosen.add(n);
        if (n > i && /^\s*\.\.\.\s*$/.test(lines[n])) break;
      }
    } else if (/\b(error|failed|failure|exception|traceback)\b/i.test(lines[i])) {
      for (let n = Math.max(0, i - 2); n <= Math.min(lines.length - 1, i + 3); n++) chosen.add(n);
    }
  }
  const tail = Array.from({ length: Math.min(25, lines.length) }, (_, index) => Math.max(0, lines.length - 25) + index);
  const candidates = [];
  let used = 0;
  for (const n of [...new Set([...tail, ...chosen])]) {
    const chars = Array.from(lines[n]).length;
    if (used + chars > maxChars) continue;
    candidates.push({ line: n + 1, text: lines[n] });
    used += chars;
  }
  candidates.sort((a, b) => a.line - b.line);
  return { lines, candidates, complete: candidates.length === lines.length };
}

export async function summarizeCommandReceipt(receipt, { projectRoot, transport, focus, signal, maxChars = 6000 } = {}) {
  let text = receipt.text || '';
  if (receipt.logHandle) {
    const root = fs.realpathSync(projectRoot);
    const target = fs.realpathSync(path.resolve(root, receipt.logHandle));
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('Command log is outside its workspace.');
    text = fs.readFileSync(target, 'utf8');
  }
  const logHash = crypto.createHash('sha256').update(text).digest('hex');
  const view = logCandidates(text, maxChars);
  let selected = view.candidates;
  let explanation = null;
  let micro = null;
  const missing = receipt.logTruncated ? ['Stored execution log was truncated.'] : [];
  if (transport && (focus || (receipt.exitCode !== 0 && Array.from(text).length > maxChars))) {
    try {
      micro = await transport({
        system: 'Select useful log lines for the given goal. Return JSON {summary,selection:[{id:"log",ranges:[[start,end]]}],missing:[]}. Use only supplied line numbers. Do not change execution status, propose commands, or copy logs into summary.',
        input: JSON.stringify({ goal: focus || 'Explain the command result and identify any actionable failure.', receipt: { id: receipt.id, exitCode: receipt.exitCode }, id: 'log', candidates: view.candidates }),
        tools: [], signal,
      });
      const refs = Array.isArray(micro.selection) ? micro.selection : micro.selection?.references;
      const numbers = new Set();
      const allowed = new Set(view.candidates.map((item) => item.line));
      let invalid = false;
      for (const ref of refs || []) {
        if (ref.id !== 'log' || !Array.isArray(ref.ranges)) { invalid = true; continue; }
        for (const range of ref.ranges) {
          if (!Array.isArray(range) || !Number.isSafeInteger(range[0]) || !Number.isSafeInteger(range[1]) || range[0] < 1 || range[1] < range[0] || range[1] > view.lines.length) { invalid = true; continue; }
          for (let n = range[0]; n <= range[1]; n++) {
            if (!allowed.has(n)) invalid = true;
            else numbers.add(n);
          }
        }
      }
      if (!invalid && numbers.size) selected = view.candidates.filter((item) => numbers.has(item.line));
      else missing.push('Micro did not provide valid log references; deterministic candidates were retained.');
      explanation = typeof micro.summary === 'string' ? micro.summary : null;
      missing.push(...(Array.isArray(micro.missing) ? micro.missing.filter((item) => typeof item === 'string') : []));
    } catch (error) {
      missing.push(`Micro log analysis unavailable: ${error.message}; deterministic log candidates were retained.`);
      micro = { status: 'failed', errorCode: error.code ?? null, usage: error.usage ?? null };
    }
  }
  return {
    status: receipt.exitCode === 0 ? 'completed' : receipt.exitCode === 130 ? 'cancelled' : 'failed',
    receipt: { id: receipt.id, command: receipt.command, cwd: receipt.cwd, exitCode: receipt.exitCode, durationMs: receipt.durationMs, logHandle: receipt.logHandle, logTruncated: receipt.logTruncated, logHash },
    summary: receipt.exitCode === 0 ? 'Command completed successfully.' : receipt.exitCode === 130 ? 'Command cancelled.' : `Command exited with code ${receipt.exitCode}.`,
    analysis: explanation,
    log: selected,
    coverage: { complete: view.complete && selected.length === view.lines.length && !receipt.logTruncated, selectedLines: selected.length, totalLines: view.lines.length },
    missing, micro,
  };
}

export async function executeCommand(args, { projectRoot, transport, runner = runCommand, signal } = {}) {
  const root = fs.realpathSync(projectRoot);
  if (args.action === 'get') return getCommandResult(root, args.id, args);
  if (args.action === 'cancel') return cancelCommand(root, args.id);
  if (typeof args.command !== 'string' || !args.command.trim()) throw new Error('A command is required.');
  const cwd = fs.realpathSync(path.resolve(root, args.cwd || '.'));
  if (cwd !== root && !cwd.startsWith(`${root}${path.sep}`)) throw new Error('Command cwd is outside its workspace.');
  const id = args.id || `command-${crypto.randomUUID()}`;
  if (!safeId(id)) throw new Error('Invalid command result id.');
  const requestHash = crypto.createHash('sha256').update(JSON.stringify([args.command, cwd])).digest('hex');
  // Claim the id before execution: reuse never launches the same command again.
  const target = file(root, id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(target, JSON.stringify({ id, requestHash, status: 'running', ownerPid: process.pid, createdAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      const prior = getCommandResult(root, id);
      if (prior.requestHash && prior.requestHash !== requestHash) throw new Error('Command id is already bound to a different command or cwd; no new execution occurred. Retrieve the original result or choose a new id.');
      return prior;
    }
    throw error;
  }
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const promise = (async () => {
    try {
      const receipt = await runner({ command: args.command, cwd, projectRoot: root, env: commandChildEnv(), maxChars: args.previewChars ?? 1200, maxLogBytes: args.maxLogBytes, timeoutMs: args.timeoutMs ?? 120000, signal: controller.signal });
      // Persist the execution receipt before optional model work starts.
      save(root, { id, requestHash, status: 'executed', receipt, ownerPid: process.pid });
      let result;
      try { result = await summarizeCommandReceipt(receipt, { projectRoot: root, transport, focus: args.focus, signal: controller.signal, maxChars: args.logChars ?? 6000 }); }
      catch (error) { result = { status: receipt.exitCode === 0 ? 'completed' : 'failed', receipt, missing: [`Log delivery failed: ${error.message}`] }; }
      return save(root, { id, requestHash, ...result });
    } catch (error) {
      return save(root, { id, requestHash, status: controller.signal.aborted ? 'cancelled' : 'failed', receipt: null, missing: [error.message] });
    } finally {
      signal?.removeEventListener('abort', abort);
      running.delete(key(root, id));
    }
  })();
  running.set(key(root, id), { controller, promise });
  if (args.background === true) return { id, status: 'running' };
  return promise;
}
