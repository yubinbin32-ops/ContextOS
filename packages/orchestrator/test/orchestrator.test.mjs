import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { Orchestrator } from '../src/index.mjs';
import { observe } from '../src/observer.mjs';
import { classifyIntent, extractPaths } from '../src/intent-router.mjs';
import { fitSections } from '../src/context-budget.mjs';
import { ContextOSV2Service } from '../../mcp/src/v2-service.mjs';

function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-orch-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "0"' } }, null, 2));
  fs.writeFileSync(path.join(dir, 'src', 'math.mjs'), 'export function add(a, b) {\n  return a + b;\n}\n');
  try {
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  } catch (_) {}
  return dir;
}

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

  const sessionFile = path.join(projectRoot, '.contextos', 'session.json');
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  assert.equal(session.status, 'closed');
  assert.ok(session.touchedFiles.some((entry) => entry.path === 'src/math.mjs'));
  assert.equal(session.receipts.length, 1);
  assert.ok(fs.existsSync(path.join(projectRoot, '.contextos', 'logs', 'sessions', 'history.jsonl')));
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
  execFileSync('git', ['add', '.'], { cwd: projectRoot, stdio: 'ignore' });
  execFileSync(
    'git',
    ['-c', 'user.name=ContextOS', '-c', 'user.email=contextos@example.invalid', 'commit', '-m', 'fixture'],
    { cwd: projectRoot, stdio: 'ignore' }
  );
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
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  const listed = await orchestrator.dispatch('ops', { capability: 'block', action: 'list' });
  assert.match(listed, /block-math/);

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
