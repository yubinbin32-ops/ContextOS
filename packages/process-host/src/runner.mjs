import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { sanitizeTerminalOutput } from './sanitizer.mjs';

export async function runCommand({
  command,
  cwd = process.cwd(),
  env = process.env,
  maxChars = 1500,
  timeoutMs = 60000,
  projectRoot = cwd,
}) {
  const receiptId = `receipt-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const startTime = Date.now();

  const logDir = path.join(projectRoot, '.contextos', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${receiptId}.log`);

  return new Promise((resolve) => {
    let stdoutData = '';
    let stderrData = '';
    let killedByTimeout = false;

    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdoutData += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderrData += chunk.toString('utf8');
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      const rawOutput = stdoutData + (stderrData ? `\n--- STDERR ---\n${stderrData}` : '');

      // Persist raw full log out-of-context
      try {
        fs.writeFileSync(logFile, rawOutput, 'utf8');
      } catch (_) {}

      const exitCode = killedByTimeout ? 124 : (code !== null ? code : 1);
      const sanitized = sanitizeTerminalOutput(rawOutput, { exitCode, maxChars });

      const relativeLogHandle = path.relative(projectRoot, logFile);

      resolve({
        id: receiptId,
        command,
        cwd,
        exitCode,
        durationMs,
        summary: killedByTimeout ? `Command timed out after ${timeoutMs}ms.` : sanitized.summary,
        text: sanitized.text,
        errors: sanitized.errors,
        warnings: sanitized.warnings,
        logHandle: relativeLogHandle,
        createdAt: new Date().toISOString(),
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      resolve({
        id: receiptId,
        command,
        cwd,
        exitCode: 1,
        durationMs,
        summary: `Command process error: ${err.message}`,
        text: `Error: ${err.message}`,
        errors: [err.message],
        warnings: [],
        logHandle: null,
        createdAt: new Date().toISOString(),
      });
    });
  });
}
