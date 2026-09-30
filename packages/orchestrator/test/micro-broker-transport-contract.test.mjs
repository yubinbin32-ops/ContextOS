import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createEvidenceTransport } from '../src/api-transports.mjs';
import { requestEvidence } from '../src/micro-broker.mjs';
import { requestContextOS } from '../src/request-service.mjs';

function temporaryProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-broker-transport-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'login.mjs'), 'export function login() { return "session"; }\n');
  return root;
}

function jsonResponse(data, status = 200) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(data) };
}

function chatCall(id, name, args) {
  return { role: 'assistant', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}

function chatCallRaw(id, name, argumentsText) {
  return { role: 'assistant', tool_calls: [{ id, type: 'function', function: { name, arguments: argumentsText } }] };
}

function responsesCall(id, name, args) {
  return { id: `fc-${id}`, call_id: id, type: 'function_call', name, arguments: JSON.stringify(args) };
}

function responsesCallRaw(id, name, argumentsText) {
  return { id: `fc-${id}`, call_id: id, type: 'function_call', name, arguments: argumentsText };
}

function readOutputs(body, protocol) {
  const raw = protocol === 'chat'
    ? body.messages.filter((message) => message.role === 'tool').map((message) => message.content)
    : body.input.filter((item) => item.type === 'function_call_output').map((item) => item.output);
  return raw.map((value) => JSON.parse(value));
}

function wireToolNames(body, protocol) {
  return protocol === 'chat' ? body.tools.map((tool) => tool.function.name) : body.tools.map((tool) => tool.name);
}

function turnControls(body, protocol) {
  const messages = protocol === 'chat' ? body.messages : body.input;
  return messages.filter((item) => item.role === 'user' && typeof item.content === 'string'
    && item.content.startsWith('Broker turn control:')).map((item) => item.content);
}

function occurrenceCount(value, text) {
  return value.split(text).length - 1;
}

function assertPriorCallsAnswered(body, protocol) {
  if (protocol === 'chat') {
    const calls = body.messages.flatMap((message) => message.role === 'assistant' ? (message.tool_calls || []).map((call) => call.id) : []);
    const results = body.messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id);
    return JSON.stringify(results.slice().sort()) === JSON.stringify(calls.slice().sort());
  }
  const calls = body.input.filter((item) => item.type === 'function_call').map((item) => item.call_id);
  const results = body.input.filter((item) => item.type === 'function_call_output').map((item) => item.call_id);
  return JSON.stringify(results.slice().sort()) === JSON.stringify(calls.slice().sort());
}

function brokerFetch(protocol, requests) {
  const prefix = protocol === 'chat' ? 'chat' : 'responses';
  return async (url, init) => {
    assert.match(String(url), protocol === 'chat' ? /chat\/completions$/ : /\/responses$/);
    const body = JSON.parse(init.body);
    requests.push({ url: String(url), body });
    const turn = requests.length;
    if (turn > 1 && !assertPriorCallsAnswered(body, protocol)) {
      return jsonResponse({ error: { code: 'invalid_request_error', message: 'assistant tool_calls missing corresponding tool messages' } }, 400);
    }

    let name;
    let args;
    if (turn === 1) {
      name = 'search';
      args = { queries: ['login'], paths: ['src/login.mjs'], limit: 4 };
    } else if (turn === 2) {
      const output = protocol === 'chat'
        ? body.messages.find((message) => message.role === 'tool' && message.tool_call_id === `${prefix}-search` )?.content
        : body.input.find((item) => item.type === 'function_call_output' && item.call_id === `${prefix}-search`)?.output;
      const search = JSON.parse(output || 'null');
      const record = search?.records?.[0];
      assert.ok(record, 'bounded exact source is included with the search output');
      name = 'select';
      args = { references: [{ id: record.id, path: record.path, contentHash: record.contentHash, ranges: record.ranges }], summary: 'The login function returns the session value.', missing: [] };
    } else {
      throw new Error('Broker should stop after the select call.');
    }

    const id = `${prefix}-${turn === 1 ? 'search' : 'select'}`;
    return jsonResponse(protocol === 'chat'
      ? { model: 'stub-model', choices: [{ message: chatCall(id, name, args) }] }
      : { model: 'stub-model', output: [responsesCall(id, name, args)] });
  };
}

for (const protocol of ['chat', 'responses']) {
  test(`micro-broker continuations preserve canonical tool results for ${protocol}`, async (t) => {
    const root = temporaryProject();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const requests = [];
    const transport = createEvidenceTransport({
      provider: 'fixture', transport: protocol, url: 'https://api.example.test/v1', model: 'stub-model',
    }, { fetchImpl: brokerFetch(protocol, requests) });

    const result = await requestEvidence({ request: 'Find and cite the login function.' }, {
      projectRoot: root,
      transport,
      config: { budget: { maxTransportInvocations: 2 } },
    });

    assert.equal(requests.length, 2);
    assert.equal(result.status, 'complete');
    assert.equal(result.summary, 'The login function returns the session value.');
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].text, 'export function login() { return "session"; }\n');
    assert.equal(result.accounting.transportInvocations, 2);
  });
}

for (const protocol of ['chat', 'responses']) {
  test(`localhost ${protocol} wire carries current turn controls and exactly the offered tools`, async (t) => {
    const root = temporaryProject();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = [
      'export const marker = 1;',
      'export function selected() {',
      '  return marker;',
      '}',
      'export const ending = 5;',
      'export const filler = 6;',
      'export const fillerAgain = 7;',
      'export const target = "exact-target";',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(root, 'src', 'login.mjs'), source);

    const bodies = [];
    const server = http.createServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        bodies.push(body);
        const turn = bodies.length;
        const outputs = readOutputs(body, protocol);
        let name;
        let args;
        if (turn === 1) {
          name = 'search';
          args = { mode: 'content', queries: ['export const marker'], paths: ['src/login.mjs'], limit: 1 };
        } else if (turn === 2) {
          assert.ok(outputs.some((item) => item.records?.some((record) => record.text?.includes('export const marker'))));
          name = 'search';
          args = { mode: 'paths', queries: ['login'], paths: ['src'], limit: 12 };
        } else if (turn === 3) {
          const pathResult = outputs.find((item) => item.mode === 'paths');
          assert.ok(pathResult?.paths?.includes('src/login.mjs'), 'path discovery is present in the continuation context');
          name = 'read';
          args = { requests: [{ path: pathResult.paths[0], ranges: [[8, 8]] }] };
        } else if (turn === 4) {
          const records = outputs.flatMap((item) => item.records || []);
          const marker = records.find((record) => record.text?.includes('export const marker'));
          const target = records.find((record) => record.text?.includes('exact-target'));
          assert.ok(marker && target, 'verified source records from earlier tool results remain available for final selection');
          assert.match(marker.ref, /^e[a-f0-9]{16}_[0-9a-z]+$/);
          assert.match(target.ref, /^e[a-f0-9]{16}_[0-9a-z]+$/);
          name = 'select';
          args = { refs: [marker.ref, target.ref], summary: 'Both exact declarations were found.', missing: [] };
        } else {
          throw new Error('The four-turn fixture must finish with select.');
        }
        const id = `${protocol}-wire-${turn}`;
        const payload = protocol === 'chat'
          ? { model: 'stub-model', choices: [{ message: chatCall(id, name, args) }], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } }
          : { model: 'stub-model', output: [responsesCall(id, name, args)], usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 } };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'fixture_error', message: error.message } }));
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const address = server.address();
    const requestText = 'Find the marker and target declarations. one-time-request-marker';
    const result = await requestContextOS('ask', { request: requestText, purpose: 'Verify exact source citations.' }, {
      projectRoot: root,
      profile: { micro: {
        provider: 'fixture', transport: protocol, url: `http://127.0.0.1:${address.port}/v1`, model: 'stub-model', audit: true,
        budget: { maxTransportInvocations: 4, maxSearchResults: 1 },
      } },
    });

    assert.equal(bodies.length, 4);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.records.map((record) => record.text), [
      'export const marker = 1;\nexport function selected() {\n  return marker;\n}\nexport const ending = 5;\n',
      'export const target = "exact-target";\n',
    ]);
    const controls = bodies.map((body) => turnControls(body, protocol));
    assert.deepEqual(controls.map((items) => items.length), [1, 1, 1, 1], 'the current control is appended once and old controls are not persisted');
    assert.match(controls[0][0], /remainingInvocations=3/);
    assert.match(controls[0][0], /maxContentResultsPerSearch=1/);
    assert.match(controls[0][0], /remainingSearchBytes=[1-9]\d*/);
    assert.match(controls[1][0], /remainingInvocations=2/);
    assert.match(controls[1][0], /offeredSearchModes=content,paths/);
    assert.match(controls[1][0], /maxContentResultsPerSearch=1/);
    assert.match(controls[1][0], /totalSearchResults=1/);
    assert.match(controls[1][0], /remainingSearchBytes=[1-9]\d*/);
    assert.match(controls[2][0], /remainingInvocations=1/);
    assert.match(controls[2][0], /offeredSearchModes=content,paths/);
    assert.match(controls[2][0], /maxContentResultsPerSearch=1/);
    assert.match(controls[2][0], /totalSearchResults=1/);
    assert.match(controls[2][0], /remainingSearchBytes=[1-9]\d*/);
    const bytesRemainingAfterContent = Number(controls[1][0].match(/remainingSearchBytes=(\d+)/)?.[1]);
    const bytesRemainingAfterPathSearch = Number(controls[2][0].match(/remainingSearchBytes=(\d+)/)?.[1]);
    assert.ok(bytesRemainingAfterPathSearch < bytesRemainingAfterContent, 'the control reports shared byte usage after path discovery');
    assert.match(controls[3][0], /remainingInvocations=0/);
    assert.match(controls[3][0], /offeredTools=select/);
    assert.match(controls[3][0], /final=true/);
    assert.deepEqual(bodies.map((body) => wireToolNames(body, protocol)), [
      ['search', 'read', 'select'], ['search', 'read', 'select'], ['search', 'read', 'select'], ['select'],
    ]);
    const systems = protocol === 'chat'
      ? bodies.map((body) => body.messages.find((message) => message.role === 'system')?.content)
      : bodies.map((body) => body.instructions);
    assert.equal(new Set(systems).size, 1, 'the system prefix stays byte-for-byte stable');
    for (const body of bodies) {
      const serialized = JSON.stringify(body);
      assert.equal(occurrenceCount(serialized, 'one-time-request-marker'), 1, 'the request is carried once, not reserialized in continuation input');
    }
    const searchModes = bodies.map((body) => {
      const tool = body.tools.find((candidate) => (protocol === 'chat' ? candidate.function.name : candidate.name) === 'search');
      return protocol === 'chat' ? tool?.function?.parameters?.properties?.mode : tool?.parameters?.properties?.mode;
    });
    assert.deepEqual(searchModes, [
      { type: 'string', enum: ['content', 'paths'], description: 'Defaults to content. Use paths for file-name discovery.' },
      { type: 'string', enum: ['content', 'paths'], description: 'Defaults to content. Use paths for file-name discovery.' },
      { type: 'string', enum: ['content', 'paths'], description: 'Defaults to content. Use paths for file-name discovery.' },
      undefined,
    ]);
    const selectTool = bodies[0].tools.find((candidate) =>
      (protocol === 'chat' ? candidate.function.name : candidate.name) === 'select');
    const selectParameters = protocol === 'chat' ? selectTool.function.parameters : selectTool.parameters;
    assert.deepEqual(selectParameters.required, ['refs']);
    assert.ok(selectParameters.properties.refs && selectParameters.properties.references,
      'wire schema prefers compact refs while retaining the legacy references parser');

    const auditDirectory = path.join(root, '.contextos', 'micro-audit');
    const auditFiles = fs.readdirSync(auditDirectory).filter((file) => file.endsWith('.ndjson'));
    assert.equal(auditFiles.length, 1);
    const auditText = fs.readFileSync(path.join(auditDirectory, auditFiles[0]), 'utf8');
    const audit = auditText.trim().split('\n').map((line) => JSON.parse(line));
    const transportEvents = audit.filter((event) => event.kind === 'transport');
    assert.deepEqual(transportEvents.map((event) => event.offeredToolNames), bodies.map((body) => wireToolNames(body, protocol)));
    assert.equal(occurrenceCount(auditText, 'one-time-request-marker'), 0);
    assert.equal(occurrenceCount(auditText, 'export const marker'), 0, 'audit stores metadata, never request or source text');
  });
}

for (const protocol of ['chat', 'responses']) {
  test(`localhost ${protocol} private audit distinguishes invalid arguments from literal null and records completion metadata`, async (t) => {
    const root = temporaryProject();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const malformedArguments = '{"references":"猫",';
    const literalNullArguments = 'null';
    const apiKey = 'fixture-secret-not-real';
    const requests = [];
    const server = http.createServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requests.push({ body, authorization: request.headers.authorization });
        const turn = requests.length;
        const rawArguments = turn === 1 ? malformedArguments : literalNullArguments;
        const id = `${protocol}-diagnostic-${turn}`;
        const payload = protocol === 'chat'
          ? {
            model: 'stub-model',
            choices: [{ finish_reason: turn === 1 ? 'length' : 'stop', message: chatCallRaw(id, 'select', rawArguments) }],
            usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
          }
          : {
            model: 'stub-model', status: turn === 1 ? 'incomplete' : 'completed',
            ...(turn === 1 ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
            output: [responsesCallRaw(id, 'select', rawArguments)],
            usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
          };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'fixture_error', message: error.message } }));
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const address = server.address();
    const requestText = 'Select evidence from the current workspace.';
    const profile = { micro: {
      provider: 'fixture', transport: protocol, url: `http://127.0.0.1:${address.port}/v1`, model: 'stub-model',
      apiKey, audit: true, budget: { maxTransportInvocations: 1 },
    } };
    const first = await requestContextOS('ask', { request: requestText, purpose: 'Test parser diagnostics.' }, { projectRoot: root, profile });
    const second = await requestContextOS('ask', { request: requestText, purpose: 'Test parser diagnostics.' }, { projectRoot: root, profile });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].authorization, `Bearer ${apiKey}`);
    assert.deepEqual(requests[0].body, requests[1].body, 'adding diagnostics does not alter the serialized provider request');
    const requestJson = JSON.stringify(requests[0].body);
    assert.equal(requestJson.includes(apiKey), false);
    assert.equal(requestJson.includes('argumentsParseStatus'), false);
    assert.equal(requestJson.includes('argumentsSha256'), false);
    assert.equal(first.status, 'partial');
    assert.equal(second.status, 'partial');

    const auditDirectory = path.join(root, '.contextos', 'micro-audit');
    const auditFiles = fs.readdirSync(auditDirectory).filter((file) => file.endsWith('.ndjson'));
    assert.equal(auditFiles.length, 2);
    const auditText = auditFiles.map((file) => fs.readFileSync(path.join(auditDirectory, file), 'utf8')).join('');
    const runs = auditFiles.map((file) => fs.readFileSync(path.join(auditDirectory, file), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line)));
    const orderedRuns = runs.slice().sort((a, b) => {
      const left = a.find((event) => event.kind === 'tool' && event.name === 'select');
      const right = b.find((event) => event.kind === 'tool' && event.name === 'select');
      return right.argumentsBytes - left.argumentsBytes;
    });
    const selections = orderedRuns.map((events) => events.find((event) => event.kind === 'tool' && event.name === 'select'));
    assert.deepEqual(selections.map((event) => event.argumentsParseStatus), ['invalid_json', 'json_non_object']);
    assert.deepEqual(selections.map((event) => event.argsShape), ['invalid_json', 'object']);
    assert.deepEqual(selections.map((event) => event.failureCategory), ['arguments_not_object', 'refs_not_array']);
    assert.deepEqual(selections.map((event) => event.argumentsBytes), [
      Buffer.byteLength(malformedArguments, 'utf8'), Buffer.byteLength(literalNullArguments, 'utf8'),
    ]);
    assert.notEqual(selections[0].argumentsBytes, malformedArguments.length, 'argument accounting uses UTF-8 bytes, not characters');
    assert.deepEqual(selections.map((event) => event.argumentsSha256), [malformedArguments, literalNullArguments]
      .map((value) => createHash('sha256').update(value, 'utf8').digest('hex')));
    const transports = orderedRuns.map((events) => events.find((event) => event.kind === 'transport'));
    assert.equal(transports.length, 2);
    assert.deepEqual(transports.map((event) => event.completion), protocol === 'chat'
      ? [
        { protocol: 'chat', finishReason: 'length' },
        { protocol: 'chat', finishReason: 'stop' },
      ]
      : [
        { protocol: 'responses', status: 'incomplete', incompleteReason: 'max_output_tokens' },
        { protocol: 'responses', status: 'completed', incompleteReason: null },
      ]);
    assert.equal(auditText.includes(apiKey), false);
    assert.equal(auditText.includes(malformedArguments), false);
    assert.equal(auditText.includes(requestText), false);
    assert.equal(auditText.includes('"messages"'), false);
    assert.equal(auditText.includes('"tools"'), false);
    assert.equal(JSON.stringify([first, second]).includes(apiKey), false);
    const publicArgumentPaths = [];
    const findPublicArgument = (value, currentPath = 'result') => {
      if (typeof value === 'string') {
        if (value.includes(malformedArguments)) publicArgumentPaths.push(currentPath);
      } else if (Array.isArray(value)) value.forEach((item, index) => findPublicArgument(item, `${currentPath}[${index}]`));
      else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) findPublicArgument(child, `${currentPath}.${key}`);
      }
    };
    findPublicArgument([first, second]);
    assert.deepEqual(publicArgumentPaths, [], 'provider tool arguments never enter public result fields');
  });
}

test('API Micro omits provider output-token caps unless explicitly configured', async () => {
  for (const protocol of ['chat', 'responses']) {
    const bodies = [];
    const transport = createEvidenceTransport({
      provider: 'fixture', transport: protocol, url: 'https://api.example.test/v1', model: 'stub-model',
    }, {
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return jsonResponse(protocol === 'chat'
          ? { model: 'stub-model', choices: [{ message: { role: 'assistant', content: 'ok' } }] }
          : { model: 'stub-model', output: [] });
      },
    });
    await transport({ input: 'bounded request' });
    assert.equal(bodies.length, 1);
    assert.equal(Object.hasOwn(bodies[0], protocol === 'chat' ? 'max_tokens' : 'max_output_tokens'), false);
  }
});

test('API Micro keeps an explicitly configured request timeout', async () => {
  const transport = createEvidenceTransport({
    provider: 'fixture', transport: 'chat', url: 'https://api.example.test/v1', model: 'stub-model', timeoutMs: 5,
  }, { fetchImpl: () => new Promise(() => {}) });
  const result = await transport({ input: 'bounded request' });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'REQUEST_TIMEOUT');
});

test('malformed or unmatched canonical tool results fail before provider launch for both protocols', async () => {
  for (const protocol of ['chat', 'responses']) {
    const state = protocol === 'chat'
      ? { transport: 'chat', messages: [{ role: 'assistant', tool_calls: [{ id: 'expected-1', type: 'function', function: { name: 'search', arguments: '{}' } }, { id: 'expected-2', type: 'function', function: { name: 'read', arguments: '{}' } }] }] }
      : { transport: 'responses', items: [{ type: 'function_call', id: 'fc-1', call_id: 'expected-1', name: 'search', arguments: '{}' }, { type: 'function_call', id: 'fc-2', call_id: 'expected-2', name: 'read', arguments: '{}' }] };
    for (const toolResults of [
      [{ name: 'search', result: {} }],
      [{ toolCallId: 'expected-1', name: 'search', result: {} }, { toolCallId: 'expected-1', name: 'search', result: {} }],
      [{ toolCallId: 'unknown', name: 'search', result: {} }, { toolCallId: 'expected-2', name: 'read', result: {} }],
      [{ toolCallId: 'expected-1', name: 'search', result: {} }],
    ]) {
      let launches = 0;
      const transport = createEvidenceTransport({ transport: protocol, url: 'https://api.example.test/v1', model: 'stub-model' }, {
        fetchImpl: async () => { launches += 1; return jsonResponse({}); },
      });
      const result = await transport({ input: 'continue', state, toolResults });
      assert.equal(result.ok, false, `${protocol} should reject malformed tool results locally`);
      assert.equal(result.errorCode, 'INVALID_REQUEST');
      assert.equal(result.invocation.providerLaunches, 0);
      assert.equal(launches, 0);
    }
  }
});
