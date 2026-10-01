import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initProjectWorkspace,
  deriveProjectId,
  syncAllPlatforms,
  detectInstalledPlatforms,
  resolveNodeExecutable,
  deployCanonicalServer,
} from './bootstrap-util.mjs';
import { evictServices, findBundledPluginRoot, requireProjectRoot } from './service-factory.mjs';
import packageMetadata from '../../../package.json' with { type: 'json' };

/**
 * System-level capabilities (init / doctor) shared by the V2 facades and
 * the V3 `ops` passthrough. Each returns the markdown text already rendered for
 * the caller, so both MCP surfaces stay byte-identical.
 */

export function runInit(input) {
  const root = requireProjectRoot(input.projectRoot);

  const config = initProjectWorkspace({
    projectRoot: root,
    mode: input.mode,
    projectId: input.projectId || deriveProjectId(root),
  });

  evictServices(root);

  let editorSummary = '';
  if (input.injectEditors) {
    const nodePath = resolveNodeExecutable();
    const serverScript = deployCanonicalServer();
    const pluginRoot = findBundledPluginRoot();
    const skillSource = path.join(pluginRoot, 'plugins', 'contextos', 'skills', 'contextos');
    const pluginSource = path.join(findBundledPluginRoot(), 'plugins', 'contextos');
    const modified = syncAllPlatforms({
      serverScript,
      nodePath,
      targetRoot: root,
      skillSource,
      pluginSource,
      selectedPlatforms: input.platforms,
      version: process.env.CONTEXTOS_VERSION || packageMetadata.version,
    });
    editorSummary = `\n\nInjected MCP & Skills into:\n${modified.map((m) => `  ✓ ${m}`).join('\n')}`;
  }

  return `✓ Initialized ContextOS in **${config.storage.toUpperCase()}** mode for project \`${config.id}\` at \`${root}\`.${editorSummary}`;
}

export async function runDoctor(input) {
  const root = requireProjectRoot(input.projectRoot);
  const nodePath = resolveNodeExecutable();
  const nodeVer = process.version;
  const projJsonPath = path.join(root, '.contextos', 'project.json');
  let projectConfig = null;
  if (fs.existsSync(projJsonPath)) {
    try {
      projectConfig = JSON.parse(fs.readFileSync(projJsonPath, 'utf8'));
    } catch (_) {}
  }

  const mode = 'local';
  const projectId = projectConfig?.id || deriveProjectId(root);
  const legacyCloud = projectConfig?.storage === 'cloud' || projectConfig?.isCloud === true || projectConfig?.localMigration?.from === 'cloud';

  let graphIntegrity = 'No saved graph (cold start)';
  const graphPath = path.join(root, '.contextos', 'graph.json');
  if (fs.existsSync(graphPath)) {
    try {
      const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
      const blocks = graph.data?.blocks;
      if (!Array.isArray(blocks)) graphIntegrity = 'Invalid graph: missing data.blocks array';
      else {
        const legacyRefs = Array.isArray(graph.data?.source_refs) ? graph.data.source_refs : [];
        const unanchored = blocks.filter((block) => !(Array.isArray(block.artifactRefs) && block.artifactRefs.length) &&
          !legacyRefs.some((ref) => (ref.blockId || ref.block_id) === block.id));
        graphIntegrity = unanchored.length
          ? `Invalid graph: ${unanchored.length} unanchored Block(s): ${unanchored.slice(0, 5).map((b) => b.id).join(', ')}. Restore real source references before normal operations; saved data was not changed.`
          : 'Anchors present (normal source validation still required)';
      }
    } catch (err) { graphIntegrity = `Invalid graph JSON: ${err.message}`; }
  }
  const platforms = detectInstalledPlatforms();
  const contextosHome = process.env.CONTEXTOS_HOME || path.join(os.homedir(), '.contextos');
  const globalProfilePath = path.join(contextosHome, 'profile.json');
  const editorStatuses = platforms
    .map((p) => `  - **${p.name}**: ${p.isInstalled ? 'Installed' : 'Not detected'} (\`${p.configPath}\`)`)
    .join('\n');

  return [
    `# ContextOS Doctor Report`,
    `- **Node Runtime**: \`${nodePath}\` (${nodeVer})`,
    `- **Project Root**: \`${root}\``,
    `- **Project ID**: \`${projectId}\``,
    `- **Active Storage Mode**: \`${mode}\``,
    `- **ContextOS Home**: \`${contextosHome}\``,
    `- **Global Profile**: \`${globalProfilePath}\` (${fs.existsSync(globalProfilePath) ? 'present' : 'missing'})`,
    ...(legacyCloud ? ['- **Legacy storage**: Local data is preserved. Remote-only data was not downloaded; import an existing export separately.'] : []),
    `- **Saved Graph Integrity**: ${graphIntegrity}`,
    ``,
    `## Detected Editors on System:`,
    editorStatuses,
  ].join('\n');
}
