import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ProjectServiceRouter } from "../src/project-router.mjs";
import { parseFlowExpression, applyArrowFlow } from "../src/flow.mjs";

test("flow: parseFlowExpression parses basic and annotated arrows", () => {
  const res1 = parseFlowExpression("block:A -> block:B -> block:C");
  assert.deepEqual(res1.nodes, ["block:A", "block:B", "block:C"]);
  assert.equal(res1.edgeSpecs.length, 2);
  assert.equal(res1.edgeSpecs[0].kind, "flows_to");
  assert.equal(res1.edgeSpecs[1].kind, "flows_to");

  const res2 = parseFlowExpression("Reader -[calls]-> Analyzer -[reads:config]-> Database");
  assert.deepEqual(res2.nodes, ["Reader", "Analyzer", "Database"]);
  assert.equal(res2.edgeSpecs[0].kind, "calls");
  assert.equal(res2.edgeSpecs[0].label, "");
  assert.equal(res2.edgeSpecs[1].kind, "reads");
  assert.equal(res2.edgeSpecs[1].label, "config");
});

test("flow: applyArrowFlow and architecture connections", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-flow-test-"));
  const router = new ProjectServiceRouter();
  router.register({ projectRoot: tmpDir, name: "flow-test" });
  const service = router.serviceFor({ projectRoot: tmpDir });

  // Create blocks
  service.mutate({
    reason: "Create architecture pipeline blocks",
    operations: [
      {
        action: "create_block",
        id: "img-reader",
        fields: {
          title: "Image Reader",
          kind: "service",
          architectureLayer: "client",
          scope: "image",
        },
      },
      {
        action: "create_block",
        id: "img-analyzer",
        fields: {
          title: "Image Analyzer",
          kind: "service",
          architectureLayer: "application",
          scope: "image",
        },
      },
      {
        action: "create_block",
        id: "img-storage",
        fields: {
          title: "Image Storage",
          kind: "database",
          architectureLayer: "data",
          scope: "image",
        },
      },
    ],
  });

  // Apply arrow flow
  const result = service.applyArrowFlow("Image Reader -> Image Analyzer -[writes:binary]-> Image Storage");
  assert.equal(result.links.length, 2);
  assert.equal(result.links[0].sourceId, "img-reader");
  assert.equal(result.links[0].targetId, "img-analyzer");
  assert.equal(result.links[0].kind, "flows_to");

  assert.equal(result.links[1].sourceId, "img-analyzer");
  assert.equal(result.links[1].targetId, "img-storage");
  assert.equal(result.links[1].kind, "writes");

  // Verify links in snapshot
  const snap = service.snapshot();
  assert.equal(snap.links.length, 2);

  // Connect blocks directly via architecture connect
  service.connectBlocks({
    sourceId: "img-reader",
    targetId: "img-storage",
    kind: "reads",
    label: "fast-path",
  });

  const snap2 = service.snapshot();
  assert.equal(snap2.links.length, 3);
  const fastPathLink = snap2.links.find((l) => l.sourceId === "img-reader" && l.targetId === "img-storage");
  assert.ok(fastPathLink);
  assert.equal(fastPathLink.kind, "reads");
  assert.equal(fastPathLink.label, "fast-path");

  router.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("flow: graphPatch supports inline flow directives with newly created blocks", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-patch-flow-test-"));
  const router = new ProjectServiceRouter();
  router.register({ projectRoot: tmpDir, name: "patch-flow-test" });
  const service = router.serviceFor({ projectRoot: tmpDir });

  // Initial block
  service.mutate({
    reason: "Create entry block",
    operations: [
      {
        action: "create_block",
        id: "gateway",
        fields: { title: "API Gateway", kind: "service", architectureLayer: "boundary", scope: "api" },
      },
    ],
  });

  // Patch creating a new block AND connecting it via flow: in the same patch
  const patchText = [
    "contextos/1 reason=\"Add auth and connect to gateway\"",
    "create block:auth-service title=\"Auth Service\" kind=service",
    "flow: gateway -[calls]-> auth-service",
  ].join("\n");

  const result = service.graphPatch({ patch: patchText });
  assert.ok(result.changeSetId);

  const snapshot = service.snapshot();
  assert.equal(snapshot.blocks.length, 2);
  const link = snapshot.links.find((l) => l.sourceId === "gateway" && l.targetId === "auth-service");
  assert.ok(link, "Expected link to be created from inline flow directive");
  assert.equal(link.kind, "calls");

  router.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

