import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ProjectServiceRouter } from "../src/project-router.mjs";

async function compositionFixture() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-composition-test-"));
  const router = new ProjectServiceRouter();
  router.register({ projectRoot: tmpDir, name: "composition-test" });
  const service = router.serviceFor({ projectRoot: tmpDir });
  service.mutate({ reason: "Create Composite Chain fixture", operations: [
    ...["a", "b", "c", "d", "macro-note"].map((id) => ({
      action: "create_block",
      id,
      fields: { title: id.toUpperCase(), kind: "product", architectureLayer: "application", scope: "core", deliveryState: "complete" },
    })),
    { action: "create_link", id: "a-b", fields: { sourceType: "block", sourceId: "a", targetType: "block", targetId: "b", kind: "calls", contract: "A -> B" } },
    { action: "create_link", id: "c-d", fields: { sourceType: "block", sourceId: "c", targetType: "block", targetId: "d", kind: "calls", contract: "C -> D" } },
    { action: "create_chain", id: "stage-a", fields: { title: "Stage A", intent: "A implementation", deliveryState: "planned" } },
    { action: "create_chain", id: "stage-b", fields: { title: "Stage B", intent: "B implementation", deliveryState: "planned" } },
    { action: "create_chain", id: "macro", fields: { title: "Macro route", chainType: "composite", intent: "A/B then C/D", deliveryState: "planned" } },
  ] });
  service.mutate({ reason: "Set child Chain paths", operations: [
    { action: "set_chain_path", id: "stage-a", expectedRevision: 1, fields: { nodeIds: ["a", "b"], linkIds: ["a-b"] } },
    { action: "set_chain_path", id: "stage-b", expectedRevision: 1, fields: { nodeIds: ["c", "d"], linkIds: ["c-d"] } },
  ] });
  service.mutate({ reason: "Complete child Chain fixture", operations: [
    { action: "update_chain", id: "stage-a", expectedRevision: 2, fields: { deliveryState: "complete" } },
    { action: "update_chain", id: "stage-b", expectedRevision: 2, fields: { deliveryState: "complete" } },
  ] });
  service.mutate({ reason: "Create macro route links", operations: [
    { action: "create_link", id: "stage-a-b", fields: { sourceType: "chain", sourceId: "stage-a", targetType: "chain", targetId: "stage-b", kind: "flows_to", contract: "Stage A -> Stage B" } },
    { action: "create_link", id: "stage-b-note", fields: { sourceType: "chain", sourceId: "stage-b", targetType: "block", targetId: "macro-note", kind: "flows_to", contract: "Stage B -> note" } },
  ] });
  return { tmpDir, router, service };
}

test("Composite Chain keeps macro members separate from child Block paths", async () => {
  const { tmpDir, router, service } = await compositionFixture();
  try {
    const result = service.setChainComposition({
      chainId: "macro",
      expectedRevision: 1,
      memberRefs: [
        { memberType: "chain", memberId: "stage-a", role: "prepare" },
        { memberType: "chain", memberId: "stage-b", role: "deliver", required: false },
      ],
      linkIds: ["stage-a-b"],
    });
    assert.equal(result.receipts[0].action, "composition-set");
    const snapshot = service.snapshot();
    assert.deepEqual(snapshot.chainMembers.filter((item) => item.chainId === "macro").map((item) => `${item.memberType}:${item.memberId}`), ["chain:stage-a", "chain:stage-b"]);
    assert.equal(snapshot.chainNodes.some((item) => item.chainId === "macro"), false);

    const stream = service.chainCodeStream({ chainId: "macro" });
    assert.equal(stream.chainType, "composite");
    assert.match(stream.codeStream, /2 macro stage/);
    assert.match(stream.codeStream, /Child Chain: 2 path Block\(s\)/);
    assert.match(stream.codeStream, /stage-a -\[flows_to\]-> chain:stage-b/);

    const appended = service.appendChainComposition({
      chainId: "macro",
      expectedRevision: 2,
      memberRefs: [{ memberType: "block", memberId: "macro-note", role: "note", required: false }],
      linkIds: ["stage-b-note"],
    });
    assert.equal(appended.receipts[0].action, "composition-appended");
    assert.deepEqual(service.snapshot().chainMembers.filter((item) => item.chainId === "macro").map((item) => `${item.memberType}:${item.memberId}`), ["chain:stage-a", "chain:stage-b", "block:macro-note"]);

    const opened = service.openEntity({ type: "chain", id: "macro" });
    assert.equal(opened.entity.chainType, "composite");
    assert.deepEqual(opened.composition.members.map((item) => item.memberId), ["stage-a", "stage-b", "macro-note"]);
    const replaced = service.setChainComposition({
      chainId: "macro",
      expectedRevision: 3,
      memberRefs: ["chain:stage-a", "chain:stage-b"],
      linkIds: ["stage-a-b"],
      removeBlockIds: ["macro-note"],
    });
    assert.deepEqual(replaced.receipts[0].removedBlockIds, ["macro-note"]);
    assert.equal(service.snapshot().blocks.some((item) => item.id === "macro-note"), false);
    assert.deepEqual(service.snapshot().chainMembers.filter((item) => item.chainId === "macro").map((item) => item.memberId), ["stage-a", "stage-b"]);
    assert.equal(service.snapshot().links.some((item) => item.id === "stage-b-note"), false);
    assert.equal(service.validate().errors.some((error) => error.includes("Composite Chain topology")), false);
    router.close();
    const reopenedRouter = new ProjectServiceRouter();
    const reopened = reopenedRouter.serviceFor({ projectRoot: tmpDir });
    assert.deepEqual(reopened.snapshot().chainMembers.filter((item) => item.chainId === "macro").map((item) => item.memberId), ["stage-a", "stage-b"]);
    reopenedRouter.close();
  } finally {
    router.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Composite Chain rejects backward routes and reopens when a required child is incomplete", async () => {
  const { tmpDir, router, service } = await compositionFixture();
  try {
    service.setChainComposition({
      chainId: "macro",
      expectedRevision: 1,
      memberRefs: ["chain:stage-a", "chain:stage-b"],
      linkIds: ["stage-a-b"],
    });
    service.mutate({ reason: "Add reverse macro link", operations: [
      { action: "create_link", id: "stage-b-a", fields: { sourceType: "chain", sourceId: "stage-b", targetType: "chain", targetId: "stage-a", kind: "flows_to", contract: "Stage B -> Stage A" } },
    ] });
    assert.throws(
      () => service.setChainComposition({ chainId: "macro", expectedRevision: 2, memberRefs: ["chain:stage-a", "chain:stage-b"], linkIds: ["stage-a-b", "stage-b-a"] }),
      /backward|cycle|invalid/i,
    );

    service.database.prepare("UPDATE chains SET delivery_state = 'complete' WHERE id = 'macro'").run();
    service.database.prepare("UPDATE chains SET delivery_state = 'planned' WHERE id = 'stage-b'").run();
    const report = service.reconcileChainNetwork({ chainId: "macro", autoExpand: false });
    assert.ok(report.reports.some((item) => item.issues.some((issue) => issue.code === "incomplete_member")));
    const macro = service.snapshot().chains.find((item) => item.id === "macro");
    assert.equal(macro.deliveryState, "implementing");
    assert.equal(macro.healthState, "warning");
  } finally {
    router.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
