import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { V2Database, SyncEngine } from '../packages/storage/src/index.mjs';
import { PlanService, TaskService, KnowledgeService } from '../packages/application/src/index.mjs';
import { LanguageRegistry, CodeTools, TreeSitterParser } from '../packages/code-intel/src/index.mjs';
import { ContextOSV2Service } from '../packages/mcp/src/v2-service.mjs';

console.log('======================================================================');
console.log('      ContextOS Tree-Sitter & Host Native Mod Comprehensive E2E       ');
console.log('======================================================================');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-manual-verify-'));
const dbPath = path.join(tempDir, '.contextos', 'state.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const service = new ContextOSV2Service({
  projectRoot: tempDir,
  projectId: 'proj-verify-all',
  dbPath,
});

try {
  // -------------------------------------------------------------
  // Test 1: Tree-Sitter Multi-Language True AST Parsing
  // -------------------------------------------------------------
  console.log('\n>>> [Test 1] Tree-Sitter Multi-Language AST Extraction');

  const multiLangCases = [
    {
      lang: 'javascript',
      file: 'sample.js',
      code: `
export class PaymentService {
  constructor(apiKey) { this.apiKey = apiKey; }
  async charge(amount) { return true; }
}
export function refund(id) { return true; }
`,
      expectedSymbols: ['PaymentService', 'PaymentService.charge', 'refund'],
    },
    {
      lang: 'python',
      file: 'sample.py',
      code: `
class AnalyticsEngine:
    def __init__(self, cfg):
        self.cfg = cfg
    @property
    def compute_metrics(self):
        return {}

@decorator
def summarize(data):
    return len(data)
`,
      expectedSymbols: ['AnalyticsEngine', 'AnalyticsEngine.compute_metrics', 'summarize'],
    },
    {
      lang: 'rust',
      file: 'sample.rs',
      code: `
pub trait Repository<'a> {
  fn find_by_id(&'a self, id: u64) -> Option<&'a str>;
}
mod storage {
  pub struct SqlStore {
    pool_size: u32,
  }
}
struct LatLng(f64, f64);
impl SqlStore {
  pub fn new(size: u32) -> Self {
    SqlStore { pool_size: size }
  }
}
`,
      expectedSymbols: ['Repository', 'find_by_id', 'SqlStore', 'LatLng', 'SqlStore.new'],
    },
    {
      lang: 'go',
      file: 'sample.go',
      code: `
package gateway
type LoadBalancer interface {
  NextNode() string
}
func (lb *LoadBalancerImpl[T]) NextNode() string {
  return ""
}
func HealthCheck() bool {
  return true
}
`,
      expectedSymbols: ['LoadBalancer', 'LoadBalancer.NextNode', 'LoadBalancerImpl.NextNode', 'HealthCheck'],
    },
    {
      lang: 'swift',
      file: 'sample.swift',
      code: `
import SwiftUI
protocol DashboardView {
  func refreshData()
}
public struct DashTheme {
  var body: String { "Dash" }
}
`,
      expectedSymbols: ['DashboardView', 'DashboardView.refreshData', 'DashTheme', 'DashTheme.body'],
    },
    {
      lang: 'cpp',
      file: 'sample.cpp',
      code: `
#include <iostream>
namespace core {
  template <typename T>
  class Engine {
  public:
    void start() {}
  };
}
char* run(int x) { return nullptr; }
`,
      expectedSymbols: ['Engine', 'Engine::start', 'run'],
    },
    {
      lang: 'csharp',
      file: 'sample.cs',
      code: `
namespace Core {
  public enum ServiceState { Active, Inactive }
  public class AccountService {
    public async Task<bool> Authenticate(string token) { return true; }
  }
}
`,
      expectedSymbols: ['ServiceState', 'AccountService', 'AccountService.Authenticate'],
    },
    {
      lang: 'php',
      file: 'sample.php',
      code: `
<?php
namespace App\\Http;
enum UserRole: string { case ADMIN = 'admin'; }
class UserController {
  public function listUsers() { return []; }
}
function verifySession() { return true; }
`,
      expectedSymbols: ['UserRole', 'UserController', 'UserController::listUsers', 'verifySession'],
    },
    {
      lang: 'ruby',
      file: 'sample.rb',
      code: `
module Commerce
  class OrderManager
    def process_order(id)
      puts id
    end
  end
end
def calculate_tax(amt)
  amt * 0.1
end
`,
      expectedSymbols: ['Commerce', 'Commerce::OrderManager', 'Commerce::OrderManager#process_order', 'calculate_tax'],
    },
  ];

  for (const { lang, file, code, expectedSymbols } of multiLangCases) {
    const structure = LanguageRegistry.parseStructure(file, code);
    assert.equal(structure.language, lang === 'cpp' ? 'cpp' : lang);
    assert.equal(structure.capability, 'L3', `${lang} must have L3 true AST capability`);
    for (const sym of expectedSymbols) {
      assert.ok(
        structure.symbols.some((s) => s.name === sym || s.shortName === sym),
        `Missing symbol '${sym}' for language ${lang}`
      );
    }
    console.log(`  ✓ ${lang.toUpperCase().padEnd(10)} AST verified: [${expectedSymbols.join(', ')}]`);
  }

  // -------------------------------------------------------------
  // Test 2: Code Facade Surgical Operations (outline, read, edit, search)
  // -------------------------------------------------------------
  console.log('\n>>> [Test 2] Code Facade Surgical Operations (outline, read, edit, search)');

  const testFilePath = 'src/worker.js';
  const testFullPath = path.join(tempDir, testFilePath);
  fs.mkdirSync(path.dirname(testFullPath), { recursive: true });

  const initialWorkerCode = `
export class JobWorker {
  constructor(name) {
    this.name = name;
  }

  execute() {
    return 'executing ' + this.name;
  }
}

export function helper() {
  return 100;
}
`;
  fs.writeFileSync(testFullPath, initialWorkerCode, 'utf8');

  // 1. code(action: 'outline')
  const outline = await service.code({ action: 'outline', path: testFilePath });
  assert.ok(outline.includes('JobWorker'));
  assert.ok(outline.includes('execute'));
  assert.ok(outline.includes('helper'));
  console.log('  ✓ code.outline produced clean markdown outline');

  // 2. code(action: 'read', selector: { symbol: 'JobWorker.execute' })
  const readRes = await service.code({
    action: 'read',
    path: testFilePath,
    selector: { symbol: 'JobWorker.execute' },
    format: 'json',
  });
  assert.equal(readRes.symbol, 'JobWorker.execute');
  assert.ok(readRes.code.includes("return 'executing ' + this.name;"));
  console.log(`  ✓ code.read extracted symbol 'JobWorker.execute' [L${readRes.startLine}-L${readRes.endLine}]`);

  // 3. code(action: 'search', query: 'helper')
  const searchRes = await service.code({
    action: 'search',
    path: testFilePath,
    query: 'helper',
    format: 'json',
  });
  assert.ok(searchRes.matchingSymbols.some((s) => s.symbol === 'helper'));
  console.log("  ✓ code.search found symbol 'helper'");

  // 4. code(action: 'edit', targetContent, replacementContent)
  const editRes = await service.code({
    action: 'edit',
    path: testFilePath,
    targetContent: "return 'executing ' + this.name;",
    replacementContent: "return 'EXECUTED ' + this.name;",
    format: 'json',
  });
  assert.ok(editRes.newHash);
  assert.ok(editRes.locators.length > 0);
  assert.ok(fs.readFileSync(testFullPath, 'utf8').includes("return 'EXECUTED ' + this.name;"));
  console.log('  ✓ code.edit wrote to disk with automatic symbol re-anchoring');

  // -------------------------------------------------------------
  // Test 3: Host Native Modification Detection via mtime + SHA256 Comparison
  // -------------------------------------------------------------
  console.log('\n>>> [Test 3] Host Native Modification Detection via mtime + SHA256');

  // Bind src/worker.js to a block
  const blockWorker = {
    id: 'block-worker',
    projectId: 'proj-verify-all',
    title: 'Worker Subsystem',
    summary: 'Background job worker',
    artifactRefs: [
      {
        path: testFilePath,
        symbol: 'JobWorker',
        hash: crypto.createHash('sha256').update(fs.readFileSync(testFullPath, 'utf8')).digest('hex').slice(0, 16),
      },
    ],
  };
  service.db.saveBlock(blockWorker);

  // Create Plan & Task
  const plan = await service.plan({
    action: 'create',
    planData: {
      id: 'plan-verify',
      projectId: 'proj-verify-all',
      title: 'Verification Plan',
      phases: [{
        id: 'P0',
        order: 0,
        objective: 'Verify native host modifications through the service facade.',
        acceptance: ['Working-set hashes and AST locators reconcile after host edits.'],
        status: 'active',
      }],
    },
    format: 'json',
  });

  const task = await service.task({
    action: 'create',
    taskData: {
      id: 'task-native-mod',
      planId: 'plan-verify',
      phaseId: 'P0',
      title: 'Host Native Modification Verification Task',
      workingSet: {
        files: [testFilePath],
        scopeDirs: ['src'],
      },
    },
    format: 'json',
  });

  // Activate Task (captures baseline snapshot with mtimeMs, size, hash)
  await service.task({ action: 'develop', id: task.id });
  const activeTask = service.db.getTask(task.id);
  const baselineSnap = activeTask.baseline.fileSnapshots[testFilePath];
  assert.ok(baselineSnap, 'Baseline snapshot must be initialized');
  console.log(`  ✓ Baseline snapshot captured: mtimeMs=${baselineSnap.mtimeMs}, size=${baselineSnap.size}, hash=${baselineSnap.hash}`);

  // SIMULATE HOST NATIVE MODIFICATION:
  // User or external IDE directly writes changes to disk without ContextOS code tools
  await new Promise((r) => setTimeout(r, 60)); // Ensure mtime advances
  const externalModifiedContent = `
export class JobWorker {
  constructor(name) {
    this.name = name;
  }

  execute() {
    return 'EXECUTED_BY_HOST ' + this.name;
  }

  stop() {
    return true;
  }
}

export function helper() {
  return 200;
}
`;
  fs.writeFileSync(testFullPath, externalModifiedContent, 'utf8');
  console.log('  ! Simulated host IDE native modification on disk (outside ContextOS)');

  // Call task.reconcile to trigger mtime + SHA256 detection
  const reconcileResult = await service.task({
    action: 'reconcile',
    id: task.id,
    format: 'json',
  });

  assert.ok(reconcileResult.workingSet.files.includes(testFilePath));
  const newExpectedHash = crypto.createHash('sha256').update(externalModifiedContent).digest('hex').slice(0, 16);
  assert.equal(reconcileResult.baseline.fileSnapshots[testFilePath].hash, newExpectedHash);
  assert.equal(reconcileResult.baseline.fileSnapshots[testFilePath].modifiedLocally, true);
  console.log(`  ✓ Host native modification detected via mtime+SHA256! New hash: ${newExpectedHash}`);

  // Verify AST outline refreshed seamlessly (new method 'JobWorker.stop' present in locators)
  assert.ok(
    reconcileResult.contextSlice.locators.some((l) => l.symbol === 'JobWorker.stop'),
    "New symbol 'JobWorker.stop' should be present in refreshed locators"
  );
  console.log("  ✓ AST outlines refreshed seamlessly! Found new symbol 'JobWorker.stop' in locators");

  // Verify task note was recorded
  assert.ok(reconcileResult.notes.some((n) => n.text.includes('[Host Native Modification]')));
  console.log('  ✓ System note recorded in task journal');

  // Verify mtime-only touch does NOT produce a false positive
  const preTouchHash = reconcileResult.baseline.fileSnapshots[testFilePath].hash;
  const future = new Date(Date.now() + 10000);
  fs.utimesSync(testFullPath, future, future);
  const touchReconciled = await service.task({ action: 'reconcile', id: task.id, format: 'json' });
  assert.equal(touchReconciled.baseline.fileSnapshots[testFilePath].hash, preTouchHash);
  console.log('  ✓ mtime-only touch without content change verified: SHA256 prevented false positive');

  // Verify external file deletion handling
  const tempDelFile = path.join(tempDir, 'src', 'to_delete.js');
  fs.writeFileSync(tempDelFile, 'export function temp() {}', 'utf8');
  await service.task({ action: 'reconcile', id: task.id, format: 'json' });
  assert.ok(service.db.getTask(task.id).workingSet.files.includes('src/to_delete.js'));
  fs.unlinkSync(tempDelFile);
  const deleteReconciled = await service.task({ action: 'reconcile', id: task.id, format: 'json' });
  assert.equal(deleteReconciled.baseline.fileSnapshots['src/to_delete.js'], undefined);
  assert.ok(deleteReconciled.notes.some((n) => n.text.includes('Detected external deletion')));
  console.log('  ✓ External file deletion reconciliation verified: snapshot and locators cleanly purged');

  // Complete and sync task
  await service.task({
    action: 'check',
    id: task.id,
    checkData: {
      description: 'All verifications passed',
      passed: true,
      evidence: 'manual feature verification script',
    },
  });

  const syncResult = await service.task({
    action: 'sync',
    id: task.id,
    syncData: {
      blocks: [
        {
          id: 'block-worker',
          projectId: 'proj-verify-all',
          title: 'Worker Subsystem',
          summary: 'Background job worker',
          artifactRefs: [
            {
              path: testFilePath,
              symbol: 'JobWorker',
              hash: newExpectedHash,
            },
          ],
        },
      ],
    },
    format: 'json',
  });

  assert.equal(syncResult.task.status, 'completed');
  console.log('  ✓ Task synced successfully with 100% block coverage gate passed!');

  console.log('\n======================================================================');
  console.log('       ContextOS Comprehensive Manual Verification: 100% PASSED       ');
  console.log('======================================================================\n');
} finally {
  service.db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
