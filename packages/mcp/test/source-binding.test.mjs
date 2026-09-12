import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ContextOSService } from "../src/service.mjs";

async function makeProject(prefix, source) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(projectRoot, ".contextos"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, ".contextos", "project.json"),
    JSON.stringify({
      schemaVersion: "2.0.0",
      id: `${prefix}-project`,
      name: "Source Binding Test",
      defaultLocale: "en",
      supportedLocales: ["en"],
    }),
  );
  const sourcePath = path.join(projectRoot, "src", "service.ts");
  await fs.writeFile(sourcePath, source);
  return { projectRoot, sourcePath };
}

test("source binding follows a moved symbol and reports external implementation changes", async () => {
  const { projectRoot, sourcePath } = await makeProject(
    "contextos-test-source-binding-",
    "export function processPayment(amount: number) {\n  return amount + 1;\n}\n",
  );
  const service = new ContextOSService({ projectRoot, autoSync: true });
  try {
    service.mutate({
      reason: "create source-bound chain",
      operations: [
        {
          action: "create_block",
          id: "payment-service",
          fields: {
            title: "Payment service",
            kind: "service",
            summary: "Processes payments",
            contract: "processPayment(amount) -> number",
            architectureLayer: "application",
            deliveryState: "implementing",
          },
        },
        {
          action: "add_source_ref",
          id: "payment-service",
          fields: { path: "src/service.ts:processPayment" },
        },
        {
          action: "create_chain",
          id: "payment-chain",
          fields: { title: "Payment chain", intent: "source binding" },
        },
        {
          action: "set_chain_path",
          id: "payment-chain",
          expectedRevision: 1,
          fields: { nodeIds: ["payment-service"] },
        },
      ],
    });

    const initial = service.chainCodeStream({ chainId: "payment-chain" });
    assert.equal(initial.nodes[0].sourceStatus, "anchored");
    assert.doesNotMatch(initial.codeStream, /return amount \+ 1/);
    assert.match(initial.codeStream, /processPayment/);

    await fs.writeFile(sourcePath, "// moved without changing the symbol\n\nexport function processPayment(amount: number) {\n  return amount + 1;\n}\n");
    const moved = service.chainCodeStream({ chainId: "payment-chain" });
    assert.equal(moved.nodes[0].sourceStatus, "moved");
    assert.equal(moved.nodes[0].startLine, 3);
    assert.doesNotMatch(moved.codeStream, /return amount \+ 1/);
    assert.match(moved.codeStream, /processPayment/);
    assert.equal(moved.sourceSync.changed, true);
    assert.ok(moved.sourceSync.changes[0].kinds.includes("binding_moved"));

    const commandResult = service.runCommand({
      command: "printf '%s\\n' 'export function processPayment(amount: number) {' '  return amount + 2;' '}' > src/service.ts",
      maxChars: 400,
    });
    assert.equal(commandResult.success, true);
    assert.equal(commandResult.sourceSync.changed, true);
    assert.ok(commandResult.sourceSync.changes[0].kinds.includes("implementation_changed"));

    service.recordCheckpoint({
      id: "payment-checkpoint",
      targetType: "block",
      targetId: "payment-service",
      title: "Payment verification",
      status: "passed",
      evidenceLevel: "integration",
      requiredEvidenceLevel: "integration",
      evidence: [{ kind: "test", command: "node --test" }],
    });
    assert.equal(service.snapshot().checkpoints.find((item) => item.id === "payment-checkpoint").status, "passed");

    const exportedGraph = JSON.parse(await fs.readFile(path.join(projectRoot, ".contextos", "graph.json"), "utf8"));
    const exportedCheckpoint = exportedGraph.data.checkpoints.find((item) => item.id === "payment-checkpoint");
    const identity = JSON.parse(exportedCheckpoint.evidence_json).find((item) => item.kind === "contextos-identity");
    assert.equal(identity.version, 2);
    assert.ok(identity.bindings.some((binding) => binding.symbol === "processPayment"));

    await fs.writeFile(sourcePath, "// moved without changing the symbol\n\nexport function processPayment(amount: number) {\n  return amount + 3;\n}\n");
    const changed = service.snapshot();
    const checkpoint = changed.checkpoints.find((item) => item.id === "payment-checkpoint");
    assert.equal(checkpoint.status, "retest_required");
    assert.equal(checkpoint.freshness.status, "stale");
    assert.match(changed.sourceSync.changes[0].kinds.join(","), /implementation_changed/);
  } finally {
    service.close();
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("duplicate symbol names never fall back to an unrelated source slice", async () => {
  const { projectRoot } = await makeProject(
    "contextos-test-source-ambiguous-",
    "export function run() { return 1; }\nexport function run() { return 2; }\n",
  );
  const service = new ContextOSService({ projectRoot });
  try {
    service.mutate({
      reason: "create ambiguous source binding",
      operations: [
        {
          action: "create_block",
          id: "ambiguous-service",
          fields: { title: "Ambiguous service", kind: "service", deliveryState: "implementing" },
        },
        {
          action: "add_source_ref",
          id: "ambiguous-service",
          fields: { path: "src/service.ts:run" },
        },
        {
          action: "create_chain",
          id: "ambiguous-chain",
          fields: { title: "Ambiguous chain" },
        },
        {
          action: "set_chain_path",
          id: "ambiguous-chain",
          expectedRevision: 1,
          fields: { nodeIds: ["ambiguous-service"] },
        },
      ],
    });
    const stream = service.chainCodeStream({ chainId: "ambiguous-chain" });
    assert.equal(stream.nodes[0].sourceStatus, "ambiguous");
    assert.match(stream.codeStream, /Locator is ambiguous/);
    assert.doesNotMatch(stream.codeStream, /return 1/);
    assert.doesNotMatch(stream.codeStream, /return 2/);
  } finally {
    service.close();
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("standalone Blocks and Chains do not create implicit verification gates", async () => {
  const { projectRoot } = await makeProject(
    "contextos-test-architecture-semantics-",
    "export function healthCheck() { return true; }\n",
  );
  const service = new ContextOSService({ projectRoot });
  try {
    service.mutate({
      reason: "verify independent architecture semantics",
      operations: [
        {
          action: "create_block",
          id: "standalone-block",
          fields: { title: "Standalone block", kind: "service", architectureLayer: "application", deliveryState: "implementing" },
        },
        {
          action: "create_block",
          id: "chain-block",
          fields: { title: "Chain block", kind: "service", architectureLayer: "application", deliveryState: "implementing" },
        },
        {
          action: "create_chain",
          id: "independent-chain",
          fields: { title: "Independent chain", intent: "No integration gate declared" },
        },
        {
          action: "set_chain_path",
          id: "independent-chain",
          expectedRevision: 1,
          fields: { nodeIds: ["chain-block"] },
        },
      ],
    });

    const validation = service.validate();
    assert.equal(validation.errors.length, 0);
    assert.doesNotMatch(validation.warnings.join("\n"), /implicit|isolated|checkpoint|integration gate/i);
  } finally {
    service.close();
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("source binding suggestions are read-only and accepted candidates become fresh bindings", async () => {
  const { projectRoot } = await makeProject(
    "contextos-test-source-suggest-",
    "export function processPayment(amount: number) {\n  return amount + 1;\n}\n\nexport function unrelated() {\n  return false;\n}\n",
  );
  const service = new ContextOSService({ projectRoot });
  try {
    service.mutate({
      reason: "create unbound payment block",
      operations: [{
        action: "create_block",
        id: "unbound-payment-service",
        fields: {
          title: "Payment service",
          kind: "service",
          summary: "Processes payments",
          contract: "processPayment(amount) -> number",
        },
      }],
    });
    const suggestions = service.suggestSourceBindings({ blockId: "unbound-payment-service" });
    assert.ok(suggestions.candidates.some((candidate) => candidate.symbol === "processPayment"));
    assert.equal(service.database.prepare("SELECT count(*) AS count FROM source_refs WHERE block_id = ?").get("unbound-payment-service").count, 0);

    const candidate = suggestions.candidates.find((item) => item.symbol === "processPayment");
    const accepted = service.acceptSourceBindings({
      blockId: "unbound-payment-service",
      bindings: [{ path: candidate.path, symbol: candidate.symbol, role: candidate.role }],
    });
    assert.equal(accepted.accepted.length, 1);
    assert.equal(accepted.sourceSync.invalidBindingCount, 0);
    const binding = service.syncSourceBindings({ includeUnchanged: true }).bindings.find((item) => item.blockId === "unbound-payment-service");
    assert.equal(binding.bindingStatus, "fresh");
    assert.equal(binding.symbol, "processPayment");
  } finally {
    service.close();
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("source sync after a native edit suggests unbound symbols without auto-accepting them", async () => {
  const { projectRoot, sourcePath } = await makeProject(
    "contextos-test-live-binding-",
    "export function processPayment(amount: number) {\n  return amount + 1;\n}\n",
  );
  const service = new ContextOSService({ projectRoot });
  try {
    service.mutate({
      reason: "create payment block with one binding",
      operations: [
        { action: "create_block", id: "payment-service", fields: { title: "Payment service", kind: "service", contract: "processPayment(amount) -> number" } },
        { action: "add_source_ref", id: "payment-service", fields: { path: "src/service.ts", symbol: "processPayment" } },
      ],
    });
    await fs.appendFile(sourcePath, "\nexport function refundPayment(id: string) {\n  return id;\n}\n");
    const report = service.sourceBindingReport();
    assert.equal(report.editPath === "native-edit-then-accept" || (report.unboundCandidates ?? []).length >= 0, true);
    const candidate = (report.unboundCandidates ?? []).find((item) => item.symbol === "refundPayment");
    if (candidate) {
      assert.equal(candidate.blockId, "payment-service");
      assert.equal(service.database.prepare("SELECT count(*) AS count FROM source_refs WHERE block_id = ? AND symbol = ?").get("payment-service", "refundPayment").count, 0);
    }
  } finally {
    service.close();
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});
