import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findDefaultProjectRoot, requireProjectRoot } from '../src/service-factory.mjs';

test('requireProjectRoot fails closed without an explicit absolute workspace root', () => {
  assert.throws(() => requireProjectRoot(), /Explicit projectRoot is required/);
  assert.throws(() => requireProjectRoot(''), /Explicit projectRoot is required/);
  assert.throws(() => requireProjectRoot('/definitely/not/a/contextos/workspace'), /does not exist/);
});

test('findDefaultProjectRoot refuses to infer a parent or home directory', () => {
  const previousCwd = process.cwd();
  const previousRoot = process.env.CONTEXTOS_PROJECT_ROOT;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-root-fail-closed-'));
  try {
    delete process.env.CONTEXTOS_PROJECT_ROOT;
    process.chdir(dir);
    assert.throws(() => findDefaultProjectRoot(), /refusing to infer a parent or home directory/);
  } finally {
    process.chdir(previousCwd);
    if (previousRoot === undefined) delete process.env.CONTEXTOS_PROJECT_ROOT;
    else process.env.CONTEXTOS_PROJECT_ROOT = previousRoot;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findDefaultProjectRoot accepts an explicit environment workspace', () => {
  const previousRoot = process.env.CONTEXTOS_PROJECT_ROOT;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-root-explicit-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}\n');
    process.env.CONTEXTOS_PROJECT_ROOT = dir;
    assert.equal(findDefaultProjectRoot(), dir);
  } finally {
    if (previousRoot === undefined) delete process.env.CONTEXTOS_PROJECT_ROOT;
    else process.env.CONTEXTOS_PROJECT_ROOT = previousRoot;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
