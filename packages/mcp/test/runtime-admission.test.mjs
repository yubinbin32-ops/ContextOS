import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { classifyRuntime, probeRuntime } from '../../../scripts/runtime-admission.mjs';

describe('classifyRuntime pure classifier', () => {
  const validTool = {
    name: 'contextos',
    description: 'ContextOS entrypoint',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        args: { type: 'object' },
        projectRoot: { type: 'string' }
      },
      required: ['action', 'args', 'projectRoot']
    }
  };

  const removedToolNames = ['change', 'explore', 'inspect', 'ops', 'pipeline', 'ship', 'verify'];
  const removedTools = removedToolNames.map(name => ({ name }));

  test('accepts valid single-tool runtime matching expected version', () => {
    const result = classifyRuntime({
      serverInfo: { name: 'contextos', version: '2.7.2' },
      tools: [validTool],
      expectedVersion: '2.7.2',
    });

    assert.equal(result.ok, true);
    assert.equal(result.version, '2.7.2');
    assert.equal(result.surface, 'single');
    assert.deepEqual(result.toolNames, ['contextos']);
    assert.equal(result.errors.length, 0);
  });

  test('rejects the removed seven-tool surface', () => {
    const result = classifyRuntime({
      serverInfo: { name: 'contextos', version: '2.7.2' },
      tools: removedTools,
      expectedVersion: '2.7.2',
    });

    assert.equal(result.ok, false);
    assert.equal(result.version, '2.7.2');
    assert.equal(result.surface, 'single');
    assert.deepEqual(result.toolNames, removedToolNames);
    assert.ok(result.errors.length > 0);
    assert.match(result.errors[0], /exactly the 'contextos' tool/i);
  });

  test('rejects version mismatch', () => {
    const result = classifyRuntime({
      serverInfo: { name: 'contextos', version: '2.6.0' },
      tools: [validTool],
      expectedVersion: '2.7.2',
    });

    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /Version mismatch/);
  });

  test('rejects missing server version', () => {
    const result = classifyRuntime({
      serverInfo: { name: 'contextos' },
      tools: [validTool],
      expectedVersion: '2.7.2',
    });

    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /Missing or invalid server version/);
  });

  test('rejects contextos tool with missing required schema property', () => {
    const malformedTool = {
      name: 'contextos',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          args: { type: 'object' }
          // projectRoot is missing
        }
      }
    };

    const result = classifyRuntime({
      serverInfo: { version: '2.7.2' },
      tools: [malformedTool],
      expectedVersion: '2.7.2',
    });

    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /projectRoot/);
  });

  test('rejects contextos tool missing inputSchema', () => {
    const result = classifyRuntime({
      serverInfo: { version: '2.7.2' },
      tools: [{ name: 'contextos' }],
      expectedVersion: '2.7.2',
    });

    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /missing inputSchema/);
  });

  test('single-tool surface rejects unexpected extra tools', () => {
    const result = classifyRuntime({
      serverInfo: { version: '2.7.2' },
      tools: [validTool, { name: 'extra_tool' }],
      expectedVersion: '2.7.2',
    });

    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /exactly the 'contextos' tool/);
  });
});

describe('probeRuntime process probe', () => {
  test('proves a valid fake new server connects and classifies correctly', async () => {
    const fakeServerScript = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      const res = {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'contextos', version: '2.7.2' }
        }
      };
      process.stdout.write(JSON.stringify(res) + '\\n');
    } else if (msg.method === 'tools/list') {
      const res = {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              name: 'contextos',
              description: 'ContextOS tool',
              inputSchema: {
                type: 'object',
                properties: {
                  action: { type: 'string' },
                  args: { type: 'object' },
                  projectRoot: { type: 'string' }
                }
              }
            }
          ]
        }
      };
      process.stdout.write(JSON.stringify(res) + '\\n');
    }
  } catch (e) {}
});
rl.on('close', () => { process.exit(0); });
`;

    const result = await probeRuntime({
      command: process.execPath,
      args: ['-e', fakeServerScript],
      expectedVersion: '2.7.2',
      timeoutMs: 3000
    });

    assert.equal(result.ok, true);
    assert.equal(result.version, '2.7.2');
    assert.equal(result.surface, 'single');
    assert.deepEqual(result.toolNames, ['contextos']);
    assert.equal(result.errors.length, 0);
  });

  test('absent executable reports error and never leaks credentials', async () => {
    const secret = 'SUPER_SECRET_TOKEN_ABSENT_EXEC_123';
    const result = await probeRuntime({
      command: 'nonexistent-executable-admission-test-xyz-98765',
      env: { SECRET_VAR: secret },
      timeoutMs: 1000
    });

    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(secret), false, 'Must never leak credentials');
  });

  test('broken handshake closes child and never leaks credentials', async () => {
    const secret = 'SUPER_SECRET_TOKEN_BROKEN_HANDSHAKE_456';
    const brokenScript = `
console.log('not valid json handshake');
process.exit(1);
`;
    const result = await probeRuntime({
      command: process.execPath,
      args: ['-e', brokenScript],
      env: { API_SECRET: secret },
      timeoutMs: 1500
    });

    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(secret), false, 'Must never leak credentials');
  });

  test('proves no orphan on timeout and never leaks credentials', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-orphan-'));
    const pidFile = path.join(tmpDir, 'child.pid');
    const secret = 'SUPER_SECRET_TOKEN_TIMEOUT_ORPHAN_789';

    const hangingScript = `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 10000);
`;

    try {
      const result = await probeRuntime({
        command: process.execPath,
        args: ['-e', hangingScript],
        env: { SECRET_TOKEN: secret },
        timeoutMs: 200
      });

      assert.equal(result.ok, false);
      assert.ok(result.errors.length > 0);
      assert.match(result.errors[0], /timed out/i);

      // Verify credentials were not leaked
      const serialized = JSON.stringify(result);
      assert.equal(serialized.includes(secret), false, 'Must never leak credentials');

      // Verify child process was terminated (no orphan)
      assert.ok(fs.existsSync(pidFile), 'PID file should have been written');
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      assert.ok(pid > 0, 'PID must be positive integer');

      // Poll briefly to ensure OS processed signal
      let isAlive = true;
      for (let i = 0; i < 15; i++) {
        try {
          process.kill(pid, 0);
          await new Promise(r => setTimeout(r, 50));
        } catch (err) {
          if (err.code === 'ESRCH') {
            isAlive = false;
            break;
          }
        }
      }
      assert.equal(isAlive, false, 'Child process must be killed on timeout (no orphan)');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
