/**
 * Task domain entity and C-D-C-S state machine.
 * Lifecycle: draft -> active -> checking -> syncing -> completed
 * Abnormal states: blocked, sync_failed
 */

export const TASK_STATUSES = [
  'draft',
  'active',
  'checking',
  'syncing',
  'completed',
  'blocked',
  'sync_failed',
];

export class Task {
  constructor({
    id,
    planId,
    phaseId,
    title,
    status = 'draft',
    contextSlice = {},
    workingSet = {},
    references = {},
    rules = null,
    ruleRefs = null,
    baseline = {},
    notes = [],
    checks = [],
    syncResult = null,
    createdAt = new Date().toISOString(),
    updatedAt = new Date().toISOString(),
  }) {
    if (!id || typeof id !== 'string') throw new Error('Task requires a valid string id');
    if (!planId || typeof planId !== 'string') throw new Error('Task requires planId');
    if (!phaseId || typeof phaseId !== 'string') throw new Error('Task requires phaseId');
    if (!title || typeof title !== 'string') throw new Error('Task requires title');
    if (!TASK_STATUSES.includes(status)) {
      throw new Error(`Invalid task status: ${status}. Must be one of ${TASK_STATUSES.join(', ')}`);
    }

    this.id = id;
    this.planId = planId;
    this.phaseId = phaseId;
    this.title = title;
    this.status = status;

    this.contextSlice = {
      objective: contextSlice.objective || '',
      constraints: Array.isArray(contextSlice.constraints) ? [...contextSlice.constraints] : [],
      references: contextSlice.references || {},
      locators: Array.isArray(contextSlice.locators) ? [...contextSlice.locators] : [],
      nextSteps: Array.isArray(contextSlice.nextSteps) ? [...contextSlice.nextSteps] : [],
      openQuestions: Array.isArray(contextSlice.openQuestions) ? [...contextSlice.openQuestions] : [],
    };

    const normalizedWorkingSet = Array.isArray(workingSet)
      ? { files: workingSet }
      : (workingSet || {});

    this.workingSet = {
      files: Array.isArray(normalizedWorkingSet.files) ? [...normalizedWorkingSet.files] : [],
      symbols: Array.isArray(normalizedWorkingSet.symbols) ? [...normalizedWorkingSet.symbols] : [],
      candidateBlockIds: Array.isArray(normalizedWorkingSet.candidateBlockIds) ? [...normalizedWorkingSet.candidateBlockIds] : [],
      scopeDirs: Array.isArray(normalizedWorkingSet.scopeDirs) ? [...normalizedWorkingSet.scopeDirs] : [],
    };

    const initialRules = Array.isArray(rules)
      ? rules
      : (Array.isArray(ruleRefs)
        ? ruleRefs
        : (Array.isArray(references?.rules) ? references.rules : []));

    this.references = {
      rules: [...new Set(initialRules.filter((r) => typeof r === 'string' && r.trim()))],
      decisionSections: Array.isArray(references?.decisionSections) ? [...references.decisionSections] : [],
      blockIds: Array.isArray(references?.blockIds) ? [...references.blockIds] : [],
    };

    this.baseline = {
      gitHead: baseline.gitHead || null,
      dirtyHash: baseline.dirtyHash || null,
      indexRevision: baseline.indexRevision || 0,
      fileSnapshots: baseline.fileSnapshots ? { ...baseline.fileSnapshots } : {},
      initializedAt: baseline.initializedAt || null,
    };

    this.notes = Array.isArray(notes) ? [...notes] : [];
    this.checks = Array.isArray(checks) ? [...checks] : [];
    this.syncResult = syncResult;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  activate() {
    if (this.status !== 'draft' && this.status !== 'blocked') {
      throw new Error(`Cannot activate task in ${this.status} state`);
    }
    this.status = 'active';
    this.updatedAt = new Date().toISOString();
  }

  addNote({ text, kind = 'journal' }) {
    if (!text || typeof text !== 'string') throw new Error('Note text is required');
    const note = {
      id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      text,
      kind,
      createdAt: new Date().toISOString(),
    };
    this.notes.push(note);
    this.updatedAt = new Date().toISOString();
    return note;
  }

  addFileToWorkingSet(filePath) {
    if (filePath && !this.workingSet.files.includes(filePath)) {
      this.workingSet.files.push(filePath);
      this.updatedAt = new Date().toISOString();
    }
  }

  addCheck({ receiptId = null, description, passed = true, evidence = '' }) {
    if (!description || typeof description !== 'string') {
      throw new Error('Check description is required');
    }
    const check = {
      id: `check-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      receiptId,
      description,
      passed: Boolean(passed),
      evidence,
      recordedAt: new Date().toISOString(),
    };
    this.checks.push(check);
    this.updatedAt = new Date().toISOString();
    return check;
  }

  startChecking() {
    if (this.status !== 'active' && this.status !== 'sync_failed') {
      throw new Error(`Cannot transition to checking from state: ${this.status}`);
    }
    this.status = 'checking';
    this.updatedAt = new Date().toISOString();
  }

  startSyncing() {
    if (this.status === 'active') {
      this.status = 'checking';
    }
    if (this.status !== 'checking') {
      throw new Error(`Cannot transition to syncing from state: ${this.status}. Must be active or checking.`);
    }
    const verifiedChecks = this.checks.filter(
      (check) => check.passed && (check.receiptId || String(check.evidence || '').trim())
    );
    if (verifiedChecks.length === 0) {
      throw new Error('Cannot sync task without at least one passing check backed by a receipt or evidence.');
    }
    const failedChecks = this.checks.filter((c) => !c.passed);
    if (failedChecks.length > 0) {
      throw new Error(`Cannot sync task with ${failedChecks.length} failed checks`);
    }
    this.status = 'syncing';
    this.updatedAt = new Date().toISOString();
  }

  completeSync(syncResult) {
    if (this.status !== 'syncing') {
      throw new Error(`Cannot complete sync from state: ${this.status}. Must be syncing.`);
    }
    this.status = 'completed';
    this.syncResult = {
      ...syncResult,
      completedAt: new Date().toISOString(),
    };
    this.updatedAt = new Date().toISOString();
  }

  failSync(reason) {
    this.status = 'sync_failed';
    this.syncResult = {
      error: reason,
      failedAt: new Date().toISOString(),
    };
    this.updatedAt = new Date().toISOString();
  }

  block(reason) {
    this.status = 'blocked';
    this.addNote({ text: `Task blocked: ${reason}`, kind: 'blocked' });
  }

  resume() {
    if (this.status !== 'blocked' && this.status !== 'sync_failed') {
      throw new Error(`Cannot resume task from state: ${this.status}`);
    }
    this.status = 'active';
    this.updatedAt = new Date().toISOString();
  }

  get rules() {
    return this.references.rules;
  }

  set rules(newRules) {
    this.references.rules = Array.isArray(newRules)
      ? [...new Set(newRules.filter((r) => typeof r === 'string' && r.trim()))]
      : [];
    this.updatedAt = new Date().toISOString();
  }

  bindRule(ruleId) {
    if (!ruleId || typeof ruleId !== 'string') return;
    const clean = ruleId.trim();
    if (clean && !this.references.rules.includes(clean)) {
      this.references.rules.push(clean);
      this.updatedAt = new Date().toISOString();
    }
  }

  unbindRule(ruleId) {
    if (!ruleId || typeof ruleId !== 'string') return;
    const clean = ruleId.trim();
    const idx = this.references.rules.indexOf(clean);
    if (idx !== -1) {
      this.references.rules.splice(idx, 1);
      this.updatedAt = new Date().toISOString();
    }
  }

  setRules(rules) {
    this.rules = rules;
  }

  toJSON() {
    return {
      id: this.id,
      planId: this.planId,
      phaseId: this.phaseId,
      title: this.title,
      status: this.status,
      contextSlice: this.contextSlice,
      workingSet: this.workingSet,
      references: this.references,
      rules: this.references.rules,
      baseline: this.baseline,
      notes: this.notes,
      checks: this.checks,
      syncResult: this.syncResult,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
