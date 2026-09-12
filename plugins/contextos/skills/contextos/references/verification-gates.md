# Checkpoints and Verification Gates Reference

In contextos, healthy delivery and completion must be backed by passed Checkpoint evidence rather than prose claims.

## Evidence Hierarchy

Evidence levels range from weakest to strongest:
1. `none`: No evidence recorded.
2. `static`: Linters, compilers, AST symbol analysis.
3. `simulated`: In-memory mocks, unit tests with stubbed dependencies.
4. `integration`: Multiple subsystems interacting in a realistic environment.
5. `real_target`: Production build running against target hardware, real databases, or network endpoints.
6. `human_review`: Explicit design or validation sign-off by a human engineer.

A passed gate requires evidence level at least as strong as its `requiredEvidenceLevel`.

## Checkpoint Topologies

1. **Atomic Checkpoint**:
   - Bound directly to a specific Block, Link, or Direct PlanChange.
   - Evaluates only that entity's specific responsibility.
2. **Chain Integration Gate**:
   - Gate that validates an entire end-to-end Chain path.
   - Eligible to pass only after all its child Block/Link checkpoints pass.
3. **Plan Acceptance Gate**:
   - Gate that validates full Plan acceptance.
   - Depends on all direct Block changes and Chain integration gates.

## Checkpoint Status Cascading

When `checkpoint_record` records a `passed` checkpoint with required evidence:
- Bound `plan_changes` automatically advance to `complete`.
- Bound `blocks` advance to healthy delivery state (`complete` or `verifying`).
- Bound `plan_steps` with matching target references advance to `complete`.
- Stale checkpoints should be marked `retest_required` if code changes invalidate prior test runs.
