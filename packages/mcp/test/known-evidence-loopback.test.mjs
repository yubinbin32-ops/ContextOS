import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverEntrypoint = process.env.CONTEXTOS_TEST_ENTRYPOINT
  || fileURLToPath(new URL('../src/v3-server.mjs', import.meta.url));

function parseKnownInput(body, expectedPath) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content !== 'string') continue;
    try {
      const parsed = JSON.parse(message.content);
      const reference = parsed?.known?.references?.find((item) => item.path === expectedPath);
      if (reference) return reference;
    } catch { /* inspect the next user message */ }
  }
  throw new Error('The provider request did not include a verified known reference.');
}

function parseRequestInput(body) {
  for (const message of body.messages || []) {
    if (message.role !== 'user' || typeof message.content !== 'string') continue;
    try {
      const parsed = JSON.parse(message.content);
      if (typeof parsed.request === 'string') return parsed;
    } catch { /* inspect the next user message */ }
  }
  throw new Error('The provider request did not include the broker request payload.');
}

test('stdio contextos reuses inspect proof through known refs and recovers its source chain locally', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-known-loopback-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, '.contextos'), { recursive: true });
  const relativePath = 'src/验证.mjs';
  const source = 'export function verify(输入) {\n  return "🙂";\n}\n';
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, relativePath), source);
  const expectedHash = createHash('sha256').update(source, 'utf8').digest('hex');
  let providerRequests = 0;
  let providerReference;
  const provider = http.createServer((request, response) => {
    providerRequests += 1;
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      try {
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/v1/chat/completions');
        const body = JSON.parse(raw);
        providerReference = parseKnownInput(body, relativePath);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          model: 'loopback-fixture',
          choices: [{ message: { role: 'assistant', tool_calls: [{
            id: 'loopback-select',
            type: 'function',
            function: { name: 'select', arguments: JSON.stringify({
              summary: 'The requested function is already covered by verified evidence.',
              references: [providerReference],
              missing: [],
            }) },
          }] } }],
          usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
        }));
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: error.message } }));
      }
    });
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const profile = {
    micro: {
      url: `http://127.0.0.1:${provider.address().port}/v1`,
      model: 'loopback-fixture',
      transport: 'chat',
      maxOutputTokens: 256,
    },
  };
  fs.writeFileSync(path.join(workspace, '.contextos', 'profile.json'), JSON.stringify(profile), { mode: 0o600 });

  const client = new Client({ name: 'known-evidence-loopback-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntrypoint],
    env: {
      PATH: process.env.PATH || '',
      HOME: root,
      TMPDIR: os.tmpdir(),
      CONTEXTOS_HOME: path.join(root, 'empty-home'),
      CONTEXTOS_DISABLE_API_MICRO: '0',
      CONTEXTOS_DISABLE_MICRO: '1',
    },
    stderr: 'pipe',
  });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ['contextos']);

    const inspected = await client.callTool({ name: 'contextos', arguments: {
      action: 'ask',
      projectRoot: workspace,
      args: { inspect: [{ path: relativePath, ranges: [[1, 3]] }] },
    } });
    assert.equal(inspected.structuredContent.status, 'completed');
    assert.deepEqual(inspected.structuredContent.accounting, {
      materializedEvidenceBytes: Buffer.byteLength(source, 'utf8'),
      materializedEvidenceChars: Array.from(source).length,
      renderedSourceBytes: Buffer.byteLength(source, 'utf8'),
      renderedSourceChars: Array.from(source).length,
    });
    const inspectedText = inspected.content.map((item) => item.text || '').join('\n');
    assert.ok(inspectedText.includes(source), 'direct inspect returns the exact Unicode source');
    assert.ok(inspectedText.includes(`hash=${expectedHash}`));
    const firstResultId = inspected.structuredContent.resultId;
    assert.ok(firstResultId);

    const reused = await client.callTool({ name: 'contextos', arguments: {
      action: 'ask',
      projectRoot: workspace,
      args: {
        request: 'Return the already inspected verify function.',
        known: { refs: [{ resultId: firstResultId }] },
      },
    } });
    assert.equal(reused.structuredContent.status, 'completed');
    assert.ok(reused.structuredContent.resultId);
    assert.notEqual(reused.structuredContent.resultId, firstResultId);
    assert.equal(providerRequests, 1);
    assert.equal(providerReference.path, relativePath);
    assert.equal(providerReference.contentHash, expectedHash);
    assert.deepEqual(providerReference.ranges, [{ start: 1, end: 3 }]);
    assert.ok(reused.content[0].text.includes(`reused result=${firstResultId}`));
    assert.ok(reused.content[0].text.includes(`hash=${expectedHash}`));
    assert.ok(!reused.content[0].text.includes(source), 'semantic response does not repeat already delivered source');
    assert.ok(!JSON.stringify(reused.structuredContent).includes(source), 'structured content carries no source copy');
    assert.equal(reused.structuredContent.records, undefined);

    const recovered = await client.callTool({ name: 'contextos', arguments: {
      action: 'ask',
      projectRoot: workspace,
      args: { resultId: reused.structuredContent.resultId, inspect: [{ path: relativePath, ranges: [[1, 3]] }] },
    } });
    assert.equal(recovered.structuredContent.status, 'completed');
    assert.equal(providerRequests, 1, 'recovering the stored reuse chain makes no provider request');
    assert.equal((recovered.content[0].text.match(/export function verify/g) || []).length, 1);
    assert.ok(recovered.content[0].text.includes(source));
    assert.ok(recovered.content[0].text.includes(`hash=${expectedHash}`));
  } finally {
    await client.close();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stdio known refs exclude clipped source, merge later delivery, and preserve delivery through reuse chains', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-known-clipped-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, '.contextos'), { recursive: true });
  const shownPath = 'src/显示.mjs';
  const hiddenPath = 'src/隐藏.mjs';
  const shownSource = `export const shown = "${'A'.repeat(220)}";\n`;
  const hiddenSource = `export const hidden = "${'B'.repeat(220)}";\n`;
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, shownPath), shownSource);
  fs.writeFileSync(path.join(workspace, hiddenPath), hiddenSource);
  let selectionForNextRequest;
  const providerInputs = [];
  const provider = http.createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      try {
        const body = JSON.parse(raw);
        const input = parseRequestInput(body);
        providerInputs.push(input);
        assert.equal(typeof selectionForNextRequest, 'function');
        const references = selectionForNextRequest(input);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ model: 'loopback-fixture', choices: [{ message: { role: 'assistant', tool_calls: [{
          id: `loopback-select-${providerInputs.length}`,
          type: 'function',
          function: { name: 'select', arguments: JSON.stringify({ summary: 'Selected exact available evidence.', references, missing: [] }) },
        }] } }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }));
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: error.message } }));
      }
    });
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(workspace, '.contextos', 'profile.json'), JSON.stringify({
    micro: { url: `http://127.0.0.1:${provider.address().port}/v1`, model: 'loopback-fixture', transport: 'chat', maxOutputTokens: 256 },
  }), { mode: 0o600 });
  const client = new Client({ name: 'known-clipped-loopback-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntrypoint],
    env: { PATH: process.env.PATH || '', HOME: root, TMPDIR: os.tmpdir(), CONTEXTOS_HOME: path.join(root, 'empty-home'),
      CONTEXTOS_DISABLE_API_MICRO: '0', CONTEXTOS_DISABLE_MICRO: '1' },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const inspected = await client.callTool({ name: 'contextos', arguments: {
      // Both source blocks fit at 1000 after metadata budgeting improved.
      // Keep this case below their combined source/header size to test clipping.
      action: 'ask', projectRoot: workspace, maxChars: 700,
      args: { inspect: [{ path: shownPath, ranges: [[1, 1]] }, { path: hiddenPath, ranges: [[1, 1]] }] },
    } });
    const initialText = inspected.content[0].text;
    assert.equal(inspected.structuredContent.status, 'partial');
    assert.equal(inspected.structuredContent.sourceDelivery, 'recorded');
    assert.deepEqual(inspected.structuredContent.accounting, {
      materializedEvidenceBytes: Buffer.byteLength(shownSource + hiddenSource, 'utf8'),
      materializedEvidenceChars: Array.from(shownSource + hiddenSource).length,
      renderedSourceBytes: Buffer.byteLength(shownSource, 'utf8'),
      renderedSourceChars: Array.from(shownSource).length,
    });
    assert.ok(initialText.includes(shownSource));
    assert.ok(!initialText.includes(hiddenSource));
    const firstResultId = inspected.structuredContent.resultId;
    const artifactPath = path.join(workspace, '.contextos', 'request-results', `${firstResultId}.json`);
    const firstArtifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    assert.deepEqual(firstArtifact.sourceDelivery.map((item) => item.path), [shownPath]);
    const hiddenRecord = firstArtifact.records.find((record) => record.path === hiddenPath);
    const shownRecord = firstArtifact.records.find((record) => record.path === shownPath);
    assert.ok(hiddenRecord && shownRecord);

    selectionForNextRequest = (input) => [input.known.references.find((reference) => reference.path === shownPath)];
    const selectedVisible = await client.callTool({ name: 'contextos', arguments: {
      action: 'ask', projectRoot: workspace,
      args: { request: 'Reuse the source that was actually returned.', known: { refs: [{ resultId: firstResultId }] } },
    } });
    assert.equal(selectedVisible.structuredContent.status, 'completed');
    assert.equal(selectedVisible.structuredContent.accounting.renderedSourceBytes, 0, 'a reuse-only response renders no source bytes');
    assert.equal(selectedVisible.structuredContent.accounting.renderedSourceChars, 0);
    assert.equal(providerInputs.length, 1);
    assert.deepEqual(providerInputs[0].known.references.map((reference) => reference.path), [shownPath]);
    assert.ok(providerInputs[0].known.unavailable.some((item) => item.path === hiddenPath && /not delivered/.test(item.reason)));
    assert.ok(!selectedVisible.content[0].text.includes(shownSource));
    assert.match(selectedVisible.content[0].text, new RegExp(`reused result=${firstResultId}`));
    const secondResultId = selectedVisible.structuredContent.resultId;

    selectionForNextRequest = () => [hiddenRecord];
    const rejectedUnseen = await client.callTool({ name: 'contextos', arguments: {
      action: 'ask', projectRoot: workspace,
      args: { request: 'Select the omitted hidden source.', known: { refs: [{ resultId: firstResultId }] } },
    } });
    assert.equal(providerInputs.length, 2);
    assert.deepEqual(providerInputs[1].known.references.map((reference) => reference.path), [shownPath]);
    assert.equal(rejectedUnseen.structuredContent.status, 'partial');
    assert.ok(rejectedUnseen.content[0].text.includes(hiddenPath));
    assert.ok(rejectedUnseen.content[0].text.includes('not delivered to the caller'), rejectedUnseen.content[0].text);
    assert.ok(!rejectedUnseen.content[0].text.includes(`reused result=${firstResultId} ${hiddenPath}`));
    assert.ok(!rejectedUnseen.content[0].text.includes(hiddenSource));

    const recovered = await client.callTool({ name: 'contextos', arguments: {
      action: 'ask', projectRoot: workspace, maxChars: 1000,
      args: { resultId: firstResultId, inspect: [{ path: hiddenPath, ranges: [[1, 1]] }] },
    } });
    assert.equal(recovered.structuredContent.status, 'completed');
    assert.equal(recovered.structuredContent.sourceDelivery, 'recorded');
    assert.equal(recovered.structuredContent.accounting.materializedEvidenceBytes, Buffer.byteLength(hiddenSource, 'utf8'));
    assert.equal(recovered.structuredContent.accounting.renderedSourceBytes, Buffer.byteLength(hiddenSource, 'utf8'));
    assert.equal(recovered.structuredContent.accounting.renderedSourceChars, Array.from(hiddenSource).length);
    assert.ok(recovered.content[0].text.includes(hiddenSource));
    const updatedArtifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    assert.deepEqual(new Set(updatedArtifact.sourceDelivery.map((item) => item.path)), new Set([shownPath, hiddenPath]));

    selectionForNextRequest = (input) => input.known.references;
    const selectedBoth = await client.callTool({ name: 'contextos', arguments: {
      action: 'ask', projectRoot: workspace,
      args: { request: 'Reuse both source blocks now delivered.', known: { refs: [{ resultId: firstResultId }] } },
    } });
    assert.equal(selectedBoth.structuredContent.status, 'completed');
    assert.deepEqual(new Set(providerInputs[2].known.references.map((reference) => reference.path)), new Set([shownPath, hiddenPath]));
    assert.equal(selectedBoth.content[0].text.includes(hiddenSource), false, 'source already delivered is represented by reuse metadata only');
    const thirdResultId = selectedBoth.structuredContent.resultId;

    selectionForNextRequest = (input) => input.known.references;
    const inherited = await client.callTool({ name: 'contextos', arguments: {
      action: 'ask', projectRoot: workspace,
      args: { request: 'Reuse the latest result chain.', known: { refs: [{ resultId: thirdResultId }] } },
    } });
    assert.equal(inherited.structuredContent.status, 'completed');
    assert.deepEqual(new Set(providerInputs[3].known.references.map((reference) => reference.path)), new Set([shownPath, hiddenPath]));
    assert.ok(inherited.content[0].text.includes(`reused result=${firstResultId}`));
  } finally {
    await client.close();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
