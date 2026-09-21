import {
  Plan,
  Task,
  assertPlanCanBeCompletedWithTasks,
  assertPlanStatusTransition,
  assertPlanStructure,
  assertPlanTaskLinks,
} from '../../../packages/domain/src/index.mjs';

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
    const allowLightweight = planId.startsWith('plan-light-');
    const instantiatedTasks = [];

    const normalizedPhases = (phases || []).map((phaseData, index) => {
      const pData = typeof phaseData.toJSON === 'function' ? phaseData.toJSON() : { ...phaseData };
      pData.id = pData.id || `phase-${index}`;
      pData.order = Number.isInteger(pData.order) ? pData.order : index;
      const phaseTasks = Array.isArray(pData.tasks) ? pData.tasks : [];
      const taskIds = Array.isArray(pData.taskIds) ? [...pData.taskIds] : [];

      for (const t of phaseTasks) {
        const tObj = typeof t === 'string' ? { id: t, title: t } : t;
        const tId = tObj.id || `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        if (!taskIds.includes(tId)) taskIds.push(tId);
        instantiatedTasks.push(new Task({
          ...tObj,
          id: tId,
          planId,
          phaseId: pData.id,
          title: tObj.title || tId,
          rules: tObj.rules ?? tObj.ruleRefs ?? tObj.references?.rules ?? [],
        }));
      }
      pData.taskIds = taskIds;
      delete pData.tasks;
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

    assertPlanStructure(plan, { allowLightweight });
    assertPlanTaskLinks(plan, instantiatedTasks);

    this.db.transaction(() => {
      this.db.savePlan(plan.toJSON());
      for (const task of instantiatedTasks) this.db.saveTask(task.toJSON());
    });
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
      const allTasksCompleted = tasks.every((task) => task.status === 'completed');

      if (allCheckpointsPassed && allTasksCompleted) {
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

  updatePlan(planId, planData = {}) {
    const rawPlan = this.db.getPlan(planId);
    if (!rawPlan) throw new Error(`Plan '${planId}' not found`);

    const tasks = this.db.listTasks(planId);
    const updated = new Plan({
      ...rawPlan,
      ...planData,
      id: rawPlan.id,
      projectId: rawPlan.projectId,
      updatedAt: new Date().toISOString(),
    });
    const allowLightweight = planId.startsWith('plan-light-');

    assertPlanStatusTransition(rawPlan.status, updated.status, planId);
    assertPlanStructure(updated, { allowLightweight });
    assertPlanTaskLinks(updated, tasks);

    if (updated.status === 'completed' && rawPlan.status !== 'completed') {
      assertPlanCanBeCompletedWithTasks(updated, tasks, { allowLightweight });
      updated.complete({
        completedSummary: planData.completedSummary || updated.completedSummary || updated.summary,
        historyRef: planData.historyRef || updated.historyRef,
      });
    }

    this.db.savePlan(updated.toJSON());
    return updated.toJSON();
  }

  completePlan(planId, { completedSummary = null, historyRef = null } = {}) {
    const rawPlan = this.db.getPlan(planId);
    if (!rawPlan) throw new Error(`Plan '${planId}' not found`);

    const tasks = this.db.listTasks(planId);
    const plan = new Plan(rawPlan);
    assertPlanCanBeCompletedWithTasks(plan, tasks, {
      allowLightweight: planId.startsWith('plan-light-'),
    });

    plan.complete({ completedSummary: completedSummary || plan.summary, historyRef });
    this.db.savePlan(plan.toJSON());
    return plan.toJSON();
  }

  deletePlan(planId) {
    return this.db.deletePlan(planId);
  }
}
