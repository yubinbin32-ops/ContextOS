import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function calculateSha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export class SyncEngine {
  constructor(db) {
    this.db = db;
  }

  _parseGraph(jsonText) {
    try {
      return JSON.parse(jsonText);
    } catch (error) {
      throw new Error(`Invalid JSON syntax in graph: ${error.message}`);
    }
  }

  _lastExportedHash(projectId) {
    return (
      this.db.getSyncState(`last_exported_hash:${projectId}`) ||
      this.db.getSyncState('last_exported_hash')
    );
  }

  /**
   * graph.json is the versioned artifact (it rides in git). If someone rewrote
   * it after our last export (git checkout / revert / pull), that copy wins even
   * when its revision is older: the code was reverted, so the OS rolls back too.
   */
  graphEditedExternally(projectId, projectRoot) {
    const targetFile = path.join(projectRoot, '.contextos', 'graph.json');
    if (!fs.existsSync(targetFile)) return false;
    const lastHash = this._lastExportedHash(projectId);
    if (!lastHash) return true;
    // Every OS write ends with an export that records the hash, so anything
    // else on disk came from outside: git checkout, revert, pull, hand edit.
    return calculateSha256(fs.readFileSync(targetFile, 'utf8')) !== lastHash;
  }

  _buildGraph(projectId, graphRevision) {
    const project = this.db.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found in database`);

    const plans = this.db.listPlans(projectId).sort((a, b) => a.id.localeCompare(b.id));
    const planIds = new Set(plans.map((plan) => plan.id));
    const tasks = this.db
      .listTasks()
      .filter((task) => planIds.has(task.planId))
      .map((task) => ({
        id: task.id,
        planId: task.planId,
        phaseId: task.phaseId,
        title: task.title,
        status: task.status,
        contextSlice: {
          objective: task.contextSlice?.objective || '',
          constraints: task.contextSlice?.constraints || [],
          references: task.contextSlice?.references || [],
          nextSteps: task.contextSlice?.nextSteps || [],
          openQuestions: task.contextSlice?.openQuestions || [],
        },
        workingSet: task.workingSet || {},
        references: task.references || {},
        rules: task.rules || task.references?.rules || [],
        notes: task.notes || [],
        checks: task.checks || [],
        syncResult: task.syncResult || null,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const blocks = this.db.listBlocks(projectId).sort((a, b) => a.id.localeCompare(b.id));
    const chains = this.db.listChains(projectId).sort((a, b) => a.id.localeCompare(b.id));
    const links = this.db.listLinks(projectId).sort((a, b) => a.id.localeCompare(b.id));

    const graph = {
      schemaVersion: 3,
      projectId,
      graphRevision,
      exportedAt: new Date().toISOString(),
      data: {
        plans,
        tasks,
        blocks,
        chains,
        links,
      },
    };

    const jsonText = JSON.stringify(graph, null, 2) + '\n';
    return {
      project,
      graph,
      jsonText,
      sha256: calculateSha256(jsonText),
    };
  }

  _writeGraphFile(projectRoot, jsonText) {
    const targetDir = path.join(projectRoot, '.contextos');
    fs.mkdirSync(targetDir, { recursive: true });
    const targetFile = path.join(targetDir, 'graph.json');
    const tempFile = path.join(targetDir, `graph.json.tmp.${process.pid}.${Date.now()}`);
    let fd = null;
    try {
      fd = fs.openSync(tempFile, 'w');
      fs.writeFileSync(fd, jsonText, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tempFile, targetFile);
      return targetFile;
    } catch (err) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch (_) {}
      }
      try {
        fs.rmSync(tempFile, { force: true });
      } catch (_) {}
      throw err;
    }
  }

  flushGraphOutbox(projectId, projectRoot) {
    const outbox = this.db.getGraphOutbox(projectId);
    if (!outbox) return null;

    const project = this.db.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found in database`);
    if ((project.graph_revision || 0) !== outbox.baseRevision) {
      if ((project.graph_revision || 0) >= outbox.targetRevision) {
        this.db.deleteGraphOutbox(projectId);
        return {
          graphRevision: project.graph_revision,
          sha256: this._lastExportedHash(projectId),
          targetFile: path.join(projectRoot, '.contextos', 'graph.json'),
        };
      }
      throw new Error(
        `Graph export revision conflict for '${projectId}': database=${project.graph_revision}, base=${outbox.baseRevision}`
      );
    }

    // Idempotent: an export that would rewrite the same bytes must not bump
    // the graph revision (the canvas and git both watch that number).
    const lastHash = this._lastExportedHash(projectId);
    if (lastHash && outbox.payloadHash === lastHash) {
      this.db.deleteGraphOutbox(projectId);
      return {
        changed: false,
        reason: 'Payload identical to last export',
        graphRevision: project.graph_revision,
        sha256: lastHash,
        targetFile: path.join(projectRoot, '.contextos', 'graph.json'),
      };
    }

    const targetFile = this._writeGraphFile(projectRoot, outbox.payloadJson);
    const actualSha256 = calculateSha256(fs.readFileSync(targetFile, 'utf8'));
    if (actualSha256 !== outbox.payloadHash) {
      throw new Error(`Graph export hash verification failed for '${projectId}'`);
    }

    this.db.setGraphExported(projectId, outbox.targetRevision, outbox.payloadHash);
    return {
      graphRevision: outbox.targetRevision,
      sha256: outbox.payloadHash,
      targetFile,
    };
  }

  recoverGraphOutbox(projectId, projectRoot) {
    const result = this.flushGraphOutbox(projectId, projectRoot);
    return result
      ? { recovered: true, ...result }
      : { recovered: false };
  }

  queueGraphToJson(projectId) {
    const project = this.db.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found in database`);

    const targetRevision = (project.graph_revision || 0) + 1;
    const payload = this._buildGraph(projectId, targetRevision);
    return this.db.saveGraphOutbox({
      projectId,
      baseRevision: project.graph_revision || 0,
      targetRevision,
      payloadHash: payload.sha256,
      payloadJson: payload.jsonText,
    });
  }

  exportGraphToJson(projectId, projectRoot) {
    this.flushGraphOutbox(projectId, projectRoot);
    this.queueGraphToJson(projectId);

    return this.flushGraphOutbox(projectId, projectRoot);
  }

  /**
   * The one and only publisher: SQLite marks the project dirty through
   * triggers, callers just give it a moment to run (end of a dispatch, end of
   * a daemon message). Nothing else has to remember to export.
   */
  publishIfDirty(projectId, projectRoot) {
    if (!this.db.isGraphDirty(projectId)) return { changed: false, reason: 'clean' };
    this.queueGraphToJson(projectId);
    const result = this.flushGraphOutbox(projectId, projectRoot);
    this.db.clearGraphDirty(projectId);
    return result || { changed: false, reason: 'no outbox' };
  }

  importGraphFromJson(jsonText, projectRoot) {
    const graph = this._parseGraph(jsonText);

    const projectId = graph.projectId || graph.project?.id || graph.id || 'contextos';
    const graphRevision = graph.graphRevision || graph.project?.graphRevision || 0;
    const sha256 = calculateSha256(jsonText);

    const data = graph.data || {};

    let blocks = data.blocks || [];
    if (graph.schemaVersion === 1 && Array.isArray(data.source_refs)) {
      const refsByBlock = new Map();
      for (const ref of data.source_refs) {
        const bId = ref.block_id || ref.blockId;
        if (!refsByBlock.has(bId)) refsByBlock.set(bId, []);
        refsByBlock.get(bId).push({
          path: ref.path,
          symbol: ref.symbol,
          startLine: ref.start_line ?? ref.startLine,
          endLine: ref.end_line ?? ref.endLine,
          hash: ref.hash || '',
          role: ref.role || 'implementation',
        });
      }
      blocks = blocks.map((b) => {
        const refs = b.artifactRefs || refsByBlock.get(b.id);
        if (!Array.isArray(refs) || refs.length === 0) {
          throw new Error(`Ghost Block rejected during graph import: Block '${b.id}' has no artifactRefs.`);
        }
        return { ...b, artifactRefs: refs };
      });
    }

    // Execute atomic replace of active projection
    this.db.transaction((db) => {
      db.ensureProject(projectId, projectRoot);
      db.setGraphRevision(projectId, graphRevision);

      // Clear existing project data
      db.db.prepare('DELETE FROM plans WHERE project_id = ?').run(projectId);
      db.db.prepare('DELETE FROM blocks WHERE project_id = ?').run(projectId);
      db.db.prepare('DELETE FROM chains WHERE project_id = ?').run(projectId);
      db.db.prepare('DELETE FROM links WHERE project_id = ?').run(projectId);

      const plans = data.plans || [];
      const planIds = new Set(plans.map((plan) => plan.id));

      for (const plan of plans) {
        db.savePlan({ ...plan, projectId });
      }

      for (const task of data.tasks || []) {
        const planId = task.planId || task.plan_id;
        if (!planIds.has(planId)) continue;
        db.saveTask({ ...task, planId, phaseId: task.phaseId || task.phase_id || 'P0' });
      }

      for (const block of blocks) {
        db.saveBlock({ ...block, projectId });
      }

      for (const chain of data.chains || []) {
        db.saveChain({ ...chain, projectId });
      }

      for (const link of data.links || []) {
        db.saveLink({ ...link, projectId });
      }

      db.setGraphExported(projectId, graphRevision, sha256);
    });

    return {
      projectId,
      graphRevision,
      sha256,
    };
  }

  reconcileExternalChange(projectId, projectRoot) {
    this.recoverGraphOutbox(projectId, projectRoot);

    const targetFile = path.join(projectRoot, '.contextos', 'graph.json');
    if (!fs.existsSync(targetFile)) {
      return { changed: false, reason: 'File does not exist' };
    }

    const jsonText = fs.readFileSync(targetFile, 'utf8');
    const currentSha256 = calculateSha256(jsonText);
    const lastHash = this._lastExportedHash(projectId);

    if (currentSha256 === lastHash) {
      return { changed: false, reason: 'Hash identical to last export' };
    }

    const graph = this._parseGraph(jsonText);

    const project = this.db.getProject(projectId);
    const currentRevision = project?.graph_revision || 0;
    const incomingRevision = graph.graphRevision || graph.project?.graphRevision || 0;
    const externallyEdited = this.graphEditedExternally(projectId, projectRoot);

    if (incomingRevision === currentRevision && !externallyEdited) {
      return {
        changed: false,
        conflict: true,
        reason: `Graph revision ${incomingRevision} diverged without a newer revision`,
        graphRevision: incomingRevision,
        databaseRevision: currentRevision,
      };
    }

    if (incomingRevision < currentRevision && !externallyEdited) {
      return {
        changed: false,
        conflict: true,
        reason: `Refusing stale graph rollback: graph revision ${incomingRevision} is older than database revision ${currentRevision}`,
        graphRevision: incomingRevision,
        databaseRevision: currentRevision,
      };
    }

    const importResult = this.importGraphFromJson(jsonText, projectRoot);
    return {
      changed: true,
      revision: importResult.graphRevision,
      sha256: currentSha256,
      rolledBack: incomingRevision < currentRevision,
    };
  }
}
