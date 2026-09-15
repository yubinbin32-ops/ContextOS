import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function calculateSha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export class SyncEngine {
  constructor(db) {
    this.db = db;
  }

  exportGraphToJson(projectId, projectRoot) {
    const project = this.db.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found in database`);

    const plans = this.db.listPlans(projectId).sort((a, b) => a.id.localeCompare(b.id));
    const tasks = this.db.listTasks().sort((a, b) => a.id.localeCompare(b.id));
    const blocks = this.db.listBlocks(projectId).sort((a, b) => a.id.localeCompare(b.id));
    const chains = this.db.listChains(projectId).sort((a, b) => a.id.localeCompare(b.id));
    const links = this.db.listLinks(projectId).sort((a, b) => a.id.localeCompare(b.id));

    const newRevision = (project.graph_revision || 0) + 1;

    const graph = {
      schemaVersion: 2,
      projectId,
      graphRevision: newRevision,
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
    const sha256 = calculateSha256(jsonText);

    const targetDir = path.join(projectRoot, '.contextos');
    fs.mkdirSync(targetDir, { recursive: true });
    const targetFile = path.join(targetDir, 'graph.json');
    const tempFile = path.join(targetDir, `graph.json.tmp.${Date.now()}`);

    fs.writeFileSync(tempFile, jsonText, 'utf8');
    fs.renameSync(tempFile, targetFile);

    this.db.setGraphRevision(projectId, newRevision);
    this.db.setSyncState('last_exported_hash', sha256);

    return {
      graphRevision: newRevision,
      sha256,
      targetFile,
    };
  }

  importGraphFromJson(jsonText, projectRoot) {
    let graph;
    try {
      graph = JSON.parse(jsonText);
    } catch (err) {
      throw new Error(`Invalid JSON syntax in graph: ${err.message}`);
    }

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
      blocks = blocks.map((b) => ({
        ...b,
        artifactRefs: b.artifactRefs || refsByBlock.get(b.id) || [{ path: 'legacy.js' }],
      }));
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

      for (const plan of data.plans || []) {
        db.savePlan({ ...plan, projectId });
      }

      for (const task of data.tasks || []) {
        db.saveTask(task);
      }

      for (const block of blocks) {
        db.saveBlock({ ...block, projectId });
      }

      for (const chain of data.chains || []) {
        db.saveChain(chain);
      }

      for (const link of data.links || []) {
        db.saveLink(link);
      }

      db.setSyncState('last_exported_hash', sha256);
    });

    return {
      projectId: graph.projectId,
      graphRevision: graph.graphRevision,
      sha256,
    };
  }

  reconcileExternalChange(projectId, projectRoot) {
    const targetFile = path.join(projectRoot, '.contextos', 'graph.json');
    if (!fs.existsSync(targetFile)) {
      return { changed: false, reason: 'File does not exist' };
    }

    const jsonText = fs.readFileSync(targetFile, 'utf8');
    const currentSha256 = calculateSha256(jsonText);
    const lastHash = this.db.getSyncState('last_exported_hash');

    if (currentSha256 === lastHash) {
      return { changed: false, reason: 'Hash identical to last export' };
    }

    // External change detected! (e.g. Git rollback, checkout, or external edit)
    const importResult = this.importGraphFromJson(jsonText, projectRoot);
    return {
      changed: true,
      revision: importResult.graphRevision,
      sha256: currentSha256,
    };
  }
}
