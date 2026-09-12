import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ContextOSService } from "../src/service.mjs";

test("passed checkpoints become retest_required when bound source changes", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-test-checkpoint-freshness-"));
  await fs.mkdir(path.join(tmpDir, ".contextos"), { recursive: true });
  await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, ".contextos", "project.json"),
    JSON.stringify({
      schemaVersion: "2.0.0",
      id: "checkpoint-freshness-test",
      name: "Checkpoint Freshness Test",
      defaultLocale: "en",
      supportedLocales: ["en"],
    }),
  );
  const sourcePath = path.join(tmpDir, "src", "service.ts");
  await fs.writeFile(sourcePath, "export function service() { return true; }\n");

  const service = new ContextOSService({ projectRoot: tmpDir, autoSync: true });
  service.mutate({
    reason: "create source-bound block",
    operations: [
      {
        action: "create_block",
        id: "source-bound-service",
        fields: {
          title: "Source-bound service",
          kind: "service",
          architectureLayer: "application",
          deliveryState: "implementing",
        },
      },
      {
        action: "add_source_ref",
        id: "source-bound-service",
        fields: { path: "src/service.ts:service" },
      },
    ],
  });
  service.recordCheckpoint({
    id: "source-bound-checkpoint",
    targetType: "block",
    targetId: "source-bound-service",
    title: "source verification",
    status: "passed",
    evidenceLevel: "integration",
    requiredEvidenceLevel: "integration",
    evidence: [{ kind: "test", command: "node --test" }],
  });

  let checkpoint = service.snapshot().checkpoints.find((item) => item.id === "source-bound-checkpoint");
  assert.equal(checkpoint.freshness.status, "fresh");
  assert.equal(checkpoint.status, "passed");

  await fs.appendFile(sourcePath, "export const changed = true;\n");
  checkpoint = service.snapshot().checkpoints.find((item) => item.id === "source-bound-checkpoint");
  assert.equal(checkpoint.freshness.status, "stale");
  assert.equal(checkpoint.status, "retest_required");
  assert.equal(service.validate().errors.some((error) => error.includes("require retest")), true);

  service.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});
