import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_MAX_LOG_BYTES = 64;

export const LOG_TRUNCATION_MARKER = '[contextos:log-truncated]\n';
const LOG_TRUNCATION_MARKER_BYTES = Buffer.from(LOG_TRUNCATION_MARKER, 'utf8');

export function normalizeMaxLogBytes(maxLogBytes) {
  if (maxLogBytes === undefined) return null;
  if (!Number.isInteger(maxLogBytes) || maxLogBytes < MIN_MAX_LOG_BYTES) {
    throw new RangeError(`maxLogBytes must be a positive integer of at least ${MIN_MAX_LOG_BYTES} bytes`);
  }
  return maxLogBytes;
}

function writeAllAtStart(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    offset += fs.writeSync(fd, buffer, offset, buffer.length - offset, offset);
  }
  fs.ftruncateSync(fd, buffer.length);
}

function createBoundedLogSink(filePath, maxBytes) {
  const fd = fs.openSync(filePath, 'w', 0o600);
  secureLogFile(filePath);

  const retentionBytes = maxBytes - LOG_TRUNCATION_MARKER_BYTES.length;
  let retained = Buffer.alloc(0);
  let truncated = false;
  let closed = false;

  const state = () => ({ logBytes: retained.length, logTruncated: truncated });

  return {
    write(chunk) {
      if (closed) throw new Error('Cannot write to a closed log sink');
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');

      if (truncated) {
        const existing = retained.subarray(LOG_TRUNCATION_MARKER_BYTES.length);
        if (incoming.length >= retentionBytes) {
          retained = Buffer.from(incoming.subarray(incoming.length - retentionBytes));
        } else {
          const combined = Buffer.concat([existing, incoming]);
          retained = Buffer.from(combined.subarray(Math.max(0, combined.length - retentionBytes)));
        }
        retained = Buffer.concat([LOG_TRUNCATION_MARKER_BYTES, retained]);
      } else if (retained.length + incoming.length > maxBytes) {
        const combined = Buffer.concat([retained, incoming]);
        truncated = true;
        retained = Buffer.concat([
          LOG_TRUNCATION_MARKER_BYTES,
          Buffer.from(combined.subarray(Math.max(0, combined.length - retentionBytes))),
        ]);
      } else {
        retained = retained.length === 0 ? Buffer.from(incoming) : Buffer.concat([retained, incoming]);
      }

      writeAllAtStart(fd, retained);
      return state();
    },

    end() {
      if (!closed) {
        try {
          writeAllAtStart(fd, retained);
        } finally {
          closed = true;
          fs.closeSync(fd);
        }
      }
      return state();
    },
  };
}

function createStreamingLogSink(filePath) {
  const stream = fs.createWriteStream(filePath, { flags: 'a', mode: 0o600 });
  stream.on('open', () => secureLogFile(filePath));
  stream.on('error', () => {});

  let bytes = 0;
  let endPromise = null;

  return {
    write(chunk) {
      bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), 'utf8');
      stream.write(chunk);
      return { logBytes: bytes, logTruncated: false };
    },

    end() {
      if (!endPromise) {
        endPromise = new Promise((resolve) => {
          stream.end(() => {
            let logBytes = bytes;
            try {
              logBytes = fs.statSync(filePath).size;
            } catch (_) {}
            resolve({ logBytes, logTruncated: false });
          });
        });
      }
      return endPromise;
    },
  };
}

export function createLogSink(filePath, { maxLogBytes } = {}) {
  const limit = normalizeMaxLogBytes(maxLogBytes);
  return limit === null
    ? createStreamingLogSink(filePath)
    : createBoundedLogSink(filePath, limit);
}

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
