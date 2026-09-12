import test from "node:test";
import assert from "node:assert/strict";
import { boundTaskResponse, resetTaskBudgets, startTaskBudget, taskBudget } from "../src/task-budget.mjs";

test("task budget is shared across focused reads and caps structured duplication", () => {
  resetTaskBudgets();
  const budget = startTaskBudget({ projectRoot: ".", budgetChars: 600 });
  const first = boundTaskResponse({
    taskContextId: budget.taskContextId,
    markdown: "a".repeat(350),
    data: { large: "b".repeat(900) },
    includeStructured: true,
  });
  assert.equal(first.structured.truncated, true);
  assert.equal(first.structured.graphRevision, null);
  const second = boundTaskResponse({
    taskContextId: budget.taskContextId,
    markdown: "c".repeat(350),
    data: { value: "d" },
    includeStructured: false,
  });
  assert.ok(second.markdown.length < 350);
  assert.ok(taskBudget(budget.taskContextId).consumedChars <= 600);
  resetTaskBudgets();
});

test("budget truncation preserves compact operation state", () => {
  resetTaskBudgets();
  const budget = startTaskBudget({ projectRoot: ".", budgetChars: 400 });
  const result = boundTaskResponse({
    taskContextId: budget.taskContextId,
    markdown: "m".repeat(300),
    data: {
      graphRevision: 42,
      sourceSync: { revision: 7, sourceRevision: "source-hash", changed: true },
      success: true,
      executionId: "exec_123",
      output: "x".repeat(2000),
    },
    includeStructured: true,
  });
  assert.equal(result.structured.truncated, true);
  assert.equal(result.structured.graphRevision, 42);
  assert.equal(result.structured.sourceSyncRevision, 7);
  assert.equal(result.structured.changed, true);
  assert.equal(result.structured.success, true);
  assert.equal(result.structured.executionId, "exec_123");
  resetTaskBudgets();
});

test('exhausted budget does not keep emitting oversized structured receipts',()=>{
 resetTaskBudgets();const {taskContextId}=startTaskBudget({budgetChars:100});
 const first=boundTaskResponse({taskContextId,markdown:'x'.repeat(200),data:{output:'y'.repeat(900)},includeStructured:true});
 const second=boundTaskResponse({taskContextId,markdown:'more',data:{output:'again'},includeStructured:true});
 const size=r=>r.markdown.length+(r.structured===undefined?0:JSON.stringify(r.structured).length);
 assert.ok(size(first)+size(second)<=100);resetTaskBudgets();
});
