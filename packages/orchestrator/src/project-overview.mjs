import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { V2Database } from '../../storage/src/database.mjs';
import { SessionStore } from './session-store.mjs';

// First contact is bounded local navigation, never semantic discovery or graph bootstrap.
const cache = new Map();
const MAX_BYTES = 64 * 1024;
const SESSION_MAX_BYTES = 256 * 1024;
const MAX_PACKAGES = 24;
const MAX_BLOCKS = 16;
const STALE_MS = 6 * 60 * 60 * 1000;
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const short = (value, max = 160) => String(value || '').slice(0, max);
const inside = (root, target) => target === root || target.startsWith(root + path.sep);

function safePath(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) return null;
  const target = path.resolve(root, relative);
  if (!inside(root, target)) return null;
  try { if (!inside(root, fs.realpathSync(target))) return null; } catch {}
  return target;
}
function read(root, relative, maxBytes = MAX_BYTES) {
  const target = safePath(root, relative);
  if (!target) return null;
  let fd;
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile()) return null;
    fd = fs.openSync(target, 'r');
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return { text: buffer.subarray(0, length).toString('utf8'), truncated: stat.size > maxBytes };
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function json(root, relative, maxBytes) {
  const file = read(root, relative, maxBytes);
  if (!file || file.truncated) return null;
  try { return JSON.parse(file.text); } catch { return null; }
}
function stamp(root, relative) {
  const target = safePath(root, relative);
  if (!target) return [relative, 'outside'];
  try { const s = fs.statSync(target); return [relative, s.size, s.mtimeMs, s.ctimeMs]; }
  catch { return [relative, 'missing']; }
}
function packagePaths(root, manifest) {
  const paths = ['package.json'];
  const patterns = Array.isArray(manifest?.workspaces) ? manifest.workspaces : manifest?.workspaces?.packages || [];
  for (const pattern of patterns.slice(0, MAX_PACKAGES)) {
    if (typeof pattern !== 'string') continue;
    if (!pattern.includes('*')) { paths.push(path.posix.join(pattern, 'package.json')); continue; }
    // Only one directory listing for a declared single-level workspace glob.
    if (!pattern.endsWith('/*') || pattern.slice(0, -2).includes('*')) continue;
    const prefix = pattern.slice(0, -2);
    const target = safePath(root, prefix);
    if (!target) continue;
    try {
      for (const entry of fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory()) paths.push(path.posix.join(prefix, entry.name, 'package.json'));
        if (paths.length > MAX_PACKAGES) break;
      }
    } catch {}
    if (paths.length > MAX_PACKAGES) break;
  }
  return [...new Set(paths)].slice(0, MAX_PACKAGES + 1);
}
function entryStrings(value, values = []) {
  if (typeof value === 'string' && values.length < 32) values.push(value);
  else if (value && typeof value === 'object') for (const child of Object.values(value).slice(0, 32)) entryStrings(child, values);
  return values;
}
function loadState(root, gaps, inputRoot = root) {
  const marker = json(root, '.contextos/project.json');
  const graphFile = read(root, '.contextos/graph.json', 4 * 1024 * 1024);
  let graph;
  if (graphFile && !graphFile.truncated) {
    try { graph = JSON.parse(graphFile.text); } catch { gaps.push('Graph JSON is invalid; local manifest navigation remains available.'); }
  } else if (graphFile?.truncated) gaps.push('Graph exceeds the 4 MiB first-contact budget.');
  let state = { blocks: [], chains: [], plans: [], tasks: [] };
  let runtimeRevision = null;
  let runtimeProjectId = null;
  for (const field of ['blocks', 'chains', 'plans', 'tasks']) {
    if (graph?.data?.[field] !== undefined && !Array.isArray(graph.data[field])) gaps.push('Invalid graph projection data.' + field + ': expected an array.');
  }
  const dbPath = safePath(root, '.contextos/state.sqlite');
  if (dbPath && fs.existsSync(dbPath)) {
    let db;
    try {
      // Reuse storage mappings without constructor migrations or any write.
      db = Object.create(V2Database.prototype);
      db.db = new DatabaseSync(dbPath, { readOnly: true });
      const projectId = marker?.id || graph?.projectId;
      const aliasRoot = root.replace(/^\/private(?=\/(?:tmp|var)\/)/, '');
      const projects = db.db.prepare('SELECT * FROM projects WHERE id=? OR repo_root IN (?,?,?) LIMIT 3').all(projectId || '', root, path.resolve(inputRoot), aliasRoot);
      const sameRoot = (p) => { try { return fs.realpathSync(p.repo_root) === root; } catch { return false; } };
      const project = projects.find((p) => p.id === projectId && sameRoot(p)) || projects.find(sameRoot);
      if (project) {
        const lastHash = db.getSyncState('last_exported_hash:' + project.id) || db.getSyncState('last_exported_hash');
        // SQLite is the current runtime state. A projection divergence is
        // actionable context, never silently imported by this read-only entry.
        if (graphFile && (!lastHash || digest(graphFile.text) !== lastHash)) gaps.push('Graph projection differs from current runtime state; use ContextOS reconciliation before graph mutations.');
        const activeClause = `p.status='active' AND (
          EXISTS (SELECT 1 FROM tasks t WHERE t.plan_id=p.id AND t.status IN ('active','checking','syncing'))
          OR (p.updated_at >= ? AND NOT (
            EXISTS (SELECT 1 FROM checkpoints c WHERE c.plan_id=p.id)
            AND NOT EXISTS (SELECT 1 FROM checkpoints c WHERE c.plan_id=p.id AND c.status!='passed')
          )))`;
        const cutoff = new Date(Date.now() - STALE_MS).toISOString();
        const plans = db.db.prepare(`SELECT p.id,p.title,p.status,substr(p.summary,1,160) AS summary,p.updated_at AS updatedAt
          FROM plans p WHERE p.project_id=? AND ${activeClause} ORDER BY p.updated_at DESC,p.id LIMIT 5`).all(project.id, cutoff);
        const tasks = plans.flatMap((p) => db.db.prepare(`SELECT id,plan_id AS planId,title,status,substr(context_slice_json,1,4096) AS context
          FROM tasks WHERE plan_id=? AND status IN ('draft','pending','active','checking','syncing','blocked')
          ORDER BY CASE WHEN status IN ('active','checking','syncing') THEN 0 ELSE 1 END,updated_at DESC LIMIT 8`).all(p.id))
          .slice(0, 8).map((t) => { let contextSlice = {}; try { contextSlice = JSON.parse(t.context); } catch {} return { ...t, contextSlice }; });
        const blocks = db.db.prepare(`SELECT id,project_id,title,kind,substr(summary,1,160) AS summary
          FROM blocks WHERE project_id=? AND id NOT LIKE 'mod-%' AND kind!='module' ORDER BY created_at,id LIMIT ?`).all(project.id, MAX_BLOCKS)
          .map((row) => {
            const refs = db.db.prepare('SELECT path,symbol,anchor_kind,start_line,end_line,hash FROM artifact_refs WHERE block_id=? GROUP BY path ORDER BY start_line,path LIMIT 2').all(row.id).map((r) => db._artifactRefFromRow(r));
            const block = db._blockFromRow(row, refs);
            block.chainIds = db.db.prepare(`SELECT c.id FROM chains c WHERE c.project_id=? AND EXISTS
              (SELECT 1 FROM json_each(c.member_ids_json) m WHERE m.value=?) ORDER BY c.created_at,c.id LIMIT 16`).all(project.id, row.id).map((c) => c.id);
            return block;
          });
        const chains = db.db.prepare('SELECT id,substr(title,1,100) AS title FROM chains WHERE project_id=? ORDER BY created_at,id LIMIT 16').all(project.id)
          .map((c) => ({ ...c, memberIds: db.db.prepare('SELECT value FROM json_each((SELECT member_ids_json FROM chains WHERE id=?)) LIMIT 16').all(c.id).map((m) => m.value) }));
        const blockCount = db.db.prepare("SELECT count(*) AS n FROM blocks WHERE project_id=? AND id NOT LIKE 'mod-%' AND kind!='module'").get(project.id).n;
        const chainCount = db.db.prepare('SELECT count(*) AS n FROM chains WHERE project_id=?').get(project.id).n;
        state = { blocks, chains, plans, tasks, counts: { blockCount, chainCount } };
        runtimeRevision = project.graph_revision;
        runtimeProjectId = project.id;
      }
    } catch { gaps.push('Stored database unavailable; manifest navigation remains available.'); }
    finally { db?.db?.close(); }
  }
  if (graph && runtimeRevision === null) gaps.push('Graph projection exists without available runtime state; use ContextOS reconciliation for architecture navigation.');
  return { state, projectId: runtimeProjectId || marker?.id || graph?.projectId || json(root, 'package.json')?.name || path.basename(root), revision: runtimeRevision };
}
function activeState(state, now) {
  const live = new Set(['active', 'checking', 'syncing']);
  const allTasks = Array.isArray(state.tasks) ? state.tasks : [];
  const plans = (state.plans || []).filter((p) => {
    if (p.status !== 'active') return false;
    const tasks = allTasks.filter((t) => t.planId === p.id);
    if (tasks.some((t) => live.has(t.status))) return true;
    const age = now - Date.parse(p.updatedAt || p.createdAt || '');
    const passed = p.checkpoints?.length && p.checkpoints.every((c) => c.status === 'passed');
    return !passed && Number.isFinite(age) && age <= STALE_MS;
  });
  const ids = new Set(plans.map((p) => p.id));
  return { plans, tasks: allTasks.filter((t) => ids.has(t.planId) && ['draft', 'pending', ...live, 'blocked'].includes(t.status)) };
}

export function projectOverview(projectRoot) {
  const started = performance.now();
  const root = fs.realpathSync(projectRoot);
  const previous = cache.get(root);
  const fixed = ['package.json', 'README.md', 'README_zh.md', 'pyproject.toml', 'Cargo.toml', 'Package.swift', 'go.mod',
    '.contextos/project.json', '.contextos/graph.json', '.contextos/state.sqlite', '.contextos/state.sqlite-wal', '.contextos/session.json'];
  const manifest = json(root, 'package.json');
  const manifests = packagePaths(root, manifest);
  const watched = [...new Set([...fixed, ...manifests, ...(previous?.watched || [])])];
  const fingerprint = digest(JSON.stringify([Math.floor(Date.now() / 60000), watched.map((p) => stamp(root, p)),
    fixed.slice(0, 7).map((p) => read(root, p)?.text || null)]));
  if (previous?.fingerprint === fingerprint) {
    cache.delete(root); cache.set(root, previous);
    return { ...structuredClone(previous.result), lifecycle: { cache: 'hit', fingerprint, modelRequests: 0, durationMs: performance.now() - started } };
  }
  const gaps = [];
  const { state, projectId, revision } = loadState(root, gaps, projectRoot);
  const readme = read(root, 'README.md') || read(root, 'README_zh.md');
  const packages = manifests.map((file) => {
    const pkg = json(root, file);
    if (!pkg) return null;
    const directory = path.posix.dirname(file);
    const declared = entryStrings([pkg.main, pkg.module, pkg.bin, pkg.exports]);
    const entries = [...new Set(declared)].map((entry) => {
      const file = path.posix.normalize(path.posix.join(directory, entry));
      const source = read(root, file);
      if (!source) { gaps.push('Declared entry unavailable: ' + file); return { path: file, available: false }; }
      return { path: file, available: true, line: 1, contentHash: digest(source.text), truncated: source.truncated };
    }).slice(0, 6);
    const commands = Object.entries(pkg.scripts || {}).filter(([key]) => /^(test|build|dev|start|verify|mcp)(:|$)/.test(key))
      .slice(0, 6).map(([name, command]) => ({ name, command: short(command, 220), at: file }));
    return { name: short(pkg.name || directory, 100), manifest: file, entries, commands };
  }).filter(Boolean);
  const types = [['package.json', 'Node.js'], ['pyproject.toml', 'Python'], ['Cargo.toml', 'Rust'], ['Package.swift', 'Swift'], ['go.mod', 'Go']]
    .filter(([file]) => read(root, file)).map(([, type]) => type);
  const blocks = (state.blocks || []).filter((b) => b.id && !b.id.startsWith('mod-') && b.kind !== 'module');
  const chains = Array.isArray(state.chains) ? state.chains : [];
  const members = new Set(chains.flatMap((c) => c.memberIds || []));
  const navigation = blocks.slice(0, MAX_BLOCKS).map((b) => {
    const anchors = [];
    for (const ref of b.artifactRefs || []) {
      if (anchors.some((a) => a.path === ref.path)) continue;
      const target = safePath(root, ref.path);
      let exists = false;
      try { exists = Boolean(target && fs.statSync(target)); } catch {}
      // Trust is earned from hash equality, never assumed: a file anchor is
      // fresh only while its recorded hash matches the bytes on disk, stale when
      // it provably drifted, and unverified when the read was truncated or the
      // anchor is a symbol/tree slice this entry cannot re-parse.
      const anchorKind = ref.anchorKind || (ref.symbol ? 'symbol' : 'file');
      const source = exists ? read(root, ref.path) : null;
      let anchorStatus = exists ? 'unverified' : 'missing';
      if (exists && source && !source.truncated && ref.hash) {
        if (anchorKind === 'file') {
          anchorStatus = digest(source.text).slice(0, 16) === ref.hash ? 'fresh' : 'stale';
        } else if (anchorKind === 'symbol' && ref.startLine && ref.endLine) {
          const slice = source.text.split(/\r?\n/).slice(ref.startLine - 1, ref.endLine).join('\n');
          if (digest(slice).slice(0, 16) === ref.hash) anchorStatus = 'fresh';
        }
      }
      anchors.push({ path: short(ref.path, 160), ...(ref.symbol ? { symbol: short(ref.symbol, 100) } : {}),
        line: ref.startLine || 1, available: exists, anchorStatus });
      if (!exists) gaps.push('Stale anchor: ' + b.id + ' -> ' + ref.path);
      else if (anchorStatus === 'stale') gaps.push('Stale anchor: ' + b.id + ' -> ' + ref.path + ' (hash drifted; refresh with block bind_auto)');
      if (anchors.length === 2) break;
    }
    if (!(b.chainIds?.length || members.has(b.id))) gaps.push('Block has no Chain membership: ' + b.id + ' (navigation advice; does not block source reads).');
    return { id: b.id, title: short(b.title, 100), summary: short(b.summary), chainIds: b.chainIds || chains.filter((c) => (c.memberIds || []).includes(b.id)).map((c) => c.id), anchors };
  });
  if (!blocks.length) gaps.push('No curated Blocks. Use declared entries and bounded inspect; no architecture has been generated.');
  const counts = state.counts || { blockCount: blocks.length, chainCount: chains.length };
  if (counts.blockCount > MAX_BLOCKS) gaps.push('Block navigation limited to ' + MAX_BLOCKS + ' of ' + counts.blockCount + '; open a named Chain or Block.');
  const current = state;
  const sessionFile = read(root, '.contextos/session.json', SESSION_MAX_BYTES);
  let currentSession = null;
  let sessionUnavailable = null;
  if (sessionFile?.truncated) {
    sessionUnavailable = 'budget-exceeded';
    gaps.push('Session exceeds the 256 KiB first-contact budget.');
  } else if (!safePath(root, '.contextos/session.json')) {
    sessionUnavailable = 'unsafe-path';
    gaps.push('Session path escapes the current workspace.');
  } else if (sessionFile) {
    try {
      const raw = JSON.parse(sessionFile.text);
      if (fs.realpathSync(raw.workspaceRoot) !== root) {
        sessionUnavailable = 'foreign-workspace';
        gaps.push('Session belongs to another workspace.');
      } else if (raw.status === 'open') currentSession = raw;
    } catch {
      sessionUnavailable = 'invalid-session';
      gaps.push('Session is invalid or its workspace is unavailable.');
    }
  } else if (fs.existsSync(path.join(root, '.contextos/session.json'))) {
    sessionUnavailable = 'unreadable';
    gaps.push('Session file is unreadable.');
  }
  const session = sessionUnavailable
    ? { status: 'unavailable', reason: sessionUnavailable }
    : new SessionStore({ projectRoot: root, projectId }).summary(currentSession);
  const overview = {
    workspace: root, projectId, types, description: short(manifest?.description || readme?.text.split('\n').find((line) => line.trim() && !line.startsWith('#')), 240),
    packages, navigation, chains: chains.slice(0, 16).map((c) => ({ id: c.id, title: short(c.title, 100), memberIds: (c.memberIds || []).slice(0, 16) })),
    graph: { revision, ...counts },
    session, plans: current.plans.slice(0, 5).map((p) => ({ id: p.id, title: short(p.title), summary: short(p.summary), status: p.status })),
    tasks: current.tasks.slice(0, 8).map((t) => ({ id: t.id, planId: t.planId, title: short(t.title), status: t.status, nextSteps: (t.contextSlice?.nextSteps || []).slice(0, 2).map((s) => short(s)) })),
    gaps: gaps.slice(0, 20),
    next: 'Use ask({inspect:[{path,ranges:[[start,end]]}]}) on an available entry/anchor; open a named Block/Chain via ops for deeper navigation. Anchor lines are hints until inspect verifies current source.',
  };
  const lines = [
    'Project ' + overview.projectId + ' [' + types.join(', ') + '] workspace=' + root,
    overview.description,
    'Session=' + JSON.stringify(session),
    'Effective plans=' + JSON.stringify(overview.plans),
    'Effective tasks=' + JSON.stringify(overview.tasks),
    ...packages.map((p) => p.name + ' @ ' + p.manifest + '; entries=' + p.entries.map((e) => e.path + ':1' + (e.available ? '' : ' (missing)')).join(', ')
      + '; commands=' + p.commands.slice(0, 3).map((c) => c.name + ': ' + c.command).join(' | ')),
    'Graph revision=' + revision + ' Blocks=' + counts.blockCount + ' Chains=' + counts.chainCount,
    ...navigation.map((b) => b.id + ' ' + b.title + ' chains=' + b.chainIds.join(',') + ' anchors=' + b.anchors.map((a) => a.path + ':' + a.line + ' (' + a.anchorStatus + ')').join(',')),
    ...overview.chains.map((c) => c.id + ' ' + c.title + ' members=' + c.memberIds.join(',')),
    'Gaps=' + overview.gaps.join('; '),
    overview.next,
  ];
  const result = { status: 'completed', overview, summary: lines.join('\n') };
  const nextWatched = [...new Set([...watched, ...packages.flatMap((p) => p.entries.map((e) => e.path)), ...navigation.flatMap((b) => b.anchors.map((a) => a.path))])];
  const nextFingerprint = digest(JSON.stringify([Math.floor(Date.now() / 60000), nextWatched.map((p) => stamp(root, p)),
    fixed.slice(0, 7).map((p) => read(root, p)?.text || null)]));
  cache.set(root, { fingerprint: nextFingerprint, watched: nextWatched, result });
  while (cache.size > 8) cache.delete(cache.keys().next().value);
  return { ...structuredClone(result), lifecycle: { cache: 'miss', fingerprint: nextFingerprint, modelRequests: 0, durationMs: performance.now() - started } };
}


// Named architecture navigation reads runtime SQLite without migrations or projection imports.
// Only exact graph IDs/titles in semantic requests are candidates; no directory ownership inference.
export async function graphEvidence(root, args = {}, signal) {
  const explicit = args.blockId !== undefined || args.chainId !== undefined;
  const missing = [];
  const blocks = [];
  let db;
  try {
    if (args.blockId !== undefined && (typeof args.blockId !== 'string' || !args.blockId.trim())
      || args.chainId !== undefined && (typeof args.chainId !== 'string' || !args.chainId.trim())) {
      throw new Error('blockId and chainId must be nonempty graph IDs.');
    }
    const target = safePath(root, '.contextos/state.sqlite');
    if (!target || !fs.existsSync(target)) {
      if (explicit) missing.push({ reason: 'Runtime graph unavailable; reconcile/init architecture or use exact inspect.' });
      return { matched: explicit, records: [], paths: [], missing };
    }
    db = Object.create(V2Database.prototype);
    db.db = new DatabaseSync(target, { readOnly: true });
    const projects = db.db.prepare('SELECT * FROM projects').all();
    const project = projects.find((row) => { try { return fs.realpathSync(row.repo_root) === root; } catch { return false; } });
    if (!project) throw new Error('No runtime graph belongs to this workspace.');
    const validBlock = (id) => {
      const block = db.getBlock(id);
      if (!block || block.projectId !== project.id || block.id.startsWith('mod-') || block.kind === 'module') {
        missing.push({ reason: 'Unknown curated Block: ' + id });
        return;
      }
      if (!blocks.some((entry) => entry.id === id)) blocks.push(block);
    };
    const addChain = (id) => {
      const chain = db.getChain(id);
      if (!chain || chain.projectId !== project.id) { missing.push({ reason: 'Unknown Chain: ' + id }); return; }
      for (const member of chain.memberIds) validBlock(member);
    };
    if (args.blockId !== undefined) validBlock(args.blockId);
    if (args.chainId !== undefined) addChain(args.chainId);
    if (!explicit && typeof args.request === 'string') {
      const includes = (id, title) => args.request.includes(id)
        || typeof title === 'string' && title.length >= 3 && args.request.includes(title);
      for (const block of db.db.prepare("SELECT id,title FROM blocks WHERE project_id=? AND id NOT LIKE 'mod-%' AND kind!='module'").all(project.id)) {
        if (includes(block.id, block.title)) validBlock(block.id);
      }
      for (const chain of db.listChains(project.id)) if (includes(chain.id, chain.title)) addChain(chain.id);
    }
  } catch (error) { if (explicit) missing.push({ reason: error.message }); }
  finally { db?.db?.close(); }
  const matched = explicit || blocks.length > 0;
  const requests = [];
  const seen = new Set();
  for (const block of blocks) for (const anchor of block.artifactRefs || []) {
    if (requests.length >= 16) { const reason = 'Graph anchor evidence capped at 16 reads; navigate a narrower Block or exact inspect.'; if (!missing.some((item) => item.reason === reason)) missing.push({ reason }); break; }
    const relative = anchor.anchorKind === 'tree' ? anchor.manifest : anchor.path;
    if (!relative) { missing.push({ path: anchor.path, reason: 'Tree anchor requires an explicit manifest; use owners/inspect for named member files.' }); continue; }
    const target = safePath(root, relative);
    if (!target) { missing.push({ path: relative, reason: 'Graph anchor escapes workspace.' }); continue; }
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size > 128 * 1024) throw new Error('Anchor is not a bounded source file; use exact inspect.');
      const bytes = fs.readFileSync(target);
      const contentHash = digest(bytes);
      const text = bytes.toString('utf8');
      // CodeIntel bindings include the final empty line after LF/CRLF and
      // treat an empty file as one line. Keep byte slicing in collectEvidence.
      const lines = text.split(/\r?\n/u);
      let first = anchor.anchorKind === 'tree' ? 1 : anchor.startLine || 1;
      let last = anchor.anchorKind === 'tree' ? Math.min(lines.length, 64) : anchor.endLine || Math.min(lines.length, first + 63);
      if (anchor.symbol && anchor.anchorKind !== 'file' && anchor.anchorKind !== 'tree') {
        // Bindings store the AST symbol/slice hash, not the whole-file hash.
        // Resolve current lines from the same parser so unchanged symbols may move.
        const { LanguageRegistry } = await import('../../code-intel/src/language-registry.mjs');
        const structure = LanguageRegistry.parseStructure(relative, text);
        const bare = anchor.symbol.includes('#') ? anchor.symbol.split('#').pop().trim() : anchor.symbol;
        let candidates = structure.symbols.filter((entry) => entry.name === bare);
        if (!candidates.length) candidates = structure.symbols.filter((entry) => entry.shortName === bare
          || entry.name.endsWith('.' + bare)
          || entry.containerName && (entry.containerName + '.' + (entry.shortName || entry.name)).endsWith('.' + bare));
        if (!candidates.length) throw new Error('Missing symbol anchor; refresh the binding before graph source delivery.');
        if (anchor.hash) {
          candidates = candidates.filter((symbol) => symbol.hash === anchor.hash);
          if (!candidates.length) throw new Error('Stale graph symbol hash; refresh the binding before graph source delivery.');
        }
        if (candidates.length > 1) {
          const located = candidates.filter((symbol) => symbol.startLine === anchor.startLine && symbol.endLine === anchor.endLine);
          if (located.length === 1) candidates = located;
        }
        if (candidates.length !== 1) throw new Error('Ambiguous symbol anchor; use a qualified symbol or refresh its exact locator.');
        const symbol = candidates[0];
        first = symbol.startLine;
        last = symbol.endLine;
      } else if (anchor.hash && !contentHash.startsWith(anchor.hash)) {
        throw new Error('Stale graph anchor hash; refresh the binding before graph source delivery.');
      }
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first || last > lines.length) {
        throw new Error('Stale graph anchor range; refresh the binding before graph source delivery.');
      }
      const key = [relative, first, last, contentHash].join(':');
      if (!seen.has(key)) {
        seen.add(key);
        // A whole-file anchor includes a zero-byte terminal line. Request its
        // complete snapshot so the byte-span reader neither clips that line
        // nor rejects the valid empty-file anchor.
        requests.push({ path: relative, ...((anchor.anchorKind === 'file' || anchor.anchorKind === 'tree') && first === 1 && last === lines.length ? {} : { ranges: [[first, last]] }), expectedContentHash: contentHash });
      }
    } catch (error) { missing.push({ path: relative, reason: error.message }); }
  }
  const { collectEvidence } = await import('./evidence-core.mjs');
  const evidence = await collectEvidence({ projectRoot: root, requests, signal });
  if (matched && !requests.length && !missing.length) missing.push({ reason: 'Selected graph entities have no exact source anchors.' });
  return { matched, blockIds: blocks.map((block) => block.id), paths: [...new Set(evidence.records.map((record) => record.path))],
    records: evidence.records, missing: [...missing, ...evidence.missing], notices: evidence.notices || [] };
}


// Resolve one explicit goal against persisted graph metadata. No source search,
// title synthesis, architecture bootstrap, substring ranking or model fallback.
export async function goalOnboarding(projectRoot, goal, signal) {
  const started = performance.now();
  const root = fs.realpathSync(projectRoot);
  const base = projectOverview(root);
  const fold = (value) => String(value || '').normalize('NFKC').toLocaleLowerCase('en-US');
  const query = fold(goal.trim());
  const missing = [];
  const candidates = [];
  let selected = null;
  let graph = { records: [], missing: [], paths: [], blockIds: [] };
  let owners = { items: [], missing: [], multiple: [] };
  let relatedChains = [];
  let chainArchitecture = null;
  let db;
  let graphRuns = 0;
  let ownerRuns = 0;
  try {
    const target = safePath(root, '.contextos/state.sqlite');
    if (!target || !fs.existsSync(target)) throw new Error('No runtime graph is available; use overview entries or exact inspect before selecting a goal.');
    db = Object.create(V2Database.prototype);
    db.db = new DatabaseSync(target, { readOnly: true });
    const project = db.db.prepare('SELECT * FROM projects').all().find((row) => {
      try { return fs.realpathSync(row.repo_root) === root; } catch { return false; }
    });
    if (!project) throw new Error('No runtime graph belongs to this workspace.');
    const blocks = db.listBlocks(project.id).filter((block) => !block.id.startsWith('mod-') && block.kind !== 'module');
    const chains = db.listChains(project.id);
    let refsVisited = 0;
    let complete = blocks.length <= 2000 && chains.length <= 2000;
    const matchRef = (ref) => {
      if (!ref.hash || !Number.isSafeInteger(ref.startLine) || !Number.isSafeInteger(ref.endLine)
        || ref.startLine < 1 || ref.endLine < ref.startLine || !safePath(root, ref.path)) return null;
      const portable = String(ref.path).replaceAll('\\', '/');
      const relative = path.posix.normalize(portable).replace(/^\.\//, '');
      const targetGoal = goal.trim().replaceAll('\\', '/');
      const normalizedGoal = path.posix.normalize(targetGoal).replace(/^\.\//, '');
      if (safePath(root, targetGoal) && normalizedGoal === relative) return 'path';
      if (!targetGoal.includes('/') && targetGoal === path.posix.basename(relative)) return 'basename';
      if (ref.symbol) {
        const symbol = String(ref.symbol);
        const qualified = symbol.includes('#') ? symbol.split('#').pop() : symbol;
        if ([symbol, qualified, qualified.split('.').pop(), relative + '#' + qualified].some((value) => fold(value) === query)) return 'symbol';
      }
      return null;
    };
    for (const block of blocks.slice(0, 2000)) {
      const matches = [];
      if (fold(block.id) === query) matches.push({ kind: 'id', value: block.id });
      if (fold(block.title) === query) matches.push({ kind: 'title', value: block.title });
      for (const ref of block.artifactRefs || []) {
        if (++refsVisited > 10000) { complete = false; break; }
        const kind = matchRef(ref);
        if (kind) matches.push({ kind, path: ref.path, ...(kind === 'symbol' ? { symbol: ref.symbol } : {}) });
      }
      if (matches.length) candidates.push({ kind: 'block', id: block.id, title: block.title, matches: matches.slice(0, 8) });
    }
    // Chains match only their own literal ID/title, never a member's symbol.
    for (const chain of chains.slice(0, 2000)) {
      const matches = [];
      if (fold(chain.id) === query) matches.push({ kind: 'id', value: chain.id });
      if (fold(chain.title) === query) matches.push({ kind: 'title', value: chain.title });
      if (matches.length) candidates.push({ kind: 'chain', id: chain.id, title: chain.title, matches });
    }
    if (!complete) missing.push({ reason: 'Graph metadata exceeds the bounded goal selector; use an explicit Block or Chain ID.' });
    else if (candidates.length === 1) {
      selected = candidates[0];
      graphRuns += 1;
      graph = await graphEvidence(root, { [selected.kind === 'block' ? 'blockId' : 'chainId']: selected.id }, signal);
      const blockIds = new Set(graph.blockIds || []);
      relatedChains = chains.filter((chain) => selected.kind === 'chain' && chain.id === selected.id
        || (chain.memberIds || []).some((id) => blockIds.has(id))).slice(0, 16).map((chain) => ({
          id: chain.id, title: chain.title, memberIds: (chain.memberIds || []).slice(0, 32),
          ...((chain.memberIds || []).length > 32 ? { memberCount: chain.memberIds.length, membersTruncated: true } : {}),
        }));
      // One onboard call must answer "what is this feature": a Chain goal returns
      // the member cards and the declared internal flow instead of forcing a
      // second chain open just to learn the structure.
      if (selected.kind === 'chain') {
        const selectedChain = chains.find((chain) => chain.id === selected.id);
        const memberIds = (selectedChain?.memberIds || graph.blockIds || []).map((id) => String(id));
        const oneLine = (value, max) => short(String(value || '').replace(/\s+/g, ' ').trim(), max);
        const members = blocks.filter((block) => memberIds.includes(block.id)).map((block) => ({
          id: block.id, title: oneLine(block.title, 120), kind: block.kind,
          ...(block.summary ? { responsibility: oneLine(block.summary, 160) } : {}),
        }));
        const internalFlow = db.listLinks(project.id)
          .filter((link) => memberIds.includes(link.from) && memberIds.includes(link.to))
          .slice(0, 24)
          .map((link) => ({ from: link.from, to: link.to, kind: link.kind || 'link' }));
        chainArchitecture = {
          id: selected.id,
          title: oneLine(selectedChain?.title || selected.title, 120),
          ...(selectedChain?.summary ? { responsibility: oneLine(selectedChain.summary, 200) } : {}),
          memberCount: memberIds.length,
          members: members.slice(0, 24),
          internalFlow,
          ...(members.length > 24 ? { membersTruncated: true } : {}),
        };
      }
      const targetBlocks = blocks.filter((block) => blockIds.has(block.id));
      const paths = [...new Set(targetBlocks.flatMap((block) => (block.artifactRefs || [])
        .map((ref) => ref.anchorKind === 'tree' ? ref.manifest : ref.path).filter((value) => value && safePath(root, value))))];
      if (paths.length > 16) missing.push({ reason: 'Owner evidence capped at 16 actual anchor paths; navigate a narrower target.' });
      if (paths.length) {
        // Reuse the actual owners capability through a read-only facade. Its
        // constructor would initialize/migrate state, which first contact must not do.
        const { ContextOSV2Service } = await import('../../mcp/src/v2-service.mjs');
        const service = Object.create(ContextOSV2Service.prototype);
        Object.assign(service, { projectRoot: root, projectId: project.id, db });
        ownerRuns += 1;
        owners = await service.block({ action: 'owners', paths: paths.slice(0, 16), format: 'json' });
        for (const item of owners.items) {
          if (item.status !== 'owned') missing.push({ path: item.path, reason: 'Actual owner status: ' + item.status });
          if (item.owners.some((owner) => owner.refs.some((ref) => ref.anchorStatus === 'stale'))) {
            missing.push({ path: item.path, reason: 'Owner includes stale source anchors; refresh actual bindings.' });
          }
        }
      }
    } else if (candidates.length > 1) missing.push({ reason: 'Goal matches multiple actual graph entities; select a candidate ID in a separate request.' });
    else {
      missing.push({ reason: 'No exact trusted graph ID, title, symbol, path or basename matches this goal. Arbitrary natural-language discovery requires a separate semantic ask.' });
      for (const block of blocks.slice(0, 8)) candidates.push({ kind: 'block', id: block.id, title: block.title, matches: [] });
    }
  } catch (error) { missing.push({ reason: error.message }); }
  finally { db?.db?.close(); }
  missing.push(...graph.missing);
  const selection = { goal, selected, candidates: candidates.slice(0, 16), candidateCount: candidates.length,
    state: selected ? 'selected' : candidates.some((candidate) => candidate.matches.length) ? 'ambiguous' : 'unmatched' };
  const records = graph.records || [];
  return {
    ...base, status: missing.length || !selected ? 'partial' : 'completed',
    summary: base.summary.split('\nGraph revision=')[0],
    records, missing, notices: graph.notices || [], owners,
    navigation: { mode: 'onboard', selection, blockIds: graph.blockIds || [], paths: graph.paths || [], relatedChains, chainArchitecture },
    lifecycle: { ...base.lifecycle, mode: 'onboard', modelRequests: 0, selectorRuns: 1,
      evidencePrimitives: { overview: 1, graphEvidence: graphRuns, owners: ownerRuns }, durationMs: performance.now() - started },
    accounting: { transportInvocations: 0, toolCalls: 0, usage: null, usageStatus: 'not_requested',
      materializedEvidenceBytes: records.reduce((sum, record) => sum + record.bytes, 0),
      materializedEvidenceChars: records.reduce((sum, record) => sum + record.chars, 0),
      renderedSourceBytes: null, renderedSourceChars: null },
  };
}
