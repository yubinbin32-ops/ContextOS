import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { OPS_CAPABILITIES, Orchestrator } from '../../orchestrator/src/index.mjs';
import { runAdminCli } from './admin-cli.mjs';
import { getService, requireProjectRoot } from './service-factory.mjs';
import { runDoctor, runInit, runSwitch } from './system-tools.mjs';

const VERSION = '2.5.0';

function ensureWorkspace(projectRoot) {
  const marker = path.join(projectRoot, '.contextos', 'project.json');
  if (fs.existsSync(marker)) return false;
  runInit({ projectRoot, mode: 'local' });
  return true;
}

function textResult(content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  return { content: [{ type: 'text', text }] };
}

const editSpec = z.object({
  path: z.string(),
  target: z.string().optional(),
  replacement: z.string().optional(),
  symbol: z.string().optional(),
  startLine: z.number().optional(),
  endLine: z.number().optional(),
});

/**
 * V3 surface: five intent-level tools. Every V2 facade stays reachable through
 * `ops`, so nothing is lost while the agent-facing protocol collapses to a loop
 * of explore -> change -> verify -> ship.
 */
export function createV3Server() {
  const server = new McpServer(
    { name: 'contextos', version: VERSION },
    {
      instructions:
        'ContextOS is a context operating system for AI coding agents. State your intent and let the OS run the internals: explore(intent) to locate and resume, change(edits|create) to patch code surgically, verify(commands) to prove it runs, ship(summary) to close the loop with evidence. Use ops({capability, action, args}) only when you need a legacy facade explicitly. Never read whole files: the OS returns budgeted slices.',
    }
  );

  const dispatch = async (tool, input) => {
    const root = requireProjectRoot(input.projectRoot);
    ensureWorkspace(root);
    const service = getService(root);
    const orchestrator = new Orchestrator({
      service,
      projectRoot: root,
      projectId: service.projectId,
      system: { init: runInit, doctor: runDoctor, switch: runSwitch },
    });
    return orchestrator.dispatch(tool, input);
  };

  server.registerTool(
    'explore',
    {
      description: 'Understand, locate or resume. The OS inspects git state, picks candidate modules, outlines symbols and injects the applicable rules, all inside one context budget.',
      inputSchema: {
        intent: z.string().describe('What you want to understand or find, in plain language.'),
        paths: z.array(z.string()).optional().describe('Optional file paths to focus on instead of letting the OS infer them.'),
        depth: z.enum(['shallow', 'normal', 'deep']).default('normal'),
        projectRoot: z.string().describe('Absolute path of the active workspace.'),
      },
    },
    async (input) => textResult(await dispatch('explore', input))
  );

  server.registerTool(
    'change',
    {
      description: 'Modify or create code. The OS locates the anchor, applies a surgical AST edit, re-anchors symbols and records the touched files.',
      inputSchema: {
        intent: z.string().optional().describe('What the change should accomplish.'),
        edits: z.array(editSpec).optional().describe('Surgical replacements. `target` must uniquely match existing text (or pass symbol/startLine/endLine).'),
        create: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
        dryRun: z.boolean().optional().describe('true to preview edits without writing files, touching the session, or running verification.'),
        paths: z.array(z.string()).optional().describe('Used for a read-only preview when no edits are supplied.'),
        depth: z.enum(['shallow', 'normal', 'deep']).default('normal'),
        projectRoot: z.string().describe('Absolute path of the active workspace.'),
      },
    },
    async (input) => textResult(await dispatch('change', input))
  );

  server.registerTool(
    'verify',
    {
      description: 'Prove the change runs. With no commands the OS uses .contextos/profile.json or package.json scripts. Output stays out of context; only receipts and failures come back.',
      inputSchema: {
        commands: z.array(z.string()).optional(),
        command: z.string().optional(),
        mode: z.enum(['once', 'serve', 'list', 'status', 'logs', 'stop']).default('once'),
        id: z.string().optional(),
        lines: z.number().optional(),
        grep: z.string().optional(),
        cwd: z.string().optional(),
        maxChars: z.number().optional(),
        timeoutMs: z.number().optional(),
        projectRoot: z.string().describe('Absolute path of the active workspace.'),
      },
    },
    async (input) => textResult(await dispatch('verify', input))
  );

  server.registerTool(
    'ship',
    {
      description: 'Close the loop: collect touched files and receipts, optionally verify first, export the architecture graph and archive the session.',
      inputSchema: {
        summary: z.string().optional().describe('What changed and why; archived with the session.'),
        verify: z.union([z.boolean(), z.array(z.string())]).optional().describe('true to run profile commands, or an explicit list.'),
        dryRun: z.boolean().optional().describe('true to preview the planned closure (touched files + receipts) without closing the session, writing history or exporting the graph.'),
        decision: z.object({
          id: z.string(),
          title: z.string().optional(),
          content: z.string().optional(),
        }).optional(),
        projectRoot: z.string().describe('Absolute path of the active workspace.'),
      },
    },
    async (input) => textResult(await dispatch('ship', input))
  );

  server.registerTool(
    'ops',
    {
      description: 'Manual passthrough to the internal capabilities (legacy facades, session, profile, system). Use only when the intent-level tools are not enough.',
      inputSchema: {
        capability: z.enum(OPS_CAPABILITIES),
        action: z.string().optional(),
        args: z.record(z.any()).optional(),
        projectRoot: z.string().describe('Absolute path of the active workspace.'),
      },
    },
    async (input) => textResult(await dispatch('ops', input))
  );

  return server;
}

if (process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1])) {
  const cliArgs = process.argv.slice(2);
  if (cliArgs.length > 0) {
    runAdminCli(cliArgs).then((code) => {
      process.exitCode = code;
    });
  } else {
    const server = createV3Server();
    const transport = new StdioServerTransport();
    server.connect(transport).catch((err) => {
      console.error('Fatal MCP Server error:', err);
      process.exit(1);
    });
  }
}
