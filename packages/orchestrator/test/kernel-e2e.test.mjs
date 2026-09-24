import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { Orchestrator } from '../src/index.mjs';
import { ContextOSV2Service } from '../../mcp/src/v2-service.mjs';

function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-kernel-e2e-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.contextos'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "0"' } }, null, 2));
  fs.writeFileSync(path.join(dir, 'src', 'main.mjs'), 'export const main = 1;\n');
  try {
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  } catch (_) {}
  return dir;
}

test('kernel e2e: inspect with budget: full on a 10KB+ document returns full text without truncation', async () => {
  const projectRoot = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  // Generate a realistic 12KB+ document
  const header = '# Architecture Decision Record: Kernel Hardening\n\n## Context\n';
  const middleLines = [];
  for (let i = 1; i <= 350; i++) {
    middleLines.push(`- Section ${i}: Detailed specification note for invariant assertion and system behavior token governance.`);
  }
  const footer = '\n## Decision\nAll invariants must be satisfied without truncation under full budget.\n';
  const longDocContent = header + middleLines.join('\n') + footer;
  assert.ok(Buffer.byteLength(longDocContent, 'utf8') > 10 * 1024, 'Document should exceed 10KB');

  fs.writeFileSync(path.join(projectRoot, 'DECISION.md'), longDocContent, 'utf8');

  // Inspect with budget: 'full'
  const result = await orchestrator.dispatch('inspect', {
    path: 'DECISION.md',
    budget: 'full',
  });

  assert.ok(result.includes('# Architecture Decision Record: Kernel Hardening'), 'Must include header');
  assert.ok(result.includes('Section 1: Detailed specification note'), 'Must include beginning sections');
  assert.ok(result.includes('Section 350: Detailed specification note'), 'Must include trailing sections');
  assert.ok(result.includes('All invariants must be satisfied without truncation'), 'Must include footer');
  assert.ok(!result.includes('[TRUNCATED'), 'Must not contain truncation markers');
  assert.ok(!result.includes('omitted)'), 'Must not contain omission markers');
  assert.ok(result.length >= longDocContent.length, 'Must return full unclipped content');

  service.close();
});

test('kernel e2e: inspect with multi-segment ranges returns multi-segment lines accurately', async () => {
  const projectRoot = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  // Create a 100-line structured file
  const lines = [];
  for (let i = 1; i <= 100; i++) {
    lines.push(`Line ${i}: payload content ${i}`);
  }
  fs.writeFileSync(path.join(projectRoot, 'src', 'data.txt'), lines.join('\n') + '\n', 'utf8');

  // Request ranges: 1-10 and 50-60
  const result = await orchestrator.dispatch('inspect', {
    path: 'src/data.txt',
    ranges: [{ startLine: 1, endLine: 10 }, { startLine: 50, endLine: 60 }],
  });

  assert.match(result, /\[L1-L10\]/);
  assert.match(result, /\[L50-L60\]/);

  // Line 1 to 10 should be present
  assert.ok(result.includes('Line 1: payload content 1'));
  assert.ok(result.includes('Line 10: payload content 10'));

  // Line 50 to 60 should be present
  assert.ok(result.includes('Line 50: payload content 50'));
  assert.ok(result.includes('Line 60: payload content 60'));

  // Lines outside ranges should NOT be present
  assert.ok(!result.includes('Line 25: payload content 25'));
  assert.ok(!result.includes('Line 35: payload content 35'));
  assert.ok(!result.includes('Line 75: payload content 75'));

  service.close();
});

test('kernel e2e: change with { path, content, overwrite: true } overwrites the file cleanly', async () => {
  const projectRoot = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  const filePath = 'src/service.mjs';
  fs.writeFileSync(path.join(projectRoot, filePath), '// Old legacy implementation\nexport function legacy() { return false; }\n');

  const newContent = 'export function cleanService() {\n  return "clean-v2";\n}\n';
  const result = await orchestrator.dispatch('change', {
    path: filePath,
    content: newContent,
    overwrite: true,
  });

  assert.match(result, /ContextOS change/);
  const diskContent = fs.readFileSync(path.join(projectRoot, filePath), 'utf8');
  assert.equal(diskContent, newContent);

  service.close();
});

test('kernel e2e: change with { edits: [{ path, replacement, fullFile: true }] } replaces full file cleanly', async () => {
  const projectRoot = makeTempProject();
  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  const filePath = 'src/worker.mjs';
  fs.writeFileSync(path.join(projectRoot, filePath), 'export function oldWorker() { return 1; }\n');

  const fullReplacement = 'export class ModernWorker {\n  run() {\n    return true;\n  }\n}\n';
  const result = await orchestrator.dispatch('change', {
    edits: [{
      path: filePath,
      replacement: fullReplacement,
      fullFile: true,
    }],
  });

  assert.match(result, /ContextOS change/);
  assert.match(result, /edited `src\/worker\.mjs`/);
  const diskContent = fs.readFileSync(path.join(projectRoot, filePath), 'utf8');
  assert.equal(diskContent, fullReplacement);

  service.close();
});

test('kernel e2e: ship architecture gate blocks unbound new apps/packages in strict mode and passes once curated and linked', async () => {
  const projectRoot = makeTempProject();
  // Enable strict mode in profile.json
  fs.writeFileSync(
    path.join(projectRoot, '.contextos', 'profile.json'),
    JSON.stringify({ strict: true, verify: ['node -e "0"'] }, null, 2)
  );

  // Add an unbound file in a new package: packages/billing/index.mjs
  fs.mkdirSync(path.join(projectRoot, 'packages', 'billing'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'packages', 'billing', 'index.mjs'), 'export const billingEngine = 1;\n');

  const service = new ContextOSV2Service({ projectRoot, projectId: 'fixture' });
  const orchestrator = new Orchestrator({ service, projectRoot, projectId: 'fixture' });

  // Touch the file in change with verify passing
  await orchestrator.dispatch('change', {
    path: 'packages/billing/index.mjs',
    content: 'export const billingEngine = 2;\n',
    overwrite: true,
    verify: true,
  });

  // Attempt to ship: should be BLOCKED because packages/billing/index.mjs has no curated block
  const blockedResult = await orchestrator.dispatch('ship', { summary: 'shipping new billing package' });
  assert.match(blockedResult, /# ContextOS ship — BLOCKED \(architecture governance gate\)/);
  assert.match(blockedResult, /packages\/billing\/index\.mjs/);

  // Now create curated block covering packages/billing
  await orchestrator.dispatch('ops', {
    capability: 'block',
    action: 'bind_auto',
    args: {
      id: 'block-billing',
      path: 'packages/billing',
      blockData: { title: 'Billing Package', kind: 'package' },
    },
  });

  // Compose chain
  await orchestrator.dispatch('ops', {
    capability: 'chain',
    action: 'compose',
    args: {
      chainData: { id: 'chain-billing', title: 'Billing Chain', memberIds: ['block-billing'] },
    },
  });

  // Now ship should succeed cleanly!
  const passedResult = await orchestrator.dispatch('ship', { summary: 'shipping new billing package with curated block' });
  assert.match(passedResult, /# ContextOS ship/);
  assert.ok(!passedResult.includes('BLOCKED'));

  service.close();
});
