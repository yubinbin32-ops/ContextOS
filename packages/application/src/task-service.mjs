import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Task, assertBlockHasRealCode } from '../../../packages/domain/src/index.mjs';
import {
  CoverageChecker,
  LanguageRegistry,
  calculateTreeHash,
} from '../../../packages/code-intel/src/index.mjs';

const CODE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.go', '.rs', '.swift', '.java', '.kt', '.kts',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.cs',
  '.php', '.rb',
]);

const IGNORED_DIRS = new Set([
  '.git', 'node_modules', '.contextos', 'dist', 'build', '.build',
  '.next', '.nuxt', 'coverage', '.turbo', 'deriveddata',
]);

const EXCLUDED_DISCOVERY_DIRS = new Set(['.git', '.contextos', 'node_modules']);

function normalizeRelPath(filePath) {
  return String(filePath).replace(/\\/g, '/').replace(/^\.\//, '');
}

function isInsideProject(projectRoot, filePath) {
  const fullPath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(projectRoot, filePath);
  const relative = path.relative(path.resolve(projectRoot), fullPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function taskScopeFromWorkingSet(files = [], projectRoot = process.cwd(), scopeDirs = []) {
  const dirs = new Set();
  const exactFiles = new Set();
  for (const filePath of files) {
    const normalized = normalizeRelPath(filePath);
    const fullPath = path.resolve(projectRoot, normalized);
    const relativeToRoot = path.relative(path.resolve(projectRoot), fullPath);
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) continue;
    let isDirectory = false;
    try {
      isDirectory = fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();
    } catch (_) {}
    if (isDirectory) {
      const root = normalized === '.' ? '' : normalized.replace(/\/+$/, '');
      if (!root.split('/').some((segment) => IGNORED_DIRS.has(segment.toLowerCase()))) dirs.add(root);
      continue;
    }
    exactFiles.add(normalized);
  }
  for (const scopeDir of scopeDirs) {
    const normalized = normalizeRelPath(scopeDir).replace(/\/+$/, '');
    const fullPath = path.resolve(projectRoot, normalized || '.');
    const relativeToRoot = path.relative(path.resolve(projectRoot), fullPath);
    if (!relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot)) {
      if (!normalized.split('/').some((segment) => IGNORED_DIRS.has(segment.toLowerCase()))) {
        dirs.add(normalized);
      }
    }
  }
  return { dirs: Array.from(dirs), exactFiles };
}

function isPathInScope(relativePath, scope) {
  const normalized = normalizeRelPath(relativePath);
  if (scope.exactFiles.has(normalized)) return true;
  return scope.dirs.some((dir) => !dir || normalized === dir || normalized.startsWith(`${dir}/`));
}

function scanScopedSourceFiles(projectRoot, workingSetFiles, scopeDirs = [], maxFiles = 300) {
  const result = [];
  const searchDirs = taskScopeFromWorkingSet(workingSetFiles, projectRoot, scopeDirs).dirs;

  const walk = (dir, relDir = '', depth = 0) => {
    if (depth > 5 || result.length >= maxFiles) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      if (IGNORED_DIRS.has(ent.name.toLowerCase())) continue;
      const childRel = relDir ? path.posix.join(relDir, ent.name) : ent.name;
      const childFull = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(childFull, childRel, depth + 1);
      } else if (ent.isFile() && CODE_EXTENSIONS.has(path.extname(ent.name).toLowerCase())) {
        result.push(childRel);
      }
    }
  };

  for (const sDir of searchDirs) {
    const full = path.join(projectRoot, sDir);
    const relativeToRoot = path.relative(path.resolve(projectRoot), path.resolve(full));
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) continue;
    if (fs.existsSync(full)) {
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full, sDir, 0);
      else if (CODE_EXTENSIONS.has(path.extname(full).toLowerCase())) result.push(sDir);
    }
  }

  return result;
}

function parseGitStatusPorcelainV2(rawOutput) {
  const tokens = String(rawOutput).split('\0');
  const paths = [];
  for (const token of tokens) {
    if (!token) continue;
    if (token.startsWith('1 ')) {
      const parts = token.split(' ');
      if (parts.length >= 9) paths.push(parts.slice(8).join(' '));
    } else if (token.startsWith('2 ')) {
      const parts = token.split(' ');
      if (parts.length >= 10) paths.push(parts.slice(9).join(' '));
    } else if (token.startsWith('u ')) {
      const parts = token.split(' ');
      if (parts.length >= 11) paths.push(parts.slice(10).join(' '));
    } else if (token.startsWith('? ') || token.startsWith('! ')) {
      paths.push(token.slice(2));
    }
  }
  return paths;
}

function readScopedGitChangedPaths(projectRoot, scope) {
  if (!projectRoot || (scope.dirs.length === 0 && scope.exactFiles.size === 0)) return [];
  try {
    const raw = execFileSync('git', ['status', '--porcelain=v2', '-z', '--untracked-files=all'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return parseGitStatusPorcelainV2(raw)
      .map(normalizeRelPath)
      .filter((filePath) => isPathInScope(filePath, scope))
      .filter((filePath) =>
        filePath &&
        !filePath.startsWith('.contextos') &&
        !filePath.startsWith('.git') &&
        !filePath.split('/').some((segment) => EXCLUDED_DISCOVERY_DIRS.has(segment.toLowerCase()))
      );
  } catch (_) {
    return [];
  }
}

export class TaskService {
  constructor(db, syncEngine) {
    this.db = db;
    this.syncEngine = syncEngine;
  }

  _initializeFileSnapshots(task, projectRoot) {
    if (!task.baseline) {
      task.baseline = { fileSnapshots: {} };
    }
    if (!task.baseline.fileSnapshots) {
      task.baseline.fileSnapshots = {};
    }
    const scope = taskScopeFromWorkingSet(
      task.workingSet.files || [],
      projectRoot,
      task.workingSet.scopeDirs || []
    );
    const filesToSnapshot = new Set([
      ...(task.workingSet.files || []),
      ...scanScopedSourceFiles(
        projectRoot,
        task.workingSet.files || [],
        task.workingSet.scopeDirs || []
      ),
      ...readScopedGitChangedPaths(projectRoot, scope),
    ]);
    for (const relPath of filesToSnapshot) {
      if (!isInsideProject(projectRoot, relPath)) continue;
      if (task.baseline.fileSnapshots[relPath]) continue;
      const fullPath = path.isAbsolute(relPath) ? relPath : path.join(projectRoot, relPath);
      if (fs.existsSync(fullPath)) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) continue;
          const content = fs.readFileSync(fullPath);
          const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
          task.baseline.fileSnapshots[relPath] = {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            hash,
            snapshottedAt: new Date().toISOString(),
          };
        } catch (_) {}
      }
    }
    task.baseline.initializedAt = task.baseline.initializedAt || new Date().toISOString();
  }

  _refreshFileAstAndLocators(relPath, content, dbBlocks, task) {
    try {
      const structure = LanguageRegistry.parseStructure(relPath, content);
      const fileHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
      const newLocators = (structure.symbols || []).map((s) => ({
        path: relPath,
        symbol: s.name,
        startLine: s.startLine,
        endLine: s.endLine,
        hash: s.hash,
        role: 'implementation',
      }));

      // 1. Update task locators
      if (task && task.contextSlice) {
        const remaining = (task.contextSlice.locators || []).filter((l) => l.path !== relPath);
        task.contextSlice.locators = [...remaining, ...newLocators];
      }

      // 2. Update matching block artifactRefs
      for (const block of dbBlocks || []) {
        let blockModified = false;
        for (const ref of block.artifactRefs || []) {
          if (ref.path !== relPath) continue;
          const anchorKind = ref.anchorKind || (ref.symbol ? 'symbol' : 'file');
          if (anchorKind === 'symbol') {
            const symbol = newLocators.find((locator) => locator.symbol === ref.symbol);
            if (!symbol) continue;
            ref.anchorKind = 'symbol';
            if (ref.hash !== symbol.hash) {
              ref.hash = symbol.hash;
              blockModified = true;
            }
            if (ref.startLine !== symbol.startLine || ref.endLine !== symbol.endLine) {
              ref.startLine = symbol.startLine;
              ref.endLine = symbol.endLine;
              blockModified = true;
            }
          } else {
            ref.anchorKind = 'file';
            if (ref.hash !== fileHash) {
              ref.hash = fileHash;
              blockModified = true;
            }
          }
        }
        if (blockModified) {
          this.db.saveBlock(block);
        }
      }
    } catch (_) {}
  }

  _reconcileWorkingSet(task, projectRoot, dbBlocks = []) {
    if (!projectRoot || !fs.existsSync(projectRoot)) return;

    if (!task.baseline) {
      task.baseline = { fileSnapshots: {} };
    }
    if (!task.baseline.fileSnapshots) {
      task.baseline.fileSnapshots = {};
    }
    if (!task.baseline.initializedAt) {
      this._initializeFileSnapshots(task, projectRoot);
    }

    const scope = taskScopeFromWorkingSet(
      task.workingSet.files || [],
      projectRoot,
      task.workingSet.scopeDirs || []
    );
    const candidateFiles = new Set([
      ...(task.workingSet.files || []),
      ...Object.keys(task.baseline.fileSnapshots),
      ...scanScopedSourceFiles(
        projectRoot,
        task.workingSet.files || [],
        task.workingSet.scopeDirs || []
      ),
      ...readScopedGitChangedPaths(projectRoot, scope),
    ]);

    // High-precision host modification detection via mtime + SHA256 hash comparison.
    for (const relPath of candidateFiles) {
      if (!isInsideProject(projectRoot, relPath)) continue;
      const fullPath = path.isAbsolute(relPath) ? relPath : path.join(projectRoot, relPath);
      if (!fs.existsSync(fullPath)) {
        if (task.baseline.fileSnapshots[relPath]) {
          delete task.baseline.fileSnapshots[relPath];
          task.workingSet.files = (task.workingSet.files || []).filter((file) => file !== relPath);
          const parent = path.posix.dirname(normalizeRelPath(relPath));
          if (parent && parent !== '.') {
            task.workingSet.scopeDirs = [...new Set([...(task.workingSet.scopeDirs || []), parent])];
          }
          if (task.contextSlice && task.contextSlice.locators) {
            task.contextSlice.locators = task.contextSlice.locators.filter((l) => l.path !== relPath);
          }
          task.addNote({
            text: `[Host Native Modification] Detected external deletion of '${relPath}'. Cleaned up baseline snapshots and locators.`,
            kind: 'system',
          });
        }
        continue;
      }

      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch (_) {
        continue;
      }
      if (stat.isDirectory()) continue;

      const snapshot = task.baseline.fileSnapshots[relPath];
      const statChanged = !snapshot || stat.mtimeMs !== snapshot.mtimeMs || stat.size !== snapshot.size;

      if (statChanged) {
        let content;
        try {
          content = fs.readFileSync(fullPath);
        } catch (_) {
          continue;
        }

        const currentHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
        const blockRef = dbBlocks.flatMap((b) => b.artifactRefs || []).find((r) => r.path === relPath);
        const baseHash = snapshot ? snapshot.hash : (blockRef?.hash || null);

        if (!baseHash || currentHash !== baseHash) {
          // Native modification or new file confirmed!
          task.addFileToWorkingSet(relPath);

          // Update snapshot
          task.baseline.fileSnapshots[relPath] = {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            hash: currentHash,
            modifiedLocally: true,
            lastReconciledAt: new Date().toISOString(),
          };

          // Seamlessly refresh AST outlines and update block locators
          this._refreshFileAstAndLocators(relPath, content.toString('utf8'), dbBlocks, task);

          task.addNote({
            text: `[Host Native Modification] Detected external disk modification in '${relPath}' via mtime/SHA256 comparison (${baseHash ? `${baseHash.slice(0, 8)} -> ${currentHash.slice(0, 8)}` : `new: ${currentHash.slice(0, 8)}`}). Working set and AST outlines refreshed.`,
            kind: 'system',
          });
        } else {
          // Stat changed (e.g. touch or formatting without content diff), but hash matches
          if (!task.baseline.fileSnapshots[relPath]) {
            task.baseline.fileSnapshots[relPath] = {
              mtimeMs: stat.mtimeMs,
              size: stat.size,
              hash: currentHash,
              snapshottedAt: new Date().toISOString(),
            };
          } else {
            task.baseline.fileSnapshots[relPath].mtimeMs = stat.mtimeMs;
            task.baseline.fileSnapshots[relPath].size = stat.size;
          }
        }
      }
    }
  }

  createTask(taskData = {}, projectRoot = null) {
    const {
      id,
      planId,
      phaseId,
      title,
      status = 'draft',
      contextSlice = {},
      workingSet = {},
      references = {},
      rules,
      ruleRefs,
      baseline = {},
    } = taskData;

    const taskRules = Array.isArray(rules)
      ? rules
      : (Array.isArray(ruleRefs)
        ? ruleRefs
        : (Array.isArray(references?.rules) ? references.rules : []));

    const task = new Task({
      id: id || `task-${Date.now()}`,
      planId,
      phaseId,
      title,
      status,
      contextSlice,
      workingSet,
      references,
      rules: taskRules,
      baseline,
    });

    if (projectRoot && fs.existsSync(projectRoot)) {
      this._initializeFileSnapshots(task, projectRoot);
    }

    this.db.saveTask(task.toJSON());
    this._attachTaskToPlanPhase(task);
    return task.toJSON();
  }

  _attachTaskToPlanPhase(task) {
    if (!task.planId || !task.phaseId) return;
    const plan = this.db.getPlan(task.planId);
    if (!plan) return;
    const phase = (plan.phases || []).find((item) => item.id === task.phaseId);
    if (!phase) return;
    if (!Array.isArray(phase.taskIds)) phase.taskIds = [];
    if (!phase.taskIds.includes(task.id)) {
      phase.taskIds.push(task.id);
      plan.updatedAt = new Date().toISOString();
      this.db.savePlan(plan);
    }
  }

  bindRule(taskId, ruleId) {
    const raw = this.db.getTask(taskId);
    if (!raw) throw new Error(`Task '${taskId}' not found`);
    const task = new Task(raw);
    task.bindRule(ruleId);
    this.db.saveTask(task.toJSON());
    return task.toJSON();
  }

  unbindRule(taskId, ruleId) {
    const raw = this.db.getTask(taskId);
    if (!raw) throw new Error(`Task '${taskId}' not found`);
    const task = new Task(raw);
    task.unbindRule(ruleId);
    this.db.saveTask(task.toJSON());
    return task.toJSON();
  }

  updateTask(taskId, taskData = {}) {
    const raw = this.db.getTask(taskId);
    if (!raw) throw new Error(`Task '${taskId}' not found`);

    const updated = { ...raw };
    if (taskData.title !== undefined) updated.title = taskData.title;
    if (taskData.status !== undefined) updated.status = taskData.status;
    if (taskData.contextSlice) {
      updated.contextSlice = { ...raw.contextSlice, ...taskData.contextSlice };
    }
    if (taskData.workingSet) {
      const incomingWorkingSet = Array.isArray(taskData.workingSet)
        ? { files: taskData.workingSet }
        : taskData.workingSet;
      updated.workingSet = { ...raw.workingSet, ...incomingWorkingSet };
    }
    if (taskData.references) {
      updated.references = { ...raw.references, ...taskData.references };
    }

    const incomingRules = taskData.rules !== undefined
      ? taskData.rules
      : (taskData.ruleRefs !== undefined
        ? taskData.ruleRefs
        : (taskData.references?.rules !== undefined ? taskData.references.rules : undefined));

    if (incomingRules !== undefined) {
      const cleanRules = Array.isArray(incomingRules) ? [...incomingRules] : [];
      updated.rules = cleanRules;
      updated.references = updated.references || {};
      updated.references.rules = cleanRules;
    } else {
      updated.rules = updated.references?.rules || raw.rules || [];
    }

    if (taskData.notes) updated.notes = taskData.notes;
    if (taskData.checks) updated.checks = taskData.checks;

    const task = new Task(updated);
    task.updatedAt = new Date().toISOString();
    this.db.saveTask(task.toJSON());
    this._attachTaskToPlanPhase(task);
    return task.toJSON();
  }

  getTask(taskId) {
    return this.db.getTask(taskId);
  }

  listTasks(planId = null) {
    return this.db.listTasks(planId);
  }

  findActiveTask(projectId) {
    if (!projectId) return null;
    const planIds = new Set(this.db.listPlans(projectId).map((plan) => plan.id));
    return (
      this.db
        .listTasks()
        .filter(
          (task) =>
            planIds.has(task.planId) &&
            ['active', 'checking', 'syncing'].includes(task.status)
        )
        .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))
        .at(-1) || null
    );
  }

  repairStateHygiene(projectId, { staleMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
    const plans = this.db.listPlans(projectId);
    const planMap = new Map(plans.map((plan) => [plan.id, plan]));
    const tasks = this.db.listTasks().filter((task) => planMap.has(task.planId));
    const blockedTaskIds = [];
    const now = Date.now();

    for (const raw of tasks) {
      const plan = planMap.get(raw.planId);
      const activeLike = ['active', 'checking', 'syncing'].includes(raw.status);
      if (!activeLike) continue;
      const updatedAt = Date.parse(raw.updatedAt || '');
      const stale = Number.isFinite(updatedAt) && now - updatedAt > staleMs;
      if (plan?.status === 'completed' || stale) {
        const task = new Task(raw);
        task.block(
          plan?.status === 'completed'
            ? `Plan '${plan.id}' is completed.`
            : `Task lease expired after ${staleMs}ms without progress.`
        );
        this.db.saveTask(task.toJSON());
        blockedTaskIds.push(task.id);
      }
    }

    const remainingActive = this.db
      .listTasks()
      .filter(
        (task) =>
          planMap.has(task.planId) &&
          planMap.get(task.planId)?.status === 'active' &&
          ['active', 'checking', 'syncing'].includes(task.status)
      )
      .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));

    for (const raw of remainingActive.slice(0, -1)) {
      const task = new Task(raw);
      task.block(`Superseded by newer active task '${remainingActive.at(-1)?.id || 'unknown'}'.`);
      this.db.saveTask(task.toJSON());
      blockedTaskIds.push(task.id);
    }

    return {
      changed: blockedTaskIds.length,
      blockedTaskIds: [...new Set(blockedTaskIds)],
    };
  }

  activateTask(taskId, projectRoot = null) {
    const raw = this.db.getTask(taskId);
    if (!raw) throw new Error(`Task '${taskId}' not found`);
    const plan = this.db.getPlan(raw.planId);
    const projectId = plan?.projectId || plan?.project_id || null;
    const active = projectId ? this.findActiveTask(projectId) : null;
    if (active && active.id !== taskId) {
      throw new Error(
        `Cannot activate Task '${taskId}' while Task '${active.id}' is ${active.status}. Resolve or resume the active task first.`
      );
    }
    const task = new Task(raw);
    task.activate();
    if (projectRoot && fs.existsSync(projectRoot)) {
      this._initializeFileSnapshots(task, projectRoot);
      this._reconcileWorkingSet(task, projectRoot, this.db.listBlocks(raw.projectId));
    }
    this.db.saveTask(task.toJSON());
    return task.toJSON();
  }

  reconcileTask(taskId, projectRoot, projectId = null) {
    const raw = this.db.getTask(taskId);
    if (!raw) throw new Error(`Task '${taskId}' not found`);
    const task = new Task(raw);
    const dbBlocks = (projectId ? this.db.listBlocks(projectId) : this.db.listBlocks()) || [];
    this._reconcileWorkingSet(task, projectRoot, dbBlocks);
    this.db.saveTask(task.toJSON());
    return task.toJSON();
  }

  addNote(taskId, { text, kind = 'journal' }) {
    const raw = this.db.getTask(taskId);
    if (!raw) throw new Error(`Task '${taskId}' not found`);
    const task = new Task(raw);
    const note = task.addNote({ text, kind });
    this.db.saveTask(task.toJSON());
    return note;
  }

  addFileToWorkingSet(taskId, filePath) {
    const raw = this.db.getTask(taskId);
    if (!raw) throw new Error(`Task '${taskId}' not found`);
    const task = new Task(raw);
    task.addFileToWorkingSet(filePath);
    this.db.saveTask(task.toJSON());
    return task.toJSON();
  }

  addCheck(taskId, { receiptId = null, description, passed = true, evidence = '' }, projectRoot = null, projectId = null) {
    const raw = this.db.getTask(taskId);
    if (!raw) throw new Error(`Task '${taskId}' not found`);
    let receipt = null;
    if (receiptId) {
      receipt = this.db.getCommandReceipt(receiptId);
      if (!receipt) throw new Error(`Command receipt '${receiptId}' not found`);
      if (projectRoot && receipt.cwd) {
        const relative = path.relative(path.resolve(projectRoot), path.resolve(receipt.cwd));
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error(`Command receipt '${receiptId}' belongs to a different project`);
        }
      }
      if (passed && receipt.exitCode !== 0) {
        throw new Error(`Cannot record a passing check for receipt '${receiptId}' with exit code ${receipt.exitCode}`);
      }
    }
    const task = new Task(raw);
    if (projectRoot && fs.existsSync(projectRoot)) {
      const dbBlocks = (projectId ? this.db.listBlocks(projectId) : this.db.listBlocks(raw.projectId)) || [];
      this._reconcileWorkingSet(task, projectRoot, dbBlocks);
    }
    const resolvedEvidence = evidence || (receipt ? `${receipt.summary} [${receipt.logHandle || 'no log'}]` : '');
    const check = task.addCheck({
      receiptId,
      description,
      passed,
      evidence: resolvedEvidence,
    });
    this.db.saveTask(task.toJSON());
    return check;
  }

  startChecking(taskId) {
    const raw = this.db.getTask(taskId);
    if (!raw) throw new Error(`Task '${taskId}' not found`);
    const task = new Task(raw);
    if (task.status === 'draft') {
      task.activate();
    }
    task.startChecking();
    this.db.saveTask(task.toJSON());
    return task.toJSON();
  }

  syncTask(taskId, {
    blocks = [],
    chains = [],
    links = [],
    projectRoot,
    projectId,
  }) {
    const raw = this.db.getTask(taskId);
    if (!raw) throw new Error(`Task '${taskId}' not found`);
    const task = new Task(raw);

    const inputBlocks = blocks.map((b) => (typeof b === 'string' ? this.db.getBlock(b) : b)).filter(Boolean);
    const dbBlocks = (projectId ? this.db.listBlocks(projectId) : this.db.listBlocks()) || [];

    this._reconcileWorkingSet(task, projectRoot, dbBlocks);

    const blockMap = new Map();
    for (const b of dbBlocks) {
      blockMap.set(b.id, { ...b });
    }
    for (const b of inputBlocks) {
      blockMap.set(b.id, { ...b });
    }
    let resolvedBlocks = Array.from(blockMap.values());

    for (const block of resolvedBlocks) {
      for (const ref of block.artifactRefs || []) {
        const anchorKind = ref.anchorKind || (ref.symbol ? 'symbol' : 'file');
        if (anchorKind === 'tree') {
          const resolved = calculateTreeHash(projectRoot || process.cwd(), ref.path, {
            hashMode: ref.hashMode || (ref.manifest ? 'manifest' : 'content'),
            manifest: ref.manifest || null,
          });
          ref.hash = resolved.hash;
          ref.hashMode = resolved.hashMode;
          ref.manifest = resolved.manifest;
          continue;
        }
        const snap = task.baseline?.fileSnapshots?.[ref.path];
        if (
          anchorKind === 'file' &&
          snap &&
          snap.hash &&
          ref.hash &&
          ref.hash !== snap.hash
        ) {
          ref.hash = snap.hash;
        }
      }
    }

    const resolvedChains = chains.map((c) => (typeof c === 'string' ? this.db.getChain(c) : c)).filter(Boolean);
    const resolvedLinks = links.map((l) => (typeof l === 'string' ? this.db.getLink(l) : l)).filter(Boolean);

    // Transition to syncing (verifies all checks passed)
    task.startSyncing();

    const effectiveProjectId = projectId || raw.projectId || raw.project_id || 'contextos';
    const allWorkingSetFiles = task.workingSet.files || [];
    const coverage = CoverageChecker.checkCoverage(allWorkingSetFiles, resolvedBlocks);

    if (!coverage.isFullyCovered) {
      const repair = {
        action: 'block.bind_auto',
        paths: coverage.uncoveredList,
        then: ['task.resume', 'task.sync'],
      };
      task.failSync(`Coverage gap: Missing Block ownership for: ${coverage.uncoveredList.join(', ')}`);
      task.syncResult.coverage = {
        totalFiles: coverage.totalFiles,
        coveredFiles: coverage.coveredFiles,
        coveragePercent: coverage.coveragePercent,
      };
      task.syncResult.repair = repair;
      this.db.saveTask(task.toJSON());
      throw new Error(
        `Task sync failed: Working set code has no Block coverage. Uncovered files: ${coverage.uncoveredList.join(', ')}. ` +
        `Suggested repair: call block(action:"bind_auto", id:"<block-id>", paths:${JSON.stringify(repair.paths)}), then task(action:"resume") and retry.`
      );
    }

    for (const block of resolvedBlocks) assertBlockHasRealCode(block);

    let syncResult;
    let exportResult = null;
    let graphWarning = null;

    try {
      this.db.transaction((db) => {
        for (const block of resolvedBlocks) {
          db.saveBlock(block);
        }

        for (const chain of resolvedChains) {
          db.saveChain(chain);
        }
        for (const link of resolvedLinks) {
          db.saveLink(link);
        }

        syncResult = {
          createdBlockIds: resolvedBlocks.map((block) => block.id),
          updatedChainIds: resolvedChains.map((chain) => chain.id),
          updatedLinkIds: resolvedLinks.map((link) => link.id || `${link.from}->${link.to}`),
          coverage: {
            totalFiles: coverage.totalFiles,
            coveredFiles: coverage.coveredFiles,
            coveragePercent: coverage.coveragePercent,
          },
        };

        task.completeSync(syncResult);
        db.saveTask(task.toJSON());

        if (this.syncEngine && projectRoot && effectiveProjectId) {
          this.syncEngine.queueGraphToJson(effectiveProjectId);
        }
      });

      if (this.syncEngine && projectRoot && effectiveProjectId) {
        try {
          exportResult = this.syncEngine.flushGraphOutbox(effectiveProjectId, projectRoot);
        } catch (err) {
          graphWarning = `Graph export pending for recovery: ${err.message}`;
        }
      }
    } catch (err) {
      const current = this.db.getTask(taskId);
      if (current && current.status === 'checking') {
        const failedTask = new Task(current);
        failedTask.failSync(err.message);
        this.db.saveTask(failedTask.toJSON());
      }
      throw err;
    }

    return {
      task: task.toJSON(),
      syncResult,
      graphRevision: exportResult ? exportResult.graphRevision : null,
      graphWarning,
    };
  }

  resumeTask(taskId) {
    const raw = this.db.getTask(taskId);
    if (!raw) throw new Error(`Task '${taskId}' not found`);
    const task = new Task(raw);
    task.resume();
    this.db.saveTask(task.toJSON());
    return task.toJSON();
  }
}
