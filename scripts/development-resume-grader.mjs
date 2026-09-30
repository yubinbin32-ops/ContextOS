import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const installer = path.resolve(process.argv[2]);
function fixture(version = '2.6.0', sourceIsRepo = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-install-test-'));
  const repo = path.join(root, 'repo');
  const source = sourceIsRepo ? path.join(repo, 'plugins/contextos') : path.join(root, 'source');
  const codexHome = path.join(root, 'codex');
  const contextosHome = path.join(root, 'contextos');
  const plugin = path.join(repo, 'plugins/contextos');
  const state = path.join(root, 'state.json');
  const files = { 'server/web-tree-sitter.wasm': 'runtime-wasm', 'grammars/tree-sitter-python.wasm': 'python-grammar', 'grammars/tree-sitter-javascript.wasm': 'javascript-grammar', 'server/contextos-mcp.mjs': 'new bundle\n', 'skills/contextos/SKILL.md': 'new skill\n', '.codex-plugin/plugin.json': '{"name":"contextos","version":"2.7.1"}', '.mcp.json': '{}' };
  for (const target of [plugin, source, path.join(codexHome, 'plugins/cache/personal/contextos', version)]) {
    for (const [relative, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(target, relative)), { recursive: true });
      fs.writeFileSync(path.join(target, relative), content);
    }
  }
  fs.writeFileSync(state, JSON.stringify({ version, adds: 0 }));
  const bin = path.join(root, 'codex-stub.mjs');
  fs.writeFileSync(bin, `#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';
const statePath=process.env.INSTALL_TEST_STATE;const state=JSON.parse(fs.readFileSync(statePath));
const source=process.env.INSTALL_TEST_SOURCE;const args=process.argv.slice(2);
if(args[0]==='features'){console.log('tool_search stable true');}
else if(args[1]==='list'){console.log(JSON.stringify({installed:[{name:'contextos',pluginId:'contextos@personal',marketplaceName:'personal',version:state.version,installed:true,enabled:true,source:{source:'local',path:source}}]}));}
else if(args[1]==='add'){state.version=JSON.parse(fs.readFileSync(path.join(source,'.codex-plugin/plugin.json'))).version;state.adds++;fs.cpSync(source,path.join(process.env.CODEX_HOME,'plugins/cache/personal/contextos',state.version),{recursive:true});fs.writeFileSync(statePath,JSON.stringify(state));console.log('{}');}
else process.exit(2);
`);
  fs.chmodSync(bin, 0o755);
  const run = (...args) => spawnSync(process.execPath, [installer, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, CODEX_HOME: codexHome, CONTEXTOS_HOME: contextosHome, CONTEXTOS_CODEX_BIN: bin, INSTALL_TEST_STATE: state, INSTALL_TEST_SOURCE: source } });
  return { root, codexHome, state, run };
}
const verdicts=[];
for (const mode of ['healthy','parser-drift','bundle-drift']) {
 const f=fixture('2.7.1',true);
 try {
  assert.equal(f.run().status,0);
  const runtime=path.join(f.root,'contextos/server/web-tree-sitter.wasm');
  const grammar=path.join(f.root,'contextos/grammars/tree-sitter-python.wasm');
  const bundle=path.join(f.root,'contextos/server/contextos-mcp.mjs');
  if(mode==='parser-drift'){fs.unlinkSync(runtime);fs.writeFileSync(grammar,'stale');}
  if(mode==='bundle-drift')fs.writeFileSync(bundle,'stale');
  const before=fs.readFileSync(f.state,'utf8');
  const result=f.run('--check','--json');
  const report=JSON.parse(result.stdout);
  assert.equal(report.ok,mode==='healthy');assert.equal(result.status,mode==='healthy'?0:1);
  assert.equal(typeof report.version,'string');assert.ok(Array.isArray(report.errors));
  if(mode==='healthy')assert.equal(report.errors.length,0);
  for(const file of mode==='parser-drift'?[runtime,grammar]:mode==='bundle-drift'?[bundle]:[]){
   assert.ok(report.errors.some(e=>typeof e.path==='string' && (e.path===file || file.endsWith('/'+e.path)) && typeof e.message==='string' && e.message),'Missing structured path '+file);
  }
  assert.equal(fs.readFileSync(f.state,'utf8'),before);
  if(mode==='parser-drift'){assert.equal(fs.existsSync(runtime),false);assert.equal(fs.readFileSync(grammar,'utf8'),'stale');}
  if(mode==='bundle-drift')assert.equal(fs.readFileSync(bundle,'utf8'),'stale');
  verdicts.push({mode,pass:true});
 }catch(e){verdicts.push({mode,pass:false,error:e.message});}
 finally{fs.rmSync(f.root,{recursive:true,force:true});}
}
console.log(JSON.stringify({pass:verdicts.every(v=>v.pass),checks:verdicts},null,2));
process.exitCode=verdicts.every(v=>v.pass)?0:1;
