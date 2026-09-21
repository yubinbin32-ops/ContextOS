import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configureJsonMcp, configureTomlCodex, deriveProjectId, initProjectWorkspace, mergePersonalMarketplaceDocument, saveGlobalCloudConfig, syncAllPlatforms } from '../src/bootstrap-util.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const bootstrapScript = path.join(repoRoot, 'scripts', 'bootstrap.mjs');

test('configureJsonMcp preserves unknown fields and rejects invalid JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-bootstrap-'));
  const configPath = path.join(dir, 'mcp.json');
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      other: { command: 'other' },
    },
    custom: { keep: true },
  }, null, 2));

  configureJsonMcp({
    configPath,
    serverScript: '/tmp/contextos-mcp.mjs',
    nodePath: '/usr/bin/node',
    version: '9.9.9',
  });
  const updated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(updated.custom.keep, true);
  assert.equal(updated.mcpServers.other.command, 'other');
  assert.equal(updated.mcpServers.contextos._version, '9.9.9');
  assert.ok(fs.existsSync(`${configPath}.contextos.bak`));

  fs.writeFileSync(configPath, '{ invalid json');
  assert.throws(
    () => configureJsonMcp({ configPath, serverScript: '/tmp/server.mjs', nodePath: '/usr/bin/node' }),
    /Refusing to overwrite invalid JSON/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bootstrap help and dry-run do not touch the target workspace', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-bootstrap-plan-'));
  const help = execFileSync(process.execPath, [bootstrapScript, '--help'], { encoding: 'utf8' });
  assert.match(help, /--dry-run/);

  const dryRun = execFileSync(
    process.execPath,
    [bootstrapScript, '--dry-run', '--target-root', dir, '--platforms', 'cursor'],
    { encoding: 'utf8' }
  );
  assert.match(dryRun, /Dry run/);
  assert.match(dryRun, /project\.json/);
  assert.match(dryRun, /contextos-mcp\.mjs/);
  assert.equal(fs.existsSync(path.join(dir, '.contextos')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bootstrap rejects missing values, unsupported modes, conflicting and unknown platform selections', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-bootstrap-invalid-'));
  const runFailure = (args) => {
    try {
      execFileSync(process.execPath, [bootstrapScript, ...args], { encoding: 'utf8', stdio: 'pipe' });
      assert.fail(`Expected bootstrap to fail for ${args.join(' ')}`);
    } catch (error) {
      assert.equal(error.status, 2);
      return String(error.stderr || error.stdout || '');
    }
  };

  assert.match(runFailure(['--target-root', dir, '--platforms']), /Missing value for --platforms/);
  assert.match(runFailure(['--mode', 'remote', '--target-root', dir, '--platforms', 'cursor']), /Unsupported mode/);
  assert.match(runFailure(['--all', '--platforms', 'cursor', '--target-root', dir]), /either --all or --platforms/);
  assert.match(runFailure(['--target-root', dir, '--platforms', 'not-a-platform']), /Unknown platform id/);
  assert.equal(fs.existsSync(path.join(dir, '.contextos')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('project metadata writes preserve unknown fields and refuse invalid JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-project-config-'));
  const projectPath = path.join(dir, '.contextos', 'project.json');
  fs.mkdirSync(path.dirname(projectPath), { recursive: true });
  fs.writeFileSync(projectPath, JSON.stringify({ id: 'keep-id', custom: { keep: true } }));

  const updated = initProjectWorkspace({ projectRoot: dir, mode: 'local', projectId: 'new-id' });
  assert.equal(updated.id, 'new-id');
  assert.equal(updated.custom.keep, true);
  assert.ok(fs.existsSync(`${projectPath}.contextos.bak`));

  fs.writeFileSync(projectPath, '{ invalid json');
  assert.throws(
    () => initProjectWorkspace({ projectRoot: dir, mode: 'local', projectId: 'new-id' }),
    /Refusing to overwrite invalid JSON/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('project identity derives from the workspace directory and is used by default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-project-id-'));
  const projectRoot = path.join(dir, 'My Project');
  fs.mkdirSync(projectRoot);
  try {
    assert.equal(deriveProjectId(projectRoot), 'my-project');
    const config = initProjectWorkspace({ projectRoot, mode: 'local' });
    assert.equal(config.id, 'my-project');
    assert.equal(config.name, 'my-project');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TOML configuration escapes quoted values and preserves unrelated sections', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-toml-'));
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, '[other]\nvalue = "keep"\n');
  configureTomlCodex({
    configPath,
    serverScript: '/tmp/server"quoted.mjs',
    nodePath: '/usr/bin/node"quoted',
    env: { CONTEXTOS_CLOUD_TOKEN: 'a"b\\nc' },
  });
  const content = fs.readFileSync(configPath, 'utf8');
  assert.match(content, /\[other\]/);
  assert.ok(content.includes('command = "/usr/bin/node\\"quoted"'));
  assert.ok(content.includes('CONTEXTOS_CLOUD_TOKEN = "a\\"b\\\\nc"'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('global cloud config preserves unknown fields and is owner-only on POSIX', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-home-'));
  try {
    const cloudPath = path.join(dir, '.contextos', 'cloud.json');
    fs.mkdirSync(path.dirname(cloudPath), { recursive: true });
    fs.writeFileSync(cloudPath, JSON.stringify({ custom: true, token: 'old' }));
    saveGlobalCloudConfig({ cloudUrl: 'https://example.test/', token: 'secret', homeDir: dir });
    const saved = JSON.parse(fs.readFileSync(cloudPath, 'utf8'));
    assert.equal(saved.custom, true);
    assert.equal(saved.cloudUrl, 'https://example.test');
    assert.equal(saved.token, 'secret');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(cloudPath).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('syncAllPlatforms rejects unknown platform ids', () => {
  assert.throws(
    () => syncAllPlatforms({ selectedPlatforms: ['not-a-platform'] }),
    /Unknown platform id/
  );
});

test('personal marketplace merge preserves other plugins and unknown fields', () => {
  const merged = mergePersonalMarketplaceDocument({
    name: 'personal',
    custom: { keep: true },
    plugins: [
      { name: 'other', source: { source: 'local', path: './plugins/other' } },
      { name: 'contextos', source: { source: 'old' } },
    ],
  });
  assert.equal(merged.custom.keep, true);
  assert.equal(merged.plugins.length, 2);
  assert.ok(merged.plugins.some((plugin) => plugin.name === 'other'));
  assert.equal(merged.plugins.at(-1).name, 'contextos');
  assert.equal(merged.plugins.at(-1).source.path, './plugins/contextos');
});
