import {
  architectureCoverage,
  assertAllowed,
  LOCALES,
  EVIDENCE_LEVELS,
  isHardPlanBlocker,
  localizationMap,
  localizedValue,
  foundationBlockGroups,
} from "./schema.mjs";

export function renderPlanContext(service, { id, locale = "en", maxChars = 12000 } = {}) {
  assertAllowed(locale, LOCALES, "locale");
  const snapshot = service.snapshot();
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
  const lines = [];
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
  lines.push(
    `# ${title}`,
    `${plan.phase} #${plan.planOrder} · ${plan.priority} · ${plan.derivedStatus}`,
    "",
    summary || "No summary.",
    "",
    "## Goal",
    goal || "—",
  );
  const nextAction = localizedValue(translations, "plan", id, locale, "nextAction", plan.nextAction);
  if (nextAction) lines.push("", "## Next action", nextAction);
  if (plan.proposedDelta.length) lines.push("", "## Overall change", ...plan.proposedDelta.map((item) => `- ${typeof item === "string" ? item : JSON.stringify(item)}`));
  if (plan.blockers.length) {
    const hard = plan.blockers.filter(isHardPlanBlocker);
    const notes = plan.blockers.filter((item) => !isHardPlanBlocker(item));
    if (hard.length) lines.push("", "## Blockers", ...hard.map((item) => `- ${item}`));
    if (notes.length) lines.push("", "## Scope notes", ...notes.map((item) => `- ${item}`));
  }
  lines.push("", "## Architecture coverage");
  lines.push(`- ${coverage.verified}/${coverage.totalBlocks} Blocks verified`);
  lines.push(`- ${coverage.planned}/${coverage.totalBlocks} Blocks covered by this Plan (${coverage.directPlanBlocks} direct · ${coverage.chainPlanBlocks} through Chains)`);
  lines.push(`- Verification coverage ${coverage.verificationCovered}/${coverage.totalBlocks} · ${coverage.failingIds.length} failing`);
  if (coverage.requiredCheckpointMissingIds.length) lines.push(`- Required verification missing: ${coverage.requiredCheckpointMissingIds.slice(0, 12).map((blockId) => `block:${blockId}`).join(", ")}${coverage.requiredCheckpointMissingIds.length > 12 ? " …" : ""}`);
  if (coverage.chainGateMissingChainIds?.length) lines.push(`- Declared Chain gates needing verification: ${coverage.chainGateMissingChainIds.slice(0, 12).map((chainId) => `chain:${chainId}`).join(", ")}${coverage.chainGateMissingChainIds.length > 12 ? " …" : ""}`);
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
        lines.push(`  - Independent verification: ${change.targetCheckpoints.map((checkpoint) => `[${checkpoint.status}] ${checkpoint.title}`).join("; ")}`);
      } else {
        lines.push("  - No checkpoint recorded yet.");
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

export function createFoundationPlan(service, {
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
  const snapshot = service.snapshot();
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

  const mutation = service.mutate(
    { actor, reason, task: "foundation-plan-bootstrap", gitHead, operations },
    { maxOperations: Number.MAX_SAFE_INTEGER, maxInputBytes: Number.MAX_SAFE_INTEGER },
  );
  const context = service.planContext({ id, maxChars: 24000 });
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
