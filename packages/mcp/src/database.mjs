import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_root TEXT NOT NULL,
  graph_revision INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  contract TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'general',
  architecture_layer TEXT NOT NULL DEFAULT 'unspecified',
  local_order INTEGER NOT NULL DEFAULT 0,
  delivery_state TEXT NOT NULL DEFAULT 'proposed',
  health_state TEXT NOT NULL DEFAULT 'unknown',
  priority TEXT NOT NULL DEFAULT 'normal',
  confidence TEXT NOT NULL DEFAULT 'confirmed',
  tags_json TEXT NOT NULL DEFAULT '[]',
  current_revision INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_refs (
  id TEXT PRIMARY KEY,
  block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  start_line INTEGER,
  end_line INTEGER,
  symbol TEXT,
  role TEXT NOT NULL DEFAULT 'implementation',
  git_commit TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS localized_text (
  entity_type TEXT NOT NULL CHECK(entity_type IN ('block', 'chain', 'link', 'plan', 'plan_step', 'chain_scope', 'plan_change', 'checkpoint')),
  entity_id TEXT NOT NULL,
  locale TEXT NOT NULL CHECK(locale IN ('en', 'zh-Hans')),
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(entity_type, entity_id, locale, field)
);

CREATE TABLE IF NOT EXISTS chains (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'feature',
  intent TEXT NOT NULL DEFAULT '',
  input_contract TEXT NOT NULL DEFAULT '',
  output_contract TEXT NOT NULL DEFAULT '',
  delivery_state TEXT NOT NULL DEFAULT 'planned',
  health_state TEXT NOT NULL DEFAULT 'unknown',
  priority TEXT NOT NULL DEFAULT 'normal',
  current_revision INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  priority TEXT NOT NULL DEFAULT 'normal',
  phase TEXT NOT NULL DEFAULT 'implementation',
  plan_order INTEGER NOT NULL DEFAULT 0,
  proposed_delta_json TEXT NOT NULL DEFAULT '[]',
  completion_policy_json TEXT NOT NULL DEFAULT '{}',
  next_action TEXT NOT NULL DEFAULT '',
  blockers_json TEXT NOT NULL DEFAULT '[]',
  status_reason TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  completed_at TEXT,
  invalidated_at TEXT,
  current_revision INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_chain_refs (
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  chain_id TEXT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(plan_id, chain_id)
);

CREATE TABLE IF NOT EXISTS plan_dependencies (
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  depends_on_plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(plan_id, depends_on_plan_id),
  CHECK(plan_id != depends_on_plan_id)
);

CREATE TABLE IF NOT EXISTS plan_steps (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  target_refs_json TEXT NOT NULL DEFAULT '[]',
  proposed_delta_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_checkpoint_refs (
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  step_id TEXT REFERENCES plan_steps(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  required INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(plan_id, checkpoint_id)
);

CREATE TABLE IF NOT EXISTS plan_chain_scopes (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  chain_id TEXT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  rationale TEXT NOT NULL DEFAULT '',
  start_block_id TEXT REFERENCES blocks(id) ON DELETE SET NULL,
  end_block_id TEXT REFERENCES blocks(id) ON DELETE SET NULL,
  node_ids_json TEXT NOT NULL DEFAULT '[]',
  link_ids_json TEXT NOT NULL DEFAULT '[]',
  expected_delta_json TEXT NOT NULL DEFAULT '[]',
  prohibitions_json TEXT NOT NULL DEFAULT '[]',
  localizations_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  current_revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(plan_id, chain_id, id)
);

CREATE TABLE IF NOT EXISTS plan_changes (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('block', 'link', 'chain')),
  entity_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  current_behavior TEXT NOT NULL DEFAULT '',
  proposed_behavior TEXT NOT NULL DEFAULT '',
  rationale TEXT NOT NULL DEFAULT '',
  prohibitions_json TEXT NOT NULL DEFAULT '[]',
  expected_effects_json TEXT NOT NULL DEFAULT '[]',
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  localizations_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  current_revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(plan_id, entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS plan_chain_change_refs (
  chain_scope_id TEXT NOT NULL REFERENCES plan_chain_scopes(id) ON DELETE CASCADE,
  plan_change_id TEXT NOT NULL REFERENCES plan_changes(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'affected',
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(chain_scope_id, plan_change_id)
);

CREATE TABLE IF NOT EXISTS chain_members (
  chain_id TEXT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
  member_type TEXT NOT NULL CHECK(member_type IN ('block', 'chain')),
  member_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(chain_id, member_type, member_id)
);

CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK(source_type IN ('block', 'chain')),
  source_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK(target_type IN ('block', 'chain')),
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  contract TEXT NOT NULL DEFAULT '',
  health_state TEXT NOT NULL DEFAULT 'unknown',
  current_revision INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chain_nodes (
  chain_id TEXT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'path',
  PRIMARY KEY(chain_id, block_id)
);

CREATE TABLE IF NOT EXISTS chain_edges (
  chain_id TEXT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
  link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(chain_id, link_id)
);

CREATE TABLE IF NOT EXISTS background_scopes (
  block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK(scope_type IN ('project', 'lens', 'chain', 'repo')),
  scope_value TEXT NOT NULL DEFAULT '*',
  PRIMARY KEY(block_id, scope_type, scope_value)
);

-- Decisions are durable architecture memory, not Canvas nodes.  Their scope
-- index mirrors Background rules so normal context reads can return only the
-- applicable title/status while entity_open/decision_open expands the body.
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  rationale TEXT NOT NULL DEFAULT '',
  alternatives_json TEXT NOT NULL DEFAULT '[]',
  consequences_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('proposed', 'active', 'superseded', 'reconsidered')),
  supersedes_decision_id TEXT REFERENCES decisions(id) ON DELETE SET NULL,
  current_revision INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_scopes (
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK(scope_type IN ('project', 'lens', 'chain', 'repo')),
  scope_value TEXT NOT NULL DEFAULT '*',
  PRIMARY KEY(decision_id, scope_type, scope_value)
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK(target_type IN ('block', 'chain', 'link', 'plan')),
  target_id TEXT NOT NULL,
  title TEXT NOT NULL,
  criteria TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  checkpoint_kind TEXT NOT NULL DEFAULT 'atomic',
  aggregation_policy_json TEXT NOT NULL DEFAULT '{}',
  eligible_after_children INTEGER NOT NULL DEFAULT 0,
  evidence_level TEXT NOT NULL DEFAULT 'none',
  required_evidence_level TEXT NOT NULL DEFAULT 'static',
  coverage TEXT NOT NULL DEFAULT 'complete',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  invalidated_at TEXT,
  current_revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoint_bindings (
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('block', 'link', 'chain', 'plan', 'plan_change', 'plan_chain_scope')),
  subject_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'leaf',
  required INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(checkpoint_id, subject_type, subject_id, role)
);

CREATE TABLE IF NOT EXISTS checkpoint_dependencies (
  parent_checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  child_checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  required INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(parent_checkpoint_id, child_checkpoint_id),
  CHECK(parent_checkpoint_id != child_checkpoint_id)
);

CREATE TABLE IF NOT EXISTS change_sets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  task TEXT NOT NULL DEFAULT '',
  git_head TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_set_id TEXT NOT NULL REFERENCES change_sets(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  revision INTEGER NOT NULL,
  summary TEXT NOT NULL,
  plan_id TEXT,
  chain_scope_id TEXT,
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json TEXT NOT NULL DEFAULT '{}',
  changed_fields_json TEXT NOT NULL DEFAULT '[]',
  affected_refs_json TEXT NOT NULL DEFAULT '[]',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS change_feed (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  change_set_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blocks_project ON blocks(project_id, archived);
CREATE INDEX IF NOT EXISTS idx_chains_project ON chains(project_id, archived);
CREATE INDEX IF NOT EXISTS idx_links_project ON links(project_id, archived);
CREATE INDEX IF NOT EXISTS idx_plans_project ON plans(project_id, archived, status);
CREATE INDEX IF NOT EXISTS idx_plan_chain_refs_plan ON plan_chain_refs(plan_id, position);
CREATE INDEX IF NOT EXISTS idx_plan_dependencies_plan ON plan_dependencies(plan_id, position);
CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps(plan_id, position);
CREATE INDEX IF NOT EXISTS idx_plan_checkpoint_refs_plan ON plan_checkpoint_refs(plan_id, position);
CREATE INDEX IF NOT EXISTS idx_plan_chain_scopes_plan ON plan_chain_scopes(plan_id, position);
CREATE INDEX IF NOT EXISTS idx_plan_changes_plan ON plan_changes(plan_id, position);
CREATE INDEX IF NOT EXISTS idx_plan_chain_change_refs_scope ON plan_chain_change_refs(chain_scope_id, position);
CREATE INDEX IF NOT EXISTS idx_chain_nodes_chain ON chain_nodes(chain_id, position);
CREATE INDEX IF NOT EXISTS idx_chain_edges_chain ON chain_edges(chain_id, position);
CREATE INDEX IF NOT EXISTS idx_background_scopes_block ON background_scopes(block_id);
CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_id, archived, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_scopes_decision ON decision_scopes(decision_id, scope_type, scope_value);
CREATE INDEX IF NOT EXISTS idx_checkpoints_target ON checkpoints(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_checkpoint_bindings_subject ON checkpoint_bindings(subject_type, subject_id, position);
CREATE INDEX IF NOT EXISTS idx_checkpoint_dependencies_parent ON checkpoint_dependencies(parent_checkpoint_id, position);
CREATE INDEX IF NOT EXISTS idx_history_entity ON history(entity_type, entity_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_change_feed_project ON change_feed(project_id, sequence DESC);
CREATE INDEX IF NOT EXISTS idx_localized_text_entity ON localized_text(entity_type, entity_id, locale);

CREATE TABLE IF NOT EXISTS sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function tableSql(database, name) {
  return database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)?.sql ?? "";
}

function migratePlanCapableTables(database) {
  const localizedSql = tableSql(database, "localized_text");
  const checkpointSql = tableSql(database, "checkpoints");
  if (localizedSql.includes("'plan_change'") && checkpointSql.includes("'plan'")) return;
  database.exec("PRAGMA foreign_keys = OFF;");
  try {
    database.exec("BEGIN IMMEDIATE;");
    if (!localizedSql.includes("'plan_change'")) {
      database.exec(`
        DROP INDEX IF EXISTS idx_localized_text_entity;
        CREATE TABLE localized_text_v2 (
          entity_type TEXT NOT NULL CHECK(entity_type IN ('block', 'chain', 'link', 'plan', 'plan_step', 'chain_scope', 'plan_change', 'checkpoint')),
          entity_id TEXT NOT NULL,
          locale TEXT NOT NULL CHECK(locale IN ('en', 'zh-Hans')),
          field TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(entity_type, entity_id, locale, field)
        );
        INSERT INTO localized_text_v2 SELECT * FROM localized_text;
        DROP TABLE localized_text;
        ALTER TABLE localized_text_v2 RENAME TO localized_text;
      `);
    }
    if (!checkpointSql.includes("'plan'")) {
      database.exec(`
        DROP INDEX IF EXISTS idx_checkpoints_target;
        CREATE TABLE checkpoints_v2 (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          target_type TEXT NOT NULL CHECK(target_type IN ('block', 'chain', 'link', 'plan')),
          target_id TEXT NOT NULL,
          title TEXT NOT NULL,
          criteria TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending',
          evidence_json TEXT NOT NULL DEFAULT '[]',
          current_revision INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO checkpoints_v2 SELECT * FROM checkpoints;
        DROP TABLE checkpoints;
        ALTER TABLE checkpoints_v2 RENAME TO checkpoints;
      `);
    }
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON;");
  }
  database.exec("CREATE INDEX IF NOT EXISTS idx_localized_text_entity ON localized_text(entity_type, entity_id, locale);");
  database.exec("CREATE INDEX IF NOT EXISTS idx_checkpoints_target ON checkpoints(target_type, target_id);");
}

function migrateBlockArchitecture(database) {
  const columns = new Set(
    database.prepare("PRAGMA table_info(blocks)").all().map((column) => column.name),
  );
  if (!columns.has("scope")) {
    database.exec("ALTER TABLE blocks ADD COLUMN scope TEXT NOT NULL DEFAULT 'general';");
  }
  if (!columns.has("architecture_layer")) {
    database.exec("ALTER TABLE blocks ADD COLUMN architecture_layer TEXT NOT NULL DEFAULT 'unspecified';");
  }
  if (!columns.has("local_order")) {
    database.exec("ALTER TABLE blocks ADD COLUMN local_order INTEGER NOT NULL DEFAULT 0;");
  }
}

function addColumnIfMissing(database, table, column, definition) {
  const columns = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name));
  if (!columns.has(column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

function migratePlanWorkflow(database) {
  addColumnIfMissing(database, "plans", "phase", "TEXT NOT NULL DEFAULT 'implementation'");
  addColumnIfMissing(database, "plans", "plan_order", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(database, "plans", "completion_policy_json", "TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(database, "plans", "status_reason", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(database, "plans", "started_at", "TEXT");
  addColumnIfMissing(database, "plans", "completed_at", "TEXT");
  addColumnIfMissing(database, "plans", "invalidated_at", "TEXT");
  addColumnIfMissing(database, "checkpoints", "evidence_level", "TEXT NOT NULL DEFAULT 'none'");
  addColumnIfMissing(database, "checkpoints", "required_evidence_level", "TEXT NOT NULL DEFAULT 'static'");
  addColumnIfMissing(database, "checkpoints", "coverage", "TEXT NOT NULL DEFAULT 'complete'");
  addColumnIfMissing(database, "checkpoints", "invalidated_at", "TEXT");
  addColumnIfMissing(database, "checkpoints", "checkpoint_kind", "TEXT NOT NULL DEFAULT 'atomic'");
  addColumnIfMissing(database, "checkpoints", "aggregation_policy_json", "TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(database, "checkpoints", "eligible_after_children", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(database, "history", "plan_id", "TEXT");
  addColumnIfMissing(database, "history", "chain_scope_id", "TEXT");
  addColumnIfMissing(database, "history", "before_json", "TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(database, "history", "after_json", "TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(database, "history", "changed_fields_json", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(database, "history", "affected_refs_json", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(database, "history", "evidence_refs_json", "TEXT NOT NULL DEFAULT '[]'");
  database.exec(`
    CREATE TABLE IF NOT EXISTS plan_dependencies (
      plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      depends_on_plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(plan_id, depends_on_plan_id),
      CHECK(plan_id != depends_on_plan_id)
    );
    CREATE TABLE IF NOT EXISTS plan_steps (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      action TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      target_refs_json TEXT NOT NULL DEFAULT '[]',
      proposed_delta_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plan_checkpoint_refs (
      plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
      step_id TEXT REFERENCES plan_steps(id) ON DELETE SET NULL,
      position INTEGER NOT NULL DEFAULT 0,
      required INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(plan_id, checkpoint_id)
    );
    CREATE TABLE IF NOT EXISTS plan_chain_scopes (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      chain_id TEXT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      rationale TEXT NOT NULL DEFAULT '',
      start_block_id TEXT REFERENCES blocks(id) ON DELETE SET NULL,
      end_block_id TEXT REFERENCES blocks(id) ON DELETE SET NULL,
      node_ids_json TEXT NOT NULL DEFAULT '[]',
      link_ids_json TEXT NOT NULL DEFAULT '[]',
      expected_delta_json TEXT NOT NULL DEFAULT '[]',
      prohibitions_json TEXT NOT NULL DEFAULT '[]',
      localizations_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      current_revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(plan_id, chain_id, id)
    );
    CREATE TABLE IF NOT EXISTS plan_changes (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('block', 'link', 'chain')),
      entity_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      current_behavior TEXT NOT NULL DEFAULT '',
      proposed_behavior TEXT NOT NULL DEFAULT '',
      rationale TEXT NOT NULL DEFAULT '',
      prohibitions_json TEXT NOT NULL DEFAULT '[]',
      expected_effects_json TEXT NOT NULL DEFAULT '[]',
      source_refs_json TEXT NOT NULL DEFAULT '[]',
      localizations_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      current_revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(plan_id, entity_type, entity_id)
    );
    CREATE TABLE IF NOT EXISTS plan_chain_change_refs (
      chain_scope_id TEXT NOT NULL REFERENCES plan_chain_scopes(id) ON DELETE CASCADE,
      plan_change_id TEXT NOT NULL REFERENCES plan_changes(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'affected',
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(chain_scope_id, plan_change_id)
    );
    CREATE TABLE IF NOT EXISTS checkpoint_bindings (
      checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
      subject_type TEXT NOT NULL CHECK(subject_type IN ('block', 'link', 'chain', 'plan', 'plan_change', 'plan_chain_scope')),
      subject_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'leaf',
      required INTEGER NOT NULL DEFAULT 1,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(checkpoint_id, subject_type, subject_id, role)
    );
    CREATE TABLE IF NOT EXISTS checkpoint_dependencies (
      parent_checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
      child_checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      required INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(parent_checkpoint_id, child_checkpoint_id),
      CHECK(parent_checkpoint_id != child_checkpoint_id)
    );
    CREATE INDEX IF NOT EXISTS idx_plan_dependencies_plan ON plan_dependencies(plan_id, position);
    CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps(plan_id, position);
    CREATE INDEX IF NOT EXISTS idx_plan_checkpoint_refs_plan ON plan_checkpoint_refs(plan_id, position);
    CREATE INDEX IF NOT EXISTS idx_plan_chain_scopes_plan ON plan_chain_scopes(plan_id, position);
    CREATE INDEX IF NOT EXISTS idx_plan_changes_plan ON plan_changes(plan_id, position);
    CREATE INDEX IF NOT EXISTS idx_plan_chain_change_refs_scope ON plan_chain_change_refs(chain_scope_id, position);
    CREATE INDEX IF NOT EXISTS idx_checkpoint_bindings_subject ON checkpoint_bindings(subject_type, subject_id, position);
    CREATE INDEX IF NOT EXISTS idx_checkpoint_dependencies_parent ON checkpoint_dependencies(parent_checkpoint_id, position);
  `);
}

function backfillChainPaths(database) {
  const legacyMemberCount = database.prepare("SELECT COUNT(*) AS count FROM chain_members").get().count;
  if (legacyMemberCount > 0) {
    database.exec(`
      INSERT OR IGNORE INTO chain_nodes(chain_id, block_id, position, role)
      SELECT chain_id, member_id, position, 'path'
      FROM chain_members WHERE member_type = 'block';
      DELETE FROM chain_members;
    `);
  }

  const missingEdgeCount = database.prepare(`
    SELECT COUNT(*) AS count
    FROM chain_nodes source
    JOIN chain_nodes target
      ON target.chain_id = source.chain_id AND target.position = source.position + 1
    JOIN links
      ON links.source_type = 'block' AND links.source_id = source.block_id
     AND links.target_type = 'block' AND links.target_id = target.block_id
    WHERE links.archived = 0
      AND NOT EXISTS (SELECT 1 FROM chain_edges existing WHERE existing.chain_id = source.chain_id)
  `).get().count;
  if (missingEdgeCount > 0) {
    database.exec(`
      INSERT OR IGNORE INTO chain_edges(chain_id, link_id, position)
      SELECT source.chain_id, links.id, source.position
      FROM chain_nodes source
      JOIN chain_nodes target
        ON target.chain_id = source.chain_id AND target.position = source.position + 1
      JOIN links
        ON links.source_type = 'block' AND links.source_id = source.block_id
       AND links.target_type = 'block' AND links.target_id = target.block_id
      WHERE links.archived = 0
        AND NOT EXISTS (SELECT 1 FROM chain_edges existing WHERE existing.chain_id = source.chain_id);
    `);
  }
}

export function openDatabase(databasePath) {
  const database = new DatabaseSync(databasePath);
  // Configure the busy handler before changing journal mode. Multiple MCP
  // processes can open the same project at once; journal-mode negotiation
  // needs the same bounded wait as normal read/write transactions.
  database.exec("PRAGMA busy_timeout = 3000;");
  // The canonical project graph is versioned with the repository. DELETE mode
  // keeps every committed mutation in the tracked database file instead of a
  // private WAL that Git cannot restore with the rest of the checkout.
  database.exec("PRAGMA journal_mode = DELETE;");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(SCHEMA);
  migratePlanCapableTables(database);
  migrateBlockArchitecture(database);
  migratePlanWorkflow(database);
  backfillChainPaths(database);
  return database;
}

export function transaction(database, callback) {
  database.exec("BEGIN IMMEDIATE;");
  try {
    const result = callback();
    database.exec("COMMIT;");
    return result;
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

export const GRAPH_TABLES = [
  { name: "projects", orderBy: "id" },
  { name: "blocks", orderBy: "id" },
  { name: "source_refs", orderBy: "block_id, id" },
  { name: "chains", orderBy: "id" },
  { name: "chain_nodes", orderBy: "chain_id, position, block_id" },
  { name: "chain_edges", orderBy: "chain_id, position, link_id" },
  { name: "links", orderBy: "id" },
  { name: "background_scopes", orderBy: "block_id, scope_type, scope_value" },
  { name: "decisions", orderBy: "id" },
  { name: "decision_scopes", orderBy: "decision_id, scope_type, scope_value" },
  { name: "plans", orderBy: "id" },
  { name: "plan_chain_refs", orderBy: "plan_id, chain_id" },
  { name: "plan_dependencies", orderBy: "plan_id, depends_on_plan_id" },
  { name: "plan_steps", orderBy: "plan_id, position, id" },
  { name: "plan_checkpoint_refs", orderBy: "plan_id, checkpoint_id" },
  { name: "plan_chain_scopes", orderBy: "plan_id, position, id" },
  { name: "plan_changes", orderBy: "plan_id, position, id" },
  { name: "plan_chain_change_refs", orderBy: "chain_scope_id, plan_change_id" },
  { name: "checkpoints", orderBy: "id" },
  { name: "checkpoint_bindings", orderBy: "checkpoint_id, position, subject_type, subject_id, role" },
  { name: "checkpoint_dependencies", orderBy: "parent_checkpoint_id, position, child_checkpoint_id" },
  { name: "localized_text", orderBy: "entity_type, entity_id, locale, field" },
];

export function sortObjectKeys(obj) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return sorted;
}

export function queryRecentHistory(database, limit = 50) {
  const changeSets = database.prepare(
    `SELECT * FROM (SELECT * FROM change_sets ORDER BY created_at DESC, id DESC LIMIT ?) ORDER BY created_at ASC, id ASC`,
  ).all(limit);

  const changeSetIds = changeSets.map((cs) => cs.id);
  if (changeSetIds.length === 0) {
    return { changeSets: [], history: [], changeFeed: [] };
  }

  const placeholders = changeSetIds.map(() => "?").join(", ");
  const history = database.prepare(
    `SELECT * FROM history WHERE change_set_id IN (${placeholders}) ORDER BY id ASC`,
  ).all(...changeSetIds);

  const changeFeed = database.prepare(
    `SELECT * FROM change_feed WHERE change_set_id IN (${placeholders}) ORDER BY sequence ASC`,
  ).all(...changeSetIds);

  return { changeSets, history, changeFeed };
}

export function exportGraphToJson(database, jsonPath, options = {}) {
  const limit = options.maxChangeSets ?? 50;
  const project = database.prepare("SELECT * FROM projects LIMIT 1").get();
  const exportData = {};

  for (const { name, orderBy } of GRAPH_TABLES) {
    const rows = database.prepare(`SELECT * FROM ${name} ORDER BY ${orderBy}`).all();
    exportData[name] = rows.map(sortObjectKeys);
  }

  const { changeSets, history, changeFeed } = queryRecentHistory(database, limit);
  exportData.change_sets = changeSets.map(sortObjectKeys);
  exportData.history = history.map(sortObjectKeys);
  exportData.change_feed = changeFeed.map(sortObjectKeys);

  const payload = {
    version: 1,
    projectId: project?.id ?? "",
    graphRevision: project?.graph_revision ?? 0,
    exportedAt: project?.updated_at ?? new Date().toISOString(),
    data: exportData,
  };

  const jsonString = `${JSON.stringify(payload, null, 2)}\n`;
  const hash = crypto.createHash("sha256").update(jsonString).digest("hex");

  const directory = path.dirname(jsonPath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = `${jsonPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporaryPath, jsonString, "utf8");
  fs.renameSync(temporaryPath, jsonPath);

  const stat = fs.statSync(jsonPath);
  try {
    database.prepare(`
      INSERT INTO sync_meta(key, value) VALUES ('graph_json_hash', ?), ('graph_json_mtime', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(hash, String(stat.mtimeMs));
  } catch {
    // If sync_meta doesn't exist yet, ignore
  }

  return { jsonPath, hash, graphRevision: payload.graphRevision, mtimeMs: stat.mtimeMs };
}

export function importGraphFromJson(database, jsonPath) {
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`graph.json not found at ${jsonPath}`);
  }
  const content = fs.readFileSync(jsonPath, "utf8");
  const payload = JSON.parse(content);
  if (!payload || !payload.data || typeof payload.data !== "object") {
    throw new Error(`Invalid graph.json at ${jsonPath}: missing data object`);
  }

  const stat = fs.statSync(jsonPath);
  const hash = crypto.createHash("sha256").update(content).digest("hex");

  database.exec("PRAGMA foreign_keys = OFF;");
  try {
    database.exec("BEGIN IMMEDIATE;");

    const allTables = [
      ...GRAPH_TABLES.map((t) => t.name),
      "change_sets",
      "history",
      "change_feed",
    ];

    for (const table of allTables) {
      database.exec(`DELETE FROM ${table};`);
      const rows = payload.data[table] ?? [];
      if (rows.length > 0) {
        const cols = Object.keys(rows[0]);
        const placeholders = cols.map(() => "?").join(", ");
        const stmt = database.prepare(
          `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`,
        );
        for (const row of rows) {
          stmt.run(...cols.map((c) => row[c]));
        }
      }
    }

    database.prepare(`
      INSERT INTO sync_meta(key, value) VALUES ('graph_json_hash', ?), ('graph_json_mtime', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(hash, String(stat.mtimeMs));

    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON;");
  }

  return { jsonPath, hash, graphRevision: payload.graphRevision, mtimeMs: stat.mtimeMs };
}

export function getSyncMeta(database) {
  try {
    const rows = database.prepare("SELECT key, value FROM sync_meta").all();
    const meta = {};
    for (const row of rows) {
      meta[row.key] = row.value;
    }
    return meta;
  } catch {
    return {};
  }
}

export function setSyncMeta(database, key, value) {
  try {
    database.prepare(`
      INSERT INTO sync_meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  } catch {
    // ignore
  }
}

