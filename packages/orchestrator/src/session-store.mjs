import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const MAX_TOUCHED = 200;
const MAX_RECEIPTS = 50;
const MAX_NOTES = 100;
const MAX_READ_RECEIPTS = 200;

function normalizeCommand(command) {
  return String(command || '').trim().replace(/\s+/g, ' ');
}

function normalizeReadRange(range) {
  if (!range) return '';
  if (typeof range === 'string') return range;
  return `${range.startLine || ''}:${range.endLine || ''}`;
}

function emptySession(projectId, intent) {
  const now = new Date().toISOString();
  return {
    id: `sess-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    projectId,
    status: 'open',
    intent: intent || '',
    intents: intent ? [{ text: intent, at: now }] : [],
    touchedFiles: [],
    receipts: [],
    readReceipts: [],
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
  if (gitStatus.status !== 0) return null;

  const hash = crypto.createHash('sha256');
  const status = gitStatus.stdout || '';
  hash.update(status);

  const diff = spawnSync('git', ['diff', '--binary', 'HEAD', '--', '.', ':(exclude).contextos'], {
    cwd: projectRoot,
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (diff.status === 0 && diff.stdout) hash.update(diff.stdout);

  for (const line of status.split(/\r?\n/)) {
    if (!line.startsWith('?? ')) continue;
    const relative = line.slice(3).trim();
    if (!relative || relative.startsWith('.contextos/')) continue;
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
      return JSON.parse(fs.readFileSync(this.sessionPath, 'utf8'));
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
    return this.save(emptySession(this.projectId, intent));
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

  recordReadReceipt({ path: filePath, hash, range = null, symbol = null, receiptId = null } = {}) {
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
      at: new Date().toISOString(),
    });
    if (session.readReceipts.length > MAX_READ_RECEIPTS) {
      session.readReceipts = session.readReceipts.slice(-MAX_READ_RECEIPTS);
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

  recentHistory(limit = 3) {
    if (!fs.existsSync(this.historyPath)) return [];
    const lines = fs.readFileSync(this.historyPath, 'utf8').split('\n').filter(Boolean);
    const parsed = [];
    for (const line of lines.slice(-limit)) {
      try {
        parsed.push(JSON.parse(line));
      } catch (_) {}
    }
    return parsed.reverse();
  }
}
