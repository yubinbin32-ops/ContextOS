import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const LOCK_DIR_NAME = 'project.lock';

function lockPath(projectRoot) {
  return path.join(path.resolve(projectRoot), '.contextos', LOCK_DIR_NAME);
}

function readOwner(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function isStale(lockDir, owner, staleMs) {
  const createdAt = owner?.createdAt ? Date.parse(owner.createdAt) : NaN;
  let stat = null;
  try {
    stat = fs.statSync(lockDir);
  } catch (_) {
    return true;
  }
  const timestamp = Number.isFinite(createdAt) ? createdAt : stat?.mtimeMs || 0;
  if (!timestamp || Date.now() - timestamp <= staleMs) return false;
  if (owner?.pid && processIsAlive(owner.pid)) return false;
  return true;
}

function removeLockDirectory(lockDir) {
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch (_) {}
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function inspectProjectWriteLock(projectRoot) {
  const lockDir = lockPath(projectRoot);
  if (!fs.existsSync(lockDir)) return null;
  const owner = readOwner(lockDir);
  let stat;
  try {
    stat = fs.statSync(lockDir);
  } catch (_) {
    return null;
  }
  return {
    path: lockDir,
    owner,
    ageMs: Date.now() - stat.mtimeMs,
    alive: owner?.pid ? processIsAlive(owner.pid) : false,
  };
}

export async function withProjectWriteLock(
  projectRoot,
  callback,
  { timeoutMs = 15000, staleMs = 60000, label = 'write' } = {}
) {
  const absoluteRoot = path.resolve(projectRoot);
  const lockDir = lockPath(absoluteRoot);
  const token = crypto.randomBytes(12).toString('hex');
  const startedAt = Date.now();
  const owner = {
    token,
    pid: process.pid,
    label,
    projectRoot: absoluteRoot,
    createdAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(lockDir), { recursive: true });

  while (true) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(owner, null, 2) + '\n', 'utf8');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      const currentOwner = readOwner(lockDir);
      if (isStale(lockDir, currentOwner, staleMs)) {
        const staleDir = `${lockDir}.stale-${token}-${Date.now()}`;
        try {
          fs.renameSync(lockDir, staleDir);
          removeLockDirectory(staleDir);
          continue;
        } catch (_) {}
      }

      if (Date.now() - startedAt >= timeoutMs) {
        const holder = currentOwner
          ? `pid=${currentOwner.pid || 'unknown'} label=${currentOwner.label || 'unknown'}`
          : 'unknown holder';
        throw new Error(`Project write lock timeout in ${label}: ${holder}`);
      }
      await sleep(40);
    }
  }

  const release = () => {
    const currentOwner = readOwner(lockDir);
    if (currentOwner?.token !== token) return;
    const releasedDir = `${lockDir}.released-${token}`;
    try {
      fs.renameSync(lockDir, releasedDir);
      removeLockDirectory(releasedDir);
    } catch (_) {
      removeLockDirectory(lockDir);
    }
  };

  try {
    return await callback();
  } finally {
    release();
  }
}
