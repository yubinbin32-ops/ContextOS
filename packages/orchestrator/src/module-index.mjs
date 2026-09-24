import fs from 'node:fs';
import path from 'node:path';
import { LanguageRegistry } from '../../code-intel/src/language-registry.mjs';
import { tokenize } from './intent-router.mjs';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage', '.contextos',
  '.cache', '.wrangler', 'DerivedData', '.build', 'vendor', 'Pods', 'target', '.venv',
]);
const SOURCE_EXT = new Set([
  '.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx', '.py', '.swift', '.go', '.rs',
  '.java', '.kt', '.rb', '.php', '.c', '.h', '.cpp', '.cs',
]);
const BINARY_OR_IGNORE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp', '.bmp', '.tiff',
  '.sqlite', '.sqlite-wal', '.sqlite-shm', '.db', '.bin',
  '.exe', '.dll', '.dylib', '.so', '.node',
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.lockb', '.pyc', '.class', '.o', '.a',
  '.pdf', '.mp4', '.mp3', '.mov', '.avi', '.wav',
  '.ds_store',
]);
const MAX_SOURCE_FILES = 800;
const MAX_INDEXED_PER_CALL = 60;
const MAX_FILE_BYTES = 200_000;

export function slugify(value) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'root';
}

export function moduleIdFor(relativePath) {
  const dir = path.dirname(String(relativePath || '')).split(path.sep).join('/');
  return `mod-${slugify(dir === '.' ? 'root' : dir)}`;
}

export function isSource(relativePath) {
  return SOURCE_EXT.has(path.extname(relativePath).toLowerCase());
}

export function isIndexable(relativePath) {
  const base = path.basename(relativePath).toLowerCase();
  if (base.startsWith('.') && base !== '.gitignore' && base !== '.env' && base !== '.npmrc') {
    if (!base.endsWith('.json') && !base.endsWith('.yaml') && !base.endsWith('.yml') && !base.endsWith('.toml')) {
      return false;
    }
  }
  const ext = path.extname(relativePath).toLowerCase();
  if (BINARY_OR_IGNORE_EXT.has(ext)) return false;
  return true;
}

function walk(dir, root, collected, limit) {
  if (collected.length >= limit) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    if (collected.length >= limit) return;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walk(path.join(dir, entry.name), root, collected, limit);
      continue;
    }
    if (!entry.isFile()) continue;
    const relative = path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/');
    if (isIndexable(relative)) collected.push(relative);
  }
}

/**
 * Derived architecture index.
 *
 * Modules are computed from the filesystem and the AST (directory clustering +
 * real symbols) instead of being declared by hand, so coverage bookkeeping can
 * become advisory rather than a blocking gate.
 */
export class ModuleIndex {
  constructor({ projectRoot }) {
    this.projectRoot = projectRoot;
    this.cachePath = path.join(projectRoot, '.contextos', 'module-index.json');
    this.entries = new Map();
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.cachePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      for (const entry of raw.entries || []) this.entries.set(entry.path, entry);
    } catch (_) {}
  }

  save() {
    fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
    fs.writeFileSync(
      this.cachePath,
      JSON.stringify({ updatedAt: new Date().toISOString(), entries: Array.from(this.entries.values()) }, null, 2) + '\n',
      'utf8'
    );
  }

  discover({ limit = MAX_SOURCE_FILES } = {}) {
    const found = [];
    walk(this.projectRoot, this.projectRoot, found, limit);
    return found;
  }

  _parse(relativePath) {
    const fullPath = path.join(this.projectRoot, relativePath);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch (_) {
      return null;
    }
    if (stat.size > MAX_FILE_BYTES) {
      return { path: relativePath, mtimeMs: stat.mtimeMs, size: stat.size, symbols: [], imports: [], language: 'unknown' };
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    const ext = path.extname(relativePath).toLowerCase();
    const basename = path.basename(relativePath);

    let symbols = [];
    let imports = [];
    let language = 'unknown';

    if (isSource(relativePath)) {
      let structure = { symbols: [], imports: [], language: 'unknown', capability: 'none' };
      try {
        structure = LanguageRegistry.parseStructure(relativePath, content) || structure;
      } catch (_) {}
      for (const sym of structure.symbols || []) {
        symbols.push({ name: sym.name, kind: sym.kind, startLine: sym.startLine });
        for (const method of sym.methods || []) {
          symbols.push({ name: method.name, kind: 'method', startLine: method.startLine });
        }
      }
      imports = (structure.imports || []).map((imp) => imp.source).slice(0, 20);
      language = structure.language || 'unknown';
    } else if (ext === '.json') {
      language = 'json';
      try {
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const key of Object.keys(parsed).slice(0, 30)) {
            const val = parsed[key];
            const valStr = typeof val === 'string' ? `:${val}` : '';
            symbols.push({ name: `${key}${valStr}`.slice(0, 50), kind: 'property', startLine: 1 });
          }
        }
      } catch (_) {}
    } else if (ext === '.toml' || ext === '.yaml' || ext === '.yml' || ext === '.plist' || ext === '.env') {
      language = ext.replace('.', '');
      const lines = content.split('\n');
      for (let i = 0; i < Math.min(lines.length, 100); i++) {
        const line = lines[i].trim();
        const m = line.match(/^([a-zA-Z0-9_-]+)\s*[:=]\s*(.+)$/);
        if (m) {
          const key = m[1];
          const val = m[2].replace(/["']/g, '').trim().slice(0, 30);
          symbols.push({ name: `${key}:${val}`, kind: 'property', startLine: i + 1 });
        }
      }
    } else {
      language = ext ? ext.replace('.', '') : 'text';
      symbols.push({ name: basename, kind: 'file', startLine: 1 });
    }

    return {
      path: relativePath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      language,
      symbols: symbols.slice(0, 40),
      imports: imports.slice(0, 20),
    };
  }

  /** Refresh entries for the given files; parses only what changed. */
  ensure(relativePaths = []) {
    let parsed = 0;
    for (const relativePath of relativePaths) {
      const fullPath = path.join(this.projectRoot, relativePath);
      if (!fs.existsSync(fullPath) || !isIndexable(relativePath)) continue;
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch (_) {
        continue;
      }
      const cached = this.entries.get(relativePath);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) continue;
      const entry = this._parse(relativePath);
      if (entry) {
        this.entries.set(relativePath, entry);
        parsed += 1;
      }
      if (parsed >= MAX_INDEXED_PER_CALL) break;
    }
    if (parsed > 0) this.save();
    return parsed;
  }

  /** Cold start: index a bounded slice of the project so lookup has material. */
  bootstrapIfEmpty() {
    if (this.entries.size > 0) return 0;
    const files = this.discover({ limit: MAX_INDEXED_PER_CALL });
    return this.ensure(files);
  }

  modules() {
    const grouped = new Map();
    for (const entry of this.entries.values()) {
      const id = moduleIdFor(entry.path);
      if (!grouped.has(id)) grouped.set(id, { id, directory: path.dirname(entry.path).split(path.sep).join('/'), files: [], symbols: [] });
      const group = grouped.get(id);
      group.files.push(entry.path);
      for (const symbol of entry.symbols.slice(0, 5)) group.symbols.push(symbol.name);
    }
    return Array.from(grouped.values());
  }

  attribute(relativePaths = []) {
    const result = new Map();
    for (const relativePath of relativePaths) {
      result.set(relativePath, moduleIdFor(relativePath));
    }
    return result;
  }

  lookup(query = '', { limit = 3 } = {}) {
    const tokens = tokenize(query);
    if (!tokens.size) return [];
    return this.modules()
      .map((module) => {
        const haystack = tokenize(`${module.id} ${module.directory} ${module.files.join(' ')} ${module.symbols.join(' ')}`);
        let score = 0;
        for (const token of tokens) if (haystack.has(token)) score += 1;
        return { ...module, score };
      })
      .filter((module) => module.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
