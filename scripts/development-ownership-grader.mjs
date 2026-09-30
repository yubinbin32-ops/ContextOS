/** Independent scoped/full ownership contracts against a target source checkout. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const workspace=path.resolve(process.argv[2]);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'contextos-owner-grade-'));
const service=pathToFileURL(path.join(workspace,'packages/mcp/src/v2-service.mjs')).href;
const orchestrator=pathToFileURL(path.join(workspace,'packages/orchestrator/src/index.mjs')).href;
const source=`import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';
import {ContextOSV2Service} from ${JSON.stringify(service)};import {Orchestrator} from ${JSON.stringify(orchestrator)};
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'owner-contract-'));fs.writeFileSync(path.join(root,'package.json'),'{}');fs.writeFileSync(path.join(root,'edit.mjs'),'export function oldName(){return 1;}\\n');fs.writeFileSync(path.join(root,'stable.mjs'),'export function stableName(){return 2;}\\n');const service=new ContextOSV2Service({projectRoot:root});return {root,service,orchestrator:new Orchestrator({projectRoot:root,service})};}
async function seed(f){await f.service.block({action:'bind_auto',id:'owner',blockData:{title:'Shared owner',kind:'component'},paths:['edit.mjs','stable.mjs']});await f.service.chain({action:'compose',chainData:{id:'owner-chain',title:'Owner chain',memberIds:['owner']}});return f.service.block({action:'open',id:'owner',format:'json'});}
for(const explicit of [true,false])test('scoped refresh '+explicit,async()=>{const f=fixture();try{const before=await seed(f);const stable=before.artifactRefs.filter(r=>r.path==='stable.mjs');const result=await f.orchestrator.dispatch('change',{edits:[{path:'edit.mjs',target:'oldName',replacement:'newName'}],...(explicit?{architecture:{blocks:[{id:'owner',title:'Shared owner',paths:['edit.mjs']}],chains:[{id:'owner-chain',title:'Owner chain',memberIds:['owner']}]}}:{}),verify:{commands:['node --check edit.mjs']}});assert.match(result,/Verify: PASS/);const after=await f.service.block({action:'open',id:'owner',format:'json'});assert.deepEqual(after.artifactRefs.filter(r=>r.path==='stable.mjs'),stable);assert.deepEqual(after.artifactRefs.filter(r=>r.path==='edit.mjs').map(r=>r.symbol),['newName']);}finally{f.service.close();fs.rmSync(f.root,{recursive:true,force:true});}});
test('legacy full replacement remains full',async()=>{const f=fixture();try{await seed(f);await f.service.block({action:'bind_auto',id:'owner',paths:['edit.mjs'],replacePaths:true});const after=await f.service.block({action:'open',id:'owner',format:'json'});assert.ok(after.artifactRefs.length>0);assert.equal(after.artifactRefs.some(r=>r.path==='stable.mjs'),false);}finally{f.service.close();fs.rmSync(f.root,{recursive:true,force:true});}});
`;
try {
  const test=path.join(root,'contract.test.mjs');fs.writeFileSync(test,source);
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,['--test',test],{encoding:'utf8',env,timeout:120000});
  const checks=[...result.stdout.matchAll(/^(not ok|ok)\s+\d+\s+-\s+(.+)$/gm)].map((m)=>({name:m[2],pass:m[1]==='ok'}));
  console.log(JSON.stringify({pass:result.status===0&&checks.length===3,checks,diagnostics:result.status===0?null:(result.stdout+result.stderr).slice(-3500)},null,2));
  process.exitCode=result.status===0?0:1;
} finally {fs.rmSync(root,{recursive:true,force:true});}
