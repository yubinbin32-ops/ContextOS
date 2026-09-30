import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContextOSV2Service } from './v2-service.mjs';
import { initProjectWorkspace, deriveProjectId } from './bootstrap-util.mjs';

const serviceCache = new Map();

function isWorkspaceRoot(candidate) {
  return (
    fs.existsSync(path.join(candidate, '.contextos', 'project.json')) ||
    fs.existsSync(path.join(candidate, '.git')) ||
    fs.existsSync(path.join(candidate, 'package.json'))
  );
}

export function requireProjectRoot(inputRoot) {
  if (!inputRoot || typeof inputRoot !== 'string') {
    throw new Error('Explicit projectRoot is required. Pass the absolute path of the active workspace.');
  }
  const root = path.resolve(inputRoot);
  if (process.env.CONTEXTOS_WORKER_ROOT && fs.realpathSync(root) !== fs.realpathSync(process.env.CONTEXTOS_WORKER_ROOT)) {
    throw new Error('Worker projectRoot must match the assigned workspace.');
  }
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`projectRoot does not exist or is not a directory: '${root}'`);
  }
  return root;
}

export function findDefaultProjectRoot() {
  if (process.env.CONTEXTOS_PROJECT_ROOT) {
    return requireProjectRoot(process.env.CONTEXTOS_PROJECT_ROOT);
  }
  const cwd = path.resolve(process.cwd());
  if (isWorkspaceRoot(cwd)) return cwd;
  throw new Error(
    'Explicit projectRoot is required because the current working directory is not a workspace root. '
    + 'Pass the absolute path of the active workspace; refusing to infer a parent or home directory.'
  );
}

export function findBundledPluginRoot() {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.CONTEXTOS_REPOSITORY_ROOT,
    path.resolve(moduleDirectory, '../../..'),
    path.resolve(moduleDirectory, '..'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'plugins', 'contextos'))) return candidate;
  }
  throw new Error('Cannot locate the bundled ContextOS plugin assets; set CONTEXTOS_REPOSITORY_ROOT explicitly.');
}

export function getService(projectRoot) {
  const root = requireProjectRoot(projectRoot);
  let projectId = deriveProjectId(root);
  const marker = path.join(root, '.contextos', 'project.json');
  if (fs.existsSync(marker)) {
    const project = JSON.parse(fs.readFileSync(marker, 'utf8'));
    projectId = project.id || projectId;
    if (project.storage === 'cloud' || project.isCloud === true || project.cloudUrl || project.cloudToken) {
      initProjectWorkspace({ projectRoot: root });
    }
  }
  const cacheKey = `local:${root}:${projectId}`;
  if (!serviceCache.has(cacheKey)) {
    serviceCache.set(cacheKey, new ContextOSV2Service({ projectRoot: root, projectId }));
  }
  return serviceCache.get(cacheKey);
}

export function evictServices(projectRoot) {
  for (const key of Array.from(serviceCache.keys())) {
    if (key.startsWith(`local:${path.resolve(projectRoot)}:`)) {
      try {
        serviceCache.get(key).close();
      } catch (_) {}
      serviceCache.delete(key);
    }
  }
}

export function projectDbPath(projectRoot) {
  return path.join(projectRoot, '.contextos', 'state.sqlite');
}
