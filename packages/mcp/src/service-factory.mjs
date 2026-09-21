import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContextOSV2Service } from './v2-service.mjs';
import { HybridContextOSService } from './hybrid-service.mjs';
import { getGlobalCloudConfig, deriveProjectId } from './bootstrap-util.mjs';

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

export function resolveProjectTransport(root) {
  let mode = 'local';
  let cloudUrl = null;
  let token = null;
  let projectId = deriveProjectId(root);

  const projJsonPath = path.join(root, '.contextos', 'project.json');
  if (fs.existsSync(projJsonPath)) {
    try {
      const proj = JSON.parse(fs.readFileSync(projJsonPath, 'utf8'));
      if (proj.id) projectId = proj.id;
      if (proj.storage === 'cloud' || proj.isCloud === true) {
        mode = 'cloud';
        const globalCloud = getGlobalCloudConfig();
        cloudUrl = proj.cloudUrl || globalCloud?.cloudUrl || process.env.CONTEXTOS_CLOUD_URL || process.env.CONTEXTOS_REMOTE_URL;
        token = globalCloud?.token || process.env.CONTEXTOS_CLOUD_TOKEN || process.env.CONTEXTOS_TOKEN;
      } else if (proj.storage === 'local' || proj.isCloud === false) {
        mode = 'local';
      }
    } catch (_) {}
  } else {
    if (process.env.CONTEXTOS_CLOUD_URL || process.env.CONTEXTOS_REMOTE_URL) {
      mode = 'cloud';
      cloudUrl = process.env.CONTEXTOS_CLOUD_URL || process.env.CONTEXTOS_REMOTE_URL;
      token = process.env.CONTEXTOS_CLOUD_TOKEN || process.env.CONTEXTOS_TOKEN;
      projectId = process.env.CONTEXTOS_PROJECT_ID || deriveProjectId(root);
    }
  }

  return { mode, cloudUrl, token, projectId };
}

export function getService(projectRoot) {
  const root = requireProjectRoot(projectRoot);
  const { mode, cloudUrl, token, projectId } = resolveProjectTransport(root);

  const cacheKey = mode === 'cloud' && cloudUrl
    ? `cloud:${cloudUrl}:${projectId}:${root}`
    : `local:${root}:${projectId}`;

  if (!serviceCache.has(cacheKey)) {
    if (mode === 'cloud' && cloudUrl) {
      serviceCache.set(
        cacheKey,
        new HybridContextOSService({ cloudUrl, token, projectId, projectRoot: root })
      );
    } else {
      serviceCache.set(cacheKey, new ContextOSV2Service({ projectRoot: root, projectId }));
    }
  }
  return serviceCache.get(cacheKey);
}

export function evictServices(projectRoot) {
  for (const key of Array.from(serviceCache.keys())) {
    if (key.endsWith(`:${projectRoot}`) || key.includes(`:${projectRoot}:`)) {
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
