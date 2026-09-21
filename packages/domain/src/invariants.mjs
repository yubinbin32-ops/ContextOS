/**
 * Core domain invariants enforcement.
 */

export class InvariantViolationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'InvariantViolationError';
    this.details = details;
  }
}

/**
 * 1. Block must bind to real code; no ghost blocks allowed.
 */
export function assertBlockHasRealCode(block) {
  if (!block.artifactRefs || block.artifactRefs.length === 0) {
    throw new InvariantViolationError(
      `Invariant 1 Violation: Block '${block.id}' has no artifactRefs. Ghost blocks are strictly prohibited.`,
      { blockId: block.id }
    );
  }

  for (const ref of block.artifactRefs) {
    if (!ref.path || typeof ref.path !== 'string' || !ref.path.trim()) {
      throw new InvariantViolationError(
        `Invariant 1 Violation: Block '${block.id}' contains an artifactRef without a valid path.`,
        { blockId: block.id, ref }
      );
    }
    const anchorKind = ref.anchorKind || (ref.symbol ? 'symbol' : 'file');
    const hasSymbol = typeof ref.symbol === 'string' && ref.symbol.trim().length > 0;
    const hasHash = typeof ref.hash === 'string' && ref.hash.trim().length > 0;
    const hasPlaceholder = ref.symbol === '*' || ref.hash === 'untracked';
    const isValidAnchor =
      hasHash &&
      !hasPlaceholder &&
      (anchorKind !== 'symbol' || hasSymbol) &&
      (anchorKind !== 'tree' || (ref.hashMode === 'manifest' ? Boolean(ref.manifest) : true));
    if (!isValidAnchor) {
      throw new InvariantViolationError(
        `Invariant 1 Violation: Block '${block.id}' contains unanchored artifactRef for '${ref.path}' (anchorKind: '${anchorKind}', symbol: '${ref.symbol || ''}', hash: '${ref.hash || ''}'). Symbol anchors require 'symbol' and 'hash'; file/tree anchors require 'hash'; manifest tree anchors require 'manifest'. Run 'block(action: "bind_auto", id: "${block.id}", path: "${ref.path}")' to automatically extract anchors before sync.`,
        { blockId: block.id, ref }
      );
    }
  }
}

/**
 * 2. Checkpoint must belong strictly to a Plan.
 */
export function assertCheckpointBelongsToPlan(checkpoint, plan) {
  if (!checkpoint.planId || checkpoint.planId !== plan.id) {
    throw new InvariantViolationError(
      `Invariant 2 Violation: Checkpoint '${checkpoint.id}' does not belong to Plan '${plan.id}'. Checkpoints belong ONLY to Plans.`,
      { checkpointId: checkpoint.id, planId: plan.id }
    );
  }
}

/**
 * 3. Working set coverage check: All modified code files in task must have Block coverage upon sync.
 */
export function checkTaskCoverage(task, blocks = []) {
  const uncoveredFiles = (task.workingSet?.files || []).filter((filePath) => {
    const normalized = String(filePath).replace(/\\/g, '/').replace(/^\.\//, '');
    return !blocks.some((block) =>
      (block.artifactRefs || []).some((ref) => {
        const binding = String(ref.path || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
        return ref.anchorKind === 'tree'
          ? normalized === binding || normalized.startsWith(`${binding}/`)
          : normalized === binding;
      })
    );
  });

  return {
    isFullyCovered: uncoveredFiles.length === 0,
    uncoveredFiles,
    coveredFiles: (task.workingSet?.files || []).filter((filePath) => !uncoveredFiles.includes(filePath)),
  };
}

/**
 * 4. Plan completion gate: All checkpoints must be passed.
 */
export function assertPlanCanBeCompleted(plan) {
  const failedOrPending = (plan.checkpoints || []).filter((cp) => cp.status !== 'passed');
  if (failedOrPending.length > 0) {
    throw new InvariantViolationError(
      `Invariant 4 Violation: Cannot complete Plan '${plan.id}'. Unpassed checkpoints: ${failedOrPending.map((c) => c.id).join(', ')}`,
      { planId: plan.id, pendingCheckpoints: failedOrPending.map((c) => c.id) }
    );
  }
}

export const PLAN_STATUS_TRANSITIONS = Object.freeze({
  draft: ['active', 'archived'],
  active: ['completed', 'archived'],
  completed: ['archived'],
  archived: [],
});

export const TASK_STATUS_TRANSITIONS = Object.freeze({
  draft: ['active', 'blocked'],
  active: ['checking', 'syncing', 'blocked'],
  checking: ['syncing', 'sync_failed', 'active', 'blocked'],
  syncing: ['completed', 'sync_failed', 'blocked'],
  completed: [],
  blocked: ['active'],
  sync_failed: ['checking', 'active', 'blocked'],
});

function assertKnownStatus(value, allowed, entity, id) {
  if (!allowed.includes(value)) {
    throw new InvariantViolationError(
      `${entity} '${id}' has unsupported status '${value}'. Must be one of ${allowed.join(', ')}`,
      { id, status: value }
    );
  }
}

export function assertPlanStatusTransition(previousStatus, nextStatus, planId = '<unknown>') {
  const allowed = PLAN_STATUS_TRANSITIONS[previousStatus];
  assertKnownStatus(previousStatus, Object.keys(PLAN_STATUS_TRANSITIONS), 'Plan', planId);
  assertKnownStatus(nextStatus, Object.keys(PLAN_STATUS_TRANSITIONS), 'Plan', planId);
  if (previousStatus !== nextStatus && !allowed.includes(nextStatus)) {
    throw new InvariantViolationError(
      `Plan '${planId}' cannot transition from '${previousStatus}' to '${nextStatus}'.`,
      { planId, previousStatus, nextStatus, allowed }
    );
  }
}

export function assertTaskStatusTransition(previousStatus, nextStatus, taskId = '<unknown>') {
  const allowed = TASK_STATUS_TRANSITIONS[previousStatus];
  assertKnownStatus(previousStatus, Object.keys(TASK_STATUS_TRANSITIONS), 'Task', taskId);
  assertKnownStatus(nextStatus, Object.keys(TASK_STATUS_TRANSITIONS), 'Task', taskId);
  if (previousStatus !== nextStatus && !allowed.includes(nextStatus)) {
    throw new InvariantViolationError(
      `Task '${taskId}' cannot transition from '${previousStatus}' to '${nextStatus}'. Use the Task lifecycle actions instead of a raw status update.`,
      { taskId, previousStatus, nextStatus, allowed }
    );
  }
}

/**
 * Validate the structural contract of a non-lightweight plan. Legacy plans can
 * still be opened, but any create/update/completion path must pass this gate.
 */
export function assertPlanStructure(plan, { allowLightweight = false } = {}) {
  const phases = plan.phases || [];
  if (!allowLightweight && phases.length === 0) {
    throw new InvariantViolationError(
      `Plan '${plan.id}' requires at least one phase.`,
      { planId: plan.id }
    );
  }

  const phaseIds = new Set();
  const phaseOrders = new Set();
  for (const phase of phases) {
    if (phaseIds.has(phase.id)) {
      throw new InvariantViolationError(`Plan '${plan.id}' contains duplicate phase id '${phase.id}'.`, {
        planId: plan.id,
        phaseId: phase.id,
      });
    }
    phaseIds.add(phase.id);

    if (!Number.isInteger(phase.order) || phase.order < 0) {
      throw new InvariantViolationError(
        `Phase '${phase.id}' in Plan '${plan.id}' requires a non-negative integer order.`,
        { planId: plan.id, phaseId: phase.id, order: phase.order }
      );
    }
    if (phaseOrders.has(phase.order)) {
      throw new InvariantViolationError(
        `Plan '${plan.id}' contains duplicate phase order ${phase.order}; orders must be unique.`,
        { planId: plan.id, order: phase.order }
      );
    }
    phaseOrders.add(phase.order);

    if (!allowLightweight) {
      if (!String(phase.objective || '').trim()) {
        throw new InvariantViolationError(
          `Phase '${phase.id}' in Plan '${plan.id}' requires a non-empty objective.`,
          { planId: plan.id, phaseId: phase.id }
        );
      }
      if (!Array.isArray(phase.acceptance) || phase.acceptance.filter((item) => String(item || '').trim()).length === 0) {
        throw new InvariantViolationError(
          `Phase '${phase.id}' in Plan '${plan.id}' requires at least one acceptance criterion.`,
          { planId: plan.id, phaseId: phase.id }
        );
      }
    }
  }
}

export function assertPlanTaskLinks(plan, tasks = []) {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const referencedTaskIds = new Set();
  for (const phase of plan.phases || []) {
    const phaseTaskIds = Array.isArray(phase.taskIds) ? phase.taskIds : [];
    for (const taskId of phaseTaskIds) {
      const task = taskById.get(taskId);
      if (!task) {
        throw new InvariantViolationError(
          `Plan '${plan.id}' phase '${phase.id}' references missing Task '${taskId}'.`,
          { planId: plan.id, phaseId: phase.id, taskId }
        );
      }
      if (task.planId !== plan.id || task.phaseId !== phase.id) {
        throw new InvariantViolationError(
          `Task '${taskId}' is linked to '${task.planId}/${task.phaseId}', not '${plan.id}/${phase.id}'.`,
          { planId: plan.id, phaseId: phase.id, taskId, taskPlanId: task.planId, taskPhaseId: task.phaseId }
        );
      }
      referencedTaskIds.add(taskId);
    }
  }

  for (const task of tasks) {
    if (!referencedTaskIds.has(task.id)) {
      throw new InvariantViolationError(
        `Task '${task.id}' belongs to Plan '${plan.id}' but is not linked from phase '${task.phaseId}'.`,
        { planId: plan.id, phaseId: task.phaseId, taskId: task.id }
      );
    }
  }
}

export function assertPlanCanBeCompletedWithTasks(plan, tasks = [], { allowLightweight = false } = {}) {
  assertPlanStructure(plan, { allowLightweight });
  assertPlanTaskLinks(plan, tasks);
  assertPlanCanBeCompleted(plan);
  const unfinished = tasks.filter((task) => task.status !== 'completed');
  if (unfinished.length > 0) {
    throw new InvariantViolationError(
      `Cannot complete Plan '${plan.id}' while non-terminal tasks remain: ${unfinished.map((task) => `${task.id}(${task.status})`).join(', ')}`,
      { planId: plan.id, unfinishedTaskIds: unfinished.map((task) => task.id) }
    );
  }
}
