import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ProjectServiceRouter } from "../src/project-router.mjs";
import { beginTask, synchronizeTaskNetwork } from "../src/reconciliation.mjs";

test("block_code_stream returns only the requested AST symbol slice", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-slice-test-"));
  const router = new ProjectServiceRouter();
  router.register({ projectRoot: tmpDir, name: "slice-test" });
  const service = router.serviceFor({ projectRoot: tmpDir });
  await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
  await fs.writeFile(path.join(tmpDir, "src/example.js"), [
    "export function first() { return 'first'; }",
    "export function second() { return 'second'; }",
  ].join("\n"));
  service.mutate({ reason: "Create AST slice fixture", operations: [
    { action: "create_block", id: "first", fields: { title: "First", kind: "function", architectureLayer: "application", scope: "core" } },
    { action: "add_source_ref", id: "first", fields: { path: "src/example.js", symbol: "first", role: "implementation" } },
  ] });
  const result = service.blockCodeStream({ blockId: "first", mode: "slice", maxLines: 20 });
  assert.match(result.codeStream, /return 'first'/);
  assert.doesNotMatch(result.codeStream, /return 'second'/);
  assert.equal(result.node.filePath, "src/example.js");
  assert.equal(result.node.symbol, "first");
  // A repository index pass shares the file cache with binding reads. The
  // binding must stay readable after that boundary so a real task can move
  // from context retrieval to an AST slice without reopening the whole file.
  service.contextForTask({ task: "read the first function", maxChars: 1200 });
  const afterContext = service.blockCodeStream({ blockId: "first", mode: "slice", maxLines: 20 });
  assert.equal(afterContext.node.sourceStatus, "anchored");
  assert.match(afterContext.codeStream, /return 'first'/);
  router.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("plan and chain append operations preserve existing paths and changes", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-append-test-"));
  const router = new ProjectServiceRouter();
  router.register({ projectRoot: tmpDir, name: "append-test" });
  const service = router.serviceFor({ projectRoot: tmpDir });
  service.mutate({ reason: "Create append fixture", operations: [
    { action: "create_block", id: "a", fields: { title: "A", kind: "service", architectureLayer: "application", scope: "core" } },
    { action: "create_block", id: "b", fields: { title: "B", kind: "service", architectureLayer: "application", scope: "core" } },
    { action: "create_link", id: "a-to-b", fields: { sourceType: "block", sourceId: "a", targetType: "block", targetId: "b", kind: "calls", label: "A calls B", contract: "A -> B" } },
    { action: "create_chain", id: "chain-ab", fields: { title: "AB", intent: "A to B", deliveryState: "planned" } },
    { action: "create_plan", id: "plan-ab", fields: { title: "AB Plan", status: "active" } },
  ] });
  const chainResult = service.appendChainPath({ chainId: "chain-ab", expectedRevision: 1, nodeIds: ["a", "b"], linkIds: ["a-to-b"] });
  assert.equal(chainResult.receipts[0].action, "path-appended");
  assert.deepEqual(service.snapshot().chainNodes.filter((item) => item.chainId === "chain-ab").map((item) => item.blockId), ["a", "b"]);
  const planResult = service.appendPlanChanges({
    planId: "plan-ab",
    expectedRevision: 1,
    changes: [{ entityType: "block", entityId: "b", title: "Implement B", status: "pending" }],
  });
  assert.equal(planResult.receipts[0].action, "changes-appended");
  assert.equal(service.snapshot().planChanges.filter((item) => item.planId === "plan-ab").length, 1);
  const updatedPlan = service.updatePlanChanges({
    planId: "plan-ab",
    expectedRevision: 2,
    updates: [{ changeId: "plan-ab-change-block-b", patch: { status: "complete" } }],
  });
  assert.equal(updatedPlan.receipts[0].action, "plan-changes-updated");
  assert.equal(service.snapshot().planChanges.find((item) => item.planId === "plan-ab")?.status, "complete");
  assert.throws(
    () => service.appendPlanChanges({ planId: "plan-ab", expectedRevision: 3, changes: [{ entityType: "block", entityId: "b", title: "Duplicate B" }] }),
    /canonical change/,
  );
  const started = beginTask(service, { intent: "Continue B", blockIds: ["a"], planId: "plan-ab", standaloneReason: "Plan coverage fixture" });
  assert.equal(started.planCoverage.changed, true);
  assert.equal(service.snapshot().planChanges.filter((item) => item.planId === "plan-ab").length, 2);
  assert.equal(JSON.parse(service.database.prepare("SELECT scope_json FROM task_sessions WHERE id = ?").get(started.taskId).scope_json).planId, "plan-ab");
  router.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("task network reconciliation appends an explicitly linked Block", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-network-test-"));
  const router = new ProjectServiceRouter();
  router.register({ projectRoot: tmpDir, name: "network-test" });
  const service = router.serviceFor({ projectRoot: tmpDir });
  service.mutate({ reason: "Create network fixture", operations: [
    { action: "create_block", id: "root", fields: { title: "Root", kind: "service", architectureLayer: "application", scope: "core" } },
    { action: "create_block", id: "leaf", fields: { title: "Leaf", kind: "service", architectureLayer: "application", scope: "core" } },
    { action: "create_link", id: "root-to-leaf", fields: { sourceType: "block", sourceId: "root", targetType: "block", targetId: "leaf", kind: "calls", contract: "Root -> Leaf" } },
    { action: "create_chain", id: "feature-chain", fields: { title: "Feature", intent: "Root to Leaf", inputContract: "input", outputContract: "output", deliveryState: "planned" } },
    { action: "set_chain_path", id: "feature-chain", expectedRevision: 1, fields: { nodeIds: ["root"], linkIds: [] } },
  ] });
  const result = synchronizeTaskNetwork(service, { chainId: "feature-chain", blockIds: ["root", "leaf"] });
  assert.equal(result.changed, true);
  assert.deepEqual(result.appendedNodeIds, ["leaf"]);
  assert.deepEqual(service.snapshot().chainNodes.filter((item) => item.chainId === "feature-chain").map((item) => item.blockId), ["root", "leaf"]);
  assert.deepEqual(service.snapshot().chainEdges.filter((item) => item.chainId === "feature-chain").map((item) => item.linkId), ["root-to-leaf"]);
  router.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("chain topology reconciliation repairs order and keeps deliberate fan-out", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-chain-topology-test-"));
  const router = new ProjectServiceRouter();
  router.register({ projectRoot: tmpDir, name: "chain-topology-test" });
  const service = router.serviceFor({ projectRoot: tmpDir });
  service.mutate({ reason: "Create fan-out chain fixture", operations: [
    ...["root", "left", "right", "tail"].map((id) => ({ action: "create_block", id, fields: { title: id, kind: "service", architectureLayer: "application", scope: "core" } })),
    { action: "create_link", id: "root-left", fields: { sourceType: "block", sourceId: "root", targetType: "block", targetId: "left", kind: "calls", contract: "root -> left" } },
    { action: "create_link", id: "root-right", fields: { sourceType: "block", sourceId: "root", targetType: "block", targetId: "right", kind: "calls", contract: "root -> right" } },
    { action: "create_link", id: "left-tail", fields: { sourceType: "block", sourceId: "left", targetType: "block", targetId: "tail", kind: "calls", contract: "left -> tail" } },
    { action: "create_link", id: "right-tail", fields: { sourceType: "block", sourceId: "right", targetType: "block", targetId: "tail", kind: "calls", contract: "right -> tail" } },
    { action: "create_chain", id: "fanout-chain", fields: { title: "Fan-out", intent: "Root fans out and merges", deliveryState: "planned" } },
    { action: "set_chain_path", id: "fanout-chain", expectedRevision: 1, fields: { nodeIds: ["tail", "right", "left", "root"], linkIds: [] } },
  ] });
  // Simulate a legacy projection that attached Links without reconciling node order.
  for (const [position, linkId] of ["root-left", "root-right", "left-tail", "right-tail"].entries()) {
    service.database.prepare("INSERT INTO chain_edges(chain_id, link_id, position) VALUES (?, ?, ?)").run("fanout-chain", linkId, position);
  }
  const dryRun = service.reconcileChainTopology({ chainId: "fanout-chain", autoReorder: false });
  assert.equal(dryRun.changed, false);
  assert.ok(dryRun.issues.some((issue) => issue.code === "needs_reorder"));
  const repaired = service.reconcileChainTopology({ chainId: "fanout-chain" });
  assert.deepEqual(repaired.changedChainIds, ["fanout-chain"]);
  assert.deepEqual(service.snapshot().chainNodes.filter((item) => item.chainId === "fanout-chain").map((item) => item.blockId), ["root", "right", "left", "tail"]);
  assert.equal(service.validate().errors.some((error) => error.includes("backward_edge")), false);
  router.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("task network inserts a newly linked Block at its topological position", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-chain-insert-test-"));
  const router = new ProjectServiceRouter();
  router.register({ projectRoot: tmpDir, name: "chain-insert-test" });
  const service = router.serviceFor({ projectRoot: tmpDir });
  service.mutate({ reason: "Create insertion fixture", operations: [
    ...["root", "middle", "tail"].map((id) => ({ action: "create_block", id, fields: { title: id, kind: "service", architectureLayer: "application", scope: "core" } })),
    { action: "create_link", id: "root-middle", fields: { sourceType: "block", sourceId: "root", targetType: "block", targetId: "middle", kind: "calls", contract: "root -> middle" } },
    { action: "create_link", id: "middle-tail", fields: { sourceType: "block", sourceId: "middle", targetType: "block", targetId: "tail", kind: "calls", contract: "middle -> tail" } },
    { action: "create_chain", id: "insert-chain", fields: { title: "Insertion", intent: "Insert a newly discovered root", inputContract: "input", outputContract: "output", deliveryState: "planned" } },
    { action: "set_chain_path", id: "insert-chain", expectedRevision: 1, fields: { nodeIds: ["middle", "tail"], linkIds: ["middle-tail"] } },
  ] });
  service.database.prepare("UPDATE chains SET delivery_state = 'complete', health_state = 'healthy' WHERE id = 'insert-chain'").run();
  const result = synchronizeTaskNetwork(service, { chainId: "insert-chain", blockIds: ["root"], linkIds: ["root-middle"] });
  assert.equal(result.changed, true);
  assert.equal(result.reordered, true);
  assert.deepEqual(result.appendedNodeIds, ["root"]);
  assert.deepEqual(result.appendedLinkIds, ["root-middle"]);
  assert.deepEqual(service.snapshot().chainNodes.filter((item) => item.chainId === "insert-chain").map((item) => item.blockId), ["root", "middle", "tail"]);
  assert.deepEqual(service.snapshot().chainEdges.filter((item) => item.chainId === "insert-chain").map((item) => item.linkId), ["middle-tail", "root-middle"]);
  assert.equal(service.snapshot().chains.find((item) => item.id === "insert-chain")?.deliveryState, "implementing");
  router.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("Chain completion rejects a disconnected legacy path", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-chain-complete-test-"));
  const router = new ProjectServiceRouter();
  router.register({ projectRoot: tmpDir, name: "chain-complete-test" });
  const service = router.serviceFor({ projectRoot: tmpDir });
  service.mutate({ reason: "Create completion fixture", operations: [
    { action: "create_block", id: "first", fields: { title: "First", kind: "product", architectureLayer: "application", scope: "core" } },
    { action: "create_block", id: "second", fields: { title: "Second", kind: "product", architectureLayer: "application", scope: "core" } },
    { action: "create_chain", id: "complete-chain", fields: { title: "Complete", intent: "Completion gate", inputContract: "input", outputContract: "output", deliveryState: "planned" } },
    { action: "set_chain_path", id: "complete-chain", expectedRevision: 1, fields: { nodeIds: ["first", "second"], linkIds: [] } },
  ] });
  service.database.prepare("UPDATE blocks SET delivery_state = 'complete' WHERE id IN ('first', 'second')").run();
  assert.throws(
    () => service.mutate({ reason: "Reject incomplete Chain", operations: [{ action: "update_chain", id: "complete-chain", expectedRevision: 2, fields: { deliveryState: "complete" } }] }),
    /ordered connected topology/,
  );
  router.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("chain topology validation surfaces cycles instead of treating them as a healthy path", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-chain-cycle-test-"));
  const router = new ProjectServiceRouter();
  router.register({ projectRoot: tmpDir, name: "chain-cycle-test" });
  const service = router.serviceFor({ projectRoot: tmpDir });
  service.mutate({ reason: "Create cyclic legacy fixture", operations: [
    { action: "create_block", id: "a", fields: { title: "A", kind: "service", architectureLayer: "application", scope: "core" } },
    { action: "create_block", id: "b", fields: { title: "B", kind: "service", architectureLayer: "application", scope: "core" } },
    { action: "create_link", id: "a-b", fields: { sourceType: "block", sourceId: "a", targetType: "block", targetId: "b", kind: "calls", contract: "A -> B" } },
    { action: "create_link", id: "b-a", fields: { sourceType: "block", sourceId: "b", targetType: "block", targetId: "a", kind: "calls", contract: "B -> A" } },
    { action: "create_chain", id: "cyclic-chain", fields: { title: "Cyclic legacy path", intent: "Cycle must be visible", deliveryState: "planned" } },
    { action: "set_chain_path", id: "cyclic-chain", expectedRevision: 1, fields: { nodeIds: ["a", "b"], linkIds: [] } },
  ] });
  service.database.prepare("UPDATE chains SET delivery_state = 'complete' WHERE id = ?").run("cyclic-chain");
  service.database.prepare("INSERT INTO chain_edges(chain_id, link_id, position) VALUES (?, ?, ?)").run("cyclic-chain", "a-b", 0);
  service.database.prepare("INSERT INTO chain_edges(chain_id, link_id, position) VALUES (?, ?, ?)").run("cyclic-chain", "b-a", 1);
  const reconciliation = service.reconcileChainTopology({ chainId: "cyclic-chain" });
  assert.equal(reconciliation.changed, false);
  assert.match(reconciliation.issues.map((issue) => issue.detail).join("\n"), /cycle/i);
  assert.ok(service.validate().errors.some((error) => /cycle/i.test(error)));
  router.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("task network reconciliation appends an explicit Link even when Blocks already belong to the Chain", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-chain-link-test-"));
  const router = new ProjectServiceRouter();
  router.register({ projectRoot: tmpDir, name: "chain-link-test" });
  const service = router.serviceFor({ projectRoot: tmpDir });
  service.mutate({ reason: "Create explicit link fixture", operations: [
    { action: "create_block", id: "root", fields: { title: "Root", kind: "service", architectureLayer: "application", scope: "core" } },
    { action: "create_block", id: "leaf", fields: { title: "Leaf", kind: "service", architectureLayer: "application", scope: "core" } },
    { action: "create_link", id: "root-leaf", fields: { sourceType: "block", sourceId: "root", targetType: "block", targetId: "leaf", kind: "calls", contract: "Root -> Leaf" } },
    { action: "create_chain", id: "explicit-link-chain", fields: { title: "Explicit link", intent: "Attach an existing route", deliveryState: "planned" } },
    { action: "set_chain_path", id: "explicit-link-chain", expectedRevision: 1, fields: { nodeIds: ["root", "leaf"], linkIds: [] } },
  ] });
  const result = synchronizeTaskNetwork(service, { chainId: "explicit-link-chain", blockIds: ["root", "leaf"], linkIds: ["root-leaf"] });
  assert.equal(result.changed, true);
  assert.deepEqual(result.appendedNodeIds, []);
  assert.deepEqual(result.appendedLinkIds, ["root-leaf"]);
  assert.deepEqual(service.snapshot().chainEdges.filter((item) => item.chainId === "explicit-link-chain").map((item) => item.linkId), ["root-leaf"]);
  router.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("context boundary advances a bound ghost Block without marking it complete", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-ghost-test-"));
  const router = new ProjectServiceRouter();
  router.register({ projectRoot: tmpDir, name: "ghost-test" });
  const service = router.serviceFor({ projectRoot: tmpDir });
  await fs.writeFile(path.join(tmpDir, "worker.js"), "export function work() { return 42; }\n");
  service.mutate({ reason: "Create ghost fixture", operations: [
    { action: "create_block", id: "worker", fields: { title: "Worker", kind: "function", architectureLayer: "application", scope: "core", deliveryState: "planned" } },
    { action: "add_source_ref", id: "worker", expectedRevision: 1, fields: { path: "worker.js", symbol: "work", role: "implementation" } },
  ] });
  const context = service.contextForTask({ task: "run worker", maxChars: 4000 });
  assert.deepEqual(context.autoReconciliation.advancedBlockIds, ["worker"]);
  const block = service.snapshot().blocks.find((item) => item.id === "worker");
  assert.equal(block.deliveryState, "implementing");
  assert.notEqual(block.deliveryState, "complete");
  router.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});
