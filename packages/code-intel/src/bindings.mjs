import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MANIFEST_CANDIDATES = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'go.sum',
  'Package.resolved',
  'Gemfile.lock',
  'composer.lock',
  'poetry.lock',
  'Pipfile.lock',
];

export function normalizeBindingPath(filePath) {
  return String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

export function bindingMatchesPath(refPath, anchorKind, targetPath) {
  const binding = normalizeBindingPath(refPath);
  const target = normalizeBindingPath(targetPath);
  if (!binding || !target) return false;
  if (anchorKind === 'tree') return target === binding || target.startsWith(`${binding}/`);
  return target === binding;
}

function hashFile(fullPath) {
  const hash = crypto.createHash('sha256');
  const file = fs.openSync(fullPath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(file, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(file);
  }
  return hash.digest('hex').slice(0, 16);
}

function collectDirectoryFiles(root, maxFiles) {
  const files = [];
  const walk = (directory, relativeDir = '') => {
    if (files.length >= maxFiles) {
      throw new Error(`Directory binding exceeds ${maxFiles} files; use hashMode='manifest' for dependency trees.`);
    }
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === '.contextos') continue;
      const fullPath = path.join(directory, entry.name);
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(fullPath, relativePath);
      } else if (entry.isFile()) {
        files.push({ fullPath, relativePath });
        if (files.length >= maxFiles) break;
      }
    }
  };
  walk(root);
  return files;
}

export function findDirectoryManifest(projectRoot, relativeDir) {
  const normalized = normalizeBindingPath(relativeDir);
  const candidateDirs = new Set([path.join(projectRoot, normalized)]);
  if (path.basename(normalized) === 'node_modules') {
    candidateDirs.add(path.dirname(path.join(projectRoot, normalized)));
  }
  for (const directory of candidateDirs) {
    for (const name of MANIFEST_CANDIDATES) {
      const fullPath = path.join(directory, name);
      if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) continue;
      const relative = path.relative(projectRoot, fullPath).split(path.sep).join('/');
      return relative;
    }
  }
  return null;
}

export function calculateTreeHash(projectRoot, relativeDir, {
  hashMode = 'content',
  manifest = null,
  maxFiles = 5000,
} = {}) {
  const normalized = normalizeBindingPath(relativeDir);
  const fullPath = path.resolve(projectRoot, normalized);
  const resolvedRoot = path.resolve(projectRoot);
  const relativeToRoot = path.relative(resolvedRoot, fullPath);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new Error(`Directory binding '${relativeDir}' is outside project root`);
  }
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) {
    throw new Error(`Directory binding not found: '${normalized}'`);
  }

  const resolvedMode = hashMode || (manifest ? 'manifest' : 'content');
  if (resolvedMode === 'manifest') {
    const manifestPath = normalizeBindingPath(manifest || findDirectoryManifest(projectRoot, normalized));
    if (!manifestPath) {
      throw new Error(`No manifest found for directory binding '${normalized}'. Pass manifest explicitly.`);
    }
    const manifestFullPath = path.resolve(projectRoot, manifestPath);
    if (!fs.existsSync(manifestFullPath) || !fs.statSync(manifestFullPath).isFile()) {
      throw new Error(`Manifest not found for directory binding '${normalized}': '${manifestPath}'`);
    }
    return { hash: hashFile(manifestFullPath), hashMode: 'manifest', manifest: manifestPath, fileCount: 0 };
  }

  const hash = crypto.createHash('sha256');
  const files = collectDirectoryFiles(fullPath, maxFiles);
  for (const file of files) {
    hash.update(`${file.relativePath}\0`);
    hash.update(hashFile(file.fullPath));
    hash.update('\0');
  }
  return { hash: hash.digest('hex').slice(0, 16), hashMode: 'content', manifest: null, fileCount: files.length };
}
