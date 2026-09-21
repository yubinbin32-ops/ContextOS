import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_TOUCHED = 200;
const MAX_RECEIPTS = 50;
const MAX_NOTES = 100;

function normalizeCommand(command) {
  return String(command || '').trim().replace(/\s+/g, ' ');
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
    notes: [],
    startedAt: now,
    updatedAt: now,
    closedAt: null,
    summary: null,
  };
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
    this.historyPath = path.join(this.dotDir, 'logs', 'sessions', 'history.jsonl');
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
      if (existing) {
        existing.lastTouchedAt = now;
        existing.source = source;
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
          source,
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
      at: resolvedAt,
    });
    if (session.receipts.length > MAX_RECEIPTS) {
      session.receipts = session.receipts.slice(-MAX_RECEIPTS);
    }
    return this.save(session);
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
