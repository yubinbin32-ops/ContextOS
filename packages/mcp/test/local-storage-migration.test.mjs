import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initProjectWorkspace } from '../src/bootstrap-util.mjs';
import { getService, evictServices } from '../src/service-factory.mjs';
import { runDoctor, runInit } from '../src/system-tools.mjs';

test('legacy remote settings migrate locally without network calls or losing local data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-local-migration-'));
  const previousFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => { networkCalls++; throw Error('Unexpected network request'); };
  try {
    fs.mkdirSync(path.join(root, '.contextos'));
    const marker = path.join(root, '.contextos', 'project.json');
    fs.writeFileSync(marker, JSON.stringify({ id: 'preserved', storage: 'cloud', isCloud: true,
      cloudUrl: 'https://unreachable.invalid', cloudToken: 'old-secret', custom: { keep: true } }));
    const db = new DatabaseSync(path.join(root, '.contextos', 'state.sqlite'));
    db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('keep');"); db.close();
    const service = getService(root);
    assert.equal(service.projectId, 'preserved');
    const migrated = JSON.parse(fs.readFileSync(marker));
    assert.equal(migrated.storage, 'local');
    assert.deepEqual(migrated.custom, { keep: true });
    assert.equal(migrated.localMigration.remoteDataImported, false);
    for (const field of ['isCloud', 'cloudUrl', 'cloudToken', 'token']) assert.equal(field in migrated, false);
    assert.ok(fs.existsSync(marker + '.contextos.bak'));
    const check = new DatabaseSync(path.join(root, '.contextos', 'state.sqlite'));
    assert.equal(check.prepare('SELECT value FROM sentinel').get().value, 'keep'); check.close();
    assert.match(await runDoctor({ projectRoot: root }), /Remote-only data was not downloaded/);
    assert.equal(networkCalls, 0);
  } finally { globalThis.fetch = previousFetch; evictServices(root); fs.rmSync(root, { recursive: true, force: true }); }
});

test('explicit unsupported storage requests fail before modifying a project', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-local-only-'));
  try {
    assert.throws(() => initProjectWorkspace({ projectRoot: root, mode: 'cloud' }), /only local/);
    assert.throws(() => runInit({ projectRoot: root, mode: 'cloud' }), /only local/);
    assert.equal(fs.existsSync(path.join(root, '.contextos')), false);
    assert.equal(initProjectWorkspace({ projectRoot: root }).storage, 'local');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
