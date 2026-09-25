import { SessionStore } from './session-store.mjs';
import { Tracer } from './tracer.mjs';
import { createCapabilities } from './capabilities.mjs';
import { globalProfilePath, loadProfile, saveProfile } from './profile.mjs';
import { changePipeline, explorePipeline, inspectPipeline, pipelinePipeline, shipPipeline, verifyPipeline, workPipeline } from './pipelines.mjs';
import { MICRO_PRESETS, runMicroTask, runMicroTasksParallel } from './micro-client.mjs';
import { microPreloadReceipt, runMicroPreload } from './micro-preload.mjs';
import { buildMicroHistory, closeMicroSession, completeMicroTurn, createMicroSession, deleteMicroSession, failMicroTurn, listMicroSessions, microSessionSnapshot, readMicroSession, startMicroTurn } from './micro-session.mjs';
import { evictArtifacts, listArtifacts, readArtifact, statArtifact } from './artifact-store.mjs';
import { compactJson, finalizeResponse, projectMicroResult, summarizeMicroUsage } from './response-budget.mjs';
import { recordTelemetry, summarizeTelemetry } from './telemetry.mjs';

export * from './context-budget.mjs';
export * from './intent-router.mjs';
export * from './micro-client.mjs';
export * from './micro-preload.mjs';
export * from './micro-session.mjs';
export * from './module-index.mjs';
export * from './observer.mjs';
export * from './profile.mjs';
export * from './session-store.mjs';

export const OPS_CAPABILITIES = [
  'os_context',
  'plan',
  'task',
  'block',
  'chain',
  'code',
  'run_command',
  'process',
  'knowledge',
  'session',
  'system',
  'profile',
  'micro',
  'artifact',
  'telemetry',
];

function render(value) {
  return typeof value === 'string' ? value : compactJson(value);
}

/**
 * The OS-side orchestrator.
 *
 * The agent states an intent; the orchestrator picks and sequences the internal
 * capabilities itself, keeps every response inside a context budget, and records
 * a trace so the run stays debuggable.
 */
export class Orchestrator {
  constructor({ service, projectRoot, projectId, system = {} }) {
    this.service = service;
    this.projectRoot = projectRoot;
    this.projectId = projectId || service?.projectId || 'contextos';
    this.system = system;
    this.store = new SessionStore({ projectRoot: this.projectRoot, projectId: this.projectId });
    this.healed = null;
    this.healCompleted = false;
  }

  /**
   * The OS heals itself: a graph.json that diverged from SQLite used to wedge
   * every read/write entry point, which pushed agents back to reading whole
   * files by hand. Reconcile, then resolve the divergence before doing work.
   */
  async _selfHeal() {
    const { service } = this;
    if (!service || typeof service.osContext !== 'function') return;
    try {
      const graphDirty = typeof service.db?.isGraphDirty === 'function'
        ? service.db.isGraphDirty(this.projectId)
        : true;
      if (this.healCompleted && !graphDirty) return;
      await service.osContext({ action: 'reconcile' });
      if (typeof service.healStateConflict === 'function') {
        this.healed = service.healStateConflict();
      }
      this.healCompleted = true;
    } catch (_) {
      this.healed = null;
    }
  }

  _context(tracer) {
    return {
      service: this.service,
      caps: createCapabilities({ service: this.service, projectRoot: this.projectRoot, projectId: this.projectId }),
      store: this.store,
      tracer,
      profile: loadProfile(this.projectRoot),
      projectRoot: this.projectRoot,
      projectId: this.projectId,
      orchestrator: this,
    };
  }

  async dispatch(tool, input = {}) {
    await this._selfHeal();
    const seed = this.store.current || this.store.ensureSession(input.intent || input.summary || '');
    const tracer = new Tracer({ projectRoot: this.projectRoot, sessionId: seed.id });
    const ctx = this._context(tracer);
    if (this.healed) tracer.step('heal', this.healed);
    const startedAt = Date.now();
    const publishGraph = input.exportGraph === true
      || (tool === 'ship' && ctx.profile?.shipExportsGraph === true);
    try {
      let result;
      switch (tool) {
        case 'explore':
          result = await explorePipeline(ctx, input);
          break;
        case 'inspect':
          result = await inspectPipeline(ctx, input);
          break;
        case 'change':
          result = await changePipeline(ctx, input);
          break;
        case 'verify':
          result = await verifyPipeline(ctx, input);
          break;
        case 'ship':
          result = await shipPipeline(ctx, input);
          break;
        case 'ops':
          result = await this._ops(ctx, input);
          break;
        case 'pipeline':
          result = await pipelinePipeline(ctx, input);
          break;
        case 'work':
          result = await workPipeline(ctx, input);
          break;
        default:
          throw new Error(`Unknown orchestrator tool '${tool}'`);
      }
      if (typeof result !== 'string') return result;
      const full = input.full === true || input.budget === 'full' || input.mode === 'full';
      const finalized = finalizeResponse(result, {
        projectRoot: this.projectRoot,
        tool,
        maxChars: typeof input.maxChars === 'number' ? input.maxChars : undefined,
        full,
      });
      recordTelemetry(this.projectRoot, {
        sessionId: seed.id,
        tool,
        input,
        output: finalized.text,
        artifactId: finalized.meta.artifactId,
        truncated: finalized.meta.truncated,
        durationMs: Date.now() - startedAt,
      });
      return finalized.text;
    } finally {
      // graph.json is a derived projection: publish once, at the boundary.
      try {
        if (publishGraph) {
          this.service?.syncEngine?.publishIfDirty(this.projectId, this.projectRoot);
        }
      } catch (_) {}
      tracer.flush();
    }
  }

  async _ops(ctx, input = {}) {
    const { capability, action, args = {} } = input;
    const { service, store, tracer } = ctx;
    tracer.step('ops', { capability, action });

    switch (capability) {
      case 'os_context':
        return render(await service.osContext({ ...args, action }));
      case 'plan':
        return render(await service.plan({ ...args, action }));
      case 'task':
        return render(await service.task({ ...args, action }));
      case 'block':
        return render(await service.block({ ...args, action }));
      case 'chain':
        return render(await service.chain({ ...args, action }));
      case 'code':
        return render(await service.code({ ...args, action }));
      case 'run_command':
        return render(await service.runCommand(args));
      case 'process':
        return render(await service.process({ ...args, action }));
      case 'knowledge':
        return render(await service.knowledge({ ...args, action }));
      case 'session': {
        if (action === 'note') return render(store.note(args.text, args.kind || 'note'));
        if (action === 'close') return render(store.close(args.summary || ''));
        if (action === 'history') return render(store.recentHistory(args.limit || 5));
        if (action === 'resume') {
          const session = store.current;
          if (!session) return render({ status: 'no-open-session' });
          return render({
            id: session.id,
            status: session.status,
            intent: session.intent || null,
            files: (session.touchedFiles || []).slice(-8).map((entry) => entry.path),
            receipts: (session.receipts || []).slice(-3).map((receipt) => ({
              command: receipt.command,
              exitCode: receipt.exitCode,
              status: receipt.status,
            })),
            notes: (session.notes || []).slice(-3).map((entry) => entry.text),
          });
        }
        return render(store.current || { status: 'no-open-session' });
      }
      case 'profile': {
        if (action === 'set') {
          const { scope, ...patch } = args;
          return render(saveProfile(this.projectRoot, patch, { scope }));
        }
        return render(loadProfile(this.projectRoot));
      }
      case 'artifact': {
        if (action === 'read') {
          const artifact = readArtifact(this.projectRoot, args.id, args);
          if (!artifact) return `# ContextOS artifact\n- Not found: \`${args.id || '(missing)'}\``;
          return [
            `# ContextOS artifact ${artifact.id}`,
            `- Range: L${artifact.range.startLine}-L${artifact.range.endLine} (${artifact.returnedLines}/${artifact.totalLines} lines)`,
            `- Truncated: ${artifact.truncated}`,
            '',
            '```text',
            artifact.text,
            '```',
          ].join('\n');
        }
        if (action === 'stat') return render(statArtifact(this.projectRoot, args.id) || { ok: false, id: args.id, error: 'not-found' });
        if (action === 'list') return render(listArtifacts(this.projectRoot, { limit: args.limit || 20 }));
        if (action === 'evict') return render(evictArtifacts(this.projectRoot, args));
        throw new Error(`Unknown artifact action '${action}'. Available: read, stat, list, evict`);
      }
      case 'telemetry': {
        if (action === 'summary' || action === undefined) {
          return render({
            ...summarizeTelemetry(this.projectRoot, {
              sessionId: args.sessionId || store.current?.id || null,
              limit: args.limit,
            }),
            microProvider: summarizeMicroUsage(this.projectRoot, { limit: args.limit }),
          });
        }
        if (action === 'list') {
          return render({
            ...summarizeTelemetry(this.projectRoot, {
              sessionId: args.sessionId || null,
              limit: args.limit,
            }),
            microProvider: summarizeMicroUsage(this.projectRoot, { limit: args.limit }),
          });
        }
        throw new Error(`Unknown telemetry action '${action}'. Available: summary, list`);
      }
      case 'micro': {
        const microConfig = ctx.profile?.micro || {};
        if (action === 'doctor') {
          const checks = [
            { name: 'url', ok: Boolean(microConfig.url), value: microConfig.url || null },
            { name: 'model', ok: Boolean(microConfig.model), value: microConfig.model || null },
            { name: 'key', ok: Boolean(microConfig.key), value: microConfig.key ? 'configured' : 'missing' },
          ];
          return render({
            ok: checks.every((check) => check.ok),
            checks,
            globalProfile: globalProfilePath(),
            projectProfile: `${this.projectRoot}/.contextos/profile.json`,
          });
        }
        const microWithOS = Boolean(input.withOS || args.withOS);
        const caps = microWithOS ? ctx.caps : null;

        if (args.sessionAction) {
          const sessionAction = String(args.sessionAction);
          const sessionId = args.sessionId;
          if (sessionAction === 'create') {
            let existing = null;
            if (sessionId) {
              try {
                existing = readMicroSession(this.projectRoot, sessionId);
              } catch (error) {
                if (!/not found/i.test(error.message)) throw error;
              }
            }
            if (existing) return render({ ok: true, existing: true, session: microSessionSnapshot(existing) });
            const preload = args.preload ? await runMicroPreload(ctx, args.preload) : null;
            const session = createMicroSession(this.projectRoot, {
              ...args,
              withOS: microWithOS || Boolean(preload),
              preload,
            });
            return render({
              ok: true,
              session: microSessionSnapshot(session),
              ...(preload ? { preload: microPreloadReceipt(preload) } : {}),
            });
          }
          if (sessionAction === 'list') {
            return render({ ok: true, sessions: listMicroSessions(this.projectRoot) });
          }
          if (sessionAction === 'get') {
            return render({ ok: true, session: microSessionSnapshot(readMicroSession(this.projectRoot, sessionId)) });
          }
          if (sessionAction === 'close') {
            return render({ ok: true, session: closeMicroSession(this.projectRoot, sessionId) });
          }
          if (sessionAction === 'delete') {
            return render({ ok: true, deleted: deleteMicroSession(this.projectRoot, sessionId), sessionId: String(sessionId || '') });
          }
          if (sessionAction === 'send') {
            const session = startMicroTurn(this.projectRoot, sessionId, args.task || args.prompt || '');
            const preset = MICRO_PRESETS[session.preset] || null;
            const sessionWithOS = microWithOS || session.withOS;
            const sessionCaps = sessionWithOS ? ctx.caps : null;
            const history = buildMicroHistory(session, { systemPrompt: preset?.system || '' });
            try {
              const result = await runMicroTask(microConfig, {
                ...args,
                prompt: '',
                input: undefined,
                inputRef: undefined,
                inputReceipt: undefined,
                inputArtifact: undefined,
                history,
                preload: undefined,
                sessionId: session.id,
                sessionMode: 'persistent',
                withOS: sessionWithOS,
                outputMode: args.full ? 'full' : 'answer',
                caps: sessionCaps,
                projectRoot: this.projectRoot,
              });
              const projected = projectMicroResult(result, {
                projectRoot: this.projectRoot,
                full: args.full === true,
                maxChars: args.maxChars,
              });
              const nextSession = result.ok
                ? completeMicroTurn(this.projectRoot, session.id, { result, receiptId: projected.receiptId })
                : failMicroTurn(this.projectRoot, session.id);
              return render({ ...projected, session: nextSession });
            } catch (error) {
              failMicroTurn(this.projectRoot, session.id);
              throw error;
            }
          }
          throw new Error(`Unknown micro sessionAction '${sessionAction}'. Available: create, send, get, list, close, delete`);
        }

        if (action === 'batch') {
          const tasks = await Promise.all((args.tasks || []).map(async (task) => ({
            ...task,
            preload: task.preload ? await runMicroPreload(ctx, task.preload) : undefined,
          })));
          const batchWithOS = microWithOS || tasks.some((task) => Boolean(task.preload));
          const result = await runMicroTasksParallel(microConfig, tasks, { ...args, batch: true, withOS: batchWithOS, outputMode: args.full ? 'full' : 'answer', caps: batchWithOS ? ctx.caps : null, projectRoot: this.projectRoot });
          if (args.full === true) return render(result);
          return render({
            ok: result.ok,
            totalDurationMs: result.totalDurationMs,
            tasks: (result.tasks || []).map((task) => ({
              id: task.id,
              ...projectMicroResult(task, { projectRoot: this.projectRoot, maxChars: args.maxChars }),
              ...(task.preload ? { preload: microPreloadReceipt(task.preload) } : {}),
            })),
          });
        }
        const preload = args.preload ? await runMicroPreload(ctx, args.preload) : null;
        const effectiveWithOS = microWithOS || Boolean(preload);
        const result = await runMicroTask(microConfig, { ...args, preload, action, withOS: effectiveWithOS, outputMode: args.full ? 'full' : 'answer', caps: effectiveWithOS ? ctx.caps : null, projectRoot: this.projectRoot });
        return render({
          ...projectMicroResult(result, {
            projectRoot: this.projectRoot,
            full: args.full === true,
            maxChars: args.maxChars,
          }),
          ...(preload ? { preload: microPreloadReceipt(preload) } : {}),
        });
      }
      case 'system': {
        const fn = this.system[action];
        if (!fn) {
          throw new Error(`Unknown system action '${action}'. Available: ${Object.keys(this.system).join(', ')}`);
        }
        return render(await fn({ projectRoot: this.projectRoot, ...args }));
      }
      default:
        throw new Error(`Unknown capability '${capability}'. Available: ${OPS_CAPABILITIES.join(', ')}`);
    }
  }
}
