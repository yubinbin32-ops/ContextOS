import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { loadMicroSkillGuidance, runMicroTask, runMicroTasksParallel } from '../src/micro-client.mjs';
import { selectMicroProvider } from '../src/micro-provider.mjs';
import { projectMicroResult, summarizeMicroUsage } from '../src/response-budget.mjs';
import { cliDoctor, normalizeCliUsage } from '../src/micro-cli.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-cli-test-'));
  const script = path.join(root, 'mock.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';
const mode=process.argv[3];
if(mode==='hang'||mode==='hangusage'){if(mode==='hangusage'){console.log(JSON.stringify({event:'step_update',step_update:{step_index:1,usage:{input_tokens:30,cache_read_tokens:120,output_tokens:5,thinking_tokens:2}}}));}setInterval(()=>{},1000);}else{
let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;const i=buffer.indexOf('\\n');if(i<0)return;
const task=JSON.parse(buffer.slice(0,i)).message.content;
fs.writeFileSync('received.json',JSON.stringify({args:process.argv.slice(2),task,workerRoot:process.env.CONTEXTOS_WORKER_ROOT,workerMode:process.env.CONTEXTOS_WORKER_MODE,microDisabled:process.env.CONTEXTOS_DISABLE_MICRO??null,apiBound:process.env.CONTEXTOS_API_MICRO_PROFILE?(()=>{const file=process.env.CONTEXTOS_API_MICRO_PROFILE;const api=JSON.parse(fs.readFileSync(file)).micro;return {model:api?.model,keyConfigured:!!api?.key,mode:fs.statSync(file).mode&0o777}})():null}));
console.log(JSON.stringify({event:'init',init:{model:mode==='mismatch'?'other':process.argv[2]}}));
if(mode==='missing'){process.exit(0);}
const report=mode==='reportsuccess'?JSON.stringify({summary:'read source',changes:[],checks:['ContextOS ask inspect'],blockers:[],question:null,needsHost:false}):null;
const result={conversation_id:'fixture-session',status:mode==='failed'?'ERROR':'SUCCESS',response:mode==='empty'?'':(report??'completed'),usage:{input_tokens:20,cache_read_tokens:80,output_tokens:10,thinking_tokens:4,total_tokens:30}};
if(mode==='denied')result.denied_actions=[{action:'command'}];
if(mode==='deniedos')result.denied_actions=[{action:'mcp',server:'contextos'}];
if(mode==='blocked')result.structured_output={blocked:true};
console.log(JSON.stringify({event:'progress',usage:{input_tokens:999999}}));
if(mode==='contextpercent'){
console.log(JSON.stringify({event:'step_update',step_update:{step_index:1,usage:{percent:60}}}));
console.log(JSON.stringify({event:'step_update',step_update:{step_index:2,usage:{percent:80}}}));
}else if(mode==='contextpercentused'){
console.log(JSON.stringify({event:'step_update',step_update:{step_index:1,usage:{percent:60,used_tokens:100}}}));
console.log(JSON.stringify({event:'step_update',step_update:{step_index:2,usage:{percent:60,used_tokens:120}}}));
}else if(mode==='contextpeak'){
console.log(JSON.stringify({event:'step_update',step_update:{step_index:1,usage:{input_tokens:30,cache_read_tokens:179970}}}));
console.log(JSON.stringify({event:'step_update',step_update:{step_index:2,usage:{input_tokens:20,cache_read_tokens:49980}}}));
}else{
console.log(JSON.stringify({event:'step_update',step_update:{step_index:1,usage:{input_tokens:20,cache_read_tokens:116480}}}));
}
console.log(JSON.stringify({event:'result',result}));
if(mode==='duplicate')console.log(JSON.stringify({event:'result',result}));
process.stdin.pause();process.exit(0);
});}
`);
  const config = mode => ({ provider: 'cli', model: 'fixture-model', thinking: 'high', timeoutMs: 3000,
    cli: { command: process.execPath, args: [script, '{model}', mode, '{thinking}'],
      input: { format: 'jsonl', template: { event: 'user', message: { content: '{task}' } }, keepOpen: true },
      output: { format: 'jsonl', terminal: { path: 'event', value: 'result' }, resultPath: 'result',
        contentPath: 'response', statusPath: 'status', successValues: ['SUCCESS'], modelPath: 'init.model', deniedPath: 'denied_actions', blockedPath: 'structured_output.blocked',
        usage: { path: 'usage', input: 'input_tokens', output: 'output_tokens', cache: 'cache_read_tokens', reasoning: 'thinking_tokens', inputIncludesCache: false, reasoningIncludedInOutput: true },
        contextUsage: { path: 'step_update.usage', percent: 'percent', used: 'used_tokens', input: 'input_tokens', cache: 'cache_read_tokens', window: 233000, inputIncludesCache: false } } } });
  return { root, config, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('CLI routes without API URL/key and injects a bounded assignment with exact model and worker scope', async () => {
  const f = fixture();
  try {
    const result = await runMicroTask(f.config('normal'), { projectRoot: f.root, task: 'Locate the failure', input: 'specific evidence',
      context: { allowedPaths: ['src/target.mjs'], acceptance: ['explain failure'], state: 'baseline failed',
        evidence: [{ resultId: 'result-parent-source', path: 'src/target.mjs', ranges: [[1, 2]] }] } });
    assert.equal(result.ok, true); assert.equal(result.actualModel, 'fixture-model');
    assert.equal(result.content, 'completed'); assert.equal(result.providerRequests, null);
    assert.equal(result.providerUsage.total_tokens, 110); assert.equal(result.providerUsage.uncached_input_tokens, 20);
    assert.equal(result.providerUsage.reasoning_tokens, 4);
    assert.equal(result.usageRaw.total_tokens, 30);
    assert.deepEqual(result.contextUsage, { percent: 50, usedTokens: 116500, windowTokens: 233000, source: 'derived' });
    const received = JSON.parse(fs.readFileSync(path.join(f.root, 'received.json')));
    assert.ok(received.task.includes('specific evidence')); assert.ok(received.task.includes('src/target.mjs'));
    assert.match(received.task, /Only text actually present in that body counts as supplied source/);
    assert.match(received.task, /evidence references and result IDs in the manifest are metadata/);
    assert.match(received.task, /contextos\(\{action:"ask",args:\{resultId:"result-\.\.\."/);
    assert.match(received.task, /Do not skip retrieval or claim known source solely because a parent or another thread received that result/);
    assert.equal(received.args.at(-1), 'high'); assert.equal(received.workerRoot, fs.realpathSync(f.root));
    assert.equal(received.workerMode, '1', 'the worker can call ask but cannot delegate another CLI task');
    assert.equal(received.microDisabled, null, 'API Micro stays available inside the CLI worker');
    assert.ok(fs.existsSync(path.join(f.root, result.logPath)));
    const projected = projectMicroResult(result, { projectRoot: f.root });
    assert.equal(projected.providerRequests, null);
    assert.deepEqual(projected.providerUsage, { promptTokens: 100, completionTokens: 10, totalTokens: 110, cachedInputTokens: 80, uncachedInputTokens: 20 });
    assert.equal(projected.invocation.providerRequests, null);
    assert.equal(projected.invocation.toolRounds, null);
    assert.equal(projected.invocation.toolCalls, null);
    const receipt = JSON.parse(fs.readFileSync(path.join(f.root, '.contextos', 'logs', 'micro-usage.jsonl'), 'utf8').trim());
    assert.equal(receipt.providerRequests, null);
    assert.equal(receipt.toolRounds, null);
    assert.equal(receipt.toolCallCount, null);
    assert.equal(receipt.steps, null);
    assert.equal(receipt.hostTurnsSaved, null);
    assert.equal(receipt.hostTurnsSavedEvidence, 'unknown');
    const summary = summarizeMicroUsage(f.root);
    assert.equal(summary.totalTokens, 110);
    assert.equal(summary.providerRequestsUnknownCalls, 1);
    assert.equal(summary.toolRoundsUnknownCalls, 1);
    assert.equal(summary.toolCallCountUnknownCalls, 1);
    assert.equal(summary.stepsUnknownCalls, 1);
    assert.equal(summary.hostTurnsSavedUnknownCalls, 1);
    assert.equal(summary.costUnknownCalls, 1);
    assert.equal(summary.estimatedCostUsd, null);

  } finally { f.cleanup(); }
});

test('CLI context usage reports the maximum observed request, not the last', async () => {
  const f = fixture();
  try {
    const result = await runMicroTask(f.config('contextpeak'), { projectRoot: f.root, task: 'bounded task' });
    assert.equal(result.ok, true);
    assert.equal(result.contextUsage.usedTokens, 180000);
    assert.equal(result.contextUsage.percent, 77.3);
  } finally { f.cleanup(); }
});

test('CLI context usage keeps the highest provider percent when usedTokens is absent', async () => {
  const f = fixture();
  try {
    const result = await runMicroTask(f.config('contextpercent'), { projectRoot: f.root, task: 'bounded task' });
    assert.equal(result.ok, true);
    assert.equal(result.contextUsage.percent, 80);
    assert.equal(result.contextUsage.usedTokens, null);
  } finally { f.cleanup(); }
});

test('CLI context usage prefers used tokens when provider percentages are rounded', async () => {
  const f = fixture();
  try {
    const result = await runMicroTask(f.config('contextpercentused'), { projectRoot: f.root, task: 'bounded task' });
    assert.equal(result.ok, true);
    assert.equal(result.contextUsage.percent, 60);
    assert.equal(result.contextUsage.usedTokens, 120);
  } finally { f.cleanup(); }
});

test('CLI adapters with an explicit OS call mapping receive core skill guidance', async () => {
  const f = fixture();
  try {
    const config = f.config('normal');
    config.cli.osInvocation = 'call_mcp_tool({"server":"contextos","tool":"contextos","arguments":{"action":"<action>","args":{},"projectRoot":"<workspace>"}})';
    const result = await runMicroTask(config, { projectRoot: f.root, task: 'bounded task' });
    assert.equal(result.ok, true);
    const received = JSON.parse(fs.readFileSync(path.join(f.root, 'received.json')));
    const canonicalGuidance = loadMicroSkillGuidance({ projectRoot: process.cwd() }).trim();
    assert.ok(received.task.includes(canonicalGuidance), 'CLI receives the same canonical skill bundle as micro');
    assert.match(received.task, /ContextOS is this project's required underlying development scaffold/);
    assert.match(received.task, /ContextOS operations skill guidance/);
  } finally { f.cleanup(); }
});

for (const [scenario, expected] of [['deniedos','CLI_PERMISSION_DENIED'], ['blocked','CLI_TASK_BLOCKED'], ['mismatch','CLI_MODEL_MISMATCH'], ['missing','CLI_TERMINAL_MISSING'], ['duplicate','CLI_TERMINAL_MISSING'], ['empty','CLI_EMPTY_RESULT'], ['failed','CLI_TASK_FAILED']]) {
  test(`CLI ${scenario} cannot become a successful receipt`, async () => {
    const f = fixture(); try { const result = await runMicroTask(f.config(scenario), { projectRoot: f.root, task: 'bounded task' });
      assert.equal(result.ok, false); assert.equal(result.errorCode, expected);
      if (scenario === 'deniedos') {
        assert.deepEqual(result.deniedActions, [{ action: 'mcp', server: 'contextos' }]);
        assert.match(result.error, /contextos/i);
      }
    } finally { f.cleanup(); }
  });
}

test('CLI native tool denial remains visible but does not fail a completed OS-backed task', async () => {
  const f = fixture();
  try {
    const result = await runMicroTask(f.config('denied'), { projectRoot: f.root, task: 'bounded task' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.deniedActions, [{ action: 'command' }]);
    assert.match(result.permissionWarning, /continued through ContextOS/);
  } finally { f.cleanup(); }
});

test('CLI rejects incomplete/oversized task inputs and unsafe implementation scope before spawning', async () => {
  const f = fixture(); try {
    for (const options of [ {task:'x',input:'z'.repeat(100),maxInputChars:10}, { task:'implement',execution:'implement' } ]) {
      const r = await runMicroTask(f.config('normal'), { projectRoot:f.root,...options }); assert.equal(r.ok,false);
    }
    assert.equal(fs.existsSync(path.join(f.root,'received.json')),false);
  } finally { f.cleanup(); }
});

test('CLI worker success keeps an explicit needsHost:false report instead of forcing host attention', async () => {
  const f = fixture();
  try {
    const result = await runMicroTask(f.config('reportsuccess'), {
      projectRoot: f.root, task: 'bounded read-only task', agentJobId: 'job-needs-host',
    });
    assert.equal(result.ok, true);
    assert.equal(result.needsHost, false, 'the worker explicitly reported no host attention needed');
    assert.equal(result.agentReport.summary, 'read source');
    assert.equal(result.agentReport.needsHost, false);
    assert.deepEqual(result.agentReport.checks, ['ContextOS ask inspect']);
    assert.match(result.content, /"summary":"read source"/, 'immediate delivery keeps the structured report content');
  } finally { f.cleanup(); }
});

test('CLI timeout and cancellation terminate the process and release the workspace', async () => {
  const f=fixture();try {
    const r=await runMicroTask(f.config('hang'),{projectRoot:f.root,task:'bounded task',timeoutMs:80}); assert.equal(r.errorCode,'CLI_TIMEOUT');
    const controller=new AbortController();controller.abort();
    const cancelled=await runMicroTask(f.config('hang'),{projectRoot:f.root,task:'bounded task',signal:controller.signal}); assert.equal(cancelled.errorCode,'MICRO_CANCELLED');
    const next=await runMicroTask(f.config('normal'),{projectRoot:f.root,task:'bounded task'});assert.equal(next.ok,true);
  }finally{f.cleanup();}
});

test('aborted CLI runs still account the partial stream usage', async () => {
  const f=fixture();try {
    const result=await runMicroTask(f.config('hangusage'),{projectRoot:f.root,task:'bounded task',timeoutMs:800});
    assert.equal(result.ok,false);assert.equal(result.errorCode,'CLI_TIMEOUT');
    assert.equal(result.partialUsage,true);
    assert.equal(result.providerUsage.uncached_input_tokens,30);
    assert.equal(result.providerUsage.cached_input_tokens,120);
    assert.equal(result.providerUsage.completion_tokens,5);
    assert.equal(result.usageRaw.input_tokens,30);
  }finally{f.cleanup();}
});

test('local CLI doctor does not launch a model; unknown cache semantics are rejected', () => {
  const f=fixture();try {
    assert.equal(cliDoctor(f.config('normal')).ok,true);assert.equal(fs.existsSync(path.join(f.root,'received.json')),false);
    const bad=f.config('normal');delete bad.cli.output.usage.inputIncludesCache;assert.equal(cliDoctor(bad).ok,false);
    assert.equal(normalizeCliUsage({i:4,o:3,c:8},{input:'i',output:'o',cache:'c',inputIncludesCache:true}),null);
    assert.deepEqual(normalizeCliUsage({i:10,o:4,c:8,r:2},{input:'i',output:'o',cache:'c',reasoning:'r',inputIncludesCache:true,reasoningIncludedInOutput:false}),
      {prompt_tokens:10,completion_tokens:6,total_tokens:16,cached_input_tokens:8,uncached_input_tokens:2,reasoning_tokens:2});
  }finally{f.cleanup();}
});

test('CLI batch defaults to serial execution in one workspace', async () => {
 const f=fixture();try {const r=await runMicroTasksParallel(f.config('normal'),[{task:'first'},{task:'second'}],{projectRoot:f.root});assert.equal(r.ok,true);assert.equal(r.tasks.length,2);}finally{f.cleanup();}
});

test('resumed cumulative usage is charged once and bound to the original task workspace', async () => {
  const f=fixture();try {
    const config=f.config('normal');config.cli.output.sessionPath='conversation_id';config.cli.output.usage.aggregation='session';config.cli.resumeArgs=['--conversation','{sessionId}'];
    const first=await runMicroTask(config,{projectRoot:f.root,task:'first task'});assert.equal(first.ok,true);
    const second=await runMicroTask(config,{projectRoot:f.root,task:'continue task',cliSessionId:first.cliSessionId});
    assert.equal(second.ok,true);assert.equal(second.providerUsage.total_tokens,0);assert.equal(second.cumulativeProviderUsage.total_tokens,110);
    const otherWorkspace=path.join(f.root,'other-workspace');fs.mkdirSync(otherWorkspace);
    const wrongWorkspace=await runMicroTask(config,{projectRoot:f.root,workspace:otherWorkspace,task:'continue',cliSessionId:first.cliSessionId});assert.equal(wrongWorkspace.errorCode,'CLI_RESUME_SCOPE_MISMATCH');
    config.cli.command='/bin/sh';
    const wrongCommand=await runMicroTask(config,{projectRoot:f.root,task:'continue',cliSessionId:first.cliSessionId});assert.equal(wrongCommand.errorCode,'CLI_RESUME_SCOPE_MISMATCH');
    config.cli.command=process.execPath;
    config.model='another-model';const wrong=await runMicroTask(config,{projectRoot:f.root,task:'continue',cliSessionId:first.cliSessionId});assert.equal(wrong.errorCode,'CLI_RESUME_SCOPE_MISMATCH');
  }finally{f.cleanup();}
});

test('CLI implementation fails closed without a real workspace diff', async () => {
  const f=fixture();
  try {
    const workspace=path.join(f.root,'implementation');fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace,'target.mjs'),'export const n=1;\n');
    const result=await runMicroTask(f.config('normal'),{
      projectRoot:f.root,workspace,execution:'implement',task:'Do not change anything',
      context:{allowedPaths:['target.mjs'],acceptance:['n remains 1']},
    });
    assert.equal(result.ok,false);
    assert.equal(result.errorCode,'MICRO_IMPLEMENTATION_NOT_APPLIED');
    assert.equal(result.implementationEvidence.applied,false);
    assert.deepEqual(result.implementationEvidence.changedPaths,[]);
  } finally { f.cleanup(); }
});

test('CLI continuation restores execution and allowedPaths from the retained session', async () => {
  const f=fixture();
  try {
    const workspace=path.join(f.root,'continuation');fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace,'first.mjs'),'export const first=1;\n');
    fs.writeFileSync(path.join(workspace,'second.mjs'),'export const second=1;\n');
    const config=f.config('normal');
    config.cli.output.sessionPath='conversation_id';config.cli.output.usage.aggregation='session';config.cli.resumeArgs=['--conversation','{sessionId}'];
    const script=config.cli.args[0];
    fs.writeFileSync(script, `import fs from 'node:fs';
let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;const i=buffer.indexOf('\\n');if(i<0)return;
 const task=JSON.parse(buffer.slice(0,i)).message.content;
 const first=task.includes('first turn');
 fs.writeFileSync(first?'first.mjs':'second.mjs',first?'export const first=2;\\n':'export const second=2;\\n');
 console.log(JSON.stringify({event:'init',init:{model:'fixture-model'}}));
 console.log(JSON.stringify({event:'result',result:{conversation_id:'fixture-session',model:'fixture-model',status:'SUCCESS',response:'changed',usage:{input_tokens:10,output_tokens:2}}}));
 process.stdin.pause();process.exit(0);
});`);
    const first=await runMicroTask(config,{projectRoot:f.root,workspace,execution:'implement',task:'first turn',
      withOS:true,context:{allowedPaths:['first.mjs','second.mjs'],acceptance:['both files change']}});
    assert.equal(first.ok,true,first.error);
    const second=await runMicroTask(config,{projectRoot:f.root,workspace,cliSessionId:first.cliSessionId,task:'continue second turn'});
    assert.equal(second.ok,true,second.error);
    assert.equal(second.executionMode,'cli-implementation');
    assert.equal(second.implementationEvidence.applied,true);
    assert.match(fs.readFileSync(path.join(workspace,'second.mjs'),'utf8'),/second=2/);
  } finally { f.cleanup(); }
});

test('both roles remain configured; explicit provider selection switches without fallback', async () => {
 const f=fixture();try {
  const config={...f.config('deniedos'),provider:'cli',url:'http://127.0.0.1:1',key:'test-key',};
  assert.equal(selectMicroProvider(config).provider,'cli');
  const result=await runMicroTask(config,{projectRoot:f.root,task:'bounded task'});
  assert.equal(result.errorCode,'CLI_PERMISSION_DENIED');assert.equal(result.provider,'cli');assert.equal(result.costEstimate.mainEquivalentTokens,148/7);
  config.provider='api';assert.equal(selectMicroProvider(config).provider,'api');assert.equal(config.cli.command,process.execPath);assert.equal(config.key,'test-key');
  config.provider='cli';config.cli.command='contextos-cli-does-not-exist';assert.equal(selectMicroProvider(config).provider,'cli','an explicit CLI selection never falls back to API');
  assert.equal(selectMicroProvider(config,{provider:'api'}).provider,'api');
  assert.equal(selectMicroProvider({url:'https://api.example.test',provider:'deepseek'}).provider,'api','a vendor label is not a role selector');
  assert.equal(selectMicroProvider({}, {provider:'other'}).ok, false);
 }finally{f.cleanup();}
});

test('lost worker log directory returns failure and stops the child instead of crashing the host', async () => {
 const f=fixture();try {
  const config=f.config('normal');
  fs.writeFileSync(config.cli.args[0],`import fs from 'node:fs';fs.rmSync('.contextos/micro-cli',{recursive:true,force:true});console.log(JSON.stringify({event:'init',init:{model:process.argv[2]}}));setInterval(()=>{},1000);`);
  const r=await runMicroTask(config,{projectRoot:f.root,task:'bounded task',timeoutMs:2000});assert.equal(r.errorCode,'CLI_LOG_UNAVAILABLE');assert.equal(r.ok,false);
 }finally{f.cleanup();}
});

 test('invalid model cannot create a resumable binding; session persistence failure retains usage', async () => {
 const f=fixture();try {
  const bad=f.config('mismatch');bad.cli.output.sessionPath='conversation_id';
  const mismatch=await runMicroTask(bad,{projectRoot:f.root,task:'bounded task'});
  assert.equal(mismatch.errorCode,'CLI_MODEL_MISMATCH');assert.equal(fs.existsSync(path.join(f.root,'.contextos/micro-cli/sessions')),false);
  fs.writeFileSync(path.join(f.root,'.contextos/micro-cli/sessions'),'blocked directory');
  const good=f.config('normal');good.cli.output.sessionPath='conversation_id';
  const result=await runMicroTask(good,{projectRoot:f.root,task:'bounded task'});
  assert.equal(result.errorCode,'CLI_SESSION_UNAVAILABLE');assert.equal(result.providerUsage.total_tokens,110);
 }finally{f.cleanup();}
 });

test('stream decoding preserves Unicode split across byte chunks', async () => {
 const f=fixture();try {
  const config=f.config('normal');
  fs.writeFileSync(config.cli.args[0], `process.stdin.once('data',()=>{
   console.log(JSON.stringify({event:'init',init:{model:process.argv[2]}}));
   const wire=Buffer.from(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'完成🙂'}})+'\\n');
   const split=wire.indexOf(Buffer.from('完成'))+1;
   process.stdout.write(wire.subarray(0,split));
   setTimeout(()=>{process.stdout.write(wire.subarray(split));process.stdin.pause();process.exit(0);},25);
  });`);
  const result=await runMicroTask(config,{projectRoot:f.root,task:'bounded task'});
  assert.equal(result.ok,true);assert.equal(result.content,'完成🙂');
 }finally{f.cleanup();}
});

test('explicit provider selection executes only the selected transport with its own model and weighted usage', async () => {
 const f=fixture(), requests=[];
 const server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
  requests.push(JSON.parse(body));res.setHeader('content-type','application/json');
  res.end(JSON.stringify({choices:[{message:{content:'API completed'}}],usage:{prompt_tokens:14,completion_tokens:7}}));
 });});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const config={...f.config('normal'),provider:'api',url:'http://127.0.0.1:'+server.address().port,model:'api-model',};
  config.cli.model='fixture-model';
  const api=await runMicroTask(config,{projectRoot:f.root,task:'bounded task',context:{allowedPaths:['src/target.mjs'],acceptance:['explain the defect'],state:'known failure'}});
  assert.equal(api.ok,true);assert.equal(api.provider,'api');assert.equal(api.costEstimate.mainEquivalentTokens,14);
  assert.equal(requests[0].model,'api-model');assert.ok(requests[0].messages.some(m=>m.content.includes('Task manifest:')&&m.content.includes('src/target.mjs')&&m.content.includes('known failure')));
  const rejected=await runMicroTask(config,{projectRoot:f.root,task:'implement',execution:'implement'});assert.equal(rejected.errorCode,'API_MICRO_IMPLEMENTATION_SCOPE_REQUIRED');assert.equal(rejected.invocation.providerLaunches,0);
  const commandAllowed=await runMicroTask(config,{projectRoot:f.root,task:'run a check',withOS:true,invocation:{tools:{enabled:true,allowCommands:true}}});
  assert.equal(commandAllowed.ok,true);assert.equal(requests.length,2);
  const oversized=await runMicroTask(config,{projectRoot:f.root,task:'bounded task',context:{state:'x'.repeat(20000)}});assert.equal(oversized.errorCode,'MICRO_CONTEXT_TOO_LARGE');assert.equal(requests.length,2);assert.equal(fs.existsSync(path.join(f.root,'received.json')),false);
  config.provider='cli';
  config.model='fixture-model';
  const cli=await runMicroTask(config,{projectRoot:f.root,task:'bounded task'});
  assert.equal(cli.ok,true);assert.equal(cli.actualModel,'fixture-model');assert.equal(cli.costEstimate.mainEquivalentTokens,148/7);
  assert.equal(requests.length,2,'switching to the CLI role never calls the API transport');
 }finally{await new Promise(resolve=>server.close(resolve));f.cleanup();}
});

test('API analyze tool loop rejects edit and command attempts without changing the workspace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-api-read-only-'));
  const target = path.join(root, 'target.mjs');
  const commandMarker = path.join(root, 'command-ran');
  fs.writeFileSync(target, 'export const n=1;\n');
  let requests = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests += 1;
      const toolArgs = requests === 1
        ? { action: 'change', args: { edits: [{ path: 'target.mjs', target: 'n=1', replacement: 'n=2' }] } }
        : { action: 'verify', args: { commands: [`touch "${commandMarker}"`] } };
      const message = requests <= 2
        ? { tool_calls: [{ id: `readonly-${requests}`, type: 'function', function: { name: 'os', arguments: JSON.stringify(toolArgs) } }] }
        : { content: 'Read-only review finished.' };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runMicroTask({ provider: 'api', url: `http://127.0.0.1:${server.address().port}`, model: 'fixture' }, {
      projectRoot: root, task: 'Review the source without changing files or running commands.', withOS: true,
      invocation: { tools: { enabled: true, maxSteps: 3 }, provider: { maxRequests: 3 } },
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(requests, 3);
    assert.match(fs.readFileSync(target, 'utf8'), /n=1/);
    assert.equal(fs.existsSync(commandMarker), false, 'analyze mode does not execute the returned shell command');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI evidence broker treats resultId-only task evidence as metadata and gives exact recovery', async () => {
  const f = fixture();
  try {
    const result = await runMicroTask(f.config('normal'), { projectRoot: f.root, task: 'Use existing evidence', agentJobId: 'assigned',
      evidenceBroker: true, apiMicro: { model: 'api-model', key: 'private-fixture-key' },
      context: { allowedPaths: [], acceptance: ['report'],
        evidence: [{ resultId: 'result-parent-only', path: 'src/target.mjs', ranges: [[1, 3]] }] } });
    assert.equal(result.ok, true, result.error);
    const received = JSON.parse(fs.readFileSync(path.join(f.root, 'received.json'), 'utf8'));
    assert.match(received.task, /action:"ask"/); assert.match(received.task, /use agent args=/);
    assert.match(received.task, /No source body was resolved from manifest evidence/);
    assert.match(received.task, /result IDs in the manifest are metadata only/);
    assert.match(received.task, /contextos\(\{action:"ask",args:\{resultId:"result-\.\.\."/);
    assert.match(received.task, /Do not skip retrieval or claim known source solely because a parent or another thread received that result/);
    assert.doesNotMatch(received.task, /Injected source\/preload is already available/);
    assert.ok(!received.task.includes('private-fixture-key'));
    assert.deepEqual(received.apiBound, { model: 'api-model', keyConfigured: true, mode: 0o600 });
    const jobDir = path.dirname(path.join(f.root, result.logPath));
    assert.equal(fs.existsSync(path.join(jobDir, 'api-role.json')), false);
  } finally { f.cleanup(); }
});
