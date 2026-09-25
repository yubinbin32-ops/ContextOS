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
import { ModuleIndex } from '../src/module-index.mjs';
import { workspaceFingerprint } from '../src/session-store.mjs';
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
});

test('pipeline preserves artifacts and honors nested full output requests', async () => {
  const dir = makeTempProject();
  fs.writeFileSync(path.join(dir, 'src', 'large.mjs'), `export const payload = '${'x'.repeat(6000)}';\n`);
  const service = new ContextOSV2Service({ projectRoot: dir, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot: dir, projectId: 'fixture' });

  const truncated = await orchestrator.dispatch('pipeline', {
    parallel: [{ inspect: { path: 'src/large.mjs' } }],
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

test('work batches inspect, create, and verify into one host transaction', async () => {
  const dir = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot: dir, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot: dir, projectId: 'fixture' });

  const result = await orchestrator.dispatch('work', {
    inspect: { path: 'src/math.mjs' },
    create: [{ path: 'src/work.mjs', content: 'export const value = 1;\n' }],
    verify: ['node --check src/work.mjs'],
  });

  assert.match(result, /work=OK/);
  assert.match(result, /parallel#1 OK/);
  assert.match(result, /change=OK/);
  assert.ok(fs.existsSync(path.join(dir, 'src', 'work.mjs')));
  service.close();
});

test('work and pipeline preserve explicit verification failures', async () => {
  const dir = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot: dir, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot: dir, projectId: 'fixture' });
  const command = 'node -e "process.exit(3)"';

  const workResult = await orchestrator.dispatch('work', { verify: [command] });
  assert.match(workResult, /Verdict: FAIL/);
  assert.doesNotMatch(workResult, /Cannot read properties of undefined/);

  const pipelineResult = await orchestrator.dispatch('pipeline', {
    steps: [{ verify: [command] }],
  });
  assert.match(pipelineResult, /Verdict: FAIL/);
  assert.doesNotMatch(pipelineResult, /Cannot read properties of undefined/);

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
  const mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
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

    // 5. Direct ops micro withOS: true attaches tools and caps
    const microWithOS = await orchestrator.dispatch('ops', {
      capability: 'micro',
      args: { prompt: 'inspect codebase', withOS: true },
    });
    assert.match(microWithOS, /micro inference ok/);

    // 6. Native inspect capability is exposed on caps
    const ctx = orchestrator._context();
    assert.equal(typeof ctx.caps.inspect, 'function');
  } finally {
    await new Promise((resolve) => mockServer.close(resolve));
  }
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
