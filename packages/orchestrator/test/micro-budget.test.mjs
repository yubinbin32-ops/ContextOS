import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { runMicroTask } from '../src/micro-client.mjs';
test('evaluation disable flag prevents provider requests even with a configured executor', async () => {
  let requests=0;
  const server=http.createServer((req,res)=>{requests++;res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'unexpected request'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));});
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  const previous=process.env.CONTEXTOS_DISABLE_MICRO;
  process.env.CONTEXTOS_DISABLE_MICRO='1';
  try {
    const result=await runMicroTask({url:`http://127.0.0.1:${server.address().port}/v1/chat/completions`,model:'test-only'}, {prompt:'No executor may start'});
    assert.equal(result.ok,false);assert.equal(result.errorCode,'MICRO_DISABLED');assert.equal(requests,0);
  } finally {if(previous===undefined)delete process.env.CONTEXTOS_DISABLE_MICRO;else process.env.CONTEXTOS_DISABLE_MICRO=previous;await new Promise((resolve)=>server.close(resolve));}
});
