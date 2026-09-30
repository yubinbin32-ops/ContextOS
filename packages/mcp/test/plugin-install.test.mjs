import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const installer = fileURLToPath(new URL('../../../scripts/install-plugin.mjs', import.meta.url));
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
  return { root, codexHome, contextosHome, state, run };
}

test('installation refreshes the Codex registered version after synchronizing local source', () => {
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.state)), { version: '2.7.1', adds: 1 });
    assert.equal(f.run('--check').status, 0);
    assert.equal(fs.readFileSync(path.join(f.codexHome, 'plugins/cache/personal/contextos/2.7.1/grammars/tree-sitter-python.wasm'), 'utf8'), 'python-grammar');
    const historical = path.join(f.codexHome, 'plugins/cache/personal/contextos/1.0.0/server');
    fs.mkdirSync(historical, { recursive: true });
    fs.writeFileSync(path.join(historical, 'contextos-mcp.mjs'), 'historical');
    assert.equal(f.run().status, 0);
    assert.equal(fs.readFileSync(path.join(historical, 'contextos-mcp.mjs'), 'utf8'), 'historical');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('check is read-only and rejects stale registration or stale bundle bytes', () => {
  const f = fixture();
  try {
    const stale = f.run('--check');
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /expected 2\.7\.1/);
    assert.equal(JSON.parse(fs.readFileSync(f.state)).adds, 0);
    assert.equal(f.run().status, 0);
    fs.writeFileSync(path.join(f.codexHome, 'plugins/cache/personal/contextos/2.7.1/server/contextos-mcp.mjs'), 'stale bundle');
    const drifted = f.run('--check');
    assert.notEqual(drifted.status, 0);
    assert.match(drifted.stderr, /differs from this build/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('check rejects missing or stale canonical parser assets without repairing them', () => {
  const f = fixture();
  try {
    const installed = f.run();
    assert.equal(installed.status, 0, installed.stderr);

    const pluginDir = path.join(f.root, 'repo/plugins/contextos');
    const grammarDir = path.join(pluginDir, 'grammars');
    const assets = [
      'server/web-tree-sitter.wasm',
      ...fs.readdirSync(grammarDir).filter((name) => name.endsWith('.wasm')).map((name) => `grammars/${name}`),
    ];
    for (const relative of assets) {
      const expected = fs.readFileSync(path.join(pluginDir, relative));
      const canonical = path.join(f.contextosHome, relative);

      fs.rmSync(canonical, { force: true });
      const missing = f.run('--check');
      assert.notEqual(missing.status, 0, `${relative} should be required`);
      assert.ok(missing.stderr.includes(canonical), `missing diagnostic should name ${canonical}: ${missing.stderr}`);
      assert.equal(fs.existsSync(canonical), false, '--check must leave missing files missing');

      const stale = Buffer.from(`stale ${relative}`);
      fs.writeFileSync(canonical, stale);
      const drifted = f.run('--check');
      assert.notEqual(drifted.status, 0, `${relative} should be compared byte-for-byte`);
      assert.ok(drifted.stderr.includes(canonical), `stale diagnostic should name ${canonical}: ${drifted.stderr}`);
      assert.deepEqual(fs.readFileSync(canonical), stale, '--check must leave stale bytes untouched');

      fs.writeFileSync(canonical, expected);
    }
    assert.equal(f.run('--check').status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.state)), { version: '2.7.1', adds: 1 });
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('installation accepts a marketplace source equal to the built plugin directory', () => {
  const f = fixture('2.7.1', true);
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.run('--check').status, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
