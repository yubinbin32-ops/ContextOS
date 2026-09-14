import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { V2_SQL_SCHEMA } from './schema.mjs';

export class V2Database {
  constructor(filePath = ':memory:') {
    this.filePath = filePath;
    if (filePath !== ':memory:') {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    this.db = new DatabaseSync(filePath);
    this.init();
  }

  init() {
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(V2_SQL_SCHEMA);
  }

  transaction(fn) {
    this.db.exec('BEGIN TRANSACTION;');
    try {
      const result = fn(this);
      this.db.exec('COMMIT;');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  close() {
    this.db.close();
  }

  // --- Project ---
  getProject(projectId) {
    const stmt = this.db.prepare('SELECT * FROM projects WHERE id = ?');
    return stmt.get(projectId) || null;
  }

  ensureProject(projectId, repoRoot) {
    const existing = this.getProject(projectId);
    if (existing) return existing;
    const stmt = this.db.prepare(
      'INSERT INTO projects (id, repo_root, graph_revision, exported_at, schema_version) VALUES (?, ?, 0, ?, 2)'
    );
    stmt.run(projectId, repoRoot, new Date().toISOString());
    return this.getProject(projectId);
  }

  setGraphRevision(projectId, revision) {
    const stmt = this.db.prepare('UPDATE projects SET graph_revision = ? WHERE id = ?');
    stmt.run(revision, projectId);
  }

  // --- Sync State ---
  getSyncState(key) {
    const stmt = this.db.prepare('SELECT value FROM sync_state WHERE key = ?');
    const row = stmt.get(key);
    return row ? row.value : null;
  }

  setSyncState(key, value) {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)');
    stmt.run(key, value);
  }

  // --- Plan ---
  savePlan(plan) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO plans (
        id, project_id, title, priority, status, summary, completed_summary,
        history_ref, rule_refs_json, decision_refs_json, dependency_refs_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      plan.id,
      plan.projectId || plan.project_id || 'contextos',
      plan.title || plan.id,
      plan.priority || 'normal',
      plan.status || 'active',
      plan.summary || '',
      plan.completedSummary || plan.completed_summary || null,
      plan.historyRef || plan.history_ref || null,
      JSON.stringify(plan.ruleRefs || plan.rule_refs || []),
      JSON.stringify(plan.decisionRefs || plan.decision_refs || []),
      JSON.stringify(plan.dependencyRefs || plan.dependency_refs || []),
      plan.createdAt || plan.created_at || new Date().toISOString(),
      plan.updatedAt || plan.updated_at || new Date().toISOString()
    );

    // Save phases
    const deletePhases = this.db.prepare('DELETE FROM phases WHERE plan_id = ?');
    deletePhases.run(plan.id);
    const insertPhase = this.db.prepare(`
      INSERT INTO phases (
        id, plan_id, phase_order, objective, scope, deliverables_json,
        status, task_ids_json, acceptance_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const phase of plan.phases || []) {
      insertPhase.run(
        phase.id,
        plan.id,
        phase.order || 0,
        phase.objective || '',
        phase.scope || '',
        JSON.stringify(phase.deliverables || []),
        phase.status || 'pending',
        JSON.stringify(phase.taskIds || []),
        JSON.stringify(phase.acceptance || [])
      );
    }

    // Save checkpoints
    const deleteCheckpoints = this.db.prepare('DELETE FROM checkpoints WHERE plan_id = ?');
    deleteCheckpoints.run(plan.id);
    const insertCp = this.db.prepare(`
      INSERT INTO checkpoints (
        id, plan_id, phase_id, title, criteria, status, evidence_refs_json, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const cp of plan.checkpoints || []) {
      insertCp.run(
        cp.id,
        plan.id,
        cp.phaseId || null,
        cp.title,
        cp.criteria || '',
        cp.status || 'pending',
        JSON.stringify(cp.evidenceRefs || []),
        cp.completedAt || null
      );
    }
  }

  getPlan(planId) {
    const stmt = this.db.prepare('SELECT * FROM plans WHERE id = ?');
    const row = stmt.get(planId);
    if (!row) return null;

    const phasesStmt = this.db.prepare('SELECT * FROM phases WHERE plan_id = ? ORDER BY phase_order ASC');
    const phases = phasesStmt.all(planId).map((p) => ({
      id: p.id,
      order: p.phase_order,
      objective: p.objective,
      scope: p.scope,
      deliverables: JSON.parse(p.deliverables_json || '[]'),
      status: p.status,
      taskIds: JSON.parse(p.task_ids_json || '[]'),
      acceptance: JSON.parse(p.acceptance_json || '[]'),
    }));

    const cpStmt = this.db.prepare('SELECT * FROM checkpoints WHERE plan_id = ?');
    const checkpoints = cpStmt.all(planId).map((c) => ({
      id: c.id,
      planId: c.plan_id,
      phaseId: c.phase_id,
      title: c.title,
      criteria: c.criteria,
      status: c.status,
      evidenceRefs: JSON.parse(c.evidence_refs_json || '[]'),
      completedAt: c.completed_at,
    }));

    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      priority: row.priority,
      status: row.status,
      summary: row.summary,
      completedSummary: row.completed_summary,
      historyRef: row.history_ref,
      ruleRefs: JSON.parse(row.rule_refs_json || '[]'),
      decisionRefs: JSON.parse(row.decision_refs_json || '[]'),
      dependencyRefs: JSON.parse(row.dependency_refs_json || '[]'),
      phases,
      checkpoints,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listPlans(projectId) {
    const stmt = projectId
      ? this.db.prepare('SELECT id FROM plans WHERE project_id = ? ORDER BY created_at DESC')
      : this.db.prepare('SELECT id FROM plans ORDER BY created_at DESC');
    const rows = projectId ? stmt.all(projectId) : stmt.all();
    return rows.map((r) => this.getPlan(r.id));
  }

  // --- Task ---
  saveTask(task) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO tasks (
        id, plan_id, phase_id, title, status, context_slice_json,
        working_set_json, references_json, baseline_json, notes_json,
        checks_json, sync_result_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      task.id,
      task.planId || task.plan_id || 'plan-default',
      task.phaseId || task.phase_id || 'P0',
      task.title || task.id,
      task.status || 'draft',
      JSON.stringify(task.contextSlice || task.context_slice || {}),
      JSON.stringify(task.workingSet || task.working_set || {}),
      JSON.stringify(task.references || {}),
      JSON.stringify(task.baseline || {}),
      JSON.stringify(task.notes || []),
      JSON.stringify(task.checks || []),
      task.syncResult ? JSON.stringify(task.syncResult) : (task.sync_result ? JSON.stringify(task.sync_result) : null),
      task.createdAt || task.created_at || new Date().toISOString(),
      task.updatedAt || task.updated_at || new Date().toISOString()
    );
  }

  getTask(taskId) {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE id = ?');
    const row = stmt.get(taskId);
    if (!row) return null;
    return {
      id: row.id,
      planId: row.plan_id,
      phaseId: row.phase_id,
      title: row.title,
      status: row.status,
      contextSlice: JSON.parse(row.context_slice_json || '{}'),
      workingSet: JSON.parse(row.working_set_json || '{}'),
      references: JSON.parse(row.references_json || '{}'),
      baseline: JSON.parse(row.baseline_json || '{}'),
      notes: JSON.parse(row.notes_json || '[]'),
      checks: JSON.parse(row.checks_json || '[]'),
      syncResult: row.sync_result_json ? JSON.parse(row.sync_result_json) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listTasks(planId) {
    const stmt = planId
      ? this.db.prepare('SELECT * FROM tasks WHERE plan_id = ? ORDER BY created_at ASC')
      : this.db.prepare('SELECT * FROM tasks ORDER BY created_at ASC');
    const rows = planId ? stmt.all(planId) : stmt.all();
    return rows.map((r) => ({
      id: r.id,
      planId: r.plan_id,
      phaseId: r.phase_id,
      title: r.title,
      status: r.status,
      contextSlice: JSON.parse(r.context_slice_json || '{}'),
      workingSet: JSON.parse(r.working_set_json || '{}'),
      references: JSON.parse(r.references_json || '{}'),
      baseline: JSON.parse(r.baseline_json || '{}'),
      notes: JSON.parse(r.notes_json || '[]'),
      checks: JSON.parse(r.checks_json || '[]'),
      syncResult: r.sync_result_json ? JSON.parse(r.sync_result_json) : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  // --- Block & ArtifactRefs ---
  saveBlock(block) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO blocks (
        id, project_id, title, summary, details, history_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      block.id,
      block.projectId || block.project_id || 'contextos',
      block.title || block.id,
      block.summary || '',
      block.details || '',
      JSON.stringify(block.history || []),
      block.createdAt || block.created_at || new Date().toISOString(),
      block.updatedAt || block.updated_at || new Date().toISOString()
    );

    const deleteRefs = this.db.prepare('DELETE FROM artifact_refs WHERE block_id = ?');
    deleteRefs.run(block.id);

    const insertRef = this.db.prepare(`
      INSERT INTO artifact_refs (
        id, block_id, path, symbol, start_line, end_line, hash, role
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const refs = block.artifactRefs || block.artifact_refs || [];
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      insertRef.run(
        `${block.id}-ref-${i}`,
        block.id,
        ref.path,
        ref.symbol || null,
        ref.startLine || ref.start_line || null,
        ref.endLine || ref.end_line || null,
        ref.hash || '',
        ref.role || 'implementation'
      );
    }
  }

  getBlock(blockId) {
    const stmt = this.db.prepare('SELECT * FROM blocks WHERE id = ?');
    const row = stmt.get(blockId);
    if (!row) return null;

    const refsStmt = this.db.prepare('SELECT * FROM artifact_refs WHERE block_id = ?');
    const refs = refsStmt.all(blockId).map((r) => ({
      path: r.path,
      symbol: r.symbol,
      startLine: r.start_line,
      endLine: r.end_line,
      hash: r.hash,
      role: r.role,
    }));

    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      summary: row.summary,
      details: row.details,
      artifactRefs: refs,
      history: JSON.parse(row.history_json || '[]'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listBlocks(projectId) {
    const stmt = projectId
      ? this.db.prepare('SELECT id FROM blocks WHERE project_id = ? ORDER BY created_at ASC')
      : this.db.prepare('SELECT id FROM blocks ORDER BY created_at ASC');
    const rows = projectId ? stmt.all(projectId) : stmt.all();
    return rows.map((r) => this.getBlock(r.id));
  }

  deleteBlock(blockId) {
    this.transaction((self) => {
      self.db.prepare('DELETE FROM links WHERE from_id = ? OR to_id = ?').run(blockId, blockId);
      self.db.prepare('DELETE FROM artifact_refs WHERE block_id = ?').run(blockId);
      self.db.prepare('DELETE FROM blocks WHERE id = ?').run(blockId);
      const chains = self.listChains();
      for (const c of chains) {
        if (c.memberIds?.includes(blockId)) {
          c.memberIds = c.memberIds.filter((m) => m !== blockId);
          self.saveChain(c);
        }
      }
    });
    return true;
  }

  // --- Chain ---
  saveChain(chain) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO chains (
        id, project_id, title, summary, kind, member_ids_json, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      chain.id,
      chain.projectId || chain.project_id || 'contextos',
      chain.title || chain.id,
      chain.summary || '',
      chain.kind || 'leaf',
      JSON.stringify(chain.memberIds || chain.member_ids || []),
      JSON.stringify(chain.metadata || {}),
      chain.createdAt || chain.created_at || new Date().toISOString(),
      chain.updatedAt || chain.updated_at || new Date().toISOString()
    );
  }

  getChain(chainId) {
    const stmt = this.db.prepare('SELECT * FROM chains WHERE id = ?');
    const row = stmt.get(chainId);
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      summary: row.summary,
      kind: row.kind,
      memberIds: JSON.parse(row.member_ids_json || '[]'),
      metadata: JSON.parse(row.metadata_json || '{}'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listChains(projectId) {
    const stmt = projectId
      ? this.db.prepare('SELECT * FROM chains WHERE project_id = ? ORDER BY created_at ASC')
      : this.db.prepare('SELECT * FROM chains ORDER BY created_at ASC');
    const rows = projectId ? stmt.all(projectId) : stmt.all();
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      title: r.title,
      summary: r.summary,
      kind: r.kind,
      memberIds: JSON.parse(r.member_ids_json || '[]'),
      metadata: JSON.parse(r.metadata_json || '{}'),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  deleteChain(chainId) {
    const stmt = this.db.prepare('DELETE FROM chains WHERE id = ?');
    stmt.run(chainId);
    return true;
  }

  // --- Link ---
  saveLink(link) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO links (
        id, project_id, from_id, to_id, kind, provenance, confidence, reason, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      link.id || `${link.from || link.source_id}->${link.to || link.target_id}`,
      link.projectId || link.project_id || 'contextos',
      link.from || link.from_id || link.source_id || link.sourceId,
      link.to || link.to_id || link.target_id || link.targetId,
      link.kind || link.link_type || link.linkType || 'depends_on',
      link.provenance || 'authored',
      link.confidence !== undefined ? link.confidence : 1.0,
      link.reason || '',
      link.revision || 1,
      link.createdAt || link.created_at || new Date().toISOString(),
      link.updatedAt || link.updated_at || new Date().toISOString()
    );
  }

  listLinks(projectId) {
    const stmt = projectId
      ? this.db.prepare('SELECT * FROM links WHERE project_id = ? ORDER BY created_at ASC')
      : this.db.prepare('SELECT * FROM links ORDER BY created_at ASC');
    const rows = projectId ? stmt.all(projectId) : stmt.all();
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      from: r.from_id,
      to: r.to_id,
      kind: r.kind,
      provenance: r.provenance,
      confidence: r.confidence,
      reason: r.reason,
      revision: r.revision,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  deleteLink(linkId) {
    const stmt = this.db.prepare('DELETE FROM links WHERE id = ?');
    stmt.run(linkId);
    return true;
  }

  deleteLinkBetween(fromId, toId) {
    const stmt = this.db.prepare('DELETE FROM links WHERE (from_id = ? AND to_id = ?) OR (id = ?)');
    stmt.run(fromId, toId, `${fromId}->${toId}`);
    return true;
  }

  // --- Command Receipts ---
  saveCommandReceipt(receipt) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO command_receipts (
        id, command, cwd, exit_code, duration_ms, summary, errors_json, warnings_json, artifacts_json, log_handle, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      receipt.id,
      receipt.command,
      receipt.cwd || process.cwd(),
      receipt.exitCode,
      receipt.durationMs || 0,
      receipt.summary || '',
      JSON.stringify(receipt.errors || []),
      JSON.stringify(receipt.warnings || []),
      JSON.stringify(receipt.artifacts || []),
      receipt.logHandle || null,
      receipt.createdAt || new Date().toISOString()
    );
  }

  getCommandReceipt(receiptId) {
    const stmt = this.db.prepare('SELECT * FROM command_receipts WHERE id = ?');
    const row = stmt.get(receiptId);
    if (!row) return null;
    return {
      id: row.id,
      command: row.command,
      cwd: row.cwd,
      exitCode: row.exit_code,
      durationMs: row.duration_ms,
      summary: row.summary,
      errors: JSON.parse(row.errors_json || '[]'),
      warnings: JSON.parse(row.warnings_json || '[]'),
      artifacts: JSON.parse(row.artifacts_json || '[]'),
      logHandle: row.log_handle,
      createdAt: row.created_at,
    };
  }
}
