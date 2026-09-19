import fs from 'node:fs';
import path from 'node:path';

function resolveRuleMeta(ruleId, rulesMap = {}, projectRoot = null) {
  if (!ruleId || typeof ruleId !== 'string') return null;
  const cleanId = ruleId.trim();
  if (!cleanId) return null;

  const root = projectRoot || (typeof rulesMap === 'string' ? rulesMap : rulesMap?.projectRoot) || process.cwd();

  if (rulesMap instanceof Map && rulesMap.has(cleanId)) {
    const val = rulesMap.get(cleanId);
    return {
      id: cleanId,
      title: val?.title || cleanId,
      category: val?.category || 'general',
    };
  }

  if (typeof rulesMap === 'object' && rulesMap !== null) {
    if (rulesMap[cleanId]) {
      const val = rulesMap[cleanId];
      return {
        id: cleanId,
        title: val?.title || cleanId,
        category: val?.category || 'general',
      };
    }
    if (typeof rulesMap.getRule === 'function') {
      const val = rulesMap.getRule.length >= 2
        ? rulesMap.getRule(root, cleanId)
        : (rulesMap.getRule(cleanId) || (root ? rulesMap.getRule(root, cleanId) : null));
      if (val) {
        return {
          id: cleanId,
          title: val?.title || cleanId,
          category: val?.category || 'general',
        };
      }
    }
  }
  if (root && typeof root === 'string') {
    try {
      const dotDir = path.join(root, '.contextos', 'rules');
      const stdDir = path.join(root, 'rules');
      const rulesDir = fs.existsSync(dotDir) ? dotDir : (fs.existsSync(stdDir) ? stdDir : null);
      if (rulesDir && fs.existsSync(rulesDir)) {
        let content = null;
        const targetFile = path.join(rulesDir, `${cleanId}.md`);
        if (fs.existsSync(targetFile)) {
          content = fs.readFileSync(targetFile, 'utf8');
        } else {
          const files = fs.readdirSync(rulesDir).filter((f) => f.endsWith('.md'));
          for (const f of files) {
            const fc = fs.readFileSync(path.join(rulesDir, f), 'utf8');
            if (f.replace(/\.md$/, '') === cleanId || fc.includes(`id: ${cleanId}`)) {
              content = fc;
              break;
            }
          }
        }

        if (content) {
          const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
          let title = cleanId;
          let category = 'general';
          if (match) {
            for (const line of match[1].split('\n')) {
              const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
              if (m) {
                const k = m[1].trim();
                const v = m[2].trim();
                if (k === 'title') title = v;
                if (k === 'category') category = v;
              }
            }
          } else {
            const headerMatch = content.match(/^#\s+(.+)$/m);
            if (headerMatch) title = headerMatch[1].trim();
          }
          return { id: cleanId, title, category };
        }
      }
    } catch (_) {}
  }

  return { id: cleanId, title: cleanId, category: 'general' };
}

function renderBoundRulesSection(ruleIds, rulesMap = {}, projectRoot = null) {
  if (!Array.isArray(ruleIds) || ruleIds.length === 0) return [];
  const lines = [];
  lines.push('\n## 💡 Bound Rules (按需调阅):');
  for (const ruleId of ruleIds) {
    const meta = resolveRuleMeta(ruleId, rulesMap, projectRoot);
    if (meta) {
      lines.push(`- \`[${meta.id}]\` **${meta.title}** (category: ${meta.category})`);
    }
  }
  lines.push("> *Tip: Call `knowledge(action: 'rule_open', ruleId: '...')` to inspect full specifications if needed.*");
  return lines;
}

/**
 * Progressive L0-L3 Markdown renderer for ContextOS MCP responses.
 * Principle: Return human/AI readable Markdown by default; return JSON only if format === 'json'.
 */

export class MarkdownRenderer {
  static renderBrief({ project, activePlan, activeTask, processes = [], recentBlocks = [], rulesMap = {}, projectRoot = null, nextAction: nextActionOverride = null }) {
    const lines = [];

    // 0. ContextOS Resumption Anchor (跨 Compaction 状态自愈锚点)
    const planLabel = activePlan ? `[${activePlan.id}] ${activePlan.title}` : 'None (Call plan.create or plan.list)';
    const currentPhase = activePlan?.phases?.find((p) => p.status === 'in_progress' || p.status === 'active')?.id || activePlan?.phases?.[0]?.id || 'N/A';
    const taskLabel = activeTask ? `[${activeTask.id}] ${activeTask.title} (${activeTask.status.toUpperCase()})` : 'None (Call task.create or task.open)';
    const workingSetLabel = activeTask?.workingSet?.files?.length > 0 ? activeTask.workingSet.files.slice(0, 3).join(', ') + (activeTask.workingSet.files.length > 3 ? ` (+${activeTask.workingSet.files.length - 3})` : '') : 'Clean';
    const nextAction = nextActionOverride || (!activePlan
      ? 'Create or select a Plan via plan(action: "create")'
      : (!activeTask
        ? 'Create or activate a Task via task(action: "create")'
        : (activeTask.status === 'draft'
          ? 'Activate task via task(action: "activate")'
          : (activeTask.status === 'active'
            ? 'Develop with code(outline/read/edit), then test & task(check)'
            : (activeTask.status === 'checking'
              ? 'Complete checks & sync via task(action: "sync")'
              : 'Task completed. Plan next task or complete plan.')))));

    lines.push('┌──────────────────────── ContextOS Resumption Anchor ────────────────────────┐');
    lines.push(`│ Active Plan:   ${planLabel.padEnd(61).slice(0, 61)} │`);
    lines.push(`│ Current Phase: ${currentPhase.padEnd(61).slice(0, 61)} │`);
    lines.push(`│ In-Prog Task:  ${taskLabel.padEnd(61).slice(0, 61)} │`);
    lines.push(`│ Working Set:   ${workingSetLabel.padEnd(61).slice(0, 61)} │`);
    lines.push(`│ NEXT MANDATORY ACTION:                                                       │`);
    lines.push(`│ 👉 ${nextAction.padEnd(72).slice(0, 72)} │`);
    lines.push('└──────────────────────────────────────────────────────────────────────────────┘\n');

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

      const boundRules = (activeTask.references?.rules || activeTask.rules || []).filter(Boolean);
      if (boundRules.length > 0) {
        const root = projectRoot || (typeof rulesMap === 'string' ? rulesMap : rulesMap?.projectRoot);
        lines.push(...renderBoundRulesSection(boundRules, rulesMap, root));
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

  static renderTask(task, rulesMap = {}) {
    const lines = [];
    lines.push(`# Task: [${task.id}] ${task.title}`);
    lines.push(`- Status: **${task.status}** (Lifecycle: draft -> active -> checking -> syncing -> completed)`);
    lines.push(`- Belongs To: Plan \`${task.planId}\`, Phase \`${task.phaseId}\``);

    const boundRules = (task.references?.rules || task.rules || []).filter(Boolean);
    if (boundRules.length > 0) {
      const root = typeof rulesMap === 'string' ? rulesMap : rulesMap?.projectRoot;
      lines.push(...renderBoundRulesSection(boundRules, rulesMap, root));
    }

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
