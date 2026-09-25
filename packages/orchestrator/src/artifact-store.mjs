import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_ARTIFACTS = 200;
const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function artifactDir(projectRoot) {
  return path.join(projectRoot, '.contextos', 'artifacts');
}

function indexPath(projectRoot) {
  return path.join(artifactDir(projectRoot), 'index.json');
}

function safeId(value) {
  const id = String(value || '');
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error('Artifact id must contain only letters, digits, dot, underscore, or hyphen');
  }
  return id;
}

function serializeContent(content) {
  if (typeof content === 'string') return content;
  return JSON.stringify(content, null, 2);
}

function loadIndex(projectRoot) {
  const filePath = indexPath(projectRoot);
  if (!fs.existsSync(filePath)) return { version: 1, entries: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      version: 1,
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    };
  } catch (_) {
    return { version: 1, entries: [] };
  }
}

function saveIndex(projectRoot, index) {
  const filePath = indexPath(projectRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tempPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
  fs.renameSync(tempPath, filePath);
}

function removeEntry(projectRoot, entry) {
  if (!entry?.file) return;
  try {
    fs.rmSync(path.join(artifactDir(projectRoot), entry.file), { force: true });
  } catch (_) {}
}

export function evictArtifacts(projectRoot, options = {}) {
  const {
    id = null,
    ids = [],
    maxArtifacts = DEFAULT_MAX_ARTIFACTS,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    keep = [],
    now = Date.now(),
  } = options;
  const index = loadIndex(projectRoot);
  const requestedIds = new Set(
    (Array.isArray(ids) ? ids : [ids])
      .concat(id == null ? [] : [id])
      .filter((value) => value != null && String(value).trim())
      .map((value) => safeId(value))
  );
  const hasExplicitPolicy = ['maxArtifacts', 'maxTotalBytes', 'maxAgeMs']
    .some((key) => Object.prototype.hasOwnProperty.call(options, key));
  const targetOnly = requestedIds.size > 0 && !hasExplicitPolicy;
  const keepIds = new Set((keep || []).map(String));
  const cutoff = Number.isFinite(maxAgeMs) ? now - Math.max(0, maxAgeMs) : -Infinity;
  const retained = [];
  const evicted = [];

  for (const entry of index.entries) {
    if (requestedIds.has(entry.id) && !keepIds.has(entry.id)) {
      removeEntry(projectRoot, entry);
      evicted.push({ id: entry.id, reason: 'requested' });
      continue;
    }
    if (targetOnly) {
      retained.push(entry);
      continue;
    }
    const createdAt = Date.parse(entry.createdAt || 0);
    const expired = Number.isFinite(createdAt) && createdAt < cutoff;
    if (expired && !keepIds.has(entry.id)) {
      removeEntry(projectRoot, entry);
      evicted.push({ id: entry.id, reason: 'expired' });
    } else {
      retained.push(entry);
    }
  }

  if (targetOnly) {
    const totalBytes = retained.reduce((total, entry) => total + (Number(entry.bytes) || 0), 0);
    saveIndex(projectRoot, { version: 1, entries: retained });
    const foundIds = new Set(index.entries.map((entry) => entry.id));
    return {
      entries: retained,
      evicted,
      totalBytes,
      requested: [...requestedIds],
      notFound: [...requestedIds].filter((requestedId) => !foundIds.has(requestedId)),
    };
  }

  retained.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  const sizeLimit = Number.isFinite(maxTotalBytes) ? Math.max(0, maxTotalBytes) : Infinity;
  const countLimit = Number.isFinite(maxArtifacts) ? Math.max(0, maxArtifacts) : Infinity;
  let totalBytes = 0;
  const next = [];

  for (const entry of retained) {
    const bytes = Number(entry.bytes) || 0;
    const overCount = next.length >= countLimit;
    const overBytes = totalBytes + bytes > sizeLimit;
    if ((overCount || overBytes) && !keepIds.has(entry.id)) {
      removeEntry(projectRoot, entry);
      evicted.push({ id: entry.id, reason: overCount ? 'count' : 'bytes' });
      continue;
    }
    next.push(entry);
    totalBytes += bytes;
  }

  saveIndex(projectRoot, { version: 1, entries: next });
  const foundIds = new Set(index.entries.map((entry) => entry.id));
  return {
    entries: next,
    evicted,
    totalBytes,
    ...(requestedIds.size
      ? { requested: [...requestedIds], notFound: [...requestedIds].filter((requestedId) => !foundIds.has(requestedId)) }
      : {}),
  };
}

export function storeArtifact(projectRoot, content, {
  id,
  kind = 'response',
  metadata = {},
  maxArtifacts = DEFAULT_MAX_ARTIFACTS,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  if (!projectRoot) throw new Error('projectRoot is required to store an artifact');
  const text = serializeContent(content);
  const resolvedId = safeId(id || `art-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`);
  const extension = typeof content === 'string' ? 'txt' : 'json';
  const file = `${resolvedId}.${extension}`;
  const fullPath = path.join(artifactDir(projectRoot), file);
  const createdAt = new Date().toISOString();
  const bytes = Buffer.byteLength(text);
  const sha256 = crypto.createHash('sha256').update(text).digest('hex');

  fs.mkdirSync(artifactDir(projectRoot), { recursive: true });
  const tempPath = `${fullPath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, text, 'utf8');
  fs.renameSync(tempPath, fullPath);

  const index = loadIndex(projectRoot);
  const entry = {
    id: resolvedId,
    file,
    kind,
    bytes,
    contentChars: text.length,
    sha256,
    createdAt,
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
  };
  index.entries = index.entries.filter((candidate) => candidate.id !== resolvedId);
  index.entries.push(entry);
  saveIndex(projectRoot, index);
  evictArtifacts(projectRoot, { maxArtifacts, maxTotalBytes, maxAgeMs, keep: [resolvedId] });

  return {
    ...entry,
    path: fullPath,
    relativePath: path.relative(projectRoot, fullPath).split(path.sep).join('/'),
  };
}

export function statArtifact(projectRoot, id) {
  let resolvedId;
  try {
    resolvedId = safeId(id);
  } catch (_) {
    return null;
  }
  const entry = loadIndex(projectRoot).entries.find((candidate) => candidate.id === resolvedId);
  if (!entry) return null;
  const fullPath = path.join(artifactDir(projectRoot), entry.file);
  return fs.existsSync(fullPath)
    ? { ...entry, path: fullPath, relativePath: path.relative(projectRoot, fullPath).split(path.sep).join('/') }
    : null;
}

function matchesGrep(line, grep) {
  const text = String(line ?? '');
  const pattern = String(grep ?? '');
  try {
    return new RegExp(pattern, 'i').test(text);
  } catch (_) {
    return text.toLowerCase().includes(pattern.toLowerCase());
  }
}

function clip(text, maxChars) {
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : text.length;
  if (text.length <= limit) return { text, truncated: false, omittedChars: 0 };
  const omittedChars = text.length - limit;
  const suffix = `\n[artifact excerpt truncated: ${omittedChars} chars omitted]`;
  if (limit <= suffix.length) {
    return {
      text: text.slice(0, limit),
      truncated: true,
      omittedChars,
    };
  }
  const cut = Math.max(0, limit - suffix.length);
  return {
    text: `${text.slice(0, cut)}${suffix}`,
    truncated: true,
    omittedChars,
  };
}

export function readArtifact(projectRoot, id, {
  startLine,
  endLine,
  grep,
  contextLines = 0,
  maxChars = 4000,
  lineNumbers = true,
} = {}) {
  const stat = statArtifact(projectRoot, id);
  if (!stat) return null;
  const content = fs.readFileSync(stat.path, 'utf8');
  const allLines = content.split(/\r?\n/);
  const start = Math.max(1, Number(startLine) || 1);
  const end = Math.max(start, Math.min(Number(endLine) || allLines.length, allLines.length));
  let selected = allLines.slice(start - 1, end).map((line, offset) => ({
    number: start + offset,
    text: line,
  }));

  if (grep) {
    const context = Number.isInteger(contextLines)
      ? Math.max(0, Math.min(5, contextLines))
      : 0;
    const matchedIndexes = selected.reduce((indexes, line, index) => {
      if (matchesGrep(line.text, grep)) indexes.push(index);
      return indexes;
    }, []);

    if (context > 0 && matchedIndexes.length > 0) {
      const included = new Set();
      for (const index of matchedIndexes) {
        const first = Math.max(0, index - context);
        const last = Math.min(selected.length - 1, index + context);
        for (let candidate = first; candidate <= last; candidate += 1) {
          included.add(candidate);
        }
      }
      selected = [...included]
        .sort((a, b) => a - b)
        .map((index) => selected[index]);
    } else {
      selected = matchedIndexes.map((index) => selected[index]);
    }
  }

  const body = selected
    .map((line) => (lineNumbers ? `${line.number}: ${line.text}` : line.text))
    .join('\n');
  const clipped = clip(body, maxChars);
  return {
    ...stat,
    text: clipped.text,
    truncated: clipped.truncated,
    omittedChars: clipped.omittedChars,
    returnedLines: selected.length,
    totalLines: allLines.length,
    range: { startLine: start, endLine: end },
  };
}

export function listArtifacts(projectRoot, { limit = 20 } = {}) {
  const entries = loadIndex(projectRoot).entries
    .slice()
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  return entries.slice(0, Math.max(0, Number(limit) || 0));
}
