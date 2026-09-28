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
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return { content: [{ type: 'text', text }] };
}

const editSpec = z.object({
  slot: z.string().optional().describe('Action slot identifier from explore (e.g. "S1").'),
  path: z.string().optional().describe('Relative file path to modify (optional if slot is provided).'),
  target: z.string().optional(),
  replacement: z.string().optional(),
  content: z.string().optional().describe('Entire file content for a fullFile replacement.'),
  symbol: z.string().optional(),
  append: z.string().optional().describe('Code to append to the end of the file.'),
  startLine: z.number().optional(),
  endLine: z.number().optional(),
  fullFile: z.boolean().optional().describe('When true, replaces entire file content with replacement.'),
});

const architectureSpec = z.record(z.any()).describe(
  'Optional curated Block/Chain ownership to apply in the same mutation or closure; derived mod-* module identities are rejected.'
);

/**
 * V3 surface: intent-level tools. Every V2 facade stays reachable through
 * `ops`, so nothing is lost while the agent-facing protocol collapses to a loop
 * of explore -> change -> verify -> ship, plus first-class inspect.
 */
export function createV3Server({
  surface = process.env.CONTEXTOS_LEAN_SURFACE === '0' ? 'legacy' : 'lean',
} = {}) {
  const server = new McpServer(
    { name: 'contextos', version: VERSION },
    {
      instructions:
        'ContextOS is the repository execution layer. Prefer one contextos call per host decision: work for read+edit+verify, pipeline for known batches, micro for bulky evidence. Trust verified receipts; expand artifacts only when the next decision needs the body.',
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

  if (surface === 'lean') {
    server.registerTool(
      'contextos',
      {
        description: 'Repository execution for one decision per call. Use action=work for {search,inspect,create,edits,verify}; use pipeline for known parallel or dependent batches directly; inspect/change/verify cover focused operations; micro handles bulky evidence and delivery. Returns compact receipts and locators; expand with full/maxChars only when needed.',
        inputSchema: {
          action: z.enum(['explore', 'inspect', 'change', 'verify', 'ship', 'pipeline', 'work', 'micro', 'resume', 'ops']),
          args: z.record(z.any()).optional(),
          projectRoot: z.string().describe('Absolute repository root.'),
          refresh: z.boolean().optional().describe('Force a fresh read instead of reusing a compact receipt.'),
          dedupeReads: z.boolean().optional().describe('Set false to bypass read deduplication.'),
          full: z.boolean().optional().describe('Request the full, unbounded payload.'),
          budget: z.string().optional().describe('Named output budget, e.g. "full".'),
          maxChars: z.number().optional().describe('Explicit output character cap.'),
        },
      },
      async (input) => {
        const args = { ...(input.args || {}) };
        for (const control of ['refresh', 'dedupeReads', 'full', 'budget', 'maxChars']) {
          if (input[control] !== undefined) args[control] = input[control];
        }
        const payload = { ...args, projectRoot: input.projectRoot };
        if (input.action === 'micro') {
          return textResult(await dispatch('ops', {
            capability: 'micro',
            action: 'run',
            args: { ...args },
            projectRoot: input.projectRoot,
          }));
        }
        if (input.action === 'resume') {
          return textResult(await dispatch('ops', { ...payload, capability: 'session', action: 'resume' }));
        }
        return textResult(await dispatch(input.action, payload));
      }
    );
    return server;
  }

  server.registerTool(
    'explore',
    {
      description: 'Locate code or resume work. Returns a bounded summary plus action slots; unchanged repeated requests reuse the prior discovery receipt. Use full/maxChars or refresh:true only when a fresh/full replay is needed.',
      inputSchema: {
        intent: z.string().describe('What to locate or understand.'),
        paths: z.array(z.string()).optional().describe('Optional focus paths.'),
        depth: z.enum(['shallow', 'normal', 'deep']).default('normal'),
        maxChars: z.number().optional().describe('Response character budget.'),
        full: z.boolean().optional().describe('Return full output instead of artifact-backed summaries.'),
        refresh: z.boolean().optional().describe('Force a fresh discovery even when the unchanged request has a reusable receipt.'),
        dedupeReads: z.boolean().optional().describe('Set false only when an intentional fresh replay is required.'),
        projectRoot: z.string().describe('Absolute path of the active workspace.'),
      },
    },
    async (input) => textResult(await dispatch('explore', input))
  );

  server.registerTool(
    'inspect',
    {
      description: 'Read precise code slices by path, slot, symbol, or ranges. Default output is bounded.',
      inputSchema: {
        slot: z.string().optional().describe('Action slot identifier from explore (e.g. "S1").'),
        path: z.string().optional().describe('File path to inspect.'),
        paths: z.array(z.string()).optional().describe('Multiple file paths to inspect in parallel (batch inspection).'),
        globs: z.array(z.string()).optional().describe('Glob patterns to resolve to repository files before inspection.'),
        ranges: z.array(z.object({ startLine: z.number(), endLine: z.number() })).optional().describe('Multiple line ranges to inspect within the same file (e.g. [{ startLine: 1, endLine: 20 }]).'),
        symbol: z.string().optional().describe('Optional symbol/function name to slice.'),
        startLine: z.number().optional(),
        endLine: z.number().optional(),
        mode: z.enum(['slices', 'outline']).optional().describe('Inspection mode: "slices" for code slices/methods, "outline" for AST symbol hierarchy and signatures.'),
        outline: z.boolean().optional().describe('Quick shorthand for mode: "outline".'),
        fullFile: z.boolean().optional(),
        budget: z.enum(['shallow', 'normal', 'deep', 'full']).optional().describe('Character budget preset. Use "full" to disable clipping and read entire long documents.'),
        maxChars: z.number().optional().describe('Explicit maximum characters to return.'),
        refresh: z.boolean().optional().describe('Force a fresh source read even when an unchanged receipt is reusable.'),
        dedupeReads: z.boolean().optional().describe('Set false only when an intentional fresh replay is required.'),
        depth: z.enum(['shallow', 'normal', 'deep']).default('normal'),
        projectRoot: z.string().describe('Absolute path of the active workspace.'),
      },
    },
    async (input) => textResult(await dispatch('inspect', input))
  );

  server.registerTool(
    'change',
    {
      description: 'Apply batched edits/creates/deletes and optional verification in one call.',
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
        delete: z.array(z.object({ path: z.string() })).optional().describe('Delete files atomically as part of the same changeset.'),
        verify: z.union([
          z.string(),
          z.array(z.string()),
          z.boolean(),
          z.object({ command: z.string().optional(), commands: z.array(z.string()).optional(), timeoutMs: z.number().optional() }),
        ]).optional().describe('Run verification immediately after writing files in the same turn.'),
        autoRevert: z.boolean().optional().describe('true to automatically revert files on disk if verification fails.'),
        architecture: architectureSpec.optional(),
        dryRun: z.boolean().optional().describe('true to preview edits without writing files, touching the session, or running verification.'),
        paths: z.array(z.string()).optional().describe('Used for a read-only preview when no edits are supplied.'),
        maxChars: z.number().optional().describe('Response character budget.'),
        full: z.boolean().optional().describe('Return full output instead of artifact-backed summaries.'),
        depth: z.enum(['shallow', 'normal', 'deep']).default('normal'),
        projectRoot: z.string().describe('Absolute path of the active workspace.'),
      },
    },
    async (input) => textResult(await dispatch('change', input))
  );

  server.registerTool(
    'verify',
    {
      description: 'Run bounded verification commands and return compact receipts plus failure diagnostics.',
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
        autoTriage: z.boolean().optional().describe('Opt in to micro diagnosis on failure.'),
        full: z.boolean().optional().describe('Return full output instead of artifact-backed summaries.'),
        projectRoot: z.string().describe('Absolute path of the active workspace.'),
      },
    },
    async (input) => textResult(await dispatch('verify', input))
  );

  server.registerTool(
    'ship',
    {
      description: 'Close the session with bounded evidence and an optional decision record.',
      inputSchema: {
        summary: z.string().optional().describe('What changed and why; archived with the session.'),
        verify: z.union([z.boolean(), z.array(z.string())]).optional().describe('true to run profile commands, or an explicit list.'),
        dryRun: z.boolean().optional().describe('true to preview the planned closure (touched files + receipts) without closing the session, writing history or exporting the graph.'),
        decision: z.object({
          id: z.string(),
          title: z.string().optional(),
          content: z.string().optional(),
        }).optional(),
        architecture: architectureSpec.optional(),
        maxChars: z.number().optional().describe('Response character budget.'),
        full: z.boolean().optional().describe('Return full output instead of artifact-backed summaries.'),
        exportGraph: z.boolean().optional().describe('Publish .contextos/graph.json. Defaults to profile.shipExportsGraph.'),
        projectRoot: z.string().describe('Absolute path of the active workspace.'),
      },
    },
    async (input) => textResult(await dispatch('ship', input))
  );

  server.registerTool(
    'ops',
    {
      description: 'Advanced capability passthrough. Reads reuse compact semantic receipts and stay bounded; use refresh:true or full:true only when a fresh/full diagnostic is required.',
      inputSchema: {
        capability: z.enum(OPS_CAPABILITIES),
        action: z.string().optional(),
        args: z.record(z.any()).optional(),
        projectRoot: z.string().describe('Absolute path of the active workspace.'),
        refresh: z.boolean().optional().describe('Force a fresh read instead of reusing a compact receipt.'),
        dedupeReads: z.boolean().optional().describe('Set false to bypass read deduplication.'),
        full: z.boolean().optional().describe('Request the full, unbounded payload.'),
        budget: z.string().optional().describe('Named output budget, e.g. "full".'),
        maxChars: z.number().optional().describe('Explicit output character cap.'),
      },
    },
    async (input) => textResult(await dispatch('ops', input))
  );

  server.registerTool(
    'pipeline',
    {
      description: 'Run dependent or independent actions in one bounded round. Default mode is compact summary.',
      inputSchema: {
        steps: z.array(z.any()).optional().describe('List of steps to execute. Supports single actions, parallel arrays, and { chain: [...] }.'),
        chain: z.array(z.any()).optional().describe('Direct sequential chain of actions. Halts immediately on failure.'),
        parallel: z.array(z.any()).optional().describe('Direct parallel list of actions to execute concurrently.'),
        flow: z.array(z.any()).optional().describe('Alias for steps.'),
        mode: z.enum(['summary', 'receipt', 'full']).default('summary').describe('Summary is artifact-backed and bounded; receipt returns references only; full is explicit.'),
        maxChars: z.number().optional().describe('Aggregate response character budget.'),
        parallelConcurrency: z.number().optional().describe('Maximum in-flight actions inside one parallel Pipeline group (default 4, hard maximum 8).'),
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
