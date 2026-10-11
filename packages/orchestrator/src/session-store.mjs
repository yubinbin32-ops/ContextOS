import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const MAX_TOUCHED = 200;
const MAX_RECEIPTS = 50;
const MAX_NOTES = 100;
const MAX_READ_RECEIPTS = 200;
const MAX_SEARCH_RECEIPTS = 100;
const MAX_EXPLORE_RECEIPTS = 50;
const MAX_SEMANTIC_RECEIPTS = 80;
const MAX_FULL_EXPANSION_PATHS = 12;
const MAX_DIRECTED_EXPANSION_PATHS = 12;
const MAX_EVIDENCE_MEMORY_HANDLES = 5;
const MAX_SUBAGENT_MEMORY_HANDLES = 3;
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

function normalizeSessionPath(filePath) {
  return String(filePath || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function sameWorkspaceRoot(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch (_) {
    return path.resolve(left) === path.resolve(right);
  }
}

function readProjectIdFromDisk(dotDir) {
  if (!dotDir) return null;
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dotDir, 'project.json'), 'utf8'));
    return typeof marker?.id === 'string' && marker.id.trim() ? marker.id.trim() : null;
  } catch (_) {
    return null;
  }
}

function normalizeMemoryHandle(handle) {
  if (!handle || typeof handle !== 'object' || Array.isArray(handle)) return null;
  const at = typeof handle.at === 'string' && handle.at ? handle.at : new Date().toISOString();
  if (typeof handle.resultId === 'string' && handle.resultId.trim()) {
    const paths = [...new Set((Array.isArray(handle.paths) ? handle.paths : [])
      .map(normalizeSessionPath)
      .filter(Boolean))];
    const contentHashes = Array.isArray(handle.contentHashes)
      ? [...new Set(handle.contentHashes.map((h) => String(h || '').trim()).filter(Boolean))]
      : (handle.contentHashes && typeof handle.contentHashes === 'object'
          ? { ...handle.contentHashes }
          : []);
    return {
      resultId: handle.resultId.trim(),
      paths,
      contentHashes,
      at,
    };
  }
  if ((handle.kind === 'cli' || handle.kind === 'micro') && typeof handle.sessionId === 'string' && handle.sessionId.trim()) {
    return {
      kind: handle.kind,
      sessionId: handle.sessionId.trim(),
      at,
    };
  }
  return null;
}

function normalizeMemoryHandles(handles) {
  if (!Array.isArray(handles)) return [];
  const normalized = handles.map(normalizeMemoryHandle).filter(Boolean);
  const evidence = [];
  const subagent = [];
  for (const item of normalized) {
    if (item.resultId) {
      const idx = evidence.findIndex((entry) => entry.resultId === item.resultId);
      if (idx !== -1) evidence.splice(idx, 1);
      evidence.push(item);
    } else if (item.kind && item.sessionId) {
      const idx = subagent.findIndex((entry) => entry.kind === item.kind && entry.sessionId === item.sessionId);
      if (idx !== -1) subagent.splice(idx, 1);
      subagent.push(item);
    }
  }
  const keptEvidence = new Set(evidence.slice(-MAX_EVIDENCE_MEMORY_HANDLES));
  const keptSubagent = new Set(subagent.slice(-MAX_SUBAGENT_MEMORY_HANDLES));
  const result = [];
  for (const item of normalized) {
    if (keptEvidence.has(item) || keptSubagent.has(item)) result.push(item);
  }
  return result;
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

function compactSessionState(session, { dotDir = null, projectId = null } = {}) {
  if (!session) return { status: 'no-open-session' };
  const touchedFiles = Array.isArray(session.touchedFiles) ? session.touchedFiles : [];
  const receipts = Array.isArray(session.receipts) ? session.receipts : [];
  const notes = Array.isArray(session.notes) ? session.notes : [];
  const memoryHandles = normalizeMemoryHandles(session.memoryHandles);
  const effectiveDotDir = dotDir || (session.workspaceRoot ? path.join(session.workspaceRoot, '.contextos') : null);
  const effectiveProjectId = projectId || session.projectId || readProjectIdFromDisk(effectiveDotDir) || 'contextos';
  const tracking = effectiveDotDir ? activeTrackingContext(effectiveDotDir, effectiveProjectId) : null;
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
    memoryHandles,
    tracking: tracking || null,
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
    memoryHandles: [],
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
// The blackboard is the resumption surface: an agent that reopens the project
// must see the active plan, the rules that plan is bound to, and the task in
// flight without spending a request. Read the runtime state read-only and fall
// back to a bare blackboard when no active plan exists.
const trackingCache = new Map();
function readTrackingContext(dotDir, projectId) {
  const dbPath = path.join(dotDir, 'state.sqlite');
  if (!fs.existsSync(dbPath)) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const byProject = db.prepare("SELECT id,title,status,rule_refs_json AS ruleRefs FROM plans WHERE project_id=? AND status='active' ORDER BY updated_at DESC,id LIMIT 1").get(projectId);
    const plan = byProject || db.prepare("SELECT id,title,status,rule_refs_json AS ruleRefs FROM plans WHERE status='active' ORDER BY updated_at DESC,id LIMIT 1").get();
    if (!plan) return null;
    const task = db.prepare("SELECT id,title,status FROM tasks WHERE plan_id=? AND status IN ('active','checking','syncing','pending','draft','blocked') ORDER BY CASE WHEN status IN ('active','checking','syncing') THEN 0 ELSE 1 END,updated_at DESC LIMIT 1").get(plan.id);
    let ruleRefs = [];
    try { ruleRefs = JSON.parse(plan.ruleRefs || '[]'); } catch { ruleRefs = []; }
    return {
      plan: { id: plan.id, title: plan.title, status: plan.status },
      rules: (Array.isArray(ruleRefs) ? ruleRefs : []).map((rule) => String(rule)).filter(Boolean).slice(0, 6),
      task: task ? { id: task.id, title: task.title, status: task.status } : null,
    };
  } catch { return null; } finally { try { db?.close(); } catch {} }
}
function activeTrackingContext(dotDir, projectId) {
  if (!dotDir) return null;
  let dbStamp = 'missing';
  try {
    const dbStat = fs.statSync(path.join(dotDir, 'state.sqlite'));
    let walStamp = '';
    try {
      const walStat = fs.statSync(path.join(dotDir, 'state.sqlite-wal'));
      walStamp = `:${walStat.size}:${walStat.mtimeMs}`;
    } catch {}
    dbStamp = `${dbStat.size}:${dbStat.mtimeMs}${walStamp}`;
  } catch {
    return null;
  }
  const key = `${dotDir}::${projectId}::${dbStamp}`;
  const cached = trackingCache.get(key);
  if (cached && Date.now() - cached.at < 5000) return cached.value;
  let value = null;
  try { value = readTrackingContext(dotDir, projectId); } catch { value = null; }
  trackingCache.set(key, { at: Date.now(), value });
  while (trackingCache.size > 16) trackingCache.delete(trackingCache.keys().next().value);
  return value;
}

export class SessionStore {
  constructor({ projectRoot, projectId = null }) {
    this.projectRoot = projectRoot;
    this.workspaceRoot = path.resolve(projectRoot);
    this.dotDir = path.join(projectRoot, '.contextos');
    this.projectId = projectId || readProjectIdFromDisk(this.dotDir) || 'contextos';
    this.sessionPath = path.join(this.dotDir, 'session.json');
    this.blackboardPath = path.join(this.dotDir, 'blackboard.md');
    this.historyPath = path.join(this.dotDir, 'logs', 'sessions', 'history.jsonl');
  }

  renderBlackboard(session = this.current) {
    const state = compactSessionState(session, {
      dotDir: this.dotDir,
      projectId: session?.projectId || this.projectId,
    });
    if (!session || state.status === 'no-open-session') {
      return '# ContextOS Blackboard\n- Status: idle (no open session)\n';
    }
    const lines = [
      '# ContextOS Blackboard',
      `- Session: \`${state.id}\` (${state.status})`,
      `- Intent: ${session.intent || '(none)'}`,
    ];
    if (session.touchedFiles?.length) {
      const paths = session.touchedFiles.slice(-5).map((f) => `\`${f.path}\``).join(', ');
      lines.push(`- Working Files: ${paths}${session.touchedFiles.length > 5 ? ` (+${session.touchedFiles.length - 5})` : ''}`);
    }
    if (session.receipts?.length) {
      const last = session.receipts[session.receipts.length - 1];
      lines.push(`- Last Verify: \`${last.command}\` -> exit ${last.exitCode} (${last.status || 'done'})`);
    }
    if (session.notes?.length) {
      const lastNote = session.notes[session.notes.length - 1];
      lines.push(`- Note: ${lastNote.text.slice(0, 100)}`);
    }
    if (state.memoryHandles?.length) {
      const handlesText = state.memoryHandles.map((handle) => {
        if (handle.resultId) {
          const paths = Array.isArray(handle.paths) && handle.paths.length
            ? ` [${handle.paths.slice(0, 3).join(', ')}${handle.paths.length > 3 ? `, +${handle.paths.length - 3}` : ''}]`
            : '';
          return `\`${handle.resultId}\`${paths}`;
        }
        if (handle.kind && handle.sessionId) {
          return `\`${handle.kind}:${handle.sessionId}\``;
        }
        return null;
      }).filter(Boolean);
      if (handlesText.length) {
        lines.push(`- Memory Handles: ${handlesText.join(', ')}`);
      }
    }
    const tracking = state.tracking;
    if (tracking?.plan) {
      lines.push(`- Active Plan: \`${tracking.plan.id}\` ${String(tracking.plan.title || '').slice(0, 120)} (${tracking.plan.status})`);
      lines.push(tracking.rules.length
        ? `- Plan Rules: ${tracking.rules.map((rule) => `\`${rule}\``).join(', ')}`
        : '- Plan Rules: (none bound) - bind project rules before implementing or the work will drift from them.');
    }
    if (tracking?.task) {
      lines.push(`- Active Task: \`${tracking.task.id}\` ${String(tracking.task.title || '').slice(0, 120)} (${tracking.task.status})`);
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
      if (!sameWorkspaceRoot(session?.workspaceRoot, this.workspaceRoot)) return null;
      if (!Array.isArray(session.memoryHandles)) session.memoryHandles = [];
      return session;
    } catch (_) {
      return null;
    }
  }

  save(session, { syncBlackboard = true } = {}) {
    session.updatedAt = new Date().toISOString();
    if (!Array.isArray(session.memoryHandles)) session.memoryHandles = [];
    fs.mkdirSync(this.dotDir, { recursive: true });
    fs.writeFileSync(this.sessionPath, JSON.stringify(session, null, 2) + '\n', 'utf8');
    if (syncBlackboard) {
      this.saveBlackboard(session);
    }
    return session;
  }

  get current() {
    const session = this.load();
    return session && session.status === 'open' ? session : null;
  }

  summary(session = this.current) {
    return compactSessionState(session, {
      dotDir: this.dotDir,
      projectId: session?.projectId || this.projectId,
    });
  }

  ensureSession(intent = '', { syncBlackboard = true } = {}) {
    const existing = this.current;
    if (existing) {
      if (existing.projectId === 'contextos' && this.projectId && this.projectId !== 'contextos') {
        existing.projectId = this.projectId;
      }
      if (intent && existing.intent !== intent) {
        existing.intents.push({ text: intent, at: new Date().toISOString() });
        existing.intent = intent;
      }
      return this.save(existing, { syncBlackboard });
    }
    return this.save(emptySession(this.projectId, intent, this.workspaceRoot), { syncBlackboard });
  }

  recordMemoryHandle(handle = {}) {
    const normalized = normalizeMemoryHandle(handle);
    if (!normalized) return this.current;
    const session = this.ensureSession('', { syncBlackboard: false });
    session.memoryHandles = normalizeMemoryHandles([...(session.memoryHandles || []), normalized]);
    return this.save(session, { syncBlackboard: true });
  }

  touch(entries = [], source = 'edit') {
    if (!entries.length) return this.current;
    const session = this.ensureSession('', { syncBlackboard: false });
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
    const changed = new Set(entries
      .map((entry) => normalizeSessionPath(typeof entry === 'string' ? entry : entry?.path))
      .filter(Boolean));
    if (changed.size) {
      if (Array.isArray(session.readReceipts) && session.readReceipts.length) {
        session.readReceipts = session.readReceipts.filter((entry) => !changed.has(normalizeSessionPath(entry.path)));
      }
      if (Array.isArray(session.memoryHandles) && session.memoryHandles.length) {
        session.memoryHandles = session.memoryHandles.filter((entry) => {
          if (!entry || !Array.isArray(entry.paths)) return true;
          return !entry.paths.some((p) => changed.has(normalizeSessionPath(p)));
        });
      }
    }
    return this.save(session, { syncBlackboard: true });
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
    const session = this.ensureSession('', { syncBlackboard: false });
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
    return this.save(session, { syncBlackboard: false });
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
    const session = this.ensureSession('', { syncBlackboard: false });
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
    return this.save(session, { syncBlackboard: false });
  }

  resetReadPolicy() {
    const session = this.ensureSession('', { syncBlackboard: false });
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
    return this.save(session, { syncBlackboard: false });
  }

  recordFullExpansion({ path: filePath = null } = {}) {
    const session = this.ensureSession('', { syncBlackboard: false });
    const current = session.readPolicy || {};
    const paths = Array.isArray(current.fullExpansionPaths) ? current.fullExpansionPaths : [];
    session.readPolicy = {
      ...current,
      fullExpansions: (Number(current.fullExpansions) || 0) + 1,
      fullExpansionPaths: filePath
        ? [...paths, String(filePath)].slice(-MAX_FULL_EXPANSION_PATHS)
        : paths,
    };
    return this.save(session, { syncBlackboard: false });
  }

  recordDirectedExpansion({ path: filePath = null } = {}) {
    const session = this.ensureSession('', { syncBlackboard: false });
    const current = session.readPolicy || {};
    const paths = Array.isArray(current.directedExpansionPaths) ? current.directedExpansionPaths : [];
    session.readPolicy = {
      ...current,
      directedExpansions: (Number(current.directedExpansions) || 0) + 1,
      directedExpansionPaths: filePath
        ? [...paths, String(filePath)].slice(-MAX_DIRECTED_EXPANSION_PATHS)
        : paths,
    };
    return this.save(session, { syncBlackboard: false });
  }

  recordPathOnlyFullDenied({ path: filePath = null, reason = null } = {}) {
    const session = this.ensureSession('', { syncBlackboard: false });
    const current = session.readPolicy || {};
    session.readPolicy = {
      ...current,
      pathOnlyFullDenied: (Number(current.pathOnlyFullDenied) || 0) + 1,
      lastPathOnlyFullDeniedAt: new Date().toISOString(),
      lastPathOnlyFullDeniedPath: filePath ? String(filePath) : current.lastPathOnlyFullDeniedPath || null,
      lastPathOnlyFullDeniedReason: reason || current.lastPathOnlyFullDeniedReason || null,
    };
    return this.save(session, { syncBlackboard: false });
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
    return this.save(session, { syncBlackboard: false });
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
    const session = this.ensureSession('', { syncBlackboard: false });
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
    return this.save(session, { syncBlackboard: false });
  }

  invalidateSearchReceipts() {
    const session = this.current;
    if (!session || !Array.isArray(session.searchReceipts) || !session.searchReceipts.length) return session;
    session.searchReceipts = [];
    return this.save(session, { syncBlackboard: false });
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
    const session = this.ensureSession('', { syncBlackboard: false });
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
    return this.save(session, { syncBlackboard: false });
  }

  invalidateSemanticReceipts() {
    const session = this.current;
    if (!session || !Array.isArray(session.semanticReceipts) || !session.semanticReceipts.length) return session;
    session.semanticReceipts = [];
    return this.save(session, { syncBlackboard: false });
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
    const session = this.ensureSession('', { syncBlackboard: false });
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
    return this.save(session, { syncBlackboard: false });
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
    const session = this.ensureSession('', { syncBlackboard: false });
    session.slots = { ...(session.slots || {}), ...slots };
    return this.save(session, { syncBlackboard: false });
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
