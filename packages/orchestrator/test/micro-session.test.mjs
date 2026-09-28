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
import {
  claimMicroDeliveries,
  completeMicroDeliveryClaims,
  enqueueMicroDelivery,
} from '../src/micro-delivery.mjs';
import { projectMicroResult } from '../src/response-budget.mjs';

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

test('closing a Micro session preserves queued answers while deleting discards them', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-micro-session-delivery-'));
  try {
    createMicroSession(projectRoot, { sessionId: 'closing-worker' });
    enqueueMicroDelivery(projectRoot, {
      deliveryId: 'micro-close-1',
      receiptId: 'micro-close-1',
      sessionId: 'closing-worker',
      content: 'answer remains claimable after close',
    });
    closeMicroSession(projectRoot, 'closing-worker');
    const claims = claimMicroDeliveries(projectRoot);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].content, 'answer remains claimable after close');
    completeMicroDeliveryClaims(projectRoot, claims.map((item) => item.deliveryId));

    createMicroSession(projectRoot, { sessionId: 'deleted-worker' });
    enqueueMicroDelivery(projectRoot, {
      deliveryId: 'micro-delete-1',
      receiptId: 'micro-delete-1',
      sessionId: 'deleted-worker',
      content: 'answer is discarded with the session',
    });
    deleteMicroSession(projectRoot, 'deleted-worker');
    assert.deepEqual(claimMicroDeliveries(projectRoot), []);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('micro session listing is paginated instead of returning an unbounded catalog', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-micro-session-list-'));
  try {
    for (let index = 0; index < 5; index += 1) {
      createMicroSession(projectRoot, { sessionId: `worker-${index}` });
    }
    const firstPage = listMicroSessions(projectRoot, { limit: 2, offset: 0 });
    const secondPage = listMicroSessions(projectRoot, { limit: 2, offset: 2 });
    assert.equal(firstPage.length, 2);
    assert.equal(secondPage.length, 2);
    assert.equal(firstPage.some((item) => secondPage.some((other) => other.id === item.id)), false);
    assert.ok(listMicroSessions(projectRoot).length <= 20);
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

test('micro sessions do not resume a session copied from another workspace root', () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-micro-session-source-'));
  const copiedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-micro-session-copy-'));
  try {
    createMicroSession(sourceRoot, { sessionId: 'copied-agent', objective: 'stale objective' });
    const sourceFile = path.join(sourceRoot, '.contextos', 'micro-sessions', 'copied-agent.json');
    const copiedDir = path.join(copiedRoot, '.contextos', 'micro-sessions');
    fs.mkdirSync(copiedDir, { recursive: true });
    fs.copyFileSync(sourceFile, path.join(copiedDir, 'copied-agent.json'));

    assert.throws(() => readMicroSession(copiedRoot, 'copied-agent'), /not found/);
    assert.deepEqual(listMicroSessions(copiedRoot), []);
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    fs.rmSync(copiedRoot, { recursive: true, force: true });
  }
});

test('closing preserves one session deliveries while deleting removes only its own', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-micro-session-delivery-scope-'));
  try {
    createMicroSession(projectRoot, { sessionId: 'alpha' });
    createMicroSession(projectRoot, { sessionId: 'beta' });
    createMicroSession(projectRoot, { sessionId: 'gamma' });
    projectMicroResult({
      ok: true,
      delivery: 'defer',
      receiptId: 'delivery-alpha',
      sessionId: 'alpha',
      content: 'alpha answer',
    }, { projectRoot });
    enqueueMicroDelivery(projectRoot, {
      deliveryId: 'delivery-beta',
      receiptId: 'delivery-beta',
      sessionId: 'beta',
      content: 'beta answer',
    });
    enqueueMicroDelivery(projectRoot, {
      deliveryId: 'delivery-one-shot',
      receiptId: 'delivery-one-shot',
      content: 'one-shot answer',
    });

    assert.equal(closeMicroSession(projectRoot, 'alpha').status, 'closed');
    const afterClose = claimMicroDeliveries(projectRoot);
    assert.deepEqual(
      afterClose.map((item) => item.deliveryId),
      ['delivery-alpha', 'delivery-beta', 'delivery-one-shot'],
    );
    completeMicroDeliveryClaims(projectRoot, afterClose.map((item) => item.deliveryId));

    // A consumed answer must not poison a freshly recreated session with the
    // same id and receipt namespace after explicit close/delete.
    assert.equal(deleteMicroSession(projectRoot, 'alpha'), true);
    createMicroSession(projectRoot, { sessionId: 'alpha' });
    projectMicroResult({
      ok: true,
      delivery: 'defer',
      receiptId: 'delivery-alpha-recreated',
      sessionId: 'alpha',
      content: 'alpha consumed answer',
    }, { projectRoot });
    const consumed = claimMicroDeliveries(projectRoot);
    assert.deepEqual(consumed.map((item) => item.deliveryId), ['delivery-alpha-recreated']);
    completeMicroDeliveryClaims(projectRoot, ['delivery-alpha-recreated']);
    assert.equal(closeMicroSession(projectRoot, 'alpha').status, 'closed');
    assert.equal(deleteMicroSession(projectRoot, 'alpha'), true);
    createMicroSession(projectRoot, { sessionId: 'alpha' });
    projectMicroResult({
      ok: true,
      delivery: 'defer',
      receiptId: 'delivery-alpha-recreated',
      sessionId: 'alpha',
      content: 'fresh alpha answer',
    }, { projectRoot });
    const freshAlpha = claimMicroDeliveries(projectRoot);
    assert.deepEqual(freshAlpha.map((item) => item.deliveryId), ['delivery-alpha-recreated']);
    completeMicroDeliveryClaims(projectRoot, ['delivery-alpha-recreated']);

    enqueueMicroDelivery(projectRoot, {
      deliveryId: 'delivery-gamma',
      receiptId: 'delivery-gamma',
      sessionId: 'gamma',
      content: 'gamma answer',
    });
    enqueueMicroDelivery(projectRoot, {
      deliveryId: 'delivery-beta-2',
      receiptId: 'delivery-beta-2',
      sessionId: 'beta',
      content: 'beta remains isolated',
    });
    assert.equal(deleteMicroSession(projectRoot, 'gamma'), true);
    const afterDelete = claimMicroDeliveries(projectRoot);
    assert.deepEqual(afterDelete.map((item) => item.deliveryId), ['delivery-beta-2']);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('Micro session histories never cross-contaminate after another session completes', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-micro-session-isolation-'));
  try {
    createMicroSession(projectRoot, { sessionId: 'source-session' });
    startMicroTurn(projectRoot, 'source-session', 'Find the source-only defect.');
    completeMicroTurn(projectRoot, 'source-session', {
      receiptId: 'source-receipt',
      result: { ok: true, content: 'source-private finding', usage: { total_tokens: 3 } },
    });

    createMicroSession(projectRoot, { sessionId: 'other-session' });
    startMicroTurn(projectRoot, 'other-session', 'Analyze only the other session.');
    const history = buildMicroHistory(readMicroSession(projectRoot, 'other-session'));
    const text = history.map((message) => message.content).join('\n');
    assert.match(text, /Analyze only the other session/);
    assert.doesNotMatch(text, /source-private finding/);
    assert.doesNotMatch(text, /Find the source-only defect/);
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
