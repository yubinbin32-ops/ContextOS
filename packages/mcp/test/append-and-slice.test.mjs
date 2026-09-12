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

test("block_code_stream returns all SourceRef locators and requires a choice for a multi-file slice", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-locator-map-test-"));
  const router = new ProjectServiceRouter();
  router.register({ projectRoot: tmpDir, name: "locator-map-test" });
  const service = router.serviceFor({ projectRoot: tmpDir });
  await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
  await fs.writeFile(path.join(tmpDir, "src/entry.js"), "export function entry() { return 'entry'; }\n");
  await fs.writeFile(path.join(tmpDir, "src/adapter.js"), "export function adapter() { return 'adapter'; }\n");
  service.mutate({ reason: "Create multi-source locator fixture", operations: [
    { action: "create_block", id: "multi", fields: { title: "Multi source", kind: "service", architectureLayer: "application", scope: "core" } },
    { action: "add_source_ref", id: "multi", fields: { sourceId: "source-1", path: "src/entry.js", symbol: "entry", role: "implementation" } },
    { action: "add_source_ref", id: "multi", fields: { sourceId: "source-2", path: "src/adapter.js", symbol: "adapter", role: "adapter" } },
  ] });
  const map = service.blockCodeStream({ blockId: "multi" });
  assert.equal(map.readMode, "locator-only");
  assert.equal(map.locators.length, 2);
  assert.deepEqual(map.locators.map((locator) => locator.path), ["src/entry.js", "src/adapter.js"]);
  assert.doesNotMatch(map.codeStream, /return 'entry'/);
  const ambiguous = service.blockCodeStream({ blockId: "multi", mode: "slice" });
  assert.equal(ambiguous.readMode, "locator-only");
  assert.match(ambiguous.node.reason, /multiple SourceRefs/);
  const selected = service.blockCodeStream({ blockId: "multi", sourceRefId: "source-2", mode: "slice" });
  assert.equal(selected.readMode, "ast-slice");
  assert.match(selected.codeStream, /return 'adapter'/);
  assert.doesNotMatch(selected.codeStream, /return 'entry'/);
  router.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("block_code_stream can read an explicitly selected line-only locator", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-line-locator-test-"));
  const router = new ProjectServiceRouter();
  router.register({ projectRoot: tmpDir, name: "line-locator-test" });
  const service = router.serviceFor({ projectRoot: tmpDir });
  await fs.writeFile(path.join(tmpDir, "range.js"), [
    "const before = 1;",
    "const selected = 2;",
    "const after = 3;",
  ].join("\n"));
  service.mutate({ reason: "Create line-only locator fixture", operations: [
    { action: "create_block", id: "range", fields: { title: "Line range", kind: "service", architectureLayer: "application", scope: "core" } },
    { action: "add_source_ref", id: "range", fields: { sourceId: "range-source", path: "range.js", startLine: 2, endLine: 2, role: "implementation" } },
  ] });
  const result = service.blockCodeStream({ blockId: "range", sourceRefId: "range-source", mode: "slice" });
  assert.equal(result.readMode, "ast-slice");
  assert.match(result.codeStream, /const selected = 2/);
  assert.doesNotMatch(result.codeStream, /const before = 1/);
  assert.doesNotMatch(result.codeStream, /const after = 3/);
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

test("task network reconciliation appends explicitly selected Blocks and Links", async () => {
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
  const result = synchronizeTaskNetwork(service, { chainId: "feature-chain", blockIds: ["root", "leaf"], linkIds: ["root-to-leaf"] });
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
  const repaired = service.reconcileChainTopology({ chainId: "fanout-chain", autoReorder: true });
  assert.deepEqual(repaired.changedChainIds, ["fanout-chain"]);
  assert.deepEqual(service.snapshot().chainNodes.filter((item) => item.chainId === "fanout-chain").map((item) => item.blockId), ["root", "right", "left", "tail"]);
  assert.equal(service.validate().errors.some((error) => error.includes("backward_edge")), false);
  router.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("chain network inspection reports order drift without mutating the Chain", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-chain-network-inspect-test-"));
  const router = new ProjectServiceRouter();
  router.register({ projectRoot: tmpDir, name: "chain-network-inspect-test" });
  const service = router.serviceFor({ projectRoot: tmpDir });
  service.mutate({ reason: "Create network inspection fixture", operations: [
    ...["source", "target"].map((id) => ({ action: "create_block", id, fields: { title: id, kind: "service", architectureLayer: "application", scope: "feature" } })),
    { action: "create_link", id: "source-target", fields: { sourceType: "block", sourceId: "source", targetType: "block", targetId: "target", kind: "calls", contract: "source -> target" } },
    { action: "create_chain", id: "network-inspect", fields: { title: "Network inspection", intent: "Review order", deliveryState: "planned" } },
    { action: "set_chain_path", id: "network-inspect", expectedRevision: 1, fields: { nodeIds: ["source", "target"], linkIds: ["source-target"] } },
  ] });
  // Reproduce a legacy projection whose stored order drifted from its route.
  service.database.prepare("UPDATE chain_nodes SET position = CASE block_id WHEN 'source' THEN 1 ELSE 0 END WHERE chain_id = 'network-inspect'").run();
  const before = service.snapshot().chainNodes.filter((item) => item.chainId === "network-inspect").sort((a, b) => a.position - b.position).map((item) => item.blockId);
  const report = service.reconcileChainNetwork({ chainId: "network-inspect", autoExpand: false, autoReorder: false });
  assert.equal(report.changed, false);
  const after = service.snapshot().chainNodes.filter((item) => item.chainId === "network-inspect").sort((a, b) => a.position - b.position).map((item) => item.blockId);
  assert.deepEqual(after, before);
  const topology = service.reconcileChainTopology({ chainId: "network-inspect", autoReorder: false });
  assert.ok(topology.issues.some((issue) => issue.code === "needs_reorder"));
  const repaired = service.reconcileChainNetwork({ chainId: "network-inspect", autoExpand: false, autoReorder: true });
  assert.deepEqual(repaired.changedChainIds, ["network-inspect"]);
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

test("Chain network reconciliation absorbs an explicitly affiliated linked Block", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-chain-network-affinity-test-"));
  const router = new ProjectServiceRouter();
  router.register({ projectRoot: tmpDir, name: "chain-network-affinity-test" });
  const service = router.serviceFor({ projectRoot: tmpDir });
  service.mutate({ reason: "Create affiliated feature network", operations: [
    { action: "create_block", id: "plugin-root", fields: { title: "Plugin root", kind: "integration", architectureLayer: "boundary", scope: "codex", tags: ["plugin"] } },
    { action: "create_block", id: "plugin-lifecycle", fields: { title: "Plugin lifecycle", kind: "service", architectureLayer: "application", scope: "codex", tags: ["plugin", "chain:plugin-release"] } },
    { action: "create_link", id: "plugin-root-to-lifecycle", fields: { sourceType: "block", sourceId: "plugin-root", targetType: "block", targetId: "plugin-lifecycle", kind: "calls", contract: "Plugin root calls lifecycle" } },
    { action: "create_chain", id: "plugin-release", fields: { title: "Plugin release", purpose: "delivery", intent: "Install and reload the plugin", deliveryState: "planned" } },
    { action: "set_chain_path", id: "plugin-release", expectedRevision: 1, fields: { nodeIds: ["plugin-root"], linkIds: [] } },
  ] });
  service.database.prepare("UPDATE chains SET delivery_state = 'complete', health_state = 'healthy' WHERE id = 'plugin-release'").run();
  const result = service.reconcileChainNetwork({ chainId: "plugin-release", autoExpand: true });
  assert.deepEqual(result.changedChainIds, ["plugin-release"]);
  assert.equal(result.reports[0].complete, true);
  assert.deepEqual(result.reports[0].missingInternalLinks, []);
  assert.deepEqual(service.snapshot().chainNodes.filter((item) => item.chainId === "plugin-release").sort((a, b) => a.position - b.position).map((item) => item.blockId), ["plugin-root", "plugin-lifecycle"]);
  assert.deepEqual(service.snapshot().chainEdges.filter((item) => item.chainId === "plugin-release").map((item) => item.linkId), ["plugin-root-to-lifecycle"]);
  assert.equal(service.snapshot().chains.find((item) => item.id === "plugin-release")?.deliveryState, "implementing");
  router.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("Chain network reconciliation attaches a safe internal route Link and leaves feedback cycles outside", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-chain-network-link-test-"));
  const router = new ProjectServiceRouter();
  router.register({ projectRoot: tmpDir, name: "chain-network-link-test" });
  const service = router.serviceFor({ projectRoot: tmpDir });
  service.mutate({ reason: "Create internal route fixture", operations: [
    ...["first", "second"].map((id) => ({ action: "create_block", id, fields: { title: id, kind: "service", architectureLayer: "application", scope: "feature" } })),
    { action: "create_link", id: "first-second", fields: { sourceType: "block", sourceId: "first", targetType: "block", targetId: "second", kind: "flows_to", contract: "first -> second" } },
    { action: "create_link", id: "second-first", fields: { sourceType: "block", sourceId: "second", targetType: "block", targetId: "first", kind: "flows_to", contract: "feedback" } },
    { action: "create_chain", id: "route-chain", fields: { title: "Route", intent: "first to second", deliveryState: "planned" } },
    { action: "set_chain_path", id: "route-chain", expectedRevision: 1, fields: { nodeIds: ["first", "second"], linkIds: [] } },
  ] });
  const result = service.reconcileChainNetwork({ chainId: "route-chain", autoExpand: true });
  assert.equal(result.changed, true);
  assert.equal(result.reports[0].complete, false);
  assert.deepEqual(result.reports[0].missingInternalLinks.map((link) => link.id), ["second-first"]);
  assert.deepEqual(service.snapshot().chainEdges.filter((item) => item.chainId === "route-chain").map((item) => item.linkId), ["first-second"]);
  assert.ok(result.reports[0].skippedLinkIds.includes("second-first"));
  router.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("Chain network reconciliation reaches affiliated Blocks transitively in one boundary", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-chain-network-fixed-point-test-"));
  const router = new ProjectServiceRouter();
  router.register({ projectRoot: tmpDir, name: "chain-network-fixed-point-test" });
  const service = router.serviceFor({ projectRoot: tmpDir });
  service.mutate({ reason: "Create transitive feature fixture", operations: [
    { action: "create_block", id: "root", fields: { title: "Root", kind: "service", architectureLayer: "application", scope: "feature" } },
    { action: "create_block", id: "middle", fields: { title: "Middle", kind: "service", architectureLayer: "application", scope: "feature", tags: ["chain:fixed-point"] } },
    { action: "create_block", id: "leaf", fields: { title: "Leaf", kind: "service", architectureLayer: "application", scope: "feature", tags: ["chain:fixed-point"] } },
    { action: "create_link", id: "root-middle", fields: { sourceType: "block", sourceId: "root", targetType: "block", targetId: "middle", kind: "calls", contract: "root calls middle" } },
    { action: "create_link", id: "middle-leaf", fields: { sourceType: "block", sourceId: "middle", targetType: "block", targetId: "leaf", kind: "calls", contract: "middle calls leaf" } },
    { action: "create_chain", id: "fixed-point", fields: { title: "Fixed point", intent: "root to leaf", deliveryState: "planned" } },
    { action: "set_chain_path", id: "fixed-point", expectedRevision: 1, fields: { nodeIds: ["root"], linkIds: [] } },
  ] });
  const result = service.reconcileChainNetwork({ chainId: "fixed-point", autoExpand: true });
  assert.deepEqual(service.snapshot().chainNodes.filter((item) => item.chainId === "fixed-point").sort((a, b) => a.position - b.position).map((item) => item.blockId), ["root", "middle", "leaf"]);
  assert.deepEqual(service.snapshot().chainEdges.filter((item) => item.chainId === "fixed-point").sort((a, b) => a.position - b.position).map((item) => item.linkId), ["root-middle", "middle-leaf"]);
  assert.deepEqual(result.reports[0].autoExpandedBlockIds, ["middle", "leaf"]);
  assert.ok(result.reports[0].passes >= 3);
  router.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("Chain network reconciliation surfaces an affinity Block that is waiting for its route Link", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-chain-network-gap-test-"));
  const router = new ProjectServiceRouter();
  router.register({ projectRoot: tmpDir, name: "chain-network-gap-test" });
  const service = router.serviceFor({ projectRoot: tmpDir });
  service.mutate({ reason: "Create affinity gap fixture", operations: [
    { action: "create_block", id: "plugin-root", fields: { title: "Plugin root", kind: "integration", architectureLayer: "boundary", scope: "codex" } },
    { action: "create_block", id: "plugin-orphan", fields: { title: "Plugin lifecycle", kind: "service", architectureLayer: "application", scope: "codex", tags: ["chain:plugin-release"] } },
    { action: "create_chain", id: "plugin-release", fields: { title: "Plugin release", intent: "Install and reload the plugin" } },
    { action: "set_chain_path", id: "plugin-release", expectedRevision: 1, fields: { nodeIds: ["plugin-root"], linkIds: [] } },
  ] });
  const result = service.reconcileChainNetwork({ chainId: "plugin-release", autoExpand: true });
  assert.equal(result.changed, false);
  assert.equal(result.reports[0].complete, false);
  assert.deepEqual(result.reports[0].candidateBlocks.map((candidate) => candidate.blockId), ["plugin-orphan"]);
  assert.equal(result.reports[0].candidateBlocks[0].requiresRouteLink, true);
  assert.ok(result.reports[0].issues.some((issue) => issue.code === "affinity_missing_route"));
  const audit = service.validate();
  assert.ok(audit.errors.some((error) => error.includes("Chain network Block has no route Link")));
  router.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("context boundary reports a newly written Block without changing Chain membership", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-chain-context-boundary-test-"));
  const router = new ProjectServiceRouter();
  router.register({ projectRoot: tmpDir, name: "chain-context-boundary-test" });
  const service = router.serviceFor({ projectRoot: tmpDir });
  service.mutate({ reason: "Create completed feature baseline", operations: [
    { action: "create_block", id: "entry", fields: { title: "Entry", kind: "service", architectureLayer: "application", scope: "feature" } },
    { action: "create_chain", id: "boundary-chain", fields: { title: "Boundary", intent: "Entry to newly written handler", inputContract: "input", outputContract: "output" } },
    { action: "set_chain_path", id: "boundary-chain", expectedRevision: 1, fields: { nodeIds: ["entry"], linkIds: [] } },
  ] });
  service.database.prepare("UPDATE blocks SET delivery_state = 'complete', health_state = 'healthy' WHERE id = 'entry'").run();
  service.database.prepare("UPDATE chains SET delivery_state = 'complete', health_state = 'healthy' WHERE id = 'boundary-chain'").run();
  service.mutate({ reason: "Write a new feature Block and route", operations: [
    { action: "create_block", id: "handler", fields: { title: "Handler", kind: "service", architectureLayer: "application", scope: "feature", tags: ["chain:boundary-chain"], deliveryState: "proposed" } },
    { action: "create_link", id: "entry-handler", fields: { sourceType: "block", sourceId: "entry", targetType: "block", targetId: "handler", kind: "calls", contract: "Entry calls Handler" } },
  ] });
  const context = service.contextForTask({ task: "continue the boundary feature", maxChars: 1800 });
  assert.deepEqual(context.chainNetwork.changedChainIds, []);
  const report = context.chainNetwork.reports.find((item) => item.chainId === "boundary-chain");
  assert.ok(report?.candidateBlocks.some((candidate) => candidate.blockId === "handler"));
  assert.deepEqual(service.snapshot().chainNodes.filter((item) => item.chainId === "boundary-chain").sort((a, b) => a.position - b.position).map((item) => item.blockId), ["entry"]);
  assert.deepEqual(service.snapshot().chainEdges.filter((item) => item.chainId === "boundary-chain").map((item) => item.linkId), []);
  assert.equal(service.snapshot().chains.find((item) => item.id === "boundary-chain")?.deliveryState, "complete");
  router.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});
