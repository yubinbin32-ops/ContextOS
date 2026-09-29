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

const architectureSpec = z.object({
  blocks: z.array(z.object({
    id: z.string(),
    title: z.string().optional(),
    kind: z.string().optional(),
    paths: z.array(z.string()).optional(),
    path: z.string().optional(),
    summary: z.string().optional(),
    symbols: z.array(z.string()).optional(),
  }).passthrough()).optional(),
  chains: z.array(z.object({
    id: z.string(),
    title: z.string().optional(),
    memberIds: z.array(z.string()).optional(),
    member_ids: z.array(z.string()).optional(),
    replaceMembers: z.boolean().optional(),
  }).passthrough()).optional(),
}).passthrough().describe(
  'Curated Block/Chain ownership applied atomically with the same mutation or closure; mod-* ModuleIndex identities are rejected.'
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
        description: 'Repository execution: one host decision per call. work={search,inspect,create,edits,verify,architecture}; change={edits,create,delete,verify,architecture,ship}; inspect={path|paths,symbol,ranges,budget}; search/create aliases; micro=evidence/delivery. Use pipeline for known batches directly. ops only for capabilities: os_context,plan,task,block,chain,architecture,code,run_command,process,knowledge,session,system,profile,micro,artifact,telemetry; block.get/inspect alias open. Expand only with full/maxChars.',
        inputSchema: {
          action: z.enum(['explore', 'inspect', 'change', 'verify', 'ship', 'pipeline', 'work', 'micro', 'resume', 'ops', 'search', 'create']),
          capability: z.string().optional(),
          args: z.record(z.any()).optional(),
          arguments: z.record(z.any()).optional(),
          projectRoot: z.string().describe('Absolute repository root.'),
          refresh: z.boolean().optional().describe('Force a fresh read instead of reusing a compact receipt.'),
          dedupeReads: z.boolean().optional().describe('Set false to bypass read deduplication.'),
          full: z.boolean().optional().describe('Request the full, unbounded payload.'),
          budget: z.string().optional().describe('Named output budget, e.g. "full".'),
          maxChars: z.number().optional().describe('Explicit output character cap.'),
          intent: z.string().optional(),
          verify: z.union([z.string(), z.array(z.string()), z.record(z.any())]).optional(),
          commands: z.array(z.string()).optional(),
          architecture: architectureSpec.optional(),
          edits: z.array(z.record(z.any())).optional(),
          create: z.array(z.record(z.any())).optional(),
          delete: z.array(z.record(z.any())).optional(),
          ship: z.union([z.boolean(), z.string(), z.record(z.any())]).optional(),
          maxLogBytes: z.number().optional().describe('Bound persisted command/process log bytes; keeps the tail and marks truncation.'),
          search: z.union([z.string(), z.record(z.any()), z.array(z.any())]).optional(),
          inspect: z.union([z.string(), z.record(z.any()), z.array(z.any())]).optional(),
          path: z.string().optional(),
          paths: z.array(z.string()).optional(),
          symbol: z.string().optional(),
          query: z.string().optional(),
          ranges: z.array(z.union([z.array(z.number()), z.record(z.any())])).optional(),
          startLine: z.number().optional(),
          endLine: z.number().optional(),
          preset: z.string().optional(),
          task: z.string().optional(),
          pipeline: z.record(z.any()).optional(),
          pipelines: z.any().optional(),
          withOS: z.boolean().optional(),
          invocation: z.record(z.any()).optional(),
          delivery: z.string().optional(),
          provider: z.record(z.any()).optional(),
          inputRef: z.string().optional(),
          inputArtifact: z.string().optional(),
          inputReceipt: z.string().optional(),
        },
      },
      async (input) => {
        const args = { ...(input.arguments || {}), ...(input.args || {}) };
        for (const control of ['refresh', 'dedupeReads', 'full', 'budget', 'maxChars', 'maxLogBytes']) {
          if (input[control] !== undefined) args[control] = input[control];
        }
        for (const field of [
          'intent', 'verify', 'commands', 'architecture', 'edits', 'create', 'delete', 'ship',
          'search', 'inspect', 'path', 'paths', 'symbol', 'query', 'ranges', 'startLine', 'endLine',
        ]) {
          if (input[field] !== undefined) args[field] = input[field];
        }
        for (const field of [
          'preset', 'task', 'pipeline', 'pipelines', 'withOS', 'invocation', 'delivery',
          'provider', 'inputRef', 'inputArtifact', 'inputReceipt',
        ]) {
          if (input[field] !== undefined) args[field] = input[field];
        }
        if (input.action === 'search' && args.search === undefined) {
          args.search = { query: input.query ?? input.search ?? '' };
        }
        const compactAction = input.action === 'search' || (input.action === 'explore' && input.search !== undefined)
          ? 'work'
          : (input.action === 'create' ? 'change' : input.action);
        if (compactAction === 'ops' && input.capability !== undefined && args.capability === undefined) {
          args.capability = input.capability;
        }
        if (compactAction === 'ops') {
          const knownCapabilities = new Set([
            'os_context', 'plan', 'task', 'block', 'chain', 'code', 'run_command', 'process',
            'knowledge', 'session', 'system', 'profile', 'micro', 'artifact', 'telemetry',
          ]);
          if (!args.capability && knownCapabilities.has(args.action)) {
            args.capability = args.action;
          }
          if (args.capability === 'run_command' && args.command === undefined && Array.isArray(args.commands)) {
            args.command = args.commands.filter((entry) => typeof entry === 'string' && entry.trim()).join(' && ');
          }
        }
        const normalizeRange = (range) => {
          const startLine = Number(Array.isArray(range) ? range[0] : (range?.startLine ?? range?.start));
          const endLine = Number(Array.isArray(range) ? range[1] : (range?.endLine ?? range?.end));
          return Number.isFinite(startLine) && Number.isFinite(endLine) && endLine >= startLine
            ? { startLine, endLine }
            : null;
        };
        const rangesByPath = (values) => {
          const grouped = new Map();
          for (const entry of Array.isArray(values) ? values : []) {
            const rangePath = typeof entry?.path === 'string' ? entry.path : null;
            const range = normalizeRange(entry);
            if (!rangePath || !range) continue;
            const list = grouped.get(rangePath) || [];
            list.push(range);
            grouped.set(rangePath, list);
          }
          return grouped;
        };
        if (compactAction === 'inspect' || compactAction === 'work') {
          if (typeof args.inspect === 'string') {
            args.inspect = {
              path: args.inspect,
              ...(args.ranges !== undefined ? { ranges: args.ranges } : {}),
              ...(args.budget !== undefined ? { budget: args.budget } : {}),
            };
          }
          if (args.inspect && typeof args.inspect === 'object' && !Array.isArray(args.inspect) && Array.isArray(args.inspect.paths)) {
            const nestedInspect = args.inspect;
            args.inspect = nestedInspect.paths.map((target) => ({
              path: target,
              ...(nestedInspect.budget !== undefined ? { budget: nestedInspect.budget } : {}),
              ...(nestedInspect.ranges !== undefined ? { ranges: nestedInspect.ranges } : {}),
            }));
          }
          if (Array.isArray(args.inspect)) {
            args.inspect = args.inspect.map((entry) => {
              if (typeof entry === 'string') return { path: entry };
              if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
              const normalized = entry.full === true && entry.budget === undefined
                ? { ...entry, budget: 'full' }
                : entry;
              const grouped = rangesByPath(normalized.ranges);
              if (grouped.size === 1 && !normalized.path) {
                const [rangePath, ranges] = [...grouped.entries()][0];
                return { ...normalized, path: rangePath, ranges };
              }
              return normalized;
            });
            const inspectBudgets = args.inspect
              .map((entry) => entry?.budget)
              .filter((value) => value !== undefined);
            if (args.budget === undefined && inspectBudgets.length
                && inspectBudgets.every((value) => value === inspectBudgets[0])) {
              args.budget = inspectBudgets[0];
            }
          }
          if (args.full === true && args.budget === undefined) args.budget = 'full';
          if (!args.inspect && Array.isArray(args.ranges)) {
            const grouped = rangesByPath(args.ranges);
            if (grouped.size) {
              args.inspect = [...grouped.entries()].map(([target, ranges]) => ({ path: target, ranges }));
            }
          }
          if (!args.inspect && typeof args.path === 'string') {
            args.inspect = {
              path: args.path,
              ...(args.ranges !== undefined ? { ranges: args.ranges } : {}),
              ...(args.budget !== undefined ? { budget: args.budget } : {}),
            };
          }
          if (!args.inspect && Array.isArray(args.paths)) {
            args.inspect = args.paths.map((target) => ({
              path: target,
              ...(args.budget !== undefined ? { budget: args.budget } : {}),
            }));
          }
        }
        if (Array.isArray(args.edits)) {
          args.edits = args.edits.map((spec) => {
            if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return spec;
            const contentOnly = spec.content !== undefined
              && spec.replacement === undefined
              && spec.replacementContent === undefined
              && spec.target === undefined
              && spec.symbol === undefined
              && spec.startLine === undefined
              && spec.fullFile !== true;
            return contentOnly ? { ...spec, fullFile: true, replacement: spec.content } : spec;
          });
        }
        if (compactAction === 'pipeline' && args.pipeline && typeof args.pipeline === 'object') {
          const nestedPipeline = args.pipeline;
          delete args.pipeline;
          for (const field of ['steps', 'chain', 'parallel', 'mode', 'budget', 'branches']) {
            if (args[field] === undefined && nestedPipeline[field] !== undefined) {
              args[field] = nestedPipeline[field];
            }
          }
          if (args.steps === undefined && Array.isArray(nestedPipeline.stages)) {
            args.steps = nestedPipeline.stages.map((stage) => {
              if (!stage || typeof stage !== 'object' || Array.isArray(stage)) return stage;
              const tool = stage.tool || stage.action || stage.type;
              const { tool: _tool, action: _action, type: _type, args: stageArgs, ...stageBody } = stage;
              return {
                tool,
                args: {
                  ...stageBody,
                  ...(stageArgs && typeof stageArgs === 'object' && !Array.isArray(stageArgs) ? stageArgs : {}),
                },
              };
            });
          }
          if (args.steps === undefined) {
            const actionKeys = ['explore', 'inspect', 'verify', 'search', 'change', 'work', 'ops', 'run_command', 'ship'];
            const shorthandSteps = [];
            for (const key of actionKeys) {
              const value = nestedPipeline[key];
              if (value === undefined || value === null || value === false) continue;
              let stepArgs = value === true ? {} : (typeof value === 'object' && !Array.isArray(value) ? value : { value });
              if (key === 'explore' && args.intent !== undefined && stepArgs.intent === undefined) {
                stepArgs = { ...stepArgs, intent: args.intent };
              }
              if (key === 'explore' && stepArgs.task !== undefined && stepArgs.intent === undefined) {
                stepArgs = { ...stepArgs, intent: stepArgs.task };
              }
              if (key === 'verify' && args.maxLogBytes !== undefined && stepArgs.maxLogBytes === undefined) {
                stepArgs = { ...stepArgs, maxLogBytes: args.maxLogBytes };
              }
              shorthandSteps.push({ tool: key, args: stepArgs });
            }
            if (shorthandSteps.length) args.steps = shorthandSteps;
          }
          if (args.steps === undefined && typeof (nestedPipeline.task || args.task) === 'string') {
            const task = nestedPipeline.task || args.task;
            args.steps = [
              { tool: 'explore', args: { intent: task } },
              { tool: 'verify', args: {} },
            ];
          }
        }
        if (compactAction === 'pipeline' && args.steps === undefined && typeof args.task === 'string' && args.task.trim()) {
          args.steps = [
            { tool: 'explore', args: { intent: args.task } },
            { tool: 'verify', args: {} },
          ];
        }
        if (compactAction === 'pipeline' && args.continueOnFailure === undefined) {
          const toolsInPipeline = new Set();
          const collectPipelineTools = (items) => {
            if (!Array.isArray(items)) return;
            for (const item of items) {
              if (Array.isArray(item)) collectPipelineTools(item);
              else if (item && Array.isArray(item.parallel)) collectPipelineTools(item.parallel);
              else if (item && Array.isArray(item.chain)) collectPipelineTools(item.chain);
              else if (item?.tool || item?.action) toolsInPipeline.add(item.tool || item.action);
            }
          };
          collectPipelineTools(args.steps);
          if (toolsInPipeline.has('explore') && toolsInPipeline.has('verify')) {
            args.continueOnFailure = true;
          }
        }
        const payload = { ...args, projectRoot: input.projectRoot };
        if (compactAction === 'micro') {
          return textResult(await dispatch('ops', {
            capability: 'micro',
            action: 'run',
            args: { ...args },
            projectRoot: input.projectRoot,
          }));
        }
        if (compactAction === 'resume') {
          return textResult(await dispatch('ops', { ...payload, capability: 'session', action: 'resume' }));
        }
        return textResult(await dispatch(compactAction, payload));
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
        ranges: z.array(z.union([z.array(z.number()), z.object({ startLine: z.number(), endLine: z.number() })])).optional().describe('Multiple line ranges to inspect within the same file (e.g. [[1, 20]] or [{ startLine: 1, endLine: 20 }]).'),
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
        maxLogBytes: z.number().optional().describe('Bound persisted verification log bytes; keeps the tail and marks truncation.'),
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
        maxLogBytes: z.number().optional().describe('Bound persisted verification log bytes; keeps the tail and marks truncation.'),
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
      description: 'Advanced capability passthrough. Reads reuse compact semantic receipts and stay bounded; use refresh:true or full:true only when a fresh/full diagnostic is required. Capabilities: os_context, plan, task, block, chain, architecture, code, run_command, process, knowledge, session, system, profile, micro, artifact, telemetry.',
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
