import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  evictArtifacts,
  listArtifacts,
  readArtifact,
  statArtifact,
  storeArtifact,
} from '../src/artifact-store.mjs';

function makeTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-artifact-'));
}

test('artifact store persists, reads ranges, and returns bounded excerpts', () => {
  const root = makeTempProject();
  try {
    const stored = storeArtifact(root, 'alpha\nbeta\ngamma\ndelta\n', {
      id: 'art-test',
      kind: 'test',
    });
    assert.equal(stored.id, 'art-test');
    assert.ok(fs.existsSync(stored.path));

    const full = readArtifact(root, 'art-test');
    assert.match(full.text, /1: alpha/);
    assert.match(full.text, /4: delta/);

    const range = readArtifact(root, 'art-test', { startLine: 2, endLine: 3 });
    assert.match(range.text, /2: beta/);
    assert.match(range.text, /3: gamma/);
    assert.doesNotMatch(range.text, /1: alpha/);

    const grepped = readArtifact(root, 'art-test', { grep: 'DELTA' });
    assert.match(grepped.text, /4: delta/);

    const bounded = readArtifact(root, 'art-test', { maxChars: 12 });
    assert.equal(bounded.truncated, true);
    assert.ok(bounded.text.length <= 12);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('artifact grep supports regular expressions and literal fallback', () => {
  const root = makeTempProject();
  try {
    storeArtifact(root, 'alpha\nbracket [ok]\ndelta\n', { id: 'art-grep' });

    const alternation = readArtifact(root, 'art-grep', { grep: 'alpha|delta' });
    assert.equal(alternation.returnedLines, 2);
    assert.match(alternation.text, /alpha/);
    assert.match(alternation.text, /delta/);
    assert.doesNotMatch(alternation.text, /bracket/);

    const invalidRegex = readArtifact(root, 'art-grep', { grep: '[' });
    assert.equal(invalidRegex.returnedLines, 1);
    assert.match(invalidRegex.text, /bracket \[ok\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('artifact context lines expand, merge overlaps, and respect ranges', () => {
  const root = makeTempProject();
  try {
    storeArtifact(root, 'one\ntwo\nthree\nfour\nfive\nsix\n', { id: 'art-context' });

    const defaultContext = readArtifact(root, 'art-context', { grep: 'three' });
    assert.deepEqual(defaultContext.text.split('\n'), ['3: three']);
    assert.equal(defaultContext.returnedLines, 1);

    const expanded = readArtifact(root, 'art-context', { grep: 'three', contextLines: 1 });
    assert.deepEqual(expanded.text.split('\n'), ['2: two', '3: three', '4: four']);
    assert.equal(expanded.returnedLines, 3);

    const overlapping = readArtifact(root, 'art-context', { grep: 'two|four', contextLines: 1 });
    assert.deepEqual(overlapping.text.split('\n'), [
      '1: one',
      '2: two',
      '3: three',
      '4: four',
      '5: five',
    ]);
    assert.equal(overlapping.returnedLines, 5);

    const ranged = readArtifact(root, 'art-context', {
      startLine: 2,
      endLine: 5,
      grep: 'three',
      contextLines: 5,
    });
    assert.deepEqual(ranged.text.split('\n'), ['2: two', '3: three', '4: four', '5: five']);
    assert.deepEqual(ranged.range, { startLine: 2, endLine: 5 });

    const unnumbered = readArtifact(root, 'art-context', {
      grep: 'three',
      contextLines: 1,
      lineNumbers: false,
    });
    assert.deepEqual(unnumbered.text.split('\n'), ['two', 'three', 'four']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('artifact lifecycle evicts by count, bytes, and age while preserving keep ids', () => {
  const root = makeTempProject();
  try {
    storeArtifact(root, 'old', { id: 'art-old' });
    storeArtifact(root, 'middle', { id: 'art-middle' });
    storeArtifact(root, 'new', { id: 'art-new' });
    const indexFile = path.join(root, '.contextos', 'artifacts', 'index.json');
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    const timestamps = {
      'art-old': '2026-01-01T00:00:00.000Z',
      'art-middle': '2026-01-02T00:00:00.000Z',
      'art-new': '2026-01-03T00:00:00.000Z',
    };
    for (const entry of index.entries) entry.createdAt = timestamps[entry.id];
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));

    const result = evictArtifacts(root, {
      maxArtifacts: 2,
      maxTotalBytes: 1000,
      maxAgeMs: Infinity,
      keep: ['art-middle'],
    });
    assert.equal(result.evicted.length, 1);
    assert.ok(['art-old', 'art-middle'].includes(result.evicted[0].id));
    assert.equal(listArtifacts(root).length, 2);

    const kept = evictArtifacts(root, {
      maxArtifacts: 1,
      maxTotalBytes: 1,
      maxAgeMs: 0,
      keep: ['art-middle'],
    });
    assert.ok(kept.entries.some((entry) => entry.id === 'art-middle'));
    assert.ok(statArtifact(root, 'art-middle'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('artifact lifecycle expires old entries by timestamp', () => {
  const root = makeTempProject();
  try {
    storeArtifact(root, 'expired', { id: 'art-expired' });
    const indexFile = path.join(root, '.contextos', 'artifacts', 'index.json');
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    index.entries[0].createdAt = '2000-01-01T00:00:00.000Z';
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));

    const result = evictArtifacts(root, { maxAgeMs: 1000 });
    assert.deepEqual(result.evicted, [{ id: 'art-expired', reason: 'expired' }]);
    assert.equal(statArtifact(root, 'art-expired'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('explicit artifact eviction deletes requested ids without returning the index', () => {
  const root = makeTempProject();
  try {
    storeArtifact(root, 'one', { id: 'art-one' });
    storeArtifact(root, 'two', { id: 'art-two' });
    const indexFile = path.join(root, '.contextos', 'artifacts', 'index.json');
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    index.entries.find((entry) => entry.id === 'art-two').createdAt = '2000-01-01T00:00:00.000Z';
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));

    const result = evictArtifacts(root, {
      id: 'art-one',
    });
    assert.deepEqual(result.evicted, [{ id: 'art-one', reason: 'requested' }]);
    assert.deepEqual(result.requested, ['art-one']);
    assert.deepEqual(result.notFound, []);
    assert.equal(statArtifact(root, 'art-one'), null);
    assert.ok(statArtifact(root, 'art-two'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('artifact ids reject path traversal', () => {
  const root = makeTempProject();
  try {
    assert.throws(() => storeArtifact(root, 'bad', { id: '../escape' }), /Artifact id/);
    assert.equal(readArtifact(root, '../escape'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
