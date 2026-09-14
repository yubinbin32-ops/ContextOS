/**
 * Progressive L0-L3 Markdown renderer for ContextOS MCP responses.
 * Principle: Return human/AI readable Markdown by default; return JSON only if format === 'json'.
 */

export class MarkdownRenderer {
  // Practical Test Hook: OS V2 Active Verification
  // Practical Test Hook: OS V2 Active Verification
  static renderBrief({ project, activePlan, activeTask, processes = [], recentBlocks = [] }) {
    const lines = [];
    lines.push(`# ContextOS Project Brief: \`${project.id}\` (rev: ${project.graph_revision || 0})`);
    lines.push(`Root: \`${project.repo_root}\`\n`);

    if (activePlan) {
      lines.push(`## Active Plan: [${activePlan.id}] ${activePlan.title}`);
      lines.push(`- Priority: ${activePlan.priority} | Status: ${activePlan.status}`);
      if (activePlan.summary) lines.push(`- Summary: ${activePlan.summary}`);
      const phases = activePlan.phases || [];
      if (phases.length > 0) {
        lines.push(`- Phases: ${phases.map((p) => `${p.id}(${p.status})`).join(' -> ')}`);
      }
      lines.push('');
    } else {
      lines.push('## Active Plan: None\n');
    }

    if (activeTask) {
      lines.push(`## Current Task: [${activeTask.id}] ${activeTask.title}`);
      lines.push(`- Status: **${activeTask.status}** | Plan: ${activeTask.planId} (Phase: ${activeTask.phaseId})`);
      if (activeTask.contextSlice?.objective) {
        lines.push(`- Objective: ${activeTask.contextSlice.objective}`);
      }
      if (activeTask.workingSet?.files?.length > 0) {
        lines.push(`- Working Set: ${activeTask.workingSet.files.map((f) => `\`${f}\``).join(', ')}`);
      }
      const notes = activeTask.notes || [];
      if (notes.length > 0) {
        lines.push(`- Latest Note: ${notes[notes.length - 1].text}`);
      }
      lines.push('');
    } else {
      lines.push('## Current Task: None\n');
    }

    if (processes.length > 0) {
      lines.push('## Running Processes:');
      for (const p of processes) {
        lines.push(`- [${p.id}] \`${p.command}\` (PID: ${p.pid}, status: ${p.status}${p.port ? `, port: ${p.port}` : ''})`);
      }
      lines.push('');
    }

    if (recentBlocks.length > 0) {
      lines.push('## Key Architecture Blocks:');
      for (const b of recentBlocks.slice(0, 8)) {
        lines.push(`- [${b.id}] **${b.title}** (${b.artifactRefs?.length || 0} code refs) - ${b.summary || ''}`);
      }
      lines.push('');
    }

    lines.push('> *Tip: Use `code` tool to outline or surgical-read files; use `task` tool to record progress.*');
    return lines.join('\n');
  }

  static renderPlan(plan) {
    const lines = [];
    lines.push(`# Plan: [${plan.id}] ${plan.title}`);
    lines.push(`- Status: **${plan.status}** | Priority: **${plan.priority}**`);
    if (plan.summary) lines.push(`- Summary: ${plan.summary}`);
    if (plan.completedSummary) lines.push(`- Completed Summary: ${plan.completedSummary}`);

    if (plan.ruleRefs?.length > 0) {
      lines.push(`- Referenced Rules: ${plan.ruleRefs.map((r) => `\`${r}\``).join(', ')}`);
    }

    lines.push('\n## Phases:');
    for (const p of plan.phases || []) {
      lines.push(`### Phase [${p.id}]: ${p.objective || 'No objective'}`);
      lines.push(`- Status: ${p.status} | Order: ${p.order}`);
      if (p.scope) lines.push(`- Scope: ${p.scope}`);
      if (p.deliverables?.length > 0) {
        lines.push(`- Deliverables: ${p.deliverables.join(', ')}`);
      }
      if (p.acceptance?.length > 0) {
        lines.push(`- Acceptance: ${p.acceptance.join(', ')}`);
      }
    }

    lines.push('\n## Checkpoints (Formal Acceptance):');
    if ((plan.checkpoints || []).length === 0) {
      lines.push('- No formal checkpoints registered.');
    } else {
      for (const cp of plan.checkpoints) {
        lines.push(`- [${cp.status.toUpperCase()}] **${cp.title}** (${cp.id})`);
        if (cp.criteria) lines.push(`  Criteria: ${cp.criteria}`);
        if (cp.completedAt) lines.push(`  Passed At: ${cp.completedAt}`);
      }
    }

    return lines.join('\n');
  }

  static renderTask(task) {
    const lines = [];
    lines.push(`# Task: [${task.id}] ${task.title}`);
    lines.push(`- Status: **${task.status}** (Lifecycle: draft -> active -> checking -> syncing -> completed)`);
    lines.push(`- Belongs To: Plan \`${task.planId}\`, Phase \`${task.phaseId}\``);

    if (task.contextSlice) {
      lines.push('\n## Context Slice:');
      if (task.contextSlice.objective) lines.push(`- **Objective**: ${task.contextSlice.objective}`);
      if (task.contextSlice.constraints?.length > 0) {
        lines.push(`- **Constraints**: ${task.contextSlice.constraints.join('; ')}`);
      }
      if (task.contextSlice.nextSteps?.length > 0) {
        lines.push(`- **Next Steps**: ${task.contextSlice.nextSteps.join('; ')}`);
      }
    }

    if (task.workingSet?.files?.length > 0) {
      lines.push('\n## Working Set Files:');
      for (const f of task.workingSet.files) {
        lines.push(`- \`${f}\``);
      }
    }

    if (task.notes?.length > 0) {
      lines.push('\n## In-Progress Notes:');
      for (const n of task.notes) {
        lines.push(`- [${n.kind || 'journal'}] ${n.text}`);
      }
    }

    if (task.checks?.length > 0) {
      lines.push('\n## Verification Checks:');
      for (const c of task.checks) {
        lines.push(`- [${c.passed ? 'PASS' : 'FAIL'}] ${c.description}${c.receiptId ? ` (Receipt: ${c.receiptId})` : ''}`);
      }
    }

    return lines.join('\n');
  }

  static renderBlock(block) {
    const lines = [];
    lines.push(`# Block: [${block.id}] ${block.title} (${block.kind || 'service'})`);
    if (block.summary) lines.push(`**Summary**: ${block.summary}`);
    if (block.details) lines.push(`\n${block.details}`);

    lines.push('\n## Bound Code Locators:');
    if ((block.artifactRefs || []).length === 0) {
      lines.push('*Warning: No bound code locators.*');
    } else {
      for (const ref of block.artifactRefs) {
        const range = ref.startLine && ref.endLine ? `[L${ref.startLine}-L${ref.endLine}]` : '';
        const sym = ref.symbol ? `symbol: \`${ref.symbol}\`` : '';
        lines.push(`- \`${ref.path}\` ${range} ${sym} (role: ${ref.role}, hash: \`${ref.hash}\`)`);
      }
    }

    if (block.history?.length > 0) {
      lines.push('\n## Change History:');
      for (const h of block.history.slice(-5)) {
        lines.push(`- Rev ${h.revision}: ${h.description} (${h.changedAt})`);
      }
    }

    return lines.join('\n');
  }
}
