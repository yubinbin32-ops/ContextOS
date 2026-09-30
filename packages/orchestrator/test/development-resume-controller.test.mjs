import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
test('offline resume transport uses the same thread, compact threshold and complete accounting',{skip:process.platform==='win32'},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctxos-resume-offline-'));
 try{
  const auth=path.join(root,'auth');fs.mkdirSync(auth);fs.writeFileSync(path.join(auth,'auth.json'),'{"synthetic":true}');
  const bin=path.join(root,'fake.py');
  fs.writeFileSync(bin,`#!/usr/bin/env python3
import json,os,pathlib,shutil,sys
args=sys.argv[1:]
if args==['--version']:print('synthetic-resume-offline');sys.exit(0)
home=pathlib.Path(os.environ['CODEX_HOME']);workspace=pathlib.Path.cwd();source=pathlib.Path(os.environ['CONTROLLER_TEST_SOURCE'])
assert 'model_auto_compact_token_limit = 32000' in (home/'config.toml').read_text()
resumed='resume' in args
if resumed:assert args[args.index('resume')+2]=='offline-thread'
else:
 shutil.copyfile(source/'scripts/install-plugin.mjs',workspace/'scripts/install-plugin.mjs')
 regression="import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import test from 'node:test';test('canonical regression',()=>{const r=JSON.parse(execFileSync('node',["+json.dumps(str(source/'scripts/development-install-grader.mjs'))+",process.cwd()+'/scripts/install-plugin.mjs'],{encoding:'utf8'}));assert.equal(r.pass,true)});"
 (workspace/'packages/mcp/test/resume-offline.test.mjs').write_text(regression)
usage=dict(input_tokens=2000 if resumed else 1000,cached_input_tokens=1500 if resumed else 700,output_tokens=30,reasoning_output_tokens=0,total_tokens=2030 if resumed else 1030)
(home/'sessions').mkdir(exist_ok=True)
records=[dict(type='turn_context',payload=dict(model='gpt-6-luna')),dict(type='token_usage_record',payload=dict(response_id='second' if resumed else 'first',usage=usage,model_context_window=40000))]
if resumed:records.append(dict(type='compacted',payload={}))
with (home/'sessions/offline-thread.jsonl').open('a') as f:
 for record in records:f.write(json.dumps(record)+'\\n')
print(json.dumps(dict(type='thread.started',thread_id='offline-thread')),flush=True)
print(json.dumps(dict(type='turn.completed',usage=usage)),flush=True)
`);fs.chmodSync(bin,0o755);
  const driver=path.join(root,'driver.py');
  fs.writeFileSync(driver,`import importlib.util,json,pathlib,subprocess,sys
source=pathlib.Path(${JSON.stringify(repo)});sys.path.insert(0,str(source/'scripts'))
spec=importlib.util.spec_from_file_location('controller',source/'scripts/benchmark-development.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
real_run=subprocess.run
# Stub only the independent resume oracle here; its asset behavior is checked separately.
def run(argv,*args,**kwargs):
 if len(argv)>1 and 'development-resume-grader.mjs' in str(argv[1]):return subprocess.CompletedProcess(argv,0,json.dumps({'pass':True,'checks':[{'synthetic':True}]}),'')
 return real_run(argv,*args,**kwargs)
subprocess.run=run
sys.exit(module.main())
`);
  const output=path.join(root,'result');
  try{execFileSync('python3',[driver,'--task','installer-json-resume','--arms','native','--codex',bin,'--output',output],{cwd:repo,env:{...process.env,CODEX_HOME:auth,CONTROLLER_TEST_SOURCE:repo},timeout:60000,stdio:'pipe'});}
  catch(e){throw new Error(String(e.stdout||'')+String(e.stderr||'')+(fs.existsSync(path.join(output,'1-native/stderr.log'))?fs.readFileSync(path.join(output,'1-native/stderr.log'),'utf8'):''));}
  const result=JSON.parse(fs.readFileSync(path.join(output,'report.json'))).results[0];
  assert.equal(result.validForComparison,true);assert.equal(result.quality.resume.pass,true);
  assert.equal(result.accountingMode,'per-turn-cli');assert.equal(result.metrics.inputTokens,3000);
  assert.equal(result.metrics.requestCount,2);assert.equal(result.tools.compactionRecords,1);
  assert.equal(fs.existsSync(path.join(output,'1-native/codex/auth.json')),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
