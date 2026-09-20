/**
 * Plan, Phase and PlanCheckpoint domain entities.
 * Invariant: Checkpoint belongs ONLY to Plan. Task and Block do not have Checkpoints.
 */

export const PLAN_PRIORITIES = ['critical', 'high', 'normal', 'low'];
export const PLAN_STATUSES = ['draft', 'active', 'completed', 'archived'];
export const PHASE_STATUSES = ['pending', 'active', 'completed'];
export const CHECKPOINT_STATUSES = ['pending', 'passed', 'failed', 'stale'];

export class PlanCheckpoint {
  constructor({
    id,
    planId,
    phaseId = null,
    title,
    criteria = '',
    status = 'pending',
    evidenceRefs = [],
    completedAt = null,
  }) {
    if (!id || typeof id !== 'string') throw new Error('PlanCheckpoint requires a valid string id');
    if (!planId || typeof planId !== 'string') throw new Error('PlanCheckpoint requires planId');
    if (!title || typeof title !== 'string') throw new Error('PlanCheckpoint requires title');
    if (!CHECKPOINT_STATUSES.includes(status)) {
      throw new Error(`Invalid checkpoint status: ${status}. Must be one of ${CHECKPOINT_STATUSES.join(', ')}`);
    }

    this.id = id;
    this.planId = planId;
    this.phaseId = phaseId;
    this.title = title;
    this.criteria = criteria;
    this.status = status;
    this.evidenceRefs = Array.isArray(evidenceRefs) ? [...evidenceRefs] : [];
    this.completedAt = completedAt;
  }

  pass(evidenceRef) {
    if (evidenceRef) this.evidenceRefs.push(evidenceRef);
    this.status = 'passed';
    this.completedAt = new Date().toISOString();
  }

  fail(reason) {
    this.status = 'failed';
    this.criteria = reason ? `${this.criteria}\nFailure: ${reason}`.trim() : this.criteria;
  }

  markStale() {
    this.status = 'stale';
  }

  toJSON() {
    return {
      id: this.id,
      planId: this.planId,
      phaseId: this.phaseId,
      title: this.title,
      criteria: this.criteria,
      status: this.status,
      evidenceRefs: this.evidenceRefs,
      completedAt: this.completedAt,
    };
  }
}

export class Phase {
  constructor({
    id,
    order = 0,
    objective = '',
    scope = '',
    deliverables = [],
    status = 'pending',
    taskIds = [],
    acceptance = [],
  }) {
    if (!id || typeof id !== 'string') throw new Error('Phase requires a valid string id (e.g. P0, P1)');
    if (!PHASE_STATUSES.includes(status)) {
      throw new Error(`Invalid phase status: ${status}. Must be one of ${PHASE_STATUSES.join(', ')}`);
    }

    this.id = id;
    this.order = order;
    this.objective = objective;
    this.scope = scope;
    this.deliverables = Array.isArray(deliverables) ? [...deliverables] : [];
    this.status = status;
    this.taskIds = Array.isArray(taskIds) ? [...taskIds] : [];
    this.acceptance = Array.isArray(acceptance) ? [...acceptance] : [];
  }

  activate() {
    this.status = 'active';
  }

  complete() {
    this.status = 'completed';
  }

  toJSON() {
    return {
      id: this.id,
      order: this.order,
      objective: this.objective,
      scope: this.scope,
      deliverables: this.deliverables,
      status: this.status,
      taskIds: this.taskIds,
      acceptance: this.acceptance,
    };
  }
}

export class Plan {
  constructor({
    id,
    projectId,
    title,
    priority = 'normal',
    status = 'active',
    summary = '',
    phases = [],
    ruleRefs = [],
    decisionRefs = [],
    dependencyRefs = [],
    checkpoints = [],
    completedSummary = null,
    historyRef = null,
    createdAt = new Date().toISOString(),
    updatedAt = new Date().toISOString(),
  }) {
    if (!id || typeof id !== 'string') throw new Error('Plan requires a valid string id');
    if (!projectId || typeof projectId !== 'string') throw new Error('Plan requires projectId');
    if (!title || typeof title !== 'string') throw new Error('Plan requires title');
    if (!PLAN_PRIORITIES.includes(priority)) {
      throw new Error(`Invalid plan priority: ${priority}. Must be one of ${PLAN_PRIORITIES.join(', ')}`);
    }
    if (!PLAN_STATUSES.includes(status)) {
      throw new Error(`Invalid plan status: ${status}. Must be one of ${PLAN_STATUSES.join(', ')}`);
    }

    this.id = id;
    this.projectId = projectId;
    this.title = title;
    this.priority = priority;
    this.status = status;
    this.summary = summary;
    this.phases = phases.map((p) => (p instanceof Phase ? p : new Phase(p)));
    this.ruleRefs = Array.isArray(ruleRefs) ? [...ruleRefs] : [];
    this.decisionRefs = Array.isArray(decisionRefs) ? [...decisionRefs] : [];
    this.dependencyRefs = Array.isArray(dependencyRefs) ? [...dependencyRefs] : [];
    this.checkpoints = checkpoints.map((c) => (c instanceof PlanCheckpoint ? c : new PlanCheckpoint({ ...c, planId: id })));
    this.completedSummary = completedSummary;
    this.historyRef = historyRef;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  addPhase(phaseData) {
    const phase = phaseData instanceof Phase ? phaseData : new Phase(phaseData);
    if (this.phases.some((p) => p.id === phase.id)) {
      throw new Error(`Phase ${phase.id} already exists in plan ${this.id}`);
    }
    this.phases.push(phase);
    this.updatedAt = new Date().toISOString();
    return phase;
  }

  getPhase(phaseId) {
    return this.phases.find((p) => p.id === phaseId) || null;
  }

  addCheckpoint(checkpointData) {
    const cp = checkpointData instanceof PlanCheckpoint
      ? checkpointData
      : new PlanCheckpoint({ ...checkpointData, planId: this.id });
    if (this.checkpoints.some((c) => c.id === cp.id)) {
      throw new Error(`Checkpoint ${cp.id} already exists in plan ${this.id}`);
    }
    this.checkpoints.push(cp);
    this.updatedAt = new Date().toISOString();
    return cp;
  }

  canComplete() {
    if (this.checkpoints.length === 0) return true;
    return this.checkpoints.every((cp) => cp.status === 'passed');
  }

  complete({ completedSummary, historyRef = null }) {
    if (!this.canComplete()) {
      const pending = this.checkpoints.filter((cp) => cp.status !== 'passed').map((cp) => cp.id);
      throw new Error(`Cannot complete Plan ${this.id}: checkpoints not passed: ${pending.join(', ')}`);
    }
    this.status = 'completed';
    for (const phase of this.phases) {
      phase.complete();
    }
    this.completedSummary = completedSummary || this.summary;
    this.historyRef = historyRef;
    this.updatedAt = new Date().toISOString();
  }

  toJSON() {
    return {
      id: this.id,
      projectId: this.projectId,
      title: this.title,
      priority: this.priority,
      status: this.status,
      summary: this.summary,
      phases: this.phases.map((p) => p.toJSON()),
      ruleRefs: this.ruleRefs,
      decisionRefs: this.decisionRefs,
      dependencyRefs: this.dependencyRefs,
      checkpoints: this.checkpoints.map((c) => c.toJSON()),
      completedSummary: this.completedSummary,
      historyRef: this.historyRef,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
