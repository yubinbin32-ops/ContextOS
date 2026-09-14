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
  const coveredFiles = new Set();
  for (const block of blocks) {
    for (const ref of block.artifactRefs || []) {
      if (ref.path) coveredFiles.add(ref.path);
    }
  }

  const uncoveredFiles = (task.workingSet?.files || []).filter((f) => !coveredFiles.has(f));

  return {
    isFullyCovered: uncoveredFiles.length === 0,
    uncoveredFiles,
    coveredFiles: Array.from(coveredFiles),
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
