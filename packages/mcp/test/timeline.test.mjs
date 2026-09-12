import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ProjectServiceRouter } from "../src/project-router.mjs";
import { normalizePriority } from "../src/timeline.mjs";

test("timeline: normalizePriority handles variants correctly", () => {
  assert.equal(normalizePriority("p0"), "P0");
  assert.equal(normalizePriority("critical"), "P0");
  assert.equal(normalizePriority("p1"), "P1");
  assert.equal(normalizePriority("high"), "P1");
  assert.equal(normalizePriority("p2"), "P2");
  assert.equal(normalizePriority("normal"), "P2");
  assert.equal(normalizePriority("p3"), "P3");
  assert.equal(normalizePriority("low"), "P3");
  assert.equal(normalizePriority("unknown"), "P2");
});

test("timeline: getTimelineState, syncTimeline and advanceStep", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-timeline-test-"));
  const router = new ProjectServiceRouter();
  router.register({ projectRoot: tmpDir, name: "timeline-test" });
  const service = router.serviceFor({ projectRoot: tmpDir });

  // Create blocks and a plan with steps
  service.mutate({
    reason: "Create test blocks and plan",
    operations: [
      {
        action: "create_block",
        id: "auth-svc",
        fields: {
          title: "Auth Service",
          kind: "service",
          architectureLayer: "application",
          scope: "auth",
        },
      },
      {
        action: "create_plan",
        id: "plan-auth",
        fields: {
          title: "Implement Authentication",
          phase: "foundation",
          priority: "P0",
          status: "active",
        },
      },
      {
        action: "set_plan_steps",
        id: "plan-auth",
        expectedRevision: 1,
        fields: {
          steps: [
            {
              id: "step-1",
              title: "Define JWT token schema",
              action: "Create jwt.ts and interfaces",
              position: 1,
              status: "active",
            },
            {
              id: "step-2",
              title: "Implement Token Signer",
              action: "Write signer function",
              position: 2,
              status: "pending",
            },
          ],
        },
      },
    ],
  });

  // 1. Check initial timeline state
  const timeline = service.getTimeline();
  assert.equal(timeline.phases.length, 1);
  assert.equal(timeline.phases[0].phase, "foundation");
  assert.equal(timeline.phases[0].plans[0].id, "plan-auth");
  assert.equal(timeline.phases[0].plans[0].priority, "P0");
  assert.equal(timeline.activeCursor.activePlanId, "plan-auth");
  assert.equal(timeline.activeCursor.activeStepId, "step-1");
  assert.equal(timeline.activeCursor.activeStepIndex, 1);
  assert.equal(timeline.activeCursor.totalSteps, 2);
  assert.ok(timeline.markdown.includes("Implement Authentication"));

  // 2. Sync timeline cursor
  const synced = service.syncTimeline({
    nowDoing: "Implementing JWT token payload parser",
    nextUp: "Run token unit tests",
    touchedFiles: ["src/auth/jwt.ts"],
  });
  assert.equal(synced.nowDoing, "Implementing JWT token payload parser");
  assert.equal(synced.nextUp, "Run token unit tests");
  assert.deepEqual(synced.touchedFiles, ["src/auth/jwt.ts"]);

  // Verify state persists in getTimeline
  const afterSync = service.getTimeline();
  assert.equal(afterSync.activeCursor.nowDoing, "Implementing JWT token payload parser");
  assert.equal(afterSync.activeCursor.nextUp, "Run token unit tests");

  // 3. Advance step
  const advanced = service.advanceStep({
    summary: "JWT token schema defined and verified",
  });
  assert.equal(advanced.activeStepId, "step-2");
  assert.ok(advanced.nowDoing.includes("Implement Token Signer"));
  assert.equal(advanced.lastFinished, "JWT token schema defined and verified");

  // Verify step status in database
  const steps = service.snapshot().planSteps.sort((a, b) => a.position - b.position);
  assert.equal(steps[0].status, "complete");
  assert.equal(steps[1].status, "active");

  const moved = service.syncTimeline({
    planId: "plan-auth",
    stepId: "step-2",
    nowDoing: "Implementing token signer",
  });
  assert.equal(moved.activeStepId, "step-2");
  const afterMove = service.snapshot().planSteps.sort((a, b) => a.position - b.position);
  assert.equal(afterMove[0].status, "complete");
  assert.equal(afterMove[1].status, "active");

  router.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});
