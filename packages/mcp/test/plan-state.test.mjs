import test from "node:test";
import assert from "node:assert/strict";
import { derivePlanState, isHardPlanBlocker } from "../src/schema.mjs";

test("scope notes do not hard-block a Plan, while waiting/cannot notes do", () => {
  assert.equal(isHardPlanBlocker("P2 局部持久化暂不进入本轮实现，避免破坏 SQLite 与 graph.json 兼容。"), false);
  assert.equal(isHardPlanBlocker("waiting for plan:foundation"), true);

  const plan = {
    id: "work-plan",
    status: "active",
    statusReason: "in progress",
    blockers: ["P2 局部持久化暂不进入本轮实现"],
    invalidatedAt: null,
  };
  const derived = derivePlanState(plan, [plan], [], [
    { id: "step-1", planId: "work-plan", status: "complete" },
    { id: "step-2", planId: "work-plan", status: "active" },
  ], [], [], [], [], []);
  assert.equal(derived.derivedStatus, "active");

  const blocked = derivePlanState({
    ...plan,
    blockers: ["waiting for plan:foundation"],
  }, [plan], [], [
    { id: "step-1", planId: "work-plan", status: "complete" },
    { id: "step-2", planId: "work-plan", status: "active" },
  ], [], [], [], [], []);
  assert.equal(blocked.derivedStatus, "blocked");
});
