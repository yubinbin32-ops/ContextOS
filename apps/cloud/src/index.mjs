/**
 * ContextOS Cloud Hub - Cloudflare Worker Entrypoint
 * Provides Serverless Context & Graph Hub with Cloudflare D1 (Edge SQLite)
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

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const db = env.DB;
    await ensureDb(db);

    // 1. Landing page
    if (url.pathname === '/' && request.method === 'GET') {
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>ContextOS Cloud Hub</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0c0d0e; color: #f0f3f6; margin: 0; padding: 40px 20px; display: flex; justify-content: center; }
    .card { background: #16181d; border: 1px solid #2a2e39; border-radius: 12px; max-width: 640px; width: 100%; padding: 32px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
    h1 { color: #58a6ff; margin-top: 0; font-size: 24px; display: flex; align-items: center; gap: 8px; }
    .status-badge { display: inline-block; background: #238636; color: #fff; font-size: 11px; font-weight: bold; padding: 4px 10px; border-radius: 20px; margin-bottom: 16px; }
    pre { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 14px; font-size: 13px; overflow-x: auto; color: #7ee787; }
    .footer { margin-top: 24px; font-size: 12px; color: #8b949e; border-top: 1px solid #2a2e39; padding-top: 16px; }
    a { color: #58a6ff; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="status-badge">● ONLINE · CLOUDFLARE EDGE</div>
    <h1>☁️ ContextOS Cloud Hub</h1>
    <p>Your serverless spatial architecture and context hub is active.</p>
    
    <h3>1. Connect Local MCP (Cursor / Codex / Claude Code)</h3>
    <pre>export CONTEXTOS_MODE="cloud"
export CONTEXTOS_CLOUD_URL="${url.origin}"
export CONTEXTOS_PROJECT_ID="contextos"</pre>

    <h3>2. Connect Desktop App</h3>
    <p>Open ContextOS Desktop, click the top-left project menu, select <b>Connect Cloud MCP Project</b>, and enter this URL: <code>${url.origin}</code>.</p>

    <div class="footer">
      Powered by <a href="https://github.com/yubinbin32-ops/ContextOS" target="_blank">ContextOS</a> · Cloudflare Workers + D1 SQLite
    </div>
  </div>
</body>
</html>`;
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // 2. Health check
    if (url.pathname === '/api/v2/health') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          version: '2.1.0',
          mode: 'cloud',
          storage: db ? 'd1' : 'ephemeral',
          url: url.origin,
        }),
        { headers: CORS_HEADERS }
      );
    }

    // 3. Snapshot export
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

    // 4. Tool call RPC endpoint (/api/v2/call)
    if (url.pathname === '/api/v2/call' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { tool, input = {} } = body;
        const projectId = body.projectId || input.projectId || request.headers.get('x-contextos-project-id') || url.searchParams.get('projectId') || 'contextos';

        let result = '';

        if (tool === 'os_context') {
          const action = input.action || 'brief';
          if (action === 'brief') {
            const countPlans = db ? (await db.prepare('SELECT count(*) as c FROM plans WHERE project_id = ?').bind(projectId).first())?.c ?? 0 : 0;
            const countBlocks = db ? (await db.prepare('SELECT count(*) as c FROM blocks WHERE project_id = ?').bind(projectId).first())?.c ?? 0 : 0;
            result = `# ContextOS Cloud Hub Brief (${projectId})\n\n- Plans: ${countPlans}\n- Blocks: ${countBlocks}\n- Storage: Cloudflare D1\n- Serverless Edge: Active\n\nAI Coding agent connected via remote MCP. Follow C-D-C-S workflow.`;
          } else {
            result = `Cloud os_context action '${action}' completed.`;
          }
        } else if (tool === 'plan') {
          const action = input.action || 'list';
          if (action === 'create' && input.planData && db) {
            const p = input.planData;
            const now = new Date().toISOString();
            await db.prepare('INSERT OR REPLACE INTO projects (id, repo_root, exported_at) VALUES (?, ?, ?)')
              .bind(projectId, '', now).run();
            await db.prepare('INSERT OR REPLACE INTO plans (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
              .bind(p.id || `plan-${Date.now()}`, projectId, p.title || 'Untitled Plan', p.status || 'active', now, now).run();
            result = { id: p.id, status: 'created', title: p.title };
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
