import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodeTools } from './code-tools.mjs';

function resolveWorkspacePath(projectRoot, inputPath, label = 'path') {
  if (typeof inputPath !== 'string' || !inputPath.trim()) {
    throw new Error(`${label} is required`);
  }
  const fullPath = path.resolve(projectRoot, inputPath);
  const relativePath = path.relative(projectRoot, fullPath).split(path.sep).join('/');
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`${label} '${inputPath}' is outside project root '${projectRoot}'`);
  }
  if (fs.existsSync(fullPath) && fs.lstatSync(fullPath).isSymbolicLink()) {
    throw new Error(`${label} '${inputPath}' is a symbolic link; refusing to modify it`);
  }
  return { fullPath, relativePath };
}

function ensureParentDirectory(fullPath, createdDirectories) {
  const parent = path.dirname(fullPath);
  const missing = [];
  let current = parent;
  while (!fs.existsSync(current)) {
    missing.push(current);
    current = path.dirname(current);
  }
  fs.mkdirSync(parent, { recursive: true });
  for (const directory of missing.reverse()) createdDirectories.push(directory);
}

function planChangeset(projectRoot, changes = []) {
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new Error('Changeset requires at least one create, edit, or delete operation');
  }

  const states = new Map();
  const results = [];

  for (let index = 0; index < changes.length; index += 1) {
    const change = { ...(changes[index] || {}) };
    const resolved = resolveWorkspacePath(projectRoot, change.path, 'changeset path');
    let state = states.get(resolved.fullPath);

    // A complete new file has an unambiguous intent even when a caller puts
    // it in edits. Keep missing source-target edits rejected and stay atomic.
    if (change.kind === 'edit' && change.fullFile === true && typeof change.replacement === 'string'
      && !state && !fs.existsSync(resolved.fullPath)
      && !['target', 'startLine', 'endLine', 'expectedHash', 'hash'].some(key => change[key] !== undefined)) {
      change.kind = 'create';
      change.content = change.replacement;
      change.overwrite = false;
    }

    if (change.kind === 'create') {
      if (state) throw new Error(`Changeset operation ${index + 1} cannot create '${resolved.relativePath}' twice`);
      const exists = fs.existsSync(resolved.fullPath);
      if (exists && !change.overwrite) {
        throw new Error(`Changeset operation ${index + 1} cannot create existing file '${resolved.relativePath}'`);
      }
      if (typeof change.content !== 'string') {
        throw new Error(`Changeset operation ${index + 1} requires string content for '${resolved.relativePath}'`);
      }
      const created = CodeTools.create(resolved.relativePath, change.content);
      state = {
        path: resolved.relativePath,
        fullPath: resolved.fullPath,
        existed: exists,
        originalContent: exists ? fs.readFileSync(resolved.fullPath, 'utf8') : null,
        newContent: change.content,
        newHash: created.newHash,
        locators: created.locators,
        mode: exists ? fs.statSync(resolved.fullPath).mode : 0o644,
      };
      states.set(resolved.fullPath, state);
      results.push({ index, kind: 'create', path: resolved.relativePath, newHash: created.newHash, locators: created.locators });
      continue;
    }

    if (change.kind === 'delete') {
      if (state?.deleted === true) {
        throw new Error(`Changeset operation ${index + 1} cannot delete '${resolved.relativePath}' twice`);
      }
      if (state && !state.existed) {
        throw new Error(`Changeset operation ${index + 1} cannot delete '${resolved.relativePath}' created in the same changeset`);
      }
      if (!fs.existsSync(resolved.fullPath)) {
        throw new Error(`Changeset operation ${index + 1} cannot delete missing file '${resolved.relativePath}'`);
      }
      if (!fs.statSync(resolved.fullPath).isFile()) {
        throw new Error(`Changeset operation ${index + 1} cannot delete non-file '${resolved.relativePath}'`);
      }
      if (!state) {
        state = {
          path: resolved.relativePath,
          fullPath: resolved.fullPath,
          existed: true,
          originalContent: fs.readFileSync(resolved.fullPath, 'utf8'),
          newContent: null,
          newHash: null,
          locators: [],
          mode: fs.statSync(resolved.fullPath).mode,
          deleted: true,
        };
        states.set(resolved.fullPath, state);
      } else {
        state.deleted = true;
        state.newContent = null;
        state.newHash = null;
        state.locators = [];
      }
      results.push({ index, kind: 'delete', path: resolved.relativePath, newHash: null, locators: [], deleted: true });
      continue;
    }

    if (change.kind !== 'edit') {
      throw new Error(`Changeset operation ${index + 1} has unknown kind '${change.kind || ''}'`);
    }
    if (state?.deleted === true) {
      throw new Error(`Changeset operation ${index + 1} cannot edit '${resolved.relativePath}' after it was deleted`);
    }

    if (!state) {
      if (!fs.existsSync(resolved.fullPath)) {
        throw new Error(`Changeset operation ${index + 1} cannot edit missing file '${resolved.relativePath}'`);
      }
      if (!fs.statSync(resolved.fullPath).isFile()) {
        throw new Error(`Changeset operation ${index + 1} cannot edit non-file '${resolved.relativePath}'`);
      }
      const originalContent = fs.readFileSync(resolved.fullPath, 'utf8');
      state = {
        path: resolved.relativePath,
        fullPath: resolved.fullPath,
        existed: true,
        originalContent,
        newContent: originalContent,
        newHash: '',
        locators: [],
        mode: fs.statSync(resolved.fullPath).mode,
      };
      states.set(resolved.fullPath, state);
    }

    if (change.fullFile) {
      if (typeof change.replacement !== 'string') {
        throw new Error(`Changeset operation ${index + 1} requires string replacement for fullFile edit '${resolved.relativePath}'`);
      }
      const edited = CodeTools.edit(resolved.relativePath, state.newContent, {
        replacementContent: change.replacement,
        fullFile: true,
      });
      state.newContent = edited.newContent;
      state.newHash = edited.newHash;
      state.locators = edited.updatedLocators;
      results.push({ index, kind: 'edit', path: resolved.relativePath, newHash: edited.newHash, locators: edited.updatedLocators });
      continue;
    }

    const edited = CodeTools.edit(resolved.relativePath, state.newContent, {
      targetContent: change.target ?? null,
      replacementContent: change.replacement ?? '',
      startLine: change.startLine ?? null,
      endLine: change.endLine ?? null,
      symbol: change.symbol ?? null,
      append: change.append ?? null,
    });
    state.newContent = edited.newContent;
    state.newHash = edited.newHash;
    state.locators = edited.updatedLocators;
    results.push({ index, kind: 'edit', path: resolved.relativePath, newHash: edited.newHash, locators: edited.updatedLocators });
  }

  return { files: Array.from(states.values()), results };
}

function commitChangeset(plan) {
  const prepared = [];
  const createdDirectories = [];

  try {
    for (const file of plan.files) {
      const token = `${process.pid}-${randomUUID()}`;
      const backupPath = file.existed
        ? path.join(path.dirname(file.fullPath), `.${path.basename(file.fullPath)}.contextos-${token}.bak`)
        : null;
      if (file.deleted === true) {
        prepared.push({ ...file, tempPath: null, backupPath, committed: false });
        continue;
      }
      ensureParentDirectory(file.fullPath, createdDirectories);
      const tempPath = path.join(path.dirname(file.fullPath), `.${path.basename(file.fullPath)}.contextos-${token}.tmp`);
      fs.writeFileSync(tempPath, file.newContent, { encoding: 'utf8', mode: file.mode || 0o644 });
      prepared.push({ ...file, tempPath, backupPath, committed: false });
    }

    for (const file of prepared) {
      if (file.deleted === true) {
        fs.renameSync(file.fullPath, file.backupPath);
      } else if (file.existed) {
        fs.renameSync(file.fullPath, file.backupPath);
        fs.renameSync(file.tempPath, file.fullPath);
      } else {
        fs.renameSync(file.tempPath, file.fullPath);
      }
      file.committed = true;
    }

    for (const file of prepared) {
      if (file.backupPath && fs.existsSync(file.backupPath)) fs.rmSync(file.backupPath, { force: true });
    }

    return {
      files: prepared.map((file) => ({
        path: file.path,
        newHash: file.newHash,
        locators: file.locators,
        created: !file.existed && file.deleted !== true,
        ...(file.deleted === true ? { deleted: true } : {}),
      })),
      results: plan.results,
    };
  } catch (error) {
    const rollbackErrors = [];
    for (const file of [...prepared].reverse()) {
      try {
        if (file.backupPath && fs.existsSync(file.backupPath)) {
          if (fs.existsSync(file.fullPath)) fs.rmSync(file.fullPath, { force: true });
          fs.renameSync(file.backupPath, file.fullPath);
        } else if (!file.existed && file.committed && fs.existsSync(file.fullPath)) {
          fs.rmSync(file.fullPath, { force: true });
        }
      } catch (rollbackError) {
        rollbackErrors.push({ path: file.path, error: rollbackError.message });
      }
    }

    for (const file of prepared) {
      try {
        if (file.tempPath && fs.existsSync(file.tempPath)) fs.rmSync(file.tempPath, { force: true });
        if (file.backupPath && fs.existsSync(file.backupPath)) fs.rmSync(file.backupPath, { force: true });
      } catch (_) {}
    }
    for (const directory of createdDirectories.reverse()) {
      try {
        if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
      } catch (_) {}
    }

    const failure = new Error(
      rollbackErrors.length > 0
        ? `Changeset commit failed and rollback was incomplete: ${error.message}`
        : `Changeset commit failed and was rolled back: ${error.message}`
    );
    failure.partial = rollbackErrors.length > 0;
    failure.rollbackErrors = rollbackErrors;
    failure.cause = error;
    throw failure;
  } finally {
    for (const file of prepared) {
      try {
        if (file.tempPath && fs.existsSync(file.tempPath)) fs.rmSync(file.tempPath, { force: true });
      } catch (_) {}
    }
  }
}

export function applyChangeset(projectRoot, changes = []) {
  const plan = planChangeset(projectRoot, changes);
  return commitChangeset(plan);
}
