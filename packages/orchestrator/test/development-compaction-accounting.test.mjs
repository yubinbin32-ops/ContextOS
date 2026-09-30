import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripCompactionContextHints, parseDevelopmentRollouts } from '../../../scripts/development-rollout.mjs';
const usage = {input_tokens:100,cached_input_tokens:40,cache_write_input_tokens:0,output_tokens:10,reasoning_output_tokens:3,total_tokens:110};
const count = (last=usage,total=usage) => ({type:'event_msg',payload:{type:'token_count',info:{last_token_usage:last,total_token_usage:total,model_context_window:258400}}});
const marker = {type:'compacted',payload:{message:'controlled fixture'}};
const zero = {input_tokens:0,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:0,reasoning_output_tokens:0,total_tokens:7706};
const primary = {type:'token_usage_record',payload:{response_id:'actual-compaction-response',usage,model_context_window:258400}};
const trace = (...rows) => rows.map(r=>JSON.stringify(r)).join('\n');
test('compaction context-size hint leaves all actual provider usage intact',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dev-usage-test-'));
 try {
  const file=path.join(root,'source.jsonl');const original=trace(primary,count(),marker,count(zero));fs.writeFileSync(file,original);
  const result=parseDevelopmentRollouts([file]);assert.equal(result.ok,true);assert.equal(result.contextSizeHintsIgnored,1);
  assert.equal(result.metrics.requestCount,1);assert.equal(result.metrics.inputTokens,100);assert.equal(result.metrics.outputTokens,10);assert.equal(result.metrics.peakRequestInputTokens,100);
  assert.equal(fs.readFileSync(file,'utf8'),original);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('ambiguous or paid zero-shape events stay subject to strict validation',()=>{
 const variants=[trace(count(),count(zero)),trace(count(),marker,count(zero,{...usage,input_tokens:101,total_tokens:111})),trace(count(),marker,count({...zero,reasoning_output_tokens:1})),trace(count(),marker,{...count(zero),payload:{...count(zero).payload,response_id:'new-response'}}),trace(count(),marker,primary,count(zero))];
 for(const content of variants)assert.equal(stripCompactionContextHints(content).ignored,0);
 assert.equal(stripCompactionContextHints(trace(count(),marker,count(zero),count(zero))).ignored,1);
});
test('invalid primary accounting cannot be hidden by a compaction marker',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dev-usage-test-'));
 try {
  const file=path.join(root,'bad.jsonl');fs.writeFileSync(file,trace({...primary,payload:{...primary.payload,usage:{...usage,total_tokens:999}}},count(),marker,count(zero)));
  const result=parseDevelopmentRollouts([file]);assert.equal(result.ok,false);assert.match(result.warnings.join('\n'),/total tokens/);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('repeated cumulative views do not double-count an actual provider response',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dev-usage-test-'));
 try {
  const file=path.join(root,'repeat.jsonl');fs.writeFileSync(file,trace(primary,count(),count(),marker,count(zero)));
  const result=parseDevelopmentRollouts([file]);assert.equal(result.ok,true);assert.equal(result.duplicateSnapshotsIgnored,1);assert.equal(result.contextSizeHintsIgnored,1);
  assert.equal(result.metrics.requestCount,1);assert.equal(result.metrics.totalTokens,110);
  assert.equal(stripCompactionContextHints(trace(count(),count(usage,{...usage,input_tokens:200,total_tokens:220}))).duplicateSnapshots,0);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
