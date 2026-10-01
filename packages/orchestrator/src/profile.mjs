import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const VERIFY_SCRIPT_PRIORITY = ['test', 'lint', 'build'];

function inferFromPackageJson(projectRoot) {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const scripts = pkg.scripts || {};
    const found = [];
    for (const name of VERIFY_SCRIPT_PRIORITY) {
      if (scripts[name]) found.push(`npm run ${name}`);
    }
    return found.slice(0, 2);
  } catch (_) {
    return [];
  }
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch (_) {
    return {};
  }
}

function mergeProfile(base, override) {
  const micro = base.micro && override.micro
    ? { ...base.micro, ...override.micro }
    : (override.micro ?? base.micro ?? null);
  return { ...base, ...override, micro };
}

export function globalProfilePath() {
  const home = process.env.CONTEXTOS_HOME || path.join(os.homedir(), '.contextos');
  return path.join(home, 'profile.json');
}

/**
 * Project-level orchestration profile. Lives in `.contextos/profile.json` and is
 * optional; without it the OS infers verification commands from package.json.
 */
export function loadProfile(projectRoot) {
  const defaults = {
    strict: false,
    strictArchitecture: false,
    autoTriage: false,
    shipExportsGraph: false,
    verify: [],
    maxChars: 1500,
    timeoutMs: 120000,
    budget: null,
    micro: null,
  };
  const profilePath = path.join(projectRoot, '.contextos', 'profile.json');
  const globalStored = readJson(globalProfilePath());
  const projectStored = readJson(profilePath);
  const stored = mergeProfile(globalStored, projectStored);
  const merged = mergeProfile(defaults, stored);
  const verify = Array.isArray(merged.verify) && merged.verify.length > 0
    ? merged.verify
    : inferFromPackageJson(projectRoot);
  return { ...merged, verify };
}

export function saveProfile(projectRoot, patch = {}, { scope = 'project' } = {}) {
  const profilePath = scope === 'global'
    ? globalProfilePath()
    : path.join(projectRoot, '.contextos', 'profile.json');
  let current = {};
  if (fs.existsSync(profilePath)) {
    current = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('Invalid profile; settings were not changed.');
  }
  const next = mergeProfile(current, patch);
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  const temp = `${profilePath}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, profilePath);
  return next;
}
