import path from 'node:path';
import fs from 'node:fs';
import { V2Database, SyncEngine } from '../../storage/src/index.mjs';
import { PlanService, TaskService, KnowledgeService } from '../../application/src/index.mjs';
import { CodeTools, CoverageChecker, LanguageRegistry, calculateHash } from '../../code-intel/src/index.mjs';
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
        const planIds = new Set(plans.map((p) => p.id));
        const allTasks = this.db.listTasks();
        const projectTasks = planIds.size > 0 ? allTasks.filter((t) => planIds.has(t.planId)) : allTasks;
        const activeTasks = projectTasks.filter((t) => ['active', 'checking', 'syncing'].includes(t.status));
        const activeTask = activeTasks.length > 0 ? activeTasks[activeTasks.length - 1] : null;

        let activePlan = null;
        if (activeTask && activeTask.planId) {
          activePlan = plans.find((p) => p.id === activeTask.planId) || this.db.getPlan(activeTask.planId) || null;
        }
        if (!activePlan) {
          activePlan = plans.find((p) => p.status === 'active') || plans[0] || null;
        }

        const displayTask = activeTask || (activePlan ? (this.db.listTasks(activePlan.id)[0] || null) : null);
        const processes = this.processManager.listProcesses().filter((p) => p.status === 'running' || p.status === 'ready');
        const recentBlocks = this.db.listBlocks(this.projectId);

        const currentPhase = activePlan?.phases?.find((p) => p.status === 'in_progress' || p.status === 'active')?.id || activePlan?.phases?.[0]?.id || 'N/A';
        const nextAction = !activePlan
          ? 'Create or select a Plan via plan(action: "create")'
          : (!displayTask
            ? 'Create or activate a Task via task(action: "create")'
            : (displayTask.status === 'draft'
              ? 'Activate task via task(action: "activate")'
              : (displayTask.status === 'active'
                ? 'Develop with code(outline/read/edit), then test & task(check)'
                : (displayTask.status === 'checking'
                  ? 'Complete checks & sync via task(action: "sync")'
                  : 'Task completed. Plan next task or complete plan.'))));

        if (format === 'json') {
          return {
            resumptionAnchor: {
              activePlan: activePlan ? { id: activePlan.id, title: activePlan.title, phase: currentPhase } : null,
              activeTask: displayTask ? { id: displayTask.id, title: displayTask.title, status: displayTask.status } : null,
              nextMandatoryAction: nextAction,
            },
            project,
            activePlan,
            activeTask: displayTask,
            processes,
            recentBlocks,
          };
        }
        return MarkdownRenderer.renderBrief({ project, activePlan, activeTask: displayTask, processes, recentBlocks, projectRoot: this.projectRoot });
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
        const allLinks = this.db.listLinks(this.projectId);
        const inboundLinks = allLinks.filter((l) => l.to === id);
        const outboundLinks = allLinks.filter((l) => l.from === id);
        const tier = MarkdownRenderer.getBlockTier(block);
        if (format === 'json') {
          return {
            ...block,
            tier,
            neighborhood: {
              inbound: inboundLinks,
              outbound: outboundLinks,
            },
          };
        }
        return MarkdownRenderer.renderBlock({ ...block, tier }, { inboundLinks, outboundLinks });
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
        this.syncEngine.exportGraphToJson(this.projectId, this.projectRoot);
        return format === 'json' ? created : MarkdownRenderer.renderPlan(created);
      }
      case 'open': {
        const plan = this.db.getPlan(id);
        if (!plan) throw new Error(`Plan '${id}' not found`);
        return format === 'json' ? plan : MarkdownRenderer.renderPlan(plan);
      }
      case 'check': {
        const cp = this.planService.checkCheckpoint(id, checkpointId, { passed, evidenceRef });
        this.syncEngine.exportGraphToJson(this.projectId, this.projectRoot);
        return `Checkpoint '${checkpointId}' in Plan '${id}' marked as ${cp.status}.`;
      }
      case 'complete': {
        const completed = this.planService.completePlan(id, planData);
        this.syncEngine.exportGraphToJson(this.projectId, this.projectRoot);
        return format === 'json' ? completed : `Plan '${id}' completed successfully!\nSummary: ${completed.completedSummary}`;
      }
      case 'delete': {
        const deleted = this.planService.deletePlan(id);
        this.syncEngine.exportGraphToJson(this.projectId, this.projectRoot);
        return format === 'json' ? { deleted, id } : `Plan '${id}' deleted successfully.`;
      }
      default:
        throw new Error(`Unknown plan action: ${action}`);
    }
  }

  // ================= 3. task =================
  async task({
    action,
    id,
    taskData = {},
    ruleId,
    rules,
    text,
    kind,
    checkData = {},
    syncData = {},
    hypothesis,
    script,
    findings,
    targetBlockId,
    files,
    format = 'markdown',
  }) {
    switch (action) {
      case 'create': {
        const payload = { ...taskData };
        if (ruleId && !payload.ruleId) payload.ruleId = ruleId;
        if (rules && !payload.rules) payload.rules = rules;
        const created = this.taskService.createTask(payload, this.projectRoot);
        return format === 'json' ? created : MarkdownRenderer.renderTask(created, { projectRoot: this.projectRoot });
      }
      case 'open': {
        if (this.projectRoot) {
          try {
            this.taskService.reconcileTask(id, this.projectRoot, this.projectId);
          } catch (_) {}
        }
        const task = this.db.getTask(id);
        if (!task) throw new Error(`Task '${id}' not found`);
        return format === 'json' ? task : MarkdownRenderer.renderTask(task, { projectRoot: this.projectRoot });
      }
      case 'bind_rule': {
        const targetRule = ruleId || taskData?.ruleId || taskData?.rule || (Array.isArray(rules) ? rules[0] : null) || text;
        if (!targetRule) throw new Error('ruleId is required to bind a rule');
        const updated = this.taskService.bindRule(id, targetRule);
        return format === 'json' ? updated : `Rule '${targetRule}' bound to Task '${id}'.`;
      }
      case 'unbind_rule': {
        const targetRule = ruleId || taskData?.ruleId || taskData?.rule || (Array.isArray(rules) ? rules[0] : null) || text;
        if (!targetRule) throw new Error('ruleId is required to unbind a rule');
        const updated = this.taskService.unbindRule(id, targetRule);
        return format === 'json' ? updated : `Rule '${targetRule}' unbound from Task '${id}'.`;
      }
      case 'update': {
        const payload = { ...taskData };
        if (rules && payload.rules === undefined) payload.rules = rules;
        if (ruleId && payload.ruleId === undefined) payload.ruleId = ruleId;
        const updated = this.taskService.updateTask(id, payload);
        return format === 'json' ? updated : MarkdownRenderer.renderTask(updated, { projectRoot: this.projectRoot });
      }
      case 'note': {
        const note = this.taskService.addNote(id, { text, kind });
        return `Note added to Task '${id}': ${note.text}`;
      }
      case 'check': {
        const check = this.taskService.addCheck(id, checkData, this.projectRoot, this.projectId);
        return `Verification check recorded for Task '${id}': [${check.passed ? 'PASS' : 'FAIL'}] ${check.description}`;
      }
      case 'sync': {
        const result = this.taskService.syncTask(id, {
          coverageMode: syncData.coverageMode || 'adaptive',
          ...syncData,
          projectRoot: this.projectRoot,
          projectId: this.projectId,
        });
        return format === 'json'
          ? result
          : `Task '${id}' completed and synced!\nRevision: ${result.graphRevision}\nBlocks: ${result.syncResult.createdBlockIds.join(', ')}`;
      }
      case 'reconcile': {
        const result = this.taskService.reconcileTask(id, this.projectRoot, this.projectId);
        return format === 'json'
          ? result
          : `Task '${id}' reconciled. Working set files: ${(result.workingSet.files || []).join(', ')}`;
      }
      case 'activate':
      case 'develop': {
        const activated = this.taskService.activateTask(id, this.projectRoot);
        return `Task '${id}' moved to state: ${activated.status}.`;
      }
      case 'resume': {
        const resumed = this.taskService.resumeTask(id);
        return `Task '${id}' resumed to state: ${resumed.status}.`;
      }
      case 'probe': {
        const targetTaskId = id || taskData?.id;
        if (!targetTaskId) throw new Error("Missing required 'id' parameter for task probe (e.g. id: 'task-xxx')");
        const task = this.db.getTask(targetTaskId);
        if (!task) throw new Error(`Task '${targetTaskId}' not found`);

        const hyp = hypothesis || taskData?.hypothesis || text || '';
        const scr = script || taskData?.script || taskData?.scratchScript || '';
        const fnd = findings || taskData?.findings || '';

        const probeEntry = {
          timestamp: new Date().toISOString(),
          hypothesis: hyp,
          script: scr,
          findings: fnd,
        };

        const noteText = `[Probe Mode] Hypothesis: ${hyp || 'N/A'}${scr ? ` | Script: ${scr}` : ''}${fnd ? ` | Findings: ${fnd}` : ''}`;
        this.taskService.addNote(targetTaskId, { text: noteText, kind: 'probe' });

        const currentSlice = task.contextSlice || {};
        const probes = Array.isArray(currentSlice.probes) ? [...currentSlice.probes] : [];
        probes.push(probeEntry);
        this.taskService.updateTask(targetTaskId, {
          contextSlice: {
            ...currentSlice,
            probes,
          },
        });

        if (format === 'json') return { taskId: targetTaskId, probe: probeEntry };
        return `🔬 Probe recorded for Task '${targetTaskId}':\n` +
          (hyp ? `- Hypothesis: ${hyp}\n` : '') +
          (scr ? `- Script: ${scr}\n` : '') +
          (fnd ? `- Findings: ${fnd}\n` : '') +
          `\n*Tip: Continue exploratory experiments. When ready, call task(action: "graduate_probe", targetBlockId: "...") to formalize.*`;
      }
      case 'graduate_probe': {
        const targetTaskId = id || taskData?.id;
        if (!targetTaskId) throw new Error("Missing required 'id' parameter for task graduate_probe (e.g. id: 'task-xxx')");
        const task = this.db.getTask(targetTaskId);
        if (!task) throw new Error(`Task '${targetTaskId}' not found`);

        const tBlockId = targetBlockId || taskData?.targetBlockId || ruleId || null;
        const gradFiles = files || taskData?.files || (script ? [script] : (taskData?.script ? [taskData.script] : []));

        const currentWorkingSet = task.workingSet || {};
        const currentFiles = Array.isArray(currentWorkingSet.files) ? [...currentWorkingSet.files] : [];
        for (const gf of gradFiles) {
          if (!currentFiles.includes(gf)) {
            currentFiles.push(gf);
          }
        }

        this.taskService.updateTask(targetTaskId, {
          workingSet: {
            ...currentWorkingSet,
            files: currentFiles,
          },
        });

        let autoBoundMsg = '';
        if (tBlockId && gradFiles.length > 0) {
          try {
            const bindRes = await this.block({
              action: 'bind_auto',
              id: tBlockId,
              paths: gradFiles,
            });
            autoBoundMsg = `\n${bindRes}`;
          } catch (err) {
            autoBoundMsg = `\n(Auto-bind deferred: ${err.message})`;
          }
        }

        const noteText = `[Probe Graduated] Promoted files to workingSet: ${gradFiles.join(', ')}${tBlockId ? ` (bound to ${tBlockId})` : ''}`;
        this.taskService.addNote(targetTaskId, { text: noteText, kind: 'graduation' });

        if (format === 'json') return { taskId: targetTaskId, graduatedFiles: gradFiles, targetBlockId: tBlockId };
        return `🎓 Probe graduated successfully for Task '${targetTaskId}':\n` +
          `- Promoted files to Task workingSet: ${gradFiles.join(', ')}\n` +
          (tBlockId ? `- Linked and bound to Block: '${tBlockId}'` : '') +
          autoBoundMsg;
      }
      default:
        throw new Error(`Unknown task action: ${action}`);
    }
  }

  async block({
    action,
    id,
    blockData = {},
    query,
    path: targetPath,
    paths = [],
    symbols = [],
    format = 'markdown',
  }) {
    switch (action) {
      case 'list': {
        const blocks = this.db.listBlocks(this.projectId);
        const enriched = blocks.map((b) => ({
          ...b,
          tier: MarkdownRenderer.getBlockTier(b),
        }));
        if (format === 'json') return enriched;
        return MarkdownRenderer.renderBlockList(enriched);
      }
      case 'open': {
        const block = this.db.getBlock(id);
        if (!block) throw new Error(`Block '${id}' not found`);
        const allLinks = this.db.listLinks(this.projectId);
        const inboundLinks = allLinks.filter((l) => l.to === id);
        const outboundLinks = allLinks.filter((l) => l.from === id);
        const tier = MarkdownRenderer.getBlockTier(block);
        if (format === 'json') {
          return {
            ...block,
            tier,
            neighborhood: {
              inbound: inboundLinks,
              outbound: outboundLinks,
            },
          };
        }
        return MarkdownRenderer.renderBlock({ ...block, tier }, { inboundLinks, outboundLinks });
      }
      case 'search': {
        const queryLower = (query || '').toLowerCase();
        const matches = this.db.listBlocks(this.projectId).filter((b) =>
          b.title?.toLowerCase().includes(queryLower) || b.summary?.toLowerCase().includes(queryLower)
        ).map((b) => ({
          ...b,
          tier: MarkdownRenderer.getBlockTier(b),
        }));
        if (format === 'json') return matches;
        return '# Block Search Results\n' + matches.map((b) => `- [${b.id}] (${b.tier}) ${b.title}: ${b.summary || 'No summary available.'}`).join('\n');
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
      case 'bind_auto': {
        const targetId = id || blockData?.id;
        if (!targetId) {
          throw new Error("Missing required 'id' parameter for block bind_auto action (e.g. id: 'block-render-engine')");
        }
        const existing = this.db.getBlock(targetId);
        if (!existing) {
          throw new Error(`Block '${targetId}' not found. Please create the Block first or specify a valid block ID.`);
        }

        const rawPaths = [];
        if (targetPath) rawPaths.push(targetPath);
        if (Array.isArray(paths)) rawPaths.push(...paths);
        if (blockData?.path) rawPaths.push(blockData.path);
        if (Array.isArray(blockData?.paths)) rawPaths.push(...blockData.paths);

        if (rawPaths.length === 0) {
          throw new Error("Missing 'path' or 'paths' parameter for bind_auto (e.g. path: 'SceneRenderer.swift')");
        }

        const symbolFilters = new Set(
          (symbols || blockData?.symbols || []).map((s) => {
            return s.includes('#') ? s.split('#')[1].trim() : s.trim();
          }).filter(Boolean)
        );

        const autoArtifactRefs = [];

        for (const inputPath of rawPaths) {
          const cleanRelPath = inputPath.startsWith(this.projectRoot)
            ? path.relative(this.projectRoot, inputPath)
            : inputPath.replace(/^\.\//, '');
          const fullPath = path.isAbsolute(inputPath)
            ? inputPath
            : path.join(this.projectRoot, cleanRelPath);

          if (!fs.existsSync(fullPath)) {
            throw new Error(`File not found on disk: '${cleanRelPath}' (resolved at: ${fullPath})`);
          }

          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            throw new Error(`Path is a directory, not a file: '${cleanRelPath}'. Please pass concrete code file paths.`);
          }

          const content = fs.readFileSync(fullPath, 'utf8');
          const fileHash = calculateHash(content);
          const lines = content.split(/\r?\n/);

          let structure = null;
          try {
            structure = LanguageRegistry.parseStructure(cleanRelPath, content);
          } catch (_) {
            structure = null;
          }

          const fileSymbols = structure?.symbols || [];
          let matchedSymbols = fileSymbols;

          if (symbolFilters.size > 0) {
            matchedSymbols = fileSymbols.filter((s) => symbolFilters.has(s.name));
          }

          if (matchedSymbols.length > 0) {
            const CONTAINER_KINDS = new Set(['class', 'struct', 'trait', 'interface', 'extension', 'impl', 'record', 'object', 'enum']);
            const topLevelOnly = matchedSymbols.filter((s) => CONTAINER_KINDS.has(s.kind) || s.kind === 'function');
            const targetSymbols = topLevelOnly.length > 0 ? topLevelOnly : matchedSymbols;

            for (const sym of targetSymbols) {
              autoArtifactRefs.push({
                path: cleanRelPath,
                symbol: sym.name,
                startLine: sym.startLine || 1,
                endLine: sym.endLine || lines.length,
                hash: sym.hash || fileHash,
                role: 'implementation',
              });
            }
          } else {
            const baseSymbol = path.basename(cleanRelPath);
            autoArtifactRefs.push({
              path: cleanRelPath,
              symbol: baseSymbol,
              startLine: 1,
              endLine: lines.length || 1,
              hash: fileHash,
              role: 'implementation',
            });
          }
        }

        const boundedPaths = new Set(autoArtifactRefs.map((r) => r.path));
        const existingRefs = (existing.artifactRefs || []).filter(
          (r) => !(boundedPaths.has(r.path) && (!r.symbol || !r.symbol.trim() || r.symbol === '*'))
        );
        const mergedRefs = [...existingRefs];
        for (const autoRef of autoArtifactRefs) {
          const idx = mergedRefs.findIndex((r) => r.path === autoRef.path && r.symbol === autoRef.symbol);
          if (idx >= 0) {
            mergedRefs[idx] = autoRef;
          } else {
            mergedRefs.push(autoRef);
          }
        }

        const updatedBlock = {
          ...existing,
          ...blockData,
          id: targetId,
          projectId: this.projectId,
          artifactRefs: mergedRefs,
        };

        this.db.saveBlock(updatedBlock);
        this.syncEngine.exportGraphToJson(this.projectId, this.projectRoot);

        if (format === 'json') {
          return { block: updatedBlock, addedRefs: autoArtifactRefs };
        }
        return `✅ Smart Auto-Bound Block '${targetId}':\n` +
          `- Extracted & Anchored ${autoArtifactRefs.length} symbol refs from ${rawPaths.length} file(s).\n` +
          autoArtifactRefs.map((r) => `  • \`${r.path}\` -> **${r.symbol}** [L${r.startLine}-L${r.endLine}] (hash: \`${r.hash}\`)`).join('\n') +
          `\n- Total Block Locators: ${mergedRefs.length}`;
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
  async code({ action, path: relPath, selector, startLine, endLine, targetContent, replacementContent, content: rawContent, query, format = 'markdown' }) {
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

      const activeTasks = this.taskService.listTasks?.(this.projectId) || [];
      const activeTask = activeTasks.find((t) => t.status === 'active');
      if (activeTask) {
        this.taskService.addFileToWorkingSet(activeTask.id, relPath);
        try {
          const stat = fs.statSync(fullPath);
          activeTask.baseline = activeTask.baseline || { fileSnapshots: {} };
          activeTask.baseline.fileSnapshots = activeTask.baseline.fileSnapshots || {};
          activeTask.baseline.fileSnapshots[relPath] = {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            hash: res.newHash,
            snapshottedAt: new Date().toISOString(),
          };
          this.db.saveTask(activeTask);
        } catch (_) {}
      }

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
        const effectiveSelector = selector || (startLine !== undefined || endLine !== undefined ? { startLine, endLine } : null);
        const res = CodeTools.read(relPath, content, effectiveSelector);
        if (format === 'json') return res;
        return `\`\`\`${path.extname(relPath).slice(1) || 'text'}\n// ${relPath} [L${res.startLine}-L${res.endLine}] (hash: ${res.hash})\n${res.code}\n\`\`\``;
      }
      case 'edit': {
        let selectorObj = {};
        if (typeof selector === 'object' && selector !== null) {
          selectorObj = selector;
        } else if (typeof selector === 'string') {
          const rangeMatch = selector.match(/^(?:.*-)?L(\d+)-L(\d+)$/);
          if (rangeMatch) {
            selectorObj = {
              startLine: parseInt(rangeMatch[1], 10),
              endLine: parseInt(rangeMatch[2], 10),
            };
          } else {
            selectorObj = { symbol: selector };
          }
        }
        const effectiveStartLine = startLine !== undefined ? startLine : selectorObj.startLine;
        const effectiveEndLine = endLine !== undefined ? endLine : selectorObj.endLine;
        const res = CodeTools.edit(relPath, content, {
          ...selectorObj,
          targetContent,
          replacementContent,
          startLine: effectiveStartLine,
          endLine: effectiveEndLine,
        });
        fs.writeFileSync(fullPath, res.newContent, 'utf8');

        const activeTasks = this.taskService.listTasks?.(this.projectId) || [];
        const activeTask = activeTasks.find((t) => t.status === 'active');
        if (activeTask) {
          this.taskService.addFileToWorkingSet(activeTask.id, relPath);
          try {
            const stat = fs.statSync(fullPath);
            activeTask.baseline = activeTask.baseline || { fileSnapshots: {} };
            activeTask.baseline.fileSnapshots = activeTask.baseline.fileSnapshots || {};
            activeTask.baseline.fileSnapshots[relPath] = {
              mtimeMs: stat.mtimeMs,
              size: stat.size,
              hash: res.newHash,
              snapshottedAt: new Date().toISOString(),
            };
            this.db.saveTask(activeTask);
          } catch (_) {}
        }

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
