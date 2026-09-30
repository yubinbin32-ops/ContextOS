import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requestContextOS, renderRequestResult, recordEvidenceDelivery } from '../src/request-service.mjs';
import { requestEvidence } from '../src/micro-broker.mjs';
import { appendRoleUsage } from '../src/role-usage-ledger.mjs';

const workspace = () => fs.mkdtempSync(path.join(os.tmpdir(), 'os-request-service-'));

async function markRawEvidenceDelivered(root, result) {
  const receipt = await recordEvidenceDelivery(root, result.resultId, result.records || []);
  assert.equal(receipt.recorded, true);
}

async function runAuditFixture(root, profile) {
  const source = "export function marker() {\n  return 'AUDIT_SOURCE_NEEDLE';\n}\n";
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'marker.mjs'), source);
  let calls = 0;
  const result = await requestContextOS('ask', {
    taskId: 'private-task-identifier',
    request: 'private-query-phrase return the marker source',
    known: { notes: 'private-note-phrase from the main request' },
  }, {
    projectRoot: root, profile, broker: requestEvidence,
    transport: async (context) => {
      calls += 1;
      const receipt = { model: 'trace-model', usage: { input_tokens: calls * 10, output_tokens: 2, cached_input_tokens: 1 } };
      if (calls === 1) return { ...receipt, calls: [{ id: 'audit-search', name: 'search', args: { queries: ['AUDIT_SOURCE_NEEDLE'] } }] };
      if (calls === 2) {
        const search = context.toolResults.at(-1).result;
        return { ...receipt, calls: [{ id: 'audit-read', name: 'read', args: { requests: [{
          path: 'src/marker.mjs', ranges: [[1, 3]], contentHash: search.results[0].contentHash,
        }] } }] };
      }
      const read = context.toolResults.at(-1).result;
      return { ...receipt, calls: [{ id: 'audit-select', name: 'select', args: { references: [
        ...(read.alreadyCovered || []), ...(read.records || []).map((record) => ({
          id: record.id, path: record.path, contentHash: record.contentHash, ranges: record.ranges,
        })),
      ] } }] };
    },
  });
  return { result, source };
}

function orderedRecordText(records) {
  return records.slice().sort((left, right) => (left.ranges?.[0]?.start ?? 0) - (right.ranges?.[0]?.start ?? 0))
    .map((record) => record.text).join('');
}

test('provider failure keeps its code and observed usage through broker persistence and recovery', async () => {
  const root = workspace(); const rows = [];
  try {
    const usage = { input_tokens: 10, output_tokens: 3 };
    const result = await requestContextOS('ask', { request: 'Find validation' }, {
      projectRoot: root, profile: {}, onUsage: row => rows.push(row),
      transport: async () => ({ ok: false, errorCode: 'API_ERROR', error: 'Provider rejected the request', model: 'observed-model', usage, invocation: { providerLaunches: 1 } }),
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'API_ERROR');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].usage, usage);
    assert.equal(result.accounting.providerResponses[0].model, 'observed-model');
    assert.deepEqual(result.accounting.providerResponses[0].usage, usage);
    assert.equal(result.accounting.usageStatus, 'reported');
    assert.match(renderRequestResult(result), /error=API_ERROR/);
    const bounded = renderRequestResult({ ...result, summary: 'x'.repeat(500) }, { maxChars: 256 });
    assert.match(bounded, /^status=failed/);
    assert.match(bounded, /error=API_ERROR/);
    const replay = await requestContextOS('ask', { resultId: result.resultId }, { projectRoot: root, profile: {} });
    assert.equal(replay.errorCode, 'API_ERROR');
    assert.deepEqual(replay.accounting.providerResponses[0].usage, usage);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('private API state never enters the host response and each request is metered', async () => {
  const root = workspace(); const rows = [];
  try {
    const result = await requestContextOS('ask', { request: 'find' }, {
      projectRoot: root, profile: {}, transport: async () => ({ model: 'cheap', usage: { input_tokens: 10, output_tokens: 3 }, state: 'private history' }),
      onUsage: (row) => rows.push(row), broker: async (_args, opts) => {
        const micro = await opts.transport({ input: 'small task' });
        return { status: 'completed', summary: 'located', records: [], micro, state: 'private broker history', reasoning: 'private thought' };
      },
    });
    assert.equal(rows.length, 1); assert.equal(rows[0].role, 'api-micro');
    assert.equal(rows[0].usage.input_tokens, 10);
    assert.ok(!JSON.stringify(result).includes('private'));
    assert.match(result.resultId, /^result-/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('artifact recovery needs no model or source exploration and rejects changed evidence', async () => {
  const root = workspace(); let requests = 0;
  try {
    fs.writeFileSync(path.join(root, 'a.mjs'), 'export const a=1;\n');
    const opts = { projectRoot: root, profile: {}, broker: async (args, options) => { requests++; return requestEvidence(args, { projectRoot: options.projectRoot }); } };
    const first = await requestContextOS('ask', { inspect: [{ path: 'a.mjs' }] }, opts);
    const replay = await requestContextOS('ask', { resultId: first.resultId }, opts);
    assert.equal(requests, 1); assert.equal(replay.records[0].text, first.records[0].text);
    fs.writeFileSync(path.join(root, 'a.mjs'), 'export const a=2;\n');
    const stale = await requestContextOS('ask', { resultId: first.resultId }, opts);
    assert.equal(stale.status, 'partial'); assert.deepEqual(stale.records, []);
    assert.match(stale.missing[0].reason, /changed after selection/); assert.equal(requests, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('known artifact refs preload verified proof as metadata without placing caller source text in Micro input', async () => {
  const root = workspace(); let calls = 0; let seen;
  try {
    const source = 'export function verify(input) {\n  return Boolean(input);\n}\n';
    fs.writeFileSync(path.join(root, 'verify.mjs'), source);
    const first = await requestContextOS('ask', { inspect: [{ path: 'verify.mjs', ranges: [[1, 3]] }] }, {
      projectRoot: root, profile: {}, broker: requestEvidence,
    });
    await markRawEvidenceDelivered(root, first);
    const original = first.records[0];
    const result = await requestContextOS('ask', {
      request: 'Return the previously inspected verification function.',
      futureOption: { accepted: true },
      known: {
        notes: 'The main request already inspected this function.',
        refs: [{ resultId: first.resultId }],
      },
    }, {
      projectRoot: root, profile: {}, broker: requestEvidence,
      transport: async (context) => {
        calls += 1;
        seen = JSON.parse(context.input);
        const ref = seen.known.references[0];
        return { selection: { references: [{ id: ref.id, path: ref.path, contentHash: ref.contentHash, ranges: ref.ranges }] } };
      },
    });
    assert.equal(calls, 1);
    assert.equal(seen.known.notes[0], 'The main request already inspected this function.');
    assert.equal(seen.known.references.length, 1);
    assert.equal(seen.known.references[0].path, 'verify.mjs');
    assert.ok(!JSON.stringify(seen).includes(source));
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.records, []);
    assert.deepEqual(result.reused, [{ resultId: first.resultId, id: original.id, path: original.path,
      contentHash: original.contentHash, ranges: [{ start: 1, end: 3 }] }]);

    const subset = await requestContextOS('ask', {
      request: 'Reuse only lines two and three from the stored artifact.',
      known: { refs: [{ resultId: first.resultId, path: 'verify.mjs', ranges: [[2, 3]] }] },
    }, {
      projectRoot: root, profile: {}, broker: requestEvidence,
      transport: async (context) => {
        const reference = JSON.parse(context.input).known.references[0];
        return { selection: { references: [reference] } };
      },
    });
    assert.equal(subset.status, 'completed');
    assert.deepEqual(subset.records, []);
    assert.deepEqual(subset.reused, [{ resultId: first.resultId, id: original.id, path: original.path,
      contentHash: original.contentHash, ranges: [{ start: 2, end: 3 }] }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a latest artifact inherits bounded reused proof for known selection and explicit range recovery', async () => {
  const root = workspace();
  try {
    const source = 'line one\nline two\nline three\nline four\n';
    fs.writeFileSync(path.join(root, 'flow.mjs'), source);
    const first = await requestContextOS('ask', { inspect: [{ path: 'flow.mjs', ranges: [[1, 2]] }] }, {
      projectRoot: root, profile: {}, broker: requestEvidence,
    });
    await markRawEvidenceDelivered(root, first);
    let calls = 0;
    const second = await requestContextOS('ask', {
      request: 'Return lines one through four.', known: { refs: [{ resultId: first.resultId }] },
    }, {
      projectRoot: root, profile: {}, broker: requestEvidence,
      transport: async (context) => {
        calls += 1;
        if (calls === 1) {
          const reference = JSON.parse(context.input).known.references[0];
          return { calls: [{ id: 'chain-gap-read', name: 'read', args: { requests: [{
            path: 'flow.mjs', ranges: [[1, 4]], contentHash: reference.contentHash,
          }] } }] };
        }
        const read = context.toolResults.at(-1).result;
        return { calls: [{ id: 'chain-gap-select', name: 'select', args: { references: [
          ...(read.alreadyCovered || []), ...(read.records || []).map((record) => ({
            id: record.id, path: record.path, contentHash: record.contentHash, ranges: record.ranges,
          })),
        ] } }] };
      },
    });
    assert.equal(calls, 2);
    assert.equal(second.status, 'completed');
    assert.equal(orderedRecordText(second.records), 'line three\nline four\n');
    assert.deepEqual(second.reused.map(({ resultId, path, ranges }) => ({ resultId, path, ranges })), [{
      resultId: first.resultId, path: 'flow.mjs', ranges: [{ start: 1, end: 2 }],
    }]);
    await markRawEvidenceDelivered(root, second);

    let reuseInput;
    const latest = await requestContextOS('ask', {
      request: 'Reuse all available flow source.', known: { refs: [{ resultId: second.resultId }] },
    }, {
      projectRoot: root, profile: {}, broker: requestEvidence,
      transport: async (context) => {
        reuseInput = JSON.parse(context.input).known.references;
        return { selection: { references: reuseInput } };
      },
    });
    assert.equal(latest.status, 'completed');
    assert.deepEqual(latest.records, []);
    assert.deepEqual(new Set(latest.reused.map((item) => item.resultId)), new Set([first.resultId, second.resultId]));
    assert.equal(reuseInput.length, 2);

    const recovered = await requestContextOS('ask', { resultId: second.resultId, inspect: [
      { path: 'flow.mjs', ranges: [[1, 4]] },
    ] }, { projectRoot: root, profile: {} });
    assert.equal(recovered.status, 'completed');
    assert.equal(orderedRecordText(recovered.records), source);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('reused evidence cycles fail before transport instead of hiding a broken artifact link', async () => {
  const root = workspace(); let calls = 0;
  try {
    fs.writeFileSync(path.join(root, 'a.mjs'), 'one\n');
    const first = await requestContextOS('ask', { inspect: [{ path: 'a.mjs', ranges: [[1, 1]] }] }, {
      projectRoot: root, profile: {}, broker: requestEvidence,
    });
    const artifact = path.join(root, '.contextos', 'request-results', `${first.resultId}.json`);
    const stored = JSON.parse(fs.readFileSync(artifact, 'utf8'));
    const record = first.records[0];
    stored.reused = [{ resultId: first.resultId, id: record.id, path: record.path,
      contentHash: record.contentHash, ranges: record.ranges }];
    fs.writeFileSync(artifact, JSON.stringify(stored));

    const result = await requestContextOS('ask', { request: 'reuse the stored source', known: { refs: [{ resultId: first.resultId }] } }, {
      projectRoot: root, profile: {}, transport: async () => { calls += 1; return {}; },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'EVIDENCE_REUSE_CYCLE');
    assert.match(result.missing[0].reason, /cycle detected/);
    assert.equal(calls, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('malformed known evidence fails before transport while unrelated outer arguments stay compatible', async () => {
  const root = workspace(); let calls = 0; let brokerCalls = 0;
  try {
    const invalid = await requestContextOS('ask', { request: 'find source', known: { sourceText: 'forged source' } }, {
      projectRoot: root, profile: {}, broker: requestEvidence,
      transport: async () => { calls += 1; return {}; },
    });
    assert.equal(invalid.status, 'failed');
    assert.equal(invalid.errorCode, 'INVALID_KNOWN_CONTEXT');
    assert.match(invalid.missing[0].reason, /source text and unknown fields are not evidence/);
    assert.equal(calls, 0);

    const forwardCompatible = await requestContextOS('ask', { request: 'find source', futureOption: { flag: true } }, {
      projectRoot: root, profile: {}, broker: async (args) => {
        brokerCalls += 1;
        assert.deepEqual(args.futureOption, { flag: true });
        return { status: 'complete', records: [] };
      },
    });
    assert.equal(brokerCalls, 1);
    assert.equal(forwardCompatible.status, 'completed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('documented known string, string-list, and paths forms stay hints rather than evidence', async () => {
  const root = workspace(); const received = [];
  try {
    const broker = async (_args, { knownContext }) => {
      received.push(knownContext);
      return { status: 'complete', records: [] };
    };
    await requestContextOS('ask', { request: 'find the related source', known: 'I already inspected this area.' }, {
      projectRoot: root, profile: {}, broker,
    });
    await requestContextOS('ask', { request: 'find the related source', known: ['already read the caller', 'need the callee'] }, {
      projectRoot: root, profile: {}, broker,
    });
    await requestContextOS('ask', { request: 'find the related source', known: { paths: ['src/caller.mjs'] } }, {
      projectRoot: root, profile: {}, broker,
    });
    assert.deepEqual(received[0].notes, ['I already inspected this area.']);
    assert.deepEqual(received[0].records, []);
    assert.deepEqual(received[1].notes, ['already read the caller', 'need the callee']);
    assert.deepEqual(received[1].records, []);
    assert.deepEqual(received[2].paths, ['src/caller.mjs']);
    assert.deepEqual(received[2].records, []);

    let invalidBrokerCalls = 0;
    const invalid = await requestContextOS('ask', { request: 'find source', known: { paths: ['../outside.mjs'] } }, {
      projectRoot: root, profile: {}, broker: async () => { invalidBrokerCalls += 1; return { status: 'complete', records: [] }; },
    });
    assert.equal(invalid.status, 'failed');
    assert.equal(invalid.errorCode, 'EVIDENCE_UNSAFE_PATH');
    assert.equal(invalidBrokerCalls, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('stale known artifact refs are not reused and a fresh hash is delivered from the current workspace', async () => {
  const root = workspace(); let calls = 0; let staleNotice;
  try {
    const oldText = 'export function verify(value) { return value === "old"; }\n';
    const currentText = 'export function verify(value) { return value === "current"; }\n';
    fs.writeFileSync(path.join(root, 'verify.mjs'), oldText);
    const first = await requestContextOS('ask', { inspect: [{ path: 'verify.mjs', ranges: [[1, 1]] }] }, {
      projectRoot: root, profile: {}, broker: requestEvidence,
    });
    await markRawEvidenceDelivered(root, first);
    const oldHash = first.records[0].contentHash;
    fs.writeFileSync(path.join(root, 'verify.mjs'), currentText);

    const result = await requestContextOS('ask', {
      request: 'Return the current verification function.',
      known: { refs: [{ resultId: first.resultId, path: 'verify.mjs' }] },
    }, {
      projectRoot: root, profile: {}, broker: requestEvidence,
      transport: async (context) => {
        calls += 1;
        if (calls === 1) {
          const input = JSON.parse(context.input);
          staleNotice = input.known.unavailable;
          return { calls: [{ id: 'fresh-search', name: 'search', args: { queries: ['verify'], paths: ['verify.mjs'] } }] };
        }
        const search = context.toolResults.at(-1).result;
        return { selection: { references: search.records.filter((record) => record.path === 'verify.mjs').map((record) => ({
          id: record.id, path: record.path, contentHash: record.contentHash, ranges: record.ranges,
        })) } };
      },
    });
    assert.equal(calls, 2);
    assert.ok(staleNotice.some((item) => /Known evidence is stale/.test(item.reason)));
    assert.equal(result.status, 'completed');
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].text, currentText);
    assert.notEqual(result.records[0].contentHash, oldHash);
    assert.equal(result.reused, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('range recovery merges overlap and ignores stale records on unselected paths', async () => {
  const root = workspace(); let providerCalls = 0;
  try {
    const source = 'line one\nline two\nline three\nline four\nline five\n';
    fs.writeFileSync(path.join(root, 'a.mjs'), source);
    fs.writeFileSync(path.join(root, 'b.mjs'), 'other source\n');
    const first = await requestContextOS('ask', { inspect: [
      { path: 'a.mjs', ranges: [[1, 5]] }, { path: 'b.mjs', ranges: [[1, 1]] },
    ] }, { projectRoot: root, profile: {}, broker: requestEvidence });
    fs.writeFileSync(path.join(root, 'b.mjs'), 'changed unrelated source\n');

    const recovered = await requestContextOS('ask', { resultId: first.resultId, inspect: [
      { path: 'a.mjs', ranges: [[3, 5], [1, 3]] },
      { path: 'a.mjs', ranges: [[2, 4]] },
    ] }, {
      projectRoot: root, profile: {}, transport: async () => { providerCalls += 1; return {}; },
    });
    assert.equal(providerCalls, 0);
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.records.length, 1);
    assert.deepEqual(recovered.records[0].ranges, [{ start: 1, end: 5 }]);
    assert.equal(recovered.records[0].text, source);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('range recovery returns only stored coverage and never widens beyond its artifact', async () => {
  const root = workspace();
  try {
    fs.writeFileSync(path.join(root, 'a.mjs'), 'one\ntwo\nthree\nfour\n');
    const first = await requestContextOS('ask', { inspect: [{ path: 'a.mjs', ranges: [[1, 2]] }] }, {
      projectRoot: root, profile: {}, broker: requestEvidence,
    });
    const recovered = await requestContextOS('ask', { resultId: first.resultId, recovery: { inspect: [
      { path: 'a.mjs', ranges: [[2, 4]] },
    ] } }, { projectRoot: root, profile: {} });
    assert.equal(recovered.status, 'partial');
    assert.equal(recovered.records.length, 1);
    assert.deepEqual(recovered.records[0].ranges, [{ start: 2, end: 2 }]);
    assert.equal(recovered.records[0].text, 'two\n');
    assert.ok(recovered.missing.some((item) => /lines 3-4 are outside/.test(item.reason)));

    const beyond = await requestContextOS('ask', { resultId: first.resultId, inspect: [
      { path: 'a.mjs', ranges: [[3, 4]] },
    ] }, { projectRoot: root, profile: {} });
    assert.equal(beyond.status, 'partial');
    assert.deepEqual(beyond.records, []);
    assert.ok(beyond.missing.some((item) => /outside the ranges stored/.test(item.reason)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('selected stale recovery is explicit and does not substitute current source', async () => {
  const root = workspace();
  try {
    fs.writeFileSync(path.join(root, 'a.mjs'), 'old source\n');
    const first = await requestContextOS('ask', { inspect: [{ path: 'a.mjs', ranges: [[1, 1]] }] }, {
      projectRoot: root, profile: {}, broker: requestEvidence,
    });
    fs.writeFileSync(path.join(root, 'a.mjs'), 'new source\n');
    const recovered = await requestContextOS('ask', { resultId: first.resultId, inspect: [
      { path: 'a.mjs', ranges: [[1, 1]] },
    ] }, { projectRoot: root, profile: {} });
    assert.equal(recovered.status, 'partial');
    assert.deepEqual(recovered.records, []);
    assert.ok(recovered.missing.some((item) => /changed after selection/.test(item.reason)));
    assert.ok(!JSON.stringify(recovered).includes('new source'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cross-workspace artifacts are rejected with an actionable gap before provider calls', async () => {
  const root = workspace(); const other = workspace(); let calls = 0;
  try {
    fs.writeFileSync(path.join(root, 'a.mjs'), 'one\n');
    const first = await requestContextOS('ask', { inspect: [{ path: 'a.mjs', ranges: [[1, 1]] }] }, {
      projectRoot: root, profile: {}, broker: requestEvidence,
    });
    const destination = path.join(other, '.contextos', 'request-results');
    fs.mkdirSync(destination, { recursive: true });
    fs.copyFileSync(path.join(root, '.contextos', 'request-results', `${first.resultId}.json`),
      path.join(destination, `${first.resultId}.json`));

    const recovery = await requestContextOS('ask', { resultId: first.resultId, inspect: [{ path: 'a.mjs', ranges: [[1, 1]] }] }, {
      projectRoot: other, profile: {}, transport: async () => { calls += 1; return {}; },
    });
    assert.equal(recovery.status, 'failed');
    assert.equal(recovery.errorCode, 'EVIDENCE_RESULT_WORKSPACE_MISMATCH');
    assert.match(recovery.missing[0].reason, /different or unverified workspace/);

    const known = await requestContextOS('ask', { request: 'find source', known: { refs: [{
      resultId: first.resultId, id: first.records[0].id, workspaceId: first.workspaceId,
    }] } }, { projectRoot: other, profile: {}, transport: async () => { calls += 1; return {}; } });
    assert.equal(known.status, 'failed');
    assert.equal(known.errorCode, 'EVIDENCE_RESULT_WORKSPACE_MISMATCH');
    assert.equal(calls, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); }
});

test('known references reject artifact ranges they do not prove before any provider request', async () => {
  const root = workspace(); let calls = 0;
  try {
    fs.writeFileSync(path.join(root, 'a.mjs'), 'one\ntwo\nthree\n');
    const first = await requestContextOS('ask', { inspect: [{ path: 'a.mjs', ranges: [[1, 1]] }] }, {
      projectRoot: root, profile: {}, broker: requestEvidence,
    });
    const invalid = await requestContextOS('ask', { request: 'find line three', known: { refs: [{
      resultId: first.resultId, id: first.records[0].id, ranges: [[3, 3]],
    }] } }, { projectRoot: root, profile: {}, transport: async () => { calls += 1; return {}; } });
    assert.equal(invalid.status, 'failed');
    assert.equal(invalid.errorCode, 'INVALID_KNOWN_REFERENCE_RANGE');
    assert.match(invalid.missing[0].reason, /exceed the ranges stored/);
    assert.equal(calls, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('stale known refs are disclosed to Micro and fresh search can return the current version', async () => {
  const root = workspace(); let calls = 0; let unavailable;
  try {
    fs.writeFileSync(path.join(root, 'a.mjs'), 'export const marker = "old";\n');
    const first = await requestContextOS('ask', { inspect: [{ path: 'a.mjs', ranges: [[1, 1]] }] }, {
      projectRoot: root, profile: {}, broker: requestEvidence,
    });
    await markRawEvidenceDelivered(root, first);
    fs.writeFileSync(path.join(root, 'a.mjs'), 'export const marker = "new";\n');
    const result = await requestContextOS('ask', { request: 'Find the current marker declaration.', known: { refs: [{
      resultId: first.resultId, id: first.records[0].id, path: 'a.mjs',
      contentHash: first.records[0].contentHash, ranges: [[1, 1]],
    }] } }, {
      projectRoot: root, profile: {}, broker: requestEvidence,
      transport: async (context) => {
        calls += 1;
        const input = JSON.parse(context.input);
        unavailable = input.known.unavailable;
        if (calls === 1) return { calls: [{ id: 'search-current', name: 'search', args: { queries: ['marker'] } }] };
        const record = context.toolResults.at(-1).result.records[0];
        return { calls: [{ id: 'select-current', name: 'select', args: { references: [{
          id: record.id, path: record.path, contentHash: record.contentHash, ranges: record.ranges,
        }] } }] };
      },
    });
    assert.equal(calls, 2);
    assert.ok(unavailable.some((item) => /stale or unavailable/.test(item.reason)));
    assert.equal(result.status, 'completed');
    assert.equal(result.records[0].text, 'export const marker = "new";\n');
    assert.notEqual(result.records[0].contentHash, first.records[0].contentHash);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('micro.audit stores only safe tool metadata and real usage in a private NDJSON file', async () => {
  const root = workspace();
  try {
    const { result, source } = await runAuditFixture(root, { micro: {
      audit: true, apiKey: 'private-secret-token',
      budget: { searchHydrationWindowLines: 1 },
    } });
    assert.equal(result.status, 'completed');
    assert.equal(orderedRecordText(result.records), source);
    assert.equal(result.diagnostics.auditStatus, 'recorded');
    const auditDir = path.join(root, '.contextos', 'micro-audit');
    const files = fs.readdirSync(auditDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^[a-f0-9-]+\.ndjson$/);
    assert.equal(fs.statSync(path.join(auditDir, files[0])).mode & 0o777, 0o600);
    const content = fs.readFileSync(path.join(auditDir, files[0]), 'utf8');
    assert.ok(!content.includes(source));
    for (const secret of ['AUDIT_SOURCE_NEEDLE', 'private-query-phrase', 'private-note-phrase', 'private-secret-token', 'private-task-identifier']) {
      assert.ok(!content.includes(secret), `audit trace must omit ${secret}`);
    }
    const events = content.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(events.filter((event) => event.kind === 'tool').map((event) => event.name), ['search', 'read', 'select']);
    assert.deepEqual(events.filter((event) => event.kind === 'transport').map((event) => event.seq), [1, 2, 3]);
    assert.deepEqual(events.filter((event) => event.kind === 'transport').map((event) => event.usage.input_tokens), [10, 20, 30]);
    assert.ok(events.filter((event) => event.kind === 'transport').every((event) => event.model === 'trace-model'));
    assert.ok(events.filter((event) => event.kind === 'tool').every((event) => event.budget.before && event.budget.after));
    assert.ok(events.filter((event) => event.kind === 'tool').some((event) => event.items.some((item) => item.path === 'src/marker.mjs')));
    assert.ok(events.some((event) => event.kind === 'selection' && event.status === 'complete' && event.failureCategory === 'none'));
    assert.ok(events.some((event) => event.kind === 'parent' && event.action === 'ask' && event.resultId === result.resultId));
    assert.ok(events.every((event) => !Object.hasOwn(event, 'input') && !Object.hasOwn(event, 'state') && !Object.hasOwn(event, 'text')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('private audit correlates typed selection failure and command receipt without recording arguments', async () => {
  const root = workspace();
  try {
    const ask = await requestContextOS('ask', { request: 'PRIVATE_ASK_TEXT' }, {
      projectRoot: root, profile: { micro: { audit: true } }, broker: requestEvidence,
      transport: async () => ({ calls: [{ id: 'bad-audit-select', name: 'select', args: '[]' }] }),
    });
    assert.equal(ask.status, 'partial');
    const auditDir = path.join(root, '.contextos', 'micro-audit');
    const askFile = fs.readdirSync(auditDir).find((name) => name.endsWith('.ndjson'));
    const askEvents = fs.readFileSync(path.join(auditDir, askFile), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(askEvents.some((event) => event.kind === 'tool' && event.name === 'select'
      && event.argsShape === 'json_array' && event.failureCategory === 'arguments_not_object'));
    assert.ok(askEvents.some((event) => event.kind === 'selection' && event.status === 'partial'
      && event.failureCategory === 'arguments_not_object'));
    assert.ok(askEvents.some((event) => event.kind === 'parent' && event.action === 'ask' && event.resultId === ask.resultId));
    assert.ok(!fs.readFileSync(path.join(auditDir, askFile), 'utf8').includes('PRIVATE_ASK_TEXT'));

    const command = await requestContextOS('command', { command: 'PRIVATE_COMMAND_TEXT' }, {
      projectRoot: root, profile: { micro: { audit: true } },
      command: async () => ({ status: 'completed', id: 'command-12345678', receipt: { id: 'receipt-12345678', exitCode: 0 } }),
    });
    assert.equal(command.status, 'completed');
    const commandFile = fs.readdirSync(auditDir).find((name) => name !== askFile);
    const commandContent = fs.readFileSync(path.join(auditDir, commandFile), 'utf8');
    const commandEvents = commandContent.trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(commandEvents.some((event) => event.kind === 'parent' && event.action === 'command'
      && event.commandId === 'command-12345678' && event.receiptId === 'receipt-12345678'));
    assert.ok(!commandContent.includes('PRIVATE_COMMAND_TEXT'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('private audit records offered tool names and typed read misses without raw request data', async () => {
  const root = workspace();
  try {
    let calls = 0;
    const result = await requestContextOS('ask', { request: 'private audit query: look up one missing file' }, {
      projectRoot: root,
      profile: { micro: { audit: true, budget: { maxTransportInvocations: 2 } } },
      broker: requestEvidence,
      transport: async (context) => {
        calls += 1;
        if (calls === 1) return { calls: [{ id: 'missing-file-read', name: 'read', args: {
          requests: [{ path: 'src/not-present.mjs', ranges: [[1, 1]] }],
        } }] };
        return { calls: [{ id: 'final-select', name: 'select', args: { references: [], missing: ['The file was not found.'] } }] };
      },
    });
    assert.equal(result.status, 'partial');
    const auditDir = path.join(root, '.contextos', 'micro-audit');
    const filename = fs.readdirSync(auditDir).find((name) => name.endsWith('.ndjson'));
    const content = fs.readFileSync(path.join(auditDir, filename), 'utf8');
    const events = content.trim().split('\n').map((line) => JSON.parse(line));
    const transports = events.filter((event) => event.kind === 'transport');
    assert.deepEqual(transports.map((event) => event.offeredToolNames), [
      ['search', 'read', 'select'], ['select'],
    ]);
    const read = events.find((event) => event.kind === 'tool' && event.name === 'read');
    assert.deepEqual(read.missingCategories, ['path_not_found']);
    assert.ok(!content.includes('private audit query'));
    assert.ok(!content.includes('requests'));
    assert.ok(events.every((event) => !Object.hasOwn(event, 'schema') && !Object.hasOwn(event, 'arguments')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('audit disabled creates no file, and an audit write failure never changes delivered evidence', async () => {
  const disabledRoot = workspace(); const failedRoot = workspace();
  try {
    const disabled = await runAuditFixture(disabledRoot, {});
    assert.equal(disabled.result.status, 'completed');
    assert.equal(disabled.result.diagnostics, undefined);
    assert.ok(!fs.existsSync(path.join(disabledRoot, '.contextos', 'micro-audit')));

    fs.mkdirSync(path.join(failedRoot, '.contextos'), { recursive: true });
    fs.writeFileSync(path.join(failedRoot, '.contextos', 'micro-audit'), 'blocked');
    const failed = await runAuditFixture(failedRoot, { micro: {
      audit: true, budget: { searchHydrationWindowLines: 1 },
    } });
    assert.equal(failed.result.status, 'completed');
    assert.equal(orderedRecordText(failed.result.records), failed.source);
    assert.equal(failed.result.diagnostics.auditStatus, 'failed');
    assert.ok(failed.result.diagnostics.auditMissing.length > 0);
    assert.deepEqual(failed.result.missing, []);
  } finally { fs.rmSync(disabledRoot, { recursive: true, force: true }); fs.rmSync(failedRoot, { recursive: true, force: true }); }
});

test('budget omits whole source blocks and gives a recovery reference instead of broken code', () => {
  const text = 'export function intact(){\n' + '  // body\n'.repeat(100) + '}\n';
  const result = { status: 'completed', resultId: 'result-test', records: [{ path: 'a.mjs', ranges: [[1, 102]], text, contentHash: 'hash' }] };
  const small = renderRequestResult(result, { maxChars: 500 });
  assert.match(small, /^status=partial/); assert.match(small, /result-test/);
  assert.ok(!small.includes('export function'));
  const large = renderRequestResult(result, { maxChars: 4000 });
  assert.ok(large.includes(text)); assert.match(large, /^status=completed/);
});

test('renderer cites reusable results compactly and makes clipped references recoverable', () => {
  const result = {
    status: 'complete', resultId: 'result-current',
    reused: [{ resultId: 'result-source', id: 'evidence-source', path: 'src/known.mjs',
      contentHash: 'b'.repeat(64), ranges: [{ start: 4, end: 8 }] }],
  };
  const complete = renderRequestResult(result, { maxChars: 1200 });
  assert.match(complete, /reused result=result-source src\/known\.mjs/);

  const compact = renderRequestResult(result, { maxChars: 256 });
  assert.match(compact, /^status=complete result=result-current/);
  assert.ok(!compact.includes('evidence-source'));

  const clipped = renderRequestResult({ ...result, reused: [{ ...result.reused[0], path: 'src/' + 'known-file-'.repeat(15) + '.mjs' }] }, { maxChars: 256 });
  assert.match(clipped, /^status=partial resultStatus=complete result=result-current/);
  assert.match(clipped, /missing\[1\]/, 'the durable result ID allows explicit recovery when even the reference details cannot fit');
  assert.ok(!clipped.includes('hash='));
});

test('renderer acknowledges only complete source blocks that survive final metadata checks', () => {
  const records = [
    { path: 'a.mjs', ranges: [{ start: 1, end: 1 }], text: 'A'.repeat(240), contentHash: 'a'.repeat(64) },
    { path: 'b.mjs', ranges: [{ start: 1, end: 1 }], text: 'B'.repeat(1_200), contentHash: 'b'.repeat(64) },
  ];
  const delivered = [];
  let partialMetrics;
  const partial = renderRequestResult({ status: 'completed', resultId: 'result-render', records }, {
    maxChars: 1_300, onSourceDelivered: record => delivered.push(record), onSourceMetrics: metrics => { partialMetrics = metrics; },
  });
  assert.match(partial, /^status=partial/);
  assert.match(partial, /missing\[1\]/, 'the minimum gap count survives even when the omitted source detail is long');
  assert.ok(partial.includes(records[0].text));
  assert.ok(!partial.includes(records[1].text));
  assert.deepEqual(delivered, [records[0]]);
  assert.deepEqual(partialMetrics, { renderedSourceBytes: 240, renderedSourceChars: 240 });

  const fallbackDelivery = [];
  let fallbackMetrics;
  const fallback = renderRequestResult({ status: 'completed', resultId: 'result-render',
    records: [{ ...records[0], text: 'small source' }], messages: [{ id: 'large', message: 'M'.repeat(800) }] }, {
    maxChars: 512, onSourceDelivered: record => fallbackDelivery.push(record), onSourceMetrics: metrics => { fallbackMetrics = metrics; },
  });
  assert.match(fallback, /^status=partial/);
  assert.ok(fallback.includes('small source'), 'a trailing message that does not fit must not erase a complete source block');
  assert.match(fallback, /display details omitted=messages\[1\]/);
  assert.match(fallback, /recover result=result-render with larger maxChars/);
  assert.deepEqual(fallbackDelivery, [{ ...records[0], text: 'small source' }]);
  assert.deepEqual(fallbackMetrics, { renderedSourceBytes: 12, renderedSourceChars: 12 });

  let emptyMetrics;
  renderRequestResult({ status: 'partial', records: [] }, { onSourceMetrics: metrics => { emptyMetrics = metrics; } });
  assert.deepEqual(emptyMetrics, { renderedSourceBytes: 0, renderedSourceChars: 0 }, 'an observed render with no selected source is zero, not unknown');
});

test('renderer keeps a roughly 9.2K source block when many gap details overflow the 12K output budget', () => {
  const source = 'x'.repeat(9_200);
  const record = { path: 'src/large.mjs', ranges: [[1, 1]], text: source, contentHash: 'c'.repeat(64) };
  const missing = Array.from({ length: 24 }, (_, index) => ({
    path: `src/gap-${index}-${'long-path-'.repeat(8)}.mjs`,
    range: { start: 100 + index, end: 200 + index },
    reason: `Not read ${'detail-'.repeat(18)}`,
  }));
  const delivered = [];
  let metrics;
  const output = renderRequestResult({ status: 'partial', resultId: 'result-large', records: [record], missing }, {
    maxChars: 12_000,
    onSourceDelivered: item => delivered.push(item),
    onSourceMetrics: value => { metrics = value; },
  });

  assert.ok(output.includes(source), 'the complete source fits and keeps priority over verbose gap metadata');
  assert.match(output, /^status=partial/);
  assert.match(output, /missing\[24\]/);
  assert.match(output, /gap detail\(s\) omitted; recover result=result-large with larger maxChars for exact ranges/);
  assert.ok(Array.from(output).length <= 12_000);
  assert.deepEqual(delivered, [record]);
  assert.deepEqual(metrics, { renderedSourceBytes: 9_200, renderedSourceChars: 9_200 });
});

test('overlong gap detail cannot displace a near-budget source block', () => {
  const resultId = '123e4567-e89b-12d3-a456-426614174000';
  const record = { path: 'src/example.mjs', ranges: [[1, 1]], contentHash: 'a'.repeat(64), text: 'x'.repeat(11_650) };
  const delivered = [];
  const output = renderRequestResult({ status: 'completed', resultId, records: [record], missing: ['g'.repeat(24_000)] }, {
    maxChars: 12_000,
    onSourceDelivered: item => delivered.push(item),
  });

  assert.match(output, new RegExp(`^status=partial resultStatus=completed result=${resultId}`));
  assert.ok(output.includes(record.text), 'an overlong gap explanation is abbreviated before the source block is dropped');
  assert.match(output, /missing\[1\]/);
  assert.ok(!output.includes('g'.repeat(100)), 'the unavailable long detail is not partially copied into the response');
  assert.ok(Array.from(output).length > 11_800 && Array.from(output).length <= 12_000);
  assert.deepEqual(delivered, [record]);
});

test('renderer omits an oversized summary as a whole while preserving exact source delivery', () => {
  const record = { path: 'src/target.mjs', ranges: [[8, 9]], text: 'const answer = 42;\n', contentHash: 'd'.repeat(64) };
  const delivered = [];
  const output = renderRequestResult({ status: 'completed', resultId: 'result-summary', records: [record], summary: 'S'.repeat(4_000) }, {
    maxChars: 512,
    onSourceDelivered: item => delivered.push(item),
  });

  assert.match(output, /^status=partial resultStatus=completed/);
  assert.ok(output.includes(record.text));
  assert.ok(!output.includes(`summary=${'S'.repeat(20)}`), 'summary text is omitted whole rather than truncated into a misleading claim');
  assert.match(output, /display details omitted=summary; recover result=result-summary with larger maxChars/);
  assert.ok(Array.from(output).length <= 512);
  assert.deepEqual(delivered, [record]);
});

test('near-limit source and receipt survive summary omission and final status growth', () => {
  const resultId = '123e4567-e89b-12d3-a456-426614174000';
  const receipt = { id: 'receipt-123', exitCode: 0, logHandle: 'logs/job-123' };
  const path = 'src/near-limit.mjs';
  const contentHash = 'f'.repeat(64);
  const limit = 12_000;
  const chars = value => Array.from(value).length;
  const completeHeader = `status=completed result=${resultId}\nreceipt=${receipt.id} exit=${receipt.exitCode} log=${receipt.logHandle}`;
  const sourcePrefix = `\n\n${path} [[1,1]] hash=${contentHash}\n`;
  const fullNotice = `\ndisplay details omitted=summary; recover result=${resultId} with larger maxChars`;
  const statusGrowth = chars(`status=partial resultStatus=completed`) - chars('status=completed');
  const sourceText = 'N'.repeat(limit - chars(completeHeader) - chars(sourcePrefix) - chars(fullNotice) - Math.floor(statusGrowth / 2));
  const record = { path, ranges: [[1, 1]], contentHash, text: sourceText };
  const delivered = [];
  const output = renderRequestResult({ status: 'completed', resultId, receipt, records: [record], summary: 'S'.repeat(5_000) }, {
    maxChars: limit,
    onSourceDelivered: item => delivered.push(item),
  });

  assert.match(output, new RegExp(`^status=partial resultStatus=completed result=${resultId}`));
  assert.ok(output.includes(`receipt=${receipt.id} exit=0 log=${receipt.logHandle}`));
  assert.ok(output.includes(sourceText), 'the complete near-limit source remains ahead of optional summary metadata');
  assert.ok(output.includes('omitted summary; larger maxChars'), 'the compact notice explains how to retrieve the omitted summary');
  assert.ok(!output.includes(`summary=${'S'.repeat(20)}`));
  assert.ok(chars(output) > limit - 100 && chars(output) <= limit);
  assert.deepEqual(delivered, [record]);
});

test('renderer acknowledges only complete optional reports and messages that remain visible', () => {
  const reportAcks = [];
  const messageAcks = [];
  const result = {
    status: 'completed', resultId: 'result-optional',
    messages: [{ id: 'm1', message: 'M'.repeat(700) }],
    reports: [{ id: 'short-report', content: 'short report body' }, { id: 'long-report', content: 'L'.repeat(1_000) }],
  };
  const output = renderRequestResult(result, {
    maxChars: 512,
    onReportDelivered: id => reportAcks.push(id),
    onMessagesDelivered: ids => messageAcks.push(...ids),
  });

  assert.match(output, /^status=partial/);
  assert.ok(output.includes('short report body'));
  assert.ok(!output.includes('messages=[') && !output.includes('M'.repeat(20)));
  assert.ok(!output.includes('L'.repeat(20)));
  assert.match(output, /display details omitted=messages\[1\],reports\[1\]/);
  assert.deepEqual(reportAcks, ['short-report']);
  assert.deepEqual(messageAcks, []);
});

test('renderer preserves failed status, error and command receipt when source cannot fit', () => {
  const record = { path: 'src/failure.mjs', ranges: [[31, 90]], text: 'F'.repeat(2_000), contentHash: 'e'.repeat(64) };
  const delivered = [];
  const output = renderRequestResult({ status: 'failed', errorCode: 'COMMAND_FAILED', resultId: 'result-failed', id: 'job-1',
    receipt: { id: 'receipt-1', exitCode: 7, logHandle: 'logs/job-1' }, records: [record] }, {
    maxChars: 512, onSourceDelivered: item => delivered.push(item),
  });

  assert.match(output, /^status=failed result=result-failed id=job-1/);
  assert.match(output, /error=COMMAND_FAILED/);
  assert.match(output, /receipt=receipt-1 exit=7 log=logs\/job-1/);
  assert.match(output, /source path=src\/failure\.mjs ranges=\[\[31,90\]\] omitted; recover result=result-failed with larger maxChars/);
  assert.ok(!output.includes('F'.repeat(20)));
  assert.ok(Array.from(output).length <= 512);
  assert.deepEqual(delivered, []);
});

test('source metrics separate materialized evidence from rendered Unicode ranges and dedupe overlaps', async () => {
  const root = workspace();
  try {
    const source = '猫🙂\nβeta\nend\n';
    fs.writeFileSync(path.join(root, 'unicode.mjs'), source, 'utf8');
    const result = await requestContextOS('ask', { inspect: [{ path: 'unicode.mjs', ranges: [[1, 3]] }] }, {
      projectRoot: root, profile: {}, broker: requestEvidence,
    });
    const expectedBytes = Buffer.byteLength(source, 'utf8');
    const expectedChars = Array.from(source).length;
    assert.equal(result.accounting.materializedEvidenceBytes, expectedBytes);
    assert.equal(result.accounting.materializedEvidenceChars, expectedChars);
    assert.equal(result.accounting.renderedSourceBytes, null, 'SDK result persistence alone does not prove a host rendered the source');
    assert.equal(result.accounting.renderedSourceChars, null);

    const original = result.records[0];
    const overlapping = [
      { ...original, ranges: [{ start: 1, end: 2 }], text: '猫🙂\nβeta\n' },
      { ...original, ranges: [{ start: 2, end: 3 }], text: 'βeta\nend\n' },
    ];
    const delivered = [];
    let renderMetrics;
    const output = renderRequestResult({ ...result, records: overlapping }, {
      maxChars: 2000,
      onSourceDelivered: record => delivered.push(record),
      onSourceMetrics: metrics => { renderMetrics = metrics; },
    });
    assert.ok(output.includes(overlapping[0].text) && output.includes(overlapping[1].text));
    assert.equal(delivered.length, 2);
    assert.deepEqual(renderMetrics, { renderedSourceBytes: expectedBytes, renderedSourceChars: expectedChars });
    assert.equal(result.accounting.renderedSourceBytes, null, 'render callbacks do not mutate the stored SDK result');

    const receipt = await recordEvidenceDelivery(root, result.resultId, delivered);
    assert.equal(receipt.recorded, true);
    assert.equal(receipt.count, 2);
    assert.equal(receipt.renderedSourceBytes, expectedBytes, 'validated overlapping refs count unique source lines once');
    assert.equal(receipt.renderedSourceChars, expectedChars);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('source delivery receipts fail closed and known ranges preserve only the delivered union', async () => {
  const root = workspace(); const other = workspace(); let seenKnown;
  try {
    const source = 'one\ntwo\nthree\n';
    fs.writeFileSync(path.join(root, 'a.mjs'), source);
    const first = await requestContextOS('ask', { inspect: [{ path: 'a.mjs', ranges: [[1, 3]] }] }, {
      projectRoot: root, profile: {}, broker: requestEvidence,
    });

    const forged = await recordEvidenceDelivery(root, first.resultId, [{ ...first.records[0], text: 'forged source\n' }]);
    assert.equal(forged.recorded, false, 'caller cannot acknowledge text that differs from the stored verified block');
    const artifactFile = path.join(root, '.contextos', 'request-results', `${first.resultId}.json`);
    assert.deepEqual(JSON.parse(fs.readFileSync(artifactFile, 'utf8')).sourceDelivery, []);

    const destination = path.join(other, '.contextos', 'request-results');
    fs.mkdirSync(destination, { recursive: true });
    fs.copyFileSync(artifactFile, path.join(destination, `${first.resultId}.json`));
    const foreign = await recordEvidenceDelivery(other, first.resultId, first.records);
    assert.equal(foreign.recorded, false, 'delivery receipts are bound to the canonical workspace');
    assert.deepEqual(JSON.parse(fs.readFileSync(artifactFile, 'utf8')).sourceDelivery, []);

    for (const range of [[[1, 1]], [[3, 3]]]) {
      const recovered = await requestContextOS('ask', { resultId: first.resultId, inspect: [
        { path: 'a.mjs', ranges: range },
      ] }, { projectRoot: root, profile: {} });
      const rendered = [];
      const text = renderRequestResult(recovered, { onSourceDelivered: record => rendered.push(record) });
      assert.ok(text.includes(rendered[0].text));
      const receipt = await recordEvidenceDelivery(root, first.resultId, rendered);
      assert.equal(receipt.recorded, true);
    }

    let providerCalls = 0;
    const selected = await requestContextOS('ask', {
      request: 'Use all three lines from the earlier artifact.',
      known: { refs: [{ resultId: first.resultId, path: 'a.mjs', ranges: [[1, 3]] }] },
    }, {
      projectRoot: root, profile: {},
      broker: async (_args, { knownContext }) => {
        providerCalls += 1;
        seenKnown = knownContext;
        return { status: 'completed', records: [], selection: { references: [{
          path: 'a.mjs', ranges: [{ start: 1, end: 3 }],
        }] } };
      },
    });
    assert.equal(providerCalls, 1);
    assert.deepEqual(seenKnown.records.map(record => record.ranges), [
      [{ start: 1, end: 1 }], [{ start: 3, end: 3 }],
    ]);
    assert.deepEqual(seenKnown.missing.map(gap => gap.range), [{ start: 2, end: 2 }]);
    assert.equal(selected.status, 'partial');
    assert.ok(selected.missing.some(gap => gap.path === 'a.mjs' && gap.range?.start === 2 && gap.range?.end === 2));
    assert.deepEqual(JSON.parse(fs.readFileSync(artifactFile, 'utf8')).sourceDelivery, [{
      path: 'a.mjs', contentHash: first.records[0].contentHash,
      ranges: [{ start: 1, end: 1 }, { start: 3, end: 3 }],
    }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); }
});

test('API Micro and CLI adapters are separate roles', async () => {
  const root = workspace();
  try {
    const result = await requestContextOS('agent', { task: 'implement' }, { projectRoot: root,
      profile: { micro: { url: 'https://api.example/v1', model: 'cheap' }, agents: { default: 'worker', adapters: { worker: { command: 'worker', model: 'capable' } } } },
      agent: (_args, opts) => ({ status: 'completed', summary: opts.adapter.model }),
    });
    assert.equal(result.summary, 'capable');
    const missing = await requestContextOS('agent', { task: 'implement' }, { projectRoot: root, profile: { micro: { url: 'https://api.example/v1', model: 'cheap' } }, agent: () => assert.fail('API must not substitute for CLI') });
    assert.equal(missing.errorCode, 'AGENT_NOT_CONFIGURED');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('usage recording failure preserves real API success and unknown actual model stays unknown', async () => {
  const root = workspace(); const rows = [];
  try {
    const result = await requestContextOS('ask', {}, { projectRoot: root, profile: { micro: { model: 'requested' } },
      transport: async () => ({ ok: true, usage: { input: 3, output: 1 } }),
      onUsage: (row) => { rows.push(row); throw new Error('ledger unavailable'); },
      broker: async (_args, opts) => { await opts.transport({}); return { status: 'complete', records: [] }; },
    });
    assert.equal(result.status, 'completed'); assert.equal(rows[0].model, null); assert.equal(rows[0].requestedModel, 'requested');
    assert.match(result.missing[0], /accounting is incomplete/);
    const failureRows = [];
    await assert.rejects(requestContextOS('ask', {}, { projectRoot: root, profile: { micro: { model: 'requested' } },
      transport: async () => { throw new Error('network failure'); }, onUsage: row => failureRows.push(row),
      broker: async (_args, opts) => opts.transport({}),
    }), /network failure/);
    assert.equal(failureRows[0].model, null); assert.equal(failureRows[0].usage, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('task API budget blocks later provider requests without stopping independent command work', async () => {
  const root = workspace();
  const taskId = 'request-service-budget-task';
  const profile = { micro: { taskBudget: {
    id: 'request-service-budget-run', taskId, limits: { requests: 10, inputTokens: 8 },
  } } };
  let providerCalls = 0;
  let commandCalls = 0;
  const onUsage = row => appendRoleUsage(root, row);
  const transport = async () => {
    providerCalls += 1;
    return { model: 'fixture-model', usage: { input_tokens: 8, output_tokens: 2 },
      invocation: { providerLaunches: 1 }, summary: 'No code evidence needed.', selection: [] };
  };
  try {
    const first = await requestContextOS('ask', { request: 'Return a short no-source answer.' }, {
      projectRoot: root, profile, transport, onUsage,
    });
    assert.equal(first.status, 'partial', 'the fixture answer intentionally selects no source evidence');
    assert.equal(first.errorCode, undefined);
    assert.equal(providerCalls, 1);

    const blocked = await requestContextOS('ask', { request: 'Another request in this same budget.' }, {
      projectRoot: root, profile, transport, onUsage,
    });
    assert.equal(blocked.status, 'failed');
    assert.equal(blocked.errorCode, 'API_MICRO_BUDGET_EXHAUSTED');
    assert.equal(providerCalls, 1, 'the exhausted budget prevents a second HTTP dispatch');

    const commandResult = await requestContextOS('command', { command: 'true' }, {
      projectRoot: root, profile, onUsage,
      command: async () => { commandCalls += 1; return { status: 'completed', summary: 'command still runs' }; },
    });
    assert.equal(commandResult.status, 'completed');
    assert.equal(commandCalls, 1, 'API budget refusal does not terminate independent CLI/native work');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('existing CLI jobs can be fetched after adapter configuration is removed', async () => {
  const root = workspace();
  try {
    const result = await requestContextOS('agent', { action: 'get', id: 'saved-job' }, { projectRoot: root, profile: {},
      agent: args => ({ status: 'completed', id: args.id }),
    });
    assert.equal(result.id, 'saved-job');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Unicode delivery budgets do not split source or acknowledge omitted messages', () => {
  const messages = [{ id: 1, message: 'important correction'.repeat(100) }]; let ack = [];
  const result = { status: 'completed', records: [{ path: 'emoji.mjs', ranges: [[1, 1]], text: '😀'.repeat(300), contentHash: 'hash' }] };
  assert.ok(renderRequestResult(result, { maxChars: 650 }).includes(result.records[0].text));
  const small = renderRequestResult({ status: 'completed', messages }, { maxChars: 256, onMessagesDelivered: ids => ack.push(...ids) });
  assert.match(small, /^status=partial/); assert.ok(Array.from(small).length <= 256); assert.deepEqual(ack, []);
  renderRequestResult({ status: 'completed', messages }, { maxChars: 4000, onMessagesDelivered: ids => ack.push(...ids) });
  assert.deepEqual(ack, [1]);
  assert.throws(() => renderRequestResult(result, { maxChars: 50 }), /at least 256/);
});

test('invalid delivery budget fails before any paid request', async () => {
  const root = workspace(); let calls = 0;
  try {
    await assert.rejects(requestContextOS('ask', { request: 'find source', maxChars: 20 }, { projectRoot: root, profile: {},
      transport: async () => { calls++; }, broker: async (_args, opts) => opts.transport({}),
    }), /at least 256/);
    assert.equal(calls, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('structured evidence gaps retain actionable paths, ranges and reasons', () => {
  const text = renderRequestResult({ status: 'partial', missing: [{ path: 'src/a.mjs', range: { start: 9, end: 13 }, reason: 'File ends at line 8' }] });
  assert.match(text, /src\/a.mjs/); assert.match(text, /File ends at line 8/); assert.match(text, /"start":9/);
  assert.ok(!text.includes('[object Object]'));
});
