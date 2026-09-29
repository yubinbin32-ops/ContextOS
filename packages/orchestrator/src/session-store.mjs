import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const MAX_TOUCHED = 200;
const MAX_RECEIPTS = 50;
const MAX_NOTES = 100;
const MAX_READ_RECEIPTS = 200;
const MAX_SEARCH_RECEIPTS = 100;
const MAX_EXPLORE_RECEIPTS = 50;
const MAX_SEMANTIC_RECEIPTS = 80;
const MAX_FULL_EXPANSION_PATHS = 12;
const MAX_DIRECTED_EXPANSION_PATHS = 12;
const DEFAULT_HISTORY_LIMIT = 3;
const MAX_HISTORY_LIMIT = 10;
const HISTORY_INTENT_CHARS = 120;
const HISTORY_SUMMARY_CHARS = 180;
const HISTORY_PATH_CHARS = 80;
const HISTORY_RECEIPT_COMMAND_CHARS = 80;
const FALLBACK_FINGERPRINT_MAX_FILES = 20000;
const FALLBACK_FINGERPRINT_CONTENT_BYTES = 16 * 1024 * 1024;
const FALLBACK_FINGERPRINT_FILE_BYTES = 512 * 1024;
const FALLBACK_IGNORED_DIRECTORIES = new Set([
  '.git', '.contextos', 'node_modules', 'dist', 'build', 'coverage',
  '.next', '.turbo', 'target', '.cache',
]);

function normalizeCommand(command) {
  return String(command || '').trim().replace(/\s+/g, ' ');
}

function normalizeReadRange(range) {
  if (!range) return '';
  if (typeof range === 'string') return range;
  if (Array.isArray(range)) {
    return JSON.stringify(range.map((entry) => ({
      startLine: entry?.startLine ?? null,
      endLine: entry?.endLine ?? null,
    })));
  }
  return `${range.startLine || ''}:${range.endLine || ''}`;
}

function clipHistoryText(value, maxChars) {
  const text = String(value || '').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function compactHistoryEntry(entry) {
  const touchedFiles = Array.isArray(entry?.touchedFiles) ? entry.touchedFiles : [];
  const receipts = Array.isArray(entry?.receipts) ? entry.receipts : [];
  return {
    id: entry?.id || null,
    status: 'closed',
    intent: clipHistoryText(entry?.intent, HISTORY_INTENT_CHARS),
    summary: clipHistoryText(entry?.summary, HISTORY_SUMMARY_CHARS),
    touchedFileCount: touchedFiles.length,
    touchedFiles: touchedFiles.slice(-4).map((filePath) => clipHistoryText(filePath, HISTORY_PATH_CHARS)),
    receiptCount: receipts.length,
    receipts: receipts.slice(-2).map((receipt) => ({
      command: clipHistoryText(receipt?.command, HISTORY_RECEIPT_COMMAND_CHARS),
      exitCode: receipt?.exitCode ?? null,
      status: receipt?.status || null,
    })),
    closedAt: entry?.closedAt || null,
  };
}

function compactSessionState(session) {
  if (!session) return { status: 'no-open-session' };
  const touchedFiles = Array.isArray(session.touchedFiles) ? session.touchedFiles : [];
  const receipts = Array.isArray(session.receipts) ? session.receipts : [];
  const notes = Array.isArray(session.notes) ? session.notes : [];
  return {
    id: session.id || null,
    projectId: session.projectId || null,
    workspaceRoot: session.workspaceRoot || null,
    status: session.status || 'open',
    intent: clipHistoryText(session.intent, HISTORY_INTENT_CHARS),
    touchedFileCount: touchedFiles.length,
    files: touchedFiles.slice(-8).map((entry) => clipHistoryText(entry?.path, HISTORY_PATH_CHARS)),
    receiptCount: receipts.length,
    receipts: receipts.slice(-3).map((receipt) => ({
      command: clipHistoryText(receipt?.command, HISTORY_RECEIPT_COMMAND_CHARS),
      exitCode: receipt?.exitCode ?? null,
      status: receipt?.status || null,
    })),
    noteCount: notes.length,
    notes: notes.slice(-2).map((entry) => clipHistoryText(entry?.text, HISTORY_SUMMARY_CHARS)),
    updatedAt: session.updatedAt || null,
    closedAt: session.closedAt || null,
  };
}

function isReservedStatePath(filePath) {
  const value = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const root = value.split('/')[0] || '';
  return root === '.contextos' || root.startsWith('.contextos-') || root.startsWith('.contextos.');
}

function fallbackWorkspaceFingerprint(projectRoot) {
  const root = path.resolve(projectRoot);
  const hash = crypto.createHash('sha256');
  let fileCount = 0;
  let contentBytes = 0;
  let truncated = false;

  const visit = (directory, relativeDirectory = '') => {
    if (fileCount >= FALLBACK_FINGERPRINT_MAX_FILES) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch (_) {
      truncated = true;
      return;
    }
    for (const entry of entries) {
      const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
      const normalizedRelative = relative.split(path.sep).join('/');
      if (isReservedStatePath(normalizedRelative)) continue;
      if (entry.isDirectory() && FALLBACK_IGNORED_DIRECTORIES.has(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath, relative);
        if (fileCount >= FALLBACK_FINGERPRINT_MAX_FILES) return;
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = fs.statSync(fullPath);
        const normalized = relative.split(path.sep).join('/');
        hash.update(`${normalized}\0${stat.size}\0${stat.mtimeMs}\n`);
        if (stat.size <= FALLBACK_FINGERPRINT_FILE_BYTES
          && contentBytes + stat.size <= FALLBACK_FINGERPRINT_CONTENT_BYTES) {
          hash.update(fs.readFileSync(fullPath));
          contentBytes += stat.size;
        } else {
          hash.update('content-skipped\n');
        }
        fileCount += 1;
      } catch (_) {
        hash.update(`${relative}\0unreadable\n`);
        fileCount += 1;
      }
    }
  };

  visit(root);
  hash.update(`files=${fileCount};contentBytes=${contentBytes};truncated=${truncated}`);
  return hash.digest('hex');
}

function emptySession(projectId, intent, workspaceRoot) {
  const now = new Date().toISOString();
  return {
    id: `sess-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    projectId,
    workspaceRoot,
    status: 'open',
    intent: intent || '',
    intents: intent ? [{ text: intent, at: now }] : [],
    touchedFiles: [],
    receipts: [],
    readReceipts: [],
    searchReceipts: [],
    exploreReceipts: [],
    semanticReceipts: [],
    readPolicy: {
      decisionPackageSeen: false,
      decisionPackageTool: null,
      decisionComplete: false,
      decisionPackageAt: null,
      decisionPackageCount: 0,
      fullExpansions: 0,
      fullExpansionPaths: [],
      directedExpansions: 0,
      directedExpansionPaths: [],
      pathOnlyFullDenied: 0,
      lastPathOnlyFullDeniedAt: null,
    },
    notes: [],
    slots: {},
    startedAt: now,
    updatedAt: now,
    closedAt: null,
    summary: null,
  };
}

export function workspaceFingerprint(projectRoot) {
  const gitStatus = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (gitStatus.status !== 0) return fallbackWorkspaceFingerprint(projectRoot);

  const hash = crypto.createHash('sha256');
  const status = gitStatus.stdout || '';
  // ContextOS writes telemetry, artifacts, sessions, and delivery state under
  // .contextos while it is inspecting the repository. Those derived files
  // must not invalidate source-state receipts or verification caches on every
  // MCP call.
  const sourceStatus = status
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => {
      const paths = line.slice(3).trim().split(' -> ').map((value) => value.trim());
      return paths.every((value) => !isReservedStatePath(value));
    })
    .join('\n');
  hash.update(sourceStatus);

  const diff = spawnSync('git', ['diff', '--binary', 'HEAD', '--', '.', ':(exclude).contextos'], {
    cwd: projectRoot,
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (diff.status === 0 && diff.stdout) hash.update(diff.stdout);

  for (const line of status.split(/\r?\n/)) {
    if (!line.startsWith('?? ')) continue;
    const relative = line.slice(3).trim();
    if (!relative || isReservedStatePath(relative)) continue;
    const fullPath = path.join(projectRoot, relative);
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile() || stat.size > 1024 * 1024) continue;
      hash.update(relative);
      hash.update(fs.readFileSync(fullPath));
    } catch (_) {}
  }

  return hash.digest('hex');
}

/**
 * Working session state for the V3 orchestrator.
 *
 * A session replaces the C-D-C-S task state machine: it is derived from what the
 * agent actually touched (git + edits + receipts), so the agent never has to
 * declare it. Only two states exist: open and closed.
 */
export class SessionStore {
  constructor({ projectRoot, projectId = 'contextos' }) {
    this.projectRoot = projectRoot;
    this.projectId = projectId;
    this.workspaceRoot = path.resolve(projectRoot);
    this.dotDir = path.join(projectRoot, '.contextos');
    this.sessionPath = path.join(this.dotDir, 'session.json');
    this.blackboardPath = path.join(this.dotDir, 'blackboard.md');
    this.historyPath = path.join(this.dotDir, 'logs', 'sessions', 'history.jsonl');
  }

  renderBlackboard(session = this.current) {
    if (!session) {
      return '# ContextOS Blackboard\n- Status: idle (no open session)\n';
    }
    const lines = [
      '# ContextOS Blackboard',
      `- Session: \`${session.id}\` (${session.status})`,
      `- Intent: ${session.intent || '(none)'}`,
    ];
    if (session.touchedFiles.length) {
      const paths = session.touchedFiles.slice(-5).map((f) => `\`${f.path}\``).join(', ');
      lines.push(`- Working Files: ${paths}${session.touchedFiles.length > 5 ? ` (+${session.touchedFiles.length - 5})` : ''}`);
    }
    if (session.receipts.length) {
      const last = session.receipts[session.receipts.length - 1];
      lines.push(`- Last Verify: \`${last.command}\` -> exit ${last.exitCode} (${last.status || 'done'})`);
    }
    if (session.notes.length) {
      const lastNote = session.notes[session.notes.length - 1];
      lines.push(`- Note: ${lastNote.text.slice(0, 100)}`);
    }
    return lines.join('\n') + '\n';
  }

  saveBlackboard(session = this.current) {
    const md = this.renderBlackboard(session);
    try {
      fs.mkdirSync(this.dotDir, { recursive: true });
      fs.writeFileSync(this.blackboardPath, md, 'utf8');
    } catch (_) {}
    return md;
  }

  load() {
    if (!fs.existsSync(this.sessionPath)) return null;
    try {
      const session = JSON.parse(fs.readFileSync(this.sessionPath, 'utf8'));
      // Session state is durable within one workspace, not portable conversation
      // history. A copied checkout/worktree must not inherit an open session's
      // intent, touched files, receipts, or slots from another root.
      if (session?.workspaceRoot !== this.workspaceRoot) return null;
      return session;
    } catch (_) {
      return null;
    }
  }

  save(session) {
    session.updatedAt = new Date().toISOString();
    fs.mkdirSync(this.dotDir, { recursive: true });
    fs.writeFileSync(this.sessionPath, JSON.stringify(session, null, 2) + '\n', 'utf8');
    this.saveBlackboard(session);
    return session;
  }

  get current() {
    const session = this.load();
    return session && session.status === 'open' ? session : null;
  }

  summary(session = this.current) {
    return compactSessionState(session);
  }

  ensureSession(intent = '') {
    const existing = this.current;
    if (existing) {
      if (existing.projectId === 'contextos' && this.projectId && this.projectId !== 'contextos') {
        existing.projectId = this.projectId;
      }
      if (intent && existing.intent !== intent) {
        existing.intents.push({ text: intent, at: new Date().toISOString() });
        existing.intent = intent;
      }
      return this.save(existing);
    }
    return this.save(emptySession(this.projectId, intent, this.workspaceRoot));
  }

  touch(entries = [], source = 'edit') {
    if (!entries.length) return this.current;
    const session = this.ensureSession();
    const now = new Date().toISOString();
    const index = new Map(session.touchedFiles.map((entry) => [entry.path, entry]));
    for (const raw of entries) {
      const entry = typeof raw === 'string' ? { path: raw } : raw;
      if (!entry?.path) continue;
      const existing = index.get(entry.path);
      const effectiveSource = typeof entry.source === 'string' && entry.source ? entry.source : source;
      if (existing) {
        existing.lastTouchedAt = now;
        existing.source = effectiveSource;
        if (entry.deleted === true) {
          existing.deleted = true;
          delete existing.mtimeMs;
          delete existing.size;
        } else {
          delete existing.deleted;
          if (entry.mtimeMs !== undefined) existing.mtimeMs = entry.mtimeMs;
          if (entry.size !== undefined) existing.size = entry.size;
        }
      } else {
        const created = {
          path: entry.path,
          source: effectiveSource,
          firstSeenAt: now,
          lastTouchedAt: now,
          mtimeMs: entry.mtimeMs,
          size: entry.size,
          ...(entry.deleted === true ? { deleted: true } : {}),
        };
        session.touchedFiles.push(created);
        index.set(entry.path, created);
      }
    }
    if (session.touchedFiles.length > MAX_TOUCHED) {
      session.touchedFiles = session.touchedFiles.slice(-MAX_TOUCHED);
    }
    if (Array.isArray(session.readReceipts) && session.readReceipts.length) {
      const changed = new Set(entries.map((entry) => (typeof entry === 'string' ? entry : entry?.path)).filter(Boolean));
      if (changed.size) {
        session.readReceipts = session.readReceipts.filter((entry) => !changed.has(entry.path));
      }
    }
    return this.save(session);
  }

  findReadReceipt({ path: filePath, hash, range = null, symbol = null } = {}) {
    const session = this.current;
    if (!session || !filePath || !hash) return null;
    const rangeKey = normalizeReadRange(range);
    return (session.readReceipts || []).find((entry) => (
      entry.path === filePath
      && entry.hash === hash
      && entry.range === rangeKey
      && (entry.symbol || null) === (symbol || null)
    )) || null;
  }

  findLatestReadReceipt({ path: filePath, range = null, symbol = null } = {}) {
    const session = this.current;
    if (!session || !filePath) return null;
    const rangeKey = normalizeReadRange(range);
    for (let index = (session.readReceipts || []).length - 1; index >= 0; index -= 1) {
      const entry = session.readReceipts[index];
      if (entry.path === filePath
        && entry.range === rangeKey
        && (entry.symbol || null) === (symbol || null)) {
        return entry;
      }
    }
    return null;
  }

  recordReadReceipt({
    path: filePath,
    hash,
    range = null,
    symbol = null,
    receiptId = null,
    artifactId = null,
    mtimeMs = null,
    size = null,
  } = {}) {
    if (!filePath || !hash) return this.current;
    const session = this.ensureSession();
    const rangeKey = normalizeReadRange(range);
    session.readReceipts = (session.readReceipts || []).filter((entry) => !(
      entry.path === filePath
      && entry.range === rangeKey
      && (entry.symbol || null) === (symbol || null)
    ));
    session.readReceipts.push({
      path: filePath,
      hash,
      range: rangeKey,
      symbol: symbol || null,
      receiptId: receiptId || null,
      artifactId: artifactId || null,
      ...(Number.isFinite(Number(mtimeMs)) ? { mtimeMs: Number(mtimeMs) } : {}),
      ...(Number.isFinite(Number(size)) ? { size: Number(size) } : {}),
      at: new Date().toISOString(),
    });
    if (session.readReceipts.length > MAX_READ_RECEIPTS) {
      session.readReceipts = session.readReceipts.slice(-MAX_READ_RECEIPTS);
    }
    return this.save(session);
  }

  readPolicy() {
    const session = this.current;
    return session?.readPolicy || {
      decisionPackageSeen: false,
      decisionPackageTool: null,
      decisionComplete: false,
      decisionPackageAt: null,
      decisionPackageCount: 0,
      fullExpansions: 0,
      fullExpansionPaths: [],
      directedExpansions: 0,
      directedExpansionPaths: [],
      pathOnlyFullDenied: 0,
      lastPathOnlyFullDeniedAt: null,
    };
  }

  markDecisionPackage({ tool = null, status = null, decisionComplete = false, artifactId = null, receiptId = null } = {}) {
    const session = this.ensureSession();
    const current = session.readPolicy || {};
    session.readPolicy = {
      ...current,
      decisionPackageSeen: true,
      decisionPackageTool: tool || current.decisionPackageTool || null,
      decisionComplete: decisionComplete === true,
      decisionPackageAt: new Date().toISOString(),
      decisionPackageCount: (Number(current.decisionPackageCount) || 0) + 1,
      decisionPackageStatus: status || current.decisionPackageStatus || null,
      decisionPackageArtifactId: artifactId || current.decisionPackageArtifactId || null,
      decisionPackageReceiptId: receiptId || current.decisionPackageReceiptId || null,
    };
    return this.save(session);
  }

  resetReadPolicy() {
    const session = this.ensureSession();
    session.readPolicy = {
      decisionPackageSeen: false,
      decisionPackageTool: null,
      decisionComplete: false,
      decisionPackageAt: null,
      decisionPackageCount: 0,
      fullExpansions: 0,
      fullExpansionPaths: [],
      directedExpansions: 0,
      directedExpansionPaths: [],
      pathOnlyFullDenied: 0,
      lastPathOnlyFullDeniedAt: null,
    };
    return this.save(session);
  }

  recordFullExpansion({ path: filePath = null } = {}) {
    const session = this.ensureSession();
    const current = session.readPolicy || {};
    const paths = Array.isArray(current.fullExpansionPaths) ? current.fullExpansionPaths : [];
    session.readPolicy = {
      ...current,
      fullExpansions: (Number(current.fullExpansions) || 0) + 1,
      fullExpansionPaths: filePath
        ? [...paths, String(filePath)].slice(-MAX_FULL_EXPANSION_PATHS)
        : paths,
    };
    return this.save(session);
  }

  recordDirectedExpansion({ path: filePath = null } = {}) {
    const session = this.ensureSession();
    const current = session.readPolicy || {};
    const paths = Array.isArray(current.directedExpansionPaths) ? current.directedExpansionPaths : [];
    session.readPolicy = {
      ...current,
      directedExpansions: (Number(current.directedExpansions) || 0) + 1,
      directedExpansionPaths: filePath
        ? [...paths, String(filePath)].slice(-MAX_DIRECTED_EXPANSION_PATHS)
        : paths,
    };
    return this.save(session);
  }

  recordPathOnlyFullDenied({ path: filePath = null, reason = null } = {}) {
    const session = this.ensureSession();
    const current = session.readPolicy || {};
    session.readPolicy = {
      ...current,
      pathOnlyFullDenied: (Number(current.pathOnlyFullDenied) || 0) + 1,
      lastPathOnlyFullDeniedAt: new Date().toISOString(),
      lastPathOnlyFullDeniedPath: filePath ? String(filePath) : current.lastPathOnlyFullDeniedPath || null,
      lastPathOnlyFullDeniedReason: reason || current.lastPathOnlyFullDeniedReason || null,
    };
    return this.save(session);
  }

  invalidateReadReceipts(paths = null) {
    const session = this.current;
    if (!session || !Array.isArray(session.readReceipts)) return session;
    const targets = paths == null
      ? null
      : new Set((Array.isArray(paths) ? paths : [paths]).filter(Boolean));
    const next = session.readReceipts.filter((entry) => !targets || targets.has(entry.path));
    if (next.length === session.readReceipts.length) return session;
    session.readReceipts = next;
    return this.save(session);
  }

  findSearchReceipt({ key, revision = null } = {}) {
    const session = this.current;
    if (!session || !key || !Array.isArray(session.searchReceipts)) return null;
    for (let index = session.searchReceipts.length - 1; index >= 0; index -= 1) {
      const entry = session.searchReceipts[index];
      if (entry.key === key && entry.revision === revision) return entry;
    }
    return null;
  }

  recordSearchReceipt({ key, revision = null, receiptId = null, artifactId = null } = {}) {
    if (!key) return this.current;
    const session = this.ensureSession();
    session.searchReceipts = (session.searchReceipts || []).filter((entry) => entry.key !== key);
    session.searchReceipts.push({
      key: String(key).slice(0, 800),
      revision: revision == null ? null : String(revision),
      receiptId: receiptId || null,
      artifactId: artifactId || null,
      at: new Date().toISOString(),
    });
    if (session.searchReceipts.length > MAX_SEARCH_RECEIPTS) {
      session.searchReceipts = session.searchReceipts.slice(-MAX_SEARCH_RECEIPTS);
    }
    return this.save(session);
  }

  invalidateSearchReceipts() {
    const session = this.current;
    if (!session || !Array.isArray(session.searchReceipts) || !session.searchReceipts.length) return session;
    session.searchReceipts = [];
    return this.save(session);
  }

  findSemanticReceipt({ key } = {}) {
    const session = this.current;
    if (!session || !key || !Array.isArray(session.semanticReceipts)) return null;
    for (let index = session.semanticReceipts.length - 1; index >= 0; index -= 1) {
      const entry = session.semanticReceipts[index];
      if (entry.key === key) return entry;
    }
    return null;
  }

  recordSemanticReceipt({ key, capability, action, hash = null, fullChars = 0, artifactId = null } = {}) {
    if (!key) return this.current;
    const session = this.ensureSession();
    session.semanticReceipts = (session.semanticReceipts || []).filter((entry) => entry.key !== key);
    session.semanticReceipts.push({
      key: String(key).slice(0, 240),
      capability: capability || null,
      action: action || null,
      hash: hash || null,
      fullChars: Number(fullChars) || 0,
      artifactId: artifactId || null,
      at: new Date().toISOString(),
    });
    if (session.semanticReceipts.length > MAX_SEMANTIC_RECEIPTS) {
      session.semanticReceipts = session.semanticReceipts.slice(-MAX_SEMANTIC_RECEIPTS);
    }
    return this.save(session);
  }

  invalidateSemanticReceipts() {
    const session = this.current;
    if (!session || !Array.isArray(session.semanticReceipts) || !session.semanticReceipts.length) return session;
    session.semanticReceipts = [];
    return this.save(session);
  }

  findExploreReceipt({ key, revision = null } = {}) {
    const session = this.current;
    if (!session || !key || !Array.isArray(session.exploreReceipts)) return null;
    for (let index = session.exploreReceipts.length - 1; index >= 0; index -= 1) {
      const entry = session.exploreReceipts[index];
      if (entry.key === key && entry.revision === revision) return entry;
    }
    return null;
  }

  recordExploreReceipt({ key, revision = null, receiptId = null, artifactId = null } = {}) {
    if (!key) return this.current;
    const session = this.ensureSession();
    session.exploreReceipts = (session.exploreReceipts || []).filter((entry) => entry.key !== key);
    session.exploreReceipts.push({
      key: String(key).slice(0, 800),
      revision: revision == null ? null : String(revision),
      receiptId: receiptId || null,
      artifactId: artifactId || null,
      at: new Date().toISOString(),
    });
    if (session.exploreReceipts.length > MAX_EXPLORE_RECEIPTS) {
      session.exploreReceipts = session.exploreReceipts.slice(-MAX_EXPLORE_RECEIPTS);
    }
    return this.save(session);
  }

  attachReceipt(receipt) {
    if (!receipt) return this.current;
    const session = this.ensureSession();
    const commandKey = normalizeCommand(receipt.command);
    const cwd = receipt.cwd || null;
    const resolvedAt = new Date().toISOString();

    if (receipt.exitCode === 0) {
      for (const previous of session.receipts) {
        const sameCommand = normalizeCommand(previous.command) === commandKey;
        const sameCwd = !previous.cwd || !cwd || previous.cwd === cwd;
        if (previous.exitCode !== 0 && previous.status !== 'superseded' && sameCommand && sameCwd) {
          previous.status = 'superseded';
          previous.supersededBy = receipt.id || null;
          previous.resolvedAt = resolvedAt;
        }
      }
    }

    session.receipts.push({
      id: receipt.id || null,
      command: receipt.command || null,
      cwd,
      exitCode: receipt.exitCode,
      status: receipt.exitCode === 0 ? 'passed' : 'unresolved',
      durationMs: receipt.durationMs,
      stateHash: receipt.stateHash || null,
      at: resolvedAt,
    });
    if (session.receipts.length > MAX_RECEIPTS) {
      session.receipts = session.receipts.slice(-MAX_RECEIPTS);
    }
    return this.save(session);
  }

  /**
   * Return a passing receipt that is still valid for the current source state.
   * A receipt is stale as soon as a tracked file was touched after it ran.
   */
  currentPassingReceipt(command, cwd = null, fingerprint = null) {
    const session = this.current;
    if (!session || !fingerprint) return null;
    const commandKey = normalizeCommand(command);
    const latestTouch = session.touchedFiles.reduce((latest, entry) => {
      const at = entry.lastTouchedAt || entry.firstSeenAt || '';
      return at > latest ? at : latest;
    }, '');
    for (let index = session.receipts.length - 1; index >= 0; index -= 1) {
      const receipt = session.receipts[index];
      if (receipt.exitCode !== 0 || receipt.status !== 'passed') continue;
      if (normalizeCommand(receipt.command) !== commandKey) continue;
      if (receipt.cwd && cwd && receipt.cwd !== cwd) continue;
      if (!receipt.stateHash || receipt.stateHash !== fingerprint) continue;
      if (receipt.at && latestTouch && latestTouch > receipt.at) continue;
      return receipt;
    }
    return null;
  }

  /**
   * Return a receipt from a closed session by id. This deliberately does not
   * claim that the evidence is still valid; callers must validate its command,
   * status, cwd, and workspace fingerprint before importing it.
   */
  findHistoricalReceipt(receiptId) {
    if (!receiptId) return null;
    const expectedId = String(receiptId);
    const history = this.recentHistory(MAX_HISTORY_LIMIT, { full: true });
    for (const session of history) {
      const receipts = Array.isArray(session?.receipts) ? session.receipts : [];
      for (let index = receipts.length - 1; index >= 0; index -= 1) {
        const receipt = receipts[index];
        if (String(receipt?.id || '') === expectedId) return receipt;
      }
    }
    return null;
  }

  /**
   * Find a passing receipt from a closed session that still proves the current
   * workspace state. Callers must provide the current fingerprint so history
   * cannot become an unbounded source of stale evidence.
   */
  findHistoricalPassingReceipt(receiptId, { cwd = null, fingerprint = null } = {}) {
    const receipt = this.findHistoricalReceipt(receiptId);
    if (!receipt || receipt.exitCode !== 0 || receipt.status !== 'passed') return null;
    if (cwd && receipt.cwd && path.resolve(receipt.cwd) !== path.resolve(cwd)) return null;
    if (fingerprint && receipt.stateHash !== fingerprint) return null;
    return receipt;
  }

  note(text, kind = 'note') {
    if (!text) return this.current;
    const session = this.ensureSession();
    session.notes.push({ text, kind, at: new Date().toISOString() });
    if (session.notes.length > MAX_NOTES) {
      session.notes = session.notes.slice(-MAX_NOTES);
    }
    return this.save(session);
  }

  setSlots(slots = {}) {
    const session = this.ensureSession();
    session.slots = { ...(session.slots || {}), ...slots };
    return this.save(session);
  }

  getSlot(slotKey) {
    const session = this.current;
    if (!session || !session.slots) return null;
    return session.slots[slotKey] || null;
  }

  close(summary = '') {
    const session = this.ensureSession();
    session.status = 'closed';
    session.closedAt = new Date().toISOString();
    session.summary = summary || session.intent;
    this.save(session);

    fs.mkdirSync(path.dirname(this.historyPath), { recursive: true });
    fs.appendFileSync(
      this.historyPath,
      JSON.stringify({
        id: session.id,
        intent: session.intent,
        summary: session.summary,
        touchedFiles: session.touchedFiles.map((entry) => entry.path),
        receipts: session.receipts,
        closedAt: session.closedAt,
      }) + '\n',
      'utf8'
    );
    return session;
  }

  recentHistory(limit = DEFAULT_HISTORY_LIMIT, { sessionId = null, full = false } = {}) {
    if (!fs.existsSync(this.historyPath)) return [];
    const lines = fs.readFileSync(this.historyPath, 'utf8').split('\n').filter(Boolean);
    const parsed = [];
    const requestedLimit = Number(limit);
    const boundedLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(MAX_HISTORY_LIMIT, Math.floor(requestedLimit))
      : DEFAULT_HISTORY_LIMIT;
    const selected = sessionId == null
      ? lines.slice(-boundedLimit)
      : lines;
    for (const line of selected) {
      try {
        const entry = JSON.parse(line);
        if (sessionId == null || entry?.id === String(sessionId)) parsed.push(entry);
      } catch (_) {}
    }
    const recent = parsed.slice(-boundedLimit).reverse();
    return full ? recent : recent.map(compactHistoryEntry);
  }
}
