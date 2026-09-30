import { createHash, randomUUID } from 'node:crypto';

const KNOWN_THINKING_EFFORTS = new Set(['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const CHAT_FINISH_REASONS = new Set(['stop', 'length', 'tool_calls', 'function_call', 'content_filter']);
const RESPONSES_STATUSES = new Set(['completed', 'incomplete', 'failed', 'cancelled', 'queued', 'in_progress']);
const RESPONSES_INCOMPLETE_REASONS = new Set(['max_output_tokens', 'content_filter']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
}

function normalizeTransport(config = {}) {
  const requested = String(config.transport || config.protocol || '').trim().toLowerCase();
  if (['responses', 'response'].includes(requested)) return 'responses';
  if (['chat', 'chat-completions', 'chat_completions', 'chatcompletion', 'chat-completion'].includes(requested)) return 'chat';

  const baseUrl = config.baseUrl || config.url;
  if (typeof baseUrl === 'string' && /\/responses\/?$/i.test(baseUrl)) return 'responses';
  return 'chat';
}

function endpointFor(config, transport) {
  const base = config.baseUrl || config.url;
  if (typeof base !== 'string' || !base.trim()) throw new Error('API Micro baseUrl/url is required.');
  const url = new URL(base.trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API Micro URL must use http or https.');
  const route = transport === 'responses' ? '/responses' : '/chat/completions';
  const path = url.pathname.replace(/\/+$/, '');
  const existingRoute = path.match(/\/(?:responses|chat\/completions)$/i)?.[0];
  if (existingRoute && existingRoute.toLowerCase() !== route) {
    throw new Error(`API Micro transport '${transport}' conflicts with the configured endpoint path.`);
  }
  if (!existingRoute) url.pathname = `${path}${route}`;
  return url;
}

function isOpenCodeGoEndpoint(url) {
  return url?.hostname?.toLowerCase() === 'opencode.ai'
    && /^\/zen\/go\/v1(?:\/|$)/i.test(url.pathname);
}

function mergeHeaders(...sources) {
  const merged = new Map();
  for (const source of sources) {
    if (!isRecord(source)) continue;
    for (const [name, value] of Object.entries(source)) {
      const normalized = name.toLowerCase();
      merged.delete(normalized);
      merged.set(normalized, [name, value]);
    }
  }
  return Object.fromEntries(merged.values());
}

function providerName(config = {}) {
  const explicit = String(config.provider || config.vendor || '').trim().toLowerCase();
  if (explicit && !['api', 'cli', 'micro'].includes(explicit)) return explicit;
  return /^deepseek-/i.test(String(config.model || '')) ? 'deepseek' : explicit;
}

function normalizeEffort(value) {
  if (value === undefined || value === null || value === '') return null;
  if (isRecord(value)) value = value.effort ?? value.level ?? value.mode;
  const effort = String(value).trim().toLowerCase();
  if (!KNOWN_THINKING_EFFORTS.has(effort)) {
    throw new Error(`Unsupported API Micro thinking value '${effort}'.`);
  }
  return effort === 'off' ? 'off' : effort;
}

function mapDeepSeekEffort(effort) {
  if (effort === 'off' || effort === 'none') return 'none';
  if (effort === 'minimal' || effort === 'low') return 'low';
  if (effort === 'medium' || effort === 'high' || effort === 'xhigh') return 'high';
  if (effort === 'max' || effort === 'ultra') return 'max';
  return null;
}

function applyThinking(config, transport, body, requestedValue) {
  const requested = normalizeEffort(requestedValue ?? config.thinking);
  if (requested === null) return {
    requested: null,
    mapped: null,
    effective: null,
    transmitted: false,
    status: 'unspecified',
  };

  const provider = providerName(config);
  if (provider === 'deepseek') {
    const mapped = mapDeepSeekEffort(requested);
    if (!mapped) throw new Error(`DeepSeek does not support the requested thinking effort '${requested}'.`);
    if (transport === 'responses') {
      body.reasoning = { effort: mapped };
    } else if (mapped === 'none') {
      body.thinking = { type: 'disabled' };
    } else {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = mapped;
    }
    return {
      requested,
      mapped,
      effective: null,
      transmitted: true,
      status: 'provider-mapped-unconfirmed',
      provider,
      protocol: transport,
    };
  }

  const configuredMapping = config.thinkingMap?.[transport];
  if (isRecord(configuredMapping) && Object.hasOwn(configuredMapping, requested)) {
    const mapped = configuredMapping[requested];
    if (mapped === null || mapped === false) {
      return {
        requested,
        mapped: null,
        effective: null,
        transmitted: false,
        status: 'configured-unavailable',
        provider: provider || null,
        protocol: transport,
      };
    }
    if (transport === 'responses') body.reasoning = { effort: mapped };
    else body.reasoning_effort = mapped;
    return {
      requested,
      mapped,
      effective: null,
      transmitted: true,
      status: 'configured-unverified',
      provider: provider || null,
      protocol: transport,
    };
  }

  if (requested === 'off' || requested === 'none') {
    return {
      requested,
      mapped: null,
      effective: null,
      transmitted: false,
      status: 'unknown-off-mapping',
      provider: provider || null,
      protocol: transport,
    };
  }

  const mapped = requested === 'ultra' ? 'max' : requested;
  if (transport === 'responses') body.reasoning = { effort: mapped };
  else body.reasoning_effort = mapped;
  return {
    requested,
    mapped,
    effective: null,
    transmitted: true,
    status: 'direct-unverified',
    provider: provider || null,
    protocol: transport,
  };
}

function wireTools(tools, transport) {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => {
    if (!isRecord(tool)) return tool;
    const fn = isRecord(tool.function) ? tool.function : tool;
    if (transport === 'responses') {
      const responseTool = {
        type: 'function',
        name: fn.name,
        parameters: clone(fn.parameters ?? { type: 'object', properties: {} }),
      };
      if (fn.description !== undefined) responseTool.description = fn.description;
      if (fn.strict !== undefined) responseTool.strict = fn.strict;
      return responseTool;
    }
    if (tool.type === 'function' && isRecord(tool.function)) return clone(tool);
    return {
      type: 'function',
      function: {
        name: fn.name,
        parameters: clone(fn.parameters ?? { type: 'object', properties: {} }),
        ...(fn.description !== undefined ? { description: fn.description } : {}),
        ...(fn.strict !== undefined ? { strict: fn.strict } : {}),
      },
    };
  });
}

function responseStateItems(state) {
  if (Array.isArray(state)) return clone(state);
  if (!isRecord(state)) return [];
  if (Array.isArray(state.items)) return clone(state.items);
  if (Array.isArray(state.outputItems)) return clone(state.outputItems);
  return [];
}

function chatStateMessages(state) {
  if (Array.isArray(state)) return clone(state);
  if (!isRecord(state)) return [];
  return Array.isArray(state.messages) ? clone(state.messages) : [];
}

/** @typedef {{ toolCallId: string, name: string, result: unknown }} BrokerToolResult */

function assertStateProtocol(state, expected) {
  if (isRecord(state) && state.transport && state.transport !== expected) {
    throw new Error(`Cannot continue ${expected} transport from ${state.transport} state.`);
  }
}

function addCall(calls, id, name, protocol) {
  if (typeof id !== 'string' || !id.trim()) throw new Error(`${protocol} assistant tool call is missing its call ID.`);
  if (calls.has(id)) throw new Error(`${protocol} assistant state repeats tool call ID '${id}'.`);
  if (typeof name !== 'string' || !name.trim()) throw new Error(`${protocol} tool call '${id}' is missing its function name.`);
  calls.set(id, name);
}

function addResult(results, calls, id, protocol) {
  if (typeof id !== 'string' || !id.trim()) throw new Error(`${protocol} tool result is missing its call ID.`);
  if (results.has(id)) throw new Error(`${protocol} state repeats tool result ID '${id}'.`);
  if (!calls.has(id)) throw new Error(`${protocol} state contains tool result '${id}' without a matching assistant call.`);
  results.add(id);
}

function unresolvedChatCalls(messages) {
  const calls = new Map();
  const results = new Set();
  for (const message of messages) {
    if (message?.role === 'assistant' && Object.hasOwn(message, 'tool_calls')) {
      if (!Array.isArray(message.tool_calls)) throw new Error('Chat assistant state has malformed tool_calls.');
      for (const toolCall of message.tool_calls) {
        addCall(calls, toolCall?.id, toolCall?.function?.name, 'Chat');
      }
    }
    if (message?.role === 'tool') addResult(results, calls, message.tool_call_id, 'Chat');
  }
  return new Map([...calls].filter(([id]) => !results.has(id)));
}

function unresolvedResponsesCalls(items) {
  const calls = new Map();
  const results = new Set();
  for (const item of items) {
    if (item?.type === 'function_call') addCall(calls, item.call_id, item.name, 'Responses');
    if (item?.type === 'function_call_output') addResult(results, calls, item.call_id, 'Responses');
  }
  return new Map([...calls].filter(([id]) => !results.has(id)));
}

/**
 * Validate the broker's one canonical tool-result shape before constructing
 * protocol-specific messages. The broker sends every outstanding call once.
 * @param {BrokerToolResult[]|undefined} toolResults
 * @param {Map<string, string>} outstanding
 * @returns {Array<{callId: string, output: string}>}
 */
function validateBrokerToolResults(toolResults, outstanding, protocol) {
  const values = toolResults ?? [];
  if (!Array.isArray(values)) throw new Error('Broker toolResults must be an array of {toolCallId,name,result}.');
  const seen = new Set();
  const normalized = [];
  for (const result of values) {
    if (!isRecord(result) || typeof result.toolCallId !== 'string' || !result.toolCallId.trim()) {
      throw new Error('Broker tool result is missing toolCallId; expected {toolCallId,name,result}.');
    }
    const id = result.toolCallId;
    if (seen.has(id)) throw new Error(`Broker toolResults repeat toolCallId '${id}'.`);
    if (!outstanding.has(id)) throw new Error(`Broker toolResult '${id}' does not match an unresolved ${protocol} assistant call.`);
    if (typeof result.name !== 'string' || result.name !== outstanding.get(id)) {
      throw new Error(`Broker toolResult '${id}' does not match the assistant function name in ${protocol} state.`);
    }
    if (!Object.hasOwn(result, 'result')) throw new Error(`Broker toolResult '${id}' is missing its result payload.`);
    seen.add(id);
    normalized.push({ callId: id, output: stringifyToolOutput(result.result) });
  }
  if (seen.size !== outstanding.size) {
    const missing = [...outstanding.keys()].filter((id) => !seen.has(id));
    throw new Error(`Broker toolResults are missing outstanding ${protocol} calls: ${missing.join(', ')}.`);
  }
  return normalized;
}

function asResponseMessage(input) {
  if (Array.isArray(input)) return input.map((item) => clone(item));
  if (isRecord(input) && typeof input.type === 'string') return [clone(input)];
  return [{ role: 'user', content: input == null ? '' : clone(input) }];
}

function asChatMessage(input) {
  if (isRecord(input) && typeof input.role === 'string') return clone(input);
  return { role: 'user', content: input == null ? '' : clone(input) };
}

function outputText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === 'string') return part;
      if (!isRecord(part)) return '';
      return part.text ?? part.output_text ?? '';
    }).filter(Boolean).join('\n');
  }
  return '';
}

function stringifyToolOutput(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function responseToolResults(toolResults) {
  return toolResults.map((result) => ({
    type: 'function_call_output',
    call_id: result.callId,
    output: result.output,
  }));
}

function chatToolResults(toolResults) {
  return toolResults.map((result) => ({
    role: 'tool',
    tool_call_id: result.callId,
    content: result.output,
  }));
}

function parseArguments(value) {
  if (isRecord(value)) return { args: clone(value), status: 'object', bytes: null, sha256: null };
  if (typeof value !== 'string') return {
    args: {}, status: value === undefined ? 'missing' : 'non_string', bytes: null, sha256: null,
  };
  const bytes = Buffer.byteLength(value, 'utf8');
  const sha256 = createHash('sha256').update(value, 'utf8').digest('hex');
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed)
      ? { args: parsed, status: 'json_object', bytes, sha256 }
      : { args: { value: parsed }, status: 'json_non_object', bytes, sha256 };
  } catch (_) { return { args: null, status: 'invalid_json', bytes, sha256 }; }
}

function normalizeCalls(items, transport) {
  const list = transport === 'responses'
    ? (Array.isArray(items) ? items.filter((item) => item?.type === 'function_call') : [])
    : (Array.isArray(items) ? items : []);
  if (transport === 'responses') return list.map((item) => {
    const parsed = parseArguments(item.arguments);
    return {
      id: item.call_id || null,
      name: item.name || null,
      args: parsed.args,
      argsParseStatus: parsed.status,
      ...(parsed.bytes !== null ? { argumentsBytes: parsed.bytes, argumentsSha256: parsed.sha256 } : {}),
    };
  });
  return list.filter((item) => item?.type === 'function' || item?.function).map((item) => {
    const argsText = item.function?.arguments ?? item.arguments;
    const parsed = parseArguments(argsText);
    return {
      id: item.id || item.call_id || null,
      name: item.function?.name || item.name || null,
      args: parsed.args,
      argsParseStatus: parsed.status,
      ...(parsed.bytes !== null ? { argumentsBytes: parsed.bytes, argumentsSha256: parsed.sha256 } : {}),
    };
  });
}

function enumMetadata(value, allowed) {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && allowed.has(value) ? value : 'unknown';
}

function completionMetadata(data, transport) {
  if (transport === 'chat') {
    return { protocol: 'chat', finishReason: enumMetadata(data?.choices?.[0]?.finish_reason, CHAT_FINISH_REASONS) };
  }
  return {
    protocol: 'responses',
    status: enumMetadata(data?.status, RESPONSES_STATUSES),
    incompleteReason: enumMetadata(data?.incomplete_details?.reason, RESPONSES_INCOMPLETE_REASONS),
  };
}

function responseMessageText(output = []) {
  return output.filter((item) => item?.type === 'message')
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .filter((part) => part?.type === 'output_text' || part?.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join('\n')
    .trim();
}

function parseSelection(text, directValue = null) {
  if (Array.isArray(directValue)) return { selection: clone(directValue), summary: String(text || '').trim() || null, missing: null };
  let parsed = isRecord(directValue) ? directValue : null;
  const source = String(text || '').trim();
  if (!parsed && source) {
    const candidate = source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    try {
      const value = JSON.parse(candidate);
      if (Array.isArray(value)) parsed = { selection: value };
      else if (isRecord(value)) parsed = value;
    } catch (_) {}
  }
  if (!parsed) return {
    selection: null,
    summary: source || null,
    missing: null,
  };
  return {
    selection: parsed.selection ?? parsed.references ?? parsed,
    summary: typeof parsed.summary === 'string'
      ? parsed.summary
      : (typeof parsed.answer === 'string' ? parsed.answer : (source || null)),
    missing: Array.isArray(parsed.missing) ? clone(parsed.missing) : null,
  };
}

function safeCount(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const count = Number(value.trim());
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

export function normalizeApiUsage(usage) {
  if (!isRecord(usage)) return { input: null, cached: null, output: null, reasoning: null, total: null };
  const input = safeCount(usage.input_tokens ?? usage.prompt_tokens);
  const cacheFields = [
    usage.input_tokens_details?.cached_tokens,
    usage.prompt_tokens_details?.cached_tokens,
    usage.input_cache_tokens,
    usage.prompt_cache_hit_tokens,
  ].filter((value) => value !== undefined && value !== null);
  const cacheCounts = cacheFields.map(safeCount);
  const cacheCountsAgree = cacheCounts.every((value) => value !== null)
    && new Set(cacheCounts).size <= 1;
  let cached = cacheCountsAgree && cacheCounts.length ? cacheCounts[0] : null;
  const hasCacheMiss = usage.prompt_cache_miss_tokens !== undefined && usage.prompt_cache_miss_tokens !== null;
  const cacheMiss = hasCacheMiss ? safeCount(usage.prompt_cache_miss_tokens) : null;
  if (hasCacheMiss && (cacheMiss === null || (input !== null && cached !== null && input !== cached + cacheMiss))) cached = null;
  if (input !== null && cached !== null && cached > input) cached = null;
  const output = safeCount(usage.output_tokens ?? usage.completion_tokens);
  const reasoning = safeCount(
    usage.output_tokens_details?.reasoning_tokens
      ?? usage.completion_tokens_details?.reasoning_tokens
      ?? usage.reasoning_tokens,
  );
  const total = safeCount(usage.total_tokens);
  return { input, cached, output, reasoning, total };
}

function redactError(value, secret) {
  const message = String(value || 'API Micro request failed.');
  return secret ? message.split(secret).join('[redacted]') : message;
}

function responseErrorMessage(data, fallback) {
  if (isRecord(data?.error)) return data.error.message || data.error.code || fallback;
  if (typeof data?.error === 'string') return data.error;
  return data?.message || fallback;
}

function requestedModel(config) {
  return config.model || null;
}

function buildResponsesRequest(config, request) {
  assertStateProtocol(request.state, 'responses');
  const state = responseStateItems(request.state);
  const brokerResults = validateBrokerToolResults(request.toolResults, unresolvedResponsesCalls(state), 'Responses');
  const results = responseToolResults(brokerResults);
  const input = [...state];
  if (!results.length) input.push(...asResponseMessage(request.input));
  input.push(...results);
  const wireInput = [...input];
  if (typeof request.turnControl === 'string' && request.turnControl) {
    wireInput.push({ role: 'user', content: request.turnControl });
  }
  const body = {
    model: requestedModel(config),
    input: wireInput,
    store: false,
  };
  if (typeof request.system === 'string' && request.system) body.instructions = request.system;
  const tools = wireTools(request.tools, 'responses');
  if (tools.length) body.tools = tools;
  const maxOutput = config.maxOutputTokens ?? config.maxTokens;
  if (Number.isSafeInteger(Number(maxOutput)) && Number(maxOutput) > 0) body.max_output_tokens = Math.floor(Number(maxOutput));
  const thinking = applyThinking(config, 'responses', body, request.thinking);
  if (typeof config.temperature === 'number'
    && !(thinking.provider === 'deepseek' && thinking.mapped !== 'none')) body.temperature = config.temperature;
  return { body, thinking, nextInput: input };
}

function buildChatRequest(config, request) {
  assertStateProtocol(request.state, 'chat');
  const prior = chatStateMessages(request.state).filter((message) => message?.role !== 'system');
  const brokerResults = validateBrokerToolResults(request.toolResults, unresolvedChatCalls(prior), 'Chat');
  const results = chatToolResults(brokerResults);
  const messages = [];
  if (typeof request.system === 'string' && request.system) messages.push({ role: 'system', content: request.system });
  messages.push(...prior);
  if (!results.length) messages.push(asChatMessage(request.input));
  messages.push(...results);
  const wireMessages = [...messages];
  if (typeof request.turnControl === 'string' && request.turnControl) {
    wireMessages.push({ role: 'user', content: request.turnControl });
  }
  const body = { model: requestedModel(config), messages: wireMessages };
  const tools = wireTools(request.tools, 'chat');
  if (tools.length) body.tools = tools;
  const maxOutput = config.maxOutputTokens ?? config.maxTokens;
  if (Number.isSafeInteger(Number(maxOutput)) && Number(maxOutput) > 0) body.max_tokens = Math.floor(Number(maxOutput));
  const thinking = applyThinking(config, 'chat', body, request.thinking);
  if (typeof config.temperature === 'number'
    && !(thinking.provider === 'deepseek' && thinking.mapped !== 'none')) body.temperature = config.temperature;
  return { body, thinking, nextMessages: messages.filter((message) => message?.role !== 'system') };
}

function withProviderThinking(requested, data) {
  const echo = data?.reasoning?.effort ?? data?.reasoning_effort;
  const observed = typeof echo === 'string' && echo.trim() ? echo.trim() : null;
  if (!requested) return requested;
  if (requested.status === 'unspecified') return { ...requested, observed: null };
  return {
    ...requested,
    observed,
    effective: observed,
    ...(observed !== null ? { status: 'effective-confirmed' } : {}),
  };
}

/**
 * Create a single-request API adapter for the API Micro evidence broker.
 * It deliberately does not execute tools or retry with another provider.
 */
export function createEvidenceTransport(config = {}, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');
  const transport = normalizeTransport(config);
  let endpoint = null;
  let endpointError = null;
  try { endpoint = endpointFor(config, transport); }
  catch (error) { endpointError = error; }
  const key = config.apiKey || config.key || (config.keyEnv ? process.env[config.keyEnv] : null) || null;
  const timeoutMs = Number.isSafeInteger(Number(config.timeoutMs)) && Number(config.timeoutMs) > 0
    ? Number(config.timeoutMs)
    : null;
  // OpenCode Go uses this as its routing/cache conversation key. The
  // transport instance is scoped to one API task by request-service, so one
  // generated value remains stable across all explicit tool continuations.
  const openCodeSessionId = isOpenCodeGoEndpoint(endpoint) ? randomUUID() : null;

  const resultBase = (state, providerLaunches) => ({
    model: null,
    requestedModel: requestedModel(config),
    usage: { input: null, cached: null, output: null, reasoning: null, total: null },
    invocation: { providerLaunches },
    calls: [],
    selection: null,
    summary: null,
    missing: null,
    state: state ?? null,
  });

  return async function requestEvidence({ system, input, tools, turnControl, state, toolResults, thinking, signal, headers: requestHeaders } = {}) {
    if (endpointError) {
      return {
        ...resultBase(state, 0),
        ok: false,
        status: null,
        errorCode: 'INVALID_CONFIGURATION',
        error: redactError(endpointError.message, key),
        thinking: { requested: null, mapped: null, effective: null, transmitted: false, status: 'not-evaluated' },
      };
    }

    const request = { system, input, tools, turnControl, state, toolResults, thinking };
    let built;
    try {
      built = transport === 'responses'
        ? buildResponsesRequest(config, request)
        : buildChatRequest(config, request);
    } catch (error) {
      return {
        ...resultBase(state, 0),
        ok: false,
        status: null,
        errorCode: 'INVALID_REQUEST',
        error: redactError(error?.message, key),
        thinking: { requested: null, mapped: null, effective: null, transmitted: false, status: 'not-evaluated' },
      };
    }
    const common = { ...resultBase(state, 0), thinking: built.thinking };
    if (built.thinking.status === 'unknown-off-mapping' || built.thinking.status === 'configured-unavailable') {
      return {
        ...common,
        ok: false,
        status: null,
        errorCode: 'THINKING_MAPPING_UNKNOWN',
        error: `The requested thinking setting '${built.thinking.requested}' has no verified ${transport} mapping for this provider.`,
      };
    }

    if (signal?.aborted) {
      return {
        ...common,
        ok: false,
        status: null,
        errorCode: 'ABORTED',
        error: 'API Micro request was aborted before provider launch.',
      };
    }

    const headers = mergeHeaders(
      { 'content-type': 'application/json' },
      key ? { authorization: `Bearer ${key}` } : null,
      openCodeSessionId ? { 'x-opencode-session': openCodeSessionId } : null,
      config.headers,
      requestHeaders,
    );
    let requestBody;
    try { requestBody = JSON.stringify(built.body); }
    catch (error) {
      return {
        ...common,
        ok: false,
        status: null,
        errorCode: 'INVALID_REQUEST',
        error: redactError(error?.message, key),
      };
    }
    const controller = new AbortController();
    let timedOut = false;
    let timeoutHandle;
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = timeoutMs === null ? null : new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('API Micro request timed out.'));
        const error = new Error(`API Micro request timed out after ${timeoutMs} ms.`);
        error.name = 'TimeoutError';
        reject(error);
      }, timeoutMs);
    });
    let response;
    let data;
    try {
      const fetchPromise = Promise.resolve().then(() => fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: requestBody,
        signal: controller.signal,
      }));
      response = timeout ? await Promise.race([fetchPromise, timeout]) : await fetchPromise;
      const raw = timeout ? await Promise.race([response.text(), timeout]) : await response.text();
      try { data = raw ? JSON.parse(raw) : {}; }
      catch (_) {
        return {
          ...common,
          ok: false,
          invocation: { providerLaunches: 1 },
          status: response.status ?? null,
          errorCode: 'INVALID_RESPONSE_JSON',
          error: redactError(`API Micro returned non-JSON content (HTTP ${response.status ?? 'unknown'}).`, key),
        };
      }
    } catch (error) {
      return {
        ...common,
        ok: false,
        invocation: { providerLaunches: 1 },
        status: null,
        errorCode: timedOut ? 'REQUEST_TIMEOUT' : (signal?.aborted || error?.name === 'AbortError' ? 'ABORTED' : 'NETWORK_ERROR'),
        error: redactError(error?.message, key),
      };
    } finally {
      clearTimeout(timeoutHandle);
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', abortFromCaller);
    }

    const usage = normalizeApiUsage(data?.usage);
    const model = typeof data?.model === 'string' ? data.model : null;
    const responseThinking = withProviderThinking(built.thinking, data);
    const status = Number(response?.status) || null;
    if (!response?.ok) {
      return {
        ...common,
        ok: false,
        invocation: { providerLaunches: 1 },
        status,
        model,
        usage,
        completion: completionMetadata(data, transport),
        thinking: responseThinking,
        errorCode: typeof data?.error?.code === 'string' ? data.error.code : 'API_ERROR',
        error: redactError(responseErrorMessage(data, `API Micro request failed${status ? ` (HTTP ${status})` : ''}.`), key),
      };
    }

    if (transport === 'responses') {
      const output = Array.isArray(data?.output) ? clone(data.output) : [];
      const text = typeof data?.output_text === 'string' ? data.output_text : responseMessageText(output);
      const selected = parseSelection(text, data?.selection);
      return {
        ...common,
        ok: true,
        invocation: { providerLaunches: 1 },
        status,
        model,
        usage,
        completion: completionMetadata(data, 'responses'),
        thinking: responseThinking,
        calls: normalizeCalls(output, 'responses'),
        ...selected,
        state: { transport: 'responses', items: [...built.nextInput, ...output] },
      };
    }

    const choice = data?.choices?.[0];
    const message = isRecord(choice?.message) ? clone(choice.message) : {};
    const text = outputText(message.content);
    const selected = parseSelection(text, message.selection ?? data?.selection);
    const nextMessages = [...built.nextMessages, message];
    return {
      ...common,
      ok: true,
      invocation: { providerLaunches: 1 },
      status,
      model,
      usage,
      completion: completionMetadata(data, 'chat'),
      thinking: responseThinking,
      calls: normalizeCalls(message.tool_calls, 'chat'),
      ...selected,
      state: { transport: 'chat', messages: nextMessages },
    };
  };
}
