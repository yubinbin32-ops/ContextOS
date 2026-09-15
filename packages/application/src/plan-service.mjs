import { Plan, Phase, PlanCheckpoint, assertPlanCanBeCompleted } from '../../../packages/domain/src/index.mjs';

export class PlanService {
  constructor(db) {
    this.db = db;
  }

  createPlan({
    id,
    projectId,
    title,
    priority = 'normal',
    summary = '',
    phases = [],
    checkpoints = [],
    ruleRefs = [],
    decisionRefs = [],
    dependencyRefs = [],
  }) {
    const plan = new Plan({
      id: id || `plan-${Date.now()}`,
      projectId,
      title,
      priority,
      status: 'active',
      summary,
      phases,
      checkpoints,
      ruleRefs,
      decisionRefs,
      dependencyRefs,
    });

    this.db.savePlan(plan.toJSON());
    return plan.toJSON();
  }

  getPlan(planId) {
    return this.db.getPlan(planId);
  }

  listPlans(projectId) {
    return this.db.listPlans(projectId);
  }

  addCheckpoint(planId, checkpointData) {
    const rawPlan = this.db.getPlan(planId);
    if (!rawPlan) throw new Error(`Plan '${planId}' not found`);

    const plan = new Plan(rawPlan);
    const cp = plan.addCheckpoint(checkpointData);
    this.db.savePlan(plan.toJSON());
    return cp.toJSON();
  }

  checkCheckpoint(planId, checkpointId, { passed = true, evidenceRef = null, reason = null }) {
    const rawPlan = this.db.getPlan(planId);
    if (!rawPlan) throw new Error(`Plan '${planId}' not found`);

    const plan = new Plan(rawPlan);
    const cp = plan.checkpoints.find((c) => c.id === checkpointId);
    if (!cp) throw new Error(`Checkpoint '${checkpointId}' not found in plan '${planId}'`);

    if (passed) {
      cp.pass(evidenceRef);
    } else {
      cp.fail(reason || 'Verification failed');
    }

    this.db.savePlan(plan.toJSON());
    return cp.toJSON();
  }

  completePlan(planId, { completedSummary = null, historyRef = null } = {}) {
    const rawPlan = this.db.getPlan(planId);
    if (!rawPlan) throw new Error(`Plan '${planId}' not found`);

    const plan = new Plan(rawPlan);
    assertPlanCanBeCompleted(plan);

    plan.complete({ completedSummary: completedSummary || plan.summary, historyRef });
    this.db.savePlan(plan.toJSON());
    return plan.toJSON();
  }

  deletePlan(planId) {
    return this.db.deletePlan(planId);
  }
}
