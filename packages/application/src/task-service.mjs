import { Task, assertBlockHasRealCode } from '../../../packages/domain/src/index.mjs';
import { CoverageChecker } from '../../../packages/code-intel/src/index.mjs';

export class TaskService {
  constructor(db, syncEngine) {
    this.db = db;
    this.syncEngine = syncEngine;
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
  }) {
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

    this.db.saveTask(task.toJSON());
    return task.toJSON();
  }

  getTask(taskId) {
    return this.db.getTask(taskId);
  }

  listTasks(planId = null) {
    return this.db.listTasks(planId);
  }

  activateTask(taskId) {
    const raw = this.db.getTask(taskId);
    if (!raw) throw new Error(`Task '${taskId}' not found`);
    const task = new Task(raw);
    task.activate();
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

  addCheck(taskId, { receiptId = null, description, passed = true, evidence = '' }) {
    const raw = this.db.getTask(taskId);
    if (!raw) throw new Error(`Task '${taskId}' not found`);
    const task = new Task(raw);
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

  syncTask(taskId, { blocks = [], chains = [], links = [], projectRoot, projectId }) {
    const raw = this.db.getTask(taskId);
    if (!raw) throw new Error(`Task '${taskId}' not found`);
    const task = new Task(raw);

    // Resolve string IDs to stored objects if needed
    const resolvedBlocks = blocks.map((b) => (typeof b === 'string' ? this.db.getBlock(b) : b)).filter(Boolean);
    const resolvedChains = chains.map((c) => (typeof c === 'string' ? this.db.getChain(c) : c)).filter(Boolean);
    const resolvedLinks = links.map((l) => (typeof l === 'string' ? this.db.getLink(l) : l)).filter(Boolean);

    // Transition to syncing (verifies all checks passed)
    task.startSyncing();

    // 1. Invariant Check: Verify Block coverage for all working set files
    const coverageReport = CoverageChecker.checkCoverage(task.workingSet.files || [], resolvedBlocks);
    if (!coverageReport.isFullyCovered) {
      task.failSync(`Coverage gap: Missing Block ownership for: ${coverageReport.uncoveredList.join(', ')}`);
      this.db.saveTask(task.toJSON());
      throw new Error(
        `Task sync failed: Working set code has no Block coverage. Uncovered files: ${coverageReport.uncoveredList.join(', ')}`
      );
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
