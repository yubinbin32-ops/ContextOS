import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {normalizeModels,modelsURL,agyModels,syncMicro,syncCLI,codexModels} from './model_catalog.mjs';
test('normalizer filters hidden/duplicate and preserves effort labels',()=>{
 const rows=normalizeModels({data:[{id:'unknown'},{id:'unknown'},{id:'hidden',hidden:true},{id:'codex',supportedReasoningEfforts:[{reasoningEffort:'high',description:'High effort'}]},{id:'custom',reasoningLevels:[{id:'special',label:'Special'}]}]},'fixture');
 assert.equal(rows.length,3); assert.deepEqual(rows[0].reasoningLevels,[]);
 assert.equal(rows[1].reasoningLevels[0].label,'High effort'); assert.equal(rows[2].reasoningLevels[0].label,'Special');
 assert.throws(()=>normalizeModels({},'fixture'),/catalog-schema/);
});
test('URL preserves paths and rejects credential/query/remote HTTP',()=>{
 assert.equal(modelsURL('https://example.com/v1/chat/completions').href,'https://example.com/v1/models');
 assert.equal(modelsURL('https://example.com/v1/models').href,'https://example.com/v1/models');
 for(const base of ['file:///tmp/a','https://user:secret@example.com/v1','https://example.com/?key=a','http://remote.example/v1']) assert.throws(()=>modelsURL(base));
});
test('AGY tab/space parser only lists present effort variants',()=>{
 const rows=agyModels('\u001b[32mgemini-high\u001b[0m\tHigh\ngemini-medium  Medium\ngemini-low\tLow\nsolo-medium\tSolo\nclaude\tClaude\ngemini-high\tHigh\n');
 assert.equal(rows.length,5); assert.deepEqual(rows[0].reasoningLevels.map(x=>x.id),['low','medium','high']);
 assert.deepEqual(rows.find(x=>x.id==='solo-medium').reasoningLevels.map(x=>x.id),['medium']);
 assert.deepEqual(rows.find(x=>x.id==='claude').reasoningLevels,[]);
});
async function withServer(handler,callback) {
 const server=http.createServer(handler); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {await callback('http://127.0.0.1:'+server.address().port);}
 finally {await new Promise(resolve=>server.close(resolve));}
}
test('Micro fallback respects unknown and explicitly empty effort metadata',async()=>{
 await withServer((req,res)=>{
  assert.equal(req.headers.authorization,'Bearer saved'); res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({data:[{id:'deepseek-v4.1-flash'},{id:'unknown'},{id:'deepseek-v4-explicit',reasoning_efforts:[]}]}));
 },async base=>{
  const profile={micro:{url:base+'/old',key:'saved'}};
  const result=await syncMicro({baseURL:base+'/v1',replacementKey:''},profile);
  assert.equal(result.models.length,3); assert.ok(result.models[0].reasoningLevels.some(x=>x.id==='medium'));
  assert.deepEqual(result.models[1].reasoningLevels,[]); assert.deepEqual(result.models[2].reasoningLevels,[]);
  profile.micro.thinkingMap={chat:{custom:'high',off:false}};
  assert.deepEqual((await syncMicro({baseURL:base,replacementKey:''},profile)).models[1].reasoningLevels.map(x=>x.id),['custom']);
 });
});
test('Micro never sends old key to new origin or follows redirects',async()=>{
 let requests=0; await withServer((req,res)=>{requests++;res.writeHead(302,{location:'https://example.com/models'});res.end();},async base=>{
  await assert.rejects(syncMicro({baseURL:base,replacementKey:''},{micro:{url:'https://old.example',key:'saved'}}),/service-key-required/);
  assert.equal(requests,0); await assert.rejects(syncMicro({baseURL:base,replacementKey:'new'},{micro:{url:'https://old.example',key:'saved'}})); assert.equal(requests,1);
 });
});
test('unknown CLI needs explicit catalog, static catalog works',async()=>{
 const profile={agents:{adapters:{custom:{command:'never-run'},static:{command:'never-run',catalog:{models:[{id:'one'}]}}}}};
 await assert.rejects(syncCLI('custom',profile),/catalog-not-declared/); assert.equal((await syncCLI('static',profile)).models[0].id,'one');
});
test('Codex initializes and paginates', {skip:process.platform==='win32'},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'catalog-rpc-')),command=path.join(dir,'codex-fixture');
 fs.writeFileSync(command,'#!'+process.execPath+'\n'+`
import readline from 'node:readline';
let ready=false;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line); if(r.method==='initialized'){ready=true;return;}
 const result=r.method==='initialize'?{}:!ready?null:r.params.cursor?{data:[{id:'second',supportedReasoningEfforts:[{reasoningEffort:'high'}]},{id:'hidden',hidden:true}],nextCursor:null}:{data:[{id:'first'}],nextCursor:'next'};
 process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');
});
`); fs.chmodSync(command,0o700);
 try {const result=await codexModels(command); assert.deepEqual(result.models.map(x=>x.id),['first','second']);assert.equal(result.models[1].reasoningLevels[0].id,'high');}
 finally {fs.rmSync(dir,{recursive:true,force:true});}
});
