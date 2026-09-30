import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeCommand, getCommandResult, summarizeCommandReceipt, cancelCommand } from '../src/command-service.mjs';
import { runCommand } from '../../process-host/src/runner.mjs';

const workspace = () => fs.mkdtempSync(path.join(os.tmpdir(), 'os-command-service-'));
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

test('split UTF-8 stdout and stderr preserve Chinese and emoji in the real execution log', async () => {
  const root = workspace();
  try {
    const script = path.join(root, 'split.mjs');
    fs.writeFileSync(script, `const text=Buffer.from('中文🙂\\n'); for(const byte of text){process.stdout.write(Buffer.from([byte])); process.stderr.write(Buffer.from([byte])); await new Promise(r=>setTimeout(r,20));}`);
    const receipt = await runCommand({ command: `${quote(process.execPath)} ${quote(script)}`, cwd: root, projectRoot: root, raw: true, maxChars: 2000 });
    assert.equal(receipt.exitCode, 0);
    const log = fs.readFileSync(path.join(root, receipt.logHandle), 'utf8');
    assert.equal((log.match(/中文🙂/g) || []).length, 2);
    assert.ok(!log.includes('\uFFFD'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('reuse and get preserve the same execution and do not run again', async () => {
  const root = workspace(); let count = 0;
  const runner = async () => { count++; return { id: 'receipt-test', command: 'given', exitCode: 0, text: 'done', summary: 'done', durationMs: 1 }; };
  try {
    const first = await executeCommand({ command: 'given', id: 'once' }, { projectRoot: root, runner });
    const second = await executeCommand({ command: 'given', id: 'once' }, { projectRoot: root, runner });
    const third = await executeCommand({ action: 'get', id: 'once' }, { projectRoot: root, runner });
    assert.equal(count, 1); assert.deepEqual(first, second); assert.deepEqual(second, third);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Micro selects exact original log text without overriding a failed execution', async () => {
  const root = workspace();
  try {
    const response = await summarizeCommandReceipt({ id: 'r', command: 'test', exitCode: 1, text: 'ok\nError: precise失败🙂\nlast\n', summary: 'failed' }, {
      projectRoot: root, focus: 'find failure', transport: async () => ({ summary: 'PASS', exitCode: 0, selection: [{ id: 'log', ranges: [[2, 2]] }], usage: null }),
    });
    assert.equal(response.status, 'failed'); assert.equal(response.receipt.exitCode, 1);
    assert.deepEqual(response.log, [{ line: 2, text: 'Error: precise失败🙂\n' }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Micro failure retains a successful execution receipt', async () => {
  const root = workspace();
  try {
    const result = await executeCommand({ command: 'given', focus: 'analyze' }, { projectRoot: root,
      runner: async () => ({ id: 'r', exitCode: 0, text: 'ok', summary: 'done' }),
      transport: async () => { throw new Error('provider down'); },
    });
    assert.equal(result.status, 'completed'); assert.equal(result.receipt.exitCode, 0);
    assert.match(result.missing.join(' '), /provider down/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('missing API key keeps the deterministic command log and reports the fallback', async () => {
  const root = workspace();
  try {
    const result = await executeCommand({ command: 'given', focus: 'analyze' }, { projectRoot: root,
      runner: async () => ({ id: 'r', exitCode: 0, text: 'ok\nError: meaningful line\n' }),
      transport: async () => {
        const error = new Error('Missing API key');
        error.code = 'MISSING_API_KEY';
        throw error;
      },
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.receipt.exitCode, 0);
    assert.ok(result.log.some((line) => /meaningful line/.test(line.text)));
    assert.match(result.missing.join(' '), /Missing API key/);
    assert.match(result.missing.join(' '), /deterministic log candidates were retained/);
    assert.equal(result.micro.errorCode, 'MISSING_API_KEY');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('background cancellation retains the command id and final cancelled receipt', async () => {
  const root = workspace();
  try {
    const script = path.join(root, 'wait.mjs');
    fs.writeFileSync(script, 'setInterval(()=>{},1000)');
    const start = await executeCommand({ command: `${quote(process.execPath)} ${quote(script)}`, background: true, id: 'cancel-test' }, { projectRoot: root });
    assert.equal(start.status, 'running');
    assert.equal(cancelCommand(root, start.id).cancellationRequested, true);
    let result;
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      result = getCommandResult(root, start.id);
      if (result.status !== 'running' && result.status !== 'executed') break;
    }
    assert.equal(result.status, 'cancelled'); assert.equal(result.receipt.exitCode, 130);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('same command id cannot silently describe a different command as executed', async () => {
  const root = workspace(); let count = 0;
  try {
    const options = { projectRoot: root, runner: async () => { count++; return { id: 'r', exitCode: 0, text: 'first', summary: 'first' }; } };
    const first = await executeCommand({ command: 'first command', id: 'bound' }, options);
    await assert.rejects(executeCommand({ command: 'second command', id: 'bound' }, options), /different command/);
    assert.equal(count, 1); assert.deepEqual(getCommandResult(root, 'bound'), first);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('passing TAP failure descriptions do not crowd out the actual failure and final statistics', async () => {
  const root = workspace();
  try {
    const text = Array.from({ length: 300 }, (_, i) => `# Subtest: detects error ${i}\nok ${i+1} - handles failed request\n  ---\n  duration_ms: 2\n  ...\n`).join('') +
      'not ok 301 - real regression\n  ---\n  error: actual invariant violated\n  stack: critical location\n  ...\n# tests 301\n# pass 300\n# fail 1\n';
    const result = await summarizeCommandReceipt({ id: 'tap', exitCode: 1, text, summary: 'heuristic 600 errors' }, { projectRoot: root, maxChars: 1200 });
    assert.ok(result.log.some(line => line.text.includes('actual invariant violated')));
    assert.ok(result.log.some(line => line.text.includes('# fail 1')));
    assert.ok(!result.summary.includes('600 errors'));
    assert.ok(result.log.reduce((sum, line) => sum + Array.from(line.text).length, 0) <= 1200);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('standard successful long command returns deterministic evidence without a paid Micro call', async () => {
  const root = workspace();
  try {
    const result = await summarizeCommandReceipt({ id: 'success', exitCode: 0, text: 'all good\n'.repeat(1000) }, {
      projectRoot: root, transport: () => assert.fail('No paid interpretation needed for ordinary success'),
    });
    assert.equal(result.status, 'completed'); assert.equal(result.micro, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('recover exact missing log ranges without executing or interpreting again, and reject altered logs', async () => {
  const root = workspace();
  try {
    const script = path.join(root, 'log.mjs');
    fs.writeFileSync(script, `for(let i=1;i<=100;i++)console.log('原文🙂 '+i);`);
    const result = await executeCommand({ command: `${quote(process.execPath)} ${quote(script)}`, id: 'log-recovery', logChars: 100 }, { projectRoot: root });
    const recovered = await executeCommand({ action: 'get', id: result.id, ranges: [[2,3],[3,4]] }, { projectRoot: root, runner: () => assert.fail('Must not execute again'), transport: () => assert.fail('Must not call Micro') });
    assert.deepEqual(recovered.log.map(line => line.line), [2,3,4]); assert.equal(recovered.log[0].text, '原文🙂 2\n');
    fs.appendFileSync(path.join(root, result.receipt.logHandle), 'altered');
    const stale = getCommandResult(root, result.id, { full: true });
    assert.deepEqual(stale.log, []); assert.match(stale.missing.join(' '), /log changed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('server transport flags do not leak into executed commands', async () => {
  const root = workspace();
  const previous = process.env.CONTEXTOS_TEXT_ONLY_RESULTS;
  process.env.CONTEXTOS_TEXT_ONLY_RESULTS = '1';
  try {
    const result = await executeCommand({
      id: 'env-clean',
      command: `${quote(process.execPath)} -e "process.stdout.write(String(process.env.CONTEXTOS_TEXT_ONLY_RESULTS))"`,
    }, { projectRoot: root });
    assert.equal(result.receipt.exitCode, 0);
    assert.equal((result.log || []).map((line) => line.text ?? '').join(''), 'undefined');
  } finally {
    if (previous === undefined) delete process.env.CONTEXTOS_TEXT_ONLY_RESULTS;
    else process.env.CONTEXTOS_TEXT_ONLY_RESULTS = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
