const TYPE_ALIASES = new Map([
  ["block", "block"],
  ["chain", "chain"],
  ["link", "link"],
  ["plan", "plan"],
  ["decision", "decision"],
  ["checkpoint", "checkpoint"],
  ["plan_change", "plan_change"],
  ["plan_step", "plan_step"],
  ["plan_chain_scope", "plan_chain_scope"],
  ["change", "change"],
  ["change_set", "change"],
  ["exec", "exec"],
  ["execution", "exec"],
]);

export function normalizeEntityId(value, expectedType = null) {
  if (typeof value !== "string") return value;
  const separator = value.indexOf(":");
  if (separator <= 0) return value;
  const prefix = TYPE_ALIASES.get(value.slice(0, separator));
  if (!prefix) return value;
  const id = value.slice(separator + 1);
  if (!id) throw new Error(`Invalid typed reference: ${value}`);
  const expected = expectedType ? (TYPE_ALIASES.get(expectedType) ?? expectedType) : null;
  if (expected && prefix !== expected) {
    throw new Error(`Typed reference ${value} does not match expected ${expectedType}`);
  }
  return id;
}

export function normalizeMcpIds(input = {}) {
  const payload = { ...input };
  const fixedTypes = {
    blockId: "block",
    chainId: "chain",
    planId: "plan",
    checkpointId: "checkpoint",
    chainScopeId: "plan_chain_scope",
    changeSetId: "change",
    executionId: "exec",
    dependsOnPlanId: "plan",
  };
  for (const [field, type] of Object.entries(fixedTypes)) {
    if (field in payload) payload[field] = normalizeEntityId(payload[field], type);
  }
  if (payload.type && "id" in payload) payload.id = normalizeEntityId(payload.id, payload.type);
  if (payload.targetType && "targetId" in payload) payload.targetId = normalizeEntityId(payload.targetId, payload.targetType);
  if ("sourceId" in payload) payload.sourceId = normalizeEntityId(payload.sourceId, "block");
  if ("targetId" in payload && !payload.targetType) payload.targetId = normalizeEntityId(payload.targetId, "block");
  if (Array.isArray(payload.blockIds)) payload.blockIds = payload.blockIds.map((id) => normalizeEntityId(id, "block"));
  if (Array.isArray(payload.nodeIds)) payload.nodeIds = payload.nodeIds.map((id) => normalizeEntityId(id, "block"));
  if (Array.isArray(payload.linkIds)) payload.linkIds = payload.linkIds.map((id) => normalizeEntityId(id, "link"));
  if (Array.isArray(payload.changes)) payload.changes = payload.changes.map((change) => ({
    ...change,
    entityId: change.entityId ? normalizeEntityId(change.entityId, change.entityType) : change.entityId,
  }));
  if (payload.scope && typeof payload.scope === "object") {
    payload.scope = { ...payload.scope };
    if (payload.scope.chainId) payload.scope.chainId = normalizeEntityId(payload.scope.chainId, "chain");
    if (Array.isArray(payload.scope.nodeIds)) payload.scope.nodeIds = payload.scope.nodeIds.map((id) => normalizeEntityId(id, "block"));
    if (Array.isArray(payload.scope.linkIds)) payload.scope.linkIds = payload.scope.linkIds.map((id) => normalizeEntityId(id, "link"));
  }
  if (Array.isArray(payload.evidenceExecutionIds)) {
    payload.evidenceExecutionIds = payload.evidenceExecutionIds.map((id) => normalizeEntityId(id, "exec"));
  }
  if (Array.isArray(payload.operations)) payload.operations = payload.operations.map(normalizeMutationOperationIds);
  return payload;
}

function operationEntityType(action) {
  if (/^(create|update|delete)_block$/.test(action)) return "block";
  if (/^(create|update|delete)_chain$/.test(action) || action === "set_chain_path") return "chain";
  if (/^(create|update|delete)_link$/.test(action)) return "link";
  if (/^(create|update|delete)_plan$/.test(action) || action.startsWith("set_plan_") || action.startsWith("append_plan_") || action === "update_plan_step" || action === "update_plan_change" || action === "update_plan_chain_scope" || action === "update_plan_changes") return "plan";
  if (/^(create|update|delete)_decision$/.test(action)) return "decision";
  if (/^(create|delete)_checkpoint$/.test(action) || action === "set_checkpoint_bindings" || action === "set_checkpoint_dependencies") return "checkpoint";
  if (action === "add_source_ref" || action === "remove_source_ref") return "block";
  return null;
}

function normalizeMutationOperationIds(operation = {}) {
  const next = { ...operation, fields: operation.fields ? { ...operation.fields } : operation.fields };
  const type = operationEntityType(next.action ?? "");
  if (type && next.id) next.id = normalizeEntityId(next.id, type);
  if (next.action === "record_checkpoint" && next.fields?.targetType && next.fields?.targetId) {
    next.fields.targetId = normalizeEntityId(next.fields.targetId, next.fields.targetType);
  }
  if (next.action === "set_chain_path" || next.action === "append_chain_path") {
    if (Array.isArray(next.fields?.nodeIds)) next.fields.nodeIds = next.fields.nodeIds.map((id) => normalizeEntityId(id, "block"));
    if (Array.isArray(next.fields?.linkIds)) next.fields.linkIds = next.fields.linkIds.map((id) => normalizeEntityId(id, "link"));
  }
  if (next.action === "append_plan_chain_scope" && next.fields?.scope) {
    next.fields.scope = { ...next.fields.scope };
    if (next.fields.scope.chainId) next.fields.scope.chainId = normalizeEntityId(next.fields.scope.chainId, "chain");
    if (Array.isArray(next.fields.scope.nodeIds)) next.fields.scope.nodeIds = next.fields.scope.nodeIds.map((id) => normalizeEntityId(id, "block"));
    if (Array.isArray(next.fields.scope.linkIds)) next.fields.scope.linkIds = next.fields.scope.linkIds.map((id) => normalizeEntityId(id, "link"));
    if (next.fields.scope.startBlockId) next.fields.scope.startBlockId = normalizeEntityId(next.fields.scope.startBlockId, "block");
    if (next.fields.scope.endBlockId) next.fields.scope.endBlockId = normalizeEntityId(next.fields.scope.endBlockId, "block");
  }
  if (next.action === "append_plan_changes" && Array.isArray(next.fields?.changes)) {
    next.fields.changes = next.fields.changes.map((change) => ({
      ...change,
      entityId: change.entityId ? normalizeEntityId(change.entityId, change.entityType) : change.entityId,
    }));
  }
  if (next.action === "update_plan_changes" && Array.isArray(next.fields?.updates)) {
    next.fields.updates = next.fields.updates.map((update) => ({ ...update }));
  }
  if (Array.isArray(next.fields?.evidenceExecutionIds)) {
    next.fields.evidenceExecutionIds = next.fields.evidenceExecutionIds.map((id) => normalizeEntityId(id, "exec"));
  }
  return next;
}
