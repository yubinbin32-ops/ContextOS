import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { requestContextOS, renderRequestResult, recordEvidenceDelivery } from '../../orchestrator/src/request-service.mjs';
import { ContextOSV2Service } from '../src/v2-service.mjs';
import { Orchestrator } from '../../orchestrator/src/index.mjs';
import { SessionStore } from '../../orchestrator/src/session-store.mjs';
import { LanguageRegistry } from '../../code-intel/src/language-registry.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-first-contact-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture-project', main: 'entry.mjs', scripts: { test: 'node --test', build: 'node entry.mjs' }, workspaces: ['packages/*'] }));
  fs.writeFileSync(path.join(root, 'README.md'), '# Fixture\nQuick project introduction.\n');
  fs.writeFileSync(path.join(root, 'entry.mjs'), 'export const entry = 1;\n');
  fs.mkdirSync(path.join(root, 'packages', 'child'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages', 'child', 'package.json'), JSON.stringify({ name: 'child', main: 'index.mjs' }));
  fs.writeFileSync(path.join(root, 'packages', 'child', 'index.mjs'), 'export const child = 1;\n');
  return root;
}
const ask = (root, extra = {}) => requestContextOS('ask', { overview: true, ...extra }, { projectRoot: root, profile: {}, transport: () => { throw new Error('overview must not launch a provider'); } });
const remove = (root) => fs.rmSync(root, { recursive: true, force: true });

test('public MCP cold and hot overview returns a body without API or graph initialization', async (t) => {
  const root = fixture();
  const client = new Client({ name: 'first-contact-check', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/v3-server.mjs', import.meta.url))],
    env: { ...process.env, CONTEXTOS_DISABLE_API_MICRO: '1', CONTEXTOS_HOME: path.join(root, 'home') }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.match(tools.tools[0].description, /overview:true/);
    const call = () => client.callTool({ name: 'contextos', arguments: { action: 'ask', args: { overview: true }, projectRoot: root } });
    const cold = await call();
    const hot = await call();
    for (const result of [cold, hot]) {
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.lifecycle.modelRequests, 0);
      assert.match(result.content[0].text, /fixture-project.*Node.js/);
      assert.match(result.content[0].text, /entry.mjs:1/);
      assert.match(result.content[0].text, /node --test/);
      assert.match(result.content[0].text, /Effective plans=/);
      assert.equal(result.structuredContent.overview.packages.length, 2);
    }
    assert.equal(cold.structuredContent.lifecycle.cache, 'miss');
    assert.equal(hot.structuredContent.lifecycle.cache, 'hit');
    assert.equal(cold.content[0].text, hot.content[0].text);
    assert.equal(fs.existsSync(path.join(root, '.contextos', 'project.json')), false);
    assert.equal(fs.existsSync(path.join(root, '.contextos', 'graph.json')), false);
    assert.equal(fs.existsSync(path.join(root, '.contextos', 'state.sqlite')), false);
    const inspect = await client.callTool({ name: 'contextos', arguments: { action: 'ask', args: { inspect: [{ path: 'entry.mjs', ranges: [[1, 1]] }] }, projectRoot: root } });
    assert.match(inspect.content[0].text, /export const entry = 1/);
    t.diagnostic(JSON.stringify({ calls: 2, modelRequests: 0, coldMs: cold.structuredContent.lifecycle.durationMs, hotMs: hot.structuredContent.lifecycle.durationMs, outputBytes: Buffer.byteLength(hot.content[0].text) }));
  } finally { await client.close(); remove(root); }
});

test('overview invalidates related manifests, README, entries and graph; bounded display always retains a body', async () => {
  const root = fixture();
  try {
    const cold = await ask(root);
    assert.equal((await ask(root)).lifecycle.cache, 'hit');
    fs.writeFileSync(path.join(root, 'README.md'), '# Fixture\nChanged readme.\n');
    assert.equal((await ask(root)).lifecycle.cache, 'miss');
    fs.writeFileSync(path.join(root, 'entry.mjs'), 'export const entry = 2;\n');
    const changedEntry = await ask(root);
    assert.equal(changedEntry.lifecycle.cache, 'miss');
    assert.notEqual(cold.overview.packages[0].entries[0].contentHash, changedEntry.overview.packages[0].entries[0].contentHash);
    fs.writeFileSync(path.join(root, 'packages', 'child', 'package.json'), JSON.stringify({ name: 'renamed-child', main: 'index.mjs' }));
    assert.equal((await ask(root)).overview.packages[1].name, 'renamed-child');
    fs.mkdirSync(path.join(root, '.contextos'), { recursive: true });
    fs.writeFileSync(path.join(root, '.contextos', 'graph.json'), JSON.stringify({ projectId: 'fixture-graph', graphRevision: 1,
      data: { blocks: [{ id: 'real-feature', title: 'Feature', artifactRefs: [{ path: 'gone.mjs', startLine: 98 }] }], chains: [], plans: [], tasks: [] } }));
    const service = new ContextOSV2Service({ projectRoot: root, projectId: 'fixture-graph' });
    service.db.saveBlock({ id: 'real-feature', projectId: service.projectId, title: 'Feature', artifactRefs: [{ path: 'gone.mjs', anchorKind: 'file', hash: 'fixture-hash', startLine: 98 }] });
    let graph;
    try { graph = await ask(root); } finally { service.close(); }
    assert.equal(graph.lifecycle.cache, 'miss');
    assert.ok(graph.overview.gaps.some((gap) => gap.includes('Stale anchor')));
    assert.ok(graph.overview.gaps.some((gap) => gap.includes('no Chain')));
    assert.equal(graph.overview.navigation[0].anchors[0].available, false);
    const display = renderRequestResult(graph, { maxChars: 256 });
    assert.ok(Array.from(display).length <= 256);
    assert.match(display, /Project fixture-graph/);
    assert.match(display, /overview display limited|omitted/);
  } finally { remove(root); }
});

test('effective plan/task and session refresh independently, and copied workspace cannot inherit the session', async () => {
  const root = fixture();
  let copy;
  const service = new ContextOSV2Service({ projectRoot: root, projectId: 'fixture-state' });
  try {
    const now = new Date().toISOString();
    const old = '2020-01-01T00:00:00.000Z';
    for (const [id, updatedAt] of [['current-plan', now], ['stale-plan', old]]) service.db.savePlan({ id, projectId: service.projectId, title: id, status: 'active', phases: [], checkpoints: [], createdAt: updatedAt, updatedAt });
    service.db.saveTask({ id: 'current-task', planId: 'current-plan', phaseId: 'phase', title: 'Work now', status: 'active', createdAt: now, updatedAt: now });
    service.syncEngine.publishIfDirty(service.projectId, root);
    const sessions = new SessionStore({ projectRoot: root, projectId: service.projectId });
    sessions.ensureSession('Current project intent');
    const initial = await ask(root);
    assert.deepEqual(initial.overview.plans.map((p) => p.id), ['current-plan']);
    assert.deepEqual(initial.overview.tasks.map((p) => p.id), ['current-task']);
    assert.equal((await ask(root)).lifecycle.cache, 'hit');
    const task = service.db.getTask('current-task');
    service.db.saveTask({ ...task, title: 'New task title', updatedAt: new Date().toISOString() });
    const refreshed = await ask(root);
    assert.equal(refreshed.lifecycle.cache, 'miss');
    assert.equal(refreshed.overview.tasks[0].title, 'New task title');
    sessions.save({ ...sessions.current, intent: 'Updated intent' });
    assert.equal((await ask(root)).overview.session.intent, 'Updated intent');
    copy = fs.mkdtempSync(path.join(os.tmpdir(), 'os-first-contact-copy-'));
    fs.cpSync(root, copy, { recursive: true });
    const other = await ask(copy);
    assert.equal(other.lifecycle.cache, 'miss');
    assert.equal(other.overview.workspace, fs.realpathSync(copy));
    assert.equal(other.overview.session.status, 'unavailable');
    assert.equal(other.overview.session.reason, 'foreign-workspace');
  } finally { service.close(); remove(root); if (copy) remove(copy); }
});

test('overview confines symlink entries and reports missing graph without creating owners', async () => {
  const root = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'os-first-contact-private-'));
  try {
    fs.writeFileSync(path.join(outside, 'private.mjs'), 'PRIVATE_SENTINEL');
    fs.symlinkSync(path.join(outside, 'private.mjs'), path.join(root, 'escaped.mjs'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'secure-fixture', main: 'escaped.mjs' }));
    const result = await ask(root);
    assert.equal(result.overview.packages[0].entries[0].available, false);
    assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'), false);
    assert.equal(result.overview.graph.blockCount, 0);
    assert.equal(fs.existsSync(path.join(root, '.contextos')), false);
    const invalid = await ask(root, { inspect: [{ path: 'entry.mjs' }] });
    assert.equal(invalid.errorCode, 'INVALID_PROJECT_OVERVIEW');
  } finally { remove(root); remove(outside); }
});

test('synchronous batch provider truncation returns a retained session that can be sent', async () => {
  const root = fixture();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'os-first-contact-microhome-'));
  const priorHome = process.env.CONTEXTOS_HOME;
  process.env.CONTEXTOS_HOME = home;
  let requests = 0;
  const server = http.createServer((req, res) => {
    req.resume(); requests += 1;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: requests === 1 ? 'length' : 'stop', message: { role: 'assistant', content: requests === 1 ? 'partial answer' : 'continued answer' } }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    fs.mkdirSync(path.join(root, '.contextos'), { recursive: true });
    fs.writeFileSync(path.join(root, '.contextos', 'profile.json'), JSON.stringify({ micro: { url: 'http://127.0.0.1:' + server.address().port, model: 'local-fixture', key: 'fixture' } }));
    const orchestrator = new Orchestrator({ projectRoot: root, projectId: 'micro-fixture', service: { projectId: 'micro-fixture', osContext: async () => ({}), syncEngine: { publishIfDirty() {} } } });
    const batch = JSON.parse(await orchestrator.dispatch('ops', { capability: 'micro', action: 'batch', args: { tasks: [{ id: 'partial', prompt: 'Do the bounded task', withOS: false }] } }));
    const partial = batch.tasks[0];
    assert.equal(partial.status, 'partial');
    assert.ok(partial.session?.id);
    assert.equal(partial.resume.sessionId, partial.session.id);
    const continuation = JSON.parse(await orchestrator.dispatch('ops', { capability: 'micro', action: 'session', args: { sessionAction: 'send', sessionId: partial.resume.sessionId, task: 'Continue' } }));
    assert.equal(continuation.ok, true);
    assert.equal(continuation.content, 'continued answer');
    assert.equal(requests, 2);
  } finally {
    if (priorHome === undefined) delete process.env.CONTEXTOS_HOME; else process.env.CONTEXTOS_HOME = priorHome;
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    remove(root); remove(home);
  }
});


test('runtime database wins divergent or malformed projection and remains scoped to its project', async () => {
  const root = fixture();
  const service = new ContextOSV2Service({ projectRoot: root, projectId: 'runtime-project' });
  try {
    const now = new Date().toISOString();
    service.db.saveBlock({ id: 'runtime-feature', projectId: service.projectId, title: 'Runtime feature', artifactRefs: [{ path: 'entry.mjs', anchorKind: 'file', hash: 'fixture-hash' }] });
    service.db.ensureProject('foreign-project', '/foreign-workspace');
    service.db.saveBlock({ id: 'foreign-feature', projectId: 'foreign-project', title: 'FOREIGN_SENTINEL', artifactRefs: [{ path: 'entry.mjs', anchorKind: 'file', hash: 'fixture-hash' }] });
    service.db.savePlan({ id: 'runtime-plan', projectId: service.projectId, title: 'Runtime work', status: 'active', updatedAt: now, createdAt: now });
    service.syncEngine.publishIfDirty(service.projectId, root);
    fs.writeFileSync(path.join(root, '.contextos', 'graph.json'), JSON.stringify({ projectId: 'foreign-project', graphRevision: 9999, data: { blocks: [{ id: 'projection-ghost' }], chains: [], plans: [], tasks: [] } }));
    const overview = await ask(root);
    assert.equal(overview.overview.projectId, service.projectId);
    assert.equal(overview.overview.graph.blockCount, 1);
    assert.equal(overview.overview.navigation[0].id, 'runtime-feature');
    assert.ok(overview.overview.gaps.some((g) => g.includes('projection differs')));
    assert.equal(JSON.stringify(overview).includes('FOREIGN_SENTINEL'), false);
    assert.notEqual(overview.overview.graph.revision, 9999);
    fs.writeFileSync(path.join(root, '.contextos', 'graph.json'), JSON.stringify({ projectId: service.projectId, data: { blocks: {}, chains: null, tasks: 'bad' } }));
    const malformed = await ask(root);
    assert.equal(malformed.lifecycle.cache, 'miss');
    assert.equal(malformed.overview.packages[0].entries[0].available, true);
    assert.equal(malformed.overview.navigation[0].id, 'runtime-feature');
    assert.ok(malformed.overview.gaps.some((g) => g.includes('Invalid graph projection')));
    fs.writeFileSync(path.join(root, '.contextos', 'graph.json'), '{ broken');
    const broken = await ask(root);
    assert.equal(broken.status, 'completed');
    assert.equal(broken.overview.navigation[0]?.id, 'runtime-feature', JSON.stringify(broken.overview));
    assert.ok(broken.overview.gaps.some((g) => g.includes('invalid')));
  } finally { service.close(); remove(root); }
});

test('overview refuses external or oversized session files while retaining project orientation', async () => {
  const root = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'os-first-contact-session-private-'));
  try {
    fs.mkdirSync(path.join(root, '.contextos'), { recursive: true });
    const secret = path.join(outside, 'session.json');
    fs.writeFileSync(secret, JSON.stringify({ status: 'open', workspaceRoot: fs.realpathSync(root), intent: 'PRIVATE_SESSION_SENTINEL', notes: [], receipts: [], touchedFiles: [] }));
    fs.symlinkSync(secret, path.join(root, '.contextos', 'session.json'));
    const escaped = await ask(root);
    assert.equal(JSON.stringify(escaped).includes('PRIVATE_SESSION_SENTINEL'), false);
    assert.equal(escaped.overview.session.status, 'unavailable');
    assert.equal(escaped.overview.session.reason, 'unsafe-path');
    fs.unlinkSync(path.join(root, '.contextos', 'session.json'));
    fs.writeFileSync(path.join(root, '.contextos', 'session.json'), JSON.stringify({ status: 'open', workspaceRoot: root, intent: 'x'.repeat(270 * 1024) }));
    const large = await ask(root);
    assert.equal(large.overview.session.status, 'unavailable');
    assert.equal(large.overview.session.reason, 'budget-exceeded');
    assert.ok(large.overview.gaps.some((g) => g.includes('256 KiB')));
    assert.match(large.summary, /fixture-project/);
  } finally { remove(root); remove(outside); }
});

test('overview renderer preserves report and mailbox callbacks under its ordinary delivery lifecycle', async () => {
  const root = fixture();
  try {
    const result = await ask(root);
    const reports = [], messages = [];
    const rendered = renderRequestResult({ ...result, reports: [{ id: 'deferred-report', content: 'REPORT_SENTINEL' }], messages: [{ id: 1, message: 'MESSAGE_SENTINEL' }] },
      { onReportDelivered: (id) => reports.push(id), onMessagesDelivered: (ids) => messages.push(...ids) });
    assert.match(rendered, /fixture-project/);
    assert.match(rendered, /REPORT_SENTINEL/);
    assert.match(rendered, /MESSAGE_SENTINEL/);
    assert.deepEqual(reports, ['deferred-report']);
    assert.deepEqual(messages, [1]);
    const shortReports = [];
    const limited = renderRequestResult({ ...result, reports: [{ id: 'too-large', content: 'r'.repeat(5000) }] }, { maxChars: 512, onReportDelivered: (id) => shortReports.push(id) });
    assert.ok(Array.from(limited).length <= 512);
    assert.deepEqual(shortReports, []);
  } finally { remove(root); }
});

test('change binds a standalone explicit Block without a fallback Chain', async () => {
  const root = fixture();
  const service = new ContextOSV2Service({ projectRoot: root });
  try {
    const orchestrator = new Orchestrator({ projectRoot: root, service });
    const result = await orchestrator.dispatch('change', { edits: [{ path: 'entry.mjs', target: 'entry = 1', replacement: 'entry = 2' }],
      architecture: { blocks: [{ id: 'entry-feature', title: 'Entry feature', paths: ['entry.mjs'] }] } });
    assert.match(result, /"changed":true/);
    assert.equal(service.db.listBlocks(service.projectId).length, 1);
    assert.equal(service.db.listChains(service.projectId).length, 0);
  } finally { service.close(); remove(root); }
});


function navigationFixture() {
  const root = fixture();
  const service = new ContextOSV2Service({ projectRoot: root });
  fs.writeFileSync(path.join(root, '.contextos', 'project.json'), JSON.stringify({ id: service.projectId, name: 'fixture-project' }));
  const now = new Date().toISOString();
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'entry.mjs'))).digest('hex').slice(0, 16);
  service.db.saveBlock({ id: 'block-entry', projectId: service.projectId, title: 'Entry function', kind: 'service', summary: 'Project entry',
    artifactRefs: [{ path: 'entry.mjs', anchorKind: 'file', startLine: 1, endLine: 1, hash }], history: [], createdAt: now, updatedAt: now });
  service.db.saveChain({ id: 'chain-entry', projectId: service.projectId, title: 'Entry feature', kind: 'feature',
    memberIds: ['block-entry'], metadata: {}, createdAt: now, updatedAt: now });
  service.syncEngine.publishIfDirty(service.projectId, root);
  return { root, service };
}

test('named graph navigation verifies exact source without API and rejects stale or unavailable anchors', async () => {
  const { root, service } = navigationFixture();
  const options = { projectRoot: root, profile: {}, transport: () => assert.fail('named graph must not request a model') };
  try {
    for (const input of [{ blockId: 'block-entry' }, { chainId: 'chain-entry' }]) {
      const result = await requestContextOS('ask', input, options);
      assert.equal(result.status, 'completed');
      assert.equal(result.accounting.transportInvocations, 0);
      assert.equal(result.records[0].text, 'export const entry = 1;\n');
      assert.equal(result.navigation.mode, 'exact');
    }
    fs.writeFileSync(path.join(root, 'entry.mjs'), 'export const replaced = 2;\n');
    const stale = await requestContextOS('ask', { blockId: 'block-entry' }, options);
    assert.equal(stale.status, 'partial');
    assert.equal(stale.records.length, 0);
    assert.match(JSON.stringify(stale.missing), /Stale graph anchor hash/);
    fs.unlinkSync(path.join(root, 'entry.mjs'));
    const absent = await requestContextOS('ask', { chainId: 'chain-entry' }, options);
    assert.equal(absent.records.length, 0);
    assert.equal(absent.status, 'partial');
    const unknown = await requestContextOS('ask', { blockId: 'missing-block' }, options);
    assert.equal(unknown.records.length, 0);
    assert.match(JSON.stringify(unknown.missing), /Unknown curated Block/);
    assert.equal((await requestContextOS('ask', { overview: true, blockId: 'block-entry' }, options)).errorCode, 'INVALID_PROJECT_OVERVIEW');
    assert.equal((await requestContextOS('ask', { blockId: 'block-entry', inspect: [] }, options)).errorCode, 'INVALID_GRAPH_NAVIGATION');
  } finally { service.db.close(); remove(root); }
});

test('graph candidates seed semantic retrieval and fixture reports actual navigation versus text exploration counters', async (t) => {
  const { root, service } = navigationFixture();
  const metrics = [];
  const options = { projectRoot: root, profile: { micro: { url: 'https://fixture.invalid', model: 'fixture-model' } } };
  try {
    let contextBytes = 0;
    const started = performance.now();
    const semantic = await requestContextOS('ask', { request: 'Locate the project entry declaration.' }, { ...options,
      transport: async (context) => {
        contextBytes += Buffer.byteLength(JSON.stringify(context), 'utf8');
        if (!context.toolResults.length) return { calls: [{ id: 'find', name: 'search', args: { queries: ['export const entry'], limit: 1 } }] };
        const record = context.toolResults[0].result.records[0];
        return { calls: [{ id: 'select', name: 'select', args: { refs: [record.ref], summary: 'Entry source' } }] };
      } });
    assert.equal(semantic.status, 'completed');
    metrics.push({ mode: 'text-semantic-exploration', modelRequests: semantic.accounting.transportInvocations,
      toolCalls: semantic.accounting.toolCalls, contextBytes, durationMs: performance.now() - started });
    const graphStart = performance.now();
    const graph = await requestContextOS('ask', { chainId: 'chain-entry' }, { ...options, transport: () => assert.fail('graph path must be deterministic') });
    assert.equal(graph.records[0].text, semantic.records[0].text);
    metrics.push({ mode: 'graph-navigation-inspect', modelRequests: graph.accounting.transportInvocations,
      toolCalls: graph.accounting.toolCalls, contextBytes: Buffer.byteLength(renderRequestResult(graph), 'utf8'),
      durationMs: performance.now() - graphStart });
    assert.deepEqual(metrics.map((row) => row.modelRequests), [2, 0]);
    let seen = 0;
    const seeded = await requestContextOS('ask', { request: 'Explain block-entry source' }, { ...options,
      transport: async (context) => {
        seen += 1;
        const input = JSON.parse(context.input);
        assert.equal(input.graph.records[0].text, graph.records[0].text);
        assert.deepEqual(input.graph.blockIds, ['block-entry']);
        return { calls: [{ id: 'select', name: 'select', args: { refs: [input.graph.records[0].ref], summary: 'Verified graph entry' } }] };
      } });
    assert.equal(seeded.status, 'completed');
    assert.equal(seeded.records[0].text, graph.records[0].text);
    assert.equal(seen, 1);
    t.diagnostic(JSON.stringify({ fixture: 'first-contact-graph-evidence', metrics }));
  } finally { service.db.close(); remove(root); }
});

test('public MCP named graph and batch owners work without semantic API configuration', async () => {
  const { root, service } = navigationFixture();
  service.db.close();
  const client = new Client({ name: 'graph-navigation-check', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/v3-server.mjs', import.meta.url))],
    env: { ...process.env, CONTEXTOS_DISABLE_API_MICRO: '1', CONTEXTOS_HOME: path.join(root, 'home') }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const graph = await client.callTool({ name: 'contextos', arguments: { action: 'ask', args: { chainId: 'chain-entry' }, projectRoot: root } });
    assert.equal(graph.structuredContent.status, 'completed');
    assert.equal(graph.structuredContent.navigation.mode, 'exact');
    assert.match(graph.content[0].text, /export const entry = 1/);
    const owners = await client.callTool({ name: 'contextos', arguments: { action: 'ops',
      args: { capability: 'block', action: 'owners', args: { paths: ['entry.mjs', 'README.md'], format: 'json' } }, projectRoot: root } });
    const text = owners.content[0].text;
    assert.match(text, /block-entry/);
    assert.match(text, /README.md/);
    assert.match(text, /missing/);
  } finally { await client.close(); remove(root); }
});


test('named graph uses canonical AST symbol hashes and current ranges while rejecting modified or missing symbols', async () => {
  const { root, service } = navigationFixture();
  const source = ['export const unrelated = 9;', '', 'export function launch() {', '  return "ready";', '}', ''].join('\n');
  fs.writeFileSync(path.join(root, 'entry.mjs'), source);
  const symbol = LanguageRegistry.parseStructure('entry.mjs', source).symbols.find((entry) => entry.name === 'launch');
  assert.ok(symbol);
  assert.notEqual(symbol.hash, crypto.createHash('sha256').update(source).digest('hex').slice(0, 16), 'fixture must distinguish symbol and file hashes');
  const block = service.db.getBlock('block-entry');
  service.db.saveBlock({ ...block, artifactRefs: [{ path: 'entry.mjs', symbol: 'entry.mjs#launch', anchorKind: 'symbol',
    startLine: symbol.startLine, endLine: symbol.endLine, hash: symbol.hash }] });
  service.syncEngine.publishIfDirty(service.projectId, root);
  const options = { projectRoot: root, profile: {}, transport: () => assert.fail('symbol navigation is deterministic') };
  try {
    const current = await requestContextOS('ask', { blockId: 'block-entry' }, options);
    assert.equal(current.status, 'completed');
    assert.equal(current.accounting.transportInvocations, 0);
    assert.deepEqual(current.records[0].ranges, [{ start: 3, end: 5 }]);
    assert.equal(current.records[0].text, 'export function launch() {\n  return "ready";\n}\n');
    fs.writeFileSync(path.join(root, 'entry.mjs'), '// relocated without changing the function\n' + source);
    const relocated = await requestContextOS('ask', { chainId: 'chain-entry' }, options);
    assert.equal(relocated.status, 'completed');
    assert.deepEqual(relocated.records[0].ranges, [{ start: 4, end: 6 }]);
    assert.equal(relocated.records[0].text, current.records[0].text);
    fs.writeFileSync(path.join(root, 'entry.mjs'), source.replace('"ready"', '"changed"'));
    const stale = await requestContextOS('ask', { blockId: 'block-entry' }, options);
    assert.equal(stale.status, 'partial');
    assert.equal(stale.records.length, 0);
    assert.match(JSON.stringify(stale.missing), /Stale graph symbol hash/);
    fs.writeFileSync(path.join(root, 'entry.mjs'), 'export const unrelated = 9;\n');
    const missing = await requestContextOS('ask', { blockId: 'block-entry' }, options);
    assert.equal(missing.status, 'partial');
    assert.equal(missing.records.length, 0);
    assert.match(JSON.stringify(missing.missing), /Missing symbol anchor/);
    const swift = ['#if os(macOS)', 'struct View {', ' let value = 1', '}', '#else', 'struct View {', ' let value = 2', '}', '#endif', ''].join('\n');
    fs.writeFileSync(path.join(root, 'View.swift'), swift);
    const branches = LanguageRegistry.parseStructure('View.swift', swift).symbols.filter((entry) => entry.name === 'View');
    assert.equal(branches.length, 2);
    const saved = branches[1];
    service.db.saveBlock({ ...block, artifactRefs: [{ path: 'View.swift', symbol: 'View', anchorKind: 'symbol',
      startLine: saved.startLine, endLine: saved.endLine, hash: saved.hash }] });
    service.syncEngine.publishIfDirty(service.projectId, root);
    const branch = await requestContextOS('ask', { blockId: 'block-entry' }, options);
    assert.equal(branch.status, 'completed');
    assert.deepEqual(branch.records[0].ranges, [{ start: 6, end: 8 }]);
    assert.equal(branch.records[0].text, 'struct View {\n let value = 2\n}\n');
    // Equal symbol hashes remain resolvable by the actual saved locator.
    fs.writeFileSync(path.join(root, 'View.swift'), swift.replace(' let value = 1', ' let value = 2'));
    const equal = await requestContextOS('ask', { blockId: 'block-entry' }, options);
    assert.equal(equal.status, 'completed');
    assert.deepEqual(equal.records[0].ranges, [{ start: 6, end: 8 }]);
  } finally { service.db.close(); remove(root); }
});


test('public MCP pipeline preserves ask graph, overview, source, artifact and semantic routes with truthful partial/failure states', async () => {
  const { root, service } = navigationFixture();
  service.db.close();
  let requests = 0;
  const mock = http.createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    requests += 1;
    const payload = JSON.parse(body);
    const input = payload.messages.map((message) => {
      try { return JSON.parse(message.content); } catch { return null; }
    }).find((value) => value?.request);
    const refs = input?.graph?.records || input?.known?.references || [];
    assert.equal(refs.length, 1, 'graph/known are delivered to the same public evidence broker');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
      id: 'select-' + requests, type: 'function', function: { name: 'select', arguments: JSON.stringify({ refs: [refs[0].ref], summary: 'Verified fixture source' }) },
    }] } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(root, '.contextos', 'profile.json'), JSON.stringify({ micro: {
    url: 'http://127.0.0.1:' + mock.address().port, model: 'local-fixture', key: 'fixture',
  } }));
  const client = new Client({ name: 'pipeline-public-ask', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/v3-server.mjs', import.meta.url))],
    env: { ...process.env, CONTEXTOS_HOME: path.join(root, 'home') }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const call = (action, args) => client.callTool({ name: 'contextos', arguments: { action, args, projectRoot: root } });
    const seed = await call('ask', { inspect: [{ path: 'entry.mjs', ranges: [[1, 1]] }] });
    const resultId = seed.structuredContent.resultId;
    const complete = await call('pipeline', { maxChars: 40000, steps: [
      { tool: 'ask', args: { overview: true } },
      { tool: 'ask', args: { blockId: 'block-entry' } },
      { tool: 'ask', args: { chainId: 'chain-entry' } },
      { tool: 'ask', args: { inspect: [{ path: 'entry.mjs', ranges: [[1, 1]] }] } },
      { tool: 'ask', args: { resultId, inspect: [{ path: 'entry.mjs', ranges: [[1, 1]] }] } },
      { tool: 'ask', args: { blockId: 'block-entry', request: 'Describe the entry' } },
      { tool: 'ask', args: { request: 'Reuse the verified entry', known: { refs: [{ resultId }] } } },
    ] });
    const text = complete.content[0].text;
    assert.match(text, /pipeline=OK actions=7 steps=7/);
    assert.match(text, /fixture-project/);
    assert.equal((text.match(/export const entry = 1/g) || []).length, 5);
    assert.match(text, /reused result=/);
    assert.doesNotMatch(text, /No target path/);
    assert.equal(requests, 2, 'only the two semantic asks launch a mock provider, once each');
    const deliveredId = text.match(/## Step 2: ask\n\nstatus=completed result=(result-[a-z0-9-]+)/)[1];
    const reusedPipeline = await call('ask', { request: 'Reuse pipeline source proof', known: { refs: [{ resultId: deliveredId }] } });
    assert.equal(reusedPipeline.structuredContent.status, 'completed');
    assert.match(reusedPipeline.content[0].text, /reused result=/);
    for (const group of ['steps', 'parallel', 'mode-parallel']) {
      const groupArgs = (steps) => group === 'mode-parallel' ? { mode: 'parallel', steps } : { [group]: steps };
      const partial = await call('pipeline', { maxChars: 12000, ...groupArgs([
        { tool: 'ask', args: { blockId: 'missing-block' } }, { tool: 'ask', args: { overview: true } },
      ]) });
      assert.match(partial.content[0].text, /pipeline=PARTIAL/);
      assert.match(partial.content[0].text, /Unknown curated Block/);
      assert.match(partial.content[0].text, /fixture-project/);
      assert.doesNotMatch(partial.content[0].text, /pipeline=HALTED|resume=/);
      const failed = await call('pipeline', { maxChars: 12000, ...groupArgs([
        { tool: 'ask', args: { overview: true, blockId: 'block-entry' } }, { tool: 'ask', args: { overview: true } },
      ]) });
      assert.match(failed.content[0].text, /pipeline=HALTED/);
      assert.match(failed.content[0].text, /INVALID_PROJECT_OVERVIEW/);
      if (group === 'steps') assert.doesNotMatch(failed.content[0].text, /fixture-project/);
    }
    const emptyAsk = await call('pipeline', { steps: [{ tool: 'ask', args: {} }, { tool: 'ask', args: { overview: true } }] });
    assert.match(emptyAsk.content[0].text, /pipeline=HALTED/);
    assert.match(emptyAsk.content[0].text, /status=failed/);
    assert.doesNotMatch(emptyAsk.content[0].text, /fixture-project/);
    const emptyInspect = await call('inspect', {});
    assert.match(emptyInspect.content[0].text, /status=failed error=INSPECT_TARGET_REQUIRED/);
    fs.writeFileSync(path.join(root, 'README.md'), '# Fixture\n' + 'Bounded source evidence.\n'.repeat(30));
    const displayPartial = await call('pipeline', { maxChars: 12000, steps: [
      { tool: 'ask', args: { inspect: [{ path: 'README.md' }], maxChars: 256 } },
      { tool: 'ask', args: { blockId: 'block-entry' } },
    ] });
    assert.match(displayPartial.content[0].text, /pipeline=PARTIAL/);
    assert.doesNotMatch(displayPartial.content[0].text, /pipeline=HALTED/);
    assert.match(displayPartial.content[0].text, /export const entry = 1/);
    const bounded = await call('pipeline', { maxChars: 256, steps: [
      { tool: 'ask', args: { inspect: [{ path: 'entry.mjs' }] } },
      { tool: 'ask', args: { overview: true } },
    ] });
    assert.match(bounded.content[0].text, /pipeline=PARTIAL/);
    assert.doesNotMatch(bounded.content[0].text, /pipeline=HALTED/);
    assert.equal(requests, 3, 'one additional semantic request verifies the pipeline delivery receipt; no duplicated dispatch');
  } finally {
    await client.close(); mock.closeAllConnections(); await new Promise((resolve) => mock.close(resolve)); remove(root);
  }
});

test('public graph navigation accepts real automatic file anchors at LF, CRLF and empty EOF boundaries', async () => {
  const root = fixture();
  const client = new Client({ name: 'graph-eof-check', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/v3-server.mjs', import.meta.url))],
    env: { ...process.env, CONTEXTOS_DISABLE_API_MICRO: '1', CONTEXTOS_HOME: path.join(root, 'home') }, stderr: 'pipe' });
  const sources = [
    { path: 'lf.mjs', content: 'export const pipelineReady = 42;\n' },
    { path: 'crlf.mjs', content: 'export const pipelineReady = 42;\r\n' },
    { path: 'no-eof.mjs', content: 'export const pipelineReady = 42;' },
    { path: 'empty.mjs', content: '' },
  ];
  try {
    await client.connect(transport);
    const call = (action, args) => client.callTool({ name: 'contextos', arguments: { action, args, projectRoot: root } });
    const changed = await call('change', { create: sources, architecture: { blocks: sources.map((source, index) => ({
      id: 'block-eof-' + index, title: 'EOF fixture ' + index, paths: [source.path],
    })) } });
    assert.match(changed.content[0].text, /"changed":true/);
    const owners = JSON.parse((await call('ops', { capability: 'block', action: 'owners', args: { paths: sources.map((source) => source.path), format: 'json' } })).content[0].text);
    assert.deepEqual(owners.missing, []);
    for (const [index, source] of sources.entries()) {
      const anchor = owners.items[index].owners[0].refs[0];
      assert.equal(anchor.anchorKind, 'file', 'the fixture must exercise actual automatic whole-file binding');
      assert.equal(anchor.startLine, 1);
      assert.equal(anchor.endLine, source.content.split(/\r?\n/).length);
      assert.equal(anchor.anchorStatus, 'fresh');
      const publicGraph = await call('ask', { blockId: 'block-eof-' + index });
      assert.equal(publicGraph.structuredContent.status, 'completed');
      const goal = await requestContextOS('ask', { onboard: { goal: source.path } }, { projectRoot: root, profile: {},
        transport: () => assert.fail('EOF onboarding must stay local') });
      assert.equal(goal.status, 'completed');
      assert.equal(goal.records[0].text, source.content);
      const graph = await requestContextOS('ask', { blockId: 'block-eof-' + index }, {
        projectRoot: root, profile: {}, transport: () => assert.fail('EOF graph navigation must stay deterministic'),
      });
      assert.equal(graph.status, 'completed');
      assert.equal(graph.accounting.transportInvocations, 0);
      assert.equal(graph.records.length, 1);
      assert.equal(graph.records[0].text, source.content, 'LF and CRLF source bytes must stay exact');
      assert.equal(graph.records[0].bytes, Buffer.byteLength(source.content));
      assert.deepEqual(graph.missing, []);
      assert.deepEqual(graph.notices || [], []);
    }
    const parallel = await call('pipeline', { mode: 'parallel', steps: sources.map((_, index) => ({ tool: 'ask', args: { blockId: 'block-eof-' + index } })) });
    assert.match(parallel.content[0].text, /pipeline=OK actions=4 steps=1/);
    assert.equal((parallel.content[0].text.match(/status=completed result=/g) || []).length, 4);
    assert.doesNotMatch(parallel.content[0].text, /Stale graph anchor range|after EOF|pipeline=PARTIAL/);
    fs.writeFileSync(path.join(root, 'lf.mjs'), 'export const changed = 9;\n');
    const stale = await call('ask', { blockId: 'block-eof-0' });
    assert.equal(stale.structuredContent.status, 'partial');
    assert.match(stale.content[0].text, /Stale graph anchor hash/);
    assert.doesNotMatch(stale.content[0].text, /export const changed = 9/);
  } finally { await client.close(); remove(root); }
});


async function realModuleIndexFixture() {
  const { root, service } = navigationFixture();
  const source = fs.readFileSync(fileURLToPath(new URL('../../orchestrator/src/module-index.mjs', import.meta.url)), 'utf8');
  const orchestrator = new Orchestrator({ projectRoot: root, service });
  await orchestrator.dispatch('change', { create: [{ path: 'src/module-index.mjs', content: source }],
    architecture: { blocks: [{ id: 'block-module-index', title: '导航索引', paths: ['src/module-index.mjs'] }],
      chains: [{ id: 'chain-intent-orchestration', title: '源码索引链', memberIds: ['block-module-index'] }] } });
  return { root, service, source };
}

test('goal onboarding matches actual ModuleIndex symbols and six automatic refs with bounded source delivery', async () => {
  const { root, service, source } = await realModuleIndexFixture();
  const options = { projectRoot: root, profile: {}, transport: () => assert.fail('goal onboarding must never launch a model') };
  try {
    const refs = service.db.getBlock('block-module-index').artifactRefs;
    assert.equal(refs.length, 6, 'use the current real ModuleIndex implementation, not a renamed fixture title');
    const onboard = await requestContextOS('ask', { onboard: { goal: 'ModuleIndex' } }, options);
    assert.equal(onboard.status, 'completed');
    assert.equal(onboard.navigation.selection.selected.id, 'block-module-index');
    assert.equal(onboard.navigation.selection.selected.title, '导航索引');
    assert.equal(onboard.navigation.selection.selected.matches[0].kind, 'symbol');
    assert.equal(onboard.navigation.selection.candidateCount, 1, 'member symbols do not become Chain candidates');
    assert.equal(onboard.records.length, 6);
    assert.deepEqual(onboard.records.map((record) => record.ranges), refs.map((ref) => [{ start: ref.startLine, end: ref.endLine }]));
    const classRecord = onboard.records.find((record) => record.text.includes('export class ModuleIndex'));
    assert.ok(classRecord);
    assert.ok(source.includes(classRecord.text));
    assert.deepEqual(onboard.owners.items.map((item) => [item.path, item.status, item.owners.map((owner) => owner.id)]),
      [['src/module-index.mjs', 'owned', ['block-module-index']]]);
    assert.deepEqual(onboard.navigation.relatedChains[0].memberIds, ['block-module-index']);
    assert.equal(onboard.lifecycle.modelRequests, 0);
    assert.equal(onboard.lifecycle.selectorRuns, 1);
    assert.deepEqual(onboard.lifecycle.evidencePrimitives, { overview: 1, graphEvidence: 1, owners: 1 });
    assert.equal(onboard.accounting.transportInvocations, 0);
    const held = [];
    const defaultText = renderRequestResult(onboard, { onSourceDelivered: (record) => held.push(record) });
    assert.match(defaultText, /^status=completed/);
    assert.ok(Array.from(defaultText).length <= 32000);
    assert.equal(held.length, 6);
    assert.match(defaultText, /owners=/);
    assert.match(defaultText, /relatedChains=/);
    const omitted = [];
    const short = renderRequestResult(onboard, { maxChars: 256, onSourceDelivered: (record) => omitted.push(record) });
    assert.match(short, /^status=partial/);
    assert.equal(omitted.length, 0);
    const unheld = await requestContextOS('ask', { resultId: onboard.resultId }, options);
    assert.deepEqual(unheld.sourceDelivery, []);
    assert.equal((await recordEvidenceDelivery(root, onboard.resultId, held)).recorded, true);
    const delivered = await requestContextOS('ask', { resultId: onboard.resultId }, options);
    assert.equal(delivered.sourceDelivery.length, 1);
    assert.equal(delivered.sourceDelivery[0].ranges.length, 6);
    for (const goal of ['block-module-index', '导航索引', 'moduleindex', 'src/module-index.mjs', './src/module-index.mjs',
      'src\\module-index.mjs', 'module-index.mjs', 'src/module-index.mjs#ModuleIndex']) {
      const alias = await requestContextOS('ask', { onboard: { goal } }, options);
      assert.equal(alias.status, 'completed', goal);
      assert.equal(alias.navigation.selection.selected.id, 'block-module-index');
    }
    const chain = await requestContextOS('ask', { onboard: { goal: '源码索引链' } }, options);
    assert.equal(chain.status, 'completed');
    assert.equal(chain.navigation.selection.selected.kind, 'chain');
    fs.writeFileSync(path.join(root, 'src/module-index.mjs'), source.replace('export class ModuleIndex', 'export class ChangedIndex'));
    const stale = await requestContextOS('ask', { onboard: { goal: 'ModuleIndex' } }, options);
    assert.equal(stale.status, 'partial');
    assert.match(JSON.stringify(stale.missing), /Missing symbol anchor|stale/i);
    assert.ok(!stale.records.some((record) => record.text.includes('export class ChangedIndex')));
  } finally { service.close(); remove(root); }
});

test('goal onboarding refuses ambiguous, unmatched, foreign or escaping evidence without graph bootstrap', async () => {
  const { root, service } = navigationFixture();
  const options = { projectRoot: root, profile: {}, transport: () => assert.fail('ambiguous goals do not invoke Micro') };
  try {
    const existing = service.db.getBlock('block-entry');
    service.db.saveBlock({ ...existing, id: 'block-other', title: 'Other actual entry' });
    service.syncEngine.publishIfDirty(service.projectId, root);
    const ambiguous = await requestContextOS('ask', { onboard: { goal: 'entry.mjs' } }, options);
    assert.equal(ambiguous.status, 'partial');
    assert.equal(ambiguous.navigation.selection.selected, null);
    assert.equal(ambiguous.navigation.selection.state, 'ambiguous');
    assert.equal(ambiguous.navigation.selection.candidateCount, 2);
    assert.deepEqual(ambiguous.records, []);
    assert.deepEqual(ambiguous.owners.items, []);
    const unmatched = await requestContextOS('ask', { onboard: { goal: 'Explain all entry behavior' } }, options);
    assert.equal(unmatched.status, 'partial');
    assert.equal(unmatched.navigation.selection.selected, null);
    assert.ok(unmatched.navigation.selection.candidates.every((candidate) => service.db.getBlock(candidate.id)));
    assert.equal(unmatched.lifecycle.modelRequests, 0);
    for (const input of [{ onboard: {} }, { onboard: { goal: '' } }, { onboard: { goal: 'entry.mjs', guess: true } },
      { onboard: { goal: 'entry.mjs' }, overview: true }, { onboard: { goal: 'entry.mjs' }, request: 'Explain' },
      { onboard: { goal: 'entry.mjs' }, inspect: [] }]) {
      assert.equal((await requestContextOS('ask', input, options)).errorCode, 'INVALID_GOAL_ONBOARDING');
    }
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'outside.mjs'), 'OUTSIDE_SOURCE_SECRET\n');
      fs.symlinkSync(path.join(outside, 'outside.mjs'), path.join(root, 'escape.mjs'));
      service.db.saveBlock({ ...existing, id: 'block-escape', title: 'Unsafe anchor',
        artifactRefs: [{ path: 'escape.mjs', anchorKind: 'file', startLine: 1, endLine: 2,
          hash: crypto.createHash('sha256').update('OUTSIDE_SOURCE_SECRET\n').digest('hex').slice(0, 16) }] });
      service.syncEngine.publishIfDirty(service.projectId, root);
      const escaped = await requestContextOS('ask', { onboard: { goal: 'Unsafe anchor' } }, options);
      assert.equal(escaped.status, 'partial');
      assert.deepEqual(escaped.records, []);
      assert.match(JSON.stringify(escaped.missing), /escapes workspace/);
      assert.doesNotMatch(renderRequestResult(escaped), /OUTSIDE_SOURCE_SECRET/);
      const unsafeGoal = await requestContextOS('ask', { onboard: { goal: '../outside.mjs' } }, options);
      assert.equal(unsafeGoal.navigation.selection.selected, null);
    } finally { remove(outside); }
    service.db.db.prepare('UPDATE projects SET repo_root=? WHERE id=?').run(path.join(root, 'foreign'), service.projectId);
    const foreign = await requestContextOS('ask', { onboard: { goal: 'entry.mjs' } }, options);
    assert.equal(foreign.status, 'partial');
    assert.deepEqual(foreign.records, []);
    assert.match(JSON.stringify(foreign.missing), /belongs to this workspace/);
  } finally { service.close(); remove(root); }
  const fresh = fixture();
  try {
    const noGraph = await requestContextOS('ask', { onboard: { goal: 'ModuleIndex' } }, { projectRoot: fresh, profile: {},
      transport: () => assert.fail('no graph must stay local') });
    assert.equal(noGraph.status, 'partial');
    assert.ok(noGraph.overview);
    assert.deepEqual(noGraph.records, []);
    assert.equal(fs.existsSync(path.join(fresh, '.contextos/state.sqlite')), false);
    assert.equal((await ask(fresh)).status, 'completed', 'ordinary overview remains compatible');
  } finally { remove(fresh); }
});

test('public stdio goal onboarding and its default pipeline deliver the actual six ranges in one call', async () => {
  const { root, service, source } = await realModuleIndexFixture();
  service.close();
  const client = new Client({ name: 'onboard-public-check', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/v3-server.mjs', import.meta.url))],
    env: { ...process.env, CONTEXTOS_DISABLE_API_MICRO: '1', CONTEXTOS_HOME: path.join(root, 'home') }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const call = (action, args) => client.callTool({ name: 'contextos', arguments: { action, args, projectRoot: root } });
    const result = await call('ask', { onboard: { goal: 'ModuleIndex' } });
    assert.equal(result.structuredContent.status, 'completed');
    assert.equal(result.structuredContent.navigation.selection.selected.id, 'block-module-index');
    assert.equal(result.structuredContent.sourceDelivery, 'recorded');
    assert.equal(result.structuredContent.lifecycle.modelRequests, 0);
    assert.equal(result.structuredContent.owners.items.length, 1);
    assert.match(result.content[0].text, /export class ModuleIndex/);
    assert.equal((result.content[0].text.match(/src\/module-index.mjs \[\{"start":/g) || []).length, 6);
    for (const shape of [
      { steps: [{ tool: 'ask', args: { onboard: { goal: 'ModuleIndex' } } }] },
      { mode: 'parallel', steps: [{ ask: { onboard: { goal: 'ModuleIndex' } } }] },
    ]) {
      const pipeline = await call('pipeline', shape);
      assert.match(pipeline.content[0].text, /pipeline=OK/);
      assert.equal((pipeline.content[0].text.match(/src\/module-index.mjs \[\{"start":/g) || []).length, 6);
      assert.doesNotMatch(pipeline.content[0].text, /response truncated|omitted details/);
      const resultId = pipeline.content[0].text.match(/status=completed result=(result-[a-z0-9-]+)/)[1];
      const recovered = await requestContextOS('ask', { resultId }, { projectRoot: root, profile: {} });
      assert.equal(recovered.sourceDelivery[0].ranges.length, 6, 'only the final complete host delivery acknowledges source');
    }
    const clipped = await call('ask', { onboard: { goal: 'ModuleIndex' }, maxChars: 256 });
    assert.equal(clipped.structuredContent.status, 'partial');
    assert.equal(clipped.structuredContent.accounting.renderedSourceBytes, 0);
    const unheld = await requestContextOS('ask', { resultId: clipped.structuredContent.resultId }, { projectRoot: root, profile: {} });
    assert.deepEqual(unheld.sourceDelivery, []);
    const childLimited = await call('pipeline', { steps: [{ tool: 'ask', args: { onboard: { goal: 'ModuleIndex' }, maxChars: 256 } }] });
    assert.match(childLimited.content[0].text, /pipeline=PARTIAL/);
    const outerLimited = await call('pipeline', { maxChars: 256, steps: [{ tool: 'ask', args: { onboard: { goal: 'ModuleIndex' } } }] });
    assert.match(outerLimited.content[0].text, /pipeline=PARTIAL/);
    assert.doesNotMatch(outerLimited.content[0].text, /pipeline=HALTED/);
    const noMatch = await call('ask', { onboard: { goal: 'Arbitrary natural-language project behavior' } });
    assert.equal(noMatch.structuredContent.status, 'partial');
    assert.ok(noMatch.structuredContent.navigation.selection.candidates.length);
    fs.writeFileSync(path.join(root, 'src/module-index.mjs'), source.replace('export class ModuleIndex', 'export class ChangedIndex'));
    const changed = await call('ask', { onboard: { goal: 'ModuleIndex' } });
    assert.equal(changed.structuredContent.status, 'partial');
    assert.doesNotMatch(changed.content[0].text, /export class ChangedIndex/);
  } finally { await client.close(); remove(root); }
});

test('chain goal onboarding returns a compact architecture card with member flow', async () => {
  const root = fixture();
  const service = new ContextOSV2Service({ projectRoot: root });
  const options = { projectRoot: root, profile: {}, transport: () => assert.fail('chain onboarding must stay local') };
  try {
    fs.writeFileSync(path.join(root, '.contextos', 'project.json'), JSON.stringify({ id: service.projectId, name: 'fixture-project' }));
    const now = new Date().toISOString();
    const anchor = (relative) => {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex').slice(0, 16);
      return [{ path: relative, anchorKind: 'file', startLine: 1, endLine: 1, hash }];
    };
    service.db.saveBlock({ id: 'block-entry', projectId: service.projectId, title: 'Entry function', kind: 'service', summary: 'Project entry',
      artifactRefs: anchor('entry.mjs'), history: [], createdAt: now, updatedAt: now });
    service.db.saveBlock({ id: 'block-child', projectId: service.projectId, title: 'Child package', kind: 'component', summary: 'Nested package',
      artifactRefs: anchor('packages/child/index.mjs'), history: [], createdAt: now, updatedAt: now });
    service.db.saveChain({ id: 'chain-entry-feature', projectId: service.projectId, title: 'Entry feature', kind: 'feature', summary: 'Entry and child package flow',
      memberIds: ['block-entry', 'block-child'], metadata: {}, createdAt: now, updatedAt: now });
    service.db.saveLink({ id: 'link-entry-child', projectId: service.projectId, from: 'block-entry', to: 'block-child', kind: 'calls',
      provenance: 'authored', confidence: 1, reason: 'entry imports child', createdAt: now, updatedAt: now });
    const onboard = await requestContextOS('ask', { onboard: { goal: 'Entry feature' } }, options);
    assert.equal(onboard.status, 'completed', JSON.stringify(onboard.missing));
    assert.equal(onboard.navigation.selection.selected.kind, 'chain');
    const card = onboard.navigation.chainArchitecture;
    assert.equal(card.id, 'chain-entry-feature');
    assert.equal(card.title, 'Entry feature');
    assert.equal(card.responsibility, 'Entry and child package flow');
    assert.equal(card.memberCount, 2);
    assert.deepEqual(card.members.map((member) => [member.id, member.kind, member.responsibility]),
      [['block-entry', 'service', 'Project entry'], ['block-child', 'component', 'Nested package']]);
    assert.deepEqual(card.internalFlow, [{ from: 'block-entry', to: 'block-child', kind: 'calls' }]);
    const text = renderRequestResult(onboard);
    assert.match(text, /chainArchitecture=chain-entry-feature "Entry feature" members=2/);
    assert.match(text, /member=block-entry "Entry function" kind=service responsibility=Project entry/);
    assert.match(text, /flow=block-entry -> block-child \(calls\)/);
  } finally { service.close(); remove(root); }
});

test('chain onboarding keeps the architecture card when member sources saturate the display budget', async () => {
  const root = fixture();
  const service = new ContextOSV2Service({ projectRoot: root });
  const options = { projectRoot: root, profile: {}, transport: () => assert.fail('chain onboarding must stay local') };
  try {
    fs.writeFileSync(path.join(root, '.contextos', 'project.json'), JSON.stringify({ id: service.projectId, name: 'fixture-project' }));
    const now = new Date().toISOString();
    const memberIds = [];
    for (let index = 0; index < 12; index += 1) {
      const relative = `src/bulk-${index}.mjs`;
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, relative), `export const value${index} = '${'x'.repeat(3000)}';\n`);
      const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex').slice(0, 16);
      const id = `block-bulk-${index}`;
      memberIds.push(id);
      service.db.saveBlock({ id, projectId: service.projectId, title: `Bulk ${index}`, kind: 'component', summary: `Bulk member ${index}`,
        artifactRefs: [{ path: relative, anchorKind: 'file', startLine: 1, endLine: 1, hash }], history: [], createdAt: now, updatedAt: now });
    }
    service.db.saveChain({ id: 'chain-bulk', projectId: service.projectId, title: 'Bulk chain', kind: 'feature', summary: 'Many member sources',
      memberIds, metadata: {}, createdAt: now, updatedAt: now });
    service.db.saveLink({ id: 'link-bulk-0-1', projectId: service.projectId, from: 'block-bulk-0', to: 'block-bulk-1', kind: 'calls',
      provenance: 'authored', confidence: 1, reason: 'bulk flow', createdAt: now, updatedAt: now });
    const onboard = await requestContextOS('ask', { onboard: { goal: 'chain-bulk' } }, options);
    const text = renderRequestResult(onboard);
    assert.ok(Array.from(text).length <= 32000);
    assert.match(text, /chainArchitecture=chain-bulk "Bulk chain" members=12/);
    assert.match(text, /member=block-bulk-0 "Bulk 0" kind=component responsibility=Bulk member 0/);
    assert.match(text, /flow=block-bulk-0 -> block-bulk-1 \(calls\)/);
    assert.match(text, /selection=/);
    assert.match(text, /owners=/);
  } finally { service.close(); remove(root); }
});
