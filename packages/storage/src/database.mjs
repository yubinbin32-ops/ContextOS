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
    this.transactionDepth = 0;
    this.init();
  }

  init() {
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(V2_SQL_SCHEMA);
    this._ensureSchemaMigrations();
  }

  _ensureSchemaMigrations() {
    const refColumns = this.db.prepare('PRAGMA table_info(artifact_refs)').all();
    if (!refColumns.some((column) => column.name === 'anchor_kind')) {
      this.db.exec("ALTER TABLE artifact_refs ADD COLUMN anchor_kind TEXT NOT NULL DEFAULT 'symbol';");
    }
    if (!refColumns.some((column) => column.name === 'hash_mode')) {
      this.db.exec('ALTER TABLE artifact_refs ADD COLUMN hash_mode TEXT;');
    }
    if (!refColumns.some((column) => column.name === 'manifest')) {
      this.db.exec('ALTER TABLE artifact_refs ADD COLUMN manifest TEXT;');
    }
    this.db.exec(`
      UPDATE artifact_refs
      SET anchor_kind = 'file'
      WHERE anchor_kind = 'symbol'
        AND (symbol IS NULL OR TRIM(symbol) = '')
    `);

    const blockColumns = this.db.prepare('PRAGMA table_info(blocks)').all();
    if (!blockColumns.some((column) => column.name === 'artifact_ref_count')) {
      this.db.exec('ALTER TABLE blocks ADD COLUMN artifact_ref_count INTEGER NOT NULL DEFAULT 0;');
    }
    this.db.exec(`
      UPDATE blocks
      SET artifact_ref_count = (
        SELECT COUNT(*) FROM artifact_refs WHERE artifact_refs.block_id = blocks.id
      )
      WHERE artifact_ref_count != (
        SELECT COUNT(*) FROM artifact_refs WHERE artifact_refs.block_id = blocks.id
      )
    `);

    const receiptColumns = this.db.prepare('PRAGMA table_info(command_receipts)').all();
    if (!receiptColumns.some((column) => column.name === 'changed_paths_json')) {
      this.db.exec("ALTER TABLE command_receipts ADD COLUMN changed_paths_json TEXT NOT NULL DEFAULT '[]';");
    }
    if (receiptColumns.some((column) => column.name === 'artifacts_json')) {
      this.db.exec(`
        UPDATE command_receipts
        SET changed_paths_json = artifacts_json
        WHERE changed_paths_json = '[]' AND artifacts_json != '[]'
      `);
    }

    this.db.exec(`
      DROP TABLE IF EXISTS artifact_links;
      DROP TABLE IF EXISTS artifact_records;
      DROP TABLE IF EXISTS build_runs;
      UPDATE projects SET schema_version = 3;
    `);
    this._ensureGraphSyncTriggers();
    this._ensureBlockIntegrityTriggers();
  }

  _ensureBlockIntegrityTriggers() {
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS blocks_require_artifact_count_insert
      AFTER INSERT ON blocks
      WHEN NEW.artifact_ref_count <= 0
      BEGIN
        SELECT RAISE(ABORT, 'Ghost Block rejected: blocks must reference real code');
      END;

      DROP TRIGGER IF EXISTS blocks_require_artifact_count_update;
      CREATE TRIGGER blocks_require_artifact_count_update
      AFTER UPDATE OF artifact_ref_count ON blocks
      WHEN NEW.artifact_ref_count <= 0
      BEGIN
        SELECT RAISE(ABORT, 'Ghost Block rejected: blocks must reference real code');
      END;

      DROP TRIGGER IF EXISTS artifact_refs_validate_insert;
      CREATE TRIGGER artifact_refs_validate_insert
      BEFORE INSERT ON artifact_refs
      WHEN NEW.path IS NULL OR TRIM(NEW.path) = ''
        OR NEW.hash IS NULL OR TRIM(NEW.hash) = '' OR LOWER(NEW.hash) = 'untracked'
        OR NEW.anchor_kind NOT IN ('symbol', 'file', 'tree')
        OR (NEW.anchor_kind = 'symbol' AND (NEW.symbol IS NULL OR TRIM(NEW.symbol) = ''))
        OR (NEW.anchor_kind = 'tree' AND NEW.hash_mode = 'manifest' AND (NEW.manifest IS NULL OR TRIM(NEW.manifest) = ''))
      BEGIN
        SELECT RAISE(ABORT, 'Invalid ArtifactRef: path, anchor and verified hash are required');
      END;

      DROP TRIGGER IF EXISTS artifact_refs_validate_update;
      CREATE TRIGGER artifact_refs_validate_update
      BEFORE UPDATE ON artifact_refs
      WHEN NEW.path IS NULL OR TRIM(NEW.path) = ''
        OR NEW.hash IS NULL OR TRIM(NEW.hash) = '' OR LOWER(NEW.hash) = 'untracked'
        OR NEW.anchor_kind NOT IN ('symbol', 'file', 'tree')
        OR (NEW.anchor_kind = 'symbol' AND (NEW.symbol IS NULL OR TRIM(NEW.symbol) = ''))
        OR (NEW.anchor_kind = 'tree' AND NEW.hash_mode = 'manifest' AND (NEW.manifest IS NULL OR TRIM(NEW.manifest) = ''))
      BEGIN
        SELECT RAISE(ABORT, 'Invalid ArtifactRef: path, anchor and verified hash are required');
      END;

      CREATE TRIGGER IF NOT EXISTS artifact_refs_sync_count_after_insert
      AFTER INSERT ON artifact_refs
      BEGIN
        UPDATE blocks
        SET artifact_ref_count = (SELECT COUNT(*) FROM artifact_refs WHERE block_id = NEW.block_id)
        WHERE id = NEW.block_id;
      END;

      CREATE TRIGGER IF NOT EXISTS artifact_refs_sync_count_after_update
      AFTER UPDATE OF block_id ON artifact_refs
      BEGIN
        UPDATE blocks
        SET artifact_ref_count = (SELECT COUNT(*) FROM artifact_refs WHERE block_id = OLD.block_id)
        WHERE id = OLD.block_id;
        UPDATE blocks
        SET artifact_ref_count = (SELECT COUNT(*) FROM artifact_refs WHERE block_id = NEW.block_id)
        WHERE id = NEW.block_id;
      END;

      DROP TRIGGER IF EXISTS artifact_refs_prevent_last_delete;
      CREATE TRIGGER artifact_refs_prevent_last_delete
      BEFORE DELETE ON artifact_refs
      WHEN EXISTS (SELECT 1 FROM blocks WHERE id = OLD.block_id)
        AND NOT EXISTS (SELECT 1 FROM artifact_refs WHERE block_id = OLD.block_id AND id <> OLD.id)
      BEGIN
        SELECT RAISE(ABORT, 'Ghost Block rejected: cannot delete the final artifactRef');
      END;

      CREATE TRIGGER IF NOT EXISTS artifact_refs_sync_count_after_delete
      AFTER DELETE ON artifact_refs
      BEGIN
        UPDATE blocks
        SET artifact_ref_count = (SELECT COUNT(*) FROM artifact_refs WHERE block_id = OLD.block_id)
        WHERE id = OLD.block_id;
      END;
    `);
  }

  /**
   * graph.json is a derived projection of SQLite. Instead of trusting every
   * call site to remember an export, the graph tables mark the project dirty
   * themselves; only the publisher decides when to write the file.
   */
  _ensureGraphSyncTriggers() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS graph_dirty (
        project_id TEXT PRIMARY KEY,
        reason TEXT NOT NULL DEFAULT '',
        marked_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const direct = ['blocks', 'chains', 'links', 'plans'];
    for (const table of direct) {
      for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
        const ref = event === 'DELETE' ? 'OLD' : 'NEW';
        const key = `${table}_${event.toLowerCase()}`;
        this.db.exec(`
          CREATE TRIGGER IF NOT EXISTS ${key}_dirty AFTER ${event} ON ${table}
          WHEN ${ref}.project_id IS NOT NULL
          BEGIN
            INSERT INTO graph_dirty (project_id, reason, marked_at)
            VALUES (${ref}.project_id, '${key}', datetime('now'))
            ON CONFLICT(project_id) DO UPDATE SET
              reason = '${key}', marked_at = datetime('now');
          END;
        `);
      }
    }
    // Rows without their own project_id borrow it from their parent.
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const ref = event === 'DELETE' ? 'OLD' : 'NEW';
      const key = `tasks_${event.toLowerCase()}`;
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${key}_dirty AFTER ${event} ON tasks
        BEGIN
          INSERT INTO graph_dirty (project_id, reason, marked_at)
          SELECT project_id, '${key}', datetime('now') FROM plans WHERE id = ${ref}.plan_id
          ON CONFLICT(project_id) DO UPDATE SET reason = '${key}', marked_at = datetime('now');
        END;
      `);
    }
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const ref = event === 'DELETE' ? 'OLD' : 'NEW';
      const key = `artifact_refs_${event.toLowerCase()}`;
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${key}_dirty AFTER ${event} ON artifact_refs
        BEGIN
          INSERT INTO graph_dirty (project_id, reason, marked_at)
          SELECT project_id, '${key}', datetime('now') FROM blocks WHERE id = ${ref}.block_id
          ON CONFLICT(project_id) DO UPDATE SET reason = '${key}', marked_at = datetime('now');
        END;
      `);
    }
  }

  isGraphDirty(projectId) {
    return Boolean(this.db.prepare('SELECT 1 FROM graph_dirty WHERE project_id = ?').get(projectId));
  }

  clearGraphDirty(projectId) {
    this.db.prepare('DELETE FROM graph_dirty WHERE project_id = ?').run(projectId);
  }

  transaction(fn) {
    if (this.transactionDepth > 0) {
      this.transactionDepth += 1;
      try {
        return fn(this);
      } finally {
        this.transactionDepth -= 1;
      }
    }

    this.db.exec('BEGIN IMMEDIATE;');
    this.transactionDepth = 1;
    try {
      const result = fn(this);
      this.db.exec('COMMIT;');
      this.transactionDepth = 0;
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } finally {
        this.transactionDepth = 0;
      }
      throw err;
    }
  }

  setGraphExported(projectId, revision, sha256, exportedAt = new Date().toISOString()) {
    this.transaction((db) => {
      db.db
        .prepare('UPDATE projects SET graph_revision = ?, exported_at = ? WHERE id = ?')
        .run(revision, exportedAt, projectId);
      db.setSyncState(`last_exported_hash:${projectId}`, sha256);
      db.db.prepare('DELETE FROM graph_outbox WHERE project_id = ?').run(projectId);
      db.clearGraphDirty(projectId);
    });
  }

  getGraphOutbox(projectId) {
    const row = this.db.prepare('SELECT * FROM graph_outbox WHERE project_id = ?').get(projectId);
    if (!row) return null;
    return {
      projectId: row.project_id,
      baseRevision: row.base_revision,
      targetRevision: row.target_revision,
      payloadHash: row.payload_hash,
      payloadJson: row.payload_json,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  saveGraphOutbox(entry) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO graph_outbox (
        project_id, base_revision, target_revision, payload_hash, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        base_revision = excluded.base_revision,
        target_revision = excluded.target_revision,
        payload_hash = excluded.payload_hash,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      entry.projectId,
      entry.baseRevision,
      entry.targetRevision,
      entry.payloadHash,
      entry.payloadJson,
      entry.createdAt || now,
      now
    );
    return this.getGraphOutbox(entry.projectId);
  }

  deleteGraphOutbox(projectId) {
    this.db.prepare('DELETE FROM graph_outbox WHERE project_id = ?').run(projectId);
    return true;
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
      'INSERT INTO projects (id, repo_root, graph_revision, exported_at, schema_version) VALUES (?, ?, 0, ?, 3)'
    );
    stmt.run(projectId, repoRoot, new Date().toISOString());
    return this.getProject(projectId);
  }

  /**
   * Atomically adopt state created by the old bootstrap identity ('contextos')
   * when a workspace later acquires its directory-derived identity. Never merge
   * two non-empty projects: refusing is safer than silently mixing histories.
   */
  adoptLegacyProject(projectId, { legacyProjectId = 'contextos', repoRoot = null } = {}) {
    if (!projectId || !legacyProjectId || projectId === legacyProjectId) {
      return { adopted: false, removedEmptyLegacy: false, sourceCounts: {}, targetCounts: {} };
    }

    return this.transaction((db) => {
      const legacy = db.getProject(legacyProjectId);
      if (!legacy) return { adopted: false, removedEmptyLegacy: false, sourceCounts: {}, targetCounts: {} };

      const scopedTables = ['plans', 'blocks', 'chains', 'links', 'graph_outbox'];
      const countRows = (id) => Object.fromEntries(scopedTables.map((table) => [
        table,
        db.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`).get(id).count,
      ]));
      const sourceCounts = countRows(legacyProjectId);
      const sourceTotal = Object.values(sourceCounts).reduce((sum, count) => sum + count, 0);

      const resolvedRepoRoot = repoRoot ? path.resolve(repoRoot) : null;
      const legacyRepoRoot = legacy.repo_root ? path.resolve(legacy.repo_root) : null;
      if (sourceTotal > 0 && resolvedRepoRoot && legacyRepoRoot && resolvedRepoRoot !== legacyRepoRoot) {
        throw new Error(
          `Refusing to adopt project '${legacyProjectId}': it belongs to '${legacyRepoRoot}', not '${resolvedRepoRoot}'.`
        );
      }

      const target = db.getProject(projectId) || db.ensureProject(projectId, resolvedRepoRoot || legacyRepoRoot || '');
      const targetCounts = countRows(projectId);
      const targetTotal = Object.values(targetCounts).reduce((sum, count) => sum + count, 0);

      if (sourceTotal > 0 && targetTotal > 0) {
        throw new Error(
          `Refusing to merge project '${legacyProjectId}' into '${projectId}': both contain plans or graph state. Export or migrate one project explicitly.`
        );
      }

      if (sourceTotal === 0) {
        const sameRepo = !resolvedRepoRoot || !legacyRepoRoot || resolvedRepoRoot === legacyRepoRoot;
        if (sameRepo) db.db.prepare('DELETE FROM projects WHERE id = ?').run(legacyProjectId);
        return { adopted: false, removedEmptyLegacy: sameRepo, sourceCounts, targetCounts };
      }

      for (const table of scopedTables) {
        db.db.prepare(`UPDATE ${table} SET project_id = ? WHERE project_id = ?`).run(projectId, legacyProjectId);
      }

      const graphRevision = Math.max(target.graph_revision || 0, legacy.graph_revision || 0);
      const exportedAt = (legacy.graph_revision || 0) >= (target.graph_revision || 0)
        ? legacy.exported_at
        : target.exported_at;
      db.db.prepare(`
        UPDATE projects
        SET repo_root = ?, graph_revision = ?, exported_at = ?, schema_version = MAX(schema_version, ?)
        WHERE id = ?
      `).run(
        resolvedRepoRoot || legacyRepoRoot || target.repo_root,
        graphRevision,
        exportedAt,
        legacy.schema_version || 3,
        projectId
      );
      db.db.prepare('DELETE FROM projects WHERE id = ?').run(legacyProjectId);
      db.db.prepare('DELETE FROM graph_dirty WHERE project_id = ?').run(legacyProjectId);
      db.db.prepare(`
        INSERT INTO graph_dirty (project_id, reason, marked_at)
        VALUES (?, 'project-identity-adopted', datetime('now'))
        ON CONFLICT(project_id) DO UPDATE SET reason = excluded.reason, marked_at = excluded.marked_at
      `).run(projectId);

      return { adopted: true, removedEmptyLegacy: false, sourceCounts, targetCounts, graphRevision };
    });
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
    return this.transaction((db) => db._savePlan(plan));
  }

  _savePlan(plan) {
    const stmt = this.db.prepare(`
      INSERT INTO plans (
        id, project_id, title, priority, status, summary, completed_summary,
        history_ref, rule_refs_json, decision_refs_json, dependency_refs_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        title = excluded.title,
        priority = excluded.priority,
        status = excluded.status,
        summary = excluded.summary,
        completed_summary = excluded.completed_summary,
        history_ref = excluded.history_ref,
        rule_refs_json = excluded.rule_refs_json,
        decision_refs_json = excluded.decision_refs_json,
        dependency_refs_json = excluded.dependency_refs_json,
        updated_at = excluded.updated_at
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

  _planFromRow(row, phases, checkpoints) {
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

  _phaseFromRow(row) {
    return {
      id: row.id,
      order: row.phase_order,
      objective: row.objective,
      scope: row.scope,
      deliverables: JSON.parse(row.deliverables_json || '[]'),
      status: row.status,
      taskIds: JSON.parse(row.task_ids_json || '[]'),
      acceptance: JSON.parse(row.acceptance_json || '[]'),
    };
  }

  _checkpointFromRow(row) {
    return {
      id: row.id,
      planId: row.plan_id,
      phaseId: row.phase_id,
      title: row.title,
      criteria: row.criteria,
      status: row.status,
      evidenceRefs: JSON.parse(row.evidence_refs_json || '[]'),
      completedAt: row.completed_at,
    };
  }

  getPlan(planId) {
    const row = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
    if (!row) return null;

    const phases = this.db
      .prepare('SELECT * FROM phases WHERE plan_id = ? ORDER BY phase_order ASC')
      .all(planId)
      .map((phase) => this._phaseFromRow(phase));
    const checkpoints = this.db
      .prepare('SELECT * FROM checkpoints WHERE plan_id = ?')
      .all(planId)
      .map((checkpoint) => this._checkpointFromRow(checkpoint));

    return this._planFromRow(row, phases, checkpoints);
  }

  listPlans(projectId) {
    const rows = projectId
      ? this.db.prepare('SELECT * FROM plans WHERE project_id = ? ORDER BY created_at DESC').all(projectId)
      : this.db.prepare('SELECT * FROM plans ORDER BY created_at DESC').all();
    if (rows.length === 0) return [];

    const phaseRows = projectId
      ? this.db.prepare(`
          SELECT phases.*
          FROM phases
          JOIN plans ON plans.id = phases.plan_id
          WHERE plans.project_id = ?
          ORDER BY phases.plan_id ASC, phases.phase_order ASC
        `).all(projectId)
      : this.db.prepare('SELECT * FROM phases ORDER BY plan_id ASC, phase_order ASC').all();
    const checkpointRows = projectId
      ? this.db.prepare(`
          SELECT checkpoints.*
          FROM checkpoints
          JOIN plans ON plans.id = checkpoints.plan_id
          WHERE plans.project_id = ?
        `).all(projectId)
      : this.db.prepare('SELECT * FROM checkpoints').all();

    const phasesByPlan = new Map();
    for (const phase of phaseRows) {
      const list = phasesByPlan.get(phase.plan_id) || [];
      list.push(this._phaseFromRow(phase));
      phasesByPlan.set(phase.plan_id, list);
    }
    const checkpointsByPlan = new Map();
    for (const checkpoint of checkpointRows) {
      const list = checkpointsByPlan.get(checkpoint.plan_id) || [];
      list.push(this._checkpointFromRow(checkpoint));
      checkpointsByPlan.set(checkpoint.plan_id, list);
    }

    return rows.map((row) => this._planFromRow(
      row,
      phasesByPlan.get(row.id) || [],
      checkpointsByPlan.get(row.id) || []
    ));
  }

  deletePlan(planId) {
    return this.transaction((db) => {
      db.db.prepare('DELETE FROM checkpoints WHERE plan_id = ?').run(planId);
      db.db.prepare('DELETE FROM phases WHERE plan_id = ?').run(planId);
      db.db.prepare('DELETE FROM tasks WHERE plan_id = ?').run(planId);
      const result = db.db.prepare('DELETE FROM plans WHERE id = ?').run(planId);
      return result.changes > 0;
    });
  }

  replaceProjectState(projectId, snapshot) {
    return this.transaction((db) => {
      // Graph integrity triggers intentionally reject zero-ref blocks. During a
      // full replacement the old graph is removed before the new graph exists,
      // so both delete-side guards must be paused and rebuilt once at the end.
      db.db.exec(`
        DROP TRIGGER IF EXISTS artifact_refs_prevent_last_delete;
        DROP TRIGGER IF EXISTS blocks_require_artifact_count_update;
      `);
      db.db.prepare('DELETE FROM artifact_refs WHERE block_id IN (SELECT id FROM blocks WHERE project_id = ?)').run(projectId);
      db.db.prepare('DELETE FROM blocks WHERE project_id = ?').run(projectId);
      db.db.prepare('DELETE FROM links WHERE project_id = ?').run(projectId);
      db.db.prepare('DELETE FROM chains WHERE project_id = ?').run(projectId);
      db.db.prepare('DELETE FROM checkpoints WHERE plan_id IN (SELECT id FROM plans WHERE project_id = ?)').run(projectId);
      db.db.prepare('DELETE FROM tasks WHERE plan_id IN (SELECT id FROM plans WHERE project_id = ?)').run(projectId);
      db.db.prepare('DELETE FROM phases WHERE plan_id IN (SELECT id FROM plans WHERE project_id = ?)').run(projectId);
      db.db.prepare('DELETE FROM plans WHERE project_id = ?').run(projectId);

      db.ensureProject(projectId, snapshot.project?.root || '');
      const phasesByPlan = new Map();
      for (const phase of snapshot.phases || []) {
        if (!phasesByPlan.has(phase.planId)) phasesByPlan.set(phase.planId, []);
        phasesByPlan.get(phase.planId).push(phase);
      }
      const checkpointsByPlan = new Map();
      for (const checkpoint of snapshot.checkpoints || []) {
        const planId = checkpoint.targetId || checkpoint.planId;
        if (!planId) continue;
        if (!checkpointsByPlan.has(planId)) checkpointsByPlan.set(planId, []);
        checkpointsByPlan.get(planId).push(checkpoint);
      }
      for (const plan of snapshot.plans || []) {
        db.savePlan({
          ...plan,
          projectId,
          phases: phasesByPlan.get(plan.id) || [],
          checkpoints: checkpointsByPlan.get(plan.id) || [],
        });
      }
      for (const task of snapshot.tasks || []) db.saveTask({ ...task, projectId });
      for (const block of snapshot.blocks || []) {
        db.saveBlock({ ...block, projectId, details: block.details ?? block.body ?? '' });
      }
      for (const chain of snapshot.chains || []) {
        db.saveChain({
          ...chain,
          projectId,
          summary: chain.summary ?? chain.purpose ?? '',
          kind: chain.kind ?? chain.chainType ?? 'leaf',
        });
      }
      for (const link of snapshot.links || []) {
        db.saveLink({
          ...link,
          projectId,
          from: link.from ?? link.fromId ?? link.from_id ?? link.sourceId,
          to: link.to ?? link.toId ?? link.to_id ?? link.targetId,
          reason: link.reason ?? link.label ?? '',
        });
      }
      db.setGraphRevision(projectId, snapshot.project?.graphRevision || snapshot.changeSequence || 0);
      db._ensureBlockIntegrityTriggers();
      return true;
    });
  }

  // --- Task ---
  saveTask(task) {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (
        id, plan_id, phase_id, title, status, context_slice_json,
        working_set_json, references_json, baseline_json, notes_json,
        checks_json, sync_result_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        plan_id = excluded.plan_id,
        phase_id = excluded.phase_id,
        title = excluded.title,
        status = excluded.status,
        context_slice_json = excluded.context_slice_json,
        working_set_json = excluded.working_set_json,
        references_json = excluded.references_json,
        baseline_json = excluded.baseline_json,
        notes_json = excluded.notes_json,
        checks_json = excluded.checks_json,
        sync_result_json = excluded.sync_result_json,
        updated_at = excluded.updated_at
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
    const references = JSON.parse(row.references_json || '{}');
    return {
      id: row.id,
      planId: row.plan_id,
      phaseId: row.phase_id,
      title: row.title,
      status: row.status,
      contextSlice: JSON.parse(row.context_slice_json || '{}'),
      workingSet: JSON.parse(row.working_set_json || '{}'),
      references,
      rules: references.rules || [],
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
    return rows.map((r) => {
      const references = JSON.parse(r.references_json || '{}');
      return {
        id: r.id,
        planId: r.plan_id,
        phaseId: r.phase_id,
        title: r.title,
        status: r.status,
        contextSlice: JSON.parse(r.context_slice_json || '{}'),
        workingSet: JSON.parse(r.working_set_json || '{}'),
        references,
        rules: references.rules || [],
        baseline: JSON.parse(r.baseline_json || '{}'),
        notes: JSON.parse(r.notes_json || '[]'),
        checks: JSON.parse(r.checks_json || '[]'),
        syncResult: r.sync_result_json ? JSON.parse(r.sync_result_json) : null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
  }

  // --- Block & ArtifactRefs ---
  saveBlock(block) {
    return this.transaction((db) => db._saveBlock(block));
  }

  _saveBlock(block) {
    const refs = block.artifactRefs || block.artifact_refs || [];
    if (!block.id || typeof block.id !== 'string') {
      throw new Error('Block requires a valid string id');
    }
    if (!block.title || typeof block.title !== 'string') {
      throw new Error(`Block '${block.id}' requires a title`);
    }
    if (!Array.isArray(refs) || refs.length === 0) {
      throw new Error(`Ghost Block rejected: Block '${block.id}' must have at least one artifactRef`);
    }

    const normalizedRefs = refs.map((ref, index) => {
      const anchorKind = ref?.anchorKind || ref?.anchor_kind || (ref?.symbol ? 'symbol' : 'file');
      const hash = typeof ref?.hash === 'string' ? ref.hash.trim() : '';
      const symbol = typeof ref?.symbol === 'string' ? ref.symbol.trim() : '';
      const hashMode = ref?.hashMode || ref?.hash_mode || null;
      const manifest = ref?.manifest || null;
      if (!ref?.path || typeof ref.path !== 'string' || !ref.path.trim()) {
        throw new Error(`Block '${block.id}' artifactRef ${index} requires a valid path`);
      }
      if (path.isAbsolute(ref.path)) {
        throw new Error(`Block '${block.id}' artifactRef path must be relative: '${ref.path}'`);
      }
      if (!hash || hash === 'untracked') {
        throw new Error(`Block '${block.id}' artifactRef '${ref.path}' requires a verified hash`);
      }
      if (anchorKind === 'symbol' && !symbol) {
        throw new Error(`Block '${block.id}' symbol anchor '${ref.path}' requires a symbol`);
      }
      if (anchorKind === 'tree' && hashMode === 'manifest' && !manifest) {
        throw new Error(`Block '${block.id}' manifest tree anchor '${ref.path}' requires a manifest path`);
      }
      return {
        id: `${block.id}-ref-${index}`,
        path: ref.path.trim(),
        symbol: anchorKind === 'tree' ? null : (symbol || null),
        anchorKind,
        startLine: anchorKind === 'tree' ? null : (ref.startLine ?? ref.start_line ?? null),
        endLine: anchorKind === 'tree' ? null : (ref.endLine ?? ref.end_line ?? null),
        hash,
        role: ref.role || 'implementation',
        hashMode,
        manifest: anchorKind === 'tree' ? manifest : null,
      };
    });

    const stmt = this.db.prepare(`
      INSERT INTO blocks (
        id, project_id, title, kind, summary, details, artifact_ref_count, history_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        title = excluded.title,
        kind = excluded.kind,
        summary = excluded.summary,
        details = excluded.details,
        artifact_ref_count = excluded.artifact_ref_count,
        history_json = excluded.history_json,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      block.id,
      block.projectId || block.project_id || 'contextos',
      block.title,
      block.kind ?? '',
      block.summary || '',
      block.details || '',
      normalizedRefs.length,
      JSON.stringify(block.history || []),
      block.createdAt || block.created_at || new Date().toISOString(),
      block.updatedAt || block.updated_at || new Date().toISOString()
    );

    const upsertRef = this.db.prepare(`
      INSERT INTO artifact_refs (
        id, block_id, path, symbol, anchor_kind, start_line, end_line, hash, role, hash_mode, manifest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        block_id = excluded.block_id,
        path = excluded.path,
        symbol = excluded.symbol,
        anchor_kind = excluded.anchor_kind,
        start_line = excluded.start_line,
        end_line = excluded.end_line,
        hash = excluded.hash,
        role = excluded.role,
        hash_mode = excluded.hash_mode,
        manifest = excluded.manifest
    `);
    const desiredRefIds = new Set();
    for (const ref of normalizedRefs) {
      desiredRefIds.add(ref.id);
      upsertRef.run(
        ref.id,
        block.id,
        ref.path,
        ref.symbol,
        ref.anchorKind,
        ref.startLine,
        ref.endLine,
        ref.hash,
        ref.role,
        ref.hashMode,
        ref.manifest
      );
    }

    const existingRefIds = this.db
      .prepare('SELECT id FROM artifact_refs WHERE block_id = ?')
      .all(block.id)
      .map((row) => row.id);
    const deleteRef = this.db.prepare('DELETE FROM artifact_refs WHERE id = ?');
    for (const refId of existingRefIds) {
      if (!desiredRefIds.has(refId)) deleteRef.run(refId);
    }
  }

  _artifactRefFromRow(row) {
    return {
      path: row.path,
      symbol: row.symbol,
      anchorKind: row.anchor_kind || (row.symbol ? 'symbol' : 'file'),
      startLine: row.start_line,
      endLine: row.end_line,
      hash: row.hash,
      role: row.role,
      hashMode: row.hash_mode || null,
      manifest: row.manifest || null,
    };
  }

  _blockFromRow(row, artifactRefs) {
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      kind: row.kind ?? '',
      summary: row.summary,
      details: row.details,
      artifactRefs,
      history: JSON.parse(row.history_json || '[]'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getBlock(blockId) {
    const row = this.db.prepare('SELECT * FROM blocks WHERE id = ?').get(blockId);
    if (!row) return null;

    const artifactRefs = this.db
      .prepare('SELECT * FROM artifact_refs WHERE block_id = ?')
      .all(blockId)
      .map((ref) => this._artifactRefFromRow(ref));

    return this._blockFromRow(row, artifactRefs);
  }

  listBlocks(projectId) {
    const rows = projectId
      ? this.db.prepare('SELECT * FROM blocks WHERE project_id = ? ORDER BY created_at ASC').all(projectId)
      : this.db.prepare('SELECT * FROM blocks ORDER BY created_at ASC').all();
    if (rows.length === 0) return [];

    const refRows = projectId
      ? this.db.prepare(`
          SELECT artifact_refs.*
          FROM artifact_refs
          JOIN blocks ON blocks.id = artifact_refs.block_id
          WHERE blocks.project_id = ?
        `).all(projectId)
      : this.db.prepare('SELECT * FROM artifact_refs').all();
    const refsByBlock = new Map();
    for (const ref of refRows) {
      const list = refsByBlock.get(ref.block_id) || [];
      list.push(this._artifactRefFromRow(ref));
      refsByBlock.set(ref.block_id, list);
    }

    return rows.map((row) => this._blockFromRow(row, refsByBlock.get(row.id) || []));
  }

  deleteBlock(blockId) {
    this.transaction((self) => {
      self.db.exec(`
        DROP TRIGGER IF EXISTS artifact_refs_prevent_last_delete;
        DROP TRIGGER IF EXISTS blocks_require_artifact_count_update;
      `);
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
      self._ensureBlockIntegrityTriggers();
    });
    return true;
  }

  // --- Chain ---
  saveChain(chain) {
    const stmt = this.db.prepare(`
      INSERT INTO chains (
        id, project_id, title, summary, kind, member_ids_json, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        title = excluded.title,
        summary = excluded.summary,
        kind = excluded.kind,
        member_ids_json = excluded.member_ids_json,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
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
      INSERT INTO links (
        id, project_id, from_id, to_id, kind, provenance, confidence, reason, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        from_id = excluded.from_id,
        to_id = excluded.to_id,
        kind = excluded.kind,
        provenance = excluded.provenance,
        confidence = excluded.confidence,
        reason = excluded.reason,
        revision = excluded.revision,
        updated_at = excluded.updated_at
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

  getLink(linkId) {
    const row = this.db.prepare('SELECT * FROM links WHERE id = ?').get(linkId);
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      from: row.from_id,
      to: row.to_id,
      kind: row.kind,
      provenance: row.provenance,
      confidence: row.confidence,
      reason: row.reason,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
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
      INSERT INTO command_receipts (
        id, command, cwd, exit_code, duration_ms, summary, errors_json, warnings_json, changed_paths_json, log_handle, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        command = excluded.command,
        cwd = excluded.cwd,
        exit_code = excluded.exit_code,
        duration_ms = excluded.duration_ms,
        summary = excluded.summary,
        errors_json = excluded.errors_json,
        warnings_json = excluded.warnings_json,
        changed_paths_json = excluded.changed_paths_json,
        log_handle = excluded.log_handle
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
      JSON.stringify(receipt.changedPaths || []),
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
      changedPaths: JSON.parse(row.changed_paths_json || '[]'),
      logHandle: row.log_handle,
      createdAt: row.created_at,
    };
  }
}
