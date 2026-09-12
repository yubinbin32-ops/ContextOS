import fs from "node:fs";
import path from "node:path";
import { pluginRuntimeStatus } from "./plugin-runtime.mjs";
import { inspectChainTopology } from "./chain-topology.mjs";
import {
  architectureCoverage,
  assertAllowed,
  LOCALES,
  ARCHITECTURE_LAYERS,
  DECISION_STATUSES,
  LEGACY_BLOCK_KINDS,
  localizationMap,
  localizedValue,
  localizedSearchText,
  taskTerms,
  normalizeBlock,
  normalizeChain,
  normalizeLink,
  normalizePlan,
  normalizeDecision,
  parseJson,
  entityExists,
  checkpointSatisfiesGate,
} from "./schema.mjs";

export function renderProjectMap(service, { locale = "en" } = {}) {
  const snapshot = service.snapshot();
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
  lines.push(`- Verification: ${coverage.verificationCovered}/${coverage.totalBlocks} bound or passed · ${coverage.failingIds.length} failing`);
  lines.push(`- Plan scope: ${coverage.planned}/${coverage.totalBlocks} Blocks covered; architecture outside the Plan remains valid`);
  if (coverage.failingIds.length) lines.push(`- Failed verification: ${coverage.failingIds.slice(0, 12).map((id) => `block:${id}`).join(", ")}${coverage.failingIds.length > 12 ? " …" : ""}`);
  if (coverage.requiredCheckpointMissingIds.length) lines.push(`- Required checkpoints missing: ${coverage.requiredCheckpointMissingIds.slice(0, 12).map((id) => `block:${id}`).join(", ")}${coverage.requiredCheckpointMissingIds.length > 12 ? " …" : ""}`);
  if (coverage.chainGateMissingChainIds?.length) lines.push(`- Declared Chain gates needing verification: ${coverage.chainGateMissingChainIds.slice(0, 12).map((id) => `chain:${id}`).join(", ")}${coverage.chainGateMissingChainIds.length > 12 ? " …" : ""}`);
  if (snapshot.sourceSync) lines.push(`- Source sync: r${snapshot.sourceSync.revision} · ${snapshot.sourceSync.bindingCount} bindings · ${snapshot.sourceSync.invalidBindingCount} needing relocation`);
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

export function listDecisions(service, { locale = "en" } = {}) {
  const snapshot = service.snapshot();
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

export function searchEntities(service, { query, kinds = [], states = [], limit = 20, locale = "en" } = {}) {
  const term = `%${query.trim()}%`;
  const terms = taskTerms(query);
  const snapshot = service.snapshot();
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
  const sourceRows = service.database
    .prepare(
      `SELECT sr.*, b.title FROM source_refs sr JOIN blocks b ON b.id = sr.block_id
       WHERE b.project_id = ? AND (sr.path LIKE ? OR COALESCE(sr.symbol, '') LIKE ?) LIMIT ?`,
    )
    .all(service.paths.descriptor.id, term, term, limit);
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

export function openEntity(service, rawPayload = {}) {
  const payload = typeof rawPayload === "string" ? { ref: rawPayload } : (rawPayload ?? {});
  let { type, id, historyLimit = 8, locale = "en" } = payload;
  if ((!type || !id) && payload.ref) {
    const parts = payload.ref.split(":");
    type = parts[0];
    id = parts.slice(1).join(":");
  }
  const projectId = service.paths.descriptor.id;
  let entity;
  if (type === "block") {
    const row = service.database.prepare("SELECT * FROM blocks WHERE project_id = ? AND id = ?").get(projectId, id);
    if (row) entity = normalizeBlock(row);
  } else if (type === "chain") {
    const row = service.database.prepare("SELECT * FROM chains WHERE project_id = ? AND id = ?").get(projectId, id);
    if (row) entity = normalizeChain(row);
  } else if (type === "link") {
    const row = service.database.prepare("SELECT * FROM links WHERE project_id = ? AND id = ?").get(projectId, id);
    if (row) entity = normalizeLink(row);
  } else if (type === "plan") {
    const row = service.database.prepare("SELECT * FROM plans WHERE project_id = ? AND id = ?").get(projectId, id);
    if (row) entity = normalizePlan(row);
  } else if (type === "decision") {
    const row = service.database.prepare("SELECT * FROM decisions WHERE project_id = ? AND id = ?").get(projectId, id);
    if (row) entity = normalizeDecision(row);
  }
  if (!entity) throw new Error(`${type}:${id} not found`);

  const checkpoints = service.database
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
  const history = service.database
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
      ? service.database
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
    ? service.database.prepare("SELECT scope_type, scope_value FROM decision_scopes WHERE decision_id = ? ORDER BY scope_type, scope_value").all(id)
      .map((row) => ({ scopeType: row.scope_type, scopeValue: row.scope_value }))
    : [];
  const pathNodes =
    type === "chain"
      ? service.database
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
      ? service.database.prepare("SELECT link_id, position FROM chain_edges WHERE chain_id = ? ORDER BY position").all(id)
          .map((row) => ({ linkId: row.link_id, position: row.position }))
      : [];
  const targetChains =
    type === "plan"
      ? service.database.prepare("SELECT chain_id, position FROM plan_chain_refs WHERE plan_id = ? ORDER BY position").all(id)
          .map((row) => ({ chainId: row.chain_id, position: row.position }))
      : [];
  const dependencies = type === "plan"
    ? service.database.prepare("SELECT depends_on_plan_id, position FROM plan_dependencies WHERE plan_id = ? ORDER BY position").all(id)
        .map((row) => ({ planId: row.depends_on_plan_id, position: row.position }))
    : [];
  const steps = type === "plan"
    ? service.database.prepare("SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY position").all(id).map((row) => ({
        id: row.id, position: row.position, title: row.title, action: row.action, status: row.status,
        targetRefs: parseJson(row.target_refs_json, []), proposedDelta: parseJson(row.proposed_delta_json, []),
      }))
    : [];
  const checkpointRefs = type === "plan"
    ? service.database.prepare("SELECT checkpoint_id, step_id, position, required FROM plan_checkpoint_refs WHERE plan_id = ? ORDER BY position").all(id)
        .map((row) => ({ checkpointId: row.checkpoint_id, stepId: row.step_id, position: row.position, required: Boolean(row.required) }))
    : [];

  assertAllowed(locale, LOCALES, "locale");
  const snapshot = service.snapshot();
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
    if (ruleScopes.length) lines.push(`- Rule scopes: ${ruleScopes.map((scope) => `${scope.scopeType}:${scope.scopeValue}`).join(", ")}`);
    if (coverage) {
      const verification = coverage.missingRequiredCheckpoint
        ? "needed"
        : coverage.hasCheckpoint && coverage.isCoveredByAnyVerification
          ? "recorded"
          : coverage.hasCheckpoint
            ? "checkpointed"
            : null;
      if (verification) lines.push(`- Verification: ${verification}`);
    }
  }
  if (type === "decision" && decisionScopes.length) lines.push(`- Scopes: ${decisionScopes.map((scope) => `${scope.scopeType}:${scope.scopeValue}`).join(", ")}`);
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
      const locator = source.symbol ? `${source.path} :: ${source.symbol}` : source.path;
      const range = source.startLine && source.endLine ? ` L${source.startLine}-L${source.endLine}` : "";
      lines.push(`- ${source.role}: ${locator}${range}`);
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
    const detailed = service.planContext({ id, locale, maxChars: 24000 });
    return {
      entity: detailed.plan,
      sourceRefs, pathNodes, pathEdges, targetChains, dependencies, steps, checkpointRefs,
      checkpoints: detailed.checkpoints, history, hierarchy: detailed.hierarchy, markdown: detailed.markdown,
    };
  }
  return { entity, sourceRefs, pathNodes, pathEdges, targetChains, dependencies, steps, checkpointRefs, checkpoints, history, coverage, ruleScopes, decisionScopes, markdown: lines.join("\n") };
}

export function getChangesSince(service, { sequence = 0, sourceSyncRevision = null, limit = 100 } = {}) {
  if (!Number.isInteger(sequence) || sequence < 0) throw new Error("sequence must be a non-negative integer");
  const boundedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const sourceSync = service.sourceBindingReport({
    sinceRevision: Number.isInteger(sourceSyncRevision) ? sourceSyncRevision : null,
  });
  const latestSequence = service.database.prepare(
    "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM change_feed WHERE project_id = ?",
  ).get(service.paths.descriptor.id).sequence;
  const earliestSequence = service.database.prepare(
    "SELECT COALESCE(MIN(sequence), 0) AS sequence FROM change_feed WHERE project_id = ?",
  ).get(service.paths.descriptor.id).sequence;
  const rows = service.database.prepare(
    `SELECT cf.sequence, cf.change_set_id, cf.entity_type, cf.entity_id, cf.action, cf.created_at,
            h.revision, h.summary, h.plan_id, h.chain_scope_id, h.before_json, h.after_json,
            h.changed_fields_json, h.affected_refs_json, h.evidence_refs_json
     FROM change_feed cf
     LEFT JOIN history h ON h.change_set_id = cf.change_set_id AND h.entity_type = cf.entity_type
       AND h.entity_id = cf.entity_id AND h.action = cf.action
     WHERE cf.project_id = ? AND cf.sequence > ? ORDER BY cf.sequence LIMIT ?`,
  ).all(service.paths.descriptor.id, sequence, boundedLimit + 1).map((row) => ({
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
    `Source sync: r${sourceSync.sourceSyncRevision} · ${sourceSync.changes.length} change(s) since ${Number.isInteger(sourceSyncRevision) ? `r${sourceSyncRevision}` : "last boundary"}`,
    "",
    ...rows.map((change) => {
      const fields = change.changedFields?.length ? ` · fields ${change.changedFields.join(", ")}` : "";
      const refs = change.affectedRefs?.length ? ` · refs ${change.affectedRefs.join(", ")}` : "";
      return `- #${change.sequence} ${change.action} ${change.ref} · r${change.revision ?? "?"}${fields}${refs}${change.summary ? ` — ${change.summary}` : ""}`;
    }),
    ...(rows.length ? ["", "Use includeStructured=true when exact before/after JSON is required."] : []),
    ...(sourceSync.changes.length ? ["", "## Source changes", ...sourceSync.changes.slice(0, 12).map((change) =>
      `- block:${change.blockId} ${change.symbol ?? change.path} · ${change.kinds.join(", ")}`)] : []),
  ].join("\n");
  return {
    fromSequence: sequence,
    nextSequence: rows.at(-1)?.sequence ?? sequence,
    latestSequence,
    earliestSequence,
    sourceSyncRevision: sourceSync.sourceSyncRevision,
    sourceChanges: sourceSync.changes,
    affectedBlockIds: sourceSync.affectedBlockIds,
    affectedChainIds: sourceSync.affectedChainIds,
    hasMore,
    changes: rows,
    markdown,
  };
}

export function validateGraph(service) {
  const snapshot = service.snapshot();
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
    const topology = inspectChainTopology({
      nodes,
      edges: edges.map((edge) => {
        const link = snapshot.links.find((item) => item.id === edge.linkId);
        return link
          ? { linkId: edge.linkId, position: edge.position, sourceId: link.sourceId, targetId: link.targetId }
          : { linkId: edge.linkId, position: edge.position };
      }),
    });
    for (const issue of topology.issues) {
      const message = `Chain topology ${issue.code}: chain:${chain.id}${issue.detail ? ` · ${issue.detail}` : ""}`;
      if (issue.hard || (chain.deliveryState === "complete" && ["disconnected", "no_edges"].includes(issue.code))) errors.push(message);
      else warnings.push(message);
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
      if (!id || !entityExists(service.database, service.paths.descriptor.id, type, id)) errors.push(`Missing Plan step target: ${step.id} -> ${ref}`);
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
    } else if (block.kind === "test" || block.kind === "checkpoint") {
      warnings.push(`Block block:${block.id} uses kind '${block.kind}'. Testing and verification criteria belong in Checkpoints and Plan gates.`);
      continue;
    }
  }
  const unspecifiedBlocks = snapshot.blocks.filter((block) => block.architectureLayer === "unspecified");
  if (unspecifiedBlocks.length > 0) {
    warnings.push(`${unspecifiedBlocks.length} block(s) have no architecture layer`);
  }
  if (coverage.requiredCheckpointMissingIds.length) {
    warnings.push(`${coverage.requiredCheckpointMissingIds.length} Block(s) require a checkpoint but have none: ${coverage.requiredCheckpointMissingIds.slice(0, 20).map((id) => `block:${id}`).join(", ")}${coverage.requiredCheckpointMissingIds.length > 20 ? " …" : ""}`);
  }
  // Plan coverage, standalone verification, and Chain integration are
  // separate concepts. An unplanned Block is not a graph defect, and a
  // standalone Block checkpoint does not need a PlanChange binding.
  if (coverage.chainGateMissingChainIds.length) {
    warnings.push(`${coverage.chainGateMissingChainIds.length} declared Chain integration gate(s) are not passed: ${coverage.chainGateMissingChainIds.slice(0, 20).map((id) => `chain:${id}`).join(", ")}${coverage.chainGateMissingChainIds.length > 20 ? " …" : ""}`);
  }
  const staleCheckpoints = snapshot.checkpoints.filter((checkpoint) =>
    checkpoint.recordedStatus === "passed" && checkpoint.freshness?.status === "stale",
  );
  if (staleCheckpoints.length) {
    errors.push(`${staleCheckpoints.length} checkpoint(s) require retest because bound source identity is stale`);
  }
  const unknownCheckpoints = snapshot.checkpoints.filter((checkpoint) =>
    checkpoint.recordedStatus === "passed" && checkpoint.freshness?.status === "unknown",
  );
  if (unknownCheckpoints.length) {
    warnings.push(`${unknownCheckpoints.length} historical checkpoint(s) lack source identity and cannot satisfy a gate until re-recorded`);
  }
  for (const chain of snapshot.chains) {
    if (chain.deliveryState === "complete") {
      const passed = snapshot.checkpoints.some(
        (checkpoint) => checkpoint.targetType === "chain" && checkpoint.targetId === chain.id && checkpointSatisfiesGate(checkpoint),
      );
      if (!passed && snapshot.checkpoints.some(c => c.targetType === "chain" && c.targetId === chain.id)) warnings.push(`Complete Chain has no passed checkpoint: chain:${chain.id}`);
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
  const drift = analyzeGraphDrift(service, snapshot);
  return { valid: errors.length === 0, errors, warnings, graphRevision: snapshot.project.graphRevision, drift };
}

export function analyzeGraphDrift(service, snapshot = service.snapshot()) {
  const projectRoot = service.paths?.projectRoot ?? process.cwd();
  const chainBlockIds = new Set(snapshot.chainNodes.map((node) => node.blockId));
  const linkBlockIds = new Set(
    snapshot.links.flatMap((link) => [
      link.sourceType === "block" ? link.sourceId : null,
      link.targetType === "block" ? link.targetId : null,
    ]).filter(Boolean),
  );

  // 1. Isolated blocks (degree 0: not in any chain and has no links)
  const isolatedBlocks = snapshot.blocks
    .filter((b) => b.kind !== "decision" && !chainBlockIds.has(b.id) && !linkBlockIds.has(b.id))
    .map((b) => ({
      id: b.id,
      title: b.title,
      kind: b.kind,
      deliveryState: b.deliveryState,
      layer: b.architectureLayer,
    }));

  // 2. Ghost blocks with implemented source code on disk
  const ghostDrifts = [];
  for (const block of snapshot.blocks) {
    if (block.kind === "decision") continue;
    if (block.deliveryState === "proposed" || block.deliveryState === "planned") {
      const bindings = snapshot.sourceRefs.filter((ref) => ref.blockId === block.id);
      for (const ref of bindings) {
        if (!ref.path) continue;
        const fullPath = path.isAbsolute(ref.path) ? ref.path : path.join(projectRoot, ref.path);
        try {
          if (ref.symbol && service.sourceBindingState?.get(ref.id) && !["missing", "ambiguous", "stale", "unreadable", "outside_project"].includes(service.sourceBindingState.get(ref.id).bindingStatus)) {
            ghostDrifts.push({
              blockId: block.id,
              title: block.title,
              deliveryState: block.deliveryState,
              path: ref.path,
              symbol: ref.symbol,
            });
            break;
          }
        } catch {
          // ignore fs access error
        }
      }
    }
  }

  // 3. Checkpoints requiring attention
  const retestRequired = snapshot.checkpoints
    .filter((cp) => cp.status === "retest_required" || (cp.recordedStatus === "passed" && cp.freshness?.status === "stale"))
    .map((cp) => ({ id: cp.id, title: cp.title, targetType: cp.targetType, targetId: cp.targetId }));

  const pendingCheckpoints = snapshot.checkpoints
    .filter((cp) => cp.status === "pending" || cp.status === "failed" || cp.status === "blocked")
    .map((cp) => ({ id: cp.id, title: cp.title, targetType: cp.targetType, targetId: cp.targetId, status: cp.status }));

  const semanticReviews = collectSemanticReviews(service, snapshot);
  const chainTopologyIssues = snapshot.chains.flatMap((chain) => {
    const nodes = snapshot.chainNodes
      .filter((node) => node.chainId === chain.id)
      .sort((left, right) => left.position - right.position);
    if (nodes.length < 2) return [];
    const edges = snapshot.chainEdges
      .filter((edge) => edge.chainId === chain.id)
      .sort((left, right) => left.position - right.position)
      .map((edge) => {
        const link = snapshot.links.find((item) => item.id === edge.linkId);
        return link
          ? { linkId: edge.linkId, position: edge.position, sourceId: link.sourceId, targetId: link.targetId }
          : { linkId: edge.linkId, position: edge.position };
      });
    const topology = inspectChainTopology({ nodes, edges });
    const actionable = topology.issues.filter((issue) => issue.code !== "position_gap" || issue.hard);
    return actionable.length ? [{
      chainId: chain.id,
      title: chain.title,
      nodeIds: nodes.map((node) => node.blockId),
      reachableNodeIds: topology.reachableNodeIds,
      missingNodeIds: topology.missingNodeIds,
      edgeIds: edges.map((edge) => edge.linkId),
      issues: actionable,
    }] : [];
  });
  const linksOutsideChains = snapshot.links
    .filter((link) => link.sourceType === "block" && link.targetType === "block")
    .filter((link) => !snapshot.chainEdges.some((edge) => edge.linkId === link.id))
    .map((link) => ({ id: link.id, sourceId: link.sourceId, targetId: link.targetId, kind: link.kind }));

  return {
    isolatedBlocks,
    ghostDrifts,
    retestRequired,
    pendingCheckpoints,
    semanticReviews,
    chainDisconnections: chainTopologyIssues,
    chainTopologyIssues,
    linksOutsideChains,
    hasDrift: isolatedBlocks.length > 0 || ghostDrifts.length > 0 || retestRequired.length > 0 || semanticReviews.length > 0 || chainTopologyIssues.length > 0,
  };
}

const SEMANTIC_FIELDS = new Set(["title", "summary", "contract", "intent", "inputContract", "outputContract"]);

function collectSemanticReviews(service, snapshot) {
  let rows = [];
  try {
    rows = service.database.prepare(`
      SELECT h.entity_type, h.entity_id, h.action, h.revision, h.changed_fields_json, h.created_at, h.summary
        FROM history h
       WHERE h.entity_type IN ('block', 'chain', 'link', 'decision')
         AND h.action IN ('updated', 'created')
       ORDER BY h.id DESC
       LIMIT 200
    `).all();
  } catch {
    return [];
  }
  const latest = new Map();
  for (const row of rows) {
    const key = `${row.entity_type}:${row.entity_id}`;
    if (latest.has(key)) continue;
    const changedFields = parseJson(row.changed_fields_json, []);
    const semanticFields = changedFields.filter((field) => SEMANTIC_FIELDS.has(field));
    if (!semanticFields.length) continue;
    latest.set(key, { ...row, semanticFields });
  }
  const reviews = [];
  for (const item of latest.values()) {
    if (item.action === "created") continue;
    const related = relatedArchitecture(snapshot, item.entity_type, item.entity_id);
    if (!related.links.length && !related.decisions.length && !related.planChanges.length) continue;
    reviews.push({
      status: "review_required",
      entityType: item.entity_type,
      entityId: item.entity_id,
      revision: item.revision,
      fields: item.semanticFields,
      relatedLinks: related.links,
      relatedDecisions: related.decisions,
      relatedPlanChanges: related.planChanges,
      summary: item.summary,
    });
  }
  return reviews.slice(0, 20);
}

function relatedArchitecture(snapshot, entityType, entityId) {
  const links = snapshot.links
    .filter((link) =>
      (link.sourceType === entityType && link.sourceId === entityId) ||
      (link.targetType === entityType && link.targetId === entityId),
    )
    .map((link) => `link:${link.id}`);
  const decisions = snapshot.decisionScopes
    .filter((scope) => scope.scopeType === entityType && scope.scopeValue === entityId)
    .map((scope) => `decision:${scope.decisionId}`);
  const planChanges = snapshot.planChanges
    .filter((change) => change.entityType === entityType && change.entityId === entityId && !["complete", "passed", "skipped"].includes(change.status))
    .map((change) => `plan_change:${change.id}`);
  return {
    links: [...new Set(links)].slice(0, 8),
    decisions: [...new Set(decisions)].slice(0, 8),
    planChanges: [...new Set(planChanges)].slice(0, 8),
  };
}

export function renderGraphStatus(service, { locale = "en" } = {}) {
  const snapshot = service.snapshot();
  const drift = analyzeGraphDrift(service, snapshot);
  const totalBlocks = snapshot.blocks.filter((b) => b.kind !== "decision").length;
  const solidBlocks = snapshot.blocks.filter(
    (b) => b.kind !== "decision" && b.deliveryState !== "proposed" && b.deliveryState !== "planned",
  ).length;
  const ghostBlocks = totalBlocks - solidBlocks;
  const totalChains = snapshot.chains.length;
  const totalLinks = snapshot.links.length;
  const totalCheckpoints = snapshot.checkpoints.length;
  const passedCheckpoints = snapshot.checkpoints.filter((c) => c.status === "passed").length;
  const plugin = pluginRuntimeStatus(service.paths.projectRoot);

  const lines = [
    `# contextos Architecture & Sync Status`,
    `- Project: ${snapshot.project.name || snapshot.project.id} (rev ${snapshot.project.graphRevision})`,
    `- Blocks: ${totalBlocks} (${solidBlocks} solid, ${ghostBlocks} ghost blueprints)`,
    `- Chains: ${totalChains} · Links: ${totalLinks}`,
    `- Links outside a Chain: ${drift.linksOutsideChains.length} (cross-cutting; review only when part of a feature path)`,
    `- Checkpoints: ${passedCheckpoints}/${totalCheckpoints} passed`,
    `- Plugin: ${plugin.stale ? "stale cache" : "in sync"}`,
    "",
  ];

  if (drift.hasDrift) {
    lines.push("## ⚠️ Architecture Drift & Actionable Alerts");
    if (drift.ghostDrifts.length > 0) {
      lines.push("### 👻 Ghost Blocks with Bound Symbols (Reconcile implementation and verification)");
      for (const g of drift.ghostDrifts) {
        lines.push(`- **block:${g.blockId}** (${g.title}) · State: \`${g.deliveryState}\` · Source: \`${g.path}\`${g.symbol ? ` (#${g.symbol})` : ""}`);
        lines.push(`  *Action*: Call \`graph_mutate\` to reconcile implementation and verify before completion.`);
      }
    }
    if (drift.isolatedBlocks.length > 0) {
      lines.push("### ⛓️ Isolated Blocks (No Chains and No Links)");
      for (const b of drift.isolatedBlocks) {
        lines.push(`- **block:${b.id}** (${b.title}) · Kind: \`${b.kind}\` · Layer: \`${b.layer}\``);
        lines.push(`  *Action*: Review if intended as standalone, or connect to a Chain via \`graph_flow\` / \`architecture_connect\` if part of a workflow.`);
      }
    }
    if (drift.chainDisconnections?.length) {
      lines.push("### 🔗 Chain topology needs attention");
      for (const chain of drift.chainDisconnections) {
        const issueText = (chain.issues ?? []).map((issue) => issue.detail || issue.code).join("; ");
        lines.push(`- **chain:${chain.chainId}** (${chain.title})${issueText ? ` · ${issueText}` : ""}`);
        lines.push("  *Action*: let task reconciliation reorder a forward DAG, or revise the Chain path with `set_chain_path` and explicit Links.");
      }
    }
    if (drift.linksOutsideChains.length > 0) {
      lines.push("### 🧭 Cross-cutting Links outside Chain paths");
      lines.push(`- ${drift.linksOutsideChains.length} Link(s) connect Blocks but are not assigned to a Chain. This is allowed; include one only when it is part of the feature's observable path.`);
    }
    if (drift.retestRequired.length > 0) {
      lines.push("### 🔄 Checkpoints Requiring Retest");
      for (const r of drift.retestRequired) {
        lines.push(`- **checkpoint:${r.id}** for ${r.targetType}:${r.targetId} (${r.title})`);
        lines.push(`  *Action*: Re-run tests and record evidence with \`checkpoint_record\`.`);
      }
    }
    if (drift.semanticReviews?.length) {
      lines.push("### 🧠 Semantic reviews required");
      for (const review of drift.semanticReviews.slice(0, 12)) {
        const related = [...review.relatedLinks, ...review.relatedDecisions, ...review.relatedPlanChanges].slice(0, 6);
        lines.push(`- **${review.entityType}:${review.entityId}** changed ${review.fields.join(", ")}`);
        if (related.length) lines.push(`  *Review*: ${related.join(", ")}`);
      }
    }
    lines.push("");
  } else {
    lines.push("## ✅ Architecture Health: Clean & Synchronized");
    lines.push("- Zero ghost drift (all implemented source files correspond to solid blocks).");
    lines.push("- All checkpoints are fresh and aligned.");
    lines.push("- All isolated blocks reviewed (standalone nodes permitted; connect any intended for active workflows).");
    lines.push("");
  }
  if (plugin.stale) {
    lines.push("## ⚠️ Plugin cache is stale");
    lines.push(`- Running: \`${plugin.runningHash}\``);
    lines.push(`- Repo bundle: \`${plugin.repoHash}\``);
    lines.push(`- Reload: \`${plugin.reload}\``);
    lines.push("");
  }

  const activePlans = snapshot.plans.filter((p) => p.status === "active" || p.status === "draft");
  if (activePlans.length > 0) {
    lines.push("## 📋 Active Plans");
    for (const p of activePlans) {
      lines.push(`- [${p.status}] **plan:${p.id}** ${p.title}${p.nextAction ? ` · Next: ${p.nextAction}` : ""}`);
    }
    lines.push("");
  }

  return {
    projectId: snapshot.project.id,
    graphRevision: snapshot.project.graphRevision,
    health: drift.hasDrift ? "drift_detected" : "healthy",
    metrics: {
      totalBlocks,
      solidBlocks,
      ghostBlocks,
      totalChains,
      totalLinks,
      passedCheckpoints,
      totalCheckpoints,
    },
    drift,
    markdown: lines.join("\n"),
  };
}
