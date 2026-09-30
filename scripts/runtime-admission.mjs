import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Pure classifier for MCP runtime server admission.
 *
 * @param {Object} options
 * @param {Object|string} [options.serverInfo]
 * @param {Array|Object} [options.tools]
 * @param {string} [options.expectedVersion]
 * @returns {{ ok: boolean, version: string|null, surface: string, toolNames: string[], errors: string[] }}
 */
export function classifyRuntime({
  serverInfo,
  tools,
  expectedVersion,
} = {}) {
  const errors = [];
  const surface = 'single';

  // Extract version
  const version = typeof serverInfo === 'string'
    ? serverInfo
    : (serverInfo && typeof serverInfo === 'object' && typeof serverInfo.version === 'string')
      ? serverInfo.version
      : null;

  if (!version) {
    errors.push('Missing or invalid server version');
  } else if (expectedVersion && version !== expectedVersion) {
    errors.push(`Version mismatch: expected '${expectedVersion}', got '${version}'`);
  }

  // Extract tool list
  let rawTools = [];
  if (Array.isArray(tools)) {
    rawTools = tools;
  } else if (tools && Array.isArray(tools.tools)) {
    rawTools = tools.tools;
  } else if (tools === undefined || tools === null) {
    errors.push('Missing tools list');
  } else {
    errors.push('Invalid tools format');
  }

  const toolNames = rawTools
    .map(t => (typeof t === 'string' ? t : t?.name))
    .filter(Boolean);

  if (rawTools.length !== 1 || toolNames.length !== 1 || toolNames[0] !== 'contextos') {
    if (rawTools.length !== toolNames.length) {
      errors.push('Surface contains malformed or nameless tools');
    } else {
      errors.push(`Surface requires exactly the 'contextos' tool, but got: [${toolNames.join(', ')}]`);
    }
  } else {
    const toolObj = rawTools[0];
    const schema = toolObj?.inputSchema || toolObj?.schema;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      errors.push("Tool 'contextos' is missing inputSchema");
    } else if (schema.type !== 'object') {
      errors.push("Tool 'contextos' schema type must be object");
    } else {
      const props = schema.properties;
      if (!props || typeof props !== 'object') {
        errors.push("Tool 'contextos' schema missing properties");
      } else {
        const requiredProps = ['action', 'args', 'projectRoot'];
        const missing = requiredProps.filter(p => !(p in props));
        if (missing.length > 0) {
          errors.push(`Tool 'contextos' schema missing required properties: ${missing.join(', ')}`);
        }
        for (const [name, type] of Object.entries({action:'string', args:'object', projectRoot:'string'})) {
          if (props[name] && props[name].type !== type) errors.push(`Tool 'contextos' property ${name} must be ${type}`);
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    version,
    surface,
    toolNames,
    errors
  };
}

/**
 * Probe a runtime executable by spawning a fresh process and connecting via MCP SDK.
 *
 * @param {Object} options
 * @param {string} options.command
 * @param {string[]} [options.args=[]]
 * @param {Object} [options.env={}]
 * @param {string} [options.expectedVersion]
 * @param {number} [options.timeoutMs=2000]
 * @returns {Promise<{ ok: boolean, version: string|null, surface: string, toolNames: string[], errors: string[] }>}
 */
export async function probeRuntime({
  command,
  args = [],
  env = {},
  expectedVersion,
  timeoutMs = 2000
} = {}) {
  if (!command || typeof command !== 'string') {
    return {
      ok: false,
      version: null,
      surface: 'single',
      toolNames: [],
      errors: ['Command is required and must be a string']
    };
  }

  let client = null;
  let transport = null;
  let timeoutId = null;

  // Sanitize any error messages against env credentials
  const sanitize = (val) => {
    if (val === null || val === undefined) return '';
    let text = typeof val === 'string' ? val : (val.message || String(val));
    if (env && typeof env === 'object') {
      for (const [, v] of Object.entries(env)) {
        if (typeof v === 'string' && v.length > 0) {
          text = text.split(v).join('[REDACTED]');
        }
      }
    }
    text = text.replace(/(key|token|secret|password|auth)=([^\s&]+)/gi, '$1=[REDACTED]');
    if (text.length > 500) {
      text = text.slice(0, 500) + '... (truncated)';
    }
    return text;
  };

  const cleanup = async (isSuccess = false) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    const pid = transport?.pid;
    if (!isSuccess && pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    let cleanupTimer;
    await Promise.race([
      (async () => {
        try { await client?.close(); } catch {}
        try { await transport?.close(); } catch {}
      })(),
      new Promise(resolve => { cleanupTimer = setTimeout(resolve, 300); })
    ]);
    clearTimeout(cleanupTimer);
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  };

  try {
    client = new Client(
      { name: 'runtime-admission-probe', version: '1.0.0' },
      { capabilities: {} }
    );

    const childEnv = { ...process.env, ...env };
    transport = new StdioClientTransport({
      command,
      args,
      env: childEnv,
      stderr: 'pipe'
    });
    transport.stderr?.on('data', () => {});

    transport.onerror = () => {};

    const probePromise = (async () => {
      await client.connect(transport);
      const serverInfo = client.getServerVersion();
      const toolsResult = await client.listTools();
      return { serverInfo, tools: toolsResult?.tools ?? [] };
    })();

    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Probe timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    const { serverInfo, tools } = await Promise.race([probePromise, timeoutPromise]);

    await cleanup(true);

    return classifyRuntime({
      serverInfo,
      tools,
      expectedVersion,
    });
  } catch (err) {
    await cleanup(false);
    return {
      ok: false,
      version: null,
      surface: 'single',
      toolNames: [],
      errors: [sanitize(err)]
    };
  }
}
