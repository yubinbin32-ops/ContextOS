import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { MarkdownRenderer } from '../src/markdown-renderer.mjs';
import { ContextOSV2Service } from '../../mcp/src/v2-service.mjs';

test('MarkdownRenderer.renderBrief embeds compact system topology backbone (<80 tokens)', () => {
  const brief = MarkdownRenderer.renderBrief({
    project: { id: 'contextos-test', repo_root: '/tmp/test', graph_revision: 1 },
    activePlan: null,
    activeTask: null,
    processes: [],
    recentBlocks: [],
  });

  assert.ok(brief.includes('## System Topology Backbone:'), 'Brief must contain topology backbone heading');
  assert.ok(brief.includes('[Client / Apps] ──> [Gateway: MCP / Daemon]'), 'Must include Gateway layer');
  assert.ok(brief.includes('[Application Services: C-D-C-S / Runner]'), 'Must include Application Services layer');
  assert.ok(brief.includes('[Core Intel & Domain: AST / Invariants]'), 'Must include Core Domain layer');
  assert.ok(brief.includes('[Storage & Infra: SQLite WAL / Git Sync]'), 'Must include Storage/Infra layer');

  const backboneSnippet = brief.split('## System Topology Backbone:')[1].split('## Active Plan:')[0];
  const tokenEst = Math.ceil(backboneSnippet.length / 4);
  assert.ok(tokenEst < 80, `Topology backbone must be compact (<80 tokens), got ${tokenEst} tokens`);
});

test('MarkdownRenderer.getBlockTier classifies blocks into 5 architectural tiers', () => {
  const t1Mcp = MarkdownRenderer.getBlockTier({ id: 'block-mcp-facades', title: 'Consolidated MCP Facades' });
  assert.equal(t1Mcp, 'Tier 1: Gateway & Protocol Layer');

  const t1Daemon = MarkdownRenderer.getBlockTier({ id: 'block-daemon-host', title: 'ContextOS Daemon (osd)' });
  assert.equal(t1Daemon, 'Tier 1: Gateway & Protocol Layer');

  const t2Lifecycle = MarkdownRenderer.getBlockTier({ id: 'block-lifecycle-services', title: 'C-D-C-S Lifecycle Services' });
  assert.equal(t2Lifecycle, 'Tier 2: Application Services');

  const t2Runner = MarkdownRenderer.getBlockTier({ id: 'block-command-runner', title: 'Command Runner' });
  assert.equal(t2Runner, 'Tier 2: Application Services');

  const t3CodeIntel = MarkdownRenderer.getBlockTier({ id: 'block-code-gateway', title: 'AST Intel Tools' });
  assert.equal(t3CodeIntel, 'Tier 3: Core Intelligence & Domain');

  const t3Domain = MarkdownRenderer.getBlockTier({ id: 'block-domain-invariants', title: 'Domain Invariants' });
  assert.equal(t3Domain, 'Tier 3: Core Intelligence & Domain');

  const t4Storage = MarkdownRenderer.getBlockTier({ id: 'block-storage-sqlite', title: 'SQLite WAL Engine' });
  assert.equal(t4Storage, 'Tier 4: Infrastructure & Storage');

  const t4Sync = MarkdownRenderer.getBlockTier({ id: 'block-storage-sync', title: 'Git Sync Engine' });
  assert.equal(t4Sync, 'Tier 4: Infrastructure & Storage');

  const t5DesktopShell = MarkdownRenderer.getBlockTier({ id: 'block-desktop-shell', title: 'Desktop App Shell' });
  assert.equal(t5DesktopShell, 'Tier 5: Client & Tooling');

  const t5DesktopDb = MarkdownRenderer.getBlockTier({ id: 'block-desktop-database', title: 'Desktop Native SQLite Store' });
  assert.equal(t5DesktopDb, 'Tier 5: Client & Tooling');

});

test('MarkdownRenderer.renderBlockList groups blocks by tiers', () => {
  const blocks = [
    { id: 'b-mcp', title: 'MCP Gateway', summary: 'Gateway entrypoint', artifactRefs: [{ path: 'packages/mcp' }] },
    { id: 'b-life', title: 'Lifecycle Services', summary: 'C-D-C-S workflow', artifactRefs: [{ path: 'packages/application' }] },
    { id: 'b-store', title: 'SQLite Store', summary: 'Storage layer', artifactRefs: [{ path: 'packages/storage' }] },
  ];

  const md = MarkdownRenderer.renderBlockList(blocks);
  assert.ok(md.includes('# Architecture Blocks (3 total)'));
  assert.ok(md.includes('## Tier 1: Gateway & Protocol Layer'));
  assert.ok(md.includes('## Tier 2: Application Services'));
  assert.ok(md.includes('## Tier 4: Infrastructure & Storage'));
  assert.ok(md.includes('- **[b-mcp]** MCP Gateway'));
  assert.ok(md.includes('- **[b-life]** Lifecycle Services'));
  assert.ok(md.includes('- **[b-store]** SQLite Store'));
});

test('MarkdownRenderer.renderBlock displays Architecture Neighborhood (上下游拓扑)', () => {
  const block = {
    id: 'b-service',
    title: 'Core Business Service',
    summary: 'Handles domain workflows',
    artifactRefs: [{ path: 'src/service.js', startLine: 1, endLine: 50, role: 'implementation', hash: 'abc12345' }],
  };

  const inboundLinks = [
    { from: 'b-gateway', to: 'b-service', kind: 'calls', reason: 'routes client requests' },
  ];
  const outboundLinks = [
    { from: 'b-service', to: 'b-repo', kind: 'depends_on', reason: 'persists state' },
  ];

  const md = MarkdownRenderer.renderBlock(block, { inboundLinks, outboundLinks });
  assert.ok(md.includes('## Architecture Neighborhood (上下游拓扑):'));
  assert.ok(md.includes('📥 **Called by (入度)**:'));
  assert.ok(md.includes('`[b-gateway]` -[calls]-> this block (routes client requests)'));
  assert.ok(md.includes('📤 **Calls (出度)**:'));
  assert.ok(md.includes('this block -[depends_on]-> `[b-repo]` (persists state)'));

  // Test root entrypoint / terminal node empty case
  const isolatedBlock = { id: 'b-isolated', title: 'Isolated Block', artifactRefs: [] };
  const isolatedMd = MarkdownRenderer.renderBlock(isolatedBlock, { inboundLinks: [], outboundLinks: [] });
  assert.ok(isolatedMd.includes('*(none / root entrypoint)*'));
  assert.ok(isolatedMd.includes('*(none / terminal node)*'));
});

test('ContextOSV2Service integrates block taxonomy and micro-topology neighborhood', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-topology-test-'));
  const service = new ContextOSV2Service({ projectRoot: tempDir, projectId: 'test-proj' });

  // 1. Create blocks
  await service.block({
    action: 'bind',
    id: 'block-gateway-test',
    blockData: {
      title: 'Gateway Test Facade',
      summary: 'Entrypoint for client requests',
      artifactRefs: ['packages/mcp/src/v2-server.mjs'],
    },
  });

  await service.block({
    action: 'bind',
    id: 'block-storage-test',
    blockData: {
      title: 'Storage Test Engine',
      summary: 'SQLite Database engine',
      artifactRefs: ['packages/storage/src/database.mjs'],
    },
  });

  // 2. Link blocks
  await service.chain({
    action: 'link',
    linkData: {
      from: 'block-gateway-test',
      to: 'block-storage-test',
      kind: 'calls',
      reason: 'direct persistence call',
    },
  });

  // 3. Test block(list) in markdown and json
  const listMd = await service.block({ action: 'list' });
  assert.ok(listMd.includes('## Tier 1: Gateway & Protocol Layer'));
  assert.ok(listMd.includes('## Tier 4: Infrastructure & Storage'));

  const listJson = await service.block({ action: 'list', format: 'json' });
  assert.equal(Array.isArray(listJson), true);
  assert.equal(listJson.length, 2);
  const gatewayBlock = listJson.find((b) => b.id === 'block-gateway-test');
  assert.equal(gatewayBlock.tier, 'Tier 1: Gateway & Protocol Layer');
  const storageBlock = listJson.find((b) => b.id === 'block-storage-test');
  assert.equal(storageBlock.tier, 'Tier 4: Infrastructure & Storage');

  // 4. Test block(open) with neighborhood in markdown
  const openGatewayMd = await service.block({ action: 'open', id: 'block-gateway-test' });
  assert.ok(openGatewayMd.includes('## Architecture Neighborhood (上下游拓扑):'));
  assert.ok(openGatewayMd.includes('this block -[calls]-> `[block-storage-test]`'));

  const openStorageMd = await service.block({ action: 'open', id: 'block-storage-test' });
  assert.ok(openStorageMd.includes('`[block-gateway-test]` -[calls]-> this block'));

  // 5. Test block(open) with neighborhood in json
  const openStorageJson = await service.block({ action: 'open', id: 'block-storage-test', format: 'json' });
  assert.equal(openStorageJson.id, 'block-storage-test');
  assert.equal(openStorageJson.tier, 'Tier 4: Infrastructure & Storage');
  assert.ok(openStorageJson.neighborhood);
  assert.equal(openStorageJson.neighborhood.inbound.length, 1);
  assert.equal(openStorageJson.neighborhood.inbound[0].from, 'block-gateway-test');
  assert.equal(openStorageJson.neighborhood.outbound.length, 0);

  // 6. Test os_context(brief) includes topology backbone
  const brief = await service.osContext({ action: 'brief' });
  assert.ok(brief.includes('## System Topology Backbone:'));

  // 7. Test block(search) includes tier metadata and handles missing summary
  await service.block({
    action: 'bind',
    id: 'block-no-summary',
    blockData: {
      title: 'Searchable No Summary Block',
      artifactRefs: [],
    },
  });
  const searchJson = await service.block({ action: 'search', query: 'Searchable', format: 'json' });
  assert.equal(searchJson.length, 1);
  assert.equal(searchJson[0].id, 'block-no-summary');
  assert.ok(searchJson[0].tier);

  const searchMd = await service.block({ action: 'search', query: 'Searchable' });
  assert.ok(searchMd.includes('Searchable No Summary Block'));
  assert.ok(searchMd.includes('No summary available.'));

  service.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('MarkdownRenderer handles edge cases: null refs and string refs', () => {
  // 1. Null/undefined elements in artifactRefs must not crash getBlockTier
  const nullRefTier = MarkdownRenderer.getBlockTier({
    id: 'block-null-test',
    artifactRefs: [null, undefined, { path: 'packages/domain/src/plan.mjs' }],
  });
  assert.equal(nullRefTier, 'Tier 3: Core Intelligence & Domain');

  // 2. String artifactRefs in renderBlock must render cleanly without 'undefined'
  const renderedBlock = MarkdownRenderer.renderBlock({
    id: 'block-string-refs',
    title: 'String Ref Block',
    summary: 'A test block',
    artifactRefs: ['src/simple-file.js', { path: 'src/object-file.js', role: 'implementation', hash: 'hash123' }],
  });
  assert.ok(!renderedBlock.includes('undefined'), 'Rendered block must not output "undefined" for string refs');
  assert.ok(renderedBlock.includes('`src/simple-file.js`'));
  assert.ok(renderedBlock.includes('`src/object-file.js`'));
  assert.ok(renderedBlock.includes('hash: `hash123`'));
});
