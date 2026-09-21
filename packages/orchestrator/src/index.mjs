import { SessionStore } from './session-store.mjs';
import { Tracer } from './tracer.mjs';
import { createCapabilities } from './capabilities.mjs';
import { loadProfile, saveProfile } from './profile.mjs';
import { changePipeline, explorePipeline, shipPipeline, verifyPipeline } from './pipelines.mjs';

export * from './context-budget.mjs';
export * from './intent-router.mjs';
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
];

function render(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
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
      await service.osContext({ action: 'reconcile' });
    } catch (_) {}
    if (typeof service.healStateConflict === 'function') {
      try {
        this.healed = service.healStateConflict();
      } catch (_) {
        this.healed = null;
      }
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
    };
  }

  async dispatch(tool, input = {}) {
    await this._selfHeal();
    const seed = this.store.current || this.store.ensureSession(input.intent || input.summary || '');
    const tracer = new Tracer({ projectRoot: this.projectRoot, sessionId: seed.id });
    const ctx = this._context(tracer);
    if (this.healed) tracer.step('heal', this.healed);
    try {
      switch (tool) {
        case 'explore':
          return await explorePipeline(ctx, input);
        case 'change':
          return await changePipeline(ctx, input);
        case 'verify':
          return await verifyPipeline(ctx, input);
        case 'ship':
          return await shipPipeline(ctx, input);
        case 'ops':
          return await this._ops(ctx, input);
        default:
          throw new Error(`Unknown orchestrator tool '${tool}'`);
      }
    } finally {
      // graph.json is a derived projection: publish once, at the boundary.
      try {
        this.service?.syncEngine?.publishIfDirty(this.projectId, this.projectRoot);
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
        return render(store.current || { status: 'no-open-session' });
      }
      case 'profile': {
        if (action === 'set') return render(saveProfile(this.projectRoot, args));
        return render(loadProfile(this.projectRoot));
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
