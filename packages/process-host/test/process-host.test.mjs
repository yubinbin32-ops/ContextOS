import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { sanitizeTerminalOutput, redactSecrets, runCommand, ProcessManager, ensureLogDir, pruneLogDir, writeSecureLog } from '../src/index.mjs';

test('Sanitizer strips ANSI, redacts secrets, and collapses build noise', () => {
  const secretText = 'Connecting with token: ghp_123456789012345678901234567890123456';
  assert.ok(redactSecrets(secretText).includes('[REDACTED_GITHUB_TOKEN]'));

  const raw = '\u001b[32m[1/100] Compiling a.ts\u001b[0m\r\n' +
    '\u001b[32m[2/100] Compiling b.ts\u001b[0m\r\n' +
    'Error: Failed to connect to database using token ghp_123456789012345678901234567890123456\n';

  const sanitized = sanitizeTerminalOutput(raw, { exitCode: 1 });
  assert.ok(!sanitized.text.includes('\u001b[32m'));
  assert.ok(!sanitized.text.includes('ghp_123456789012345678901234567890123456'));
  assert.ok(sanitized.text.includes('[REDACTED_GITHUB_TOKEN]'));
  assert.ok(sanitized.text.includes('Failed to connect to database'));
  assert.equal(sanitized.errors.length, 1);
});

test('runCommand executes command, logs out-of-context, and compresses context', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-runner-test-'));

  const receipt = await runCommand({
    command: 'echo "Hello ContextOS" && echo "Step 2 done"',
    projectRoot: tempDir,
  });

  assert.equal(receipt.exitCode, 0);
  assert.ok(receipt.summary.includes('succeeded'));
  assert.ok(receipt.logHandle);

  const fullLogPath = path.join(tempDir, receipt.logHandle);
  assert.ok(fs.existsSync(fullLogPath));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(fullLogPath).mode & 0o777, 0o600);
  }
  const fullContent = fs.readFileSync(fullLogPath, 'utf8');
  assert.ok(fullContent.includes('Hello ContextOS'));

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('log store creates private directories and files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-log-mode-test-'));
  const logDir = ensureLogDir(tempDir);
  const logFile = path.join(logDir, 'private.log');
  writeSecureLog(logFile, 'secret');

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(logDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('log store prunes by age, count, and byte budget', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-log-prune-test-'));
  const logDir = ensureLogDir(tempDir);
  const now = Date.now();
  const makeLog = (name, size, ageMs = 0) => {
    const filePath = path.join(logDir, name);
    fs.writeFileSync(filePath, 'x'.repeat(size));
    const mtime = new Date(now - ageMs);
    fs.utimesSync(filePath, mtime, mtime);
    return filePath;
  };

  const expired = makeLog('expired.log', 4, 40 * 24 * 60 * 60 * 1000);
  const oldest = makeLog('oldest.log', 6, 3000);
  const middle = makeLog('middle.log', 6, 2000);
  const newest = makeLog('newest.log', 6, 1000);

  const result = pruneLogDir(logDir, { maxFiles: 2, maxBytes: 100, maxAgeMs: 30 * 24 * 60 * 60 * 1000, now });
  assert.equal(result.removed, 2);
  assert.equal(result.kept, 2);
  assert.equal(fs.existsSync(expired), false);
  assert.equal(fs.existsSync(oldest), false);
  assert.equal(fs.existsSync(middle), true);
  assert.equal(fs.existsSync(newest), true);

  makeLog('large.log', 80, 500);
  const byteResult = pruneLogDir(logDir, { maxFiles: 10, maxBytes: 20, maxAgeMs: 30 * 24 * 60 * 60 * 1000, now });
  assert.equal(byteResult.kept, 1);
  assert.equal(fs.existsSync(path.join(logDir, 'large.log')), true);
  assert.equal(fs.existsSync(middle), false);
  assert.equal(fs.existsSync(newest), false);

  fs.rmSync(tempDir, { recursive: true, force: true });
});
test('Sanitizer treats the exit code as authoritative for successful command output', () => {
  const sanitized = sanitizeTerminalOutput('Recovered from a failed attempt successfully.\n', { exitCode: 0 });
  assert.match(sanitized.summary, /succeeded/i);
  assert.ok(!sanitized.summary.includes('Command failed'));
  assert.equal(sanitized.errors.length, 0);
});

test('Sanitizer preserves query output and distinct files instead of blind collapsing', () => {
  const lines = [];
  for (let i = 1; i <= 30; i++) {
    lines.push(`packages/core/src/file${i}.ts:${i}: const version = "2.5.5";`);
  }
  const raw = lines.join('\n') + '\n';
  const sanitized = sanitizeTerminalOutput(raw, { exitCode: 0, command: 'rg "version" packages/' });
  assert.match(sanitized.summary, /succeeded.*30 lines/i);
  assert.ok(sanitized.text.includes('file1.ts'));
  assert.ok(sanitized.text.includes('Matched files'));
  assert.ok(!sanitized.text.includes('lines collapsed).'));
});

test('Sanitizer returns verbatim output when raw: true is passed', () => {
  const raw = 'line 1\nline 2\nline 3\nline 4\nline 5\n';
  const sanitized = sanitizeTerminalOutput(raw, { exitCode: 0, raw: true });
  assert.equal(sanitized.text, raw.trimEnd());
});

test('ProcessManager starts, streams logs, and terminates process group', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-proc-test-'));
  const manager = new ProcessManager({ projectRoot: tempDir });

  // Start a background ticking process
  const session = await manager.startProcess({
    id: 'test-process',
    command: 'node -e "setInterval(() => console.log(\'tick-\' + Date.now()), 50)"',
  });

  assert.equal(session.id, 'test-process');
  assert.equal(session.status, 'running');
  assert.ok(session.pid > 0);

  // Wait for a few ticks to accumulate in the log
  await new Promise((r) => setTimeout(r, 250));

  const logs = manager.getLogs(session.id, { lines: 5 });
  assert.ok(logs.lines.length > 0);
  assert.ok(logs.lines.some((l) => l.includes('tick-')));

  // Stop process cleanly
  const stopped = await manager.stopProcess(session.id, { graceMs: 1000 });
  assert.equal(stopped.status, 'stopped');

  // Verify process is really dead
  let alive = true;
  try {
    process.kill(session.pid, 0);
  } catch (_) {
    alive = false;
  }
  assert.equal(alive, false);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('extractDiagnosticBlocks captures multi-line TAP failure frames with diffs and locations', () => {
  const tapOutput = `
# Subtest: 13. SagaCoordinator 在幂等窗口内返回缓存结果
ok 13 - 13. SagaCoordinator 在幂等窗口内返回缓存结果
  ---
  duration_ms: 0.133916
  type: 'test'
  ...
# Subtest: 15. SagaCoordinator 步骤超时后取消并补偿已完成步骤
not ok 15 - 15. SagaCoordinator 步骤超时后取消并补偿已完成步骤
  ---
  duration_ms: 11.907292
  type: 'test'
  location: '/path/to/test/saga-settlement.test.mjs:248:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    
    1 !== 0
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 0
  actual: 1
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///path/to/test/saga-settlement.test.mjs:270:10)
  ...
# Subtest: 16. 全链路多币种转账
ok 16 - 16. 全链路多币种转账
`;

  const sanitized = sanitizeTerminalOutput(tapOutput, { exitCode: 1 });
  assert.ok(sanitized.diagnostics.length > 0);
  const firstBlock = sanitized.diagnostics[0];
  assert.ok(firstBlock.includes('not ok 15'));
  assert.ok(firstBlock.includes('1 !== 0'));
  assert.ok(firstBlock.includes('saga-settlement.test.mjs:248:1'));
  assert.ok(firstBlock.includes('expected: 0'));
  assert.ok(firstBlock.includes('actual: 1'));
  assert.ok(sanitized.text.includes(firstBlock));
});

test('extractDiagnosticBlocks captures syntax error with caret and line pointers', () => {
  const syntaxErrOutput = `
/tmp/project/src/ledger.mjs:42
const x = \\\${amount};
          ^
SyntaxError: Invalid or unexpected token
    at ModuleLoader.moduleStrategy (node:internal/modules/esm/translators:168:18)
`;

  const sanitized = sanitizeTerminalOutput(syntaxErrOutput, { exitCode: 1 });
  assert.ok(sanitized.diagnostics.length > 0);
  const block = sanitized.diagnostics[0];
  assert.ok(block.includes('SyntaxError'));
  assert.ok(block.includes('/tmp/project/src/ledger.mjs:42'));
  assert.ok(block.includes('^'));
});
