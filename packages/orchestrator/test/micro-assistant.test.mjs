import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ContextOSV2Service } from '../../mcp/src/v2-service.mjs';
import { createV3Server } from '../../mcp/src/v3-server.mjs';
import { Orchestrator } from '../src/index.mjs';
import { createMicroJob, readMicroJob, reportMicroJob, claimMicroDeliveries } from '../src/micro-delivery.mjs';
import { projectMicroResult, summarizeMicroUsage } from '../src/response-budget.mjs';
import { runMicroTask } from '../src/micro-client.mjs';
import { readArtifact } from '../src/artifact-store.mjs';
import { parseMicroRouting } from '../src/micro-reporting.mjs';

const originalHome = process.env.CONTEXTOS_HOME;
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-assistant-global-'));
process.env.CONTEXTOS_HOME = isolatedHome;
test.after(() => { if (originalHome === undefined) delete process.env.CONTEXTOS_HOME; else process.env.CONTEXTOS_HOME = originalHome; fs.rmSync(isolatedHome, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-assistant-'));
  fs.mkdirSync(path.join(root, '.contextos'));
  const script = path.join(root, 'worker.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';
let task='';process.stdin.on('data',c=>task+=c);process.stdin.on('end',()=>{
const mode=process.argv[2];
// Install the SIGTERM handler before the file the test waits on appears:
// otherwise an abort can land in the gap and kill the fake CLI before it can
// report its terminal usage, which made the cancellation test flaky.
if(mode==='cancel-usage')process.on('SIGTERM',()=>{console.log(JSON.stringify({model:'assistant-test',status:'FAILED',response:'cancelled',usage:{input:100,output:20}}));process.exit(0);});
fs.writeFileSync('assignment.txt',task);
if(mode==='hang'||mode==='cancel-usage'){setInterval(()=>{},1000);return;}
setTimeout(()=>{console.log(JSON.stringify({model:'assistant-test',status:mode==='fail'?'FAILED':'OK',response:mode==='plain'?'unmapped answer':JSON.stringify({needsHost:mode!=='quiet',hostReason:'review finding',answer:mode==='quiet'?'':'negative totals need a regression test'}),usage:{input:100,output:20}}));},80);
});`);
  const config = mode => ({ provider:'cli',model:'assistant-test',timeoutMs:3000,
    cli:{command:process.execPath,args:[script,mode,'{model}'],input:{format:'text'},output:{format:'json',modelPath:'model',contentPath:'response',statusPath:'status',successValues:['OK'],usage:{path:'usage',input:'input',output:'output',inputIncludesCache:true,reasoningIncludedInOutput:true}}} });
  const configure = mode => fs.writeFileSync(path.join(root,'.contextos/profile.json'),JSON.stringify({verify:[],micro:config(mode)}));
  const service = new ContextOSV2Service({projectRoot:root,projectId:'assistant-test'});
  const orchestrator = new Orchestrator({projectRoot:root,projectId:'assistant-test',service});
  const call = async (action,args={}) => JSON.parse(await orchestrator.dispatch('ops',{capability:'micro',action,args}));
  return {root,config,configure,orchestrator,call,cleanup:()=>{service.close();fs.rmSync(root,{recursive:true,force:true});}};
}
async function terminal(root,id) {
  const deadline=Date.now()+3000;
  while(Date.now()<deadline){const job=readMicroJob(root,id);if(job.status!=='running')return job;await new Promise(r=>setTimeout(r,20));}
  throw new Error('task did not terminate');
}
const hostCall = f => f.orchestrator.dispatch('ops',{capability:'profile',action:'show',args:{maxChars:500}});

test('background CLI defaults to auto, stays quiet while running and hides independent success',async()=>{
  const f=fixture();f.configure('quiet');
  try{
    const launch=await f.call('run',{background:true,jobId:'quiet',task:'bounded review'});
    assert.equal(launch.delivery,'running');assert.equal(launch.jobId,'quiet');
    assert.doesNotMatch(await hostCall(f),/microPending|microRecovered|startedAt/);
    const job=await terminal(f.root,'quiet');assert.equal(job.status,'completed');assert.equal(job.delivery,'success-hidden');
    assert.doesNotMatch(await hostCall(f),/microRecovered|Deferred Micro/);
    const assignment=fs.readFileSync(path.join(f.root,'assignment.txt'),'utf8');assert.match(assignment,/needsHost/);assert.doesNotMatch(assignment,/To report a material finding/);
    const summary=summarizeMicroUsage(f.root);assert.equal(summary.totalTokens,120);assert.equal(summary.mainEquivalentTokens,120/7);
    const duplicate=await f.call('run',{background:true,jobId:'quiet',task:'do not run again'});
    assert.equal(duplicate.duplicate,true);assert.equal(duplicate.status,'completed');assert.equal(summary.calls,1);
    assert.equal((fs.statSync(path.join(f.root,'.contextos/micro-deliveries/jobs/quiet.json')).mode&0o777),0o600);
  }finally{f.cleanup();}
});

for(const [mode,delivery,pattern] of [['notify','auto',/negative totals/],['quiet','defer',/needsHost/],['plain','auto',/unmapped answer/],['fail','errors-only',/failed/i]]){
  test(`background CLI ${mode}/${delivery} reports once and retains a result artifact`,async()=>{
    const f=fixture();f.configure(mode);
    try{
      await f.call('run',{background:true,delivery,jobId:'reported',task:'bounded review'});
      const job=await terminal(f.root,'reported');assert.ok(job.receiptId);
      const first=await hostCall(f);assert.match(first,pattern);assert.match(first,/reported/);
      assert.doesNotMatch(await hostCall(f),/microRecovered|Deferred Micro/);
    }finally{f.cleanup();}
  });
}

test('a material report is delivered during a task, deduplicated, and does not get lost under a small action budget',async()=>{
  const f=fixture();f.configure('hang');
  try{
    await f.call('run',{background:true,jobId:'progress',task:'bounded review'});
    const content='Important finding: '+ 'source evidence '.repeat(110);
    assert.equal(reportMicroJob(f.root,'progress',content).queued,true);
    assert.equal(reportMicroJob(f.root,'progress',content).duplicate,true);
    const first=await f.orchestrator.dispatch('inspect',{path:'worker.mjs',maxChars:100});
    assert.match(first,/Important finding/);assert.match(first,/source evidence/);
    assert.doesNotMatch(await hostCall(f),/Important finding/);
    const stopped=await f.call('cancel',{jobId:'progress'});assert.equal(stopped.cancellationRequested,true);
    assert.equal((await terminal(f.root,'progress')).status,'failed');
    assert.equal(summarizeMicroUsage(f.root).totalTokensComplete,false);
  }finally{f.cleanup();}
});

test('a result finishing during an OS call is delivered by that response',async()=>{
  const f=fixture();f.configure('notify');
  try{
    await f.call('run',{background:true,jobId:'during-call',task:'bounded review'});
    // The host's action outlasts the fixture worker; no extra host poll is needed.
    const result=await f.orchestrator.dispatch('verify',{commands:[`${process.execPath} -e "setTimeout(()=>{},500)"`]});
    assert.match(result,/negative totals/);
    assert.doesNotMatch(await hostCall(f),/negative totals/);
  }finally{f.cleanup();}
});

test('lean MCP routes query/cancel/report actions rather than silently launching another model',async()=>{
  const f=fixture();f.configure('hang');
  const server=createV3Server();const client=new Client({name:'assistant-test',version:'1'});
  const [ct,st]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(st),client.connect(ct)]);
  const call=async args=>JSON.parse((await client.callTool({name:'contextos',arguments:{action:'micro',args,projectRoot:f.root}})).content[0].text);
  try{
    await call({background:true,jobId:'mcp-job',task:'review'});
    assert.equal((await call({action:'get',jobId:'mcp-job'})).job.status,'running');
    assert.equal((await call({action:'report',jobId:'mcp-job',content:'MCP report'})).queued,true);
    assert.equal((await call({action:'cancel',jobId:'mcp-job'})).cancellationRequested,true);
    assert.equal((await terminal(f.root,'mcp-job')).status,'failed');
    assert.equal((await call({action:'list'})).jobs.length,1);
  }finally{await client.close();await server.close();f.cleanup();}
});

test('expired workers report failure once and unsafe job paths are rejected',()=>{
  const f=fixture();
  try{
    createMicroJob(f.root,{jobId:'exited'});
    const file=path.join(f.root,'.contextos/micro-deliveries/jobs/exited.json');const job=JSON.parse(fs.readFileSync(file));job.leasePid=99999999;fs.writeFileSync(file,JSON.stringify(job));
    assert.equal(readMicroJob(f.root,'exited').status,'failed');assert.equal(claimMicroDeliveries(f.root).length,1);
    assert.equal(readMicroJob(f.root,'exited').status,'failed');assert.equal(claimMicroDeliveries(f.root).length,0);
    const usage=summarizeMicroUsage(f.root);assert.equal(usage.failed,1);assert.equal(usage.totalTokensComplete,false);
    assert.throws(()=>createMicroJob(f.root,{jobId:'../../outside'}),/Invalid/);
    assert.throws(()=>reportMicroJob(f.root,'exited','stale'),/running/);
  }finally{f.cleanup();}
});

test('auto cannot hide a failed assigned tool call',()=>{
  const f=fixture();try{
    const result=projectMicroResult({ok:true,delivery:'auto',needsHost:false,content:'',toolCalls:[{name:'run',error:'test failed'}]},{projectRoot:f.root});
    assert.equal(result.ok,false);assert.equal(result.delivery,'error');
  }finally{f.cleanup();}
});

test('API background can report while working and defer its final finding',async()=>{
  const f=fixture();let requests=0;
  const server=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;const payload=JSON.parse(body);requests++;
    const message=requests===1?{role:'assistant',tool_calls:[{id:'r1',type:'function',function:{name:'report',arguments:JSON.stringify({content:'early API finding'})}}]}:{role:'assistant',content:JSON.stringify({needsHost:true,hostReason:'review',answer:'final API finding'})};
    assert.ok(payload.tools.some(t=>t.function.name==='report'));
    res.end(JSON.stringify({choices:[{message,finish_reason:requests===1?'tool_calls':'stop'}],usage:{prompt_tokens:50,completion_tokens:10,total_tokens:60}}));
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  fs.writeFileSync(path.join(f.root,'.contextos/profile.json'),JSON.stringify({verify:[],micro:{url:`http://127.0.0.1:${server.address().port}`,model:'api-test'}}));
  try{
    await f.call('run',{background:true,jobId:'api-report',task:'review',withOS:true,reportUpdates:true});await terminal(f.root,'api-report');
    const response=await hostCall(f);assert.match(response,/early API finding/);assert.match(response,/final API finding/);
    assert.equal(requests,2);assert.equal(summarizeMicroUsage(f.root).totalTokens,120);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));f.cleanup();}
});

test('API cancellation retains known usage but does not label partial cost as a complete task',async()=>{
  const f=fixture();const controller=new AbortController();let requests=0;
  const server=http.createServer(async(req,res)=>{for await(const c of req){}requests++;
    if(requests===1)res.end(JSON.stringify({choices:[{message:{role:'assistant',tool_calls:[{id:'r',type:'function',function:{name:'os',arguments:'{"action":"context"}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:50,completion_tokens:10,total_tokens:60}}));
    else controller.abort();
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const result=await runMicroTask({url:`http://127.0.0.1:${server.address().port}`,model:'api-test'},{projectRoot:f.root,task:'review',withOS:true,signal:controller.signal,orchestrator:{dispatch:async()=> 'bounded evidence'}});
    assert.equal(result.ok,false);assert.match(result.error,/cancelled/);assert.equal(result.providerUsage.total_tokens,60);assert.equal(result.providerUsageComplete,false);
    projectMicroResult(result,{projectRoot:f.root});const summary=summarizeMicroUsage(f.root);
    assert.equal(summary.totalTokens,60);assert.equal(summary.totalTokensComplete,false);assert.equal(summary.mainEquivalentTokensComplete,false);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));f.cleanup();}
});

test('invalid auto envelopes preserve the answer; valid JSON answers are supported',()=>{
  assert.equal(parseMicroRouting('plain text'),null);
  assert.equal(parseMicroRouting('{"needsHost":true,"answer":""}'),null);
  assert.equal(parseMicroRouting('{"needsHost":false,"answer":""}').needsHost,false);
  assert.equal(parseMicroRouting('{"needsHost":true,"answer":{"finding":1}}').content,'{"finding":1}');
  const report='{"summary":"read source","changes":[],"checks":["ask"],"blockers":[],"question":null,"needsHost":false}';
  const routing=parseMicroRouting(report);
  assert.equal(routing.needsHost,false);
  assert.equal(routing.content,report,'a structured report keeps its own summary instead of being rewritten to an empty answer');
  const fenced='```json\n'+report+'\n```';
  assert.equal(parseMicroRouting(fenced).needsHost,false,'one whole Markdown fence is accepted');
  assert.equal(parseMicroRouting('Result is '+report),null,'JSON embedded in prose is rejected');
});

test('cancelled CLI terminal usage remains a known subtotal, never a complete task bill',async()=>{
  const f=fixture();try{
    const controller=new AbortController();const promise=runMicroTask(f.config('cancel-usage'),{projectRoot:f.root,task:'bounded task',signal:controller.signal});
    const deadline=Date.now()+2000;
    while(!fs.existsSync(path.join(f.root,'assignment.txt'))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
    assert.ok(fs.existsSync(path.join(f.root,'assignment.txt')));controller.abort();
    const result=await promise;assert.equal(result.errorCode,'CLI_CANCELLED');assert.equal(result.providerUsage.total_tokens,120);assert.equal(result.providerUsageComplete,false);
    projectMicroResult(result,{projectRoot:f.root});const summary=summarizeMicroUsage(f.root);assert.equal(summary.totalTokens,120);assert.equal(summary.totalTokensComplete,false);
  }finally{f.cleanup();}
});

test('a worker reports to its injected host workspace and cannot select a different job',async()=>{
  const host=fixture(),worker=fixture();createMicroJob(host.root,{jobId:'assigned'});
  const keys=['CONTEXTOS_WORKER_MODE','CONTEXTOS_WORKER_ROOT','CONTEXTOS_MICRO_REPORT_ROOT','CONTEXTOS_MICRO_REPORT_JOB'];
  const original=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  process.env.CONTEXTOS_WORKER_MODE='1';process.env.CONTEXTOS_WORKER_ROOT=worker.root;
  process.env.CONTEXTOS_MICRO_REPORT_ROOT=host.root;process.env.CONTEXTOS_MICRO_REPORT_JOB='assigned';
  const server=createV3Server(),client=new Client({name:'worker-report-test',version:'1'});
  const [ct,st]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(st),client.connect(ct)]);
  try{
    const call=jobId=>client.callTool({name:'contextos',arguments:{action:'micro',args:{action:'report',jobId,content:'isolated worker finding'},projectRoot:worker.root}});
    const valid=await call('assigned');assert.equal(JSON.parse(valid.content[0].text).queued,true);
    const wrong=await call('unassigned');assert.equal(wrong.isError,true);assert.match(wrong.content[0].text,/assigned job/);
    assert.equal(claimMicroDeliveries(worker.root).length,0);
    const report=claimMicroDeliveries(host.root);assert.equal(report.length,1);assert.equal(report[0].receiptId,'assigned');
  }finally{
    for(const k of keys){if(original[k]===undefined)delete process.env[k];else process.env[k]=original[k];}
    await client.close();await server.close();host.cleanup();worker.cleanup();
  }
});

test('a clipped material report retains the full evidence by artifact',()=>{
  const f=fixture();try{
    createMicroJob(f.root,{jobId:'long-report'});const content='x'.repeat(3190)+'END';reportMicroJob(f.root,'long-report',content);
    const report=claimMicroDeliveries(f.root,{maxChars:400})[0];assert.equal(report.truncated,true);assert.ok(report.artifactId);
    const full=readArtifact(f.root,report.artifactId,{maxChars:4000,lineNumbers:false});assert.equal(full.text,content);
  }finally{f.cleanup();}
});
