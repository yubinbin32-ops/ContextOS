import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

const IGNORED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', '.contextos', '.next', '.nuxt', '.output', '.turbo',
  '.cache', '.parcel-cache', '.svelte-kit', '.angular', '.vercel', 'node_modules',
  'vendor', 'bower_components', 'coverage', 'dist', 'build', 'out', 'target',
  'release', 'generated', 'gen', 'storybook-static', '__generated__',
]);

const SENSITIVE_FILENAMES = new Set([
  '.env', '.env.local', '.env.development', '.env.production', 'id_rsa', 'id_ed25519',
  'credentials.json', 'secrets.json',
]);

const SEARCHABLE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.html', '.java', '.js',
  '.jsx', '.json', '.kt', '.md', '.mdx', '.mjs', '.mts', '.php', '.py', '.rb',
  '.rs', '.scss', '.sh', '.sql', '.svelte', '.swift', '.toml', '.ts', '.tsx',
  '.log', '.txt', '.vue', '.yaml', '.yml',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw codedError('Evidence request was cancelled.', 'ABORT_ERR');
}

function decodeUtf8(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw codedError('File is not valid UTF-8; exact text evidence is unavailable.', 'EVIDENCE_INVALID_UTF8');
  }
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw codedError('File does not round-trip as UTF-8; exact text evidence is unavailable.', 'EVIDENCE_INVALID_UTF8');
  }
  return text;
}

/** Resolve the real workspace and a stable identity for this filesystem location. */
export function workspaceIdentity(projectRoot) {
  if (typeof projectRoot !== 'string' || !projectRoot.trim()) {
    throw new TypeError('projectRoot must be a non-empty path.');
  }
  const workspace = fs.realpathSync(path.resolve(projectRoot));
  if (!fs.statSync(workspace).isDirectory()) throw new TypeError('projectRoot must resolve to a directory.');
  return {
    workspace,
    workspaceId: sha256(`contextos-workspace-v1\0${workspace}`),
  };
}

/** Normalize an in-workspace, relative source path using portable slash semantics. */
export function normalizeEvidencePath(value) {
  if (typeof value !== 'string' || !value.trim()) throw codedError('A relative file path is required.', 'EVIDENCE_INVALID_PATH');
  const raw = value.trim();
  if (raw.includes('\0') || /^[a-zA-Z]:/.test(raw) || raw.startsWith('\\\\')) {
    throw codedError('Absolute and device paths are not accepted.', 'EVIDENCE_UNSAFE_PATH');
  }
  const portable = raw.replaceAll('\\', '/');
  if (path.posix.isAbsolute(portable)) throw codedError('Absolute paths are not accepted.', 'EVIDENCE_UNSAFE_PATH');
  const normalized = path.posix.normalize(portable);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw codedError('Path escapes the workspace.', 'EVIDENCE_UNSAFE_PATH');
  }
  return normalized;
}

function parseRange(value) {
  const start = Array.isArray(value) ? value[0] : value?.start;
  const end = Array.isArray(value) ? value[1] : value?.end;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
    throw new RangeError('Line ranges must be inclusive 1-based integer pairs with end >= start.');
  }
  return { start, end };
}

/** Merge overlapping or adjacent inclusive line ranges. */
export function mergeLineRanges(ranges) {
  if (!Array.isArray(ranges)) throw new TypeError('ranges must be an array.');
  const sorted = ranges.map(parseRange).sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end + 1) merged.push({ ...range });
    else previous.end = Math.max(previous.end, range.end);
  }
  return merged;
}

function lineSpans(text) {
  if (!text.length) return [];
  const spans = [];
  let start = 0;
  let newline = text.indexOf('\n', start);
  while (newline !== -1) {
    spans.push({ start, end: newline + 1 });
    start = newline + 1;
    newline = text.indexOf('\n', start);
  }
  if (start < text.length) spans.push({ start, end: text.length });
  return spans;
}

/** Extract exact source text for inclusive 1-based line ranges. */
export function extractLineRanges(text, ranges) {
  if (typeof text !== 'string') throw new TypeError('text must be a string.');
  const spans = lineSpans(text);
  const normalized = mergeLineRanges(ranges);
  return normalized.map((range) => {
    if (range.end > spans.length) throw new RangeError(`Line ${range.end} is outside the ${spans.length}-line file.`);
    const fragment = text.slice(spans[range.start - 1].start, spans[range.end - 1].end);
    return {
      ranges: [range],
      text: fragment,
      bytes: Buffer.byteLength(fragment, 'utf8'),
      chars: Array.from(fragment).length,
    };
  });
}

function readSnapshot(workspace, relativePath) {
  const normalized = normalizeEvidencePath(relativePath);
  const absolute = path.resolve(workspace, ...normalized.split('/'));
  if (!isWithin(workspace, absolute)) throw codedError('Path escapes the workspace.', 'EVIDENCE_UNSAFE_PATH');
  const realPath = fs.realpathSync(absolute);
  if (!isWithin(workspace, realPath)) throw codedError('Symlink resolves outside the workspace.', 'EVIDENCE_UNSAFE_PATH');
  const stat = fs.statSync(realPath);
  if (!stat.isFile()) throw codedError('Evidence path is not a regular file.', 'EVIDENCE_NOT_FILE');
  const bytes = fs.readFileSync(realPath);
  const afterReadPath = fs.realpathSync(absolute);
  if (afterReadPath !== realPath) throw codedError('File path changed while it was being read.', 'EVIDENCE_PATH_CHANGED');
  const text = decodeUtf8(bytes);
  return { path: normalized, realPath, bytes, text, contentHash: sha256(bytes) };
}

function toMissing(pathValue, reason, range, extra = {}) {
  return {
    ...(pathValue ? { path: pathValue } : {}),
    ...(range ? { range } : {}),
    reason,
    ...extra,
  };
}

function makeRecord(workspaceId, snapshot, ranges, text) {
  const normalizedRanges = ranges.map(({ start, end }) => ({ start, end }));
  const id = sha256(JSON.stringify([
    'contextos-evidence-v1', workspaceId, snapshot.path, snapshot.contentHash, normalizedRanges,
  ]));
  return {
    id,
    workspaceId,
    path: snapshot.path,
    ranges: normalizedRanges,
    text,
    contentHash: snapshot.contentHash,
    bytes: Buffer.byteLength(text, 'utf8'),
    chars: Array.from(text).length,
    missing: [],
  };
}

function getRequestedRanges(request) {
  if (request.ranges === undefined || request.ranges === null || (Array.isArray(request.ranges) && request.ranges.length === 0)) {
    return { full: true, ranges: [] };
  }
  const values = Array.isArray(request.ranges) ? request.ranges : [request.ranges];
  return { full: false, ranges: values.map(parseRange) };
}

/** Read exact current files, merge duplicate ranges, and return bounded source records. */
export async function collectEvidence({ projectRoot, requests = [], signal } = {}) {
  const identity = workspaceIdentity(projectRoot);
  if (!Array.isArray(requests)) throw new TypeError('requests must be an array.');
  const missing = [];
  const notices = [];
  const groups = new Map();

  for (const request of requests) {
    assertNotAborted(signal);
    let relativePath;
    try {
      relativePath = normalizeEvidencePath(request?.path);
      const parsed = getRequestedRanges(request);
      const expectedHash = request.expectedContentHash ?? request.contentHash ?? null;
      const key = `${relativePath}\0${expectedHash || ''}`;
      const group = groups.get(key) || { path: relativePath, expectedHash, full: false, ranges: [] };
      group.full ||= parsed.full;
      group.ranges.push(...parsed.ranges);
      groups.set(key, group);
    } catch (error) {
      missing.push(toMissing(typeof request?.path === 'string' ? request.path : undefined, error.message,
        request?.range ?? null));
    }
  }

  const records = [];
  for (const group of groups.values()) {
    assertNotAborted(signal);
    let snapshot;
    try {
      snapshot = readSnapshot(identity.workspace, group.path);
    } catch (error) {
      missing.push(toMissing(group.path, error.message));
      continue;
    }
    if (group.expectedHash && group.expectedHash !== snapshot.contentHash) {
      missing.push(toMissing(group.path, 'File content changed before the requested evidence was read.', null, {
        expectedContentHash: group.expectedHash,
        currentContentHash: snapshot.contentHash,
      }));
      continue;
    }

    const spans = lineSpans(snapshot.text);
    if (group.full) {
      if (!spans.length) records.push(makeRecord(identity.workspaceId, snapshot, [], ''));
      else {
        const range = { start: 1, end: spans.length };
        records.push(makeRecord(identity.workspaceId, snapshot, [range], snapshot.text));
      }
      continue;
    }

    let ranges;
    try {
      ranges = mergeLineRanges(group.ranges);
    } catch (error) {
      missing.push(toMissing(group.path, error.message));
      continue;
    }
    for (const range of ranges) {
      if (range.start > spans.length) {
        missing.push(toMissing(group.path, `Requested line ${range.start} is outside the ${spans.length}-line file.`, range));
        continue;
      }
      const end = Math.min(range.end, spans.length);
      const actualRange = { start: range.start, end };
      const fragment = snapshot.text.slice(spans[range.start - 1].start, spans[end - 1].end);
      records.push(makeRecord(identity.workspaceId, snapshot, [actualRange], fragment));
      if (end < range.end) {
        notices.push({
          path: group.path,
          requestedRange: { start: range.start, end: range.end },
          actualRange,
          reason: `Requested range ends after EOF at line ${spans.length}; returned available lines ${range.start}-${end}.`,
        });
      }
    }
  }

  const bytes = records.reduce((sum, record) => sum + record.bytes, 0);
  const chars = records.reduce((sum, record) => sum + record.chars, 0);
  return {
    status: missing.length ? 'partial' : 'complete',
    workspace: identity.workspace,
    workspaceId: identity.workspaceId,
    records,
    missing,
    notices,
    bytes,
    chars,
  };
}

function isExcludedPath(relativePath, extraExcluded = []) {
  const parts = relativePath.split('/');
  if (parts.some((part) => IGNORED_DIRECTORIES.has(part) || extraExcluded.includes(part))) return true;
  const basename = parts.at(-1) || '';
  const lower = basename.toLowerCase();
  return SENSITIVE_FILENAMES.has(lower)
    || /^\.env(?:\.|$)/i.test(basename)
    || /(?:\.generated\.[^.]+|\.min\.(?:js|css)|\.bundle\.js|\.map)$/i.test(basename)
    || lower.endsWith('.lock');
}

function isSearchableFile(relativePath) {
  const basename = path.posix.basename(relativePath);
  if (!path.posix.extname(basename)) return /^(readme|license|makefile|dockerfile|justfile)$/i.test(basename);
  return SEARCHABLE_EXTENSIONS.has(path.posix.extname(basename).toLowerCase());
}

function collectSearchFiles(workspace, requestedPaths, extraExcluded, maxScannedFiles, signal) {
  const files = [];
  const missing = [];
  let visited = 0;
  let truncated = false;

  const addFile = (relative) => {
    assertNotAborted(signal);
    if (isExcludedPath(relative, extraExcluded) || !isSearchableFile(relative)) return;
    visited += 1;
    if (visited > maxScannedFiles) {
      truncated = true;
      return;
    }
    files.push(relative);
  };

  const walk = (absoluteDir, relativeDir) => {
    assertNotAborted(signal);
    let entries;
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      missing.push(toMissing(relativeDir || undefined, `Unable to list search scope: ${error.message}`));
      return;
    }
    for (const entry of entries) {
      if (truncated) break;
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (isExcludedPath(relative, extraExcluded) || entry.isSymbolicLink()) continue;
      const absolute = path.join(absoluteDir, entry.name);
      if (entry.isDirectory()) walk(absolute, relative);
      else if (entry.isFile()) addFile(relative);
    }
  };

  const roots = Array.isArray(requestedPaths) && requestedPaths.length ? requestedPaths : ['.'];
  for (const candidate of roots) {
    if (truncated) break;
    let relative;
    try {
      relative = candidate === '.' ? '.' : normalizeEvidencePath(candidate);
      const absolute = relative === '.' ? workspace : path.resolve(workspace, ...relative.split('/'));
      if (!isWithin(workspace, absolute)) throw codedError('Search path escapes the workspace.', 'EVIDENCE_UNSAFE_PATH');
      const real = fs.realpathSync(absolute);
      if (!isWithin(workspace, real)) throw codedError('Search path resolves outside the workspace.', 'EVIDENCE_UNSAFE_PATH');
      const stat = fs.statSync(real);
      if (stat.isDirectory()) walk(real, relative === '.' ? '' : relative);
      else if (stat.isFile()) addFile(relative);
      else missing.push(toMissing(relative, 'Search path is not a file or directory.'));
    } catch (error) {
      missing.push(toMissing(typeof candidate === 'string' ? candidate : undefined, error.message));
    }
  }

  if (truncated) missing.push(toMissing(undefined,
    `Search stopped after ${maxScannedFiles} files; narrow the search paths or raise config.search.maxScannedFiles.`));
  return { files, missing, visited: Math.min(visited, maxScannedFiles), truncated };
}

/** List bounded, searchable workspace paths without reading their file contents. */
export async function listWorkspacePaths({
  projectRoot,
  queries = [],
  paths,
  limit,
  cursor = 0,
  config = {},
  signal,
} = {}) {
  const identity = workspaceIdentity(projectRoot);
  const terms = (Array.isArray(queries) ? queries : [queries])
    .map((query) => String(query ?? '').trim().toLocaleLowerCase())
    .filter(Boolean);
  if (!terms.length) {
    return {
      status: 'partial', workspace: identity.workspace, workspaceId: identity.workspaceId,
      paths: [], missing: [toMissing(undefined, 'At least one non-empty path search query is required.')],
      scannedFiles: 0, truncated: false,
    };
  }
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    return {
      status: 'partial', workspace: identity.workspace, workspaceId: identity.workspaceId,
      paths: [], missing: [toMissing(undefined, 'Path search cursor must be a non-negative integer.')],
      scannedFiles: 0, truncated: false,
    };
  }

  const searchConfig = config.search || {};
  const maxResults = Math.min(64, Math.max(1, Math.floor(Number(limit ?? 8)) || 8));
  const offset = cursor;
  const maxScannedFiles = Math.max(1, Math.floor(Number(searchConfig.maxScannedFiles ?? 20_000)) || 20_000);
  const extraExcluded = Array.isArray(searchConfig.excludeDirectories) ? searchConfig.excludeDirectories : [];
  const scan = collectSearchFiles(identity.workspace, paths, extraExcluded, maxScannedFiles, signal);
  const matching = scan.files.filter((relativePath) => {
    const lower = relativePath.toLocaleLowerCase();
    return terms.some((term) => lower.includes(term));
  });
  const found = matching.slice(offset, offset + maxResults);
  const hasMore = offset + found.length < matching.length;
  if (hasMore) {
    scan.missing.push(toMissing(undefined,
      `Path search returned a bounded page; continue from cursor ${offset + found.length} or narrow the scope.`));
  }
  if (!matching.length) scan.missing.push(toMissing(undefined, 'No matching searchable workspace paths were found.'));
  return {
    status: scan.missing.length ? 'partial' : 'complete',
    workspace: identity.workspace,
    workspaceId: identity.workspaceId,
    paths: found,
    missing: scan.missing,
    scannedFiles: scan.visited,
    truncated: scan.truncated || hasMore,
    ...(hasMore ? { nextCursor: offset + found.length } : {}),
  };
}

/** Search source-like files without following symlinks or entering generated/dependency trees. */
export async function searchWorkspace({
  projectRoot,
  queries = [],
  paths,
  limit,
  config = {},
  signal,
} = {}) {
  const identity = workspaceIdentity(projectRoot);
  const terms = (Array.isArray(queries) ? queries : [queries])
    .map((query) => String(query ?? '').trim().toLocaleLowerCase())
    .filter(Boolean);
  if (!terms.length) {
    return {
      status: 'partial', workspace: identity.workspace, workspaceId: identity.workspaceId,
      results: [], missing: [toMissing(undefined, 'At least one non-empty search query is required.')],
    };
  }

  const searchConfig = config.search || {};
  const maxResults = Math.max(1, Math.floor(Number(limit ?? searchConfig.maxResults ?? 30)) || 30);
  const maxScannedFiles = Math.max(1, Math.floor(Number(searchConfig.maxScannedFiles ?? 20_000)) || 20_000);
  const maxFileBytes = Math.max(1, Math.floor(Number(searchConfig.maxFileBytes ?? 1_000_000)) || 1_000_000);
  const maxSnippetChars = Math.max(80, Math.floor(Number(searchConfig.maxSnippetChars ?? 400)) || 400);
  const extraExcluded = Array.isArray(searchConfig.excludeDirectories) ? searchConfig.excludeDirectories : [];
  const scan = collectSearchFiles(identity.workspace, paths, extraExcluded, maxScannedFiles, signal);
  const found = [];
  let oversized = 0;

  for (const relativePath of scan.files) {
    assertNotAborted(signal);
    let snapshot;
    try {
      snapshot = readSnapshot(identity.workspace, relativePath);
    } catch (error) {
      scan.missing.push(toMissing(relativePath, error.message));
      continue;
    }
    if (snapshot.bytes.length > maxFileBytes || snapshot.bytes.includes(0)) {
      oversized += 1;
      continue;
    }
    const lines = lineSpans(snapshot.text).map(({ start, end }) => snapshot.text.slice(start, end));
    for (let index = 0; index < lines.length; index += 1) {
      const lower = lines[index].toLocaleLowerCase();
      const matchedTerms = terms.filter((term) => lower.includes(term));
      if (!matchedTerms.length) continue;
      const contextLine = lines[index].replace(/[\r\n]+$/u, '');
      found.push({
        path: relativePath,
        line: index + 1,
        contentHash: snapshot.contentHash,
        score: matchedTerms.length,
        snippet: contextLine.length > maxSnippetChars
          ? `${contextLine.slice(0, maxSnippetChars)}…`
          : contextLine,
      });
    }
  }

  found.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.line - right.line);
  const results = found.slice(0, maxResults);
  if (found.length > results.length) {
    scan.missing.push(toMissing(undefined,
      `Search returned the first ${results.length} of ${found.length} matching lines; narrow the query or raise config.search.maxResults.`));
  }
  if (!results.length) {
    scan.missing.push(toMissing(undefined, `No matching source lines were found for: ${terms.join(', ')}.`));
  }
  if (oversized) scan.missing.push(toMissing(undefined,
    `Search skipped ${oversized} source-like file(s) larger than config.search.maxFileBytes.`));

  return {
    status: scan.missing.length ? 'partial' : 'complete',
    workspace: identity.workspace,
    workspaceId: identity.workspaceId,
    results,
    missing: scan.missing,
    scannedFiles: scan.visited,
  };
}

function selectionRanges(reference, original) {
  if (!Array.isArray(reference.ranges)) return null;
  try {
    const selected = mergeLineRanges(reference.ranges);
    const available = mergeLineRanges(original.ranges || []);
    if (!selected.length) return available.length ? null : [];

    for (const wanted of selected) {
      let cursor = wanted.start;
      for (const source of available) {
        if (source.end < cursor) continue;
        if (source.start > cursor) break;
        cursor = Math.max(cursor, source.end + 1);
        if (cursor > wanted.end) break;
      }
      if (cursor <= wanted.end) return null;
    }
    return selected;
  } catch {
    return null;
  }
}

/** Re-read selected records from current disk and deliver only references still on the same version. */
export async function deliverEvidence({ projectRoot, availableRecords = [], references = [], signal } = {}) {
  const identity = workspaceIdentity(projectRoot);
  const missing = [];
  const records = [];
  const byId = new Map(availableRecords.map((record) => [record.id, record]));
  const seen = new Set();

  if (!Array.isArray(references)) {
    return {
      status: 'partial', workspace: identity.workspace, workspaceId: identity.workspaceId,
      records, missing: [toMissing(undefined, 'Selection references must be an array.')], bytes: 0, chars: 0,
    };
  }

  for (const reference of references) {
    assertNotAborted(signal);
    if (!reference || typeof reference.id !== 'string') {
      missing.push(toMissing(typeof reference?.path === 'string' ? reference.path : undefined,
        'Selection is missing a valid evidence id.'));
      continue;
    }
    const selectionKey = JSON.stringify([reference.id, reference.path, reference.contentHash, reference.ranges]);
    if (seen.has(selectionKey)) continue;
    seen.add(selectionKey);
    const original = byId.get(reference.id);
    const selectedRanges = original ? selectionRanges(reference, original) : null;
    if (!original
      || reference.path !== original.path
      || reference.contentHash !== original.contentHash
      || selectedRanges === null) {
      missing.push(toMissing(typeof reference.path === 'string' ? reference.path : undefined,
        'Selection must cite a valid subset of ranges returned by the read tool; it cannot cross unread gaps or expand beyond read lines.'));
      continue;
    }
    if (original.workspaceId && original.workspaceId !== identity.workspaceId) {
      missing.push(toMissing(original.path, 'Workspace identity changed before evidence delivery.', null, {
        expectedWorkspaceId: original.workspaceId,
        currentWorkspaceId: identity.workspaceId,
      }));
      continue;
    }
    let snapshot;
    try {
      snapshot = readSnapshot(identity.workspace, original.path);
    } catch (error) {
      missing.push(toMissing(original.path, error.message));
      continue;
    }
    if (snapshot.contentHash !== original.contentHash) {
      missing.push(toMissing(original.path, 'File content changed after selection; refresh the evidence before using it.', null, {
        expectedContentHash: original.contentHash,
        currentContentHash: snapshot.contentHash,
      }));
      continue;
    }

    const fragments = selectedRanges.length
      ? extractLineRanges(snapshot.text, selectedRanges)
      : [{ ranges: [], text: '', bytes: 0, chars: 0 }];
    for (const fragment of fragments) {
      const record = makeRecord(identity.workspaceId, snapshot, fragment.ranges, fragment.text);
      records.push({ ...record, workspaceId: identity.workspaceId, sourceEvidenceId: original.id });
    }
  }

  const bytes = records.reduce((sum, record) => sum + record.bytes, 0);
  const chars = records.reduce((sum, record) => sum + record.chars, 0);
  return {
    status: missing.length ? 'partial' : 'complete',
    workspace: identity.workspace,
    workspaceId: identity.workspaceId,
    records,
    missing,
    bytes,
    chars,
  };
}
