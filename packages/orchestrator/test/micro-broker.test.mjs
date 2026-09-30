import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { searchWorkspace } from '../src/evidence-core.mjs';
import { requestEvidence } from '../src/micro-broker.mjs';

const HYDRATION_SOURCES = {
  'src/session-flow.mjs': [
    "import { makeSession } from './session-factory.mjs';",
    '',
    'export async function authenticate(credentials, clock = Date) {',
    "  if (!credentials?.username) throw new TypeError('username is required');",
    '  const session = await makeSession(credentials.username);',
    '  return { ...session, issuedAt: clock.now() };',
    '}',
    '',
  ].join('\n'),
  'src/session-factory.mjs': [
    "import crypto from 'node:crypto';",
    '',
    'export async function makeSession(username) {',
    '  const id = crypto.randomUUID();',
    '  return { id, username, active: true };',
    '}',
    '',
  ].join('\n'),
};
const HYDRATION_TARGETS = [
  { path: 'src/session-flow.mjs', start: 3, end: 7 },
  { path: 'src/session-factory.mjs', start: 3, end: 6 },
];
const HYDRATION_HASHES = {
  'src/session-flow.mjs': 'ccae908707563b09d32f03bdcaac1e21ae31f3fa18ac61653e12c61fbd66aaaf',
  'src/session-factory.mjs': '9a3cf1bab395430b2064c8bde1ba0c2799216ef463e34c5967abf3c4776d1d3e',
};

function temporaryProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-micro-broker-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'login.mjs'), 'export function login() { return "session"; }\n');
  return root;
}

function reference(record) {
  return { id: record.id, path: record.path, contentHash: record.contentHash, ranges: record.ranges };
}

async function hydrationFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-micro-hydration-'));
  try {
    for (const [relative, text] of Object.entries(HYDRATION_SOURCES)) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text, 'utf8');
    }
    return await run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function exactHydrationText(target) {
  return HYDRATION_SOURCES[target.path].split(/(?<=\n)/u).slice(target.start - 1, target.end).join('');
}

function hydrationStub() {
  let invocation = 0;
  const seen = [];
  const transport = async (context) => {
    invocation += 1;
    seen.push(context);
    if (invocation === 1) {
      return { calls: [{ id: 'search-1', name: 'search', args: {
        queries: ['export async function authenticate', 'export async function makeSession'],
        paths: ['src'], limit: 8,
      } }] };
    }

    const result = context.toolResults.at(-1).result;
    const records = [...(result.records || []), ...(result.alreadyCovered || [])];
    const covered = HYDRATION_TARGETS.map((target) => {
      const matching = records.filter((candidate) => candidate.path === target.path)
        .flatMap((candidate) => candidate.ranges || []).sort((left, right) => left.start - right.start);
      let cursor = target.start;
      for (const range of matching) {
        if (range.end < cursor) continue;
        if (range.start > cursor) break;
        cursor = Math.max(cursor, range.end + 1);
        if (cursor > target.end) break;
      }
      return { target, fullyCovered: cursor > target.end };
    });
    if (invocation === 2 && covered.some(({ fullyCovered }) => !fullyCovered)) {
      const hits = result.results || [];
      const requests = covered.filter(({ fullyCovered }) => !fullyCovered).map(({ target }) => ({
        path: target.path,
        ranges: [[target.start, target.end]],
        contentHash: hits.find((hit) => hit.path === target.path)?.contentHash,
      }));
      return { calls: [{ id: 'read-2', name: 'read', args: { requests } }] };
    }
    if ((invocation === 2 && !covered.some(({ fullyCovered }) => !fullyCovered)) || invocation === 3) {
      const references = [];
      for (const target of HYDRATION_TARGETS) {
        for (const candidate of records.filter((record) => record.path === target.path)) {
          const ranges = candidate.ranges.flatMap((range) => {
            const start = Math.max(target.start, range.start);
            const end = Math.min(target.end, range.end);
            return start <= end ? [{ start, end }] : [];
          });
          if (ranges.length) references.push({ ...reference(candidate), ranges });
        }
      }
      return { calls: [{ id: `select-${invocation}`, name: 'select', args: { references } }] };
    }
    throw new Error(`Unexpected fixture call ${invocation}.`);
  };
  return { transport, seen, get invocation() { return invocation; } };
}

test('exact inspect reads bypass transport and deliver precise source directly', async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let transportCalls = 0;

  const result = await requestEvidence({
    request: 'Read the login function.',
    inspect: [{ path: 'src/login.mjs', ranges: [[1, 1]] }],
  }, {
    projectRoot: root,
    transport: async () => { transportCalls += 1; throw new Error('must not be called'); },
  });

  assert.equal(transportCalls, 0);
  assert.equal(result.status, 'complete');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].text, 'export function login() { return "session"; }\n');
  assert.equal(result.accounting.transportInvocations, 0);
  assert.equal(result.accounting.usage, null);
  assert.equal(result.accounting.usageStatus, 'not_requested');
});

test('known proof read returns only uncovered lines and lets selection reuse the verified ranges', async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = 'line one\nline two\nline three\nline four\nline five\n';
  fs.writeFileSync(path.join(root, 'src', 'proof.mjs'), source);
  const initial = await requestEvidence({ inspect: [{ path: 'src/proof.mjs', ranges: [[1, 2]] }] }, { projectRoot: root });
  let invocation = 0;
  let readResult;
  const result = await requestEvidence({ request: 'Return source lines one through four.' }, {
    projectRoot: root,
    knownContext: { notes: ['Already inspected the first two lines.'], refs: [], records: initial.records, missing: [] },
    transport: async (context) => {
      invocation += 1;
      if (invocation === 1) {
        const input = JSON.parse(context.input);
        assert.equal(input.known.notes[0], 'Already inspected the first two lines.');
        assert.ok(!context.input.includes('line one'));
        return { calls: [{ id: 'gap-read', name: 'read', args: { requests: [
          { path: 'src/proof.mjs', ranges: [[1, 4]], contentHash: initial.records[0].contentHash },
        ] } }] };
      }
      readResult = context.toolResults.at(-1).result;
      assert.deepEqual(readResult.records.map((record) => record.ranges), [[{ start: 3, end: 4 }]]);
      assert.equal(readResult.records[0].text, 'line three\nline four\n');
      assert.deepEqual(readResult.alreadyCovered.map((reference) => reference.ranges), [[{ start: 1, end: 2 }]]);
      assert.ok(!JSON.stringify(readResult).includes('line one\nline two\n'));
      return { calls: [{ id: 'select-known-and-gap', name: 'select', args: { references: [
        ...readResult.alreadyCovered,
        ...readResult.records.map((record) => reference(record)),
      ] } }] };
    },
  });

  assert.equal(invocation, 2);
  assert.equal(result.status, 'complete');
  assert.equal(result.accounting.readRequests, 1);
  assert.equal(result.accounting.transportInvocations, 2);
  assert.equal(result.records.map((record) => record.text).join(''), 'line three\nline four\n');
  assert.deepEqual(result.reused.map(({ path, ranges }) => ({ path, ranges })), [{
    path: 'src/proof.mjs', ranges: [{ start: 1, end: 2 }],
  }]);
});

test('semantic read can open a safe workspace path directly without a preceding search', async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const result = await requestEvidence({ request: 'Return the exact login function.' }, {
    projectRoot: root,
    transport: async (context) => {
      calls += 1;
      if (calls === 1) return { calls: [{ id: 'direct-read', name: 'read', args: { requests: [
        { path: 'src/login.mjs', ranges: [[1, 1]] },
      ] } }] };
      const record = context.toolResults.at(-1).result.records[0];
      return { calls: [{ id: 'direct-select', name: 'select', args: { references: [reference(record)] } }] };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 'complete');
  assert.equal(result.records[0].path, 'src/login.mjs');
  assert.equal(result.records[0].text, 'export function login() { return "session"; }\n');
});

test('direct semantic reads report missing and out-of-workspace paths without delivering source', async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-outside-read-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const outsideFile = path.join(outside, 'private.mjs');
  fs.writeFileSync(outsideFile, 'export const privateValue = true;\n');
  fs.symlinkSync(outsideFile, path.join(root, 'src', 'escaped.mjs'));
  for (const pathValue of ['src/does-not-exist.mjs', '../outside.mjs', 'src/escaped.mjs']) {
    let calls = 0;
    const result = await requestEvidence({ request: 'Check a directly named source path.' }, {
      projectRoot: root,
      transport: async (context) => {
        calls += 1;
        if (calls === 1) return { calls: [{ id: `read-${calls}`, name: 'read', args: { requests: [
          { path: pathValue, ranges: [[1, 2]] },
        ] } }] };
        return { calls: [{ id: `select-${calls}`, name: 'select', args: { references: [],
          missing: [{ path: pathValue, reason: 'Could not provide this requested path.' }] } }] };
      },
    });
    assert.equal(result.status, 'partial');
    assert.equal(result.records.length, 0);
    assert.ok(result.missing.some((item) => item.path === pathValue));
  }
});

test('audit callback failure cannot change selected evidence or trigger another transport round', async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const result = await requestEvidence({ request: 'Return the login declaration.' }, {
    projectRoot: root,
    onTrace: async () => { throw new Error('audit target unavailable'); },
    transport: async (context) => {
      calls += 1;
      if (calls === 1) return { calls: [{ id: 'search-audit-fail', name: 'search', args: { queries: ['export function login'] } }] };
      const record = context.toolResults.at(-1).result.records[0];
      return { calls: [{ id: 'select-audit-fail', name: 'select', args: { references: [reference(record)] } }] };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 'complete');
  assert.equal(result.records[0].text, 'export function login() { return "session"; }\n');
});

test('semantic requests can select exact bounded search evidence without a separate read', async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inputs = [];
  let invocation = 0;

  const result = await requestEvidence({ request: 'Find the login function and return its exact source.' }, {
    projectRoot: root,
    config: { model: 'requested-model', thinking: 'medium', budget: { maxTransportInvocations: 6 } },
    transport: async (call) => {
      invocation += 1;
      inputs.push(call);
      assert.deepEqual(call.tools.map((tool) => tool.function.name), ['search', 'read', 'select']);
      if (invocation === 1) {
        return {
          model: 'actual-model',
          usage: { input_tokens: 10, output_tokens: 2 },
          calls: [{ id: 'search-1', name: 'search', args: { queries: ['login', 'session'] } }],
        };
      }
      if (invocation === 2) {
        const search = call.toolResults[0].result;
        const record = search.records[0];
        assert.ok(record.ranges.some((range) => range.start <= search.results[0].line && range.end >= search.results[0].line));
        return {
          model: 'actual-model',
          calls: [{ id: 'select-1', name: 'select', args: {
            references: [reference(record)],
            summary: 'The login function returns the session value.',
            missing: [],
          } }],
        };
      }
      throw new Error('The fixture should select after search and must not request an extra turn.');
    },
  });

  assert.equal(invocation, 2);
  assert.equal(inputs[0].thinking, 'medium');
  assert.match(inputs[0].turnControl, /remainingInvocations=5/);
  assert.match(inputs[1].turnControl, /remainingInvocations=4/);
  assert.equal(inputs[0].input, inputs[1].input, 'the request stays in the initial context instead of being reserialized on continuation');
  assert.equal(result.status, 'complete');
  assert.equal(result.summary, 'The login function returns the session value.');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].text, 'export function login() { return "session"; }\n');
  assert.equal(result.accounting.transportInvocations, 2);
  assert.equal(result.accounting.toolCalls, 2);
  assert.ok(result.accounting.evidenceBytes > 0);
  assert.ok(result.accounting.searchBytes > 0);
  assert.equal(result.accounting.usage, null, 'a missing provider usage record remains unknown');
  assert.equal(result.accounting.usageStatus, 'partial', 'one unreported provider response keeps the aggregate unknown while preserving observed usage');
  assert.equal(result.accounting.providerResponses[1].usage, null);
  assert.equal(result.accounting.providerResponses[0].model, 'actual-model');
});

test('compact refs are request-scoped, stable across reads, merge ranges, and deliver exact UTF-8 source', async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = '// café\nexport const token = "猫";\nreturn token;\nexport default token;\n';
  fs.writeFileSync(path.join(root, 'src', 'login.mjs'), source, 'utf8');
  let invocation = 0;
  let recordHandle;
  const result = await requestEvidence({ request: 'Return lines 2 through 4 exactly.' }, {
    projectRoot: root,
    transport: async (context) => {
      invocation += 1;
      if (invocation === 1) {
        return { calls: [{ id: 'read-utf8', name: 'read', args: {
          requests: [{ path: 'src/login.mjs', ranges: [{ start: 1, end: 4 }] }],
        } }] };
      }
      if (invocation === 2) {
        const read = context.toolResults.at(-1).result;
        recordHandle = read.records[0].ref;
        assert.match(recordHandle, /^e[a-f0-9]{16}_[0-9a-z]+$/);
        return { calls: [{ id: 'read-covered', name: 'read', args: {
          requests: [{ path: 'src/login.mjs', ranges: [{ start: 2, end: 3 }] }],
        } }] };
      }
      const covered = context.toolResults.at(-1).result.alreadyCovered[0];
      assert.equal(covered.ref, recordHandle, 'the same canonical record retains its handle within this ask');
      return { calls: [{ id: 'select-compact', name: 'select', args: {
        refs: [
          { id: covered.ref, ranges: [{ start: 2, end: 3 }] },
          { id: covered.ref, ranges: [{ start: 3, end: 4 }] },
          { id: covered.ref, ranges: [{ start: 3, end: 3 }] },
        ],
      } }] };
    },
  });

  assert.equal(invocation, 3);
  assert.equal(result.status, 'complete');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].text, 'export const token = "猫";\nreturn token;\nexport default token;\n');
  assert.deepEqual(result.records[0].ranges, [{ start: 2, end: 4 }]);
  assert.equal(result.records[0].bytes, Buffer.byteLength(result.records[0].text, 'utf8'));
  assert.equal(result.records[0].chars, [...result.records[0].text].length);
});

test('unknown and conflicting compact selections stay partial without producing source', async (t) => {
  for (const selection of [
    { refs: ['e0000000000000000_1'] },
    { refs: ['unknown'], references: [] },
  ]) {
    const root = temporaryProject();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const events = [];
    const result = await requestEvidence({ request: 'Select evidence.' }, {
      projectRoot: root,
      onTrace: (event) => events.push(event),
      transport: async () => ({ calls: [{ id: 'invalid-compact-select', name: 'select', args: selection }] }),
    });
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.records, []);
    assert.ok(result.missing.length > 0);
    const selectEvent = events.find((event) => event.kind === 'tool' && event.name === 'select');
    assert.equal(selectEvent.status, 'failed');
    assert.equal(selectEvent.failureCategory, selection.references ? 'refs_references_conflict' : 'unknown_evidence_handle');
  }
});

test('compact handles cannot cross requests or workspaces', async (t) => {
  const firstRoot = temporaryProject();
  const otherRoot = temporaryProject();
  t.after(() => fs.rmSync(firstRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(otherRoot, { recursive: true, force: true }));
  const captureHandle = async (root) => {
    let handle;
    let invocation = 0;
    await requestEvidence({ request: 'Read source for a later request.' }, {
      projectRoot: root,
      config: { budget: { maxTransportInvocations: 2 } },
      transport: async (context) => {
        invocation += 1;
        if (invocation === 1) return { calls: [{ id: 'capture-read', name: 'read', args: {
          requests: [{ path: 'src/login.mjs', ranges: [{ start: 1, end: 1 }] }],
        } }] };
        handle = context.toolResults.at(-1).result.records[0]?.ref;
        return { calls: [] };
      },
    });
    return handle;
  };
  const priorHandle = await captureHandle(firstRoot);
  assert.match(priorHandle, /^e[a-f0-9]{16}_[0-9a-z]+$/);

  for (const root of [firstRoot, otherRoot]) {
    let invocation = 0;
    let currentHandle;
    const result = await requestEvidence({ request: 'Read this request, then select only its current evidence.' }, {
      projectRoot: root,
      config: { budget: { maxTransportInvocations: 2 } },
      transport: async (context) => {
        invocation += 1;
        if (invocation === 1) return { calls: [{ id: 'fresh-read', name: 'read', args: {
          requests: [{ path: 'src/login.mjs', ranges: [{ start: 1, end: 1 }] }],
        } }] };
        currentHandle = context.toolResults[0].result.records[0].ref;
        assert.notEqual(currentHandle, priorHandle);
        return { calls: [{ id: 'stale-compact-select', name: 'select', args: { refs: [priorHandle] } }] };
      },
    });
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.records, []);
    assert.ok(result.missing.some((item) => /Unknown or expired evidence handle/.test(item.reason)));
  }
});

test('compact subranges cannot cross unread holes, extend beyond read lines, or deliver stale text', async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'src', 'login.mjs'), 'one\ntwo\nthree\n', 'utf8');

  for (const ranges of [
    [{ start: 1, end: 3 }],
    [{ start: 4, end: 4 }],
  ]) {
    let invocation = 0;
    const result = await requestEvidence({ request: 'Do not cite unread lines.' }, {
      projectRoot: root,
      transport: async (context) => {
        invocation += 1;
        if (invocation === 1) return { calls: [{ id: 'read-hole', name: 'read', args: {
          requests: [{ path: 'src/login.mjs', ranges: [{ start: 1, end: 1 }, { start: 3, end: 3 }] }],
        } }] };
        const records = context.toolResults.at(-1).result.records;
        assert.deepEqual(records.map((record) => record.ranges), [[{ start: 1, end: 1 }], [{ start: 3, end: 3 }]]);
        const refs = ranges[0].end === 3
          ? records.map((record) => ({ id: record.ref, ranges }))
          : [{ id: records[0].ref, ranges }];
        return { calls: [{ id: 'select-unread', name: 'select', args: { refs } }] };
      },
    });
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.records, []);
    assert.ok(result.missing.length > 0);
  }

  let invocation = 0;
  const stale = await requestEvidence({ request: 'The selected version must remain current.' }, {
    projectRoot: root,
    transport: async (context) => {
      invocation += 1;
      if (invocation === 1) return { calls: [{ id: 'read-stale', name: 'read', args: {
        requests: [{ path: 'src/login.mjs', ranges: [{ start: 1, end: 1 }] }],
      } }] };
      const record = context.toolResults.at(-1).result.records[0];
      fs.writeFileSync(path.join(root, 'src', 'login.mjs'), 'changed\ntwo\nthree\n', 'utf8');
      return { calls: [{ id: 'select-stale', name: 'select', args: { refs: [record.ref] } }] };
    },
  });
  assert.equal(stale.status, 'partial');
  assert.deepEqual(stale.records, []);
  assert.ok(stale.missing.some((item) => /changed|hash/i.test(item.reason)));
});

test('search hydrates exact bounded function windows so the fixture completes in two calls', async () => {
  await hydrationFixture(async (root) => {
    const stub = hydrationStub();
    const result = await requestEvidence({
      request: 'Locate the complete authenticate function and its makeSession dependency. Return the exact source ranges for both definitions.',
      paths: Object.keys(HYDRATION_SOURCES),
    }, { projectRoot: root, transport: stub.transport });

    assert.equal(stub.invocation, 2);
    assert.equal(result.status, 'complete', JSON.stringify(result.missing));
    assert.deepEqual(result.records.map((record) => record.path), HYDRATION_TARGETS.map((target) => target.path));
    assert.deepEqual(result.records.map((record) => record.text), HYDRATION_TARGETS.map(exactHydrationText));
    assert.deepEqual(result.records.map((record) => record.contentHash), HYDRATION_TARGETS.map((target) => HYDRATION_HASHES[target.path]));
    assert.deepEqual(result.records.map((record) => record.ranges), HYDRATION_TARGETS.map((target) => [{ start: target.start, end: target.end }]));
    assert.equal(result.accounting.transportInvocations, 2);
    assert.equal(result.accounting.readRequests, 0);
    assert.equal(result.accounting.searchHydrationRecords, 2);
    assert.equal(result.accounting.searchHydrationBytes, 371);
    assert.equal(result.accounting.evidenceBytes, 371);
    assert.equal(result.accounting.materializedEvidenceBytes, 371);
    assert.equal(result.accounting.materializedEvidenceChars, 371);
    assert.equal(result.accounting.renderedSourceBytes, null, 'the broker has not rendered this exact evidence to a caller');
    assert.equal(result.accounting.renderedSourceChars, null);

    const search = stub.seen[1].toolResults[0].result;
    assert.equal(search.records.length, 2);
    assert.equal(search.status, 'complete');
    assert.equal(search.notices.length, 1, 'the factory window reaches EOF without creating a missing gap');
    assert.ok(search.results.every((hit) => !Object.hasOwn(hit, 'snippet')));
    const serialized = JSON.stringify(search);
    for (const record of search.records) {
      const text = JSON.stringify(record.text);
      const first = serialized.indexOf(text);
      assert.notEqual(first, -1);
      assert.equal(serialized.indexOf(text, first + text.length), -1, 'metadata must not repeat exact source text');
      assert.ok(record.ranges.every((range) => range.start > 1 && range.end - range.start < 8));
      assert.ok(record.bytes < Buffer.byteLength(HYDRATION_SOURCES[record.path], 'utf8'));
    }
    assert.deepEqual(Object.fromEntries(search.records.map((record) => [record.path, record.ranges])), {
      'src/session-factory.mjs': [{ start: 3, end: 6 }],
      'src/session-flow.mjs': [{ start: 3, end: 7 }],
    });
  });
});

test('the recorded four-hit trace hydrates line 1 and both definitions for exact two-call selection', async () => {
  await hydrationFixture(async (root) => {
    let invocation = 0;
    const seen = [];
    const result = await requestEvidence({
      request: 'Locate authenticate and its makeSession dependency, including the import needed to understand that dependency.',
    }, {
      projectRoot: root,
      transport: async (context) => {
        invocation += 1;
        seen.push(context);
        assert.ok(context.tools.some((tool) => tool.function.name === 'read'), 'narrower follow-up reads remain available');
        if (invocation === 1) {
          return { calls: [{ id: 'trace-search-1', name: 'search', args: {
            queries: ['function authenticate', 'makeSession', 'const makeSession', 'function makeSession'],
          } }] };
        }

        const search = context.toolResults.at(-1).result;
        assert.deepEqual(search.results.map(({ path: filePath, line }) => [filePath, line]), [
          ['src/session-factory.mjs', 3],
          ['src/session-flow.mjs', 1],
          ['src/session-flow.mjs', 3],
          ['src/session-flow.mjs', 5],
        ]);
        assert.equal(search.status, 'complete');
        assert.deepEqual(search.missing, []);
        assert.equal(search.notices.length, 2, 'only the two ordinary end-of-file clipping notices remain');
        assert.ok(search.results.every((hit) => !Object.hasOwn(hit, 'snippet')), 'hydrated hits do not duplicate snippets');
        assert.deepEqual(Object.fromEntries(search.records.map((record) => [record.path, record.ranges])), {
          'src/session-factory.mjs': [{ start: 3, end: 6 }],
          'src/session-flow.mjs': [{ start: 1, end: 7 }],
        });
        const factory = search.records.find((record) => record.path === 'src/session-factory.mjs');
        const flow = search.records.find((record) => record.path === 'src/session-flow.mjs');
        assert.equal(flow.text, HYDRATION_SOURCES['src/session-flow.mjs']);
        assert.equal(flow.bytes, 302);
        assert.equal(factory.bytes, 123);
        assert.equal(flow.contentHash, HYDRATION_HASHES['src/session-flow.mjs']);
        assert.equal(factory.contentHash, HYDRATION_HASHES['src/session-factory.mjs']);

        return { calls: [{ id: 'trace-select-2', name: 'select', args: {
          references: [
            { ...reference(flow), ranges: [{ start: 1, end: 1 }, { start: 3, end: 7 }] },
            { ...reference(factory), ranges: [{ start: 3, end: 6 }] },
          ],
          summary: 'authenticate imports and uses makeSession.',
          missing: [],
        } }] };
      },
    });

    assert.equal(invocation, 2);
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.missing, []);
    assert.equal(result.summary, 'authenticate imports and uses makeSession.');
    assert.deepEqual(result.records.map((record) => [record.path, record.ranges, record.text]), [
      ['src/session-flow.mjs', [{ start: 1, end: 1 }], exactHydrationText({ path: 'src/session-flow.mjs', start: 1, end: 1 })],
      ['src/session-flow.mjs', [{ start: 3, end: 7 }], exactHydrationText(HYDRATION_TARGETS[0])],
      ['src/session-factory.mjs', [{ start: 3, end: 6 }], exactHydrationText(HYDRATION_TARGETS[1])],
    ]);
    assert.deepEqual(result.records.map((record) => record.contentHash), [
      HYDRATION_HASHES['src/session-flow.mjs'],
      HYDRATION_HASHES['src/session-flow.mjs'],
      HYDRATION_HASHES['src/session-factory.mjs'],
    ]);
    assert.equal(result.accounting.transportInvocations, 2);
    assert.equal(result.accounting.toolCalls, 2);
    assert.equal(result.accounting.searchHydrationHits, 4);
    assert.equal(result.accounting.searchHydrationRecords, 2);
    assert.equal(result.accounting.searchHydrationBytes, 425);
    assert.equal(result.accounting.evidenceBytes, 425);
    assert.equal(result.accounting.evidenceChars, 425);
    assert.equal(result.accounting.materializedEvidenceBytes, 424);
    assert.equal(result.accounting.materializedEvidenceChars, 424);
    assert.equal(result.accounting.renderedSourceBytes, null);
    assert.equal(result.accounting.renderedSourceChars, null);
    assert.equal(result.accounting.readRequests, 0);
    assert.equal(seen[1].toolResults[0].name, 'search');
  });
});

test('insufficient hydration window falls back to exact reads and still verifies complete citations', async () => {
  await hydrationFixture(async (root) => {
    const stub = hydrationStub();
    const result = await requestEvidence({
      request: 'Locate authenticate and makeSession definitions.',
      budget: { searchHydrationWindowLines: 1 },
    }, {
      projectRoot: root,
      config: { budget: { searchHydrationWindowLines: 1 } },
      transport: stub.transport,
    });

    assert.equal(stub.invocation, 3);
    assert.equal(result.status, 'complete', JSON.stringify(result.missing));
    assert.equal(result.accounting.maxSearchHydrationWindowLines, 1);
    assert.equal(result.accounting.readRequests, 2);
    for (const target of HYDRATION_TARGETS) {
      const selected = result.records.filter((record) => record.path === target.path)
        .sort((left, right) => left.ranges[0].start - right.ranges[0].start);
      assert.ok(selected.length > 0);
      assert.equal(selected.map((record) => record.text).join(''), exactHydrationText(target));
      assert.ok(selected.every((record) => record.contentHash === HYDRATION_HASHES[target.path]));
    }
  });
});

test('hydration-byte cap leaves an explicit notice and permits narrower read fallback', async () => {
  await hydrationFixture(async (root) => {
    const stub = hydrationStub();
    const result = await requestEvidence({
      request: 'Locate authenticate and makeSession definitions.',
      budget: { maxSearchHydrationBytes: 1 },
    }, { projectRoot: root, transport: stub.transport });

    assert.equal(stub.invocation, 3);
    assert.equal(result.status, 'complete', JSON.stringify(result.missing));
    assert.equal(result.accounting.searchHydrationBytes, 0);
    assert.equal(result.accounting.searchHydrationRecords, 0);
    assert.equal(result.accounting.readRequests, 2);
    assert.ok(result.notices.some((item) => /hydration byte limit/.test(item.reason)));
    assert.deepEqual(result.records.map((record) => record.text), HYDRATION_TARGETS.map(exactHydrationText));
  });
});

test('cumulative evidence-byte budget still blocks hydration and follow-up reads', async () => {
  await hydrationFixture(async (root) => {
    const stub = hydrationStub();
    const result = await requestEvidence({
      request: 'Locate authenticate and makeSession definitions.',
      budget: { maxEvidenceBytes: 1, maxSearchHydrationBytes: 12_288, maxTransportInvocations: 3 },
    }, {
      projectRoot: root,
      config: { budget: { maxEvidenceBytes: 1, maxSearchHydrationBytes: 12_288, maxTransportInvocations: 3 } },
      transport: stub.transport,
    });

    assert.equal(stub.invocation, 3);
    assert.equal(result.status, 'partial');
    assert.equal(result.records.length, 0);
    assert.equal(result.accounting.maxEvidenceBytes, 1);
    assert.equal(result.accounting.evidenceBytes, 0);
    assert.equal(result.accounting.searchHydrationBytes, 0);
    assert.ok(result.missing.some((item) => /Cumulative evidence byte budget reached/.test(item.reason)));
  });
});

test('broker treats a read ending past EOF as a notice and delivers only the actual ranges', async () => {
  await hydrationFixture(async (root) => {
    let invocation = 0;
    const result = await requestEvidence({
      request: 'Read the two known function files and select their definitions.',
      knownPaths: Object.keys(HYDRATION_SOURCES),
    }, {
      projectRoot: root,
      transport: async (context) => {
        invocation += 1;
        if (invocation === 1) {
          return { calls: [{ id: 'read-all-1', name: 'read', args: { requests: Object.keys(HYDRATION_SOURCES).map((filePath) => ({
            path: filePath,
            ranges: [[1, 60]],
          })) } }] };
        }
        const read = context.toolResults[0].result;
        assert.equal(read.status, 'complete');
        assert.equal(read.records.length, 2);
        assert.equal(read.notices.length, 2);
        const references = HYDRATION_TARGETS.map((target) => {
          const record = read.records.find((candidate) => candidate.path === target.path
            && candidate.ranges.some((range) => range.start <= target.start && range.end >= target.end));
          assert.ok(record, `expected actual range to cover ${target.path}`);
          return { ...reference(record), ranges: [{ start: target.start, end: target.end }] };
        });
        return { calls: [{ id: 'select-2', name: 'select', args: { references } }] };
      },
    });

    assert.equal(invocation, 2, 'selection ends the workflow without an unnecessary follow-up call');
    assert.equal(result.status, 'complete');
    assert.equal(result.missing.length, 0);
    assert.equal(result.records.length, 2);
    assert.equal(result.notices.length, 2);
    assert.deepEqual(result.records.map((record) => record.text), HYDRATION_TARGETS.map(exactHydrationText));
  });
});

test('broker keeps a read starting beyond EOF as a real missing range', async () => {
  await hydrationFixture(async (root) => {
    let invocation = 0;
    const result = await requestEvidence({
      request: 'Try to read lines past EOF from the known source files.',
      knownPaths: Object.keys(HYDRATION_SOURCES),
    }, {
      projectRoot: root,
      transport: async (context) => {
        invocation += 1;
        if (invocation === 1) {
          return { calls: [{ id: 'read-past-eof-1', name: 'read', args: { requests: Object.keys(HYDRATION_SOURCES).map((filePath) => ({
            path: filePath,
            ranges: [[60, 80]],
          })) } }] };
        }
        const read = context.toolResults[0].result;
        assert.equal(read.records.length, 0);
        assert.equal(read.missing.length, 2);
        assert.equal(read.notices?.length || 0, 0);
        return { calls: [{ id: 'select-past-eof-2', name: 'select', args: { references: [], missing: read.missing } }] };
      },
    });

    assert.equal(invocation, 2);
    assert.equal(result.status, 'partial');
    assert.ok(result.missing.some((item) => /outside the 7-line file/.test(item.reason)));
    assert.ok(result.missing.some((item) => /outside the 6-line file/.test(item.reason)));
  });
});

test('selected subranges preserve intake and delivery byte/character accounting after line-one hydration', async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = 'line1\nline2\nline3\nline4\n';
  fs.writeFileSync(path.join(root, 'src', 'login.mjs'), source);
  let invocation = 0;

  const result = await requestEvidence({ request: 'Select only the second line.' }, {
    projectRoot: root,
    transport: async (call) => {
      invocation += 1;
      if (invocation === 1) return { calls: [{ id: 's1', name: 'search', args: { queries: ['line1'] } }] };
      if (invocation === 2) {
        const original = call.toolResults[0].result.records[0];
        return { calls: [{ id: 'sel1', name: 'select', args: {
          references: [{ ...reference(original), ranges: [{ start: 2, end: 2 }] }],
        } }] };
      }
      throw new Error('The exact subrange should be selectable in the second turn.');
    },
  });

  assert.equal(invocation, 2);
  assert.equal(result.status, 'complete');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].text, 'line2\n');
  assert.equal(result.records[0].sourceEvidenceId, result.selection.references[0].id);
  assert.notEqual(result.records[0].id, result.selection.references[0].id);
  assert.equal(result.accounting.evidenceBytes, Buffer.byteLength(source, 'utf8'));
  assert.equal(result.accounting.evidenceChars, Array.from(source).length);
  assert.equal(result.accounting.materializedEvidenceBytes, Buffer.byteLength('line2\n', 'utf8'));
  assert.equal(result.accounting.materializedEvidenceChars, Array.from('line2\n').length);
  assert.equal(result.accounting.renderedSourceBytes, null);
  assert.equal(result.accounting.renderedSourceChars, null);
});

test('cumulative read and evidence-byte budgets return partial records with exact gaps', async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'src', 'login.mjs'), 'ab\ncd\n');
  let invocation = 0;

  const result = await requestEvidence({ request: 'Find and cite the login lines.' }, {
    projectRoot: root,
    config: { budget: { maxReadRequests: 1, maxEvidenceBytes: 2 } },
    transport: async (call) => {
      invocation += 1;
      if (invocation === 1) return { calls: [{ id: 's1', name: 'search', args: { queries: ['ab'] } }] };
      if (invocation === 2) {
        const hit = call.toolResults[0].result.results[0];
        return { calls: [{ id: 'r1', name: 'read', args: { requests: [
          { path: hit.path, ranges: [[1, 1]], contentHash: hit.contentHash },
          { path: hit.path, ranges: [[2, 2]], contentHash: hit.contentHash },
        ] } }] };
      }
      const read = call.toolResults[0].result;
      assert.equal(read.records.length, 0);
      return { calls: [{ id: 'sel1', name: 'select', args: {
        references: [],
        summary: 'No full source range fit the configured budget.',
        missing: read.missing.map((item) => item.reason),
      } }] };
    },
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.records.length, 0, 'a range over the cumulative byte budget is withheld whole');
  assert.ok(result.missing.some((item) => /byte budget reached/.test(item.reason)));
  assert.ok(result.missing.some((item) => /Cumulative read request budget reached/.test(item.reason)));
  assert.equal(result.accounting.maxEvidenceBytes, 2);
  assert.equal(result.accounting.evidenceBytes, 0);
  assert.equal(result.accounting.readRequests, 1);
  assert.equal(result.accounting.maxReadRequests, 1);
});

test('a file changed after model selection becomes partial and stale text is withheld', async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'src', 'login.mjs');
  let invocation = 0;

  const result = await requestEvidence({ request: 'Find and cite the login function.' }, {
    projectRoot: root,
    transport: async (call) => {
      invocation += 1;
      if (invocation === 1) {
        return { calls: [{ id: 's1', name: 'search', args: { queries: ['login'] } }] };
      }
      if (invocation === 2) {
        const selected = call.toolResults[0].result.records[0];
        fs.writeFileSync(sourcePath, 'export function login() { return "changed"; }\n');
        return { calls: [{ id: 'sel1', name: 'select', args: { references: [reference(selected)] } }] };
      }
      throw new Error('The fixture should select directly from the bounded search record.');
    },
  });

  assert.equal(invocation, 2);
  assert.equal(result.status, 'partial');
  assert.equal(result.records.length, 0, 'the newer source is not substituted under the old citation');
  assert.equal(result.missing.some((item) => /changed after selection/.test(item.reason)), true);
  assert.ok(result.missing.some((item) => item.expectedContentHash && item.currentContentHash));
});

test('citation ids and tool names are validated; arbitrary tools never execute', async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const forged = await requestEvidence({ request: 'Find source.' }, {
    projectRoot: root,
    transport: async () => ({ selection: { references: [{
      id: 'invented', path: 'src/login.mjs', contentHash: 'not-a-hash', ranges: [{ start: 1, end: 1 }],
    }] } }),
  });
  assert.equal(forged.status, 'partial');
  assert.equal(forged.records.length, 0);
  assert.match(forged.missing.at(-1).reason, /subset of ranges returned/);

  const unsupported = await requestEvidence({ request: 'Run something.' }, {
    projectRoot: root,
    transport: async () => ({ calls: [{ id: 'bad1', name: 'run', args: { command: 'touch should-not-run' } }] }),
    config: { budget: { maxTransportInvocations: 1 } },
  });
  assert.equal(unsupported.status, 'partial');
  assert.ok(unsupported.missing.some((item) => /was not offered in this round/.test(item.reason)));
  assert.equal(unsupported.accounting.usage, null);
});

test('content result caps apply per query while cumulative search accounting and read/select remain intact', async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'src', 'login.mjs'), [
    'export const marker = 1;',
    'const separator = true;',
    'export const marker = 2;',
    '',
  ].join('\n'));
  let invocation = 0;
  let discoveredRecord;

  const result = await requestEvidence({ request: 'Return both marker definitions.' }, {
    projectRoot: root,
    config: { budget: {
      maxSearchResults: 1,
      maxSearchBytes: 4096,
      maxSearchHydrationHits: 1,
      searchHydrationWindowLines: 1,
      maxTransportInvocations: 3,
    } },
    transport: async (context) => {
      invocation += 1;
      const names = context.tools.map((tool) => tool.function.name);
      if (invocation === 1) {
        assert.deepEqual(names, ['search', 'read', 'select']);
        return { calls: [
          { id: 'bounded-broad-search', name: 'search', args: {
            queries: ['export const marker'], paths: ['src/login.mjs'], limit: 1,
          } },
          { id: 'fresh-query-cap', name: 'search', args: {
            queries: ['export const marker = 2'], paths: ['src/login.mjs'], limit: 1,
          } },
        ] };
      }
      if (invocation === 2) {
        assert.deepEqual(names, ['search', 'read', 'select'], 'a per-query result cap does not disable the next content search');
        assert.deepEqual(context.tools[0].function.parameters.properties.mode.enum, ['content', 'paths']);
        assert.match(context.turnControl, /offeredSearchModes=content,paths/);
        assert.match(context.turnControl, /maxContentResultsPerSearch=1/);
        assert.match(context.turnControl, /remainingSearchBytes=[1-9]\d*/);
        assert.match(context.turnControl, /totalSearchResults=2/);
        assert.equal(context.toolResults.length, 2);
        const broadSearch = context.toolResults[0].result;
        assert.ok(broadSearch.missing.some((item) => /first 1 of 2/.test(item.reason)));
        discoveredRecord = broadSearch.records.find((record) => record.text.includes('marker = 1'));
        assert.ok(discoveredRecord);
        const exactSearch = context.toolResults[1].result;
        assert.equal(exactSearch.status, 'complete');
        const targetHit = exactSearch.results.find((record) => record.line === 3);
        assert.ok(targetHit);
        return { calls: [{ id: 'read-second-marker', name: 'read', args: { requests: [{
          path: targetHit.path, ranges: [[targetHit.line, targetHit.line]], contentHash: targetHit.contentHash,
        }] } }] };
      }
      assert.deepEqual(names, ['select'], 'the final provider round is reserved for citation selection');
      assert.match(context.turnControl, /remainingInvocations=0/);
      assert.match(context.turnControl, /offeredTools=select/);
      const read = context.toolResults.at(-1).result;
      const second = read.records.find((record) => record.path === 'src/login.mjs');
      assert.ok(second);
      return { calls: [{ id: 'select-both-markers', name: 'select', args: { references: [
        reference(discoveredRecord), reference(second),
      ] } }] };
    },
  });

  assert.equal(invocation, 3);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.missing, []);
  assert.ok(result.notices.some((item) => /first 1 of 2/.test(item.reason)));
  assert.deepEqual(result.records.map((record) => record.text), ['export const marker = 1;\n', 'export const marker = 2;\n']);
  assert.equal(result.accounting.maxSearchResults, 1);
  assert.equal(result.accounting.searchResults, 2, 'cumulative accounting is retained across per-query caps');
  assert.ok(result.accounting.searchBytes < result.accounting.maxSearchBytes);
});

test('bounded path discovery remains available alongside content after a per-query result cap', async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src', 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'main.mjs'), 'export const searchTrigger = true;\n');
  for (let index = 0; index < 12; index += 1) {
    fs.writeFileSync(path.join(root, 'src', 'tests', `case-${String(index).padStart(2, '0')}.test.mjs`), `export const case${index} = ${index};\n`);
  }
  const selectedPath = 'src/tests/zz-late.test.mjs';
  fs.writeFileSync(path.join(root, selectedPath), 'export const lateCase = true;\n');
  let invocation = 0;
  const result = await requestEvidence({ request: 'Find the late test fixture and return its exact source.' }, {
    projectRoot: root,
    config: { budget: { maxSearchResults: 1, maxSearchBytes: 4096, maxTransportInvocations: 5 } },
    transport: async (context) => {
      invocation += 1;
      assert.match(context.turnControl, new RegExp(`remainingInvocations=${5 - invocation}`));
      if (invocation === 1) return { calls: [{ id: 'fill-content-results', name: 'search', args: {
        mode: 'content', queries: ['searchTrigger'], paths: ['src/main.mjs'],
      } }] };
      if (invocation === 2 || invocation === 3) {
        assert.deepEqual(context.tools[0].function.parameters.properties.mode.enum, ['content', 'paths']);
        assert.match(context.turnControl, /offeredSearchModes=content,paths/);
        assert.match(context.turnControl, /maxContentResultsPerSearch=1/);
        assert.match(context.turnControl, /remainingSearchBytes=[1-9]\d*/);
        const cursor = invocation === 3 ? context.toolResults.at(-1).result.nextCursor : undefined;
        return { calls: [{ id: `path-page-${invocation}`, name: 'search', args: {
          mode: 'paths', queries: ['.test.mjs'], paths: ['src/tests'], limit: 12, ...(cursor !== undefined ? { cursor } : {}),
        } }] };
      }
      if (invocation === 4) {
        const pathsResult = context.toolResults.at(-1).result;
        assert.deepEqual(pathsResult.paths, [selectedPath]);
        assert.equal(pathsResult.mode, 'paths');
        assert.ok(!JSON.stringify(pathsResult).includes('lateCase'));
        return { calls: [{ id: 'read-discovered-test', name: 'read', args: { requests: [{ path: selectedPath, ranges: [[1, 1]] }] } }] };
      }
      assert.deepEqual(context.tools.map((tool) => tool.function.name), ['select']);
      assert.match(context.turnControl, /remainingInvocations=0/);
      const record = context.toolResults.at(-1).result.records[0];
      return { calls: [{ id: 'select-discovered-test', name: 'select', args: { references: [reference(record)] } }] };
    },
  });

  assert.equal(invocation, 5);
  assert.equal(result.status, 'complete');
  assert.equal(result.records[0].path, selectedPath);
  assert.equal(result.records[0].text, 'export const lateCase = true;\n');
  assert.equal(result.accounting.searchPaths, 13);
  assert.equal(result.accounting.searchResults, 1);
  assert.ok(result.accounting.searchBytes <= result.accounting.maxSearchBytes);
  assert.ok(result.notices.some((notice) => /bounded page/.test(notice.reason)));
});

test('final round rejects an unoffered read instead of executing it or declaring completion', async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = [];
  let invocation = 0;
  const result = await requestEvidence({ request: 'Return the login source.' }, {
    projectRoot: root,
    config: { budget: { maxTransportInvocations: 2 } },
    onTrace: (event) => events.push(event),
    transport: async (context) => {
      invocation += 1;
      if (invocation === 1) return { calls: [{ id: 'search-first', name: 'search', args: { queries: ['export function login'] } }] };
      assert.deepEqual(context.tools.map((tool) => tool.function.name), ['select']);
      assert.match(context.turnControl, /remainingInvocations=0/);
      assert.match(context.turnControl, /offeredTools=select/);
      return { calls: [{ id: 'read-on-final-round', name: 'read', args: { requests: [{ path: 'src/login.mjs', ranges: [[1, 1]] }] } }] };
    },
  });

  assert.equal(invocation, 2);
  assert.equal(result.status, 'partial');
  assert.equal(result.accounting.readRequests, 0);
  assert.ok(result.missing.some((item) => /not offered in this round/.test(item.reason)));
  assert.equal(events.find((event) => event.kind === 'tool' && event.name === 'read')?.failureCategory, 'tool_not_offered');
});

test('the shared byte budget stops further searches but leaves read and final select available', async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'src', 'login.mjs'), 'export function login() { return "session"; }\n');
  const expected = await searchWorkspace({ projectRoot: root, queries: ['export function login'], paths: ['src/login.mjs'], limit: 1 });
  assert.equal(expected.results.length, 1);
  const maxSearchBytes = Buffer.byteLength(JSON.stringify(expected.results[0]), 'utf8');
  let invocation = 0;
  const result = await requestEvidence({ request: 'Find the login definition.' }, {
    projectRoot: root,
    config: { budget: { maxSearchResults: 1, maxSearchBytes, maxTransportInvocations: 3 } },
    transport: async (context) => {
      invocation += 1;
      if (invocation === 1) {
        assert.match(context.turnControl, /remainingSearchBytes=[1-9]\d*/);
        return { calls: [
          { id: 'consume-search-bytes', name: 'search', args: { queries: ['export function login'], paths: ['src/login.mjs'] } },
          { id: 'search-after-byte-cap', name: 'search', args: { queries: ['export function login'], paths: ['src/login.mjs'] } },
        ] };
      }
      if (invocation === 2) {
        assert.deepEqual(context.tools.map((tool) => tool.function.name), ['read', 'select']);
        assert.match(context.turnControl, /remainingSearchBytes=0/);
        assert.match(context.toolResults[1].result.missing[0].reason, /Search byte budget was exhausted/);
        return { calls: [{ id: 'read-login', name: 'read', args: { requests: [{ path: 'src/login.mjs', ranges: [[1, 1]] }] } }] };
      }
      assert.deepEqual(context.tools.map((tool) => tool.function.name), ['select']);
      const readResult = context.toolResults.at(-1).result;
      const record = readResult.records[0] || readResult.alreadyCovered?.[0];
      assert.ok(record?.ref);
      return { calls: [{ id: 'select-login', name: 'select', args: { refs: [record.ref] } }] };
    },
  });

  assert.equal(invocation, 3);
  assert.equal(result.status, 'complete');
  assert.equal(result.records[0].text, 'export function login() { return "session"; }\n');
  assert.equal(result.accounting.searchResults, 1);
  assert.equal(result.accounting.searchBytes, maxSearchBytes);
  assert.equal(result.accounting.maxSearchBytes, maxSearchBytes);
  assert.ok(result.notices.some((item) => /Search byte budget was exhausted/.test(item.reason)));
});

test('a later precise content query can discover a relevant hit after the first query returned 48 results', async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lines = Array.from({ length: 49 }, (_, index) => `export const needle${index + 1} = ${index + 1};`);
  lines.push('export const targetNeedle = "needle";');
  fs.writeFileSync(path.join(root, 'src', 'matches.mjs'), `${lines.join('\n')}\n`);
  let invocation = 0;
  let targetHit;
  const result = await requestEvidence({ request: 'Locate the targetNeedle definition after broad matches.' }, {
    projectRoot: root,
    config: { budget: { maxSearchResults: 48, maxSearchBytes: 24576, maxTransportInvocations: 4 } },
    transport: async (context) => {
      invocation += 1;
      if (invocation === 1) {
        return { calls: [{ id: 'first-48-matches', name: 'search', args: {
          queries: ['needle'], paths: ['src/matches.mjs'], limit: 100,
        } }] };
      }
      if (invocation === 2) {
        assert.deepEqual(context.tools[0].function.parameters.properties.mode.enum, ['content', 'paths']);
        assert.match(context.turnControl, /maxContentResultsPerSearch=48/);
        assert.match(context.turnControl, /totalSearchResults=48/);
        assert.match(context.turnControl, /remainingSearchBytes=[1-9]\d*/);
        const prior = context.toolResults.at(-1).result;
        assert.equal(prior.results.length, 48);
        assert.ok(prior.missing.some((item) => /first 48 of 50/.test(item.reason)));
        return { calls: [{ id: 'precise-target-search', name: 'search', args: {
          queries: ['targetNeedle'], paths: ['src/matches.mjs'], limit: 48,
        } }] };
      }
      if (invocation === 3) {
        assert.match(context.turnControl, /maxContentResultsPerSearch=48/);
        assert.match(context.turnControl, /totalSearchResults=49/);
        const search = context.toolResults.at(-1).result;
        assert.equal(search.results.length, 1);
        targetHit = search.results[0];
        assert.equal(targetHit.line, 50);
        return { calls: [{ id: 'read-target-line', name: 'read', args: { requests: [{
          path: targetHit.path, ranges: [[targetHit.line, targetHit.line]], contentHash: targetHit.contentHash,
        }] } }] };
      }
      assert.deepEqual(context.tools.map((tool) => tool.function.name), ['select']);
      const record = context.toolResults.at(-1).result.records[0];
      return { calls: [{ id: 'select-target-line', name: 'select', args: { refs: [record.ref] } }] };
    },
  });

  assert.equal(invocation, 4);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.missing, []);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].path, 'src/matches.mjs');
  assert.equal(result.records[0].ranges[0].start, 50);
  assert.equal(result.records[0].text, 'export const targetNeedle = "needle";\n');
  assert.equal(result.accounting.maxSearchResults, 48);
  assert.equal(result.accounting.searchResults, 49);
  assert.ok(result.accounting.searchBytes < result.accounting.maxSearchBytes);
  assert.ok(targetHit);
});

test('search no-match is a notice while explicit select.missing remains a real partial gap', async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let invocation = 0;
  const result = await requestEvidence({ request: 'Find a marker declaration.' }, {
    projectRoot: root,
    transport: async () => {
      invocation += 1;
      if (invocation === 1) return { calls: [{ id: 'no-hit', name: 'search', args: { queries: ['not-present'] } }] };
      return { calls: [{ id: 'select-gap', name: 'select', args: {
        references: [], missing: [{ path: 'src/config.mjs', reason: 'Need the configuration declaration.' }],
      } }] };
    },
  });

  assert.equal(result.status, 'partial');
  assert.ok(result.notices.some((item) => /No matching source lines/.test(item.reason)));
  assert.ok(result.missing.some((item) => /Need the configuration declaration/.test(item.reason)));
  assert.ok(!result.missing.some((item) => /No matching source lines/.test(item.reason)));
});

test('a non-object selection cannot be recorded as completed and emits only typed shape diagnostics', async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = [];
  const result = await requestEvidence({ request: 'Select verified source.' }, {
    projectRoot: root,
    onTrace: (event) => events.push(event),
    transport: async () => ({ calls: [{ id: 'bad-select-shape', name: 'select', args: '[]' }] }),
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.records.length, 0);
  assert.ok(result.missing.some((item) => /Selection arguments must be a JSON object/.test(item.reason)));
  const toolEvent = events.find((event) => event.kind === 'tool' && event.name === 'select');
  assert.equal(toolEvent.status, 'failed');
  assert.equal(toolEvent.argsShape, 'json_array');
  assert.equal(toolEvent.failureCategory, 'arguments_not_object');
  const finalEvent = events.find((event) => event.kind === 'selection');
  assert.equal(finalEvent.status, 'partial');
  assert.equal(finalEvent.failureCategory, 'arguments_not_object');
});
