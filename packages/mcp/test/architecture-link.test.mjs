import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ProjectServiceRouter } from "../src/project-router.mjs";
import { suggestLinksForBlock, connectBlocks } from "../src/architecture-link.mjs";

test("architecture-link: suggestLinksForBlock with code imports and layer conventions", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-arch-test-"));
  const router = new ProjectServiceRouter();
  router.register({ projectRoot: tmpDir, name: "arch-test" });
  const service = router.serviceFor({ projectRoot: tmpDir });

  // Create two source files where one imports the other
  const srcDir = path.join(tmpDir, "src");
  await fs.mkdir(srcDir, { recursive: true });
  await fs.writeFile(path.join(srcDir, "db.js"), "export function query() { return 42; }\nexport function unused() { return 0; }");
  await fs.writeFile(path.join(srcDir, "service.js"), "import { query } from './db.js';\nexport function run() { return query(); }");

  // Create blocks with source refs
  service.mutate({
    reason: "Create blocks with source refs",
    operations: [
      {
        action: "create_block",
        id: "svc-block",
        fields: {
          title: "Service Block",
          kind: "service",
          architectureLayer: "application",
          scope: "core",
        },
      },
      {
        action: "add_source_ref",
        id: "svc-block",
        expectedRevision: 1,
        fields: {
          path: "src/service.js",
          symbol: "run",
          role: "declaration",
        },
      },
      {
        action: "create_block",
        id: "db-block",
        fields: {
          title: "Database Block",
          kind: "database",
          architectureLayer: "data",
          scope: "core",
        },
      },
      {
        action: "add_source_ref",
        id: "db-block",
        expectedRevision: 1,
        fields: {
          path: "src/db.js",
          symbol: "query",
          role: "declaration",
        },
      },
      {
        action: "create_block",
        id: "unused-block",
        fields: {
          title: "Unused Database Export",
          kind: "database",
          architectureLayer: "data",
          scope: "core",
        },
      },
      {
        action: "add_source_ref",
        id: "unused-block",
        expectedRevision: 1,
        fields: {
          path: "src/db.js",
          symbol: "unused",
          role: "declaration",
        },
      },
    ],
  });

  // Suggest links for svc-block
  const suggestions = suggestLinksForBlock(service, "svc-block");
  assert.ok(suggestions.length > 0);
  const targetSuggestion = suggestions.find((s) => s.targetId === "db-block");
  assert.ok(targetSuggestion, "Expected link suggestion to db-block");
  assert.equal(targetSuggestion.confidence, "high");
  assert.equal(targetSuggestion.kind, "reads");
  assert.equal(suggestions.some((item) => item.targetId === "unused-block"), false, "Unused exports must not become Block links");

  // Connect blocks
  const connectRes = connectBlocks(service, {
    sourceId: "svc-block",
    targetId: "db-block",
    kind: targetSuggestion.kind,
  });
  assert.ok(connectRes.changeSetId);

  const snap = service.snapshot();
  assert.equal(snap.links.length, 1);
  assert.equal(snap.links[0].sourceId, "svc-block");
  assert.equal(snap.links[0].targetId, "db-block");

  router.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});
