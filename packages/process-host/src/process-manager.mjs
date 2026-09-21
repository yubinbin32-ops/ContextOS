import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { ensureLogDir, pruneLogDir, secureLogFile } from './log-store.mjs';

export class ProcessManager {
  constructor({ projectRoot = process.cwd() } = {}) {
    this.projectRoot = path.resolve(projectRoot);
    this.sessions = new Map();
    this._healZombieProcesses();
  }

  _healZombieProcesses() {
    try {
      const procFile = path.join(this.projectRoot, '.contextos', 'processes.json');
      if (!fs.existsSync(procFile)) return;
      const data = JSON.parse(fs.readFileSync(procFile, 'utf8'));
      if (!Array.isArray(data)) return;

      let hasChanges = false;
      for (const item of data) {
        if (!item || !item.id) continue;
        const pid = item.pid;
        let isAlive = false;
        if (pid) {
          try {
            process.kill(pid, 0);
            isAlive = true;
          } catch (_) {
            isAlive = false;
          }
        }

        if (isAlive) {
          this.sessions.set(item.id, {
            id: item.id,
            command: item.command,
            cwd: item.cwd || this.projectRoot,
            pid: item.pid,
            pgid: item.pid,
            status: item.status || 'running',
            startedAt: item.startedAt || new Date().toISOString(),
            stoppedAt: null,
            exitCode: null,
            port: item.port || null,
            url: item.url || null,
            logFile: item.logFile || path.join(this.projectRoot, '.contextos', 'logs', `${item.id}.log`),
            child: null,
          });
        } else {
          hasChanges = true;
        }
      }

      if (hasChanges) {
        this._persistProcesses();
      }
    } catch (_) {}
  }

  async startProcess({
    id = null,
    command,
    cwd = this.projectRoot,
    env = process.env,
    readyRegex = null,
    portRegex = null,
  }) {
    const sessionId = id || `proc-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    if (this.sessions.has(sessionId)) {
      throw new Error(`Process session '${sessionId}' already exists`);
    }
    const logDir = ensureLogDir(this.projectRoot);
    pruneLogDir(logDir);
    const logFile = path.join(logDir, `${sessionId}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: 'a', mode: 0o600 });
    logStream.on('open', () => secureLogFile(logFile));

    const isWin = process.platform === 'win32';
    const shell = isWin ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
    const shellArgs = isWin ? ['/d', '/s', '/c', command] : ['-c', command];

    const child = spawn(shell, shellArgs, {
      cwd,
      env,
      detached: !isWin,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: isWin,
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
      this._persistProcesses();
    });

    child.on('error', (err) => {
      session.status = 'error';
      session.error = err.message;
      session.stoppedAt = new Date().toISOString();
      logStream.end();
      this._persistProcesses();
    });

    // Short grace wait to see if it immediately fails or stays running
    await new Promise((r) => setTimeout(r, 200));
    if (session.status === 'starting') {
      session.status = 'running';
    }
    this._persistProcesses();

    return this._sessionSummary(session);
  }

  _persistProcesses() {
    try {
      const procFile = path.join(this.projectRoot, '.contextos', 'processes.json');
      fs.mkdirSync(path.dirname(procFile), { recursive: true });
      fs.writeFileSync(procFile, JSON.stringify(this.listProcesses(), null, 2), 'utf8');
    } catch (_) {}
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

    const pgid = session.pgid || session.pid;
    const isWin = process.platform === 'win32';
    try {
      if (isWin && session.pid) {
        try {
          execSync(`taskkill /pid ${session.pid} /T /F`, { stdio: 'ignore' });
        } catch (_) {
          process.kill(session.pid, 'SIGTERM');
        }
      } else if (pgid) {
        process.kill(-pgid, 'SIGTERM');
      }
    } catch (_) {
      try {
        session.child?.kill('SIGTERM');
      } catch (_) {}
    }

    // Wait for process exit or timeout
    const start = Date.now();
    while (session.status !== 'stopped' && Date.now() - start < graceMs) {
      if (!session.child && session.pid) {
        try {
          process.kill(session.pid, 0);
        } catch (_) {
          session.status = 'stopped';
          session.stoppedAt = new Date().toISOString();
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    // If still not stopped, send SIGKILL
    if (session.status !== 'stopped') {
      try {
        if (isWin && session.pid) {
          try {
            execSync(`taskkill /pid ${session.pid} /T /F`, { stdio: 'ignore' });
          } catch (_) {
            process.kill(session.pid, 'SIGKILL');
          }
        } else if (pgid) {
          process.kill(-pgid, 'SIGKILL');
        }
      } catch (_) {
        try {
          session.child?.kill('SIGKILL');
        } catch (_) {}
      }
      session.status = 'stopped';
      session.stoppedAt = new Date().toISOString();
    }

    this._persistProcesses();
    return this._sessionSummary(session);
  }

  clearStopped() {
    for (const [id, session] of this.sessions.entries()) {
      if (session.status === 'stopped' || session.status === 'error') {
        this.sessions.delete(id);
      }
    }
    this._persistProcesses();
  }

  async stopAll() {
    for (const session of this.sessions.values()) {
      if (session.status === 'running' || session.status === 'starting' || session.status === 'ready') {
        try {
          await this.stopProcess(session.id, { graceMs: 500 });
        } catch (_) {}
      }
    }
    this._persistProcesses();
  }

  _sessionSummary(s) {
    return {
      id: s.id,
      command: s.command,
      cwd: s.cwd,
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
