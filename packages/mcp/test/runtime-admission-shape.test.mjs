import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRuntime } from '../../../scripts/runtime-admission.mjs';

test('classifyRuntime: rejects root inputSchema with type array even if properties exist', () => {
  const result = classifyRuntime({
    serverInfo: '1.0.0',
    tools: [
      {
        name: 'contextos',
        inputSchema: {
          type: 'array',
          properties: {
            action: { type: 'string' },
            args: { type: 'object' },
            projectRoot: { type: 'string' }
          }
        }
      }
    ]
  });

  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors.some(err => err.includes("schema type must be object")));
});

test('classifyRuntime: rejects tool list with one valid tool plus an invalid nameless record', () => {
  const validTool = {
    name: 'contextos',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        args: { type: 'object' },
        projectRoot: { type: 'string' }
      }
    }
  };
  const namelessRecord = {
    description: 'invalid nameless tool record'
  };

  const result = classifyRuntime({
    serverInfo: '1.0.0',
    tools: [validTool, namelessRecord]
  });

  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.length > 0);
});

test('classifyRuntime: accepts valid object schema case', () => {
  const validTool = {
    name: 'contextos',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        args: { type: 'object' },
        projectRoot: { type: 'string' }
      }
    }
  };

  const result = classifyRuntime({
    serverInfo: '1.0.0',
    tools: [validTool]
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.errors.length, 0);
  assert.deepStrictEqual(result.toolNames, ['contextos']);
});
