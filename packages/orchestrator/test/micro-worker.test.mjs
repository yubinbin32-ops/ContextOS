import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { scheduleMicro } from '../src/micro-scheduler.mjs';
import { createMicroWorker } from '../src/micro-worker.mjs';
import { createMicroJob, readMicroJob } from '../src/micro-delivery.mjs';
import { sendMicroMessage, receiveMicroMessages, waitForMicroMessages } from '../src/micro-mailbox.mjs';
import { runMicroTask, runMicroTasksParallel, executeMicroTool } from '../src/micro-client.mjs';
import { ContextOSV2Service } from '../../mcp/src/v2-service.mjs';
import { Orchestrator } from '../src/index.mjs';

const originalHome = process.env.CONTEXTOS_HOME;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-child-test-'));
process.env.CONTEXTOS_HOME = path.join(root, 'global');
test.after(() => { if (originalHome === undefined) delete process.env.CONTEXTOS_HOME; else process.env.CONTEXTOS_HOME = originalHome; fs.rmSync(root, { recursive: true, force: true }); });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function directory(name) { const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true }); return dir; }
const owner = directory('host'), workspace = directory('child');

test('readers overlap, writers wait fairly, and independent workspaces overlap', async () => {
  const order = []; let readers = 0, peak = 0;
  const reader = () => { order.push('read'); peak = Math.max(peak, ++readers); return pause(25).then(() => { readers--; }); };
  const tasks = [scheduleMicro({ workspace }, reader), scheduleMicro({ workspace }, reader),
    scheduleMicro({ workspace, execution: 'implement' }, async () => { assert.equal(readers, 0); order.push('write'); await pause(25); }),
    scheduleMicro({ workspace }, async () => { order.push('after-write'); }),
    scheduleMicro({ workspace: owner, execution: 'implement' }, async () => { order.push('independent'); })];
  await Promise.all(tasks);
  assert.equal(peak, 2);
  assert.ok(order.indexOf('independent') < order.indexOf('write'));
  assert.ok(order.indexOf('after-write') > order.indexOf('write'));
});

test('cancelled queued jobs never call the provider or retain a scheduler slot', async () => {
  const controller = new AbortController(); let dispatched = false;
  const running = scheduleMicro({ workspace, execution: 'implement' }, () => pause(25));
  const queued = scheduleMicro({ workspace, signal: controller.signal }, () => { dispatched = true; });
  controller.abort(); const result = await queued; await running;
  assert.equal(dispatched, false); assert.equal(result.providerUsage.total_tokens, 0);
  assert.equal(result.providerUsageComplete, true);
  await scheduleMicro({ workspace }, () => {});
});

test('mailbox is ordered, private, one-time and bounded without dropping queued messages', () => {
  createMicroJob(owner, { jobId: 'inbox' });
  const a = sendMicroMessage(owner, 'inbox', 'use the corrected contract');
  const b = sendMicroMessage(owner, 'inbox', 'X'.repeat(2400));
  sendMicroMessage(owner, 'inbox', 'Y'.repeat(2400));
  assert.deepEqual(receiveMicroMessages(owner, 'inbox').map((item) => item.id), [a.messageId, b.messageId]);
  assert.equal(receiveMicroMessages(owner, 'inbox')[0].message.length, 2400);
  assert.deepEqual(receiveMicroMessages(owner, 'inbox'), []);
  assert.equal(fs.statSync(path.join(owner, '.contextos/micro-deliveries/inbox/inbox.json')).mode & 0o777, 0o600);
  assert.throws(() => sendMicroMessage(owner, '../invalid', 'x'), /Invalid/);
  assert.throws(() => sendMicroMessage(owner, 'inbox', 'x'.repeat(2401)), /2400/);
});
test('child waits for a host reply locally and cancellation retains future replies', async () => {
  createMicroJob(owner, { jobId: 'waiting' });
  const reply = waitForMicroMessages(owner, 'waiting', { waitMs: 1000 });
  setTimeout(() => sendMicroMessage(owner, 'waiting', 'continue with option A'), 20);
  assert.equal((await reply)[0].message, 'continue with option A');
  const controller = new AbortController();
  const cancelled = waitForMicroMessages(owner, 'waiting', { waitMs: 1000, signal: controller.signal });
  controller.abort(); assert.deepEqual(await cancelled, []);
  sendMicroMessage(owner, 'waiting', 'retained after cancellation');
  assert.equal(receiveMicroMessages(owner, 'waiting')[0].message, 'retained after cancellation');
});
test('API implementation can edit the current project through bounded change receipts', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'os-micro-direct-edit-'));
  fs.writeFileSync(path.join(project, 'target.mjs'), 'export const n=1;\n');
  try {
    const worker = await createMicroWorker({
      projectRoot: project,
      execution: 'implement',
      context: { allowedPaths: ['target.mjs'], acceptance: ['n becomes 2'] },
    });
    const changed = await worker.dispatch('change', {
      edits: [{ path: 'target.mjs', target: 'n=1', replacement: 'n=2' }],
      architecture: { blocks: [{ id: 'block-target', title: 'Target module', paths: ['target.mjs'] }] },
    });
    assert.doesNotMatch(changed, /Verdict: BLOCKED/);
    assert.match(fs.readFileSync(path.join(project, 'target.mjs'), 'utf8'), /n=2/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('API cached reads still receive host corrections without repeating repository reads', async () => {
  createMicroJob(owner, { jobId: 'cached-inbox' });
  let calls = 0, reads = 0, lastPayload;
  const server = http.createServer((req, res) => {
    let data = ''; req.on('data', (chunk) => { data += chunk; }); req.on('end', () => {
      calls++; lastPayload = JSON.parse(data);
      if (calls === 2) sendMicroMessage(owner, 'cached-inbox', 'corrected requirements');
      const message = calls < 3 ? { tool_calls: [{ id: `read-${calls}`, type: 'function', function: { name: 'os', arguments: '{"action":"inspect","args":{"path":"target.mjs"}}' } }] }
        : { content: '{"summary":"done","needsHost":false}' };
      res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
    });
  }); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runMicroTask({ url: `http://127.0.0.1:${server.address().port}`, model: 'local-test' }, { projectRoot: owner, task: 'bounded analysis', agentJobId: 'cached-inbox', withOS: true, maxSteps: 3, orchestrator: { dispatch: async () => { reads++; return 'source'; } } });
    assert.equal(result.ok, true, result.error); assert.equal(reads, 1);
    const reused = JSON.parse(lastPayload.messages.filter((message) => message.role === 'tool').at(-1).content);
    assert.equal(reused.deduplicated, true);
    assert.equal(reused.microMessages[0].message, 'corrected requirements');
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test('API workspace dispatch isolates edits, refuses path escapes and receives host messages', async () => {
  fs.writeFileSync(path.join(owner, 'target.mjs'), 'export const n=1;\n');
  fs.writeFileSync(path.join(workspace, 'target.mjs'), 'export const n=1;\n');
  createMicroJob(owner, { jobId: 'worker-mail' });
  sendMicroMessage(owner, 'worker-mail', 'n must be 2');
  const worker = await createMicroWorker({ projectRoot: owner, workspace, execution: 'implement', agentJobId: 'worker-mail', context: { allowedPaths: ['target.mjs'], acceptance: ['n becomes 2'] } });
  try {
    const result = JSON.parse(await worker.dispatch('inspect', { path: 'target.mjs', ranges: [[1, 1]] }));
    assert.equal(result.microMessages[0].message, 'n must be 2');
    assert.deepEqual(receiveMicroMessages(owner, 'worker-mail'), []);
    await assert.rejects(worker.dispatch('change', { create: [{ path: '../host/escape.mjs', content: 'x' }] }), /allowedPaths/);
    await assert.rejects(worker.dispatch('work', { path: '../host/target.mjs', target: 'n=1', replacement: 'n=999' }), /allowedPaths/);
    fs.symlinkSync(owner, path.join(workspace, 'escape'));
    await assert.rejects(worker.dispatch('change', { create: [{ path: 'escape/out.mjs', content: 'x' }] }), /allowedPaths/);
    const changed = await worker.dispatch('change', { edits: [{ path: 'target.mjs', target: 'n=1', replacement: 'n=2' }] });
    assert.doesNotMatch(changed, /Verdict: BLOCKED/);
    assert.match(fs.readFileSync(path.join(workspace, 'target.mjs'), 'utf8'), /n=2/);
    assert.match(fs.readFileSync(path.join(owner, 'target.mjs'), 'utf8'), /n=1/);
  } finally { worker.close(); }
});
test('compact OS aliases cannot bypass analysis or command permission checks', async () => {
  let dispatched = false;
  const options = { projectRoot: owner, dispatch: async () => { dispatched = true; }, allowCommands: false };
  for (const args of [
    { action: 'work', args: { path: 'target.mjs', target: 'n=1', replacement: 'n=999' } },
    { action: 'work', args: { commands: ['echo should-not-run'] } },
    { action: 'change', args: { edits: [{ path: 'target.mjs', target: 'n=1', replacement: 'n=2' }], verify: ['echo should-not-run'] } },
  ]) {
    const result = JSON.parse(await executeMicroTool('os', args, options));
    assert.ok(result.error);
  }
  const result = JSON.parse(await executeMicroTool('os', { action: 'change', args: { edits: [{ path: 'target.mjs', target: 'n=1', replacement: 'n=2' }], verify: ['echo should-not-run'] } }, { ...options, execution: 'implement' }));
  assert.match(result.error, /allowCommands/);
  assert.equal(dispatched, false);
});

test('API implementation runs bounded change and command tools through OS dispatch', async () => {
  const project = directory('api-main');
  fs.writeFileSync(path.join(project, 'target.mjs'), 'export const n=1;\n');
  const service = new ContextOSV2Service({ projectRoot: project, projectId: 'api-main' });
  const orchestrator = new Orchestrator({ service, projectRoot: project });
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      calls += 1;
      const args = calls === 1
        ? { action: 'change', args: { edits: [{ path: 'target.mjs', target: 'n=1', replacement: 'n=2' }], architecture: { blocks: [{ id: 'block-target', title: 'Target module', paths: ['target.mjs'] }] } } }
        : calls === 2
          ? { action: 'verify', args: { commands: ['node --check target.mjs && touch command-ran'] } }
          : null;
      const message = args
        ? { tool_calls: [{ id: `api-${calls}`, type: 'function', function: { name: 'os', arguments: JSON.stringify(args) } }] }
        : { content: JSON.stringify({ summary: 'changed', changes: ['target.mjs'], checks: ['node --check'], blockers: [], question: null, needsHost: false }) };
      res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runMicroTask({ url: `http://127.0.0.1:${server.address().port}`, model: 'local-test' }, {
      projectRoot: project, execution: 'implement', task: 'Change n to 2 and syntax check',
      context: { allowedPaths: ['target.mjs'], acceptance: ['n=2 and syntax check passes'] },
      withOS: true,
      invocation: { tools: { enabled: true, allowCommands: true, maxSteps: 4 }, provider: { maxRequests: 4 } },
      orchestrator,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(calls, 3);
    assert.equal(result.invocation.providerRequests, 3);
    assert.match(fs.readFileSync(path.join(project, 'target.mjs'), 'utf8'), /n=2/);
    assert.equal(fs.existsSync(path.join(project, 'command-ran')), true);
  } finally {
    service.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

function cliConfig() {
  const script = path.join(root, 'parallel-cli.mjs');
  fs.writeFileSync(script, `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const started=Date.now();setTimeout(()=>console.log(JSON.stringify({model:'local-cli',status:'OK',response:JSON.stringify({summary:'completed',started,ended:Date.now(),changes:['target.mjs'],checks:[],needsHost:true,transcript:'NEVER_RETURN_FLOW'.repeat(1000)}),usage:{input:10,output:5}})),180);});`);
  return { provider: 'cli', model: 'local-cli', cli: { command: process.execPath, args: [script, '{model}'], input: { format: 'text' }, output: { format: 'json', modelPath: 'model', contentPath: 'response', statusPath: 'status', successValues: ['OK'], usage: { path: 'usage', input: 'input', output: 'output', inputIncludesCache: true, reasoningIncludedInOutput: true } } } };
}
test('API total task time budget prevents further requests after slow tools', async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.resume(); req.on('end', () => { calls++; res.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'slow', type: 'function', function: { name: 'os', arguments: '{"action":"inspect","args":{"path":"target.mjs"}}' } }] } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runMicroTask({ url: `http://127.0.0.1:${server.address().port}`, model: 'local-test' }, { projectRoot: owner, task: 'read', withOS: true, taskTimeoutMs: 100, timeoutMs: 1000, orchestrator: { dispatch: async () => { await pause(150); return 'source'; } } });
    assert.equal(result.status, 'partial'); assert.equal(result.partial, true); assert.equal(result.errorCode, 'MICRO_CONTINUATION_REQUIRED'); assert.equal(calls, 1);
    assert.equal(result.providerUsage.total_tokens, 120);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
test('API implementation requires bounded paths, OS tools and a dispatcher before provider dispatch', async () => {
  const missingScope = await runMicroTask({ url: 'http://127.0.0.1:1', model: 'unused' }, { projectRoot: owner, execution: 'implement', task: 'edit', withOS: true, invocation: { tools: { enabled: true } } });
  assert.equal(missingScope.ok, false); assert.equal(missingScope.errorCode, 'API_MICRO_IMPLEMENTATION_SCOPE_REQUIRED');
  assert.equal(missingScope.invocation.providerLaunches, 0);
  const noTools = await runMicroTask({ url: 'http://127.0.0.1:1', model: 'unused' }, { projectRoot: owner, execution: 'implement', task: 'edit', withOS: false, context: { allowedPaths: ['target.mjs'] } });
  assert.equal(noTools.ok, false); assert.equal(noTools.errorCode, 'API_MICRO_TOOLS_REQUIRED');
  const noDispatcher = await runMicroTask({ url: 'http://127.0.0.1:1', model: 'unused' }, { projectRoot: owner, execution: 'implement', task: 'edit', withOS: true, context: { allowedPaths: ['target.mjs'] }, invocation: { tools: { enabled: true } } });
  assert.equal(noDispatcher.ok, false); assert.equal(noDispatcher.errorCode, 'API_MICRO_OS_DISPATCH_REQUIRED');
  assert.equal(noDispatcher.providerUsage, null);
});
test('CLI batch supports concurrency in the same read-only workspace', async () => {
  const result = await runMicroTasksParallel(cliConfig(), [{ task: 'first' }, { task: 'second' }], { projectRoot: owner, maxConcurrency: 2 });
  assert.equal(result.tasks.length, 2); assert.ok(result.tasks.every((item) => item.ok));
  // Both receipts exist; the CLI_BUSY failure/forced serial route is gone.
  assert.notEqual(result.tasks[0].jobId, result.tasks[1].jobId);
  const timings = result.tasks.map((task) => JSON.parse(task.content));
  assert.ok(Math.max(...timings.map((item) => item.started)) < Math.min(...timings.map((item) => item.ended)), 'CLI tasks must actually overlap');
});
test('API implementation fails closed when the provider reports success without a workspace diff', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'os-micro-noop-edit-'));
  fs.writeFileSync(path.join(project, 'target.mjs'), 'export const n=1;\n');
  const server = http.createServer((req, res) => {
    req.resume(); req.on('end', () => res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ summary: 'finished', changes: ['target.mjs'], needsHost: false }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runMicroTask({ url: `http://127.0.0.1:${server.address().port}`, model: 'local-test' }, {
      projectRoot: project, execution: 'implement', task: 'Claim a change without applying one',
      context: { allowedPaths: ['target.mjs'], acceptance: ['n changes'] }, withOS: true,
      invocation: { tools: { enabled: true, maxSteps: 2 }, provider: { maxRequests: 2 } },
      orchestrator: { dispatch: async () => 'unused' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'MICRO_IMPLEMENTATION_NOT_APPLIED');
    assert.equal(result.implementationEvidence.applied, false);
    assert.match(fs.readFileSync(path.join(project, 'target.mjs'), 'utf8'), /n=1/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('API continuation restores execution, allowedPaths, and command permission', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'os-micro-continuation-'));
  fs.writeFileSync(path.join(project, 'first.mjs'), 'export const first=1;\n');
  fs.writeFileSync(path.join(project, 'second.mjs'), 'export const second=1;\n');
  const service = new ContextOSV2Service({ projectRoot: project, projectId: 'api-continuation' });
  const orchestrator = new Orchestrator({ service, projectRoot: project });
  const dispatch = orchestrator.dispatch.bind(orchestrator);
  let verifyCalls = 0;
  let continuationManifestOk = false;
  let request = 0;
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      request += 1;
      let message;
      if (request === 1) {
        message = { tool_calls: [{ id: 'first-change', type: 'function', function: { name: 'os', arguments: JSON.stringify({ action: 'change', args: { edits: [{ path: 'first.mjs', target: 'first=1', replacement: 'first=2' }] } }) } }] };
      } else if (request === 2) {
        message = { content: JSON.stringify({ summary: 'first turn complete', changes: ['first.mjs'], needsHost: true }) };
      } else if (request === 3) {
        const payload = JSON.parse(data);
        const manifest = payload.messages.map((entry) => entry.content || '').join('\n');
        continuationManifestOk = /"execution":"implement"/.test(manifest)
          && /"allowedPaths":\[[^\]]*"first\.mjs"[^\]]*"second\.mjs"/.test(manifest);
        message = { tool_calls: [{ id: 'second-verify', type: 'function', function: { name: 'os', arguments: JSON.stringify({ action: 'verify', args: { commands: ['node --check first.mjs && node --check second.mjs'] } }) } }] };
      } else if (request === 4) {
        message = { tool_calls: [{ id: 'second-change', type: 'function', function: { name: 'os', arguments: JSON.stringify({ action: 'change', args: { edits: [{ path: 'second.mjs', target: 'second=1', replacement: 'second=2' }] } }) } }] };
      } else {
        message = { content: JSON.stringify({ summary: 'second turn complete', changes: ['second.mjs'], needsHost: false }) };
      }
      res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const config = { url: `http://127.0.0.1:${server.address().port}`, model: 'local-test' };
    const first = await runMicroTask(config, {
      projectRoot: project, execution: 'implement', task: 'Change the first file', withOS: true,
      context: { allowedPaths: ['first.mjs', 'second.mjs'], acceptance: ['both files can change'] },
      invocation: { tools: { enabled: true, allowCommands: true, maxSteps: 4 }, provider: { maxRequests: 4 } },
      orchestrator: { dispatch: async (action, args) => { if (action === 'verify') verifyCalls += 1; return dispatch(action, args); } },
    });
    assert.equal(first.ok, true, first.error);
    const second = await runMicroTask(config, {
      projectRoot: project, sessionId: first.sessionId, task: 'Continue and change the second file',
      orchestrator: { dispatch: async (action, args) => { if (action === 'verify') verifyCalls += 1; return dispatch(action, args); } },
    });
    assert.equal(second.ok, true, second.error);
    assert.equal(second.executionMode, 'executor');
    assert.equal(verifyCalls, 1, 'allowCommands survives the continuation');
    assert.match(fs.readFileSync(path.join(project, 'first.mjs'), 'utf8'), /first=2/);
    assert.match(fs.readFileSync(path.join(project, 'second.mjs'), 'utf8'), /second=2/);
    assert.equal(continuationManifestOk, true);
  } finally {
    service.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('a CLI child receives host messages through real MCP and reports without exposing its flow', async () => {
  const child = directory('cli-mcp-child'); fs.writeFileSync(path.join(child, 'target.mjs'), 'export const n=2;');
  const script = path.join(root, 'cli-mcp-worker.mjs');
  const serverModule = new URL('../../mcp/src/v3-server.mjs', import.meta.url).href;
  fs.writeFileSync(script, `import {Client} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'))};
import {InMemoryTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/inMemory.js'))};
import {createV3Server} from ${JSON.stringify(serverModule)};
process.stdin.resume(); process.stdin.on('end',async()=>{
 const server=createV3Server(),client=new Client({name:'child-fixture',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();await Promise.all([client.connect(a),server.connect(b)]);
 const call=async(action,args)=>(await client.callTool({name:'contextos',arguments:{action,args,projectRoot:process.env.CONTEXTOS_WORKER_ROOT}})).content[0].text;
 const evidence=JSON.parse(await call('inspect',{path:'target.mjs',ranges:[[1,1]]}));
 const reply=evidence.microMessages?.[0]?.message;
 const report={summary:reply,checks:['source read completed'],question:'Need host review?',needsHost:true};
 await call('micro',{action:'report',jobId:process.env.CONTEXTOS_MICRO_REPORT_JOB,content:JSON.stringify(report)});
 const guard=await call('micro',{action:'messages',jobId:'wrong-job'});
 await client.close();await server.close();
 console.log(JSON.stringify({model:'local-cli',status:reply==='use corrected requirements'&&/assigned job/.test(guard)?'OK':'FAILED',response:JSON.stringify(report),usage:{input:10,output:5}}));process.exit(0);
});`);
  createMicroJob(owner, { jobId: 'cli-message' });
  sendMicroMessage(owner, 'cli-message', 'use corrected requirements');
  const config = cliConfig(); config.cli.args = [script, '{model}'];
  const result = await runMicroTask(config, { projectRoot: owner, workspace: child, task: 'Read the assigned file and receive the host correction.', agentJobId: 'cli-message', timeoutMs: 4000 });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.agentReport.summary, 'use corrected requirements');
  assert.deepEqual(receiveMicroMessages(owner, 'cli-message'), []);
});
test('background batch returns IDs, host sends messages, and queries expose structured reports without flow', async () => {
  const host = directory('background-host'); fs.mkdirSync(path.join(host, '.contextos'));
  fs.writeFileSync(path.join(host, '.contextos/profile.json'), JSON.stringify({ micro: cliConfig() }));
  const service = new ContextOSV2Service({ projectRoot: host, projectId: 'worker-test' });
  const orchestrator = new Orchestrator({ service, projectRoot: host });
  const call = (action, args = {}) => orchestrator.dispatch('ops', { capability: 'micro', action, args });
  try {
    const jobs = JSON.parse(await call('batch', { background: true, maxConcurrency: 2, tasks: [{ task: 'first' }, { task: 'second' }] })).tasks;
    assert.ok(jobs.every((job) => job.delivery === 'running'));
    assert.ok(JSON.parse(await call('send', { jobId: jobs[0].jobId, message: 'follow the supplied contract' })).queued);
    const deadline = Date.now() + 4000;
    while (jobs.some((job) => readMicroJob(host, job.jobId)?.status === 'running') && Date.now() < deadline) await pause(10);
    const queried = JSON.parse(await call('get', { jobId: jobs[0].jobId }));
    assert.deepEqual(queried.job.report.changes, ['target.mjs']);
    assert.equal(queried.job.result, undefined);
    assert.ok(queried.microRecovered?.length);
    assert.match(JSON.stringify(queried.microRecovered), /completed/);
    assert.doesNotMatch(JSON.stringify(queried), /NEVER_RETURN_FLOW/);
    assert.doesNotMatch(await orchestrator.dispatch('ops', { capability: 'profile', action: 'show' }), /microRecovered/);
  } finally { service.close(); }
});
