import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import { sanitizeTerminalOutput, redactSecrets } from './sanitizer.mjs';
import {
  createLogSink,
  ensureLogDir,
  normalizeMaxLogBytes,
  pruneLogDir,
  writeSecureLog,
} from './log-store.mjs';

export async function runCommand({
  command,
  cwd = process.cwd(),
  env = process.env,
  maxChars = 1500,
  maxLogBytes,
  timeoutMs = 60000,
  projectRoot = cwd,
  raw = false,
  mode = 'auto',
}) {
  const maxLogBytesLimit = normalizeMaxLogBytes(maxLogBytes);
  const receiptId = `receipt-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const startTime = Date.now();

  const logDir = ensureLogDir(projectRoot);
  const logFile = path.join(logDir, `${receiptId}.log`);
  pruneLogDir(logDir);
  const boundedLog = maxLogBytesLimit === null
    ? null
    : createLogSink(logFile, { maxLogBytes: maxLogBytesLimit });
  const maxCaptureChars = 10_000_000;

  return new Promise((resolve) => {
    let stdoutData = '';
    let stderrData = '';
    let captureTruncated = false;
    let killedByTimeout = false;
    let logBytes = 0;
    let logTruncated = false;
    let settled = false;

    const finish = (receipt) => {
      if (settled) return;
      settled = true;
      resolve(receipt);
    };

    const safeCommand = typeof command === 'string' ? command : '';
    const isWin = process.platform === 'win32';
    const shell = isWin ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
    const shellArgs = isWin ? ['/d', '/s', '/c', safeCommand] : ['-c', safeCommand];

    const child = spawn(shell, shellArgs, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWin,
      windowsVerbatimArguments: isWin,
    });

    const timer = setTimeout(() => {
      killedByTimeout = true;
      if (isWin && child.pid) {
        try {
          execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
        } catch (_) {
          child.kill('SIGKILL');
        }
      } else {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch (_) {
          child.kill('SIGKILL');
        }
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (boundedLog) {
        const logState = boundedLog.write(redactSecrets(text));
        logBytes = logState.logBytes;
        logTruncated = logState.logTruncated;
      }
      if (stdoutData.length >= maxCaptureChars) {
        captureTruncated = true;
        return;
      }
      stdoutData += text.slice(0, maxCaptureChars - stdoutData.length);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (boundedLog) {
        const logState = boundedLog.write(redactSecrets(text));
        logBytes = logState.logBytes;
        logTruncated = logState.logTruncated;
      }
      if (stderrData.length >= maxCaptureChars) {
        captureTruncated = true;
        return;
      }
      stderrData += text.slice(0, maxCaptureChars - stderrData.length);
    });

    child.on('close', async (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      const rawOutput =
        stdoutData +
        (stderrData ? `\n--- STDERR ---\n${stderrData}` : '') +
        (captureTruncated ? '\n--- CAPTURE TRUNCATED ---\n' : '');
      const redactedOutput = redactSecrets(rawOutput);

      if (boundedLog) {
        try {
          const logState = await boundedLog.end();
          logBytes = logState.logBytes;
          logTruncated = logState.logTruncated;
        } catch (_) {}
      } else {
        // Preserve the existing full-log path when no bound is requested.
        try {
          writeSecureLog(logFile, redactedOutput);
          logBytes = Buffer.byteLength(redactedOutput, 'utf8');
        } catch (_) {}
      }

      const exitCode = killedByTimeout ? 124 : (code !== null ? code : 1);
      const sanitized = sanitizeTerminalOutput(rawOutput, { exitCode, maxChars, raw, mode, command: safeCommand });

      const relativeLogHandle = path.relative(projectRoot, logFile);

      finish({
        id: receiptId,
        command: redactSecrets(command),
        cwd,
        exitCode,
        durationMs,
        summary: killedByTimeout ? `Command timed out after ${timeoutMs}ms.` : sanitized.summary,
        text: sanitized.text,
        errors: sanitized.errors,
        diagnostics: sanitized.diagnostics || [],
        warnings: sanitized.warnings,
        logHandle: relativeLogHandle,
        logBytes,
        logTruncated,
        createdAt: new Date().toISOString(),
      });
    });

    child.on('error', async (err) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      if (boundedLog) {
        try {
          const logState = await boundedLog.end();
          logBytes = logState.logBytes;
          logTruncated = logState.logTruncated;
        } catch (_) {}
      }
      finish({
        id: receiptId,
        command: redactSecrets(command),
        cwd,
        exitCode: 1,
        durationMs,
        summary: `Command process error: ${err.message}`,
        text: `Error: ${err.message}`,
        errors: [err.message],
        warnings: [],
        logHandle: boundedLog ? path.relative(projectRoot, logFile) : null,
        logBytes,
        logTruncated,
        createdAt: new Date().toISOString(),
      });
    });
  });
}
