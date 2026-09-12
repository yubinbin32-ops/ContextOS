export const WORKSPACE_SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
 kind TEXT NOT NULL DEFAULT 'note', status TEXT NOT NULL DEFAULT 'draft',
 summary TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
 relations_json TEXT NOT NULL DEFAULT '[]', source_path TEXT,
 source_hash TEXT, revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS document_versions (
 document_id TEXT NOT NULL, revision INTEGER NOT NULL, payload_json TEXT NOT NULL,
 created_at TEXT NOT NULL, PRIMARY KEY(document_id, revision)
);
CREATE TABLE IF NOT EXISTS task_sessions (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, intent TEXT NOT NULL,
 scope_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
 source_revision TEXT, result_json TEXT, idempotency_key TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checkpoint_runtime (
 checkpoint_id TEXT PRIMARY KEY, checkpoint_revision INTEGER NOT NULL, status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_index (
 path TEXT PRIMARY KEY, file_hash TEXT NOT NULL, symbols_json TEXT NOT NULL,
 revision INTEGER NOT NULL, supported INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sync_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL,
 kind TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_issues (
 id TEXT PRIMARY KEY, task_id TEXT, kind TEXT NOT NULL, target TEXT NOT NULL,
 detail TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', updated_at TEXT NOT NULL
);
`;
