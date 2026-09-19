import { Plan, Phase, Task, PlanCheckpoint, assertPlanCanBeCompleted } from '../../../packages/domain/src/index.mjs';

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
    const planId = id || `plan-${Date.now()}`;
    const instantiatedTasks = [];

    const normalizedPhases = (phases || []).map((phaseData, index) => {
      const pData = typeof phaseData.toJSON === 'function' ? phaseData.toJSON() : { ...phaseData };
      pData.id = pData.id || `phase-${index}`;
      const phaseTasks = Array.isArray(pData.tasks) ? pData.tasks : [];
      const taskIds = Array.isArray(pData.taskIds) ? [...pData.taskIds] : [];

      for (const t of phaseTasks) {
        const tObj = typeof t === 'string' ? { id: t, title: t } : t;
        const tId = tObj.id || `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        if (!taskIds.includes(tId)) {
          taskIds.push(tId);
        }
        const taskInstance = new Task({
          ...tObj,
          id: tId,
          planId,
          phaseId: pData.id,
          title: tObj.title || tId,
          rules: tObj.rules ?? tObj.ruleRefs ?? tObj.references?.rules ?? [],
        });
        instantiatedTasks.push(taskInstance);
      }
      pData.taskIds = taskIds;
      return pData;
    });

    const plan = new Plan({
      id: planId,
      projectId,
      title,
      priority,
      status: 'active',
      summary,
      phases: normalizedPhases,
      checkpoints,
      ruleRefs,
      decisionRefs,
      dependencyRefs,
    });

    this.db.savePlan(plan.toJSON());
    for (const t of instantiatedTasks) {
      this.db.saveTask(t.toJSON());
    }
    return plan.toJSON();
  }

  getPlan(planId) {
    return this.db.getPlan(planId);
  }

  listPlans(projectId) {
    return this.db.listPlans(projectId);
  }

  repairStateHygiene(projectId, { staleMs = 6 * 60 * 60 * 1000 } = {}) {
    const changedPlanIds = [];
    const now = Date.now();
    for (const rawPlan of this.db.listPlans(projectId)) {
      if (rawPlan.status !== 'active') continue;
      const tasks = this.db.listTasks(rawPlan.id);
      const hasActiveTask = tasks.some((task) =>
        ['active', 'checking', 'syncing'].includes(task.status)
      );
      if (hasActiveTask) continue;

      const updatedAt = Date.parse(rawPlan.updatedAt || '');
      const stale = Number.isFinite(updatedAt) && now - updatedAt > staleMs;
      const allCheckpointsPassed =
        rawPlan.checkpoints.length > 0 &&
        rawPlan.checkpoints.every((checkpoint) => checkpoint.status === 'passed');

      if (allCheckpointsPassed) {
        rawPlan.status = 'completed';
        rawPlan.completedSummary =
          rawPlan.completedSummary ||
          'Auto-completed because all checkpoints passed and no active task remains.';
        rawPlan.updatedAt = new Date().toISOString();
        this.db.savePlan(rawPlan);
        changedPlanIds.push(rawPlan.id);
      } else if (stale) {
        rawPlan.status = 'archived';
        rawPlan.completedSummary =
          rawPlan.completedSummary ||
          'Archived by state hygiene because no active task remained for the stale plan.';
        rawPlan.updatedAt = new Date().toISOString();
        this.db.savePlan(rawPlan);
        changedPlanIds.push(rawPlan.id);
      }
    }
    return { changed: changedPlanIds.length, changedPlanIds };
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
    for (const rawTask of this.db.listTasks(planId)) {
      if (rawTask.status === 'completed') continue;
      const task = new Task(rawTask);
      task.block(`Plan '${planId}' completed before this task reached sync.`);
      this.db.saveTask(task.toJSON());
    }
    return plan.toJSON();
  }

  deletePlan(planId) {
    return this.db.deletePlan(planId);
  }
}
