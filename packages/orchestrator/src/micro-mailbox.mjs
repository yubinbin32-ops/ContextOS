import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readMicroJob, updateMicroJob, withQueueLock } from './micro-delivery.mjs';

function mailboxPath(root, jobId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(String(jobId))) throw new Error('Invalid Micro job id.');
  return path.join(root, '.contextos', 'micro-deliveries', 'inbox', `${jobId}.json`);
}
function read(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { sequence: 0, messages: [] };
}
function write(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
export function sendMicroMessage(root, jobId, message) {
  const file = mailboxPath(root, jobId);
  const job = readMicroJob(root, jobId);
  if (!job || job.status !== 'running') throw new Error('Messages require a running assigned Micro job.');
  const text = String(message ?? '').trim();
  if (!text || text.length > 2400) throw new Error('Message must contain 1–2400 characters.');
  const sent = withQueueLock(root, () => {
    const state = read(file);
    if (state.messages.length >= 32) throw new Error('Micro inbox is full; wait for the child to receive messages.');
    const id = ++state.sequence;
    state.messages.push({ id, message: text });
    write(file, state);
    return { jobId, messageId: id, queued: true };
  });
  if (job.report?.question) {
    const answeredQuestions = Array.from(new Set([
      ...(Array.isArray(job.answeredQuestions) ? job.answeredQuestions : []),
      job.report.question,
    ])).slice(-16);
    updateMicroJob(root, jobId, { answeredQuestions });
  }
  return sent;
}
export function receiveMicroMessages(root, jobId, { peek = false } = {}) {
  const file = mailboxPath(root, jobId);
  return withQueueLock(root, () => {
    const state = read(file);
    const messages = [];
    let chars = 0;
    while (state.messages.length && messages.length < 4) {
      const next = state.messages[0];
      if (chars + next.message.length > 3200) break;
      messages.push(state.messages.shift());
      chars += next.message.length;
    }
    if (messages.length && !peek) write(file, state);
    return messages;
  });
}

export function acknowledgeMicroMessages(root, jobId, ids) {
  if (!Array.isArray(ids) || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error('Message acknowledgements require positive integer ids.');
  const file = mailboxPath(root, jobId);
  return withQueueLock(root, () => {
    const state = read(file);
    const delivered = new Set(ids);
    state.messages = state.messages.filter((message) => !delivered.has(message.id));
    write(file, state);
  });
}

// Wait locally for one reply; no model polling and no queue lock held while
// waiting. Check after registering the watcher too, so a fast reply is kept.
export async function waitForMicroMessages(root, jobId, { waitMs = 0, signal } = {}) {
  const file = mailboxPath(root, jobId);
  if (signal?.aborted) return [];
  const immediate = receiveMicroMessages(root, jobId);
  if (immediate.length) return immediate;
  const duration = Math.min(60000, Math.max(0, Number(waitMs) || 0));
  if (!duration) return [];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return new Promise((resolve, reject) => {
    let watcher, timer, finished = false;
    const done = (messages, error) => {
      if (finished) return;
      finished = true; watcher?.close(); clearTimeout(timer);
      signal?.removeEventListener('abort', cancelled);
      error ? reject(error) : resolve(messages);
    };
    const check = () => { try { const messages = receiveMicroMessages(root, jobId); if (messages.length) done(messages); } catch (error) { done([], error); } };
    const cancelled = () => done([]);
    watcher = fs.watch(path.dirname(file), (_event, filename) => { if (String(filename) === path.basename(file)) check(); });
    watcher.on('error', (error) => done([], error));
    timer = setTimeout(() => done([]), duration);
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled(); else check();
  });
}
