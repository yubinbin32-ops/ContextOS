import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createFixtureProject } from './fixture-project.mjs';
import { ContextOSV2Service } from '../packages/mcp/src/v2-service.mjs';
import { packageVersion } from './version.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = path.join(repoRoot, 'plugins', 'contextos', 'server', 'contextos-mcp.mjs');
assert.ok(fs.existsSync(bundlePath), 'The shipped MCP bundle is missing');

const fixture = createFixtureProject({ prefix: 'ctxos-p7-acceptance' });
const legacyFixture = createFixtureProject({ prefix: 'ctxos-p7-legacy' });
let legacyTransport = null;
let legacyClient = null;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bundlePath],
  cwd: repoRoot,
  stderr: 'inherit',
});
const client = new Client({ name: 'contextos-p7-acceptance', version: packageVersion });

const textOf = (result) => (result.content || []).map((chunk) => chunk.text || '').join('\n');
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: { projectRoot: fixture.root, ...args } });
  const text = textOf(result);
  assert.equal(Boolean(result.isError), false, `${name} failed: ${text}`);
  return text;
};
const callExpectError = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: { projectRoot: fixture.root, ...args } });
  assert.equal(Boolean(result.isError), true, `${name} unexpectedly succeeded`);
  return textOf(result);
};

try {
  await client.connect(transport);
  const listing = await client.listTools();
  assert.deepEqual(listing.tools.map((tool) => tool.name).sort(), ['change', 'explore', 'inspect', 'ops', 'pipeline', 'ship', 'verify']);

  const explored = await call('explore', { intent: 'inspect greet and the fixture test suite' });
  assert.match(explored, /# ContextOS explore/);
  const derivedProjectId = path.basename(fixture.root).toLowerCase().replace(/ +/g, '-');
  const projectConfig = JSON.parse(fs.readFileSync(path.join(fixture.root, '.contextos', 'project.json'), 'utf8'));
  assert.equal(projectConfig.id, derivedProjectId, 'fresh bootstrap must use the workspace-derived project id');

  const fileSearch = JSON.parse(await call('ops', {
    capability: 'code',
    action: 'search',
    args: { query: 'export', root: 'src/math.mjs', format: 'json' },
  }));
  assert.ok(fileSearch.scannedFiles > 0, 'single-file code search must scan the requested file in the shipped bundle');
  assert.ok(fileSearch.text.some((hit) => hit.path === 'src/math.mjs'));

  const beforeMath = fixture.read('src/math.mjs');
  const rejected = await call('change', {
    edits: [
      { path: 'src/math.mjs', target: 'return a + b;', replacement: 'return a + b + 1;' },
      { path: 'src/strings.mjs', target: 'this target does not exist', replacement: 'never' },
    ],
  });
  assert.match(rejected, /changeset rejected|no files were modified/i);
  assert.equal(fixture.read('src/math.mjs'), beforeMath);

  const changed = await call('change', {
    edits: [{ path: 'src/strings.mjs', target: 'return `hello ${name}`;', replacement: 'return `hello ${name}`; // p7 verified' }],
  });
  assert.match(changed, /edited/);
  assert.match(fixture.read('src/strings.mjs'), /p7 verified/);

  const verified = await call('verify', { commands: ['npm test'] });
  assert.match(verified, /Verdict: PASS/);
  const receiptId = verified.match(/receipt-[A-Za-z0-9-]+/)?.[0];
  assert.ok(receiptId, 'verify output must expose a receipt id');
  const receiptLogs = await call('verify', { mode: 'logs', id: receiptId, lines: 20 });
  assert.match(receiptLogs, /ContextOS verify \(logs\)/);
  assert.match(receiptLogs, /Receipt:/);

  const timeout = await call('verify', {
    command: 'node -e "setTimeout(() => {}, 5000)"',
    timeoutMs: 150,
  });
  assert.match(timeout, /timed out|timeout/i);

  const redacted = await call('verify', {
    command: 'echo "token ghp_123456789012345678901234567890123456" && exit 1',
  });
  assert.doesNotMatch(redacted, /ghp_123456789012345678901234567890123456/);
  assert.match(redacted, /REDACTED_GITHUB_TOKEN/);

  const logDir = path.join(fixture.root, '.contextos', 'logs');
  const logFiles = fs.readdirSync(logDir).filter((name) => name.endsWith('.log'));
  assert.ok(logFiles.length > 0, 'verify must leave a private receipt log');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(logDir, logFiles[0])).mode & 0o777, 0o600);
  }

  const ghost = await callExpectError('ops', {
    capability: 'block',
    action: 'bind',
    args: { id: 'block-p7-ghost', blockData: { title: 'Ghost', artifactRefs: [] } },
  });
  assert.match(ghost, /Ghost Block rejected/);

  const bound = await call('ops', {
    capability: 'block',
    action: 'bind_auto',
    args: { id: 'block-p7-strings', path: 'src/strings.mjs' },
  });
  assert.match(bound, /Auto-Bound|Total Block Locators/);

  await call('ops', {
    capability: 'chain',
    action: 'compose',
    args: { chainData: { id: 'chain-p7', title: 'P7 acceptance chain', memberIds: ['block-p7-strings'] } },
  });
  const chainValidation = await call('ops', { capability: 'chain', action: 'validate', args: {} });
  assert.match(chainValidation, /"valid": true/);

  await call('ops', {
    capability: 'plan',
    action: 'create',
    args: {
      id: 'plan-p7',
      format: 'json',
      planData: {
        title: 'P7 Real Acceptance',
        phases: [{
          id: 'P0',
          order: 0,
          objective: 'Exercise the real MCP lifecycle end to end.',
          acceptance: ['Plan, Task, checkpoint and graph state complete atomically.'],
          status: 'active',
        }],
        checkpoints: [{ id: 'cp-p7', title: 'Real MCP loop', status: 'pending' }],
      },
    },
  });
  await call('ops', {
    capability: 'task',
    action: 'create',
    args: {
      format: 'json',
      taskData: {
        id: 'task-p7',
        planId: 'plan-p7',
        phaseId: 'P0',
        title: 'Exercise the real MCP loop',
        workingSet: { files: ['src/strings.mjs'] },
      },
    },
  });

  await call('ops', {
    capability: 'plan',
    action: 'check',
    args: { id: 'plan-p7', checkpointId: 'cp-p7', passed: true, evidenceRef: 'p7-lifecycle-check' },
  });
  const prematureCompletion = await callExpectError('ops', {
    capability: 'plan',
    action: 'complete',
    args: { id: 'plan-p7', planData: { completedSummary: 'must fail while task is draft' } },
  });
  assert.match(prematureCompletion, /non-terminal tasks remain/);

  const retryMarker = path.join(fixture.root, 'retry.marker');
  const retryCommand = 'node -e "process.exit(require(\'fs\').existsSync(\'retry.marker\') ? 0 : 1)"';
  const retryFailed = await call('verify', { command: retryCommand });
  assert.match(retryFailed, /Verdict: FAIL/);
  fs.writeFileSync(retryMarker, 'ready\n');
  const retryPassed = await call('verify', { command: retryCommand });
  assert.match(retryPassed, /Verdict: PASS/);

  legacyFixture.write('src/legacy.mjs', 'export const legacy = true;\n');
  const legacyService = new ContextOSV2Service({ projectRoot: legacyFixture.root, projectId: 'contextos' });
  await legacyService.plan({
    action: 'create',
    planData: {
      id: 'plan-legacy-identity',
      title: 'Legacy identity plan',
      phases: [{
        id: 'P0',
        order: 0,
        objective: 'Prove legacy state survives identity adoption.',
        acceptance: ['The derived workspace sees the legacy plan.'],
        status: 'active',
      }],
    },
  });
  legacyService.close();
  const legacyProjectId = path.basename(legacyFixture.root).toLowerCase().replace(/ +/g, '-');
  fs.writeFileSync(
    path.join(legacyFixture.root, '.contextos', 'project.json'),
    JSON.stringify({ id: legacyProjectId, name: legacyProjectId, storage: 'local', isCloud: false }, null, 2) + '\n',
    'utf8'
  );
  legacyTransport = new StdioClientTransport({
    command: process.execPath,
    args: [bundlePath],
    cwd: repoRoot,
    stderr: 'inherit',
  });
  legacyClient = new Client({ name: 'contextos-p9-legacy-adoption', version: packageVersion });
  await legacyClient.connect(legacyTransport);
  const legacyPlanList = await legacyClient.callTool({
    name: 'ops',
    arguments: {
      projectRoot: legacyFixture.root,
      capability: 'plan',
      action: 'list',
      args: { format: 'json' },
    },
  });
  assert.equal(Boolean(legacyPlanList.isError), false, textOf(legacyPlanList));
  const legacyPlans = JSON.parse(textOf(legacyPlanList));
  assert.ok(legacyPlans.some((plan) => plan.id === 'plan-legacy-identity'));
  await legacyClient.close();
  legacyClient = null;
  await legacyTransport.close();
  legacyTransport = null;

  const shipped = await call('ship', { summary: 'P7 real MCP acceptance changed greet() and verified the fixture suite.' });
  assert.match(shipped, /Closure/);
  assert.match(shipped, /Superseded failures: 1/);
  const graphPath = path.join(fixture.root, '.contextos', 'graph.json');
  assert.ok(fs.existsSync(graphPath));

  const revisionBeforeCliSync = JSON.parse(fs.readFileSync(graphPath, 'utf8')).graphRevision;
  const runCliSync = () => execFileSync(
    process.execPath,
    [bundlePath, 'sync'],
    { cwd: fixture.root, encoding: 'utf8' }
  );
  assert.equal(JSON.parse(runCliSync()).ok, true);
  assert.equal(JSON.parse(runCliSync()).ok, true);
  const revisionAfterCliSync = JSON.parse(fs.readFileSync(graphPath, 'utf8')).graphRevision;
  assert.equal(
    revisionAfterCliSync,
    revisionBeforeCliSync,
    'reopening SQLite during repeated sync must not create another revision'
  );

  const noRoot = await client.callTool({ name: 'explore', arguments: { intent: 'missing root' } });
  assert.equal(Boolean(noRoot.isError), true);

  console.log('# P7 Real MCP Acceptance Passed!');
  console.log('- explore -> atomic change -> verify -> bind -> chain -> plan/task -> ship');
  console.log('- failure paths: multi-file rollback, timeout, secret redaction, Ghost Block, missing root, draft plan completion');
  console.log('- project identity, legacy adoption, single-file search and superseded receipts: verified');
  console.log('- private receipt logs and graph export: verified');
} finally {
  if (legacyClient) await legacyClient.close().catch(() => {});
  if (legacyTransport) await legacyTransport.close().catch(() => {});
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
  fixture.cleanup();
  legacyFixture.cleanup();
}
