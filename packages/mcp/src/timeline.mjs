/**
 * Timeline Engine: Global execution axis, Phase/Priority ordering, and Active Cursor
 */

const PRIORITY_ORDER = {
  p0: 0,
  critical: 0,
  p1: 1,
  high: 1,
  p2: 2,
  normal: 2,
  p3: 3,
  low: 3,
};

export function normalizePriority(priority = "normal") {
  const lower = String(priority).toLowerCase().trim();
  if (lower === "p0" || lower === "critical") return "P0";
  if (lower === "p1" || lower === "high") return "P1";
  if (lower === "p2" || lower === "normal") return "P2";
  if (lower === "p3" || lower === "low") return "P3";
  return "P2";
}

export function getTimelineState(service) {
  const snapshot = service.snapshot();
  const project = snapshot.project;

  let storedTimeline = {};
  const row = service.database
    .prepare("SELECT timeline_json, handoff_json FROM projects WHERE id = ?")
    .get(project.id);
  if (row) {
    try {
      if (row.timeline_json && row.timeline_json !== "{}") {
        storedTimeline = JSON.parse(row.timeline_json);
      } else if (row.handoff_json && row.handoff_json !== "{}") {
        storedTimeline = JSON.parse(row.handoff_json);
      }
    } catch {
      // ignore JSON parse error
    }
  }

  // Group plans by phase and sort by Priority (P0 > P1 > P2) and plan_order
  const plans = snapshot.plans.map((p) => ({
    ...p,
    normalizedPriority: normalizePriority(p.priority),
    priorityRank: PRIORITY_ORDER[String(p.priority).toLowerCase()] ?? 2,
  }));

  const phaseMap = new Map();
  for (const plan of plans) {
    const phaseKey = plan.phase || "general";
    if (!phaseMap.has(phaseKey)) {
      phaseMap.set(phaseKey, []);
    }
    phaseMap.get(phaseKey).push(plan);
  }

  const phases = [];
  for (const [phaseKey, phasePlans] of phaseMap.entries()) {
    phasePlans.sort((a, b) => a.priorityRank - b.priorityRank || a.planOrder - b.planOrder);
    const completedCount = phasePlans.filter((p) => p.derivedStatus === "complete").length;
    phases.push({
      phase: phaseKey,
      completed: completedCount === phasePlans.length && phasePlans.length > 0,
      plans: phasePlans.map((p) => ({
        id: p.id,
        title: p.title,
        priority: p.normalizedPriority,
        derivedStatus: p.derivedStatus,
        status: p.status,
        progress: p.progress,
        stepsCount: snapshot.planSteps.filter((s) => s.planId === p.id).length,
      })),
    });
  }

  // Resolve active plan
  let activePlan = null;
  if (storedTimeline.activePlanId) {
    activePlan = plans.find((p) => p.id === storedTimeline.activePlanId && p.derivedStatus !== "cancelled");
  }
  if (!activePlan) {
    // Pick the highest priority active plan, or first non-complete plan
    activePlan = plans.find((p) => p.status === "active" || p.derivedStatus === "active") ||
                 plans.find((p) => p.derivedStatus !== "complete" && p.derivedStatus !== "cancelled") ||
                 plans[0] || null;
  }

  // Resolve active step within the active plan
  let activeStep = null;
  let activeStepIndex = 0;
  let allSteps = [];
  if (activePlan) {
    allSteps = snapshot.planSteps
      .filter((s) => s.planId === activePlan.id)
      .sort((a, b) => a.position - b.position);

    if (storedTimeline.activeStepId) {
      activeStep = allSteps.find((s) => s.id === storedTimeline.activeStepId);
    }
    if (!activeStep) {
      activeStep = allSteps.find((s) => s.status === "active") ||
                   allSteps.find((s) => s.status === "pending") ||
                   allSteps[0] || null;
    }
    if (activeStep) {
      activeStepIndex = allSteps.findIndex((s) => s.id === activeStep.id);
    }
  }

  const activeCursor = {
    activePhase: activePlan?.phase || (phases[0]?.phase ?? "foundation"),
    activePlanId: activePlan?.id || null,
    activePlanTitle: activePlan?.title || null,
    priority: activePlan?.normalizedPriority || "P0",
    activeStepId: activeStep?.id || null,
    activeStepTitle: activeStep?.title || null,
    activeStepIndex: activeStepIndex + 1,
    totalSteps: allSteps.length,
    nowDoing: storedTimeline.nowDoing || (activeStep ? `正在执行步骤 ${activeStepIndex + 1}: ${activeStep.title}` : "准备开始开发"),
    lastFinished: storedTimeline.lastFinished || (activePlan?.derivedReason ?? ""),
    nextUp: storedTimeline.nextUp || (activeStep ? activeStep.action || activePlan?.nextAction || "推进下一个开发任务" : ""),
    touchedFiles: storedTimeline.touchedFiles || [],
    cursorUpdatedAt: storedTimeline.cursorUpdatedAt || project.updatedAt,
  };

  const mdLines = [
    "# 📍 Project Timeline & Focus",
    `- **Active Phase**: \`${activeCursor.activePhase}\``,
    `- **Active Plan**: \`plan:${activeCursor.activePlanId ?? "none"}\` (${activeCursor.activePlanTitle ?? "None"}) [${activeCursor.priority}]`,
    ...(activeCursor.activeStepTitle ? [`- **Active Step**: Step ${activeCursor.activeStepIndex}/${activeCursor.totalSteps}: ${activeCursor.activeStepTitle}`] : []),
    `- **Now Doing**: ${activeCursor.nowDoing}`,
    ...(activeCursor.nextUp ? [`- **Next Up**: ${activeCursor.nextUp}`] : []),
    ...(activeCursor.lastFinished ? [`- **Last Finished**: ${activeCursor.lastFinished}`] : []),
    "",
    "## Phases & Execution Order",
  ];

  for (const p of phases) {
    mdLines.push(`### Phase: ${p.phase} ${p.completed ? "(Completed)" : ""}`);
    for (const plan of p.plans) {
      const isCurrent = plan.id === activeCursor.activePlanId;
      const marker = plan.derivedStatus === "complete" ? "[x]" : (isCurrent ? "[*]" : "[ ]");
      mdLines.push(`- ${marker} \`plan:${plan.id}\` · ${plan.priority} · ${plan.title} (${plan.derivedStatus})`);
    }
  }

  return {
    projectId: project.id,
    graphRevision: project.graphRevision,
    phases,
    activeCursor,
    markdown: mdLines.join("\n"),
  };
}

export function syncTimeline(service, {
  planId,
  stepId,
  nowDoing,
  nextUp,
  lastFinished,
  touchedFiles = [],
}) {
  const current = getTimelineState(service).activeCursor;
  const timestamp = new Date().toISOString();

  const updatedCursor = {
    activePlanId: planId ?? current.activePlanId,
    activeStepId: stepId ?? current.activeStepId,
    nowDoing: nowDoing ?? current.nowDoing,
    nextUp: nextUp ?? current.nextUp,
    lastFinished: lastFinished ?? current.lastFinished,
    touchedFiles: touchedFiles.length > 0 ? touchedFiles : current.touchedFiles,
    cursorUpdatedAt: timestamp,
  };

  service.database
    .prepare("UPDATE projects SET timeline_json = ?, handoff_json = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(updatedCursor), JSON.stringify(updatedCursor), timestamp, service.paths.descriptor.id);

  if (updatedCursor.activePlanId && updatedCursor.activeStepId) {
    service.database
      .prepare("UPDATE plan_steps SET status = 'pending', updated_at = ? WHERE plan_id = ? AND status = 'active' AND id != ?")
      .run(timestamp, updatedCursor.activePlanId, updatedCursor.activeStepId);
    service.database
      .prepare("UPDATE plan_steps SET status = 'active', updated_at = ? WHERE plan_id = ? AND id = ? AND status = 'pending'")
      .run(timestamp, updatedCursor.activePlanId, updatedCursor.activeStepId);
  }

  return updatedCursor;
}

export function advanceStep(service, {
  planId,
  stepId,
  status = "complete",
  summary = "",
  nextStepId = null,
}) {
  const timestamp = new Date().toISOString();
  const snapshot = service.snapshot();

  const targetPlanId = planId || getTimelineState(service).activeCursor.activePlanId;
  if (!targetPlanId) throw new Error("No active plan found to advance step");

  const steps = snapshot.planSteps
    .filter((s) => s.planId === targetPlanId)
    .sort((a, b) => a.position - b.position);

  const currentStep = stepId ? steps.find((s) => s.id === stepId) : steps.find((s) => s.status === "active" || s.status === "pending");
  if (!currentStep) throw new Error("Step not found in plan");

  // Mark current step as complete
  service.database
    .prepare("UPDATE plan_steps SET status = ?, updated_at = ? WHERE plan_id = ? AND id = ?")
    .run(status, timestamp, targetPlanId, currentStep.id);

  // Determine next step
  const currentIndex = steps.findIndex((s) => s.id === currentStep.id);
  const nextStep = nextStepId
    ? steps.find((s) => s.id === nextStepId)
    : steps[currentIndex + 1] || null;

  if (nextStep) {
    service.database
      .prepare("UPDATE plan_steps SET status = 'active', updated_at = ? WHERE plan_id = ? AND id = ?")
      .run(timestamp, targetPlanId, nextStep.id);
  }

  const lastFinished = summary || `已完成步骤 ${currentIndex + 1}: ${currentStep.title}`;
  const nowDoing = nextStep ? `正在执行步骤 ${currentIndex + 2}: ${nextStep.title}` : `计划已全部步骤完成`;
  const nextUp = nextStep ? nextStep.action || "推进步骤实现与验证" : "运行全计划验收门禁";

  return syncTimeline(service, {
    planId: targetPlanId,
    stepId: nextStep?.id || null,
    nowDoing,
    nextUp,
    lastFinished,
  });
}
