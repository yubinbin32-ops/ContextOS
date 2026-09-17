/**
 * Progressive L0-L3 Markdown renderer for ContextOS MCP responses.
 * Principle: Return human/AI readable Markdown by default; return JSON only if format === 'json'.
 */

export class MarkdownRenderer {
  static renderBrief({ project, activePlan, activeTask, processes = [], recentBlocks = [] }) {
    const lines = [];
    lines.push(`# ContextOS Project Brief: \`${project.id}\` (rev: ${project.graph_revision || 0})`);
    lines.push(`Root: \`${project.repo_root}\`\n`);

    lines.push('## System Topology Backbone:');
    lines.push('```');
    lines.push('[Client / Apps] ──> [Gateway: MCP / Daemon]');
    lines.push('                    │');
    lines.push('                    ▼');
    lines.push('[Application Services: C-D-C-S / Runner]');
    lines.push('       │');
    lines.push('       ▼');
    lines.push('[Core Intel & Domain: AST / Invariants]');
    lines.push('       │');
    lines.push('       ▼');
    lines.push('[Storage & Infra: SQLite WAL / Git Sync]');
    lines.push('```\n');

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

  static getBlockTier(block) {
    if (block?.tier) return block.tier;
    const id = (block?.id || '').toLowerCase();
    const title = (block?.title || '').toLowerCase();

    // Check dynamic/unassigned blocks first so temporary task working sets don't pollute architecture tiers
    if (
      id.startsWith('block-unassigned') ||
      id.includes('unassigned') ||
      id.includes('dynamic') ||
      block?.kind === 'dynamic'
    ) {
      return 'Tier 6: Workspace & Dynamic Blocks';
    }

    const refs = (block?.artifactRefs || [])
      .filter(Boolean)
      .map((r) => (typeof r === 'string' ? r : r?.path || ''))
      .join(' ')
      .toLowerCase();

    // Check Tier 5 (Desktop & Client tooling) early so desktop-database doesn't match generic database
    if (
      id.includes('desktop') ||
      id.includes('cli') ||
      id.includes('cloud') ||
      id.includes('installer') ||
      id.includes('client') ||
      refs.includes('apps/desktop') ||
      refs.includes('apps/cli') ||
      refs.includes('apps/cloud') ||
      title.includes('desktop') ||
      title.includes('metro map')
    ) {
      return 'Tier 5: Client & Tooling';
    }

    // Tier 1: Gateway & Protocol Layer
    if (
      (id.includes('mcp') && !id.includes('code')) ||
      id.includes('daemon') ||
      id.includes('protocol') ||
      refs.includes('packages/mcp') ||
      refs.includes('packages/protocol') ||
      refs.includes('apps/daemon') ||
      title.includes('protocol') ||
      title.includes('mcp facade')
    ) {
      return 'Tier 1: Gateway & Protocol Layer';
    }

    // Tier 2: Application Services
    if (
      id.includes('lifecycle') ||
      id.includes('command-runner') ||
      id.includes('process-host') ||
      id.includes('coverage-guard') ||
      refs.includes('packages/application') ||
      refs.includes('packages/process-host') ||
      title.includes('lifecycle') ||
      title.includes('command runner') ||
      title.includes('process supervisor') ||
      title.includes('coverage guard')
    ) {
      return 'Tier 2: Application Services';
    }

    // Tier 3: Core Intelligence & Domain
    if (
      id.includes('code-gateway') ||
      id.includes('code-intel') ||
      id.includes('domain') ||
      id.includes('context') ||
      id.includes('layout') ||
      refs.includes('packages/code-intel') ||
      refs.includes('packages/domain') ||
      refs.includes('packages/context') ||
      refs.includes('packages/layout') ||
      title.includes('ast') ||
      title.includes('domain') ||
      title.includes('context') ||
      title.includes('layout')
    ) {
      return 'Tier 3: Core Intelligence & Domain';
    }

    // Tier 4: Infrastructure & Storage
    if (
      id.includes('storage') ||
      id.includes('database') ||
      refs.includes('packages/storage') ||
      refs.includes('.sqlite') ||
      title.includes('sqlite') ||
      title.includes('sync engine') ||
      title.includes('database engine')
    ) {
      return 'Tier 4: Infrastructure & Storage';
    }

    return 'Tier 6: Workspace & Dynamic Blocks';
  }

  static renderBlockList(blocks) {
    const lines = [`# Architecture Blocks (${blocks.length} total)`];

    const standardTiers = [
      'Tier 1: Gateway & Protocol Layer',
      'Tier 2: Application Services',
      'Tier 3: Core Intelligence & Domain',
      'Tier 4: Infrastructure & Storage',
      'Tier 5: Client & Tooling',
    ];

    const grouped = new Map();
    for (const tier of standardTiers) {
      grouped.set(tier, []);
    }

    for (const b of blocks) {
      const tier = b.tier || MarkdownRenderer.getBlockTier(b);
      if (!grouped.has(tier)) {
        grouped.set(tier, []);
      }
      grouped.get(tier).push(b);
    }

    for (const [tierName, tierBlocks] of grouped.entries()) {
      if (tierBlocks.length === 0) continue;
      lines.push(`\n## ${tierName} (${tierBlocks.length})`);
      for (const b of tierBlocks) {
        lines.push(`- **[${b.id}]** ${b.title || b.id} (${b.artifactRefs?.length || 0} code refs)\n  ${b.summary || 'No summary available.'}`);
      }
    }

    return lines.join('\n');
  }

  static renderBlock(block, { inboundLinks = [], outboundLinks = [] } = {}) {
    const lines = [];
    lines.push(`# Block: [${block.id}] ${block.title || block.id} (${block.kind || 'service'})`);
    const tier = block.tier || MarkdownRenderer.getBlockTier(block);
    if (tier) lines.push(`**Tier**: ${tier}`);
    if (block.summary) lines.push(`**Summary**: ${block.summary}`);
    if (block.details) lines.push(`\n${block.details}`);

    const safeInbound = inboundLinks || [];
    const safeOutbound = outboundLinks || [];

    lines.push('\n## Architecture Neighborhood (上下游拓扑):');
    if (safeInbound.length === 0) {
      lines.push('- 📥 **Called by (入度)**: *(none / root entrypoint)*');
    } else {
      lines.push('- 📥 **Called by (入度)**:');
      for (const link of safeInbound) {
        const reason = link.reason ? ` (${link.reason})` : '';
        lines.push(`  - \`[${link.from || 'unknown'}]\` -[${link.kind || 'calls'}]-> this block${reason}`);
      }
    }

    if (safeOutbound.length === 0) {
      lines.push('- 📤 **Calls (出度)**: *(none / terminal node)*');
    } else {
      lines.push('- 📤 **Calls (出度)**:');
      for (const link of safeOutbound) {
        const reason = link.reason ? ` (${link.reason})` : '';
        lines.push(`  - this block -[${link.kind || 'calls'}]-> \`[${link.to || 'unknown'}]\`${reason}`);
      }
    }

    lines.push('\n## Bound Code Locators:');
    if ((block.artifactRefs || []).length === 0) {
      lines.push('*Warning: No bound code locators.*');
    } else {
      for (const ref of block.artifactRefs) {
        if (!ref) continue;
        if (typeof ref === 'string') {
          lines.push(`- \`${ref}\``);
        } else if (typeof ref === 'object') {
          const range = ref.startLine && ref.endLine ? ` [L${ref.startLine}-L${ref.endLine}]` : '';
          const sym = ref.symbol ? ` symbol: \`${ref.symbol}\`` : '';
          const role = ref.role ? `role: ${ref.role}` : '';
          const hash = ref.hash ? `hash: \`${ref.hash}\`` : '';
          const metaParts = [role, hash].filter(Boolean);
          const metaStr = metaParts.length > 0 ? ` (${metaParts.join(', ')})` : '';
          lines.push(`- \`${ref.path || 'unknown'}\`${range}${sym}${metaStr}`);
        }
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
