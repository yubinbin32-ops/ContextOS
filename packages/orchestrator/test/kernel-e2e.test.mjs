import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { Orchestrator } from '../src/index.mjs';
import { ContextOSV2Service } from '../../mcp/src/v2-service.mjs';

function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-kernel-e2e-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.contextos'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "0"' } }, null, 2));
  fs.writeFileSync(path.join(dir, 'src', 'main.mjs'), 'export const main = 1;\n');
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

test('kernel e2e: inspect with budget: full on a 10KB+ document returns full text without truncation', async () => {
  const projectRoot = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  // Generate a realistic 12KB+ document
  const header = '# Architecture Decision Record: Kernel Hardening\n\n## Context\n';
  const middleLines = [];
  for (let i = 1; i <= 350; i++) {
    middleLines.push(`- Section ${i}: Detailed specification note for invariant assertion and system behavior token governance.`);
  }
  const footer = '\n## Decision\nAll invariants must be satisfied without truncation under full budget.\n';
  const longDocContent = header + middleLines.join('\n') + footer;
  assert.ok(Buffer.byteLength(longDocContent, 'utf8') > 10 * 1024, 'Document should exceed 10KB');

  fs.writeFileSync(path.join(projectRoot, 'DECISION.md'), longDocContent, 'utf8');

  // Inspect with budget: 'full'
  const result = await orchestrator.dispatch('inspect', {
    path: 'DECISION.md',
    budget: 'full',
  });

  assert.ok(result.includes('# Architecture Decision Record: Kernel Hardening'), 'Must include header');
  assert.ok(result.includes('Section 1: Detailed specification note'), 'Must include beginning sections');
  assert.ok(result.includes('Section 350: Detailed specification note'), 'Must include trailing sections');
  assert.ok(result.includes('All invariants must be satisfied without truncation'), 'Must include footer');
  assert.ok(!result.includes('[TRUNCATED'), 'Must not contain truncation markers');
  assert.ok(!result.includes('omitted)'), 'Must not contain omission markers');
  assert.ok(result.length >= longDocContent.length, 'Must return full unclipped content');

  service.close();
});

test('kernel e2e: inspect with multi-segment ranges returns multi-segment lines accurately', async () => {
  const projectRoot = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  // Create a 100-line structured file
  const lines = [];
  for (let i = 1; i <= 100; i++) {
    lines.push(`Line ${i}: payload content ${i}`);
  }
  fs.writeFileSync(path.join(projectRoot, 'src', 'data.txt'), lines.join('\n') + '\n', 'utf8');

  // Request ranges: 1-10 and 50-60
  const result = await orchestrator.dispatch('inspect', {
    path: 'src/data.txt',
    ranges: [{ startLine: 1, endLine: 10 }, { startLine: 50, endLine: 60 }],
  });

  assert.match(result, /\[L1-L10\]/);
  assert.match(result, /\[L50-L60\]/);

  // Line 1 to 10 should be present
  assert.ok(result.includes('Line 1: payload content 1'));
  assert.ok(result.includes('Line 10: payload content 10'));

  // Line 50 to 60 should be present
  assert.ok(result.includes('Line 50: payload content 50'));
  assert.ok(result.includes('Line 60: payload content 60'));

  // Lines outside ranges should NOT be present
  assert.ok(!result.includes('Line 25: payload content 25'));
  assert.ok(!result.includes('Line 35: payload content 35'));
  assert.ok(!result.includes('Line 75: payload content 75'));

  service.close();
});

test('kernel e2e: change with { path, content, overwrite: true } overwrites the file cleanly', async () => {
  const projectRoot = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  const filePath = 'src/service.mjs';
  fs.writeFileSync(path.join(projectRoot, filePath), '// Old legacy implementation\nexport function legacy() { return false; }\n');

  const newContent = 'export function cleanService() {\n  return "clean-v2";\n}\n';
  const result = await orchestrator.dispatch('change', {
    path: filePath,
    content: newContent,
    overwrite: true,
  });

  assert.match(result, /ContextOS change/);
  const diskContent = fs.readFileSync(path.join(projectRoot, filePath), 'utf8');
  assert.equal(diskContent, newContent);

  service.close();
});

test('kernel e2e: change with { edits: [{ path, replacement, fullFile: true }] } replaces full file cleanly', async () => {
  const projectRoot = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  const filePath = 'src/worker.mjs';
  fs.writeFileSync(path.join(projectRoot, filePath), 'export function oldWorker() { return 1; }\n');

  const fullReplacement = 'export class ModernWorker {\n  run() {\n    return true;\n  }\n}\n';
  const result = await orchestrator.dispatch('change', {
    edits: [{
      path: filePath,
      replacement: fullReplacement,
      fullFile: true,
    }],
  });

  assert.match(result, /ContextOS change/);
  assert.match(result, /edited `src\/worker\.mjs`/);
  const diskContent = fs.readFileSync(path.join(projectRoot, filePath), 'utf8');
  assert.equal(diskContent, fullReplacement);

  service.close();
});

test('kernel e2e: change accepts content alias for fullFile edits', async () => {
  const projectRoot = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  const nestedPath = 'src/content-alias.mjs';
  const topLevelPath = 'src/top-level-alias.mjs';
  fs.writeFileSync(path.join(projectRoot, nestedPath), 'export const old = true;\n');
  fs.writeFileSync(path.join(projectRoot, topLevelPath), 'export const old = true;\n');

  const nestedReplacement = 'export const nested = "updated";\n';
  const topLevelReplacement = 'export const topLevel = "updated";\n';
  await orchestrator.dispatch('change', {
    edits: [{ path: nestedPath, content: nestedReplacement, fullFile: true }],
  });
  await orchestrator.dispatch('change', {
    path: topLevelPath,
    content: topLevelReplacement,
    fullFile: true,
  });

  assert.equal(fs.readFileSync(path.join(projectRoot, nestedPath), 'utf8'), nestedReplacement);
  assert.equal(fs.readFileSync(path.join(projectRoot, topLevelPath), 'utf8'), topLevelReplacement);

  service.close();
});

test('kernel e2e: change binds curated Blocks and composes Chains in one transaction', async () => {
  const projectRoot = makeTempProject();
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'renderer.mjs'), 'export const render = () => 1;\n');

  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });
  const result = await orchestrator.dispatch('change', {
    path: 'src/renderer.mjs',
    content: 'export const render = () => 2;\n',
    fullFile: true,
    verify: { command: 'node -e "0"' },
    architecture: {
      blocks: [{
        id: 'block-renderer',
        title: 'Renderer service',
        kind: 'service',
        summary: 'Turns render requests into stable output.',
        paths: ['src/renderer.mjs'],
      }],
      chains: [{
        id: 'chain-render-flow',
        title: 'Render request flow',
        kind: 'feature',
        memberIds: ['block-renderer'],
      }],
    },
  });
  assert.match(result, /1 curated Block\(s\) bound/);
  assert.match(result, /1 Chain\(s\) composed/);

  const block = await service.block({ action: 'open', id: 'block-renderer', format: 'json' });
  assert.ok(block.artifactRefs.some((ref) => ref.path === 'src/renderer.mjs'));
  const chain = await service.chain({ action: 'open', id: 'chain-render-flow', format: 'json' });
  assert.deepEqual(chain.memberIds, ['block-renderer']);

  fs.writeFileSync(path.join(projectRoot, 'src', 'adapter.mjs'), 'export const adapt = (value) => value;\n');
  await service.block({
    action: 'bind_auto',
    id: 'block-render-adapter',
    path: 'src/adapter.mjs',
    blockData: { title: 'Render adapter', kind: 'adapter' },
  });
  await service.block({
    action: 'bind_auto',
    id: 'block-render-adapter',
    path: 'src/adapter.mjs',
  });
  const idempotentAdapter = await service.block({ action: 'open', id: 'block-render-adapter', format: 'json' });
  assert.equal(
    idempotentAdapter.artifactRefs.filter((ref) => ref.path === 'src/adapter.mjs').length,
    1,
    'repeated binding must refresh one locator instead of appending a duplicate'
  );
  await service.chain({
    action: 'compose',
    chainData: { id: 'chain-render-flow', memberIds: ['block-render-adapter'] },
  });
  const mergedChain = await service.chain({ action: 'open', id: 'chain-render-flow', format: 'json' });
  assert.deepEqual(new Set(mergedChain.memberIds), new Set(['block-renderer', 'block-render-adapter']));

  fs.writeFileSync(
    path.join(projectRoot, 'src', 'adapter.mjs'),
    'export function normalize(value) { return value; }\n'
  );
  await service.block({
    action: 'bind_auto',
    id: 'block-render-adapter',
    path: 'src/adapter.mjs',
    symbols: ['normalize'],
    replacePaths: true,
  });
  const refreshedAdapter = await service.block({ action: 'open', id: 'block-render-adapter', format: 'json' });
  const adapterRefs = refreshedAdapter.artifactRefs.filter((ref) => ref.path === 'src/adapter.mjs');
  assert.deepEqual(adapterRefs.map((ref) => ref.symbol), ['normalize']);
  const refreshedChain = await service.chain({ action: 'open', id: 'chain-render-flow', format: 'json' });
  assert.deepEqual(new Set(refreshedChain.memberIds), new Set(['block-renderer', 'block-render-adapter']));

  // replacePaths is a complete ownership refresh: stale paths must not stay
  // attached when a subsystem is moved or its boundary is narrowed.
  await service.block({
    action: 'bind_auto',
    id: 'block-render-adapter',
    paths: ['src/renderer.mjs'],
    replacePaths: true,
  });
  const replacedAdapter = await service.block({ action: 'open', id: 'block-render-adapter', format: 'json' });
  assert.deepEqual([...new Set(replacedAdapter.artifactRefs.map((ref) => ref.path))], ['src/renderer.mjs']);
  service.close();
});

test('kernel e2e: pipeline shorthand preserves ship architecture in receipt mode', async () => {
  const projectRoot = makeTempProject();
  const filePath = path.join(projectRoot, 'src', 'pipeline-worker.mjs');
  fs.writeFileSync(filePath, 'export const pipelineWorker = 1;\n');

  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });
  await orchestrator.dispatch('change', {
    path: 'src/pipeline-worker.mjs',
    content: 'export const pipelineWorker = 2;\n',
    fullFile: true,
    verify: { command: 'node -e "0"' },
  });

  const result = await orchestrator.dispatch('pipeline', {
    mode: 'receipt',
    chain: [
      { verify: { commands: ['node -e "0"'] } },
      {
        ship: {
          summary: 'Close shorthand pipeline architecture.',
          architecture: {
            blocks: [{
              id: 'block-pipeline-worker',
              title: 'Pipeline worker',
              kind: 'service',
              paths: ['src/pipeline-worker.mjs'],
            }],
            chains: [{
              id: 'chain-pipeline-worker',
              title: 'Pipeline worker flow',
              kind: 'feature',
              memberIds: ['block-pipeline-worker'],
            }],
          },
        },
      },
    ],
  });
  assert.match(result, /pipeline=OK/);
  assert.match(result, /architectureGaps=0/, 'receipt mode must expose ship architecture completeness');
  const block = await service.block({ action: 'open', id: 'block-pipeline-worker', format: 'json' });
  assert.ok(block.artifactRefs.some((ref) => ref.path === 'src/pipeline-worker.mjs'));
  const chain = await service.chain({ action: 'open', id: 'chain-pipeline-worker', format: 'json' });
  assert.deepEqual(chain.memberIds, ['block-pipeline-worker']);
  service.close();
});

test('kernel e2e: ship can close explicit Block and Chain ownership in one round', async () => {
  const projectRoot = makeTempProject();
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'worker.mjs'), 'export const worker = () => 1;\n');

  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });
  await orchestrator.dispatch('change', {
    path: 'src/worker.mjs',
    content: 'export const worker = () => 2;\n',
    fullFile: true,
    verify: { command: 'node -e "0"' },
  });

  const shipped = await orchestrator.dispatch('ship', {
    summary: 'Close worker architecture in one round.',
    architecture: {
      blocks: [{
        id: 'block-worker-service',
        title: 'Worker service',
        kind: 'service',
        paths: ['src/worker.mjs'],
      }],
      chains: [{
        id: 'chain-worker-flow',
        title: 'Worker flow',
        kind: 'feature',
        memberIds: ['block-worker-service'],
      }],
    },
  });
  assert.match(shipped, /1 gap\(s\) across 1 changed file\(s\)|0 gap\(s\) across 1 changed file\(s\)/);
  assert.match(shipped, /Every architecture-tracked source path has exactly one curated Block owner/);

  const block = await service.block({ action: 'open', id: 'block-worker-service', format: 'json' });
  assert.ok(block.artifactRefs.some((ref) => ref.path === 'src/worker.mjs'));
  const chain = await service.chain({ action: 'open', id: 'chain-worker-flow', format: 'json' });
  assert.deepEqual(chain.memberIds, ['block-worker-service']);
  service.close();
});

test('kernel e2e: ship architecture accepts common model aliases without extra rounds', async () => {
  const projectRoot = makeTempProject();
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'api.mjs'), 'export const api = () => 1;\n');
  fs.writeFileSync(path.join(projectRoot, 'src', 'index.mjs'), 'export * from "./api.mjs";\n');

  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });
  await orchestrator.dispatch('change', {
    create: [
      { path: 'src/api.mjs', content: 'export const api = () => 2;\n', overwrite: true },
      { path: 'src/index.mjs', content: 'export * from "./api.mjs";\n', overwrite: true },
    ],
    verify: { command: 'node -e "0"' },
  });

  const shipped = await orchestrator.dispatch('ship', {
    summary: 'Close an API boundary submitted with common aliases.',
    architecture: {
      blocks: [{
        id: 'block-api',
        name: 'API boundary',
        files: ['src/api.mjs', 'src/index.mjs'],
        responsibility: 'Own the public API boundary.',
      }],
      chains: [{
        id: 'chain-api-flow',
        name: 'API flow',
        blocks: ['block-api'],
      }],
    },
  });
  assert.match(shipped, /# ContextOS ship/);
  assert.doesNotMatch(shipped, /BLOCKED/);

  const block = await service.block({ action: 'open', id: 'block-api', format: 'json' });
  assert.deepEqual(
    block.artifactRefs.map((ref) => ref.path).sort(),
    ['src/api.mjs', 'src/index.mjs'],
  );
  assert.equal(block.kind, 'component');
  const chain = await service.chain({ action: 'open', id: 'chain-api-flow', format: 'json' });
  assert.deepEqual(chain.memberIds, ['block-api']);

  service.close();
});

test('kernel e2e: ship requires one curated owner and Chain membership in strict mode', async () => {
  const projectRoot = makeTempProject();
  fs.writeFileSync(
    path.join(projectRoot, '.contextos', 'profile.json'),
    JSON.stringify({ strict: true, verify: ['node -e "0"'] }, null, 2)
  );
  fs.mkdirSync(path.join(projectRoot, 'packages', 'billing'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'packages', 'billing', 'index.mjs'), 'export const billingEngine = 1;\n');

  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });
  await orchestrator.dispatch('change', {
    path: 'packages/billing/index.mjs',
    content: 'export const billingEngine = 2;\n',
    overwrite: true,
    verify: true,
  });

  const unownedResult = await orchestrator.dispatch('ship', { summary: 'shipping new billing package' });
  assert.match(unownedResult, /BLOCKED \(architecture governance gate\)/);
  assert.match(unownedResult, /packages\/billing\/index\.mjs/);
  const blocksAfterUnownedShip = await service.block({ action: 'list', format: 'json' });
  assert.ok(!blocksAfterUnownedShip.items.some((block) => String(block.id).startsWith('mod-')));

  await assert.rejects(
    () => service.block({
      action: 'bind_auto',
      id: 'mod-legacy-billing',
      path: 'packages/billing/index.mjs',
      blockData: { title: 'Derived module mod-legacy-billing', kind: 'module' },
    }),
    /Derived ModuleIndex identity is not a curated Block/
  );
  service.db.saveBlock({
    id: 'mod-legacy-billing',
    projectId: 'fixture',
    title: 'Derived module mod-legacy-billing',
    kind: 'module',
    artifactRefs: [{
      path: 'packages/billing/index.mjs',
      anchorKind: 'file',
      hash: 'legacy-fixture-hash',
    }],
  });
  const pruned = await service.block({ action: 'prune_derived', format: 'json' });
  assert.deepEqual(pruned.deletedIds, ['mod-legacy-billing']);

  await assert.rejects(
    () => service.block({
      action: 'bind',
      id: 'mod-direct-bind',
      blockData: { title: 'Derived module mod-direct-bind', kind: 'module' },
    }),
    /Derived ModuleIndex identity is not a curated Block/
  );

  await orchestrator.dispatch('ops', {
    capability: 'block',
    action: 'bind_auto',
    args: {
      id: 'block-billing',
      path: 'packages/billing',
      blockData: { title: 'Billing Package', kind: 'package' },
    },
  });
  const noChainResult = await orchestrator.dispatch('ship', { summary: 'billing block without chain' });
  assert.match(noChainResult, /BLOCKED \(architecture governance gate\)/);
  assert.match(noChainResult, /not a member of a Chain/);

  await orchestrator.dispatch('ops', {
    capability: 'chain',
    action: 'compose',
    args: {
      chainData: { id: 'chain-billing', title: 'Billing Chain', memberIds: ['block-billing'] },
    },
  });
  await assert.rejects(
    () => service.chain({
      action: 'compose',
      chainData: { id: 'chain-derived', title: 'Invalid derived chain', memberIds: ['mod-legacy-billing'] },
    }),
    /cannot include derived ModuleIndex ids/
  );
  const duplicateOwner = await service.block({
    action: 'bind_auto',
    id: 'block-billing-duplicate',
    path: 'packages/billing',
    blockData: { title: 'Duplicate Billing Owner', kind: 'package' },
  });
  assert.ok(duplicateOwner);
  const duplicateGraph = await service.chain({ action: 'validate', format: 'json' });
  assert.equal(duplicateGraph.valid, false);
  assert.deepEqual(duplicateGraph.duplicateArtifactRefs[0].blockIds, ['block-billing', 'block-billing-duplicate']);
  assert.equal(duplicateGraph.duplicateArtifactRefs[0].path, 'packages/billing');
  assert.equal(duplicateGraph.duplicateArtifactRefs[0].anchorKind, 'tree');
  const duplicateResult = await orchestrator.dispatch('ship', { summary: 'billing with duplicate owners' });
  assert.match(duplicateResult, /multiple curated Block owners/);
  await service.block({ action: 'delete', id: 'block-billing-duplicate' });

  const passedResult = await orchestrator.dispatch('ship', { summary: 'billing package with curated Block and Chain' });
  assert.match(passedResult, /# ContextOS ship/);
  assert.ok(!passedResult.includes('BLOCKED'));
  service.close();
});


test('non-strict ship reports typed per-path architecture gaps without creating derived Blocks', async () => {
  const projectRoot = makeTempProject();
  const searchDir = path.join(projectRoot, 'packages', 'search');
  fs.mkdirSync(searchDir, { recursive: true });
  const changedFiles = [
    ['missing.mjs', 'export const missing = 1;\n'],
    ['duplicate.mjs', 'export const duplicate = 1;\n'],
    ['unchained.mjs', 'export const unchained = 1;\n'],
  ];
  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });
  for (const [name, content] of changedFiles) {
    const filePath = 'packages/search/' + name;
    fs.writeFileSync(path.join(searchDir, name), content);
    await orchestrator.dispatch('change', {
      path: filePath,
      content: content.replace('= 1', '= 2'),
      fullFile: true,
      verify: { command: 'node -e "0"' },
    });
  }

  for (const [id, filePath, title] of [
    ['block-search-first', 'packages/search/duplicate.mjs', 'Search duplicate owner one'],
    ['block-search-second', 'packages/search/duplicate.mjs', 'Search duplicate owner two'],
    ['block-search-unchained', 'packages/search/unchained.mjs', 'Search unchained owner'],
  ]) {
    await service.block({
      action: 'bind_auto',
      id,
      path: filePath,
      blockData: { title, kind: 'service' },
    });
  }

  const result = await orchestrator.dispatch('ship', { summary: 'exercise all advisory architecture gaps' });
  assert.match(result, /Gap counts: missing curated Block 1; multiple curated Block owners 1; owner without Chain membership 1\./);
  assert.ok(result.includes('packages/search/missing.mjs'));
  assert.ok(result.includes('packages/search/duplicate.mjs'));
  assert.ok(result.includes('packages/search/unchained.mjs'));
  assert.ok(result.includes('block-search-first'));
  assert.ok(result.includes('block-search-second'));
  assert.match(result, /Curated architecture diagnostics/);
  assert.match(result, /Module index hints \(navigation only\)/);
  const blocks = await service.block({ action: 'list', format: 'json', includeRefs: true });
  assert.ok(!blocks.items.some((block) => String(block.id).startsWith('mod-')));
  service.close();
});

test('explicit ship architecture contract blocks closure instead of silently accepting gaps', async () => {
  const projectRoot = makeTempProject();
  fs.writeFileSync(path.join(projectRoot, 'src', 'contract-worker.mjs'), 'export const worker = 1;\n');
  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });
  await orchestrator.dispatch('change', {
    path: 'src/contract-worker.mjs',
    content: 'export const worker = 2;\n',
    fullFile: true,
    verify: { command: 'node -e "0"' },
  });

  const result = await orchestrator.dispatch('ship', {
    summary: 'reject an incomplete explicit architecture contract',
    architecture: {
      blocks: [{
        id: 'block-wrong-path',
        title: 'Wrong path owner',
        kind: 'service',
        paths: ['src/not-the-worker.mjs'],
      }],
      chains: [{
        id: 'chain-wrong-path',
        title: 'Wrong path flow',
        kind: 'feature',
        memberIds: ['block-wrong-path'],
      }],
    },
  });
  assert.match(result, /BLOCKED \(explicit architecture contract\)/);
  assert.match(result, /src\/contract-worker\.mjs/);
  assert.ok(orchestrator.store.current, 'failed contract must keep the session available for repair');
  service.close();
});

test('Block and Chain list responses are compact, bounded, and paginated', async () => {
  const projectRoot = makeTempProject();
  fs.writeFileSync(path.join(projectRoot, 'src', 'search-index.mjs'), 'export const search = 1;\n');
  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  for (let i = 0; i < 27; i += 1) {
    const suffix = String(i).padStart(2, '0');
    await service.block({
      action: 'bind_auto',
      id: 'block-search-' + suffix,
      path: 'src/search-index.mjs',
      blockData: { title: 'Search index ' + suffix, kind: 'service', summary: 'search responsibility '.repeat(30) },
    });
  }
  const blockPage = await service.block({ action: 'list', format: 'json', limit: 200 });
  assert.equal(blockPage.total, 27);
  assert.equal(blockPage.items.length, 25);
  assert.equal(blockPage.limit, 25);
  assert.equal(blockPage.nextOffset, 25);
  assert.equal(blockPage.hasMore, true);
  assert.equal(blockPage.items[0].summary.length, 160);
  assert.equal(blockPage.items[0].summaryTruncated, true);
  assert.equal(Object.hasOwn(blockPage.items[0], 'artifactRefs'), false);
  assert.ok(blockPage.items[0].paths.includes('src/search-index.mjs'));
  assert.ok(JSON.stringify(blockPage).length < 15000);

  const fullBlockPage = await service.block({ action: 'list', format: 'json', offset: 25, includeRefs: true });
  assert.equal(fullBlockPage.items.length, 2);
  assert.ok(fullBlockPage.items[0].artifactRefs.some((ref) => ref.path === 'src/search-index.mjs'));

  for (let i = 0; i < 27; i += 1) {
    const suffix = String(i).padStart(2, '0');
    await service.chain({
      action: 'compose',
      chainData: { id: 'chain-search-' + suffix, title: 'Search flow ' + suffix, memberIds: ['block-search-' + suffix] },
    });
  }
  const chainPage = await service.chain({ action: 'list', format: 'json', limit: 200 });
  assert.equal(chainPage.total, 27);
  assert.equal(chainPage.items.length, 25);
  assert.equal(chainPage.nextOffset, 25);
  assert.equal(chainPage.items[0].memberCount, 1);
  assert.equal(Object.hasOwn(chainPage.items[0], 'memberIds'), false);

  const fullChainPage = await service.chain({ action: 'list', format: 'json', offset: 25, includeMembers: true });
  assert.equal(fullChainPage.items.length, 2);
  assert.deepEqual(fullChainPage.items[0].memberIds, ['block-search-25']);
  service.close();
});

test('ship reports advisory architecture gaps without creating derived Blocks', async () => {
  const projectRoot = makeTempProject();
  fs.mkdirSync(path.join(projectRoot, 'packages', 'search'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'packages', 'search', 'index.mjs'), 'export const search = 1;\n');

  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });
  await orchestrator.dispatch('change', {
    path: 'packages/search/index.mjs',
    content: 'export const search = 2;\n',
    fullFile: true,
    verify: { command: 'node -e "0"' },
  });

  await orchestrator.dispatch('change', {
    path: 'README.md',
    content: '# Fixture overview\\n',
    fullFile: true,
    verify: { command: 'node -e "0"' },
  });
  const result = await orchestrator.dispatch('ship', { summary: 'report search package architecture gap' });
  assert.match(result, /Curated architecture: 1 gap/);
  assert.match(result, /Module index hints \(navigation only\)/);
  assert.ok(!result.includes('BLOCKED'));
  const blocks = await service.block({ action: 'list', format: 'json' });
  assert.ok(!blocks.items.some((block) => String(block.id).startsWith('mod-')));
  service.close();
});
