import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFixtureProject } from '../../../scripts/fixture-project.mjs';
import { CodeTools } from '../../code-intel/src/code-tools.mjs';
import { createV3Server } from '../src/v3-server.mjs';
test('bounded work preserves exact batched evidence and exposes mutation outcomes', async () => {
  const fixture=createFixtureProject({prefix:'ctxos-work-evidence'});
  fixture.write('src/evidence.mjs','export function compute(value) {\n'+Array.from({length:75},(_,n)=>`  // relevant contract line ${n}: preserve this source body for a complete repair`).join('\n')+'\n  return value; // SOURCE_END_REQUIRED\n}\n');
  fixture.write('src/contract.mjs',Array.from({length:65},(_,n)=>`// contract ${n}: this expectation is required for a complete repair`).join('\n')+'\nexport const CONTRACT_END_REQUIRED = true;\n');
  const client=new Client({name:'work-evidence',version:'1'});const server=createV3Server();
  const [ct,st]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(st),client.connect(ct)]);
  const call=(args)=>client.callTool({name:'contextos',arguments:{action:'work',projectRoot:fixture.root,args}});
  try {
    const result=await call({inspect:[{path:'src/evidence.mjs',symbol:'compute'},{path:'src/contract.mjs',ranges:[[1,67]]}],verify:{commands:['node --check src/evidence.mjs']},maxChars:16000});
    const text=result.content[0].text;
    assert.ok(text.includes('SOURCE_END_REQUIRED'), 'source ending missing: '+text.slice(-1000));assert.ok(text.includes('CONTRACT_END_REQUIRED'), 'contract ending missing: '+text.slice(-1000));
    assert.match(text,/read_complete=true/);assert.doesNotMatch(text,/output truncated|response truncated/);assert.ok(text.length<=24500);
    const bounded=await call({inspect:[{path:'src/evidence.mjs',symbol:'compute'}],maxChars:900});
    assert.doesNotMatch(bounded.content[0].text,/read_complete=true/);
    const accepted=await call({edits:[{path:'src/evidence.mjs',target:'return value;',replacement:'return value + 1;'}],verify:{commands:['node --check src/evidence.mjs']}});
    assert.equal(accepted.structuredContent.status,'verified');assert.equal(accepted.structuredContent.changed,true);
    const blocked=await call({edits:[{path:'src/evidence.mjs',target:'missing source',replacement:''}]});
    assert.equal(blocked.isError,true);assert.equal(blocked.structuredContent.errorCode,'EDIT_REJECTED');
  } finally {await client.close();fixture.cleanup();}
});

test('string ranges return source bodies and malformed ranges never become outlines', async () => {
 const fixture=createFixtureProject({prefix:'ctxos-string-range'});
 fixture.write('src/ranges.mjs','export const alpha = 1;\nexport const beta = 2;\nexport const gamma = 3;\n');
 const client=new Client({name:'range-shapes',version:'1'}),server=createV3Server();
 const [ct,st]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(st),client.connect(ct)]);
 try {
  for(const action of ['work','inspect']){
   const args=action==='work'?{inspect:[{path:'src/ranges.mjs',ranges:'1-2'}]}:{path:'src/ranges.mjs',ranges:'2:3'};
   const r=await client.callTool({name:'contextos',arguments:{action,projectRoot:fixture.root,args}});
   assert.match(r.content[0].text,/export const beta = 2/);assert.doesNotMatch(r.content[0].text,/Module Outline/);
  }
  const invalid=await client.callTool({name:'contextos',arguments:{action:'work',projectRoot:fixture.root,args:{inspect:[{path:'src/ranges.mjs',ranges:'invalid'}]}}});
  assert.equal(invalid.isError,true);assert.match(invalid.content[0].text,/Invalid ranges/);
 }finally{await client.close();fixture.cleanup();}
});

test('work never marks search, outlines or missing source as a complete read', async () => {
 const fixture=createFixtureProject({prefix:'ctxos-read-readiness'});
 fixture.write('src/value.mjs','export function value() { return 1; }\n'+Array.from({length:180},(_,i)=>`export function other${i}() { return ${i}; }`).join('\n')+'\n');
 const client=new Client({name:'read-readiness',version:'1'}),server=createV3Server();
 const [ct,st]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(st),client.connect(ct)]);
 try {
  for(const args of [
   {search:{query:'absent_identifier',paths:['src/value.mjs']}},
   {search:{query:'value',paths:['src/value.mjs']}},
   {inspect:[{path:'src/value.mjs'}]},
   {inspect:[{path:'src/value.mjs',symbol:'missing'}]},
   {inspect:[{path:'src/value.mjs',symbol:'value'},{path:'src/value.mjs',symbol:'missing'}]},
   {inspect:[{path:'src/value.mjs',symbol:'value'}],verify:{commands:['node -e "process.exit(1)"']}}
  ]) {
   const r=await client.callTool({name:'contextos',arguments:{action:'work',projectRoot:fixture.root,args}});
   assert.match(r.content[0].text,/read_complete=false/);
   assert.doesNotMatch(r.content[0].text,/read_complete=true/);
  }
  const complete=await client.callTool({name:'contextos',arguments:{action:'work',projectRoot:fixture.root,args:{inspect:[{path:'src/value.mjs',symbol:'value'}]}}});
  assert.match(complete.content[0].text,/read_complete=true/);
 }finally{await client.close();fixture.cleanup();}
});

test('work search can resolve matches into merged bounded source ranges', async () => {
 const fixture=createFixtureProject({prefix:'ctxos-search-context'});
 fixture.write('src/focus.mjs',Array.from({length:100},(_,i)=>`export const line${i+1} = ${i===48 || i===50 ? '"FOCUS"' : i};`).join('\n')+'\n');
 fixture.write('src/other.mjs','export const FOCUS_OUTSIDE_REQUEST = true;\n');
 const client=new Client({name:'search-context',version:'1'}),server=createV3Server();
 const [ct,st]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(st),client.connect(ct)]);
 const call=args=>client.callTool({name:'contextos',arguments:{action:'work',projectRoot:fixture.root,args}});
 try {
  const r=await call({search:{query:'FOCUS',paths:['src/focus.mjs'],contextLines:4}});
  const body=r.content[0].text;assert.match(body,/line45/);assert.match(body,/line55/);assert.doesNotMatch(body,/line20|FOCUS_OUTSIDE_REQUEST/);assert.match(body,/read_complete=true/);
  assert.equal((body.match(/export const line49/g)||[]).length,1,'overlapping match context must be merged');
  const absent=await call({search:{query:'absent',paths:['src/focus.mjs'],contextLines:4}});assert.match(absent.content[0].text,/read_complete=false/);
  const bounded=await call({search:{query:'FOCUS',paths:['src/focus.mjs'],contextLines:40},maxChars:500});assert.doesNotMatch(bounded.content[0].text,/read_complete=true/);
  const invalid=await call({search:{query:'FOCUS',paths:['src/focus.mjs'],contextLines:41}});assert.equal(invalid.isError,true);
  fixture.write('src/bound.mjs',Array.from({length:250},(_,i)=>`export const bound${i+1} = ${[40,121,202].includes(i) ? '"BOUND_MATCH"' : i};`).join('\n')+'\n');
  const split=await call({search:{query:'BOUND_MATCH',paths:['src/bound.mjs'],contextLines:40}});assert.match(split.content[0].text,/read_complete=false/);assert.match(split.content[0].text,/artifact=/,'clipped multi-range output must expose recovery');assert.doesNotMatch(split.content[0].text,/bound244/);
 }finally{await client.close();fixture.cleanup();}
});

test('work unions compatible same-file ranges and keeps bounded source recoverable', async (t) => {
 const fixture=createFixtureProject({prefix:'ctxos-work-range-union'});
 const sourceLines=Array.from({length:60},(_,i)=>`export const RANGE_LINE_${String(i+1).padStart(2,'0')} = '${'x'.repeat(32)}';`);
 fixture.write('src/range-union.mjs',sourceLines.join('\n')+'\n');
 const client=new Client({name:'work-range-union',version:'1'}),server=createV3Server();
 const [ct,st]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(st),client.connect(ct)]);
 const originalRead=CodeTools.read;
 const readRequests=[];
 CodeTools.read=function(filePath,content,selector={}){
  if(Array.isArray(selector?.ranges))readRequests.push({path:filePath,ranges:selector.ranges.map(range=>({...range}))});
  return originalRead.call(this,filePath,content,selector);
 };
 const call=args=>client.callTool({name:'contextos',arguments:{action:'work',projectRoot:fixture.root,args}});
 const mergedProbes=[
  {path:'src/range-union.mjs',ranges:[{startLine:10,endLine:20},{startLine:28,endLine:30}]},
  {path:'src/range-union.mjs',ranges:[{startLine:18,endLine:27}]},
 ];
 try {
  const merged=await call({inspect:mergedProbes});
  const text=merged.content[0].text;
  assert.equal(readRequests.length,1,'compatible probes should cause one source read');
  assert.equal(readRequests[0].path,'src/range-union.mjs');
  assert.deepEqual(readRequests[0].ranges,[{startLine:10,endLine:30}], 'overlap and adjacency should be read once');
  for(let line=10;line<=30;line++)assert.equal((text.match(new RegExp(`RANGE_LINE_${String(line).padStart(2,'0')}`,'g'))||[]).length,1,`source line ${line} should appear once`);
  assert.doesNotMatch(text,/RANGE_LINE_09|RANGE_LINE_31/);
  const textBytes=Buffer.byteLength(text);
  const envelopeBytes=Buffer.byteLength(JSON.stringify(merged));
  const sourceBytes=Buffer.byteLength(sourceLines.slice(9,30).join('\n'));
  assert.ok(textBytes<=2400,`default work output should stay within its 2400-character cap, got ${textBytes}`);
  assert.ok(envelopeBytes>textBytes,'MCP envelope adds measurable bytes around the returned text');
  assert.ok(textBytes>sourceBytes,'rendering overhead is measured separately from source bytes');
  t.diagnostic(`merged read calls=1 unique source bytes=${sourceBytes} rendered text bytes=${textBytes} text-only rendering overhead=${textBytes-sourceBytes} MCP JSON envelope bytes=${envelopeBytes} envelope overhead=${envelopeBytes-textBytes} output cap=2400`);

  readRequests.length=0;
  const bounded=await call({inspect:mergedProbes,maxChars:700});
  const boundedText=bounded.content[0].text;
  assert.ok(Buffer.byteLength(boundedText)<=700,`explicit caller maxChars must cap output, got ${Buffer.byteLength(boundedText)}`);
  const artifactIds=[...boundedText.matchAll(/artifact=([A-Za-z0-9._-]+)/g)].map(match=>match[1]);
  assert.ok(artifactIds.length,'truncated bounded source must carry an artifact locator');
  let recovered=false;
  let recoveredArtifactBytes=0;
  let boundedArtifactReadObserved=false;
  for(const id of artifactIds){
   const boundedArtifact=await client.callTool({name:'contextos',arguments:{action:'ops',projectRoot:fixture.root,args:{capability:'artifact',action:'read',id,maxChars:1400,allowRawPipeline:true,auditReason:'verify bounded range recovery in fixture'}}});
   const boundedArtifactText=(boundedArtifact.content||[]).map(item=>String(item.text||'')).join('\n');
   boundedArtifactReadObserved ||= /- Truncated: true/.test(boundedArtifactText);
   const artifact=await client.callTool({name:'contextos',arguments:{action:'ops',projectRoot:fixture.root,args:{capability:'artifact',action:'read',id,full:true,allowRawPipeline:true,auditReason:'verify bounded range recovery in fixture'}}});
   const artifactText=(artifact.content||[]).map(item=>String(item.text||'')).join('\n');
   recoveredArtifactBytes=Math.max(recoveredArtifactBytes,Buffer.byteLength(artifactText));
   const completeRequestedRange=Array.from({length:21},(_,i)=>`RANGE_LINE_${String(i+10).padStart(2,'0')}`).every(marker=>(artifactText.match(new RegExp(marker,'g'))||[]).length===1);
   const excludesOutsideRange=!/RANGE_LINE_09|RANGE_LINE_31/.test(artifactText);
   if(completeRequestedRange&&excludesOutsideRange)recovered=true;
  }
  assert.ok(boundedArtifactReadObserved,'artifact recovery exposes a bounded read and its truncation state');
  assert.ok(recovered,`audited raw artifact replay should recover all 21 requested source lines exactly once; ids=${JSON.stringify(artifactIds)} response=${boundedText.slice(-1200)}`);
  t.diagnostic(`bounded work response bytes=${Buffer.byteLength(boundedText)} cap=700; audited artifact replay bytes=${recoveredArtifactBytes} complete requested coverage=21/21 lines; source read calls=1`);
  assert.equal(readRequests.length,1,'artifact recovery should not issue another source read');

  readRequests.length=0;
  await call({inspect:[
   {path:'src/range-union.mjs',ranges:[{startLine:10,endLine:15}],maxChars:1200},
   {path:'src/range-union.mjs',ranges:[{startLine:15,endLine:20}],maxChars:1300},
  ]});
  assert.equal(readRequests.length,2,'probes with different output budgets must remain separate');

  const requestedMarkers=[];
  const multiProbes=[50,50,49].map((lineCount,fileIndex)=>{
   const file=`src/multi-${fileIndex+1}.mjs`;
   const lines=Array.from({length:lineCount},(_,lineIndex)=>{
    const marker=`MULTI_LINE_${String(requestedMarkers.length+1).padStart(3,'0')}`;
    requestedMarkers.push(marker);
    return `export const ${marker} = '${'y'.repeat(28)}';`;
   });
   fixture.write(file,lines.join('\n')+'\n');
   return {path:file,ranges:[{startLine:1,endLine:lineCount}]};
  });
  readRequests.length=0;
  const multi=await call({inspect:multiProbes});
  const multiText=multi.content[0].text;
  const multiArtifactIds=[...multiText.matchAll(/artifact=([A-Za-z0-9._-]+)/g)].map(match=>match[1]);
  assert.ok(Buffer.byteLength(multiText)<=2400,'default response budget must cap the multi-file packet');
  assert.ok(multiArtifactIds.length,'large multi-file evidence must expose an artifact locator');
  assert.deepEqual(readRequests.map((request)=>request.path).sort(),multiProbes.map((probe)=>probe.path).sort(),'149 requested lines should require exactly one source read per file');
  let multiArtifactBytes=0;
  let multiCoverageRecovered=false;
  let boundedMultiArtifactObserved=false;
  for(const id of multiArtifactIds){
   const boundedArtifact=await client.callTool({name:'contextos',arguments:{action:'ops',projectRoot:fixture.root,args:{capability:'artifact',action:'read',id,maxChars:1400,allowRawPipeline:true,auditReason:'verify bounded multi-file range recovery in fixture'}}});
   boundedMultiArtifactObserved ||= /- Truncated: true/.test(boundedArtifact.content?.[0]?.text||'');
   const artifact=await client.callTool({name:'contextos',arguments:{action:'ops',projectRoot:fixture.root,args:{capability:'artifact',action:'read',id,full:true,allowRawPipeline:true,auditReason:'verify bounded multi-file range recovery in fixture'}}});
   const artifactText=(artifact.content||[]).map(item=>String(item.text||'')).join('\n');
   multiArtifactBytes=Math.max(multiArtifactBytes,Buffer.byteLength(artifactText));
   if(requestedMarkers.every((marker)=>(artifactText.match(new RegExp(marker,'g'))||[]).length===1))multiCoverageRecovered=true;
  }
  assert.ok(boundedMultiArtifactObserved,'multi-file artifact exposes its bounded read truncation state');
  assert.ok(multiCoverageRecovered,'raw artifact replay should preserve all 149 requested source lines exactly once');
  assert.equal(readRequests.length,3,'artifact replay should not reread any source file');
  t.diagnostic(`149-line multi-file request: source reads=${readRequests.length}, main response bytes=${Buffer.byteLength(multiText)}/2400, complete artifact replay bytes=${multiArtifactBytes}, recovered markers=${requestedMarkers.length}/149, additional source reads=0`);
 } finally {
  CodeTools.read=originalRead;
  await client.close();fixture.cleanup();
 }
});
