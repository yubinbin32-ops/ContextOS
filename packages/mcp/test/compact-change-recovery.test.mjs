import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFixtureProject } from '../../../scripts/fixture-project.mjs';
import { createV3Server } from '../src/v3-server.mjs';

test('compact edits recover from ownership conflicts using only the returned receipt', async () => {
  const fixture = createFixtureProject({ prefix: 'ctxos-change-recovery' });
  const server = createV3Server();
  const client = new Client({ name: 'change-recovery', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (args) => {
    const result = await client.callTool({ name: 'contextos', arguments: { action: 'change', args, projectRoot: fixture.root } });
    return result.content.map((c) => c.text || '').join('\n');
  };
  const file = path.join(fixture.root, 'src/recover.mjs');
  try {
    const initial = 'export const answer = 1;\n';
    const created = await call({ create: [{ path: 'src/recover.mjs', content: initial }],
      architecture: { blocks: [{ id: 'answer-owner', title: 'Answer ownership', paths: ['src/recover.mjs'] }], chains: [{ id: 'answer-chain', memberIds: ['answer-owner'] }] },
      verify: { commands: ['node --check src/recover.mjs'] } });
    const edits = [{ path: 'src/recover.mjs', oldText: 'answer = 1', newText: 'answer = 2' }];
    assert.match(created, /Verify: PASS/);
    const rejected = await call({ edits, architecture: { blocks: [{ id: 'wrong-owner', title: 'Wrong', paths: ['src/recover.mjs'] }], chains: [{ id: 'wrong-chain', memberIds: ['wrong-owner'] }] } });
    assert.match(rejected, /No files were modified/);
    assert.equal(fs.readFileSync(file, 'utf8'), initial);
    const receipt = JSON.parse(rejected.match(/^- ownership=(.+)$/m)[1]);
    const owner = receipt.find((r) => r.path === 'src/recover.mjs').owners[0];
    assert.equal(owner.id, 'answer-owner'); assert.equal(owner.title, 'Answer ownership');
    assert.deepEqual(owner.chainIds, ['answer-chain']);
    const accepted = await call({ edits, architecture: {
      blocks: [{ id: owner.id, title: owner.title, paths: ['src/recover.mjs'] }],
      chains: [{ id: owner.chainIds[0], memberIds: [owner.id] }],
    }, verify: { commands: ['node --check src/recover.mjs'] } });
    assert.match(accepted, /Verify: PASS/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'export const answer = 2;\n');
    await call({ edits: [{ path: 'src/recover.mjs', oldText: 'export const answer = 2;\n', newText: '' }], verify: { commands: ['node --check src/recover.mjs'] } });
    assert.equal(fs.readFileSync(file, 'utf8'), '');
  } finally { await client.close(); fixture.cleanup(); }
});
test('failed change names the failing receipt and recovers logs without rerunning commands',async()=>{
 const fixture=createFixtureProject({prefix:'ctxos-failure-receipt'});
 fixture.write('src/failing.mjs','export const value = 1;\n');
 const client=new Client({name:'failure-receipt',version:'1'}),server=createV3Server();
 const [ct,st]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(st),client.connect(ct)]);
 try {
  const command=`node -e "require('node:fs').appendFileSync('checks.count','x');console.error('CTX_EXISTING_FAILURE_LOG');process.exit(1)"`;
  const result=await client.callTool({name:'contextos',arguments:{action:'change',projectRoot:fixture.root,args:{edits:[{path:'src/failing.mjs',target:'value = 1',replacement:'value = 2'}],verify:['node --check src/failing.mjs',command],autoRevert:false}}});
  const text=result.content[0].text;const recovery=JSON.parse(text.match(/verify\((\{[^\n]+\})\)/)[1]);
  assert.equal(recovery.mode,'logs');assert.match(recovery.id,/^receipt-/);
  const logs=await client.callTool({name:'contextos',arguments:{action:'verify',projectRoot:fixture.root,args:recovery}});
  assert.match(logs.content[0].text,/CTX_EXISTING_FAILURE_LOG/);assert.equal(fs.readFileSync(path.join(fixture.root,'checks.count'),'utf8'),'x');
 } finally {await client.close();fixture.cleanup();}
});

async function withReceiptRecoveryClient(run) {
 const fixture=createFixtureProject({prefix:'ctxos-receipt-recovery'});
 const client=new Client({name:'receipt-recovery',version:'1'}),server=createV3Server();
 const [ct,st]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(st),client.connect(ct)]);
 const call=async(action,args)=>{
  const result=await client.callTool({name:'contextos',arguments:{action,projectRoot:fixture.root,args}});
  return result.content.map(c=>c.text||'').join('\n');
 };
 try {await run({fixture,call});} finally {await client.close();fixture.cleanup();}
}
test('explicit receipt log recovery honors a finite budget and keeps its hard cap',async()=>withReceiptRecoveryClient(async({fixture,call})=>{
 const command=`node -e "for(let i=0;i<32;i++)console.error('row-'+i+'-'+ 'x'.repeat(80));process.exit(1)"`;
 const failed=await call('verify',{commands:[command],autoTriage:false});
 const id=failed.match(/receipt (receipt-[A-Za-z0-9-]+)/)[1];
 const logs=await call('verify',{mode:'logs',id,lines:40,maxChars:4000});
 assert.match(logs,/row-16-/);assert.doesNotMatch(logs,/response truncated/);assert.ok(logs.length<=4000);
 const more=await call('verify',{commands:[`node -e "for(let i=0;i<240;i++)console.error('cap-'+i+'-'+ 'y'.repeat(80));process.exit(1)"`],autoTriage:false});
 const moreId=more.match(/receipt (receipt-[A-Za-z0-9-]+)/)[1];
 const capped=await call('verify',{mode:'logs',id:moreId,lines:300,maxChars:100000});
 assert.ok(capped.length<=8000);assert.match(capped,/response truncated/);
}));
test('receipt logs without an id recover the latest active failure without executing it again',async()=>withReceiptRecoveryClient(async({fixture,call})=>{
 const empty=await call('verify',{mode:'logs'});assert.doesNotMatch(empty,/undefined/);assert.match(empty,/receipt/i);
 const command=`node -e "require('node:fs').appendFileSync('recovery-count','x');console.error('LATEST_RECEIPT_RECOVERY');process.exit(1)"`;
 const failed=await call('verify',{commands:[command],autoTriage:false});
 const id=failed.match(/receipt (receipt-[A-Za-z0-9-]+)/)[1];
 const logs=await call('verify',{mode:'logs',lines:30,maxChars:4000});
 assert.match(logs,new RegExp(id));assert.match(logs,/LATEST_RECEIPT_RECOVERY/);
 assert.equal(fs.readFileSync(path.join(fixture.root,'recovery-count'),'utf8'),'x');
}));
test('a failed change includes the failing local source frame for direct repair',async()=>withReceiptRecoveryClient(async({fixture,call})=>{
 fixture.write('src/source-frame.mjs','const FRAME_LOCAL_CONST = 1;\nthrow new Error("FRAME_FAILURE");\n');
 const failed=await call('change',{edits:[{path:'src/source-frame.mjs',target:'FRAME_LOCAL_CONST = 1',replacement:'FRAME_LOCAL_CONST = 2'}],verify:['node src/source-frame.mjs'],autoRevert:false});
 assert.match(failed,/Failure source/);assert.match(failed,/FRAME_LOCAL_CONST = 2/);assert.match(failed,/src\/source-frame\.mjs/);
}));
test('failure source recovery does not follow a symlink outside the repository',async()=>withReceiptRecoveryClient(async({fixture,call})=>{
 const outside=fs.mkdtempSync(path.join(path.dirname(fixture.root),'ctxos-frame-outside-'));
 try {
  const secret=path.join(outside,'private.mjs');fs.writeFileSync(secret,'const EXTERNAL_PRIVATE_SOURCE_MARKER = true;\n');
  fs.mkdirSync(path.join(fixture.root,'src'),{recursive:true});fs.symlinkSync(secret,path.join(fixture.root,'src','linked.mjs'));
  fixture.write('src/touched.mjs','export const value = 1;\n');
  const command=`node -e "console.error('at Example ('+require('node:path').resolve('src/linked.mjs')+':1:1)');process.exit(1)"`;
  const failed=await call('change',{edits:[{path:'src/touched.mjs',target:'value = 1',replacement:'value = 2'}],verify:[command],autoRevert:false});
  assert.doesNotMatch(failed,/EXTERNAL_PRIVATE_SOURCE_MARKER/);
 } finally {fs.rmSync(outside,{recursive:true,force:true});}
}));
