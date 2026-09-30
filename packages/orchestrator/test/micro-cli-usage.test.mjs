import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCliContextUsage, normalizeCliUsage } from '../src/micro-cli.mjs';
const mapping = { input: 'i', output: 'o', cache: 'c', reasoning: 'r', inputIncludesCache: false, reasoningIncludedInOutput: true };
test('unknown provider fields cannot become zero-cost usage', () => {
  for (const key of ['i', 'o', 'c', 'r']) for (const value of [undefined, null, '', '   ', false, true, [], {}, -1, NaN, Infinity]) {
    assert.equal(normalizeCliUsage({ i: 20, o: 10, c: 80, r: 4, [key]: value }, mapping), null, key + ':' + String(value));
  }
});
test('zero and numeric strings preserve cache and reasoning accounting', () => {
  assert.deepEqual(normalizeCliUsage({ i: '20', o: 10, c: '80', r: '4' }, mapping), {
    prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cached_input_tokens: 80, uncached_input_tokens: 20, reasoning_tokens: 4,
  });
  assert.equal(normalizeCliUsage({ i: 0, o: 0, c: 0, r: 0 }, mapping).total_tokens, 0);
});

test('context usage percentage uses provider telemetry and an explicit window', () => {
  assert.deepEqual(normalizeCliContextUsage({ p: 42.25, u: 98443 }, {
    percent: 'p', used: 'u', window: 233000,
  }), {
    percent: 42.3, usedTokens: 98443, windowTokens: 233000, source: 'provider',
  });
  assert.deepEqual(normalizeCliContextUsage({ i: 20, c: 116480 }, {
    input: 'i', cache: 'c', window: 233000, inputIncludesCache: false,
  }), {
    percent: 50, usedTokens: 116500, windowTokens: 233000, source: 'derived',
  });
  assert.equal(normalizeCliContextUsage({ i: 20 }, { input: 'i', window: 0, inputIncludesCache: false }), null);
  assert.equal(normalizeCliContextUsage({ i: 10, c: 20 }, { input: 'i', cache: 'c', window: 233000, inputIncludesCache: true }), null);
});
