import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { openDatabase, exportGraphToJson, importGraphFromJson } from "../src/database.mjs";
import { ContextOSService } from "../src/service.mjs";

test("storage: exportGraphToJson and importGraphFromJson round-trip", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-test-storage-"));
  const contextosDir = path.join(tmpDir, ".contextos");
  await fs.mkdir(contextosDir, { recursive: true });

  const dbPath = path.join(contextosDir, "contextos.sqlite");
  const jsonPath = path.join(contextosDir, "graph.json");

  const db = openDatabase(dbPath);

  // Insert test project and block
  db.prepare(`
    INSERT INTO projects (id, name, repo_root, graph_revision, schema_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("test-proj", "Test Project", tmpDir, 1, 1, "2026-09-08T00:00:00Z", "2026-09-08T00:00:00Z");

  db.prepare(`
    INSERT INTO blocks (id, project_id, kind, title, summary, body, scope, architecture_layer, local_order, delivery_state, health_state, priority, confidence, tags_json, current_revision, archived, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("block:test-1", "test-proj", "service", "Test Block 1", "Summary 1", "Body 1", "test-scope", "domain", 0, "verifying", "healthy", "normal", "confirmed", "[]", 1, 0, "2026-09-08T00:00:00Z", "2026-09-08T00:00:00Z");

  // Export to graph.json
  const exportResult = exportGraphToJson(db, jsonPath);
  assert.equal(exportResult.jsonPath, jsonPath);
  assert.ok(exportResult.hash);
  assert.equal(exportResult.graphRevision, 1);

  const jsonContent = await fs.readFile(jsonPath, "utf8");
  const parsed = JSON.parse(jsonContent);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.projectId, "test-proj");
  assert.equal(parsed.data.blocks.length, 1);
  assert.equal(parsed.data.blocks[0].id, "block:test-1");

  // Create a second DB and import from graph.json
  const tmpDir2 = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-test-import-"));
  const contextosDir2 = path.join(tmpDir2, ".contextos");
  await fs.mkdir(contextosDir2, { recursive: true });
  const dbPath2 = path.join(contextosDir2, "contextos.sqlite");

  const db2 = openDatabase(dbPath2);
  const importResult = importGraphFromJson(db2, jsonPath);
  assert.equal(importResult.graphRevision, 1);

  const row = db2.prepare("SELECT * FROM blocks WHERE id = ?").get("block:test-1");
  assert.ok(row);
  assert.equal(row.title, "Test Block 1");
  assert.equal(row.summary, "Summary 1");

  db.close();
  db2.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(tmpDir2, { recursive: true, force: true });
});

test("service: ensureSynced detects external graph.json modification", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-test-sync-"));
  const contextosDir = path.join(tmpDir, ".contextos");
  await fs.mkdir(contextosDir, { recursive: true });

  await fs.writeFile(
    path.join(contextosDir, "project.json"),
    JSON.stringify({ id: "sync-test", name: "Sync Test" }, null, 2)
  );

  const service = new ContextOSService({ projectRoot: tmpDir });

  // Mutate graph via service
  service.mutate({
    reason: "Add block",
    operations: [
      {
        action: "create_block",
        id: "block:sync-test",
        fields: {
          title: "Original Name",
          kind: "service",
          deliveryState: "implementing",
          healthState: "healthy",
          summary: "Original summary",
          scope: "test",
          architectureLayer: "domain",
        },
      },
    ],
  });

  const blockBefore = service.entityOpen({ type: "block", id: "block:sync-test" });
  assert.equal(blockBefore.entity.title, "Original Name");

  // Verify graph.json was auto-exported
  const jsonPath = path.join(contextosDir, "graph.json");
  const raw = await fs.readFile(jsonPath, "utf8");
  const graph = JSON.parse(raw);
  assert.equal(graph.data.blocks[0].title, "Original Name");

  // Simulate external edit (e.g. Git Discard, git checkout, or external pull)
  await new Promise((resolve) => setTimeout(resolve, 50));
  graph.data.blocks[0].title = "Externally Modified Name";
  await fs.writeFile(jsonPath, JSON.stringify(graph, null, 2), "utf8");

  // Call ensureSynced
  const synced = service.ensureSynced();
  assert.equal(synced, true);

  // Read block again - should reflect external edit
  const blockAfter = service.entityOpen({ type: "block", id: "block:sync-test" });
  assert.equal(blockAfter.entity.title, "Externally Modified Name");

  service.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("service: revertChangeSet rolls back created entities", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-test-revert-"));
  const contextosDir = path.join(tmpDir, ".contextos");
  await fs.mkdir(contextosDir, { recursive: true });

  await fs.writeFile(
    path.join(contextosDir, "project.json"),
    JSON.stringify({ id: "revert-test", name: "Revert Test" }, null, 2)
  );

  const service = new ContextOSService({ projectRoot: tmpDir });

  const mutationResult = service.mutate({
    reason: "Create temporary block",
    operations: [
      {
        action: "create_block",
        id: "block:temp",
        fields: {
          title: "Temporary Block",
          kind: "service",
          deliveryState: "proposed",
          healthState: "unknown",
          summary: "To be reverted",
          scope: "test",
          architectureLayer: "domain",
        },
      },
    ],
  });

  assert.ok(mutationResult.changeSetId);
  const block = service.entityOpen({ type: "block", id: "block:temp" });
  assert.equal(block.entity.title, "Temporary Block");

  // Revert change set
  const revertResult = service.revertChangeSet({
    changeSetId: mutationResult.changeSetId,
    reason: "Undo temporary block",
  });
  assert.ok(revertResult.changeSetId);

  // Block should now be archived
  const blockAfterRevert = service.entityOpen({ type: "block", id: "block:temp" });
  assert.equal(blockAfterRevert.entity.archived, true);

  service.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("router: serviceFor auto-registers uninitialized project on cold start", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-test-autoreg-"));
  // Note: NO .contextos directory created!
  const { ProjectServiceRouter } = await import("../src/project-router.mjs");
  const router = new ProjectServiceRouter();

  // serviceFor should automatically create .contextos/project.json and initialize
  const service = router.serviceFor({ projectRoot: tmpDir });
  assert.ok(service);

  // Check project.json was created
  const projectJson = JSON.parse(await fs.readFile(path.join(tmpDir, ".contextos", "project.json"), "utf8"));
  assert.ok(projectJson.id);
  assert.ok(projectJson.name);

  // Check graph.json was created
  assert.ok(await fs.stat(path.join(tmpDir, ".contextos", "graph.json")));

  // Check context_for_task runs smoothly
  const context = service.contextForTask({ task: "Initial development" });
  assert.ok(context.markdown.includes("# Task Context"));

  router.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

