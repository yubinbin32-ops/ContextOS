import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { ContextOSV2Service } from './v2-service.mjs';

const serviceCache = new Map();

function findDefaultProjectRoot() {
  if (process.env.CONTEXTOS_PROJECT_ROOT && fs.existsSync(process.env.CONTEXTOS_PROJECT_ROOT)) {
    return process.env.CONTEXTOS_PROJECT_ROOT;
  }
  let cur = process.cwd();
  if (cur && cur !== '/') {
    while (cur && cur !== path.dirname(cur)) {
      if (fs.existsSync(path.join(cur, '.contextos'))) {
        return cur;
      }
      cur = path.dirname(cur);
    }
  }
  const defaultRepo = '/Users/a1-6/Documents/GitHub/mdflow';
  if (fs.existsSync(defaultRepo)) {
    return defaultRepo;
  }
  return process.cwd();
}

function getService(projectRoot) {
  const root = projectRoot || findDefaultProjectRoot();
  if (!serviceCache.has(root)) {
    serviceCache.set(root, new ContextOSV2Service({ projectRoot: root }));
  }
  return serviceCache.get(root);
}

function textResult(content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  return {
    content: [{ type: 'text', text }],
  };
}

export function createV2Server() {
  const server = new McpServer(
    { name: 'contextos', version: '2.0.0' },
    {
      instructions:
        'ContextOS V2 is a context operating system for AI coding agents. Follow the C-D-C-S workflow: Create Plan & Task -> Develop (outline, surgical code read/edit, run_command, task note) -> Check (record test verification) -> Sync (bind real Blocks, commit state). Never read whole files unless outline/read is insufficient. Never create ghost Blocks.',
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
        action: z.enum(['list', 'create', 'open', 'check', 'complete']),
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
        action: z.enum(['open', 'search', 'bind']),
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
        action: z.enum(['list', 'open', 'link', 'validate_layout']),
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
      description: 'Code Gateway: read outline first, surgical read by symbol or line range, surgical edit with automatic re-anchoring, and symbol search.',
      inputSchema: {
        action: z.enum(['outline', 'read', 'edit', 'search']),
        path: z.string().optional(),
        selector: z.union([z.string(), z.record(z.any())]).optional(),
        targetContent: z.string().optional(),
        replacementContent: z.string().optional(),
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
