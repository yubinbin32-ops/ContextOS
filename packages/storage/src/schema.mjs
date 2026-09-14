export const V2_SQL_SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  repo_root TEXT NOT NULL,
  graph_revision INTEGER NOT NULL DEFAULT 0,
  exported_at TEXT,
  schema_version INTEGER NOT NULL DEFAULT 2
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'active',
  summary TEXT NOT NULL DEFAULT '',
  completed_summary TEXT,
  history_ref TEXT,
  rule_refs_json TEXT NOT NULL DEFAULT '[]',
  decision_refs_json TEXT NOT NULL DEFAULT '[]',
  dependency_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS phases (
  id TEXT NOT NULL,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  phase_order INTEGER NOT NULL DEFAULT 0,
  objective TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT '',
  deliverables_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  task_ids_json TEXT NOT NULL DEFAULT '[]',
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (id, plan_id)
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  phase_id TEXT,
  title TEXT NOT NULL,
  criteria TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  phase_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  context_slice_json TEXT NOT NULL DEFAULT '{}',
  working_set_json TEXT NOT NULL DEFAULT '{}',
  references_json TEXT NOT NULL DEFAULT '{}',
  baseline_json TEXT NOT NULL DEFAULT '{}',
  notes_json TEXT NOT NULL DEFAULT '[]',
  checks_json TEXT NOT NULL DEFAULT '[]',
  sync_result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  history_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifact_refs (
  id TEXT PRIMARY KEY,
  block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  symbol TEXT,
  start_line INTEGER,
  end_line INTEGER,
  hash TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'implementation'
);

CREATE TABLE IF NOT EXISTS chains (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'leaf',
  member_ids_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'depends_on',
  provenance TEXT NOT NULL DEFAULT 'authored',
  confidence REAL NOT NULL DEFAULT 1.0,
  reason TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS command_receipts (
  id TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  duration_ms REAL NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  errors_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  log_handle TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
