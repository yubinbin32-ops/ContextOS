import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { globalProfilePath, loadProfile, saveProfile } from '../src/profile.mjs';

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
