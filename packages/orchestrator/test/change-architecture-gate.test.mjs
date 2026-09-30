import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ContextOSV2Service } from '../../mcp/src/v2-service.mjs';
import { Orchestrator } from '../src/index.mjs';

const workspace = () => fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-arch-gate-'));

test('a canvas project blocks a change until every touched file has one Block and one Chain', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'owned.mjs'), 'export const owned = 1;\n');
  fs.writeFileSync(path.join(root, 'loose.mjs'), 'export const loose = 1;\n');
  const service = new ContextOSV2Service({ projectRoot: root });
  const orchestrator = new Orchestrator({ projectRoot: root, service });
  try {
    const seeded = await orchestrator.dispatch('change', {
      edits: [{ path: 'owned.mjs', target: 'owned = 1', replacement: 'owned = 2' }],
      architecture: { blocks: [{ id: 'owned-block', title: 'Owned surface', paths: ['owned.mjs'] }] },
      verify: { commands: ['node --check owned.mjs'] },
    });
    assert.match(seeded, /Verify: PASS/);

    const blocked = await orchestrator.dispatch('change', {
      edits: [{ path: 'loose.mjs', target: 'loose = 1', replacement: 'loose = 2' }],
      verify: { commands: ['node --check loose.mjs'] },
    });
    assert.match(blocked, /ARCHITECTURE_REQUIRED/);
    assert.match(blocked, /No files were modified/);
    assert.equal(fs.readFileSync(path.join(root, 'loose.mjs'), 'utf8'), 'export const loose = 1;\n');

    const payload = /Ready-to-paste architecture: `([^`]+)`/.exec(blocked);
    assert.ok(payload, blocked);
    const architecture = JSON.parse(payload[1]);
    assert.equal(architecture.blocks.length, 1);

    const retried = await orchestrator.dispatch('change', {
      edits: [{ path: 'loose.mjs', target: 'loose = 1', replacement: 'loose = 2' }],
      architecture,
      verify: { commands: ['node --check loose.mjs'] },
    });
    assert.match(retried, /Verify: PASS/);
    assert.equal(fs.readFileSync(path.join(root, 'loose.mjs'), 'utf8'), 'export const loose = 2;\n');
    const block = await service.block({ action: 'open', id: architecture.blocks[0].id, format: 'json' });
    assert.ok(block.artifactRefs.some((ref) => ref.path === 'loose.mjs'));
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a greenfield project keeps the previous no-architecture flow', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'fresh.mjs'), 'export const fresh = 1;\n');
  const service = new ContextOSV2Service({ projectRoot: root });
  const orchestrator = new Orchestrator({ projectRoot: root, service });
  try {
    const result = await orchestrator.dispatch('change', {
      edits: [{ path: 'fresh.mjs', target: 'fresh = 1', replacement: 'fresh = 2' }],
      verify: { commands: ['node --check fresh.mjs'] },
    });
    assert.match(result, /Verify: PASS/);
    assert.equal(fs.readFileSync(path.join(root, 'fresh.mjs'), 'utf8'), 'export const fresh = 2;\n');
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an edit target pasted from a read result applies without retyping the body', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'pasted.mjs'), 'export function value() {\n  return 1;\n}\n');
  const service = new ContextOSV2Service({ projectRoot: root });
  const orchestrator = new Orchestrator({ projectRoot: root, service });
  try {
    const target = ['```js', '// pasted.mjs [L2-L2] (hash: deadbeef)', '   2 |   return 1;', '```'].join('\n');
    const result = await orchestrator.dispatch('change', {
      edits: [{ path: 'pasted.mjs', target, replacement: '  return 2;' }],
      verify: { commands: ['node --check pasted.mjs'] },
    });
    assert.match(result, /Verify: PASS/);
    assert.equal(fs.readFileSync(path.join(root, 'pasted.mjs'), 'utf8'), 'export function value() {\n  return 2;\n}\n');
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a directory Block path covers its files before the first write', async () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/index.mjs'), 'export const index = 1;\n');
  const service = new ContextOSV2Service({ projectRoot: root });
  const orchestrator = new Orchestrator({ projectRoot: root, service });
  try {
    const seeded = await orchestrator.dispatch('change', {
      edits: [{ path: 'src/index.mjs', target: 'index = 1', replacement: 'index = 2' }],
      architecture: { blocks: [{ id: 'src-block', title: 'Source surface', paths: ['src'] }] },
      verify: { commands: ['node --check src/index.mjs'] },
    });
    assert.doesNotMatch(seeded, /ARCHITECTURE_REQUIRED/);
    assert.match(seeded, /Verify: PASS/);
    assert.equal(fs.readFileSync(path.join(root, 'src/index.mjs'), 'utf8'), 'export const index = 2;\n');

    const followUp = await orchestrator.dispatch('change', {
      edits: [{ path: path.join(root, 'src/index.mjs'), target: 'index = 2', replacement: 'index = 3' }],
      verify: { commands: ['node --check src/index.mjs'] },
    });
    assert.doesNotMatch(followUp, /ARCHITECTURE_REQUIRED/);
    assert.match(followUp, /Verify: PASS/);
    assert.equal(fs.readFileSync(path.join(root, 'src/index.mjs'), 'utf8'), 'export const index = 3;\n');
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unchained Block owner keeps the change contract ready', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'unchained.mjs'), 'export const unchained = 1;\n');
  const service = new ContextOSV2Service({ projectRoot: root });
  const orchestrator = new Orchestrator({ projectRoot: root, service });
  try {
    await service.block({
      action: 'bind_auto',
      id: 'unchained-block',
      paths: ['unchained.mjs'],
      refreshPaths: true,
      blockData: { title: 'Unchained surface', kind: 'component' },
      format: 'json',
    });
    const result = await orchestrator.dispatch('change', {
      edits: [{ path: 'unchained.mjs', target: 'unchained = 1', replacement: 'unchained = 2' }],
      verify: { commands: ['node --check unchained.mjs'] },
    });
    assert.match(result, /Verify: PASS/);
    const status = JSON.parse(/^status=(\{.*\})$/m.exec(result)[1]);
    assert.equal(status.architectureReady, true);
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a directory Block created by the same changeset binds as a tree', async () => {
  const root = workspace();
  const service = new ContextOSV2Service({ projectRoot: root });
  const orchestrator = new Orchestrator({ projectRoot: root, service });
  try {
    const result = await orchestrator.dispatch('change', {
      create: [
        { path: 'lib/new/index.mjs', content: 'export const value = 1;\n' },
        { path: 'lib/new/helper.mjs', content: 'export const helper = 1;\n' },
      ],
      architecture: { blocks: [{ id: 'lib-new', title: 'New library', paths: ['lib/new'] }] },
      verify: { commands: ['node --check lib/new/index.mjs'] },
    });
    assert.doesNotMatch(result, /ARCHITECTURE_REQUIRED/);
    assert.match(result, /Verify: PASS/);
    const block = await service.block({ action: 'open', id: 'lib-new', format: 'json' });
    assert.ok(block.artifactRefs.some((ref) => ref.path === 'lib/new' && ref.anchorKind === 'tree'));
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an absolute Block path covers the same files as its relative form', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'abs.mjs'), 'export const abs = 1;\n');
  const service = new ContextOSV2Service({ projectRoot: root });
  const orchestrator = new Orchestrator({ projectRoot: root, service });
  try {
    const result = await orchestrator.dispatch('change', {
      edits: [{ path: 'abs.mjs', target: 'abs = 1', replacement: 'abs = 2' }],
      architecture: { blocks: [{ id: 'abs-block', title: 'Absolute surface', paths: [path.join(root, 'abs.mjs')] }] },
      verify: { commands: ['node --check abs.mjs'] },
    });
    assert.doesNotMatch(result, /ARCHITECTURE_REQUIRED/);
    assert.match(result, /Verify: PASS/);
    const block = await service.block({ action: 'open', id: 'abs-block', format: 'json' });
    assert.ok(block.artifactRefs.some((ref) => ref.path === 'abs.mjs'));
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('config and asset files bind as dependency Blocks instead of blocking', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'app.mjs'), 'export const app = 1;\n');
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'assets/logo.svg'), '<svg></svg>\n');
  const service = new ContextOSV2Service({ projectRoot: root });
  const orchestrator = new Orchestrator({ projectRoot: root, service });
  try {
    const seeded = await orchestrator.dispatch('change', {
      edits: [{ path: 'app.mjs', target: 'app = 1', replacement: 'app = 2' }],
      architecture: { blocks: [{ id: 'app-block', title: 'App surface', paths: ['app.mjs'] }] },
      verify: { commands: ['node --check app.mjs'] },
    });
    assert.match(seeded, /Verify: PASS/);

    const blocked = await orchestrator.dispatch('change', {
      create: [{ path: '.gitignore', content: 'node_modules\n' }],
      verify: { commands: ['node --check app.mjs'] },
    });
    assert.match(blocked, /ARCHITECTURE_REQUIRED/);
    const payload = /Ready-to-paste architecture: `([^`]+)`/.exec(blocked);
    assert.ok(payload, blocked);
    const architecture = JSON.parse(payload[1]);
    assert.equal(architecture.blocks[0].id, 'block-gitignore');
    assert.equal(architecture.blocks[0].kind, 'dependency');

    const retried = await orchestrator.dispatch('change', {
      create: [{ path: '.gitignore', content: 'node_modules\n' }],
      architecture,
      verify: { commands: ['node --check app.mjs'] },
    });
    assert.match(retried, /Verify: PASS/);
    const configBlock = await service.block({ action: 'open', id: 'block-gitignore', format: 'json' });
    assert.equal(configBlock.kind, 'dependency');
    assert.ok(configBlock.artifactRefs.some((ref) => ref.path === '.gitignore'));

    const assets = await orchestrator.dispatch('change', {
      edits: [{ path: 'assets/logo.svg', target: '<svg></svg>', replacement: '<svg id="logo"></svg>' }],
      architecture: { blocks: [{ id: 'block-assets', title: 'Static assets', kind: 'dependency', paths: ['assets'] }] },
      verify: { commands: ['node --check app.mjs'] },
    });
    assert.match(assets, /Verify: PASS/);
    const assetBlock = await service.block({ action: 'open', id: 'block-assets', format: 'json' });
    assert.equal(assetBlock.kind, 'dependency');
    assert.ok(assetBlock.artifactRefs.some((ref) => ref.path === 'assets' && ref.anchorKind === 'tree'));
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a Block can take over a file from another Block with takeOver', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'kept.mjs'), 'export const kept = 1;\n');
  fs.writeFileSync(path.join(root, 'moved.mjs'), 'export const moved = 1;\n');
  const service = new ContextOSV2Service({ projectRoot: root });
  const orchestrator = new Orchestrator({ projectRoot: root, service });
  try {
    const seeded = await orchestrator.dispatch('change', {
      edits: [{ path: 'moved.mjs', target: 'moved = 1', replacement: 'moved = 2' }],
      architecture: { blocks: [{ id: 'block-a', title: 'A surface', paths: ['kept.mjs', 'moved.mjs'] }] },
      verify: { commands: ['node --check moved.mjs'] },
    });
    assert.match(seeded, /Verify: PASS/);

    const taken = await orchestrator.dispatch('change', {
      edits: [{ path: 'moved.mjs', target: 'moved = 2', replacement: 'moved = 3' }],
      architecture: { blocks: [{ id: 'block-b', title: 'B surface', paths: ['moved.mjs'], takeOver: true }] },
      verify: { commands: ['node --check moved.mjs'] },
    });
    assert.match(taken, /Verify: PASS/);
    assert.match(taken, /1 Block\(s\) released/);
    const blockA = await service.block({ action: 'open', id: 'block-a', format: 'json' });
    const blockB = await service.block({ action: 'open', id: 'block-b', format: 'json' });
    assert.ok(blockA.artifactRefs.some((ref) => ref.path === 'kept.mjs'));
    assert.ok(!blockA.artifactRefs.some((ref) => ref.path === 'moved.mjs'));
    assert.ok(blockB.artifactRefs.some((ref) => ref.path === 'moved.mjs'));
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('takeOver refuses to split a tree anchor', async () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/entry.mjs'), 'export const entry = 1;\n');
  const service = new ContextOSV2Service({ projectRoot: root });
  const orchestrator = new Orchestrator({ projectRoot: root, service });
  try {
    const seeded = await orchestrator.dispatch('change', {
      edits: [{ path: 'src/entry.mjs', target: 'entry = 1', replacement: 'entry = 2' }],
      architecture: { blocks: [{ id: 'block-tree', title: 'Tree surface', paths: ['src'] }] },
      verify: { commands: ['node --check src/entry.mjs'] },
    });
    assert.match(seeded, /Verify: PASS/);

    const refused = await orchestrator.dispatch('change', {
      edits: [{ path: 'src/entry.mjs', target: 'entry = 2', replacement: 'entry = 3' }],
      architecture: { blocks: [{ id: 'block-leaf', title: 'Leaf surface', paths: ['src/entry.mjs'], takeOver: true }] },
      verify: { commands: ['node --check src/entry.mjs'] },
    });
    assert.match(refused, /ARCHITECTURE_REJECTED/);
    assert.match(refused, /tree anchor/);
    assert.equal(fs.readFileSync(path.join(root, 'src/entry.mjs'), 'utf8'), 'export const entry = 2;\n');
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
