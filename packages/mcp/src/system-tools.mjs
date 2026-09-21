import fs from 'node:fs';
import path from 'node:path';
import { ContextOSV2Service } from './v2-service.mjs';
import { ContextOSCloudClient } from './cloud-client.mjs';
import {
  initProjectWorkspace,
  deriveProjectId,
  syncAllPlatforms,
  detectInstalledPlatforms,
  resolveNodeExecutable,
  deployCanonicalServer,
  getGlobalCloudConfig,
  saveGlobalCloudConfig,
} from './bootstrap-util.mjs';
import { evictServices, findBundledPluginRoot, projectDbPath, requireProjectRoot } from './service-factory.mjs';

/**
 * System-level capabilities (init / doctor / switch) shared by the V2 facades and
 * the V3 `ops` passthrough. Each returns the markdown text already rendered for
 * the caller, so both MCP surfaces stay byte-identical.
 */

export function runInit(input) {
  const root = requireProjectRoot(input.projectRoot);

  if (input.saveGlobalCloud && input.cloudUrl) {
    saveGlobalCloudConfig({ cloudUrl: input.cloudUrl, token: input.token });
  }

  let resolvedCloudUrl = input.cloudUrl;
  let resolvedToken = input.token;
  if (input.mode === 'cloud' && !resolvedCloudUrl) {
    const globalCloud = getGlobalCloudConfig();
    if (globalCloud?.cloudUrl) {
      resolvedCloudUrl = globalCloud.cloudUrl;
      if (!resolvedToken && globalCloud.token) resolvedToken = globalCloud.token;
    }
  }

  const config = initProjectWorkspace({
    projectRoot: root,
    mode: input.mode,
    cloudUrl: resolvedCloudUrl,
    token: resolvedToken,
    projectId: input.projectId || deriveProjectId(root),
  });

  evictServices(root);

  let editorSummary = '';
  if (input.injectEditors) {
    const nodePath = resolveNodeExecutable();
    const serverScript = deployCanonicalServer();
    let env = null;
    if (input.mode === 'cloud' && resolvedCloudUrl) {
      env = {
        CONTEXTOS_MODE: 'cloud',
        CONTEXTOS_CLOUD_URL: resolvedCloudUrl.replace(/\/+$/, ''),
        CONTEXTOS_PROJECT_ID: input.projectId || deriveProjectId(root),
      };
      if (resolvedToken) env.CONTEXTOS_CLOUD_TOKEN = resolvedToken;
    }
    const pluginRoot = findBundledPluginRoot();
    const skillSource = path.join(pluginRoot, 'plugins', 'contextos', 'skills', 'contextos');
    const pluginSource = path.join(findBundledPluginRoot(), 'plugins', 'contextos');
    const modified = syncAllPlatforms({
      serverScript,
      nodePath,
      env,
      targetRoot: root,
      skillSource,
      pluginSource,
      selectedPlatforms: input.platforms,
      version: process.env.CONTEXTOS_VERSION || null,
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

  const globalCloud = getGlobalCloudConfig();
  const mode = projectConfig?.storage || (process.env.CONTEXTOS_CLOUD_URL ? 'cloud (env)' : 'local (default)');
  const projectId = projectConfig?.id || process.env.CONTEXTOS_PROJECT_ID || deriveProjectId(root);
  const cloudUrl = projectConfig?.cloudUrl || globalCloud?.cloudUrl || process.env.CONTEXTOS_CLOUD_URL || 'N/A';

  let cloudHealth = 'N/A';
  if (mode.startsWith('cloud') && cloudUrl !== 'N/A') {
    try {
      const res = await fetch(`${cloudUrl.replace(/\/+$/, '')}/api/v2/health`, {
        headers: globalCloud?.token || process.env.CONTEXTOS_CLOUD_TOKEN
          ? { Authorization: `Bearer ${globalCloud?.token || process.env.CONTEXTOS_CLOUD_TOKEN}` }
          : {},
      });
      cloudHealth = res.ok ? '🟢 Connected (200 OK)' : `🔴 HTTP ${res.status}`;
    } catch (err) {
      cloudHealth = `🔴 Connection failed: ${err.message}`;
    }
  }

  const platforms = detectInstalledPlatforms();
  const editorStatuses = platforms
    .map((p) => `  - **${p.name}**: ${p.isInstalled ? 'Installed' : 'Not detected'} (\`${p.configPath}\`)`)
    .join('\n');

  return [
    `# ContextOS Doctor Report`,
    `- **Node Runtime**: \`${nodePath}\` (${nodeVer})`,
    `- **Project Root**: \`${root}\``,
    `- **Project ID**: \`${projectId}\``,
    `- **Active Storage Mode**: \`${mode}\``,
    `- **Cloud Hub URL**: \`${cloudUrl}\``,
    `- **Global Cloud Config**: ${globalCloud ? `Configured (\`${globalCloud.cloudUrl}\`)` : 'None'}`,
    `- **Cloud Hub Connectivity**: ${cloudHealth}`,
    ``,
    `## Detected Editors on System:`,
    editorStatuses,
  ].join('\n');
}

export async function runSwitch(input) {
  const root = requireProjectRoot(input.projectRoot);
  const dotContextos = path.join(root, '.contextos');
  const projJsonPath = path.join(dotContextos, 'project.json');
  let proj = {};
  if (fs.existsSync(projJsonPath)) {
    try {
      proj = JSON.parse(fs.readFileSync(projJsonPath, 'utf8'));
    } catch (_) {}
  }

  const globalCloud = getGlobalCloudConfig();
  const resolvedCloudUrl = input.targetMode === 'cloud'
    ? (input.cloudUrl || proj.cloudUrl || globalCloud?.cloudUrl || process.env.CONTEXTOS_CLOUD_URL)
    : (input.cloudUrl || proj.cloudUrl);
  const resolvedToken = input.token
    || (input.targetMode === 'cloud' ? (globalCloud?.token || process.env.CONTEXTOS_CLOUD_TOKEN) : null);
  const pid = input.projectId || proj.id || 'contextos';

  if (input.targetMode === 'cloud') {
    if (!resolvedCloudUrl) {
      throw new Error('Switching to cloud requires a cloudUrl. Provide cloudUrl or configure global credentials via ~/.contextos/cloud.json.');
    }

    let localSnapshot = { schemaVersion: 4, blocks: [], chains: [], links: [], plans: [], phases: [], checkpoints: [], tasks: [] };
    const dbFile = projectDbPath(root);
    if (fs.existsSync(dbFile)) {
      let localService;
      try {
        localService = new ContextOSV2Service({ projectRoot: root, projectId: pid });
        const blocks = localService.db.listBlocks(pid);
        const chains = localService.db.listChains(pid);
        const links = localService.db.listLinks(pid);
        const plans = localService.db.listPlans(pid);
        const tasks = plans.flatMap((plan) => localService.db.listTasks(plan.id));
        localSnapshot = {
          schemaVersion: 4,
          project: { id: pid, name: pid, root, graphRevision: localService.db.getProject(pid)?.graph_revision || 0 },
          changeSequence: localService.db.getProject(pid)?.graph_revision || 0,
          blocks,
          chains,
          links,
          plans,
          phases: plans.flatMap((plan) => (plan.phases || []).map((phase) => ({ ...phase, planId: plan.id }))),
          checkpoints: plans.flatMap((plan) => (plan.checkpoints || []).map((checkpoint) => ({ ...checkpoint, targetId: plan.id }))),
          tasks,
        };
      } catch (error) {
        throw new Error(`Cannot switch to cloud because the local graph could not be read: ${error.message}`);
      } finally {
        localService?.close();
      }
    }

    const cloudClient = new ContextOSCloudClient({ cloudUrl: resolvedCloudUrl, token: resolvedToken, projectId: pid });
    await cloudClient.pushSnapshot(localSnapshot, pid);

    proj.storage = 'cloud';
    proj.isCloud = true;
    proj.cloudUrl = resolvedCloudUrl.replace(/\/+$/, '');
    delete proj.token;
    delete proj.cloudToken;
    proj.updatedAt = new Date().toISOString();
    fs.writeFileSync(projJsonPath, JSON.stringify(proj, null, 2) + '\n', 'utf8');

    evictServices(root);

    return `✓ Successfully migrated project \`${pid}\` to **CLOUD** mode.\n- Uploaded ${localSnapshot.blocks.length} blocks, ${localSnapshot.chains.length} chains, ${localSnapshot.plans.length} plans, and ${localSnapshot.tasks?.length || 0} tasks to ${resolvedCloudUrl}.\n- All future task & plan changes will synchronize with Cloudflare D1.`;
  }

  if (resolvedCloudUrl) {
    try {
      const cloudClient = new ContextOSCloudClient({ cloudUrl: resolvedCloudUrl, token: resolvedToken, projectId: pid });
      const cloudSnapshot = await cloudClient.fetchSnapshot(pid);
      if (cloudSnapshot) {
        const localService = new ContextOSV2Service({ projectRoot: root, projectId: pid });
        localService.db.replaceProjectState(pid, cloudSnapshot);
        // The snapshot arrived from outside the OS: publish it to graph.json too.
        localService.syncEngine.exportGraphToJson(pid, root);
        localService.close();
      }
    } catch (e) {
      throw new Error(`Cannot switch to local because the cloud snapshot could not be pulled: ${e.message}`);
    }
  }

  proj.storage = 'local';
  proj.isCloud = false;
  delete proj.cloudUrl;
  delete proj.token;
  proj.updatedAt = new Date().toISOString();
  fs.writeFileSync(projJsonPath, JSON.stringify(proj, null, 2) + '\n', 'utf8');

  evictServices(root);

  return `✓ Successfully switched project \`${pid}\` to **LOCAL** mode.\n- Architecture snapshot is now stored in local SQLite.\n- Fully offline, private, and decoupled from Cloud Hub.`;
}
