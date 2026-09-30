import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {runTaskMicroPreload,microPreloadReceipt,microPreloadPrompt} from '../src/micro-preload.mjs';
import {statArtifact} from '../src/artifact-store.mjs';
import {scheduleMicro} from '../src/micro-scheduler.mjs';
import {runMicroTask} from '../src/micro-client.mjs';
test('a delegated read pipeline injects child revision without reading host source',async()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'os-source-owner-'));const host=path.join(base,'host'),child=path.join(base,'child');
 for(const root of [host,child])fs.mkdirSync(root);
 fs.writeFileSync(path.join(host,'source.mjs'),'export const version="HOST_OLD_SOURCE";\n');
 fs.writeFileSync(path.join(child,'source.mjs'),'export const version="CHILD_NEW_SOURCE";\n');
 const ctx={projectRoot:host,profile:{},store:{},tracer:{step(){}},orchestrator:{dispatch(){throw Error('Host source must not be read');}}};
 try{
  const result=await runTaskMicroPreload(ctx,{steps:[{inspect:{path:'source.mjs',ranges:[[1,1]],full:true}}],maxChars:8000},{workspace:child});
  assert.equal(result.ok,true,result.error);assert.match(result.summary,/CHILD_NEW_SOURCE/);assert.doesNotMatch(result.summary,/HOST_OLD_SOURCE/);
  assert.ok(statArtifact(child,result.artifactId));assert.equal(statArtifact(host,result.artifactId),null);
  assert.ok(!JSON.stringify(microPreloadReceipt(result)).includes('CHILD_NEW_SOURCE'),'main receives a receipt, not source');
  assert.match(microPreloadPrompt(result),/do not read unchanged covered source again/);
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
test('a queued writer prepares evidence once after the previous writer finishes',async()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'os-source-queue-'));const host=path.join(base,'host'),child=path.join(base,'child');
 for(const root of [host,child])fs.mkdirSync(root);
 fs.writeFileSync(path.join(child,'source.mjs'),'old');
 const cli=path.join(base,'fixture-cli.mjs'),taskFile=path.join(base,'cli-task.txt');
 fs.writeFileSync(cli,`import fs from 'node:fs';
let task='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>task+=chunk);
process.stdin.on('end',()=>{fs.writeFileSync(process.argv[3],task);fs.writeFileSync('source.mjs','newer');process.stdout.write(JSON.stringify({status:'SUCCESS',response:'writer finished'}));});
`);
 let release,started;const ready=new Promise(r=>{started=r});const gate=new Promise(r=>{release=r});
 let reads=0;
 try{
  const first=scheduleMicro({workspace:child,execution:'implement'},async()=>{started();await gate;fs.writeFileSync(path.join(child,'source.mjs'),'new');return {ok:true};});
  await ready;
  const second=runMicroTask({provider:'cli',model:'fixture-model',cli:{command:process.execPath,args:[cli,'{model}',taskFile],
   input:{format:'text',template:'{task}'},output:{format:'json',contentPath:'response',statusPath:'status',successValues:['SUCCESS']}}},
   {provider:'cli',projectRoot:host,workspace:child,execution:'implement',task:'Review the latest source',withOS:true,context:{allowedPaths:['source.mjs'],acceptance:['review']},preparePreload:()=>{
   reads++;assert.equal(fs.readFileSync(path.join(child,'source.mjs'),'utf8'),'new');return {ok:true,status:'OK',summary:'new source',chars:10,pipelineRuns:1};
  }});
  await new Promise(r=>setTimeout(r,10));assert.equal(reads,0);
  release();await first;const result=await second;
  assert.equal(reads,1);assert.equal(result.ok,true,result.error);assert.equal(result.provider,'cli');assert.equal(result.preload.pipelineRuns,1);
  const received=fs.readFileSync(taskFile,'utf8');assert.match(received,/new source/);
 }finally{release?.();fs.rmSync(base,{recursive:true,force:true});}
});
