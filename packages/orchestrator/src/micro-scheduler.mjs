import fs from 'node:fs';
import path from 'node:path';

const active = new Set();
const pending = [];
function workspaceKey(options) {
  const root = path.resolve(options.workspace || options.projectRoot || process.cwd());
  try { return fs.realpathSync(root); } catch { return root; }
}
function conflicts(a, b) {
  return a.workspace === b.workspace && (a.writer || b.writer);
}
function pump() {
  for (let i = 0; i < pending.length;) {
    const task = pending[i];
    if (active.size >= task.limit || [...active].some((other) => conflicts(task, other))
      || pending.slice(0, i).some((other) => conflicts(task, other))) { i++; continue; }
    pending.splice(i, 1);
    task.signal?.removeEventListener('abort', task.cancel);
    active.add(task);
    Promise.resolve().then(() => task.run()).then(task.resolve, task.reject).finally(() => {
      active.delete(task);
      pump();
    });
  }
}

// One provider scheduler covers direct, batch and background jobs. Workspace
// writers queue rather than fail; independent workspaces/readers can overlap.
export function scheduleMicro(options, run) {
  return new Promise((resolve, reject) => {
    const number = Number(options.maxConcurrency);
    const task = { workspace: workspaceKey(options), writer: options.execution === 'implement' || Boolean(options.cliSessionId),
      limit: Number.isFinite(number) && number > 0 ? Math.max(1, Math.floor(number)) : 4,
      signal: options.signal, run, resolve, reject };
    task.cancel = () => {
      const index = pending.indexOf(task);
      if (index !== -1) pending.splice(index, 1);
      resolve({ ok: false, errorCode: 'MICRO_CANCELLED', error: 'Cancelled before provider dispatch.',
        providerUsage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        providerUsageComplete: true, usageSource: 'not-dispatched', durationMs: 0 });
      pump();
    };
    if (task.signal?.aborted) { task.cancel(); return; }
    task.signal?.addEventListener('abort', task.cancel, { once: true });
    pending.push(task);
    pump();
  });
}
