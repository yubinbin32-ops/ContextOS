import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContextOSV2Service } from '../packages/mcp/src/v2-service.mjs';

const repoRoot = process.cwd();
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-admin-cli-'));
const projectId = 'manual-admin-cli';
const serverPath = path.join(repoRoot, 'plugins/contextos/server/contextos-mcp.mjs');
fs.mkdirSync(path.join(projectRoot, '.contextos'), { recursive: true });
fs.writeFileSync(
  path.join(projectRoot, '.contextos/project.json'),
  JSON.stringify({ id: projectId, storage: 'local' }, null, 2) + '\n',
  'utf8'
);
const service = new ContextOSV2Service({ projectRoot, projectId });

function runAdmin(args) {
  const output = execFileSync(
    'node',
    ['--no-warnings=ExperimentalWarning', serverPath, ...args],
    { cwd: projectRoot, encoding: 'utf8' }
  );
  return JSON.parse(output);
}

try {
  fs.mkdirSync(path.join(projectRoot, 'app'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'app/Info.plist'), '<plist/>\n', 'utf8');
  fs.writeFileSync(path.join(projectRoot, 'app/Build.xcconfig'), 'PRODUCT_NAME=Demo\n', 'utf8');
  const infoContent = fs.readFileSync(path.join(projectRoot, 'app/Info.plist'));
  const buildConfigContent = fs.readFileSync(path.join(projectRoot, 'app/Build.xcconfig'));
  const infoHash = crypto.createHash('sha256').update(infoContent).digest('hex').slice(0, 16);
  const buildConfigHash = crypto.createHash('sha256').update(buildConfigContent).digest('hex').slice(0, 16);
  service.db.saveBlock({
    id: 'block-packaging',
    projectId,
    title: 'Packaging',
    artifactRefs: [{ path: 'app/Info.plist', anchorKind: 'file', hash: infoHash }],
  });
  service.syncEngine.exportGraphToJson(projectId, projectRoot);
  service.db.saveBlock({
    id: 'block-admin-sync',
    projectId,
    title: 'Admin sync marker',
    artifactRefs: [{ path: 'app/Build.xcconfig', anchorKind: 'file', hash: buildConfigHash }],
  });
  service.close({ stopProcesses: false });

  const synced = runAdmin(['sync']);
  assert.equal(synced.ok, true);
  const context = runAdmin(['context']);
  assert.equal(context.ok, true);
  const graph = JSON.parse(fs.readFileSync(path.join(projectRoot, '.contextos', 'graph.json'), 'utf8'));
  assert.equal(graph.data.blocks.some((block) => block.id === 'block-admin-sync'), true);

  console.log('Manual admin CLI flow passed.');
  console.log('- sync and context used the packaged writer channel.');
  console.log('- graph and SQLite remained synchronized.');
} finally {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}
