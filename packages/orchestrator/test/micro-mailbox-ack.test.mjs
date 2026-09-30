import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMicroJob } from '../src/micro-delivery.mjs';
import { sendMicroMessage, receiveMicroMessages, acknowledgeMicroMessages } from '../src/micro-mailbox.mjs';

test('peek preserves queued corrections until only delivered ids are acknowledged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-mailbox-ack-'));
  try {
    createMicroJob(root, { jobId: 'child' });
    sendMicroMessage(root, 'child', 'first correction');
    sendMicroMessage(root, 'child', 'second correction');
    assert.equal(receiveMicroMessages(root, 'child', { peek: true }).length, 2);
    assert.equal(receiveMicroMessages(root, 'child', { peek: true }).length, 2);
    acknowledgeMicroMessages(root, 'child', [1]);
    assert.deepEqual(receiveMicroMessages(root, 'child', { peek: true }), [{ id: 2, message: 'second correction' }]);
    assert.equal(receiveMicroMessages(root, 'child').length, 1);
    assert.deepEqual(receiveMicroMessages(root, 'child'), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
