import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { ContextOSV2Service } from './v2-service.mjs';
import { HybridContextOSService } from './hybrid-service.mjs';
import { ContextOSCloudClient } from './cloud-client.mjs';
import {
  initProjectWorkspace,
  syncAllPlatforms,
  detectInstalledPlatforms,
  resolveNodeExecutable,
  deployCanonicalServer,
  getGlobalCloudConfig,
  saveGlobalCloudConfig,
} from './bootstrap-util.mjs';

const serviceCache = new Map();

function findDefaultProjectRoot() {
  if (process.env.CONTEXTOS_PROJECT_ROOT && fs.existsSync(process.env.CONTEXTOS_PROJECT_ROOT)) {
    return process.env.CONTEXTOS_PROJECT_ROOT;
  }
  let cur = process.cwd();
  while (cur && cur !== path.dirname(cur)) {
    if (
      fs.existsSync(path.join(cur, '.contextos')) ||
      fs.existsSync(path.join(cur, '.git')) ||
      fs.existsSync(path.join(cur, 'package.json'))
    ) {
      return cur;
    }
    cur = path.dirname(cur);
  }
  if (
    cur &&
    (fs.existsSync(path.join(cur, '.contextos')) ||
      fs.existsSync(path.join(cur, '.git')) ||
      fs.existsSync(path.join(cur, 'package.json')))
  ) {
    return cur;
  }
  return process.cwd();
}

function getService(projectRoot) {
  const root = projectRoot || findDefaultProjectRoot();
  let mode = 'local';
  let cloudUrl = null;
  let token = null;
  let projectId = 'contextos';

  // 1. Inspect workspace .contextos/project.json for project-level isolation
  const projJsonPath = path.join(root, '.contextos', 'project.json');
  if (fs.existsSync(projJsonPath)) {
    try {
      const proj = JSON.parse(fs.readFileSync(projJsonPath, 'utf8'));
      if (proj.id) projectId = proj.id;
      if (proj.storage === 'cloud' || proj.isCloud === true) {
        mode = 'cloud';
        const globalCloud = getGlobalCloudConfig();
        cloudUrl = proj.cloudUrl || globalCloud?.cloudUrl || process.env.CONTEXTOS_CLOUD_URL || process.env.CONTEXTOS_REMOTE_URL;
        token = proj.token || proj.cloudToken || globalCloud?.token || process.env.CONTEXTOS_CLOUD_TOKEN || process.env.CONTEXTOS_TOKEN;
      } else if (proj.storage === 'local' || proj.isCloud === false) {
        mode = 'local';
      }
    } catch (_) {}
  } else {
    // 2. Fallback to global environment variables
    if (process.env.CONTEXTOS_CLOUD_URL || process.env.CONTEXTOS_REMOTE_URL) {
      mode = 'cloud';
      cloudUrl = process.env.CONTEXTOS_CLOUD_URL || process.env.CONTEXTOS_REMOTE_URL;
      token = process.env.CONTEXTOS_CLOUD_TOKEN || process.env.CONTEXTOS_TOKEN;
      projectId = process.env.CONTEXTOS_PROJECT_ID || 'contextos';
    }
  }

  const cacheKey = mode === 'cloud' && cloudUrl
    ? `cloud:${cloudUrl}:${projectId}:${root}`
    : `local:${root}:${projectId}`;

  if (!serviceCache.has(cacheKey)) {
    if (mode === 'cloud' && cloudUrl) {
      serviceCache.set(
        cacheKey,
        new HybridContextOSService({
          cloudUrl,
          token,
          projectId,
          projectRoot: root,
        })
      );
    } else {
      serviceCache.set(cacheKey, new ContextOSV2Service({ projectRoot: root, projectId }));
    }
  }
  return serviceCache.get(cacheKey);
}

function textResult(content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  return {
    content: [{ type: 'text', text }],
  };
}

export function createV2Server() {
  const server = new McpServer(
    { name: 'contextos', version: '2.2.1' },
    {
      instructions:
        'ContextOS V2 is a context operating system for AI coding agents (Local & Cloud compatible). Follow the C-D-C-S workflow: Create Plan & Task -> Develop (outline, surgical code read/edit, run_command, task note) -> Check (record test verification) -> Sync (bind real Blocks, commit state). Never read whole files unless outline/read is insufficient. Local shell and AST code edits execute locally, while project plans and architecture graphs synchronize with local SQLite or remote Cloud Hub.',
    }
  );

  // 1. os_context
  server.registerTool(
    'os_context',
    {
      description: 'Project context gateway. Use action=brief on session start or resume; search to find entities; open to read an entity; reconcile to check external Git/JSON changes.',
      inputSchema: {
        action: z.enum(['brief', 'search', 'open', 'reconcile']).default('brief'),
        query: z.string().optional(),
        entityId: z.string().optional(),
        format: z.enum(['markdown', 'json']).default('markdown'),
        projectRoot: z.string().optional(),
      },
    },
    async (input) => {
      const service = getService(input.projectRoot);
      const res = await service.osContext(input);
      return textResult(res);
    }
  );

  // 2. plan
  server.registerTool(
    'plan',
    {
      description: 'Manage delivery Plans, Phases and Plan Checkpoints (formal acceptance). Checkpoints belong strictly to Plans.',
      inputSchema: {
        action: z.enum(['list', 'create', 'open', 'check', 'complete', 'delete']),
        id: z.string().optional(),
        planData: z.record(z.any()).optional(),
        checkpointId: z.string().optional(),
        passed: z.boolean().optional(),
        evidenceRef: z.string().optional(),
        format: z.enum(['markdown', 'json']).default('markdown'),
        projectRoot: z.string().optional(),
      },
    },
    async (input) => {
      const service = getService(input.projectRoot);
      const res = await service.plan(input);
      return textResult(res);
    }
  );

  // 3. task
  server.registerTool(
    'task',
    {
      description: 'C-D-C-S development lifecycle task execution (draft -> active -> checking -> syncing -> completed). Task sync requires 100% Block coverage on working set files.',
      inputSchema: {
        action: z.enum(['create', 'open', 'note', 'check', 'sync', 'resume', 'activate', 'develop']),
        id: z.string().optional(),
        taskData: z.record(z.any()).optional(),
        text: z.string().optional(),
        kind: z.string().optional(),
        checkData: z.record(z.any()).optional(),
        syncData: z.record(z.any()).optional(),
        format: z.enum(['markdown', 'json']).default('markdown'),
        projectRoot: z.string().optional(),
      },
    },
    async (input) => {
      const service = getService(input.projectRoot);
      const res = await service.task(input);
      return textResult(res);
    }
  );

  // 4. block
  server.registerTool(
    'block',
    {
      description: 'Manage code functional Blocks. Blocks MUST bind to real code artifacts; ghost blocks are strictly rejected.',
      inputSchema: {
        action: z.enum(['list', 'open', 'search', 'bind', 'delete']),
        id: z.string().optional(),
        query: z.string().optional(),
        blockData: z.record(z.any()).optional(),
        format: z.enum(['markdown', 'json']).default('markdown'),
        projectRoot: z.string().optional(),
      },
    },
    async (input) => {
      const service = getService(input.projectRoot);
      const res = await service.block(input);
      return textResult(res);
    }
  );

  // 5. chain
  server.registerTool(
    'chain',
    {
      description: 'Feature chains and dependency links. Link kind reflects true semantics: depends_on, calls, imports, implements.',
      inputSchema: {
        action: z.enum(['list', 'open', 'compose', 'delete', 'link', 'unlink', 'links', 'validate_layout', 'validate']),
        id: z.string().optional(),
        chainData: z.record(z.any()).optional(),
        linkData: z.record(z.any()).optional(),
        format: z.enum(['markdown', 'json']).default('markdown'),
        projectRoot: z.string().optional(),
      },
    },
    async (input) => {
      const service = getService(input.projectRoot);
      const res = await service.chain(input);
      return textResult(res);
    }
  );

  // 6. code
  server.registerTool(
    'code',
    {
      description: 'Code Gateway: read outline first, surgical read by symbol or line range, surgical edit with automatic re-anchoring, symbol search, and create new files with AST registration.',
      inputSchema: {
        action: z.enum(['outline', 'read', 'edit', 'search', 'create']),
        path: z.string().optional(),
        selector: z.union([z.string(), z.record(z.any())]).optional(),
        startLine: z.number().optional(),
        endLine: z.number().optional(),
        targetContent: z.string().optional(),
        replacementContent: z.string().optional(),
        content: z.string().optional(),
        query: z.string().optional(),
        format: z.enum(['markdown', 'json']).default('markdown'),
        projectRoot: z.string().optional(),
      },
    },
    async (input) => {
      const service = getService(input.projectRoot);
      const res = await service.code(input);
      return textResult(res);
    }
  );

  // 7. run_command
  server.registerTool(
    'run_command',
    {
      description: 'Run finite shell command. Sanitizes terminal noise, saves raw logs out-of-context in .contextos/logs, and returns compressed receipt.',
      inputSchema: {
        command: z.string(),
        cwd: z.string().optional(),
        maxChars: z.number().default(1500),
        timeoutMs: z.number().default(60000),
        projectRoot: z.string().optional(),
      },
    },
    async (input) => {
      const service = getService(input.projectRoot);
      const res = await service.runCommand(input);
      return textResult(res);
    }
  );

  // 8. process
  server.registerTool(
    'process',
    {
      description: 'Manage long-running daemon background processes (dev servers, watchers). Stop terminates entire process group.',
      inputSchema: {
        action: z.enum(['start', 'list', 'status', 'logs', 'stop', 'clear']),
        id: z.string().optional(),
        command: z.string().optional(),
        lines: z.number().default(50),
        grep: z.string().optional(),
        projectRoot: z.string().optional(),
      },
    },
    async (input) => {
      const service = getService(input.projectRoot);
      const res = await service.process(input);
      return textResult(res);
    }
  );

  // 9. knowledge
  server.registerTool(
    'knowledge',
    {
      description: 'Project knowledge management: categorized Rules and single-narrative project Decision (DECISION.md).',
      inputSchema: {
        action: z.enum(['rule_list', 'rule_open', 'rule_write', 'decision_open', 'decision_write']),
        ruleId: z.string().optional(),
        ruleData: z.record(z.any()).optional(),
        sectionId: z.string().optional(),
        sectionTitle: z.string().optional(),
        content: z.string().optional(),
        format: z.enum(['markdown', 'json']).default('markdown'),
        projectRoot: z.string().optional(),
      },
    },
    async (input) => {
      const service = getService(input.projectRoot);
      const res = await service.knowledge(input);
      return textResult(res);
    }
  );

  // 10. contextos_init
  server.registerTool(
    'contextos_init',
    {
      description: 'Initialize or switch ContextOS mode (local or cloud) for a project. User only chooses mode; AI performs setup.',
      inputSchema: {
        mode: z.enum(['local', 'cloud']).default('local'),
        projectId: z.string().default('contextos'),
        cloudUrl: z.string().optional(),
        token: z.string().optional(),
        saveGlobalCloud: z.boolean().default(false),
        platforms: z.array(z.string()).optional(),
        injectEditors: z.boolean().default(false),
        projectRoot: z.string().optional(),
      },
    },
    async (input) => {
      const root = input.projectRoot || findDefaultProjectRoot();

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
        projectId: input.projectId || 'contextos',
      });

      // Evict old cache for this root
      for (const k of Array.from(serviceCache.keys())) {
        if (k.endsWith(`:${root}`) || k.includes(`:${root}:`)) {
          try { serviceCache.get(k).close(); } catch (_) {}
          serviceCache.delete(k);
        }
      }

      let editorSummary = '';
      if (input.injectEditors) {
        const nodePath = resolveNodeExecutable();
        const serverScript = deployCanonicalServer();
        let env = null;
        if (input.mode === 'cloud' && resolvedCloudUrl) {
          env = {
            CONTEXTOS_MODE: 'cloud',
            CONTEXTOS_CLOUD_URL: resolvedCloudUrl.replace(/\/+$/, ''),
            CONTEXTOS_PROJECT_ID: input.projectId || 'contextos',
          };
          if (resolvedToken) env.CONTEXTOS_CLOUD_TOKEN = resolvedToken;
        }
        const skillSource = path.join(findDefaultProjectRoot(), 'plugins', 'contextos', 'skills', 'contextos');
        const pluginSource = path.join(findDefaultProjectRoot(), 'plugins', 'contextos');
        const modified = syncAllPlatforms({
          serverScript,
          nodePath,
          env,
          targetRoot: root,
          skillSource,
          pluginSource,
          selectedPlatforms: input.platforms,
        });
        editorSummary = `\n\nInjected MCP & Skills into:\n${modified.map((m) => `  ✓ ${m}`).join('\n')}`;
      }

      return textResult(
        `✓ Initialized ContextOS in **${config.storage.toUpperCase()}** mode for project \`${config.id}\` at \`${root}\`.${editorSummary}`
      );
    }
  );

  // 11. contextos_doctor
  server.registerTool(
    'contextos_doctor',
    {
      description: 'Diagnose ContextOS environment, storage routing, and editor integrations.',
      inputSchema: {
        projectRoot: z.string().optional(),
      },
    },
    async (input) => {
      const root = input.projectRoot || findDefaultProjectRoot();
      const nodePath = resolveNodeExecutable();
      let nodeVer = process.version;
      const projJsonPath = path.join(root, '.contextos', 'project.json');
      let projectConfig = null;
      if (fs.existsSync(projJsonPath)) {
        try {
          projectConfig = JSON.parse(fs.readFileSync(projJsonPath, 'utf8'));
        } catch (_) {}
      }

      const globalCloud = getGlobalCloudConfig();
      const mode = projectConfig?.storage || (process.env.CONTEXTOS_CLOUD_URL ? 'cloud (env)' : 'local (default)');
      const projectId = projectConfig?.id || process.env.CONTEXTOS_PROJECT_ID || 'contextos';
      const cloudUrl = projectConfig?.cloudUrl || globalCloud?.cloudUrl || process.env.CONTEXTOS_CLOUD_URL || 'N/A';

      let cloudHealth = 'N/A';
      if (mode.startsWith('cloud') && cloudUrl !== 'N/A') {
        try {
          const res = await fetch(`${cloudUrl.replace(/\/+$/, '')}/api/v2/health`, {
            headers: projectConfig?.token || globalCloud?.token || process.env.CONTEXTOS_CLOUD_TOKEN
              ? { Authorization: `Bearer ${projectConfig?.token || globalCloud?.token || process.env.CONTEXTOS_CLOUD_TOKEN}` }
              : {},
          });
          cloudHealth = res.ok ? '🟢 Connected (200 OK)' : `🔴 HTTP ${res.status}`;
        } catch (err) {
          cloudHealth = `🔴 Connection failed: ${err.message}`;
        }
      }

      const platforms = detectInstalledPlatforms();
      const editorStatuses = platforms.map((p) => `  - **${p.name}**: ${p.isInstalled ? 'Installed' : 'Not detected'} (\`${p.configPath}\`)`).join('\n');

      const lines = [
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
      ];

      return textResult(lines.join('\n'));
    }
  );

  // 12. contextos_switch
  server.registerTool(
    'contextos_switch',
    {
      description: 'Losslessly switch project between Local (offline SQLite) and Cloud (Cloudflare Edge D1) modes, bidirectionally synchronizing all architecture data.',
      inputSchema: {
        targetMode: z.enum(['local', 'cloud']),
        cloudUrl: z.string().optional(),
        token: z.string().optional(),
        projectId: z.string().default('contextos'),
        projectRoot: z.string().optional(),
      },
    },
    async (input) => {
      const root = input.projectRoot || findDefaultProjectRoot();
      const dotContextos = path.join(root, '.contextos');
      const projJsonPath = path.join(dotContextos, 'project.json');
      let proj = {};
      if (fs.existsSync(projJsonPath)) {
        try { proj = JSON.parse(fs.readFileSync(projJsonPath, 'utf8')); } catch (_) {}
      }

      const globalCloud = getGlobalCloudConfig();
      const resolvedCloudUrl = input.cloudUrl || proj.cloudUrl || globalCloud?.cloudUrl || process.env.CONTEXTOS_CLOUD_URL;
      const resolvedToken = input.token || proj.token || globalCloud?.token || process.env.CONTEXTOS_CLOUD_TOKEN;
      const pid = input.projectId || proj.id || 'contextos';

      if (input.targetMode === 'cloud') {
        if (!resolvedCloudUrl) {
          throw new Error('Switching to cloud requires a cloudUrl. Provide cloudUrl or configure global credentials via ~/.contextos/cloud.json.');
        }

        // 1. Read local state from SQLite if exists
        let localSnapshot = { blocks: [], chains: [], links: [], plans: [], tasks: [] };
        if (fs.existsSync(dbPath)) {
          try {
            const localService = new ContextOSV2Service({ projectRoot: root, projectId: pid });
            const blocks = localService.db.listBlocks(pid);
            const chains = localService.db.listChains(pid);
            const links = localService.db.listLinks(pid);
            const plans = localService.db.listPlans(pid);
            const tasks = localService.db.listTasks();
            localSnapshot = { blocks, chains, links, plans, tasks };
            localService.close();
          } catch (_) {}
        }

        // 2. Push snapshot to Cloud Hub
        const cloudClient = new ContextOSCloudClient({
          cloudUrl: resolvedCloudUrl,
          token: resolvedToken,
          projectId: pid,
        });
        await cloudClient.pushSnapshot(localSnapshot, pid);

        // 3. Update project.json
        proj.storage = 'cloud';
        proj.isCloud = true;
        proj.cloudUrl = resolvedCloudUrl.replace(/\/+$/, '');
        if (resolvedToken) proj.token = resolvedToken;
        proj.updatedAt = new Date().toISOString();
        fs.writeFileSync(projJsonPath, JSON.stringify(proj, null, 2) + '\n', 'utf8');

        // 4. Evict serviceCache for this root
        for (const k of Array.from(serviceCache.keys())) {
          if (k.endsWith(`:${root}`) || k.includes(`:${root}:`)) {
            try { serviceCache.get(k).close(); } catch (_) {}
            serviceCache.delete(k);
          }
        }

        return textResult(
          `✓ Successfully migrated project \`${pid}\` to **CLOUD** mode.\n- Uploaded ${localSnapshot.blocks.length} blocks, ${localSnapshot.chains.length} chains, ${localSnapshot.plans.length} plans, and ${localSnapshot.tasks?.length || 0} tasks to ${resolvedCloudUrl}.\n- All future task & plan changes will synchronize with Cloudflare D1.`
        );
      } else {
        // targetMode === 'local'
        if (resolvedCloudUrl) {
          // 1. Fetch latest snapshot from Cloud
          try {
            const cloudClient = new ContextOSCloudClient({
              cloudUrl: resolvedCloudUrl,
              token: resolvedToken,
              projectId: pid,
            });
            const cloudSnapshot = await cloudClient.fetchSnapshot(pid);
            if (cloudSnapshot) {
              const localService = new ContextOSV2Service({ projectRoot: root, projectId: pid });
              for (const b of cloudSnapshot.blocks || []) {
                localService.db.saveBlock({
                  id: b.id,
                  projectId: pid,
                  title: b.title,
                  kind: b.kind || 'service',
                  summary: b.summary || '',
                  details: b.body || '',
                  artifactRefs: b.artifactRefs || b.artifact_refs || [],
                });
              }
              for (const c of cloudSnapshot.chains || []) {
                localService.db.saveChain({
                  id: c.id,
                  projectId: pid,
                  title: c.title,
                  summary: c.purpose || '',
                  kind: c.chainType || 'linear',
                  memberIds: c.memberIds || c.member_ids || [],
                });
              }
              for (const l of cloudSnapshot.links || []) {
                localService.db.saveLink({
                  id: l.id,
                  projectId: pid,
                  fromBlockId: l.fromBlockId || l.from_block_id || l.from,
                  toBlockId: l.toBlockId || l.to_block_id || l.to,
                  kind: l.kind || 'calls',
                });
              }
              for (const p of cloudSnapshot.plans || []) {
                localService.db.savePlan({
                  id: p.id,
                  projectId: pid,
                  title: p.title,
                  summary: p.summary || '',
                  status: p.status || 'active',
                  priority: p.priority || 'normal',
                });
              }
              for (const t of cloudSnapshot.tasks || []) {
                localService.db.saveTask({
                  id: t.id,
                  planId: t.planId || t.plan_id || 'plan-v2-rebuild',
                  phaseId: t.phaseId || t.phase_id || 'P0',
                  title: t.title || 'Untitled Task',
                  status: t.status || 'draft',
                  contextSlice: t.contextSlice || t.context_slice || {},
                  workingSet: t.workingSet || t.working_set || {},
                  references: t.references || {},
                  baseline: t.baseline || {},
                  notes: t.notes || [],
                  checks: t.checks || [],
                  syncResult: t.syncResult || t.sync_result || null,
                  createdAt: t.createdAt || t.created_at,
                  updatedAt: t.updatedAt || t.updated_at,
                });
              }
              localService.close();
            }
          } catch (e) {
            console.warn('[ContextOS Switch] Could not pull cloud snapshot before switching to local:', e.message);
          }
        }

        // 2. Update project.json to local
        proj.storage = 'local';
        proj.isCloud = false;
        delete proj.cloudUrl;
        delete proj.token;
        proj.updatedAt = new Date().toISOString();
        fs.writeFileSync(projJsonPath, JSON.stringify(proj, null, 2) + '\n', 'utf8');

        // 3. Evict serviceCache for this root
        for (const k of Array.from(serviceCache.keys())) {
          if (k.endsWith(`:${root}`) || k.includes(`:${root}:`)) {
            try { serviceCache.get(k).close(); } catch (_) {}
            serviceCache.delete(k);
          }
        }

        return textResult(
          `✓ Successfully switched project \`${pid}\` to **LOCAL** mode.\n- Architecture snapshot is now stored in local SQLite.\n- Fully offline, private, and decoupled from Cloud Hub.`
        );
      }
    }
  );

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createV2Server();
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    console.error('Fatal MCP Server error:', err);
    process.exit(1);
  });
}
