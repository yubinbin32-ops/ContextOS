import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildMicroHistory,
  closeMicroSession,
  completeMicroTurn,
  createMicroSession,
  deleteMicroSession,
  failMicroTurn,
  listMicroSessions,
  readMicroSession,
  startMicroTurn,
  withMicroSessionLock,
} from '../src/micro-session.mjs';

test('micro sessions persist multi-turn state and keep the main context result-only', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-micro-session-'));
  try {
    const created = createMicroSession(projectRoot, {
      sessionId: 'review-agent',
      objective: 'Review the generated diagnostic and propose the smallest fix.',
      preset: 'diagnose',
      maxTurns: 3,
      maxContextChars: 4000,
    });
    assert.equal(created.turnCount, 0);
    assert.equal(created.status, 'active');

    const started = startMicroTurn(projectRoot, 'review-agent', 'Find the failing assertion.');
    const history = buildMicroHistory(started, { systemPrompt: 'Diagnostic worker.' });
    assert.equal(history[0].role, 'system');
    assert.equal(history.at(-1).content, 'Find the failing assertion.');

    const snapshot = completeMicroTurn(projectRoot, 'review-agent', {
      receiptId: 'receipt-micro-1',
      result: {
        ok: true,
        content: 'The assertion expects an object, but the implementation returns a string.',
        model: 'mock-model',
        durationMs: 12,
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      },
    });
    assert.equal(snapshot.turnCount, 1);
    assert.equal(snapshot.lastReceiptId, 'receipt-micro-1');
    assert.equal(snapshot.usage.totalTokens, 120);

    const persisted = readMicroSession(projectRoot, 'review-agent');
    assert.equal(persisted.messages.length, 2);
    assert.equal(persisted.messages[0].role, 'user');
    assert.equal(persisted.messages[1].role, 'assistant');
    assert.equal(listMicroSessions(projectRoot)[0].id, 'review-agent');

    startMicroTurn(projectRoot, 'review-agent', 'Now identify the file.');
    const compressedHistory = buildMicroHistory(readMicroSession(projectRoot, 'review-agent'));
    const compressedText = compressedHistory.map((message) => message.content).join('\n');
    assert.match(compressedText, /Compressed prior findings/);
    assert.doesNotMatch(compressedText, /Find the failing assertion/);
    assert.equal(failMicroTurn(projectRoot, 'review-agent').turnCount, 1);
    assert.equal(closeMicroSession(projectRoot, 'review-agent').status, 'closed');
    assert.equal(deleteMicroSession(projectRoot, 'review-agent'), true);
    assert.equal(deleteMicroSession(projectRoot, 'review-agent'), false);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('micro sessions keep preload evidence out of host snapshots but inside Micro history', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-micro-session-preload-'));
  try {
    createMicroSession(projectRoot, {
      sessionId: 'preload-agent',
      preload: {
        ok: true,
        status: 'FAIL',
        artifactId: 'art-preload',
        summary: 'Test failure evidence: expected 1 but received 2.',
        chars: 52,
        steps: 2,
      },
    });
    const snapshot = listMicroSessions(projectRoot)[0];
    assert.equal(snapshot.preload.status, 'FAIL');
    assert.equal(snapshot.preload.artifactId, 'art-preload');
    assert.doesNotMatch(JSON.stringify(snapshot), /expected 1 but received 2/);

    startMicroTurn(projectRoot, 'preload-agent', 'Analyze the failure.');
    const history = buildMicroHistory(readMicroSession(projectRoot, 'preload-agent'));
    const text = history.map((message) => message.content).join('\n');
    assert.match(text, /Preloaded OS context/);
    assert.match(text, /expected 1 but received 2/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('micro sessions mark the final allowed turn as completed', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-micro-session-complete-'));
  try {
    createMicroSession(projectRoot, { sessionId: 'single-turn', maxTurns: 1 });
    startMicroTurn(projectRoot, 'single-turn', 'Return the final answer.');
    const snapshot = completeMicroTurn(projectRoot, 'single-turn', {
      receiptId: 'receipt-micro-final',
      result: { ok: true, content: 'done', usage: { total_tokens: 5 } },
    });
    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.remainingTurns, 0);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('micro session ids reject path traversal', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-micro-session-id-'));
  try {
    assert.throws(() => createMicroSession(projectRoot, { sessionId: '../escape' }), /sessionId/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('micro sessions expire and reject concurrent cross-process writers', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-micro-session-lifecycle-'));
  try {
    createMicroSession(projectRoot, { sessionId: 'expires-fast', ttlMs: 1 });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    assert.throws(() => readMicroSession(projectRoot, 'expires-fast'), /expired/);

    createMicroSession(projectRoot, { sessionId: 'locked-agent' });
    withMicroSessionLock(projectRoot, 'locked-agent', () => {
      assert.throws(
        () => withMicroSessionLock(projectRoot, 'locked-agent', () => {}, { timeoutMs: 0 }),
        /locked by another process/
      );
    });
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
