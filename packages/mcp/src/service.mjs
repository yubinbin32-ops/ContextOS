import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { openDatabase, transaction, exportGraphToJson, importGraphFromJson, getSyncMeta, setSyncMeta } from "./database.mjs";
import { resolveProjectPaths } from "./paths.mjs";
import { parseGraphPatch } from "./patch.mjs";
import { extractSymbols, extractSymbolSlice, buildChainCodeStream, replaceSymbolSlice, detectLanguage } from "./ast.mjs";
import { sanitizeTerminalOutput } from "./sanitizer.mjs";

const BLOCK_KINDS = new Set([
  "principle",
  "product",
  "requirement",
  "flow",
  "ui",
  "service",
  "function",
  "integration",
  "data",
  "database",
  "risk",
  "test",
  "checkpoint",
]);

// `decision` was briefly accepted as a Block kind in the migration-era
// schema. Keep it readable for old graphs, but never create or mutate one:
// durable architecture decisions now live in the scoped `decisions` table.
const LEGACY_BLOCK_KINDS = new Set([...BLOCK_KINDS, "decision"]);

const DELIVERY_STATES = new Set([
  "proposed",
  "planned",
  "implementing",
  "verifying",
  "complete",
  "deprecated",
]);

const HEALTH_STATES = new Set([
  "unknown",
  "healthy",
  "warning",
  "failing",
  "unstable",
  "disputed",
]);

const PLAN_STATUSES = new Set(["draft", "ready", "active", "verifying", "complete", "blocked", "failed", "retest_required", "cancelled"]);
const PLAN_STEP_STATUSES = new Set(["pending", "active", "complete", "blocked", "failed", "skipped"]);
const DECISION_STATUSES = new Set(["proposed", "active", "superseded", "reconsidered"]);
const CHECKPOINT_STATUSES = new Set([
  "pending", "running", "passed", "partial_pass", "failed", "blocked", "not_supported", "retest_required",
]);
const CHECKPOINT_KINDS = new Set(["atomic", "aggregate", "integration"]);
const EVIDENCE_LEVELS = new Set(["none", "static", "simulated", "integration", "real_target", "human_review"]);
const EVIDENCE_LEVEL_RANK = new Map([...EVIDENCE_LEVELS].map((value, index) => [value, index]));

const LINK_KINDS = new Set([
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

const ARCHITECTURE_LAYERS = new Set([
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

const FOUNDATION_LAYER_ORDER = [
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

const EDITABLE_BLOCK_FIELDS = new Set([
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

const EDITABLE_CHAIN_FIELDS = new Set([
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

const EDITABLE_LINK_FIELDS = new Set([
  "kind",
  "label",
  "contract",
  "healthState",
  "archived",
]);

const EDITABLE_PLAN_FIELDS = new Set([
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

const EDITABLE_DECISION_FIELDS = new Set([
  "title",
  "summary",
  "rationale",
  "alternatives",
  "consequences",
  "status",
  "supersedesDecisionId",
  "archived",
]);

const EDITABLE_PLAN_CHAIN_SCOPE_FIELDS = new Set([
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

const EDITABLE_PLAN_CHANGE_FIELDS = new Set([
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

const LOCALIZED_FIELDS = {
  block: new Set(["title", "summary", "body", "contract"]),
  chain: new Set(["title", "intent", "inputContract", "outputContract"]),
  link: new Set(["label", "contract"]),
  plan: new Set(["title", "summary", "goal", "nextAction"]),
};

const LOCALES = new Set(["en", "zh-Hans"]);

function now() {
  return new Date().toISOString();
}

function identifier(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function changedHistoryFields(before = {}, after = {}, candidates = []) {
  return [...new Set(candidates)].filter((field) =>
    JSON.stringify(before?.[field] ?? null) !== JSON.stringify(after?.[field] ?? null),
  );
}

function serializeTags(value) {
  if (!Array.isArray(value)) return "[]";
  return JSON.stringify([...new Set(value.map(String).filter(Boolean))]);
}

function camelToColumn(field) {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function assertAllowed(value, allowed, label) {
  if (!allowed.has(value)) throw new Error(`Invalid ${label}: ${value}`);
}

function entityExists(database, projectId, type, id) {
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

function normalizeBlock(row) {
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

function normalizeDecision(row) {
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

function normalizeChain(row) {
  return {
    id: row.id,
    title: row.title,
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

function normalizeLink(row) {
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

function normalizePlan(row) {
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

function normalizePlanChainScope(row) {
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

function normalizePlanChange(row) {
  return {
    id: row.id, planId: row.plan_id, entityType: row.entity_type, entityId: row.entity_id,
    position: row.position, title: row.title, summary: row.summary,
    currentBehavior: row.current_behavior, proposedBehavior: row.proposed_behavior, rationale: row.rationale,
    prohibitions: parseJson(row.prohibitions_json, []), expectedEffects: parseJson(row.expected_effects_json, []),
    sourceRefs: parseJson(row.source_refs_json, []), localizations: parseJson(row.localizations_json, {}),
    status: row.status, currentRevision: row.current_revision, updatedAt: row.updated_at,
  };
}

function deriveCheckpointStates(checkpoints, dependencies) {
  const byId = new Map(checkpoints.map((checkpoint) => [checkpoint.id, { ...checkpoint, recordedStatus: checkpoint.status }]));
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

function checkpointSatisfiesGate(checkpoint) {
  return checkpoint?.status === "passed" && checkpoint.coverage === "complete" &&
    (EVIDENCE_LEVEL_RANK.get(checkpoint.evidenceLevel) ?? 0) >=
      (EVIDENCE_LEVEL_RANK.get(checkpoint.requiredEvidenceLevel) ?? 0) && !checkpoint.invalidatedAt;
}

function architectureCoverage(snapshot, planId = null) {
  const blocks = snapshot.blocks.filter((block) => block.deliveryState !== "deprecated" && block.kind !== "decision");
  const blockIds = new Set(blocks.map((block) => block.id));
  const chainBlockIds = new Set(snapshot.chainNodes.filter((node) => blockIds.has(node.blockId)).map((node) => node.blockId));
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
  const chainGateIds = new Set(planId ? [] : snapshot.checkpoints.filter((checkpoint) =>
    checkpoint.targetType === "chain" && checkpoint.checkpointKind === "integration",
  ).map((checkpoint) => checkpoint.targetId));
  for (const binding of snapshot.checkpointBindings) {
    if (!binding.required || binding.subjectType !== "plan_chain_scope") continue;
    const scope = snapshot.planChainScopes.find((item) => item.id === binding.subjectId && candidatePlanIds.has(item.planId));
    const checkpoint = snapshot.checkpoints.find((item) => item.id === binding.checkpointId);
    if (scope && checkpoint?.checkpointKind === "integration") chainGateIds.add(scope.chainId);
  }
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
    // for merely declaring an architectural Block.  Direct Plan work and
    // completed delivery explicitly request verification; an unplanned
    // proposed Block may remain checkpoint-free until its requirement is
    // understood.
    const checkpointRequired = plannedBlockIds.has(block.id) || block.deliveryState === "complete";
    return {
      blockId: block.id,
      hasCheckpoint,
      checkpointRequired,
      missingRequiredCheckpoint: checkpointRequired && !hasCheckpoint,
      isCoveredByPlan: plannedBlockIds.has(block.id),
      isCoveredByChain: chainBlockIds.has(block.id),
      isCoveredByAnyVerification,
      checkpointUnbound: plannedBlockIds.has(block.id) && hasCheckpoint && !hasExactPlanBinding,
      chainGateMissing: relevantChainIds.length > 0 && relevantChainIds.some((chainId) => !chainGateIds.has(chainId)),
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
    blockCoverage,
  };
}

function derivePlanState(
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
  } else if (plan.blockers.length || ownSteps.some((item) => item.status === "blocked") || requiredCheckpoints.some((item) => item.status === "blocked")) {
    derivedStatus = "blocked";
    derivedReason ||= "A required step, checkpoint, or explicit blocker prevents progress.";
  } else {
    const incompleteDependencies = ownDependencies.filter((item) => {
      const dependency = allPlans.find((candidate) => candidate.id === item.dependsOnPlanId);
      return dependency?.status !== "complete";
    });
    if (incompleteDependencies.length) {
      derivedStatus = "ready";
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

function normalizeLocalizations(rows) {
  return rows.map((row) => ({
    entityType: row.entity_type,
    entityId: row.entity_id,
    locale: row.locale,
    field: row.field,
    value: row.value,
  }));
}

function localizationMap(_snapshot) {
  // Legacy localizations remain readable in storage for compatibility, but project
  // facts are always emitted from their canonical field. App language is UI chrome.
  return null;
}

function localizedValue(_map, _type, _id, _locale, _field, fallback = "") {
  return fallback;
}

function localizedSearchText(_snapshot, _type, _id) {
  return "";
}

function operationEntityType(action) {
  if (action.includes("decision")) return "decision";
  if (action.includes("block") || ["add_source_ref", "remove_source_ref", "set_background_scopes"].includes(action)) return "block";
  if (action.includes("chain") && !action.startsWith("set_plan_")) return "chain";
  if (action.includes("link")) return "link";
  if (action.includes("plan")) return "plan";
  if (action.includes("checkpoint")) return "checkpoint";
  return null;
}

function affectedRefsForOperation(operation) {
  const refs = new Set();
  const fields = operation.fields ?? {};
  const add = (type, id) => { if (id) refs.add(`${type}:${id}`); };
  for (const id of fields.nodeIds ?? []) add("block", id);
  for (const id of fields.linkIds ?? []) add("link", id);
  for (const id of fields.chainIds ?? []) add("chain", id);
  for (const id of fields.planIds ?? []) add("plan", id);
  for (const id of fields.decisionIds ?? []) add("decision", id);
  if (fields.supersedesDecisionId) add("decision", fields.supersedesDecisionId);
  for (const scope of fields.scopes ?? []) {
    add("chain", scope.chainId);
    for (const id of scope.nodeIds ?? []) add("block", id);
    for (const id of scope.linkIds ?? []) add("link", id);
  }
  for (const change of fields.changes ?? []) add(change.entityType, change.entityId);
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

function taskTerms(task) {
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

function foundationBlockGroups(snapshot, blocks) {
  const remaining = new Map(blocks.map((block) => [block.id, block]));
  const dependencyIds = new Map(blocks.map((block) => [block.id, new Set()]));
  for (const link of snapshot.links) {
    if (link.kind !== "depends_on" || link.sourceType !== "block" || link.targetType !== "block") continue;
    if (dependencyIds.has(link.sourceId) && dependencyIds.has(link.targetId)) {
      dependencyIds.get(link.sourceId).add(link.targetId);
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

export class MdflowService {
  constructor(options = {}) {
    const resolvedOptions = typeof options === "string" ? { projectRoot: options } : options;
    this.paths = resolveProjectPaths(resolvedOptions);
    this.database = openDatabase(this.paths.databasePath);
    this.ensureProject();
    this.ensureSynced();
  }

  close() {
    this.database.close();
  }

  ensureSynced() {
    const graphJsonPath = this.paths.graphJsonPath;
    if (!graphJsonPath) return false;
    if (!fs.existsSync(graphJsonPath)) {
      const hasProject = this.database.prepare("SELECT count(*) as count FROM projects").get()?.count > 0;
      if (hasProject) {
        exportGraphToJson(this.database, graphJsonPath);
        return true;
      }
      return false;
    }

    const stat = fs.statSync(graphJsonPath);
    const meta = getSyncMeta(this.database);
    const hasProject = this.database.prepare("SELECT count(*) as count FROM projects").get()?.count > 0;

    if (!hasProject) {
      importGraphFromJson(this.database, graphJsonPath);
      return true;
    }

    if (meta.graph_json_mtime && Math.abs(stat.mtimeMs - Number(meta.graph_json_mtime)) < 10) {
      return false;
    }

    const content = fs.readFileSync(graphJsonPath, "utf8");
    const currentHash = crypto.createHash("sha256").update(content).digest("hex");
    if (meta.graph_json_hash !== currentHash) {
      importGraphFromJson(this.database, graphJsonPath);
      return true;
    } else {
      setSyncMeta(this.database, "graph_json_mtime", String(stat.mtimeMs));
      return false;
    }
  }

  ensureProject() {
    const timestamp = now();
    // The checkout path is runtime state, not canonical project truth. Store a
    // stable repository-relative marker so clones and Git worktrees do not
    // dirty the versioned graph merely by opening it. Snapshot readers expose
    // the resolved absolute root from `this.paths.projectRoot` instead.
    const storedRepoRoot = ".";
    this.database
      .prepare(
        `INSERT INTO projects(id, name, repo_root, schema_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, repo_root = excluded.repo_root,
           schema_version = excluded.schema_version, updated_at = excluded.updated_at
         WHERE projects.name IS NOT excluded.name
            OR projects.repo_root IS NOT excluded.repo_root
            OR projects.schema_version IS NOT excluded.schema_version`,
      )
      .run(
        this.paths.descriptor.id,
        this.paths.descriptor.name,
        storedRepoRoot,
        this.paths.descriptor.schemaVersion ?? 1,
        timestamp,
        timestamp,
      );
  }

  project() {
    this.ensureSynced();
    return this.database.prepare("SELECT * FROM projects WHERE id = ?").get(this.paths.descriptor.id);
  }

  snapshot() {
    this.ensureSynced();
    const projectId = this.paths.descriptor.id;
    const blocks = this.database
      .prepare("SELECT * FROM blocks WHERE project_id = ? AND archived = 0 ORDER BY title")
      .all(projectId)
      .map(normalizeBlock);
    const chains = this.database
      .prepare("SELECT * FROM chains WHERE project_id = ? AND archived = 0 ORDER BY updated_at DESC")
      .all(projectId)
      .map(normalizeChain);
    let plans = this.database
      .prepare("SELECT * FROM plans WHERE project_id = ? AND archived = 0 ORDER BY phase, plan_order, priority, updated_at DESC")
      .all(projectId)
      .map(normalizePlan);
    const links = this.database
      .prepare("SELECT * FROM links WHERE project_id = ? AND archived = 0 ORDER BY created_at")
      .all(projectId)
      .map(normalizeLink);
    const chainNodes = this.database
      .prepare(
        `SELECT cn.* FROM chain_nodes cn JOIN chains c ON c.id = cn.chain_id
         WHERE c.project_id = ? AND c.archived = 0 ORDER BY cn.chain_id, cn.position`,
      )
      .all(projectId)
      .map((row) => ({ chainId: row.chain_id, blockId: row.block_id, position: row.position, role: row.role }));
    const chainEdges = this.database
      .prepare(
        `SELECT ce.* FROM chain_edges ce JOIN chains c ON c.id = ce.chain_id
         WHERE c.project_id = ? AND c.archived = 0 ORDER BY ce.chain_id, ce.position`,
      )
      .all(projectId)
      .map((row) => ({ chainId: row.chain_id, linkId: row.link_id, position: row.position }));
    const planChainRefs = this.database
      .prepare(
        `SELECT pcr.* FROM plan_chain_refs pcr JOIN plans p ON p.id = pcr.plan_id
         WHERE p.project_id = ? AND p.archived = 0 ORDER BY pcr.plan_id, pcr.position`,
      )
      .all(projectId)
      .map((row) => ({ planId: row.plan_id, chainId: row.chain_id, position: row.position }));
    const planDependencies = this.database
      .prepare(
        `SELECT pd.* FROM plan_dependencies pd JOIN plans p ON p.id = pd.plan_id
         WHERE p.project_id = ? AND p.archived = 0 ORDER BY pd.plan_id, pd.position`,
      )
      .all(projectId)
      .map((row) => ({ planId: row.plan_id, dependsOnPlanId: row.depends_on_plan_id, position: row.position }));
    const planSteps = this.database
      .prepare(
        `SELECT ps.* FROM plan_steps ps JOIN plans p ON p.id = ps.plan_id
         WHERE p.project_id = ? AND p.archived = 0 ORDER BY ps.plan_id, ps.position`,
      )
      .all(projectId)
      .map((row) => ({
        id: row.id, planId: row.plan_id, position: row.position, title: row.title, action: row.action,
        status: row.status, targetRefs: parseJson(row.target_refs_json, []), proposedDelta: parseJson(row.proposed_delta_json, []),
        updatedAt: row.updated_at,
      }));
    const planCheckpointRefs = this.database
      .prepare(
        `SELECT pcr.* FROM plan_checkpoint_refs pcr JOIN plans p ON p.id = pcr.plan_id
         WHERE p.project_id = ? AND p.archived = 0 ORDER BY pcr.plan_id, pcr.position`,
      )
      .all(projectId)
      .map((row) => ({
        planId: row.plan_id, checkpointId: row.checkpoint_id, stepId: row.step_id,
        position: row.position, required: Boolean(row.required),
      }));
    const planChainScopes = this.database
      .prepare(
        `SELECT pcs.* FROM plan_chain_scopes pcs JOIN plans p ON p.id = pcs.plan_id
         WHERE p.project_id = ? AND p.archived = 0 ORDER BY pcs.plan_id, pcs.position`,
      )
      .all(projectId)
      .map(normalizePlanChainScope);
    const planChanges = this.database
      .prepare(
        `SELECT pc.* FROM plan_changes pc JOIN plans p ON p.id = pc.plan_id
         WHERE p.project_id = ? AND p.archived = 0 ORDER BY pc.plan_id, pc.position`,
      )
      .all(projectId)
      .map(normalizePlanChange);
    const planChainChangeRefs = this.database
      .prepare(
        `SELECT pccr.* FROM plan_chain_change_refs pccr
         JOIN plan_chain_scopes pcs ON pcs.id = pccr.chain_scope_id
         JOIN plans p ON p.id = pcs.plan_id
         WHERE p.project_id = ? AND p.archived = 0 ORDER BY pccr.chain_scope_id, pccr.position`,
      )
      .all(projectId)
      .map((row) => ({
        chainScopeId: row.chain_scope_id, planChangeId: row.plan_change_id,
        role: row.role, position: row.position,
      }));
    const backgroundScopes = this.database
      .prepare(
        `SELECT bs.* FROM background_scopes bs JOIN blocks b ON b.id = bs.block_id
         WHERE b.project_id = ? ORDER BY bs.block_id, bs.scope_type, bs.scope_value`,
      )
      .all(projectId)
      .map((row) => ({ blockId: row.block_id, scopeType: row.scope_type, scopeValue: row.scope_value }));
    const decisions = this.database
      .prepare("SELECT * FROM decisions WHERE project_id = ? AND archived = 0 ORDER BY updated_at DESC, id")
      .all(projectId)
      .map(normalizeDecision);
    const decisionScopes = this.database
      .prepare(
        `SELECT ds.* FROM decision_scopes ds JOIN decisions d ON d.id = ds.decision_id
         WHERE d.project_id = ? AND d.archived = 0 ORDER BY ds.decision_id, ds.scope_type, ds.scope_value`,
      )
      .all(projectId)
      .map((row) => ({ decisionId: row.decision_id, scopeType: row.scope_type, scopeValue: row.scope_value }));
    const sourceRefs = this.database
      .prepare(
        `SELECT sr.* FROM source_refs sr JOIN blocks b ON b.id = sr.block_id
         WHERE b.project_id = ? ORDER BY sr.path, sr.start_line`,
      )
      .all(projectId)
      .map((row) => ({
        id: row.id,
        blockId: row.block_id,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        symbol: row.symbol,
        role: row.role,
        gitCommit: row.git_commit,
      }));
    const rawCheckpoints = this.database
      .prepare("SELECT * FROM checkpoints WHERE project_id = ? ORDER BY updated_at DESC, id ASC")
      .all(projectId)
      .map((row) => ({
        id: row.id,
        targetType: row.target_type,
        targetId: row.target_id,
        title: row.title,
        criteria: row.criteria,
        status: row.status,
        checkpointKind: row.checkpoint_kind,
        aggregationPolicy: parseJson(row.aggregation_policy_json, {}),
        eligibleAfterChildren: Boolean(row.eligible_after_children),
        evidenceLevel: row.evidence_level,
        requiredEvidenceLevel: row.required_evidence_level,
        coverage: row.coverage,
        evidence: parseJson(row.evidence_json, []),
        invalidatedAt: row.invalidated_at,
        currentRevision: row.current_revision,
        updatedAt: row.updated_at,
      }));
    const checkpointBindings = this.database
      .prepare(
        `SELECT cb.* FROM checkpoint_bindings cb JOIN checkpoints c ON c.id = cb.checkpoint_id
         WHERE c.project_id = ? ORDER BY cb.checkpoint_id, cb.position`,
      )
      .all(projectId)
      .map((row) => ({
        checkpointId: row.checkpoint_id, subjectType: row.subject_type, subjectId: row.subject_id,
        role: row.role, required: Boolean(row.required), position: row.position,
      }));
    const checkpointDependencies = this.database
      .prepare(
        `SELECT cd.* FROM checkpoint_dependencies cd JOIN checkpoints c ON c.id = cd.parent_checkpoint_id
         WHERE c.project_id = ? ORDER BY cd.parent_checkpoint_id, cd.position`,
      )
      .all(projectId)
      .map((row) => ({
        parentCheckpointId: row.parent_checkpoint_id, childCheckpointId: row.child_checkpoint_id,
        position: row.position, required: Boolean(row.required),
      }));
    const checkpoints = deriveCheckpointStates(rawCheckpoints, checkpointDependencies);
    plans = plans.map((plan) => derivePlanState(
      plan, plans, planDependencies, planSteps, planCheckpointRefs, checkpoints,
      planChainScopes, planChanges, checkpointBindings,
    ));
    const localizations = normalizeLocalizations(
      this.database
        .prepare(
          `SELECT lt.* FROM localized_text lt
           WHERE EXISTS (
             SELECT 1 FROM blocks b WHERE b.project_id = ? AND lt.entity_type = 'block' AND b.id = lt.entity_id
             UNION ALL
             SELECT 1 FROM chains c WHERE c.project_id = ? AND lt.entity_type = 'chain' AND c.id = lt.entity_id
             UNION ALL
             SELECT 1 FROM links l WHERE l.project_id = ? AND lt.entity_type = 'link' AND l.id = lt.entity_id
             UNION ALL
             SELECT 1 FROM plans p WHERE p.project_id = ? AND lt.entity_type = 'plan' AND p.id = lt.entity_id
           )`,
        )
        .all(projectId, projectId, projectId, projectId),
    );
    const changeSequence =
      this.database
        .prepare("SELECT COALESCE(MAX(sequence), 0) AS value FROM change_feed WHERE project_id = ?")
        .get(projectId).value ?? 0;

    return {
      project: {
        id: projectId,
        name: this.paths.descriptor.name,
        graphRevision: this.project().graph_revision,
        root: this.paths.projectRoot,
      },
      changeSequence,
      blocks,
      chains,
      plans,
      links,
      chainNodes,
      chainEdges,
      planChainRefs,
      planDependencies,
      planSteps,
      planCheckpointRefs,
      planChainScopes,
      planChanges,
      planChainChangeRefs,
      backgroundScopes,
      decisions,
      decisionScopes,
      sourceRefs,
      checkpoints,
      checkpointBindings,
      checkpointDependencies,
      localizations,
    };
  }

  chainCodeStream({ chainId, maxTotalChars = 4000 } = {}) {
    if (!chainId?.trim()) throw new Error("chainId is required");
    this.ensureSynced();
    const snapshot = this.snapshot();
    const chain = snapshot.chains.find((c) => c.id === chainId);
    if (!chain) throw new Error(`Chain not found: ${chainId}`);

    const nodeIds = snapshot.chainNodes
      .filter((node) => node.chainId === chain.id)
      .sort((a, b) => a.position - b.position)
      .map((node) => node.blockId);

    const streamNodes = [];
    for (const blockId of nodeIds) {
      const block = snapshot.blocks.find((b) => b.id === blockId);
      if (!block) continue;

      const sourceRefs = this.database
        .prepare("SELECT path, start_line, end_line, symbol, role FROM source_refs WHERE block_id = ? ORDER BY id")
        .all(block.id);

      let code = null;
      let filePath = null;
      let symbol = null;

      if (sourceRefs.length > 0) {
        const ref = sourceRefs[0];
        filePath = ref.path;
        symbol = ref.symbol;
        const fullPath = path.isAbsolute(filePath)
          ? filePath
          : path.resolve(this.paths.projectRoot, filePath);
        try {
          if (fs.existsSync(fullPath)) {
            const content = fs.readFileSync(fullPath, "utf8");
            const slice = extractSymbolSlice(content, {
              symbol: ref.symbol,
              startLine: ref.start_line,
              endLine: ref.end_line,
              maxLines: 40,
            });
            code = slice.code;
          }
        } catch {
          code = null;
        }
      }

      streamNodes.push({
        blockId: block.id,
        title: block.title,
        filePath,
        symbol,
        code,
        contract: block.contract || block.summary,
      });
    }

    const codeStream = buildChainCodeStream(streamNodes, { maxTotalChars });
    return {
      chainId: chain.id,
      title: chain.title,
      nodes: streamNodes,
      codeStream,
      markdown: [
        `# Chain Code Stream: ${chain.title} (${chain.id})`,
        `Nodes: ${streamNodes.length} · Sliced from AST symbol facades`,
        "",
        codeStream,
      ].join("\n"),
    };
  }

  sanitizeLog({ rawOutput, maxChars = 3000, exitCode = null } = {}) {
    return sanitizeTerminalOutput(rawOutput, { maxChars, exitCode });
  }

  mutateBlockCode({ blockId, symbol, newCode, verifyCommand = null } = {}) {
    if (!blockId?.trim()) throw new Error("blockId is required");
    if (!symbol?.trim()) throw new Error("symbol is required");
    if (typeof newCode !== "string") throw new Error("newCode is required");

    this.ensureSynced();
    const snapshot = this.snapshot();
    const block = snapshot.blocks.find((b) => b.id === blockId);
    if (!block) throw new Error(`Block not found: ${blockId}`);

    const sourceRefs = snapshot.sourceRefs.filter((ref) => ref.blockId === block.id);
    if (!sourceRefs.length) {
      throw new Error(`Block "${blockId}" has no bound source files (virtual blueprint)`);
    }

    const ref = sourceRefs.find((r) => r.symbol === symbol) || sourceRefs[0];
    const filePath = ref.path;
    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.paths.projectRoot, filePath);

    if (!fs.existsSync(fullPath)) {
      throw new Error(`Source file not found at ${fullPath}`);
    }

    const originalCode = fs.readFileSync(fullPath, "utf8");
    const lang = detectLanguage(fullPath);
    const { updatedCode, replacedLines } = replaceSymbolSlice(originalCode, {
      symbol,
      newCode,
      language: lang,
    });

    // Write modified code to disk
    fs.writeFileSync(fullPath, updatedCode, "utf8");

    // Optional verification with sanitizer and auto-rollback
    if (verifyCommand) {
      try {
        const rawOutput = execSync(verifyCommand, {
          cwd: this.paths.projectRoot,
          encoding: "utf8",
          stdio: "pipe",
        });
        const sanitized = sanitizeTerminalOutput(rawOutput);
        return {
          success: true,
          blockId,
          symbol,
          filePath,
          replacedLines,
          verification: {
            passed: true,
            command: verifyCommand,
            output: sanitized.text,
          },
        };
      } catch (err) {
        // Automatic rollback on verification failure!
        fs.writeFileSync(fullPath, originalCode, "utf8");
        const rawError = (err.stdout || "") + "\n" + (err.stderr || "") + "\n" + err.message;
        const sanitized = sanitizeTerminalOutput(rawError);
        return {
          success: false,
          blockId,
          symbol,
          filePath,
          error: "Verification test failed. Source code automatically rolled back.",
          verification: {
            passed: false,
            command: verifyCommand,
            output: sanitized.text,
          },
        };
      }
    }

    return {
      success: true,
      blockId,
      symbol,
      filePath,
      replacedLines,
    };
  }

  projectMap({ locale = "en" } = {}) {
    const snapshot = this.snapshot();
    const coverage = architectureCoverage(snapshot);
    const graphBlocks = snapshot.blocks.filter((block) => block.kind !== "decision");
    assertAllowed(locale, LOCALES, "locale");
    const translations = localizationMap(snapshot);
    const layerCounts = Object.fromEntries(
        [...ARCHITECTURE_LAYERS]
        .map((layer) => [layer, graphBlocks.filter((block) => block.architectureLayer === layer).length])
        .filter(([, count]) => count > 0),
    );
    const scopeCounts = Object.fromEntries(
      [...new Set(graphBlocks.map((block) => block.scope))]
        .sort()
        .map((scope) => [scope, graphBlocks.filter((block) => block.scope === scope).length]),
    );
    const architectureGroups = [...new Set(graphBlocks.map((block) => `${block.architectureLayer}\u0000${block.scope}`))]
      .sort()
      .map((key) => {
        const [layer, scope] = key.split("\u0000");
        const members = graphBlocks
          .filter((block) => block.architectureLayer === layer && block.scope === scope)
          .sort((left, right) => left.localOrder - right.localOrder || left.id.localeCompare(right.id));
        return {
          layer,
          scope,
          count: members.length,
          blockRefs: members.slice(0, 50).map((block) => `block:${block.id}`),
          truncated: members.length > 50,
        };
      });
    const lines = [
      `# ${snapshot.project.name}`,
      `Graph revision: ${snapshot.project.graphRevision}`,
      "",
      "## Plans",
    ];
    const plans = snapshot.plans;
    if (plans.length === 0) lines.push("- None");
    for (const plan of plans) {
      const count = snapshot.planChainRefs.filter((item) => item.planId === plan.id).length;
      const title = localizedValue(translations, "plan", plan.id, locale, "title", plan.title);
      const progress = `${plan.progress.completedSteps}/${plan.progress.totalSteps} steps · ${plan.progress.passedRequiredCheckpoints}/${plan.progress.totalRequiredCheckpoints} gates`;
      lines.push(
        `- [plan:${plan.id}] ${title} — ${plan.phase} #${plan.planOrder} · ${plan.priority} · ${plan.derivedStatus} · ${progress} · ${count} target chain(s)`,
      );
      if (plan.derivedReason) lines.push(`  ${plan.derivedReason}`);
    }
    lines.push("", "## Project network");
    lines.push(`- ${graphBlocks.length} Blocks / ${snapshot.links.length} Links / ${snapshot.chains.length} Chain overlays`);
    lines.push(`- ${snapshot.decisions.length} Decisions (scoped index; expand a record on demand)`);
    lines.push(`- Coverage: ${coverage.verified}/${coverage.totalBlocks} verified · ${coverage.planned}/${coverage.totalBlocks} planned · ${coverage.withCheckpoint}/${coverage.totalBlocks} with checkpoints`);
    lines.push(`- Verification coverage: ${coverage.verificationCovered}/${coverage.totalBlocks} bound or passed · ${coverage.inChains} in Chains · ${coverage.outsideChainIds.length} standalone`);
    lines.push(`- Architecture coverage: ${coverage.directPlanBlocks} direct Plan Blocks · ${coverage.chainPlanBlocks} through Chains · ${coverage.unverifiedIds.length} unverified · ${coverage.failingIds.length} failing`);
    if (coverage.unverifiedIds.length) lines.push(`- Unverified Blocks: ${coverage.unverifiedIds.slice(0, 12).map((id) => `block:${id}`).join(", ")}${coverage.unverifiedIds.length > 12 ? " …" : ""}`);
    if (coverage.failingIds.length) lines.push(`- Failed verification: ${coverage.failingIds.slice(0, 12).map((id) => `block:${id}`).join(", ")}${coverage.failingIds.length > 12 ? " …" : ""}`);
    if (coverage.outsideChainIds.length) lines.push(`- Outside Chains: ${coverage.outsideChainIds.slice(0, 12).map((id) => `block:${id}`).join(", ")}${coverage.outsideChainIds.length > 12 ? " …" : ""}`);
    if (coverage.unplannedIds.length) lines.push(`- Unplanned Blocks: ${coverage.unplannedIds.slice(0, 12).map((id) => `block:${id}`).join(", ")}${coverage.unplannedIds.length > 12 ? " …" : ""}`);
    if (coverage.withoutCheckpointIds.length) lines.push(`- Checkpoint-free Blocks (verification not requested yet): ${coverage.withoutCheckpointIds.slice(0, 12).map((id) => `block:${id}`).join(", ")}${coverage.withoutCheckpointIds.length > 12 ? " …" : ""}`);
    if (coverage.requiredCheckpointMissingIds.length) lines.push(`- Required checkpoints missing: ${coverage.requiredCheckpointMissingIds.slice(0, 12).map((id) => `block:${id}`).join(", ")}${coverage.requiredCheckpointMissingIds.length > 12 ? " …" : ""}`);
    if (coverage.checkpointUnboundIds.length) lines.push(`- Unbound Block checkpoints: ${coverage.checkpointUnboundIds.slice(0, 12).map((id) => `block:${id}`).join(", ")}${coverage.checkpointUnboundIds.length > 12 ? " …" : ""}`);
    if (coverage.chainGateMissingIds.length) lines.push(`- Missing Chain integration gates: ${coverage.chainGateMissingIds.slice(0, 12).map((id) => `block:${id}`).join(", ")}${coverage.chainGateMissingIds.length > 12 ? " …" : ""}`);
    lines.push(`- Architecture layers: ${Object.entries(layerCounts).map(([layer, count]) => `${layer} ${count}`).join(" · ") || "None"}`);
    lines.push(`- Scopes: ${Object.entries(scopeCounts).map(([scope, count]) => `${scope} ${count}`).join(" · ") || "None"}`);
    for (const block of graphBlocks.filter((item) => item.priority === "critical").slice(0, 8)) {
      const title = localizedValue(translations, "block", block.id, locale, "title", block.title);
      lines.push(`- [block:${block.id}] ${title} — ${block.deliveryState}/${block.healthState}`);
    }
    if (snapshot.decisions.length) {
      lines.push("", "## Decision index");
      for (const decision of snapshot.decisions.slice(0, 12)) {
        const scopes = snapshot.decisionScopes.filter((scope) => scope.decisionId === decision.id)
          .map((scope) => `${scope.scopeType}:${scope.scopeValue}`);
        lines.push(`- [decision:${decision.id}] ${decision.title} · ${decision.status}${scopes.length ? ` · scopes ${scopes.join(", ")}` : ""} · use decision_open for rationale`);
      }
      if (snapshot.decisions.length > 12) lines.push(`- … ${snapshot.decisions.length - 12} more; use decision_list for the complete index.`);
    }
    return {
      map: {
        project: snapshot.project,
        changeSequence: snapshot.changeSequence,
        counts: {
          blocks: graphBlocks.length,
          links: snapshot.links.length,
          chains: snapshot.chains.length,
          plans: snapshot.plans.length,
          decisions: snapshot.decisions.length,
        },
        architecture: {
          layerCounts,
          scopeCounts,
          groups: architectureGroups,
          coverage,
        },
        plans: plans.map((plan) => ({
          id: plan.id,
          title: localizedValue(translations, "plan", plan.id, locale, "title", plan.title),
          status: plan.status,
          derivedStatus: plan.derivedStatus,
          derivedReason: plan.derivedReason,
          priority: plan.priority,
          phase: plan.phase,
          order: plan.planOrder,
          progress: plan.progress,
          typedProgress: plan.typedProgress,
          dependencyPlanIds: snapshot.planDependencies.filter((item) => item.planId === plan.id).sort((a, b) => a.position - b.position).map((item) => item.dependsOnPlanId),
          targetChainIds: snapshot.planChainRefs.filter((item) => item.planId === plan.id).sort((a, b) => a.position - b.position).map((item) => item.chainId),
        })),
        criticalBlocks: graphBlocks.filter((item) => item.priority === "critical").slice(0, 8).map((block) => ({
          id: block.id,
          title: localizedValue(translations, "block", block.id, locale, "title", block.title),
          deliveryState: block.deliveryState,
          healthState: block.healthState,
        })),
        decisions: snapshot.decisions.map((decision) => ({
          id: decision.id,
          title: decision.title,
          status: decision.status,
          scopes: snapshot.decisionScopes.filter((scope) => scope.decisionId === decision.id),
        })),
      },
      markdown: lines.join("\n"),
    };
  }

  decisionList({ locale = "en" } = {}) {
    const snapshot = this.snapshot();
    assertAllowed(locale, LOCALES, "locale");
    const decisions = snapshot.decisions.map((decision) => ({
      id: decision.id,
      title: decision.title,
      summary: decision.summary,
      status: decision.status,
      currentRevision: decision.currentRevision,
      supersedesDecisionId: decision.supersedesDecisionId,
      scopes: snapshot.decisionScopes
        .filter((scope) => scope.decisionId === decision.id)
        .map((scope) => ({ type: scope.scopeType, value: scope.scopeValue })),
    }));
    const lines = ["# Decision index", `- Graph revision: ${snapshot.project.graphRevision}`, `- Count: ${decisions.length}`, ""];
    for (const decision of decisions) {
      const scopes = decision.scopes.map((scope) => `${scope.type}:${scope.value}`).join(", ");
      lines.push(`- [decision:${decision.id}] ${decision.title} · ${decision.status}${scopes ? ` · scopes ${scopes}` : ""} · use decision_open for rationale`);
    }
    return { decisions, markdown: lines.join("\n") };
  }

  search({ query, kinds = [], states = [], limit = 20, locale = "en" }) {
    const term = `%${query.trim()}%`;
    const terms = taskTerms(query);
    const snapshot = this.snapshot();
    assertAllowed(locale, LOCALES, "locale");
    const translations = localizationMap(snapshot);
    const kindSet = new Set(kinds);
    const stateSet = new Set(states);
    const score = (text) => terms.reduce((total, item) => total + (text.toLowerCase().includes(item) ? 1 : 0), 0);
    const blocks = snapshot.blocks.filter((block) => block.kind !== "decision").map((block) => {
      const text = `${block.title}\n${block.summary}\n${block.body}\n${block.contract}\n${block.scope}\n${block.architectureLayer}\n${block.tags.join(" ")}\n${localizedSearchText(snapshot, "block", block.id)}`;
      return { item: block, score: score(text) };
    }).filter(({ item: block, score }) => {
      return (score > 0 &&
        (kindSet.size === 0 || kindSet.has(block.kind)) &&
        (stateSet.size === 0 || stateSet.has(block.deliveryState) || stateSet.has(block.healthState))
      );
    }).sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id)).map(({ item }) => item);
    const chains = snapshot.chains.map((chain) => {
      const text = `${chain.title}\n${chain.intent}\n${chain.inputContract}\n${chain.outputContract}\n${localizedSearchText(snapshot, "chain", chain.id)}`;
      return { item: chain, score: score(text) };
    }).filter(({ item: chain, score }) => {
      return (score > 0 &&
        (kindSet.size === 0 || kindSet.has("chain")) &&
        (stateSet.size === 0 || stateSet.has(chain.deliveryState) || stateSet.has(chain.healthState))
      );
    }).sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id)).map(({ item }) => item);
    const plans = snapshot.plans.map((plan) => {
      const text = `${plan.title}\n${plan.summary}\n${plan.goal}\n${plan.status}\n${plan.nextAction}\n${JSON.stringify(plan.blockers)}\n${localizedSearchText(snapshot, "plan", plan.id)}`;
      return { item: plan, score: score(text) };
    }).filter(({ item: plan, score }) => score > 0 &&
        (kindSet.size === 0 || kindSet.has("plan")) &&
        (stateSet.size === 0 || stateSet.has(plan.status)))
      .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id)).map(({ item }) => item);
    const decisions = snapshot.decisions.map((decision) => {
      const text = `${decision.title}\n${decision.summary}\n${decision.rationale}\n${decision.status}\n${JSON.stringify(decision.alternatives)}\n${JSON.stringify(decision.consequences)}`;
      return { item: decision, score: score(text) };
    }).filter(({ item: decision, score }) => score > 0 &&
      (kindSet.size === 0 || kindSet.has("decision")) &&
      (stateSet.size === 0 || stateSet.has(decision.status)))
      .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id)).map(({ item }) => item);
    const sourceRows = this.database
      .prepare(
        `SELECT sr.*, b.title FROM source_refs sr JOIN blocks b ON b.id = sr.block_id
         WHERE b.project_id = ? AND (sr.path LIKE ? OR COALESCE(sr.symbol, '') LIKE ?) LIMIT ?`,
      )
      .all(this.paths.descriptor.id, term, term, limit);
    const searchItems = [
      ...blocks.map((block) => `- [block:${block.id}] ${localizedValue(translations, "block", block.id, locale, "title", block.title)} · ${block.deliveryState}`),
      ...chains.map((chain) => `- [chain:${chain.id}] ${localizedValue(translations, "chain", chain.id, locale, "title", chain.title)} · ${chain.deliveryState}`),
      ...plans.map((plan) => `- [plan:${plan.id}] ${localizedValue(translations, "plan", plan.id, locale, "title", plan.title)} · ${plan.status}`),
      ...decisions.map((decision) => `- [decision:${decision.id}] ${decision.title} · ${decision.status} · use decision_open for rationale`),
      ...sourceRows.map((row) => `- [source:${row.id}] ${localizedValue(translations, "block", row.block_id, locale, "title", row.title)} · ${row.path}${row.start_line ? `:${row.start_line}` : ""}`),
    ].slice(0, limit);
    return {
      query,
      results: [
        ...blocks.map((block) => ({ type: "block", id: block.id, title: localizedValue(translations, "block", block.id, locale, "title", block.title), state: block.deliveryState })),
        ...chains.map((chain) => ({ type: "chain", id: chain.id, title: localizedValue(translations, "chain", chain.id, locale, "title", chain.title), state: chain.deliveryState })),
        ...plans.map((plan) => ({ type: "plan", id: plan.id, title: localizedValue(translations, "plan", plan.id, locale, "title", plan.title), state: plan.status })),
        ...decisions.map((decision) => ({ type: "decision", id: decision.id, title: decision.title, state: decision.status })),
        ...sourceRows.map((row) => ({
          type: "source",
          id: row.id,
          title: `${localizedValue(translations, "block", row.block_id, locale, "title", row.title)}: ${row.path}${row.start_line ? `:${row.start_line}` : ""}`,
          blockId: row.block_id,
        })),
      ].slice(0, limit),
      markdown: [
        `# Search: ${query}`,
        `Count: ${searchItems.length}`,
        "",
        ...searchItems,
      ].join("\n"),
    };
  }

  entityOpen({ type, id, historyLimit = 8, locale = "en" }) {
    const projectId = this.paths.descriptor.id;
    let entity;
    if (type === "block") {
      const row = this.database.prepare("SELECT * FROM blocks WHERE project_id = ? AND id = ?").get(projectId, id);
      if (row) entity = normalizeBlock(row);
    } else if (type === "chain") {
      const row = this.database.prepare("SELECT * FROM chains WHERE project_id = ? AND id = ?").get(projectId, id);
      if (row) entity = normalizeChain(row);
    } else if (type === "link") {
      const row = this.database.prepare("SELECT * FROM links WHERE project_id = ? AND id = ?").get(projectId, id);
      if (row) entity = normalizeLink(row);
    } else if (type === "plan") {
      const row = this.database.prepare("SELECT * FROM plans WHERE project_id = ? AND id = ?").get(projectId, id);
      if (row) entity = normalizePlan(row);
    } else if (type === "decision") {
      const row = this.database.prepare("SELECT * FROM decisions WHERE project_id = ? AND id = ?").get(projectId, id);
      if (row) entity = normalizeDecision(row);
    }
    if (!entity) throw new Error(`${type}:${id} not found`);

    const checkpoints = this.database
      .prepare(type === "plan"
        ? `SELECT DISTINCT c.* FROM checkpoints c
           LEFT JOIN plan_checkpoint_refs pcr ON pcr.checkpoint_id = c.id
           WHERE c.project_id = ? AND ((c.target_type = ? AND c.target_id = ?) OR pcr.plan_id = ?)
           ORDER BY c.updated_at DESC`
        : "SELECT * FROM checkpoints WHERE project_id = ? AND target_type = ? AND target_id = ? ORDER BY updated_at DESC",
      )
      .all(...(type === "plan" ? [projectId, type, id, id] : [projectId, type, id]))
      .map((row) => ({
        id: row.id,
        targetType: row.target_type,
        targetId: row.target_id,
        title: row.title,
        criteria: row.criteria,
        status: row.status,
        evidenceLevel: row.evidence_level,
        requiredEvidenceLevel: row.required_evidence_level,
        coverage: row.coverage,
        evidence: parseJson(row.evidence_json, []),
        invalidatedAt: row.invalidated_at,
        updatedAt: row.updated_at,
      }));
    const history = this.database
      .prepare(
        `SELECT h.* FROM history h JOIN change_sets cs ON cs.id = h.change_set_id
         WHERE cs.project_id = ? AND h.entity_type = ? AND h.entity_id = ?
         ORDER BY h.id DESC LIMIT ?`,
      )
      .all(projectId, type, id, historyLimit)
      .map((row) => ({
        action: row.action,
        revision: row.revision,
        summary: row.summary,
        createdAt: row.created_at,
      }));
    const sourceRefs =
      type === "block"
        ? this.database
            .prepare("SELECT * FROM source_refs WHERE block_id = ? ORDER BY created_at")
            .all(id)
            .map((row) => ({
              id: row.id,
              path: row.path,
              startLine: row.start_line,
              endLine: row.end_line,
              symbol: row.symbol,
              role: row.role,
              gitCommit: row.git_commit,
            }))
        : [];
    const decisionScopes = type === "decision"
      ? this.database.prepare("SELECT scope_type, scope_value FROM decision_scopes WHERE decision_id = ? ORDER BY scope_type, scope_value").all(id)
        .map((row) => ({ scopeType: row.scope_type, scopeValue: row.scope_value }))
      : [];
    const pathNodes =
      type === "chain"
        ? this.database
            .prepare("SELECT chain_id, 'block' AS member_type, block_id AS member_id, position FROM chain_nodes WHERE chain_id = ? ORDER BY position")
            .all(id)
            .map((row) => ({
              memberType: row.member_type,
              memberId: row.member_id,
              position: row.position,
            }))
        : [];
    const pathEdges =
      type === "chain"
        ? this.database.prepare("SELECT link_id, position FROM chain_edges WHERE chain_id = ? ORDER BY position").all(id)
            .map((row) => ({ linkId: row.link_id, position: row.position }))
        : [];
    const targetChains =
      type === "plan"
        ? this.database.prepare("SELECT chain_id, position FROM plan_chain_refs WHERE plan_id = ? ORDER BY position").all(id)
            .map((row) => ({ chainId: row.chain_id, position: row.position }))
        : [];
    const dependencies = type === "plan"
      ? this.database.prepare("SELECT depends_on_plan_id, position FROM plan_dependencies WHERE plan_id = ? ORDER BY position").all(id)
          .map((row) => ({ planId: row.depends_on_plan_id, position: row.position }))
      : [];
    const steps = type === "plan"
      ? this.database.prepare("SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY position").all(id).map((row) => ({
          id: row.id, position: row.position, title: row.title, action: row.action, status: row.status,
          targetRefs: parseJson(row.target_refs_json, []), proposedDelta: parseJson(row.proposed_delta_json, []),
        }))
      : [];
    const checkpointRefs = type === "plan"
      ? this.database.prepare("SELECT checkpoint_id, step_id, position, required FROM plan_checkpoint_refs WHERE plan_id = ? ORDER BY position").all(id)
          .map((row) => ({ checkpointId: row.checkpoint_id, stepId: row.step_id, position: row.position, required: Boolean(row.required) }))
      : [];

    assertAllowed(locale, LOCALES, "locale");
    const snapshot = this.snapshot();
    const translations = localizationMap(snapshot);
    const coverage = type === "block"
      ? architectureCoverage(snapshot).blockCoverage.find((item) => item.blockId === id) ?? null
      : null;
    const ruleScopes = type === "block"
      ? snapshot.backgroundScopes.filter((scope) => scope.blockId === id)
      : [];
    const field = type === "link" ? "label" : "title";
    const displayTitle = localizedValue(translations, type, id, locale, field, entity[field] ?? `${type}:${id}`);
    const displaySummary = localizedValue(translations, type, id, locale, type === "chain" ? "intent" : "summary", entity.intent ?? entity.summary ?? "");
    const displayContract = localizedValue(translations, type, id, locale, "contract", entity.contract ?? "");
    const displayInput = localizedValue(translations, type, id, locale, "inputContract", entity.inputContract ?? "");
    const displayOutput = localizedValue(translations, type, id, locale, "outputContract", entity.outputContract ?? "");
    const lines = [`# ${displayTitle}`, ""];
    lines.push(`- Ref: ${type}:${id}`);
    lines.push(`- Revision: ${entity.currentRevision}`);
    if (type === "block") {
      lines.push(`- Architecture: ${entity.architectureLayer}`);
      lines.push(`- Scope: ${entity.scope}`);
      lines.push(`- Local order: ${entity.localOrder}`);
      if (ruleScopes.length) {
        lines.push(`- Rule scopes: ${ruleScopes.map((scope) => `${scope.scopeType}:${scope.scopeValue}`).join(", ")} (background; not a Canvas Block)`);
      }
      if (coverage) {
        lines.push(`- Coverage: checkpoint=${coverage.hasCheckpoint ? "yes" : "no"} · required=${coverage.checkpointRequired ? "yes" : "no"} · requiredMissing=${coverage.missingRequiredCheckpoint ? "yes" : "no"} · plan=${coverage.isCoveredByPlan ? "yes" : "no"} · chain=${coverage.isCoveredByChain ? "yes" : "no"} · verification=${coverage.isCoveredByAnyVerification ? "yes" : "no"}`);
      }
    }
    if (type === "decision" && decisionScopes.length) {
      lines.push(`- Scopes: ${decisionScopes.map((scope) => `${scope.scopeType}:${scope.scopeValue}`).join(", ")} (background; not a Canvas entity)`);
    }
    if (entity.deliveryState) lines.push(`- Delivery: ${entity.deliveryState}`);
    if (entity.status) lines.push(`- Status: ${entity.status}`);
    if (type === "plan") {
      lines.push(`- Phase: ${entity.phase}`);
      lines.push(`- Order: ${entity.planOrder}`);
      lines.push(`- Priority: ${entity.priority}`);
    }
    if (entity.healthState) lines.push(`- Health: ${entity.healthState}`);
    if (displaySummary) lines.push("", "## Summary", displaySummary);
    if (type === "block") {
      const displayBody = localizedValue(translations, type, id, locale, "body", entity.body ?? "");
      if (displayBody) lines.push("", "## Details", displayBody);
    }
    if (type === "decision") {
      if (entity.rationale) lines.push("", "## Rationale", entity.rationale);
      if (entity.alternatives.length) lines.push("", "## Alternatives", ...entity.alternatives.map((item) => `- ${typeof item === "string" ? item : JSON.stringify(item)}`));
      if (entity.consequences.length) lines.push("", "## Consequences", ...entity.consequences.map((item) => `- ${typeof item === "string" ? item : JSON.stringify(item)}`));
      if (entity.supersedesDecisionId) lines.push("", "## Supersedes", `[decision:${entity.supersedesDecisionId}]`);
    }
    if (displayContract) lines.push("", "## Contract", displayContract);
    if (entity.inputContract || entity.outputContract) {
      lines.push("", "## Contract", `Input: ${displayInput || "—"}`, `Output: ${displayOutput || "—"}`);
    }
    if (type === "plan") {
      const goal = localizedValue(translations, type, id, locale, "goal", entity.goal);
      const nextAction = localizedValue(translations, type, id, locale, "nextAction", entity.nextAction);
      if (goal) lines.push("", "## Goal", goal);
      if (nextAction) lines.push("", "## Next action", nextAction);
      const scopeChainIDs = snapshot.planChainScopes.filter((scope) => scope.planId === id).sort((left, right) => left.position - right.position).map((scope) => scope.chainId);
      const allTargetChainIDs = [...new Set([...targetChains.map((target) => target.chainId), ...scopeChainIDs])];
      if (allTargetChainIDs.length) {
        lines.push("", "## Target chains");
        for (const chainID of allTargetChainIDs) lines.push(`- [chain:${chainID}]`);
      }
      if (dependencies.length) {
        lines.push("", "## Prerequisites", ...dependencies.map((item) => `- [plan:${item.planId}]`));
      }
      if (steps.length) {
        lines.push("", "## Ordered steps");
        for (const step of steps) lines.push(`${step.position + 1}. ${step.status}: ${step.title}${step.action ? ` — ${step.action}` : ""}`);
      }
      if (entity.proposedDelta.length) lines.push("", "## Proposed graph delta", JSON.stringify(entity.proposedDelta));
      if (entity.blockers.length) lines.push("", "## Blockers", ...entity.blockers.map((item) => `- ${item}`));
    }
    if (sourceRefs.length) {
      lines.push("", "## Files & Code");
      for (const source of sourceRefs) {
        lines.push(
          `- ${source.role}: ${source.path}${source.startLine ? `:${source.startLine}` : ""}${source.symbol ? ` (${source.symbol})` : ""}`,
        );
      }
    }
    if (checkpoints.length) {
      lines.push("", "## Checkpoints");
      for (const checkpoint of checkpoints) {
        const required = checkpointRefs.find((item) => item.checkpointId === checkpoint.id)?.required;
        lines.push(`- ${checkpoint.status} · ${checkpoint.evidenceLevel}/${checkpoint.requiredEvidenceLevel}${required === false ? " · optional" : ""}: ${checkpoint.title}`);
      }
    }
    if (history.length) {
      lines.push("", "## Relevant history");
      for (const item of history) lines.push(`- r${item.revision} ${item.action}: ${item.summary}`);
    }
    if (type === "plan") {
      const detailed = this.planContext({ id, locale, maxChars: 24000 });
      return {
        entity: detailed.plan,
        sourceRefs, pathNodes, pathEdges, targetChains, dependencies, steps, checkpointRefs,
        checkpoints: detailed.checkpoints, history, hierarchy: detailed.hierarchy, markdown: detailed.markdown,
      };
    }
    return { entity, sourceRefs, pathNodes, pathEdges, targetChains, dependencies, steps, checkpointRefs, checkpoints, history, coverage, ruleScopes, decisionScopes, markdown: lines.join("\n") };
  }

  checkpointList({ status, targetType, targetId, planId, chainScopeId, unassignedOnly = false, limit = 100, locale = "en" } = {}) {
    const snapshot = this.snapshot();
    assertAllowed(locale, LOCALES, "locale");
    const planCheckpointIDs = new Set([
      ...snapshot.planCheckpointRefs.map((item) => item.checkpointId),
      ...snapshot.checkpoints.filter((checkpoint) => checkpoint.targetType === "plan").map((checkpoint) => checkpoint.id),
    ]);
    const planBoundIDs = new Set(snapshot.checkpointBindings.filter((binding) =>
      binding.subjectType === "plan" || binding.subjectType === "plan_change" || binding.subjectType === "plan_chain_scope",
    ).map((binding) => binding.checkpointId));
    const scopeCheckpointIDs = chainScopeId
      ? new Set(snapshot.checkpointBindings.filter((binding) => binding.subjectType === "plan_chain_scope" && binding.subjectId === chainScopeId).map((binding) => binding.checkpointId))
      : null;
    const activeTargetIDs = new Map([
      ["block", new Set(snapshot.blocks.map((item) => item.id))],
      ["chain", new Set(snapshot.chains.map((item) => item.id))],
      ["link", new Set(snapshot.links.map((item) => item.id))],
      ["plan", new Set(snapshot.plans.map((item) => item.id))],
    ]);
    const matching = snapshot.checkpoints.filter((checkpoint) => {
      const activeIDs = activeTargetIDs.get(checkpoint.targetType);
      if (activeIDs && !activeIDs.has(checkpoint.targetId)) return false;
      if (status && checkpoint.status !== status) return false;
      if (targetType && checkpoint.targetType !== targetType) return false;
      if (targetId && checkpoint.targetId !== targetId) return false;
      if (planId) {
        const direct = checkpoint.targetType === "plan" && checkpoint.targetId === planId;
        const referenced = snapshot.planCheckpointRefs.some((item) => item.planId === planId && item.checkpointId === checkpoint.id);
        const planChangeIds = new Set(snapshot.planChanges.filter((item) => item.planId === planId).map((item) => item.id));
        const chainScopeIds = new Set(snapshot.planChainScopes.filter((item) => item.planId === planId).map((item) => item.id));
        const bound = snapshot.checkpointBindings.some((item) => item.checkpointId === checkpoint.id && (
          (item.subjectType === "plan" && item.subjectId === planId) ||
          (item.subjectType === "plan_change" && planChangeIds.has(item.subjectId)) ||
          (item.subjectType === "plan_chain_scope" && chainScopeIds.has(item.subjectId))
        ));
        if (!direct && !referenced && !bound) return false;
      }
      if (scopeCheckpointIDs && !scopeCheckpointIDs.has(checkpoint.id)) return false;
      if (unassignedOnly && (planCheckpointIDs.has(checkpoint.id) || planBoundIDs.has(checkpoint.id))) return false;
      return true;
    }).slice(0, limit);
    const ownerTitle = (checkpoint) => {
      if (checkpoint.targetType === "block") return snapshot.blocks.find((item) => item.id === checkpoint.targetId)?.title ?? checkpoint.targetId;
      if (checkpoint.targetType === "chain") return snapshot.chains.find((item) => item.id === checkpoint.targetId)?.title ?? checkpoint.targetId;
      if (checkpoint.targetType === "plan") return snapshot.plans.find((item) => item.id === checkpoint.targetId)?.title ?? checkpoint.targetId;
      return checkpoint.targetId;
    };
    const items = matching.map((checkpoint) => ({
      ...checkpoint,
      owner: { type: checkpoint.targetType, id: checkpoint.targetId, title: ownerTitle(checkpoint) },
      planned: planCheckpointIDs.has(checkpoint.id) || planBoundIDs.has(checkpoint.id),
    }));
    const lines = [`# Checkpoints`, `Count: ${items.length}`, ""];
    for (const item of items) lines.push(`- [${item.status}] ${item.title} — ${item.targetType}:${item.targetId} · ${item.owner.title}${item.planned ? " · planned" : " · standalone"}`);
    return { items, count: items.length, markdown: lines.join("\n") };
  }

  planContext({ id, locale = "en", maxChars = 12000 }) {
    assertAllowed(locale, LOCALES, "locale");
    const snapshot = this.snapshot();
    const plan = snapshot.plans.find((item) => item.id === id);
    if (!plan) throw new Error(`plan:${id} not found`);
    const translations = localizationMap(snapshot);
    const scopes = snapshot.planChainScopes.filter((item) => item.planId === id).sort((a, b) => a.position - b.position);
    const changes = snapshot.planChanges.filter((item) => item.planId === id).sort((a, b) => a.position - b.position);
    const orderedSteps = snapshot.planSteps.filter((item) => item.planId === id).sort((a, b) => a.position - b.position);
    const bindingsBySubject = new Map();
    const checkpointDependenciesByParent = new Map();
    for (const dependency of snapshot.checkpointDependencies) {
      const values = checkpointDependenciesByParent.get(dependency.parentCheckpointId) ?? [];
      const checkpoint = snapshot.checkpoints.find((item) => item.id === dependency.childCheckpointId);
      if (checkpoint) values.push({ ...dependency, checkpoint });
      checkpointDependenciesByParent.set(dependency.parentCheckpointId, values);
    }
    const decorateBinding = (binding) => {
      const dependencies = (checkpointDependenciesByParent.get(binding.checkpoint.id) ?? []).sort((a, b) => a.position - b.position);
      return {
        ...binding,
        dependencies,
        blockers: dependencies.filter((item) => item.required && item.checkpoint.status !== "passed"),
      };
    };
    for (const binding of snapshot.checkpointBindings) {
      const key = `${binding.subjectType}:${binding.subjectId}`;
      const values = bindingsBySubject.get(key) ?? [];
      const checkpoint = snapshot.checkpoints.find((item) => item.id === binding.checkpointId);
      if (checkpoint) values.push({ ...binding, checkpoint });
      bindingsBySubject.set(key, values);
    }
    const scopeChangeRefs = new Map();
    for (const ref of snapshot.planChainChangeRefs) {
      const values = scopeChangeRefs.get(ref.chainScopeId) ?? [];
      const change = changes.find((item) => item.id === ref.planChangeId);
      if (change) values.push({ ...ref, change });
      scopeChangeRefs.set(ref.chainScopeId, values);
    }
    const hierarchy = scopes.map((scope) => ({
      ...scope,
      chain: snapshot.chains.find((item) => item.id === scope.chainId) ?? null,
      changes: (scopeChangeRefs.get(scope.id) ?? []).sort((a, b) => a.position - b.position).map((item) => ({
        ...item.change,
        role: item.role,
        checkpoints: (bindingsBySubject.get(`plan_change:${item.change.id}`) ?? []).map(decorateBinding),
      })),
      checkpoints: (bindingsBySubject.get(`plan_chain_scope:${scope.id}`) ?? []).map(decorateBinding),
    }));
    const scopedChangeIds = new Set(snapshot.planChainChangeRefs
      .filter((ref) => scopes.some((scope) => scope.id === ref.chainScopeId))
      .map((ref) => ref.planChangeId));
    const scopedChanges = changes.filter((change) => scopedChangeIds.has(change.id)).map((change) => ({
      ...change,
      checkpoints: (bindingsBySubject.get(`plan_change:${change.id}`) ?? []).map(decorateBinding),
    }));
    const projectedChangePayload = (change) => JSON.stringify({
      id: change.id, entityType: change.entityType, entityId: change.entityId, title: change.title,
      summary: change.summary, currentBehavior: change.currentBehavior, proposedBehavior: change.proposedBehavior,
      rationale: change.rationale, prohibitions: change.prohibitions, expectedEffects: change.expectedEffects,
      sourceRefs: change.sourceRefs, status: change.status,
    }).length;
    const canonicalScopedPayloadChars = scopedChanges.reduce((total, change) => total + projectedChangePayload(change), 0);
    const scopeExpandedPayloadChars = hierarchy.flatMap((scope) => scope.changes)
      .reduce((total, change) => total + projectedChangePayload(change), 0);
    const avoidedRepeatedPayloadChars = Math.max(0, scopeExpandedPayloadChars - canonicalScopedPayloadChars);
    const unattachedChanges = changes.filter((change) =>
      !snapshot.planChainChangeRefs.some((ref) => ref.planChangeId === change.id));
    const directChanges = unattachedChanges.map((change) => ({
      ...change,
      entity: change.entityType === "block" ? snapshot.blocks.find((item) => item.id === change.entityId) ?? null
        : change.entityType === "link" ? snapshot.links.find((item) => item.id === change.entityId) ?? null
          : snapshot.chains.find((item) => item.id === change.entityId) ?? null,
      checkpoints: (bindingsBySubject.get(`plan_change:${change.id}`) ?? []).map(decorateBinding),
      targetCheckpoints: change.entityType === "block"
        ? snapshot.checkpoints.filter((checkpoint) => checkpoint.targetType === "block" && checkpoint.targetId === change.entityId)
        : [],
    }));
    const coverage = architectureCoverage(snapshot, id);
    const planCheckpoints = [
      ...(bindingsBySubject.get(`plan:${id}`) ?? []),
      ...snapshot.checkpoints.filter((checkpoint) => checkpoint.targetType === "plan" && checkpoint.targetId === id)
        .map((checkpoint) => ({ checkpoint, role: "plan", required: true, position: 0 })),
      ...snapshot.planCheckpointRefs.filter((ref) => ref.planId === id).map((ref) => {
        const checkpoint = snapshot.checkpoints.find((item) => item.id === ref.checkpointId);
        return checkpoint ? { ...ref, checkpoint } : null;
      }).filter(Boolean),
    ].filter((item, index, values) => values.findIndex((candidate) => candidate.checkpoint.id === item.checkpoint.id) === index)
      .map(decorateBinding);
    const appendBlockers = (binding, indent = "  ") => {
      if (!binding.blockers.length) return;
      lines.push(`${indent}Blocked by required checks:`);
      for (const blocker of binding.blockers.slice(0, 12)) {
        lines.push(`${indent}- ${blocker.checkpoint.status}: ${blocker.checkpoint.title} [checkpoint:${blocker.checkpoint.id}]`);
      }
      if (binding.blockers.length > 12) lines.push(`${indent}- … ${binding.blockers.length - 12} more`);
    };
    const appendChangeDetails = (change) => {
      lines.push("", `### ${change.title} [plan_change:${change.id}]`, `Target: ${change.entityType}:${change.entityId}`, change.summary || "—");
      if (change.currentBehavior) lines.push(`Current: ${change.currentBehavior}`);
      if (change.proposedBehavior) lines.push(`Proposed: ${change.proposedBehavior}`);
      if (change.rationale) lines.push(`Reason: ${change.rationale}`);
      if (change.prohibitions.length) lines.push(`Must not: ${change.prohibitions.join("; ")}`);
      if (change.expectedEffects.length) lines.push(`Expected: ${change.expectedEffects.join("; ")}`);
      if (change.sourceRefs.length) lines.push(`Sources: ${change.sourceRefs.join(", ")}`);
      for (const binding of change.checkpoints) {
        const checkpoint = binding.checkpoint;
        lines.push(`- Checkpoint ${checkpoint.status}: ${checkpoint.title} (${checkpoint.evidenceLevel}/${checkpoint.requiredEvidenceLevel})`);
        appendBlockers(binding, "  ");
      }
    };
    const title = localizedValue(translations, "plan", id, locale, "title", plan.title);
    const summary = localizedValue(translations, "plan", id, locale, "summary", plan.summary);
    const goal = localizedValue(translations, "plan", id, locale, "goal", plan.goal);
    const lines = [
      `# ${title}`,
      `${plan.phase} #${plan.planOrder} · ${plan.priority} · ${plan.derivedStatus}`,
      "",
      summary || "No summary.",
      "",
      "## Goal",
      goal || "—",
    ];
    const nextAction = localizedValue(translations, "plan", id, locale, "nextAction", plan.nextAction);
    if (nextAction) lines.push("", "## Next action", nextAction);
    if (plan.proposedDelta.length) lines.push("", "## Overall change", ...plan.proposedDelta.map((item) => `- ${typeof item === "string" ? item : JSON.stringify(item)}`));
    if (plan.blockers.length) lines.push("", "## Blockers / prohibitions", ...plan.blockers.map((item) => `- ${item}`));
    lines.push("", "## Architecture coverage");
    lines.push(`- ${coverage.verified}/${coverage.totalBlocks} Blocks verified`);
    lines.push(`- ${coverage.planned}/${coverage.totalBlocks} Blocks covered by this Plan (${coverage.directPlanBlocks} direct · ${coverage.chainPlanBlocks} through Chains)`);
    lines.push(`- Verification coverage ${coverage.verificationCovered}/${coverage.totalBlocks} · ${coverage.inChains} in Chains · ${coverage.outsideChainIds.length} standalone · ${coverage.failingIds.length} failing`);
    if (coverage.unplannedIds.length) lines.push(`- Outside this Plan: ${coverage.unplannedIds.slice(0, 12).map((blockId) => `block:${blockId}`).join(", ")}${coverage.unplannedIds.length > 12 ? " …" : ""}`);
    if (coverage.withoutCheckpointIds.length) lines.push(`- Required Block checkpoints missing: ${coverage.withoutCheckpointIds.slice(0, 12).map((blockId) => `block:${blockId}`).join(", ")}${coverage.withoutCheckpointIds.length > 12 ? " …" : ""}`);
    if (coverage.checkpointUnboundIds.length) lines.push(`- Block checkpoints not bound to an exact PlanChange: ${coverage.checkpointUnboundIds.slice(0, 12).map((blockId) => `block:${blockId}`).join(", ")}${coverage.checkpointUnboundIds.length > 12 ? " …" : ""}`);
    if (coverage.chainGateMissingIds.length) lines.push(`- Blocks on Chains without integration gates: ${coverage.chainGateMissingIds.slice(0, 12).map((blockId) => `block:${blockId}`).join(", ")}${coverage.chainGateMissingIds.length > 12 ? " …" : ""}`);
    const typed = plan.typedProgress;
    lines.push("", "## Typed progress");
    lines.push(`- Direct Block Changes: ${typed.directBlockChanges.completed}/${typed.directBlockChanges.total}`);
    lines.push(`- Chain Changes: ${typed.chainChanges.completed}/${typed.chainChanges.total}`);
    lines.push(`- Link Changes: ${typed.linkChanges.completed}/${typed.linkChanges.total}`);
    lines.push(`- Chain integration gates: ${typed.chainIntegrationGates.passed}/${typed.chainIntegrationGates.total}`);
    lines.push(`- Plan acceptance gates: ${typed.planAcceptanceGates.passed}/${typed.planAcceptanceGates.total}`);
    lines.push("", "## Execution order");
    if (orderedSteps.length) {
      lines.push("### Ordered steps");
      for (const step of orderedSteps) {
        lines.push(`${step.position + 1}. ${step.status}: ${step.title}${step.action ? ` — ${step.action}` : ""}`);
      }
    } else {
      lines.push("- No ordered steps declared.");
    }
    if (hierarchy.length === 0 && directChanges.length === 0 && orderedSteps.length === 0) {
      lines.push(
        "",
        "## Change structure",
        locale === "zh-Hans"
          ? "此 Plan 没有有序步骤、ChainScope 或逐实体修改，不能用 0/0 表示完成。"
          : "This Plan has no ordered steps, ChainScopes, or per-entity work; 0/0 is not completion.",
      );
    }
    const directBlockChanges = directChanges.filter((change) => change.entityType === "block");
    lines.push("", "## Direct Block work");
    if (directBlockChanges.length) {
      for (const change of directBlockChanges) {
        lines.push(`- ${change.status}: ${change.title} [block:${change.entityId}] — ${change.proposedBehavior || change.summary || "—"}`);
        if (change.currentBehavior) lines.push(`  - Current: ${change.currentBehavior}`);
        if (change.proposedBehavior) lines.push(`  - Change: ${change.proposedBehavior}`);
        if (change.rationale) lines.push(`  - Why: ${change.rationale}`);
        if (change.checkpoints.length) {
          for (const binding of change.checkpoints) {
            const checkpoint = binding.checkpoint;
            lines.push(`  - Required checkpoint ${checkpoint.status}: ${checkpoint.title} (${checkpoint.evidenceLevel}/${checkpoint.requiredEvidenceLevel})`);
            appendBlockers(binding, "    ");
          }
        } else if (change.targetCheckpoints.length) {
          lines.push(`  - Warning: Block checkpoints exist but none is bound to this PlanChange: ${change.targetCheckpoints.map((checkpoint) => `checkpoint:${checkpoint.id}`).join(", ")}`);
        } else {
          lines.push("  - Warning: this Block has no checkpoint.");
        }
      }
    } else {
      lines.push("- None declared.");
    }
    lines.push("", "## Chain integration");
    if (hierarchy.length === 0) lines.push("- None declared.");
    for (const scope of hierarchy) {
      lines.push("", `### ${scope.position + 1}. ${scope.title} [chain:${scope.chainId}]`, scope.summary || "—");
      if (scope.rationale) lines.push(`Reason: ${scope.rationale}`);
      if (scope.nodeIds.length || scope.linkIds.length) lines.push(`Path: ${scope.nodeIds.map((nodeId) => `block:${nodeId}`).join(" → ")}${scope.linkIds.length ? ` · Links ${scope.linkIds.map((linkId) => `link:${linkId}`).join(", ")}` : ""}`);
      if (scope.prohibitions.length) lines.push("Prohibitions:", ...scope.prohibitions.map((item) => `- ${item}`));
      if (scope.changes.length) lines.push(`Changes: ${scope.changes.map((change) => `[plan_change:${change.id}]`).join(", ")}`);
      for (const binding of scope.checkpoints) {
        const checkpoint = binding.checkpoint;
        lines.push(`- Chain gate ${checkpoint.status}: ${checkpoint.title} (${checkpoint.evidenceLevel}/${checkpoint.requiredEvidenceLevel})`);
        appendBlockers(binding, "  ");
      }
    }
    if (scopedChanges.length) {
      lines.push("", "## Canonical scoped changes");
      for (const change of scopedChanges) appendChangeDetails(change);
    }
    const otherDirectChanges = directChanges.filter((change) => change.entityType !== "block");
    if (otherDirectChanges.length) {
      lines.push("", "## Cross-Chain changes");
      for (const change of otherDirectChanges) lines.push(`- ${change.title} [${change.entityType}:${change.entityId}] — ${change.proposedBehavior || change.summary}`);
    }
    lines.push("", "## Plan acceptance");
    if (planCheckpoints.length) {
      for (const binding of planCheckpoints) {
        const checkpoint = binding.checkpoint;
        lines.push(`- ${checkpoint.status}: ${checkpoint.title} (${checkpoint.evidenceLevel}/${checkpoint.requiredEvidenceLevel})`);
        appendBlockers(binding, "  ");
      }
    } else {
      lines.push("- No acceptance checkpoint declared.");
    }
    let markdown = lines.join("\n");
    if (markdown.length > maxChars) markdown = `${markdown.slice(0, Math.max(0, maxChars - 64))}\n\n[truncated; open a referenced entity for detail]`;
    return {
      plan, steps: orderedSteps, hierarchy, scopedChanges, unattachedChanges, directChanges, coverage,
      checkpoints: planCheckpoints.map((item) => item.checkpoint),
      checkpointGates: planCheckpoints,
      dependencies: snapshot.planDependencies.filter((item) => item.planId === id),
      projection: {
        canonicalChangeCount: changes.length,
        scopeChangeReferenceCount: snapshot.planChainChangeRefs.filter((ref) => scopes.some((scope) => scope.id === ref.chainScopeId)).length,
        repeatedScopeReferenceCount: Math.max(0, snapshot.planChainChangeRefs.filter((ref) => scopes.some((scope) => scope.id === ref.chainScopeId)).length - scopedChanges.length),
        canonicalScopedPayloadChars,
        legacyScopeExpandedPayloadChars: scopeExpandedPayloadChars,
        avoidedRepeatedPayloadChars,
        estimatedTokensAvoided: Math.ceil(avoidedRepeatedPayloadChars / 4),
        markdownChars: markdown.length,
        estimatedTokens: Math.ceil(markdown.length / 4),
      },
      markdown,
    };
  }

  changesSince({ sequence = 0, limit = 100 } = {}) {
    if (!Number.isInteger(sequence) || sequence < 0) throw new Error("sequence must be a non-negative integer");
    const boundedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const latestSequence = this.database.prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM change_feed WHERE project_id = ?",
    ).get(this.paths.descriptor.id).sequence;
    const earliestSequence = this.database.prepare(
      "SELECT COALESCE(MIN(sequence), 0) AS sequence FROM change_feed WHERE project_id = ?",
    ).get(this.paths.descriptor.id).sequence;
    const rows = this.database.prepare(
      `SELECT cf.sequence, cf.change_set_id, cf.entity_type, cf.entity_id, cf.action, cf.created_at,
              h.revision, h.summary, h.plan_id, h.chain_scope_id, h.before_json, h.after_json,
              h.changed_fields_json, h.affected_refs_json, h.evidence_refs_json
       FROM change_feed cf
       LEFT JOIN history h ON h.change_set_id = cf.change_set_id AND h.entity_type = cf.entity_type
         AND h.entity_id = cf.entity_id AND h.action = cf.action
       WHERE cf.project_id = ? AND cf.sequence > ? ORDER BY cf.sequence LIMIT ?`,
    ).all(this.paths.descriptor.id, sequence, boundedLimit + 1).map((row) => ({
      sequence: row.sequence, changeSetId: row.change_set_id, ref: `${row.entity_type}:${row.entity_id}`,
      action: row.action, revision: row.revision, summary: row.summary, planId: row.plan_id,
      chainScopeId: row.chain_scope_id, before: parseJson(row.before_json, {}), after: parseJson(row.after_json, {}),
      changedFields: parseJson(row.changed_fields_json, []), affectedRefs: parseJson(row.affected_refs_json, []),
      evidenceRefs: parseJson(row.evidence_refs_json, []), createdAt: row.created_at,
    }));
    const hasMore = rows.length > boundedLimit;
    if (hasMore) rows.pop();
    const markdown = [
      `# Changes since sequence ${sequence}`,
      `Range: ${sequence} → ${rows.at(-1)?.sequence ?? sequence} · latest ${latestSequence} · earliest ${earliestSequence || "—"}`,
      `Returned: ${rows.length}${hasMore ? ` · more available after ${rows.at(-1)?.sequence ?? sequence}` : ""}`,
      "",
      ...rows.map((change) => {
        const fields = change.changedFields?.length ? ` · fields ${change.changedFields.join(", ")}` : "";
        const refs = change.affectedRefs?.length ? ` · refs ${change.affectedRefs.join(", ")}` : "";
        return `- #${change.sequence} ${change.action} ${change.ref} · r${change.revision ?? "?"}${fields}${refs}${change.summary ? ` — ${change.summary}` : ""}`;
      }),
      ...(rows.length ? ["", "Use includeStructured=true when exact before/after JSON is required."] : []),
    ].join("\n");
    return {
      fromSequence: sequence,
      nextSequence: rows.at(-1)?.sequence ?? sequence,
      latestSequence,
      earliestSequence,
      hasMore,
      changes: rows,
      markdown,
    };
  }

  revertChangeSet({ changeSetId, actor = "agent", reason, task = "", gitHead = null, planId = null, chainScopeId = null }) {
    if (!changeSetId?.trim()) throw new Error("changeSetId is required");
    this.ensureSynced();
    const changeSet = this.database.prepare(
      "SELECT * FROM change_sets WHERE project_id = ? AND id = ?",
    ).get(this.paths.descriptor.id, changeSetId);
    if (!changeSet) throw new Error(`change_set:${changeSetId} not found`);
    const history = this.database.prepare(
      "SELECT * FROM history WHERE change_set_id = ? ORDER BY id DESC",
    ).all(changeSetId);
    if (history.length === 0) throw new Error(`change_set:${changeSetId} has no reversible history`);

    const inverse = [];
    const expectedRevisions = new Map();
    const simulatedStates = new Map();
    const stateForHistory = (item) => {
      if (item.action === "plan-change-updated") {
        const planIdForChange = item.plan_id ?? [...parseJson(item.affected_refs_json, [])]
          .find((ref) => ref.startsWith("plan:"))?.slice("plan:".length);
        const changeId = parseJson(item.affected_refs_json, [])
          .find((ref) => ref.startsWith("plan_change:"))?.slice("plan_change:".length);
        if (!planIdForChange || !changeId) throw new Error(`change_set:${changeSetId} child change target is missing`);
        return { operation: { action: "update_plan_change", id: planIdForChange, fields: { changeId } }, planId: planIdForChange };
      }
      if (item.action === "chain-scope-updated") {
        const planIdForScope = item.plan_id ?? [...parseJson(item.affected_refs_json, [])]
          .find((ref) => ref.startsWith("plan:"))?.slice("plan:".length);
        const scopeId = parseJson(item.affected_refs_json, [])
          .find((ref) => ref.startsWith("plan_chain_scope:"))?.slice("plan_chain_scope:".length);
        if (!planIdForScope || !scopeId) throw new Error(`change_set:${changeSetId} ChainScope target is missing`);
        return { operation: { action: "update_plan_chain_scope", id: planIdForScope, fields: { scopeId } }, planId: planIdForScope };
      }
      return { operation: null, planId: null };
    };
    for (const item of history) {
      if (item.action === "created") {
        if (["block", "chain", "link", "plan", "decision"].includes(item.entity_type)) {
          const tableName = item.entity_type === "block" ? "blocks"
            : item.entity_type === "chain" ? "chains"
              : item.entity_type === "link" ? "links"
                : item.entity_type === "decision" ? "decisions" : "plans";
          const key = `${item.entity_type}:${item.entity_id}`;
          const revision = expectedRevisions.get(key) ?? this.database.prepare(
            `SELECT current_revision FROM ${tableName} WHERE project_id = ? AND id = ?`,
          ).get(this.paths.descriptor.id, item.entity_id)?.current_revision;
          if (!Number.isInteger(revision)) throw new Error(`${item.entity_type}:${item.entity_id} not found`);
          inverse.push({
            action: `update_${item.entity_type}`,
            id: item.entity_id,
            expectedRevision: revision,
            fields: { archived: true },
          });
          expectedRevisions.set(key, revision + 1);
          simulatedStates.set(key, { ...(simulatedStates.get(key) ?? {}), archived: true });
          continue;
        }
        if (item.entity_type === "checkpoint") {
          inverse.push({
            action: "delete_checkpoint",
            id: item.entity_id,
          });
          continue;
        }
      }
      if (item.action === "updated" && ["block", "chain", "link", "plan"].includes(item.entity_type)) {
        const before = parseJson(item.before_json, {});
        const after = parseJson(item.after_json, {});
        const fields = parseJson(item.changed_fields_json, []);
        const allowed = item.entity_type === "block" ? EDITABLE_BLOCK_FIELDS
          : item.entity_type === "chain" ? EDITABLE_CHAIN_FIELDS
            : item.entity_type === "link" ? EDITABLE_LINK_FIELDS : EDITABLE_PLAN_FIELDS;
        if (!fields.length || fields.some((field) => !allowed.has(field))) {
          throw new Error(`change_set:${changeSetId} contains a non-reversible ${item.entity_type} update`);
        }
        const stateKey = `${item.entity_type}:${item.entity_id}`;
        const current = simulatedStates.get(stateKey) ?? this.historyState(item.entity_type, item.entity_id);
        for (const field of fields) {
          if (JSON.stringify(current?.[field] ?? null) !== JSON.stringify(after?.[field] ?? null)) {
            throw new Error(`change_set:${changeSetId} is stale for ${item.entity_type}:${item.entity_id}; refusing to overwrite newer work`);
          }
        }
        const key = `${item.entity_type}:${item.entity_id}`;
        const revision = expectedRevisions.get(key) ?? this.database.prepare(
          `SELECT current_revision FROM ${item.entity_type === "block" ? "blocks" : item.entity_type === "chain" ? "chains" : item.entity_type === "link" ? "links" : "plans"} WHERE project_id = ? AND id = ?`,
        ).get(this.paths.descriptor.id, item.entity_id)?.current_revision;
        if (!Number.isInteger(revision)) throw new Error(`${item.entity_type}:${item.entity_id} not found`);
        inverse.push({ action: `update_${item.entity_type}`, id: item.entity_id, expectedRevision: revision, fields: Object.fromEntries(fields.map((field) => [field, before[field]])) });
        expectedRevisions.set(key, revision + 1);
        simulatedStates.set(stateKey, before);
        continue;
      }
      if (item.action === "plan-change-updated" || item.action === "chain-scope-updated") {
        const target = stateForHistory(item);
        const before = parseJson(item.before_json, {});
        const after = parseJson(item.after_json, {});
        const fields = parseJson(item.changed_fields_json, []);
        const allowed = item.action === "plan-change-updated" ? EDITABLE_PLAN_CHANGE_FIELDS : EDITABLE_PLAN_CHAIN_SCOPE_FIELDS;
        if (!fields.length || fields.some((field) => !allowed.has(field))) {
          throw new Error(`change_set:${changeSetId} contains a non-reversible ${item.action}`);
        }
        const stateKey = item.action === "plan-change-updated"
          ? `plan_change:${target.operation.fields.changeId}`
          : `plan_chain_scope:${target.operation.fields.scopeId}`;
        const current = simulatedStates.get(stateKey) ?? this.historyStateForOperation(target.operation, "plan", target.planId);
        for (const field of fields) {
          if (JSON.stringify(current?.[field] ?? null) !== JSON.stringify(after?.[field] ?? null)) {
            throw new Error(`change_set:${changeSetId} is stale for ${item.action}; refusing to overwrite newer work`);
          }
        }
        const key = `plan:${target.planId}`;
        const revision = expectedRevisions.get(key) ?? this.database.prepare("SELECT current_revision FROM plans WHERE project_id = ? AND id = ?")
          .get(this.paths.descriptor.id, target.planId)?.current_revision;
        if (!Number.isInteger(revision)) throw new Error(`plan:${target.planId} not found`);
        inverse.push({
          action: item.action === "plan-change-updated" ? "update_plan_change" : "update_plan_chain_scope",
          id: target.planId,
          expectedRevision: revision,
          fields: item.action === "plan-change-updated"
            ? { changeId: target.operation.fields.changeId, patch: Object.fromEntries(fields.map((field) => [field, before[field]])) }
            : { scopeId: target.operation.fields.scopeId, patch: Object.fromEntries(fields.map((field) => [field, before[field]])) },
        });
        expectedRevisions.set(key, revision + 1);
        simulatedStates.set(stateKey, before);
        continue;
      }
      throw new Error(`change_set:${changeSetId} contains unsupported action ${item.action}; refusing partial revert`);
    }
    const resolvedContext = this.resolveHistoryContext(planId, chainScopeId);
    return this.mutate({
      actor,
      reason: reason?.trim() || `Revert change set ${changeSetId}`,
      task,
      gitHead,
      planId: resolvedContext.planId,
      chainScopeId: resolvedContext.chainScopeId,
      operations: inverse,
    });
  }

  contextForTask({ task, focusRefs = [], maxChars = 6000, locale = "en" }) {
    const snapshot = this.snapshot();
    const coverage = architectureCoverage(snapshot);
    assertAllowed(locale, LOCALES, "locale");
    const translations = localizationMap(snapshot);
    const terms = taskTerms(task);
    const backgroundRuleIds = new Set(snapshot.backgroundScopes.map((scope) => scope.blockId));
    const planSignals = new Set(["plan", "todo", "roadmap", "progress", "status", "next", "blocker", "blocked", "release", "readiness", "计划", "进度", "阻塞", "发布"]);
    const taskMentionsPlan = terms.some((term) => planSignals.has(term));
    const scoreText = (text, weight = 1) => {
      if (!text) return 0;
      const lower = text.toLowerCase();
      let matchCount = 0;
      for (const term of terms) {
        if (lower.includes(term)) {
          matchCount += weight * (term.length >= 4 ? 2 : 1);
        }
      }
      return matchCount;
    };
    const scoredBlocks = snapshot.blocks
      .filter((block) => !backgroundRuleIds.has(block.id) && block.kind !== "decision")
      .map((block) => {
        let semanticScore = 0;
        semanticScore += scoreText(block.title, 5);
        semanticScore += scoreText(block.summary, 3);
        semanticScore += scoreText(block.tags.join(" "), 4);
        semanticScore += scoreText(block.contract, 3);
        semanticScore += scoreText(block.scope, 2);
        semanticScore += scoreText(block.architectureLayer, 2);
        semanticScore += scoreText(block.body, 1);
        semanticScore += scoreText(localizedSearchText(snapshot, "block", block.id), 3);
        return { block, score: semanticScore + (focusRefs.includes(`block:${block.id}`) ? 100 : 0) };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    const scoredChains = snapshot.chains
      .map((chain) => {
        let semanticScore = 0;
        semanticScore += scoreText(chain.title, 5);
        semanticScore += scoreText(chain.intent, 3);
        semanticScore += scoreText(chain.inputContract, 3);
        semanticScore += scoreText(chain.outputContract, 3);
        semanticScore += scoreText(localizedSearchText(snapshot, "chain", chain.id), 3);
        return {
          chain,
          score: semanticScore + (focusRefs.includes(`chain:${chain.id}`) ? 100 : 0),
        };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    const scoredPlans = snapshot.plans
      .map((plan) => {
        const focused = focusRefs.includes(`plan:${plan.id}`);
        let semanticScore = 0;
        semanticScore += scoreText(plan.title, 5);
        semanticScore += scoreText(plan.summary, 3);
        semanticScore += scoreText(plan.goal, 3);
        semanticScore += scoreText(plan.status, 2);
        semanticScore += scoreText(plan.nextAction, 2);
        semanticScore += scoreText(JSON.stringify(plan.proposedDelta), 1);
        semanticScore += scoreText(JSON.stringify(plan.blockers), 2);
        semanticScore += scoreText(localizedSearchText(snapshot, "plan", plan.id), 3);
        return { plan, semanticScore, score: semanticScore + (focused ? 100 : 0), focused };
      })
      .filter((entry) => entry.focused || entry.semanticScore >= 3 || (taskMentionsPlan && entry.semanticScore >= 1))
      .sort((a, b) => b.score - a.score);

    if (scoredBlocks.length === 0 && scoredChains.length === 0 && scoredPlans.length === 0) {
      for (const plan of snapshot.plans.filter((item) => ["active", "ready", "blocked"].includes(item.status)).slice(0, 3)) {
        scoredPlans.push({ plan, score: 1 });
      }
    }

    const selectedBlockIds = new Set(scoredBlocks.slice(0, 5).map((entry) => entry.block.id));
    const selectedChainIds = new Set(scoredChains.slice(0, 1).map((entry) => entry.chain.id));
    const selectedPlanIds = new Set(scoredPlans.slice(0, 1).map((entry) => entry.plan.id));
    const detailedBlockIds = new Set(
      focusRefs.filter((ref) => ref.startsWith("block:")).map((ref) => ref.slice("block:".length)),
    );
    if (selectedPlanIds.size === 0) {
      for (const entry of scoredBlocks.slice(0, 3)) detailedBlockIds.add(entry.block.id);
    }
    const relatedChains = new Map();
    for (const node of snapshot.chainNodes) {
      if (selectedBlockIds.has(node.blockId)) relatedChains.set(node.chainId, (relatedChains.get(node.chainId) ?? 0) + 1);
    }
    for (const [chainId] of [...relatedChains.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      if (selectedChainIds.size >= 1) break;
      selectedChainIds.add(chainId);
    }
    // A Plan is allowed to cover Blocks directly.  Do not make the context
    // depend on a Chain reference just to discover those Blocks; otherwise a
    // Plan can look complete while its standalone work is absent from the
    // first context pack.
    for (const planId of selectedPlanIds) {
      for (const change of snapshot.planChanges) {
        if (change.planId === planId && change.entityType === "block") selectedBlockIds.add(change.entityId);
      }
      for (const step of snapshot.planSteps) {
        if (step.planId !== planId) continue;
        for (const ref of step.targetRefs) {
          if (String(ref).startsWith("block:")) selectedBlockIds.add(String(ref).slice("block:".length));
        }
      }
      for (const scope of snapshot.planChainScopes) {
        if (scope.planId !== planId) continue;
        for (const blockId of scope.nodeIds) selectedBlockIds.add(blockId);
      }
    }
    // Include Chain paths introduced by Plan ChainScopes in the same traversal
    // pass.  The old snapshot of selectedChainIds was taken before Plan refs
    // were added, so Plan context could omit its own path neighbours.
    for (const target of snapshot.planChainRefs) {
      if (selectedPlanIds.has(target.planId)) selectedChainIds.add(target.chainId);
    }
    for (const scope of snapshot.planChainScopes) {
      if (selectedPlanIds.has(scope.planId)) selectedChainIds.add(scope.chainId);
    }
    for (const chainId of selectedChainIds) {
      const path = snapshot.chainNodes
        .filter((item) => item.chainId === chainId)
        .sort((a, b) => a.position - b.position)
        .map((item) => item.blockId);
      if (focusRefs.includes(`chain:${chainId}`)) {
        for (const blockId of path.slice(0, 10)) selectedBlockIds.add(blockId);
        continue;
      }
      const matchingPositions = path.flatMap((blockId, index) => selectedBlockIds.has(blockId) ? [index] : []);
      for (const position of matchingPositions) {
        for (const index of [position - 1, position, position + 1]) {
          if (path[index]) selectedBlockIds.add(path[index]);
        }
      }
    }
    const applicableRuleScopes = snapshot.backgroundScopes.filter((scope) =>
      scope.scopeType === "project" ||
      (scope.scopeType === "lens" && terms.some((term) => scope.scopeValue.toLowerCase().includes(term))) ||
      (scope.scopeType === "chain" && selectedChainIds.has(scope.scopeValue)) ||
      (scope.scopeType === "repo" && (terms.some((term) => scope.scopeValue.toLowerCase().includes(term)) || focusRefs.some((ref) => ref.includes(scope.scopeValue))))
    );
    const applicableRuleIds = [...new Set(applicableRuleScopes.map((scope) => scope.blockId))];
    const applicableDecisionScopes = snapshot.decisionScopes.filter((scope) =>
      scope.scopeType === "project" ||
      (scope.scopeType === "lens" && terms.some((term) => scope.scopeValue.toLowerCase().includes(term))) ||
      (scope.scopeType === "chain" && selectedChainIds.has(scope.scopeValue)) ||
      (scope.scopeType === "repo" && (terms.some((term) => scope.scopeValue.toLowerCase().includes(term)) || focusRefs.some((ref) => ref.includes(scope.scopeValue))))
    );
    const applicableDecisionIds = [...new Set(applicableDecisionScopes.map((scope) => scope.decisionId))];
    const applicableDecisions = snapshot.decisions
      .filter((decision) => applicableDecisionIds.includes(decision.id))
      .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
    const relevantBlocks = snapshot.blocks.filter((block) => selectedBlockIds.has(block.id) && block.kind !== "decision");
    const relevantChains = snapshot.chains.filter((chain) => selectedChainIds.has(chain.id));
    const relevantPlans = snapshot.plans.filter((plan) => selectedPlanIds.has(plan.id));
    const planCoverage = new Map(relevantPlans.map((plan) => [plan.id, architectureCoverage(snapshot, plan.id)]));
    const relevantLinks = snapshot.links
      .filter(
        (link) =>
          (selectedBlockIds.has(link.sourceId) || selectedChainIds.has(link.sourceId)) &&
          (selectedBlockIds.has(link.targetId) || selectedChainIds.has(link.targetId)),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const relevantScopeIDs = new Set(snapshot.planChainScopes.filter((scope) => selectedPlanIds.has(scope.planId)).map((scope) => scope.id));
    const relevantChangeIDs = new Set(snapshot.planChanges.filter((change) => selectedPlanIds.has(change.planId)).map((change) => change.id));
    const boundCheckpointIDs = new Set(snapshot.checkpointBindings.filter((binding) =>
      (binding.subjectType === "plan" && selectedPlanIds.has(binding.subjectId)) ||
      (binding.subjectType === "plan_chain_scope" && relevantScopeIDs.has(binding.subjectId)) ||
      (binding.subjectType === "plan_change" && relevantChangeIDs.has(binding.subjectId)))
      .map((binding) => binding.checkpointId));
    const plannedCheckpointIDs = new Set([
      ...snapshot.planCheckpointRefs.map((item) => item.checkpointId),
      ...snapshot.checkpoints.filter((checkpoint) => checkpoint.targetType === "plan").map((checkpoint) => checkpoint.id),
      ...snapshot.checkpointBindings
        .filter((binding) => ["plan", "plan_change", "plan_chain_scope"].includes(binding.subjectType))
        .map((binding) => binding.checkpointId),
    ]);
    // A checkpoint can be intentionally independent of all Plans. Keep open
    // standalone checks in bounded context so an agent can discover and run them.
    const checkpointOrder = (left, right) =>
      left.targetType.localeCompare(right.targetType) ||
      left.targetId.localeCompare(right.targetId) ||
      left.id.localeCompare(right.id);
    const standaloneOpenCheckpoints = snapshot.checkpoints
      .filter((checkpoint) => !plannedCheckpointIDs.has(checkpoint.id) && checkpoint.status !== "passed")
      .sort(checkpointOrder)
      .slice(0, 20);
    const relevantCheckpoints = snapshot.checkpoints
      .filter(
        (checkpoint) =>
          (checkpoint.targetType === "block" && selectedBlockIds.has(checkpoint.targetId)) ||
          (checkpoint.targetType === "chain" && selectedChainIds.has(checkpoint.targetId)) ||
          (checkpoint.targetType === "plan" && selectedPlanIds.has(checkpoint.targetId)) ||
          boundCheckpointIDs.has(checkpoint.id),
      )
      .sort(checkpointOrder);

    const lines = ["# Task Context", `Task: ${task}`, `Graph revision: ${snapshot.project.graphRevision}`, ""];
    lines.push("## Architecture coverage");
    lines.push(`- ${coverage.verified}/${coverage.totalBlocks} Blocks verified · ${coverage.planned}/${coverage.totalBlocks} planned · ${coverage.withCheckpoint}/${coverage.totalBlocks} with checkpoints`);
    lines.push(`- ${coverage.inChains} in Chains · ${coverage.outsideChainIds.length} standalone · ${coverage.verificationCovered}/${coverage.totalBlocks} covered by bound or passed verification · ${coverage.failingIds.length} failing`);
    if (coverage.unplannedIds.length) lines.push(`- Unplanned: ${coverage.unplannedIds.slice(0, 10).map((id) => `block:${id}`).join(", ")}${coverage.unplannedIds.length > 10 ? " …" : ""}`);
    if (coverage.withoutCheckpointIds.length) lines.push(`- Checkpoint-free Blocks (verification not requested yet): ${coverage.withoutCheckpointIds.slice(0, 10).map((id) => `block:${id}`).join(", ")}${coverage.withoutCheckpointIds.length > 10 ? " …" : ""}`);
    if (coverage.requiredCheckpointMissingIds.length) lines.push(`- Required checkpoints missing: ${coverage.requiredCheckpointMissingIds.slice(0, 10).map((id) => `block:${id}`).join(", ")}${coverage.requiredCheckpointMissingIds.length > 10 ? " …" : ""}`);
    if (coverage.checkpointUnboundIds.length) lines.push(`- Unbound checkpoints: ${coverage.checkpointUnboundIds.slice(0, 10).map((id) => `block:${id}`).join(", ")}${coverage.checkpointUnboundIds.length > 10 ? " …" : ""}`);
    if (coverage.chainGateMissingIds.length) lines.push(`- Missing Chain gates: ${coverage.chainGateMissingIds.slice(0, 10).map((id) => `block:${id}`).join(", ")}${coverage.chainGateMissingIds.length > 10 ? " …" : ""}`);
    lines.push("");
    if (applicableRuleIds.length) {
      lines.push("## Applicable rule index");
      for (const blockId of applicableRuleIds) {
        const block = snapshot.blocks.find((item) => item.id === blockId);
        if (!block) continue;
        const title = localizedValue(translations, "block", block.id, locale, "title", block.title);
        const scopes = applicableRuleScopes.filter((scope) => scope.blockId === block.id).map((scope) => `${scope.scopeType}:${scope.scopeValue}`);
        lines.push(`- [block:${block.id}] ${title} · scopes ${scopes.join(", ")} · use entity_open only if the rule is needed`);
      }
      lines.push("");
    }
    if (applicableDecisions.length) {
      lines.push("## Applicable decision index");
      for (const decision of applicableDecisions.slice(0, 12)) {
        const scopes = applicableDecisionScopes.filter((scope) => scope.decisionId === decision.id)
          .map((scope) => `${scope.scopeType}:${scope.scopeValue}`);
        lines.push(`- [decision:${decision.id}] ${decision.title} · ${decision.status} · scopes ${scopes.join(", ")} · use decision_open/entity_open only if rationale is needed`);
      }
      if (applicableDecisions.length > 12) lines.push(`- … ${applicableDecisions.length - 12} more; use decision_list for the complete index.`);
      lines.push("");
    }
    if (relevantPlans.length) {
      lines.push("## Active plans");
      for (const plan of relevantPlans) {
        const title = localizedValue(translations, "plan", plan.id, locale, "title", plan.title);
        const summary = localizedValue(translations, "plan", plan.id, locale, "summary", plan.summary);
        const nextAction = localizedValue(translations, "plan", plan.id, locale, "nextAction", plan.nextAction);
        lines.push(`- [plan:${plan.id}] ${title} — ${plan.phase} #${plan.planOrder} · ${plan.priority} · ${plan.derivedStatus}`);
        const scopes = snapshot.planChainScopes.filter((scope) => scope.planId === plan.id).sort((a, b) => a.position - b.position);
        const changes = snapshot.planChanges.filter((change) => change.planId === plan.id).sort((a, b) => a.position - b.position);
        // A Plan can legitimately cover many Blocks, but a task context must
        // not repeat every PlanChange merely because those Blocks are in the
        // selected Plan.  Keep the direct Block index complete above, then
        // project only changes that match the task (or an explicitly focused
        // Block/Chain).  Terms shared by most changes, such as a product name,
        // are treated as noise so they cannot pull every change into context.
        const changeTexts = changes.map((change) =>
          `${change.title} ${change.summary} ${change.currentBehavior} ${change.proposedBehavior} ${change.rationale}`.toLowerCase(),
        );
        const changeTermFrequency = new Map(terms.map((term) => [term, changeTexts.filter((text) => text.includes(term)).length]));
        const broadChangeTermLimit = Math.max(2, Math.ceil(changes.length / 2));
        const explicitBlockIDs = new Set(focusRefs.filter((ref) => ref.startsWith("block:")).map((ref) => ref.slice("block:".length)));
        const explicitChainIDs = new Set(focusRefs.filter((ref) => ref.startsWith("chain:")).map((ref) => ref.slice("chain:".length)));
        const taskChanges = changes
          .map((change) => {
            const text = `${change.title} ${change.summary} ${change.currentBehavior} ${change.proposedBehavior} ${change.rationale}`.toLowerCase();
            const semanticScore = terms.reduce((score, term) =>
              score + (term.length > 2 && (changeTermFrequency.get(term) ?? 0) < broadChangeTermLimit && text.includes(term) ? 1 : 0), 0);
            const focused = explicitBlockIDs.has(change.entityId) ||
              (change.entityType === "chain" && explicitChainIDs.has(change.entityId));
            return { change, semanticScore, focused };
          })
          .filter((entry) => entry.focused || entry.semanticScore > 0)
          .sort((left, right) => Number(right.focused) - Number(left.focused) || right.semanticScore - left.semanticScore || left.change.position - right.change.position)
          .slice(0, 3)
          .map((entry) => entry.change);
        lines.push(`  Progress: ${plan.progress.completedSteps}/${plan.progress.totalSteps} ${scopes.length || changes.length ? "changes" : "steps"} · ${plan.progress.passedRequiredCheckpoints}/${plan.progress.totalRequiredCheckpoints} required gates`);
        lines.push(`  Typed: Block ${plan.typedProgress.directBlockChanges.completed}/${plan.typedProgress.directBlockChanges.total} · Chain ${plan.typedProgress.chainChanges.completed}/${plan.typedProgress.chainChanges.total} · Link ${plan.typedProgress.linkChanges.completed}/${plan.typedProgress.linkChanges.total} · Chain gates ${plan.typedProgress.chainIntegrationGates.passed}/${plan.typedProgress.chainIntegrationGates.total} · Plan gates ${plan.typedProgress.planAcceptanceGates.passed}/${plan.typedProgress.planAcceptanceGates.total}`);
        const selectedPlanCoverage = planCoverage.get(plan.id);
        if (selectedPlanCoverage) {
          const directBlocks = changes.filter((change) => change.planId === plan.id && change.entityType === "block").map((change) => `block:${change.entityId}`);
          if (directBlocks.length) lines.push(`  Direct Blocks: ${directBlocks.slice(0, 20).join(", ")}${directBlocks.length > 20 ? ` … (${directBlocks.length} total)` : ""}`);
          if (selectedPlanCoverage.unplannedIds.length) {
            lines.push(`  Uncovered direct Blocks: ${selectedPlanCoverage.unplannedIds.slice(0, 20).map((blockId) => `block:${blockId}`).join(", ")}${selectedPlanCoverage.unplannedIds.length > 20 ? ` … (${selectedPlanCoverage.unplannedIds.length} total)` : ""}`);
          }
          if (selectedPlanCoverage.withoutCheckpointIds.length) {
            lines.push(`  Blocks without checkpoint: ${selectedPlanCoverage.withoutCheckpointIds.slice(0, 20).map((blockId) => `block:${blockId}`).join(", ")}`);
          }
        }
        if (plan.derivedReason) lines.push(`  State: ${plan.derivedReason}`);
        const dependencies = snapshot.planDependencies.filter((item) => item.planId === plan.id).sort((a, b) => a.position - b.position);
        if (dependencies.length) lines.push(`  Prerequisites: ${dependencies.map((item) => `[plan:${item.dependsOnPlanId}]`).join(", ")}`);
        const steps = snapshot.planSteps.filter((item) => item.planId === plan.id).sort((a, b) => a.position - b.position);
        const openSteps = steps.filter((step) => !["complete", "skipped"].includes(step.status)).slice(0, 3);
        for (const step of openSteps) lines.push(`  ${step.position + 1}. ${step.status}: ${step.title}${step.targetRefs.length ? ` (${step.targetRefs.join(", ")})` : ""}`);
        if (steps.length > openSteps.length) lines.push(`  Steps: showing ${openSteps.length} open of ${steps.length} total; use plan_context for full ordering.`);
        const taskChangeIds = new Set(taskChanges.map((change) => change.id));
        for (const scope of scopes) {
          const changeIDs = snapshot.planChainChangeRefs.filter((ref) => ref.chainScopeId === scope.id).sort((a, b) => a.position - b.position).map((ref) => ref.planChangeId);
          const matchingIDs = changeIDs.filter((changeID) => taskChangeIds.has(changeID));
          lines.push(`  ChainScope ${scope.position + 1}: ${scope.title} [chain:${scope.chainId}]${matchingIDs.length ? ` · relevant ${matchingIDs.map((changeID) => `[plan_change:${changeID}]`).join(", ")}` : ""}`);
        }
        if (taskChanges.length) {
          lines.push("  Task-relevant canonical changes:");
          for (const change of taskChanges) {
            lines.push(`  - [plan_change:${change.id}] ${change.title} · target ${change.entityType}:${change.entityId}: ${change.currentBehavior || "—"} -> ${change.proposedBehavior || change.summary || "—"}`);
            if (change.prohibitions.length) lines.push(`    Must not: ${change.prohibitions.join("; ")}`);
            if (change.sourceRefs.length) lines.push(`    Sources: ${change.sourceRefs.join(", ")}`);
          }
        }
        if (changes.length > taskChanges.length) lines.push(`  ${changes.length - taskChanges.length} additional canonical change(s): use plan_context to expand the Plan.`);
        if (summary) lines.push(`  ${summary}`);
        if (nextAction) lines.push(`  Next: ${nextAction}`);
      }
      lines.push("");
    }
    const hasExplicitChainFocus = focusRefs.some((ref) => ref.startsWith("chain:"));
    const hasSemanticChainMatch = scoredChains.some((entry) => selectedChainIds.has(entry.chain.id));
    if (relevantChains.length && (selectedPlanIds.size === 0 || hasExplicitChainFocus || hasSemanticChainMatch)) {
      lines.push("## Target chains");
      for (const chain of relevantChains) {
        const title = localizedValue(translations, "chain", chain.id, locale, "title", chain.title);
        const path = snapshot.chainNodes
          .filter((node) => node.chainId === chain.id)
          .sort((left, right) => left.position - right.position)
          .map((node) => `block:${node.blockId}`)
          .join(" → ");
        lines.push(`- [chain:${chain.id}] ${title} — ${chain.deliveryState}/${chain.healthState}${path ? ` · path ${path}` : ""}`);
        const intent = localizedValue(translations, "chain", chain.id, locale, "intent", chain.intent);
        if (intent && (selectedPlanIds.size === 0 || hasExplicitChainFocus)) lines.push(`  ${intent}`);
      }
      lines.push("");
    }
    const explicitBlockFocusIds = new Set(focusRefs.filter((ref) => ref.startsWith("block:")).map((ref) => ref.slice("block:".length)));
    const chainOrder = new Map();
    for (const chainId of selectedChainIds) {
      snapshot.chainNodes
        .filter((node) => node.chainId === chainId)
        .sort((left, right) => left.position - right.position)
        .forEach((node, index) => {
          const current = chainOrder.get(node.blockId);
          if (current === undefined || index < current) chainOrder.set(node.blockId, index);
        });
    }
    const orderedRelevantBlocks = [...relevantBlocks].sort((left, right) =>
      (chainOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (chainOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
      left.localOrder - right.localOrder || left.id.localeCompare(right.id),
    );
    // Plan context must show its direct Block work even when the caller only
    // focused the Plan.  `focusRefs=block:*` remains an optional narrower read;
    // it must not be the implicit gate for plan coverage.
    const contentBlocks = selectedPlanIds.size && explicitBlockFocusIds.size
      ? orderedRelevantBlocks.filter((block) => explicitBlockFocusIds.has(block.id))
      : orderedRelevantBlocks;
    if (contentBlocks.length) {
      lines.push("## Architecture order / relevant Blocks");
      contentBlocks.forEach((block, index) => {
        const title = localizedValue(translations, "block", block.id, locale, "title", block.title);
        const summary = localizedValue(translations, "block", block.id, locale, "summary", block.summary);
        const body = localizedValue(translations, "block", block.id, locale, "body", block.body);
        const contract = localizedValue(translations, "block", block.id, locale, "contract", block.contract);
        const isGhost = block.deliveryState === "proposed" || block.deliveryState === "planned";
        const stateTag = isGhost ? "Ghost (Virtual Blueprint)" : "Solid (Anchored)";
        lines.push(`${index + 1}. [block:${block.id}] ${title} — ${stateTag} · ${block.architectureLayer}/${block.scope} · ${block.deliveryState}/${block.healthState}`);
        const sources = snapshot.sourceRefs?.filter((s) => s.blockId === block.id) ?? [];
        if (sources.length > 0) {
          const primary = sources[0];
          lines.push(`  Facade: ${primary.path}${primary.symbol ? ` :: ${primary.symbol}` : ""}${primary.startLine ? ` (L${primary.startLine}-L${primary.endLine})` : ""}`);
        }
        if (summary && (selectedPlanIds.size === 0 || explicitBlockFocusIds.size > 0 || contentBlocks.length <= 3)) lines.push(`  ${summary}`);
        if (body && detailedBlockIds.has(block.id)) lines.push(`  Details: ${body}`);
        if (contract && detailedBlockIds.has(block.id)) lines.push(`  Contract: ${contract}`);
      });
      lines.push("");
    }
    if (relevantLinks.length) {
      lines.push("## Relationships and interfaces");
      for (const link of relevantLinks) {
        const label = localizedValue(translations, "link", link.id, locale, "label", link.label);
        const contract = localizedValue(translations, "link", link.id, locale, "contract", link.contract);
        lines.push(
          `- ${link.sourceType}:${link.sourceId} -[${link.kind}${label ? `:${label}` : ""}]-> ${link.targetType}:${link.targetId}`,
        );
        if (contract && (selectedPlanIds.size === 0 || hasExplicitChainFocus)) lines.push(`  Contract: ${contract}`);
      }
      lines.push("");
    }
    const failing = relevantCheckpoints.filter((checkpoint) => checkpoint.status !== "passed");
    if (failing.length) {
      lines.push("## Open checkpoints");
      for (const checkpoint of failing.slice(0, 6)) {
        lines.push(`- ${checkpoint.status} · ${checkpoint.evidenceLevel}/${checkpoint.requiredEvidenceLevel} · ${checkpoint.coverage}: ${checkpoint.title}`);
      }
      if (failing.length > 6) lines.push(`- … ${failing.length - 6} more; use checkpoint_list for the complete filtered inbox.`);
      lines.push("");
    }
    if (standaloneOpenCheckpoints.length) {
      lines.push("## Standalone verification");
      for (const checkpoint of standaloneOpenCheckpoints) {
        const owner = checkpoint.targetType === "block"
          ? snapshot.blocks.find((block) => block.id === checkpoint.targetId)?.title ?? checkpoint.targetId
          : checkpoint.targetId;
        lines.push(`- ${checkpoint.status} · ${checkpoint.evidenceLevel}/${checkpoint.requiredEvidenceLevel} · ${checkpoint.targetType}:${checkpoint.targetId} (${owner}): ${checkpoint.title}`);
      }
      lines.push("");
    }
    lines.push("## Expand", "Use plan_context for a Plan; use entity_open for a Block, Chain, Link, or Decision when more detail is needed.");
    const fullMarkdown = lines.join("\n");
    const markdown = fullMarkdown.length <= maxChars
      ? fullMarkdown
      : `${fullMarkdown.slice(0, Math.max(0, maxChars - 112))}\n\n[truncated; use plan_context, entity_open, checkpoint_list, or changes_since for the referenced detail]`;
    return {
      graphRevision: snapshot.project.graphRevision,
      refs: [
        ...relevantPlans.map((plan) => `plan:${plan.id}`),
        ...relevantChains.map((chain) => `chain:${chain.id}`),
        ...relevantBlocks.map((block) => `block:${block.id}`),
        ...applicableRuleIds.map((blockId) => `block:${blockId}`),
        ...applicableDecisions.map((decision) => `decision:${decision.id}`),
      ],
      applicableRules: applicableRuleIds.map((blockId) => ({
        ref: `block:${blockId}`,
        scopes: applicableRuleScopes.filter((scope) => scope.blockId === blockId).map((scope) => ({ type: scope.scopeType, value: scope.scopeValue })),
      })),
      applicableDecisions: applicableDecisions.map((decision) => ({
        ref: `decision:${decision.id}`,
        title: decision.title,
        status: decision.status,
        scopes: applicableDecisionScopes.filter((scope) => scope.decisionId === decision.id)
          .map((scope) => ({ type: scope.scopeType, value: scope.scopeValue })),
      })),
      markdown,
    };
  }

  resolveHistoryContext(planId = null, chainScopeId = null) {
    let resolvedPlanId = planId || null;
    if (resolvedPlanId && !entityExists(this.database, this.paths.descriptor.id, "plan", resolvedPlanId)) {
      throw new Error(`plan:${resolvedPlanId} not found`);
    }
    if (chainScopeId) {
      const scope = this.database.prepare(
        `SELECT pcs.plan_id FROM plan_chain_scopes pcs JOIN plans p ON p.id = pcs.plan_id
         WHERE p.project_id = ? AND pcs.id = ?`,
      ).get(this.paths.descriptor.id, chainScopeId);
      if (!scope) throw new Error(`plan_chain_scope:${chainScopeId} not found`);
      if (resolvedPlanId && scope.plan_id !== resolvedPlanId) {
        throw new Error(`plan_chain_scope:${chainScopeId} does not belong to plan:${resolvedPlanId}`);
      }
      resolvedPlanId = scope.plan_id;
    }
    return { planId: resolvedPlanId, chainScopeId: chainScopeId || null };
  }

  createFoundationPlan({
    id = "foundation-plan",
    title = "Foundation Plan",
    goal = "Implement the complete declared architecture in dependency order.",
    requiredEvidenceLevel = "integration",
    actor = "agent",
    reason = "Generate the initial implementation plan from the architecture graph",
    gitHead = null,
  } = {}) {
    if (!id?.trim() || !title?.trim()) throw new Error("Foundation Plan requires id and title");
    assertAllowed(requiredEvidenceLevel, EVIDENCE_LEVELS, "required evidence level");
    const snapshot = this.snapshot();
    if (snapshot.plans.some((plan) => plan.id === id)) throw new Error(`plan:${id} already exists`);
    const blocks = snapshot.blocks.filter((block) =>
      !block.archived && block.kind !== "decision" && !["complete", "deprecated"].includes(block.deliveryState),
    );
    if (blocks.length === 0) throw new Error("No unimplemented Blocks are available for a Foundation Plan");

    const groups = foundationBlockGroups(snapshot, blocks);
    const orderedBlocks = groups.flat();
    const checkpointIds = new Set(snapshot.checkpoints.map((checkpoint) => checkpoint.id));
    const checkpointByBlock = new Map();
    const operations = [{
      action: "create_plan",
      id,
      fields: {
        title: title.trim(),
        summary: "Automatically generated from every non-deprecated unimplemented Block, including standalone Blocks.",
        goal,
        status: "ready",
        priority: "critical",
        phase: "foundation",
        planOrder: 1,
        nextAction: groups[0]?.length
          ? `Implement parallel group 1: ${groups[0].map((block) => `block:${block.id}`).join(", ")}`
          : "Review generated coverage.",
      },
    }];

    for (const block of orderedBlocks) {
      const existing = snapshot.checkpoints
        .filter((checkpoint) => checkpoint.targetType === "block" && checkpoint.targetId === block.id && checkpoint.checkpointKind === "atomic")
        .sort((left, right) => left.id.localeCompare(right.id))[0];
      const checkpointId = existing?.id ?? `${id}-proof-${block.id}`;
      checkpointByBlock.set(block.id, { id: checkpointId, revision: existing?.currentRevision ?? 1, existing: Boolean(existing) });
      if (!existing) {
        if (checkpointIds.has(checkpointId)) throw new Error(`checkpoint:${checkpointId} already exists`);
        checkpointIds.add(checkpointId);
        operations.push({
          action: "create_checkpoint",
          id: checkpointId,
          fields: {
            targetType: "block",
            targetId: block.id,
            title: `Verify ${block.title}`,
            criteria: block.contract || `Verify block:${block.id} satisfies its declared responsibility.`,
            status: "pending",
            checkpointKind: "atomic",
            coverage: "complete",
            requiredEvidenceLevel,
          },
        });
      }
    }

    const changes = orderedBlocks.map((block, position) => ({
      id: `${id}-change-${block.id}`,
      entityType: "block",
      entityId: block.id,
      position,
      title: `Implement ${block.title}`,
      summary: block.summary,
      currentBehavior: `Delivery state: ${block.deliveryState}.`,
      proposedBehavior: block.contract || `Implement the responsibility declared by block:${block.id}.`,
      rationale: "The Foundation Plan covers every unimplemented Block directly; Chain membership is not required.",
      expectedEffects: [`block:${block.id} reaches its atomic checkpoint`],
      status: ["implementing", "verifying"].includes(block.deliveryState) ? "active" : "pending",
    }));
    operations.push({ action: "set_plan_changes", id, expectedRevision: 1, fields: { changes } });

    const selectedIds = new Set(orderedBlocks.map((block) => block.id));
    const chains = snapshot.chains.filter((chain) =>
      snapshot.chainNodes.some((node) => node.chainId === chain.id && selectedIds.has(node.blockId)),
    ).sort((left, right) => left.id.localeCompare(right.id));
    const scopes = chains.map((chain, position) => {
      const nodeIds = snapshot.chainNodes.filter((node) => node.chainId === chain.id).sort((a, b) => a.position - b.position).map((node) => node.blockId);
      const linkIds = snapshot.chainEdges.filter((edge) => edge.chainId === chain.id).sort((a, b) => a.position - b.position).map((edge) => edge.linkId);
      return {
        id: `${id}-scope-${chain.id}`,
        chainId: chain.id,
        position,
        title: `Integrate ${chain.title}`,
        summary: "Verify the reusable Chain after its required Block work is complete.",
        rationale: "Chains integrate paths; they do not own their Blocks.",
        nodeIds,
        linkIds,
        status: "pending",
      };
    });
    operations.push({ action: "set_plan_chain_scopes", id, expectedRevision: 2, fields: { scopes } });
    operations.push({
      action: "set_plan_steps",
      id,
      expectedRevision: 3,
      fields: { steps: groups.map((group, index) => ({
        id: `${id}-step-${index + 1}`,
        title: `Parallel implementation group ${index + 1}`,
        action: `Implement ${group.map((block) => `block:${block.id}`).join(", ")}`,
        status: "pending",
        targetRefs: group.map((block) => `block:${block.id}`),
      })).concat(chains.length ? [{
        id: `${id}-step-integration`,
        title: "Integrate Chain paths",
        action: "Run every required Chain integration gate.",
        status: "pending",
        targetRefs: chains.map((chain) => `chain:${chain.id}`),
      }] : [], [{
        id: `${id}-step-acceptance`,
        title: "Accept the Foundation Plan",
        action: "Run the final Plan acceptance gate after all required children pass.",
        status: "pending",
        targetRefs: [`plan:${id}`],
      }]) },
    });

    for (const block of orderedBlocks) {
      const checkpoint = checkpointByBlock.get(block.id);
      const existingBindings = checkpoint.existing
        ? snapshot.checkpointBindings.filter((binding) => binding.checkpointId === checkpoint.id).map((binding) => ({
          subjectType: binding.subjectType, subjectId: binding.subjectId, role: binding.role, required: binding.required,
        }))
        : [];
      operations.push({
        action: "set_checkpoint_bindings",
        id: checkpoint.id,
        expectedRevision: checkpoint.revision,
        fields: { bindings: existingBindings.concat({
          subjectType: "plan_change", subjectId: `${id}-change-${block.id}`, role: "acceptance", required: true,
        }) },
      });
    }

    const chainGateIds = [];
    for (const [index, chain] of chains.entries()) {
      const gateId = `${id}-gate-${chain.id}`;
      if (checkpointIds.has(gateId)) throw new Error(`checkpoint:${gateId} already exists`);
      checkpointIds.add(gateId);
      chainGateIds.push(gateId);
      operations.push({
        action: "create_checkpoint", id: gateId, fields: {
          targetType: "chain", targetId: chain.id, title: `Integrate ${chain.title}`,
          criteria: `Verify chain:${chain.id} works as one ordered path after its required Block and Link checks pass.`,
          status: "pending", checkpointKind: "integration", eligibleAfterChildren: true,
          coverage: "complete", requiredEvidenceLevel,
        },
      });
      operations.push({
        action: "set_checkpoint_bindings", id: gateId, expectedRevision: 1, fields: { bindings: [{
          subjectType: "plan_chain_scope", subjectId: scopes[index].id, role: "integration", required: true,
        }] },
      });
      const childIds = new Set();
      for (const blockId of scopes[index].nodeIds) {
        const selected = checkpointByBlock.get(blockId);
        const existing = snapshot.checkpoints.find((item) =>
          item.targetType === "block" && item.targetId === blockId && item.checkpointKind === "atomic",
        );
        if (selected?.id || existing?.id) childIds.add(selected?.id ?? existing.id);
      }
      for (const linkId of scopes[index].linkIds) {
        for (const checkpoint of snapshot.checkpoints.filter((item) => item.targetType === "link" && item.targetId === linkId)) childIds.add(checkpoint.id);
      }
      operations.push({
        action: "set_checkpoint_dependencies", id: gateId, expectedRevision: 2,
        fields: { children: [...childIds].map((checkpointId) => ({ checkpointId, required: true })) },
      });
    }

    const acceptanceId = `${id}-acceptance`;
    if (checkpointIds.has(acceptanceId)) throw new Error(`checkpoint:${acceptanceId} already exists`);
    operations.push({
      action: "create_checkpoint", id: acceptanceId, fields: {
        targetType: "plan", targetId: id, title: `${title.trim()} acceptance`,
        criteria: "Accept the whole Foundation Plan only after every direct Block check and Chain integration gate passes.",
        status: "pending", checkpointKind: "integration", eligibleAfterChildren: true,
        coverage: "complete", requiredEvidenceLevel,
      },
    });
    operations.push({
      action: "set_checkpoint_bindings", id: acceptanceId, expectedRevision: 1,
      fields: { bindings: [{ subjectType: "plan", subjectId: id, role: "acceptance", required: true }] },
    });
    operations.push({
      action: "set_checkpoint_dependencies", id: acceptanceId, expectedRevision: 2,
      fields: { children: [...orderedBlocks.map((block) => checkpointByBlock.get(block.id).id), ...chainGateIds]
        .map((checkpointId) => ({ checkpointId, required: true })) },
    });

    const mutation = this.mutate(
      { actor, reason, task: "foundation-plan-bootstrap", gitHead, operations },
      { maxOperations: Number.MAX_SAFE_INTEGER, maxInputBytes: Number.MAX_SAFE_INTEGER },
    );
    const context = this.planContext({ id, maxChars: 24000 });
    return {
      ...mutation,
      plan: context.plan,
      generated: {
        blockIds: orderedBlocks.map((block) => block.id),
        parallelGroups: groups.map((group) => group.map((block) => block.id)),
        chainIds: chains.map((chain) => chain.id),
        blockCheckpointIds: orderedBlocks.map((block) => checkpointByBlock.get(block.id).id),
        chainGateIds,
        planAcceptanceCheckpointId: acceptanceId,
      },
      markdown: context.markdown,
    };
  }

  graphPatch({
    patch, actor = "agent", reason, task = "compact-patch", gitHead = null,
    planId = null, chainScopeId = null,
  } = {}) {
    const parsed = parseGraphPatch(patch);
    const metadata = parsed.metadata ?? {};
    const allowedMetadata = new Set(["base", "plan", "chainScope", "actor", "reason", "task"]);
    for (const key of Object.keys(metadata)) {
      if (!allowedMetadata.has(key)) throw new Error(`Unsupported compact patch header field: ${key}`);
    }
    const before = this.snapshot();
    const baseRevision = metadata.base;
    if (baseRevision != null && (!Number.isInteger(baseRevision) || baseRevision < 0)) {
      throw new Error("Compact patch base must be a non-negative graph revision");
    }
    if (baseRevision != null && baseRevision !== before.project.graphRevision) {
      throw new Error(`Graph base revision conflict; expected ${baseRevision}, current ${before.project.graphRevision}`);
    }
    const resolvedPlanId = planId ?? metadata.plan ?? null;
    const resolvedChainScopeId = chainScopeId ?? metadata.chainScope ?? null;
    const resolvedActor = actor === "agent" && metadata.actor ? metadata.actor : actor;
    const resolvedReason = reason?.trim() || metadata.reason?.trim();
    if (!resolvedReason) throw new Error("Compact patch requires reason=... in the header or a reason argument");
    const resolvedTask = task === "compact-patch" && metadata.task ? metadata.task : task;
    const fieldAliases = {
      delivery: "deliveryState",
      health: "healthState",
      layer: "architectureLayer",
      order: "localOrder",
    };
    const normalizeFields = (fields = {}) => Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [fieldAliases[key] ?? key, value]),
    );
    const collections = {
      block: before.blocks,
      chain: before.chains,
      link: before.links,
      plan: before.plans,
      decision: before.decisions,
      checkpoint: before.checkpoints,
      plan_change: before.planChanges,
      plan_scope: before.planChainScopes,
    };
    const findEntity = (type, id) => collections[type]?.find((item) => item.id === id) ?? null;
    const requireEntity = (type, id) => {
      const entity = findEntity(type, id);
      if (!entity) throw new Error(`${type}:${id} not found`);
      return entity;
    };
    const resolvePlanForChange = (changeId) => {
      if (resolvedPlanId) return requireEntity("plan", resolvedPlanId);
      const matches = before.planChanges.filter((change) => change.id === changeId);
      if (matches.length !== 1) throw new Error(`plan_change:${changeId} requires plan=... when it is not unique`);
      return requireEntity("plan", matches[0].planId);
    };
    const checkpointForTarget = (targetType, targetId) => before.checkpoints
      .filter((checkpoint) => checkpoint.targetType === targetType && checkpoint.targetId === targetId)
      .sort((left, right) => (left.checkpointKind === "atomic" ? -1 : 1) - (right.checkpointKind === "atomic" ? -1 : 1) || left.id.localeCompare(right.id))[0] ?? null;
    const normalizeCheckpointFields = (fields, targetType, targetId, existing) => {
      const normalized = normalizeFields(fields);
      const raw = existing ? this.database.prepare("SELECT status FROM checkpoints WHERE project_id = ? AND id = ?")
        .get(this.paths.descriptor.id, existing.id) : null;
      if (normalized.evidence != null && !Array.isArray(normalized.evidence)) {
        normalized.evidence = [{ kind: "compact-patch", summary: String(normalized.evidence) }];
      }
      return {
        ...normalized,
        targetType,
        targetId,
        title: normalized.title ?? existing?.title ?? `Verify ${targetType}:${targetId}`,
        criteria: normalized.criteria ?? existing?.criteria ?? `Verify ${targetType}:${targetId} satisfies its declared responsibility.`,
        status: normalized.status ?? raw?.status ?? existing?.status ?? "pending",
        checkpointKind: normalized.checkpointKind ?? existing?.checkpointKind ?? "atomic",
        coverage: normalized.coverage ?? existing?.coverage ?? "complete",
        evidenceLevel: normalized.evidenceLevel ?? existing?.evidenceLevel ?? (normalized.status === "passed" ? "static" : "none"),
        requiredEvidenceLevel: normalized.requiredEvidenceLevel ?? existing?.requiredEvidenceLevel ?? "static",
        aggregationPolicy: normalized.aggregationPolicy ?? existing?.aggregationPolicy ?? {},
        eligibleAfterChildren: normalized.eligibleAfterChildren ?? existing?.eligibleAfterChildren ?? false,
        evidence: normalized.evidence ?? existing?.evidence ?? [],
        invalidatedAt: normalized.invalidatedAt ?? existing?.invalidatedAt ?? null,
      };
    };
    const operations = [];
    const autoPlanEntries = [];
    for (const item of parsed.operations) {
      const fields = normalizeFields(item.fields);
      const targetType = item.targetType;
      const targetId = item.targetId;
      if (item.action === "source") {
        if (targetType !== "block") throw new Error(`source target must be block:${targetId}`);
        requireEntity("block", targetId);
        operations.push({ action: "add_source_ref", id: targetId, fields });
        continue;
      }
      if (item.action === "checkpoint" || (item.action === "update" && targetType === "checkpoint")) {
        let existing;
        let checkpointTargetType = targetType;
        let checkpointTargetId = targetId;
        if (targetType === "checkpoint") {
          existing = requireEntity("checkpoint", targetId);
          checkpointTargetType = existing.targetType;
          checkpointTargetId = existing.targetId;
        } else {
          requireEntity(targetType, targetId);
          existing = checkpointForTarget(targetType, targetId);
        }
        const checkpointId = existing?.id ?? fields.id ?? `${checkpointTargetType}-${checkpointTargetId}-checkpoint`;
        delete fields.id;
        operations.push({
          action: "record_checkpoint",
          id: checkpointId,
          expectedRevision: item.expectedRevision ?? existing?.currentRevision,
          fields: normalizeCheckpointFields(fields, checkpointTargetType, checkpointTargetId, existing),
        });
        continue;
      }
      if (targetType === "plan_change") {
        if (item.action !== "update") throw new Error("plan_change supports update only");
        const plan = resolvePlanForChange(targetId);
        requireEntity("plan_change", targetId);
        operations.push({
          action: "update_plan_change",
          id: plan.id,
          expectedRevision: item.expectedRevision ?? plan.currentRevision,
          fields: { changeId: targetId, patch: fields },
        });
        continue;
      }
      if (targetType === "plan_scope") {
        if (item.action !== "update") throw new Error("plan_scope supports update only");
        const scope = requireEntity("plan_scope", targetId);
        const plan = resolvedPlanId ? requireEntity("plan", resolvedPlanId) : requireEntity("plan", scope.planId);
        operations.push({
          action: "update_plan_chain_scope",
          id: plan.id,
          expectedRevision: item.expectedRevision ?? plan.currentRevision,
          fields: { scopeId: targetId, patch: fields },
        });
        continue;
      }
      if (!["block", "chain", "link", "plan", "decision"].includes(targetType)) {
        throw new Error(`Unsupported compact patch target ${targetType}:${targetId}`);
      }
      if (item.action === "create") {
        const operationFields = { ...fields };
        const autoCheckpoint = targetType === "block" && operationFields.checkpoint === "auto";
        delete operationFields.checkpoint;
        operations.push({ action: `create_${targetType}`, id: targetId, fields: operationFields });
        if (autoCheckpoint) {
          operations.push({
            action: "create_checkpoint",
            id: `${targetId}-checkpoint`,
            fields: {
              targetType: "block",
              targetId,
              title: `Verify ${operationFields.title}`,
              criteria: operationFields.contract || `Verify block:${targetId} satisfies its declared responsibility.`,
              status: "pending",
              checkpointKind: "atomic",
              coverage: "complete",
              requiredEvidenceLevel: "static",
            },
          });
          if (resolvedPlanId) {
            const plan = requireEntity("plan", resolvedPlanId);
            const changeId = `${plan.id}-change-${targetId}`;
            if (before.planChanges.some((change) => change.id === changeId)) {
              throw new Error(`plan_change:${changeId} already exists; use update plan_change:${changeId}`);
            }
            autoPlanEntries.push({
              plan,
              checkpointId: `${targetId}-checkpoint`,
              change: {
                id: changeId,
                entityType: "block",
                entityId: targetId,
                title: `Implement ${operationFields.title}`,
                summary: operationFields.summary ?? "",
                currentBehavior: `Delivery state: ${operationFields.deliveryState ?? "proposed"}.`,
                proposedBehavior: operationFields.contract || `Implement the responsibility declared by block:${targetId}.`,
                rationale: "The compact patch directly covers this Block; Chain membership is not required.",
                expectedEffects: [`block:${targetId} reaches its atomic checkpoint`],
                status: "pending",
              },
            });
          }
        }
        continue;
      }
      if (item.action !== "update") throw new Error(`${item.action} does not support ${targetType}:${targetId}`);
      const entity = requireEntity(targetType, targetId);
      operations.push({
        action: `update_${targetType}`,
        id: targetId,
        expectedRevision: item.expectedRevision ?? entity.currentRevision,
        fields,
      });
    }
    if (autoPlanEntries.length) {
      const plan = autoPlanEntries[0].plan;
      if (autoPlanEntries.some((entry) => entry.plan.id !== plan.id)) {
        throw new Error("A compact patch cannot auto-bind Blocks to multiple Plans");
      }
      const existingChanges = before.planChanges
        .filter((change) => change.planId === plan.id)
        .sort((left, right) => left.position - right.position)
        .map((change) => ({
          id: change.id,
          entityType: change.entityType,
          entityId: change.entityId,
          title: change.title,
          summary: change.summary,
          currentBehavior: change.currentBehavior,
          proposedBehavior: change.proposedBehavior,
          rationale: change.rationale,
          prohibitions: change.prohibitions,
          expectedEffects: change.expectedEffects,
          sourceRefs: change.sourceRefs,
          localizations: change.localizations,
          status: change.status,
        }));
      operations.push({
        action: "set_plan_changes",
        id: plan.id,
        expectedRevision: plan.currentRevision,
        fields: { changes: existingChanges.concat(autoPlanEntries.map((entry) => entry.change)) },
      });
      for (const entry of autoPlanEntries) {
        operations.push({
          action: "set_checkpoint_bindings",
          id: entry.checkpointId,
          expectedRevision: 1,
          fields: { bindings: [{ subjectType: "plan_change", subjectId: entry.change.id, role: "acceptance", required: true }] },
        });
      }
    }
    if (operations.length > 20) throw new Error("Compact patch expands to more than 20 operations; split it into smaller patches");
    const mutation = this.mutate(
      {
        actor: resolvedActor,
        reason: resolvedReason,
        task: resolvedTask,
        gitHead,
        planId: resolvedPlanId,
        chainScopeId: resolvedChainScopeId,
        operations,
      },
      { maxOperations: 20, maxInputBytes: 65536 },
    );
    const after = this.snapshot();
    const coverage = architectureCoverage(after);
    const validation = this.validate();
    const unverified = coverage.unverifiedIds.map((id) => `block:${id}`);
    const markdown = [
      "# Graph patch",
      "- Protocol: mdflow/1",
      `- ChangeSet: ${mutation.changeSetId}`,
      `- Graph revision: ${before.project.graphRevision} → ${mutation.graphRevision}`,
      `- Applied: ${mutation.receipts.length} operation(s)`,
      `- Validation: ${validation.valid ? "valid" : "invalid"} · ${validation.errors.length} error(s) · ${validation.warnings.length} warning(s)`,
      "",
      "## Applied",
      ...mutation.receipts.map((receipt) => `- ${receipt.action} ${receipt.ref ?? `${receipt.entityType}:${receipt.id}`} · r${receipt.revision}${receipt.summary ? ` · ${receipt.summary}` : ""}`),
      "",
      "## Coverage",
      `- Blocks: ${coverage.totalBlocks} total · ${coverage.verified} verified · ${coverage.planned} planned · ${coverage.withCheckpoint} with checkpoints`,
      `- Chains: ${coverage.inChains} in Chains · ${coverage.outsideChainIds.length} standalone · ${coverage.failingIds.length} failing`,
      ...(unverified.length ? [`- Unverified: ${unverified.join(", ")}`] : []),
      "",
      "## Next",
      "Use entity_open for changed refs and graph_validate for the full validation report.",
    ].join("\n");
    return {
      ...mutation,
      baseRevision: before.project.graphRevision,
      patchVersion: parsed.version,
      operations,
      coverage,
      validation,
      markdown,
    };
  }

  mutate(
    { actor = "agent", reason, task = "", gitHead = null, planId = null, chainScopeId = null, operations },
    { maxOperations = 20, maxInputBytes = 65536 } = {},
  ) {
    if (!reason?.trim()) throw new Error("reason is required");
    if (!Array.isArray(operations) || operations.length === 0) throw new Error("operations are required");

    if (operations.length > maxOperations) throw new Error(`graph_mutate accepts at most ${maxOperations} operations`);
    if (JSON.stringify(operations).length > maxInputBytes) throw new Error("graph_mutate input exceeds 64 KB");

    this.ensureSynced();

    const database = this.database;
    const projectId = this.paths.descriptor.id;
    const changeSetId = identifier("change");
    const timestamp = now();
    const receipts = [];
    const historyContext = this.resolveHistoryContext(planId, chainScopeId);

    const mutationResult = transaction(database, () => {
      database
        .prepare(
          `INSERT INTO change_sets(id, project_id, actor, reason, task, git_head, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(changeSetId, projectId, actor, reason.trim(), task, gitHead, timestamp);

      for (const operation of operations) {
        const predictedType = operationEntityType(operation.action);
        const before = predictedType && operation.id ? this.historyStateForOperation(operation, predictedType, operation.id) : {};
        const receipt = this.applyOperation(operation, { changeSetId, timestamp });
        receipt.ref = `${receipt.entityType}:${receipt.id}`;
        receipt.uiLocation = this.uiLocationFor(receipt.entityType, receipt.id);
        receipt.readBack = { ref: receipt.ref, revision: receipt.revision };
        const after = this.historyStateForOperation(operation, receipt.entityType, receipt.id);
        const candidateFields = ["source-linked", "source-removed"].includes(receipt.action)
          ? ["sourceRefs"]
          : operation.action === "update_plan_change" || operation.action === "update_plan_chain_scope"
            ? Object.keys(operation.fields?.patch ?? {})
            : Object.keys(operation.fields ?? {});
        const changedFields = changedHistoryFields(before, after, candidateFields);
        const affectedRefs = new Set([receipt.ref, ...affectedRefsForOperation(operation)]);
        if (historyContext.planId) affectedRefs.add(`plan:${historyContext.planId}`);
        if (historyContext.chainScopeId) affectedRefs.add(`plan_chain_scope:${historyContext.chainScopeId}`);
        receipts.push(receipt);
        database
          .prepare(
            `INSERT INTO history(
              change_set_id, entity_type, entity_id, action, revision, summary, plan_id, chain_scope_id,
              before_json, after_json, changed_fields_json, affected_refs_json, evidence_refs_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            changeSetId,
            receipt.entityType,
            receipt.id,
            receipt.action,
            receipt.revision,
            receipt.summary,
            historyContext.planId ?? (receipt.entityType === "plan" ? receipt.id : null),
            historyContext.chainScopeId,
            JSON.stringify(before ?? {}),
            JSON.stringify(after ?? {}),
            JSON.stringify(changedFields),
            JSON.stringify([...affectedRefs]),
            JSON.stringify([]),
            timestamp,
          );
        database
          .prepare(
            `INSERT INTO change_feed(project_id, change_set_id, entity_type, entity_id, action, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(projectId, changeSetId, receipt.entityType, receipt.id, receipt.action, timestamp);
      }

      database
        .prepare(
          `UPDATE projects SET graph_revision = graph_revision + 1, updated_at = ? WHERE id = ?`,
        )
        .run(timestamp, projectId);
      const graphRevision = database.prepare("SELECT graph_revision FROM projects WHERE id = ?").get(projectId)
        .graph_revision;
      return { changeSetId, graphRevision, receipts };
    });

    if (this.paths.graphJsonPath) {
      try {
        exportGraphToJson(this.database, this.paths.graphJsonPath);
      } catch {
        // preserve mutationResult even if export fails
      }
    }

    return mutationResult;
  }

  historyStateForOperation(operation, entityType, id) {
    if (operation.action === "update_plan_change") {
      const row = this.database.prepare(
        "SELECT pc.* FROM plan_changes pc JOIN plans p ON p.id = pc.plan_id WHERE p.project_id = ? AND pc.plan_id = ? AND pc.id = ?",
      ).get(this.paths.descriptor.id, id, operation.fields?.changeId);
      return row ? normalizePlanChange(row) : {};
    }
    if (operation.action === "update_plan_chain_scope") {
      const row = this.database.prepare(
        "SELECT pcs.* FROM plan_chain_scopes pcs JOIN plans p ON p.id = pcs.plan_id WHERE p.project_id = ? AND pcs.plan_id = ? AND pcs.id = ?",
      ).get(this.paths.descriptor.id, id, operation.fields?.scopeId);
      return row ? normalizePlanChainScope(row) : {};
    }
    return this.historyState(entityType, id);
  }

  historyState(entityType, id) {
    if (entityType === "block") {
      const row = this.database.prepare("SELECT * FROM blocks WHERE project_id = ? AND id = ?").get(this.paths.descriptor.id, id);
      return row ? {
        ...normalizeBlock(row),
        sourceRefs: this.database.prepare("SELECT path, start_line, end_line, symbol, role FROM source_refs WHERE block_id = ? ORDER BY id").all(id),
      } : {};
    }
    if (entityType === "chain") {
      const row = this.database.prepare("SELECT * FROM chains WHERE project_id = ? AND id = ?").get(this.paths.descriptor.id, id);
      return row ? {
        ...normalizeChain(row),
        nodeIds: this.database.prepare("SELECT block_id FROM chain_nodes WHERE chain_id = ? ORDER BY position").all(id).map((item) => item.block_id),
        linkIds: this.database.prepare("SELECT link_id FROM chain_edges WHERE chain_id = ? ORDER BY position").all(id).map((item) => item.link_id),
      } : {};
    }
    if (entityType === "link") {
      const row = this.database.prepare("SELECT * FROM links WHERE project_id = ? AND id = ?").get(this.paths.descriptor.id, id);
      return row ? normalizeLink(row) : {};
    }
    if (entityType === "plan") {
      const row = this.database.prepare("SELECT * FROM plans WHERE project_id = ? AND id = ?").get(this.paths.descriptor.id, id);
      return row ? {
        ...normalizePlan(row),
        chainScopeIds: this.database.prepare("SELECT id FROM plan_chain_scopes WHERE plan_id = ? ORDER BY position").all(id).map((item) => item.id),
        changeIds: this.database.prepare("SELECT id FROM plan_changes WHERE plan_id = ? ORDER BY position").all(id).map((item) => item.id),
      } : {};
    }
    if (entityType === "decision") {
      const row = this.database.prepare("SELECT * FROM decisions WHERE project_id = ? AND id = ?").get(this.paths.descriptor.id, id);
      return row ? {
        ...normalizeDecision(row),
        scopes: this.database.prepare("SELECT scope_type, scope_value FROM decision_scopes WHERE decision_id = ? ORDER BY scope_type, scope_value")
          .all(id).map((item) => ({ type: item.scope_type, value: item.scope_value })),
      } : {};
    }
    if (entityType === "checkpoint") {
      const row = this.database.prepare("SELECT * FROM checkpoints WHERE project_id = ? AND id = ?").get(this.paths.descriptor.id, id);
      return row ? {
        id: row.id, targetType: row.target_type, targetId: row.target_id, title: row.title,
        criteria: row.criteria, status: row.status, checkpointKind: row.checkpoint_kind,
        aggregationPolicy: parseJson(row.aggregation_policy_json, {}),
        eligibleAfterChildren: Boolean(row.eligible_after_children), evidenceLevel: row.evidence_level,
        requiredEvidenceLevel: row.required_evidence_level, coverage: row.coverage,
        evidence: parseJson(row.evidence_json, []), invalidatedAt: row.invalidated_at,
        bindings: this.database.prepare("SELECT subject_type, subject_id, role, required FROM checkpoint_bindings WHERE checkpoint_id = ? ORDER BY position").all(id),
        children: this.database.prepare("SELECT child_checkpoint_id, required FROM checkpoint_dependencies WHERE parent_checkpoint_id = ? ORDER BY position").all(id),
        currentRevision: row.current_revision,
      } : {};
    }
    return {};
  }

  uiLocationFor(entityType, id) {
    if (entityType === "plan") return `Project > Plans > plan:${id}`;
    if (entityType === "decision") return `Project > Decisions > decision:${id}`;
    if (entityType === "chain") return `Project > Chains > chain:${id}`;
    if (entityType === "block") return `Canvas > block:${id}`;
    if (entityType === "link") return `Canvas > link:${id}`;
    if (entityType === "source_ref") return `Project > Block details > Files & Code > ${id}`;
    return `Project > ${entityType}:${id}`;
  }

  applyOperation(operation, context) {
    switch (operation.action) {
      case "create_block":
        return this.createBlock(operation, context);
      case "create_checkpoint":
        return this.createCheckpoint(operation, context);
      case "delete_checkpoint":
        return this.deleteCheckpoint(operation, context);
      case "record_checkpoint":
        return this.recordCheckpointOperation(operation, context);
      case "update_block":
        return this.updateEntity("block", operation, context);
      case "add_source_ref":
        return this.addSourceRef(operation, context);
      case "remove_source_ref":
        return this.removeSourceRef(operation, context);
      case "create_chain":
        return this.createChain(operation, context);
      case "update_chain":
        return this.updateEntity("chain", operation, context);
      case "create_link":
        return this.createLink(operation, context);
      case "update_link":
        return this.updateEntity("link", operation, context);
      case "create_plan":
        return this.createPlan(operation, context);
      case "update_plan":
        return this.updateEntity("plan", operation, context);
      case "set_plan_chains":
        return this.setPlanChains(operation, context);
      case "set_plan_dependencies":
        return this.setPlanDependencies(operation, context);
      case "set_plan_steps":
        return this.setPlanSteps(operation, context);
      case "set_plan_checkpoints":
        return this.setPlanCheckpoints(operation, context);
      case "set_plan_chain_scopes":
        return this.setPlanChainScopes(operation, context);
      case "update_plan_chain_scope":
        return this.updatePlanChainScope(operation, context);
      case "set_plan_changes":
        return this.setPlanChanges(operation, context);
      case "update_plan_change":
        return this.updatePlanChange(operation, context);
      case "set_plan_chain_change_refs":
        return this.setPlanChainChangeRefs(operation, context);
      case "set_checkpoint_bindings":
        return this.setCheckpointBindings(operation, context);
      case "set_checkpoint_dependencies":
        return this.setCheckpointDependencies(operation, context);
      case "set_chain_path":
        return this.setChainPath(operation, context);
      case "set_background_scopes":
        return this.setBackgroundScopes(operation, context);
      case "create_decision":
        return this.createDecision(operation, context);
      case "update_decision":
        return this.updateEntity("decision", operation, context);
      case "set_decision_scopes":
        return this.setDecisionScopes(operation, context);
      default:
        throw new Error(`Unsupported action: ${operation.action}`);
    }
  }

  applyLocalizations(entityType, entityId, localizations, timestamp) {
    if (localizations == null) return;
    if (entityType === "decision") {
      throw new Error("Decision records keep one canonical project-language body; use summary/rationale instead of localizations");
    }
    if (typeof localizations !== "object" || Array.isArray(localizations)) {
      throw new Error("fields.localizations must be an object keyed by locale");
    }
    const allowedFields = LOCALIZED_FIELDS[entityType];
    const upsert = this.database.prepare(
      `INSERT INTO localized_text(entity_type, entity_id, locale, field, value, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_type, entity_id, locale, field)
       DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    for (const [locale, values] of Object.entries(localizations)) {
      assertAllowed(locale, LOCALES, "locale");
      if (typeof values !== "object" || Array.isArray(values) || values == null) {
        throw new Error(`Localization for ${locale} must be an object`);
      }
      for (const [field, value] of Object.entries(values)) {
        if (!allowedFields.has(field)) throw new Error(`${field} cannot be localized on ${entityType}`);
        if (typeof value !== "string") throw new Error(`Localized ${field} must be a string`);
        upsert.run(entityType, entityId, locale, field, value, timestamp);
      }
    }
  }

  removeStaleLocalizations(entityType, entityId, changedFields, localizations) {
    const localizedFields = LOCALIZED_FIELDS[entityType];
    if (!localizedFields) return;
    const explicitlyUpdated = new Set(
      Object.values(localizations ?? {}).flatMap((values) => Object.keys(values ?? {})),
    );
    const remove = this.database.prepare(
      "DELETE FROM localized_text WHERE entity_type = ? AND entity_id = ? AND field = ?",
    );
    for (const field of changedFields) {
      if (localizedFields.has(field) && !explicitlyUpdated.has(field)) {
        remove.run(entityType, entityId, field);
      }
    }
  }

  createPlan(operation, { timestamp }) {
    const fields = operation.fields ?? {};
    if (!fields.title?.trim()) throw new Error("create_plan requires fields.title");
    assertAllowed(fields.status ?? "draft", PLAN_STATUSES, "plan status");
    const id = operation.id ?? identifier("plan");
    this.database.prepare(
      `INSERT INTO plans(
        id, project_id, title, summary, goal, status, priority, phase, plan_order,
        proposed_delta_json, completion_policy_json, next_action, blockers_json, status_reason,
        started_at, completed_at, invalidated_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, this.paths.descriptor.id, fields.title.trim(), fields.summary ?? "", fields.goal ?? "",
      fields.status ?? "draft", fields.priority ?? "normal", fields.phase ?? "implementation", fields.planOrder ?? 0,
      JSON.stringify(fields.proposedDelta ?? []), JSON.stringify(fields.completionPolicy ?? {}),
      fields.nextAction ?? "", JSON.stringify(fields.blockers ?? []), fields.statusReason ?? "",
      fields.startedAt ?? null, fields.completedAt ?? null, fields.invalidatedAt ?? null, timestamp, timestamp,
    );
    this.applyLocalizations("plan", id, fields.localizations, timestamp);
    return { entityType: "plan", id, action: "created", revision: 1, summary: fields.title.trim() };
  }

  setPlanChains(operation) {
    if (!operation.id || !Number.isInteger(operation.expectedRevision)) {
      throw new Error("set_plan_chains requires id and expectedRevision");
    }
    const plan = this.database.prepare("SELECT * FROM plans WHERE project_id = ? AND id = ?")
      .get(this.paths.descriptor.id, operation.id);
    if (!plan) throw new Error(`plan:${operation.id} not found`);
    if (plan.current_revision !== operation.expectedRevision) {
      throw new Error(`Revision conflict for plan:${operation.id}; expected ${operation.expectedRevision}, current ${plan.current_revision}`);
    }
    const chainIds = operation.fields?.chainIds ?? [];
    for (const chainId of chainIds) {
      if (!entityExists(this.database, this.paths.descriptor.id, "chain", chainId)) throw new Error(`chain:${chainId} not found`);
    }
    this.database.prepare("DELETE FROM plan_chain_refs WHERE plan_id = ?").run(operation.id);
    const insert = this.database.prepare("INSERT INTO plan_chain_refs(plan_id, chain_id, position) VALUES (?, ?, ?)");
    chainIds.forEach((chainId, index) => insert.run(operation.id, chainId, index));
    const revision = plan.current_revision + 1;
    this.database.prepare("UPDATE plans SET current_revision = ?, updated_at = ? WHERE id = ?").run(revision, now(), operation.id);
    return { entityType: "plan", id: operation.id, action: "chains-set", revision, summary: `${chainIds.length} target chain(s)` };
  }

  planForMutation(operation, action) {
    if (!operation.id || !Number.isInteger(operation.expectedRevision)) {
      throw new Error(`${action} requires id and expectedRevision`);
    }
    const plan = this.database.prepare("SELECT * FROM plans WHERE project_id = ? AND id = ?")
      .get(this.paths.descriptor.id, operation.id);
    if (!plan) throw new Error(`plan:${operation.id} not found`);
    if (plan.current_revision !== operation.expectedRevision) {
      throw new Error(`Revision conflict for plan:${operation.id}; expected ${operation.expectedRevision}, current ${plan.current_revision}`);
    }
    return plan;
  }

  finishPlanRelationMutation(plan, operation, action, summary) {
    const revision = plan.current_revision + 1;
    this.database.prepare("UPDATE plans SET current_revision = ?, updated_at = ? WHERE id = ?")
      .run(revision, now(), operation.id);
    return { entityType: "plan", id: operation.id, action, revision, summary };
  }

  validatedPlanChainScope(scope, index = 0) {
    if (!scope.chainId || !entityExists(this.database, this.paths.descriptor.id, "chain", scope.chainId)) {
      throw new Error(`chain:${scope.chainId ?? ""} not found`);
    }
    if (!scope.title?.trim()) throw new Error(`Plan ChainScope ${index + 1} requires title`);
    if (!Number.isInteger(scope.position) || scope.position < 0) throw new Error("Plan ChainScope position must be a non-negative integer");
    assertAllowed(scope.status ?? "pending", PLAN_STEP_STATUSES, "Plan ChainScope status");
    const chainNodeIds = this.database.prepare("SELECT block_id FROM chain_nodes WHERE chain_id = ? ORDER BY position")
      .all(scope.chainId).map((row) => row.block_id);
    const chainLinkIds = this.database.prepare("SELECT link_id FROM chain_edges WHERE chain_id = ? ORDER BY position")
      .all(scope.chainId).map((row) => row.link_id);
    const nodeIds = scope.nodeIds ?? chainNodeIds;
    const linkIds = scope.linkIds ?? chainLinkIds;
    if (!Array.isArray(nodeIds) || !Array.isArray(linkIds)) throw new Error("Plan ChainScope nodeIds and linkIds must be arrays");
    let lastPosition = -1;
    for (const blockId of nodeIds) {
      const position = chainNodeIds.indexOf(blockId);
      if (position < 0) throw new Error(`Plan ChainScope references block:${blockId} outside chain:${scope.chainId}`);
      if (position <= lastPosition) throw new Error(`Plan ChainScope nodes must follow chain:${scope.chainId} order`);
      lastPosition = position;
    }
    for (const linkId of linkIds) {
      if (!chainLinkIds.includes(linkId)) throw new Error(`Plan ChainScope references link:${linkId} outside chain:${scope.chainId}`);
    }
    if (scope.startBlockId && nodeIds[0] !== scope.startBlockId) throw new Error("startBlockId must be the first scoped node");
    if (scope.endBlockId && nodeIds.at(-1) !== scope.endBlockId) throw new Error("endBlockId must be the last scoped node");
    return {
      ...scope,
      title: scope.title.trim(),
      startBlockId: scope.startBlockId ?? nodeIds[0] ?? null,
      endBlockId: scope.endBlockId ?? nodeIds.at(-1) ?? null,
      nodeIds,
      linkIds,
      status: scope.status ?? "pending",
    };
  }

  validatedPlanChange(change, index = 0) {
    if (!change.title?.trim()) throw new Error(`Plan change ${index + 1} requires title`);
    if (!Number.isInteger(change.position) || change.position < 0) throw new Error("Plan change position must be a non-negative integer");
    if (!["block", "link", "chain"].includes(change.entityType) ||
        !entityExists(this.database, this.paths.descriptor.id, change.entityType, change.entityId)) {
      throw new Error(`${change.entityType}:${change.entityId} not found`);
    }
    assertAllowed(change.status ?? "pending", PLAN_STEP_STATUSES, "Plan change status");
    return { ...change, title: change.title.trim(), status: change.status ?? "pending" };
  }

  refreshPlanChainRefs(planId) {
    this.database.prepare("DELETE FROM plan_chain_refs WHERE plan_id = ?").run(planId);
    const chainIds = this.database.prepare(
      "SELECT chain_id FROM plan_chain_scopes WHERE plan_id = ? GROUP BY chain_id ORDER BY MIN(position), chain_id",
    ).all(planId).map((row) => row.chain_id);
    const insert = this.database.prepare("INSERT INTO plan_chain_refs(plan_id, chain_id, position) VALUES (?, ?, ?)");
    chainIds.forEach((chainId, index) => insert.run(planId, chainId, index));
  }

  setPlanDependencies(operation) {
    const plan = this.planForMutation(operation, "set_plan_dependencies");
    const planIds = operation.fields?.planIds ?? [];
    if (!Array.isArray(planIds) || new Set(planIds).size !== planIds.length) throw new Error("planIds must be unique");
    for (const dependencyId of planIds) {
      if (dependencyId === operation.id) throw new Error("Plan cannot depend on itself");
      if (!entityExists(this.database, this.paths.descriptor.id, "plan", dependencyId)) throw new Error(`plan:${dependencyId} not found`);
    }
    const existing = this.database.prepare("SELECT plan_id, depends_on_plan_id FROM plan_dependencies").all();
    const adjacency = new Map();
    for (const row of existing) {
      if (row.plan_id === operation.id) continue;
      if (!adjacency.has(row.plan_id)) adjacency.set(row.plan_id, []);
      adjacency.get(row.plan_id).push(row.depends_on_plan_id);
    }
    adjacency.set(operation.id, planIds);
    const visiting = new Set();
    const visited = new Set();
    const hasCycle = (id) => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      for (const next of adjacency.get(id) ?? []) if (hasCycle(next)) return true;
      visiting.delete(id);
      visited.add(id);
      return false;
    };
    if ([...adjacency.keys()].some(hasCycle)) throw new Error("Plan dependencies must remain acyclic");
    this.database.prepare("DELETE FROM plan_dependencies WHERE plan_id = ?").run(operation.id);
    const insert = this.database.prepare("INSERT INTO plan_dependencies(plan_id, depends_on_plan_id, position) VALUES (?, ?, ?)");
    planIds.forEach((id, index) => insert.run(operation.id, id, index));
    return this.finishPlanRelationMutation(plan, operation, "dependencies-set", `${planIds.length} prerequisite plan(s)`);
  }

  setPlanSteps(operation, { timestamp }) {
    const plan = this.planForMutation(operation, "set_plan_steps");
    const steps = operation.fields?.steps ?? [];
    if (!Array.isArray(steps)) throw new Error("steps must be an array");
    const ids = steps.map((step, index) => step.id ?? `${operation.id}-step-${index + 1}`);
    if (new Set(ids).size !== ids.length) throw new Error("Plan step IDs must be unique");
    for (const [index, step] of steps.entries()) {
      if (!step.title?.trim()) throw new Error(`Plan step ${index + 1} requires title`);
      assertAllowed(step.status ?? "pending", PLAN_STEP_STATUSES, "plan step status");
      for (const ref of step.targetRefs ?? []) {
        const [type, id] = String(ref).split(":", 2);
        if (!id || !entityExists(this.database, this.paths.descriptor.id, type, id)) throw new Error(`Missing Plan step target: ${ref}`);
      }
    }
    this.database.prepare("DELETE FROM plan_steps WHERE plan_id = ?").run(operation.id);
    const insert = this.database.prepare(
      `INSERT INTO plan_steps(id, plan_id, position, title, action, status, target_refs_json, proposed_delta_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    steps.forEach((step, index) => insert.run(
      ids[index], operation.id, index, step.title.trim(), step.action ?? "", step.status ?? "pending",
      JSON.stringify(step.targetRefs ?? []), JSON.stringify(step.proposedDelta ?? []), timestamp, timestamp,
    ));
    return this.finishPlanRelationMutation(plan, operation, "steps-set", `${steps.length} ordered step(s)`);
  }

  setPlanCheckpoints(operation) {
    const plan = this.planForMutation(operation, "set_plan_checkpoints");
    const checkpoints = operation.fields?.checkpoints ?? [];
    if (!Array.isArray(checkpoints)) throw new Error("checkpoints must be an array");
    const stepIds = new Set(this.database.prepare("SELECT id FROM plan_steps WHERE plan_id = ?").all(operation.id).map((row) => row.id));
    for (const item of checkpoints) {
      if (!item.checkpointId || !this.database.prepare("SELECT 1 FROM checkpoints WHERE project_id = ? AND id = ?").get(this.paths.descriptor.id, item.checkpointId)) {
        throw new Error(`checkpoint:${item.checkpointId ?? ""} not found`);
      }
      if (item.stepId && !stepIds.has(item.stepId)) throw new Error(`Plan step not found: ${item.stepId}`);
    }
    this.database.prepare("DELETE FROM plan_checkpoint_refs WHERE plan_id = ?").run(operation.id);
    const insert = this.database.prepare(
      "INSERT INTO plan_checkpoint_refs(plan_id, checkpoint_id, step_id, position, required) VALUES (?, ?, ?, ?, ?)",
    );
    checkpoints.forEach((item, index) => insert.run(operation.id, item.checkpointId, item.stepId ?? null, index, item.required === false ? 0 : 1));
    return this.finishPlanRelationMutation(plan, operation, "checkpoints-set", `${checkpoints.length} checkpoint gate(s)`);
  }

  setPlanChainScopes(operation, { timestamp }) {
    const plan = this.planForMutation(operation, "set_plan_chain_scopes");
    const scopes = operation.fields?.scopes ?? [];
    if (!Array.isArray(scopes)) throw new Error("scopes must be an array");
    const ids = scopes.map((scope, index) => scope.id ?? `${operation.id}-chain-scope-${index + 1}`);
    if (new Set(ids).size !== ids.length) throw new Error("Plan ChainScope IDs must be unique");
    const normalizedScopes = scopes.map((scope, index) => this.validatedPlanChainScope({ ...scope, id: ids[index], position: index }, index));
    const existingRows = this.database.prepare("SELECT * FROM plan_chain_scopes WHERE plan_id = ?").all(operation.id);
    const existingById = new Map(existingRows.map((row) => [row.id, row]));
    for (const scope of normalizedScopes) {
      const owner = this.database.prepare("SELECT plan_id FROM plan_chain_scopes WHERE id = ?").get(scope.id);
      if (owner && owner.plan_id !== operation.id) throw new Error(`plan_chain_scope:${scope.id} belongs to another Plan`);
    }
    const desiredIds = new Set(ids);
    const removedIds = existingRows.filter((row) => !desiredIds.has(row.id)).map((row) => row.id);
    for (const id of removedIds) {
      this.database.prepare("DELETE FROM checkpoint_bindings WHERE subject_type = 'plan_chain_scope' AND subject_id = ?").run(id);
      this.database.prepare("DELETE FROM plan_chain_scopes WHERE plan_id = ? AND id = ?").run(operation.id, id);
    }
    const insert = this.database.prepare(
      `INSERT INTO plan_chain_scopes(
        id, plan_id, chain_id, position, title, summary, rationale, start_block_id, end_block_id,
        node_ids_json, link_ids_json, expected_delta_json, prohibitions_json, localizations_json,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const update = this.database.prepare(
      `UPDATE plan_chain_scopes SET
        chain_id = ?, position = ?, title = ?, summary = ?, rationale = ?, start_block_id = ?, end_block_id = ?,
        node_ids_json = ?, link_ids_json = ?, expected_delta_json = ?, prohibitions_json = ?, localizations_json = ?,
        status = ?, current_revision = current_revision + 1, updated_at = ?
       WHERE plan_id = ? AND id = ?`,
    );
    normalizedScopes.forEach((scope) => {
      const values = [
        scope.chainId, scope.position, scope.title, scope.summary ?? "", scope.rationale ?? "",
        scope.startBlockId, scope.endBlockId, JSON.stringify(scope.nodeIds), JSON.stringify(scope.linkIds),
        JSON.stringify(scope.expectedDelta ?? []), JSON.stringify(scope.prohibitions ?? []),
        JSON.stringify(scope.localizations ?? {}), scope.status,
      ];
      if (existingById.has(scope.id)) update.run(...values, timestamp, operation.id, scope.id);
      else insert.run(scope.id, operation.id, ...values, timestamp, timestamp);
    });
    this.refreshPlanChainRefs(operation.id);
    return this.finishPlanRelationMutation(plan, operation, "chain-scopes-set", `${scopes.length} detailed Chain scope(s)`);
  }

  updatePlanChainScope(operation, { timestamp }) {
    const plan = this.planForMutation(operation, "update_plan_chain_scope");
    const scopeId = operation.fields?.scopeId;
    const patch = operation.fields?.patch;
    if (!scopeId || !patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("update_plan_chain_scope requires fields.scopeId and fields.patch");
    }
    for (const field of Object.keys(patch)) {
      if (!EDITABLE_PLAN_CHAIN_SCOPE_FIELDS.has(field)) throw new Error(`Unsupported Plan ChainScope field: ${field}`);
    }
    const row = this.database.prepare("SELECT * FROM plan_chain_scopes WHERE plan_id = ? AND id = ?").get(operation.id, scopeId);
    if (!row) throw new Error(`plan_chain_scope:${scopeId} not found in plan:${operation.id}`);
    const current = normalizePlanChainScope(row);
    const next = this.validatedPlanChainScope({ ...current, ...patch }, current.position);
    this.database.prepare(
      `UPDATE plan_chain_scopes SET
        chain_id = ?, position = ?, title = ?, summary = ?, rationale = ?, start_block_id = ?, end_block_id = ?,
        node_ids_json = ?, link_ids_json = ?, expected_delta_json = ?, prohibitions_json = ?, localizations_json = ?,
        status = ?, current_revision = current_revision + 1, updated_at = ?
       WHERE plan_id = ? AND id = ?`,
    ).run(
      next.chainId, next.position, next.title, next.summary, next.rationale, next.startBlockId, next.endBlockId,
      JSON.stringify(next.nodeIds), JSON.stringify(next.linkIds), JSON.stringify(next.expectedDelta),
      JSON.stringify(next.prohibitions), JSON.stringify(next.localizations), next.status, timestamp, operation.id, scopeId,
    );
    this.refreshPlanChainRefs(operation.id);
    return this.finishPlanRelationMutation(plan, operation, "chain-scope-updated", `Updated plan_chain_scope:${scopeId}`);
  }

  setPlanChanges(operation, { timestamp }) {
    const plan = this.planForMutation(operation, "set_plan_changes");
    const changes = operation.fields?.changes ?? [];
    if (!Array.isArray(changes)) throw new Error("changes must be an array");
    const keys = changes.map((change) => `${change.entityType}:${change.entityId}`);
    if (new Set(keys).size !== keys.length) throw new Error("A Plan may define only one canonical change per entity");
    const normalizedChanges = changes.map((change, index) => this.validatedPlanChange({
      ...change,
      id: change.id ?? `${operation.id}-${change.entityType}-${change.entityId}`,
      position: index,
    }, index));
    const existingRows = this.database.prepare("SELECT * FROM plan_changes WHERE plan_id = ?").all(operation.id);
    const existingById = new Map(existingRows.map((row) => [row.id, row]));
    for (const change of normalizedChanges) {
      const owner = this.database.prepare("SELECT plan_id, entity_type, entity_id FROM plan_changes WHERE id = ?").get(change.id);
      if (owner && owner.plan_id !== operation.id) throw new Error(`plan_change:${change.id} belongs to another Plan`);
      if (owner && (owner.entity_type !== change.entityType || owner.entity_id !== change.entityId)) {
        throw new Error(`plan_change:${change.id} target is immutable; create a new Plan change ID`);
      }
    }
    const desiredIds = new Set(normalizedChanges.map((change) => change.id));
    const removedIds = existingRows.filter((row) => !desiredIds.has(row.id)).map((row) => row.id);
    for (const id of removedIds) {
      this.database.prepare("DELETE FROM checkpoint_bindings WHERE subject_type = 'plan_change' AND subject_id = ?").run(id);
      this.database.prepare("DELETE FROM plan_changes WHERE plan_id = ? AND id = ?").run(operation.id, id);
    }
    const insert = this.database.prepare(
      `INSERT INTO plan_changes(
        id, plan_id, entity_type, entity_id, position, title, summary, current_behavior, proposed_behavior,
        rationale, prohibitions_json, expected_effects_json, source_refs_json, localizations_json,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const update = this.database.prepare(
      `UPDATE plan_changes SET position = ?, title = ?, summary = ?, current_behavior = ?, proposed_behavior = ?,
        rationale = ?, prohibitions_json = ?, expected_effects_json = ?, source_refs_json = ?, localizations_json = ?,
        status = ?, current_revision = current_revision + 1, updated_at = ? WHERE plan_id = ? AND id = ?`,
    );
    normalizedChanges.forEach((change) => {
      const values = [
        change.position, change.title, change.summary ?? "", change.currentBehavior ?? "", change.proposedBehavior ?? "",
        change.rationale ?? "", JSON.stringify(change.prohibitions ?? []), JSON.stringify(change.expectedEffects ?? []),
        JSON.stringify(change.sourceRefs ?? []), JSON.stringify(change.localizations ?? {}), change.status,
      ];
      if (existingById.has(change.id)) update.run(...values, timestamp, operation.id, change.id);
      else insert.run(
        change.id, operation.id, change.entityType, change.entityId, ...values, timestamp, timestamp,
      );
    });
    return this.finishPlanRelationMutation(plan, operation, "changes-set", `${changes.length} canonical entity change(s)`);
  }

  updatePlanChange(operation, { timestamp }) {
    const plan = this.planForMutation(operation, "update_plan_change");
    const changeId = operation.fields?.changeId;
    const patch = operation.fields?.patch;
    if (!changeId || !patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("update_plan_change requires fields.changeId and fields.patch");
    }
    for (const field of Object.keys(patch)) {
      if (!EDITABLE_PLAN_CHANGE_FIELDS.has(field)) throw new Error(`Unsupported Plan change field: ${field}`);
    }
    const row = this.database.prepare("SELECT * FROM plan_changes WHERE plan_id = ? AND id = ?").get(operation.id, changeId);
    if (!row) throw new Error(`plan_change:${changeId} not found in plan:${operation.id}`);
    const current = normalizePlanChange(row);
    const next = this.validatedPlanChange({ ...current, ...patch }, current.position);
    this.database.prepare(
      `UPDATE plan_changes SET position = ?, title = ?, summary = ?, current_behavior = ?, proposed_behavior = ?,
        rationale = ?, prohibitions_json = ?, expected_effects_json = ?, source_refs_json = ?, localizations_json = ?,
        status = ?, current_revision = current_revision + 1, updated_at = ? WHERE plan_id = ? AND id = ?`,
    ).run(
      next.position, next.title, next.summary, next.currentBehavior, next.proposedBehavior, next.rationale,
      JSON.stringify(next.prohibitions), JSON.stringify(next.expectedEffects), JSON.stringify(next.sourceRefs),
      JSON.stringify(next.localizations), next.status, timestamp, operation.id, changeId,
    );
    return this.finishPlanRelationMutation(plan, operation, "plan-change-updated", `Updated plan_change:${changeId}`);
  }

  setPlanChainChangeRefs(operation) {
    const plan = this.planForMutation(operation, "set_plan_chain_change_refs");
    const refs = operation.fields?.refs ?? [];
    if (!Array.isArray(refs)) throw new Error("refs must be an array");
    const scopes = new Set(this.database.prepare("SELECT id FROM plan_chain_scopes WHERE plan_id = ?").all(operation.id).map((row) => row.id));
    const changes = new Set(this.database.prepare("SELECT id FROM plan_changes WHERE plan_id = ?").all(operation.id).map((row) => row.id));
    for (const ref of refs) {
      if (!scopes.has(ref.chainScopeId)) throw new Error(`Plan ChainScope not found: ${ref.chainScopeId}`);
      if (!changes.has(ref.planChangeId)) throw new Error(`Plan change not found: ${ref.planChangeId}`);
    }
    this.database.prepare(
      "DELETE FROM plan_chain_change_refs WHERE chain_scope_id IN (SELECT id FROM plan_chain_scopes WHERE plan_id = ?)",
    ).run(operation.id);
    const insert = this.database.prepare(
      "INSERT INTO plan_chain_change_refs(chain_scope_id, plan_change_id, role, position) VALUES (?, ?, ?, ?)",
    );
    refs.forEach((ref, index) => insert.run(ref.chainScopeId, ref.planChangeId, ref.role ?? "affected", ref.position ?? index));
    return this.finishPlanRelationMutation(plan, operation, "chain-change-refs-set", `${refs.length} Chain-to-change reference(s)`);
  }

  checkpointForMutation(operation, action) {
    if (!operation.id || !Number.isInteger(operation.expectedRevision)) throw new Error(`${action} requires id and expectedRevision`);
    const checkpoint = this.database.prepare("SELECT * FROM checkpoints WHERE project_id = ? AND id = ?")
      .get(this.paths.descriptor.id, operation.id);
    if (!checkpoint) throw new Error(`checkpoint:${operation.id} not found`);
    if (checkpoint.current_revision !== operation.expectedRevision) {
      throw new Error(`Revision conflict for checkpoint:${operation.id}; expected ${operation.expectedRevision}, current ${checkpoint.current_revision}`);
    }
    return checkpoint;
  }

  finishCheckpointRelationMutation(checkpoint, operation, action, summary) {
    const revision = checkpoint.current_revision + 1;
    this.database.prepare("UPDATE checkpoints SET current_revision = ?, updated_at = ? WHERE id = ?")
      .run(revision, now(), operation.id);
    return { entityType: "checkpoint", id: operation.id, action, revision, summary };
  }

  setCheckpointBindings(operation) {
    const checkpoint = this.checkpointForMutation(operation, "set_checkpoint_bindings");
    const bindings = operation.fields?.bindings ?? [];
    if (!Array.isArray(bindings)) throw new Error("bindings must be an array");
    for (const binding of bindings) {
      if (!entityExists(this.database, this.paths.descriptor.id, binding.subjectType, binding.subjectId)) {
        throw new Error(`${binding.subjectType}:${binding.subjectId} not found`);
      }
    }
    this.database.prepare("DELETE FROM checkpoint_bindings WHERE checkpoint_id = ?").run(operation.id);
    const insert = this.database.prepare(
      "INSERT INTO checkpoint_bindings(checkpoint_id, subject_type, subject_id, role, required, position) VALUES (?, ?, ?, ?, ?, ?)",
    );
    bindings.forEach((binding, index) => insert.run(
      operation.id, binding.subjectType, binding.subjectId, binding.role ?? "leaf",
      binding.required === false ? 0 : 1, binding.position ?? index,
    ));
    return this.finishCheckpointRelationMutation(checkpoint, operation, "bindings-set", `${bindings.length} subject binding(s)`);
  }

  setCheckpointDependencies(operation) {
    const checkpoint = this.checkpointForMutation(operation, "set_checkpoint_dependencies");
    const children = operation.fields?.children ?? [];
    if (!Array.isArray(children)) throw new Error("children must be an array");
    const ids = children.map((child) => child.checkpointId);
    if (new Set(ids).size !== ids.length) throw new Error("Checkpoint child IDs must be unique");
    for (const childId of ids) {
      if (childId === operation.id) throw new Error("Checkpoint cannot depend on itself");
      if (!this.database.prepare("SELECT 1 FROM checkpoints WHERE project_id = ? AND id = ?").get(this.paths.descriptor.id, childId)) {
        throw new Error(`checkpoint:${childId ?? ""} not found`);
      }
    }
    const rows = this.database.prepare(
      `SELECT cd.parent_checkpoint_id, cd.child_checkpoint_id FROM checkpoint_dependencies cd
       JOIN checkpoints c ON c.id = cd.parent_checkpoint_id WHERE c.project_id = ?`,
    ).all(this.paths.descriptor.id);
    const adjacency = new Map();
    for (const row of rows) {
      if (row.parent_checkpoint_id === operation.id) continue;
      const values = adjacency.get(row.parent_checkpoint_id) ?? [];
      values.push(row.child_checkpoint_id);
      adjacency.set(row.parent_checkpoint_id, values);
    }
    adjacency.set(operation.id, ids);
    const visiting = new Set();
    const visited = new Set();
    const hasCycle = (id) => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      for (const child of adjacency.get(id) ?? []) if (hasCycle(child)) return true;
      visiting.delete(id);
      visited.add(id);
      return false;
    };
    if ([...adjacency.keys()].some(hasCycle)) throw new Error("Checkpoint dependencies must remain acyclic");
    this.database.prepare("DELETE FROM checkpoint_dependencies WHERE parent_checkpoint_id = ?").run(operation.id);
    const insert = this.database.prepare(
      "INSERT INTO checkpoint_dependencies(parent_checkpoint_id, child_checkpoint_id, position, required) VALUES (?, ?, ?, ?)",
    );
    children.forEach((child, index) => insert.run(operation.id, child.checkpointId, child.position ?? index, child.required === false ? 0 : 1));
    return this.finishCheckpointRelationMutation(checkpoint, operation, "dependencies-set", `${children.length} child checkpoint(s)`);
  }

  setChainPath(operation) {
    if (!operation.id || !Number.isInteger(operation.expectedRevision)) {
      throw new Error("set_chain_path requires id and expectedRevision");
    }
    const chain = this.database.prepare("SELECT * FROM chains WHERE project_id = ? AND id = ?")
      .get(this.paths.descriptor.id, operation.id);
    if (!chain) throw new Error(`chain:${operation.id} not found`);
    if (chain.current_revision !== operation.expectedRevision) {
      throw new Error(`Revision conflict for chain:${operation.id}; expected ${operation.expectedRevision}, current ${chain.current_revision}`);
    }
    const nodeIds = operation.fields?.nodeIds ?? [];
    const linkIds = operation.fields?.linkIds ?? [];
    const nodeSet = new Set(nodeIds);
    for (const blockId of nodeIds) {
      if (!entityExists(this.database, this.paths.descriptor.id, "block", blockId)) throw new Error(`block:${blockId} not found`);
    }
    const links = linkIds.map((linkId) => {
      const link = this.database.prepare("SELECT * FROM links WHERE project_id = ? AND id = ? AND archived = 0")
        .get(this.paths.descriptor.id, linkId);
      if (!link) throw new Error(`link:${linkId} not found`);
      if (link.source_type !== "block" || link.target_type !== "block" || !nodeSet.has(link.source_id) || !nodeSet.has(link.target_id)) {
        throw new Error(`link:${linkId} endpoints must both be referenced Chain nodes`);
      }
      return link;
    });
    this.database.prepare("DELETE FROM chain_nodes WHERE chain_id = ?").run(operation.id);
    this.database.prepare("DELETE FROM chain_edges WHERE chain_id = ?").run(operation.id);
    const insertNode = this.database.prepare("INSERT INTO chain_nodes(chain_id, block_id, position, role) VALUES (?, ?, ?, 'path')");
    nodeIds.forEach((blockId, index) => {
      insertNode.run(operation.id, blockId, index);
    });
    const insertEdge = this.database.prepare("INSERT INTO chain_edges(chain_id, link_id, position) VALUES (?, ?, ?)");
    links.forEach((link, index) => insertEdge.run(operation.id, link.id, index));
    const revision = chain.current_revision + 1;
    this.database.prepare("UPDATE chains SET current_revision = ?, updated_at = ? WHERE id = ?").run(revision, now(), operation.id);
    return { entityType: "chain", id: operation.id, action: "path-set", revision, summary: `${nodeIds.length} nodes / ${linkIds.length} edges` };
  }

  setBackgroundScopes(operation) {
    if (!operation.id || !Number.isInteger(operation.expectedRevision)) {
      throw new Error("set_background_scopes requires block id and expectedRevision");
    }
    const block = this.database.prepare("SELECT * FROM blocks WHERE project_id = ? AND id = ?")
      .get(this.paths.descriptor.id, operation.id);
    if (!block) throw new Error(`block:${operation.id} not found`);
    if (block.current_revision !== operation.expectedRevision) {
      throw new Error(`Revision conflict for block:${operation.id}; expected ${operation.expectedRevision}, current ${block.current_revision}`);
    }
    const scopes = operation.fields?.scopes ?? [];
    const allowed = new Set(["project", "lens", "chain", "repo"]);
    this.database.prepare("DELETE FROM background_scopes WHERE block_id = ?").run(operation.id);
    const insert = this.database.prepare("INSERT INTO background_scopes(block_id, scope_type, scope_value) VALUES (?, ?, ?)");
    for (const scope of scopes) {
      assertAllowed(scope.type, allowed, "background scope type");
      insert.run(operation.id, scope.type, scope.value ?? "*");
    }
    const revision = block.current_revision + 1;
    this.database.prepare("UPDATE blocks SET current_revision = ?, updated_at = ? WHERE id = ?").run(revision, now(), operation.id);
    return { entityType: "block", id: operation.id, action: "scopes-set", revision, summary: `${scopes.length} scope(s)` };
  }

  setDecisionScopes(operation) {
    if (!operation.id || !Number.isInteger(operation.expectedRevision)) {
      throw new Error("set_decision_scopes requires decision id and expectedRevision");
    }
    const decision = this.database.prepare("SELECT * FROM decisions WHERE project_id = ? AND id = ?")
      .get(this.paths.descriptor.id, operation.id);
    if (!decision) throw new Error(`decision:${operation.id} not found`);
    if (decision.current_revision !== operation.expectedRevision) {
      throw new Error(`Revision conflict for decision:${operation.id}; expected ${operation.expectedRevision}, current ${decision.current_revision}`);
    }
    const scopes = operation.fields?.scopes ?? [];
    if (!Array.isArray(scopes)) throw new Error("decision scopes must be an array");
    const allowed = new Set(["project", "lens", "chain", "repo"]);
    this.database.prepare("DELETE FROM decision_scopes WHERE decision_id = ?").run(operation.id);
    const insert = this.database.prepare("INSERT INTO decision_scopes(decision_id, scope_type, scope_value) VALUES (?, ?, ?)");
    for (const scope of scopes) {
      assertAllowed(scope.type, allowed, "decision scope type");
      if (scope.value != null && (typeof scope.value !== "string" || !scope.value.trim())) {
        throw new Error("decision scope value must be a non-empty string");
      }
      if (scope.type === "chain" && scope.value !== "*" && !entityExists(this.database, this.paths.descriptor.id, "chain", scope.value)) {
        throw new Error(`chain:${scope.value} not found for decision scope`);
      }
      insert.run(operation.id, scope.type, scope.value?.trim() || "*");
    }
    const revision = decision.current_revision + 1;
    this.database.prepare("UPDATE decisions SET current_revision = ?, updated_at = ? WHERE project_id = ? AND id = ?")
      .run(revision, now(), this.paths.descriptor.id, operation.id);
    return { entityType: "decision", id: operation.id, action: "scopes-set", revision, summary: `${scopes.length} scope(s)` };
  }

  createDecision(operation, { timestamp }) {
    const fields = operation.fields ?? {};
    if (!fields.title?.trim()) throw new Error("create_decision requires fields.title");
    if (fields.localizations != null) {
      throw new Error("create_decision does not accept localizations; keep one canonical decision body");
    }
    assertAllowed(fields.status ?? "active", DECISION_STATUSES, "decision status");
    if (fields.alternatives != null && !Array.isArray(fields.alternatives)) throw new Error("decision alternatives must be an array");
    if (fields.consequences != null && !Array.isArray(fields.consequences)) throw new Error("decision consequences must be an array");
    if (fields.supersedesDecisionId && !entityExists(this.database, this.paths.descriptor.id, "decision", fields.supersedesDecisionId)) {
      throw new Error(`decision:${fields.supersedesDecisionId} not found`);
    }
    const id = operation.id ?? identifier("decision");
    this.database.prepare(
      `INSERT INTO decisions(
        id, project_id, title, summary, rationale, alternatives_json, consequences_json,
        status, supersedes_decision_id, archived, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, this.paths.descriptor.id, fields.title.trim(), fields.summary ?? "", fields.rationale ?? "",
      JSON.stringify(fields.alternatives ?? []), JSON.stringify(fields.consequences ?? []), fields.status ?? "active",
      fields.supersedesDecisionId ?? null, Number(Boolean(fields.archived)), timestamp, timestamp,
    );
    const scopes = fields.scopes;
    if (scopes != null) {
      if (!Array.isArray(scopes)) throw new Error("decision scopes must be an array");
      const allowed = new Set(["project", "lens", "chain", "repo"]);
      const insert = this.database.prepare("INSERT INTO decision_scopes(decision_id, scope_type, scope_value) VALUES (?, ?, ?)");
      for (const scope of scopes) {
        assertAllowed(scope.type, allowed, "decision scope type");
        const value = scope.value?.trim() || "*";
        if (scope.type === "chain" && value !== "*" && !entityExists(this.database, this.paths.descriptor.id, "chain", value)) {
          throw new Error(`chain:${value} not found for decision scope`);
        }
        insert.run(id, scope.type, value);
      }
    }
    return { entityType: "decision", id, action: "created", revision: 1, summary: fields.title.trim() };
  }

  createBlock(operation, { timestamp }) {
    const fields = operation.fields ?? {};
    if (fields.kind === "decision") {
      throw new Error("Decision records are not Canvas Blocks; use create_decision with project/lens/chain/repo scopes");
    }
    assertAllowed(fields.kind, BLOCK_KINDS, "block kind");
    assertAllowed(fields.architectureLayer ?? "unspecified", ARCHITECTURE_LAYERS, "architecture layer");
    assertAllowed(fields.deliveryState ?? "proposed", DELIVERY_STATES, "delivery state");
    assertAllowed(fields.healthState ?? "unknown", HEALTH_STATES, "health state");
    if (!fields.title?.trim()) throw new Error("create_block requires fields.title");
    if (fields.scope != null && (typeof fields.scope !== "string" || !fields.scope.trim())) {
      throw new Error("fields.scope must be a non-empty string");
    }
    if (fields.localOrder != null && !Number.isInteger(fields.localOrder)) {
      throw new Error("fields.localOrder must be an integer");
    }
    const id = operation.id ?? identifier("block");
    this.database
      .prepare(
        `INSERT INTO blocks(
          id, project_id, kind, title, summary, body, contract, scope, architecture_layer,
          local_order, delivery_state, health_state, priority, confidence, tags_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.paths.descriptor.id,
        fields.kind,
        fields.title.trim(),
        fields.summary ?? "",
        fields.body ?? "",
        fields.contract ?? "",
        fields.scope?.trim() ?? "general",
        fields.architectureLayer ?? "unspecified",
        fields.localOrder ?? 0,
        fields.deliveryState ?? "proposed",
        fields.healthState ?? "unknown",
        fields.priority ?? "normal",
        fields.confidence ?? "confirmed",
        serializeTags(fields.tags),
        timestamp,
        timestamp,
      );
    this.applyLocalizations("block", id, fields.localizations, timestamp);
    return { entityType: "block", id, action: "created", revision: 1, summary: fields.title.trim() };
  }

  createChain(operation, { timestamp }) {
    const fields = operation.fields ?? {};
    assertAllowed(fields.deliveryState ?? "planned", DELIVERY_STATES, "delivery state");
    assertAllowed(fields.healthState ?? "unknown", HEALTH_STATES, "health state");
    if (!fields.title?.trim()) throw new Error("create_chain requires fields.title");
    const id = operation.id ?? identifier("chain");
    this.database
      .prepare(
        `INSERT INTO chains(
          id, project_id, title, purpose, intent, input_contract, output_contract,
          delivery_state, health_state, priority, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.paths.descriptor.id,
        fields.title.trim(),
        fields.purpose ?? "feature",
        fields.intent ?? "",
        fields.inputContract ?? "",
        fields.outputContract ?? "",
        fields.deliveryState ?? "planned",
        fields.healthState ?? "unknown",
        fields.priority ?? "normal",
        timestamp,
        timestamp,
      );
    this.applyLocalizations("chain", id, fields.localizations, timestamp);
    return { entityType: "chain", id, action: "created", revision: 1, summary: fields.title.trim() };
  }

  createLink(operation, { timestamp }) {
    const fields = operation.fields ?? {};
    if (fields.sourceType === "decision" || fields.targetType === "decision") {
      throw new Error("Decisions are scoped project memory, not Link endpoints; use decision scopes or a source reference");
    }
    assertAllowed(fields.kind, LINK_KINDS, "link kind");
    assertAllowed(fields.healthState ?? "unknown", HEALTH_STATES, "health state");
    if (!entityExists(this.database, this.paths.descriptor.id, fields.sourceType, fields.sourceId)) {
      throw new Error(`Missing link source ${fields.sourceType}:${fields.sourceId}`);
    }
    if (!entityExists(this.database, this.paths.descriptor.id, fields.targetType, fields.targetId)) {
      throw new Error(`Missing link target ${fields.targetType}:${fields.targetId}`);
    }
    const id = operation.id ?? identifier("link");
    this.database
      .prepare(
        `INSERT INTO links(
          id, project_id, source_type, source_id, target_type, target_id, kind, label,
          contract, health_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.paths.descriptor.id,
        fields.sourceType,
        fields.sourceId,
        fields.targetType,
        fields.targetId,
        fields.kind,
        fields.label ?? "",
        fields.contract ?? "",
        fields.healthState ?? "unknown",
        timestamp,
        timestamp,
      );
    this.applyLocalizations("link", id, fields.localizations, timestamp);
    return { entityType: "link", id, action: "created", revision: 1, summary: fields.label || fields.kind };
  }

  createCheckpoint(operation, { timestamp }) {
    const fields = operation.fields ?? {};
    if (!["block", "chain", "link", "plan"].includes(fields.targetType)) throw new Error(`Invalid targetType: ${fields.targetType}`);
    if (!fields.title?.trim()) throw new Error("create_checkpoint requires fields.title");
    const status = fields.status ?? "pending";
    const checkpointKind = fields.checkpointKind ?? "atomic";
    const requiredEvidenceLevel = fields.requiredEvidenceLevel ?? "static";
    const evidenceLevel = fields.evidenceLevel ?? (status === "passed" ? "static" : "none");
    assertAllowed(status, CHECKPOINT_STATUSES, "checkpoint status");
    assertAllowed(checkpointKind, CHECKPOINT_KINDS, "checkpoint kind");
    assertAllowed(evidenceLevel, EVIDENCE_LEVELS, "evidence level");
    assertAllowed(requiredEvidenceLevel, EVIDENCE_LEVELS, "required evidence level");
    if (!["complete", "partial"].includes(fields.coverage ?? "complete")) throw new Error(`Invalid checkpoint coverage: ${fields.coverage}`);
    if ((status === "passed") && (fields.coverage ?? "complete") !== "complete") {
      throw new Error("Passed checkpoint requires complete coverage");
    }
    if (checkpointKind === "aggregate" && status === "passed") {
      throw new Error("Aggregate checkpoint status is derived from child checkpoints and cannot be recorded as passed");
    }
    if (status === "passed" && (EVIDENCE_LEVEL_RANK.get(evidenceLevel) ?? 0) < (EVIDENCE_LEVEL_RANK.get(requiredEvidenceLevel) ?? 0)) {
      throw new Error(`Passed checkpoint requires ${requiredEvidenceLevel} evidence, received ${evidenceLevel}`);
    }
    if (!entityExists(this.database, this.paths.descriptor.id, fields.targetType, fields.targetId)) {
      throw new Error(`${fields.targetType}:${fields.targetId} not found`);
    }
    const id = operation.id ?? identifier("checkpoint");
    const existing = this.database.prepare("SELECT 1 FROM checkpoints WHERE project_id = ? AND id = ?")
      .get(this.paths.descriptor.id, id);
    if (existing) throw new Error(`checkpoint:${id} already exists; use checkpoint_record to update it`);
    const coverage = fields.coverage ?? "complete";
    const criteria = fields.criteria ?? "";
    const invalidatedAt = fields.invalidatedAt ?? null;
    this.database
      .prepare(
        `INSERT INTO checkpoints(
          id, project_id, target_type, target_id, title, criteria, status, checkpoint_kind,
          aggregation_policy_json, eligible_after_children, evidence_level,
          required_evidence_level, coverage, evidence_json, invalidated_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.paths.descriptor.id,
        fields.targetType,
        fields.targetId,
        fields.title.trim(),
        criteria,
        status,
        checkpointKind,
        JSON.stringify(fields.aggregationPolicy ?? {}),
        Number(Boolean(fields.eligibleAfterChildren)),
        evidenceLevel,
        requiredEvidenceLevel,
        coverage,
        JSON.stringify(fields.evidence ?? []),
        invalidatedAt,
        timestamp,
        timestamp,
      );
    const healthState = status === "passed" ? "healthy"
      : status === "failed" ? "failing"
        : ["blocked", "partial_pass", "retest_required"].includes(status) ? "warning" : null;
    if (healthState && fields.targetType !== "plan") {
      const targetTable = fields.targetType === "block" ? "blocks"
        : fields.targetType === "chain" ? "chains" : "links";
      this.database
        .prepare(`UPDATE ${targetTable} SET health_state = ?, updated_at = ? WHERE id = ?`)
        .run(healthState, timestamp, fields.targetId);
    }
    return { entityType: "checkpoint", id, action: "created", revision: 1, summary: fields.title.trim() };
  }

  deleteCheckpoint(operation, { timestamp }) {
    const id = operation.id;
    if (!id) throw new Error("checkpoint id is required for delete_checkpoint");
    const checkpoint = this.database.prepare(
      "SELECT * FROM checkpoints WHERE project_id = ? AND id = ?",
    ).get(this.paths.descriptor.id, id);
    if (!checkpoint) throw new Error(`checkpoint:${id} not found`);
    this.database.prepare("DELETE FROM checkpoint_bindings WHERE checkpoint_id = ?").run(id);
    this.database.prepare("DELETE FROM checkpoint_dependencies WHERE parent_checkpoint_id = ? OR child_checkpoint_id = ?").run(id, id);
    this.database.prepare("DELETE FROM plan_checkpoint_refs WHERE checkpoint_id = ?").run(id);
    this.database.prepare("DELETE FROM checkpoints WHERE id = ?").run(id);
    return {
      entityType: "checkpoint",
      id,
      action: "deleted",
      revision: checkpoint.current_revision + 1,
      summary: `Deleted checkpoint ${id}`,
    };
  }

  recordCheckpointOperation(operation, { timestamp }) {
    const fields = operation.fields ?? {};
    if (!['block', 'chain', 'link', 'plan'].includes(fields.targetType)) {
      throw new Error(`Invalid targetType: ${fields.targetType}`);
    }
    if (!fields.title?.trim()) throw new Error("record_checkpoint requires fields.title");
    const status = fields.status ?? "pending";
    const checkpointKind = fields.checkpointKind ?? "atomic";
    const requiredEvidenceLevel = fields.requiredEvidenceLevel ?? "static";
    const evidenceLevel = fields.evidenceLevel ?? (status === "passed" ? "static" : "none");
    assertAllowed(status, CHECKPOINT_STATUSES, "checkpoint status");
    assertAllowed(checkpointKind, CHECKPOINT_KINDS, "checkpoint kind");
    assertAllowed(evidenceLevel, EVIDENCE_LEVELS, "evidence level");
    assertAllowed(requiredEvidenceLevel, EVIDENCE_LEVELS, "required evidence level");
    const coverage = fields.coverage ?? "complete";
    if (!["complete", "partial"].includes(coverage)) throw new Error(`Invalid checkpoint coverage: ${coverage}`);
    if (status === "passed" && coverage !== "complete") throw new Error("Passed checkpoint requires complete coverage");
    if (checkpointKind === "aggregate" && status === "passed") {
      throw new Error("Aggregate checkpoint status is derived from child checkpoints and cannot be recorded as passed");
    }
    if (status === "passed" && (EVIDENCE_LEVEL_RANK.get(evidenceLevel) ?? 0) < (EVIDENCE_LEVEL_RANK.get(requiredEvidenceLevel) ?? 0)) {
      throw new Error(`Passed checkpoint requires ${requiredEvidenceLevel} evidence, received ${evidenceLevel}`);
    }
    if (!entityExists(this.database, this.paths.descriptor.id, fields.targetType, fields.targetId)) {
      throw new Error(`${fields.targetType}:${fields.targetId} not found`);
    }
    const id = operation.id ?? identifier("checkpoint");
    const existing = this.database.prepare("SELECT * FROM checkpoints WHERE project_id = ? AND id = ?")
      .get(this.paths.descriptor.id, id);
    let revision = 1;
    let action = "created";
    if (existing) {
      if (existing.project_id !== this.paths.descriptor.id || existing.target_type !== fields.targetType || existing.target_id !== fields.targetId) {
        throw new Error(`checkpoint:${id} target cannot be changed`);
      }
      if (!Number.isInteger(operation.expectedRevision) || operation.expectedRevision !== existing.current_revision) {
        throw new Error(`Revision conflict for checkpoint:${id}; expected ${operation.expectedRevision}, current ${existing.current_revision}`);
      }
      revision = existing.current_revision + 1;
      action = "updated";
      this.database.prepare(
        `UPDATE checkpoints SET title = ?, criteria = ?, status = ?, checkpoint_kind = ?,
         aggregation_policy_json = ?, eligible_after_children = ?, evidence_level = ?,
         required_evidence_level = ?, coverage = ?, evidence_json = ?, invalidated_at = ?,
         current_revision = ?, updated_at = ? WHERE project_id = ? AND id = ?`,
      ).run(
        fields.title.trim(), fields.criteria ?? "", status, checkpointKind,
        JSON.stringify(fields.aggregationPolicy ?? {}), Number(Boolean(fields.eligibleAfterChildren)), evidenceLevel,
        requiredEvidenceLevel, coverage, JSON.stringify(fields.evidence ?? []), fields.invalidatedAt ?? null,
        revision, timestamp, this.paths.descriptor.id, id,
      );
    } else {
      this.database.prepare(
        `INSERT INTO checkpoints(
          id, project_id, target_type, target_id, title, criteria, status, checkpoint_kind,
          aggregation_policy_json, eligible_after_children, evidence_level,
          required_evidence_level, coverage, evidence_json, invalidated_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, this.paths.descriptor.id, fields.targetType, fields.targetId, fields.title.trim(), fields.criteria ?? "",
        status, checkpointKind, JSON.stringify(fields.aggregationPolicy ?? {}), Number(Boolean(fields.eligibleAfterChildren)),
        evidenceLevel, requiredEvidenceLevel, coverage, JSON.stringify(fields.evidence ?? []), fields.invalidatedAt ?? null,
        timestamp, timestamp,
      );
    }
    const healthState = status === "passed" ? "healthy"
      : status === "failed" ? "failing"
        : ["blocked", "partial_pass", "retest_required"].includes(status) ? "warning" : null;
    if (healthState && fields.targetType !== "plan") {
      const targetTable = fields.targetType === "block" ? "blocks"
        : fields.targetType === "chain" ? "chains" : "links";
      this.database.prepare(`UPDATE ${targetTable} SET health_state = ?, updated_at = ? WHERE id = ?`)
        .run(healthState, timestamp, fields.targetId);
    }
    return {
      entityType: "checkpoint", id, action, revision,
      summary: `${status}: ${fields.title.trim()}`,
    };
  }

  updateEntity(type, operation, { timestamp }) {
    const config = {
      block: { table: "blocks", allowed: EDITABLE_BLOCK_FIELDS, normalizer: normalizeBlock },
      chain: { table: "chains", allowed: EDITABLE_CHAIN_FIELDS, normalizer: normalizeChain },
      link: { table: "links", allowed: EDITABLE_LINK_FIELDS, normalizer: normalizeLink },
      plan: { table: "plans", allowed: EDITABLE_PLAN_FIELDS, normalizer: normalizePlan },
      decision: { table: "decisions", allowed: EDITABLE_DECISION_FIELDS, normalizer: normalizeDecision },
    }[type];
    if (!operation.id || !Number.isInteger(operation.expectedRevision)) {
      throw new Error(`update_${type} requires id and expectedRevision`);
    }
    const existing = this.database
      .prepare(`SELECT * FROM ${config.table} WHERE project_id = ? AND id = ?`)
      .get(this.paths.descriptor.id, operation.id);
    if (!existing) throw new Error(`${type}:${operation.id} not found`);
    if (existing.current_revision !== operation.expectedRevision) {
      throw new Error(
        `Revision conflict for ${type}:${operation.id}; expected ${operation.expectedRevision}, current ${existing.current_revision}`,
      );
    }
    const fields = { ...(operation.fields ?? {}) };
    const localizations = fields.localizations;
    delete fields.localizations;
    const decisionScopes = type === "decision" ? fields.scopes : null;
    if (type === "decision") delete fields.scopes;
    const updates = [];
    const values = [];
    for (const [field, rawValue] of Object.entries(fields)) {
      if (!config.allowed.has(field)) throw new Error(`Field ${field} is not editable on ${type}`);
      if (field === "kind" && type === "block") {
        if (rawValue === "decision") {
          throw new Error("Decision records are not Canvas Blocks; use update_decision or create_decision");
        }
        assertAllowed(rawValue, BLOCK_KINDS, "block kind");
      }
      if (field === "kind" && type === "link") assertAllowed(rawValue, LINK_KINDS, "link kind");
      if (field === "architectureLayer") assertAllowed(rawValue, ARCHITECTURE_LAYERS, "architecture layer");
      if (field === "scope" && (typeof rawValue !== "string" || !rawValue.trim())) {
        throw new Error("scope must be a non-empty string");
      }
      if (field === "localOrder" && !Number.isInteger(rawValue)) {
        throw new Error("localOrder must be an integer");
      }
      if (field === "deliveryState") assertAllowed(rawValue, DELIVERY_STATES, "delivery state");
      if (field === "healthState") assertAllowed(rawValue, HEALTH_STATES, "health state");
      if (field === "status") assertAllowed(rawValue, type === "decision" ? DECISION_STATUSES : PLAN_STATUSES, type === "decision" ? "decision status" : "plan status");
      if (["alternatives", "consequences"].includes(field) && !Array.isArray(rawValue)) {
        throw new Error(`decision ${field} must be an array`);
      }
      if (field === "supersedesDecisionId" && rawValue != null &&
          !entityExists(this.database, this.paths.descriptor.id, "decision", rawValue)) {
        throw new Error(`decision:${rawValue} not found`);
      }
      const column = field === "proposedDelta" ? "proposed_delta_json"
        : field === "completionPolicy" ? "completion_policy_json"
          : field === "blockers" ? "blockers_json"
            : field === "alternatives" ? "alternatives_json"
              : field === "consequences" ? "consequences_json" : camelToColumn(field);
      updates.push(`${column} = ?`);
      values.push(field === "tags" ? serializeTags(rawValue)
        : ["proposedDelta", "blockers", "completionPolicy", "alternatives", "consequences"].includes(field) ? JSON.stringify(rawValue ?? (field === "completionPolicy" ? {} : []))
          : field === "archived" ? Number(Boolean(rawValue)) : field === "scope" ? rawValue.trim() : rawValue);
    }
    if (updates.length === 0 && localizations == null && decisionScopes == null) throw new Error(`update_${type} has no fields`);
    const revision = existing.current_revision + 1;
    updates.push("current_revision = ?", "updated_at = ?");
    values.push(revision, timestamp, this.paths.descriptor.id, operation.id);
    this.database
      .prepare(`UPDATE ${config.table} SET ${updates.join(", ")} WHERE project_id = ? AND id = ?`)
      .run(...values);
    if (type === "decision" && decisionScopes != null) {
      if (!Array.isArray(decisionScopes)) throw new Error("decision scopes must be an array");
      const allowed = new Set(["project", "lens", "chain", "repo"]);
      this.database.prepare("DELETE FROM decision_scopes WHERE decision_id = ?").run(operation.id);
      const insert = this.database.prepare("INSERT INTO decision_scopes(decision_id, scope_type, scope_value) VALUES (?, ?, ?)");
      for (const scope of decisionScopes) {
        assertAllowed(scope.type, allowed, "decision scope type");
        const value = scope.value?.trim() || "*";
        if (scope.type === "chain" && value !== "*" && !entityExists(this.database, this.paths.descriptor.id, "chain", value)) {
          throw new Error(`chain:${value} not found for decision scope`);
        }
        insert.run(operation.id, scope.type, value);
      }
    }
    this.removeStaleLocalizations(type, operation.id, Object.keys(fields), localizations);
    this.applyLocalizations(type, operation.id, localizations, timestamp);
    const normalized = config.normalizer(
      this.database
        .prepare(`SELECT * FROM ${config.table} WHERE project_id = ? AND id = ?`)
        .get(this.paths.descriptor.id, operation.id),
    );
    return {
      entityType: type,
      id: operation.id,
      action: "updated",
      revision,
      summary: operation.summary ?? normalized.title ?? normalized.label ?? Object.keys(fields).join(", "),
    };
  }

  addSourceRef(operation, { timestamp }) {
    const fields = operation.fields ?? {};
    if (!operation.id) throw new Error("add_source_ref requires id of the target block");
    if (!entityExists(this.database, this.paths.descriptor.id, "block", operation.id)) {
      throw new Error(`block:${operation.id} not found`);
    }
    if (!fields.path?.trim()) throw new Error("add_source_ref requires fields.path");
    const sourceId = fields.sourceId ?? identifier("source");

    let resolvedPath = fields.path.trim();
    let resolvedSymbol = fields.symbol ?? null;
    if (resolvedPath.includes(":") && !resolvedSymbol) {
      const parts = resolvedPath.split(":");
      resolvedPath = parts[0];
      resolvedSymbol = parts[1];
    }
    let startLine = fields.startLine ?? null;
    let endLine = fields.endLine ?? null;

    if ((!startLine || !endLine) && this.paths?.projectRoot) {
      const fullPath = path.isAbsolute(resolvedPath)
        ? resolvedPath
        : path.resolve(this.paths.projectRoot, resolvedPath);
      try {
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, "utf8");
          const symbols = extractSymbols(content, { filePath: resolvedPath });
          const matched = resolvedSymbol
            ? symbols.find((s) => s.name === resolvedSymbol || s.name.endsWith(`.${resolvedSymbol}`))
            : symbols[0];
          if (matched) {
            startLine = matched.startLine;
            endLine = matched.endLine;
            if (!resolvedSymbol) resolvedSymbol = matched.name;
          }
        }
      } catch {
        // file not created yet or unreadable
      }
    }

    this.database
      .prepare(
        `INSERT INTO source_refs(id, block_id, path, start_line, end_line, symbol, role, git_commit, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sourceId,
        operation.id,
        resolvedPath,
        startLine,
        endLine,
        resolvedSymbol,
        fields.role ?? "implementation",
        fields.gitCommit ?? null,
        timestamp,
      );
    const block = this.database.prepare("SELECT current_revision FROM blocks WHERE id = ?").get(operation.id);
    return {
      entityType: "block",
      id: operation.id,
      action: "source-linked",
      revision: block.current_revision,
      summary: `${fields.role ?? "implementation"}: ${fields.path}`,
      sourceId,
    };
  }

  removeSourceRef(operation) {
    const sourceId = operation.fields?.sourceId;
    if (!operation.id || !sourceId) {
      throw new Error("remove_source_ref requires the target block id and fields.sourceId");
    }
    const source = this.database
      .prepare("SELECT * FROM source_refs WHERE id = ? AND block_id = ?")
      .get(sourceId, operation.id);
    if (!source) throw new Error(`source:${sourceId} is not attached to block:${operation.id}`);
    this.database.prepare("DELETE FROM source_refs WHERE id = ?").run(sourceId);
    const block = this.database.prepare("SELECT current_revision FROM blocks WHERE id = ?").get(operation.id);
    return {
      entityType: "block",
      id: operation.id,
      action: "source-removed",
      revision: block.current_revision,
      summary: `${source.role}: ${source.path}`,
      sourceId,
    };
  }

  recordCheckpoint({
    actor = "agent", id, targetType, targetId, title, criteria = "", status,
    checkpointKind = "atomic", aggregationPolicy = {}, eligibleAfterChildren = false,
    evidenceLevel, requiredEvidenceLevel = "static", coverage = "complete",
    evidence = [], invalidatedAt = null, expectedRevision,
    planId = null, chainScopeId = null, gitHead = null,
  }) {
    if (!["block", "chain", "link", "plan"].includes(targetType)) throw new Error(`Invalid targetType: ${targetType}`);
    if (!title?.trim()) throw new Error("title is required");
    assertAllowed(status, CHECKPOINT_STATUSES, "checkpoint status");
    assertAllowed(checkpointKind, CHECKPOINT_KINDS, "checkpoint kind");
    if (!entityExists(this.database, this.paths.descriptor.id, targetType, targetId)) {
      throw new Error(`${targetType}:${targetId} not found`);
    }
    const resolvedEvidenceLevel = evidenceLevel ?? (status === "passed" ? "static" : "none");
    assertAllowed(resolvedEvidenceLevel, EVIDENCE_LEVELS, "evidence level");
    assertAllowed(requiredEvidenceLevel, EVIDENCE_LEVELS, "required evidence level");
    if (!["complete", "partial"].includes(coverage)) throw new Error(`Invalid checkpoint coverage: ${coverage}`);
    if (status === "passed" && coverage !== "complete") throw new Error("Passed checkpoint requires complete coverage");
    if (checkpointKind === "aggregate" && status === "passed") {
      throw new Error("Aggregate checkpoint status is derived from child checkpoints and cannot be recorded as passed");
    }
    if (status === "passed" && (EVIDENCE_LEVEL_RANK.get(resolvedEvidenceLevel) ?? 0) < (EVIDENCE_LEVEL_RANK.get(requiredEvidenceLevel) ?? 0)) {
      throw new Error(`Passed checkpoint requires ${requiredEvidenceLevel} evidence, received ${resolvedEvidenceLevel}`);
    }
    const checkpointId = id ?? identifier("checkpoint");
    const timestamp = now();
    const changeSetId = identifier("change");
    const historyContext = this.resolveHistoryContext(planId, chainScopeId);
    const before = this.historyState("checkpoint", checkpointId);
    return transaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO change_sets(id, project_id, actor, reason, task, git_head, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(changeSetId, this.paths.descriptor.id, actor, `Checkpoint: ${title}`, title, gitHead, timestamp);
      const existing = this.database.prepare("SELECT * FROM checkpoints WHERE id = ?").get(checkpointId);
      let revision = 1;
      let action = "created";
      if (existing) {
        if (existing.project_id !== this.paths.descriptor.id || existing.target_type !== targetType || existing.target_id !== targetId) {
          throw new Error(`checkpoint:${checkpointId} target cannot be changed`);
        }
        if (!Number.isInteger(expectedRevision) || expectedRevision !== existing.current_revision) {
          throw new Error(
            `Revision conflict for checkpoint:${checkpointId}; expected ${expectedRevision}, current ${existing.current_revision}`,
          );
        }
        revision = existing.current_revision + 1;
        action = "updated";
        this.database
          .prepare(
            `UPDATE checkpoints SET title = ?, criteria = ?, status = ?, checkpoint_kind = ?,
             aggregation_policy_json = ?, eligible_after_children = ?, evidence_level = ?,
             required_evidence_level = ?, coverage = ?, evidence_json = ?, invalidated_at = ?,
             current_revision = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            title, criteria, status, checkpointKind, JSON.stringify(aggregationPolicy ?? {}), Number(Boolean(eligibleAfterChildren)),
            resolvedEvidenceLevel, requiredEvidenceLevel, coverage,
            JSON.stringify(evidence), invalidatedAt, revision, timestamp, checkpointId,
          );
      } else {
        this.database
          .prepare(
            `INSERT INTO checkpoints(
              id, project_id, target_type, target_id, title, criteria, status, checkpoint_kind,
              aggregation_policy_json, eligible_after_children, evidence_level,
              required_evidence_level, coverage, evidence_json, invalidated_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            checkpointId,
            this.paths.descriptor.id,
            targetType,
            targetId,
            title,
            criteria,
            status,
            checkpointKind,
            JSON.stringify(aggregationPolicy ?? {}),
            Number(Boolean(eligibleAfterChildren)),
            resolvedEvidenceLevel,
            requiredEvidenceLevel,
            coverage,
            JSON.stringify(evidence),
            invalidatedAt,
            timestamp,
            timestamp,
          );
      }
      const targetTable = targetType === "block" ? "blocks" : targetType === "chain" ? "chains" : targetType === "link" ? "links" : "plans";
      const healthState = status === "passed" ? "healthy" : status === "failed" ? "failing" : ["blocked", "partial_pass", "retest_required"].includes(status) ? "warning" : null;
      if (healthState && targetType !== "plan") {
        this.database
          .prepare(`UPDATE ${targetTable} SET health_state = ?, updated_at = ? WHERE id = ?`)
          .run(healthState, timestamp, targetId);
      }
      const after = this.historyState("checkpoint", checkpointId);
      const changedFields = changedHistoryFields(before, after, [
        "title", "criteria", "status", "checkpointKind", "aggregationPolicy", "eligibleAfterChildren",
        "evidenceLevel", "requiredEvidenceLevel", "coverage", "evidence", "invalidatedAt",
      ]);
      const evidenceRefs = [...new Set(evidence.flatMap((item) =>
        [item.ref, item.path, item.command, item.url].filter((value) => typeof value === "string" && value.trim()),
      ))];
      const affectedRefs = [
        `checkpoint:${checkpointId}`,
        `${targetType}:${targetId}`,
        ...(historyContext.planId ? [`plan:${historyContext.planId}`] : []),
        ...(historyContext.chainScopeId ? [`plan_chain_scope:${historyContext.chainScopeId}`] : []),
      ];
      this.database
        .prepare(
          `INSERT INTO history(
             change_set_id, entity_type, entity_id, action, revision, summary, plan_id, chain_scope_id,
             before_json, after_json, changed_fields_json, affected_refs_json, evidence_refs_json, created_at
           ) VALUES (?, 'checkpoint', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          changeSetId, checkpointId, action, revision, `${status}: ${title}`,
          historyContext.planId ?? (targetType === "plan" ? targetId : null), historyContext.chainScopeId,
          JSON.stringify(before ?? {}), JSON.stringify(after ?? {}),
          JSON.stringify(changedFields),
          JSON.stringify(affectedRefs), JSON.stringify(evidenceRefs), timestamp,
        );
      this.database
        .prepare(
          `INSERT INTO change_feed(project_id, change_set_id, entity_type, entity_id, action, created_at)
           VALUES (?, ?, 'checkpoint', ?, ?, ?)`,
        )
        .run(this.paths.descriptor.id, changeSetId, checkpointId, action, timestamp);
      this.database
        .prepare("UPDATE projects SET graph_revision = graph_revision + 1, updated_at = ? WHERE id = ?")
        .run(timestamp, this.paths.descriptor.id);
      return {
        changeSetId,
        graphRevision: this.project().graph_revision,
        checkpoint: {
          id: checkpointId, revision, status, checkpointKind, aggregationPolicy,
          eligibleAfterChildren: Boolean(eligibleAfterChildren), evidenceLevel: resolvedEvidenceLevel,
          requiredEvidenceLevel, coverage,
        },
      };
    });
  }

  validate() {
    const snapshot = this.snapshot();
    const coverage = architectureCoverage(snapshot);
    const errors = [];
    const warnings = [];
    const refs = new Set([
      ...snapshot.blocks.map((block) => `block:${block.id}`),
      ...snapshot.chains.map((chain) => `chain:${chain.id}`),
    ]);
    for (const link of snapshot.links) {
      if (!refs.has(`${link.sourceType}:${link.sourceId}`)) errors.push(`Dangling link source: link:${link.id}`);
      if (!refs.has(`${link.targetType}:${link.targetId}`)) errors.push(`Dangling link target: link:${link.id}`);
      if (["calls", "reads", "writes"].includes(link.kind) && !link.contract.trim()) {
        warnings.push(`Missing contract: link:${link.id}`);
      }
    }
    for (const chain of snapshot.chains) {
      const nodes = snapshot.chainNodes.filter((item) => item.chainId === chain.id);
      const edges = snapshot.chainEdges.filter((item) => item.chainId === chain.id);
      const count = nodes.length;
      if (count === 0) warnings.push(`Empty chain: chain:${chain.id}`);
      const nodeIds = new Set(nodes.map((item) => item.blockId));
      for (const edge of edges) {
        const link = snapshot.links.find((item) => item.id === edge.linkId);
        if (!link) errors.push(`Missing Chain edge: chain:${chain.id} -> link:${edge.linkId}`);
        else if (!nodeIds.has(link.sourceId) || !nodeIds.has(link.targetId)) {
          errors.push(`Chain edge leaves referenced nodes: chain:${chain.id} -> link:${edge.linkId}`);
        }
      }
    }
    for (const target of snapshot.planChainRefs) {
      if (!snapshot.plans.some((plan) => plan.id === target.planId)) errors.push(`Missing Plan: plan:${target.planId}`);
      if (!snapshot.chains.some((chain) => chain.id === target.chainId)) errors.push(`Missing Plan target: plan:${target.planId} -> chain:${target.chainId}`);
    }
    for (const dependency of snapshot.planDependencies) {
      if (!snapshot.plans.some((plan) => plan.id === dependency.planId)) errors.push(`Missing dependent Plan: plan:${dependency.planId}`);
      if (!snapshot.plans.some((plan) => plan.id === dependency.dependsOnPlanId)) errors.push(`Missing prerequisite Plan: plan:${dependency.dependsOnPlanId}`);
    }
    for (const step of snapshot.planSteps) {
      if (!snapshot.plans.some((plan) => plan.id === step.planId)) errors.push(`Missing Plan for step: ${step.id}`);
      for (const ref of step.targetRefs) {
        const [type, id] = String(ref).split(":", 2);
        if (!id || !entityExists(this.database, this.paths.descriptor.id, type, id)) errors.push(`Missing Plan step target: ${step.id} -> ${ref}`);
      }
    }
    for (const ref of snapshot.planCheckpointRefs) {
      if (!snapshot.plans.some((plan) => plan.id === ref.planId)) errors.push(`Missing Plan checkpoint owner: plan:${ref.planId}`);
      if (!snapshot.checkpoints.some((checkpoint) => checkpoint.id === ref.checkpointId)) errors.push(`Missing Plan checkpoint: plan:${ref.planId} -> checkpoint:${ref.checkpointId}`);
      if (ref.stepId && !snapshot.planSteps.some((step) => step.id === ref.stepId && step.planId === ref.planId)) {
        errors.push(`Checkpoint references a foreign Plan step: checkpoint:${ref.checkpointId} -> ${ref.stepId}`);
      }
    }
    for (const scope of snapshot.backgroundScopes) {
      if (!snapshot.blocks.some((block) => block.id === scope.blockId)) errors.push(`Missing Background Block: block:${scope.blockId}`);
    }
    const decisionIDs = new Set(snapshot.decisions.map((decision) => decision.id));
    for (const decision of snapshot.decisions) {
      if (!DECISION_STATUSES.has(decision.status)) errors.push(`Invalid Decision status: decision:${decision.id}`);
      if (decision.supersedesDecisionId && !decisionIDs.has(decision.supersedesDecisionId)) {
        errors.push(`Missing superseded Decision: decision:${decision.id} -> decision:${decision.supersedesDecisionId}`);
      }
    }
    for (const scope of snapshot.decisionScopes) {
      if (!decisionIDs.has(scope.decisionId)) errors.push(`Missing Decision for scope: decision:${scope.decisionId}`);
      if (scope.scopeType === "chain" && scope.scopeValue !== "*" && !snapshot.chains.some((chain) => chain.id === scope.scopeValue)) {
        errors.push(`Missing Chain for Decision scope: decision:${scope.decisionId} -> chain:${scope.scopeValue}`);
      }
    }
    for (const block of snapshot.blocks) {
      if (!LEGACY_BLOCK_KINDS.has(block.kind)) {
        errors.push(`Invalid Block kind: block:${block.id}`);
      } else if (block.kind === "decision") {
        warnings.push(`Legacy decision Block is not a Decision record and is excluded from the Canvas; migrate block:${block.id} to decision:<id>`);
        continue;
      }
      if (block.deliveryState === "complete") {
        const passed = snapshot.checkpoints.some(
          (checkpoint) => checkpoint.targetType === "block" && checkpoint.targetId === block.id && checkpoint.status === "passed",
        );
        if (!passed) warnings.push(`Complete block has no passed checkpoint: block:${block.id}`);
      }
    }
    const unspecifiedBlocks = snapshot.blocks.filter((block) => block.architectureLayer === "unspecified");
    if (unspecifiedBlocks.length > 0) {
      warnings.push(`${unspecifiedBlocks.length} block(s) have no architecture layer`);
    }
    if (coverage.requiredCheckpointMissingIds.length) {
      warnings.push(`${coverage.requiredCheckpointMissingIds.length} Block(s) require a checkpoint but have none: ${coverage.requiredCheckpointMissingIds.slice(0, 20).map((id) => `block:${id}`).join(", ")}${coverage.requiredCheckpointMissingIds.length > 20 ? " …" : ""}`);
    }
    if (coverage.unplannedIds.length) {
      warnings.push(`${coverage.unplannedIds.length} Block(s) are not covered by any Plan: ${coverage.unplannedIds.slice(0, 20).map((id) => `block:${id}`).join(", ")}${coverage.unplannedIds.length > 20 ? " …" : ""}`);
    }
    if (coverage.checkpointUnboundIds.length) {
      warnings.push(`${coverage.checkpointUnboundIds.length} planned Block checkpoint(s) are not bound to an exact PlanChange: ${coverage.checkpointUnboundIds.slice(0, 20).map((id) => `block:${id}`).join(", ")}${coverage.checkpointUnboundIds.length > 20 ? " …" : ""}`);
    }
    if (coverage.chainGateMissingIds.length) {
      warnings.push(`${coverage.chainGateMissingIds.length} Block(s) belong to Chains without an integration gate: ${coverage.chainGateMissingIds.slice(0, 20).map((id) => `block:${id}`).join(", ")}${coverage.chainGateMissingIds.length > 20 ? " …" : ""}`);
    }
    for (const chain of snapshot.chains) {
      if (chain.deliveryState === "complete") {
        const passed = snapshot.checkpoints.some(
          (checkpoint) => checkpoint.targetType === "chain" && checkpoint.targetId === chain.id && checkpoint.status === "passed",
        );
        if (!passed) warnings.push(`Complete Chain has no passed checkpoint: chain:${chain.id}`);
      }
    }
    for (const plan of snapshot.plans) {
      if (plan.status === "complete") {
        const required = snapshot.planCheckpointRefs.filter((item) => item.planId === plan.id && item.required);
        const fallback = snapshot.checkpoints.filter((checkpoint) => checkpoint.targetType === "plan" && checkpoint.targetId === plan.id);
        const gates = required.length ? required.map((item) => snapshot.checkpoints.find((checkpoint) => checkpoint.id === item.checkpointId)).filter(Boolean) : fallback;
        if (!gates.length || gates.some((checkpoint) => !checkpointSatisfiesGate(checkpoint))) {
          warnings.push(`Complete plan has unsatisfied checkpoint gates: plan:${plan.id}`);
        }
        const steps = snapshot.planSteps.filter((step) => step.planId === plan.id);
        if (steps.length && steps.some((step) => !["complete", "skipped"].includes(step.status))) {
          warnings.push(`Complete plan has unfinished steps: plan:${plan.id}`);
        }
      }
      const hasChain = snapshot.planChainRefs.some((item) => item.planId === plan.id);
      const hasChange = snapshot.planChanges.some((item) => item.planId === plan.id);
      const hasStep = snapshot.planSteps.some((item) => item.planId === plan.id);
      if (!hasChain && !hasChange && !hasStep) warnings.push(`Plan has no declared work target: plan:${plan.id}`);
    }
    return { valid: errors.length === 0, errors, warnings, graphRevision: snapshot.project.graphRevision };
  }
}

export function createService(options = {}) {
  return new MdflowService(options);
}
