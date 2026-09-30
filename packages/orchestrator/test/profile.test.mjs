import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { globalProfilePath, loadProfile, saveProfile } from '../src/profile.mjs';
import { resolveMicroRoles } from '../src/micro-role-config.mjs';

test('profile inherits global settings and lets project settings override them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-profile-'));
  const globalHome = path.join(root, 'global-home');
  const previousHome = process.env.CONTEXTOS_HOME;
  process.env.CONTEXTOS_HOME = globalHome;
  try {
    fs.mkdirSync(path.join(root, '.contextos'), { recursive: true });
    saveProfile(root, {
      micro: { url: 'https://micro.test', model: 'small' },
      autoTriage: true,
      timeoutMs: 5000,
    }, { scope: 'global' });
    assert.ok(fs.existsSync(globalProfilePath()));

    fs.writeFileSync(
      path.join(root, '.contextos', 'profile.json'),
      JSON.stringify({ timeoutMs: 9000, micro: { model: 'project-model' } }, null, 2)
    );

    const profile = loadProfile(root);
    assert.equal(profile.timeoutMs, 9000);
    assert.equal(profile.autoTriage, true);
    assert.equal(profile.micro.url, 'https://micro.test');
    assert.equal(profile.micro.model, 'project-model');
  } finally {
    if (previousHome === undefined) delete process.env.CONTEXTOS_HOME;
    else process.env.CONTEXTOS_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('project micro settings deep-merge global settings without copying inherited credentials to disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-profile-micro-merge-'));
  const previous = process.env.CONTEXTOS_HOME;
  process.env.CONTEXTOS_HOME = path.join(root, 'global');
  try {
    saveProfile(root, { micro: { key: 'global-private-key', url: 'https://api.example.test', model: 'api-model' } }, { scope: 'global' });
    saveProfile(root, { micro: { model: 'project-model' } });
    const disk = JSON.parse(fs.readFileSync(path.join(root, '.contextos/profile.json')));
    assert.equal(disk.micro.model, 'project-model');
    assert.equal(disk.micro.key, undefined, 'global credentials are never copied into the project profile');
    assert.equal(loadProfile(root).micro.key, 'global-private-key');
    assert.equal(loadProfile(root).micro.url, 'https://api.example.test');
    assert.equal(loadProfile(root).micro.model, 'project-model');
    fs.writeFileSync(path.join(root, '.contextos/profile.json'), '{broken');
    assert.throws(() => saveProfile(root, { micro: { model: 'other' } }));
    assert.equal(fs.readFileSync(path.join(root, '.contextos/profile.json'), 'utf8'), '{broken');
  } finally {
    if (previous === undefined) delete process.env.CONTEXTOS_HOME;
    else process.env.CONTEXTOS_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('effective profiles merge global credentials and adapters with project overrides without persisting globals', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-profile-effective-'));
  const previousHome = process.env.CONTEXTOS_HOME;
  process.env.CONTEXTOS_HOME = path.join(root, 'global');
  try {
    saveProfile(root, {
      micro: { url: 'https://api.example.test/v1', key: 'private-global-key', model: 'global-model', thinking: 'high' },
      agents: { default: 'alpha', adapters: { alpha: { command: 'alpha', model: 'a1' }, beta: { command: 'beta' } } },
    }, { scope: 'global' });
    saveProfile(root, {
      micro: { model: 'project-model' },
      agents: { default: 'gamma', adapters: { alpha: { model: 'a2' }, beta: null, gamma: { command: 'gamma' } } },
    });

    const disk = JSON.parse(fs.readFileSync(path.join(root, '.contextos/profile.json'), 'utf8'));
    assert.equal(disk.micro.key, undefined, 'global secrets are never copied into the project profile');
    const profile = loadProfile(root);
    const roles = resolveMicroRoles(profile);
    assert.deepEqual(roles.micro, {
      url: 'https://api.example.test/v1', key: 'private-global-key', model: 'project-model', thinking: 'high',
    });
    assert.equal(roles.agents.default, 'gamma');
    assert.deepEqual(roles.agents.adapters.alpha, { command: 'alpha', model: 'a2' });
    assert.equal(roles.agents.adapters.beta, undefined, 'explicit null disables an inherited adapter');
    assert.deepEqual(roles.agents.adapters.gamma, { command: 'gamma' });
  } finally {
    if (previousHome === undefined) delete process.env.CONTEXTOS_HOME;
    else process.env.CONTEXTOS_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('explicit null disables the API role and an entire agent adapter map', () => {
  const roles = resolveMicroRoles({
    micro: null,
    agents: { default: 'legacy-cli', adapters: { 'legacy-cli': { command: 'legacy' } } },
  });
  assert.equal(roles.micro, null);
  assert.deepEqual(roles.agents.adapters['legacy-cli'], { command: 'legacy' });

  const disabled = resolveMicroRoles({
    agents: { adapters: null },
  });
  assert.equal(disabled.agents.default, null);
  assert.deepEqual(disabled.agents.adapters, {});
});

test('nested profile patches preserve sibling keys inside adapters', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-profile-nested-'));
  try {
    saveProfile(root, {
      agents: {
        adapters: {
          worker: {
            command: 'worker',
            model: 'capable',
            output: { format: 'text', contentPath: 'result', terminal: { enabled: true } },
          },
        },
      },
    });
    saveProfile(root, { agents: { adapters: { worker: { output: { usage: { aggregation: 'session' } } } } } });
    const stored = JSON.parse(fs.readFileSync(path.join(root, '.contextos/profile.json'), 'utf8'));
    const worker = stored.agents.adapters.worker;
    assert.equal(worker.command, 'worker');
    assert.equal(worker.output.format, 'text');
    assert.equal(worker.output.contentPath, 'result');
    assert.deepEqual(worker.output.terminal, { enabled: true });
    assert.deepEqual(worker.output.usage, { aggregation: 'session' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('private API Micro profile binds only the effective API role to a workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-profile-private-api-'));
  const previousHome = process.env.CONTEXTOS_HOME;
  const previousBinding = process.env.CONTEXTOS_API_MICRO_PROFILE;
  process.env.CONTEXTOS_HOME = path.join(root, 'global');
  try {
    saveProfile(root, {
      micro: { key: 'legacy-global-key', url: 'https://legacy.example.test/v1', model: 'legacy-model' },
      agents: { default: 'global-cli', adapters: { 'global-cli': { command: 'global-agent' } } },
    }, { scope: 'global' });
    fs.mkdirSync(path.join(root, '.contextos'), { recursive: true });
    fs.writeFileSync(path.join(root, '.contextos/profile.json'), JSON.stringify({ agents: { default: 'project-cli' } }));
    const privateProfile = path.join(root, 'private-api.json');
    fs.writeFileSync(privateProfile, JSON.stringify({ micro: { url: 'https://task.example.test/v1', key: 'task-private-key', model: 'task-model' } }), { mode: 0o600 });
    process.env.CONTEXTOS_API_MICRO_PROFILE = privateProfile;

    const profile = loadProfile(root);
    const roles = resolveMicroRoles(profile);
    assert.deepEqual(roles.micro, { url: 'https://task.example.test/v1', key: 'task-private-key', model: 'task-model' });
    assert.equal(roles.agents.default, 'project-cli', 'private API binding leaves CLI role inheritance untouched');
    assert.deepEqual(roles.agents.adapters['global-cli'], { command: 'global-agent' });
    assert.equal(profile.micro.key, 'task-private-key', 'the task binding replaces the effective API role');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.contextos/profile.json'), 'utf8')).micro, undefined);

    fs.writeFileSync(privateProfile, JSON.stringify({ micro: null }));
    assert.equal(resolveMicroRoles(loadProfile(root)).micro, null, 'explicit null disables only the API role');
  } finally {
    if (previousHome === undefined) delete process.env.CONTEXTOS_HOME;
    else process.env.CONTEXTOS_HOME = previousHome;
    if (previousBinding === undefined) delete process.env.CONTEXTOS_API_MICRO_PROFILE;
    else process.env.CONTEXTOS_API_MICRO_PROFILE = previousBinding;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('private API Micro profile rejects missing or extra top-level fields', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-profile-private-api-invalid-'));
  const previous = process.env.CONTEXTOS_API_MICRO_PROFILE;
  try {
    const file = path.join(root, 'private-api.json');
    process.env.CONTEXTOS_API_MICRO_PROFILE = file;
    assert.throws(() => loadProfile(root), /CONTEXTOS_API_MICRO_PROFILE must name a readable JSON file/);
    fs.writeFileSync(file, JSON.stringify({ micro: {}, agents: { default: 'must-not-leak' } }));
    assert.throws(() => loadProfile(root), /must contain exactly one `micro` object or null/);
    fs.writeFileSync(file, JSON.stringify({ micro: 'not-an-object' }));
    assert.throws(() => loadProfile(root), /must contain exactly one `micro` object or null/);
  } finally {
    if (previous === undefined) delete process.env.CONTEXTOS_API_MICRO_PROFILE;
    else process.env.CONTEXTOS_API_MICRO_PROFILE = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
