import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function ensureLogDir(projectRoot) {
  const logDir = path.join(projectRoot, '.contextos', 'logs');
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(logDir, 0o700);
  } catch (_) {}
  return logDir;
}

export function secureLogFile(filePath) {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (_) {}
  return filePath;
}

export function writeSecureLog(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  return secureLogFile(filePath);
}

export function pruneLogDir(logDir, {
  maxFiles = DEFAULT_MAX_FILES,
  maxBytes = DEFAULT_MAX_BYTES,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = Date.now(),
} = {}) {
  let entries = [];
  try {
    entries = fs.readdirSync(logDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.log'))
      .map((entry) => {
        const filePath = path.join(logDir, entry.name);
        const stat = fs.statSync(filePath);
        return { filePath, mtimeMs: stat.mtimeMs, size: stat.size };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch (_) {
    return { removed: 0, kept: 0 };
  }

  const kept = [];
  let totalBytes = 0;
  let removed = 0;
  for (const entry of entries) {
    const expired = now - entry.mtimeMs > maxAgeMs;
    const exceedsCount = kept.length >= maxFiles;
    const exceedsBytes = totalBytes + entry.size > maxBytes && kept.length > 0;
    if (expired || exceedsCount || exceedsBytes) {
      try {
        fs.rmSync(entry.filePath, { force: true });
        removed += 1;
      } catch (_) {}
      continue;
    }
    kept.push(entry);
    totalBytes += entry.size;
  }
  return { removed, kept: kept.length };
}
