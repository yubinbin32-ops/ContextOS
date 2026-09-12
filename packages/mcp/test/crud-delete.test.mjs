import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ContextOSService } from "../src/service.mjs";

test("crud: delete_block, delete_chain, delete_link, delete_decision, delete_plan, delete_checkpoint", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-test-crud-"));
  const contextosDir = path.join(tmpDir, ".contextos");
  await fs.mkdir(contextosDir, { recursive: true });
  await fs.writeFile(
    path.join(contextosDir, "project.json"),
    JSON.stringify({ id: "crud-test", name: "CRUD Test Project" }, null, 2),
  );

  const service = new ContextOSService({ projectRoot: tmpDir });

  // 1. Create entities: 2 blocks, 1 link, 1 chain, 1 decision, 1 plan, 1 checkpoint
  service.mutate({
    reason: "Create test fixtures",
    operations: [
      {
        action: "create_block",
        id: "block:alpha",
        fields: {
          title: "Block Alpha",
          kind: "service",
          deliveryState: "implementing",
          healthState: "healthy",
          architectureLayer: "domain",
        },
      },
      {
        action: "create_block",
        id: "block:beta",
        fields: {
          title: "Block Beta",
          kind: "service",
          deliveryState: "implementing",
          healthState: "healthy",
          architectureLayer: "application",
        },
      },
      {
        action: "create_link",
        id: "link:alpha-beta",
        fields: {
          kind: "calls",
          sourceType: "block",
          sourceId: "block:alpha",
          targetType: "block",
          targetId: "block:beta",
        },
      },
      {
        action: "create_chain",
        id: "chain:main-flow",
        fields: {
          title: "Main Flow",
          deliveryState: "implementing",
        },
      },
      {
        action: "set_chain_path",
        id: "chain:main-flow",
        expectedRevision: 1,
        fields: {
          nodeIds: ["block:alpha", "block:beta"],
          linkIds: ["link:alpha-beta"],
        },
      },
      {
        action: "create_decision",
        id: "decision:arch-01",
        fields: {
          title: "Architecture Decision 01",
          summary: "Use modular monolith",
          status: "active",
        },
      },
      {
        action: "create_checkpoint",
        id: "cp:alpha",
        fields: {
          targetType: "block",
          targetId: "block:alpha",
          title: "Verify Alpha",
          criteria: "Alpha works",
          status: "passed",
        },
      },
      {
        action: "create_plan",
        id: "plan:phase-1",
        fields: {
          title: "Phase 1 Plan",
          status: "active",
        },
      },
    ],
  });

  const snapshotBefore = service.snapshot();
  assert.equal(snapshotBefore.blocks.length, 2);
  assert.equal(snapshotBefore.links.length, 1);
  assert.equal(snapshotBefore.chains.length, 1);
  assert.equal(snapshotBefore.decisions.length, 1);
  assert.equal(snapshotBefore.plans.length, 1);
  assert.equal(snapshotBefore.checkpoints.length, 1);

  // Test delete_link
  service.mutate({
    reason: "Delete link",
    operations: [
      {
        action: "delete_link",
        id: "link:alpha-beta",
      },
    ],
  });
  assert.equal(service.snapshot().links.length, 0);
  assert.equal(service.snapshot().blocks.length, 2);

  // Test delete_chain
  service.mutate({
    reason: "Delete chain",
    operations: [
      {
        action: "delete_chain",
        id: "chain:main-flow",
      },
    ],
  });
  assert.equal(service.snapshot().chains.length, 0);

  // Test delete_checkpoint
  service.mutate({
    reason: "Delete checkpoint",
    operations: [
      {
        action: "delete_checkpoint",
        id: "cp:alpha",
      },
    ],
  });
  assert.equal(service.snapshot().checkpoints.length, 0);

  // Test delete_decision
  service.mutate({
    reason: "Delete decision",
    operations: [
      {
        action: "delete_decision",
        id: "decision:arch-01",
      },
    ],
  });
  assert.equal(service.snapshot().decisions.length, 0);

  // Test delete_plan
  service.mutate({
    reason: "Delete plan",
    operations: [
      {
        action: "delete_plan",
        id: "plan:phase-1",
      },
    ],
  });
  assert.equal(service.snapshot().plans.length, 0);

  // Test delete_block
  service.mutate({
    reason: "Delete block alpha",
    operations: [
      {
        action: "delete_block",
        id: "block:alpha",
      },
    ],
  });
  assert.equal(service.snapshot().blocks.length, 1);
  assert.equal(service.snapshot().blocks[0].id, "block:beta");

  // Test compact patch delete syntax
  service.graphPatch({
    patch: `contextos/1 reason="Delete beta via compact patch"
delete block:block:beta
`,
  });
  assert.equal(service.snapshot().blocks.length, 0);

  await fs.rm(tmpDir, { recursive: true, force: true });
});
