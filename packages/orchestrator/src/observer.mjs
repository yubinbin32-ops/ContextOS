import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const GIT_TIMEOUT_MS = 5000;
const IGNORED_PREFIXES = ['.git/'];
const OS_STATE_PREFIX = '.contextos/';

function runGit(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['status', '--porcelain', '-uall'], { cwd, timeout: GIT_TIMEOUT_MS }, (error, stdout) => {
      if (error) resolve({ available: false, lines: [] });
      else resolve({ available: true, lines: String(stdout || '').split('\n').filter(Boolean) });
    });
  });
}

function parsePorcelainLine(line) {
  const status = line.slice(0, 2);
  const rest = line.slice(3).trim();
  const arrow = rest.indexOf(' -> ');
  const rawPath = arrow >= 0 ? rest.slice(arrow + 4) : rest;
  const clean = rawPath.replace(/^"|"$/g, '');
  return { status: status.trim(), filePath: clean, deleted: status.includes('D') };
}

function statEntry(projectRoot, filePath) {
  try {
    const stat = fs.statSync(path.join(projectRoot, filePath));
    return { path: filePath, mtimeMs: stat.mtimeMs, size: stat.size, source: 'mtime' };
  } catch (_) {
    return { path: filePath, source: 'missing' };
  }
}

/**
 * Reconciles whatever the agent did outside ContextOS (host edits, apply_patch,
 * another process) into the session, so nothing has to be declared by hand.
 */
export async function observe({ projectRoot, store }) {
  const { available, lines } = await runGit(projectRoot);
  const changed = [];
  const untracked = [];
  const systemChanged = [];
  const deleted = new Set();

  for (const line of lines) {
    const { status, filePath, deleted: isDeleted } = parsePorcelainLine(line);
    if (!filePath) continue;
    if (filePath.startsWith(OS_STATE_PREFIX)) {
      systemChanged.push(filePath);
      continue;
    }
    if (IGNORED_PREFIXES.some((prefix) => filePath.startsWith(prefix))) continue;
    if (status === '??') untracked.push(filePath);
    else changed.push(filePath);
    if (isDeleted) deleted.add(filePath);
  }

  const discovered = [...changed, ...untracked];
  let reconciled = 0;

  if (available) {
    const entries = discovered.map((filePath) => {
      const entry = statEntry(projectRoot, filePath);
      return deleted.has(filePath) ? { ...entry, deleted: true } : entry;
    });
    const before = new Set((store.current?.touchedFiles || []).map((entry) => entry.path));
    store.touch(entries, 'git');
    const after = store.current?.touchedFiles || [];
    reconciled = after.filter((entry) => !before.has(entry.path)).length;
  } else {
    // No git: fall back to mtime drift on files already known to the session.
    const session = store.current;
    for (const entry of session?.touchedFiles || []) {
      if (entry.mtimeMs === undefined) continue;
      const stat = statEntry(projectRoot, entry.path);
      if (stat.mtimeMs !== undefined && stat.mtimeMs !== entry.mtimeMs) {
        changed.push(entry.path);
        reconciled += 1;
      }
    }
  }

  return { gitAvailable: available, changed, untracked, systemChanged, reconciled };
}
