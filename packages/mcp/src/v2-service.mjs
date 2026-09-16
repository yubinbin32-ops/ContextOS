import path from 'node:path';
import fs from 'node:fs';
import { V2Database, SyncEngine } from '../../storage/src/index.mjs';
import { PlanService, TaskService, KnowledgeService } from '../../application/src/index.mjs';
import { CodeTools, CoverageChecker } from '../../code-intel/src/index.mjs';
import { runCommand, ProcessManager } from '../../process-host/src/index.mjs';
import { NetworkLayoutEngine } from '../../layout/src/index.mjs';
import { MarkdownRenderer } from '../../context/src/index.mjs';

export class ContextOSV2Service {
  constructor({ projectRoot = process.cwd(), projectId = 'contextos' } = {}) {
    this.projectRoot = path.resolve(projectRoot);
    this.projectId = projectId;

    const dbPath = path.join(this.projectRoot, '.contextos', 'state.sqlite');
    this.db = new V2Database(dbPath);
    this.db.ensureProject(this.projectId, this.projectRoot);

    this.syncEngine = new SyncEngine(this.db);
    this.planService = new PlanService(this.db);
    this.taskService = new TaskService(this.db, this.syncEngine);
    this.processManager = new ProcessManager({ projectRoot: this.projectRoot });

    // Initial external sync check
    this.syncEngine.reconcileExternalChange(this.projectId, this.projectRoot);
  }

  close() {
    this.db.close();
    this.processManager.stopAll().catch(() => {});
  }

  // ================= 1. os_context =================
  async osContext({ action = 'brief', query = '', entityId = '', format = 'markdown' }) {
    switch (action) {
      case 'brief': {
        const project = this.db.getProject(this.projectId) || { id: this.projectId, repo_root: this.projectRoot };
        const plans = this.db.listPlans(this.projectId);
        const activePlan = plans.find((p) => p.status === 'active') || plans[0] || null;
        const tasks = this.db.listTasks(activePlan?.id);
        const activeTask = tasks.find((t) => ['active', 'checking', 'syncing'].includes(t.status)) || tasks[0] || null;
        const processes = this.processManager.listProcesses().filter((p) => p.status === 'running' || p.status === 'ready');
        const recentBlocks = this.db.listBlocks(this.projectId);

        if (format === 'json') {
          return { project, activePlan, activeTask, processes, recentBlocks };
        }
        return MarkdownRenderer.renderBrief({ project, activePlan, activeTask, processes, recentBlocks });
      }

      case 'search': {
        const queryLower = (query || '').toLowerCase();
        const blocks = this.db.listBlocks(this.projectId).filter((b) =>
          b.title.toLowerCase().includes(queryLower) || b.summary?.toLowerCase().includes(queryLower)
        );
        const chains = this.db.listChains(this.projectId).filter((c) =>
          c.title.toLowerCase().includes(queryLower) || c.summary?.toLowerCase().includes(queryLower)
        );
        const tasks = this.db.listTasks().filter((t) =>
          t.title.toLowerCase().includes(queryLower)
        );

        if (format === 'json') return { blocks, chains, tasks };
        const lines = [`# Search Results for "${query}"`];
        if (blocks.length) lines.push('## Blocks:\n' + blocks.map((b) => `- [${b.id}] ${b.title} - ${b.summary}`).join('\n'));
        if (chains.length) lines.push('## Chains:\n' + chains.map((c) => `- [${c.id}] ${c.title}`).join('\n'));
        if (tasks.length) lines.push('## Tasks:\n' + tasks.map((t) => `- [${t.id}] ${t.title} (${t.status})`).join('\n'));
        return lines.join('\n\n');
      }

      case 'open': {
        const [type, id] = entityId.includes(':') ? entityId.split(':') : ['block', entityId];
        if (type === 'plan') {
          const plan = this.db.getPlan(id);
          if (!plan) throw new Error(`Plan '${id}' not found`);
          return format === 'json' ? plan : MarkdownRenderer.renderPlan(plan);
        }
        if (type === 'task') {
          const task = this.db.getTask(id);
          if (!task) throw new Error(`Task '${id}' not found`);
          return format === 'json' ? task : MarkdownRenderer.renderTask(task);
        }
        if (type === 'chain') {
          const chain = this.db.getChain(id);
          if (!chain) throw new Error(`Chain '${id}' not found`);
          return format === 'json' ? chain : `# Chain [${chain.id}] ${chain.title}\nKind: ${chain.kind}\nMembers: ${chain.memberIds.join(', ')}`;
        }
        const block = this.db.getBlock(id);
        if (!block) throw new Error(`Block '${id}' not found`);
        return format === 'json' ? block : MarkdownRenderer.renderBlock(block);
      }

      case 'reconcile': {
        const res = this.syncEngine.reconcileExternalChange(this.projectId, this.projectRoot);
        return res.changed
          ? `External Git/JSON change applied! Graph revision updated to ${res.revision}.`
          : 'ContextOS database and graph.json are already in sync.';
      }

      default:
        throw new Error(`Unknown os_context action: ${action}`);
    }
  }

  // ================= 2. plan =================
  async plan({ action, id, planData = {}, checkpointId, passed, evidenceRef, format = 'markdown' }) {
    switch (action) {
      case 'list': {
        const plans = this.db.listPlans(this.projectId);
        if (format === 'json') return plans;
        return '# Project Plans\n' + (plans.length ? plans.map((p) => `- [${p.status.toUpperCase()}] **${p.title}** (${p.id}) - ${p.summary}`).join('\n') : 'No plans yet.');
      }
      case 'create': {
        const created = this.planService.createPlan({ ...planData, projectId: this.projectId });
        return format === 'json' ? created : MarkdownRenderer.renderPlan(created);
      }
      case 'open': {
        const plan = this.db.getPlan(id);
        if (!plan) throw new Error(`Plan '${id}' not found`);
        return format === 'json' ? plan : MarkdownRenderer.renderPlan(plan);
      }
      case 'check': {
        const cp = this.planService.checkCheckpoint(id, checkpointId, { passed, evidenceRef });
        return `Checkpoint '${checkpointId}' in Plan '${id}' marked as ${cp.status}.`;
      }
      case 'complete': {
        const completed = this.planService.completePlan(id, planData);
        return format === 'json' ? completed : `Plan '${id}' completed successfully!\nSummary: ${completed.completedSummary}`;
      }
      case 'delete': {
        const deleted = this.planService.deletePlan(id);
        return format === 'json' ? { deleted, id } : `Plan '${id}' deleted successfully.`;
      }
      default:
        throw new Error(`Unknown plan action: ${action}`);
    }
  }

  // ================= 3. task =================
  async task({ action, id, taskData = {}, text, kind, checkData = {}, syncData = {}, format = 'markdown' }) {
    switch (action) {
      case 'create': {
        const created = this.taskService.createTask(taskData);
        return format === 'json' ? created : MarkdownRenderer.renderTask(created);
      }
      case 'open': {
        const task = this.db.getTask(id);
        if (!task) throw new Error(`Task '${id}' not found`);
        return format === 'json' ? task : MarkdownRenderer.renderTask(task);
      }
      case 'note': {
        const note = this.taskService.addNote(id, { text, kind });
        return `Note added to Task '${id}': ${note.text}`;
      }
      case 'check': {
        const check = this.taskService.addCheck(id, checkData);
        return `Verification check recorded for Task '${id}': [${check.passed ? 'PASS' : 'FAIL'}] ${check.description}`;
      }
      case 'sync': {
        const result = this.taskService.syncTask(id, {
          ...syncData,
          projectRoot: this.projectRoot,
          projectId: this.projectId,
        });
        return format === 'json'
          ? result
          : `Task '${id}' completed and synced!\nRevision: ${result.graphRevision}\nBlocks: ${result.syncResult.createdBlockIds.join(', ')}`;
      }
      case 'activate':
      case 'develop': {
        const activated = this.taskService.activateTask(id);
        return `Task '${id}' moved to state: ${activated.status}.`;
      }
      case 'resume': {
        const resumed = this.taskService.resumeTask(id);
        return `Task '${id}' resumed to state: ${resumed.status}.`;
      }
      default:
        throw new Error(`Unknown task action: ${action}`);
    }
  }

  // ================= 4. block =================
  async block({ action, id, blockData = {}, query, format = 'markdown' }) {
    switch (action) {
      case 'list': {
        const blocks = this.db.listBlocks(this.projectId);
        if (format === 'json') return blocks;
        const lines = [`# Architecture Blocks (${blocks.length} total)`];
        for (const b of blocks) {
          lines.push(`- **[${b.id}]** ${b.title} (${b.artifactRefs?.length || 0} code refs)\n  ${b.summary}`);
        }
        return lines.join('\n');
      }
      case 'open': {
        const block = this.db.getBlock(id);
        if (!block) throw new Error(`Block '${id}' not found`);
        return format === 'json' ? block : MarkdownRenderer.renderBlock(block);
      }
      case 'search': {
        const queryLower = (query || '').toLowerCase();
        const matches = this.db.listBlocks(this.projectId).filter((b) =>
          b.title.toLowerCase().includes(queryLower) || b.summary.toLowerCase().includes(queryLower)
        );
        if (format === 'json') return matches;
        return '# Block Search Results\n' + matches.map((b) => `- [${b.id}] ${b.title}: ${b.summary}`).join('\n');
      }
      case 'bind': {
        const targetId = id || blockData?.id;
        if (!targetId) {
          throw new Error("Missing required 'id' parameter for block bind action (e.g. id: 'block-desktop-installer')");
        }
        const existing = this.db.getBlock(targetId);
        const inputArtifactRefs = blockData?.artifactRefs || [];
        const normalizedRefs = inputArtifactRefs.map((ref) => {
          if (typeof ref === 'string') {
            return { path: ref, role: 'implementation' };
          }
          return ref;
        });

        const existingRefs = existing?.artifactRefs || [];
        const mergedRefs = [...existingRefs];
        for (const nr of normalizedRefs) {
          if (!mergedRefs.some((r) => r.path === nr.path && (!nr.symbol || r.symbol === nr.symbol))) {
            mergedRefs.push(nr);
          }
        }

        const block = {
          ...(existing || {}),
          ...blockData,
          id: targetId,
          projectId: this.projectId,
          artifactRefs: mergedRefs,
        };
        this.db.saveBlock(block);
        this.syncEngine.exportGraphToJson(this.projectId, this.projectRoot);
        return `Block '${block.id}' bound with ${block.artifactRefs.length} code locators.`;
      }
      case 'delete': {
        this.db.deleteBlock(id);
        this.syncEngine.exportGraphToJson(this.projectId, this.projectRoot);
        return `Block '${id}' deleted successfully.`;
      }
      default:
        throw new Error(`Unknown block action: ${action}`);
    }
  }

  // ================= 5. chain =================
  async chain({ action, id, chainData = {}, linkData = {}, format = 'markdown' }) {
    switch (action) {
      case 'list': {
        const chains = this.db.listChains(this.projectId);
        if (format === 'json') return chains;
        return '# Feature Chains\n' + (chains.length ? chains.map((c) => `- [${c.id}] ${c.title} (${c.kind}, ${c.memberIds.length} members)`).join('\n') : 'No chains yet.');
      }
      case 'open': {
        const chain = this.db.getChain(id);
        if (!chain) throw new Error(`Chain '${id}' not found`);
        return format === 'json' ? chain : `# Chain: [${chain.id}] ${chain.title}\nMembers: ${chain.memberIds.join(', ')}`;
      }
      case 'compose': {
        this.db.saveChain({ ...chainData, projectId: this.projectId });
        this.syncEngine.exportGraphToJson(this.projectId, this.projectRoot);
        return `Chain '${chainData.id}' composed successfully.`;
      }
      case 'delete': {
        this.db.deleteChain(id);
        this.syncEngine.exportGraphToJson(this.projectId, this.projectRoot);
        return `Chain '${id}' deleted successfully.`;
      }
      case 'link': {
        this.db.saveLink({ ...linkData, projectId: this.projectId });
        this.syncEngine.exportGraphToJson(this.projectId, this.projectRoot);
        return `Link created: ${linkData.from} -[${linkData.kind}]-> ${linkData.to}`;
      }
      case 'unlink': {
        const from = linkData.from || linkData.from_id;
        const to = linkData.to || linkData.to_id;
        if (id) {
          this.db.deleteLink(id);
        } else if (from && to) {
          this.db.deleteLinkBetween(from, to);
        } else {
          throw new Error("Action 'unlink' requires link id or { from, to } in linkData");
        }
        this.syncEngine.exportGraphToJson(this.projectId, this.projectRoot);
        return `Link between '${from}' and '${to}' removed.`;
      }
      case 'links': {
        const links = this.db.listLinks(this.projectId);
        if (format === 'json') return links;
        const lines = [`# Architecture Links (${links.length} total)`];
        for (const l of links) {
          const reason = l.reason ? ` - ${l.reason}` : '';
          lines.push(`- \`${l.from}\` -[${l.kind}]-> \`${l.to}\`${reason}`);
        }
        return lines.join('\n');
      }
      case 'validate': {
        const blocks = this.db.listBlocks(this.projectId);
        const chains = this.db.listChains(this.projectId);
        const links = this.db.listLinks(this.projectId);
        const layout = NetworkLayoutEngine.computeLayout({ blocks, chains, links });
        return {
          valid: true,
          nodeCount: layout.nodes.length,
          edgeCount: layout.edges.length,
          bounds: layout.bounds,
        };
      }
      default:
        throw new Error(`Unknown chain action: ${action}`);
    }
  }

  // ================= 6. code =================
  async code({ action, path: relPath, selector, targetContent, replacementContent, content: rawContent, query, format = 'markdown' }) {
    if (action === 'search' && !relPath) {
      // Global workspace symbol search
      const blocks = this.db.listBlocks(this.projectId);
      const allFiles = new Set();
      for (const b of blocks) {
        for (const ref of b.artifactRefs) {
          allFiles.add(ref.path);
        }
      }
      const results = CodeTools.searchWorkspace(this.projectRoot, query || '', Array.from(allFiles));
      if (format === 'json') return results;
      const lines = [`# Workspace Symbols matching: \`${query}\``];
      if (results.length === 0) {
        lines.push('No matching symbols found.');
      } else {
        for (const r of results) {
          const sig = r.signature ? ` - \`${r.signature}\`` : '';
          lines.push(`- **${r.kind}** \`${r.symbol}\`${sig} [\`${r.path}\`:L${r.startLine}-L${r.endLine}]`);
        }
      }
      return lines.join('\n');
    }

    if (!relPath) throw new Error(`Code action '${action}' requires 'path' parameter`);
    const fullPath = path.resolve(this.projectRoot, relPath);

    if (action === 'create') {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      const initialContent = replacementContent || rawContent || '';
      fs.writeFileSync(fullPath, initialContent, 'utf8');
      const res = CodeTools.create(relPath, initialContent);
      return {
        filePath: relPath,
        newHash: res.newHash,
        locators: res.locators,
        message: `File '${relPath}' created successfully with AST anchors initialized.`,
      };
    }

    if (!fs.existsSync(fullPath)) throw new Error(`File not found: ${relPath}`);
    const content = fs.readFileSync(fullPath, 'utf8');

    switch (action) {
      case 'outline': {
        const res = CodeTools.outline(relPath, content);
        return format === 'json' ? res.structure : res.markdown;
      }
      case 'read': {
        const res = CodeTools.read(relPath, content, selector);
        if (format === 'json') return res;
        return `\`\`\`${path.extname(relPath).slice(1) || 'text'}\n// ${relPath} [L${res.startLine}-L${res.endLine}] (hash: ${res.hash})\n${res.code}\n\`\`\``;
      }
      case 'edit': {
        const res = CodeTools.edit(relPath, content, {
          targetContent,
          replacementContent,
          ...(typeof selector === 'object' ? selector : {}),
        });
        fs.writeFileSync(fullPath, res.newContent, 'utf8');
        return {
          filePath: relPath,
          newHash: res.newHash,
          locators: res.updatedLocators,
          message: `File '${relPath}' updated cleanly and re-anchored.`,
        };
      }
      case 'search': {
        const res = CodeTools.search(relPath, content, query || '');
        if (format === 'json') return res;
        const lines = [`# Symbols in \`${relPath}\` matching: \`${query}\``];
        if (res.matchingSymbols.length > 0) {
          lines.push('\n### Matching Methods / Symbols:');
          for (const s of res.matchingSymbols) {
            const sig = s.signature ? ` - \`${s.signature}\`` : '';
            lines.push(`- **${s.kind}** \`${s.symbol}\`${sig} [L${s.startLine}-L${s.endLine}]`);
          }
        }
        if (res.matchingLines.length > 0) {
          lines.push('\n### Matching Lines:');
          for (const l of res.matchingLines) {
            lines.push(`- L${l.line}: \`${l.content}\``);
          }
        }
        return lines.join('\n');
      }
      default:
        throw new Error(`Unknown code action: ${action}`);
    }
  }

  // ================= 7. run_command =================
  async runCommand({ command, cwd, maxChars = 1500, timeoutMs = 60000 }) {
    const targetCwd = cwd ? path.resolve(this.projectRoot, cwd) : this.projectRoot;
    return runCommand({
      command,
      cwd: targetCwd,
      maxChars,
      timeoutMs,
      projectRoot: this.projectRoot,
    });
  }

  // ================= 8. process =================
  async process({ action, command, id, lines = 50, grep }) {
    switch (action) {
      case 'start':
        return this.processManager.startProcess({ command });
      case 'list':
        return this.processManager.listProcesses();
      case 'status':
        return this.processManager.getProcess(id);
      case 'logs':
        return this.processManager.getLogs(id, { lines, grep });
      case 'stop':
        return this.processManager.stopProcess(id);
      case 'clear':
        this.processManager.clearStopped();
        return { cleared: true };
      default:
        throw new Error(`Unknown process action: ${action}`);
    }
  }

  // ================= 9. knowledge =================
  async knowledge({ action, ruleId, ruleData = {}, sectionId, sectionTitle, content, format = 'markdown' }) {
    switch (action) {
      case 'rule_list': {
        const rules = KnowledgeService.listRules(this.projectRoot);
        if (format === 'json') return rules;
        return '# Project Rules\n' + (rules.length ? rules.map((r) => `- [${r.category.toUpperCase()}] **${r.title}** (\`${r.id}\`) - ${r.summary}`).join('\n') : 'No rules defined yet.');
      }
      case 'rule_open': {
        const rule = KnowledgeService.getRule(this.projectRoot, ruleId);
        if (!rule) throw new Error(`Rule '${ruleId}' not found`);
        return format === 'json' ? rule : `# Rule: ${rule.title} (${rule.category})\n\n${rule.content}`;
      }
      case 'rule_write': {
        const saved = KnowledgeService.saveRule(this.projectRoot, ruleData);
        return `Rule '${saved.id}' saved successfully.`;
      }
      case 'decision_open': {
        const { document } = KnowledgeService.getDecision(this.projectRoot);
        if (sectionId) {
          const sec = document.getSection(sectionId);
          if (!sec) throw new Error(`Decision section '${sectionId}' not found`);
          return `## [${sec.id}] ${sec.title}\n\n${sec.content}`;
        }
        return document.toMarkdown();
      }
      case 'decision_write': {
        KnowledgeService.patchDecisionSection(this.projectRoot, {
          id: sectionId,
          title: sectionTitle,
          content,
        });
        return `Decision section '[${sectionId}] ${sectionTitle}' patched successfully.`;
      }
      default:
        throw new Error(`Unknown knowledge action: ${action}`);
    }
  }
}
