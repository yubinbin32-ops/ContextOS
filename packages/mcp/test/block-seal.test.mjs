import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ContextOSService } from "../src/service.mjs";

async function project() {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-block-seal-"));
  await fs.mkdir(path.join(projectRoot, ".contextos"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, ".contextos", "project.json"), JSON.stringify({
    schemaVersion: "2.0.0",
    id: "block-seal-test",
    name: "Block Seal Test",
    defaultLocale: "en",
    supportedLocales: ["en"],
  }));
  await fs.writeFile(path.join(projectRoot, "src", "service.ts"), "export function verifiedService() { return true; }\n");
  return projectRoot;
}

test("block seal requires current bindings and receipt-backed checkpoint, then is idempotent", async () => {
  const projectRoot = await project();
  const service = new ContextOSService({ projectRoot });
  try {
    service.mutate({
      reason: "create sealable block",
      operations: [{
        action: "create_block",
        id: "sealable-service",
        fields: { title: "Verified service", kind: "service", deliveryState: "implementing" },
      }],
    });
    assert.throws(() => service.sealBlock({ blockId: "sealable-service" }), /no SourceBinding/);

    service.acceptSourceBindings({
      blockId: "sealable-service",
      bindings: [{ path: "src/service.ts", symbol: "verifiedService", role: "implementation" }],
    });
    assert.throws(() => service.sealBlock({ blockId: "sealable-service" }), /passed Checkpoint/);

    const execution = service.runCommand({ command: "node --check src/service.ts", executionKind: "test" });
    const checkpoint = service.recordCheckpoint({
      id: "seal-checkpoint",
      targetType: "block",
      targetId: "sealable-service",
      title: "verified service check",
      status: "passed",
      requiredEvidenceLevel: "integration",
      evidenceExecutionIds: [execution.executionId],
    });
    const sealed = service.sealBlock({
      blockId: "sealable-service",
      checkpointId: checkpoint.checkpoint.id,
      executionId: execution.executionId,
    });
    assert.equal(sealed.changed, true);
    assert.equal(service.snapshot().blocks.find((item) => item.id === "sealable-service").deliveryState, "complete");

    const repeated = service.sealBlock({
      blockId: "sealable-service",
      checkpointId: checkpoint.checkpoint.id,
      executionId: execution.executionId,
    });
    assert.equal(repeated.changed, false);
    assert.equal(repeated.idempotent, true);
  } finally {
    service.close();
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("block seal rejects stale checkpoints and failed execution receipts", async () => {
  const projectRoot = await project();
  const service = new ContextOSService({ projectRoot });
  try {
    service.mutate({
      reason: "create stale seal block",
      operations: [
        { action: "create_block", id: "stale-service", fields: { title: "Stale service", kind: "service", deliveryState: "verifying" } },
        { action: "add_source_ref", id: "stale-service", fields: { path: "src/service.ts", symbol: "verifiedService" } },
      ],
    });
    const passed = service.runCommand({ command: "true", executionKind: "test" });
    service.recordCheckpoint({
      id: "stale-checkpoint",
      targetType: "block",
      targetId: "stale-service",
      title: "initial verification",
      status: "passed",
      requiredEvidenceLevel: "integration",
      evidenceExecutionIds: [passed.executionId],
    });
    await fs.writeFile(path.join(projectRoot, "src", "service.ts"), "export function verifiedService() { return false; }\n");
    assert.throws(() => service.sealBlock({ blockId: "stale-service", checkpointId: "stale-checkpoint" }), /must be passed|must be fresh/);

    const failed = service.runCommand({ command: "exit 2" });
    assert.throws(() => service.sealBlock({ blockId: "stale-service", executionId: failed.executionId }), /passed Checkpoint|successful/);
  } finally {
    service.close();
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});
