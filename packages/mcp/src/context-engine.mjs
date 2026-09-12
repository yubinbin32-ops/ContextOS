import { listDocuments } from "./documents.mjs";
import {
  architectureCoverage,
  assertAllowed,
  LOCALES,
  localizationMap,
  taskTerms,
  localizedSearchText,
  localizedValue,
} from "./schema.mjs";
import { analyzeGraphDrift } from "./query-engine.mjs";
import { pluginRuntimeStatus } from "./plugin-runtime.mjs";

export function buildContextForTask(service, { task, focusRefs = [], maxChars = 6000, locale = "en", repositorySync = null } = {}) {
  const snapshot = service.snapshot();
  const coverage = architectureCoverage(snapshot);
  assertAllowed(locale, LOCALES, "locale");
  const translations = localizationMap(snapshot);
  const terms = taskTerms(task);
  const focusIds = (kind) => new Set(focusRefs
    .filter((ref) => ref.startsWith(`${kind}:`))
    .flatMap((ref) => {
      const id = ref.slice(`${kind}:`.length);
      return [id, `${kind}:${id}`];
    }));
  const focusBlockIds = focusIds("block");
  const focusChainIds = focusIds("chain");
  const focusPlanIds = focusIds("plan");
  const backgroundRuleIds = new Set(snapshot.backgroundScopes.map((scope) => scope.blockId));
  const planSignals = new Set(["plan", "todo", "roadmap", "progress", "status", "next", "blocker", "blocked", "release", "readiness", "计划", "进度", "阻塞", "发布"]);
  const taskMentionsPlan = terms.some((term) => planSignals.has(term));
  // Downweight ubiquitous terms (e.g. MCP) so a specific platform or feature
  // name is not buried by broad infrastructure matches.
  const corpus = snapshot.blocks.map(b => `${b.id} ${b.title} ${b.summary} ${b.body} ${b.contract} ${b.tags.join(' ')} ${localizedSearchText(snapshot,'block',b.id)}`.toLowerCase());
  const termWeights = new Map(terms.map(term => [term, 1 + Math.log((corpus.length+1)/(corpus.filter(text=>text.includes(term)).length+1))]));
  const scoreText = (text, weight = 1) => {
    if (!text) return 0;
    const lower = text.toLowerCase();
    let matchCount = 0;
    for (const term of terms) {
      if (lower.includes(term)) {
        matchCount += weight * (term.length >= 4 ? 2 : 1) * (termWeights.get(term) ?? 1);
      }
    }
    return matchCount;
  };
  const scoredBlocks = snapshot.blocks
    .filter((block) => !backgroundRuleIds.has(block.id) && block.kind !== "decision")
    .map((block) => {
      let semanticScore = 0;
      semanticScore += scoreText(block.id, 4);
      semanticScore += scoreText(block.title, 5);
      semanticScore += scoreText(block.summary, 3);
      semanticScore += scoreText(block.tags.join(" "), 4);
      semanticScore += scoreText(block.contract, 3);
      semanticScore += scoreText(block.scope, 2);
      semanticScore += scoreText(block.architectureLayer, 2);
      semanticScore += scoreText(block.body, 1);
      semanticScore += scoreText(localizedSearchText(snapshot, "block", block.id), 3);
      return { block, score: semanticScore + (focusBlockIds.has(block.id) ? 100 : 0) };
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
        score: semanticScore + (focusChainIds.has(chain.id) ? 100 : 0),
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  const scoredPlans = snapshot.plans
    .map((plan) => {
      const focused = focusPlanIds.has(plan.id);
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

  const timeline = service.getTimeline();
  const activeCursor = timeline.activeCursor;
  const continuationSignals = new Set(["继续", "开发", "下一步", "推进", "恢复", "接手", "开始", "continue", "next", "resume", "status", "start"]);
  const isContinuation = terms.some((term) => continuationSignals.has(term)) || terms.length === 0;

  if (activeCursor.activePlanId) {
    const activeEntry = scoredPlans.find((e) => e.plan.id === activeCursor.activePlanId);
    if (activeEntry) {
      activeEntry.score += isContinuation ? 200 : 50;
    } else {
      const p = snapshot.plans.find((plan) => plan.id === activeCursor.activePlanId);
      if (p) scoredPlans.unshift({ plan: p, semanticScore: 10, score: isContinuation ? 200 : 50, focused: false });
    }
    scoredPlans.sort((a, b) => b.score - a.score);
  }

  if (scoredPlans.length === 0) {
    for (const plan of snapshot.plans.filter((item) => ["active", "ready", "blocked"].includes(item.status)).slice(0, 3)) {
      scoredPlans.push({ plan, score: 1 });
    }
  }

  const selectedBlockIds = new Set(scoredBlocks.slice(0, 5).map((entry) => entry.block.id));
  const selectedChainIds = new Set(scoredChains.slice(0, 1).map((entry) => entry.chain.id));
  const selectedPlanIds = new Set(scoredPlans.slice(0, 1).map((entry) => entry.plan.id));
  const detailedBlockIds = new Set(focusBlockIds);
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
  // A Plan is allowed to cover Blocks directly. Do not make the context
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
  // pass. The old snapshot of selectedChainIds was taken before Plan refs
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
    if (focusChainIds.has(chainId)) {
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

  // 📍 Timeline & Active Development Cursor
  lines.push("## 📍 Timeline & Current Focus");
  lines.push(`- Phase: ${activeCursor.activePhase} · Priority: ${activeCursor.priority}`);
  if (activeCursor.activePlanId) {
    lines.push(`- Active Plan: [plan:${activeCursor.activePlanId}] ${activeCursor.activePlanTitle || ""} (${activeCursor.activeStepIndex}/${activeCursor.totalSteps} steps)`);
  }
  if (activeCursor.activeStepTitle) {
    lines.push(`- Active Step: ${activeCursor.activeStepTitle}`);
  }
  lines.push(`- Now Doing: ${activeCursor.nowDoing}`);
  lines.push(`- Next Up: ${activeCursor.nextUp}`);
  if (activeCursor.lastFinished) {
    lines.push(`- Last Finished: ${activeCursor.lastFinished}`);
  }
  if (activeCursor.touchedFiles.length > 0) {
    lines.push(`- Working Files: ${activeCursor.touchedFiles.join(", ")}`);
  }
  lines.push("");

  const drift = analyzeGraphDrift(service, snapshot);

  lines.push("## Architecture coverage");
  lines.push(`- Verification: ${coverage.verificationCovered}/${coverage.totalBlocks} Blocks bound or passed · ${coverage.failingIds.length} failing`);
  const plugin = pluginRuntimeStatus(service.paths.projectRoot);
  if (plugin.stale) {
    lines.push(`- Plugin cache is stale (${plugin.runningHash} != ${plugin.repoHash}). Reload with: ${plugin.reload}`);
  }
  if (drift.hasDrift) {
    const parts = [];
    if (drift.ghostDrifts.length) parts.push(`${drift.ghostDrifts.length} ghost drift(s)`);
    if (drift.isolatedBlocks.length) parts.push(`${drift.isolatedBlocks.length} isolated block(s)`);
    if (drift.retestRequired.length) parts.push(`${drift.retestRequired.length} retest(s)`);
    if (drift.semanticReviews?.length) parts.push(`${drift.semanticReviews.length} semantic review(s)`);
    if (drift.chainDisconnections?.length) parts.push(`${drift.chainDisconnections.length} disconnected Chain path(s)`);
    lines.push(`- Drift alerts: ${parts.join(", ")} · Call graph_status for details.`);
    const relevantDrifts = drift.ghostDrifts.filter((g) => relevantBlocks.some((b) => b.id === g.blockId));
    if (relevantDrifts.length > 0) {
      lines.push(`- Relevant block drift: ${relevantDrifts.map((g) => `block:${g.blockId} (marked '${g.deliveryState}' but code exists; update to 'complete')`).join(", ")}`);
    }
    const relevantIsolated = drift.isolatedBlocks.filter((b) => relevantBlocks.some((rb) => rb.id === b.id));
    if (relevantIsolated.length > 0) {
      lines.push(`- Relevant isolated block(s): ${relevantIsolated.map((b) => `block:${b.id}`).join(", ")} · Evaluate: keep standalone if intentional, or connect to workflow if meant to be integrated.`);
    }
    const relevantDisconnected = (drift.chainDisconnections ?? []).filter((chain) =>
      selectedChainIds.has(chain.chainId) || chain.missingNodeIds.some((id) => selectedBlockIds.has(id)),
    );
    if (relevantDisconnected.length > 0) {
      lines.push(`- Relevant disconnected Chain path(s): ${relevantDisconnected.map((chain) => `chain:${chain.chainId}`).join(", ")} · add an explicit Link or revise the path.`);
    }
  }
  if (taskMentionsPlan && coverage.unplannedIds.length) {
    lines.push(`- Plan scope: ${coverage.planned}/${coverage.totalBlocks} Blocks are in the current Plan; other Blocks remain independent architecture.`);
  }
  if (coverage.requiredCheckpointMissingIds.length) lines.push(`- Required checkpoints missing: ${coverage.requiredCheckpointMissingIds.slice(0, 10).map((id) => `block:${id}`).join(", ")}${coverage.requiredCheckpointMissingIds.length > 10 ? " …" : ""}`);
  if (coverage.chainGateMissingChainIds?.length) lines.push(`- Declared Chain gates needing verification: ${coverage.chainGateMissingChainIds.slice(0, 10).map((id) => `chain:${id}`).join(", ")}${coverage.chainGateMissingChainIds.length > 10 ? " …" : ""}`);
  if (snapshot.sourceSync) {
    lines.push(`- Source sync: r${snapshot.sourceSync.revision} · ${snapshot.sourceSync.bindingCount} bindings · ${snapshot.sourceSync.invalidBindingCount} needing relocation`);
    if (snapshot.sourceSync.changes?.length) {
      lines.push(`- Code changes since the previous contextos boundary: ${snapshot.sourceSync.changes.slice(0, 8).map((change) => `block:${change.blockId} (${change.kinds.join(", ")})`).join(", ")}${snapshot.sourceSync.changes.length > 8 ? " …" : ""}`);
    }
  }
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
      // selected Plan. Keep the direct Block index complete above, then
      // project only changes that match the task (or an explicitly focused
      // Block/Chain). Terms shared by most changes, such as a product name,
      // are treated as noise so they cannot pull every change into context.
      const changeTexts = changes.map((change) =>
        `${change.title} ${change.summary} ${change.currentBehavior} ${change.proposedBehavior} ${change.rationale}`.toLowerCase(),
      );
      const changeTermFrequency = new Map(terms.map((term) => [term, changeTexts.filter((text) => text.includes(term)).length]));
      const broadChangeTermLimit = Math.max(2, Math.ceil(changes.length / 2));
      const explicitBlockIDs = focusBlockIds;
      const explicitChainIDs = focusChainIds;
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
  const hasExplicitChainFocus = focusChainIds.size > 0;
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
      const compositionMembers = chain.chainType === "composite"
        ? snapshot.chainMembers.filter((member) => member.chainId === chain.id).sort((left, right) => left.position - right.position)
        : [];
      const composition = compositionMembers.length
        ? ` · macro ${compositionMembers.map((member) => `${member.memberType}:${member.memberId}`).join(" → ")}`
        : "";
      lines.push(`- [chain:${chain.id}] ${title} — ${chain.deliveryState}/${chain.healthState}${path ? ` · path ${path}` : ""}${composition}`);
      const intent = localizedValue(translations, "chain", chain.id, locale, "intent", chain.intent);
      if (intent && (selectedPlanIds.size === 0 || hasExplicitChainFocus)) lines.push(`  ${intent}`);
    }
    lines.push("");
  }
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
  // focused the Plan. `focusRefs=block:*` remains an optional narrower read;
  // it must not be the implicit gate for plan coverage.
  const contentBlocks = selectedPlanIds.size && focusBlockIds.size
    ? orderedRelevantBlocks.filter((block) => focusBlockIds.has(block.id))
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
        const primary = sources.find((item) => item.role === "implementation" && item.symbol) || sources.find((item) => item.symbol) || sources[0];
        lines.push(`  Locator: ${primary.path}${primary.symbol ? ` :: ${primary.symbol}` : ""}${primary.startLine ? ` L${primary.startLine}-L${primary.endLine}` : ""}`);
      }
      const incoming = snapshot.links.filter((l) => l.targetType === "block" && l.targetId === block.id);
      const outgoing = snapshot.links.filter((l) => l.sourceType === "block" && l.sourceId === block.id);
      if (incoming.length > 0 || outgoing.length > 0) {
        const flowParts = [];
        if (incoming.length > 0) {
          flowParts.push(`Upstream: ${incoming.map((l) => `[${l.sourceId}] -[${l.kind}]->`).join(", ")}`);
        }
        if (outgoing.length > 0) {
          flowParts.push(`Downstream: ${outgoing.map((l) => `-[${l.kind}]-> [${l.targetId}]`).join(", ")}`);
        }
        lines.push(`  Flow: ${flowParts.join(" | ")}`);
      }
      if (summary && (selectedPlanIds.size === 0 || focusBlockIds.size > 0 || contentBlocks.length <= 3)) lines.push(`  ${summary}`);
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
  // Reserve the front of the pack for the task, not a stale plan's narrative.
  const priority = [`# Task Context`, `Task: ${task}`, `Graph revision: ${snapshot.project.graphRevision}`, '', '## Task essentials'];
  if(repositorySync) priority.splice(3,0,`Source index: ${repositorySync.files} files; ${repositorySync.unboundCount} without bindings (includes tests/tooling). Use source_index to inspect.`);
  const resumableTasks = service.database.prepare("SELECT id,intent,scope_json FROM task_sessions WHERE status='active' ORDER BY updated_at DESC LIMIT 3").all();
  if(resumableTasks.length) priority.splice(4,0,'## Resume / synchronization',...resumableTasks.map(t=>`- ${t.id}: ${t.intent.slice(0,100)}; next: ${(JSON.parse(t.scope_json).nextAction??'task_reconcile').slice(0,100)}`),'');
  const visibleRefs = new Set();
  for (const {block} of scoredBlocks.slice(0,5)) {
    const ref = snapshot.sourceRefs.find(r => r.blockId === block.id && r.symbol);
    const locator = ref ? `${ref.path} :: ${ref.symbol} L${ref.startLine ?? '?'}-${ref.endLine ?? '?'}` : 'Binding not yet declared';
    priority.push(`- [block:${block.id}] ${block.title} — ${block.summary.slice(0,140)}\n  ${locator}`);
    visibleRefs.add(`block:${block.id}`);
  }
  let requiredContextIncomplete = false;
  priority.push('', '## Required rules');
  for (const id of applicableRuleIds) {
    const rule = snapshot.blocks.find(b => b.id === id);
    if (!rule) continue;
    const text = `- [block:${id}] ${rule.title}: ${rule.contract || rule.body || rule.summary}`;
    if (priority.join('\n').length + text.length < maxChars * 0.8) { priority.push(text); visibleRefs.add(`block:${id}`); }
    else { priority.push(`- [block:${id}] REQUIRED: open this rule before implementation.`); requiredContextIncomplete = true; }
  }
  priority.push('', '## Relevant decisions');
  for (const decision of applicableDecisions.slice(0,3)) {
    priority.push(`- [decision:${decision.id}] ${decision.title}: ${decision.summary.slice(0,160)}`);
  }
  const docs = listDocuments(service).map(d => ({d,score:scoreText(`${d.title} ${d.summary}`,3)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,3);
  if (docs.length) priority.push('', '## Knowledge documents', ...docs.map(({d})=>`- [document:${d.id}] ${d.title} · r${d.revision} · document_open for sections`));
  const fullMarkdown = [...priority, '', ...lines.slice(3)].join('\n');
  if (priority.join('\n').length > maxChars) requiredContextIncomplete = true;
  const suffix = requiredContextIncomplete ? '\n\n[REQUIRED context incomplete: expand applicable rules before implementation]' : '\n\n[truncated; expand referenced entities or document sections]';
  const markdown = fullMarkdown.length <= maxChars ? fullMarkdown : fullMarkdown.slice(0, Math.max(0,maxChars-suffix.length)) + suffix;
  if (priority.join('\n').length > maxChars) requiredContextIncomplete = true;
  return {
    graphRevision: snapshot.project.graphRevision,
    requiredContextIncomplete,
    resumableTasks: resumableTasks.map(({id,intent})=>({id,intent})),
    documentRefs: docs.map(({d}) => `document:${d.id}`),
    sourceSync: snapshot.sourceSync ? {
      revision: snapshot.sourceSync.revision,
      sourceRevision: snapshot.sourceSync.sourceRevision,
      bindingCount: snapshot.sourceSync.bindingCount,
      changed: snapshot.sourceSync.changed,
      changedBindingCount: snapshot.sourceSync.changedBindingCount,
      invalidBindingCount: snapshot.sourceSync.invalidBindingCount,
      affectedBlockIds: snapshot.sourceSync.affectedBlockIds,
      changes: snapshot.sourceSync.changes,
    } : null,
    refs: [...new Set([...markdown.matchAll(/\[(block|chain|plan|decision|document):([^\]]+)\]/g)].map(m=>`${m[1]}:${m[2]}`))],
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
    drift,
    markdown,
  };
}
