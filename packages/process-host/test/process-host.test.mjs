import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { sanitizeTerminalOutput, stripAnsi, redactSecrets, runCommand, ProcessManager } from '../src/index.mjs';

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
  const fullContent = fs.readFileSync(fullLogPath, 'utf8');
  assert.ok(fullContent.includes('Hello ContextOS'));

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('ProcessManager starts, streams logs, and terminates process group', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-proc-test-'));
  const manager = new ProcessManager({ projectRoot: tempDir });

  // Start a background ticking process
  const session = await manager.startProcess({
    command: 'node -e "setInterval(() => console.log(\'tick-\' + Date.now()), 50)"',
  });

  assert.ok(session.id);
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
