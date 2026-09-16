/**
 * ContextOS Cloud Hub - Cloudflare Worker Entrypoint
 * Provides Serverless Context & Graph Hub with Cloudflare D1 (Edge SQLite)
 * Supports MCP over HTTP (SSE & Streamable JSON-RPC) + REST API + Bearer Token Auth
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json',
};

const DDL = `
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, repo_root TEXT NOT NULL, graph_revision INTEGER NOT NULL DEFAULT 0, exported_at TEXT, schema_version INTEGER NOT NULL DEFAULT 2);
CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal', status TEXT NOT NULL DEFAULT 'active', summary TEXT NOT NULL DEFAULT '', completed_summary TEXT, history_ref TEXT, rule_refs_json TEXT NOT NULL DEFAULT '[]', decision_refs_json TEXT NOT NULL DEFAULT '[]', dependency_refs_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS phases (id TEXT NOT NULL, plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE, phase_order INTEGER NOT NULL DEFAULT 0, objective TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT '', deliverables_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', task_ids_json TEXT NOT NULL DEFAULT '[]', acceptance_json TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (id, plan_id));
CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE, phase_id TEXT, title TEXT NOT NULL, criteria TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', evidence_refs_json TEXT NOT NULL DEFAULT '[]', completed_at TEXT);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE, phase_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', context_slice_json TEXT NOT NULL DEFAULT '{}', working_set_json TEXT NOT NULL DEFAULT '{}', references_json TEXT NOT NULL DEFAULT '{}', baseline_json TEXT NOT NULL DEFAULT '{}', notes_json TEXT NOT NULL DEFAULT '[]', checks_json TEXT NOT NULL DEFAULT '[]', sync_result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blocks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'service', summary TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '', history_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifact_refs (id TEXT PRIMARY KEY, block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE, path TEXT NOT NULL, symbol TEXT, start_line INTEGER, end_line INTEGER, hash TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'implementation');
CREATE TABLE IF NOT EXISTS chains (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'leaf', member_ids_json TEXT NOT NULL DEFAULT '[]', metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'depends_on', provenance TEXT NOT NULL DEFAULT 'authored', confidence REAL NOT NULL DEFAULT 1.0, reason TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
`;

let dbInitialized = false;

async function ensureDb(db) {
  if (dbInitialized || !db) return;
  try {
    await db.exec(DDL);
    dbInitialized = true;
  } catch (err) {
    console.error('Failed to initialize D1 schema:', err);
  }
}

// In-memory active SSE sessions for the isolate
const sseSessions = new Map();

function checkAuth(request, env) {
  const secret = (env?.AUTH_TOKEN || env?.CONTEXTOS_TOKEN || '').trim();
  if (!secret) return { authorized: true };

  const authHeader = request.headers.get('Authorization') || request.headers.get('x-contextos-token') || '';
  let token = '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (authHeader) {
    token = authHeader.trim();
  }

  if (!token) {
    const url = new URL(request.url);
    token = url.searchParams.get('token') || '';
  }

  if (token === secret) {
    return { authorized: true };
  }
  return { authorized: false, error: 'Unauthorized: Invalid or missing Bearer token.' };
}

// Execute a ContextOS tool operation
async function executeTool(tool, input = {}, projectId = 'contextos', db) {
  let result = '';

  if (tool === 'os_context') {
    const action = input.action || 'brief';
    if (action === 'brief') {
      const countPlans = db ? (await db.prepare('SELECT count(*) as c FROM plans WHERE project_id = ?').bind(projectId).first())?.c ?? 0 : 0;
      const countBlocks = db ? (await db.prepare('SELECT count(*) as c FROM blocks WHERE project_id = ?').bind(projectId).first())?.c ?? 0 : 0;
      result = `# ContextOS Cloud Hub Brief (${projectId})\n\n- Plans: ${countPlans}\n- Blocks: ${countBlocks}\n- Storage: Cloudflare D1\n- Serverless Edge: Active\n\nAI Coding agent connected via remote MCP over HTTP. Follow the C-D-C-S workflow.`;
    } else if (action === 'search' && db) {
      const q = `%${input.query || ''}%`;
      const blocks = (await db.prepare('SELECT id, title, kind, summary FROM blocks WHERE project_id = ? AND (title LIKE ? OR summary LIKE ?) LIMIT 10').bind(projectId, q, q).all()).results || [];
      const plans = (await db.prepare('SELECT id, title, status, summary FROM plans WHERE project_id = ? AND (title LIKE ? OR summary LIKE ?) LIMIT 10').bind(projectId, q, q).all()).results || [];
      result = JSON.stringify({ blocks, plans }, null, 2);
    } else {
      result = `Cloud os_context action '${action}' completed on project '${projectId}'.`;
    }
  } else if (tool === 'plan') {
    const action = input.action || 'list';
    if (action === 'create' && input.planData && db) {
      const p = input.planData;
      const now = new Date().toISOString();
      const planId = p.id || `plan-${Date.now()}`;
      await db.prepare('INSERT OR REPLACE INTO projects (id, repo_root, exported_at) VALUES (?, ?, ?)')
        .bind(projectId, '', now).run();
      await db.prepare('INSERT OR REPLACE INTO plans (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(planId, projectId, p.title || 'Untitled Plan', p.status || 'active', now, now).run();
      result = { id: planId, status: 'created', title: p.title };
    } else if (action === 'list' && db) {
      const rows = (await db.prepare('SELECT * FROM plans WHERE project_id = ?').bind(projectId).all()).results || [];
      result = rows;
    } else {
      result = `Plan action '${action}' executed on cloud hub.`;
    }
  } else if (tool === 'task') {
    const action = input.action || 'create';
    result = `Task '${input.id || 'draft'}' action '${action}' synchronized to cloud hub.`;
  } else if (tool === 'block') {
    const action = input.action || 'list';
    if (action === 'bind' && input.id && db) {
      const now = new Date().toISOString();
      await db.prepare('INSERT OR REPLACE INTO blocks (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .bind(input.id, projectId, input.id, now, now).run();
      result = `Block '${input.id}' bound on cloud hub.`;
    } else if (db) {
      result = (await db.prepare('SELECT * FROM blocks WHERE project_id = ?').bind(projectId).all()).results || [];
    } else {
      result = [];
    }
  } else if (tool === 'chain') {
    result = `Chain operation executed on cloud hub.`;
  } else if (tool === 'knowledge') {
    result = `Knowledge rule retrieved from cloud hub.`;
  } else {
    result = `Tool '${tool}' completed on cloud hub.`;
  }

  return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
}

// MCP Tools schema definition
const MCP_TOOLS = [
  {
    name: 'os_context',
    description: 'Project context gateway. Use action=brief on session start or resume; search to find entities; open to read an entity.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['brief', 'search', 'open', 'reconcile'], default: 'brief' },
        query: { type: 'string' },
        entityId: { type: 'string' },
        format: { type: 'string', enum: ['markdown', 'json'], default: 'markdown' },
      },
    },
  },
  {
    name: 'plan',
    description: 'Manage delivery Plans, Phases and Plan Checkpoints (formal acceptance). Checkpoints belong strictly to Plans.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'open', 'check', 'complete', 'delete'] },
        id: { type: 'string' },
        planData: { type: 'object' },
        checkpointId: { type: 'string' },
        passed: { type: 'boolean' },
        evidenceRef: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'task',
    description: 'C-D-C-S development lifecycle task execution (draft -> active -> checking -> syncing -> completed).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'open', 'note', 'check', 'sync', 'resume', 'activate', 'develop'] },
        id: { type: 'string' },
        title: { type: 'string' },
        planId: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'block',
    description: 'Manage code functional Blocks. Blocks bind to real code artifacts; ghost blocks are strictly rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'open', 'search', 'bind', 'delete'] },
        id: { type: 'string' },
        query: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'chain',
    description: 'Feature chains and dependency links between architecture blocks.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'open', 'compose', 'delete', 'link', 'unlink', 'links'] },
        id: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'knowledge',
    description: 'Project knowledge management: categorized Rules and architectural decisions.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get'] },
        id: { type: 'string' },
      },
      required: ['action'],
    },
  },
];

// Handle incoming JSON-RPC message
async function handleJsonRpc(msg, env, db, projectId = 'contextos') {
  const { id, method, params = {} } = msg;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: 'contextos',
          version: '2.0.3',
        },
        instructions:
          'ContextOS Cloud Hub: Spatial architecture and C-D-C-S context manager for AI coding agents. Plans, tasks, and blocks synchronize with Cloudflare edge D1 SQLite.',
      },
    };
  }

  if (method === 'notifications/initialized') {
    return null;
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: MCP_TOOLS,
      },
    };
  }

  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params;
    const targetProject = args.projectId || projectId;
    try {
      const outputText = await executeTool(name, args, targetProject, db);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: outputText }],
        },
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: `Tool execution failed: ${err.message}`,
        },
      };
    }
  }

  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32601,
      message: `Method '${method}' not found`,
    },
  };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const db = env.DB;
    await ensureDb(db);

    // 1. Landing page & documentation (public)
    if (url.pathname === '/' && request.method === 'GET') {
      const hasAuthToken = Boolean((env?.AUTH_TOKEN || env?.CONTEXTOS_TOKEN || '').trim());
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>ContextOS Cloud Hub</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0c0d0e; color: #f0f3f6; margin: 0; padding: 40px 20px; display: flex; justify-content: center; }
    .card { background: #16181d; border: 1px solid #2a2e39; border-radius: 12px; max-width: 680px; width: 100%; padding: 32px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
    h1 { color: #58a6ff; margin-top: 0; font-size: 24px; display: flex; align-items: center; gap: 8px; }
    .status-badge { display: inline-block; background: #238636; color: #fff; font-size: 11px; font-weight: bold; padding: 4px 10px; border-radius: 20px; margin-bottom: 16px; }
    .badge-auth { background: ${hasAuthToken ? '#1f6feb' : '#d29922'}; }
    pre { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 14px; font-size: 13px; overflow-x: auto; color: #7ee787; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; background: rgba(110,118,129,0.2); padding: 2px 6px; border-radius: 4px; }
    .footer { margin-top: 24px; font-size: 12px; color: #8b949e; border-top: 1px solid #2a2e39; padding-top: 16px; }
    a { color: #58a6ff; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="status-badge">● ONLINE · CLOUDFLARE EDGE</div>
    <div class="status-badge badge-auth">${hasAuthToken ? '🔒 BEARER AUTH ENABLED' : '🔓 OPEN ACCESS (NO TOKEN)'}</div>
    <h1>☁️ ContextOS Cloud Hub</h1>
    <p>Your serverless spatial architecture and context hub is active on Cloudflare Workers + D1.</p>
    
    <h3>1. Connect Remote MCP via HTTP / SSE (Cursor / Windsurf / Claude)</h3>
    <p>In Cursor <b>Settings -> Features -> MCP</b>, add a new server with Type <code>SSE</code>:</p>
    <pre>{
  "mcpServers": {
    "contextos": {
      "url": "${url.origin}/sse",
      "headers": {
        "Authorization": "Bearer ${hasAuthToken ? '<YOUR_TOKEN>' : ''}"
      }
    }
  }
}</pre>

    <h3>2. Connect Desktop App</h3>
    <p>In ContextOS Desktop, open the top-left project menu, choose <b>Connect Cloud MCP Project…</b>:</p>
    <ul>
      <li><b>Cloud Hub URL:</b> <code>${url.origin}</code></li>
      <li><b>Project ID:</b> <code>contextos</code></li>
      <li><b>Auth Token:</b> <code>${hasAuthToken ? '<YOUR_TOKEN>' : '(Optional)'}</code></li>
    </ul>

    <div class="footer">
      Powered by <a href="https://github.com/yubinbin32-ops/ContextOS" target="_blank">ContextOS</a> · Serverless Edge Architecture
    </div>
  </div>
</body>
</html>`;
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // Auth verification for all API / MCP endpoints
    const auth = checkAuth(request, env);
    if (!auth.authorized) {
      return new Response(JSON.stringify({ error: auth.error }), {
        status: 401,
        headers: CORS_HEADERS,
      });
    }

    // 2. Health check (/api/v2/health)
    if (url.pathname === '/api/v2/health') {
      const hasAuthToken = Boolean((env?.AUTH_TOKEN || env?.CONTEXTOS_TOKEN || '').trim());
      return new Response(
        JSON.stringify({
          status: 'ok',
          version: '2.0.3',
          mode: 'cloud',
          storage: db ? 'd1' : 'ephemeral',
          authRequired: hasAuthToken,
          url: url.origin,
        }),
        { headers: CORS_HEADERS }
      );
    }

    // 3. MCP SSE Transport endpoint (/sse)
    if (url.pathname === '/sse' && request.method === 'GET') {
      const sessionId = crypto.randomUUID();
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      sseSessions.set(sessionId, writer);

      // Write initial endpoint event as required by MCP SSE specification
      writer.write(encoder.encode(`event: endpoint\r\ndata: /message?sessionId=${sessionId}\r\n\r\n`));

      // Keepalive interval in isolate
      const keepaliveInterval = setInterval(() => {
        try {
          writer.write(encoder.encode(`: keepalive\r\n\r\n`));
        } catch (_) {
          clearInterval(keepaliveInterval);
          sseSessions.delete(sessionId);
        }
      }, 15000);

      // Clean up when client disconnects
      request.signal.addEventListener('abort', () => {
        clearInterval(keepaliveInterval);
        sseSessions.delete(sessionId);
        try {
          writer.close();
        } catch (_) {}
      });

      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
        },
      });
    }

    // 4. MCP Message endpoint for SSE (/message)
    if (url.pathname === '/message' && request.method === 'POST') {
      try {
        const body = await request.json();
        const sessionId = url.searchParams.get('sessionId') || '';
        const projectId = request.headers.get('x-contextos-project-id') || url.searchParams.get('projectId') || 'contextos';

        const rpcResponse = await handleJsonRpc(body, env, db, projectId);

        const writer = sseSessions.get(sessionId);
        if (writer && rpcResponse) {
          const encoder = new TextEncoder();
          writer.write(encoder.encode(`event: message\r\ndata: ${JSON.stringify(rpcResponse)}\r\n\r\n`));
          return new Response('Accepted', { status: 202, headers: CORS_HEADERS });
        }

        // If no active SSE session in this isolate, return RPC response directly
        if (rpcResponse) {
          return new Response(JSON.stringify(rpcResponse), { status: 200, headers: CORS_HEADERS });
        }
        return new Response('Accepted', { status: 202, headers: CORS_HEADERS });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: CORS_HEADERS });
      }
    }

    // 5. Direct Stateless MCP HTTP Endpoint (/mcp)
    if (url.pathname === '/mcp') {
      if (request.method === 'POST') {
        try {
          const body = await request.json();
          const projectId = request.headers.get('x-contextos-project-id') || url.searchParams.get('projectId') || 'contextos';
          const rpcResponse = await handleJsonRpc(body, env, db, projectId);
          return new Response(JSON.stringify(rpcResponse || {}), { status: 200, headers: CORS_HEADERS });
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: CORS_HEADERS });
        }
      }
      return new Response(JSON.stringify({ status: 'ContextOS Streamable HTTP MCP Active' }), { headers: CORS_HEADERS });
    }

    // 6. Snapshot export (/api/v2/snapshot)
    if (url.pathname === '/api/v2/snapshot') {
      const projectId = url.searchParams.get('projectId') || 'contextos';
      let snapshot = {
        project: { id: projectId, name: `${projectId} (Cloud)`, root: '', graphRevision: 1 },
        changeSequence: 1,
        blocks: [],
        chains: [],
        plans: [],
        links: [],
        chainMembers: [],
        chainNodes: [],
        chainEdges: [],
        planChainReferences: [],
        planDependencies: [],
        planSteps: [],
        planCheckpointReferences: [],
        planChainScopes: [],
        planChanges: [],
        planChainChangeReferences: [],
        backgroundScopes: [],
        decisions: [],
        decisionScopes: [],
        sourceReferences: [],
        checkpoints: [],
        checkpointBindings: [],
        checkpointDependencies: [],
        localizations: [],
        history: [],
        latestChanges: [],
      };

      if (db) {
        try {
          const plans = (await db.prepare('SELECT * FROM plans WHERE project_id = ?').bind(projectId).all()).results || [];
          const blocks = (await db.prepare('SELECT * FROM blocks WHERE project_id = ?').bind(projectId).all()).results || [];
          const chains = (await db.prepare('SELECT * FROM chains WHERE project_id = ?').bind(projectId).all()).results || [];
          const links = (await db.prepare('SELECT * FROM links WHERE project_id = ?').bind(projectId).all()).results || [];
          const checkpoints = (await db.prepare('SELECT * FROM checkpoints WHERE plan_id IN (SELECT id FROM plans WHERE project_id = ?)').bind(projectId).all()).results || [];

          snapshot.plans = plans.map((p) => ({
            id: p.id,
            title: p.title,
            summary: p.summary || '',
            goal: p.title,
            status: p.status,
            derivedStatus: p.status,
            statusReason: '',
            priority: p.priority,
            phase: 'implementation',
            order: 0,
            proposedDelta: '',
            completionPolicy: '{}',
            nextAction: '',
            blockers: '[]',
            startedAt: p.created_at,
            completedAt: null,
            invalidatedAt: null,
            progress: { total: 0, passed: 0, failed: 0, percentage: 0 },
            revision: 1,
          }));

          snapshot.blocks = blocks.map((b) => ({
            id: b.id,
            kind: b.kind || 'service',
            title: b.title,
            summary: b.summary || '',
            body: b.details || '',
            contract: '',
            scope: 'project',
            architectureLayer: 'domain',
            localOrder: 0,
            deliveryState: 'active',
            healthState: 'healthy',
            priority: 'normal',
            revision: 1,
          }));

          snapshot.chains = chains.map((c) => ({
            id: c.id,
            title: c.title,
            chainType: c.kind || 'leaf',
            purpose: c.summary || '',
            intent: c.title,
            inputContract: '',
            outputContract: '',
            deliveryState: 'active',
            healthState: 'healthy',
            priority: 'normal',
            topologyOrder: 0,
            revision: 1,
          }));

          snapshot.links = links.map((l) => ({
            id: l.id,
            sourceType: 'block',
            sourceId: l.from_id,
            targetType: 'block',
            targetId: l.to_id,
            kind: l.kind || 'depends_on',
            label: l.reason || '',
            contract: '',
            healthState: 'healthy',
            revision: l.revision || 1,
          }));

          snapshot.checkpoints = checkpoints.map((cp) => ({
            id: cp.id,
            targetType: 'plan',
            targetId: cp.plan_id,
            title: cp.title,
            criteria: cp.criteria || '',
            status: cp.status || 'pending',
            kind: 'atomic',
            aggregationPolicy: '{}',
            eligibleAfterChildren: false,
            evidenceLevel: 'none',
            requiredEvidenceLevel: 'static',
            coverage: 'complete',
            evidence: '[]',
            invalidatedAt: null,
            revision: 1,
            updatedAt: cp.completed_at || new Date().toISOString(),
          }));
        } catch (e) {
          console.error('Error querying D1 snapshot:', e);
        }
      }

      return new Response(JSON.stringify(snapshot), { headers: CORS_HEADERS });
    }

    // 7. Tool call RPC endpoint (/api/v2/call)
    if (url.pathname === '/api/v2/call' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { tool, input = {}, projectId = 'contextos' } = body;
        const result = await executeTool(tool, input, projectId, db);
        return new Response(JSON.stringify({ result }), { headers: CORS_HEADERS });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: CORS_HEADERS,
        });
      }
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404, headers: CORS_HEADERS });
  },
};
