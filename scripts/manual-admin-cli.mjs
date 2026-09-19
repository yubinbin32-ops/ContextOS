import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  service.db.saveBlock({
    id: 'block-packaging',
    projectId,
    title: 'Packaging',
    artifactRefs: [{ path: 'app/Info.plist', anchorKind: 'file', hash: 'placeholder' }],
  });
  service.artifactService.recordArtifact({ path: 'app/Info.plist', category: 'config' });
  service.artifactService.recordArtifact({ path: 'app/Build.xcconfig', category: 'config' });
  service.syncEngine.exportGraphToJson(projectId, projectRoot);
  service.close({ stopProcesses: false });

  const linked = runAdmin(['artifact', 'link', '--path', 'app/Info.plist', '--block-id', 'block-packaging']);
  assert.equal(linked.ok, true);
  const ignored = runAdmin([
    'artifact',
    'ignore',
    '--path',
    'app/Build.xcconfig',
    '--reason',
    'manual admin verification',
  ]);
  assert.equal(ignored.ok, true);
  const list = runAdmin(['artifact', 'list']);
  assert.equal(list.ok, true);
  assert.equal(list.result.length, 2);
  assert.equal(list.result.find((item) => item.path === 'app/Info.plist').status, 'linked');
  assert.equal(list.result.find((item) => item.path === 'app/Build.xcconfig').status, 'ignored');

  console.log('Manual admin CLI flow passed.');
  console.log('- link and ignore actions used the packaged writer channel.');
  console.log('- graph and SQLite remained synchronized.');
} finally {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}
