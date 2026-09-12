import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createService } from "../src/service.mjs";
import { registerProject } from "../src/paths.mjs";
import { analyzeGraphDrift, renderGraphStatus } from "../src/query-engine.mjs";

test("graph drift detection: detects ghost blocks with code and isolated blocks", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-drift-test-"));
  registerProject({ projectRoot: tmpDir, name: "drift-test" });
  const service = createService({ projectRoot: tmpDir });

  try {
    // 1. Create a dummy code file
    const srcDir = path.join(tmpDir, "src");
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, "auth.js"), "export function login() {}\n", "utf8");

    // 2. Create an isolated ghost block that points to existing code
    service.mutate({
      reason: "Create test ghost block",
      operations: [
        {
          action: "create_block",
          id: "ghost-block",
          fields: {
            title: "Ghost Auth Service",
            kind: "service",
            deliveryState: "proposed",
            architectureLayer: "application",
            summary: "Proposed ghost auth service",
          },
        },
      ],
    });

    service.graphPatch({
      patch: `contextos/1 reason="bind source"
source block:ghost-block path="src/auth.js" symbol="login"`,
    });

    // 3. Analyze drift
    const drift = analyzeGraphDrift(service);
    assert.equal(drift.hasDrift, true);
    assert.equal(drift.isolatedBlocks.length, 1);
    assert.equal(drift.isolatedBlocks[0].id, "ghost-block");
    assert.equal(drift.ghostDrifts.length, 1);
    assert.equal(drift.ghostDrifts[0].blockId, "ghost-block");

    // 4. Test renderGraphStatus
    const status = renderGraphStatus(service);
    assert.equal(status.health, "drift_detected");
    assert.ok(status.markdown.includes("Ghost Blocks with Bound Symbols"));
    assert.ok(status.markdown.includes("Isolated Blocks"));

    // 5. Test contextForTask alert
    const ctx = service.contextForTask({ task: "修复 Ghost Auth 模块" });
    assert.deepEqual(ctx.autoReconciliation.advancedBlockIds, ["ghost-block"]);
    assert.ok(ctx.markdown.includes("Drift alerts: 1 isolated block(s)"));
    assert.ok(!ctx.markdown.includes("ghost drift"));
    assert.equal(service.snapshot().blocks.find((block) => block.id === "ghost-block").deliveryState, "implementing");

    // 6. Remediate: connect to a chain and mark implementation anchored (not verified)
    service.mutate({
      reason: "Remediate ghost block and connect to chain",
      operations: [
        {
          action: "create_chain",
          id: "auth-chain",
          fields: { title: "Auth Pipeline", intent: "Handle user authentication" },
        },
        {
          action: "set_chain_path",
          id: "auth-chain",
          expectedRevision: 1,
          fields: { nodeIds: ["ghost-block"] },
        },
      ],
    });

    const remediatedDrift = analyzeGraphDrift(service);
    assert.equal(remediatedDrift.isolatedBlocks.length, 0);
    assert.equal(remediatedDrift.ghostDrifts.length, 0);

    const remediatedStatus = renderGraphStatus(service);
    assert.equal(remediatedStatus.health, "healthy");
    assert.ok(remediatedStatus.markdown.includes("Architecture Health: Clean & Synchronized"));
  } finally {
    service.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("graph drift detection: semantic field changes request related architecture review", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-semantic-drift-"));
  registerProject({ projectRoot: tmpDir, name: "semantic-drift" });
  const service = createService({ projectRoot: tmpDir });
  try {
    service.mutate({
      reason: "create related architecture",
      operations: [
        { action: "create_block", id: "payment", fields: { title: "Payment", kind: "service", contract: "charge(card)" } },
        { action: "create_block", id: "ledger", fields: { title: "Ledger", kind: "service" } },
        { action: "create_link", id: "payment-ledger", fields: { sourceType: "block", sourceId: "payment", targetType: "block", targetId: "ledger", kind: "calls", contract: "charge then record" } },
        { action: "create_plan", id: "pay-plan", fields: { title: "Payments", status: "active" } },
        { action: "set_plan_changes", id: "pay-plan", expectedRevision: 1, fields: { changes: [{ id: "pay-change", entityType: "block", entityId: "payment", title: "Update payment contract", status: "pending" }] } },
      ],
    });
    service.mutate({
      reason: "change payment contract",
      operations: [{ action: "update_block", id: "payment", expectedRevision: 1, fields: { contract: "charge(card, idempotencyKey)" } }],
    });
    const drift = analyzeGraphDrift(service);
    assert.equal(drift.semanticReviews.length > 0, true);
    const review = drift.semanticReviews.find((item) => item.entityId === "payment");
    assert.equal(review.status, "review_required");
    assert.ok(review.fields.includes("contract"));
    assert.ok(review.relatedLinks.includes("link:payment-ledger"));
    assert.ok(review.relatedPlanChanges.includes("plan_change:pay-change"));
    const status = renderGraphStatus(service);
    assert.ok(status.markdown.includes("Semantic reviews required"));
  } finally {
    service.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("creating a block does not emit semantic review noise", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-semantic-create-"));
  registerProject({ projectRoot: tmpDir, name: "semantic-create" });
  const service = createService({ projectRoot: tmpDir });
  try {
    service.mutate({
      reason: "create related architecture without later semantic edits",
      operations: [
        { action: "create_block", id: "payment", fields: { title: "Payment", kind: "service", contract: "charge(card)" } },
        { action: "create_block", id: "ledger", fields: { title: "Ledger", kind: "service" } },
        { action: "create_link", id: "payment-ledger", fields: { sourceType: "block", sourceId: "payment", targetType: "block", targetId: "ledger", kind: "calls", contract: "charge then record" } },
      ],
    });
    const drift = analyzeGraphDrift(service);
    assert.equal((drift.semanticReviews ?? []).some((item) => item.entityId === "payment"), false);
  } finally {
    service.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
