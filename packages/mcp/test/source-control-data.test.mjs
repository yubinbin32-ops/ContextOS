import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFixtureProject } from '../../../scripts/fixture-project.mjs';
import { createV3Server } from '../src/v3-server.mjs';
test('receipt-like text in numbered source is data, not a failed or incomplete read',async()=>{
 const fixture=createFixtureProject({prefix:'ctxos-source-control-data'});
 fixture.write('src/control-data.mjs','export const message = "✗ [body not inlined] [response truncated] Symbol value not found";\nexport const SOURCE_END_PRESENT = true;\n');
 const client=new Client({name:'source-control-data',version:'1'}),server=createV3Server();
 const [ct,st]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(st),client.connect(ct)]);
 try {
  const result=await client.callTool({name:'contextos',arguments:{action:'work',projectRoot:fixture.root,args:{inspect:[{path:'src/control-data.mjs',ranges:[[1,2]]}]}}});
  assert.match(result.content[0].text,/SOURCE_END_PRESENT/);assert.match(result.content[0].text,/read_complete=true/);
  const clipped=await client.callTool({name:'contextos',arguments:{action:'work',projectRoot:fixture.root,args:{inspect:[{path:'src/control-data.mjs',ranges:[[1,2]]}],maxChars:100}}});
  assert.doesNotMatch(clipped.content[0].text,/read_complete=true/);
 } finally {await client.close();fixture.cleanup();}
});
