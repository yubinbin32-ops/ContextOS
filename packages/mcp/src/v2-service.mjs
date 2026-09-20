import path from 'node:path';
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  V2Database,
  SyncEngine,
  inspectProjectWriteLock,
  withProjectWriteLock,
} from '../../storage/src/index.mjs';
import { PlanService, TaskService, KnowledgeService } from '../../application/src/index.mjs';
import {
  CodeTools,
  LanguageRegistry,
  calculateHash,
  calculateTreeHash,
  findDirectoryManifest,
} from '../../code-intel/src/index.mjs';
import { runCommand, ProcessManager } from '../../process-host/src/index.mjs';
import { NetworkLayoutEngine } from '../../layout/src/index.mjs';
import { MarkdownRenderer } from '../../context/src/index.mjs';

export class ContextOSV2Service {
  constructor({ projectRoot = process.cwd(), projectId = 'contextos' } = {}) {
    this.projectRoot = path.resolve(projectRoot);
    this.projectId = projectId;
    this.writeContext = new AsyncLocalStorage();
    this.stateConflict = null;

    const dbPath = path.join(this.projectRoot, '.contextos', 'state.sqlite');
    this.db = new V2Database(dbPath);
    this.db.ensureProject(this.projectId, this.projectRoot);

    this.syncEngine = new SyncEngine(this.db);
    this.planService = new PlanService(this.db);
    this.taskService = new TaskService(this.db, this.syncEngine);
    this.processManager = new ProcessManager({ projectRoot: this.projectRoot });
  }

  close({ stopProcesses = true } = {}) {
    this.db.close();
    if (stopProcesses) this.processManager.stopAll().catch(() => {});
  }

  _ensureStateReconciled() {
    const reconciliation = this.syncEngine.reconcileExternalChange(this.projectId, this.projectRoot);
    if (reconciliation.conflict) {
      this.stateConflict = reconciliation;
      return false;
    }
    this.stateConflict = null;

    const hygiene = this.taskService.repairStateHygiene(this.projectId);
    const planHygiene = this.planService.repairStateHygiene(this.projectId);
    if (hygiene.changed > 0 || planHygiene.changed > 0) {
      this.syncEngine.exportGraphToJson(this.projectId, this.projectRoot);
    }
    return true;
  }

  async _withWriteLock(label, callback, { allowConflict = false } = {}) {
    if (this.writeContext.getStore() === true) return callback();

    return withProjectWriteLock(
      this.projectRoot,
      async () =>
        this.writeContext.run(true, async () => {
          if (!this._ensureStateReconciled() && !allowConflict) {
            throw new Error(`State conflict blocks ${label}: ${this.stateConflict.reason}`);
          }
          return callback();
        }),
      { label }
    );
  }

  _resolveProjectPath(inputPath, label = 'path') {
    const fullPath = path.resolve(this.projectRoot, inputPath);
    const relativePath = path.relative(this.projectRoot, fullPath).split(path.sep).join('/');
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error(`${label} '${inputPath}' is outside project root '${this.projectRoot}'`);
    }
    return { fullPath, relativePath };
  }

  // ================= 1. os_context =================
  async osContext({ action = 'brief', query = '', entityId = '', format = 'markdown' }) {
    await this._withWriteLock('os_context.preflight', async () => {}, { allowConflict: true });
    switch (action) {
      case 'brief': {
        const project = this.db.getProject(this.projectId) || { id: this.projectId, repo_root: this.projectRoot };
        const plans = this.db.listPlans(this.projectId);
        const planIds = new Set(plans.map((p) => p.id));
        const activePlanIds = new Set(plans.filter((plan) => plan.status === 'active').map((plan) => plan.id));
        const allTasks = this.db.listTasks();
        const projectTasks = planIds.size > 0 ? allTasks.filter((t) => planIds.has(t.planId)) : allTasks;
        const activeTasks = projectTasks
          .filter((t) => activePlanIds.has(t.planId) && ['active', 'checking', 'syncing'].includes(t.status))
          .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
        const activeTask = activeTasks.length > 0 ? activeTasks[activeTasks.length - 1] : null;

        let activePlan = null;
        if (activeTask && activeTask.planId) {
          activePlan = plans.find((p) => p.id === activeTask.planId) || this.db.getPlan(activeTask.planId) || null;
        }
        if (!activePlan) {
          activePlan = plans
            .filter((plan) => plan.status === 'active')
            .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))
            .at(-1) || null;
        }

        const displayTask = activeTask || (activePlan ? this.db.listTasks(activePlan.id).find((task) => task.status !== 'completed') || null : null);
        const processes = this.processManager.listProcesses().filter((p) => p.status === 'running' || p.status === 'ready');
        const recentBlocks = this.db.listBlocks(this.projectId);
        const writeLock = inspectProjectWriteLock(this.projectRoot);

        const currentPhase = activePlan?.phases?.find((p) => p.status === 'in_progress' || p.status === 'active')?.id || activePlan?.phases?.[0]?.id || 'N/A';
        const nextAction = this.stateConflict
          ? 'Resolve graph state conflict via os_context(action: "reconcile")'
          : activeTasks.length > 1
          ? 'Resolve multiple active Tasks before continuing: ' + activeTasks.map((task) => task.id).join(', ')
          : writeLock?.alive && writeLock.owner?.pid !== process.pid
          ? 'Wait for the active project writer or inspect the project lock'
          : (!activePlan
          ? 'Create a Plan or start a lightweight Task via task(action: "start")'
          : (!displayTask
            ? 'Create or activate a Task via task(action: "start")'
            : (displayTask.status === 'draft'
              ? 'Activate task via task(action: "activate")'
              : (displayTask.status === 'active'
                ? 'Develop with code(outline/read/edit), then use task(action: "finish") or task(check) + task(sync)'
                : (displayTask.status === 'checking'
                  ? 'Complete checks & sync via task(action: "finish") or task(action: "sync")'
                  : 'Task completed. Plan next task or complete plan.')))));

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
            stateConflict: this.stateConflict,
            writeLock,
          };
        }
        let brief = MarkdownRenderer.renderBrief({
          project,
          activePlan,
          activeTask: displayTask,
          processes,
          recentBlocks,
          projectRoot: this.projectRoot,
          nextAction,
        });
        if (this.stateConflict) {
          brief = `> [!CAUTION]\n> Graph state conflict: ${this.stateConflict.reason}\n\n${brief}`;
        } else if (writeLock?.alive && writeLock.owner?.pid !== process.pid) {
          brief = `> [!WARNING]\n> Another writer is active (pid ${writeLock.owner?.pid || 'unknown'}). Writes may wait for the project lock.\n\n${brief}`;
        }
        return brief;
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
        return this._withWriteLock('os_context.reconcile', () => {
          const res = this.syncEngine.reconcileExternalChange(this.projectId, this.projectRoot);
          this.stateConflict = res.conflict ? res : null;
          const hygiene = res.conflict
            ? { changed: 0, blockedTaskIds: [] }
            : this.taskService.repairStateHygiene(this.projectId);
          const planHygiene = res.conflict
            ? { changed: 0, changedPlanIds: [] }
            : this.planService.repairStateHygiene(this.projectId);
          if (hygiene.changed > 0 || planHygiene.changed > 0) {
            this.syncEngine.exportGraphToJson(this.projectId, this.projectRoot);
          }
          if (res.changed) {
            return `External Git/JSON change applied! Graph revision updated to ${res.revision}.`;
          }
          if (res.conflict) {
            return `Graph conflict detected. ${res.reason}`;
          }
          const hygieneMessage = hygiene.changed > 0 || planHygiene.changed > 0
            ? ` Archived ${hygiene.changed} stale task(s) and ${planHygiene.changed} stale plan(s).`
            : '';
          return `ContextOS database and graph.json are already in sync.${hygieneMessage}`;
        }, { allowConflict: true });
      }

      default:
        throw new Error(`Unknown os_context action: ${action}`);
    }
  }

  // ================= 2. plan =================
  async plan(input) {
    return this._withWriteLock('plan', () => this._plan(input));
  }

  async _plan({ action, id, planData = {}, checkpointId, passed, evidenceRef, format = 'markdown' }) {
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
  async task(input) {
    return this._withWriteLock('task', () => this._task(input));
  }

  _ensurePlanPhase(planId, preferredPhaseId = null) {
    const plan = this.db.getPlan(planId);
    if (!plan) throw new Error(`Plan '${planId}' not found`);
    const phases = Array.isArray(plan.phases) ? plan.phases : [];
    const phase = phases.find((item) => item.id === preferredPhaseId)
      || phases.find((item) => item.status === 'active' || item.status === 'in_progress')
      || phases[0];

    if (phase) {
      if (phase.status === 'pending') {
        phase.status = 'active';
        plan.updatedAt = new Date().toISOString();
        this.db.savePlan(plan);
      }
      return phase.id;
    }

    const createdPhase = {
      id: preferredPhaseId || 'phase-work',
      order: 0,
      objective: '',
      scope: '',
      deliverables: [],
      status: 'active',
      taskIds: [],
      acceptance: [],
    };
    plan.phases = [...phases, createdPhase];
    plan.updatedAt = new Date().toISOString();
    this.db.savePlan(plan);
    return createdPhase.id;
  }

  async _task({
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
      case 'start': {
        const payload = { ...taskData };
        payload.id = payload.id || `task-${Date.now()}`;
        payload.title = payload.title || 'Untitled task';
        if (ruleId && !payload.ruleId) payload.ruleId = ruleId;
        if (rules && !payload.rules) payload.rules = rules;

        let autoPlanId = null;
        if (!payload.planId) {
          const activePlan = this.db
            .listPlans(this.projectId)
            .filter((plan) => plan.status === 'active')
            .at(-1);

          if (activePlan) {
            payload.planId = activePlan.id;
          } else {
            const createdPlan = this.planService.createPlan({
              id: `plan-light-${payload.id}`,
              projectId: this.projectId,
              title: payload.title,
              summary: `Auto-created lightweight plan for task '${payload.title}'.`,
              phases: [{ id: 'phase-work', order: 0, status: 'active' }],
              checkpoints: [],
            });
            payload.planId = createdPlan.id;
            autoPlanId = createdPlan.id;
          }
        }

        payload.phaseId = this._ensurePlanPhase(payload.planId, payload.phaseId);
        const created = this.taskService.createTask(payload, this.projectRoot);
        const started = this.taskService.activateTask(created.id, this.projectRoot);
        this.syncEngine.exportGraphToJson(this.projectId, this.projectRoot);

        if (format === 'json') {
          return {
            task: started,
            autoPlanId,
            lightweight: Boolean(autoPlanId),
          };
        }
        return `Task '${started.id}' started in state '${started.status}'.${autoPlanId ? ` Auto-created lightweight plan '${autoPlanId}'.` : ''}`;
      }
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
      case 'finish': {
        let resolvedCheckData = { ...checkData };
        if (!resolvedCheckData.receiptId && !resolvedCheckData.evidence) {
          if (!resolvedCheckData.command) {
            throw new Error("task.finish requires checkData.command, checkData.receiptId, or checkData.evidence");
          }
          const receipt = await this.runCommand({
            command: resolvedCheckData.command,
            cwd: resolvedCheckData.cwd,
            maxChars: resolvedCheckData.maxChars,
            timeoutMs: resolvedCheckData.timeoutMs,
          });
          if (receipt.exitCode !== 0) {
            this.taskService.addNote(id, {
              text: `[Failed Check] ${resolvedCheckData.description || resolvedCheckData.command}: ${receipt.summary}`,
              kind: 'check',
            });
            const error = new Error(
              `task.finish check failed with exit code ${receipt.exitCode}. Receipt: ${receipt.id}. Log: ${receipt.logHandle || 'N/A'}`
            );
            error.receipt = receipt;
            throw error;
          }
          resolvedCheckData = {
            ...resolvedCheckData,
            receiptId: receipt.id,
            passed: resolvedCheckData.passed !== false,
            description: resolvedCheckData.description || resolvedCheckData.command,
          };
        }

        const check = this.taskService.addCheck(id, resolvedCheckData, this.projectRoot, this.projectId);
        const result = this.taskService.syncTask(id, {
          ...syncData,
          projectRoot: this.projectRoot,
          projectId: this.projectId,
        });

        let completedPlan = null;
        const plan = this.db.getPlan(result.task.planId);
        if (plan && plan.id.startsWith('plan-light-') && (!plan.checkpoints || plan.checkpoints.length === 0)) {
          const tasks = this.db.listTasks(plan.id);
          if (tasks.length > 0 && tasks.every((task) => task.status === 'completed')) {
            completedPlan = this.planService.completePlan(plan.id, {
              completedSummary: `Lightweight task '${result.task.title}' completed.`,
            });
            this.syncEngine.exportGraphToJson(this.projectId, this.projectRoot);
          }
        }

        if (format === 'json') {
          return {
            ...result,
            check,
            completedPlan,
          };
        }
        return `Task '${id}' finished and synced.\nRevision: ${result.graphRevision}\nCoverage: ${result.syncResult.coverage.coveragePercent}%${completedPlan ? `\nLightweight plan '${completedPlan.id}' completed.` : ''}`;
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

  async block(input) {
    return this._withWriteLock('block', () => this._block(input));
  }

  async _block({
    action,
    id,
    blockData = {},
    query,
    path: targetPath,
    paths = [],
    symbols = [],
    hashMode = null,
    manifest = null,
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
            return {
              path: this._resolveProjectPath(ref, 'artifactRef path').relativePath,
              role: 'implementation',
            };
          }
          if (!ref?.path) return ref;
          return {
            ...ref,
            path: this._resolveProjectPath(ref.path, 'artifactRef path').relativePath,
            manifest: ref.manifest
              ? this._resolveProjectPath(ref.manifest, 'artifactRef manifest').relativePath
              : null,
          };
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
        const existing = this.db.getBlock(targetId) || {
          id: targetId,
          projectId: this.projectId,
          title: blockData?.title || targetId,
          kind: blockData?.kind || 'service',
          summary: blockData?.summary || '',
          details: blockData?.details || '',
          artifactRefs: [],
        };

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
          const resolvedPath = this._resolveProjectPath(inputPath, 'path');
          const cleanRelPath = resolvedPath.relativePath;
          const fullPath = resolvedPath.fullPath;

          if (!fs.existsSync(fullPath)) {
            throw new Error(`File not found on disk: '${cleanRelPath}' (resolved at: ${fullPath})`);
          }

          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            const resolvedManifest = manifest
              ? this._resolveProjectPath(manifest, 'manifest').relativePath
              : findDirectoryManifest(this.projectRoot, cleanRelPath);
            const resolved = calculateTreeHash(this.projectRoot, cleanRelPath, {
              hashMode: hashMode || (resolvedManifest ? 'manifest' : 'content'),
              manifest: resolvedManifest,
            });
            autoArtifactRefs.push({
              path: cleanRelPath,
              anchorKind: 'tree',
              hash: resolved.hash,
              role: blockData?.kind === 'dependency' ? 'dependency' : 'resource',
              hashMode: resolved.hashMode,
              manifest: resolved.manifest,
            });
            continue;
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
          const declaredSymbols = fileSymbols.filter((symbol) => symbol.kind !== 'file');
          let matchedSymbols = declaredSymbols;

          if (symbolFilters.size > 0) {
            matchedSymbols = declaredSymbols.filter((s) => symbolFilters.has(s.name));
          }

          if (matchedSymbols.length > 0) {
            const CONTAINER_KINDS = new Set(['class', 'struct', 'trait', 'interface', 'extension', 'impl', 'record', 'object', 'enum']);
            const topLevelOnly = matchedSymbols.filter((s) => CONTAINER_KINDS.has(s.kind) || s.kind === 'function');
            const targetSymbols = topLevelOnly.length > 0 ? topLevelOnly : matchedSymbols;

            for (const sym of targetSymbols) {
              autoArtifactRefs.push({
                path: cleanRelPath,
                anchorKind: 'symbol',
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
              anchorKind: 'file',
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
        const treeRefs = autoArtifactRefs.filter((ref) => ref.anchorKind === 'tree');
        const symbolRefs = autoArtifactRefs.filter((ref) => ref.anchorKind !== 'tree');
        return `✅ Smart Auto-Bound Block '${targetId}':\n` +
          `- Extracted ${symbolRefs.length} symbol ref(s) and ${treeRefs.length} directory tree(s) from ${rawPaths.length} path(s).\n` +
          autoArtifactRefs.map((r) => r.anchorKind === 'tree'
            ? `  • \`${r.path}\` -> **TREE/${r.hashMode}** (hash: \`${r.hash}\`${r.manifest ? `, manifest: \`${r.manifest}\`` : ''})`
            : `  • \`${r.path}\` -> **${r.symbol}** [L${r.startLine}-L${r.endLine}] (hash: \`${r.hash}\`)`).join('\n') +
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
  async chain(input) {
    return this._withWriteLock('chain', () => this._chain(input));
  }

  async _chain({ action, id, chainData = {}, linkData = {}, format = 'markdown' }) {
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
      case 'validate':
      case 'validate_layout': {
        const blocks = this.db.listBlocks(this.projectId);
        const chains = this.db.listChains(this.projectId);
        const links = this.db.listLinks(this.projectId);
        const blockIds = new Set(blocks.map((block) => block.id));
        const chainedIds = new Set(chains.flatMap((chain) => chain.memberIds || []));
        const missingMembers = chains.flatMap((chain) =>
          (chain.memberIds || [])
            .filter((blockId) => !blockIds.has(blockId))
            .map((blockId) => ({ chainId: chain.id, blockId }))
        );
        const orphanBlocks = blocks
          .filter((block) => !chainedIds.has(block.id))
          .map((block) => block.id);
        const danglingLinks = links
          .filter((link) => !blockIds.has(link.from) || !blockIds.has(link.to))
          .map((link) => link.id);
        const layout = NetworkLayoutEngine.computeLayout({ blocks, chains, links });
        return {
          valid: missingMembers.length === 0 && orphanBlocks.length === 0 && danglingLinks.length === 0,
          nodeCount: layout.nodes.length,
          edgeCount: layout.edges.length,
          bounds: layout.bounds,
          orphanBlocks,
          missingMembers,
          danglingLinks,
        };
      }
      default:
        throw new Error(`Unknown chain action: ${action}`);
    }
  }

  // ================= 6. code =================
  async code(input) {
    return this._withWriteLock('code', () => this._code(input));
  }

  async _code({ action, path: relPath, selector, startLine, endLine, targetContent, replacementContent, content: rawContent, query, format = 'markdown' }) {
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
    const resolvedPath = this._resolveProjectPath(relPath, 'path');
    relPath = resolvedPath.relativePath;
    const fullPath = resolvedPath.fullPath;

    if (action === 'create') {
      if (fs.existsSync(fullPath)) {
        throw new Error(`File already exists: ${relPath}. Use action 'edit' for existing files.`);
      }
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      const initialContent = replacementContent || rawContent || '';
      fs.writeFileSync(fullPath, initialContent, 'utf8');
      const res = CodeTools.create(relPath, initialContent);

      const activeTask = this.taskService.findActiveTask(this.projectId);
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

        const activeTask = this.taskService.findActiveTask(this.projectId);
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
  async runCommand({
    command,
    cwd,
    maxChars = 1500,
    timeoutMs = 60000,
  }) {
    const targetCwd = cwd
      ? this._resolveProjectPath(cwd, 'cwd').fullPath
      : this.projectRoot;
    const receipt = await runCommand({
      command,
      cwd: targetCwd,
      maxChars,
      timeoutMs,
      projectRoot: this.projectRoot,
    });

    await this._withWriteLock('run_command.record', async () => {
      this.db.saveCommandReceipt(receipt);
    });

    return receipt;
  }

  // ================= 8. process =================
  async process(input) {
    return this._withWriteLock('process', () => this._process(input));
  }

  async _process({ action, command, id, lines = 50, grep }) {
    switch (action) {
      case 'start':
        return this.processManager.startProcess({ id, command });
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
  async knowledge(input) {
    return this._withWriteLock('knowledge', () => this._knowledge(input));
  }

  async _knowledge({ action, ruleId, ruleData = {}, sectionId, sectionTitle, content, format = 'markdown' }) {
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
