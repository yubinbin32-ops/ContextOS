import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { Orchestrator } from '../src/index.mjs';
import { createCapabilities } from '../src/capabilities.mjs';
import { observe } from '../src/observer.mjs';
import { classifyIntent, extractPaths } from '../src/intent-router.mjs';
import { fitSections } from '../src/context-budget.mjs';
import { ModuleIndex } from '../src/module-index.mjs';
import { SessionStore, workspaceFingerprint } from '../src/session-store.mjs';
import { storeArtifact } from '../src/artifact-store.mjs';
import { ContextOSV2Service } from '../../mcp/src/v2-service.mjs';

function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-orch-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "0"' } }, null, 2));
  fs.writeFileSync(path.join(dir, 'src', 'math.mjs'), 'export function add(a, b) {\n  return a + b;\n}\n');
  try {
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', [
      '-c', 'user.name=ContextOS',
      '-c', 'user.email=contextos@example.test',
      'commit', '-m', 'fixture baseline',
    ], { cwd: dir, stdio: 'ignore' });
  } catch (_) {}
  return dir;
}
test('internal Block and Chain graph reads collect every compact listing page', async () => {
  const blockItems = Array.from({ length: 31 }, (_, index) => ({ id: 'block-' + index, artifactRefs: [{ path: 'src/' + index + '.mjs' }] }));
  const chainItems = Array.from({ length: 31 }, (_, index) => ({ id: 'chain-' + index, memberIds: ['block-' + index] }));
  const calls = { block: [], chain: [] };
  const makePage = (items, args) => {
    const pageItems = items.slice(args.offset, args.offset + args.limit);
    const hasMore = args.offset + pageItems.length < items.length;
    return {
      items: pageItems,
      total: items.length,
      offset: args.offset,
      limit: args.limit,
      hasMore,
      nextOffset: hasMore ? args.offset + pageItems.length : null,
    };
  };
  const service = {
    block: async (args) => { calls.block.push(args); return makePage(blockItems, args); },
    chain: async (args) => { calls.chain.push(args); return makePage(chainItems, args); },
  };
  const capabilities = createCapabilities({ service, projectRoot: process.cwd(), projectId: 'fixture' });
  const [blocks, chains] = await Promise.all([capabilities.blocks(), capabilities.chains()]);
  assert.equal(blocks.ok, true);
  assert.equal(chains.ok, true);
  assert.equal(blocks.data.length, 31);
  assert.equal(chains.data.length, 31);
  assert.equal(calls.block.length, 2);
  assert.equal(calls.chain.length, 2);
  assert.ok(calls.block.every((args) => args.includeRefs === true && args.limit === 25));
  assert.ok(calls.chain.every((args) => args.includeMembers === true && args.limit === 25));
});

test('session history is compact by default and can target one closed session', async () => {
  const projectRoot = makeTempProject();
  const store = new SessionStore({ projectRoot, projectId: 'fixture' });
  const session = store.ensureSession('intent '.repeat(100));
  store.touch(Array.from({ length: 200 }, (_, index) => ({ path: `src/generated-${index}.mjs` })));
  for (let index = 0; index < 10; index += 1) {
    store.attachReceipt({
      id: `receipt-${index}`,
      command: `npm test ${'verbose '.repeat(30)}`,
      cwd: projectRoot,
      exitCode: index === 9 ? 0 : 1,
      durationMs: 10,
    });
  }
  store.current.intents = Array.from({ length: 200 }, () => 'historical intent '.repeat(40));
  store.current.semanticReceipts = Array.from({ length: 200 }, () => ({
    key: 'semantic-key',
    artifactId: 'artifact-id',
    hash: 'hash'.repeat(80),
  }));
  store.close('summary '.repeat(200));

  const compact = store.recentHistory(10);
  assert.equal(compact.length, 1);
  assert.equal(compact[0].id, session.id);
  assert.equal(compact[0].touchedFileCount, 200);
  assert.ok(compact[0].touchedFiles.length <= 4);
  assert.ok(compact[0].receipts.length <= 2);
  assert.equal(Object.hasOwn(compact[0], 'intents'), false);
  assert.equal(Object.hasOwn(compact[0], 'semanticReceipts'), false);
  assert.ok(JSON.stringify(compact).length < 2200, 'default history must not replay full session state');

  const targeted = store.recentHistory(10, { sessionId: session.id });
  assert.deepEqual(targeted, compact);
  assert.deepEqual(store.recentHistory(10, { sessionId: 'missing-session' }), []);

  const full = store.recentHistory(10, { sessionId: session.id, full: true });
  assert.equal(full[0].receipts.length, 10);
  assert.ok(full[0].summary.length > compact[0].summary.length);

  const orchestrator = new Orchestrator({ service: fakeService(), projectRoot, projectId: 'fixture' });
  const response = await orchestrator.dispatch('ops', {
    capability: 'session',
    action: 'history',
    args: { sessionId: session.id, limit: 10 },
  });
  const parsed = JSON.parse(response);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, session.id);
  assert.ok(response.length < 2200, 'MCP history response must stay within the ops budget');
});

test('artifact eviction returns a compact requested-id receipt', async () => {
  const projectRoot = makeTempProject();
  storeArtifact(projectRoot, 'artifact body', { id: 'art-evict-me' });
  const orchestrator = new Orchestrator({ service: fakeService(), projectRoot, projectId: 'fixture' });

  const response = await orchestrator.dispatch('ops', {
    capability: 'artifact',
    action: 'evict',
    args: {
      id: 'art-evict-me',
      policy: { maxAgeMs: Infinity, maxArtifacts: Infinity, maxTotalBytes: Infinity },
    },
  });
  const parsed = JSON.parse(response);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.evicted, [{ id: 'art-evict-me', reason: 'requested' }]);
  assert.deepEqual(parsed.notFound, []);
  assert.equal(Object.hasOwn(parsed, 'entries'), false);
  assert.ok(response.length < 700);
});

test('session status stays compact even when the durable session is large', async () => {
  const projectRoot = makeTempProject();
  const store = new SessionStore({ projectRoot, projectId: 'fixture' });
  store.ensureSession('status intent');
  store.touch(Array.from({ length: 200 }, (_, index) => ({ path: `src/status-${index}.mjs` })));
  for (let index = 0; index < 50; index += 1) {
    store.attachReceipt({
      id: `status-receipt-${index}`,
      command: `npm test ${index}`,
      cwd: projectRoot,
      exitCode: 0,
      durationMs: 1,
    });
  }
  const raw = store.current;
  raw.readReceipts = Array.from({ length: 200 }, (_, index) => ({ path: `src/status-${index}.mjs`, hash: `hash-${index}` }));
  raw.searchReceipts = Array.from({ length: 100 }, (_, index) => ({ key: `search-${index}` }));
  store.save(raw);

  const orchestrator = new Orchestrator({ service: fakeService(), projectRoot, projectId: 'fixture' });
  const response = await orchestrator.dispatch('ops', {
    capability: 'session',
    action: 'status',
  });
  const parsed = JSON.parse(response);
  assert.equal(parsed.touchedFileCount, 200);
  assert.equal(parsed.receiptCount, 50);
  assert.ok(parsed.files.length <= 8);
  assert.ok(parsed.receipts.length <= 3);
  assert.equal(Object.hasOwn(parsed, 'readReceipts'), false);
  assert.ok(response.length < 2200, 'session status must not replay durable receipt arrays');
});

function fakeService({ exitCode = 0, exitCodes = null } = {}) {

  const calls = [];
  let graphExports = 0;
  let runCount = 0;
  const service = {
    calls,
    get graphExports() {
      return graphExports;
    },
    projectId: 'fixture',
    async code(args) {
      calls.push({ capability: 'code', args });
      if (args.action === 'outline') return `# outline of ${args.path}\n- function add(a, b) -> calls: []`;
      if (args.action === 'edit') return { filePath: args.path, newHash: 'hash-1', locators: [1, 2] };
      if (args.action === 'create') return { filePath: args.path, newHash: 'hash-2', locators: [] };
      if (args.action === 'changeset') {
        return {
          files: (args.changes || []).map((change, index) => ({
            path: change.path,
            newHash: `hash-${index + 1}`,
            locators: [1],
            created: change.kind === 'create',
          })),
          results: [],
        };
      }
      if (args.action === 'search') return '- **function** `add` [`src/math.mjs`:L1-L3]';
      return 'ok';
    },
    async block() {
      return [{ id: 'block-math', title: 'Math helpers', summary: 'add()', artifactRefs: [{ path: 'src/math.mjs' }] }];
    },
    async knowledge() {
      return [{ id: 'rule-surgical-code-editing', title: 'Surgical code editing', category: 'code_style', summary: 'Never read whole files' }];
    },
    async runCommand(args) {
      calls.push({ capability: 'run', args });
      const effectiveExitCode = Array.isArray(exitCodes) ? (exitCodes[runCount] ?? 0) : exitCode;
      runCount += 1;
      return {
        id: `receipt-test-${runCount}`,
        command: args.command,
        cwd: args.cwd || null,
        exitCode: effectiveExitCode,
        durationMs: 3,
        errors: [],
        summary: effectiveExitCode === 0 ? 'ok' : 'failed',
      };
    },
    syncEngine: {
      async exportGraphToJson() {
        graphExports += 1;
        return { graphRevision: 7 };
      },
    },
  };
  return service;
}

test('intent router classifies agent phrasing', () => {
  assert.equal(classifyIntent('修复 storage 层的一个 bug').intent, 'change');
  assert.equal(classifyIntent('跑一下测试看看').intent, 'verify');
  assert.equal(classifyIntent('我想了解 database 模块的架构').intent, 'explore');
  assert.equal(classifyIntent('做完了，收尾吧').intent, 'ship');
  assert.equal(classifyIntent('随便什么', { hasEdits: true }).intent, 'change');
  assert.deepEqual(extractPaths('看一下 packages/storage/src/database.mjs'), ['packages/storage/src/database.mjs']);
});

test('context budget truncates the lowest priority section and drops it when nothing fits', () => {
  const sections = () => [
    { key: 'next', title: 'Next', priority: 0, lines: ['- one'] },
    { key: 'bulk', title: 'Bulk', priority: 5, lines: ['x'.repeat(400)] },
  ];

  const truncated = fitSections(sections(), { maxChars: 200 });
  assert.ok(truncated.text.includes('Next'), 'highest priority section always survives');
  assert.deepEqual(truncated.meta.dropped, []);
  assert.deepEqual(truncated.meta.truncated, ['bulk']);
  assert.ok(truncated.text.length <= 260);

  const dropped = fitSections(sections(), { maxChars: 60 });
  assert.deepEqual(dropped.meta.included, ['next']);
  assert.deepEqual(dropped.meta.dropped, ['bulk']);
});

test('orchestrator runs explore -> change -> verify -> ship in one round trip each', async () => {
  const projectRoot = makeTempProject();
  const service = fakeService();
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  const explored = await orchestrator.dispatch('explore', { intent: '了解 src/math.mjs 的结构' });
  assert.match(explored, /# ContextOS explore/);
  assert.match(explored, /src\/math\.mjs/);
  assert.match(explored, /Next/);

  const changed = await orchestrator.dispatch('change', {
    intent: '修改 add',
    edits: [{ path: 'src/math.mjs', target: 'return a + b;', replacement: 'return a + b + 0;' }],
  });
  assert.match(changed, /edited `src\/math\.mjs`/);

  const verified = await orchestrator.dispatch('verify', { commands: ['node -e "0"'] });
  assert.match(verified, /Verdict: PASS/);

  const shipped = await orchestrator.dispatch('ship', { summary: 'add() no-op tweak' });
  assert.match(shipped, /closed/);
  assert.equal(service.graphExports, 0, 'ship must not publish a tracked graph by default');

  const sessionFile = path.join(projectRoot, '.contextos', 'session.json');
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  assert.equal(session.status, 'closed');
  assert.ok(session.touchedFiles.some((entry) => entry.path === 'src/math.mjs'));
  assert.equal(session.receipts.length, 1);
  assert.ok(fs.existsSync(path.join(projectRoot, '.contextos', 'logs', 'sessions', 'history.jsonl')));

  const shippedWithGraph = await orchestrator.dispatch('ship', {
    summary: 'explicit graph export',
    exportGraph: true,
  });
  assert.match(shippedWithGraph, /graph\.json exported/);
  assert.equal(service.graphExports, 1);
});

test('repeated semantic capability reads reuse a compact receipt until a mutation invalidates it', async () => {
  const projectRoot = makeTempProject();
  const service = fakeService();
  const planCalls = [];
  service.plan = async (args) => {
    planCalls.push(args);
    return { id: 'plan-1', status: 'active', phases: [{ id: 'phase-1', status: 'active' }] };
  };
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  const first = await orchestrator.dispatch('ops', {
    projectRoot,
    capability: 'plan',
    action: 'check',
    args: { id: 'plan-1' },
  });
  const second = await orchestrator.dispatch('ops', {
    projectRoot,
    capability: 'plan',
    action: 'check',
    args: { id: 'plan-1' },
  });
  assert.match(first, /plan-1/);
  assert.match(second, /plan\.check \(reused\)/);
  assert.equal(planCalls.length, 1);

  await orchestrator.dispatch('ops', {
    projectRoot,
    capability: 'plan',
    action: 'update',
    args: { id: 'plan-1', summary: 'changed' },
  });
  const afterMutation = await orchestrator.dispatch('ops', {
    projectRoot,
    capability: 'plan',
    action: 'check',
    args: { id: 'plan-1' },
  });
  assert.match(afterMutation, /plan-1/);
  assert.equal(planCalls.length, 3, 'mutation and the following read must reach the service');
});

test('discovery convergence hint never replaces the requested payload', async () => {
  const projectRoot = makeTempProject();
  const orchestrator = new Orchestrator({ service: fakeService(), projectRoot, projectId: 'fixture' });
  for (let index = 0; index < 6; index += 1) {
    await orchestrator.dispatch('inspect', {
      path: 'src/math.mjs',
      refresh: true,
    });
  }
  const gated = await orchestrator.dispatch('inspect', { path: 'src/math.mjs' });
  // The read still returns its own result; the guard only attaches a hint.
  assert.match(gated, /src\/math\.mjs/);
  assert.match(gated, /discovery\/diagnostic calls/);
  assert.match(gated, /converge with one bounded/);
  assert.doesNotMatch(gated, /^# ContextOS convergence gate$/m);
});

test('discovery convergence hint also applies to read-only work loops without blocking them', async () => {
  const projectRoot = makeTempProject();
  const orchestrator = new Orchestrator({ service: fakeService(), projectRoot, projectId: 'fixture' });
  for (let index = 0; index < 6; index += 1) {
    await orchestrator.dispatch('work', {
      inspect: [{ path: 'src/math.mjs', symbol: 'add' }],
      refresh: true,
    });
  }
  const gated = await orchestrator.dispatch('work', {
    inspect: [{ path: 'src/math.mjs', symbol: 'add' }],
  });
  assert.match(gated, /src\/math\.mjs/);
  assert.match(gated, /discovery\/diagnostic calls/);
});

test('pipeline artifact reads return a compact preview unless raw output is explicit', async () => {
  const projectRoot = makeTempProject();
  const artifact = storeArtifact(projectRoot, {
    status: 'OK',
    totalActions: 2,
    steps: [{
      step: 1,
      kind: 'parallel',
      items: [
        { index: 1, tool: 'inspect', ok: true, output: '# ContextOS inspect\\nsource slice' },
        { index: 2, tool: 'verify', ok: false, output: 'failure diagnostic' },
      ],
    }],
  }, { kind: 'response:pipeline' });
  const orchestrator = new Orchestrator({ service: fakeService(), projectRoot, projectId: 'fixture' });

  const preview = await orchestrator.dispatch('ops', {
    capability: 'artifact',
    action: 'read',
    args: { id: artifact.id },
  });
  assert.match(preview, /Pipeline preview/);
  assert.match(preview, /tool=inspect OK/);
  assert.match(preview, /tool=verify FAIL/);
  assert.match(preview, /full:true/);

  const raw = await orchestrator.dispatch('ops', {
    capability: 'artifact',
    action: 'read',
    args: { id: artifact.id, full: true },
  });
  assert.match(raw, /\"totalActions\": 2/);
  assert.match(raw, /\"steps\":/);
});

test('profile set accepts dotted values and does not persist transport projectRoot', async () => {
  const projectRoot = makeTempProject();
  const orchestrator = new Orchestrator({ service: fakeService(), projectRoot, projectId: 'fixture' });
  await orchestrator.dispatch('ops', {
    projectRoot,
    capability: 'profile',
    action: 'set',
    args: {
      values: {
        'micro.url': 'http://127.0.0.1:1/v1',
        'micro.model': 'test-model',
        'micro.key': 'test-key',
        autoTriage: false,
      },
    },
  });
  const profile = JSON.parse(fs.readFileSync(path.join(projectRoot, '.contextos', 'profile.json'), 'utf8'));
  assert.deepEqual(profile.micro, {
    url: 'http://127.0.0.1:1/v1',
    model: 'test-model',
    key: 'test-key',
  });
  assert.equal(profile.autoTriage, false);
  assert.equal(profile.projectRoot, undefined);
});

test('change dry run previews edits without writing, touching the session, or verifying', async () => {
  const projectRoot = makeTempProject();
  const service = fakeService();
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });
  const filePath = path.join(projectRoot, 'src', 'math.mjs');
  const before = fs.readFileSync(filePath, 'utf8');

  const preview = await orchestrator.dispatch('change', {
    intent: 'preview a math change',
    dryRun: true,
    edits: [
      { path: 'src/math.mjs', target: 'return a + b;', replacement: 'return a + b + 0;' },
      { path: 'src/math.mjs', target: 'a', replacement: 'x' },
    ],
  });

  assert.match(preview, /# ContextOS change \(dry run\)/);
  assert.match(preview, /File: `src\/math\.mjs`/);
  assert.match(preview, /Target unique: true \(1 match\)/);
  assert.match(preview, /Target unique: false \(\d+ matches\)/);
  assert.match(preview, /return a \+ b;/);
  assert.match(preview, /return a \+ b \+ 0;/);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);

  const session = JSON.parse(fs.readFileSync(path.join(projectRoot, '.contextos', 'session.json'), 'utf8'));
  assert.deepEqual(session.touchedFiles, []);
  assert.deepEqual(session.receipts, []);
  assert.equal(service.calls.some((call) => call.capability === 'run'), false);
  assert.equal(
    service.calls.some((call) => call.capability === 'code' && ['create', 'edit'].includes(call.args.action)),
    false
  );
});

test('change without edits warns that architecture was not applied', async () => {
  const projectRoot = makeTempProject();
  const service = fakeService();
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  const preview = await orchestrator.dispatch('change', {
    architecture: {
      blocks: [{ id: 'block-api', title: 'API boundary', kind: 'service', paths: ['src/math.mjs'] }],
      chains: [{ id: 'chain-api', title: 'API flow', memberIds: ['block-api'] }],
    },
  });

  assert.match(preview, /# ContextOS change \(propose\)/);
  assert.match(preview, /NOT applied/);
  assert.match(preview, /bind_auto/);
  assert.equal(
    service.calls.some((call) => call.capability === 'code' && ['create', 'edit'].includes(call.args.action)),
    false
  );
});

test('ship on an unverified reopened session points at receipt re-attachment', async () => {
  const projectRoot = makeTempProject();
  const service = fakeService();
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  await orchestrator.dispatch('change', {
    intent: 'unverified edit',
    edits: [{ path: 'src/math.mjs', target: 'return a + b;', replacement: 'return a + b + 0;' }],
  });
  const shipped = await orchestrator.dispatch('ship', { summary: 'close without verify' });

  assert.match(shipped, /Passing receipts: 0/);
  assert.match(shipped, /No passing receipt in this session/);
  assert.match(shipped, /receiptIds/);
});

test('failed receipts are superseded only by the same command and remain explicit in ship output', async () => {
  const projectRoot = makeTempProject();
  const service = fakeService({ exitCodes: [1, 0, 1] });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  const failed = await orchestrator.dispatch('verify', { command: 'node --test retry.test.mjs' });
  assert.match(failed, /Verdict: FAIL/);
  const passed = await orchestrator.dispatch('verify', { command: 'node --test retry.test.mjs' });
  assert.match(passed, /Verdict: PASS/);
  const unresolved = await orchestrator.dispatch('verify', { command: 'node --test unrelated.test.mjs' });
  assert.match(unresolved, /Verdict: FAIL/);

  const shipped = await orchestrator.dispatch('ship', { summary: 'retry verification semantics' });
  assert.match(shipped, /Superseded failures: 1/);
  assert.match(shipped, /Unresolved failures: 1/);
  assert.match(shipped, /\[SUPERSEDED\]/);
  assert.match(shipped, /\[UNRESOLVED\]/);
});

test('verify reuses a passing receipt until a tracked file changes', async () => {
  const projectRoot = makeTempProject();
  const service = fakeService();
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  orchestrator.store.ensureSession('verify cache');
  orchestrator.store.attachReceipt({
    id: 'receipt-cached',
    command: 'node --test',
    cwd: projectRoot,
    exitCode: 0,
    durationMs: 3,
    stateHash: workspaceFingerprint(projectRoot),
  });

  const cached = await orchestrator.dispatch('verify', { command: 'node --test' });
  assert.match(cached, /cached PASS/);
  assert.equal(service.calls.some((call) => call.capability === 'run'), false);

  orchestrator.store.touch(['src/math.mjs'], 'edit');
  await orchestrator.dispatch('verify', { command: 'node --test' });
  assert.equal(service.calls.some((call) => call.capability === 'run'), true);
});

test('ship dry run previews the archive without closing the session or exporting the graph', async () => {
  const projectRoot = makeTempProject();
  const service = fakeService();
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  const session = orchestrator.store.ensureSession('preview the pending ship');
  orchestrator.store.touch([{ path: 'src/math.mjs' }], 'edit');
  orchestrator.store.attachReceipt({
    id: 'receipt-preview',
    command: 'node --test',
    exitCode: 0,
    durationMs: 12,
  });

  const preview = await orchestrator.dispatch('ship', { dryRun: true, summary: 'preview only' });
  assert.match(preview, /# ContextOS ship \(dry run\)/);
  assert.match(preview, /Planned summary: preview only/);
  assert.match(preview, /src\/math\.mjs/);
  assert.match(preview, /receipt-preview/);
  assert.equal(service.graphExports, 0);

  const saved = JSON.parse(fs.readFileSync(path.join(projectRoot, '.contextos', 'session.json'), 'utf8'));
  assert.equal(saved.id, session.id);
  assert.equal(saved.status, 'open');
  assert.equal(saved.closedAt, null);
  assert.equal(fs.existsSync(path.join(projectRoot, '.contextos', 'logs', 'sessions', 'history.jsonl')), false);
});

test('observer separates OS state changes from code dirtiness', async () => {
  const projectRoot = makeTempProject();

  fs.mkdirSync(path.join(projectRoot, '.contextos'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.contextos', 'graph.json'), '{"schemaVersion":3}\n');

  const touched = [];
  const store = {
    current: { touchedFiles: [] },
    touch(entries) { touched.push(...entries); },
  };
  const result = await observe({ projectRoot, store });

  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.untracked, []);
  assert.deepEqual(result.systemChanged, ['.contextos/graph.json']);
  assert.deepEqual(touched, []);
});

test('observer reconciles edits the agent made outside ContextOS', async () => {
  const projectRoot = makeTempProject();
  const service = fakeService();
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  fs.writeFileSync(path.join(projectRoot, 'src', 'extra.mjs'), 'export const extra = 1;\n');
  const explored = await orchestrator.dispatch('explore', { intent: '继续之前的工作' });
  assert.match(explored, /src\/extra\.mjs/);

  const session = JSON.parse(fs.readFileSync(path.join(projectRoot, '.contextos', 'session.json'), 'utf8'));
  assert.ok(session.touchedFiles.some((entry) => entry.path === 'src/extra.mjs'));
});

test('observer marks deleted files and ship skips their derived attribution', async () => {
  const projectRoot = makeTempProject();
  const legacyPath = path.join(projectRoot, 'src', 'legacy.mjs');
  fs.writeFileSync(legacyPath, 'export const legacy = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: projectRoot, stdio: 'ignore' });
  execFileSync(
    'git',
    ['-c', 'user.name=ContextOS', '-c', 'user.email=contextos@example.invalid', 'commit', '-m', 'fixture'],
    { cwd: projectRoot, stdio: 'ignore' }
  );
  fs.rmSync(legacyPath);

  const service = fakeService();
  const bindCalls = [];
  const originalBlock = service.block;
  service.block = async (args = {}) => {
    if (args.action === 'bind_auto') bindCalls.push(args);
    return originalBlock(args);
  };
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  await orchestrator.dispatch('explore', { intent: '继续之前的工作' });
  const session = JSON.parse(fs.readFileSync(path.join(projectRoot, '.contextos', 'session.json'), 'utf8'));
  const deleted = session.touchedFiles.find((entry) => entry.path === 'src/legacy.mjs');
  assert.equal(deleted?.deleted, true);

  await orchestrator.dispatch('ship', { summary: 'delete legacy module' });
  assert.deepEqual(bindCalls, []);
});

test('a reverted graph.json rolls the OS back instead of wedging it', async () => {
  const projectRoot = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  service.syncEngine.exportGraphToJson('fixture', projectRoot);
  service.syncEngine.exportGraphToJson('fixture', projectRoot);
  const dbRevision = service.db.getProject('fixture').graph_revision;
  assert.ok(dbRevision >= 2, `fixture needs a database revision above the stale graph (got ${dbRevision})`);

  const graphPath = path.join(projectRoot, '.contextos', 'graph.json');
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  fs.writeFileSync(graphPath, JSON.stringify({ ...graph, graphRevision: 1 }, null, 2) + '\n', 'utf8');

  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });
  const explored = await orchestrator.dispatch('explore', { intent: '读一下 src/math.mjs' });
  assert.match(explored, /# ContextOS explore/);
  // Reverting the versioned graph.json reverts SQLite with it.
  assert.equal(service.db.getProject('fixture').graph_revision, 1);
  assert.equal(service.stateConflict, null, 'no state conflict may stay open');
  const after = service.syncEngine.reconcileExternalChange('fixture', projectRoot);
  assert.equal(after.changed, false, 'after the rollback the file matches the export again');
  service.close();
});

test('observer reconciles edits the agent made outside ContextOS (legacy)', async () => {
  const projectRoot = makeTempProject();
  const service = fakeService();
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  fs.writeFileSync(path.join(projectRoot, 'src', 'extra.mjs'), 'export const extra = 1;\n');
  const explored = await orchestrator.dispatch('explore', { intent: '继续之前的工作' });
  assert.match(explored, /src\/extra\.mjs/);

  const session = JSON.parse(fs.readFileSync(path.join(projectRoot, '.contextos', 'session.json'), 'utf8'));
  assert.ok(session.touchedFiles.some((entry) => entry.path === 'src/extra.mjs'));
});

test('ops passthrough reaches legacy capabilities and rejects unknown ones', async () => {
  const projectRoot = makeTempProject();
  const service = fakeService({ exitCode: 1 });
  const planCalls = [];
  service.plan = async (args = {}) => {
    planCalls.push(args);
    return { plans: [], total: 0, limit: args.limit, status: args.status };
  };
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  const listed = await orchestrator.dispatch('ops', { capability: 'block', action: 'list' });
  assert.match(listed, /block-math/);

  await orchestrator.dispatch('ops', {
    capability: 'plan', action: 'list', status: 'active', limit: 3,
  });
  assert.deepEqual(planCalls.at(-1), { status: 'active', limit: 3, action: 'list' });

  await orchestrator.dispatch('ops', {
    capability: 'plan', action: 'list', status: 'archived',
    args: { status: 'active', limit: 1 },
  });
  assert.deepEqual(planCalls.at(-1), { status: 'active', limit: 1, action: 'list' });

  const failed = await orchestrator.dispatch('verify', { commands: ['node -e "process.exit(1)"'] });
  assert.match(failed, /Verdict: FAIL/);

  await assert.rejects(
    () => orchestrator.dispatch('ops', { capability: 'nope' }),
    /Unknown capability/
  );
});

test('directories bind as tree refs and symbols resolve in every spelling', async () => {
  const projectRoot = makeTempProject();
  fs.mkdirSync(path.join(projectRoot, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'assets', 'logo.txt'), 'logo\n');
  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  const bound = await orchestrator.dispatch('ops', {
    capability: 'block',
    action: 'bind_auto',
    args: { id: 'block-assets', path: 'assets', blockData: { title: 'Assets', kind: 'assets' } },
  });
  assert.match(bound, /TREE\//);

  const treeRef = service.db.getBlock('block-assets').artifactRefs[0];
  assert.equal(treeRef.anchorKind, 'tree');
  assert.equal(treeRef.hashMode, 'content');
  assert.ok(treeRef.hash, 'a directory binding must carry a real tree hash');

  // A directory with a manifest binds against the manifest instead of every file.
  fs.writeFileSync(path.join(projectRoot, 'assets', 'manifest.txt'), 'manifest\n');
  await orchestrator.dispatch('ops', {
    capability: 'block',
    action: 'bind_auto',
    args: { id: 'block-assets', path: 'assets', manifest: 'assets/manifest.txt' },
  });
  const manifestRef = service.db.getBlock('block-assets').artifactRefs[0];
  assert.equal(manifestRef.hashMode, 'manifest');
  assert.equal(manifestRef.manifest, 'assets/manifest.txt');

  // Bare, qualified and `#` spellings all land on the same symbol.
  for (const symbols of [['add'], ['math.add'], ['math#add']]) {
    const res = await orchestrator.dispatch('ops', {
      capability: 'block',
      action: 'bind_auto',
      args: { id: `block-math-${symbols[0].replace(/[.#]/g, '-')}`, path: 'src/math.mjs', symbols },
    });
    assert.match(res, /add/, `symbols ${JSON.stringify(symbols)} must resolve to the function`);
  }

  // An unknown symbol must fail loudly instead of binding the whole file.
  await assert.rejects(
    () => orchestrator.dispatch('ops', {
      capability: 'block',
      action: 'bind_auto',
      args: { id: 'block-bad-symbol', path: 'src/math.mjs', symbols: ['nope'] },
    }),
    /not found/
  );

  service.close();
});

test('inspect supports ranges, budget: full, and truncation hints', async () => {
  const projectRoot = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  // 1. inspect with ranges
  const inspectRanges = await orchestrator.dispatch('inspect', {
    path: 'src/math.mjs',
    ranges: [{ startLine: 1, endLine: 1 }, { startLine: 3, endLine: 3 }],
  });
  assert.match(inspectRanges, /\[L1-L1\]/);
  assert.match(inspectRanges, /export function add/);
  assert.match(inspectRanges, /\[L3-L3\]/);

  // 2. inspect with budget: full bypasses clip on long content
  const longContent = 'line\n'.repeat(600);
  fs.writeFileSync(path.join(projectRoot, 'src', 'long.mjs'), longContent);
  const inspectFull = await orchestrator.dispatch('inspect', {
    path: 'src/long.mjs',
    budget: 'full',
  });
  assert.ok(inspectFull.length > 2500);
  assert.ok(!inspectFull.includes('chars omitted'));

  // 3. inspect with small maxChars shows truncation hint
  const inspectTruncated = await orchestrator.dispatch('inspect', {
    path: 'src/long.mjs',
    maxChars: 500,
  });
  assert.match(inspectTruncated, /\[TRUNCATED: budget exceeded\. Action required: specify 'ranges: \[{startLine, endLine}\]' or pass 'budget: "full"'/);

  service.close();
});

test('inspect expands directory and glob targets without EISDIR failures', async () => {
  const projectRoot = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  const directory = await orchestrator.dispatch('inspect', { path: 'src' });
  assert.match(directory, /src\/math\.mjs/);
  assert.doesNotMatch(directory, /EISDIR/);

  const glob = await orchestrator.dispatch('inspect', { path: 'src/**' });
  assert.match(glob, /src\/math\.mjs/);
  assert.doesNotMatch(glob, /EISDIR/);

  service.close();
});

test('explore accepts directory focus paths without indexing directories as files', async () => {
  const projectRoot = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  const result = await orchestrator.dispatch('explore', {
    intent: 'understand the source tree',
    paths: ['src'],
  });
  assert.doesNotMatch(result, /EISDIR/);
  assert.match(result, /src\/math\.mjs/);

  service.close();
});

test('change supports top-level path, content, and overwrite: true', async () => {
  const projectRoot = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  const result = await orchestrator.dispatch('change', {
    path: 'src/math.mjs',
    content: 'export const PI = 3.14;\n',
    overwrite: true,
  });
  assert.match(result, /ContextOS change/);
  assert.equal(fs.readFileSync(path.join(projectRoot, 'src', 'math.mjs'), 'utf8'), 'export const PI = 3.14;\n');

  service.close();
});

test('architecture payload preflight prevents partial Block writes when a Chain is invalid', async () => {
  const projectRoot = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  const result = await orchestrator.dispatch('change', {
    path: 'src/math.mjs',
    content: 'export const PI = 3.14;\n',
    overwrite: true,
    architecture: {
      blocks: [{
        id: 'block-math',
        title: 'Math service',
        kind: 'service',
        paths: ['src/math.mjs'],
      }],
      chains: [{
        id: 'chain-invalid',
        title: 'Invalid flow',
        memberIds: ['block-missing'],
      }],
    },
  });

  assert.match(result, /Architecture update needs attention/);
  assert.match(result, /chain-invalid cannot include missing Block/);
  assert.equal(fs.readFileSync(path.join(projectRoot, 'src', 'math.mjs'), 'utf8'), 'export const PI = 3.14;\n');
  const blocks = await service.block({ action: 'list', includeRefs: true, limit: 100, offset: 0, format: 'json' });
  assert.equal(blocks.items.some((block) => block.id === 'block-math'), false);

  service.close();
});

test('ship enforces architecture completeness gate when strictArchitecture is enabled', async () => {
  const projectRoot = makeTempProject();
  fs.mkdirSync(path.join(projectRoot, '.contextos'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, '.contextos', 'profile.json'),
    JSON.stringify({ strictArchitecture: true, verify: ['node -e "0"'] }, null, 2)
  );

  // Add an application file in apps/demo/app.mjs
  fs.mkdirSync(path.join(projectRoot, 'apps', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'apps', 'demo', 'app.mjs'), 'export const app = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: projectRoot, stdio: 'ignore' });
  execFileSync('git', [
    '-c', 'user.name=ContextOS',
    '-c', 'user.email=contextos@example.test',
    'commit', '-m', 'fixture strict architecture baseline',
  ], { cwd: projectRoot, stdio: 'ignore' });

  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  // Touch the file in change
  await orchestrator.dispatch('change', {
    path: 'apps/demo/app.mjs',
    content: 'export const app = 2;\n',
    overwrite: true,
    verify: true,
  });

  // ship should be BLOCKED because apps/demo/app.mjs is not covered by a curated block
  const shipBlocked = await orchestrator.dispatch('ship', { summary: 'test ship blocked' });
  assert.match(shipBlocked, /# ContextOS ship — BLOCKED \(architecture governance gate\)/);
  assert.match(shipBlocked, /apps\/demo\/app\.mjs/);

  // Now bind a curated block covering apps/demo
  await orchestrator.dispatch('ops', {
    capability: 'block',
    action: 'bind_auto',
    args: {
      id: 'block-demo',
      path: 'apps/demo',
      blockData: { title: 'Demo App', kind: 'app' },
    },
  });

  // Link to a chain
  await orchestrator.dispatch('ops', {
    capability: 'chain',
    action: 'compose',
    args: {
      chainData: { id: 'chain-demo', title: 'Demo Chain', memberIds: ['block-demo'] },
    },
  });

  // ship should now succeed!
  const shipPassed = await orchestrator.dispatch('ship', { summary: 'test ship passed' });
  assert.match(shipPassed, /# ContextOS ship/);
  assert.ok(!shipPassed.includes('BLOCKED'));

  service.close();
});

test('pipeline executes parallel and sequential chains with any tool', async () => {
  const dir = makeTempProject();
  const service = fakeService({ exitCode: 0 });
  const orchestrator = new Orchestrator({ service, projectRoot: dir, projectId: 'fixture' });

  // 1. Parallel inspect + ops run_command
  const parallelRes = await orchestrator.dispatch('pipeline', {
    steps: [
      {
        parallel: [
          { action: 'inspect', args: { path: 'src/math.mjs' } },
          { action: 'ops', args: { capability: 'run_command', args: { command: 'git status' } } },
          { tool: 'inspect', path: 'src/math.mjs' },
        ],
      },
    ],
  });
  assert.match(parallelRes, /pipeline=OK/);
  assert.match(parallelRes, /parallel#1 OK/);

  // 2. Sequential chain: change -> verify
  const chainRes = await orchestrator.dispatch('pipeline', {
    steps: [
      {
        chain: [
          { action: 'change', args: { edits: [{ path: 'src/math.mjs', target: 'return a + b;', replacement: 'return a + b + 1;' }] } },
          { action: 'verify', args: { command: 'npm test' } },
          { change: { path: 'src/math.mjs', target: 'return a + b + 1;', replacement: 'return a + b + 2;' } },
          { verify: 'npm test' },
        ],
      },
    ],
  });
  assert.match(chainRes, /pipeline=OK/);
  assert.match(chainRes, /chain#1 OK/);

  // Status-looking text in inspected source is content, not a failed action.
  const statusText = ['Verdict: FAIL', 'Verify: FAIL', 'BLOCKED', 'pipeline=HALTED', '{"ok": false}', 'exit 3'].join('\n');
  fs.writeFileSync(path.join(dir, 'src', 'status-text.mjs'), `/*\n${statusText}\n*/\nexport const status = true;\n`);
  const inspectChainRes = await orchestrator.dispatch('pipeline', {
    steps: [{
      chain: [
        { action: 'inspect', args: { path: 'src/status-text.mjs', budget: 'full' } },
        { action: 'verify', args: { command: 'node --check src/status-text.mjs' } },
      ],
    }],
  });
  assert.match(inspectChainRes, /pipeline=OK/);
  assert.match(inspectChainRes, /chain#1 OK/);
});

test('pipeline preserves artifacts and honors nested full output requests', async () => {
  const dir = makeTempProject();
  fs.writeFileSync(path.join(dir, 'src', 'large.mjs'), `export const payload = '${'x'.repeat(6000)}';\n`);
  const service = new ContextOSV2Service({ projectRoot: dir, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot: dir, projectId: 'fixture' });

  const truncated = await orchestrator.dispatch('pipeline', {
    parallel: [{ inspect: { path: 'src/large.mjs', maxChars: 300 } }],
    maxChars: 500,
  });
  assert.match(truncated, /artifact=/);
  assert.match(truncated, /os-response tool=pipeline artifact=/);

  const full = await orchestrator.dispatch('pipeline', {
    parallel: [{ inspect: { path: 'src/large.mjs', budget: 'full' } }],
  });
  assert.ok(full.includes('x'.repeat(1000)));
  assert.doesNotMatch(full, /artifact=/);

  service.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('path-only inspect returns whole small files and outlines large ones', async () => {
  const dir = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot: dir, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot: dir, projectId: 'fixture' });

  const small = await orchestrator.dispatch('inspect', { path: 'src/math.mjs' });
  assert.match(small, /export function add/);
  assert.doesNotMatch(small, /body not inlined/);

  fs.writeFileSync(
    path.join(dir, 'src', 'large.mjs'),
    `export const payload = '${'x'.repeat(6000)}';\nexport function helper() { return 1; }\n`
  );
  const large = await orchestrator.dispatch('inspect', { path: 'src/large.mjs' });
  assert.match(large, /AST Outline/);
  assert.match(large, /body not inlined/);
  assert.doesNotMatch(large, /x{200}/);

  const targeted = await orchestrator.dispatch('inspect', { path: 'src/large.mjs', symbol: 'helper' });
  assert.match(targeted, /helper/);
  assert.doesNotMatch(targeted, /body not inlined/);

  const full = await orchestrator.dispatch('inspect', { path: 'src/large.mjs', budget: 'full' });
  assert.match(full, /x{200}/);

  service.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('work batches search, inspect, create, and verify into one host transaction', async () => {
  const dir = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot: dir, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot: dir, projectId: 'fixture' });

  const verifyCommand = `node -e "const fs=require('node:fs');if(!fs.existsSync('src/work.mjs'))process.exit(1);fs.writeFileSync('.verify-ran','yes')"`;
  const result = await orchestrator.dispatch('work', {
    search: { query: 'add', maxResults: 5 },
    inspect: { path: 'src/math.mjs' },
    create: [{ path: 'src/work.mjs', content: 'export const value = 1;\n' }],
    commands: [verifyCommand],
  });

  assert.match(result, /work=OK/);
  assert.match(result, /Search: `add`/);
  assert.match(result, /parallel#1 OK/);
  assert.match(result, /change=OK/);
  assert.match(result, /done: verified/);
  assert.doesNotMatch(result, /👉 verify\(/);
  assert.ok(fs.existsSync(path.join(dir, 'src', 'work.mjs')));
  assert.equal(fs.readFileSync(path.join(dir, '.verify-ran'), 'utf8'), 'yes');
  service.close();
});

test('pipeline bounds parallel fan-out while preserving every action result', async () => {
  const dir = makeTempProject();
  const service = fakeService();
  let active = 0;
  let peak = 0;
  const originalCode = service.code;
  service.code = async (args) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 12));
    try {
      return await originalCode(args);
    } finally {
      active -= 1;
    }
  };
  const orchestrator = new Orchestrator({ service, projectRoot: dir, projectId: 'fixture' });

  const result = await orchestrator.dispatch('pipeline', {
    parallelConcurrency: 2,
    steps: [{
      parallel: Array.from({ length: 5 }, (_, index) => ({
        action: 'inspect',
        args: { path: 'src/math.mjs', symbol: `add-${index}` },
      })),
    }],
  });

  assert.match(result, /parallel#1 OK/);
  assert.equal(peak, 2, 'parallel Pipeline actions must respect the requested concurrency cap');
  assert.equal((result.match(/inspect=OK/g) || []).length, 5, 'bounded scheduling must not drop actions');
});

test('work and pipeline preserve explicit verification failures', async () => {
  const dir = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot: dir, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot: dir, projectId: 'fixture' });
  const command = 'node -e "process.exit(3)"';

  const workResult = await orchestrator.dispatch('work', {
    create: [{ path: 'src/failing.mjs', content: 'export const value = 1;\\n' }],
    commands: [command],
  });
  assert.match(workResult, /work=HALTED/);
  assert.match(workResult, /Verify: FAIL/);
  assert.match(workResult, /exit 3/);
  assert.match(workResult, /receipt=[A-Za-z0-9._-]+/, 'bounded work failures must preserve the receipt locator');
  assert.ok(fs.existsSync(path.join(dir, 'src', 'failing.mjs')));
  assert.doesNotMatch(workResult, /Cannot read properties of undefined/);

  const pipelineResult = await orchestrator.dispatch('pipeline', {
    steps: [{ verify: [command] }],
  });
  assert.match(pipelineResult, /Verdict: FAIL/);
  assert.doesNotMatch(pipelineResult, /Cannot read properties of undefined/);

  service.close();
});

test('bounded work failure recovers receipt locators from the session when the child output is clipped', async () => {
  const dir = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot: dir, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot: dir, projectId: 'fixture' });
  const first = 'node -e "process.exit(2)"';
  const second = 'node -e "process.exit(3)"';

  const result = await orchestrator.dispatch('work', {
    create: [{ path: 'src/clipped-failure.mjs', content: 'export const value = 1;\\n' }],
    commands: [first, second],
    maxChars: 300,
  });

  assert.match(result, /work=HALTED/);
  assert.match(result, /receipt=[A-Za-z0-9._-]+/, 'a clipped child failure must still expose a session receipt');
  assert.equal(orchestrator.store.current.receipts.length, 2);
  service.close();
});

test('change strips ContextOS inspect metadata headers from edit targets', async () => {
  const dir = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot: dir, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot: dir, projectId: 'fixture' });
  const target = [
    '// src/math.mjs [L1-L4] (hash: a1b2c3)',
    'export function add(a, b) {',
    '  return a + b;',
    '}',
    '',
  ].join('\n');

  const result = await orchestrator.dispatch('change', {
    edits: [{ path: 'src/math.mjs', target, replacement: 'export const add = (a, b) => a + b;\n' }],
  });
  assert.match(result, /edited `src\/math\.mjs`/);
  assert.match(fs.readFileSync(path.join(dir, 'src', 'math.mjs'), 'utf8'), /export const add/);
  service.close();
});

test('pipeline preserves nested action output budgets', async () => {
  const dir = makeTempProject();
  const largeFile = path.join(dir, 'src', 'large.txt');
  fs.writeFileSync(largeFile, `BEGIN\n${'x'.repeat(4000)}\nEND_MARKER\n`);

  const service = new ContextOSV2Service({ projectRoot: dir, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot: dir, projectId: 'fixture' });

  const result = await orchestrator.dispatch('pipeline', {
    mode: 'full',
    maxChars: 8000,
    steps: [
      {
        parallel: [
          {
            inspect: {
              path: 'src/large.txt',
              budget: 'full',
              maxChars: 6000,
            },
          },
        ],
      },
    ],
  });

  assert.match(result, /END_MARKER/);
  service.close();
});

test('pipeline enforces an aggregate response budget by default', async () => {
  const dir = makeTempProject();
  fs.writeFileSync(path.join(dir, 'src', 'large.txt'), `BEGIN\n${'y'.repeat(12000)}\nEND_MARKER\n`);

  const service = new ContextOSV2Service({ projectRoot: dir, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot: dir, projectId: 'fixture' });
  const result = await orchestrator.dispatch('pipeline', {
    steps: [{ inspect: { path: 'src/large.txt', budget: 'full' } }],
  });

  assert.match(result, /os-budget/);
  assert.ok(result.length <= 4300, `pipeline output should be bounded, got ${result.length}`);
  assert.ok(!result.includes('END_MARKER'));
  service.close();
});

test('pipeline keeps advanced ops children bounded even in full mode', async () => {
  const dir = makeTempProject();
  const service = fakeService();
  service.block = async () => ({ items: [{ id: 'block-large', details: 'x'.repeat(12000) }] });
  const orchestrator = new Orchestrator({ service, projectRoot: dir, projectId: 'fixture' });
  const result = await orchestrator.dispatch('pipeline', {
    mode: 'full',
    maxChars: 12000,
    steps: [{ tool: 'ops', args: { capability: 'block', action: 'list', full: true, maxChars: 12000 } }],
  });
  assert.ok(result.length < 3000, `ops child should stay bounded, got ${result.length}`);
});

test('pipeline receipt mode returns only status references and stays bounded', async () => {
  const dir = makeTempProject();
  fs.writeFileSync(path.join(dir, 'src', 'large.txt'), `BEGIN\n${'z'.repeat(12000)}\nEND_MARKER\n`);
  const service = new ContextOSV2Service({ projectRoot: dir, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot: dir, projectId: 'fixture' });

  const result = await orchestrator.dispatch('pipeline', {
    mode: 'receipt',
    steps: [{ inspect: { path: 'src/large.txt', budget: 'full' } }],
  });

  assert.match(result, /mode=receipt/);
  assert.match(result, /inspect=OK ok/);
  assert.ok(!result.includes('END_MARKER'));
  assert.ok(result.length < 1000, `receipt mode should stay compact, got ${result.length}`);
  service.close();
});

test('ModuleIndex indexes manifests and config files, extracting structural properties', () => {
  const dir = makeTempProject();
  fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "desktop"\nversion = "2.5.5"\n');
  fs.writeFileSync(path.join(dir, 'tauri.conf.json'), JSON.stringify({ version: '2.5.5', build: 'custom' }, null, 2));

  const index = new ModuleIndex({ projectRoot: dir });
  const discovered = index.discover();
  assert.ok(discovered.includes('Cargo.toml'), 'Cargo.toml should be discovered');
  assert.ok(discovered.includes('tauri.conf.json'), 'tauri.conf.json should be discovered');

  index.ensure(['Cargo.toml', 'tauri.conf.json', 'package.json']);
  const matches = index.lookup('version');
  assert.ok(matches.length > 0, 'lookup version should return modules containing version configs');
});

test('ModuleIndex removes deleted and unsafe cache entries on load', () => {
  const dir = makeTempProject();
  const cachePath = path.join(dir, '.contextos', 'module-index.json');
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({
    entries: [
      { path: 'src/math.mjs', mtimeMs: 1, size: 1, language: 'javascript', symbols: [], imports: [] },
      { path: 'src/deleted.mjs', mtimeMs: 1, size: 1, language: 'javascript', symbols: [], imports: [] },
      { path: '../outside.mjs', mtimeMs: 1, size: 1, language: 'javascript', symbols: [], imports: [] },
    ],
  }));

  const index = new ModuleIndex({ projectRoot: dir });
  assert.equal(index.entries.has('src/math.mjs'), true);
  assert.equal(index.entries.has('src/deleted.mjs'), false);
  assert.equal(index.entries.has('../outside.mjs'), false);
  const persisted = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.deepEqual(persisted.entries.map((entry) => entry.path), ['src/math.mjs']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('explore automatically highlights active plan in Now section', async () => {
  const projectRoot = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  // Create an active plan with phases and checkpoints
  await orchestrator.dispatch('ops', {
    capability: 'plan',
    action: 'create',
    args: {
      planData: {
        id: 'plan-test-active',
        title: 'Active Plan Test',
        summary: 'Test summary',
        status: 'active',
        phases: [{ id: 'P1', order: 1, objective: 'Phase 1', status: 'active', acceptance: ['Criteria 1'] }],
      },
    },
  });

  const explored = await orchestrator.dispatch('explore', { intent: 'check status' });
  assert.match(explored, /## Now/);
  assert.match(explored, /- Active Plan: `plan-test-active` "Active Plan Test"/);

  service.close();
});

test('ops plan get returns native markdown for multi-line summary', async () => {
  const projectRoot = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  await orchestrator.dispatch('ops', {
    capability: 'plan',
    action: 'create',
    args: {
      planData: {
        id: 'plan-doc-test',
        title: 'Doc Test',
        summary: '### Specification Header\nDetailed paragraph here.\n- List item 1\n- List item 2',
        status: 'active',
        phases: [{ id: 'P1', order: 1, objective: 'Doc Phase', status: 'active', acceptance: ['Doc criteria'] }],
      },
    },
  });

  const planMarkdown = await orchestrator.dispatch('ops', {
    capability: 'plan',
    action: 'get',
    args: { id: 'plan-doc-test' },
  });

  assert.match(planMarkdown, /# Plan: \[plan-doc-test\] Doc Test/);
  assert.match(planMarkdown, /## Specification \/ Summary:/);
  assert.match(planMarkdown, /### Specification Header/);
  assert.ok(!planMarkdown.includes('\\n'), 'Markdown should not be JSON stringified with escaped newlines');

  service.close();
});

test('ops supports micro capability and verify triggers micro triage on failure', async () => {
  const http = await import('node:http');
  const pingToolAvailability = [];
  const mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (parsed.messages?.some((message) => message.content?.includes('ping'))) {
        pingToolAvailability.push(Array.isArray(parsed.tools) && parsed.tools.length > 0);
      }
      const isTriage = parsed.messages?.some((m) => m.content?.includes('分析以下测试'));
      const isWithOS = parsed.messages?.some((m) => m.content?.includes('inspect codebase'));
      if (isWithOS && (!Array.isArray(parsed.tools) || parsed.tools.length === 0)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Expected tools when withOS=true' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: isTriage ? '出错文件: test.mjs，修复建议: 修正返回值' : 'micro inference ok',
              },
            },
          ],
        })
      );
    });
  });

  const { port } = await new Promise((resolve) => {
    mockServer.listen(0, '127.0.0.1', () => resolve({ port: mockServer.address().port }));
  });

  try {
    const projectRoot = makeTempProject();
    fs.mkdirSync(path.join(projectRoot, '.contextos'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.contextos', 'profile.json'),
      JSON.stringify(
        {
          micro: {
            url: `http://127.0.0.1:${port}`,
            model: 'mock-micro-model',
          },
        },
        null,
        2
      )
    );

    const service = fakeService({ exitCode: 1 });
    const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

    // 1. Direct ops micro
    const microDirect = await orchestrator.dispatch('ops', {
      capability: 'micro',
      args: { prompt: 'ping' },
    });
    assert.match(microDirect, /micro inference ok/);
    assert.equal(
      pingToolAvailability.at(-1),
      true,
      'OS-dispatched Micro must default to executor mode when the request budget allows a tool round and final answer',
    );

    const doctorProbe = JSON.parse(await orchestrator.dispatch('ops', {
      capability: 'micro',
      action: 'doctor',
      args: { probe: true },
    }));
    assert.equal(doctorProbe.ok, true);
    assert.equal(
      doctorProbe.checks.find((check) => check.name === 'provider')?.ok,
      true,
    );

    // 2. Direct ops micro batch
    const microBatch = await orchestrator.dispatch('ops', {
      capability: 'micro',
      action: 'batch',
      args: { tasks: [{ id: 'b1', prompt: 'ping' }] },
    });
    assert.match(microBatch, /micro inference ok/);

    // 3. Micro remains composable through pipeline/chain orchestration
    const microPipeline = await orchestrator.dispatch('pipeline', {
      chain: [
        { tool: 'ops', args: { capability: 'micro', action: 'run', args: { prompt: 'ping' } } },
      ],
    });
    assert.match(microPipeline, /pipeline=OK/);
    assert.match(microPipeline, /micro inference ok/);

    // 4. verify failure triggers micro triage
    const verifyFail = await orchestrator.dispatch('verify', {
      commands: ['node -e "process.exit(1)"'],
      autoTriage: true,
    });
    assert.match(verifyFail, /Verdict: FAIL/);
    assert.match(verifyFail, /👉 Micro-Triage \(工程诊断小脑\)/);
    assert.match(verifyFail, /出错文件: test\.mjs/);
    const microUsagePath = path.join(projectRoot, '.contextos', 'logs', 'micro-usage.jsonl');
    const microUsage = fs.readFileSync(microUsagePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(microUsage.some((entry) => entry.preset === 'triage' && entry.hostSessionId === orchestrator.store.current.id));

    // 5. Large failure evidence auto-routes to Micro even without autoTriage:true,
    // and mode:"full" remains an output mode instead of a process action.
    service.runCommand = async (args) => ({
      id: 'receipt-large-failure',
      command: args.command,
      cwd: null,
      exitCode: 1,
      durationMs: 3,
      diagnostics: [`AssertionError: ${'failure evidence '.repeat(180)}`],
      summary: 'failed',
    });
    const verifyLarge = await orchestrator.dispatch('verify', {
      commands: ['node -e "process.exit(1)"'],
      mode: 'full',
    });
    assert.match(verifyLarge, /Verdict: FAIL/);
    assert.match(verifyLarge, /👉 Micro-Triage \(工程诊断小脑\)/);
    assert.match(verifyLarge, /出错文件: test\.mjs/);

    // 6. Default (non-full) failure output keeps the diagnosis and a locator
    // instead of re-sending the raw log Micro already summarized.
    const verifyCompact = await orchestrator.dispatch('verify', {
      commands: ['node -e "process.exit(1)"'],
    });
    assert.match(verifyCompact, /👉 Micro-Triage \(工程诊断小脑\)/);
    assert.match(verifyCompact, /raw failure log kept in the verification receipt/);
    assert.ok(
      verifyCompact.length < verifyLarge.length,
      `compact verify (${verifyCompact.length}) must be smaller than full verify (${verifyLarge.length})`
    );
    assert.doesNotMatch(verifyLarge, /Unknown process action: full/);

    // 6. Direct ops micro withOS: true attaches tools and caps
    const microWithOS = await orchestrator.dispatch('ops', {
      capability: 'micro',
      args: { prompt: 'inspect codebase', withOS: true },
    });
    assert.match(microWithOS, /micro inference ok/);

    // 7. Native inspect capability is exposed on caps
    const ctx = orchestrator._context();
    assert.equal(typeof ctx.caps.inspect, 'function');
  } finally {
    await new Promise((resolve) => mockServer.close(resolve));
  }
});

test('late read-only Micro evidence is skipped after successful mutation and verification', async () => {
  const projectRoot = makeTempProject();
  fs.mkdirSync(path.join(projectRoot, '.contextos'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.contextos', 'profile.json'), JSON.stringify({
    micro: { url: 'http://127.0.0.1:1/v1', model: 'unreachable-test-model', timeoutMs: 100 },
  }, null, 2));
  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  await orchestrator.dispatch('change', {
    edits: [{
      path: 'src/math.mjs',
      fullFile: true,
      replacement: 'export function add(a, b) { return a + b; }\n',
    }],
  });
  await orchestrator.dispatch('verify', { command: 'node --check src/math.mjs' });

  const skipped = JSON.parse(await orchestrator.dispatch('ops', {
    capability: 'micro',
    action: 'run',
    args: {
      preset: 'evidence',
      task: 'summarize the source after the implementation',
      pipeline: { steps: [{ inspect: { path: 'src/math.mjs' } }], maxChars: 1200 },
    },
  }));
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, 'late-read-only-evidence');

  const explicit = JSON.parse(await orchestrator.dispatch('ops', {
    capability: 'micro',
    action: 'run',
    args: {
      preset: 'evidence',
      task: 'explicit post-verify audit',
      allowLate: true,
      pipeline: { steps: [{ inspect: { path: 'src/math.mjs' } }], maxChars: 1200 },
    },
  }));
  assert.equal(explicit.skipped, undefined);
  assert.equal(explicit.ok, false);

  service.close();
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('self-heal reconciles once and only reruns when graph state becomes dirty', async () => {
  const projectRoot = makeTempProject();
  let reconcileCalls = 0;
  let graphDirty = false;
  const service = {
    projectId: 'fixture',
    osContext: async () => { reconcileCalls += 1; },
    healStateConflict: () => null,
    db: { isGraphDirty: () => graphDirty },
  };
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });
  await orchestrator._selfHeal();
  await orchestrator._selfHeal();
  assert.equal(reconcileCalls, 1);
  graphDirty = true;
  await orchestrator._selfHeal();
  assert.equal(reconcileCalls, 2);
});

test('work keeps full small inspect output alongside mutation receipts', async () => {
  const dir = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot: dir, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot: dir, projectId: 'fixture' });

  const result = await orchestrator.dispatch('work', {
    inspect: { path: 'src/math.mjs' },
    create: [{ path: 'src/work.mjs', content: 'export const value = 1;\n' }],
    verify: ['node --check src/work.mjs'],
  });

  assert.match(result, /work=OK/);
  assert.match(result, /return a \+ b/);
  assert.match(result, /change=OK/);
  service.close();
});

test('verify rejects malformed command payloads instead of reporting empty PASS', async () => {
  const dir = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot: dir, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot: dir, projectId: 'fixture' });

  const result = await orchestrator.dispatch('verify', {
    commands: [{ command: 'npm test' }],
  });

  assert.match(result, /Verdict: FAIL/);
  assert.match(result, /Invalid verification command/);
  service.close();
});

test('inspect accepts nested payloads and change accepts targetContent aliases', async () => {
  const dir = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot: dir, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot: dir, projectId: 'fixture' });

  const inspectResult = await orchestrator.dispatch('inspect', {
    inspect: { path: 'src/math.mjs', budget: 'full' },
  });
  assert.match(inspectResult, /return a \+ b/);

  const changeResult = await orchestrator.dispatch('change', {
    edits: [{
      path: 'src/math.mjs',
      targetContent: 'export function add(a, b) {',
      replacementContent: 'export function add(a, b) {',
    }],
    verify: ['node --check src/math.mjs'],
  });
  assert.match(changeResult, /edited `src\/math\.mjs`/);
  service.close();
});
