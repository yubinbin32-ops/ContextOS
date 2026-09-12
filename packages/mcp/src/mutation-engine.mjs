import { markProjectionPending, flushProjection } from "./database.mjs";
import fs from "node:fs";
import path from "node:path";
import { transaction } from "./database.mjs";
import { parseGraphPatch } from "./patch.mjs";
import { expandArrowFlowOperations } from "./flow.mjs";
import { extractSymbols } from "./ast.mjs";
import { executeRecordCheckpointOperation } from "./checkpoint-engine.mjs";
import { inspectChainTopology, topologyIssueText } from "./chain-topology.mjs";
import {
  memberKey,
  memberRef,
  inspectChainComposition,
  inspectCompositionCycles,
} from "./chain-composition.mjs";
import {
  assertAllowed,
  now,
  identifier,
  parseJson,
  changedHistoryFields,
  serializeTags,
  camelToColumn,
  entityExists,
  operationEntityType,
  affectedRefsForOperation,
  architectureCoverage,
  EDITABLE_BLOCK_FIELDS,
  EDITABLE_CHAIN_FIELDS,
  EDITABLE_LINK_FIELDS,
  EDITABLE_PLAN_FIELDS,
  EDITABLE_DECISION_FIELDS,
  EDITABLE_PLAN_CHAIN_SCOPE_FIELDS,
  EDITABLE_PLAN_CHANGE_FIELDS,
  LOCALIZED_FIELDS,
  LOCALES,
  PLAN_STATUSES,
  PLAN_STEP_STATUSES,
  DECISION_STATUSES,
  CHECKPOINT_STATUSES,
  CHECKPOINT_KINDS,
  EVIDENCE_LEVELS,
  EVIDENCE_LEVEL_RANK,
  LINK_KINDS,
  ARCHITECTURE_LAYERS,
  DELIVERY_STATES,
  HEALTH_STATES,
  LEGACY_BLOCK_KINDS,
  normalizeBlock,
  normalizeChain,
  normalizeLink,
  normalizePlan,
  normalizeDecision,
  normalizePlanChange,
  normalizePlanChainScope,
} from "./schema.mjs";

export function uiLocationFor(entityType, id) {
  if (entityType === "plan") return `Project > Plans > plan:${id}`;
  if (entityType === "decision") return `Project > Decisions > decision:${id}`;
  if (entityType === "chain") return `Project > Chains > chain:${id}`;
  if (entityType === "block") return `Canvas > block:${id}`;
  if (entityType === "link") return `Canvas > link:${id}`;
  if (entityType === "source_ref") return `Project > Block details > Files & Code > ${id}`;
  return `Project > ${entityType}:${id}`;
}

export function historyState(service, entityType, id) {
  const db = service.database;
  const projectId = service.paths.descriptor.id;
  if (entityType === "block") {
    const row = db.prepare("SELECT * FROM blocks WHERE project_id = ? AND id = ?").get(projectId, id);
    return row ? {
      ...normalizeBlock(row),
      sourceRefs: db.prepare("SELECT path, start_line, end_line, symbol, role FROM source_refs WHERE block_id = ? ORDER BY id").all(id),
    } : {};
  }
  if (entityType === "chain") {
    const row = db.prepare("SELECT * FROM chains WHERE project_id = ? AND id = ?").get(projectId, id);
    return row ? {
      ...normalizeChain(row),
      nodeIds: db.prepare("SELECT block_id FROM chain_nodes WHERE chain_id = ? ORDER BY position").all(id).map((item) => item.block_id),
      linkIds: db.prepare("SELECT link_id FROM chain_edges WHERE chain_id = ? ORDER BY position").all(id).map((item) => item.link_id),
      members: db.prepare("SELECT member_type, member_id, position, role, required FROM chain_members WHERE chain_id = ? ORDER BY position, member_type, member_id").all(id)
        .map((item) => ({ memberType: item.member_type, memberId: item.member_id, position: item.position, role: item.role, required: item.required !== 0 })),
    } : {};
  }
  if (entityType === "link") {
    const row = db.prepare("SELECT * FROM links WHERE project_id = ? AND id = ?").get(projectId, id);
    return row ? normalizeLink(row) : {};
  }
  if (entityType === "plan") {
    const row = db.prepare("SELECT * FROM plans WHERE project_id = ? AND id = ?").get(projectId, id);
    return row ? {
      ...normalizePlan(row),
      chainScopeIds: db.prepare("SELECT id FROM plan_chain_scopes WHERE plan_id = ? ORDER BY position").all(id).map((item) => item.id),
      changeIds: db.prepare("SELECT id FROM plan_changes WHERE plan_id = ? ORDER BY position").all(id).map((item) => item.id),
    } : {};
  }
  if (entityType === "decision") {
    const row = db.prepare("SELECT * FROM decisions WHERE project_id = ? AND id = ?").get(projectId, id);
    return row ? {
      ...normalizeDecision(row),
      scopes: db.prepare("SELECT scope_type, scope_value FROM decision_scopes WHERE decision_id = ? ORDER BY scope_type, scope_value")
        .all(id).map((item) => ({ type: item.scope_type, value: item.scope_value })),
    } : {};
  }
  if (entityType === "checkpoint") {
    const row = db.prepare("SELECT * FROM checkpoints WHERE project_id = ? AND id = ?").get(projectId, id);
    return row ? {
      id: row.id, targetType: row.target_type, targetId: row.target_id, title: row.title,
      criteria: row.criteria, status: row.status, checkpointKind: row.checkpoint_kind,
      aggregationPolicy: parseJson(row.aggregation_policy_json, {}),
      eligibleAfterChildren: Boolean(row.eligible_after_children), evidenceLevel: row.evidence_level,
      requiredEvidenceLevel: row.required_evidence_level, coverage: row.coverage,
      evidence: parseJson(row.evidence_json, []), invalidatedAt: row.invalidated_at,
      bindings: db.prepare("SELECT subject_type, subject_id, role, required FROM checkpoint_bindings WHERE checkpoint_id = ? ORDER BY position").all(id),
      children: db.prepare("SELECT child_checkpoint_id, required FROM checkpoint_dependencies WHERE parent_checkpoint_id = ? ORDER BY position").all(id),
      currentRevision: row.current_revision,
    } : {};
  }
  return {};
}

export function historyStateForOperation(service, operation, entityType, id) {
  if (operation.action === "update_plan_change") {
    const row = service.database.prepare(
      "SELECT pc.* FROM plan_changes pc JOIN plans p ON p.id = pc.plan_id WHERE p.project_id = ? AND pc.plan_id = ? AND pc.id = ?",
    ).get(service.paths.descriptor.id, id, operation.fields?.changeId);
    return row ? normalizePlanChange(row) : {};
  }
  if (operation.action === "update_plan_chain_scope") {
    const row = service.database.prepare(
      "SELECT pcs.* FROM plan_chain_scopes pcs JOIN plans p ON p.id = pcs.plan_id WHERE p.project_id = ? AND pcs.plan_id = ? AND pcs.id = ?",
    ).get(service.paths.descriptor.id, id, operation.fields?.scopeId);
    return row ? normalizePlanChainScope(row) : {};
  }
  return historyState(service, entityType, id);
}

export function applyLocalizations(service, entityType, entityId, localizations, timestamp) {
  if (localizations == null) return;
  if (entityType === "decision") {
    throw new Error("Decision records keep one canonical project-language body; use summary/rationale instead of localizations");
  }
  if (typeof localizations !== "object" || Array.isArray(localizations)) {
    throw new Error("fields.localizations must be an object keyed by locale");
  }
  const allowedFields = LOCALIZED_FIELDS[entityType];
  const upsert = service.database.prepare(
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

export function removeStaleLocalizations(service, entityType, entityId, changedFields, localizations) {
  const localizedFields = LOCALIZED_FIELDS[entityType];
  if (!localizedFields) return;
  const explicitlyUpdated = new Set(
    Object.values(localizations ?? {}).flatMap((values) => Object.keys(values ?? {})),
  );
  const remove = service.database.prepare(
    "DELETE FROM localized_text WHERE entity_type = ? AND entity_id = ? AND field = ?",
  );
  for (const field of changedFields) {
    if (localizedFields.has(field) && !explicitlyUpdated.has(field)) {
      remove.run(entityType, entityId, field);
    }
  }
}

export function executeMutate(
  service,
  { actor = "agent", reason, task = "", gitHead = null, planId = null, chainScopeId = null, operations },
  { maxOperations = 20, maxInputBytes = 65536, commitHook = null } = {},
) {
  if (!reason?.trim()) throw new Error("reason is required");
  if (!Array.isArray(operations) || operations.length === 0) throw new Error("operations are required");

  if (operations.length > maxOperations) throw new Error(`graph_mutate accepts at most ${maxOperations} operations`);
  if (JSON.stringify(operations).length > maxInputBytes) throw new Error("graph_mutate input exceeds 64 KB");

  const fieldSchemas = {
    create_block: new Set([...EDITABLE_BLOCK_FIELDS, 'localizations']),
    create_chain: new Set([...EDITABLE_CHAIN_FIELDS, 'localizations']),
    create_decision: new Set([...EDITABLE_DECISION_FIELDS, 'scopes']),
    create_plan: new Set([...EDITABLE_PLAN_FIELDS, 'localizations']),
    create_link: new Set([...EDITABLE_LINK_FIELDS, 'sourceType','sourceId','targetType','targetId','summary']),
    add_source_ref: new Set(['sourceId','path','symbol','role','startLine','endLine','gitCommit']),
    append_plan_changes: new Set(['changes']),
    append_plan_chain_scope: new Set(['scope']),
    update_plan_changes: new Set(['updates']),
    append_chain_path: new Set(['nodeIds','linkIds']),
    set_chain_composition: new Set(['memberRefs', 'members', 'linkIds', 'removeBlockIds']),
    append_chain_composition: new Set(['memberRefs', 'members', 'linkIds', 'removeBlockIds']),
  };
  for (const operation of operations) {
    const allowed = fieldSchemas[operation.action];
    const unknown = allowed && Object.keys(operation.fields ?? {}).filter(key => !allowed.has(key));
    if (unknown?.length) throw new Error(`${operation.action}: unknown fields ${unknown.join(', ')}; allowed: ${[...allowed].join(', ')}`);
  }
  service.ensureSynced();

  const database = service.database;
  const projectId = service.paths.descriptor.id;
  const changeSetId = identifier("change");
  const timestamp = now();
  const receipts = [];
  const historyContext = service.resolveHistoryContext(planId, chainScopeId);

  const mutationResult = transaction(database, () => {
    database
      .prepare(
        `INSERT INTO change_sets(id, project_id, actor, reason, task, git_head, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(changeSetId, projectId, actor, reason.trim(), task, gitHead, timestamp);

    for (const operation of operations) {
      const predictedType = operationEntityType(operation.action);
      const before = predictedType && operation.id ? historyStateForOperation(service, operation, predictedType, operation.id) : {};
      const receipt = applyOperation(service, operation, { changeSetId, timestamp });
      receipt.ref = `${receipt.entityType}:${receipt.id}`;
      receipt.uiLocation = uiLocationFor(receipt.entityType, receipt.id);
      receipt.readBack = { ref: receipt.ref, revision: receipt.revision };
      const after = historyStateForOperation(service, operation, receipt.entityType, receipt.id);
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

    const completions = operations.filter(op => ['create_block','update_block','create_chain','update_chain'].includes(op.action) && op.fields?.deliveryState === 'complete');
    if (completions.length) {
      const snapshot = service.snapshot();
      for (const op of completions) {
        const type = op.action.endsWith('_chain') ? 'chain' : 'block';
        const target = op.id ?? receipts[operations.indexOf(op)]?.id;
        const checks = snapshot.checkpoints.filter(c => c.targetType === type && c.targetId === target);
        const block = type === 'block' ? snapshot.blocks.find(b=>b.id===target) : null;
        const sourceBacked = block && ['flow','ui','service','function','integration','api','data','database'].includes(block.kind);
        if(sourceBacked) {
          const bindings=[...service.sourceBindingState.values()].filter(b=>b.blockId===target);
          if(!bindings.length || bindings.some(b=>!b.symbol || ['missing','ambiguous','stale','unreadable','outside_project','line_only'].includes(b.bindingStatus))) throw new Error(`Completion requires valid source bindings and a fresh passed Checkpoint for block:${target}`);
        }
        if(type==='chain') {
          const targetChain = snapshot.chains.find((candidate) => candidate.id === target);
          if (targetChain?.chainType === "composite") {
            const members = snapshot.chainMembers.filter((member) => member.chainId === target).sort((a, b) => a.position - b.position);
            const edges = snapshot.chainEdges.filter((edge) => edge.chainId === target).sort((a, b) => a.position - b.position);
            const composition = inspectChainComposition({
              chain: targetChain,
              members,
              edges,
              chains: snapshot.chains,
              blocks: snapshot.blocks,
              links: snapshot.links,
            });
            if (!members.length || !composition.ready) {
              throw new Error(`Composite Chain completion requires complete members and a connected acyclic composition for ${target}`);
            }
          } else {
            const nodes=snapshot.chainNodes.filter(n=>n.chainId===target);
            if(!nodes.length || nodes.some(n=>snapshot.blocks.find(b=>b.id===n.blockId)?.deliveryState!=='complete')) throw new Error(`Chain completion requires completed member Blocks: ${target}`);
            const edges = snapshot.chainEdges
              .filter((edge) => edge.chainId === target)
              .map((edge) => {
                const link = snapshot.links.find((item) => item.id === edge.linkId);
                return link
                  ? { linkId: edge.linkId, position: edge.position, sourceId: link.sourceId, targetId: link.targetId }
                  : { linkId: edge.linkId, position: edge.position };
              });
            const topology = inspectChainTopology({ nodes, edges });
            const topologyIssues = topology.issues.filter((issue) => issue.hard || ['disconnected', 'no_edges'].includes(issue.code));
            if (topologyIssues.length) throw new Error(`Chain completion requires an ordered connected topology for ${target}: ${topologyIssueText(target, { issues: topologyIssues })}`);
          }
        }
        if ((checks.length || sourceBacked || op.action === 'update_block') && !checks.some(c => c.status === 'passed' && c.freshness?.status === 'fresh')) {
          throw new Error(`Completion requires a fresh passed Checkpoint for ${type}:${target}; use checkpoint_record and block_seal/task_finish`);
        }
      }
    }
    database
      .prepare(
        `UPDATE projects SET graph_revision = graph_revision + 1, updated_at = ? WHERE id = ?`,
      )
      .run(timestamp, projectId);
    const graphRevision = database.prepare("SELECT graph_revision FROM projects WHERE id = ?").get(projectId)
      .graph_revision;
    if (commitHook) commitHook();
    markProjectionPending(database);
    return { changeSetId, graphRevision, receipts };
  });

  if (service.paths.graphJsonPath) {
    try {
      flushProjection(service.database, service.paths.graphJsonPath);
      mutationResult.projection = { status: "synced" };
    } catch (error) {
      mutationResult.projection = { status: "pending", error: error.message };
      mutationResult.success = false;
    }
  }

  return mutationResult;
}

export function applyOperation(service, operation, context) {
  switch (operation.action) {
    case "create_block":
      return createBlock(service, operation, context);
    case "update_block":
      return updateEntity(service, "block", operation, context);
    case "delete_block":
      return deleteBlock(service, operation, context);
    case "create_checkpoint":
      return createCheckpoint(service, operation, context);
    case "delete_checkpoint":
      return deleteCheckpoint(service, operation, context);
    case "record_checkpoint":
      return executeRecordCheckpointOperation(service, operation, context);
    case "add_source_ref":
      return addSourceRef(service, operation, context);
    case "remove_source_ref":
      return removeSourceRef(service, operation, context);
    case "create_chain":
      return createChain(service, operation, context);
    case "update_chain":
      return updateEntity(service, "chain", operation, context);
    case "delete_chain":
      return deleteChain(service, operation, context);
    case "create_link":
      return createLink(service, operation, context);
    case "update_link":
      return updateEntity(service, "link", operation, context);
    case "delete_link":
      return deleteLink(service, operation, context);
    case "create_plan":
      return createPlan(service, operation, context);
    case "update_plan":
      return updateEntity(service, "plan", operation, context);
    case "delete_plan":
      return deletePlan(service, operation, context);
    case "set_plan_chains":
      return setPlanChains(service, operation, context);
    case "set_plan_dependencies":
      return setPlanDependencies(service, operation, context);
    case "set_plan_steps":
      return setPlanSteps(service, operation, context);
    case "update_plan_step":
      return updatePlanStep(service, operation, context);
    case "set_plan_checkpoints":
      return setPlanCheckpoints(service, operation, context);
    case "set_plan_chain_scopes":
      return setPlanChainScopes(service, operation, context);
    case "update_plan_chain_scope":
      return updatePlanChainScope(service, operation, context);
    case "set_plan_changes":
      return setPlanChanges(service, operation, context);
    case "append_plan_changes":
      return appendPlanChanges(service, operation, context);
    case "update_plan_change":
      return updatePlanChange(service, operation, context);
    case "update_plan_changes":
      return updatePlanChanges(service, operation, context);
    case "append_plan_chain_scope":
      return appendPlanChainScope(service, operation, context);
    case "set_plan_chain_change_refs":
      return setPlanChainChangeRefs(service, operation, context);
    case "set_checkpoint_bindings":
      return setCheckpointBindings(service, operation, context);
    case "set_checkpoint_dependencies":
      return setCheckpointDependencies(service, operation, context);
    case "set_chain_path":
      return setChainPath(service, operation, context);
    case "append_chain_path":
      return appendChainPath(service, operation, context);
    case "set_chain_composition":
      return setChainComposition(service, operation, context);
    case "append_chain_composition":
      return appendChainComposition(service, operation, context);
    case "set_background_scopes":
      return setBackgroundScopes(service, operation, context);
    case "create_decision":
      return createDecision(service, operation, context);
    case "update_decision":
      return updateEntity(service, "decision", operation, context);
    case "delete_decision":
      return deleteDecision(service, operation, context);
    case "set_decision_scopes":
      return setDecisionScopes(service, operation, context);
    default:
      throw new Error(`Unsupported action: ${operation.action}`);
  }
}

export function createPlan(service, operation, { timestamp }) {
  const fields = operation.fields ?? {};
  if (!fields.title?.trim()) throw new Error("create_plan requires fields.title");
  assertAllowed(fields.status ?? "draft", PLAN_STATUSES, "plan status");
  const id = operation.id ?? identifier("plan");
  service.database.prepare(
    `INSERT INTO plans(
      id, project_id, title, summary, goal, status, priority, phase, plan_order,
      proposed_delta_json, completion_policy_json, next_action, blockers_json, status_reason,
      started_at, completed_at, invalidated_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, service.paths.descriptor.id, fields.title.trim(), fields.summary ?? "", fields.goal ?? "",
    fields.status ?? "draft", fields.priority ?? "normal", fields.phase ?? "implementation", fields.planOrder ?? 0,
    JSON.stringify(fields.proposedDelta ?? []), JSON.stringify(fields.completionPolicy ?? {}),
    fields.nextAction ?? "", JSON.stringify(fields.blockers ?? []), fields.statusReason ?? "",
    fields.startedAt ?? null, fields.completedAt ?? null, fields.invalidatedAt ?? null, timestamp, timestamp,
  );
  applyLocalizations(service, "plan", id, fields.localizations, timestamp);
  return { entityType: "plan", id, action: "created", revision: 1, summary: fields.title.trim() };
}

export function setPlanChains(service, operation) {
  if (!operation.id || !Number.isInteger(operation.expectedRevision)) {
    throw new Error("set_plan_chains requires id and expectedRevision");
  }
  const plan = service.database.prepare("SELECT * FROM plans WHERE project_id = ? AND id = ?")
    .get(service.paths.descriptor.id, operation.id);
  if (!plan) throw new Error(`plan:${operation.id} not found`);
  if (plan.current_revision !== operation.expectedRevision) {
    throw new Error(`Revision conflict for plan:${operation.id}; expected ${operation.expectedRevision}, current ${plan.current_revision}`);
  }
  const chainIds = operation.fields?.chainIds ?? [];
  for (const chainId of chainIds) {
    if (!entityExists(service.database, service.paths.descriptor.id, "chain", chainId)) throw new Error(`chain:${chainId} not found`);
  }
  service.database.prepare("DELETE FROM plan_chain_refs WHERE plan_id = ?").run(operation.id);
  const insert = service.database.prepare("INSERT INTO plan_chain_refs(plan_id, chain_id, position) VALUES (?, ?, ?)");
  chainIds.forEach((chainId, index) => insert.run(operation.id, chainId, index));
  const revision = plan.current_revision + 1;
  service.database.prepare("UPDATE plans SET current_revision = ?, updated_at = ? WHERE id = ?").run(revision, now(), operation.id);
  return { entityType: "plan", id: operation.id, action: "chains-set", revision, summary: `${chainIds.length} target chain(s)` };
}

function planForMutation(service, operation, action) {
  if (!operation.id || !Number.isInteger(operation.expectedRevision)) {
    throw new Error(`${action} requires id and expectedRevision`);
  }
  const plan = service.database.prepare("SELECT * FROM plans WHERE project_id = ? AND id = ?")
    .get(service.paths.descriptor.id, operation.id);
  if (!plan) throw new Error(`plan:${operation.id} not found`);
  if (plan.current_revision !== operation.expectedRevision) {
    throw new Error(`Revision conflict for plan:${operation.id}; expected ${operation.expectedRevision}, current ${plan.current_revision}`);
  }
  return plan;
}

function finishPlanRelationMutation(service, plan, operation, action, summary) {
  const revision = plan.current_revision + 1;
  service.database.prepare("UPDATE plans SET current_revision = ?, updated_at = ? WHERE id = ?")
    .run(revision, now(), operation.id);
  return { entityType: "plan", id: operation.id, action, revision, summary };
}

function validatedPlanChainScope(service, scope, index = 0) {
  if (!scope.chainId || !entityExists(service.database, service.paths.descriptor.id, "chain", scope.chainId)) {
    throw new Error(`chain:${scope.chainId ?? ""} not found`);
  }
  if (!scope.title?.trim()) throw new Error(`Plan ChainScope ${index + 1} requires title`);
  if (!Number.isInteger(scope.position) || scope.position < 0) throw new Error("Plan ChainScope position must be a non-negative integer");
  assertAllowed(scope.status ?? "pending", PLAN_STEP_STATUSES, "Plan ChainScope status");
  const chainNodeIds = service.database.prepare("SELECT block_id FROM chain_nodes WHERE chain_id = ? ORDER BY position")
    .all(scope.chainId).map((row) => row.block_id);
  const chainLinkIds = service.database.prepare("SELECT link_id FROM chain_edges WHERE chain_id = ? ORDER BY position")
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

function validatedPlanChange(service, change, index = 0) {
  if (!change.title?.trim()) throw new Error(`Plan change ${index + 1} requires title`);
  if (!Number.isInteger(change.position) || change.position < 0) throw new Error("Plan change position must be a non-negative integer");
  if (!["block", "link", "chain"].includes(change.entityType) ||
      !entityExists(service.database, service.paths.descriptor.id, change.entityType, change.entityId)) {
    throw new Error(`${change.entityType}:${change.entityId} not found`);
  }
  assertAllowed(change.status ?? "pending", PLAN_STEP_STATUSES, "Plan change status");
  return { ...change, title: change.title.trim(), status: change.status ?? "pending" };
}

function refreshPlanChainRefs(service, planId) {
  service.database.prepare("DELETE FROM plan_chain_refs WHERE plan_id = ?").run(planId);
  const chainIds = service.database.prepare(
    "SELECT chain_id FROM plan_chain_scopes WHERE plan_id = ? GROUP BY chain_id ORDER BY MIN(position), chain_id",
  ).all(planId).map((row) => row.chain_id);
  const insert = service.database.prepare("INSERT INTO plan_chain_refs(plan_id, chain_id, position) VALUES (?, ?, ?)");
  chainIds.forEach((chainId, index) => insert.run(planId, chainId, index));
}

export function setPlanDependencies(service, operation) {
  const plan = planForMutation(service, operation, "set_plan_dependencies");
  const planIds = operation.fields?.planIds ?? [];
  if (!Array.isArray(planIds) || new Set(planIds).size !== planIds.length) throw new Error("planIds must be unique");
  for (const dependencyId of planIds) {
    if (dependencyId === operation.id) throw new Error("Plan cannot depend on itself");
    if (!entityExists(service.database, service.paths.descriptor.id, "plan", dependencyId)) throw new Error(`plan:${dependencyId} not found`);
  }
  const existing = service.database.prepare("SELECT plan_id, depends_on_plan_id FROM plan_dependencies").all();
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
  service.database.prepare("DELETE FROM plan_dependencies WHERE plan_id = ?").run(operation.id);
  const insert = service.database.prepare("INSERT INTO plan_dependencies(plan_id, depends_on_plan_id, position) VALUES (?, ?, ?)");
  planIds.forEach((id, index) => insert.run(operation.id, id, index));
  return finishPlanRelationMutation(service, plan, operation, "dependencies-set", `${planIds.length} prerequisite plan(s)`);
}

export function setPlanSteps(service, operation, { timestamp }) {
  const plan = planForMutation(service, operation, "set_plan_steps");
  const steps = operation.fields?.steps ?? [];
  if (!Array.isArray(steps)) throw new Error("steps must be an array");
  const ids = steps.map((step, index) => step.id ?? `${operation.id}-step-${index + 1}`);
  if (new Set(ids).size !== ids.length) throw new Error("Plan step IDs must be unique");
  for (const [index, step] of steps.entries()) {
    if (!step.title?.trim()) throw new Error(`Plan step ${index + 1} requires title`);
    assertAllowed(step.status ?? "pending", PLAN_STEP_STATUSES, "plan step status");
    for (const ref of step.targetRefs ?? []) {
      const [type, id] = String(ref).split(":", 2);
      if (!id || !entityExists(service.database, service.paths.descriptor.id, type, id)) throw new Error(`Missing Plan step target: ${ref}`);
    }
  }
  service.database.prepare("DELETE FROM plan_steps WHERE plan_id = ?").run(operation.id);
  const insert = service.database.prepare(
    `INSERT INTO plan_steps(id, plan_id, position, title, action, status, target_refs_json, proposed_delta_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  steps.forEach((step, index) => insert.run(
    ids[index], operation.id, index, step.title.trim(), step.action ?? "", step.status ?? "pending",
    JSON.stringify(step.targetRefs ?? []), JSON.stringify(step.proposedDelta ?? []), timestamp, timestamp,
  ));
  return finishPlanRelationMutation(service, plan, operation, "steps-set", `${steps.length} ordered step(s)`);
}

export function updatePlanStep(service, operation, { timestamp }) {
  const plan = planForMutation(service, operation, "update_plan_step");
  const stepId = operation.fields?.stepId;
  const patch = operation.fields?.patch;
  if (!stepId || !patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("update_plan_step requires fields.stepId and fields.patch");
  }
  const row = service.database.prepare("SELECT * FROM plan_steps WHERE plan_id = ? AND id = ?").get(operation.id, stepId);
  if (!row) throw new Error(`plan_step:${stepId} not found in plan:${operation.id}`);
  const nextStatus = patch.status ?? row.status;
  assertAllowed(nextStatus, PLAN_STEP_STATUSES, "plan step status");
  const title = patch.title?.trim() ?? row.title;
  const action = patch.action ?? row.action;
  const targetRefs = patch.targetRefs ? JSON.stringify(patch.targetRefs) : row.target_refs_json;
  const proposedDelta = patch.proposedDelta ? JSON.stringify(patch.proposedDelta) : row.proposed_delta_json;
  service.database.prepare(
    `UPDATE plan_steps SET title = ?, action = ?, status = ?, target_refs_json = ?, proposed_delta_json = ?, updated_at = ?
     WHERE plan_id = ? AND id = ?`,
  ).run(title, action, nextStatus, targetRefs, proposedDelta, timestamp, operation.id, stepId);
  return finishPlanRelationMutation(service, plan, operation, "plan-step-updated", `Updated plan_step:${stepId}`);
}

export function setPlanCheckpoints(service, operation) {
  const plan = planForMutation(service, operation, "set_plan_checkpoints");
  const checkpoints = operation.fields?.checkpoints ?? [];
  if (!Array.isArray(checkpoints)) throw new Error("checkpoints must be an array");
  const stepIds = new Set(service.database.prepare("SELECT id FROM plan_steps WHERE plan_id = ?").all(operation.id).map((row) => row.id));
  for (const item of checkpoints) {
    if (!item.checkpointId || !service.database.prepare("SELECT 1 FROM checkpoints WHERE project_id = ? AND id = ?").get(service.paths.descriptor.id, item.checkpointId)) {
      throw new Error(`checkpoint:${item.checkpointId ?? ""} not found`);
    }
    if (item.stepId && !stepIds.has(item.stepId)) throw new Error(`Plan step not found: ${item.stepId}`);
  }
  service.database.prepare("DELETE FROM plan_checkpoint_refs WHERE plan_id = ?").run(operation.id);
  const insert = service.database.prepare(
    "INSERT INTO plan_checkpoint_refs(plan_id, checkpoint_id, step_id, position, required) VALUES (?, ?, ?, ?, ?)",
  );
  checkpoints.forEach((item, index) => insert.run(operation.id, item.checkpointId, item.stepId ?? null, index, item.required === false ? 0 : 1));
  return finishPlanRelationMutation(service, plan, operation, "checkpoints-set", `${checkpoints.length} checkpoint gate(s)`);
}

export function setPlanChainScopes(service, operation, { timestamp }) {
  const plan = planForMutation(service, operation, "set_plan_chain_scopes");
  const scopes = operation.fields?.scopes ?? [];
  if (!Array.isArray(scopes)) throw new Error("scopes must be an array");
  const ids = scopes.map((scope, index) => scope.id ?? `${operation.id}-chain-scope-${index + 1}`);
  if (new Set(ids).size !== ids.length) throw new Error("Plan ChainScope IDs must be unique");
  const normalizedScopes = scopes.map((scope, index) => validatedPlanChainScope(service, { ...scope, id: ids[index], position: index }, index));
  const existingRows = service.database.prepare("SELECT * FROM plan_chain_scopes WHERE plan_id = ?").all(operation.id);
  const existingById = new Map(existingRows.map((row) => [row.id, row]));
  for (const scope of normalizedScopes) {
    const owner = service.database.prepare("SELECT plan_id FROM plan_chain_scopes WHERE id = ?").get(scope.id);
    if (owner && owner.plan_id !== operation.id) throw new Error(`plan_chain_scope:${scope.id} belongs to another Plan`);
  }
  const desiredIds = new Set(ids);
  const removedIds = existingRows.filter((row) => !desiredIds.has(row.id)).map((row) => row.id);
  for (const id of removedIds) {
    service.database.prepare("DELETE FROM checkpoint_bindings WHERE subject_type = 'plan_chain_scope' AND subject_id = ?").run(id);
    service.database.prepare("DELETE FROM plan_chain_scopes WHERE plan_id = ? AND id = ?").run(operation.id, id);
  }
  const insert = service.database.prepare(
    `INSERT INTO plan_chain_scopes(
      id, plan_id, chain_id, position, title, summary, rationale, start_block_id, end_block_id,
      node_ids_json, link_ids_json, expected_delta_json, prohibitions_json, localizations_json,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = service.database.prepare(
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
  refreshPlanChainRefs(service, operation.id);
  return finishPlanRelationMutation(service, plan, operation, "chain-scopes-set", `${scopes.length} detailed Chain scope(s)`);
}

export function updatePlanChainScope(service, operation, { timestamp }) {
  const plan = planForMutation(service, operation, "update_plan_chain_scope");
  const scopeId = operation.fields?.scopeId;
  const patch = operation.fields?.patch;
  if (!scopeId || !patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("update_plan_chain_scope requires fields.scopeId and fields.patch");
  }
  for (const field of Object.keys(patch)) {
    if (!EDITABLE_PLAN_CHAIN_SCOPE_FIELDS.has(field)) throw new Error(`Unsupported Plan ChainScope field: ${field}`);
  }
  const row = service.database.prepare("SELECT * FROM plan_chain_scopes WHERE plan_id = ? AND id = ?").get(operation.id, scopeId);
  if (!row) throw new Error(`plan_chain_scope:${scopeId} not found in plan:${operation.id}`);
  const current = normalizePlanChainScope(row);
  const next = validatedPlanChainScope(service, { ...current, ...patch }, current.position);
  service.database.prepare(
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
  refreshPlanChainRefs(service, operation.id);
  return finishPlanRelationMutation(service, plan, operation, "chain-scope-updated", `Updated plan_chain_scope:${scopeId}`);
}

export function setPlanChanges(service, operation, { timestamp }) {
  const plan = planForMutation(service, operation, "set_plan_changes");
  const changes = operation.fields?.changes ?? [];
  if (!Array.isArray(changes)) throw new Error("changes must be an array");
  const keys = changes.map((change) => `${change.entityType}:${change.entityId}`);
  if (new Set(keys).size !== keys.length) throw new Error("A Plan may define only one canonical change per entity");
  const normalizedChanges = changes.map((change, index) => validatedPlanChange(service, {
    ...change,
    id: change.id ?? `${operation.id}-${change.entityType}-${change.entityId}`,
    position: index,
  }, index));
  const existingRows = service.database.prepare("SELECT * FROM plan_changes WHERE plan_id = ?").all(operation.id);
  const existingById = new Map(existingRows.map((row) => [row.id, row]));
  for (const change of normalizedChanges) {
    const owner = service.database.prepare("SELECT plan_id, entity_type, entity_id FROM plan_changes WHERE id = ?").get(change.id);
    if (owner && owner.plan_id !== operation.id) throw new Error(`plan_change:${change.id} belongs to another Plan`);
    if (owner && (owner.entity_type !== change.entityType || owner.entity_id !== change.entityId)) {
      throw new Error(`plan_change:${change.id} target is immutable; create a new Plan change ID`);
    }
  }
  const desiredIds = new Set(normalizedChanges.map((change) => change.id));
  const removedIds = existingRows.filter((row) => !desiredIds.has(row.id)).map((row) => row.id);
  for (const id of removedIds) {
    service.database.prepare("DELETE FROM checkpoint_bindings WHERE subject_type = 'plan_change' AND subject_id = ?").run(id);
    service.database.prepare("DELETE FROM plan_changes WHERE plan_id = ? AND id = ?").run(operation.id, id);
  }
  const insert = service.database.prepare(
    `INSERT INTO plan_changes(
      id, plan_id, entity_type, entity_id, position, title, summary, current_behavior, proposed_behavior,
      rationale, prohibitions_json, expected_effects_json, source_refs_json, localizations_json,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = service.database.prepare(
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
  return finishPlanRelationMutation(service, plan, operation, "changes-set", `${changes.length} canonical entity change(s)`);
}

/**
 * Append canonical work to an existing Plan without asking the caller to
 * replay and replace the whole change list. This is the safe default for a
 * feature that grows during implementation: existing PlanChanges and their
 * checkpoint bindings remain intact, while the optimistic revision still
 * prevents concurrent writers from silently merging stale state.
 */
export function appendPlanChanges(service, operation, { timestamp }) {
  const plan = planForMutation(service, operation, "append_plan_changes");
  const changes = operation.fields?.changes ?? [];
  if (!Array.isArray(changes) || changes.length === 0) throw new Error("append_plan_changes requires at least one change");
  const existingRows = service.database.prepare("SELECT * FROM plan_changes WHERE plan_id = ? ORDER BY position, id").all(operation.id);
  const existingKeys = new Set(existingRows.map((row) => `${row.entity_type}:${row.entity_id}`));
  const incomingKeys = new Set();
  const normalizedChanges = changes.map((change, index) => {
    const key = `${change.entityType}:${change.entityId}`;
    if (existingKeys.has(key) || incomingKeys.has(key)) {
      throw new Error(`Plan already has a canonical change for ${key}; use update_plan_change for an existing entity`);
    }
    incomingKeys.add(key);
    return validatedPlanChange(service, {
      ...change,
      id: change.id ?? `${operation.id}-change-${change.entityType}-${change.entityId}`,
      position: existingRows.length + index,
    }, existingRows.length + index);
  });
  const insert = service.database.prepare(
    `INSERT INTO plan_changes(
      id, plan_id, entity_type, entity_id, position, title, summary, current_behavior, proposed_behavior,
      rationale, prohibitions_json, expected_effects_json, source_refs_json, localizations_json,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const change of normalizedChanges) {
    const owner = service.database.prepare("SELECT plan_id FROM plan_changes WHERE id = ?").get(change.id);
    if (owner) throw new Error(`plan_change:${change.id} already exists`);
    insert.run(
      change.id, operation.id, change.entityType, change.entityId, change.position, change.title, change.summary ?? "",
      change.currentBehavior ?? "", change.proposedBehavior ?? "", change.rationale ?? "",
      JSON.stringify(change.prohibitions ?? []), JSON.stringify(change.expectedEffects ?? []),
      JSON.stringify(change.sourceRefs ?? []), JSON.stringify(change.localizations ?? {}), change.status, timestamp, timestamp,
    );
  }
  return finishPlanRelationMutation(service, plan, operation, "changes-appended", `${normalizedChanges.length} canonical entity change(s) appended`);
}

/** Append one ordered ChainScope while preserving all existing scopes. */
export function appendPlanChainScope(service, operation, { timestamp }) {
  const plan = planForMutation(service, operation, "append_plan_chain_scope");
  const scope = operation.fields?.scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) throw new Error("append_plan_chain_scope requires fields.scope");
  const existingRows = service.database.prepare("SELECT * FROM plan_chain_scopes WHERE plan_id = ? ORDER BY position, id").all(operation.id);
  const id = scope.id ?? `${operation.id}-chain-scope-${existingRows.length + 1}`;
  if (service.database.prepare("SELECT 1 FROM plan_chain_scopes WHERE id = ?").get(id)) throw new Error(`plan_chain_scope:${id} already exists`);
  const normalized = validatedPlanChainScope(service, { ...scope, id, position: existingRows.length }, existingRows.length);
  service.database.prepare(
    `INSERT INTO plan_chain_scopes(
      id, plan_id, chain_id, position, title, summary, rationale, start_block_id, end_block_id,
      node_ids_json, link_ids_json, expected_delta_json, prohibitions_json, localizations_json,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    normalized.id, operation.id, normalized.chainId, normalized.position, normalized.title, normalized.summary ?? "",
    normalized.rationale ?? "", normalized.startBlockId, normalized.endBlockId, JSON.stringify(normalized.nodeIds),
    JSON.stringify(normalized.linkIds), JSON.stringify(normalized.expectedDelta ?? []), JSON.stringify(normalized.prohibitions ?? []),
    JSON.stringify(normalized.localizations ?? {}), normalized.status, timestamp, timestamp,
  );
  refreshPlanChainRefs(service, operation.id);
  return finishPlanRelationMutation(service, plan, operation, "chain-scope-appended", `ChainScope ${normalized.id} appended`);
}

export function updatePlanChange(service, operation, { timestamp }) {
  const plan = planForMutation(service, operation, "update_plan_change");
  const changeId = operation.fields?.changeId;
  const patch = operation.fields?.patch;
  if (!changeId || !patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("update_plan_change requires fields.changeId and fields.patch");
  }
  for (const field of Object.keys(patch)) {
    if (!EDITABLE_PLAN_CHANGE_FIELDS.has(field)) throw new Error(`Unsupported Plan change field: ${field}`);
  }
  const row = service.database.prepare("SELECT * FROM plan_changes WHERE plan_id = ? AND id = ?").get(operation.id, changeId);
  if (!row) throw new Error(`plan_change:${changeId} not found in plan:${operation.id}`);
  const current = normalizePlanChange(row);
  const next = validatedPlanChange(service, { ...current, ...patch }, current.position);
  service.database.prepare(
    `UPDATE plan_changes SET position = ?, title = ?, summary = ?, current_behavior = ?, proposed_behavior = ?,
      rationale = ?, prohibitions_json = ?, expected_effects_json = ?, source_refs_json = ?, localizations_json = ?,
      status = ?, current_revision = current_revision + 1, updated_at = ? WHERE plan_id = ? AND id = ?`,
  ).run(
    next.position, next.title, next.summary, next.currentBehavior, next.proposedBehavior, next.rationale,
    JSON.stringify(next.prohibitions), JSON.stringify(next.expectedEffects), JSON.stringify(next.sourceRefs),
    JSON.stringify(next.localizations), next.status, timestamp, operation.id, changeId,
  );
  return finishPlanRelationMutation(service, plan, operation, "plan-change-updated", `Updated plan_change:${changeId}`);
}

/**
 * Update several existing PlanChanges in one optimistic Plan revision. This
 * is used by task reconciliation/finish so a feature can advance its
 * canonical work records without replaying the whole Plan change list.
 */
export function updatePlanChanges(service, operation, { timestamp }) {
  const plan = planForMutation(service, operation, "update_plan_changes");
  const updates = operation.fields?.updates ?? [];
  if (!Array.isArray(updates) || updates.length === 0) throw new Error("update_plan_changes requires at least one update");
  if (updates.length > 20) throw new Error("update_plan_changes accepts at most 20 updates");
  const seen = new Set();
  const normalized = updates.map((update, index) => {
    const changeId = update?.changeId;
    const patch = update?.patch;
    if (!changeId || !patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error(`Plan change update ${index + 1} requires changeId and patch`);
    }
    if (seen.has(changeId)) throw new Error(`Duplicate Plan change update: ${changeId}`);
    seen.add(changeId);
    for (const field of Object.keys(patch)) {
      if (!EDITABLE_PLAN_CHANGE_FIELDS.has(field)) throw new Error(`Unsupported Plan change field: ${field}`);
    }
    const row = service.database.prepare("SELECT * FROM plan_changes WHERE plan_id = ? AND id = ?").get(operation.id, changeId);
    if (!row) throw new Error(`plan_change:${changeId} not found in plan:${operation.id}`);
    return { row, next: validatedPlanChange(service, { ...normalizePlanChange(row), ...patch }, row.position) };
  });
  const update = service.database.prepare(
    `UPDATE plan_changes SET position = ?, title = ?, summary = ?, current_behavior = ?, proposed_behavior = ?,
      rationale = ?, prohibitions_json = ?, expected_effects_json = ?, source_refs_json = ?, localizations_json = ?,
      status = ?, current_revision = current_revision + 1, updated_at = ? WHERE plan_id = ? AND id = ?`,
  );
  for (const { next } of normalized) {
    update.run(
      next.position, next.title, next.summary ?? "", next.currentBehavior ?? "", next.proposedBehavior ?? "",
      next.rationale ?? "", JSON.stringify(next.prohibitions ?? []), JSON.stringify(next.expectedEffects ?? []),
      JSON.stringify(next.sourceRefs ?? []), JSON.stringify(next.localizations ?? {}), next.status, timestamp, operation.id, next.id,
    );
  }
  return finishPlanRelationMutation(service, plan, operation, "plan-changes-updated", `${normalized.length} Plan change(s) updated`);
}

export function setPlanChainChangeRefs(service, operation) {
  const plan = planForMutation(service, operation, "set_plan_chain_change_refs");
  const refs = operation.fields?.refs ?? [];
  if (!Array.isArray(refs)) throw new Error("refs must be an array");
  const scopes = new Set(service.database.prepare("SELECT id FROM plan_chain_scopes WHERE plan_id = ?").all(operation.id).map((row) => row.id));
  const changes = new Set(service.database.prepare("SELECT id FROM plan_changes WHERE plan_id = ?").all(operation.id).map((row) => row.id));
  for (const ref of refs) {
    if (!scopes.has(ref.chainScopeId)) throw new Error(`Plan ChainScope not found: ${ref.chainScopeId}`);
    if (!changes.has(ref.planChangeId)) throw new Error(`Plan change not found: ${ref.planChangeId}`);
  }
  service.database.prepare(
    "DELETE FROM plan_chain_change_refs WHERE chain_scope_id IN (SELECT id FROM plan_chain_scopes WHERE plan_id = ?)",
  ).run(operation.id);
  const insert = service.database.prepare(
    "INSERT INTO plan_chain_change_refs(chain_scope_id, plan_change_id, role, position) VALUES (?, ?, ?, ?)",
  );
  refs.forEach((ref, index) => insert.run(ref.chainScopeId, ref.planChangeId, ref.role ?? "affected", ref.position ?? index));
  return finishPlanRelationMutation(service, plan, operation, "chain-change-refs-set", `${refs.length} Chain-to-change reference(s)`);
}

function checkpointForMutation(service, operation, action) {
  if (!operation.id || !Number.isInteger(operation.expectedRevision)) throw new Error(`${action} requires id and expectedRevision`);
  const checkpoint = service.database.prepare("SELECT * FROM checkpoints WHERE project_id = ? AND id = ?")
    .get(service.paths.descriptor.id, operation.id);
  if (!checkpoint) throw new Error(`checkpoint:${operation.id} not found`);
  if (checkpoint.current_revision !== operation.expectedRevision) {
    throw new Error(`Revision conflict for checkpoint:${operation.id}; expected ${operation.expectedRevision}, current ${checkpoint.current_revision}`);
  }
  return checkpoint;
}

function finishCheckpointRelationMutation(service, checkpoint, operation, action, summary) {
  const revision = checkpoint.current_revision + 1;
  service.database.prepare("UPDATE checkpoints SET current_revision = ?, updated_at = ? WHERE id = ?")
    .run(revision, now(), operation.id);
  return { entityType: "checkpoint", id: operation.id, action, revision, summary };
}

export function setCheckpointBindings(service, operation) {
  const checkpoint = checkpointForMutation(service, operation, "set_checkpoint_bindings");
  const bindings = operation.fields?.bindings ?? [];
  if (!Array.isArray(bindings)) throw new Error("bindings must be an array");
  for (const binding of bindings) {
    if (!entityExists(service.database, service.paths.descriptor.id, binding.subjectType, binding.subjectId)) {
      throw new Error(`${binding.subjectType}:${binding.subjectId} not found`);
    }
  }
  service.database.prepare("DELETE FROM checkpoint_bindings WHERE checkpoint_id = ?").run(operation.id);
  const insert = service.database.prepare(
    "INSERT INTO checkpoint_bindings(checkpoint_id, subject_type, subject_id, role, required, position) VALUES (?, ?, ?, ?, ?, ?)",
  );
  bindings.forEach((binding, index) => insert.run(
    operation.id, binding.subjectType, binding.subjectId, binding.role ?? "leaf",
    binding.required === false ? 0 : 1, binding.position ?? index,
  ));
  return finishCheckpointRelationMutation(service, checkpoint, operation, "bindings-set", `${bindings.length} subject binding(s)`);
}

export function setCheckpointDependencies(service, operation) {
  const checkpoint = checkpointForMutation(service, operation, "set_checkpoint_dependencies");
  const children = operation.fields?.children ?? [];
  if (!Array.isArray(children)) throw new Error("children must be an array");
  const ids = children.map((child) => child.checkpointId);
  if (new Set(ids).size !== ids.length) throw new Error("Checkpoint child IDs must be unique");
  for (const childId of ids) {
    if (childId === operation.id) throw new Error("Checkpoint cannot depend on itself");
    if (!service.database.prepare("SELECT 1 FROM checkpoints WHERE project_id = ? AND id = ?").get(service.paths.descriptor.id, childId)) {
      throw new Error(`checkpoint:${childId ?? ""} not found`);
    }
  }
  const rows = service.database.prepare(
    `SELECT cd.parent_checkpoint_id, cd.child_checkpoint_id FROM checkpoint_dependencies cd
     JOIN checkpoints c ON c.id = cd.parent_checkpoint_id WHERE c.project_id = ?`,
  ).all(service.paths.descriptor.id);
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
  service.database.prepare("DELETE FROM checkpoint_dependencies WHERE parent_checkpoint_id = ?").run(operation.id);
  const insert = service.database.prepare(
    "INSERT INTO checkpoint_dependencies(parent_checkpoint_id, child_checkpoint_id, position, required) VALUES (?, ?, ?, ?)",
  );
  children.forEach((child, index) => insert.run(operation.id, child.checkpointId, child.position ?? index, child.required === false ? 0 : 1));
  return finishCheckpointRelationMutation(service, checkpoint, operation, "dependencies-set", `${children.length} child checkpoint(s)`);
}

function compositionEntities(service) {
  const projectId = service.paths.descriptor.id;
  const chains = service.database.prepare("SELECT * FROM chains WHERE project_id = ?").all(projectId).map(normalizeChain);
  const blocks = service.database.prepare("SELECT * FROM blocks WHERE project_id = ?").all(projectId).map(normalizeBlock);
  const links = service.database.prepare("SELECT * FROM links WHERE project_id = ? AND archived = 0").all(projectId).map(normalizeLink);
  const chainMembers = service.database.prepare(
    "SELECT chain_id, member_type, member_id, position, role, required FROM chain_members ORDER BY chain_id, position, member_type, member_id",
  ).all().map((row) => ({
    chainId: row.chain_id, memberType: row.member_type, memberId: row.member_id,
    position: row.position, role: row.role ?? "stage", required: row.required !== 0,
  }));
  return { chains, blocks, links, chainMembers };
}

function compositionPayload(service, operation, { append = false } = {}) {
  if (!operation.id || !Number.isInteger(operation.expectedRevision)) {
    throw new Error(`${append ? "append_chain_composition" : "set_chain_composition"} requires id and expectedRevision`);
  }
  const row = service.database.prepare("SELECT * FROM chains WHERE project_id = ? AND id = ?")
    .get(service.paths.descriptor.id, operation.id);
  if (!row) throw new Error(`chain:${operation.id} not found`);
  if (row.current_revision !== operation.expectedRevision) {
    throw new Error(`Revision conflict for chain:${operation.id}; expected ${operation.expectedRevision}, current ${row.current_revision}`);
  }
  if (row.chain_type !== "composite") throw new Error(`chain:${operation.id} is a leaf Chain; set chainType to composite first`);
  const fields = operation.fields ?? {};
  const rawMembers = fields.memberRefs ?? fields.members ?? [];
  const rawLinkIds = fields.linkIds ?? [];
  const removeBlockIds = fields.removeBlockIds ?? [];
  if (!Array.isArray(rawMembers) || !Array.isArray(rawLinkIds) || !Array.isArray(removeBlockIds)) throw new Error("memberRefs/members, linkIds and removeBlockIds must be arrays");
  const existing = compositionEntities(service);
  const currentMembers = existing.chainMembers.filter((member) => member.chainId === operation.id)
    .sort((left, right) => left.position - right.position || left.memberType.localeCompare(right.memberType) || left.memberId.localeCompare(right.memberId));
  const currentEdgeIds = service.database.prepare("SELECT link_id FROM chain_edges WHERE chain_id = ? ORDER BY position").all(operation.id).map((item) => item.link_id);
  const requestedMembers = rawMembers.map((member, index) => {
    const ref = memberRef(member);
    if (!ref) throw new Error(`Invalid Composite Chain member at position ${index}`);
    return {
      memberType: ref.memberType,
      memberId: ref.memberId,
      position: index,
      role: member?.role ?? member?.memberRole ?? member?.member_role ?? "stage",
      required: member?.required !== false && member?.required !== 0,
    };
  });
  const requestedLinks = rawLinkIds.map((id) => String(id));
  const members = append ? [...currentMembers, ...requestedMembers.map((member, index) => ({ ...member, position: currentMembers.length + index }))] : requestedMembers;
  const linkIds = append ? [...currentEdgeIds, ...requestedLinks] : requestedLinks;
  if (new Set(members.map((member) => memberKey(member.memberType, member.memberId))).size !== members.length) {
    throw new Error("Composite Chain members must be unique");
  }
  if (new Set(linkIds).size !== linkIds.length) throw new Error("Composite Chain Links must be unique");
  const chainById = new Map(existing.chains.map((chain) => [chain.id, chain]));
  const blockById = new Map(existing.blocks.map((block) => [block.id, block]));
  const blocksToRemove = [...new Set(removeBlockIds.map((id) => String(id).trim()).filter(Boolean))];
  for (const blockId of blocksToRemove) {
    if (!blockById.has(blockId)) throw new Error(`Block to replace not found: ${blockId}`);
    if (members.some((member) => member.memberType === "block" && member.memberId === blockId)) {
      throw new Error(`Block to replace cannot remain a Composite Chain member: ${blockId}`);
    }
  }
  for (const member of members) {
    const entity = member.memberType === "chain" ? chainById.get(member.memberId) : blockById.get(member.memberId);
    if (!entity || entity.archived || (member.memberType === "block" && entity.deliveryState === "deprecated")) {
      throw new Error(`Composite Chain member not found or archived: ${member.memberType}:${member.memberId}`);
    }
    if (member.memberType === "chain" && member.memberId === operation.id) throw new Error("Composite Chain cannot contain itself");
  }
  const memberSet = new Set(members.map((member) => memberKey(member.memberType, member.memberId)));
  const links = linkIds.map((linkId) => {
    const link = existing.links.find((candidate) => candidate.id === linkId);
    if (!link) throw new Error(`link:${linkId} not found`);
    const sourceKey = memberKey(link.sourceType, link.sourceId);
    const targetKey = memberKey(link.targetType, link.targetId);
    if (!memberSet.has(sourceKey) || !memberSet.has(targetKey)) {
      throw new Error(`link:${linkId} endpoints must both be Composite Chain members`);
    }
    if (!["flows_to", "calls", "writes", "implements"].includes(link.kind)) {
      throw new Error(`link:${linkId} must use a route kind (flows_to, calls, writes, or implements)`);
    }
    return link;
  });
  const candidateChainMembers = [
    ...existing.chainMembers.filter((member) => member.chainId !== operation.id),
    ...members.map((member) => ({ chainId: operation.id, ...member })),
  ];
  const cycleSnapshot = { chains: existing.chains, chainMembers: candidateChainMembers };
  const cycles = inspectCompositionCycles(cycleSnapshot);
  if (cycles.length) throw new Error(`Composite Chain membership must remain acyclic: ${cycles[0].join(" -> ")}`);
  const inspected = inspectChainComposition({
    chain: { ...normalizeChain(row), chainType: "composite" },
    members,
    edges: linkIds.map((linkId, position) => ({ linkId, position })),
    chains: existing.chains,
    blocks: existing.blocks,
    links: existing.links,
  });
  const structuralIssues = inspected.topology.issues.filter((issue) => issue.hard || ["disconnected", "no_edges"].includes(issue.code));
  if (structuralIssues.length) {
    throw new Error(`Composite Chain composition invalid: ${structuralIssues.map((issue) => issue.detail).join("; ")}`);
  }
  return { row, members, linkIds, links, inspected, blocksToRemove };
}

/** Replace a Composite Chain's typed member route atomically. */
export function setChainComposition(service, operation) {
  const { row, members, linkIds, blocksToRemove } = compositionPayload(service, operation);
  service.database.prepare("DELETE FROM chain_members WHERE chain_id = ?").run(operation.id);
  service.database.prepare("DELETE FROM chain_nodes WHERE chain_id = ?").run(operation.id);
  service.database.prepare("DELETE FROM chain_edges WHERE chain_id = ?").run(operation.id);
  const insertMember = service.database.prepare(
    "INSERT INTO chain_members(chain_id, member_type, member_id, position, role, required) VALUES (?, ?, ?, ?, ?, ?)",
  );
  members.forEach((member, position) => insertMember.run(operation.id, member.memberType, member.memberId, position, member.role, Number(member.required)));
  const insertEdge = service.database.prepare("INSERT INTO chain_edges(chain_id, link_id, position) VALUES (?, ?, ?)");
  linkIds.forEach((linkId, position) => insertEdge.run(operation.id, linkId, position));
  for (const blockId of blocksToRemove) deleteBlock(service, { id: blockId }, { timestamp: now() });
  const revision = row.current_revision + 1;
  service.database.prepare("UPDATE chains SET current_revision = ?, updated_at = ? WHERE project_id = ? AND id = ?")
    .run(revision, now(), service.paths.descriptor.id, operation.id);
  return {
    entityType: "chain", id: operation.id, action: "composition-set", revision,
    summary: `${members.length} typed member(s) / ${linkIds.length} composition edge(s)${blocksToRemove.length ? ` / removed ${blocksToRemove.length} replaced Block(s)` : ""}`,
    removedBlockIds: blocksToRemove,
  };
}

/** Add typed members and composition Links without replaying the parent route. */
export function appendChainComposition(service, operation) {
  const { row, members, linkIds, blocksToRemove } = compositionPayload(service, operation, { append: true });
  const currentMemberCount = service.database.prepare("SELECT COUNT(*) AS count FROM chain_members WHERE chain_id = ?").get(operation.id).count;
  const currentEdgeCount = service.database.prepare("SELECT COUNT(*) AS count FROM chain_edges WHERE chain_id = ?").get(operation.id).count;
  const insertMember = service.database.prepare(
    "INSERT INTO chain_members(chain_id, member_type, member_id, position, role, required) VALUES (?, ?, ?, ?, ?, ?)",
  );
  members.slice(currentMemberCount).forEach((member, index) => insertMember.run(operation.id, member.memberType, member.memberId, currentMemberCount + index, member.role, Number(member.required)));
  const insertEdge = service.database.prepare("INSERT INTO chain_edges(chain_id, link_id, position) VALUES (?, ?, ?)");
  linkIds.slice(currentEdgeCount).forEach((linkId, index) => insertEdge.run(operation.id, linkId, currentEdgeCount + index));
  for (const blockId of blocksToRemove) deleteBlock(service, { id: blockId }, { timestamp: now() });
  const revision = row.current_revision + 1;
  service.database.prepare("UPDATE chains SET current_revision = ?, updated_at = ? WHERE project_id = ? AND id = ?")
    .run(revision, now(), service.paths.descriptor.id, operation.id);
  return {
    entityType: "chain", id: operation.id, action: "composition-appended", revision,
    summary: `${members.length - currentMemberCount} member(s) / ${linkIds.length - currentEdgeCount} composition edge(s) appended${blocksToRemove.length ? ` / removed ${blocksToRemove.length} replaced Block(s)` : ""}`,
    removedBlockIds: blocksToRemove,
  };
}

export function setChainPath(service, operation) {
  if (!operation.id || !Number.isInteger(operation.expectedRevision)) {
    throw new Error("set_chain_path requires id and expectedRevision");
  }
  const chain = service.database.prepare("SELECT * FROM chains WHERE project_id = ? AND id = ?")
    .get(service.paths.descriptor.id, operation.id);
  if (!chain) throw new Error(`chain:${operation.id} not found`);
  if (chain.chain_type === "composite") throw new Error(`chain:${operation.id} is composite; use set_chain_composition`);
  if (chain.current_revision !== operation.expectedRevision) {
    throw new Error(`Revision conflict for chain:${operation.id}; expected ${operation.expectedRevision}, current ${chain.current_revision}`);
  }
  const nodeIds = operation.fields?.nodeIds ?? [];
  const linkIds = operation.fields?.linkIds ?? [];
  if (!Array.isArray(nodeIds) || !Array.isArray(linkIds)) throw new Error("set_chain_path nodeIds and linkIds must be arrays");
  if (new Set(nodeIds).size !== nodeIds.length) throw new Error("Chain nodes must be unique");
  if (new Set(linkIds).size !== linkIds.length) throw new Error("Chain links must be unique");
  const nodeSet = new Set(nodeIds);
  for (const blockId of nodeIds) {
    if (!entityExists(service.database, service.paths.descriptor.id, "block", blockId)) throw new Error(`block:${blockId} not found`);
  }
  const links = linkIds.map((linkId) => {
    const link = service.database.prepare("SELECT * FROM links WHERE project_id = ? AND id = ? AND archived = 0")
      .get(service.paths.descriptor.id, linkId);
    if (!link) throw new Error(`link:${linkId} not found`);
    if (link.source_type !== "block" || link.target_type !== "block" || !nodeSet.has(link.source_id) || !nodeSet.has(link.target_id)) {
      throw new Error(`link:${linkId} endpoints must both be referenced Chain nodes`);
    }
    return link;
  });
  const topology = inspectChainTopology({
    nodes: nodeIds.map((blockId, position) => ({ blockId, position })),
    edges: links.map((link, position) => ({
      linkId: link.id, sourceId: link.source_id, targetId: link.target_id, position,
    })),
  });
  const hardIssues = topology.issues.filter((issue) => issue.hard);
  if (hardIssues.length) throw new Error(`set_chain_path topology invalid: ${topologyIssueText(operation.id, { issues: hardIssues })}`);
  if (chain.delivery_state === "complete" && nodeIds.length > 1 && !topology.connected) {
    throw new Error(`set_chain_path cannot leave complete chain disconnected: ${topologyIssueText(operation.id, topology)}`);
  }
  service.database.prepare("DELETE FROM chain_nodes WHERE chain_id = ?").run(operation.id);
  service.database.prepare("DELETE FROM chain_edges WHERE chain_id = ?").run(operation.id);
  const insertNode = service.database.prepare("INSERT INTO chain_nodes(chain_id, block_id, position, role) VALUES (?, ?, ?, 'path')");
  nodeIds.forEach((blockId, index) => {
    insertNode.run(operation.id, blockId, index);
  });
  const insertEdge = service.database.prepare("INSERT INTO chain_edges(chain_id, link_id, position) VALUES (?, ?, ?)");
  links.forEach((link, index) => insertEdge.run(operation.id, link.id, index));
  const revision = chain.current_revision + 1;
  service.database.prepare("UPDATE chains SET current_revision = ?, updated_at = ? WHERE id = ?").run(revision, now(), operation.id);
  return { entityType: "chain", id: operation.id, action: "path-set", revision, summary: `${nodeIds.length} nodes / ${linkIds.length} edges` };
}

/**
 * Extend a Chain by appending nodes and links. `set_chain_path` remains the
 * explicit replacement API for reorder/branch edits; this append operation is
 * deliberately additive so an agent can grow an existing feature path
 * without replaying (and accidentally dropping) its old nodes or edges.
 */
export function appendChainPath(service, operation) {
  if (!operation.id || !Number.isInteger(operation.expectedRevision)) {
    throw new Error("append_chain_path requires id and expectedRevision");
  }
  const chain = service.database.prepare("SELECT * FROM chains WHERE project_id = ? AND id = ?")
    .get(service.paths.descriptor.id, operation.id);
  if (!chain) throw new Error(`chain:${operation.id} not found`);
  if (chain.chain_type === "composite") throw new Error(`chain:${operation.id} is composite; use append_chain_composition`);
  if (chain.current_revision !== operation.expectedRevision) {
    throw new Error(`Revision conflict for chain:${operation.id}; expected ${operation.expectedRevision}, current ${chain.current_revision}`);
  }
  const nodeIds = operation.fields?.nodeIds ?? [];
  const linkIds = operation.fields?.linkIds ?? [];
  if (!Array.isArray(nodeIds) || !Array.isArray(linkIds)) throw new Error("nodeIds and linkIds must be arrays");
  if (nodeIds.length === 0 && linkIds.length === 0) throw new Error("append_chain_path requires a node or link");
  if (new Set(nodeIds).size !== nodeIds.length) throw new Error("Appended Chain nodes must be unique");
  if (new Set(linkIds).size !== linkIds.length) throw new Error("Appended Chain links must be unique");
  const existingNodeRows = service.database.prepare("SELECT block_id, position FROM chain_nodes WHERE chain_id = ? ORDER BY position").all(operation.id);
  const existingNodes = existingNodeRows.map((row) => row.block_id);
  const existingEdgeRows = service.database.prepare("SELECT link_id, position FROM chain_edges WHERE chain_id = ? ORDER BY position").all(operation.id);
  const existingLinks = existingEdgeRows.map((row) => row.link_id);
  const existingNodeSet = new Set(existingNodes);
  const existingLinkSet = new Set(existingLinks);
  for (const blockId of nodeIds) {
    if (existingNodeSet.has(blockId)) throw new Error(`Chain already contains block:${blockId}`);
    if (!entityExists(service.database, service.paths.descriptor.id, "block", blockId)) throw new Error(`block:${blockId} not found`);
  }
  for (const linkId of linkIds) {
    if (existingLinkSet.has(linkId)) throw new Error(`Chain already contains link:${linkId}`);
  }
  const finalNodeSet = new Set([...existingNodes, ...nodeIds]);
  const links = linkIds.map((linkId) => {
    const link = service.database.prepare("SELECT * FROM links WHERE project_id = ? AND id = ? AND archived = 0")
      .get(service.paths.descriptor.id, linkId);
    if (!link) throw new Error(`link:${linkId} not found`);
    if (link.source_type !== "block" || link.target_type !== "block" || !finalNodeSet.has(link.source_id) || !finalNodeSet.has(link.target_id)) {
      throw new Error(`link:${linkId} endpoints must be Chain nodes after append`);
    }
    return link;
  });
  const existingLinkRows = existingLinks.map((linkId, position) => {
    const link = service.database.prepare("SELECT * FROM links WHERE project_id = ? AND id = ?").get(service.paths.descriptor.id, linkId);
    return link ? { linkId: link.id, sourceId: link.source_id, targetId: link.target_id, position } : null;
  }).filter(Boolean);
  const topology = inspectChainTopology({
    nodes: [...existingNodeRows, ...nodeIds.map((blockId, index) => ({ blockId, position: existingNodes.length + index }))],
    edges: [
      ...existingLinkRows,
      ...links.map((link, index) => ({ linkId: link.id, sourceId: link.source_id, targetId: link.target_id, position: existingLinks.length + index })),
    ],
  });
  const hardIssues = topology.issues.filter((issue) => issue.hard);
  if (hardIssues.length) throw new Error(`append_chain_path topology invalid: ${topologyIssueText(operation.id, { issues: hardIssues })}`);
  if (chain.delivery_state === "complete" && topology.nodes.length > 1 && !topology.connected) {
    throw new Error(`append_chain_path cannot leave complete chain disconnected: ${topologyIssueText(operation.id, topology)}`);
  }
  const insertNode = service.database.prepare("INSERT INTO chain_nodes(chain_id, block_id, position, role) VALUES (?, ?, ?, 'path')");
  nodeIds.forEach((blockId, index) => insertNode.run(operation.id, blockId, existingNodes.length + index));
  const insertEdge = service.database.prepare("INSERT INTO chain_edges(chain_id, link_id, position) VALUES (?, ?, ?)");
  links.forEach((link, index) => insertEdge.run(operation.id, link.id, existingLinks.length + index));
  const revision = chain.current_revision + 1;
  service.database.prepare("UPDATE chains SET current_revision = ?, updated_at = ? WHERE id = ?").run(revision, now(), operation.id);
  return {
    entityType: "chain",
    id: operation.id,
    action: "path-appended",
    revision,
    summary: `${nodeIds.length} node(s) / ${linkIds.length} edge(s) appended`,
  };
}

export function setBackgroundScopes(service, operation) {
  if (!operation.id || !Number.isInteger(operation.expectedRevision)) {
    throw new Error("set_background_scopes requires block id and expectedRevision");
  }
  const block = service.database.prepare("SELECT * FROM blocks WHERE project_id = ? AND id = ?")
    .get(service.paths.descriptor.id, operation.id);
  if (!block) throw new Error(`block:${operation.id} not found`);
  if (block.current_revision !== operation.expectedRevision) {
    throw new Error(`Revision conflict for block:${operation.id}; expected ${operation.expectedRevision}, current ${block.current_revision}`);
  }
  const scopes = operation.fields?.scopes ?? [];
  const allowed = new Set(["project", "lens", "chain", "repo"]);
  service.database.prepare("DELETE FROM background_scopes WHERE block_id = ?").run(operation.id);
  const insert = service.database.prepare("INSERT INTO background_scopes(block_id, scope_type, scope_value) VALUES (?, ?, ?)");
  for (const scope of scopes) {
    assertAllowed(scope.type, allowed, "background scope type");
    insert.run(operation.id, scope.type, scope.value ?? "*");
  }
  const revision = block.current_revision + 1;
  service.database.prepare("UPDATE blocks SET current_revision = ?, updated_at = ? WHERE id = ?").run(revision, now(), operation.id);
  return { entityType: "block", id: operation.id, action: "scopes-set", revision, summary: `${scopes.length} scope(s)` };
}

export function setDecisionScopes(service, operation) {
  if (!operation.id || !Number.isInteger(operation.expectedRevision)) {
    throw new Error("set_decision_scopes requires decision id and expectedRevision");
  }
  const decision = service.database.prepare("SELECT * FROM decisions WHERE project_id = ? AND id = ?")
    .get(service.paths.descriptor.id, operation.id);
  if (!decision) throw new Error(`decision:${operation.id} not found`);
  if (decision.current_revision !== operation.expectedRevision) {
    throw new Error(`Revision conflict for decision:${operation.id}; expected ${operation.expectedRevision}, current ${decision.current_revision}`);
  }
  const scopes = operation.fields?.scopes ?? [];
  if (!Array.isArray(scopes)) throw new Error("decision scopes must be an array");
  const allowed = new Set(["project", "lens", "chain", "repo"]);
  service.database.prepare("DELETE FROM decision_scopes WHERE decision_id = ?").run(operation.id);
  const insert = service.database.prepare("INSERT INTO decision_scopes(decision_id, scope_type, scope_value) VALUES (?, ?, ?)");
  for (const scope of scopes) {
    assertAllowed(scope.type, allowed, "decision scope type");
    if (scope.value != null && (typeof scope.value !== "string" || !scope.value.trim())) {
      throw new Error("decision scope value must be a non-empty string");
    }
    if (scope.type === "chain" && scope.value !== "*" && !entityExists(service.database, service.paths.descriptor.id, "chain", scope.value)) {
      throw new Error(`chain:${scope.value} not found for decision scope`);
    }
    insert.run(operation.id, scope.type, scope.value?.trim() || "*");
  }
  const revision = decision.current_revision + 1;
  service.database.prepare("UPDATE decisions SET current_revision = ?, updated_at = ? WHERE project_id = ? AND id = ?")
    .run(revision, now(), service.paths.descriptor.id, operation.id);
  return { entityType: "decision", id: operation.id, action: "scopes-set", revision, summary: `${scopes.length} scope(s)` };
}

export function createDecision(service, operation, { timestamp }) {
  const fields = operation.fields ?? {};
  if (!fields.title?.trim()) throw new Error("create_decision requires fields.title");
  if (fields.localizations != null) {
    throw new Error("create_decision does not accept localizations; keep one canonical decision body");
  }
  assertAllowed(fields.status ?? "active", DECISION_STATUSES, "decision status");
  if (fields.alternatives != null && !Array.isArray(fields.alternatives)) throw new Error("decision alternatives must be an array");
  if (fields.consequences != null && !Array.isArray(fields.consequences)) throw new Error("decision consequences must be an array");
  if (fields.supersedesDecisionId && !entityExists(service.database, service.paths.descriptor.id, "decision", fields.supersedesDecisionId)) {
    throw new Error(`decision:${fields.supersedesDecisionId} not found`);
  }
  const id = operation.id ?? identifier("decision");
  service.database.prepare(
    `INSERT INTO decisions(
      id, project_id, title, summary, rationale, alternatives_json, consequences_json,
      status, supersedes_decision_id, archived, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, service.paths.descriptor.id, fields.title.trim(), fields.summary ?? "", fields.rationale ?? "",
    JSON.stringify(fields.alternatives ?? []), JSON.stringify(fields.consequences ?? []), fields.status ?? "active",
    fields.supersedesDecisionId ?? null, Number(Boolean(fields.archived)), timestamp, timestamp,
  );
  const scopes = fields.scopes;
  if (scopes != null) {
    if (!Array.isArray(scopes)) throw new Error("decision scopes must be an array");
    const allowed = new Set(["project", "lens", "chain", "repo"]);
    const insert = service.database.prepare("INSERT INTO decision_scopes(decision_id, scope_type, scope_value) VALUES (?, ?, ?)");
    for (const scope of scopes) {
      assertAllowed(scope.type, allowed, "decision scope type");
      const value = scope.value?.trim() || "*";
      if (scope.type === "chain" && value !== "*" && !entityExists(service.database, service.paths.descriptor.id, "chain", value)) {
        throw new Error(`chain:${value} not found for decision scope`);
      }
      insert.run(id, scope.type, value);
    }
  }
  return { entityType: "decision", id, action: "created", revision: 1, summary: fields.title.trim() };
}

export function createBlock(service, operation, { timestamp }) {
  const fields = operation.fields ?? {};
  if (fields.kind === "decision") {
    throw new Error("Decision records are not Canvas Blocks; use create_decision with project/lens/chain/repo scopes");
  }
  assertAllowed(fields.kind, LEGACY_BLOCK_KINDS, "block kind");
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
  service.database
    .prepare(
      `INSERT INTO blocks(
        id, project_id, kind, title, summary, body, contract, scope, architecture_layer,
        local_order, delivery_state, health_state, priority, confidence, tags_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      service.paths.descriptor.id,
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
  applyLocalizations(service, "block", id, fields.localizations, timestamp);
  return { entityType: "block", id, action: "created", revision: 1, summary: fields.title.trim() };
}

export function createChain(service, operation, { timestamp }) {
  const fields = operation.fields ?? {};
  assertAllowed(fields.chainType ?? "leaf", new Set(["leaf", "composite"]), "chain type");
  assertAllowed(fields.deliveryState ?? "planned", DELIVERY_STATES, "delivery state");
  assertAllowed(fields.healthState ?? "unknown", HEALTH_STATES, "health state");
  if (!fields.title?.trim()) throw new Error("create_chain requires fields.title");
  const id = operation.id ?? identifier("chain");
  service.database
    .prepare(
      `INSERT INTO chains(
        id, project_id, title, chain_type, purpose, intent, input_contract, output_contract,
        delivery_state, health_state, priority, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      service.paths.descriptor.id,
      fields.title.trim(),
      fields.chainType ?? "leaf",
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
  applyLocalizations(service, "chain", id, fields.localizations, timestamp);
  return { entityType: "chain", id, action: "created", revision: 1, summary: fields.title.trim() };
}

export function createLink(service, operation, { timestamp }) {
  const fields = operation.fields ?? {};
  if (fields.sourceType === "decision" || fields.targetType === "decision") {
    throw new Error("Decisions are scoped project memory, not Link endpoints; use decision scopes or a source reference");
  }
  assertAllowed(fields.kind, LINK_KINDS, "link kind");
  assertAllowed(fields.healthState ?? "unknown", HEALTH_STATES, "health state");
  if (!entityExists(service.database, service.paths.descriptor.id, fields.sourceType, fields.sourceId)) {
    throw new Error(`Missing link source ${fields.sourceType}:${fields.sourceId}`);
  }
  if (!entityExists(service.database, service.paths.descriptor.id, fields.targetType, fields.targetId)) {
    throw new Error(`Missing link target ${fields.targetType}:${fields.targetId}`);
  }
  const id = operation.id ?? identifier("link");
  service.database
    .prepare(
      `INSERT INTO links(
        id, project_id, source_type, source_id, target_type, target_id, kind, label,
        contract, health_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      service.paths.descriptor.id,
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
  applyLocalizations(service, "link", id, fields.localizations, timestamp);
  return { entityType: "link", id, action: "created", revision: 1, summary: fields.label || fields.kind };
}

export function createCheckpoint(service, operation, { timestamp }) {
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
  if (!entityExists(service.database, service.paths.descriptor.id, fields.targetType, fields.targetId)) {
    throw new Error(`${fields.targetType}:${fields.targetId} not found`);
  }
  const id = operation.id ?? identifier("checkpoint");
  const existing = service.database.prepare("SELECT 1 FROM checkpoints WHERE project_id = ? AND id = ?")
    .get(service.paths.descriptor.id, id);
  if (existing) throw new Error(`checkpoint:${id} already exists; use checkpoint_record to update it`);
  const coverage = fields.coverage ?? "complete";
  const criteria = fields.criteria ?? "";
  const invalidatedAt = fields.invalidatedAt ?? null;
  service.database
    .prepare(
      `INSERT INTO checkpoints(
        id, project_id, target_type, target_id, title, criteria, status, checkpoint_kind,
        aggregation_policy_json, eligible_after_children, evidence_level,
        required_evidence_level, coverage, evidence_json, invalidated_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      service.paths.descriptor.id,
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
    service.database
      .prepare(`UPDATE ${targetTable} SET health_state = ?, updated_at = ? WHERE id = ?`)
      .run(healthState, timestamp, fields.targetId);
  }

  if (status === "passed") {
    // 1. Advance bound plan_changes to complete
    const bindings = service.database
      .prepare("SELECT * FROM checkpoint_bindings WHERE checkpoint_id = ?")
      .all(id);
    for (const binding of bindings) {
      if (binding.subject_type === "plan_change") {
        service.database
          .prepare("UPDATE plan_changes SET status = 'complete', updated_at = ? WHERE id = ?")
          .run(timestamp, binding.subject_id);
      }
    }

    // 2. If bound to a block and block is implementing/verifying, update delivery_state to complete
    if (fields.targetType === "block") {
      service.database
        .prepare("UPDATE blocks SET delivery_state = 'complete', updated_at = ? WHERE id = ? AND delivery_state IN ('implementing', 'verifying')")
        .run(timestamp, fields.targetId);
    }

    // 3. If referenced by a plan_step in plan_checkpoint_refs, check if all required checkpoints for that step have passed
    const stepRefs = service.database
      .prepare("SELECT plan_id, step_id FROM plan_checkpoint_refs WHERE checkpoint_id = ? AND step_id IS NOT NULL")
      .all(id);
    for (const ref of stepRefs) {
      const requiredChecks = service.database
        .prepare(`SELECT c.status FROM plan_checkpoint_refs r
                  JOIN checkpoints c ON c.id = r.checkpoint_id
                  WHERE r.plan_id = ? AND r.step_id = ? AND r.required = 1`)
        .all(ref.plan_id, ref.step_id);
      const allPassed = requiredChecks.every((c) => c.status === "passed");
      if (allPassed && requiredChecks.length > 0) {
        service.database
          .prepare("UPDATE plan_steps SET status = 'complete', updated_at = ? WHERE plan_id = ? AND id = ?")
          .run(timestamp, ref.plan_id, ref.step_id);
      }
    }
  }

  return { entityType: "checkpoint", id, action: existing ? "updated" : "created", revision: 1, summary: fields.title.trim() };
}

export function deleteBlock(service, operation, { timestamp }) {
  const id = operation.id;
  if (!id) throw new Error("block id is required for delete_block");
  const block = service.database.prepare(
    "SELECT * FROM blocks WHERE project_id = ? AND id = ?",
  ).get(service.paths.descriptor.id, id);
  if (!block) throw new Error(`block:${id} not found`);
  if (Number.isInteger(operation.expectedRevision) && block.current_revision !== operation.expectedRevision) {
    throw new Error(`Conflict for block:${id}; expected revision ${operation.expectedRevision}, current ${block.current_revision}`);
  }

  // 1. Clean up links referencing this block (both incoming and outgoing)
  const connectedLinks = service.database.prepare(
    "SELECT id FROM links WHERE project_id = ? AND ((source_type = 'block' AND source_id = ?) OR (target_type = 'block' AND target_id = ?))",
  ).all(service.paths.descriptor.id, id, id);
  for (const link of connectedLinks) {
    service.database.prepare("DELETE FROM chain_edges WHERE link_id = ?").run(link.id);
    service.database.prepare("DELETE FROM localized_text WHERE entity_type = 'link' AND entity_id = ?").run(link.id);
    service.database.prepare("DELETE FROM checkpoint_bindings WHERE subject_type = 'link' AND subject_id = ?").run(link.id);
    service.database.prepare("DELETE FROM plan_changes WHERE entity_type = 'link' AND entity_id = ?").run(link.id);
    const linkCheckpoints = service.database.prepare(
      "SELECT id FROM checkpoints WHERE target_type = 'link' AND target_id = ?",
    ).all(link.id);
    for (const cp of linkCheckpoints) {
      service.database.prepare("DELETE FROM checkpoint_bindings WHERE checkpoint_id = ?").run(cp.id);
      service.database.prepare("DELETE FROM checkpoint_dependencies WHERE parent_checkpoint_id = ? OR child_checkpoint_id = ?").run(cp.id, cp.id);
      service.database.prepare("DELETE FROM plan_checkpoint_refs WHERE checkpoint_id = ?").run(cp.id);
      service.database.prepare("DELETE FROM checkpoints WHERE id = ?").run(cp.id);
    }
  }
  service.database.prepare("DELETE FROM links WHERE project_id = ? AND ((source_type = 'block' AND source_id = ?) OR (target_type = 'block' AND target_id = ?))").run(service.paths.descriptor.id, id, id);

  // 2. Clean up block-level associations
  service.database.prepare("DELETE FROM source_refs WHERE block_id = ?").run(id);
  service.database.prepare("DELETE FROM background_scopes WHERE block_id = ?").run(id);
  service.database.prepare("DELETE FROM chain_nodes WHERE block_id = ?").run(id);
  service.database.prepare("DELETE FROM chain_members WHERE member_type = 'block' AND member_id = ?").run(id);
  service.database.prepare("DELETE FROM localized_text WHERE entity_type = 'block' AND entity_id = ?").run(id);
  service.database.prepare("DELETE FROM checkpoint_bindings WHERE subject_type = 'block' AND subject_id = ?").run(id);
  service.database.prepare("DELETE FROM plan_changes WHERE entity_type = 'block' AND entity_id = ?").run(id);
  service.database.prepare("UPDATE plan_chain_scopes SET start_block_id = NULL WHERE start_block_id = ?").run(id);
  service.database.prepare("UPDATE plan_chain_scopes SET end_block_id = NULL WHERE end_block_id = ?").run(id);

  // 3. Clean up checkpoints targeting this block
  const blockCheckpoints = service.database.prepare(
    "SELECT id FROM checkpoints WHERE target_type = 'block' AND target_id = ?",
  ).all(id);
  for (const cp of blockCheckpoints) {
    service.database.prepare("DELETE FROM checkpoint_bindings WHERE checkpoint_id = ?").run(cp.id);
    service.database.prepare("DELETE FROM checkpoint_dependencies WHERE parent_checkpoint_id = ? OR child_checkpoint_id = ?").run(cp.id, cp.id);
    service.database.prepare("DELETE FROM plan_checkpoint_refs WHERE checkpoint_id = ?").run(cp.id);
    service.database.prepare("DELETE FROM checkpoints WHERE id = ?").run(cp.id);
  }

  // 4. Delete the block itself
  service.database.prepare("DELETE FROM blocks WHERE project_id = ? AND id = ?").run(service.paths.descriptor.id, id);

  return {
    entityType: "block",
    id,
    action: "deleted",
    revision: block.current_revision + 1,
    summary: `Deleted block ${id}`,
  };
}

export function deleteChain(service, operation, { timestamp }) {
  const id = operation.id;
  if (!id) throw new Error("chain id is required for delete_chain");
  const chain = service.database.prepare(
    "SELECT * FROM chains WHERE project_id = ? AND id = ?",
  ).get(service.paths.descriptor.id, id);
  if (!chain) throw new Error(`chain:${id} not found`);
  if (Number.isInteger(operation.expectedRevision) && chain.current_revision !== operation.expectedRevision) {
    throw new Error(`Conflict for chain:${id}; expected revision ${operation.expectedRevision}, current ${chain.current_revision}`);
  }

  // 1. Clean up connected links
  const connectedLinks = service.database.prepare(
    "SELECT id FROM links WHERE project_id = ? AND ((source_type = 'chain' AND source_id = ?) OR (target_type = 'chain' AND target_id = ?))",
  ).all(service.paths.descriptor.id, id, id);
  for (const link of connectedLinks) {
    service.database.prepare("DELETE FROM chain_edges WHERE link_id = ?").run(link.id);
    service.database.prepare("DELETE FROM localized_text WHERE entity_type = 'link' AND entity_id = ?").run(link.id);
    service.database.prepare("DELETE FROM checkpoint_bindings WHERE subject_type = 'link' AND subject_id = ?").run(link.id);
    service.database.prepare("DELETE FROM plan_changes WHERE entity_type = 'link' AND entity_id = ?").run(link.id);
    const linkCheckpoints = service.database.prepare(
      "SELECT id FROM checkpoints WHERE target_type = 'link' AND target_id = ?",
    ).all(link.id);
    for (const cp of linkCheckpoints) {
      service.database.prepare("DELETE FROM checkpoint_bindings WHERE checkpoint_id = ?").run(cp.id);
      service.database.prepare("DELETE FROM checkpoint_dependencies WHERE parent_checkpoint_id = ? OR child_checkpoint_id = ?").run(cp.id, cp.id);
      service.database.prepare("DELETE FROM plan_checkpoint_refs WHERE checkpoint_id = ?").run(cp.id);
      service.database.prepare("DELETE FROM checkpoints WHERE id = ?").run(cp.id);
    }
  }
  service.database.prepare("DELETE FROM links WHERE project_id = ? AND ((source_type = 'chain' AND source_id = ?) OR (target_type = 'chain' AND target_id = ?))").run(service.paths.descriptor.id, id, id);

  // 2. Clean up chain topology
  service.database.prepare("DELETE FROM chain_nodes WHERE chain_id = ?").run(id);
  service.database.prepare("DELETE FROM chain_edges WHERE chain_id = ?").run(id);
  service.database.prepare("DELETE FROM chain_members WHERE chain_id = ?").run(id);
  service.database.prepare("DELETE FROM chain_members WHERE member_type = 'chain' AND member_id = ?").run(id);
  service.database.prepare("DELETE FROM localized_text WHERE entity_type = 'chain' AND entity_id = ?").run(id);
  service.database.prepare("DELETE FROM plan_chain_refs WHERE chain_id = ?").run(id);

  // 2. Clean up plan scopes for this chain
  const scopes = service.database.prepare("SELECT id FROM plan_chain_scopes WHERE chain_id = ?").all(id);
  for (const scope of scopes) {
    service.database.prepare("DELETE FROM plan_chain_change_refs WHERE chain_scope_id = ?").run(scope.id);
    service.database.prepare("DELETE FROM checkpoint_bindings WHERE subject_type = 'plan_chain_scope' AND subject_id = ?").run(scope.id);
  }
  service.database.prepare("DELETE FROM plan_chain_scopes WHERE chain_id = ?").run(id);

  // 3. Clean up checkpoints targeting this chain
  const chainCheckpoints = service.database.prepare(
    "SELECT id FROM checkpoints WHERE target_type = 'chain' AND target_id = ?",
  ).all(id);
  for (const cp of chainCheckpoints) {
    service.database.prepare("DELETE FROM checkpoint_bindings WHERE checkpoint_id = ?").run(cp.id);
    service.database.prepare("DELETE FROM checkpoint_dependencies WHERE parent_checkpoint_id = ? OR child_checkpoint_id = ?").run(cp.id, cp.id);
    service.database.prepare("DELETE FROM plan_checkpoint_refs WHERE checkpoint_id = ?").run(cp.id);
    service.database.prepare("DELETE FROM checkpoints WHERE id = ?").run(cp.id);
  }
  service.database.prepare("DELETE FROM checkpoint_bindings WHERE subject_type = 'chain' AND subject_id = ?").run(id);
  service.database.prepare("DELETE FROM plan_changes WHERE entity_type = 'chain' AND entity_id = ?").run(id);

  // 4. Delete the chain itself
  service.database.prepare("DELETE FROM chains WHERE project_id = ? AND id = ?").run(service.paths.descriptor.id, id);

  return {
    entityType: "chain",
    id,
    action: "deleted",
    revision: chain.current_revision + 1,
    summary: `Deleted chain ${id}`,
  };
}

export function deleteLink(service, operation, { timestamp }) {
  const id = operation.id;
  if (!id) throw new Error("link id is required for delete_link");
  const link = service.database.prepare(
    "SELECT * FROM links WHERE project_id = ? AND id = ?",
  ).get(service.paths.descriptor.id, id);
  if (!link) throw new Error(`link:${id} not found`);
  if (Number.isInteger(operation.expectedRevision) && link.current_revision !== operation.expectedRevision) {
    throw new Error(`Conflict for link:${id}; expected revision ${operation.expectedRevision}, current ${link.current_revision}`);
  }

  // 1. Clean up chain_edges, localized_text, bindings, plan_changes
  service.database.prepare("DELETE FROM chain_edges WHERE link_id = ?").run(id);
  service.database.prepare("DELETE FROM localized_text WHERE entity_type = 'link' AND entity_id = ?").run(id);
  service.database.prepare("DELETE FROM checkpoint_bindings WHERE subject_type = 'link' AND subject_id = ?").run(id);
  service.database.prepare("DELETE FROM plan_changes WHERE entity_type = 'link' AND entity_id = ?").run(id);

  // 2. Clean up checkpoints targeting this link
  const linkCheckpoints = service.database.prepare(
    "SELECT id FROM checkpoints WHERE target_type = 'link' AND target_id = ?",
  ).all(id);
  for (const cp of linkCheckpoints) {
    service.database.prepare("DELETE FROM checkpoint_bindings WHERE checkpoint_id = ?").run(cp.id);
    service.database.prepare("DELETE FROM checkpoint_dependencies WHERE parent_checkpoint_id = ? OR child_checkpoint_id = ?").run(cp.id, cp.id);
    service.database.prepare("DELETE FROM plan_checkpoint_refs WHERE checkpoint_id = ?").run(cp.id);
    service.database.prepare("DELETE FROM checkpoints WHERE id = ?").run(cp.id);
  }

  // 3. Delete the link itself
  service.database.prepare("DELETE FROM links WHERE project_id = ? AND id = ?").run(service.paths.descriptor.id, id);

  return {
    entityType: "link",
    id,
    action: "deleted",
    revision: link.current_revision + 1,
    summary: `Deleted link ${id}`,
  };
}

export function deleteDecision(service, operation, { timestamp }) {
  const id = operation.id;
  if (!id) throw new Error("decision id is required for delete_decision");
  const decision = service.database.prepare(
    "SELECT * FROM decisions WHERE project_id = ? AND id = ?",
  ).get(service.paths.descriptor.id, id);
  if (!decision) throw new Error(`decision:${id} not found`);
  if (Number.isInteger(operation.expectedRevision) && decision.current_revision !== operation.expectedRevision) {
    throw new Error(`Conflict for decision:${id}; expected revision ${operation.expectedRevision}, current ${decision.current_revision}`);
  }

  // 1. Clean up decision scopes & references
  service.database.prepare("DELETE FROM decision_scopes WHERE decision_id = ?").run(id);
  service.database.prepare("UPDATE decisions SET supersedes_decision_id = NULL WHERE supersedes_decision_id = ?").run(id);

  // 2. Clean up checkpoints targeting this decision
  const decisionCheckpoints = service.database.prepare(
    "SELECT id FROM checkpoints WHERE target_type = 'decision' AND target_id = ?",
  ).all(id);
  for (const cp of decisionCheckpoints) {
    service.database.prepare("DELETE FROM checkpoint_bindings WHERE checkpoint_id = ?").run(cp.id);
    service.database.prepare("DELETE FROM checkpoint_dependencies WHERE parent_checkpoint_id = ? OR child_checkpoint_id = ?").run(cp.id, cp.id);
    service.database.prepare("DELETE FROM plan_checkpoint_refs WHERE checkpoint_id = ?").run(cp.id);
    service.database.prepare("DELETE FROM checkpoints WHERE id = ?").run(cp.id);
  }
  service.database.prepare("DELETE FROM checkpoint_bindings WHERE subject_type = 'decision' AND subject_id = ?").run(id);

  // 3. Delete the decision itself
  service.database.prepare("DELETE FROM decisions WHERE project_id = ? AND id = ?").run(service.paths.descriptor.id, id);

  return {
    entityType: "decision",
    id,
    action: "deleted",
    revision: decision.current_revision + 1,
    summary: `Deleted decision ${id}`,
  };
}

export function deleteCheckpoint(service, operation, { timestamp }) {
  const id = operation.id;
  if (!id) throw new Error("checkpoint id is required for delete_checkpoint");
  const checkpoint = service.database.prepare(
    "SELECT * FROM checkpoints WHERE project_id = ? AND id = ?",
  ).get(service.paths.descriptor.id, id);
  if (!checkpoint) throw new Error(`checkpoint:${id} not found`);
  if (Number.isInteger(operation.expectedRevision) && checkpoint.current_revision !== operation.expectedRevision) {
    throw new Error(`Conflict for checkpoint:${id}; expected revision ${operation.expectedRevision}, current ${checkpoint.current_revision}`);
  }
  service.database.prepare("DELETE FROM checkpoint_bindings WHERE checkpoint_id = ?").run(id);
  service.database.prepare("DELETE FROM checkpoint_dependencies WHERE parent_checkpoint_id = ? OR child_checkpoint_id = ?").run(id, id);
  service.database.prepare("DELETE FROM plan_checkpoint_refs WHERE checkpoint_id = ?").run(id);
  service.database.prepare("DELETE FROM checkpoints WHERE id = ?").run(id);
  return {
    entityType: "checkpoint",
    id,
    action: "deleted",
    revision: checkpoint.current_revision + 1,
    summary: `Deleted checkpoint ${id}`,
  };
}

export function deletePlan(service, operation, { timestamp }) {
  const id = operation.id;
  if (!id) throw new Error("plan id is required for delete_plan");
  const plan = service.database.prepare(
    "SELECT * FROM plans WHERE project_id = ? AND id = ?",
  ).get(service.paths.descriptor.id, id);
  if (!plan) throw new Error(`plan:${id} not found`);
  if (Number.isInteger(operation.expectedRevision) && plan.current_revision !== operation.expectedRevision) {
    throw new Error(`Conflict for plan:${id}; expected revision ${operation.expectedRevision}, current ${plan.current_revision}`);
  }
  service.database.prepare("DELETE FROM plan_chain_refs WHERE plan_id = ?").run(id);
  service.database.prepare("DELETE FROM plan_dependencies WHERE plan_id = ? OR depends_on_plan_id = ?").run(id, id);
  service.database.prepare("DELETE FROM plan_steps WHERE plan_id = ?").run(id);
  service.database.prepare("DELETE FROM plan_checkpoint_refs WHERE plan_id = ?").run(id);
  service.database.prepare("DELETE FROM plan_chain_change_refs WHERE chain_scope_id IN (SELECT id FROM plan_chain_scopes WHERE plan_id = ?)").run(id);
  service.database.prepare("DELETE FROM checkpoint_bindings WHERE subject_type = 'plan_chain_scope' AND subject_id IN (SELECT id FROM plan_chain_scopes WHERE plan_id = ?)").run(id);
  service.database.prepare("DELETE FROM checkpoint_bindings WHERE subject_type = 'plan_change' AND subject_id IN (SELECT id FROM plan_changes WHERE plan_id = ?)").run(id);
  service.database.prepare("DELETE FROM checkpoint_bindings WHERE subject_type = 'plan' AND subject_id = ?").run(id);
  service.database.prepare("DELETE FROM plan_chain_scopes WHERE plan_id = ?").run(id);
  service.database.prepare("DELETE FROM plan_changes WHERE plan_id = ?").run(id);
  service.database.prepare("DELETE FROM localized_text WHERE entity_type = 'plan' AND entity_id = ?").run(id);
  service.database.prepare("DELETE FROM checkpoints WHERE target_type = 'plan' AND target_id = ?").run(id);
  service.database.prepare("DELETE FROM plans WHERE project_id = ? AND id = ?").run(service.paths.descriptor.id, id);
  return {
    entityType: "plan",
    id,
    action: "deleted",
    revision: plan.current_revision + 1,
    summary: `Deleted plan ${id}`,
  };
}

export function updateEntity(service, type, operation, { timestamp }) {
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
  const existing = service.database
    .prepare(`SELECT * FROM ${config.table} WHERE project_id = ? AND id = ?`)
    .get(service.paths.descriptor.id, operation.id);
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
      assertAllowed(rawValue, LEGACY_BLOCK_KINDS, "block kind");
    }
    if (field === "kind" && type === "link") assertAllowed(rawValue, LINK_KINDS, "link kind");
    if (field === "chainType") {
      assertAllowed(rawValue, new Set(["leaf", "composite"]), "chain type");
      if (type !== "chain") throw new Error("chainType is editable only on Chain");
      const memberCount = service.database.prepare("SELECT COUNT(*) AS count FROM chain_members WHERE chain_id = ?").get(operation.id).count;
      const nodeCount = service.database.prepare("SELECT COUNT(*) AS count FROM chain_nodes WHERE chain_id = ?").get(operation.id).count;
      if (rawValue === "leaf" && memberCount > 0) throw new Error(`chain:${operation.id} still has Composite members; clear composition first`);
      if (rawValue === "composite" && nodeCount > 0 && memberCount === 0) {
        // Conversion is allowed so the next atomic composition operation can
        // replace the old leaf path without a transient empty parent in the UI.
      }
    }
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
        !entityExists(service.database, service.paths.descriptor.id, "decision", rawValue)) {
      throw new Error(`decision:${rawValue} not found`);
    }
    const column = field === "tags" ? "tags_json" : field === "proposedDelta" ? "proposed_delta_json"
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
  values.push(revision, timestamp, service.paths.descriptor.id, operation.id);
  service.database
    .prepare(`UPDATE ${config.table} SET ${updates.join(", ")} WHERE project_id = ? AND id = ?`)
    .run(...values);
  if (type === "decision" && decisionScopes != null) {
    if (!Array.isArray(decisionScopes)) throw new Error("decision scopes must be an array");
    const allowed = new Set(["project", "lens", "chain", "repo"]);
    service.database.prepare("DELETE FROM decision_scopes WHERE decision_id = ?").run(operation.id);
    const insert = service.database.prepare("INSERT INTO decision_scopes(decision_id, scope_type, scope_value) VALUES (?, ?, ?)");
    for (const scope of decisionScopes) {
      assertAllowed(scope.type, allowed, "decision scope type");
      const value = scope.value?.trim() || "*";
      if (scope.type === "chain" && value !== "*" && !entityExists(service.database, service.paths.descriptor.id, "chain", value)) {
        throw new Error(`chain:${value} not found for decision scope`);
      }
      insert.run(operation.id, scope.type, value);
    }
  }
  removeStaleLocalizations(service, type, operation.id, Object.keys(fields), localizations);
  applyLocalizations(service, type, operation.id, localizations, timestamp);
  const normalized = config.normalizer(
    service.database
      .prepare(`SELECT * FROM ${config.table} WHERE project_id = ? AND id = ?`)
      .get(service.paths.descriptor.id, operation.id),
  );
  return {
    entityType: type,
    id: operation.id,
    action: "updated",
    revision,
    summary: operation.summary ?? normalized.title ?? normalized.label ?? Object.keys(fields).join(", "),
  };
}

export function addSourceRef(service, operation, { timestamp }) {
  const fields = operation.fields ?? {};
  if (!operation.id) throw new Error("add_source_ref requires id of the target block");
  if (!entityExists(service.database, service.paths.descriptor.id, "block", operation.id)) {
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

  if ((!startLine || !endLine) && service.paths?.projectRoot) {
    const fullPath = path.isAbsolute(resolvedPath)
      ? resolvedPath
      : path.resolve(service.paths.projectRoot, resolvedPath);
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

  service.database
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
  const block = service.database.prepare("SELECT current_revision FROM blocks WHERE id = ?").get(operation.id);
  return {
    entityType: "block",
    id: operation.id,
    action: "source-linked",
    revision: block.current_revision,
    summary: `${fields.role ?? "implementation"}: ${fields.path}`,
    sourceId,
  };
}

export function removeSourceRef(service, operation) {
  const sourceId = operation.fields?.sourceId;
  if (!operation.id || !sourceId) {
    throw new Error("remove_source_ref requires the target block id and fields.sourceId");
  }
  const source = service.database
    .prepare("SELECT * FROM source_refs WHERE id = ? AND block_id = ?")
    .get(sourceId, operation.id);
  if (!source) throw new Error(`source:${sourceId} is not attached to block:${operation.id}`);
  service.database.prepare("DELETE FROM source_refs WHERE id = ?").run(sourceId);
  const block = service.database.prepare("SELECT current_revision FROM blocks WHERE id = ?").get(operation.id);
  return {
    entityType: "block",
    id: operation.id,
    action: "source-removed",
    revision: block.current_revision,
    summary: `${source.role}: ${source.path}`,
    sourceId,
  };
}

export function executeGraphPatch(service, {
  patch, actor = "agent", reason, task = "compact-patch", gitHead = null,
  planId = null, chainScopeId = null,
} = {}) {
  const parsed = parseGraphPatch(patch);
  const metadata = parsed.metadata ?? {};
  const allowedMetadata = new Set(["base", "plan", "chainScope", "actor", "reason", "task"]);
  for (const key of Object.keys(metadata)) {
    if (!allowedMetadata.has(key)) throw new Error(`Unsupported compact patch header field: ${key}`);
  }
  const before = service.snapshot();
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
    plan_step: before.planSteps,
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
    const raw = existing ? service.database.prepare("SELECT status FROM checkpoints WHERE project_id = ? AND id = ?")
      .get(service.paths.descriptor.id, existing.id) : null;
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
    if (item.action === "flow") {
      const extraBlocks = operations
        .filter((op) => op.action === "create_block")
        .map((op) => ({ id: op.id, title: op.fields?.title || op.id, kind: op.fields?.kind || "service" }));
      const flowExpansion = expandArrowFlowOperations(before, item.flow, extraBlocks);
      operations.push(...flowExpansion.operations);
      continue;
    }
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
    if (targetType === "plan_step") {
      if (item.action !== "update") throw new Error("plan_step supports update only");
      const step = requireEntity("plan_step", targetId);
      const plan = resolvedPlanId ? requireEntity("plan", resolvedPlanId) : requireEntity("plan", step.planId);
      operations.push({
        action: "update_plan_step",
        id: plan.id,
        expectedRevision: item.expectedRevision ?? plan.currentRevision,
        fields: { stepId: targetId, patch: fields },
      });
      continue;
    }
    if (item.action === "delete") {
      if (["block", "chain", "link", "plan", "decision", "checkpoint"].includes(targetType)) {
        const entity = requireEntity(targetType, targetId);
        operations.push({
          action: `delete_${targetType}`,
          id: targetId,
          expectedRevision: item.expectedRevision ?? entity.currentRevision,
        });
        continue;
      }
      throw new Error(`Unsupported compact patch delete target: ${targetType}:${targetId}`);
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
  const mutation = executeMutate(
    service,
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
  const after = service.snapshot();
  const coverage = architectureCoverage(after);
  const validation = service.validate();
  const markdown = [
    "# Graph patch",
    "- Protocol: contextos/1",
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
    `- Chains: ${coverage.inChains} with member Blocks · ${coverage.failingIds.length} failing`,
    ...(coverage.requiredCheckpointMissingIds.length
      ? [`- Required verification missing: ${coverage.requiredCheckpointMissingIds.slice(0, 12).map((id) => `block:${id}`).join(", ")}`]
      : []),
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

export function executeRevertChangeSet(service, {
  changeSetId, actor = "agent", reason, task = "", gitHead = null, planId = null, chainScopeId = null,
} = {}) {
  if (!changeSetId?.trim()) throw new Error("changeSetId is required");
  service.ensureSynced();
  const changeSet = service.database.prepare(
    "SELECT * FROM change_sets WHERE project_id = ? AND id = ?",
  ).get(service.paths.descriptor.id, changeSetId);
  if (!changeSet) throw new Error(`change_set:${changeSetId} not found`);
  const historyRows = service.database.prepare(
    "SELECT * FROM history WHERE change_set_id = ? ORDER BY id DESC",
  ).all(changeSetId);
  if (historyRows.length === 0) throw new Error(`change_set:${changeSetId} has no reversible history`);

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
  for (const item of historyRows) {
    if (item.action === "created") {
      if (["block", "chain", "link", "plan", "decision"].includes(item.entity_type)) {
        const tableName = item.entity_type === "block" ? "blocks"
          : item.entity_type === "chain" ? "chains"
            : item.entity_type === "link" ? "links"
              : item.entity_type === "decision" ? "decisions" : "plans";
        const key = `${item.entity_type}:${item.entity_id}`;
        const revision = expectedRevisions.get(key) ?? service.database.prepare(
          `SELECT current_revision FROM ${tableName} WHERE project_id = ? AND id = ?`,
        ).get(service.paths.descriptor.id, item.entity_id)?.current_revision;
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
      const current = simulatedStates.get(stateKey) ?? historyState(service, item.entity_type, item.entity_id);
      for (const field of fields) {
        if (JSON.stringify(current?.[field] ?? null) !== JSON.stringify(after?.[field] ?? null)) {
          throw new Error(`change_set:${changeSetId} is stale for ${item.entity_type}:${item.entity_id}; refusing to overwrite newer work`);
        }
      }
      const key = `${item.entity_type}:${item.entity_id}`;
      const revision = expectedRevisions.get(key) ?? service.database.prepare(
        `SELECT current_revision FROM ${item.entity_type === "block" ? "blocks" : item.entity_type === "chain" ? "chains" : item.entity_type === "link" ? "links" : "plans"} WHERE project_id = ? AND id = ?`,
      ).get(service.paths.descriptor.id, item.entity_id)?.current_revision;
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
      const current = simulatedStates.get(stateKey) ?? historyStateForOperation(service, target.operation, "plan", target.planId);
      for (const field of fields) {
        if (JSON.stringify(current?.[field] ?? null) !== JSON.stringify(after?.[field] ?? null)) {
          throw new Error(`change_set:${changeSetId} is stale for ${item.action}; refusing to overwrite newer work`);
        }
      }
      const key = `plan:${target.planId}`;
      const revision = expectedRevisions.get(key) ?? service.database.prepare("SELECT current_revision FROM plans WHERE project_id = ? AND id = ?")
        .get(service.paths.descriptor.id, target.planId)?.current_revision;
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
  const resolvedContext = service.resolveHistoryContext(planId, chainScopeId);
  return executeMutate(service, {
    actor,
    reason: reason?.trim() || `Revert change set ${changeSetId}`,
    task,
    gitHead,
    planId: resolvedContext.planId,
    chainScopeId: resolvedContext.chainScopeId,
    operations: inverse,
  });
}
