import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { runMicroTask, runMicroTasksParallel } from '../src/micro-client.mjs';
import { selectMicroProvider } from '../src/micro-provider.mjs';
import { projectMicroResult, summarizeMicroUsage } from '../src/response-budget.mjs';
import { cliDoctor, normalizeCliUsage } from '../src/micro-cli.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-cli-test-'));
  const script = path.join(root, 'mock.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';
const mode=process.argv[3];
if(mode==='hang'){setInterval(()=>{},1000);}else{
let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;const i=buffer.indexOf('\\n');if(i<0)return;
const task=JSON.parse(buffer.slice(0,i)).message.content;
fs.writeFileSync('received.json',JSON.stringify({args:process.argv.slice(2),task,workerRoot:process.env.CONTEXTOS_WORKER_ROOT,nested:process.env.CONTEXTOS_DISABLE_MICRO}));
console.log(JSON.stringify({event:'init',init:{model:mode==='mismatch'?'other':process.argv[2]}}));
if(mode==='missing'){process.exit(0);}
const result={conversation_id:'fixture-session',status:mode==='failed'?'ERROR':'SUCCESS',response:mode==='empty'?'':'completed',usage:{input_tokens:20,cache_read_tokens:80,output_tokens:10,thinking_tokens:4,total_tokens:30}};
if(mode==='denied')result.denied_actions=[{action:'command'}];
if(mode==='blocked')result.structured_output={blocked:true};
console.log(JSON.stringify({event:'progress',usage:{input_tokens:999999}}));
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
        usage: { path: 'usage', input: 'input_tokens', output: 'output_tokens', cache: 'cache_read_tokens', reasoning: 'thinking_tokens', inputIncludesCache: false, reasoningIncludedInOutput: true } } } });
  return { root, config, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('CLI routes without API URL/key and injects a bounded assignment with exact model and worker scope', async () => {
  const f = fixture();
  try {
    const result = await runMicroTask(f.config('normal'), { projectRoot: f.root, task: 'Locate the failure', input: 'specific evidence',
      context: { allowedPaths: ['src/target.mjs'], acceptance: ['explain failure'], state: 'baseline failed' } });
    assert.equal(result.ok, true); assert.equal(result.actualModel, 'fixture-model');
    assert.equal(result.content, 'completed'); assert.equal(result.providerRequests, null);
    assert.equal(result.providerUsage.total_tokens, 110); assert.equal(result.providerUsage.uncached_input_tokens, 20);
    assert.equal(result.providerUsage.reasoning_tokens, 4);
    assert.equal(result.usageRaw.total_tokens, 30);
    const received = JSON.parse(fs.readFileSync(path.join(f.root, 'received.json')));
    assert.ok(received.task.includes('specific evidence')); assert.ok(received.task.includes('src/target.mjs'));
    assert.equal(received.args.at(-1), 'high'); assert.equal(received.workerRoot, fs.realpathSync(f.root)); assert.equal(received.nested, '1');
    assert.ok(fs.existsSync(path.join(f.root, result.logPath)));
    const projected = projectMicroResult(result, { projectRoot: f.root });
    assert.equal(projected.providerRequests, null);
    const summary = summarizeMicroUsage(f.root);
    assert.equal(summary.totalTokens, 110);
    assert.equal(summary.providerRequestsUnknownCalls, 1);
    assert.equal(summary.costUnknownCalls, 1);
    assert.equal(summary.estimatedCostUsd, null);

  } finally { f.cleanup(); }
});

for (const [scenario, expected] of [['denied','CLI_PERMISSION_DENIED'], ['blocked','CLI_TASK_BLOCKED'], ['mismatch','CLI_MODEL_MISMATCH'], ['missing','CLI_TERMINAL_MISSING'], ['duplicate','CLI_TERMINAL_MISSING'], ['empty','CLI_EMPTY_RESULT'], ['failed','CLI_TASK_FAILED']]) {
  test(`CLI ${scenario} cannot become a successful receipt`, async () => {
    const f = fixture(); try { const result = await runMicroTask(f.config(scenario), { projectRoot: f.root, task: 'bounded task' });
      assert.equal(result.ok, false); assert.equal(result.errorCode, expected);
    } finally { f.cleanup(); }
  });
}

test('CLI rejects incomplete/oversized task inputs and unsafe implementation scope before spawning', async () => {
  const f = fixture(); try {
    for (const options of [ {task:'x',input:'z'.repeat(100),maxInputChars:10}, { task:'implement',execution:'implement' } ]) {
      const r = await runMicroTask(f.config('normal'), { projectRoot:f.root,...options }); assert.equal(r.ok,false);
    }
    assert.equal(fs.existsSync(path.join(f.root,'received.json')),false);
  } finally { f.cleanup(); }
});

test('CLI timeout and cancellation terminate the process and release the workspace', async () => {
  const f=fixture();try {
    const r=await runMicroTask(f.config('hang'),{projectRoot:f.root,task:'bounded task',timeoutMs:80}); assert.equal(r.errorCode,'CLI_TIMEOUT');
    const controller=new AbortController();controller.abort();
    const cancelled=await runMicroTask(f.config('hang'),{projectRoot:f.root,task:'bounded task',signal:controller.signal}); assert.equal(cancelled.errorCode,'CLI_CANCELLED');
    const next=await runMicroTask(f.config('normal'),{projectRoot:f.root,task:'bounded task'});assert.equal(next.ok,true);
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
    config.model='another-model';const wrong=await runMicroTask(config,{projectRoot:f.root,task:'continue',cliSessionId:first.cliSessionId});assert.equal(wrong.errorCode,'CLI_RESUME_SCOPE_MISMATCH');
  }finally{f.cleanup();}
});

test('both providers remain configured; priority can switch and CLI failures do not call API', async () => {
 const f=fixture();try {
  const config={...f.config('denied'),priority:'cli-first',url:'http://127.0.0.1:1',key:'test-key',cost:{tokenDivisor:7}};
  assert.equal(selectMicroProvider(config).provider,'cli');
  const result=await runMicroTask(config,{projectRoot:f.root,task:'bounded task'});
  assert.equal(result.errorCode,'CLI_PERMISSION_DENIED');assert.equal(result.provider,'cli');assert.equal(result.costEstimate.mainEquivalentTokens,110/7);
  config.priority='api-first';assert.equal(selectMicroProvider(config).provider,'api');assert.equal(config.cli.command,process.execPath);assert.equal(config.key,'test-key');
  config.priority='cli-first';config.cli.command='contextos-cli-does-not-exist';assert.equal(selectMicroProvider(config).provider,'api');
  assert.equal(selectMicroProvider(config,{provider:'cli'}).provider,'cli');
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

test('switching priority executes only the selected transport with its own model and weighted usage', async () => {
 const f=fixture(), requests=[];
 const server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
  requests.push(JSON.parse(body));res.setHeader('content-type','application/json');
  res.end(JSON.stringify({choices:[{message:{content:'API completed'}}],usage:{prompt_tokens:14,completion_tokens:7}}));
 });});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const config={...f.config('normal'),priority:'api-first',cost:{tokenDivisor:7},api:{url:'http://127.0.0.1:'+server.address().port,model:'api-model'}};
  config.cli.model='fixture-model';
  const api=await runMicroTask(config,{projectRoot:f.root,task:'bounded task',context:{allowedPaths:['src/target.mjs'],acceptance:['explain the defect'],state:'known failure'}});
  assert.equal(api.ok,true);assert.equal(api.provider,'api');assert.equal(api.costEstimate.mainEquivalentTokens,3);
  assert.equal(requests[0].model,'api-model');assert.ok(requests[0].messages.some(m=>m.content.includes('Task manifest:')&&m.content.includes('src/target.mjs')&&m.content.includes('known failure')));
  const rejected=await runMicroTask(config,{projectRoot:f.root,task:'implement',execution:'implement'});assert.equal(rejected.errorCode,'MICRO_API_IMPLEMENTATION_UNSUPPORTED');
  const oversized=await runMicroTask(config,{projectRoot:f.root,task:'bounded task',context:{state:'x'.repeat(20000)}});assert.equal(oversized.errorCode,'MICRO_CONTEXT_TOO_LARGE');assert.equal(requests.length,1);assert.equal(fs.existsSync(path.join(f.root,'received.json')),false);
  config.priority='cli-first';
  const cli=await runMicroTask(config,{projectRoot:f.root,task:'bounded task'});
  assert.equal(cli.ok,true);assert.equal(cli.actualModel,'fixture-model');assert.equal(cli.costEstimate.mainEquivalentTokens,110/7);
  assert.equal(requests.length,1);assert.equal(config.api.model,'api-model');
 }finally{await new Promise(resolve=>server.close(resolve));f.cleanup();}
});
