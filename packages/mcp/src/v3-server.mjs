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
import packageMetadata from '../../../package.json' with { type: 'json' };

const VERSION = packageMetadata.version;

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
  slot: z.string().optional().describe('Action slot identifier from explore (e.g. "S1").'),
  path: z.string().optional().describe('Relative file path to modify (optional if slot is provided).'),
  target: z.string().optional(),
  replacement: z.string().optional(),
  symbol: z.string().optional(),
  append: z.string().optional().describe('Code to append to the end of the file.'),
  startLine: z.number().optional(),
  endLine: z.number().optional(),
  fullFile: z.boolean().optional().describe('When true, replaces entire file content with replacement.'),
});

/**
 * V3 surface: intent-level tools. Every V2 facade stays reachable through
 * `ops`, so nothing is lost while the agent-facing protocol collapses to a loop
 * of explore -> change -> verify -> ship, plus first-class inspect.
 */
export function createV3Server() {
  const server = new McpServer(
    { name: 'contextos', version: VERSION },
    {
      instructions:
        'ContextOS is a context operating system for AI coding agents. State your intent and let the OS run the internals: explore(intent) to locate, pre-slice and pick action slots, inspect(slot|path) to read code, change(slot|edits) to patch code surgically with in-situ verify, ship(summary) to close the loop with evidence. Never read whole files: the OS returns budgeted slices.',
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
      description: 'Understand, locate or resume. The OS inspects git state, pre-slices candidate code, outlines symbols and provides actionable slots, all inside one context budget.',
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
    'inspect',
    {
      description: 'Inspect code slices or files directly. Supports slot identifier (e.g. S1), symbol name, multiple line ranges, or multiple file paths in parallel.',
      inputSchema: {
        slot: z.string().optional().describe('Action slot identifier from explore (e.g. "S1").'),
        path: z.string().optional().describe('File path to inspect.'),
        paths: z.array(z.string()).optional().describe('Multiple file paths to inspect in parallel (batch inspection).'),
        ranges: z.array(z.object({ startLine: z.number(), endLine: z.number() })).optional().describe('Multiple line ranges to inspect within the same file (e.g. [{ startLine: 1, endLine: 20 }]).'),
        symbol: z.string().optional().describe('Optional symbol/function name to slice.'),
        startLine: z.number().optional(),
        endLine: z.number().optional(),
        mode: z.enum(['slices', 'outline']).optional().describe('Inspection mode: "slices" for code slices/methods, "outline" for AST symbol hierarchy and signatures.'),
        outline: z.boolean().optional().describe('Quick shorthand for mode: "outline".'),
        fullFile: z.boolean().optional(),
        budget: z.enum(['shallow', 'normal', 'deep', 'full']).optional().describe('Character budget preset. Use "full" to disable clipping and read entire long documents.'),
        maxChars: z.number().optional().describe('Explicit maximum characters to return.'),
        depth: z.enum(['shallow', 'normal', 'deep']).default('normal'),
        projectRoot: z.string().describe('Absolute path of the active workspace.'),
      },
    },
    async (input) => textResult(await dispatch('inspect', input))
  );

  server.registerTool(
    'change',
    {
      description: 'Modify or create code. Supports slot-based quick editing, symbol body replacement, code append, full-file overwrite, and in-situ atomic verification. TIP: Batch multi-file modifications in edits/create arrays or call concurrently to minimize turns.',
      inputSchema: {
        intent: z.string().optional().describe('What the change should accomplish.'),
        slot: z.string().optional().describe('Action slot identifier to target (e.g. "S1").'),
        path: z.string().optional().describe('Target file path (shorthand for single edit or file overwrite).'),
        content: z.string().optional().describe('Entire file content to overwrite (used with overwrite: true).'),
        overwrite: z.boolean().optional().describe('When true, overwrites existing file content entirely.'),
        target: z.string().optional().describe('Target text to replace (shorthand for single edit).'),
        replacement: z.string().optional().describe('Replacement text (shorthand for single edit).'),
        symbol: z.string().optional().describe('AST symbol name to replace (shorthand for single edit).'),
        append: z.string().optional().describe('Code to append to file (shorthand for single edit).'),
        edits: z.array(editSpec).optional().describe('Surgical replacements or appends across multiple files.'),
        create: z.array(z.object({ path: z.string(), content: z.string(), overwrite: z.boolean().optional() })).optional(),
        verify: z.union([z.string(), z.array(z.string()), z.boolean()]).optional().describe('Run verification immediately after writing files in the same turn.'),
        autoRevert: z.boolean().optional().describe('true to automatically revert files on disk if verification fails.'),
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
        mode: z.enum(['once', 'serve', 'list', 'status', 'logs', 'stop', 'query']).default('once'),
        raw: z.boolean().optional().describe('Pass true to preserve terminal output without collapsing.'),
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

  server.registerTool(
    'pipeline',
    {
      description: 'Universal multi-task orchestrator. Execute multiple MCP commands in parallel, sequence (sequential chain), or nested combinations in a single round. Supports ANY MCP tool: inspect, change, verify, ship, ops (run_command, block, chain, plan, task). Use parallel array [action1, action2] or { parallel: [...] } for concurrent execution (e.g. parallel inspect or search queries via run: "rg ...", raw: true), and { chain: [action1, action2] } for transactional sequential execution that halts on failure. Query command outputs retain top matching lines and distinct file lists without being collapsed.',
      inputSchema: {
        steps: z.array(z.any()).optional().describe('List of steps to execute. Supports single actions, parallel arrays, and { chain: [...] }.'),
        chain: z.array(z.any()).optional().describe('Direct sequential chain of actions. Halts immediately on failure.'),
        parallel: z.array(z.any()).optional().describe('Direct parallel list of actions to execute concurrently.'),
        flow: z.array(z.any()).optional().describe('Alias for steps.'),
        projectRoot: z.string().describe('Absolute path of the active workspace.'),
      },
    },
    async (input) => textResult(await dispatch('pipeline', input))
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
