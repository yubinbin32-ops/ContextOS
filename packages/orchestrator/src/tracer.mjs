import fs from 'node:fs';
import path from 'node:path';

/**
 * Writes one JSONL trace per session so a failed pipeline can be inspected
 * without asking the agent to narrate what it did.
 */
export class Tracer {
  constructor({ projectRoot, sessionId = 'no-session' }) {
    this.projectRoot = projectRoot;
    this.sessionId = sessionId;
    this.tracePath = path.join(projectRoot, '.contextos', 'logs', 'sessions', `${sessionId}.jsonl`);
    this.steps = [];
  }

  step(name, meta = {}) {
    this.steps.push({ name, ...meta });
  }

  flush() {
    try {
      fs.mkdirSync(path.dirname(this.tracePath), { recursive: true });
      const payload = this.steps
        .map((entry) => JSON.stringify({ at: new Date().toISOString(), ...entry }))
        .join('\n');
      fs.appendFileSync(this.tracePath, payload ? `${payload}\n` : '', 'utf8');
    } catch (_) {}
  }
}
