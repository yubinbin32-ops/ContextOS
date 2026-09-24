import assert from 'node:assert/strict';
import fs from 'node:fs';
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
          }
        }
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
    assert.ok(res.includes('👉 ship'), 'next step should directly recommend ship');
    
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

    // Verify Action Slots and Code Slices
    assert.ok(res.includes('Available Action Slots'), 'explore must return Action Slots');
    assert.ok(res.includes('[S1]'), 'must include slot S1');
    assert.ok(res.includes('Code Slices'), 'must include direct code slice preview');
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
    });
    assert.ok(exploreRes.includes('[S1]'), 'explore must define slot S1');
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
    assert.ok(changeRes.includes('Milestone Reached'), 'must indicate milestone reached');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
