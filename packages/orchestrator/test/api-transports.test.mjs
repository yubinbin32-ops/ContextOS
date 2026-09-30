import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvidenceTransport, normalizeApiUsage } from '../src/api-transports.mjs';

function response(data, { status = 200, ok = status >= 200 && status < 300 } = {}) {
  return { status, ok, text: async () => JSON.stringify(data) };
}

function makeFetch(data, options = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init, body: JSON.parse(init.body) });
    return response(typeof data === 'function' ? data(requests.at(-1)) : data, options);
  };
  return { fetchImpl, requests };
}

test('Responses transport preserves reasoning/tool state and normalizes a selection result', async () => {
  const { fetchImpl, requests } = makeFetch((request) => request.body.input.some((item) => item.type === 'function_call_output')
    ? {
        id: 'resp-2',
        model: 'deepseek-flash',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({
          summary: 'One focused source slice is sufficient.',
          selection: [{ id: 'read-1', path: 'src/auth.mjs', contentHash: 'sha256:a', ranges: [[12, 30]] }],
          missing: [],
        }) }] }],
        usage: { input_tokens: 7, output_tokens: 9, total_tokens: 16 },
      }
    : {
        id: 'resp-1',
        model: 'deepseek-flash',
        output: [
          { id: 'rs_1', type: 'reasoning', encrypted_content: 'opaque-provider-state', summary: [] },
          { id: 'fc_1', call_id: 'call_1', type: 'function_call', name: 'search', arguments: '{"queries":["session state"],"paths":["src"]}' },
        ],
        reasoning: { effort: 'high' },
        usage: {
          input_tokens: 20,
          input_tokens_details: { cached_tokens: 6 },
          output_tokens: 12,
          output_tokens_details: { reasoning_tokens: 8 },
          total_tokens: 32,
        },
      });
  const transport = createEvidenceTransport({
    provider: 'deepseek',
    transport: 'responses',
    baseUrl: 'https://api.deepseek.com/v1/',
    model: 'deepseek-flash',
    thinking: 'medium',
    temperature: 0.2,
  }, { fetchImpl });

  const first = await transport({
    system: 'Select evidence; never rewrite source.',
    input: 'Find the session state definition.',
    tools: [{ type: 'function', function: { name: 'search', description: 'Search source.', parameters: { type: 'object', properties: { queries: { type: 'array' } } } } }],
  });
  assert.equal(first.ok, true);
  assert.equal(first.model, 'deepseek-flash');
  assert.equal(first.requestedModel, 'deepseek-flash');
  assert.equal(first.calls[0].id, 'call_1');
  assert.deepEqual(first.calls[0].args, { queries: ['session state'], paths: ['src'] });
  assert.deepEqual(first.usage, { input: 20, cached: 6, output: 12, reasoning: 8, total: 32 });
  assert.equal(first.thinking.requested, 'medium');
  assert.equal(first.thinking.mapped, 'high');
  assert.equal(first.thinking.effective, 'high');
  assert.equal(first.thinking.observed, 'high');
  assert.equal(first.thinking.status, 'effective-confirmed');
  assert.equal(requests[0].url, 'https://api.deepseek.com/v1/responses');
  assert.equal(requests[0].body.instructions, 'Select evidence; never rewrite source.');
  assert.deepEqual(requests[0].body.tools[0], {
    type: 'function',
    name: 'search',
    description: 'Search source.',
    parameters: { type: 'object', properties: { queries: { type: 'array' } } },
  });
  assert.deepEqual(requests[0].body.reasoning, { effort: 'high' });
  assert.equal(requests[0].body.reasoning_effort, undefined);
  assert.equal(requests[0].body.temperature, undefined, 'DeepSeek thinking mode must not send an ignored temperature');
  assert.ok(first.state.items.some((item) => item.id === 'rs_1' && item.encrypted_content === 'opaque-provider-state'));

  const second = await transport({
    system: 'Select evidence; never rewrite source.',
    input: 'This original request must not be appended a second time.',
    state: first.state,
    toolResults: [{ toolCallId: 'call_1', name: 'search', result: { matches: [{ path: 'src/auth.mjs', line: 18 }] } }],
  });
  assert.equal(second.ok, true);
  assert.equal(second.summary, 'One focused source slice is sufficient.');
  assert.deepEqual(second.selection, [{ id: 'read-1', path: 'src/auth.mjs', contentHash: 'sha256:a', ranges: [[12, 30]] }]);
  assert.deepEqual(second.missing, []);
  const secondInput = requests[1].body.input;
  assert.equal(secondInput.filter((item) => item.role === 'user').length, 1, 'follow-up tool turns reuse prior request input without duplicating it');
  assert.ok(secondInput.some((item) => item.type === 'reasoning' && item.id === 'rs_1'));
  assert.ok(secondInput.some((item) => item.type === 'function_call_output' && item.call_id === 'call_1'));
  assert.equal(requests.length, 2, 'one provider request per explicit transport call; no retries');
});

test('Chat Completions uses its endpoint and preserves reasoning_content with tool call IDs', async () => {
  const { fetchImpl, requests } = makeFetch({
    model: 'compatible-small-v3',
    choices: [{ message: {
      role: 'assistant',
      reasoning_content: 'provider continuation state',
      tool_calls: [{ id: 'chat-call-7', type: 'function', function: { name: 'read', arguments: '{"requests":[{"path":"src/auth.mjs","ranges":[[12,30]]}]}' } }],
    } }],
    usage: {
      prompt_tokens: 11,
      prompt_tokens_details: { cached_tokens: 4 },
      completion_tokens: 8,
      completion_tokens_details: { reasoning_tokens: 3 },
    },
  });
  const transport = createEvidenceTransport({
    provider: 'compatible-provider',
    transport: 'chat-completions',
    url: 'https://api.example.test/v1/chat/completions',
    model: 'compatible-small-v3',
    thinking: 'low',
    apiKey: 'never-return-this-key',
  }, { fetchImpl });
  const result = await transport({
    system: 'Use exact source references.',
    input: 'Read the selected path.',
    tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }],
  });

  assert.equal(requests[0].url, 'https://api.example.test/v1/chat/completions', 'an already-complete chat endpoint is not rewritten or duplicated');
  assert.equal(requests[0].init.headers.authorization, 'Bearer never-return-this-key');
  assert.equal(requests[0].body.reasoning_effort, 'low');
  assert.equal(result.calls[0].id, 'chat-call-7');
  assert.equal(result.calls[0].name, 'read');
  assert.deepEqual(result.calls[0].args, { requests: [{ path: 'src/auth.mjs', ranges: [[12, 30]] }] });
  assert.deepEqual(result.usage, { input: 11, cached: 4, output: 8, reasoning: 3, total: null });
  assert.equal(result.thinking.status, 'direct-unverified', 'compatible endpoints do not claim an unobserved effort mapping');
  assert.equal(result.thinking.effective, null);
  assert.equal(result.thinking.observed, null);
  assert.equal(result.state.messages.find((message) => message.role === 'assistant')?.reasoning_content, 'provider continuation state');

  const followup = await transport({
    input: 'Do not duplicate the current task during tool continuation.',
    state: result.state,
    toolResults: [{ toolCallId: 'chat-call-7', name: 'read', result: { text: 'read result' } }],
  });
  const messages = requests[1].body.messages;
  assert.equal(messages.filter((message) => message.role === 'user').length, 1, 'the original request remains once in provider state');
  assert.ok(!messages.some((message) => message.content === 'Do not duplicate the current task during tool continuation.'));
  assert.ok(messages.some((message) => message.role === 'assistant' && message.reasoning_content === 'provider continuation state'));
  assert.ok(messages.some((message) => message.role === 'tool' && message.tool_call_id === 'chat-call-7'));
  assert.equal(followup.ok, true);
});

test('OpenCode Go gets one stable session per transport task, with explicit headers taking precedence', async () => {
  const { fetchImpl, requests } = makeFetch({ model: 'deepseek-v4.1-flash', choices: [{ message: { role: 'assistant', content: 'ok' } }] });
  const config = { transport: 'chat', url: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4.1-flash' };
  const taskA = createEvidenceTransport(config, { fetchImpl });
  const first = await taskA({ input: 'first turn' });
  const followup = await taskA({ input: 'continue this turn', state: first.state });
  assert.equal(first.ok, true);
  assert.equal(followup.ok, true);
  const sessionA = requests[0].init.headers['x-opencode-session'];
  assert.match(sessionA, /^[0-9a-f-]{36}$/i);
  assert.equal(requests[1].init.headers['x-opencode-session'], sessionA, 'tool-loop continuations retain the task session');

  const taskB = createEvidenceTransport(config, { fetchImpl });
  await taskB({ input: 'parallel task' });
  const sessionB = requests[2].init.headers['x-opencode-session'];
  assert.match(sessionB, /^[0-9a-f-]{36}$/i);
  assert.notEqual(sessionB, sessionA, 'separate API tasks get separate sessions');

  const configuredHeader = createEvidenceTransport({ ...config, headers: { 'X-OpenCode-Session': 'configured-session' } }, { fetchImpl });
  await configuredHeader({ input: 'explicit configured session' });
  assert.equal(requests[3].init.headers['X-OpenCode-Session'], 'configured-session');
  const perRequestHeader = createEvidenceTransport(config, { fetchImpl });
  await perRequestHeader({ input: 'explicit request session', headers: { 'x-opencode-session': 'request-session' } });
  assert.equal(requests[4].init.headers['x-opencode-session'], 'request-session');

  const nonGo = makeFetch({ model: 'small', choices: [{ message: { role: 'assistant', content: 'ok' } }] });
  const nonGoTransport = createEvidenceTransport({ transport: 'chat', url: 'https://opencode.ai/zen/v1', model: 'small' }, { fetchImpl: nonGo.fetchImpl });
  await nonGoTransport({ input: 'other OpenCode route' });
  assert.equal(Object.keys(nonGo.requests[0].init.headers).some((name) => name.toLowerCase() === 'x-opencode-session'), false, 'the provider-specific header is scoped to the Go route');
  const genericGoPath = makeFetch({ model: 'small', choices: [{ message: { role: 'assistant', content: 'ok' } }] });
  const genericTransport = createEvidenceTransport({ transport: 'chat', url: 'https://api.example.test/zen/go/v1', model: 'small' }, { fetchImpl: genericGoPath.fetchImpl });
  await genericTransport({ input: 'same path on another host' });
  assert.equal(Object.keys(genericGoPath.requests[0].init.headers).some((name) => name.toLowerCase() === 'x-opencode-session'), false, 'the Go path on another host gets no OpenCode header');
});

test('DeepSeek effort mapping is explicit on both protocols, and off does not send reasoning_effort', async () => {
  const cases = [
    ['minimal', 'low'], ['low', 'low'], ['medium', 'high'], ['high', 'high'],
    ['xhigh', 'high'], ['max', 'max'], ['ultra', 'max'],
  ];
  for (const [requested, mapped] of cases) {
    const { fetchImpl, requests } = makeFetch({ model: 'deepseek-flash', output: [] });
    const transport = createEvidenceTransport({ provider: 'deepseek', transport: 'chat', url: 'https://api.deepseek.com', model: 'deepseek-flash' }, { fetchImpl });
    const result = await transport({ input: 'test', thinking: requested });
    assert.equal(result.thinking.requested, requested);
    assert.equal(result.thinking.mapped, mapped);
    assert.equal(result.thinking.effective, null, 'a request mapping does not prove the provider effective level');
    assert.equal(result.thinking.observed, null);
    assert.equal(result.thinking.status, 'provider-mapped-unconfirmed');
    assert.equal(requests[0].body.reasoning_effort, mapped);
    assert.deepEqual(requests[0].body.thinking, { type: 'enabled' });
  }

  const chat = makeFetch({ model: 'deepseek-flash', choices: [{ message: { role: 'assistant', content: 'ok' } }] });
  const chatTransport = createEvidenceTransport({ provider: 'deepseek', transport: 'chat', url: 'https://api.deepseek.com', model: 'deepseek-flash', temperature: 0.4 }, { fetchImpl: chat.fetchImpl });
  const chatOff = await chatTransport({ input: 'test', thinking: 'off' });
  assert.deepEqual(chat.requests[0].body.thinking, { type: 'disabled' });
  assert.equal(chat.requests[0].body.reasoning_effort, undefined);
  assert.equal(chat.requests[0].body.temperature, 0.4, 'non-thinking mode can use temperature');
  assert.equal(chatOff.thinking.effective, null);
  assert.equal(chatOff.thinking.observed, null);
  assert.equal(chatOff.thinking.status, 'provider-mapped-unconfirmed');

  const responses = makeFetch({ model: 'deepseek-flash', output: [] });
  const responseTransport = createEvidenceTransport({ provider: 'deepseek', transport: 'responses', url: 'https://api.deepseek.com', model: 'deepseek-flash' }, { fetchImpl: responses.fetchImpl });
  await responseTransport({ input: 'test', thinking: 'off' });
  assert.deepEqual(responses.requests[0].body.reasoning, { effort: 'none' });
  assert.equal(responses.requests[0].body.reasoning_effort, undefined);
});

test('mapped thinking is separate from provider echo for generic and DeepSeek responses', async () => {
  const generic = makeFetch({ model: 'compatible-small', choices: [{ message: { role: 'assistant', content: 'ok' } }] });
  const genericTransport = createEvidenceTransport({
    provider: 'compatible-provider', transport: 'chat', url: 'https://api.example.test/v1', model: 'compatible-small',
    thinkingMap: { chat: { medium: 'high' } },
  }, { fetchImpl: generic.fetchImpl });
  const genericResult = await genericTransport({ input: 'test', thinking: 'medium' });
  assert.equal(genericResult.thinking.mapped, 'high');
  assert.equal(genericResult.thinking.effective, null);
  assert.equal(genericResult.thinking.observed, null);
  assert.equal(genericResult.thinking.status, 'configured-unverified');

  const echoed = makeFetch({ model: 'deepseek-flash', reasoning_effort: 'low', choices: [{ message: { role: 'assistant', content: 'ok' } }] });
  const deepSeekTransport = createEvidenceTransport({ provider: 'deepseek', transport: 'chat', url: 'https://api.deepseek.com', model: 'deepseek-flash' }, { fetchImpl: echoed.fetchImpl });
  const echoedResult = await deepSeekTransport({ input: 'test', thinking: 'minimal' });
  assert.equal(echoedResult.thinking.mapped, 'low');
  assert.equal(echoedResult.thinking.effective, 'low');
  assert.equal(echoedResult.thinking.observed, 'low');
  assert.equal(echoedResult.thinking.status, 'effective-confirmed');
});

test('unmapped off is explicit unknown and does not silently send a request', async () => {
  let calls = 0;
  const transport = createEvidenceTransport({ transport: 'chat', url: 'https://api.example.test', model: 'unknown-model' }, {
    fetchImpl: async () => { calls += 1; return response({}); },
  });
  const result = await transport({ input: 'test', thinking: 'off' });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'THINKING_MAPPING_UNKNOWN');
  assert.equal(result.invocation.providerLaunches, 0);
  assert.equal(result.thinking.status, 'unknown-off-mapping');
  assert.equal(result.usage.total, null);
  assert.equal(calls, 0);
});

test('usage keeps unknown and zero distinct and never adds reasoning twice', () => {
  assert.deepEqual(normalizeApiUsage(undefined), { input: null, cached: null, output: null, reasoning: null, total: null });
  assert.deepEqual(normalizeApiUsage({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }), { input: 0, cached: null, output: 0, reasoning: null, total: 0 });
  assert.deepEqual(normalizeApiUsage({ prompt_tokens: 5, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 4 } }), { input: 5, cached: null, output: 7, reasoning: 4, total: null });
  assert.deepEqual(normalizeApiUsage({ prompt_tokens: 20, completion_tokens: 3, total_tokens: 23, prompt_cache_hit_tokens: 5, prompt_cache_miss_tokens: 15 }), { input: 20, cached: 5, output: 3, reasoning: null, total: 23 });
  assert.deepEqual(normalizeApiUsage({ prompt_tokens: 20, completion_tokens: 3, total_tokens: 23, prompt_cache_hit_tokens: 5, prompt_cache_miss_tokens: 14 }), { input: 20, cached: null, output: 3, reasoning: null, total: 23 }, 'inconsistent DeepSeek hit/miss fields leave cache usage unknown');
  assert.deepEqual(normalizeApiUsage({ prompt_tokens: 20, completion_tokens: 3, prompt_cache_miss_tokens: 15 }), { input: 20, cached: null, output: 3, reasoning: null, total: null }, 'missing hit and total fields remain unknown');
  assert.deepEqual(normalizeApiUsage({ prompt_tokens: '', completion_tokens: -1, total_tokens: 'NaN' }), { input: null, cached: null, output: null, reasoning: null, total: null });
  assert.deepEqual(normalizeApiUsage({ input_tokens: true, output_tokens: null, total_tokens: null }), { input: null, cached: null, output: null, reasoning: null, total: null });
  assert.deepEqual(normalizeApiUsage({ input_tokens: '  ', output_tokens: '12', total_tokens: '12' }), { input: null, cached: null, output: 12, reasoning: null, total: 12 });
});

test('provider launch accounting distinguishes local request errors, launched failures, and bounded timeout', async () => {
  const invalid = createEvidenceTransport({ transport: 'chat', url: 'https://api.example.test', model: 'small' }, {
    fetchImpl: async () => { throw new Error('must not launch'); },
  });
  const invalidResult = await invalid({ input: 'test', thinking: 'not-a-real-level' });
  assert.equal(invalidResult.ok, false);
  assert.equal(invalidResult.errorCode, 'INVALID_REQUEST');
  assert.equal(invalidResult.invocation.providerLaunches, 0);

  const networkFailure = createEvidenceTransport({ transport: 'chat', url: 'https://api.example.test', model: 'small' }, {
    fetchImpl: async () => { throw new Error('connection refused'); },
  });
  const networkResult = await networkFailure({ input: 'test' });
  assert.equal(networkResult.errorCode, 'NETWORK_ERROR');
  assert.equal(networkResult.invocation.providerLaunches, 1);

  let receivedSignal;
  const hanging = createEvidenceTransport({ transport: 'chat', url: 'https://api.example.test', model: 'small', timeoutMs: 10 }, {
    fetchImpl: async (_url, init) => {
      receivedSignal = init.signal;
      return new Promise(() => {});
    },
  });
  const timeoutResult = await hanging({ input: 'bounded request' });
  assert.equal(timeoutResult.errorCode, 'REQUEST_TIMEOUT');
  assert.equal(timeoutResult.invocation.providerLaunches, 1);
  assert.equal(receivedSignal.aborted, true);
});

test('HTTP failure returns observed usage, sanitizes credentials, and does not retry', async () => {
  const { fetchImpl, requests } = makeFetch({
    error: { code: 'rate_limited', message: 'key never-return-this-key rejected' },
    usage: { prompt_tokens: 2, prompt_tokens_details: { cached_tokens: 1 }, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 1 }, total_tokens: 5 },
  }, { status: 429, ok: false });
  const transport = createEvidenceTransport({ transport: 'chat', url: 'https://api.example.test/v1', model: 'small', key: 'never-return-this-key' }, { fetchImpl });
  const result = await transport({ input: 'one attempt' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 429);
  assert.equal(result.invocation.providerLaunches, 1);
  assert.equal(result.errorCode, 'rate_limited');
  assert.doesNotMatch(result.error, /never-return-this-key/);
  assert.deepEqual(result.usage, { input: 2, cached: 1, output: 3, reasoning: 1, total: 5 });
  assert.equal(requests.length, 1);
});
