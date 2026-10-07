#!/usr/bin/env node
// Bridge Codex CLI's JSONL stream into the single-JSON contract ContextOS
// expects from a CLI adapter. The prompt is read from stdin.
//
// `usage` is the turn aggregate that ContextOS divides by the worker divisor
// for cost accounting. `context_usage` is the peak per-request prompt size of
// the retained conversation, which is the number a host needs to decide
// whether a conversation is still below the reuse threshold.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_WINDOW_TOKENS = 233000;
const MAX_WALK_ENTRIES = 20000;

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return options;
}

export function summarizeCodexStream(stdout) {
  let threadId = null;
  let usage = null;
  let lastAgentMessage = '';
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (record.type === 'thread.started' && record.thread_id) threadId = record.thread_id;
    if (record.type === 'item.completed' && record.item?.type === 'agent_message') {
      lastAgentMessage = String(record.item.text || '');
    }
    if (record.type === 'turn.completed' && record.usage) usage = record.usage;
  }
  return { threadId, usage, lastAgentMessage };
}

function walkRolloutFiles(root, budget = { entries: MAX_WALK_ENTRIES }) {
  const found = [];
  const stack = [root];
  while (stack.length && budget.entries > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (budget.entries <= 0) break;
      budget.entries -= 1;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(full);
    }
  }
  return found;
}

// The codex CLI writes one rollout per conversation; its token_count events
// carry last_token_usage, the per-request prompt size. The peak of those is
// the real occupancy of the conversation, unlike the summed turn usage.
export function readPeakContextUsage(threadId, options = {}) {
  if (!threadId) return null;
  const sessionsRoot = options.sessionsRoot || path.join(os.homedir(), '.codex', 'sessions');
  const requestedWindow = Number(options.windowTokens);
  const windowTokens = requestedWindow > 0 ? requestedWindow : DEFAULT_WINDOW_TOKENS;
  const candidates = walkRolloutFiles(sessionsRoot).filter((file) => path.basename(file).includes(threadId));
  let peak = null;
  for (const file of candidates) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes('token_count')) continue;
      let record;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const info = record?.payload?.type === 'token_count' ? record.payload.info : null;
      const last = info?.last_token_usage;
      const input = Number(last?.input_tokens);
      if (!Number.isFinite(input) || input <= 0) continue;
      if (!peak || input > peak.input_tokens) {
        const cached = Number(last?.cached_input_tokens);
        peak = { input_tokens: input, cached_input_tokens: Number.isFinite(cached) ? cached : 0 };
      }
    }
  }
  if (!peak) return null;
  return { ...peak, window_tokens: windowTokens };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const model = String(options.model || 'deepseek-v4.1-flash');
  const workspace = path.resolve(String(options.workspace || process.cwd()));
  const thinking = String(options.thinking || 'high');
  const sessionId = options['session-id'] ? String(options['session-id']) : null;
  const windowTokens = Number(options.window) > 0 ? Number(options.window) : DEFAULT_WINDOW_TOKENS;
  const task = fs.readFileSync(0, 'utf8');
  const lastMessageFile = path.join(os.tmpdir(), `contextos-codex-cli-${process.pid}-${Date.now()}.txt`);

  const args = sessionId
    ? ['exec', 'resume', sessionId, '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--json', '-m', model, '-c', `model_reasoning_effort=${thinking}`, '-o', lastMessageFile]
    : ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--json', '-m', model, '-c', `model_reasoning_effort=${thinking}`, '-C', workspace, '-o', lastMessageFile];

  const child = spawn('codex', args, { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] });
  let streamBuffer = '';
  let stderr = '';
  let summary = { threadId: null, usage: null, lastAgentMessage: '' };
  const emitProgress = stage => {
    if (process.env.CONTEXTOS_CLI_PROGRESS === '1') process.stderr.write(`[contextos-progress] ${JSON.stringify({ stage })}\n`);
  };
  const consume = line => {
    const next = summarizeCodexStream(line);
    if (next.threadId) summary.threadId = next.threadId;
    if (next.usage) summary.usage = next.usage;
    if (next.lastAgentMessage) summary.lastAgentMessage = next.lastAgentMessage;
    let record; try { record = JSON.parse(line); } catch { return; }
    const stage = record.type === 'thread.started' ? 'session-started'
      : record.type === 'turn.started' ? 'model-running'
      : record.type === 'turn.completed' ? 'model-completed'
      : record.type === 'item.started' && record.item?.type === 'command_execution' ? 'command-running'
      : record.type === 'item.completed' ? 'tool-completed' : 'provider-stream';
    emitProgress(stage);
  };
  emitProgress('provider-launched');
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    streamBuffer += chunk;
    let newline;
    while ((newline = streamBuffer.indexOf('\n')) >= 0) {
      consume(streamBuffer.slice(0, newline)); streamBuffer = streamBuffer.slice(newline + 1);
    }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); emitProgress('provider-diagnostic'); });
  child.stdin.end(task);

  const exitCode = await new Promise((resolve) => {
    child.on('error', (error) => {
      stderr += `${error.message}\n`;
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });

  if (streamBuffer.trim()) consume(streamBuffer);
  const threadId = sessionId || summary.threadId;
  let lastAgentMessage = summary.lastAgentMessage;
  try {
    if (fs.existsSync(lastMessageFile)) {
      const fileMessage = fs.readFileSync(lastMessageFile, 'utf8').trim();
      if (fileMessage) lastAgentMessage = fileMessage;
    }
  } catch {}
  try { fs.rmSync(lastMessageFile, { force: true }); } catch {}

  const payload = {
    status: exitCode === 0 && lastAgentMessage ? 'SUCCESS' : 'FAILED',
    content: lastAgentMessage,
    thread_id: threadId,
    usage: summary.usage,
    context_usage: readPeakContextUsage(threadId, { windowTokens }),
    exit_code: exitCode,
    stderr: stderr.slice(-2000),
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = payload.status === 'SUCCESS' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
