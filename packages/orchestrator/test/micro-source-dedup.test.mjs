import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {runMicroTask} from '../src/micro-client.mjs';
test('API task source appears once instead of repeating inside the manifest',async()=>{
 let payload;
 const server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{payload=JSON.parse(body);res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}}));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const result=await runMicroTask({url:`http://127.0.0.1:${server.address().port}/v1/chat/completions`,model:'test'},{prompt:'Review INJECTED_SOURCE_ONCE only.',withOS:false,context:{acceptance:['review supplied evidence']}});
  assert.equal(result.ok,true,result.error);
  assert.equal(JSON.stringify(payload.messages).split('INJECTED_SOURCE_ONCE').length-1,1);
 }finally{await new Promise(r=>server.close(r));}
});
