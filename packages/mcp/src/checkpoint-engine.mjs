import { markProjectionPending, flushProjection, transaction } from "./database.mjs";
import {
  assertAllowed,
  LOCALES,
  CHECKPOINT_STATUSES,
  CHECKPOINT_KINDS,
  EVIDENCE_LEVELS,
  EVIDENCE_LEVEL_RANK,
  entityExists,
  identifier,
  now,
  changedHistoryFields,
} from "./schema.mjs";
import { withCheckpointIdentity } from "./checkpoint-freshness.mjs";

export function listCheckpoints(service, {
  status, targetType, targetId, planId, chainScopeId, unassignedOnly = false, limit = 100, locale = "en",
} = {}) {
  const snapshot = service.snapshot();
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

export function recordCheckpoint(service, {
  actor = "agent", id, targetType, targetId, title, criteria = "", status,
  checkpointKind = "atomic", aggregationPolicy = {}, eligibleAfterChildren = false,
  evidenceLevel, requiredEvidenceLevel = "static", coverage = "complete",
  evidence = [], invalidatedAt = null, expectedRevision,
  planId = null, chainScopeId = null, gitHead = null,
  evidenceExecutionIds = [],
} = {}) {
  if (!["block", "chain", "link", "plan"].includes(targetType)) throw new Error(`Invalid targetType: ${targetType}`);
  if (!title?.trim()) throw new Error("title is required");
  assertAllowed(status, CHECKPOINT_STATUSES, "checkpoint status");
  assertAllowed(checkpointKind, CHECKPOINT_KINDS, "checkpoint kind");
  if (!entityExists(service.database, service.paths.descriptor.id, targetType, targetId)) {
    throw new Error(`${targetType}:${targetId} not found`);
  }
  if (!Array.isArray(evidenceExecutionIds)) throw new Error("evidenceExecutionIds must be an array");
  const receipts = evidenceExecutionIds.map((executionId) => {
    const receipt = service.database.prepare(
      "SELECT * FROM execution_receipts WHERE id = ? AND project_id = ?",
    ).get(executionId, service.paths.descriptor.id);
    if (!receipt) throw new Error(`Execution receipt not found in project: ${executionId}`);
    return receipt;
  });
  if (status === "passed") {
    const failedReceipt = receipts.find((receipt) => receipt.status !== "passed" || receipt.exit_code !== 0);
    if (failedReceipt) throw new Error(`Passed checkpoint cannot use failed execution receipt: ${failedReceipt.id}`);
  }
  const resolvedEvidenceLevel = evidenceLevel ?? (receipts.length > 0 ? "integration" : (status === "passed" ? "static" : "none"));
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
  const receiptEvidence = receipts.map((receipt) => ({
    kind: "execution_receipt",
    executionId: receipt.id,
    command: receipt.command,
    cwd: receipt.cwd,
    executionKind: receipt.execution_kind,
    status: receipt.status,
    exitCode: receipt.exit_code,
    durationMs: receipt.duration_ms,
    originalChars: receipt.original_chars,
    finalChars: receipt.final_chars,
    redactions: receipt.redactions,
    gitHead: receipt.git_head,
    dirtyDiffHash: receipt.dirty_diff_hash,
    sourceSyncRevision: receipt.source_sync_revision,
    sourceRevision: receipt.source_revision,
    testSummary: JSON.parse(receipt.test_summary_json || "{}"),
    artifactSummary: JSON.parse(receipt.artifact_summary_json || "{}"),
  }));
  const checkpointEvidence = withCheckpointIdentity(service, {
    targetType,
    targetId,
    evidence: [...evidence, ...receiptEvidence],
    gitHead,
  });
  const changeSetId = identifier("change");
  const historyContext = service.resolveHistoryContext(planId, chainScopeId);
  const before = service.historyState("checkpoint", checkpointId);
  const result = transaction(service.database, () => {
    service.database
      .prepare(
        `INSERT INTO change_sets(id, project_id, actor, reason, task, git_head, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(changeSetId, service.paths.descriptor.id, actor, `Checkpoint: ${title}`, title, gitHead, timestamp);
    const existing = service.database.prepare("SELECT * FROM checkpoints WHERE id = ?").get(checkpointId);
    let revision = 1;
    let action = "created";
    if (existing) {
      if (existing.project_id !== service.paths.descriptor.id || existing.target_type !== targetType || existing.target_id !== targetId) {
        throw new Error(`checkpoint:${checkpointId} target cannot be changed`);
      }
      if (!Number.isInteger(expectedRevision) || expectedRevision !== existing.current_revision) {
        throw new Error(
          `Revision conflict for checkpoint:${checkpointId}; expected ${expectedRevision}, current ${existing.current_revision}`,
        );
      }
      revision = existing.current_revision + 1;
      action = "updated";
      service.database
        .prepare(
          `UPDATE checkpoints SET title = ?, criteria = ?, status = ?, checkpoint_kind = ?,
           aggregation_policy_json = ?, eligible_after_children = ?, evidence_level = ?,
           required_evidence_level = ?, coverage = ?, evidence_json = ?, invalidated_at = ?,
           current_revision = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          title, criteria, status, checkpointKind, JSON.stringify(aggregationPolicy ?? {}), Number(Boolean(eligibleAfterChildren)),
          resolvedEvidenceLevel, requiredEvidenceLevel, coverage,
      JSON.stringify(checkpointEvidence), invalidatedAt, revision, timestamp, checkpointId,
        );
    } else {
      service.database
        .prepare(
          `INSERT INTO checkpoints(
            id, project_id, target_type, target_id, title, criteria, status, checkpoint_kind,
            aggregation_policy_json, eligible_after_children, evidence_level,
            required_evidence_level, coverage, evidence_json, invalidated_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          checkpointId,
          service.paths.descriptor.id,
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
          JSON.stringify(checkpointEvidence),
          invalidatedAt,
          timestamp,
          timestamp,
        );
    }
    const targetTable = targetType === "block" ? "blocks" : targetType === "chain" ? "chains" : targetType === "link" ? "links" : "plans";
    const healthState = status === "passed" ? "healthy" : status === "failed" ? "failing" : ["blocked", "partial_pass", "retest_required"].includes(status) ? "warning" : null;
    if (healthState && targetType !== "plan") {
      service.database
        .prepare(`UPDATE ${targetTable} SET health_state = ?, updated_at = ? WHERE id = ?`)
        .run(healthState, timestamp, targetId);
    }
    const after = service.historyState("checkpoint", checkpointId);
    const changedFields = changedHistoryFields(before, after, [
      "title", "criteria", "status", "checkpointKind", "aggregationPolicy", "eligibleAfterChildren",
      "evidenceLevel", "requiredEvidenceLevel", "coverage", "evidence", "invalidatedAt",
    ]);
    const evidenceRefs = [...new Set([...evidence, ...receiptEvidence].flatMap((item) =>
      [item.ref, item.path, item.command, item.url].filter((value) => typeof value === "string" && value.trim()),
    ))];
    const affectedRefs = [
      `checkpoint:${checkpointId}`,
      `${targetType}:${targetId}`,
      ...(historyContext.planId ? [`plan:${historyContext.planId}`] : []),
      ...(historyContext.chainScopeId ? [`plan_chain_scope:${historyContext.chainScopeId}`] : []),
    ];
    service.database
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
    service.database
      .prepare(
        `INSERT INTO change_feed(project_id, change_set_id, entity_type, entity_id, action, created_at)
         VALUES (?, ?, 'checkpoint', ?, ?, ?)`,
      )
      .run(service.paths.descriptor.id, changeSetId, checkpointId, action, timestamp);
    service.database
      .prepare("UPDATE projects SET graph_revision = graph_revision + 1, updated_at = ? WHERE id = ?")
      .run(timestamp, service.paths.descriptor.id);
    markProjectionPending(service.database);
    return {
      changeSetId,
      graphRevision: service.project().graph_revision,
      checkpoint: {
        id: checkpointId, revision, status, checkpointKind, aggregationPolicy,
        eligibleAfterChildren: Boolean(eligibleAfterChildren), evidenceLevel: resolvedEvidenceLevel,
        requiredEvidenceLevel, coverage,
        executionIds: receipts.map((receipt) => receipt.id),
      },
    };
  });
  // checkpoint_record is a first-class mutation entry point, so it must keep
  // the versioned graph projection in lockstep with graph_mutate. Otherwise a
  // freshly recorded source identity can disappear when a new service process
  // imports the checked-in graph.json.
  if (service.paths.graphJsonPath) {
    try {
      flushProjection(service.database, service.paths.graphJsonPath);
    } catch (error) {
      result.success = false;
      result.projection = { status: "pending", error: error.message };
    }
  }
  return result;
}

export function executeRecordCheckpointOperation(service, operation, { timestamp }) {
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
  if (!entityExists(service.database, service.paths.descriptor.id, fields.targetType, fields.targetId)) {
    throw new Error(`${fields.targetType}:${fields.targetId} not found`);
  }
  const id = operation.id ?? identifier("checkpoint");
  const checkpointEvidence = withCheckpointIdentity(service, {
    targetType: fields.targetType,
    targetId: fields.targetId,
    evidence: fields.evidence ?? [],
    gitHead: fields.gitHead ?? null,
  });
  const existing = service.database.prepare("SELECT * FROM checkpoints WHERE project_id = ? AND id = ?")
    .get(service.paths.descriptor.id, id);
  let revision = 1;
  let action = "created";
  if (existing) {
    if (existing.project_id !== service.paths.descriptor.id || existing.target_type !== fields.targetType || existing.target_id !== fields.targetId) {
      throw new Error(`checkpoint:${id} target cannot be changed`);
    }
    if (!Number.isInteger(operation.expectedRevision) || operation.expectedRevision !== existing.current_revision) {
      throw new Error(`Revision conflict for checkpoint:${id}; expected ${operation.expectedRevision}, current ${existing.current_revision}`);
    }
    revision = existing.current_revision + 1;
    action = "updated";
    service.database.prepare(
      `UPDATE checkpoints SET title = ?, criteria = ?, status = ?, checkpoint_kind = ?,
       aggregation_policy_json = ?, eligible_after_children = ?, evidence_level = ?,
       required_evidence_level = ?, coverage = ?, evidence_json = ?, invalidated_at = ?,
       current_revision = ?, updated_at = ? WHERE project_id = ? AND id = ?`,
    ).run(
      fields.title.trim(), fields.criteria ?? "", status, checkpointKind,
      JSON.stringify(fields.aggregationPolicy ?? {}), Number(Boolean(fields.eligibleAfterChildren)), evidenceLevel,
      requiredEvidenceLevel, coverage, JSON.stringify(checkpointEvidence), fields.invalidatedAt ?? null,
      revision, timestamp, service.paths.descriptor.id, id,
    );
  } else {
    service.database.prepare(
      `INSERT INTO checkpoints(
        id, project_id, target_type, target_id, title, criteria, status, checkpoint_kind,
        aggregation_policy_json, eligible_after_children, evidence_level,
        required_evidence_level, coverage, evidence_json, invalidated_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, service.paths.descriptor.id, fields.targetType, fields.targetId, fields.title.trim(), fields.criteria ?? "",
      status, checkpointKind, JSON.stringify(fields.aggregationPolicy ?? {}), Number(Boolean(fields.eligibleAfterChildren)),
      evidenceLevel, requiredEvidenceLevel, coverage, JSON.stringify(checkpointEvidence), fields.invalidatedAt ?? null,
      timestamp, timestamp,
    );
  }
  const healthState = status === "passed" ? "healthy"
    : status === "failed" ? "failing"
      : ["blocked", "partial_pass", "retest_required"].includes(status) ? "warning" : null;
  if (healthState && fields.targetType !== "plan") {
    const targetTable = fields.targetType === "block" ? "blocks"
      : fields.targetType === "chain" ? "chains" : "links";
    service.database.prepare(`UPDATE ${targetTable} SET health_state = ?, updated_at = ? WHERE id = ?`)
      .run(healthState, timestamp, fields.targetId);
  }
  return {
    entityType: "checkpoint", id, action, revision,
    summary: `${status}: ${fields.title.trim()}`,
  };
}
