import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEntityId, normalizeMcpIds } from "../src/reference.mjs";

test("typed and plain entity IDs normalize to the same service input", () => {
  assert.equal(normalizeEntityId("block:payment-service", "block"), "payment-service");
  assert.equal(normalizeEntityId("payment-service", "block"), "payment-service");
  assert.deepEqual(normalizeMcpIds({ blockId: "block:payment-service", executionId: "execution:123" }), {
    blockId: "payment-service",
    executionId: "123",
  });
  assert.deepEqual(normalizeMcpIds({ targetType: "chain", targetId: "chain:checkout" }), {
    targetType: "chain",
    targetId: "checkout",
  });
});

test("typed IDs reject a conflicting parameter type", () => {
  assert.throws(() => normalizeEntityId("chain:checkout", "block"), /does not match expected block/);
  assert.throws(() => normalizeMcpIds({ type: "plan", id: "block:checkout" }), /does not match expected plan/);
});

test("typed IDs are normalized inside graph mutation operations", () => {
  const result = normalizeMcpIds({ operations: [
    { action: "update_block", id: "block:payment", fields: { deliveryState: "complete" } },
    { action: "set_chain_path", id: "chain:checkout", fields: { nodeIds: ["block:payment"], linkIds: ["link:payment-next"] } },
    { action: "record_checkpoint", fields: { targetType: "block", targetId: "block:payment", evidenceExecutionIds: ["exec:123"] } },
  ] });
  assert.equal(result.operations[0].id, "payment");
  assert.equal(result.operations[1].id, "checkout");
  assert.deepEqual(result.operations[1].fields.nodeIds, ["payment"]);
  assert.deepEqual(result.operations[1].fields.linkIds, ["payment-next"]);
  assert.equal(result.operations[2].fields.targetId, "payment");
  assert.deepEqual(result.operations[2].fields.evidenceExecutionIds, ["123"]);
});
