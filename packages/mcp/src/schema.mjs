import crypto from "node:crypto";

export const BLOCK_KINDS = new Set([
  "principle",
  "product",
  "requirement",
  "flow",
  "ui",
  "service",
  "function",
  "integration",
  "api",
  "data",
  "database",
  "risk",
]);

// `decision`, `test`, and `checkpoint` were accepted as Block kinds in earlier
// schemas. Keep them readable for legacy graphs, but never create or mutate one:
// durable architecture decisions live in the scoped `decisions` table, and
// testing/verification belongs to Plans and Checkpoints.
export const LEGACY_BLOCK_KINDS = new Set([...BLOCK_KINDS, "decision", "test", "checkpoint"]);

export const DELIVERY_STATES = new Set([
  "proposed",
  "planned",
  "implementing",
  "verifying",
  "complete",
  "deprecated",
]);

export const HEALTH_STATES = new Set([
  "unknown",
  "healthy",
  "warning",
  "failing",
  "unstable",
  "disputed",
]);

export const PLAN_STATUSES = new Set(["draft", "ready", "active", "verifying", "complete", "blocked", "failed", "retest_required", "cancelled"]);
export const PLAN_STEP_STATUSES = new Set(["pending", "active", "complete", "blocked", "failed", "skipped"]);

export function isHardPlanBlocker(value) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (/^(blocked|blocker|waiting|cannot|can't|unable|depends on|prerequisite)\b/i.test(text)) return true;
  if (/\b(blocked by|waiting for|cannot proceed|can't proceed|unable to proceed)\b/i.test(text)) return true;
  return false;
}
export const DECISION_STATUSES = new Set(["proposed", "active", "superseded", "reconsidered"]);
export const CHECKPOINT_STATUSES = new Set([
  "pending", "running", "passed", "partial_pass", "failed", "blocked", "not_supported", "retest_required",
]);
export const CHECKPOINT_KINDS = new Set(["atomic", "aggregate", "integration"]);
export const EVIDENCE_LEVELS = new Set(["none", "static", "simulated", "integration", "real_target", "human_review"]);
export const EVIDENCE_LEVEL_RANK = new Map([...EVIDENCE_LEVELS].map((value, index) => [value, index]));

export const LINK_KINDS = new Set([
  "flows_to",
  "calls",
  "reads",
  "writes",
  "depends_on",
  "implements",
  "validates",
  "constrains",
  "supersedes",
]);

export const ARCHITECTURE_LAYERS = new Set([
  "client",
  "boundary",
  "application",
  "domain",
  "data",
  "external",
  "quality",
  "infrastructure",
  "unspecified",
]);

export const FOUNDATION_LAYER_ORDER = [
  "data",
  "domain",
  "application",
  "boundary",
  "client",
  "external",
  "infrastructure",
  "quality",
  "unspecified",
];

export const EDITABLE_BLOCK_FIELDS = new Set([
  "kind",
  "title",
  "summary",
  "body",
  "contract",
  "scope",
  "architectureLayer",
  "localOrder",
  "deliveryState",
  "healthState",
  "priority",
  "confidence",
  "tags",
  "archived",
]);

export const EDITABLE_CHAIN_FIELDS = new Set([
  "chainType",
  "title",
  "purpose",
  "intent",
  "inputContract",
  "outputContract",
  "deliveryState",
  "healthState",
  "priority",
  "archived",
]);

export const EDITABLE_LINK_FIELDS = new Set([
  "kind",
  "label",
  "contract",
  "healthState",
  "archived",
]);

export const EDITABLE_PLAN_FIELDS = new Set([
  "title",
  "summary",
  "goal",
  "status",
  "priority",
  "phase",
  "planOrder",
  "proposedDelta",
  "completionPolicy",
  "nextAction",
  "blockers",
  "statusReason",
  "startedAt",
  "completedAt",
  "invalidatedAt",
  "archived",
]);

export const EDITABLE_DECISION_FIELDS = new Set([
  "title",
  "summary",
  "rationale",
  "alternatives",
  "consequences",
  "status",
  "supersedesDecisionId",
  "archived",
]);

export const EDITABLE_PLAN_CHAIN_SCOPE_FIELDS = new Set([
  "chainId",
  "position",
  "title",
  "summary",
  "rationale",
  "startBlockId",
  "endBlockId",
  "nodeIds",
  "linkIds",
  "expectedDelta",
  "prohibitions",
  "localizations",
  "status",
]);

export const EDITABLE_PLAN_CHANGE_FIELDS = new Set([
  "position",
  "title",
  "summary",
  "currentBehavior",
  "proposedBehavior",
  "rationale",
  "prohibitions",
  "expectedEffects",
  "sourceRefs",
  "localizations",
  "status",
]);

export const LOCALIZED_FIELDS = {
  block: new Set(["title", "summary", "body", "contract"]),
  chain: new Set(["title", "intent", "inputContract", "outputContract"]),
  link: new Set(["label", "contract"]),
  plan: new Set(["title", "summary", "goal", "nextAction"]),
};

export const LOCALES = new Set(["en", "zh-Hans"]);

export function now() {
  return new Date().toISOString();
}

export function identifier(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function changedHistoryFields(before = {}, after = {}, candidates = []) {
  return [...new Set(candidates)].filter((field) =>
    JSON.stringify(before?.[field] ?? null) !== JSON.stringify(after?.[field] ?? null),
  );
}

export function serializeTags(value) {
  if (!Array.isArray(value)) return "[]";
  return JSON.stringify([...new Set(value.map(String).filter(Boolean))]);
}

export function camelToColumn(field) {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function assertAllowed(value, allowed, label) {
  if (!allowed.has(value)) throw new Error(`Invalid ${label}: ${value}`);
}

export function entityExists(database, projectId, type, id) {
  const table = type === "block" ? "blocks"
    : type === "chain" ? "chains"
      : type === "link" ? "links"
        : type === "plan" ? "plans"
          : type === "decision" ? "decisions"
          : type === "plan_change" ? "plan_changes"
            : type === "plan_chain_scope" ? "plan_chain_scopes" : null;
  if (!table) return false;
  if (["plan_changes", "plan_chain_scopes"].includes(table)) {
    return Boolean(database.prepare(
      `SELECT 1 FROM ${table} item JOIN plans p ON p.id = item.plan_id WHERE p.project_id = ? AND item.id = ?`,
    ).get(projectId, id));
  }
  return Boolean(database.prepare(`SELECT 1 FROM ${table} WHERE project_id = ? AND id = ?`).get(projectId, id));
}

export function normalizeBlock(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    body: row.body,
    contract: row.contract,
    scope: row.scope,
    architectureLayer: row.architecture_layer,
    localOrder: row.local_order,
    deliveryState: row.delivery_state,
    healthState: row.health_state,
    priority: row.priority,
    confidence: row.confidence,
    tags: parseJson(row.tags_json, []),
    currentRevision: row.current_revision,
    archived: Boolean(row.archived),
    updatedAt: row.updated_at,
  };
}

export function normalizeDecision(row) {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    rationale: row.rationale,
    alternatives: parseJson(row.alternatives_json, []),
    consequences: parseJson(row.consequences_json, []),
    status: row.status,
    supersedesDecisionId: row.supersedes_decision_id,
    currentRevision: row.current_revision,
    archived: Boolean(row.archived),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function normalizeChain(row) {
  return {
    id: row.id,
    title: row.title,
    chainType: row.chain_type ?? "leaf",
    purpose: row.purpose,
    intent: row.intent,
    inputContract: row.input_contract,
    outputContract: row.output_contract,
    deliveryState: row.delivery_state,
    healthState: row.health_state,
    priority: row.priority,
    currentRevision: row.current_revision,
    archived: Boolean(row.archived),
    updatedAt: row.updated_at,
  };
}

export function normalizeLink(row) {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    targetType: row.target_type,
    targetId: row.target_id,
    kind: row.kind,
    label: row.label,
    contract: row.contract,
    healthState: row.health_state,
    currentRevision: row.current_revision,
    archived: Boolean(row.archived),
    updatedAt: row.updated_at,
  };
}

export function normalizePlan(row) {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    goal: row.goal,
    status: row.status,
    priority: row.priority,
    phase: row.phase,
    planOrder: row.plan_order,
    proposedDelta: parseJson(row.proposed_delta_json, []),
    completionPolicy: parseJson(row.completion_policy_json, {}),
    nextAction: row.next_action,
    blockers: parseJson(row.blockers_json, []),
    statusReason: row.status_reason,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    invalidatedAt: row.invalidated_at,
    currentRevision: row.current_revision,
    archived: Boolean(row.archived),
    updatedAt: row.updated_at,
  };
}

export function normalizePlanChainScope(row) {
  return {
    id: row.id, planId: row.plan_id, chainId: row.chain_id, position: row.position,
    title: row.title, summary: row.summary, rationale: row.rationale,
    startBlockId: row.start_block_id, endBlockId: row.end_block_id,
    nodeIds: parseJson(row.node_ids_json, []), linkIds: parseJson(row.link_ids_json, []),
    expectedDelta: parseJson(row.expected_delta_json, []), prohibitions: parseJson(row.prohibitions_json, []),
    localizations: parseJson(row.localizations_json, {}), status: row.status,
    currentRevision: row.current_revision, updatedAt: row.updated_at,
  };
}

export function normalizePlanChange(row) {
  return {
    id: row.id, planId: row.plan_id, entityType: row.entity_type, entityId: row.entity_id,
    position: row.position, title: row.title, summary: row.summary,
    currentBehavior: row.current_behavior, proposedBehavior: row.proposed_behavior, rationale: row.rationale,
    prohibitions: parseJson(row.prohibitions_json, []), expectedEffects: parseJson(row.expected_effects_json, []),
    sourceRefs: parseJson(row.source_refs_json, []), localizations: parseJson(row.localizations_json, {}),
    status: row.status, currentRevision: row.current_revision, updatedAt: row.updated_at,
  };
}

export function deriveCheckpointStates(checkpoints, dependencies) {
  const byId = new Map(checkpoints.map((checkpoint) => [checkpoint.id, {
    ...checkpoint,
    recordedStatus: checkpoint.recordedStatus ?? checkpoint.status,
  }]));
  const childrenByParent = new Map();
  for (const dependency of dependencies) {
    const values = childrenByParent.get(dependency.parentCheckpointId) ?? [];
    values.push(dependency);
    childrenByParent.set(dependency.parentCheckpointId, values);
  }
  const visiting = new Set();
  const resolved = new Set();
  const derive = (id) => {
    const checkpoint = byId.get(id);
    if (!checkpoint || resolved.has(id)) return checkpoint;
    if (visiting.has(id)) throw new Error("Checkpoint dependency graph must remain acyclic");
    visiting.add(id);
    const dependenciesForCheckpoint = (childrenByParent.get(id) ?? []).sort((a, b) => a.position - b.position);
    const children = dependenciesForCheckpoint.map((dependency) => ({
      dependency,
      checkpoint: derive(dependency.childCheckpointId),
    })).filter((item) => item.checkpoint);
    const required = children.filter((item) => item.dependency.required).map((item) => item.checkpoint);
    const optional = children.filter((item) => !item.dependency.required).map((item) => item.checkpoint);
    checkpoint.optionalWarnings = optional
      .filter((child) => ["failed", "blocked", "retest_required", "not_supported"].includes(child.status))
      .map((child) => child.id);
    if (children.length > 0) {
      const statuses = required.map((child) => child.status);
      const gatesPassed = required.length > 0 && required.every(checkpointSatisfiesGate);
      if (required.some((child) => child.invalidatedAt || child.status === "retest_required")) checkpoint.status = "retest_required";
      else if (statuses.includes("failed")) checkpoint.status = "failed";
      else if (statuses.includes("blocked")) checkpoint.status = "blocked";
      else if (statuses.length > 0 && statuses.every((status) => status === "not_supported")) checkpoint.status = "not_supported";
      else if (checkpoint.checkpointKind === "integration" || checkpoint.eligibleAfterChildren) {
        checkpoint.eligible = gatesPassed;
        checkpoint.status = gatesPassed ? checkpoint.recordedStatus : (statuses.some((status) => status === "passed") ? "partial_pass" : "pending");
      } else if (gatesPassed) {
        checkpoint.status = "passed";
        checkpoint.coverage = "complete";
        checkpoint.evidenceLevel = required.reduce((level, child) =>
          Math.min(level, EVIDENCE_LEVEL_RANK.get(child.evidenceLevel) ?? 0), Number.MAX_SAFE_INTEGER);
        checkpoint.evidenceLevel = [...EVIDENCE_LEVEL_RANK.entries()].find(([, rank]) => rank === checkpoint.evidenceLevel)?.[0] ?? "none";
        if ((EVIDENCE_LEVEL_RANK.get(checkpoint.evidenceLevel) ?? 0) <
            (EVIDENCE_LEVEL_RANK.get(checkpoint.requiredEvidenceLevel) ?? 0)) {
          checkpoint.status = "partial_pass";
        }
      } else if (statuses.includes("running")) checkpoint.status = "running";
      else if (statuses.some((status) => ["passed", "partial_pass"].includes(status))) checkpoint.status = "partial_pass";
      else checkpoint.status = "pending";
    }
    visiting.delete(id);
    resolved.add(id);
    return checkpoint;
  };
  for (const checkpoint of checkpoints) derive(checkpoint.id);
  return [...byId.values()];
}

export function checkpointSatisfiesGate(checkpoint) {
  return checkpoint?.status === "passed" && checkpoint.coverage === "complete" &&
    (EVIDENCE_LEVEL_RANK.get(checkpoint.evidenceLevel) ?? 0) >=
      (EVIDENCE_LEVEL_RANK.get(checkpoint.requiredEvidenceLevel) ?? 0) && !checkpoint.invalidatedAt &&
    checkpoint.freshness?.status === "fresh";
}

export function architectureCoverage(snapshot, planId = null) {
  const blocks = snapshot.blocks.filter((block) => block.deliveryState !== "deprecated" && block.kind !== "decision");
  const blockIds = new Set(blocks.map((block) => block.id));
  const compositionMembersByChain = new Map();
  for (const member of snapshot.chainMembers ?? []) {
    const values = compositionMembersByChain.get(member.chainId) ?? [];
    values.push(member);
    compositionMembersByChain.set(member.chainId, values);
  }
  const chainBlocks = (chainId, visiting = new Set()) => {
    if (visiting.has(chainId)) return new Set();
    visiting.add(chainId);
    const ids = new Set(snapshot.chainNodes.filter((node) => node.chainId === chainId && blockIds.has(node.blockId)).map((node) => node.blockId));
    for (const member of compositionMembersByChain.get(chainId) ?? []) {
      if (member.memberType === "block" && blockIds.has(member.memberId)) ids.add(member.memberId);
      if (member.memberType === "chain") for (const blockId of chainBlocks(member.memberId, new Set(visiting))) ids.add(blockId);
    }
    return ids;
  };
  const chainBlockIds = new Set();
  for (const chain of snapshot.chains ?? []) for (const blockId of chainBlocks(chain.id)) chainBlockIds.add(blockId);
  const checkpointsByBlock = new Map(blocks.map((block) => [block.id, []]));
  for (const checkpoint of snapshot.checkpoints) {
    if (checkpoint.targetType === "block" && checkpointsByBlock.has(checkpoint.targetId)) {
      checkpointsByBlock.get(checkpoint.targetId).push(checkpoint);
    }
  }

  const candidatePlans = planId ? snapshot.plans.filter((plan) => plan.id === planId) : snapshot.plans;
  const candidatePlanIds = new Set(candidatePlans.map((plan) => plan.id));
  const directPlanBlockIds = new Set();
  for (const change of snapshot.planChanges) {
    if (candidatePlanIds.has(change.planId) && change.entityType === "block" && blockIds.has(change.entityId)) directPlanBlockIds.add(change.entityId);
  }
  for (const step of snapshot.planSteps) {
    if (!candidatePlanIds.has(step.planId)) continue;
    for (const ref of step.targetRefs) {
      const [type, id] = String(ref).split(":", 2);
      if (type === "block" && blockIds.has(id)) directPlanBlockIds.add(id);
    }
  }
  const chainPlanBlockIds = new Set(snapshot.planChainScopes
    .filter((scope) => candidatePlanIds.has(scope.planId))
    .flatMap((scope) => scope.nodeIds)
    .filter((blockId) => blockIds.has(blockId)));
  for (const scope of snapshot.planChainScopes.filter((item) => candidatePlanIds.has(item.planId))) {
    for (const blockId of chainBlocks(scope.chainId)) chainPlanBlockIds.add(blockId);
  }
  const plannedBlockIds = new Set([...directPlanBlockIds, ...chainPlanBlockIds]);
  const candidateChangeIdsByBlock = new Map();
  for (const change of snapshot.planChanges) {
    if (!candidatePlanIds.has(change.planId) || change.entityType !== "block") continue;
    const values = candidateChangeIdsByBlock.get(change.entityId) ?? [];
    values.push(change.id);
    candidateChangeIdsByBlock.set(change.entityId, values);
  }
  const bindingsByCheckpoint = new Map();
  for (const binding of snapshot.checkpointBindings) {
    const values = bindingsByCheckpoint.get(binding.checkpointId) ?? [];
    values.push(binding);
    bindingsByCheckpoint.set(binding.checkpointId, values);
  }
  const explicitlyRequiredBlockIds = new Set(snapshot.checkpointBindings
    .filter((binding) => binding.required && binding.subjectType === "block")
    .map((binding) => binding.subjectId));
  for (const reference of snapshot.planCheckpointRefs) {
    if (!reference.required || !candidatePlanIds.has(reference.planId)) continue;
    const checkpoint = snapshot.checkpoints.find((item) => item.id === reference.checkpointId);
    if (checkpoint?.targetType === "block") explicitlyRequiredBlockIds.add(checkpoint.targetId);
  }
  const scopesByBlock = new Map(blocks.map((block) => [block.id, []]));
  for (const scope of snapshot.planChainScopes) {
    if (!candidatePlanIds.has(scope.planId)) continue;
    for (const blockId of scope.nodeIds) {
      if (scopesByBlock.has(blockId)) scopesByBlock.get(blockId).push(scope);
    }
  }
  const chainIdsByBlock = new Map(blocks.map((block) => [block.id, []]));
  for (const node of snapshot.chainNodes) {
    if (chainIdsByBlock.has(node.blockId)) chainIdsByBlock.get(node.blockId).push(node.chainId);
  }
  for (const chain of snapshot.chains ?? []) {
    for (const blockId of chainBlocks(chain.id)) {
      if (chainIdsByBlock.has(blockId) && !chainIdsByBlock.get(blockId).includes(chain.id)) chainIdsByBlock.get(blockId).push(chain.id);
    }
  }
  // Chain integration is opt-in. Membership alone does not make every member
  // Block wait for a Chain checkpoint; only a declared integration Checkpoint
  // or an explicitly bound Plan ChainScope creates a gate.
  const declaredChainGateIds = new Set(snapshot.checkpoints
    .filter((checkpoint) => checkpoint.targetType === "chain" && checkpoint.checkpointKind === "integration")
    .map((checkpoint) => checkpoint.targetId));
  const chainGateIds = new Set([...declaredChainGateIds]);
  for (const binding of snapshot.checkpointBindings) {
    if (!binding.required || binding.subjectType !== "plan_chain_scope") continue;
    const scope = snapshot.planChainScopes.find((item) => item.id === binding.subjectId && candidatePlanIds.has(item.planId));
    const checkpoint = snapshot.checkpoints.find((item) => item.id === binding.checkpointId);
    if (scope && checkpoint?.checkpointKind === "integration") chainGateIds.add(scope.chainId);
  }
  const chainGateMissingChainIds = [...chainGateIds].filter((chainId) => {
    const gates = snapshot.checkpoints.filter((checkpoint) =>
      checkpoint.targetType === "chain" && checkpoint.targetId === chainId && checkpoint.checkpointKind === "integration",
    );
    return gates.length === 0 || gates.every((checkpoint) => !checkpointSatisfiesGate(checkpoint));
  });
  const chainGateMissingSet = new Set(chainGateMissingChainIds);

  const blockCoverage = blocks.map((block) => {
    const blockCheckpoints = checkpointsByBlock.get(block.id) ?? [];
    const changeIds = new Set(candidateChangeIdsByBlock.get(block.id) ?? []);
    const checkpointBindings = blockCheckpoints.flatMap((checkpoint) => bindingsByCheckpoint.get(checkpoint.id) ?? []);
    const hasCheckpoint = blockCheckpoints.length > 0;
    const hasExactPlanBinding = checkpointBindings.some((binding) =>
      binding.subjectType === "plan_change" && changeIds.has(binding.subjectId),
    );
    const isCoveredByAnyVerification = checkpointBindings.length > 0 || blockCheckpoints.some(checkpointSatisfiesGate);
    const memberChainIds = [...new Set(chainIdsByBlock.get(block.id) ?? [])];
    const relevantChainIds = planId
      ? [...new Set((scopesByBlock.get(block.id) ?? []).map((scope) => scope.chainId))]
      : memberChainIds;
    // A checkpoint is a requested verification artifact, not a prerequisite
    // for declaring an architectural Block, completing delivery, or entering
    // a Plan. Only an explicit required binding/ref creates a Block gate.
    const checkpointRequired = explicitlyRequiredBlockIds.has(block.id);
    // A standalone Block checkpoint is valid on its own. It is only an
    // unbound Plan checkpoint when it was explicitly attached to Plan work but
    // not to this Block's canonical PlanChange.
    const hasPlanIntentBinding = checkpointBindings.some((binding) =>
      ["plan", "plan_change", "plan_chain_scope"].includes(binding.subjectType),
    );
    return {
      blockId: block.id,
      hasCheckpoint,
      checkpointRequired,
      missingRequiredCheckpoint: checkpointRequired && !hasCheckpoint,
      isCoveredByPlan: plannedBlockIds.has(block.id),
      isCoveredByChain: chainBlockIds.has(block.id),
      isCoveredByAnyVerification,
      checkpointUnbound: plannedBlockIds.has(block.id) && hasCheckpoint && hasPlanIntentBinding && !hasExactPlanBinding,
      chainGateMissing: relevantChainIds.some((chainId) => chainGateMissingSet.has(chainId)),
      checkpointIds: blockCheckpoints.map((checkpoint) => checkpoint.id),
      planChangeIds: [...changeIds],
      chainIds: memberChainIds,
      relevantChainIds,
      chainScopeIds: (scopesByBlock.get(block.id) ?? []).map((scope) => scope.id),
    };
  });
  const withCheckpointIds = blocks.filter((block) => (checkpointsByBlock.get(block.id) ?? []).length > 0).map((block) => block.id);
  const verifiedIds = blocks.filter((block) => (checkpointsByBlock.get(block.id) ?? []).some(checkpointSatisfiesGate)).map((block) => block.id);
  const withCheckpointIdSet = new Set(withCheckpointIds);
  const verifiedIdSet = new Set(verifiedIds);
  const failingIds = blocks.filter((block) => (checkpointsByBlock.get(block.id) ?? []).some((checkpoint) =>
    ["failed", "blocked", "retest_required"].includes(checkpoint.status),
  )).map((block) => block.id);
  return {
    totalBlocks: blocks.length,
    withCheckpoint: withCheckpointIds.length,
    verified: verifiedIds.length,
    inChains: chainBlockIds.size,
    planned: plannedBlockIds.size,
    directPlanBlocks: directPlanBlockIds.size,
    chainPlanBlocks: chainPlanBlockIds.size,
    // For a Plan-scoped projection, only report missing checkpoints for work
    // that Plan actually covers; global project maps still expose every
    // checkpoint-free Block so omission remains discoverable.
    withoutCheckpointIds: blocks.filter((block) => !withCheckpointIdSet.has(block.id) && (!planId || plannedBlockIds.has(block.id))).map((block) => block.id),
    requiredCheckpointMissingIds: blockCoverage.filter((item) => item.missingRequiredCheckpoint).map((item) => item.blockId),
    unverifiedIds: blocks.filter((block) => !verifiedIdSet.has(block.id)).map((block) => block.id),
    outsideChainIds: blocks.filter((block) => !chainBlockIds.has(block.id)).map((block) => block.id),
    unplannedIds: blocks.filter((block) => !plannedBlockIds.has(block.id)).map((block) => block.id),
    failingIds,
    verificationCovered: blockCoverage.filter((item) => item.isCoveredByAnyVerification).length,
    checkpointUnboundIds: blockCoverage.filter((item) => item.checkpointUnbound).map((item) => item.blockId),
    chainGateMissingIds: blockCoverage.filter((item) => item.chainGateMissing).map((item) => item.blockId),
    chainGateMissingChainIds,
    blockCoverage,
  };
}

export function derivePlanState(
  plan, allPlans, dependencies, steps, checkpointRefs, checkpoints,
  chainScopes = [], changes = [], checkpointBindings = [],
) {
  const ownDependencies = dependencies.filter((item) => item.planId === plan.id);
  const ownSteps = steps.filter((item) => item.planId === plan.id);
  const ownScopes = chainScopes.filter((item) => item.planId === plan.id);
  const ownChanges = changes.filter((item) => item.planId === plan.id);
  const ownCheckpointRefs = checkpointRefs.filter((item) => item.planId === plan.id);
  const requiredRefs = ownCheckpointRefs.filter((item) => item.required);
  const checkpointById = new Map(checkpoints.map((item) => [item.id, item]));
  const scopeIDs = new Set(ownScopes.map((item) => item.id));
  const changeIDs = new Set(ownChanges.map((item) => item.id));
  const requiredCheckpointIDs = new Set([
    ...requiredRefs.map((item) => item.checkpointId),
    ...checkpoints.filter((item) => item.targetType === "plan" && item.targetId === plan.id).map((item) => item.id),
    ...checkpointBindings.filter((binding) => binding.required && (
      (binding.subjectType === "plan" && binding.subjectId === plan.id) ||
      (binding.subjectType === "plan_chain_scope" && scopeIDs.has(binding.subjectId)) ||
      (binding.subjectType === "plan_change" && changeIDs.has(binding.subjectId))
    )).map((binding) => binding.checkpointId),
  ]);
  const requiredCheckpoints = [...requiredCheckpointIDs].map((id) => checkpointById.get(id)).filter(Boolean);
  const completedGates = requiredCheckpoints.filter(checkpointSatisfiesGate).length;
  const usesDetailedChanges = ownScopes.length > 0 || ownChanges.length > 0;
  const completedWork = usesDetailedChanges
    ? ownChanges.filter((item) => ["complete", "passed"].includes(item.status)).length
    : ownSteps.filter((item) => ["complete", "skipped"].includes(item.status)).length;
  const totalWork = usesDetailedChanges ? ownChanges.length : ownSteps.length;
  const progress = {
    completedSteps: completedWork,
    totalSteps: totalWork,
    passedRequiredCheckpoints: completedGates,
    totalRequiredCheckpoints: requiredCheckpoints.length,
  };
  const changeProgress = (entityType) => {
    const items = ownChanges.filter((item) => item.entityType === entityType);
    return {
      completed: items.filter((item) => ["complete", "passed"].includes(item.status)).length,
      total: items.length,
    };
  };
  const chainGateIds = new Set(checkpointBindings.filter((binding) =>
    binding.required && binding.subjectType === "plan_chain_scope" && scopeIDs.has(binding.subjectId),
  ).map((binding) => binding.checkpointId));
  const planGateIds = new Set([
    ...requiredRefs.map((item) => item.checkpointId),
    ...checkpoints.filter((item) => item.targetType === "plan" && item.targetId === plan.id).map((item) => item.id),
    ...checkpointBindings.filter((binding) =>
      binding.required && binding.subjectType === "plan" && binding.subjectId === plan.id,
    ).map((binding) => binding.checkpointId),
  ]);
  const gateProgress = (ids) => {
    const items = [...ids].map((id) => checkpointById.get(id)).filter(Boolean);
    return { passed: items.filter(checkpointSatisfiesGate).length, total: items.length };
  };
  const typedProgress = {
    directBlockChanges: changeProgress("block"),
    chainChanges: changeProgress("chain"),
    linkChanges: changeProgress("link"),
    chainIntegrationGates: gateProgress(chainGateIds),
    planAcceptanceGates: gateProgress(planGateIds),
  };
  let derivedStatus = plan.status;
  let derivedReason = plan.statusReason;
  if (plan.invalidatedAt || requiredCheckpoints.some((item) => item.invalidatedAt || item.status === "retest_required")) {
    derivedStatus = "retest_required";
    derivedReason ||= "A required checkpoint was invalidated and must be run again.";
  } else if (plan.status === "cancelled") {
    derivedStatus = "cancelled";
  } else if (ownSteps.some((item) => item.status === "failed") || requiredCheckpoints.some((item) => item.status === "failed")) {
    derivedStatus = "failed";
    derivedReason ||= "A required step or checkpoint failed.";
  } else if (plan.blockers.some(isHardPlanBlocker) || ownSteps.some((item) => item.status === "blocked") || requiredCheckpoints.some((item) => item.status === "blocked")) {
    derivedStatus = "blocked";
    derivedReason ||= "A required step, checkpoint, or explicit blocker prevents progress.";
  } else {
    const incompleteDependencies = ownDependencies.filter((item) => {
      const dependency = allPlans.find((candidate) => candidate.id === item.dependsOnPlanId);
      return dependency?.derivedStatus !== "complete" && dependency?.status !== "complete";
    });
    if (incompleteDependencies.length) {
      derivedStatus = "blocked";
      derivedReason ||= `Waiting for ${incompleteDependencies.length} prerequisite plan(s).`;
    } else if (totalWork > 0 && progress.completedSteps === totalWork &&
        requiredCheckpoints.length > 0 && completedGates === requiredCheckpoints.length) {
      derivedStatus = "complete";
      derivedReason ||= usesDetailedChanges
        ? "All declared entity changes and required checkpoint gates passed."
        : "All ordered steps and required checkpoint gates passed.";
    } else if (totalWork > 0 && progress.completedSteps === totalWork) {
      derivedStatus = "verifying";
      derivedReason ||= usesDetailedChanges
        ? "Declared changes are complete; checkpoint evidence remains."
        : "Implementation steps are complete; checkpoint evidence remains.";
    }
  }
  return { ...plan, derivedStatus, derivedReason, progress, typedProgress };
}

export function normalizeLocalizations(rows) {
  return rows.map((row) => ({
    entityType: row.entity_type,
    entityId: row.entity_id,
    locale: row.locale,
    field: row.field,
    value: row.value,
  }));
}

export function localizationMap(_snapshot) {
  // Legacy localizations remain readable in storage for compatibility, but project
  // facts are always emitted from their canonical field. App language is UI chrome.
  return null;
}

export function localizedValue(_map, _type, _id, _locale, _field, fallback = "") {
  return fallback;
}

export function localizedSearchText(_snapshot, _type, _id) {
  return "";
}

export function operationEntityType(action) {
  if (action.includes("decision")) return "decision";
  if (action.includes("block") || ["add_source_ref", "remove_source_ref", "set_background_scopes"].includes(action)) return "block";
  if (action.includes("chain") && !action.startsWith("set_plan_") && !action.startsWith("append_plan_")) return "chain";
  if (action.includes("link")) return "link";
  if (action.includes("plan")) return "plan";
  if (action.includes("checkpoint")) return "checkpoint";
  return null;
}

export function affectedRefsForOperation(operation) {
  const refs = new Set();
  const fields = operation.fields ?? {};
  const add = (type, id) => { if (id) refs.add(`${type}:${id}`); };
  for (const id of fields.nodeIds ?? []) add("block", id);
  for (const id of fields.removeBlockIds ?? []) add("block", id);
  for (const id of fields.linkIds ?? []) add("link", id);
  for (const id of fields.chainIds ?? []) add("chain", id);
  for (const member of [...(fields.memberRefs ?? []), ...(fields.members ?? [])]) {
    const type = member?.memberType ?? member?.member_type ?? member?.type;
    const id = member?.memberId ?? member?.member_id ?? member?.id ?? (typeof member === "string" && member.includes(":") ? member.split(":").slice(1).join(":") : null);
    if (type && id) add(type, id);
  }
  for (const id of fields.compositionLinkIds ?? []) add("link", id);
  for (const id of fields.planIds ?? []) add("plan", id);
  for (const id of fields.decisionIds ?? []) add("decision", id);
  if (fields.supersedesDecisionId) add("decision", fields.supersedesDecisionId);
  for (const scope of fields.scopes ?? []) {
    add("chain", scope.chainId);
    for (const id of scope.nodeIds ?? []) add("block", id);
    for (const id of scope.linkIds ?? []) add("link", id);
  }
  if (fields.scope) {
    add("chain", fields.scope.chainId);
    for (const id of fields.scope.nodeIds ?? []) add("block", id);
    for (const id of fields.scope.linkIds ?? []) add("link", id);
  }
  for (const change of fields.changes ?? []) add(change.entityType, change.entityId);
  for (const update of fields.updates ?? []) {
    add("plan_change", update.changeId);
    for (const id of update.patch?.nodeIds ?? []) add("block", id);
    for (const id of update.patch?.linkIds ?? []) add("link", id);
    if (update.patch?.chainId) add("chain", update.patch.chainId);
  }
  if (fields.scopeId) {
    add("plan_chain_scope", fields.scopeId);
    add("chain", fields.patch?.chainId);
    for (const id of fields.patch?.nodeIds ?? []) add("block", id);
    for (const id of fields.patch?.linkIds ?? []) add("link", id);
  }
  if (fields.changeId) add("plan_change", fields.changeId);
  for (const ref of fields.refs ?? []) {
    add("plan_chain_scope", ref.chainScopeId);
    add("plan_change", ref.planChangeId);
  }
  for (const binding of fields.bindings ?? []) add(binding.subjectType, binding.subjectId);
  for (const child of fields.children ?? []) add("checkpoint", child.checkpointId);
  for (const checkpoint of fields.checkpoints ?? []) add("checkpoint", checkpoint.checkpointId);
  if (fields.targetType && fields.targetId) add(fields.targetType, fields.targetId);
  return [...refs];
}

export function taskTerms(task) {
  const stopWords = new Set([
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "is", "it",
    "of", "on", "or", "the", "this", "to", "what", "when", "where", "which", "with",
  ]);
  const terms = task
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((term) => term.length > 1 && !stopWords.has(term));
  const cjkRuns = task.match(/[\p{Script=Han}]+/gu) ?? [];
  for (const run of cjkRuns) {
    if (run.length >= 2) terms.push(run);
    for (let index = 0; index < run.length - 1; index += 1) terms.push(run.slice(index, index + 2));
    if (run.length === 1) terms.push(run);
  }
  return [...new Set(terms)];
}

export function foundationBlockGroups(snapshot, blocks) {
  const remaining = new Map(blocks.map((block) => [block.id, block]));
  const dependencyIds = new Map(blocks.map((block) => [block.id, new Set()]));
  for (const link of snapshot.links) {
    if (link.sourceType !== "block" || link.targetType !== "block") continue;
    if (["depends_on", "calls", "reads", "writes"].includes(link.kind)) {
      if (dependencyIds.has(link.sourceId) && dependencyIds.has(link.targetId)) {
        dependencyIds.get(link.sourceId).add(link.targetId);
      }
    } else if (link.kind === "flows_to") {
      if (dependencyIds.has(link.targetId) && dependencyIds.has(link.sourceId)) {
        dependencyIds.get(link.targetId).add(link.sourceId);
      }
    }
  }
  const layerRank = new Map(FOUNDATION_LAYER_ORDER.map((layer, index) => [layer, index]));
  const compare = (left, right) =>
    (layerRank.get(left.architectureLayer) ?? FOUNDATION_LAYER_ORDER.length) -
      (layerRank.get(right.architectureLayer) ?? FOUNDATION_LAYER_ORDER.length) ||
    left.localOrder - right.localOrder || left.id.localeCompare(right.id);
  const groups = [];
  const completed = new Set();
  while (remaining.size > 0) {
    let ready = [...remaining.values()].filter((block) =>
      [...(dependencyIds.get(block.id) ?? [])].every((id) => completed.has(id) || !remaining.has(id)),
    );
    if (ready.length === 0) ready = [...remaining.values()];
    ready.sort(compare);
    const rank = layerRank.get(ready[0].architectureLayer) ?? FOUNDATION_LAYER_ORDER.length;
    const group = ready.filter((block) =>
      (layerRank.get(block.architectureLayer) ?? FOUNDATION_LAYER_ORDER.length) === rank,
    );
    groups.push(group);
    for (const block of group) {
      remaining.delete(block.id);
      completed.add(block.id);
    }
  }
  return groups;
}
