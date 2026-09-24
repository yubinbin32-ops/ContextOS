/**
 * ContextOS Cloud Hub - Cloudflare Worker Entrypoint
 * Provides Serverless Context & Graph Hub with Cloudflare D1 (Edge SQLite)
 * Supports MCP over HTTP (SSE & Streamable JSON-RPC) + REST API + Bearer Token Auth
 */

import packageMetadata from './package.json' with { type: 'json' };

const VERSION = packageMetadata.version;

const BASE_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-contextos-token, x-contextos-project-id',
  'Content-Type': 'application/json',
};

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return {};
  const configured = String(env?.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.includes('*')) {
    return { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };
  }
  if (!configured.includes(origin)) return {};
  return { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };
}

function jsonHeaders(request, env) {
  return { ...BASE_HEADERS, ...corsHeaders(request, env) };
}

const DDL = `
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, repo_root TEXT NOT NULL, graph_revision INTEGER NOT NULL DEFAULT 0, exported_at TEXT, schema_version INTEGER NOT NULL DEFAULT 4);
CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal', status TEXT NOT NULL DEFAULT 'active', summary TEXT NOT NULL DEFAULT '', completed_summary TEXT, history_ref TEXT, rule_refs_json TEXT NOT NULL DEFAULT '[]', decision_refs_json TEXT NOT NULL DEFAULT '[]', dependency_refs_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS phases (id TEXT NOT NULL, plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE, phase_order INTEGER NOT NULL DEFAULT 0, objective TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT '', deliverables_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', task_ids_json TEXT NOT NULL DEFAULT '[]', acceptance_json TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (id, plan_id));
CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE, phase_id TEXT, title TEXT NOT NULL, criteria TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', evidence_refs_json TEXT NOT NULL DEFAULT '[]', completed_at TEXT);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE, phase_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', context_slice_json TEXT NOT NULL DEFAULT '{}', working_set_json TEXT NOT NULL DEFAULT '{}', references_json TEXT NOT NULL DEFAULT '{}', baseline_json TEXT NOT NULL DEFAULT '{}', notes_json TEXT NOT NULL DEFAULT '[]', checks_json TEXT NOT NULL DEFAULT '[]', sync_result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blocks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'service', summary TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '', artifact_ref_count INTEGER NOT NULL DEFAULT 0, history_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifact_refs (id TEXT PRIMARY KEY, block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE, path TEXT NOT NULL, symbol TEXT, anchor_kind TEXT NOT NULL DEFAULT 'symbol', start_line INTEGER, end_line INTEGER, hash TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'implementation', hash_mode TEXT, manifest TEXT);
CREATE TABLE IF NOT EXISTS chains (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'leaf', member_ids_json TEXT NOT NULL DEFAULT '[]', metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'depends_on', provenance TEXT NOT NULL DEFAULT 'authored', confidence REAL NOT NULL DEFAULT 1.0, reason TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
`;

const CLOUD_SCHEMA_MIGRATIONS = [
  "ALTER TABLE blocks ADD COLUMN artifact_ref_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE artifact_refs ADD COLUMN anchor_kind TEXT NOT NULL DEFAULT 'symbol'",
  "ALTER TABLE artifact_refs ADD COLUMN hash_mode TEXT",
  "ALTER TABLE artifact_refs ADD COLUMN manifest TEXT",
];

const initializedDbs = new WeakSet();

async function ensureDb(db) {
  if (!db || initializedDbs.has(db)) return;
  try {
    await db.exec(DDL);
    for (const statement of CLOUD_SCHEMA_MIGRATIONS) {
      try {
        await db.exec(statement);
      } catch (err) {
        if (!/duplicate column name/i.test(String(err?.message || err))) throw err;
      }
    }
    await db.exec('UPDATE projects SET schema_version = 4 WHERE schema_version < 4;');
    initializedDbs.add(db);
  } catch (err) {
    console.error('Failed to initialize D1 schema:', err);
    throw err;
  }
}

// In-memory active SSE sessions for the isolate
const sseSessions = new Map();

function checkAuth(request, env) {
  const secret = (env?.AUTH_TOKEN || env?.CONTEXTOS_TOKEN || '').trim();
  const allowOpenAccess = String(env?.ALLOW_OPEN_ACCESS || '').toLowerCase() === 'true';
  if (!secret) {
    return allowOpenAccess
      ? { authorized: true }
      : { authorized: false, error: 'Unauthorized: AUTH_TOKEN is not configured.' };
  }

  const authHeader = request.headers.get('Authorization') || request.headers.get('x-contextos-token') || '';
  let token = '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (authHeader) {
    token = authHeader.trim();
  }

  if (token === secret) {
    return { authorized: true };
  }
  return { authorized: false, error: 'Unauthorized: Invalid or missing Bearer token.' };
}

// Execute a ContextOS tool operation
async function seedStarterProjectIfNeeded(db, projectId) {
  if (!db) return;
  try {
    const existing = await db.prepare('SELECT id FROM projects WHERE id = ?').bind(projectId).first();
    if (existing) return;

    const now = new Date().toISOString();
    await db.prepare('INSERT INTO projects (id, repo_root, graph_revision, exported_at, schema_version) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET exported_at = excluded.exported_at')
      .bind(projectId, '', 1, now, 2).run();

    const planId = `plan-init-${Date.now().toString(36)}`;
    await db.prepare('INSERT OR REPLACE INTO plans (id, project_id, title, priority, status, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(planId, projectId, 'System Architecture & Baseline Setup', 'high', 'active', 'Initial spatial architecture and baseline milestone', now, now).run();

    const b1 = 'block-api-gateway';
    const b2 = 'block-core-service';
    await db.prepare('INSERT OR REPLACE INTO blocks (id, project_id, title, kind, summary, details, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(b1, projectId, 'API Gateway & MCP Interface', 'gateway', 'External protocol entrypoint and client integration', '', now, now).run();
    await db.prepare('INSERT OR REPLACE INTO blocks (id, project_id, title, kind, summary, details, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(b2, projectId, 'Core Domain Service', 'service', 'Core domain business logic and data processing', '', now, now).run();

    const c1 = 'chain-main-flow';
    await db.prepare('INSERT OR REPLACE INTO chains (id, project_id, title, summary, kind, member_ids_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(c1, projectId, 'Main Request Pipeline', 'End-to-end execution flow from API to Core Domain', 'linear', JSON.stringify([b1, b2]), now, now).run();

    const l1 = `link-${Date.now().toString(36)}`;
    await db.prepare('INSERT OR REPLACE INTO links (id, project_id, from_id, to_id, kind, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(l1, projectId, b1, b2, 'depends_on', 'Gateway invokes core service', now, now).run();
  } catch (err) {
    console.error('Error seeding starter project:', err);
  }
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function buildCloudSnapshot(db, projectId) {
  const empty = {
    schemaVersion: 4,
    project: { id: projectId, name: `${projectId} (Cloud)`, root: '', graphRevision: 0 },
    changeSequence: 0,
    plans: [],
    phases: [],
    checkpoints: [],
    tasks: [],
    blocks: [],
    chains: [],
    chainMembers: [],
    links: [],
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
    checkpointBindings: [],
    checkpointDependencies: [],
    localizations: [],
    history: [],
    latestChanges: [],
  };
  if (!db) return empty;

  const project = await db.prepare('SELECT * FROM projects WHERE id = ?').bind(projectId).first();
  const plans = (await db.prepare('SELECT * FROM plans WHERE project_id = ?').bind(projectId).all()).results || [];
  const phases = (await db.prepare('SELECT * FROM phases WHERE plan_id IN (SELECT id FROM plans WHERE project_id = ?)').bind(projectId).all()).results || [];
  const checkpoints = (await db.prepare('SELECT * FROM checkpoints WHERE plan_id IN (SELECT id FROM plans WHERE project_id = ?)').bind(projectId).all()).results || [];
  const tasks = (await db.prepare('SELECT * FROM tasks WHERE plan_id IN (SELECT id FROM plans WHERE project_id = ?)').bind(projectId).all()).results || [];
  const blocks = (await db.prepare('SELECT * FROM blocks WHERE project_id = ?').bind(projectId).all()).results || [];
  const refs = (await db.prepare('SELECT * FROM artifact_refs WHERE block_id IN (SELECT id FROM blocks WHERE project_id = ?)').bind(projectId).all()).results || [];
  const chains = (await db.prepare('SELECT * FROM chains WHERE project_id = ?').bind(projectId).all()).results || [];
  const links = (await db.prepare('SELECT * FROM links WHERE project_id = ?').bind(projectId).all()).results || [];
  const refsByBlock = new Map();
  for (const ref of refs) {
    if (!refsByBlock.has(ref.block_id)) refsByBlock.set(ref.block_id, []);
    refsByBlock.get(ref.block_id).push({
      id: ref.id,
      path: ref.path,
      symbol: ref.symbol || undefined,
      anchorKind: ref.anchor_kind || (ref.symbol ? 'symbol' : 'file'),
      startLine: ref.start_line,
      endLine: ref.end_line,
      hash: ref.hash || '',
      role: ref.role || 'implementation',
      hashMode: ref.hash_mode || null,
      manifest: ref.manifest || null,
    });
  }

  return {
    ...empty,
    project: {
      id: projectId,
      name: `${projectId} (Cloud)`,
      root: project?.repo_root || '',
      graphRevision: project?.graph_revision || 0,
    },
    changeSequence: project?.graph_revision || 0,
    plans: plans.map((p) => ({
      id: p.id,
      title: p.title,
      summary: p.summary || '',
      goal: p.title,
      status: p.status || 'active',
      derivedStatus: p.status || 'active',
      statusReason: '',
      priority: p.priority || 'normal',
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
      ruleRefs: parseJson(p.rule_refs_json, []),
      decisionRefs: parseJson(p.decision_refs_json, []),
      dependencyRefs: parseJson(p.dependency_refs_json, []),
    })),
    phases: phases.map((phase) => ({
      id: phase.id,
      planId: phase.plan_id,
      order: phase.phase_order || 0,
      objective: phase.objective || '',
      scope: phase.scope || '',
      deliverables: parseJson(phase.deliverables_json, []),
      status: phase.status || 'pending',
      taskIds: parseJson(phase.task_ids_json, []),
      acceptance: parseJson(phase.acceptance_json, []),
    })),
    checkpoints: checkpoints.map((checkpoint) => ({
      id: checkpoint.id,
      targetType: 'plan',
      targetId: checkpoint.plan_id,
      phaseId: checkpoint.phase_id || null,
      title: checkpoint.title,
      criteria: checkpoint.criteria || '',
      status: checkpoint.status || 'pending',
      evidenceRefs: parseJson(checkpoint.evidence_refs_json, []),
      completedAt: checkpoint.completed_at || null,
      revision: 1,
    })),
    tasks: tasks.map((task) => ({
      id: task.id,
      planId: task.plan_id,
      phaseId: task.phase_id,
      title: task.title,
      status: task.status || 'draft',
      contextSlice: parseJson(task.context_slice_json, {}),
      workingSet: parseJson(task.working_set_json, {}),
      references: parseJson(task.references_json, {}),
      baseline: parseJson(task.baseline_json, {}),
      notes: parseJson(task.notes_json, []),
      checks: parseJson(task.checks_json, []),
      syncResult: parseJson(task.sync_result_json, null),
      createdAt: task.created_at,
      updatedAt: task.updated_at,
    })),
    blocks: blocks.map((block) => ({
      id: block.id,
      kind: block.kind || 'service',
      title: block.title,
      summary: block.summary || '',
      body: block.details || '',
      details: block.details || '',
      history: parseJson(block.history_json, []),
      contract: '',
      scope: 'project',
      architectureLayer: 'domain',
      localOrder: 0,
      deliveryState: 'active',
      healthState: 'healthy',
      priority: 'normal',
      revision: 1,
      createdAt: block.created_at,
      updatedAt: block.updated_at,
      artifactRefs: refsByBlock.get(block.id) || [],
    })),
    chains: chains.map((chain) => ({
      id: chain.id,
      title: chain.title,
      chainType: chain.kind || 'leaf',
      kind: chain.kind || 'leaf',
      purpose: chain.summary || '',
      summary: chain.summary || '',
      metadata: parseJson(chain.metadata_json, {}),
      intent: chain.title,
      inputContract: '',
      outputContract: '',
      deliveryState: 'active',
      healthState: 'healthy',
      priority: 'normal',
      topologyOrder: 0,
      revision: 1,
      createdAt: chain.created_at,
      updatedAt: chain.updated_at,
      memberIds: parseJson(chain.member_ids_json, []),
    })),
    chainMembers: chains.flatMap((chain) => parseJson(chain.member_ids_json, []).map((blockId, index) => ({
      chainId: chain.id,
      blockId,
      order: index,
    }))),
    links: links.map((link) => ({
      id: link.id,
      sourceType: 'block',
      sourceId: link.from_id,
      targetType: 'block',
      targetId: link.to_id,
      kind: link.kind || 'depends_on',
      label: link.reason || '',
      reason: link.reason || '',
      provenance: link.provenance || 'authored',
      confidence: link.confidence ?? 1,
      contract: '',
      healthState: 'healthy',
      revision: link.revision || 1,
      createdAt: link.created_at,
      updatedAt: link.updated_at,
    })),
  };
}

async function replaceCloudSnapshot(db, projectId, body) {
  const now = new Date().toISOString();
  const statements = [];
  const add = (sql, ...values) => statements.push(db.prepare(sql).bind(...values));

  add('INSERT INTO projects (id, repo_root, graph_revision, exported_at, schema_version) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET repo_root = excluded.repo_root, graph_revision = excluded.graph_revision, exported_at = excluded.exported_at, schema_version = excluded.schema_version',
    projectId, body.project?.root || '', body.project?.graphRevision || body.changeSequence || 0, now, body.schemaVersion || 4);
  add('DELETE FROM links WHERE project_id = ?', projectId);
  add('DELETE FROM chains WHERE project_id = ?', projectId);
  add('DELETE FROM artifact_refs WHERE block_id IN (SELECT id FROM blocks WHERE project_id = ?)', projectId);
  add('DELETE FROM blocks WHERE project_id = ?', projectId);
  add('DELETE FROM checkpoints WHERE plan_id IN (SELECT id FROM plans WHERE project_id = ?)', projectId);
  add('DELETE FROM tasks WHERE plan_id IN (SELECT id FROM plans WHERE project_id = ?)', projectId);
  add('DELETE FROM phases WHERE plan_id IN (SELECT id FROM plans WHERE project_id = ?)', projectId);
  add('DELETE FROM plans WHERE project_id = ?', projectId);

  for (const plan of body.plans || []) {
    add('INSERT INTO plans (id, project_id, title, priority, status, summary, completed_summary, history_ref, rule_refs_json, decision_refs_json, dependency_refs_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      plan.id, projectId, plan.title || plan.id, plan.priority || 'normal', plan.status || 'active', plan.summary || '', plan.completedSummary || null, plan.historyRef || null,
      JSON.stringify(plan.ruleRefs || []), JSON.stringify(plan.decisionRefs || []), JSON.stringify(plan.dependencyRefs || []), plan.startedAt || plan.createdAt || now, plan.updatedAt || now);
  }
  for (const phase of body.phases || []) {
    add('INSERT OR REPLACE INTO phases (id, plan_id, phase_order, objective, scope, deliverables_json, status, task_ids_json, acceptance_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      phase.id, phase.planId, phase.order || 0, phase.objective || '', phase.scope || '', JSON.stringify(phase.deliverables || []), phase.status || 'pending', JSON.stringify(phase.taskIds || []), JSON.stringify(phase.acceptance || []));
  }
  for (const checkpoint of body.checkpoints || []) {
    add('INSERT OR REPLACE INTO checkpoints (id, plan_id, phase_id, title, criteria, status, evidence_refs_json, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      checkpoint.id, checkpoint.targetId || checkpoint.planId, checkpoint.phaseId || null, checkpoint.title || checkpoint.id, checkpoint.criteria || '', checkpoint.status || 'pending', JSON.stringify(checkpoint.evidenceRefs || []), checkpoint.completedAt || null);
  }
  for (const task of body.tasks || []) {
    add('INSERT OR REPLACE INTO tasks (id, plan_id, phase_id, title, status, context_slice_json, working_set_json, references_json, baseline_json, notes_json, checks_json, sync_result_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      task.id, task.planId, task.phaseId || '', task.title || task.id, task.status || 'draft', JSON.stringify(task.contextSlice || {}), JSON.stringify(task.workingSet || {}), JSON.stringify(task.references || {}), JSON.stringify(task.baseline || {}), JSON.stringify(task.notes || []), JSON.stringify(task.checks || []), task.syncResult ? JSON.stringify(task.syncResult) : null, task.createdAt || now, task.updatedAt || now);
  }
  for (const block of body.blocks || []) {
    add('INSERT OR REPLACE INTO blocks (id, project_id, title, kind, summary, details, artifact_ref_count, history_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      block.id, projectId, block.title || block.id, block.kind || 'service', block.summary || '', block.body || block.details || '', (block.artifactRefs || []).length, JSON.stringify(block.history || []), block.createdAt || now, block.updatedAt || now);
    for (const [index, ref] of (block.artifactRefs || []).entries()) {
      const anchorKind = ref.anchorKind || ref.anchor_kind || (ref.symbol ? 'symbol' : 'file');
      add('INSERT OR REPLACE INTO artifact_refs (id, block_id, path, symbol, anchor_kind, start_line, end_line, hash, role, hash_mode, manifest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ref.id || `${block.id}-ref-${index}`, block.id, ref.path || '', ref.symbol || null, anchorKind, ref.startLine ?? ref.start_line ?? null, ref.endLine ?? ref.end_line ?? null, ref.hash || '', ref.role || 'implementation', ref.hashMode || ref.hash_mode || null, ref.manifest || null);
    }
  }
  for (const chain of body.chains || []) {
    add('INSERT OR REPLACE INTO chains (id, project_id, title, summary, kind, member_ids_json, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      chain.id, projectId, chain.title || chain.id, chain.summary || chain.purpose || '', chain.kind || chain.chainType || 'linear', JSON.stringify(chain.memberIds || chain.member_ids || []), JSON.stringify(chain.metadata || {}), chain.createdAt || now, chain.updatedAt || now);
  }
  for (const link of body.links || []) {
    const fromId = link.sourceId || link.fromId || link.from_id || link.from;
    const toId = link.targetId || link.toId || link.to_id || link.to;
    if (!fromId || !toId) continue;
    add('INSERT OR REPLACE INTO links (id, project_id, from_id, to_id, kind, provenance, confidence, reason, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      link.id || `link-${fromId}-${toId}`, projectId, fromId, toId, link.kind || 'depends_on', link.provenance || 'authored', link.confidence ?? 1, link.reason || link.label || '', link.revision || 1, link.createdAt || now, link.updatedAt || now);
  }

  if (typeof db.batch === 'function') {
    await db.batch(statements);
  } else {
    for (const statement of statements) await statement.run();
  }
  return {
    plans: (body.plans || []).length,
    phases: (body.phases || []).length,
    checkpoints: (body.checkpoints || []).length,
    tasks: (body.tasks || []).length,
    blocks: (body.blocks || []).length,
    artifactRefs: (body.blocks || []).reduce((sum, block) => sum + (block.artifactRefs || []).length, 0),
    chains: (body.chains || []).length,
    links: (body.links || []).length,
  };
}

async function executeTool(tool, input = {}, projectId = 'contextos', db) {
  let result = '';
  await seedStarterProjectIfNeeded(db, projectId);

  if (tool === 'os_context') {
    const action = input.action || 'brief';
    if (action === 'brief') {
      const countPlans = db ? (await db.prepare('SELECT count(*) as c FROM plans WHERE project_id = ?').bind(projectId).first())?.c ?? 0 : 0;
      const countBlocks = db ? (await db.prepare('SELECT count(*) as c FROM blocks WHERE project_id = ?').bind(projectId).first())?.c ?? 0 : 0;
      const countChains = db ? (await db.prepare('SELECT count(*) as c FROM chains WHERE project_id = ?').bind(projectId).first())?.c ?? 0 : 0;
      result = `# ContextOS Cloud Hub Brief (${projectId})\n\n- Plans: ${countPlans}\n- Blocks: ${countBlocks}\n- Chains: ${countChains}\n- Storage: Cloudflare D1\n- Serverless Edge: Active\n\nAI Coding agent connected via remote MCP over HTTP. Follow the C-D-C-S workflow.`;
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
    if (action === 'create' && db) {
      const p = input.planData || input;
      const now = new Date().toISOString();
      const planId = p.id || `plan-${Date.now()}`;
      await db.prepare('INSERT INTO projects (id, repo_root, exported_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET exported_at = excluded.exported_at')
        .bind(projectId, '', now).run();
      await db.prepare('INSERT OR REPLACE INTO plans (id, project_id, title, priority, status, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(planId, projectId, p.title || 'Untitled Plan', p.priority || 'normal', p.status || 'active', p.summary || '', now, now).run();
      result = { id: planId, status: 'created', title: p.title };
    } else if (action === 'list' && db) {
      const rows = (await db.prepare('SELECT * FROM plans WHERE project_id = ? ORDER BY created_at DESC').bind(projectId).all()).results || [];
      result = rows;
    } else {
      result = `Plan action '${action}' executed on cloud hub.`;
    }
  } else if (tool === 'task') {
    const action = input.action || 'list';
    if (action === 'create' && db) {
      const t = input.taskData || input;
      const taskId = t.id || input.id || `task-${Date.now()}`;
      const planId = t.planId || input.planId || 'plan-v2-rebuild';
      const phaseId = t.phaseId || input.phaseId || 'P0';
      const title = t.title || input.title || 'Untitled Task';
      const status = t.status || 'draft';
      const now = new Date().toISOString();
      const contextSlice = JSON.stringify(t.contextSlice || {});
      const workingSet = JSON.stringify(Array.isArray(t.workingSet) ? { files: t.workingSet } : (t.workingSet || {}));
      const references = JSON.stringify(t.references || {});
      const baseline = JSON.stringify(t.baseline || {});
      await db.prepare('INSERT OR REPLACE INTO tasks (id, plan_id, phase_id, title, status, context_slice_json, working_set_json, references_json, baseline_json, notes_json, checks_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(taskId, planId, phaseId, title, status, contextSlice, workingSet, references, baseline, '[]', '[]', now, now).run();
      result = { id: taskId, planId, phaseId, title, status };
    } else if ((action === 'activate' || action === 'develop') && db) {
      const taskId = input.id;
      const now = new Date().toISOString();
      await db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').bind('active', now, taskId).run();
      result = { id: taskId, status: 'active' };
    } else if (action === 'check' && db) {
      const taskId = input.id;
      const checkData = input.checkData || {};
      const row = await db.prepare('SELECT checks_json FROM tasks WHERE id = ?').bind(taskId).first();
      const checks = row?.checks_json ? JSON.parse(row.checks_json) : [];
      checks.push({
        id: `check-${Date.now()}`,
        description: checkData.description || 'Check recorded',
        passed: checkData.passed !== false,
        evidence: checkData.evidence || '',
        recordedAt: new Date().toISOString(),
      });
      await db.prepare('UPDATE tasks SET checks_json = ?, updated_at = ? WHERE id = ?')
        .bind(JSON.stringify(checks), new Date().toISOString(), taskId).run();
      result = { id: taskId, status: 'checking', checksCount: checks.length };
    } else if (action === 'note' && db) {
      const taskId = input.id;
      const row = await db.prepare('SELECT notes_json FROM tasks WHERE id = ?').bind(taskId).first();
      const notes = row?.notes_json ? JSON.parse(row.notes_json) : [];
      notes.push({
        id: `note-${Date.now()}`,
        text: input.text || '',
        kind: input.kind || 'journal',
        createdAt: new Date().toISOString(),
      });
      await db.prepare('UPDATE tasks SET notes_json = ?, updated_at = ? WHERE id = ?')
        .bind(JSON.stringify(notes), new Date().toISOString(), taskId).run();
      result = { id: taskId, notesCount: notes.length };
    } else if (action === 'sync' && db) {
      const taskId = input.id;
      const now = new Date().toISOString();
      const syncResult = JSON.stringify(input.syncData || {});
      await db.prepare('UPDATE tasks SET status = ?, sync_result_json = ?, updated_at = ? WHERE id = ?')
        .bind('completed', syncResult, now, taskId).run();
      result = { id: taskId, status: 'completed' };
    } else if (action === 'get' && db) {
      const row = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(input.id).first();
      result = row || null;
    } else if (action === 'list' && db) {
      const planId = input.planId || input.plan_id;
      let rows;
      if (planId) {
        rows = (await db.prepare('SELECT * FROM tasks WHERE plan_id = ? ORDER BY created_at DESC').bind(planId).all()).results || [];
      } else {
        rows = (await db.prepare('SELECT * FROM tasks WHERE plan_id IN (SELECT id FROM plans WHERE project_id = ?) ORDER BY created_at DESC').bind(projectId).all()).results || [];
        if (rows.length === 0) {
          rows = (await db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all()).results || [];
        }
      }
      result = rows;
    } else {
      result = `Task '${input.id || 'draft'}' action '${action}' synchronized to cloud hub.`;
    }
  } else if (tool === 'block') {
    const action = input.action || 'list';
    if ((action === 'bind' || action === 'create') && db) {
      const b = input.blockData || input;
      const blockId = b.id || input.id;
      if (blockId) {
        const now = new Date().toISOString();
        await db.prepare('INSERT OR REPLACE INTO blocks (id, project_id, title, kind, summary, details, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(blockId, projectId, b.title || blockId, b.kind || 'service', b.summary || '', b.details || '', now, now).run();
        result = `Block '${blockId}' bound on cloud hub.`;
      } else {
        result = 'Missing block id';
      }
    } else if (db) {
      result = (await db.prepare('SELECT * FROM blocks WHERE project_id = ? ORDER BY title').bind(projectId).all()).results || [];
    } else {
      result = [];
    }
  } else if (tool === 'chain') {
    const action = input.action || 'list';
    if ((action === 'compose' || action === 'create') && db) {
      const c = input.chainData || input;
      const chainId = c.id || input.id;
      if (chainId) {
        const now = new Date().toISOString();
        const memberIds = JSON.stringify(c.memberIds || []);
        await db.prepare('INSERT OR REPLACE INTO chains (id, project_id, title, summary, kind, member_ids_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(chainId, projectId, c.title || chainId, c.summary || '', c.kind || 'leaf', memberIds, now, now).run();
        result = `Chain '${chainId}' composed on cloud hub.`;
      } else {
        result = 'Missing chain id';
      }
    } else if (action === 'link' && db) {
      const l = input.linkData || input;
      const linkId = l.id || `link-${Date.now().toString(36)}`;
      const now = new Date().toISOString();
      await db.prepare('INSERT OR REPLACE INTO links (id, project_id, from_id, to_id, kind, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(linkId, projectId, l.fromId || l.sourceId, l.toId || l.targetId, l.kind || 'depends_on', l.reason || l.label || '', now, now).run();
      result = `Link '${linkId}' created between '${l.fromId || l.sourceId}' and '${l.toId || l.targetId}'.`;
    } else if (db) {
      result = (await db.prepare('SELECT * FROM chains WHERE project_id = ? ORDER BY id').bind(projectId).all()).results || [];
    } else {
      result = [];
    }
  } else if (tool === 'knowledge') {
    const action = input.action || 'list';
    if (action === 'list') {
      result = [];
    } else if (action === 'get') {
      result = null;
    } else {
      result = [];
    }
  } else {
    throw new Error(`Unknown tool: ${tool}`);
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
          version: VERSION,
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
    const responseHeaders = jsonHeaders(request, env);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: responseHeaders });
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
        headers: responseHeaders,
      });
    }

    // 2. Health check (/api/v2/health)
    if (url.pathname === '/api/v2/health') {
      const hasAuthToken = Boolean((env?.AUTH_TOKEN || env?.CONTEXTOS_TOKEN || '').trim());
      return new Response(
        JSON.stringify({
          status: 'ok',
          version: VERSION,
          mode: 'cloud',
          storage: db ? 'd1' : 'ephemeral',
          authRequired: hasAuthToken,
          url: url.origin,
        }),
        { headers: responseHeaders }
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
          ...responseHeaders,
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
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
          return new Response('Accepted', { status: 202, headers: responseHeaders });
        }

        // If no active SSE session in this isolate, return RPC response directly
        if (rpcResponse) {
          return new Response(JSON.stringify(rpcResponse), { status: 200, headers: responseHeaders });
        }
        return new Response('Accepted', { status: 202, headers: responseHeaders });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: responseHeaders });
      }
    }

    // 5. Direct Stateless MCP HTTP Endpoint (/mcp)
    if (url.pathname === '/mcp') {
      if (request.method === 'POST') {
        try {
          const body = await request.json();
          const projectId = request.headers.get('x-contextos-project-id') || url.searchParams.get('projectId') || 'contextos';
          const rpcResponse = await handleJsonRpc(body, env, db, projectId);
          return new Response(JSON.stringify(rpcResponse || {}), { status: 200, headers: responseHeaders });
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: responseHeaders });
        }
      }
      return new Response(JSON.stringify({ status: 'ContextOS Streamable HTTP MCP Active' }), { headers: responseHeaders });
    }

    // 6. Snapshot export & transactional replacement (/api/v2/snapshot)
    if (url.pathname === '/api/v2/snapshot') {
      const projectId = request.headers.get('x-contextos-project-id') || url.searchParams.get('projectId') || 'contextos';
      if (request.method === 'POST') {
        try {
          const body = await request.json();
          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return new Response(JSON.stringify({ error: 'Snapshot body must be a JSON object.' }), { status: 400, headers: responseHeaders });
          }
          if (body.schemaVersion && body.schemaVersion !== 4) {
            return new Response(JSON.stringify({ error: `Unsupported snapshot schemaVersion: ${body.schemaVersion}` }), { status: 409, headers: responseHeaders });
          }
          if (!db) {
            return new Response(JSON.stringify({ error: 'Cloud storage is unavailable.' }), { status: 503, headers: responseHeaders });
          }
          const counts = await replaceCloudSnapshot(db, projectId, body);
          return new Response(JSON.stringify({ status: 'ok', projectId, schemaVersion: 4, counts }), { headers: responseHeaders });
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: responseHeaders });
        }
      }

      if (db) await seedStarterProjectIfNeeded(db, projectId);
      const snapshot = await buildCloudSnapshot(db, projectId);
      return new Response(JSON.stringify(snapshot), { headers: responseHeaders });
    }

    // 7. Tool call RPC endpoint (/api/v2/call)
    if (url.pathname === '/api/v2/call' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { tool, input = {} } = body;
        const projectId = body.projectId || input.projectId || request.headers.get('x-contextos-project-id') || url.searchParams.get('projectId') || 'contextos';
        const result = await executeTool(tool, input, projectId, db);
        return new Response(JSON.stringify({ result }), { headers: responseHeaders });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: responseHeaders,
        });
      }
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404, headers: responseHeaders });
  },
};
