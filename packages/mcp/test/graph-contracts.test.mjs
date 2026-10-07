import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContextOSV2Service } from '../src/v2-service.mjs';

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-graph-contracts-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/a.mjs'), 'export function alpha() { return 1; }\n');
  fs.writeFileSync(path.join(root, 'src/b.mjs'), 'export function beta() { return 2; }\n');
  fs.writeFileSync(path.join(root, 'src/unowned.mjs'), 'export const unowned = 1;\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"graph-fixture"}\n');
  const service = new ContextOSV2Service({ projectRoot: root, projectId: 'graph-fixture' });
  try {
    await service.block({ action: 'bind', id: 'a', blockData: { title: 'Alpha', artifactRefs: [{ path: 'src/a.mjs' }] } });
    await service.block({ action: 'bind', id: 'b', blockData: { title: 'Beta', artifactRefs: [{ path: 'src/b.mjs' }] } });
    await run(service, root);
  } finally { service.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

test('standalone Blocks are advisory and validation only checks sources when explicitly requested', () => fixture(async (service, root) => {
  const initial = await service.chain({ action: 'validate' });
  assert.equal(initial.valid, true);
  assert.deepEqual(initial.advisories.standaloneBlocks, ['a', 'b']);
  assert.equal(initial.sourceCheck, 'skipped');
  service.db.saveBlock({ ...service.db.getBlock('a'), artifactRefs: service.db.getBlock('a').artifactRefs.map(ref => ({ ...ref, symbol: 'a.mjs' })) });
  assert.equal((await service.chain({ action: 'validate', checkSources: true })).valid, true);
  const labeled = await service.block({ action: 'owners', paths: ['src/a.mjs'], format: 'json' });
  assert.equal(labeled.items[0].owners[0].refs[0].matchKind, 'exact-file');
  fs.writeFileSync(path.join(root, 'src/a.mjs'), 'export function alpha() { return 3; }\n');
  fs.unlinkSync(path.join(root, 'src/b.mjs'));
  assert.equal((await service.chain({ action: 'validate' })).valid, true);
  const scoped = await service.chain({ action: 'validate', checkSources: true, paths: ['src/a.mjs'] });
  assert.equal(scoped.valid, false);
  assert.deepEqual(scoped.sourceIssues.map((issue) => issue.kind), ['hash-drift']);
  const all = await service.chain({ action: 'validate', checkSources: true });
  assert.deepEqual(new Set(all.sourceIssues.map((issue) => issue.kind)), new Set(['hash-drift', 'missing-path']));
}));

test('chain open keeps large chains inside the orientation budget with a member rollup', () => fixture(async (service, root) => {
  const memberIds = [];
  for (let index = 0; index < 30; index += 1) {
    const id = `member-${index}`;
    memberIds.push(id);
    fs.writeFileSync(path.join(root, `src/member-${index}.mjs`), `export const value${index} = ${index};\n`);
    await service.block({ action: 'bind', id, blockData: { title: `Member ${index}`, artifactRefs: [{ path: `src/member-${index}.mjs` }] } });
  }
  await service.chain({ action: 'compose', chainData: { id: 'big', title: 'Big chain', kind: 'feature', memberIds } });
  const text = await service.chain({ action: 'open', chainId: 'big' });
  assert.ok(Array.from(text).length < 6000, `chain open must stay inside the orientation budget (got ${Array.from(text).length})`);
  assert.match(text, /Members: 30/);
  assert.match(text, /… 6 more member\(s\)/);
  assert.ok(!text.includes('undefined'));
}));

test('block/chain open accept their id aliases and knowledge exposes read actions', () => fixture(async (service, root) => {
  await service.chain({ action: 'compose', chainData: { id: 'flow', title: 'Flow', kind: 'linear', memberIds: ['a', 'b'] } });
  assert.match(await service.block({ action: 'open', blockId: 'a' }), /Alpha/);
  assert.match(await service.chain({ action: 'open', chainId: 'flow' }), /Chain: \[flow\] Flow/);
  await assert.rejects(service.block({ action: 'open' }), /requires 'id'/);
  await assert.rejects(service.chain({ action: 'open' }), /requires 'id'/);
  fs.mkdirSync(path.join(root, '.contextos', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, '.contextos', 'rules', 'rule-verify.md'),
    '---\nid: rule-verify\ntitle: Verify first\ncategory: workflow\nsummary: Always verify before shipping.\n---\n\nRun the project tests.\n');
  fs.writeFileSync(path.join(root, 'DECISION.md'), '# Decisions\n\n## [storage] Storage\n\nSQLite is the store.\n');
  const listed = await service.knowledge({ action: 'list' });
  assert.match(listed, /rule-verify/);
  assert.match(listed, /\[DECISION\]/);
  assert.match(await service.knowledge({ action: 'read', ruleId: 'rule-verify' }), /Run the project tests\./);
  assert.match(await service.knowledge({ action: 'read', sectionId: 'storage' }), /SQLite is the store\./);
  const status = await service.knowledge({ action: 'status', format: 'json' });
  assert.equal(status.rules, 1);
  assert.equal(status.decisionSections, 1);
  await assert.rejects(service.knowledge({ action: 'read', ruleId: 'missing-rule' }), /was not found/);
}));

test('validation retains hard errors for missing members, dangling links and duplicate explicit owners', () => fixture(async (service) => {
  service.db.saveChain({ id: 'legacy-broken', projectId: service.projectId, title: 'Broken import', memberIds: ['missing'] });
  service.db.saveBlock({ ...service.db.getBlock('a'), id: 'duplicate' });
  service.db.db.prepare("INSERT INTO links (id,project_id,from_id,to_id,kind,created_at,updated_at) VALUES ('broken',?,'a','missing','unknown','now','now')").run(service.projectId);
  const result = await service.chain({ action: 'validate' });
  assert.equal(result.valid, false);
  assert.deepEqual(result.missingMembers, [{ chainId: 'legacy-broken', blockId: 'missing' }]);
  assert.deepEqual(result.danglingLinks, ['broken']);
  assert.equal(result.duplicateArtifactRefs.length, 1);
  assert.equal(result.invalidLinks[0].id, 'broken');
}));

test('typed pair Links coexist, endpoint and kind rejection is atomic, and unlink has explicit scopes', () => fixture(async (service) => {
  await service.chain({ action: 'compose', chainData: { id: 'group', title: 'Feature', kind: 'feature', memberIds: ['a', 'b'] } });
  await service.chain({ action: 'link', linkData: { from: 'a', to: 'b', kind: 'calls' } });
  await service.chain({ action: 'link', linkData: { from: 'a', to: 'b', kind: 'depends_on' } });
  let links = await service.chain({ action: 'links', format: 'json' });
  assert.equal(links.length, 2);
  assert.equal(new Set(links.map((link) => link.id)).size, 2);
  const calls = links.find((link) => link.kind === 'calls');
  const before = service.db.listLinks(service.projectId);
  for (const patch of [{ to: 'group' }, { to: 'missing' }, { from: 'missing' }, { kind: 'unknown' }, { from: 7 }]) {
    await assert.rejects(service.chain({ action: 'link', linkData: { ...calls, ...patch } }), /endpoint|existing Block|Invalid link kind/);
    assert.deepEqual(service.db.listLinks(service.projectId), before);
  }
  await service.chain({ action: 'unlink', linkData: { from: 'a', to: 'b', kind: 'calls' } });
  assert.deepEqual(service.db.listLinks(service.projectId).map((link) => link.kind), ['depends_on']);
  await service.chain({ action: 'link', linkData: { id: 'legacy-pair-id', from: 'a', to: 'b', kind: 'calls' } });
  await service.chain({ action: 'unlink', linkData: { id: 'legacy-pair-id' } });
  assert.equal(service.db.listLinks(service.projectId).length, 1);
  await service.chain({ action: 'link', linkData: { from: 'a', to: 'b', kind: 'calls' } });
  await service.chain({ action: 'unlink', linkData: { from: 'a', to: 'b' } });
  assert.deepEqual(service.db.listLinks(service.projectId), []);
  await assert.rejects(service.chain({ action: 'compose', chainData: { id: 'bad', title: 'Invalid', kind: 'unknown' } }), /Invalid chain kind/);
  assert.equal(service.db.getChain('bad'), null);
}));

test('owners batches actual explicit file, symbol and tree coverage and reports missing/multiple', () => fixture(async (service, root) => {
  await service.chain({ action: 'compose', chainData: { id: 'group', title: 'Feature', kind: 'linear', memberIds: ['a'] } });
  let result = await service.block({ action: 'owners', paths: ['src/a.mjs', 'src/b.mjs', 'src/unowned.mjs', 'missing.mjs'], format: 'json' });
  assert.equal(result.items[0].owners[0].id, 'a');
  assert.deepEqual(result.items[0].owners[0].chainIds, ['group']);
  assert.equal(result.items[0].owners[0].refs[0].matchKind, 'exact-file');
  assert.deepEqual(result.missing, ['src/unowned.mjs', 'missing.mjs']);
  await service.block({ action: 'bind_auto', id: 'a', paths: ['src/a.mjs'], refreshPaths: true });
  result = await service.block({ action: 'owners', paths: ['src/a.mjs'], format: 'json' });
  assert.equal(result.items[0].owners[0].refs[0].matchKind, 'exact-symbol');
  fs.writeFileSync(path.join(root, 'src/a.mjs'), 'export function alpha() { return 4; }\n');
  result = await service.block({ action: 'owners', paths: ['src/a.mjs'], format: 'json' });
  assert.equal(result.items[0].owners[0].refs[0].anchorStatus, 'stale');
  service.db.saveBlock({ ...service.db.getBlock('a'), id: 'duplicate' });
  result = await service.block({ action: 'owners', paths: ['src/a.mjs'], format: 'json' });
  assert.deepEqual(result.multiple, ['src/a.mjs']);
  service.db.deleteBlock('duplicate');
  await service.block({ action: 'bind', id: 'tree', blockData: { title: 'Explicit tree', artifactRefs: [{ path: 'src', anchorKind: 'tree', hashMode: 'manifest', manifest: 'package.json' }] } });
  result = await service.block({ action: 'owners', paths: ['src/unowned.mjs', 'package.json'], format: 'json' });
  assert.deepEqual(result.items.map((item) => item.status), ['owned', 'owned']);
  assert.equal(result.items[0].owners[0].refs[0].matchKind, 'tree-member');
  assert.equal(result.items[1].owners[0].refs[0].matchKind, 'tree-manifest');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"changed"}\n');
  result = await service.block({ action: 'owners', paths: ['src/unowned.mjs'], format: 'json' });
  assert.equal(result.items[0].owners[0].refs[0].anchorStatus, 'stale');
  const scoped = await service.chain({ action: 'validate', checkSources: true, paths: ['package.json'] });
  assert.equal(scoped.sourceIssues[0].kind, 'hash-drift');
}));

test('different symbol locators on one file cannot conceal duplicate explicit owners', () => fixture(async (service) => {
  await service.block({ action: 'bind_auto', id: 'a', paths: ['src/a.mjs'], refreshPaths: true });
  await service.block({ action: 'bind', id: 'other', blockData: { title: 'Other owner', artifactRefs: [{ path: 'src/a.mjs' }] } });
  const result = await service.chain({ action: 'validate' });
  assert.equal(result.valid, false);
  assert.deepEqual(result.duplicateOwners, [{ path: 'src/a.mjs', blockIds: ['a', 'other'] }]);
  assert.deepEqual(result.duplicateArtifactRefs, [], 'distinct locators are still conflicting file ownership');
}));

test('source validation and owners never accept escaping symlink anchors', { skip: process.platform === 'win32' }, () => fixture(async (service, root) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-anchor-private-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.mjs'), 'export const secret = 9;\n');
    fs.symlinkSync(path.join(outside, 'secret.mjs'), path.join(root, 'escape.mjs'));
    service.db.saveBlock({ id: 'escaped', projectId: service.projectId, title: 'Historical escape', artifactRefs: [{ path: 'escape.mjs', hash: 'old' }] });
    const owners = await service.block({ action: 'owners', paths: ['escape.mjs'], format: 'json' });
    assert.deepEqual(owners.missing, ['escape.mjs']);
    const result = await service.chain({ action: 'validate', checkSources: true, paths: ['escape.mjs'] });
    assert.equal(result.sourceIssues[0].kind, 'unreadable-anchor');
    assert.match(result.sourceIssues[0].message, /outside project/);
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
}));

test('same-name Swift platform branches validate the saved declaration locator', () => fixture(async (service, root) => {
  const file = 'branches.swift';
  const content = '#if os(macOS)\nstruct Branch {\n  let value = 1\n}\n#else\nstruct Branch {\n  let value = 2\n}\n#endif\n';
  fs.writeFileSync(path.join(root, file), content);
  await service.block({ action: 'bind_auto', id: 'branches', paths: [file], blockData: { title: 'Platform branches' } });
  const block = await service.block({ action: 'open', id: 'branches', format: 'json' });
  const branch = block.artifactRefs.find(ref => ref.symbol === 'Branch');
  assert.ok(branch.startLine > 4, 'bind_auto preserves the deduplicated second platform declaration');
  assert.deepEqual((await service.chain({ action: 'validate', checkSources: true, paths: [file] })).sourceIssues, []);
  const owners = await service.block({ action: 'owners', paths: [file], format: 'json' });
  assert.equal(owners.items[0].owners[0].refs.find(ref => ref.symbol === 'Branch').anchorStatus, 'fresh');
  fs.writeFileSync(path.join(root, file), content.replace('value = 2', 'value = 3'));
  assert.deepEqual((await service.chain({ action: 'validate', checkSources: true, paths: [file] })).sourceIssues.map(issue => issue.kind), ['hash-drift']);
}));

test('generated artifacts bind one whole-file locator instead of exploding into symbols', () => fixture(async (service, root) => {
  const file = 'bundle.mjs';
  const lines = [];
  for (let i = 0; i < 40; i += 1) lines.push(`export function generated${i}() { return ${i}; }`);
  fs.writeFileSync(path.join(root, file), lines.join('\n') + '\n');
  const bound = await service.block({ action: 'bind_auto', id: 'bundle', path: file, anchorKind: 'file', blockData: { title: 'Generated bundle' }, format: 'json' });
  assert.equal(bound.block.artifactRefs.length, 1, 'a generated artifact owns exactly one locator');
  assert.equal(bound.block.artifactRefs[0].anchorKind, 'file');
  assert.equal(bound.block.artifactRefs[0].symbol, 'bundle.mjs');
  assert.deepEqual((await service.chain({ action: 'validate', checkSources: true, paths: [file] })).sourceIssues, []);
  fs.writeFileSync(path.join(root, file), lines.concat('export const extra = 1;').join('\n') + '\n');
  assert.deepEqual((await service.chain({ action: 'validate', checkSources: true, paths: [file] })).sourceIssues.map(issue => issue.kind), ['hash-drift']);
}));
