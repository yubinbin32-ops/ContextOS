import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFixtureProject } from '../../../scripts/fixture-project.mjs';
import { createV3Server } from '../src/v3-server.mjs';
test('doctor diagnoses an unanchored saved Block without importing or altering it', async () => {
  const fixture = createFixtureProject({prefix:'ctxos-invalid-graph-doctor'});
  const graphPath = path.join(fixture.root,'.contextos','graph.json');
  const graph = JSON.stringify({schemaVersion:2,data:{blocks:[{id:'old-unanchored',artifactRefs:[]}]} });
  fs.mkdirSync(path.dirname(graphPath),{recursive:true});fs.writeFileSync(graphPath,graph);
  const client = new Client({name:'doctor-regression',version:'1'}), server = createV3Server();
  const [ct,st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st),client.connect(ct)]);
  try {
    const result = await client.callTool({name:'contextos',arguments:{action:'ops',projectRoot:fixture.root,args:{capability:'system',action:'doctor'}}});
    assert.equal(result.isError ?? false,false);
    assert.match(result.content[0].text,/unanchored Block.*old-unanchored/);
    assert.equal(fs.readFileSync(graphPath,'utf8'),graph);
  } finally {await client.close();fixture.cleanup();}
});
