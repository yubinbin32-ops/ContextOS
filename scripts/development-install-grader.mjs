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
for (const asset of ['server/web-tree-sitter.wasm','grammars/tree-sitter-python.wasm','grammars/tree-sitter-javascript.wasm']) {
 for (const kind of ['missing','stale']) {
  const f=fixture('2.7.1',true);
  try {
   assert.equal(f.run().status,0);
   assert.equal(f.run('--check').status,0);
   const target=path.join(f.root,'contextos',asset);
   if(kind==='missing')fs.unlinkSync(target);else fs.writeFileSync(target,'stale-runtime');
   const stateBefore=fs.readFileSync(f.state,'utf8');
   const result=f.run('--check');
   assert.notEqual(result.status,0,'check accepted '+kind+' '+asset);
   assert.ok(result.stderr.includes(target),'missing affected path');
   assert.equal(fs.readFileSync(f.state,'utf8'),stateBefore,'registration changed');
   if(kind==='missing')assert.equal(fs.existsSync(target),false,'check repaired missing file');
   else assert.equal(fs.readFileSync(target,'utf8'),'stale-runtime','check repaired stale file');
   assert.equal(f.run().status,0,'install did not repair drift');
   assert.equal(f.run('--check').status,0,'repaired install rejected');
   verdicts.push({asset,kind,pass:true});
  } catch(e) {verdicts.push({asset,kind,pass:false,error:e.message});}
  finally{fs.rmSync(f.root,{recursive:true,force:true});}
 }
}
console.log(JSON.stringify({pass:verdicts.every(v=>v.pass),checks:verdicts},null,2));
process.exitCode=verdicts.every(v=>v.pass)?0:1;
