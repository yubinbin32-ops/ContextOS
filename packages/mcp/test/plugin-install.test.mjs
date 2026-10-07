import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  const files = { 'server/web-tree-sitter.wasm': 'runtime-wasm', 'grammars/tree-sitter-python.wasm': 'python-grammar', 'grammars/tree-sitter-javascript.wasm': 'javascript-grammar', 'server/contextos-mcp.mjs': 'new bundle\n', 'skills/contextos/SKILL.md': '---\nname: contextos\ndescription: "Required scaffold: use ContextOS."\n---\nnew skill\n', 'skills/contextos/notes/setup.md': 'new setup reference\n', 'skills/contextos-ops/SKILL.md': '---\nname: contextos-ops\ndescription: "Required operations guide: configure ContextOS."\n---\nnew ops skill\n', 'skills/contextos-ops/notes/micro-setup.md': 'new ops reference\n', '.codex-plugin/plugin.json': '{"name":"contextos","version":"2.7.1"}', '.mcp.json': '{}' };
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
  const run = (...args) => spawnSync(process.execPath, [installer, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, CODEX_HOME: codexHome, CONTEXTOS_HOME: contextosHome, CONTEXTOS_CLI_HOME: path.join(root, 'cli-home'), CONTEXTOS_CODEX_BIN: bin, INSTALL_TEST_STATE: state, INSTALL_TEST_SOURCE: source } });
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
    assert.equal(fs.readFileSync(path.join(f.contextosHome, 'skills/contextos/SKILL.md'), 'utf8'), '---\nname: contextos\ndescription: "Required scaffold: use ContextOS."\n---\nnew skill\n');
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

test('installer repairs the full cached skill tree and check detects missing or stale skill files', () => {
  const f = fixture('2.7.1');
  const installPath = path.join(f.codexHome, 'plugins/cache/personal/contextos/2.7.1/skills/contextos');
  const opsInstallPath = path.join(f.codexHome, 'plugins/cache/personal/contextos/2.7.1/skills/contextos-ops');
  try {
    const installed = f.run();
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(fs.readFileSync(path.join(installPath, 'notes/setup.md'), 'utf8'), 'new setup reference\n');
    assert.equal(fs.readFileSync(path.join(opsInstallPath, 'notes/micro-setup.md'), 'utf8'), 'new ops reference\n');
    const runtimeSkillPath = path.join(f.contextosHome, 'skills/contextos/SKILL.md');
    assert.equal(fs.readFileSync(runtimeSkillPath, 'utf8'), '---\nname: contextos\ndescription: "Required scaffold: use ContextOS."\n---\nnew skill\n');
    fs.writeFileSync(runtimeSkillPath, 'stale runtime skill');
    const staleRuntime = f.run('--check');
    assert.notEqual(staleRuntime.status, 0);
    assert.match(staleRuntime.stderr, /Runtime skill content differs from canonical/);
    assert.equal(f.run().status, 0, 'install repairs the runtime skill copy');
    assert.equal(fs.readFileSync(runtimeSkillPath, 'utf8'), '---\nname: contextos\ndescription: "Required scaffold: use ContextOS."\n---\nnew skill\n');

    fs.rmSync(path.join(opsInstallPath, 'SKILL.md'));
    const missingOps = f.run('--check');
    assert.notEqual(missingOps.status, 0);
    assert.match(missingOps.stderr, /contextos-ops/);
    assert.equal(fs.existsSync(path.join(opsInstallPath, 'SKILL.md')), false, '--check does not repair the ops skill');
    assert.equal(f.run().status, 0, 'install repairs the missing ops skill');
    assert.equal(fs.readFileSync(path.join(opsInstallPath, 'SKILL.md'), 'utf8'), '---\nname: contextos-ops\ndescription: "Required operations guide: configure ContextOS."\n---\nnew ops skill\n');

    fs.writeFileSync(path.join(installPath, 'notes/obsolete.md'), 'stale cached reference');
    const repaired = f.run();
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.equal(fs.existsSync(path.join(installPath, 'notes/obsolete.md')), false, 'sync removes stale skill files');

    fs.rmSync(path.join(installPath, 'notes/setup.md'));
    const missing = f.run('--check');
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /skill tree is missing or has stale files/);
    assert.equal(fs.existsSync(path.join(installPath, 'notes/setup.md')), false, '--check does not repair the cache');

    fs.writeFileSync(path.join(installPath, 'notes/setup.md'), 'new setup reference\n');
    fs.writeFileSync(path.join(installPath, 'notes/obsolete.md'), 'stale cached reference');
    const stale = f.run('--check');
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /skill tree is missing or has stale files/);
    assert.equal(fs.existsSync(path.join(installPath, 'notes/obsolete.md')), true, '--check leaves stale files untouched');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('installation refreshes and verifies CLI MCP version metadata', () => {
  const f = fixture('2.7.1');
  const cliHome = path.join(f.root, 'cli-home');
  const legacyConfig = path.join(cliHome, '.gemini', 'config', 'mcp_config.json');
  const canonicalConfig = path.join(f.contextosHome, 'mcp.json');
  const workspaceConfig = path.join(f.root, 'repo', '.agents', 'mcp_config.json');
  const server = { command: 'old-node', args: ['old-server.mjs'] };
  try {
    for (const configPath of [legacyConfig, canonicalConfig, workspaceConfig]) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
    }
    fs.writeFileSync(legacyConfig, JSON.stringify({ mcpServers: { contextos: { ...server, _version: '2.6.0', _build: 'stale-build' } } }, null, 2));
    fs.writeFileSync(canonicalConfig, JSON.stringify({ ...server, _version: '2.6.1' }, null, 2));
    fs.writeFileSync(workspaceConfig, JSON.stringify({ mcpServers: { contextos: { ...server, _version: '2.6.1' } } }, null, 2));

    const installed = f.run();
    assert.equal(installed.status, 0, installed.stderr);
    const expectedBuild = createHash('sha256').update('new bundle\n').digest('hex');
    assert.equal(JSON.parse(fs.readFileSync(legacyConfig, 'utf8')).mcpServers.contextos._version, '2.7.1');
    assert.equal(JSON.parse(fs.readFileSync(legacyConfig, 'utf8')).mcpServers.contextos._build, expectedBuild);
    assert.equal(JSON.parse(fs.readFileSync(canonicalConfig, 'utf8'))._version, '2.7.1');
    assert.equal(JSON.parse(fs.readFileSync(workspaceConfig, 'utf8')).mcpServers.contextos._version, '2.7.1');

    fs.writeFileSync(legacyConfig, JSON.stringify({ mcpServers: { contextos: { ...server, _version: '2.6.0', _build: expectedBuild } } }, null, 2));
    const staleVersion = f.run('--check');
    assert.notEqual(staleVersion.status, 0);
    assert.match(staleVersion.stderr, /reports version 2\.6\.0; expected 2\.7\.1/);
    assert.equal(JSON.parse(fs.readFileSync(legacyConfig, 'utf8')).mcpServers.contextos._version, '2.6.0');

    fs.writeFileSync(legacyConfig, JSON.stringify({ mcpServers: { contextos: { ...server, _version: '2.7.1', _build: 'stale-build' } } }, null, 2));
    const staleBuild = f.run('--check');
    assert.notEqual(staleBuild.status, 0);
    assert.match(staleBuild.stderr, /stale build hash/);
    assert.equal(f.run().status, 0, 'install repairs stale metadata');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('installation accepts a marketplace source equal to the built plugin directory', () => {
  const f = fixture('2.7.1', true);
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.run('--check').status, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('installation syncs both skills into CLI homes and clears the legacy lean-surface flag', () => {
  const f = fixture('2.7.1');
  const cliHome = path.join(f.root, 'cli-home');
  const canonicalSkill = path.join(cliHome, '.gemini', 'antigravity-cli', 'skills', 'contextos', 'SKILL.md');
  const legacyOpsSkill = path.join(cliHome, '.gemini', 'config', 'skills', 'contextos-ops', 'SKILL.md');
  const legacyConfig = path.join(cliHome, '.gemini', 'config', 'mcp_config.json');
  try {
    fs.mkdirSync(path.dirname(legacyConfig), { recursive: true });
    fs.writeFileSync(legacyConfig, JSON.stringify({ mcpServers: { contextos: { command: 'node', env: { CONTEXTOS_LEAN_SURFACE: '1' } } } }, null, 2));
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(canonicalSkill, 'utf8'), '---\nname: contextos\ndescription: "Required scaffold: use ContextOS."\n---\nnew skill\n');
    assert.equal(fs.readFileSync(legacyOpsSkill, 'utf8'), '---\nname: contextos-ops\ndescription: "Required operations guide: configure ContextOS."\n---\nnew ops skill\n');
    const config = JSON.parse(fs.readFileSync(legacyConfig, 'utf8'));
    assert.equal(config.mcpServers.contextos.env, undefined);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('check rejects a CLI skill copy that differs from canonical', () => {
  const f = fixture('2.7.1');
  const cliSkill = path.join(f.root, 'cli-home', '.gemini', 'antigravity-cli', 'skills', 'contextos', 'SKILL.md');
  try {
    assert.equal(f.run().status, 0);
    fs.writeFileSync(cliSkill, 'stale CLI skill\n');
    const drifted = f.run('--check');
    assert.notEqual(drifted.status, 0);
    assert.match(drifted.stderr, /CLI skill content differs from canonical/);
    assert.equal(fs.readFileSync(cliSkill, 'utf8'), 'stale CLI skill\n');
    assert.equal(f.run().status, 0);
    assert.equal(fs.readFileSync(cliSkill, 'utf8'), '---\nname: contextos\ndescription: "Required scaffold: use ContextOS."\n---\nnew skill\n');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('installation preconfigures AGY full tool permissions and keeps the ContextOS MCP grant', () => {
  const f = fixture('2.7.1');
  const cliHome = path.join(f.root, 'cli-home');
  const profilePath = path.join(f.contextosHome, 'profile.json');
  const settingsPath = path.join(cliHome, '.gemini', 'antigravity-cli', 'settings.json');
  try {
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(profilePath, JSON.stringify({
      micro: { url: 'https://private.example.test/v1', model: 'fixture-model' },
      agents: { default: 'agy', adapters: { agy: {
        command: 'agy', model: 'gemini-3.8-flash-high',
        args: ['--input-format', 'stream-json', '--model', '{model}', '--effort', '{thinking}', '--disable-slash-commands', '--sandbox'],
      } } },
    }, null, 2));
    fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: [] } }, null, 2));
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    const args = profile.agents.adapters.agy.args;
    assert.ok(args.includes('--dangerously-skip-permissions'));
    assert.ok(!args.includes('--disable-slash-commands'));
    assert.ok(!args.includes('--sandbox'));
    assert.ok(!args.includes('--effort'));
    assert.ok(!args.includes('{thinking}'));
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(settings.permissions.allow.includes('mcp(contextos/contextos)'));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('installation writes text-only MCP results into an existing Codex config without duplicating sections', () => {
  const f = fixture('2.7.1');
  const configPath = path.join(f.codexHome, 'config.toml');
  const original = '[projects."/repo"]\ntrust_level = "trusted"\n\n[mcp_servers.contextos]\ncommand = "node"\nargs = ["old-server.mjs"]\n';
  try {
    fs.writeFileSync(configPath, original);
    const installed = f.run();
    assert.equal(installed.status, 0, installed.stderr);
    const first = fs.readFileSync(configPath, 'utf8');
    assert.match(first, /\[mcp_servers\.contextos\.env\]/);
    assert.match(first, /CONTEXTOS_TEXT_ONLY_RESULTS = "1"/);
    assert.match(first, /\[projects\."\/repo"\]/, 'unrelated config sections must survive');
    assert.equal((first.match(/\[mcp_servers\.contextos\]/g) || []).length, 1);

    assert.equal(f.run().status, 0);
    const second = fs.readFileSync(configPath, 'utf8');
    assert.equal((second.match(/\[mcp_servers\.contextos\.env\]/g) || []).length, 1, 'reinstall must not duplicate the env section');
    assert.equal((second.match(/CONTEXTOS_TEXT_ONLY_RESULTS/g) || []).length, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('installation repairs an orphaned or duplicated contextos MCP env table', () => {
  const f = fixture('2.7.1');
  const configPath = path.join(f.codexHome, 'config.toml');
  const corrupted = [
    '[mcp_servers.contextos.env]',
    'CONTEXTOS_TEXT_ONLY_RESULTS = "1"',
    '',
    '[projects."/repo"]',
    'trust_level = "trusted"',
    '',
    '[mcp_servers.contextos]',
    'command = "node"',
    'args = ["old-server.mjs"]',
    '',
    '[mcp_servers.contextos.env]',
    'CONTEXTOS_VERSION = "2.6.0"',
    '',
  ].join('\n');
  try {
    fs.writeFileSync(configPath, corrupted);
    assert.equal(f.run().status, 0);
    const repaired = fs.readFileSync(configPath, 'utf8');
    assert.equal((repaired.match(/\[mcp_servers\.contextos\]/g) || []).length, 1);
    assert.equal((repaired.match(/\[mcp_servers\.contextos\.env\]/g) || []).length, 1);
    assert.match(repaired, /CONTEXTOS_TEXT_ONLY_RESULTS = "1"/);
    assert.match(repaired, /CONTEXTOS_VERSION = "2.6.0"/);
    assert.match(repaired, /\[projects\."\/repo"\]/, 'unrelated sections must survive the repair');
    assert.equal(f.run('--check').status, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
