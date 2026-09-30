import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { storeArtifact } from '../src/artifact-store.mjs';
import { pipelinePipeline } from '../src/pipelines.mjs';
import {
  MICRO_OS_TOOLS,
  MICRO_PRESETS,
  applyOutputBudget,
  executeMicroTool,
  loadMicroSkillGuidance,
  normalizeMicroInvocation,
  resolveMicroBudget,
  resolveChatCompletionsUrl,
  resolveMicroInput,
  runMicroTask,
  runMicroTasksParallel,
} from '../src/micro-client.mjs';

function createMockServer() {
  const requests = [];
  let handler = (req, res, body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock-1',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'mock answer',
              reasoning_content: 'mock reasoning',
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      })
    );
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch (_) {}
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: parsed,
        raw,
      });
      handler(req, res, parsed);
    });
  });

  return {
    requests,
    setHandler: (fn) => {
      handler = fn;
    },
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const port = server.address().port;
          resolve({ port, url: `http://127.0.0.1:${port}` });
        });
      }),
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  };
}

test('resolveChatCompletionsUrl handles various inputs', () => {
  assert.equal(resolveChatCompletionsUrl('https://api.example.com/v1'), 'https://api.example.com/v1/chat/completions');
  assert.equal(resolveChatCompletionsUrl('https://api.example.com/v1/'), 'https://api.example.com/v1/chat/completions');
  assert.equal(
    resolveChatCompletionsUrl('https://api.example.com/v1/chat/completions'),
    'https://api.example.com/v1/chat/completions'
  );
  assert.equal(
    resolveChatCompletionsUrl('https://api.example.com/v1/chat/completions/'),
    'https://api.example.com/v1/chat/completions'
  );
  assert.equal(resolveChatCompletionsUrl(''), null);
  assert.equal(resolveChatCompletionsUrl(null), null);
});

test('resolveMicroInput accepts artifact references without inlining caller context', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-micro-input-'));
  try {
    storeArtifact(root, 'artifact payload', { id: 'art-input' });
    const result = resolveMicroInput({ inputArtifact: 'art-input' }, { projectRoot: root });
    assert.equal(result.source, 'artifact');
    assert.equal(result.input, 'artifact payload');
    const alias = resolveMicroInput({ artifactId: 'art-input' }, { projectRoot: root });
    assert.equal(alias.source, 'artifact');
    assert.equal(alias.input, 'artifact payload');
    assert.throws(
      () => resolveMicroInput({ inputRef: '../escape' }, { projectRoot: root }),
      /inside the project root/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MICRO_PRESETS contains all required presets', () => {
  const expectedKeys = ['triage', 'contract', 'patch', 'graph', 'custom', 'evidence'];
  for (const key of expectedKeys) {
    assert.ok(MICRO_PRESETS[key], `Missing preset ${key}`);
    assert.ok(MICRO_PRESETS[key].name);
    assert.ok(MICRO_PRESETS[key].system);
    assert.ok(MICRO_PRESETS[key].format);
  }
});

test('graph Micro preset emits the canonical curated Block/Chain contract', () => {
  const prompt = MICRO_PRESETS.graph.system;
  assert.match(prompt, /memberIds/);
  assert.match(prompt, /paths/);
  assert.match(prompt, /stable curated semantic ids/);
  assert.match(prompt, /Never emit mod-\* ids/);
  assert.doesNotMatch(prompt, /\{"blocks":\[\{"id","name","chain"/);
});

test('runMicroTask validates required configuration', async () => {
  // Missing URL
  const noUrl = await runMicroTask({}, { prompt: 'hi' });
  assert.equal(noUrl.ok, false);
  assert.match(noUrl.error, /Micro URL is not configured/);

  // Missing model
  const noModel = await runMicroTask({ url: 'http://localhost:8080' }, { prompt: 'hi' });
  assert.equal(noModel.ok, false);
  assert.match(noModel.error, /Micro model is not configured/);
});

test('runMicroTask accepts task as the direct Micro prompt alias', async () => {
  const mock = createMockServer();
  const { url } = await mock.listen();
  try {
    const result = await runMicroTask({ url, model: 'test-model' }, { task: 'analyze this receipt' });
    assert.equal(result.ok, true);
    assert.equal(mock.requests[0].body.messages.at(-1).content, 'analyze this receipt');
  } finally {
    await mock.close();
  }
});

test('runMicroTask injects preload evidence into the Micro-only transcript', async () => {
  const mock = createMockServer();
  mock.setHandler((req, res, body) => {
    const preload = body.messages.find((message) => message.role === 'system' && message.content.includes('Preloaded OS context'));
    assert.ok(preload, 'preload must be present as a system message');
    assert.match(preload.content, /preload evidence/);
    assert.match(preload.content, /artifact=art-preload/);
    assert.equal(body.tools, undefined, 'preload evidence alone must not enable OS tools');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'preload consumed' } }],
      usage: { prompt_tokens: 8, completion_tokens: 4 },
    }));
  });
  const { url } = await mock.listen();
  try {
    const result = await runMicroTask(
      { url, model: 'test-model' },
      {
        prompt: 'analyze the preloaded evidence',
        projectRoot: process.cwd(),
        preload: {
          status: 'FAIL',
          artifactId: 'art-preload',
          summary: 'preload evidence: assertion failed',
          chars: 34,
        },
      }
    );
    assert.equal(result.ok, true);
    assert.equal(result.preload.status, 'FAIL');
    assert.equal(result.preload.artifactId, 'art-preload');
  } finally {
    await mock.close();
  }
});

test('runMicroTask enables OS tools only when explicitly requested', async () => {
  const mock = createMockServer();
  const { url } = await mock.listen();
  try {
    const result = await runMicroTask(
      { url, model: 'test-model' },
      { prompt: 'inspect one bounded source', projectRoot: process.cwd(), withOS: true }
    );
    assert.equal(result.ok, true);
    assert.ok(mock.requests[0].body.tools, 'explicit withOS should expose bounded OS tools');
  } finally {
    await mock.close();
  }
});

test('runMicroTask suppresses duplicate read-only OS calls within one Micro turn', async () => {
  const mock = createMockServer();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-micro-read-memo-'));
  let requestNumber = 0;
  let inspectCalls = 0;
  mock.setHandler((_req, res) => {
    requestNumber += 1;
    const response = requestNumber < 3
      ? {
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: `read-${requestNumber}`,
                type: 'function',
                function: {
                  name: 'os',
                  arguments: JSON.stringify({ action: 'inspect', path: 'src/fixture.mjs' }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }
      : {
          choices: [{ message: { role: 'assistant', content: 'finished' } }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  const { url } = await mock.listen();
  try {
    const result = await runMicroTask(
      { url, model: 'test-model' },
      {
        prompt: 'inspect the fixture once and finish',
        projectRoot: root,
        withOS: true,
        caps: {
          inspect: async () => {
            inspectCalls += 1;
            return { ok: true, data: 'bounded source result' };
          },
        },
      }
    );
    assert.equal(result.ok, true);
    assert.equal(result.content, 'finished');
    assert.equal(inspectCalls, 1, 'duplicate read-only calls must reuse the first result');
    assert.equal(result.deduplicatedToolCallCount, 1);
    assert.equal(result.toolCalls.filter((call) => call.deduplicated).length, 1);
  } finally {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runMicroTask gives receipt-backed input a default preset instruction', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-micro-receipt-prompt-'));
  fs.mkdirSync(path.join(root, '.contextos', 'logs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.contextos', 'logs', 'receipt-test.log'),
    'AssertionError: expected 1 but received 2',
    'utf8'
  );
  const mock = createMockServer();
  mock.setHandler((req, res, body) => {
    const user = body.messages.find((message) => message.role === 'user');
    assert.match(user.content, /Analyze the following input/);
    assert.match(user.content, /<INPUT>/);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: JSON.stringify({
            answer: 'root cause',
            evidenceRefs: ['receipt-test'],
            confidence: 'high',
            unknowns: [],
          }),
        },
      }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    }));
  });
  const { url } = await mock.listen();
  try {
    const result = await runMicroTask(
      { url, model: 'test-model' },
      { preset: 'evidence', inputReceipt: 'receipt-test', projectRoot: root }
    );
    assert.equal(result.ok, true);
    assert.equal(result.inputSource, 'receipt');
    assert.equal(result.structured.answer, 'root cause');
  } finally {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runMicroTask rejects an empty provider response', async () => {
  const mock = createMockServer();
  mock.setHandler((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'mock-empty',
      choices: [{ index: 0, message: { role: 'assistant', content: '   ' } }],
      usage: { prompt_tokens: 3, completion_tokens: 0 },
    }));
  });
  const { url } = await mock.listen();
  try {
    const result = await runMicroTask({ url, model: 'test-model' }, { prompt: 'ping' });
    assert.equal(result.ok, false);
    assert.match(result.error, /empty response/);
    assert.equal(mock.requests.length, 2, 'empty response must trigger one final-answer retry');
    assert.ok(result.usage.total_tokens >= 3);
  } finally {
    await mock.close();
  }
});

test('runMicroTask surfaces a provider completion cap instead of a silent success', async () => {
  const mock = createMockServer();
  mock.setHandler((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'mock-cap',
      choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: 'partial report' } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }));
  });
  const { url } = await mock.listen();
  try {
    const result = await runMicroTask({ url, model: 'test-model' }, { prompt: 'report everything', outputMode: 'answer' });
    assert.equal(result.ok, true);
    assert.equal(result.providerTruncated, true);
    assert.equal(result.finishReason, 'length');
    assert.equal(mock.requests[0].body.max_tokens, 3072, 'the custom answer ceiling must not silently cut a report at 512 tokens');
  } finally {
    await mock.close();
  }
});

test('runMicroTask records provider cache hits instead of pricing every prompt token as fresh', async () => {
  const mock = createMockServer();
  mock.setHandler((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'mock-cache',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'cached answer' } }],
      usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, prompt_tokens_details: { cached_tokens: 900 } },
    }));
  });
  const { url } = await mock.listen();
  try {
    const result = await runMicroTask({ url, model: 'test-model' }, { prompt: 'cached?', outputMode: 'answer' });
    assert.equal(result.ok, true);
    assert.equal(result.providerUsage.cached_input_tokens, 900);
    assert.equal(result.providerUsage.uncached_input_tokens, 100);
  } finally {
    await mock.close();
  }
});

test('runMicroTask retries pseudo tool-call output when tools are disabled', async () => {
  const mock = createMockServer();
  let callIndex = 0;
  mock.setHandler((_req, res, body) => {
    callIndex += 1;
    if (callIndex === 1) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'pseudo-tool-call',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '<\uFF5C｜DSML｜\uFF5C calls>\n<\uFF5C｜DSML｜\uFF5C invoke name="bash">npm test',
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }));
      return;
    }
    assert.equal(body.reasoning_effort, 'none');
    assert.match(body.messages.at(-1).content, /no tools are available/);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'final-answer',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Root cause and repair direction.' } }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    }));
  });
  const { url } = await mock.listen();
  try {
    const result = await runMicroTask(
      { url, model: 'test-model' },
      { prompt: 'diagnose', invocation: { provider: { maxRequests: 1 }, tools: { enabled: false } } },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.content, 'Root cause and repair direction.');
    assert.equal(result.providerRequests, 2);
    assert.equal(mock.requests.length, 2);
  } finally {
    await mock.close();
  }
});

test('runMicroTask injects host skill guidance without micro-only restrictions', async () => {
  const mock = createMockServer();
  const guidance = loadMicroSkillGuidance({ projectRoot: process.cwd() });
  mock.setHandler((_req, res, body) => {
    const systemPrompt = body.messages[0].content;
    assert.equal(systemPrompt, guidance);
    assert.match(systemPrompt, /name: contextos/);
    assert.match(systemPrompt, /ContextOS operations and diagnosis/);
    assert.match(systemPrompt, /Pipeline is the default container for 3 or more known independent reads/);
    assert.doesNotMatch(systemPrompt, /You are a bounded executor/);
    assert.doesNotMatch(systemPrompt, /When a change is rejected because it exceeds allowedPaths/);
    assert.doesNotMatch(systemPrompt, /Do not delegate to another agent/);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'skill-guidance',
      choices: [{ index: 0, message: { role: 'assistant', content: 'host-equivalent guidance received' } }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    }));
  });
  const { url } = await mock.listen();
  try {
    const result = await runMicroTask(
      { url, model: 'test-model' },
      { prompt: 'inspect the assigned surface', withOS: true, invocation: { tools: { enabled: true } } },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(mock.requests.length, 1);
  } finally {
    await mock.close();
  }
});

test('project-local canonical skills take precedence over stale runtime copies', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-skill-precedence-'));
  const skillsRoot = path.join(projectRoot, 'plugins/contextos/skills');
  fs.mkdirSync(path.join(skillsRoot, 'contextos'), { recursive: true });
  fs.mkdirSync(path.join(skillsRoot, 'contextos-ops'), { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, 'contextos/SKILL.md'), '---\nname: contextos\n---\nPROJECT_CANONICAL_CONTEXTOS\n');
  fs.writeFileSync(path.join(skillsRoot, 'contextos-ops/SKILL.md'), '---\nname: contextos-ops\n---\nPROJECT_CANONICAL_OPS\n');
  try {
    const guidance = loadMicroSkillGuidance({ projectRoot });
    assert.match(guidance, /PROJECT_CANONICAL_CONTEXTOS/);
    assert.match(guidance, /PROJECT_CANONICAL_OPS/);
    assert.doesNotMatch(guidance, /意图级开发底座与编码执行外骨骼/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('runMicroTask rejects pseudo tool-call output after finalization retry', async () => {
  const mock = createMockServer();
  mock.setHandler((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'pseudo-tool-call',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '<\uFF5C｜DSML｜\uFF5C calls>\n<\uFF5C｜DSML｜\uFF5C invoke name="bash">npm test',
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }));
  });
  const { url } = await mock.listen();
  try {
    const result = await runMicroTask(
      { url, model: 'test-model' },
      { prompt: 'diagnose', invocation: { provider: { maxRequests: 1 }, tools: { enabled: false } } },
    );
    assert.equal(result.ok, false);
    assert.equal(result.invalidOutput, 'tool_call_syntax');
    assert.match(result.error, /tool-call syntax while tools were disabled/);
    assert.equal(mock.requests.length, 2);
  } finally {
    await mock.close();
  }
});

test('runMicroTask separates provider usage from token fallback estimates', async () => {
  const mock = createMockServer();
  mock.setHandler((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'estimated-usage',
      choices: [{ index: 0, message: { role: 'assistant', content: 'small answer' } }],
    }));
  });
  const { url } = await mock.listen();
  try {
    const result = await runMicroTask({ url, model: 'test-model' }, { prompt: 'answer' });
    assert.equal(result.ok, true);
    assert.equal(result.usageSource, 'estimated');
    assert.equal(result.providerUsage, null);
    assert.equal(result.providerUsageCalls, 0);
    assert.equal(result.estimatedUsageCalls, 1);
    assert.ok(result.estimatedUsage.total_tokens > 0);
  } finally {
    await mock.close();
  }
});

test('runMicroTask retries once without reasoning when the provider returns reasoning only', async () => {
  const mock = createMockServer();
  let callIndex = 0;
  mock.setHandler((req, res, body) => {
    callIndex += 1;
    if (callIndex === 1) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'reasoning-only',
        choices: [{ index: 0, message: { role: 'assistant', content: '', reasoning_content: 'long internal reasoning' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }));
      return;
    }
    assert.equal(body.reasoning_effort, 'none', 'final-answer retry must explicitly disable reasoning');
    assert.equal(body.tools, undefined, 'final-answer retry must not expose tools');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'final-answer',
      choices: [{ index: 0, message: { role: 'assistant', content: 'final answer' } }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    }));
  });
  const { url } = await mock.listen();
  try {
    const result = await runMicroTask({ url, model: 'test-model' }, { prompt: 'answer with evidence' });
    assert.equal(result.ok, true);
    assert.equal(result.content, 'final answer');
    assert.equal(mock.requests.length, 2);
    assert.equal(result.usage.total_tokens, 42);
    assert.equal(result.usageSource, 'provider');
    assert.equal(result.providerUsage.total_tokens, 42);
    assert.equal(result.providerUsageCalls, 2);
    assert.equal(result.estimatedUsage, null);
  } finally {
    await mock.close();
  }
});

test('runMicroTask still finalizes an empty response when maxRequests is one', async () => {
  const mock = createMockServer();
  let callIndex = 0;
  mock.setHandler((_req, res, body) => {
    callIndex += 1;
    if (callIndex === 1) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'reasoning-only-bounded',
        choices: [{ index: 0, message: { role: 'assistant', content: '', reasoning_content: 'budget consumed' } }],
        usage: { prompt_tokens: 10, completion_tokens: 512, total_tokens: 522 },
      }));
      return;
    }
    assert.equal(body.reasoning_effort, 'none');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'final-answer-bounded',
      choices: [{ index: 0, message: { role: 'assistant', content: 'bounded final answer' } }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    }));
  });
  const { url } = await mock.listen();
  try {
    const result = await runMicroTask(
      { url, model: 'test-model' },
      {
        prompt: 'answer with evidence',
        invocation: { provider: { maxRequests: 1 }, tools: { enabled: false } },
      },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.content, 'bounded final answer');
    assert.equal(mock.requests.length, 2);
    assert.equal(result.providerRequests, 2);
  } finally {
    await mock.close();
  }
});

test('runMicroTask evidence preset returns structured evidence fields', async () => {
  const mock = createMockServer();
  mock.setHandler((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: JSON.stringify({
            answer: 'The parser should reject empty input.',
            evidenceRefs: [{ path: 'src/parser.mjs', lines: '10-18' }],
            confidence: 'medium',
            unknowns: ['No production sample'],
          }),
        },
      }],
      usage: { prompt_tokens: 8, completion_tokens: 12 },
    }));
  });
  const { url } = await mock.listen();
  try {
    const result = await runMicroTask({ url, model: 'test-model' }, {
      preset: 'evidence',
      task: 'Inspect the parser and return structured evidence.',
    });
    assert.equal(result.ok, true);
    assert.equal(result.confidence, 'medium');
    assert.equal(result.evidenceRefs[0].path, 'src/parser.mjs');
    assert.deepEqual(result.unknowns, ['No production sample']);
    assert.equal(result.structured.answer, 'The parser should reject empty input.');
  } finally {
    await mock.close();
  }
});

test('runMicroTask sends proper payload and headers', async () => {
  const mock = createMockServer();
  const { url } = await mock.listen();

  try {
    const config = {
      url,
      model: 'test-model',
      key: 'sk-test-secret',
      sessionHeader: 'x-custom-session',
    };

    const res = await runMicroTask(config, {
      preset: 'triage',
      prompt: 'Analyze this error',
      input: 'TypeError: undefined is not a function',
      sessionId: 'sess-test-42',
    });

    assert.equal(res.ok, true);
    assert.equal(res.content, 'mock answer');
    assert.equal(res.reasoning, 'mock reasoning');
    assert.equal(res.usage.prompt_tokens, 10);
    assert.equal(res.usage.completion_tokens, 20);

    assert.equal(mock.requests.length, 1);
    const req = mock.requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/chat/completions');
    assert.equal(req.headers['authorization'], 'Bearer sk-test-secret');
    assert.equal(req.headers['x-custom-session'], 'sess-test-42');

    const payload = req.body;
    assert.equal(payload.model, 'test-model');
    assert.equal(Object.hasOwn(payload, 'max_tokens'), false);
    assert.equal(payload.reasoning_effort, 'low');
    assert.equal(payload.messages.length, 2);
    assert.equal(payload.messages[0].role, 'system');
    assert.equal(payload.messages[0].content, loadMicroSkillGuidance({ projectRoot: process.cwd() }));
    assert.equal(payload.messages[1].role, 'user');
    assert.match(payload.messages[1].content, /Analyze this error/);
    assert.match(payload.messages[1].content, /<INPUT>\nTypeError: undefined is not a function\n<\/INPUT>/);
  } finally {
    await mock.close();
  }
});

test('one-shot Micro calls do not persist empty continuation stubs', async () => {
  const mock = createMockServer();
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-micro-stub-'));
  mock.setHandler((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'one-shot',
      choices: [{ index: 0, message: { role: 'assistant', content: 'one-shot complete' } }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    }));
  });
  const { url } = await mock.listen();
  try {
    const result = await runMicroTask({ url, model: 'test-model' }, {
      projectRoot,
      prompt: 'one-shot task',
      sessionId: 'sess-one-shot',
      withOS: true,
      invocation: { tools: { enabled: true } },
    });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(projectRoot, '.contextos', 'micro-session-context')), false);
  } finally {
    await mock.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('runMicroTask isolates implicit provider sessions across calls', async () => {
  const mock = createMockServer();
  const { url } = await mock.listen();

  try {
    const config = { url, model: 'test-model', sessionHeader: 'x-session' };
    await runMicroTask(config, { preset: 'triage', prompt: 'first' });
    await runMicroTask(config, { preset: 'triage', prompt: 'second' });

    assert.equal(mock.requests.length, 2);
    assert.notEqual(mock.requests[0].headers['x-session'], mock.requests[1].headers['x-session']);
  } finally {
    await mock.close();
  }
});

test('runMicroTask can require external bulk input before provider dispatch', async () => {
  const mock = createMockServer();
  const { url } = await mock.listen();
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-micro-bulk-input-'));
  try {
    const config = { url, model: 'test-model', requireBulkInput: true };
    const rejected = await runMicroTask(config, { preset: 'triage', task: 'summarize' });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /requires inputRef/);
    assert.equal(mock.requests.length, 0);

    const withOS = await runMicroTask(config, {
      preset: 'contract',
      task: 'inspect bounded repository structure',
      withOS: true,
      projectRoot,
      caps: {},
    });
    assert.equal(withOS.ok, true);
    assert.equal(withOS.withOS, true);
    assert.equal(withOS.inputSource, 'task');

    const batched = await runMicroTasksParallel(config, [
      { preset: 'contract', task: 'inspect README contract', withOS: true },
      { preset: 'graph', task: 'inspect source relationships', withOS: true },
    ], { projectRoot, caps: {} });
    assert.equal(batched.ok, true);
    assert.ok(batched.tasks.every((task) => task.batch === true));

    fs.writeFileSync(path.join(projectRoot, 'diagnostic.log'), 'first\nsecond\n');
    const accepted = await runMicroTask(config, {
      preset: 'triage',
      inputRef: 'diagnostic.log',
      task: 'summarize',
      projectRoot,
    });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.inputSource, 'inputRef');
  } finally {
    await mock.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('runMicroTask enforces provider token and cost budgets before dispatch', async () => {
  const mock = createMockServer();
  const { url } = await mock.listen();

  try {
    const config = { url, model: 'test-model' };
    const tokenLimited = await runMicroTask(config, {
      prompt: 'analyze this',
      maxTokens: 100,
      maxProviderTokens: 1,
    });
    assert.equal(tokenLimited.ok, false);
    assert.equal(tokenLimited.budgetExceeded, 'providerTokens');
    assert.match(tokenLimited.error, /token budget exceeded/);
    assert.match(tokenLimited.hint, /maxProviderTokens/);

    const costLimited = await runMicroTask(config, {
      prompt: 'analyze this',
      maxTokens: 100,
      maxCostUsd: 0.000001,
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 1,
    });
    assert.equal(costLimited.ok, false);
    assert.equal(costLimited.budgetExceeded, 'cost');
    assert.match(costLimited.error, /cost budget exceeded/);

    const oversizedPreload = await runMicroTask(config, {
      prompt: 'summarize this small chore',
      maxTokens: 512,
      maxProviderTokens: 1000,
      preload: { status: 'OK', summary: 'x'.repeat(40000) },
    });
    assert.equal(oversizedPreload.ok, false);
    assert.equal(oversizedPreload.budgetExceeded, 'providerTokens');
    assert.equal(oversizedPreload.budgetDecision.action, 'narrow_or_raise_provider_tokens');
    assert.equal(oversizedPreload.budgetDecision.retrySafe, false);
    assert.ok(oversizedPreload.budgetDecision.projected > oversizedPreload.budgetDecision.limit);
    assert.equal(mock.requests.length, 0, 'an explicit budget still stops the dispatch');

    const unbudgetedPreload = await runMicroTask(config, {
      prompt: 'summarize this small chore',
      maxTokens: 512,
      preload: { status: 'OK', summary: 'x'.repeat(40000) },
    });
    assert.equal(unbudgetedPreload.ok, true, 'no default budget may kill a legitimate run');
    assert.equal(mock.requests.length, 1);

    const requestsBeforeTruncated = mock.requests.length;
    const truncatedPreload = await runMicroTask(config, {
      prompt: 'review the inspected source',
      preload: {
        ok: false,
        status: 'TRUNCATED',
        truncated: true,
        summary: 'only an incomplete excerpt',
      },
    });
    assert.equal(truncatedPreload.ok, false);
    assert.match(truncatedPreload.error, /preload evidence was truncated/);
    assert.equal(truncatedPreload.usageSource, 'unavailable');
    assert.equal(mock.requests.length, requestsBeforeTruncated, 'truncated evidence must be rejected before provider dispatch');

    const measured = await runMicroTask(config, { prompt: 'measure usage' });
    assert.equal(measured.ok, true);
    assert.equal(measured.usage.total_tokens, 30);
    assert.equal(measured.budget.maxProviderTokens, null, 'no default provider token budget may kill a Micro run');
  } finally {
    await mock.close();
  }
});

test('Micro direct evidence route is bounded to one provider request and reports invocation state', async () => {
  const mock = createMockServer();
  const { url } = await mock.listen();
  try {
    const result = await runMicroTask({ url, model: 'test-model' }, {
      prompt: 'summarize the attached evidence',
      preload: { ok: true, status: 'OK', summary: 'bounded evidence', chars: 16 },
    });
    assert.equal(result.ok, true);
    assert.equal(mock.requests.length, 1);
    assert.equal(result.providerRequests, 1);
    assert.equal(result.invocation.evidenceMode, 'pipeline');
    assert.equal(result.invocation.maxRequests, 1);
    assert.equal(result.invocation.shortCircuited, false);
  } finally {
    await mock.close();
  }
});

test('Micro input budgets short-circuit before dispatch and empty responses get one finalization call', async () => {
  const mock = createMockServer();
  const { url } = await mock.listen();
  mock.setHandler((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '' } }],
      usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
    }));
  });
  try {
    const requestLimited = await runMicroTask({ url, model: 'test-model' }, {
      prompt: 'empty answer should not trigger an unbounded retry',
      preload: { ok: true, status: 'OK', summary: 'evidence', chars: 8 },
      delivery: 'defer',
    });
    assert.equal(requestLimited.ok, false);
    assert.equal(requestLimited.budgetExceeded, undefined, 'an empty response is not itself a budget failure');
    assert.match(requestLimited.error, /empty response after final-answer retry/);
    assert.equal(requestLimited.delivery, 'defer', 'failed deliveries must preserve the requested delivery');
    assert.equal(requestLimited.providerRequests, 2, 'one empty response may use a terminal finalization call');
    assert.equal(mock.requests.length, 2);

    const inputLimited = await runMicroTask({ url, model: 'test-model' }, {
      prompt: 'x'.repeat(100),
      invocation: { provider: { maxInputTokens: 4 } },
    });
    assert.equal(inputLimited.ok, false);
    assert.equal(inputLimited.budgetExceeded, 'inputTokens');
    assert.equal(inputLimited.budgetDecision.action, 'narrow_or_raise_input');
    assert.equal(inputLimited.budgetDecision.retrySafe, false);
    assert.equal(mock.requests.length, 2, 'input admission must happen before more network dispatch');
  } finally {
    await mock.close();
  }
});

test('resolveMicroBudget keeps provider token limits opt-in', () => {
  assert.equal(
    resolveMicroBudget({}, { withOS: true, invocation: { provider: { maxRequests: 4 } } }).maxProviderTokens,
    null,
  );
  assert.equal(
    resolveMicroBudget({}, { withOS: true, invocation: { provider: { maxRequests: 4, maxProviderTokens: 9000 } } }).maxProviderTokens,
    9000,
  );
  assert.equal(
    resolveMicroBudget({}, { withOS: false, invocation: { provider: { maxRequests: 4 } } }).maxProviderTokens,
    null,
  );
});

test('normalizeMicroInvocation keeps flat fields compatible with the bounded contract', () => {
  assert.deepEqual(
    normalizeMicroInvocation({}, { preload: { ok: true }, withOS: false }, 'triage', { hasPreload: true }),
    {
      evidenceMode: 'pipeline',
      evidenceCacheHit: false,
      maxRequests: 1,
      maxInputTokens: null,
      maxOutputTokens: null,
      toolsEnabled: false,
      allowCommands: false,
      maxSteps: null,
      shortCircuited: false,
    },
  );
});

test('Micro exposes run only when command execution is explicitly allowed', async () => {
  const denied = await executeMicroTool('run', { command: 'npm test' }, {
    allowCommands: false,
    dispatch: async () => 'should-not-run',
  });
  assert.match(denied, /allowCommands:true/);

  const calls = [];
  const allowed = await executeMicroTool('run', { command: 'npm test', maxChars: 800 }, {
    allowCommands: true,
    dispatch: async (tool, input) => {
      calls.push({ tool, input });
      return JSON.stringify({ ok: true, summary: '1 test failed' });
    },
  });
  assert.match(allowed, /1 test failed/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'ops');
  assert.equal(calls[0].input.capability, 'run_command');
  assert.equal(calls[0].input.args.command, 'npm test');
  assert.equal(calls[0].input.args.mode, 'summary');
});

test('API runMicroTask executes an allowed run tool through the provider loop', async () => {
  const mock = createMockServer();
  const { url } = await mock.listen();
  let requestCount = 0;
  let commandCount = 0;
  mock.setHandler((_req, res) => {
    requestCount += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const message = requestCount === 1
      ? { tool_calls: [{ id: 'run-1', type: 'function', function: { name: 'run', arguments: JSON.stringify({ command: 'npm test' }) } }] }
      : { content: '1 test failed' };
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
  });

  try {
    const result = await runMicroTask(
      { url, model: 'test-model' },
      {
        prompt: 'Run the focused test and summarize the failure.',
        withOS: true,
        caps: {
          run: async (args) => { commandCount += 1; assert.equal(args.command, 'npm test'); return { ok: true, data: '1 test failed' }; },
        },
        invocation: { tools: { enabled: true, allowCommands: true }, provider: { maxRequests: 2 } },
      },
    );
    assert.equal(result.ok, true, result.error);
    assert.equal(result.invocation.providerRequests, 2);
    assert.equal(requestCount, 2, 'the API endpoint receives the tool turn and final turn');
    assert.equal(commandCount, 1, 'the run capability executes once');
    assert.equal(result.content, '1 test failed');
    assert.equal(result.toolCalls[0].name, 'run');
  } finally {
    await mock.close();
  }
});

test('runMicroTask rejects unsupported provider protocols', async () => {
  const result = await runMicroTask({ url: 'ftp://example.com', model: 'test-model' }, { prompt: 'hi' });
  assert.equal(result.ok, false);
  assert.match(result.error, /Unsupported Micro URL protocol/);
});

test('executeMicroTool blocks inspect path traversal in fallback mode', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-micro-path-'));
  try {
    const result = await executeMicroTool('inspect', { path: '../outside.txt' }, { projectRoot: root });
    assert.match(result, /inside the project root/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runMicroTask enforces budgets before final tool-convergence dispatch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-micro-final-budget-'));
  const mock = createMockServer();
  const { url } = await mock.listen();
  mock.setHandler((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'inspect', arguments: JSON.stringify({ path: 'a.mjs' }) },
          }],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }));
  });
  try {
    fs.writeFileSync(path.join(root, 'a.mjs'), 'export const x = 1;\n');
    const result = await runMicroTask({ url, model: 'test-model' }, {
      prompt: 'inspect the file',
      projectRoot: root,
      withOS: true,
      maxSteps: 1,
      maxTokens: 5,
      maxProviderTokens: 4130,
      caps: { inspect: async () => 'export const x = 1;' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.budgetExceeded, 'providerTokens');
    assert.equal(mock.requests.length, 1);
  } finally {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runMicroTask classifies request exhaustion after executor tool rounds', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-micro-executor-budget-'));
  fs.writeFileSync(path.join(root, 'a.mjs'), 'export const x = 1;\n');
  const mock = createMockServer();
  const { url } = await mock.listen();
  mock.setHandler((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: `inspect-${mock.requests.length}`,
            type: 'function',
            function: { name: 'inspect', arguments: JSON.stringify({ path: 'a.mjs' }) },
          }],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }));
  });
  try {
    const result = await runMicroTask({ url, model: 'test-model' }, {
      prompt: 'inspect the file twice',
      projectRoot: root,
      withOS: true,
      maxSteps: 2,
      invocation: {
        provider: { maxRequests: 2 },
        tools: { enabled: true },
      },
      caps: { inspect: async () => 'export const x = 1;' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.budgetExceeded, 'requests');
    assert.equal(result.withOS, true);
    assert.equal(result.executionMode, 'executor');
    assert.equal(result.summarizerOnly, false);
    assert.equal(result.invocation.toolRounds, 2);
    assert.equal(result.toolCalls.length, 2);
    assert.equal(mock.requests.length, 2);
  } finally {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runMicroTask rejects oversized provider responses', async () => {
  const mock = createMockServer();
  const { url } = await mock.listen();
  mock.setHandler((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'x'.repeat(500) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  try {
    const result = await runMicroTask({ url, model: 'test-model', maxResponseChars: 100 }, { prompt: 'hi' });
    assert.equal(result.ok, false);
    assert.match(result.error, /maxResponseChars/);
  } finally {
    await mock.close();
  }
});

test('runMicroTasksParallel isolates task failures and aggregates provider usage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-micro-batch-'));
  const mock = createMockServer();
  const { url } = await mock.listen();
  try {
    const result = await runMicroTasksParallel(
      { url, model: 'test-model' },
      [
        { id: 'bad', prompt: 'reject this input', inputRef: '../escape' },
        { id: 'good', prompt: 'analyze this' },
      ],
      { projectRoot: root }
    );
    assert.equal(result.ok, false);
    assert.equal(result.tasks[0].ok, false);
    assert.match(result.tasks[0].error, /inside the project root/);
    assert.equal(result.tasks[1].ok, true);
    assert.equal(result.usage.totalTokens, 30);
  } finally {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runMicroTasksParallel bounds provider concurrency without dropping tasks', async () => {
  const mock = createMockServer();
  const { url } = await mock.listen();
  let active = 0;
  let peak = 0;
  let calls = 0;
  mock.setHandler((_req, res, body) => {
    active += 1;
    calls += 1;
    peak = Math.max(peak, active);
    setTimeout(() => {
      active -= 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: body.messages.at(-1).content } }],
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
      }));
    }, 15);
  });

  try {
    const result = await runMicroTasksParallel(
      { url, model: 'test-model' },
      Array.from({ length: 5 }, (_, index) => ({ id: `bounded-${index + 1}`, prompt: `task-${index + 1}` })),
      { maxConcurrency: 2 }
    );
    assert.equal(result.ok, true);
    assert.equal(calls, 5, 'a concurrency cap must not discard batch tasks');
    assert.equal(peak, 2, 'provider requests must respect the requested concurrency cap');
    assert.deepEqual(result.tasks.map((task) => task.id), [
      'bounded-1', 'bounded-2', 'bounded-3', 'bounded-4', 'bounded-5',
    ]);
  } finally {
    await mock.close();
  }
});

test('runMicroTask supports thinking levels and custom maxTokens', async () => {
  const mock = createMockServer();
  const { url } = await mock.listen();

  try {
    const config = { url, model: 'test-model' };

    // high thinking
    await runMicroTask(config, { prompt: 'hi', thinking: 'high', maxTokens: 8192, maxProviderTokens: 20000 });
    assert.equal(mock.requests[0].body.reasoning_effort, 'high');
    assert.equal(mock.requests[0].body.max_tokens, 8192);

    // none thinking
    await runMicroTask(config, { prompt: 'hi', thinking: 'none' });
    assert.equal(mock.requests[1].body.reasoning_effort, undefined);
  } finally {
    await mock.close();
  }
});

test('runMicroTask preserves conversation history for multi-turn tasks', async () => {
  const mock = createMockServer();
  const { url } = await mock.listen();

  try {
    const config = { url, model: 'test-model' };
    const history = [
      { role: 'user', content: 'Turn 1 user' },
      { role: 'assistant', content: 'Turn 1 assistant' },
    ];

    await runMicroTask(config, {
      history,
      prompt: 'Turn 2 user',
      preset: 'contract',
    });

    const messages = mock.requests[0].body.messages;
    assert.equal(messages[0].content, loadMicroSkillGuidance({ projectRoot: process.cwd() }));
    assert.equal(messages[1].content, 'Turn 1 user');

    assert.equal(messages[2].content, 'Turn 1 assistant');
    assert.equal(messages[3].content, 'Turn 2 user');
  } finally {
    await mock.close();
  }
});

test('runMicroTask handles HTTP error responses and timeouts', async () => {
  const mock = createMockServer();
  const { url } = await mock.listen();

  try {
    const config = { url, model: 'test-model' };

    // 400 Bad Request with error body
    mock.setHandler((req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid model parameter' } }));
    });

    const errRes = await runMicroTask(config, { prompt: 'test' });
    assert.equal(errRes.ok, false);
    assert.equal(errRes.statusCode, 400);
    assert.match(errRes.error, /Invalid model parameter/);

    // Timeout
    mock.setHandler((req, res) => {
      // intentionally hang
    });

    const timeoutRes = await runMicroTask(config, { prompt: 'test', timeoutMs: 50 });
    assert.equal(timeoutRes.ok, false);
    assert.equal(timeoutRes.status, 'partial');
    assert.equal(timeoutRes.partial, true);
    assert.equal(timeoutRes.errorCode, 'MICRO_CONTINUATION_REQUIRED');
    assert.equal(timeoutRes.resume.kind, 'micro');
    assert.match(timeoutRes.guidance, /refresh the 290s window/);
  } finally {
    await mock.close();
  }
});

test('runMicroTasksParallel executes tasks concurrently with error isolation', async () => {
  const mock = createMockServer();
  const { url } = await mock.listen();

  try {
    const config = { url, model: 'test-model' };

    let count = 0;
    mock.setHandler((req, res, body) => {
      count++;
      if (body.messages.some((m) => m.content.includes('fail-task'))) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Server exploded' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: `Result for ${body.messages.at(-1).content}` } }],
          })
        );
      }
    });

    const batch = await runMicroTasksParallel(
      config,
      [
        { id: 't1', prompt: 'success-1' },
        { id: 't2', prompt: 'fail-task' },
        { id: 't3', prompt: 'success-2' },
      ],
      { preset: 'patch' }
    );

    assert.equal(batch.ok, false); // because t2 failed
    assert.equal(batch.tasks.length, 3);
    assert.equal(batch.tasks[0].id, 't1');
    assert.equal(batch.tasks[0].ok, true);
    assert.match(batch.tasks[0].content, /Result for success-1/);

    assert.equal(batch.tasks[1].id, 't2');
    assert.equal(batch.tasks[1].ok, false);
    assert.match(batch.tasks[1].error, /Server exploded/);

    assert.equal(batch.tasks[2].id, 't3');
    assert.equal(batch.tasks[2].ok, true);
    assert.match(batch.tasks[2].content, /Result for success-2/);
  } finally {
    await mock.close();
  }
});

test('Micro OS tools expose bounded reads, optional run, and curated Block/Chain chores', () => {
  const toolNames = MICRO_OS_TOOLS.map((t) => t.function.name);
  assert.deepEqual(toolNames, ['os', 'run', 'block', 'chain']);
  assert.deepEqual(
    MICRO_OS_TOOLS[0].function.parameters.properties.action.enum,
    ['inspect', 'search', 'context', 'artifact']
  );
  const properties = MICRO_OS_TOOLS[0].function.parameters.properties;
  assert.equal(properties.artifactId.type, 'string');
  assert.equal(properties.paths.type, 'array');
  assert.equal(properties.globs.type, 'array');
  assert.equal(properties.symbol.type, 'string');
  assert.equal(properties.startLine.type, 'number');
  assert.equal(properties.endLine.type, 'number');
  assert.match(MICRO_OS_TOOLS[0].function.description, /Batch independent files/);
  assert.equal(MICRO_OS_TOOLS[1].function.parameters.properties.command.type, 'string');
  assert.deepEqual(
    MICRO_OS_TOOLS[2].function.parameters.properties.action.enum,
    ['list', 'open', 'search', 'bind_auto']
  );
  assert.deepEqual(
    MICRO_OS_TOOLS[3].function.parameters.properties.action.enum,
    ['list', 'open', 'compose']
  );
});

test('executeMicroTool safely handles inspect, search_code, and os_context', async () => {
  const fakeCaps = {
    inspect: async (args) => `inspected: ${args.path}`,
    code: async (args) => ({ ok: true, data: `search result for ${args.query}` }),
    osContext: async () => ({ ok: true, data: '# Context Summary' }),
    plan: async () => ({ ok: true, data: [{ id: 'plan-1' }] }),
  };

  // 1. inspect with caps
  const inspectRes = await executeMicroTool('inspect', '{"path":"file.mjs"}', { caps: fakeCaps });
  assert.equal(inspectRes, 'inspected: file.mjs');

  // 2. search_code
  const searchRes = await executeMicroTool('search_code', '{"query":"hello"}', { caps: fakeCaps });
  assert.equal(searchRes, 'search result for hello');

  // 3. os_context brief
  const ctxRes = await executeMicroTool('os_context', '{}', { caps: fakeCaps });
  assert.equal(ctxRes, '# Context Summary');

  // 4. os_context plan_list
  const planRes = await executeMicroTool('os_context', '{"action":"plan_list"}', { caps: fakeCaps });
  assert.match(planRes, /plan-1/);

  // 5. unknown tool
  const unknownRes = await executeMicroTool('delete_file', '{}', { caps: fakeCaps });
  assert.match(unknownRes, /Unknown micro tool/);
});

test('executeMicroTool batches inspect paths, expands safe globs, and forwards search globs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-micro-tool-'));
  try {
    fs.writeFileSync(path.join(root, 'a.mjs'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(root, 'b.mjs'), 'export const b = 2;\n');
    const inspectCalls = [];
    const searchCalls = [];
    const caps = {
      inspect: async (args) => {
        inspectCalls.push(args);
        return `content of ${args.path}`;
      },
      code: async (args) => {
        searchCalls.push(args);
        return { ok: true, data: `search result for ${args.query}` };
      },
    };

    const batched = await executeMicroTool('os', {
      action: 'inspect',
      paths: ['a.mjs', 'b.mjs'],
    }, { caps, projectRoot: root });
    assert.match(batched, /### a\.mjs/);
    assert.match(batched, /### b\.mjs/);
    assert.deepEqual(inspectCalls.map((call) => call.path), ['a.mjs', 'b.mjs']);
    assert.ok(inspectCalls.every((call) => call.action === undefined));

    inspectCalls.length = 0;
    const globbed = await executeMicroTool('os', {
      action: 'inspect',
      globs: ['*.mjs'],
    }, { caps, projectRoot: root });
    assert.match(globbed, /### a\.mjs/);
    assert.match(globbed, /### b\.mjs/);

    await executeMicroTool('os', {
      action: 'search',
      query: 'retention',
      globs: ['packages/**/*.mjs'],
      maxResults: 5,
    }, { caps, projectRoot: root });
    assert.deepEqual(searchCalls.at(-1), {
      action: 'search',
      query: 'retention',
      globs: ['packages/**/*.mjs'],
      maxResults: 5,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('executeMicroTool routes read-only pipelines and blocks mutation or command bypasses', async () => {
  const calls = [];
  const dispatch = async (tool, input) => {
    calls.push({ tool, input });
    return '# ContextOS pipeline\nstatus=OK';
  };

  const readOnly = await executeMicroTool('os', {
    action: 'pipeline',
    args: { parallel: [{ inspect: { path: 'a.mjs' } }, { inspect: { path: 'b.mjs' } }] },
  }, { dispatch, projectRoot: '/tmp/micro-pipeline-fixture' });
  assert.match(readOnly, /status=OK/);
  assert.equal(calls[0].input.maxChars, undefined);
  assert.equal(calls[0].input.full, true);
  assert.deepEqual(calls[0].input.parallel[0], { inspect: { path: 'a.mjs' } });

  const analysisMutation = await executeMicroTool('os', {
    action: 'pipeline',
    args: { steps: [{ change: { edits: [{ path: 'a.mjs', target: 'x', replacement: 'y' }] } }] },
  }, { dispatch, projectRoot: '/tmp/micro-pipeline-fixture' });
  assert.match(analysisMutation, /Analysis tasks cannot run mutation steps/);
  assert.equal(calls.length, 1);

  const commandBypass = await executeMicroTool('os', {
    action: 'pipeline',
    args: { steps: [{ verify: { commands: ['npm test'] } }] },
  }, { dispatch, projectRoot: '/tmp/micro-pipeline-fixture', allowCommands: false });
  assert.match(commandBypass, /require invocation\.tools\.allowCommands:true/);
  assert.equal(calls.length, 1);

  const delegated = await executeMicroTool('os', {
    action: 'pipeline',
    args: { steps: [{ tool: 'agent', args: { task: 'x' } }] },
  }, { dispatch, projectRoot: '/tmp/micro-pipeline-fixture' });
  assert.match(delegated, /cannot delegate/);
  assert.equal(calls.length, 1);

  const implementMutation = await executeMicroTool('os', {
    action: 'pipeline',
    args: { steps: [{ change: { edits: [{ path: 'a.mjs', target: 'x', replacement: 'y' }] } }] },
  }, { dispatch, projectRoot: '/tmp/micro-pipeline-fixture', execution: 'implement', allowedPaths: ['a.mjs'], allowCommands: true });
  assert.match(implementMutation, /status=OK/);
  assert.equal(calls.length, 2);
});

test('executeMicroTool keeps multi-inspect pipeline evidence wider than the old summary clip', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-micro-pipeline-full-'));
  const calls = [];
  const tail = 'SECOND-INSPECTION-TAIL';
  const dispatch = async (tool, input) => {
    calls.push({ tool, input });
    return pipelinePipeline({
      projectRoot: root,
      orchestrator: {
        dispatch: async (_tool, actionInput) => {
          const second = actionInput.path === 'src/b.mjs';
          return `# ContextOS inspect\n\n[L1-L2]\n${'x'.repeat(3200)}${second ? `\n${tail}` : '\nFIRST-INSPECTION'}`;
        },
      },
    }, input);
  };

  try {
    const output = await executeMicroTool('os', {
      action: 'pipeline',
      args: { parallel: [
        { inspect: { path: 'src/a.mjs', ranges: [[1, 400]] } },
        { inspect: { path: 'src/b.mjs', ranges: [[1, 400]] } },
      ] },
    }, { dispatch, projectRoot: root });

    assert.equal(calls[0].input.maxChars, undefined);
    assert.equal(calls[0].input.full, true);

    assert.match(output, new RegExp(tail));
    assert.doesNotMatch(output, /response truncated/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runMicroTask counts successful pipeline tool calls with preload runs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-micro-pipeline-runs-'));
  const mock = createMockServer();
  const { url } = await mock.listen();
  let requestCount = 0;
  let pipelineCalls = 0;
  mock.setHandler((req, res) => {
    requestCount += 1;
    const message = requestCount === 1
      ? { tool_calls: [{ id: 'pipeline-1', type: 'function', function: { name: 'os', arguments: JSON.stringify({ action: 'pipeline', args: { parallel: [{ inspect: { path: 'a.mjs' } }] } }) } }] }
      : { content: 'pipeline complete' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }));
  });
  try {
    const result = await runMicroTask({ url, model: 'test-model' }, {
      prompt: 'run the bounded pipeline',
      projectRoot: root,
      withOS: true,
      preload: { ok: true, status: 'OK', summary: 'preloaded evidence', chars: 18, pipelineRuns: 1 },
      invocation: { tools: { enabled: true }, provider: { maxRequests: 2 } },
      orchestrator: {
        dispatch: async (tool) => {
          assert.equal(tool, 'pipeline');
          pipelineCalls += 1;
          return '# ContextOS pipeline\npipeline=OK';
        },
      },
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(pipelineCalls, 1);
    assert.equal(result.invocation.pipelineRuns, 2, 'preload and in-loop pipeline runs share the same invocation counter');
  } finally {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('executeMicroTool reads bounded artifact slices', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-micro-artifact-'));
  try {
    storeArtifact(root, 'line one\nline two\nline three', { id: 'art-read' });
    const result = await executeMicroTool('artifact', JSON.stringify({
      artifactId: 'art-read',
      startLine: 2,
      endLine: 3,
    }), { projectRoot: root });
    assert.match(result, /line two/);
    assert.match(result, /line three/);
    assert.doesNotMatch(result, /line one/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runMicroTask withOS=true executes tool call loop and returns final answer', async () => {
  const mock = createMockServer();
  const { url } = await mock.listen();

  try {
    let callIndex = 0;
    mock.setHandler((req, res, body) => {
      callIndex += 1;
      if (callIndex === 1) {
        // Step 1: Model requests a tool call to inspect math.mjs
        assert.ok(body.tools, 'Payload should include tools when withOS=true');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  reasoning_content: 'need to inspect math.mjs first',
                  tool_calls: [
                    {
                      id: 'call_inspect_1',
                      type: 'function',
                      function: {
                        name: 'inspect',
                        arguments: JSON.stringify({ path: 'src/math.mjs' }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 15, completion_tokens: 10 },
          })
        );
      } else {
        // Step 2: Model receives tool result and provides final answer
        const lastMsg = body.messages.at(-1);
        assert.equal(lastMsg.role, 'tool');
        assert.equal(lastMsg.tool_call_id, 'call_inspect_1');
        assert.match(lastMsg.content, /function add/);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'The function add takes two parameters and returns sum.',
                  reasoning_content: 'now I have the code',
                },
              },
            ],
            usage: { prompt_tokens: 25, completion_tokens: 15 },
          })
        );
      }
    });

    const config = { url, model: 'test-flash-model' };
    const fakeCaps = {
      inspect: async (args) => `export function add(a, b) { return a + b; }`,
    };

    const result = await runMicroTask(config, {
      prompt: 'What does add() do?',
      withOS: true,
      caps: fakeCaps,
      maxSteps: 3,
    });

    assert.equal(result.ok, true);
    assert.equal(result.withOS, true);
    assert.equal(result.steps, 1);
    assert.equal(result.content, 'The function add takes two parameters and returns sum.');
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'inspect');
    assert.equal(result.usage.prompt_tokens, 40); // 15 + 25
    assert.equal(result.usage.completion_tokens, 25); // 10 + 15
  } finally {
    await mock.close();
  }
});

test('runMicroTask withOS=false ignores caps and does not send tools payload', async () => {
  const mock = createMockServer();
  const { url } = await mock.listen();

  try {
    mock.setHandler((req, res, body) => {
      assert.equal(body.tools, undefined, 'Payload must not include tools when withOS is false');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'pure answer' } }],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        })
      );
    });

    const config = { url, model: 'test-model' };
    const result = await runMicroTask(config, {
      prompt: 'ping',
      withOS: false,
      caps: { inspect: async () => 'code' },
    });

    assert.equal(result.ok, true);
    assert.equal(result.withOS, false);
    assert.equal(result.content, 'pure answer');
  } finally {
    await mock.close();
  }
});

test('runMicroTask withOS=true caps explicit multi-step chains', async () => {
  const mock = createMockServer();
  const { url } = await mock.listen();

  try {
    let callCount = 0;
    mock.setHandler((req, res, body) => {
      callCount += 1;
      // Steps 1 to 4 request inspect tools
      if (callCount <= 4) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: `call_${callCount}`,
                      type: 'function',
                      function: {
                        name: 'inspect',
                        arguments: JSON.stringify({ path: `file_${callCount}.mjs` }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10 },
          })
        );
      } else {
        // Step 5: final synthesis without tool calls
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Capped probe chain completed.' } }],
            usage: { prompt_tokens: 20, completion_tokens: 15 },
          })
        );
      }
    });

    const config = { url, model: 'test-model' };
    const fakeCaps = {
      inspect: async (args) => `content of ${args.path}`,
    };

    const result = await runMicroTask(config, {
      prompt: 'Execute deep probe',
      withOS: true,
      maxSteps: 6,
      caps: fakeCaps,
    });

    assert.equal(result.ok, true);
    assert.equal(result.steps, 4, 'Micro safety cap should limit the chain to 4 steps');
    assert.equal(result.toolCalls.length, 4);
    assert.match(result.content, /Capped probe chain completed/);
  } finally {
    await mock.close();
  }
});

test('applyOutputBudget and executeMicroTool honor budget: full and custom maxChars', async () => {
  // 1. applyOutputBudget behavior
  const longText = 'x'.repeat(12000);

  // default limit (2500)
  const defaultBudget = applyOutputBudget(longText, {});
  assert.equal(defaultBudget.startsWith('x'.repeat(2500)), true);
  assert.match(defaultBudget, /\+9500 chars truncated/);

  // budget: 'full'
  const fullBudget = applyOutputBudget(longText, { budget: 'full' });
  assert.equal(fullBudget.length, 12000);
  assert.equal(fullBudget, longText);

  // maxChars custom and hard cap
  const customBudget = applyOutputBudget(longText, { maxChars: 500 });
  assert.equal(customBudget.startsWith('x'.repeat(500)), true);
  assert.match(customBudget, /\+11500 chars truncated/);
  const hardCap = applyOutputBudget(longText, { maxChars: 12000 });
  assert.equal(hardCap.startsWith('x'.repeat(4000)), true);
  assert.match(hardCap, /\+8000 chars truncated/);

  // 2. executeMicroTool with budget & maxChars
  const fakeCaps = {
    inspect: async () => 'a'.repeat(15000),
    code: async (args) => ({ ok: true, data: `search: ${args.query}`.repeat(1000) }),
    osContext: async () => ({ ok: true, data: '# Context '.repeat(1000) }),
  };

  const fullInspect = await executeMicroTool('inspect', { path: 'a.mjs', budget: 'full' }, { caps: fakeCaps });
  assert.equal(fullInspect.length, 15000);

  const customInspect = await executeMicroTool('inspect', { path: 'a.mjs', maxChars: 1200 }, { caps: fakeCaps });
  assert.equal(customInspect.startsWith('a'.repeat(1200)), true);
  assert.match(customInspect, /chars truncated/);

  const fullSearch = await executeMicroTool('search_code', { query: 'foo', budget: 'full' }, { caps: fakeCaps });
  assert.equal(fullSearch.includes('truncated'), false);

  const customCtx = await executeMicroTool('os_context', { maxChars: 300 }, { caps: fakeCaps });
  assert.match(customCtx, /\+.*chars truncated/);
});

test('runMicroTask has no default tool-round ceiling', async () => {
  const mock = createMockServer();
  const { url } = await mock.listen();
  try {
    let calls = 0;
    mock.setHandler((req, res, body) => {
      calls += 1;
      const toolCalls = calls <= 10
        ? [{ id: `call_${calls}`, type: 'function', function: { name: 'inspect', arguments: JSON.stringify({ path: `file_${calls}.mjs` }) } }]
        : undefined;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: toolCalls ? { role: 'assistant', content: null, tool_calls: toolCalls } : { role: 'assistant', content: 'finished after ten rounds' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }));
    });
    const result = await runMicroTask({ url, model: 'test-model' }, {
      prompt: 'complete after ten tool rounds',
      withOS: true,
      caps: { inspect: async (args) => `content of ${args.path}` },
    });
    assert.equal(result.ok, true);
    assert.equal(result.steps, 10);
    assert.equal(result.invocation.toolRounds, 10);
    assert.match(result.content, /finished after ten rounds/);
  } finally {
    await mock.close();
  }
});

test('runMicroTask withOS=true gracefully handles safety step limit convergence', async () => {
  const mock = createMockServer();
  const { url } = await mock.listen();

  try {
    let callCount = 0;
    mock.setHandler((req, res, body) => {
      callCount += 1;
      const isFinalCallWithoutTools = !body.tools;
      if (isFinalCallWithoutTools) {
        assert.equal(body.reasoning_effort, 'none');
        // Model was asked for final convergence without tools
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Final convergence summary after hitting limit.',
                },
              },
            ],
            usage: { prompt_tokens: 30, completion_tokens: 10 },
          })
        );
        return;
      }

      // Model keeps returning tool calls
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: `call_${callCount}`,
                    type: 'function',
                    function: {
                      name: 'inspect',
                      arguments: JSON.stringify({ path: `file_${callCount}.mjs` }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        })
      );
    });

    const config = { url, model: 'test-model' };
    const fakeCaps = {
      inspect: async (args) => `content of ${args.path}`,
    };

    const result = await runMicroTask(config, {
      prompt: 'Infinite probe test',
      withOS: true,
      caps: fakeCaps,
      maxSteps: 2,
    });

    assert.equal(result.ok, true);
    assert.equal(result.steps, 2);
    assert.match(result.content, /Final convergence summary after hitting limit/);
  } finally {
    await mock.close();
  }
});

test('micro os inspect normalizes natural range forms before dispatch', async () => {
  const calls = [];
  const dispatch = async (tool, input) => {
    calls.push({ tool, input });
    return 'ok';
  };
  await executeMicroTool('os', { action: 'inspect', args: { path: 'src/example.mjs', lines: '1-4' } }, { dispatch, projectRoot: '/tmp/micro-range-fixture' });
  await executeMicroTool('os', { action: 'inspect', args: { path: 'src/example.mjs', ranges: '2:3' } }, { dispatch, projectRoot: '/tmp/micro-range-fixture' });
  await executeMicroTool('os', { action: 'inspect', args: { path: 'src/example.mjs', ranges: [4, 6] } }, { dispatch, projectRoot: '/tmp/micro-range-fixture' });
  assert.deepEqual(calls, [
    { tool: 'inspect', input: { path: 'src/example.mjs', ranges: [[1, 4]] } },
    { tool: 'inspect', input: { path: 'src/example.mjs', ranges: [[2, 3]] } },
    { tool: 'inspect', input: { path: 'src/example.mjs', ranges: [[4, 6]] } },
  ]);
});
