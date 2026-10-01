import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCliUsage } from '../src/micro-cli.mjs';
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
