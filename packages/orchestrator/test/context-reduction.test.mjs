import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Orchestrator } from '../src/index.mjs';
import { SessionStore } from '../src/session-store.mjs';

function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-reduct-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'reduct-fixture' }, null, 2));
  fs.writeFileSync(path.join(dir, 'src', 'math.mjs'), 'export function add(a, b) {\n  return a + b;\n}\n');
  return dir;
}

function fakeService({ exitCode = 0, exitCodes = null } = {}) {
  const calls = [];
  let runCount = 0;
  return {
    calls,
    projectId: 'reduct-fixture',
    async code(args) {
      calls.push({ capability: 'code', args });
      if (args.action === 'outline') {
        return `# Outline: \`${args.path}\` (javascript, capability: core, 10 lines)
### Symbols:
- **func** \`add(a, b)\` [L1-L3] (hash: \`hash1\`)
- **func** \`sub(a, b)\` [L5-L7] (hash: \`hash2\`)
`;
      }
      if (args.action === 'changeset') {
        // Mock changeset application
        for (const change of args.changes || []) {
          const fullPath = path.resolve(this.projectRoot || os.tmpdir(), change.path);
          if (change.kind === 'edit') {
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, change.replacement || 'modified', 'utf8');
          } else if (change.kind === 'create') {
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, change.content || '', 'utf8');
          } else if (change.kind === 'delete') {
            fs.rmSync(fullPath, { force: true });
          }
        }
        return {
          files: (args.changes || []).map((change, index) => ({
            path: change.path,
            newHash: change.kind === 'delete' ? null : `hash-${index + 1}`,
            locators: change.kind === 'delete' ? [] : [1],
            created: change.kind === 'create',
            ...(change.kind === 'delete' ? { deleted: true } : {}),
          })),
          results: [],
        };
      }
      if (args.action === 'search') return '- **function** `add` [`src/math.mjs`:L1-L3]';
      if (args.action === 'read') {
        const fullPath = path.resolve(this.projectRoot || os.tmpdir(), args.path);
        if (fs.existsSync(fullPath)) return fs.readFileSync(fullPath, 'utf8');
        return 'export function add(a, b) {\n  return a + b;\n}';
      }
      return 'ok';
    },
    async block() {
      return [];
    },
    async rules() {
      return [];
    },
    async runCommand(args) {
      calls.push({ capability: 'run', args });
      const code = Array.isArray(exitCodes) ? (exitCodes[runCount] ?? 0) : exitCode;
      runCount += 1;
      return {
        id: `receipt-${runCount}`,
        command: args.command,
        cwd: args.cwd || null,
        exitCode: code,
        durationMs: 5,
        errors: code === 0 ? [] : ['Error: test failed on line 12'],
        summary: code === 0 ? 'all tests pass' : '1 test failed',
      };
    },
    syncEngine: {
      async exportGraphToJson() {
        return { graphRevision: 1 };
      },
    },
  };
}

test('SessionStore persists and updates .contextos/blackboard.md', () => {
  const dir = makeTempProject();
  try {
    const store = new SessionStore({ projectRoot: dir, projectId: 'test-proj' });
    const session = store.ensureSession('Test blackboard');
    store.touch(['src/math.mjs'], 'edit');
    store.attachReceipt({ id: 'rec-1', command: 'npm test', exitCode: 0, durationMs: 10 });
    store.note('Implemented basic addition', 'milestone');

    const bbPath = path.join(dir, '.contextos', 'blackboard.md');
    assert.ok(fs.existsSync(bbPath), 'blackboard.md must exist on disk');

    const bbContent = fs.readFileSync(bbPath, 'utf8');
    assert.ok(bbContent.includes('ContextOS Blackboard'));
    assert.ok(bbContent.includes(session.id));
    assert.ok(bbContent.includes('Test blackboard'));
    assert.ok(bbContent.includes('src/math.mjs'));
    assert.ok(bbContent.includes('npm test'));
    assert.ok(bbContent.includes('Implemented basic addition'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionStore does not inherit an open session copied from another workspace root', () => {
  const dir = makeTempProject();
  try {
    const sessionPath = path.join(dir, '.contextos', 'session.json');
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, JSON.stringify({
      id: 'copied-session',
      projectId: 'test-proj',
      workspaceRoot: '/different/worktree',
      status: 'open',
      intent: 'stale intent from another checkout',
      intents: [{ text: 'stale intent from another checkout' }],
      touchedFiles: [{ path: 'stale.mjs' }],
      receipts: [{ command: 'npm test', exitCode: 0 }],
      readReceipts: [],
      notes: [],
      slots: { stale: true },
    }, null, 2));

    const store = new SessionStore({ projectRoot: dir, projectId: 'test-proj' });
    assert.equal(store.current, null);
    const fresh = store.ensureSession('fresh workspace');
    assert.notEqual(fresh.id, 'copied-session');
    assert.equal(fresh.workspaceRoot, path.resolve(dir));
    assert.equal(fresh.intent, 'fresh workspace');
    assert.deepEqual(fresh.touchedFiles, []);
    assert.deepEqual(fresh.receipts, []);
    assert.deepEqual(fresh.slots, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('inspect returns an unchanged receipt for a repeated identical read', async () => {
  const dir = makeTempProject();
  const service = fakeService();
  service.projectRoot = dir;
  const orch = new Orchestrator({ projectRoot: dir, service });

  try {
    const first = await orch.dispatch('inspect', {
      path: 'src/math.mjs',
      startLine: 1,
      endLine: 3,
    });
    const second = await orch.dispatch('inspect', {
      path: 'src/math.mjs',
      startLine: 1,
      endLine: 3,
    });
    const forced = await orch.dispatch('inspect', {
      path: 'src/math.mjs',
      startLine: 1,
      endLine: 3,
      full: true,
    });

    assert.match(first, /export function add/);
    assert.match(second, /unchanged/);
    assert.doesNotMatch(second, /export function add/);
    assert.match(forced, /export function add/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('changePipeline executes atomic verify in a single round trip (Verify: PASS)', async () => {
  const dir = makeTempProject();
  const service = fakeService({ exitCode: 0 });
  service.projectRoot = dir;
  const orch = new Orchestrator({ projectRoot: dir, service });

  try {
    const res = await orch.dispatch('change', {
      intent: 'add multiply function',
      edits: [
        {
          path: 'src/math.mjs',
          target: 'export function add(a, b) {',
          replacement: 'export function multiply(a, b) { return a * b; }\nexport function add(a, b) {',
        },
      ],
      verify: 'node --test',
    });

    assert.ok(res.includes('Verify: PASS'), 'must include Verify: PASS in output');
    assert.ok(res.includes('node --test'), 'must mention verification command');
    assert.ok(res.includes('do not rerun'), 'next step should forbid duplicate verification');
    
    // Verify receipt was attached to session
    const session = orch.store.current;
    assert.equal(session.receipts.length, 1);
    assert.equal(session.receipts[0].exitCode, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('changePipeline auto-reverts changes on verification failure when autoRevert: true', async () => {
  const dir = makeTempProject();
  const initialMath = fs.readFileSync(path.join(dir, 'src', 'math.mjs'), 'utf8');
  const service = fakeService({ exitCode: 1 });
  service.projectRoot = dir;
  const orch = new Orchestrator({ projectRoot: dir, service });

  try {
    const res = await orch.dispatch('change', {
      intent: 'broken edit that fails test',
      edits: [
        {
          path: 'src/math.mjs',
          target: 'export function add(a, b) {',
          replacement: 'export function add(a, b) { return a - b; }',
        },
      ],
      verify: 'node --test',
      autoRevert: true,
    });

    assert.ok(res.includes('Verify: FAIL'), 'must report Verify: FAIL');
    assert.ok(res.includes('autoReverted disk changes'), 'must report autoRevert happened');
    assert.ok(res.includes('test failed on line 12'), 'must report error diagnostic');

    // Check disk content was restored
    const currentMath = fs.readFileSync(path.join(dir, 'src', 'math.mjs'), 'utf8');
    assert.equal(currentMath, initialMath, 'file on disk must be restored to initial content');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('changePipeline deletes files, previews them, and auto-reverts failed deletion', async () => {
  const dir = makeTempProject();
  const legacyPath = path.join(dir, 'src', 'legacy.mjs');
  const legacyContent = 'export const legacy = true;\n';
  fs.writeFileSync(legacyPath, legacyContent);
  const service = fakeService({ exitCodes: [1, 0] });
  service.projectRoot = dir;
  const orch = new Orchestrator({ projectRoot: dir, service });

  try {
    const dryRun = await orch.dispatch('change', {
      delete: [{ path: 'src/legacy.mjs' }],
      dryRun: true,
    });
    assert.ok(dryRun.includes('Delete 1'), 'dry-run must preview the deletion');
    assert.equal(fs.readFileSync(legacyPath, 'utf8'), legacyContent);

    const failed = await orch.dispatch('change', {
      delete: [{ path: 'src/legacy.mjs' }],
      verify: 'node --test',
      autoRevert: true,
    });
    assert.ok(failed.includes('Verify: FAIL'));
    assert.ok(failed.includes('autoReverted disk changes'));
    assert.equal(fs.readFileSync(legacyPath, 'utf8'), legacyContent, 'failed deletion must be restored');

    const passed = await orch.dispatch('change', {
      delete: [{ path: 'src/legacy.mjs' }],
      verify: 'node --test',
    });
    assert.ok(passed.includes('Verify: PASS'));
    assert.equal(fs.existsSync(legacyPath), false, 'successful deletion must remove the file');
    assert.equal(orch.store.current.touchedFiles.find((entry) => entry.path === 'src/legacy.mjs')?.deleted, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('explorePipeline uses compact outline signatures and masks older receipts', async () => {
  const dir = makeTempProject();
  const service = fakeService({ exitCode: 0 });
  service.projectRoot = dir;
  const orch = new Orchestrator({ projectRoot: dir, service });

  try {
    // Simulate multiple receipts
    orch.store.ensureSession('Test explore');
    orch.store.attachReceipt({ id: 'rec-fail-1', command: 'npm test', exitCode: 1, durationMs: 4 });
    orch.store.attachReceipt({ id: 'rec-fail-2', command: 'npm test', exitCode: 1, durationMs: 4 });
    orch.store.attachReceipt({ id: 'rec-pass-3', command: 'npm test', exitCode: 0, durationMs: 5 });

    const res = await orch.dispatch('explore', {
      intent: 'inspect math helpers',
      paths: ['src/math.mjs'],
    });

    // Verify compact outline format: does not dump raw markdown headers or large chunks
    assert.ok(res.includes('func add(a, b) L1-L3'), 'must contain compact symbol signature');
    assert.ok(!res.includes('### Symbols:'), 'normal depth must omit raw bulky headers');

    // Verify receipt masking
    assert.ok(res.includes('Last receipt: `npm test` exit 0'));

    // Normal depth stays navigational; code previews and edit slots are opt-in.
    assert.ok(!res.includes('Available Action Slots'), 'normal explore should not create action slots');
    assert.ok(!res.includes('[S1]'), 'normal explore should not create slots');
    assert.ok(!res.includes('Code Slices'), 'normal explore should not read code previews');
    assert.ok(!res.includes('mod-'), 'navigation output must not expose derived IDs as architecture');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('inspectPipeline reads file slices and changePipeline supports slots and append', async () => {
  const dir = makeTempProject();
  const service = fakeService({ exitCode: 0 });
  service.projectRoot = dir;
  const orch = new Orchestrator({ projectRoot: dir, service });

  try {
    // 1. Explore generates slots
    const exploreRes = await orch.dispatch('explore', {
      intent: 'work on math.mjs',
      paths: ['src/math.mjs'],
      depth: 'deep',
    });
    assert.ok(exploreRes.includes('[S1]'), 'deep explore should define slot S1');
    assert.ok(exploreRes.includes('derived navigation only; not Block ownership'));
    assert.ok(!exploreRes.includes('mod-'), 'derived navigation IDs must stay internal');
    const slotS1 = orch.store.getSlot('S1');
    assert.ok(slotS1, 'slot S1 must be saved in session store');
    assert.equal(slotS1.path, 'src/math.mjs');

    // 2. inspect can use slot directly
    const inspectRes = await orch.dispatch('inspect', { slot: 'S1' });
    assert.ok(inspectRes.includes('Inspection Result'));
    assert.ok(inspectRes.includes('export function add'));

    // 3. change can use slot and append without verbatim target
    const changeRes = await orch.dispatch('change', {
      slot: 'S1',
      append: 'export function multiply(a, b) {\n  return a * b;\n}\n',
      verify: 'npm test',
    });
    assert.ok(changeRes.includes('Verify: PASS'), 'change with verify must pass in 1 turn');
    assert.ok(changeRes.includes('verify: PASS'), 'must mark the passing receipt without replaying it');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionStore decouples read receipts from blackboard disk writes, projects bounded memoryHandles + tracking, and evicts touched evidence handles', async () => {
  const dir = makeTempProject();
  try {
    const store = new SessionStore({ projectRoot: dir });
    store.ensureSession('test deterministic memory handles');
    const blackboardPath = store.blackboardPath;
    assert.ok(fs.existsSync(blackboardPath), 'ensureSession creates blackboard.md');

    const statBeforeReceipts = fs.statSync(blackboardPath);
    const contentBeforeReceipts = fs.readFileSync(blackboardPath, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 15));

    store.recordReadReceipt({ path: 'src/math.mjs', hash: 'h1', range: { startLine: 1, endLine: 3 } });
    store.recordSearchReceipt({ query: 'add', path: '.', glob: '', output: 'src/math.mjs:1' });
    store.recordSemanticReceipt({ key: 'outline:src/math.mjs', output: 'func add', paths: ['src/math.mjs'] });
    store.recordExploreReceipt({ key: 'explore:math', output: 'explored', paths: ['src/math.mjs'] });

    const statAfterReceipts = fs.statSync(blackboardPath);
    assert.equal(statAfterReceipts.mtimeMs, statBeforeReceipts.mtimeMs, 'receipt mutations must not rewrite blackboard.md');
    assert.equal(fs.readFileSync(blackboardPath, 'utf8'), contentBeforeReceipts);

    for (let i = 1; i <= 7; i += 1) {
      store.recordMemoryHandle({
        resultId: `result-ev-${i}`,
        paths: [i % 2 === 0 ? 'src/math.mjs' : `src/other-${i}.mjs`],
        contentHashes: [`hash-${i}`],
      });
    }
    for (let i = 1; i <= 5; i += 1) {
      store.recordMemoryHandle({
        kind: 'micro',
        sessionId: `micro-sess-${i}`,
      });
    }

    const summary = store.summary();
    assert.ok(Array.isArray(summary.memoryHandles), 'summary() must project memoryHandles array');
    const evidenceHandles = summary.memoryHandles.filter((h) => h.resultId);
    const subagentHandles = summary.memoryHandles.filter((h) => h.sessionId);
    assert.equal(evidenceHandles.length, 5, 'evidence handles bounded to 5 FIFO');
    assert.equal(evidenceHandles[0].resultId, 'result-ev-3');
    assert.equal(evidenceHandles.at(-1).resultId, 'result-ev-7');
    assert.equal(subagentHandles.length, 3, 'subagent handles bounded to 3 FIFO');
    assert.equal(subagentHandles[0].sessionId, 'micro-sess-3');
    assert.equal(subagentHandles.at(-1).sessionId, 'micro-sess-5');
    assert.ok('tracking' in summary, 'summary() must project tracking');

    const blackboardAfterHandles = fs.readFileSync(blackboardPath, 'utf8');
    assert.match(blackboardAfterHandles, /- Memory Handles:/);
    assert.match(blackboardAfterHandles, /result-ev-7/);
    assert.doesNotMatch(blackboardAfterHandles, /result-ev-1/);
    assert.match(blackboardAfterHandles, /micro-sess-5/);
    assert.doesNotMatch(blackboardAfterHandles, /micro-sess-1/);

    store.touch(['src/math.mjs'], 'edit');
    const summaryAfterTouch = store.summary();
    for (const ev of summaryAfterTouch.memoryHandles.filter((h) => h.resultId)) {
      assert.ok(!ev.paths.includes('src/math.mjs'), 'touched path must be deterministically evicted from evidence handles');
    }
    const blackboardAfterTouch = fs.readFileSync(blackboardPath, 'utf8');
    assert.doesNotMatch(blackboardAfterTouch, /result-ev-6/);
    assert.match(blackboardAfterTouch, /result-ev-7/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pipeline resolves $stepN.resultId and $stepN.receiptId, hydrates handle-only evidence into micro at turn 0, and rejects drifted SHA-256 slices', async () => {
  const dir = makeTempProject();
  const service = fakeService({ exitCode: 0 });
  service.projectRoot = dir;
  const capturedPrompts = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const text = (parsed.messages || []).map((m) => m.content).join('\n');
        capturedPrompts.push(text);
      } catch (_) {}
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Analyzed preloaded slice at turn 0' } }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const savedMicroEnv = process.env.CONTEXTOS_API_MICRO_PROFILE;
  delete process.env.CONTEXTOS_API_MICRO_PROFILE;
  try {
    fs.mkdirSync(path.join(dir, '.contextos'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.contextos', 'profile.json'),
      JSON.stringify({ micro: { url: 'http://127.0.0.1:' + server.address().port, model: 'local-fixture', key: 'fixture' } })
    );
    const orch = new Orchestrator({ projectRoot: dir, service });

    const pipelineOut = await orch.dispatch('pipeline', {
      steps: [
        { tool: 'ask', args: { inspect: [{ path: 'src/math.mjs', ranges: [{ start: 1, end: 3 }] }], delivery: 'handle-only' } },
        { tool: 'verify', args: { command: 'npm test' } },
        {
          tool: 'micro',
          args: {
            action: 'run',
            withOS: false,
            prompt: 'Review math.mjs',
            context: {
              evidenceRefs: ['$step1.resultId'],
              verifyReceiptId: '$step2.receiptId',
            },
          },
        },
        {
          tool: 'ship',
          args: {
            receiptIds: ['$step2.receiptId'],
          },
        },
      ],
    });

    assert.match(pipelineOut, /delivery=handle-only/);
    assert.doesNotMatch(pipelineOut, /return a \+ b;/, 'handle-only step must not inline raw source in pipeline output');
    assert.match(pipelineOut, /Reused passing receipt\(s\): receipt-1/, '$step2.receiptId must resolve to receipt-1 in ship step');
    assert.equal(capturedPrompts.length, 1, 'micro provider should be called once at turn 0');
    assert.match(capturedPrompts[0], /## Verified Preloaded Evidence/, 'micro prompt must receive ## Verified Preloaded Evidence at turn 0');
    assert.match(capturedPrompts[0], /export function add\(a, b\)/, 'hydrated evidence must include verified slice text');

    // Mutate src/math.mjs on disk so its SHA-256 drifts from the stored result
    fs.writeFileSync(path.join(dir, 'src', 'math.mjs'), 'export function add(a, b) {\n  return a + b + 1;\n}\n');
    const step1ResultId = fs.readdirSync(path.join(dir, '.contextos', 'request-results'))[0].replace(/\.json$/, '');
    await orch.dispatch('ops', {
      capability: 'micro',
      action: 'run',
      args: {
        withOS: false,
        prompt: 'Re-check math.mjs after drift',
        context: { evidenceRefs: [step1ResultId] },
      },
    });
    assert.equal(capturedPrompts.length, 2, 'micro provider called with drifted ref');
    assert.match(
      capturedPrompts[1],
      /Path src\/math\.mjs changed since result-[A-Za-z0-9._-]+; inspect fresh slice/,
      'drifted file must be rejected with explicit stale notice'
    );
    assert.ok(
      !capturedPrompts[1].includes('return a + b;'),
      'drifted file must never inject stale source text'
    );

    const unsupportedRef = await orch.dispatch('pipeline', {
      steps: [
        { tool: 'verify', args: { command: 'npm test' } },
        { tool: 'inspect', args: { path: '$step1.unknownField' } },
      ],
    });
    assert.match(unsupportedRef, /PIPELINE_STEP_REFERENCE_UNSUPPORTED/);

    const unresolvedRef = await orch.dispatch('pipeline', {
      steps: [
        { tool: 'inspect', args: { path: 'src/math.mjs', startLine: 1, endLine: 2 } },
        { tool: 'micro', args: { action: 'run', withOS: false, prompt: 'use missing resultId', context: { evidenceRefs: ['$step1.resultId'] } } },
      ],
    });
    assert.match(unresolvedRef, /PIPELINE_STEP_REFERENCE_UNRESOLVED/);
  } finally {
    if (savedMicroEnv !== undefined) process.env.CONTEXTOS_API_MICRO_PROFILE = savedMicroEnv;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

