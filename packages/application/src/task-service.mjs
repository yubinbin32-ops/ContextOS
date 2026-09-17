import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { Task, assertBlockHasRealCode } from '../../../packages/domain/src/index.mjs';
import { CoverageChecker, LanguageRegistry } from '../../../packages/code-intel/src/index.mjs';

const CODE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.go', '.rs', '.swift', '.java', '.kt', '.kts',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.cs',
  '.php', '.rb',
]);

function scanProjectSourceFiles(projectRoot, maxFiles = 300) {
  const result = [];
  const ignoredDirs = new Set(['.git', 'node_modules', '.contextos', 'dist', 'build', '.next', '.nuxt', 'coverage', '.turbo']);
  const searchDirs = ['src', 'packages', 'apps', 'lib', 'scripts', 'test'];

  const walk = (dir, relDir = '', depth = 0) => {
    if (depth > 5 || result.length >= maxFiles) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      if (ignoredDirs.has(ent.name)) continue;
      const childRel = relDir ? path.join(relDir, ent.name) : ent.name;
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
    if (fs.existsSync(full)) {
      walk(full, sDir, 0);
    }
  }

  try {
    const rootEntries = fs.readdirSync(projectRoot, { withFileTypes: true });
    for (const ent of rootEntries) {
      if (ent.isFile() && !ent.name.startsWith('.') && CODE_EXTENSIONS.has(path.extname(ent.name).toLowerCase())) {
        result.push(ent.name);
      }
    }
  } catch (_) {}

  return result;
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
    const dbBlocks = this.db.listBlocks() || [];
    const filesToSnapshot = new Set(task.workingSet.files || []);
    for (const b of dbBlocks) {
      for (const ref of b.artifactRefs || []) {
        if (ref.path) filesToSnapshot.add(ref.path);
      }
    }
    for (const relPath of filesToSnapshot) {
      if (task.baseline.fileSnapshots[relPath]) continue;
      const fullPath = path.isAbsolute(relPath) ? relPath : path.join(projectRoot, relPath);
      if (fs.existsSync(fullPath)) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) continue;
          const content = fs.readFileSync(fullPath, 'utf8');
          const hash = crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
          task.baseline.fileSnapshots[relPath] = {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            hash,
            snapshottedAt: new Date().toISOString(),
          };
        } catch (_) {}
      }
    }
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
          if (ref.path === relPath) {
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

    const candidateFiles = new Set([
      ...(task.workingSet.files || []),
      ...Object.keys(task.baseline.fileSnapshots),
    ]);

    for (const block of dbBlocks) {
      for (const ref of block.artifactRefs || []) {
        if (ref.path) candidateFiles.add(ref.path);
      }
    }

    // 1. Discover newly modified / untracked files via Git status if in a git repository
    try {
      const gitOutput = execSync('git status --porcelain', {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const lines = gitOutput.split('\n');
      for (const line of lines) {
        if (!line || line.length < 4) continue;
        let rawPath = line.slice(3).trim();
        if (rawPath.startsWith('"') && rawPath.endsWith('"')) {
          rawPath = rawPath.slice(1, -1);
        }
        if (rawPath.includes(' -> ')) {
          rawPath = rawPath.split(' -> ').pop().trim();
        }
        if (
          rawPath &&
          !rawPath.startsWith('.contextos') &&
          !rawPath.startsWith('.git') &&
          !rawPath.includes('node_modules')
        ) {
          candidateFiles.add(rawPath);
        }
      }
    } catch (_) {
      // Not a git repo or git not found
    }

    // 2. Also scan project source files directly so we do NOT rely purely on git status
    const scannedFiles = scanProjectSourceFiles(projectRoot);
    for (const f of scannedFiles) {
      candidateFiles.add(f);
    }

    // 3. High-precision Host Native Modification Detection via mtime + SHA256 Hash Comparison
    for (const relPath of candidateFiles) {
      const fullPath = path.isAbsolute(relPath) ? relPath : path.join(projectRoot, relPath);
      if (!fs.existsSync(fullPath)) {
        if (task.baseline.fileSnapshots[relPath]) {
          delete task.baseline.fileSnapshots[relPath];
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
        let content = '';
        try {
          content = fs.readFileSync(fullPath, 'utf8');
        } catch (_) {
          continue;
        }

        const currentHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
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
          this._refreshFileAstAndLocators(relPath, content, dbBlocks, task);

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

  createTask({
    id,
    planId,
    phaseId,
    title,
    status = 'draft',
    contextSlice = {},
    workingSet = {},
    references = {},
    baseline = {},
  }, projectRoot = null) {
    const task = new Task({
      id: id || `task-${Date.now()}`,
      planId,
      phaseId,
      title,
      status,
      contextSlice,
      workingSet,
      references,
      baseline,
    });

    if (projectRoot && fs.existsSync(projectRoot)) {
      this._initializeFileSnapshots(task, projectRoot);
    }

    this.db.saveTask(task.toJSON());
    return task.toJSON();
  }

  getTask(taskId) {
    return this.db.getTask(taskId);
  }

  listTasks(planId = null) {
    return this.db.listTasks(planId);
  }

  activateTask(taskId, projectRoot = null) {
    const raw = this.db.getTask(taskId);
    if (!raw) throw new Error(`Task '${taskId}' not found`);
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
    const task = new Task(raw);
    if (projectRoot && fs.existsSync(projectRoot)) {
      const dbBlocks = (projectId ? this.db.listBlocks(projectId) : this.db.listBlocks(raw.projectId)) || [];
      this._reconcileWorkingSet(task, projectRoot, dbBlocks);
    }
    const check = task.addCheck({ receiptId, description, passed, evidence });
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

  syncTask(taskId, { blocks = [], chains = [], links = [], projectRoot, projectId, coverageMode = 'strict' }) {
    const raw = this.db.getTask(taskId);
    if (!raw) throw new Error(`Task '${taskId}' not found`);
    const task = new Task(raw);

    // Resolve string IDs to stored objects if needed
    const inputBlocks = blocks.map((b) => (typeof b === 'string' ? this.db.getBlock(b) : b)).filter(Boolean);
    const dbBlocks = (projectId ? this.db.listBlocks(projectId) : this.db.listBlocks()) || [];

    // Auto-reconcile workingSet with disk changes
    this._reconcileWorkingSet(task, projectRoot, dbBlocks);

    // Merge existing database blocks with input blocks
    const blockMap = new Map();
    for (const b of dbBlocks) {
      blockMap.set(b.id, { ...b });
    }
    for (const b of inputBlocks) {
      blockMap.set(b.id, { ...b });
    }
    let resolvedBlocks = Array.from(blockMap.values());

    // Synchronize resolvedBlocks artifactRefs with latest task fileSnapshots if modified
    for (const b of resolvedBlocks) {
      for (const ref of b.artifactRefs || []) {
        const snap = task.baseline?.fileSnapshots?.[ref.path];
        if (snap && snap.hash && ref.hash !== snap.hash) {
          ref.hash = snap.hash;
        }
      }
    }

    const resolvedChains = chains.map((c) => (typeof c === 'string' ? this.db.getChain(c) : c)).filter(Boolean);
    const resolvedLinks = links.map((l) => (typeof l === 'string' ? this.db.getLink(l) : l)).filter(Boolean);

    // Transition to syncing (verifies all checks passed)
    task.startSyncing();

    // 1. Invariant Check: Verify Block coverage for all working set files
    const coverageReport = CoverageChecker.checkCoverage(task.workingSet.files || [], resolvedBlocks);
    if (!coverageReport.isFullyCovered) {
      if (coverageMode === 'adaptive') {
        let unassignedBlock = resolvedBlocks.find(
          (b) => b.id === 'block-unassigned' || b.id === `block-unassigned-${task.id}`
        );
        if (!unassignedBlock) {
          unassignedBlock = {
            id: `block-unassigned-${task.id}`,
            projectId: projectId || raw.projectId || 'contextos',
            title: `Unassigned Working Set (${task.title})`,
            summary: `Adaptive block for unassigned files: ${coverageReport.uncoveredList.join(', ')}`,
            details: 'Automatically created by ContextOS adaptive coverage gate.',
            kind: 'unassigned',
            artifactRefs: [],
          };
          resolvedBlocks.push(unassignedBlock);
        }
        for (const filePath of coverageReport.uncoveredList) {
          if (unassignedBlock.artifactRefs.some((r) => r.path === filePath)) {
            continue;
          }
          let hash = 'untracked';
          if (projectRoot) {
            const fullPath = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
            if (fs.existsSync(fullPath)) {
              try {
                const content = fs.readFileSync(fullPath, 'utf8');
                hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
              } catch (_) {}
            }
          }
          unassignedBlock.artifactRefs.push({
            path: filePath,
            symbol: '*',
            hash,
          });
        }
        task.addNote({
          text: `[Adaptive Coverage Warning] Automatically mapped unassigned files to ${unassignedBlock.id}: ${coverageReport.uncoveredList.join(', ')}`,
          kind: 'system',
        });
      } else {
        task.failSync(`Coverage gap: Missing Block ownership for: ${coverageReport.uncoveredList.join(', ')}`);
        this.db.saveTask(task.toJSON());
        throw new Error(
          `Task sync failed: Working set code has no Block coverage. Uncovered files: ${coverageReport.uncoveredList.join(', ')}`
        );
      }
    }

    // 2. Invariant Check: Ensure no ghost blocks
    for (const b of resolvedBlocks) {
      assertBlockHasRealCode(b);
    }

    // 3. Persist and complete in atomic transaction
    let syncResult;
    let exportResult;

    this.db.transaction((db) => {
      for (const b of resolvedBlocks) {
        db.saveBlock(b);
      }
      for (const c of resolvedChains) {
        db.saveChain(c);
      }
      for (const l of resolvedLinks) {
        db.saveLink(l);
      }

      syncResult = {
        createdBlockIds: resolvedBlocks.map((b) => b.id),
        updatedChainIds: resolvedChains.map((c) => c.id),
        updatedLinkIds: resolvedLinks.map((l) => l.id || `${l.from}->${l.to}`),
      };

      task.completeSync(syncResult);
      db.saveTask(task.toJSON());

      if (this.syncEngine && projectRoot && projectId) {
        exportResult = this.syncEngine.exportGraphToJson(projectId, projectRoot);
      }
    });

    return {
      task: task.toJSON(),
      syncResult,
      graphRevision: exportResult ? exportResult.graphRevision : null,
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
