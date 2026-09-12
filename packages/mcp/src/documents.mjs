import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { transaction, markProjectionPending, flushProjection } from './database.mjs';

const digest = (text) => crypto.createHash('sha256').update(text).digest('hex');
export function projectFile(root, relative) {
  const file = path.resolve(root, relative);
  const rel = path.relative(fs.realpathSync(root), fs.realpathSync(file));
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('File must remain inside this project');
  return file;
}
export function documentSections(body) {
  const lines = body.split('\n');
  const sections = [];
  const used = new Map();
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { fenced = !fenced; continue; }
    const match = !fenced && lines[i].match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (!match) continue;
    const slug = match[2].toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section';
    const count = (used.get(slug) ?? 0) + 1; used.set(slug, count);
    sections.push({ id: count === 1 ? slug : `${slug}-${count}`, title: match[2], level: match[1].length, startLine: i + 1 });
  }
  return sections.map((section, i) => ({ ...section, endLine: (sections[i + 1]?.startLine ?? lines.length + 1) - 1 }));
}
function normalize(row) {
  return { id: row.id, title: row.title, kind: row.kind, status: row.status, summary: row.summary,
    body: row.body, revision: row.revision, relations: JSON.parse(row.relations_json), sourcePath: row.source_path,
    sourceHash: row.source_hash, updatedAt: row.updated_at };
}
export function listDocuments(service, { query = '' } = {}) {
  service.ensureSynced();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return service.database.prepare('SELECT * FROM documents WHERE project_id = ? ORDER BY updated_at DESC').all(service.paths.descriptor.id)
    .map(normalize).filter(d => terms.every(t => `${d.title} ${d.summary} ${d.body}`.toLowerCase().includes(t)))
    .map(({ body, ...doc }) => ({ ...doc, sections: documentSections(body) }));
}
export function openDocument(service, { id, sectionId, maxChars = 6000, revision } = {}) {
  service.ensureSynced();
  const row = service.database.prepare('SELECT * FROM documents WHERE id = ? AND project_id = ?').get(id, service.paths.descriptor.id);
  if (!row) throw new Error(`Document not found: ${id}`);
  const doc = normalize(row);
  if (revision !== undefined && revision !== doc.revision) throw new Error(`Document revision changed: expected ${revision}, current ${doc.revision}`);
  const sections = documentSections(doc.body);
  let text = doc.body;
  if (sectionId) {
    const section = sections.find(s => s.id === sectionId);
    if (!section) throw new Error('Section not found; refresh document_list');
    text = doc.body.split('\n').slice(section.startLine - 1, section.endLine).join('\n');
  }
  const budget = Math.max(200, Math.min(maxChars, 50000));
  const truncated = text.length > budget;
  const { body, ...metadata } = doc;
  return { ...metadata, sections, truncated, markdown: text.slice(0, budget),
    openURL: `contextos://knowledge?project=${encodeURIComponent(service.paths.projectRoot)}&document=${encodeURIComponent(id)}${sectionId ? `&section=${encodeURIComponent(sectionId)}` : ''}` };
}
export function writeDocument(service, { id, title, body, summary = '', kind = 'note', status = 'draft', relations = [], expectedRevision, sourcePath = null, sourceHash = null } = {}) {
  if (!id || !title?.trim() || typeof body !== 'string') throw new Error('id, title and Markdown body are required');
  if (!['note','audit','design','guide','reference'].includes(kind)) throw new Error('Invalid document kind');
  if (!['draft','review','accepted','archived'].includes(status)) throw new Error('Invalid document status');
  if (!Array.isArray(relations) || relations.some(r => typeof r !== 'string' || !/^(block|chain|decision|plan):.+/.test(r))) throw new Error('relations must contain typed entity references');
  if (body.length > 1_000_000) throw new Error('Document exceeds 1M characters; split into documents');
  service.ensureSynced();
  const db = service.database; const projectId = service.paths.descriptor.id;
  const result = transaction(db, () => {
    const current = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    if (current && current.project_id !== projectId) throw new Error('Document belongs to another project');
    if (current && expectedRevision !== current.revision) throw new Error(`Revision conflict: expected ${expectedRevision}, current ${current.revision}`);
    if (!current && expectedRevision != null && expectedRevision !== 0) throw new Error('New document requires revision 0');
    for (const ref of relations) {
      const [type, ...parts] = ref.split(':');
      const table = { block:'blocks', chain:'chains', decision:'decisions', plan:'plans' }[type];
      if (!db.prepare(`SELECT id FROM ${table} WHERE id = ? AND project_id = ?`).get(parts.join(':'), projectId)) throw new Error(`Unknown relation: ${ref}`);
    }
    const revision = (current?.revision ?? 0) + 1; const now = new Date().toISOString();
    db.prepare(`INSERT INTO documents(id,project_id,title,kind,status,summary,body,relations_json,source_path,source_hash,revision,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,kind=excluded.kind,status=excluded.status,summary=excluded.summary,
      body=excluded.body,relations_json=excluded.relations_json,source_path=excluded.source_path,source_hash=excluded.source_hash,revision=excluded.revision,updated_at=excluded.updated_at`)
      .run(id,projectId,title,kind,status,summary,body,JSON.stringify(relations),sourcePath ?? current?.source_path ?? null,sourceHash ?? current?.source_hash ?? null,revision,current?.created_at ?? now,now);
    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    db.prepare('INSERT INTO document_versions VALUES(?,?,?,?)').run(id,revision,JSON.stringify(row),now);
    db.prepare('UPDATE projects SET graph_revision=graph_revision+1, updated_at=? WHERE id=?').run(now,projectId);
    markProjectionPending(db);
    return { id, revision, changed: true };
  });
  try { flushProjection(db, service.paths.graphJsonPath); result.projection = {status:'synced'}; }
  catch (error) { result.success = false; result.projection = {status:'pending',error:error.message}; result.error = error.message; }
  return { ...result, openURL: `contextos://knowledge?project=${encodeURIComponent(service.paths.projectRoot)}&document=${encodeURIComponent(id)}` };
}
export function patchDocument(service, { id, sectionId, body, expectedRevision } = {}) {
  const doc = openDocument(service, { id, maxChars: 50000, revision: expectedRevision });
  const row = service.database.prepare('SELECT * FROM documents WHERE id=?').get(id);
  const current = normalize(row);
  const section = doc.sections.find(s => s.id === sectionId);
  if (!section) throw new Error('Section not found');
  const lines = current.body.split('\n');
  lines.splice(section.startLine - 1, section.endLine - section.startLine + 1, body);
  return writeDocument(service, { ...current, body: lines.join('\n'), expectedRevision });
}
export function importDocument(service, { relativePath, id, title, kind = 'note', expectedRevision } = {}) {
  if (path.dirname(relativePath) === '.' && /^readme(?:[_.-].*)?\.md$/i.test(path.basename(relativePath))) throw new Error('README stays in the repository and is read-only in the App');
  const body = fs.readFileSync(projectFile(service.paths.projectRoot, relativePath), 'utf8');
  return writeDocument(service, { id, title, kind, body, expectedRevision, sourcePath: relativePath, sourceHash: digest(body), status:'review' });
}
