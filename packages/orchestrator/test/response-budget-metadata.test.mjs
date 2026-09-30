import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { finalizeResponse } from '../src/response-budget.mjs';
import { readArtifact } from '../src/artifact-store.mjs';

test('body clipping remains visible when metadata makes the response longer', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'os-budget-metadata-'));
 try {
  const raw='UNIQUE_SOURCE_EVIDENCE_'.repeat(6);
  const result=finalizeResponse(raw,{projectRoot:root,maxChars:170,routingHint:'h'.repeat(150)});
  assert.equal(result.meta.truncated,true);
  assert.ok(result.meta.artifactId);
  assert.ok(result.text.length<=170);
  assert.match(readArtifact(root,result.meta.artifactId).text,/UNIQUE_SOURCE_EVIDENCE/);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('locator and route hint share the declared hard response budget', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'os-budget-hard-'));
 try {
  for(const maxChars of [20,100,200,500]) {
   const result=finalizeResponse('x'.repeat(3000),{projectRoot:root,maxChars,routingHint:'route'.repeat(40)});
   assert.ok(result.text.length<=maxChars,`${result.text.length} > ${maxChars}`);
   assert.equal(result.meta.truncated,true);
   assert.ok(result.meta.artifactId);
  }
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
