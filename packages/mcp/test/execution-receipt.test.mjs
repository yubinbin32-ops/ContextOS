import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ContextOSService } from "../src/service.mjs";

async function makeProject() {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-exec-receipt-"));
  await fs.mkdir(path.join(projectRoot, ".contextos"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, ".contextos", "project.json"), JSON.stringify({
    schemaVersion: "2.0.0",
    id: "execution-receipt-test",
    name: "Execution Receipt Test",
    defaultLocale: "en",
    supportedLocales: ["en"],
  }));
  return projectRoot;
}

test("runCommand persists a compact execution receipt and checkpoints can cite it", async () => {
  const projectRoot = await makeProject();
  const service = new ContextOSService({ projectRoot });
  try {
    service.mutate({
      reason: "create receipt test block",
      operations: [{
        action: "create_block",
        id: "receipt-block",
        fields: { title: "Receipt Block", kind: "service", deliveryState: "implementing" },
      }],
    });
    const execution = service.runCommand({
      command: 'printf "tests 2 passed 2 failed 0\\n"',
      executionKind: "test",
      maxChars: 200,
    });
    assert.match(execution.executionId, /^exec_/);
    assert.equal(execution.success, true);
    assert.equal(execution.executionKind, "test");
    assert.equal(execution.testSummary.passed, 2);

    const stored = service.database.prepare("SELECT * FROM execution_receipts WHERE id = ?").get(execution.executionId);
    assert.equal(stored.status, "passed");
    assert.equal(stored.exit_code, 0);
    assert.equal(stored.project_id, "execution-receipt-test");

    const checkpoint = service.recordCheckpoint({
      id: "receipt-checkpoint",
      targetType: "block",
      targetId: "receipt-block",
      title: "receipt-backed verification",
      status: "passed",
      requiredEvidenceLevel: "integration",
      evidenceExecutionIds: [execution.executionId],
    });
    assert.deepEqual(checkpoint.checkpoint.executionIds, [execution.executionId]);
    const evidence = service.database.prepare("SELECT evidence_json FROM checkpoints WHERE id = ?").get("receipt-checkpoint");
    assert.equal(JSON.parse(evidence.evidence_json).some((item) => item.kind === "execution_receipt"), true);
  } finally {
    service.close();
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("failed execution receipts cannot produce passed checkpoints", async () => {
  const projectRoot = await makeProject();
  const service = new ContextOSService({ projectRoot });
  try {
    service.mutate({
      reason: "create failed receipt test block",
      operations: [{
        action: "create_block",
        id: "failed-receipt-block",
        fields: { title: "Failed Receipt Block", kind: "service" },
      }],
    });
    const execution = service.runCommand({ command: "exit 3", maxChars: 200 });
    assert.equal(execution.success, false);
    assert.throws(() => service.recordCheckpoint({
      targetType: "block",
      targetId: "failed-receipt-block",
      title: "should fail",
      status: "passed",
      requiredEvidenceLevel: "integration",
      evidenceExecutionIds: [execution.executionId],
    }), /failed execution receipt/);
  } finally {
    service.close();
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});
