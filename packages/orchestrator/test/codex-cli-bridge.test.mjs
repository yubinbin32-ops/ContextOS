import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readPeakContextUsage, summarizeCodexStream } from '../../../scripts/adapters/codex-cli-bridge.mjs';

test('summarizeCodexStream reads the thread id, final message and turn usage', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } }),
  ].join('\n');
  const summary = summarizeCodexStream(stdout);
  assert.equal(summary.threadId, 'thread-1');
  assert.equal(summary.lastAgentMessage, 'final answer');
  assert.deepEqual(summary.usage, { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 });
});


test('bridge resume uses process cwd without unsupported resume --cd arguments', { skip: process.platform === 'win32' }, () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctxos-codex-resume-'));
 try {
  const bin=path.join(root,'bin'), workspace=path.join(root,'fixture');
  fs.mkdirSync(bin);fs.mkdirSync(workspace);
  const fake=path.join(bin,'codex');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2);
if(args[0]!=='exec'||args[1]!=='resume'||args.includes('-C')||args.includes('--cd')){
 console.error('invalid resume argument contract');process.exit(2);
}
if(process.cwd()!==process.env.EXPECTED_FIXTURE){console.error('incorrect workspace');process.exit(2)}
const output=args[args.indexOf('-o')+1];fs.writeFileSync(output,'RESUME_OK');
console.log(JSON.stringify({type:'thread.started',thread_id:args[2]}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESUME_OK'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:3,output_tokens:2}}));
`,{mode:0o755});
  const result=JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('../../../scripts/adapters/codex-cli-bridge.mjs',import.meta.url)),'--session-id','fake-thread','--workspace',workspace],{
   input:'Continue the synthetic fixture.',encoding:'utf8',
   env:{...process.env,PATH:bin+path.delimiter+path.dirname(process.execPath)+path.delimiter+process.env.PATH,CODEX_HOME:path.join(root,'codex-home'),EXPECTED_FIXTURE:fs.realpathSync(workspace)}
  }));
  assert.equal(result.status,'SUCCESS');assert.equal(result.thread_id,'fake-thread');assert.equal(result.content,'RESUME_OK');
  assert.deepEqual(result.usage,{input_tokens:10,cached_input_tokens:3,output_tokens:2});
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});

test('readPeakContextUsage reports the peak per-request prompt, not the turn sum', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-codex-bridge-'));
  try {
    const day = path.join(root, '2026', '10', '03');
    fs.mkdirSync(day, { recursive: true });
    const rollout = [
      JSON.stringify({ payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 4000, cached_input_tokens: 1000 }, total_token_usage: { input_tokens: 4000 } } } }),
      JSON.stringify({ payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 120000, cached_input_tokens: 90000 }, total_token_usage: { input_tokens: 124000 } } } }),
      JSON.stringify({ payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 30000, cached_input_tokens: 20000 }, total_token_usage: { input_tokens: 154000 } } } }),
    ].join('\n');
    fs.writeFileSync(path.join(day, 'rollout-2026-10-03T00-00-00-thread-peak.jsonl'), `${rollout}\n`, 'utf8');

    const usage = readPeakContextUsage('thread-peak', { sessionsRoot: root, windowTokens: 233000 });
    assert.equal(usage.input_tokens, 120000);
    assert.equal(usage.cached_input_tokens, 90000);
    assert.equal(usage.window_tokens, 233000);
    assert.equal(readPeakContextUsage('missing-thread', { sessionsRoot: root }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
