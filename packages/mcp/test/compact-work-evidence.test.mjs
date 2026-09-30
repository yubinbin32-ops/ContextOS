import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFixtureProject } from '../../../scripts/fixture-project.mjs';
import { createV3Server } from '../src/v3-server.mjs';
test('bounded work preserves exact batched evidence and exposes mutation outcomes', async () => {
  const fixture=createFixtureProject({prefix:'ctxos-work-evidence'});
  fixture.write('src/evidence.mjs','export function compute(value) {\n'+Array.from({length:75},(_,n)=>`  // relevant contract line ${n}: preserve this source body for a complete repair`).join('\n')+'\n  return value; // SOURCE_END_REQUIRED\n}\n');
  fixture.write('src/contract.mjs',Array.from({length:65},(_,n)=>`// contract ${n}: this expectation is required for a complete repair`).join('\n')+'\nexport const CONTRACT_END_REQUIRED = true;\n');
  const client=new Client({name:'work-evidence',version:'1'});const server=createV3Server();
  const [ct,st]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(st),client.connect(ct)]);
  const call=(args)=>client.callTool({name:'contextos',arguments:{action:'work',projectRoot:fixture.root,args}});
  try {
    const result=await call({inspect:[{path:'src/evidence.mjs',symbol:'compute'},{path:'src/contract.mjs',ranges:[[1,67]]}],verify:{commands:['node --check src/evidence.mjs']}});
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
  const split=await call({search:{query:'BOUND_MATCH',paths:['src/bound.mjs'],contextLines:40}});assert.match(split.content[0].text,/read_complete=true/);assert.match(split.content[0].text,/bound243/);assert.doesNotMatch(split.content[0].text,/bound244/);
 }finally{await client.close();fixture.cleanup();}
});
