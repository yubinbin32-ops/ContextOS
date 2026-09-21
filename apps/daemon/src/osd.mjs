#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { V2Database, SyncEngine } from '../../../packages/storage/src/index.mjs';
import { IPCServer, getSocketPath } from '../../../packages/protocol/src/index.mjs';

export class Daemon {
  constructor({ projectRoot = process.cwd(), projectId = 'default' }) {
    this.projectRoot = path.resolve(projectRoot);
    this.projectId = projectId;
    this.dbPath = path.join(this.projectRoot, '.contextos', 'state.sqlite');
    this.db = new V2Database(this.dbPath);
    this.db.ensureProject(this.projectId, this.projectRoot);
    this.syncEngine = new SyncEngine(this.db);
    this.socketPath = getSocketPath(this.projectRoot);
    this.ipcServer = null;
    this.runningProcesses = new Map();
  }

  async start() {
    // Initial reconciliation with graph.json if it exists
    this.syncEngine.reconcileExternalChange(this.projectId, this.projectRoot);

    this.ipcServer = new IPCServer({
      socketPath: this.socketPath,
      handler: this.handleMessage.bind(this),
    });

    await this.ipcServer.start();
    return { socketPath: this.socketPath };
  }

  async stop() {
    if (this.ipcServer) {
      await this.ipcServer.stop();
      this.ipcServer = null;
    }
    this.db.close();
  }

  async handleMessage(method, params = {}) {
    const result = await this._handleMessage(method, params);
    // graph.json is a derived projection: publish once per request.
    try { this.syncEngine.publishIfDirty(this.projectId, this.projectRoot); } catch (_) {}
    return result;
  }

  async _handleMessage(method, params = {}) {
    switch (method) {
      case 'ping':
        return { pong: true, timestamp: Date.now() };

      case 'status': {
        const project = this.db.getProject(this.projectId);
        const plans = this.db.listPlans(this.projectId);
        const blocks = this.db.listBlocks(this.projectId);
        const chains = this.db.listChains(this.projectId);
        return {
          projectId: this.projectId,
          repoRoot: this.projectRoot,
          graphRevision: project ? project.graph_revision : 0,
          planCount: plans.length,
          blockCount: blocks.length,
          chainCount: chains.length,
          activeProcesses: this.runningProcesses.size,
        };
      }

      // --- Plan & Task ---
      case 'plan_save':
        this.db.savePlan(params.plan);
        this.syncEngine.exportGraphToJson(this.projectId, this.projectRoot);
        return this.db.getPlan(params.plan.id);

      case 'plan_get':
        return this.db.getPlan(params.planId);

      case 'plan_list':
        return this.db.listPlans(this.projectId);

      case 'task_save':
        this.db.saveTask(params.task);
        this.syncEngine.exportGraphToJson(this.projectId, this.projectRoot);
        return this.db.getTask(params.task.id);

      case 'task_get':
        return this.db.getTask(params.taskId);

      case 'task_list':
        return this.db.listTasks(params.planId);

      // --- Block & Chain ---
      case 'block_save':
        this.db.saveBlock(params.block);
        this.syncEngine.exportGraphToJson(this.projectId, this.projectRoot);
        return this.db.getBlock(params.block.id);

      case 'block_get':
        return this.db.getBlock(params.blockId);

      case 'block_list':
        return this.db.listBlocks(this.projectId);

      case 'chain_save':
        this.db.saveChain(params.chain);
        this.syncEngine.exportGraphToJson(this.projectId, this.projectRoot);
        return this.db.getChain(params.chain.id);

      case 'chain_get':
        return this.db.getChain(params.chainId);

      case 'chain_list':
        return this.db.listChains(this.projectId);

      case 'link_save':
        this.db.saveLink(params.link);
        this.syncEngine.exportGraphToJson(this.projectId, this.projectRoot);
        return { saved: true };

      case 'link_list':
        return this.db.listLinks(this.projectId);

      // --- Sync ---
      case 'sync_export':
        return this.syncEngine.exportGraphToJson(this.projectId, this.projectRoot);

      case 'sync_reconcile':
        return this.syncEngine.reconcileExternalChange(this.projectId, this.projectRoot);

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }
}

// If executed directly from CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const projectRoot = process.argv[2] || process.cwd();
  const daemon = new Daemon({ projectRoot });
  daemon.start().then(({ socketPath }) => {
    console.log(`ContextOS Daemon started on ${socketPath}`);
  }).catch((err) => {
    console.error('Failed to start daemon:', err);
    process.exit(1);
  });

  process.on('SIGINT', async () => {
    await daemon.stop();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await daemon.stop();
    process.exit(0);
  });
}
