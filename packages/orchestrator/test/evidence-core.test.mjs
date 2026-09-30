import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  collectEvidence,
  deliverEvidence,
  extractLineRanges,
  mergeLineRanges,
  normalizeEvidencePath,
  searchWorkspace,
  workspaceIdentity,
} from '../src/evidence-core.mjs';

function temporaryProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-evidence-core-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  return root;
}

test('workspace identity follows realpath and range extraction preserves exact UTF-8 line text', async (t) => {
  const root = temporaryProject();
  const alias = `${root}-alias`;
  t.after(() => {
    fs.rmSync(alias, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.symlinkSync(root, alias, 'dir');

  const real = workspaceIdentity(root);
  const linked = workspaceIdentity(alias);
  assert.equal(linked.workspace, real.workspace);
  assert.equal(linked.workspaceId, real.workspaceId);

  const source = '中😀\r\nsecond\r\nlast';
  fs.writeFileSync(path.join(root, 'src', 'fixture.mjs'), source, 'utf8');
  const evidence = await collectEvidence({
    projectRoot: alias,
    requests: [{ path: 'src/fixture.mjs', ranges: [[2, 2], [1, 1], { start: 2, end: 3 }] }],
  });

  assert.equal(evidence.status, 'complete');
  assert.equal(evidence.records.length, 1, 'overlapping and adjacent requests merge');
  assert.deepEqual(evidence.records[0].ranges, [{ start: 1, end: 3 }]);
  assert.equal(evidence.records[0].text, source);
  assert.equal(evidence.records[0].bytes, Buffer.byteLength(source, 'utf8'));
  assert.equal(evidence.records[0].chars, Array.from(source).length);
  assert.equal(evidence.records[0].workspaceId, real.workspaceId);
  assert.deepEqual(mergeLineRanges([[4, 5], [2, 3], [3, 4], [9, 9]]), [
    { start: 2, end: 5 },
    { start: 9, end: 9 },
  ]);

  const hashBeforeEdit = evidence.records[0].contentHash;
  fs.writeFileSync(path.join(root, 'src', 'fixture.mjs'), `${source}!`, 'utf8');
  const edited = await collectEvidence({ projectRoot: root, requests: [{ path: 'src/fixture.mjs' }] });
  assert.notEqual(edited.records[0].contentHash, hashBeforeEdit, 'hash follows uncommitted disk content');
  assert.equal(edited.records[0].text, `${source}!`);
});

test('line extraction has no phantom final line and handles empty files explicitly', () => {
  assert.deepEqual(extractLineRanges('one\r\ntwo\n', [[1, 1], [2, 2]]), [
    { ranges: [{ start: 1, end: 2 }], text: 'one\r\ntwo\n', bytes: 9, chars: 9 },
  ]);
  assert.deepEqual(extractLineRanges('', []), []);
  assert.throws(() => extractLineRanges('one\n', [[2, 2]]), /outside/);
  assert.throws(() => mergeLineRanges([[0, 1]]), /inclusive 1-based/);
});

test('range reads clip only the end at EOF while starts beyond EOF remain missing', async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = 'alpha\nbeta\ngamma\n';
  fs.writeFileSync(path.join(root, 'src', 'state.mjs'), source);

  const clipped = await collectEvidence({
    projectRoot: root,
    requests: [{ path: 'src/state.mjs', ranges: [[2, 60]] }],
  });
  assert.equal(clipped.status, 'complete');
  assert.deepEqual(clipped.records.map((record) => record.ranges), [[{ start: 2, end: 3 }]]);
  assert.equal(clipped.records[0].text, 'beta\ngamma\n');
  assert.deepEqual(clipped.missing, []);
  assert.equal(clipped.notices.length, 1);
  assert.deepEqual(clipped.notices[0].requestedRange, { start: 2, end: 60 });
  assert.deepEqual(clipped.notices[0].actualRange, { start: 2, end: 3 });

  const beyond = await collectEvidence({
    projectRoot: root,
    requests: [{ path: 'src/state.mjs', ranges: [[60, 80]] }],
  });
  assert.equal(beyond.status, 'partial');
  assert.equal(beyond.records.length, 0);
  assert.equal(beyond.notices.length, 0);
  assert.deepEqual(beyond.missing[0].range, { start: 60, end: 80 });
});

test('unsafe paths and symlinks outside the workspace are rejected with a concrete gap', async (t) => {
  const root = temporaryProject();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-evidence-outside-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(outside, 'private.mjs'), 'const secret = true;\n');
  fs.symlinkSync(path.join(outside, 'private.mjs'), path.join(root, 'src', 'escape.mjs'));

  assert.throws(() => normalizeEvidencePath('../outside.mjs'), /escapes/);
  const result = await collectEvidence({
    projectRoot: root,
    requests: [
      { path: '../outside.mjs' },
      { path: 'src/escape.mjs' },
    ],
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.records.length, 0);
  assert.equal(result.missing.length, 2);
  assert.match(result.missing[1].reason, /outside/);
});

test('workspace search excludes dependency and generated output directories', async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'node_modules', 'package'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'generated'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'auth.mjs'), 'export function login() { return "needle"; }\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'package', 'auth.mjs'), 'needle in dependency\n');
  fs.writeFileSync(path.join(root, 'dist', 'auth.mjs'), 'needle in build output\n');
  fs.writeFileSync(path.join(root, 'src', 'generated', 'auth.mjs'), 'needle in generated output\n');
  fs.writeFileSync(path.join(root, '.env'), 'needle in a secret file\n');

  const result = await searchWorkspace({ projectRoot: root, queries: ['needle'] });
  assert.deepEqual(result.results.map((item) => item.path), ['src/auth.mjs']);
  assert.equal(result.status, 'complete');
});

test('delivery refuses to substitute a newer file version for a stale citation', async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'src', 'state.mjs');
  fs.writeFileSync(file, 'export const state = "old";\n');
  const initial = await collectEvidence({ projectRoot: root, requests: [{ path: 'src/state.mjs', ranges: [[1, 1]] }] });
  const original = initial.records[0];
  fs.writeFileSync(file, 'export const state = "new";\n');

  const delivered = await deliverEvidence({
    projectRoot: root,
    availableRecords: initial.records,
    references: [{ id: original.id, path: original.path, contentHash: original.contentHash, ranges: original.ranges }],
  });
  assert.equal(delivered.status, 'partial');
  assert.equal(delivered.records.length, 0);
  assert.equal(delivered.missing[0].expectedContentHash, original.contentHash);
  assert.notEqual(delivered.missing[0].currentContentHash, original.contentHash);
  assert.match(delivered.missing[0].reason, /refresh/);
});

test('a stale search content hash is rejected before evidence is hydrated', async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'src', 'state.mjs');
  fs.writeFileSync(file, 'export const state = "old";\n');
  const search = await searchWorkspace({ projectRoot: root, queries: ['state'] });
  const oldHash = search.results[0].contentHash;
  fs.writeFileSync(file, 'export const state = "new";\n');

  const stale = await collectEvidence({
    projectRoot: root,
    requests: [{ path: search.results[0].path, expectedContentHash: oldHash, ranges: [[1, 1]] }],
  });
  assert.equal(stale.status, 'partial');
  assert.equal(stale.records.length, 0);
  assert.equal(stale.missing[0].expectedContentHash, oldHash);
  assert.notEqual(stale.missing[0].currentContentHash, oldHash);
  assert.match(stale.missing[0].reason, /changed before the requested evidence was read/);
});

test('delivery accepts exact selected subranges and creates records linked to the read evidence', async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = 'one\ntwo\nthree\nfour\nfive\n';
  fs.writeFileSync(path.join(root, 'src', 'state.mjs'), source);
  const read = await collectEvidence({ projectRoot: root, requests: [{ path: 'src/state.mjs', ranges: [[1, 5]] }] });
  const original = read.records[0];

  const delivered = await deliverEvidence({
    projectRoot: root,
    availableRecords: [original],
    references: [{
      id: original.id,
      path: original.path,
      contentHash: original.contentHash,
      ranges: [[2, 2], [4, 4]],
    }],
  });

  assert.equal(delivered.status, 'complete');
  assert.deepEqual(delivered.records.map((record) => record.ranges), [
    [{ start: 2, end: 2 }], [{ start: 4, end: 4 }],
  ]);
  assert.deepEqual(delivered.records.map((record) => record.text), ['two\n', 'four\n']);
  for (const record of delivered.records) {
    assert.notEqual(record.id, original.id, 'selected records get an id for their delivered ranges');
    assert.equal(record.sourceEvidenceId, original.id);
    assert.equal(record.contentHash, original.contentHash);
  }
});

test('delivery rejects a selected interval spanning an unread hole or extending outside read lines', async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'src', 'state.mjs'), 'one\ntwo\nthree\nfour\nfive\n');
  const read = await collectEvidence({ projectRoot: root, requests: [{ path: 'src/state.mjs', ranges: [[1, 2], [4, 5]] }] });
  const original = read.records[0];

  for (const ranges of [[[2, 4]], [[1, 6]]]) {
    const delivered = await deliverEvidence({
      projectRoot: root,
      availableRecords: read.records,
      references: [{ id: original.id, path: original.path, contentHash: original.contentHash, ranges }],
    });
    assert.equal(delivered.status, 'partial');
    assert.equal(delivered.records.length, 0);
    assert.match(delivered.missing[0].reason, /subset|unread gaps/);
  }
});

test('EOF clipping notices never expand the ranges allowed for citation', async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'src', 'state.mjs'), 'one\ntwo\nthree\n');
  const read = await collectEvidence({ projectRoot: root, requests: [{ path: 'src/state.mjs', ranges: [[1, 60]] }] });
  const original = read.records[0];
  assert.deepEqual(original.ranges, [{ start: 1, end: 3 }]);
  assert.equal(read.notices.length, 1);

  const delivered = await deliverEvidence({
    projectRoot: root,
    availableRecords: [original],
    references: [{
      id: original.id,
      path: original.path,
      contentHash: original.contentHash,
      ranges: [[1, 60]],
    }],
  });
  assert.equal(delivered.status, 'partial');
  assert.equal(delivered.records.length, 0);
  assert.match(delivered.missing[0].reason, /subset of ranges returned/);
});

test('delivery rejects subset citations after source edits and across workspace identities', async (t) => {
  const root = temporaryProject();
  const other = temporaryProject();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  });
  const sourcePath = path.join(root, 'src', 'state.mjs');
  const otherSourcePath = path.join(other, 'src', 'state.mjs');
  fs.writeFileSync(sourcePath, 'one\ntwo\n');
  fs.writeFileSync(otherSourcePath, 'one\ntwo\n');
  const read = await collectEvidence({ projectRoot: root, requests: [{ path: 'src/state.mjs', ranges: [[1, 2]] }] });
  const original = read.records[0];
  const selection = [{ id: original.id, path: original.path, contentHash: original.contentHash, ranges: [[2, 2]] }];

  fs.writeFileSync(sourcePath, 'one\nchanged\n');
  const stale = await deliverEvidence({ projectRoot: root, availableRecords: [original], references: selection });
  assert.equal(stale.status, 'partial');
  assert.equal(stale.records.length, 0);
  assert.match(stale.missing[0].reason, /changed after selection/);

  const foreign = await deliverEvidence({ projectRoot: other, availableRecords: [original], references: selection });
  assert.equal(foreign.status, 'partial');
  assert.equal(foreign.records.length, 0);
  assert.match(foreign.missing[0].reason, /Workspace identity changed/);
});
