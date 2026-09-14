import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

export class ProcessManager {
  constructor({ projectRoot = process.cwd() } = {}) {
    this.projectRoot = path.resolve(projectRoot);
    this.sessions = new Map();
  }

  async startProcess({
    command,
    cwd = this.projectRoot,
    env = process.env,
    readyRegex = null,
    portRegex = null,
  }) {
    const sessionId = `proc-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const logDir = path.join(this.projectRoot, '.contextos', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `${sessionId}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });

    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const session = {
      id: sessionId,
      command,
      cwd,
      pid: child.pid,
      pgid: child.pid,
      status: 'starting',
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      exitCode: null,
      port: null,
      url: null,
      logFile,
      child,
    };

    this.sessions.set(sessionId, session);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      logStream.write(chunk);

      if (portRegex && !session.port) {
        const match = text.match(new RegExp(portRegex));
        if (match && match[1]) session.port = parseInt(match[1], 10);
      }
      if (text.match(/http:\/\/localhost:(\d+)|http:\/\/127\.0\.0\.1:(\d+)/)) {
        const urlMatch = text.match(/https?:\/\/[a-zA-Z0-9.:_-]+/);
        if (urlMatch) session.url = urlMatch[0];
      }
      if (readyRegex && text.match(new RegExp(readyRegex))) {
        session.status = 'ready';
      }
    });

    child.stderr.on('data', (chunk) => {
      logStream.write(chunk);
    });

    child.on('close', (code) => {
      session.status = 'stopped';
      session.exitCode = code;
      session.stoppedAt = new Date().toISOString();
      logStream.end();
    });

    child.on('error', (err) => {
      session.status = 'error';
      session.error = err.message;
      session.stoppedAt = new Date().toISOString();
      logStream.end();
    });

    // Short grace wait to see if it immediately fails or stays running
    await new Promise((r) => setTimeout(r, 200));
    if (session.status === 'starting') {
      session.status = 'running';
    }

    return this._sessionSummary(session);
  }

  listProcesses() {
    return Array.from(this.sessions.values()).map(this._sessionSummary);
  }

  getProcess(sessionId) {
    const session = this.sessions.get(sessionId);
    return session ? this._sessionSummary(session) : null;
  }

  getLogs(sessionId, { lines = 100, grep = null, startLine = null, endLine = null } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Process session '${sessionId}' not found`);

    if (!fs.existsSync(session.logFile)) {
      return { lines: [], total: 0 };
    }

    const content = fs.readFileSync(session.logFile, 'utf8');
    let allLines = content.split(/\r?\n/);

    if (grep) {
      const query = grep.toLowerCase();
      allLines = allLines.filter((l) => l.toLowerCase().includes(query));
    }

    if (startLine !== null && endLine !== null) {
      const start = Math.max(0, startLine - 1);
      const end = Math.min(allLines.length, endLine);
      allLines = allLines.slice(start, end);
    } else if (lines > 0) {
      allLines = allLines.slice(-lines);
    }

    return {
      sessionId,
      lines: allLines,
      total: allLines.length,
      logFile: path.relative(this.projectRoot, session.logFile),
    };
  }

  async stopProcess(sessionId, { graceMs = 2000 } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Process session '${sessionId}' not found`);

    if (session.status === 'stopped' || session.status === 'error') {
      return this._sessionSummary(session);
    }

    const pgid = session.pgid;
    try {
      // Send SIGTERM to entire process group
      process.kill(-pgid, 'SIGTERM');
    } catch (_) {
      try {
        session.child?.kill('SIGTERM');
      } catch (_) {}
    }

    // Wait for process exit or timeout
    const start = Date.now();
    while (session.status !== 'stopped' && Date.now() - start < graceMs) {
      await new Promise((r) => setTimeout(r, 100));
    }

    // If still not stopped, send SIGKILL
    if (session.status !== 'stopped') {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch (_) {
        try {
          session.child?.kill('SIGKILL');
        } catch (_) {}
      }
      session.status = 'stopped';
      session.stoppedAt = new Date().toISOString();
    }

    return this._sessionSummary(session);
  }

  clearStopped() {
    for (const [id, session] of this.sessions.entries()) {
      if (session.status === 'stopped' || session.status === 'error') {
        this.sessions.delete(id);
      }
    }
  }

  async stopAll() {
    for (const session of this.sessions.values()) {
      if (session.status === 'running' || session.status === 'starting' || session.status === 'ready') {
        try {
          await this.stopProcess(session.id, { graceMs: 500 });
        } catch (_) {}
      }
    }
  }

  _sessionSummary(s) {
    return {
      id: s.id,
      command: s.command,
      pid: s.pid,
      status: s.status,
      startedAt: s.startedAt,
      stoppedAt: s.stoppedAt,
      exitCode: s.exitCode,
      port: s.port,
      url: s.url,
      logFile: s.logFile,
    };
  }
}
