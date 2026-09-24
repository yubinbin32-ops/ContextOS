import fs from 'node:fs';
import path from 'node:path';

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

/**
 * Project-level orchestration profile. Lives in `.contextos/profile.json` and is
 * optional; without it the OS infers verification commands from package.json.
 */
export function loadProfile(projectRoot) {
  const defaults = { strict: false, strictArchitecture: false, verify: [], maxChars: 1500, timeoutMs: 120000, budget: null };
  const profilePath = path.join(projectRoot, '.contextos', 'profile.json');
  let stored = {};
  if (fs.existsSync(profilePath)) {
    try {
      stored = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    } catch (_) {
      stored = {};
    }
  }
  const verify = Array.isArray(stored.verify) && stored.verify.length > 0
    ? stored.verify
    : inferFromPackageJson(projectRoot);
  return { ...defaults, ...stored, verify };
}

export function saveProfile(projectRoot, patch = {}) {
  const profilePath = path.join(projectRoot, '.contextos', 'profile.json');
  const current = loadProfile(projectRoot);
  const next = { ...current, ...patch };
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(profilePath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}
