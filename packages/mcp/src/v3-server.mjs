import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { OPS_CAPABILITIES, Orchestrator } from '../../orchestrator/src/index.mjs';
import { runAdminCli } from './admin-cli.mjs';
import { getService, requireProjectRoot } from './service-factory.mjs';
import { runDoctor, runInit } from './system-tools.mjs';
import packageMetadata from '../../../package.json' with { type: 'json' };
import { requestContextOS, renderRequestResult, recordEvidenceDelivery, publicAgentProgress } from '../../orchestrator/src/request-service.mjs';
import { appendRoleUsage } from '../../orchestrator/src/role-usage-ledger.mjs';
import { executeAgent } from '../../orchestrator/src/agent-service.mjs';
import { runAgentWorkerCli } from '../../orchestrator/src/agent-worker.mjs';
import { hasAgentReportContent } from '../../orchestrator/src/micro-agent-report.mjs';
import { claimMicroDeliveries, completeMicroDeliveryClaims, readMicroJob, releaseMicroDeliveryClaims } from '../../orchestrator/src/micro-delivery.mjs';
import { receiveMicroMessages, acknowledgeMicroMessages } from '../../orchestrator/src/micro-mailbox.mjs';

const VERSION = packageMetadata.version;
const textOnlyResults = () => process.env.CONTEXTOS_TEXT_ONLY_RESULTS === '1';

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

function reportJobId(content) {
  try {
    return JSON.parse(content)?.jobId || null;
  } catch {
    return null;
  }
}

function recordCallMeta(input, extra) {
  try {
    const root = input && typeof input.projectRoot === 'string' ? input.projectRoot : null;
    if (!root) return;
    const dir = path.join(root, '.contextos', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const meta = extra && typeof extra === 'object' ? extra : {};
    fs.appendFileSync(path.join(dir, 'mcp-call-meta.jsonl'), `${JSON.stringify({
      ts: new Date().toISOString(),
      action: input.action ?? null,
      hasProgressToken: meta._meta?.progressToken !== undefined,
      sessionId: meta.sessionId ?? null,
      requestId: meta.requestId ?? null,
    })}\n`);
  } catch {
    // Diagnostics must never affect the call.
  }
}

function startProgressHeartbeat(extra, input) {
  const token = extra?._meta?.progressToken;
  const notify = typeof extra?.sendNotification === 'function' ? extra.sendNotification.bind(extra) : null;
  if (!notify || token === undefined || token === null) return { stop() {} };
  let count = 0;
  const startedAt = Date.now();
  const timer = setInterval(() => {
    count += 1;
    try {
      const pending = notify({
        method: 'notifications/progress',
        params: {
          progressToken: token,
          progress: count,
          message: `ContextOS ${input?.action || 'call'} still running (${Math.round((Date.now() - startedAt) / 1000)}s)`,
        },
      });
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch {
      // Heartbeats are best-effort only.
    }
  }, 15_000);
  timer.unref?.();
  return { stop() { clearInterval(timer); } };
}

function mutationResult(content) {
  const result = textResult(content);
  const line = result.content[0].text.split(/\r?\n/).find((value) => value.startsWith('status='));
  if (!line) return result;
  try {
    const status = JSON.parse(line.slice(7));
    if (status.schemaVersion !== 1 || status.operation !== 'change') return result;
    return { ...result, structuredContent: status, ...(status.errorCode ? { isError: true } : {}) };
  } catch { return result; }
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
export function createV3Server() {
  const server = new McpServer(
    { name: 'contextos', version: VERSION },
    {
      instructions:
        'First contact with an exact goal: ask({onboard:{goal:"ModuleIndex"}}) resolves existing graph ID/title/symbol/path locally and returns overview, actual owners and verified source in one request; ambiguity returns candidates/partial, no model fallback. Without a goal, ask({overview:true}) returns bounded project entries, commands, graph navigation and current session/plan/task in one local zero-model request. Use micro to delegate a bounded task and receive one compact report; batch micro tasks in pipeline. Use ask for code evidence: describe the goal; API Micro explores privately and OS returns exact selected source. Known inspect ranges read directly. ask({blockId}) or ask({chainId}) verifies named graph anchors and returns bounded source without API; stale anchors are gaps. With request, named graph entities seed semantic retrieval. Batch ownership via ops({capability:"block",action:"owners",args:{paths:[...]}}). Use command to execute once, then command action get with its id to retrieve results. CLI agent tasks handle complex multi-file implementation and can use ask. Keep provider traces private, use actual execution receipts, and fetch named missing evidence. Native tools remain available.',
    }
  );

  const dispatch = async (tool, input) => {
    const root = requireProjectRoot(input.projectRoot);
    if (tool === 'ask' || tool === 'command' || tool === 'agent') {
      const worker = process.env.CONTEXTOS_WORKER_MODE === '1';
      const ledgerRoot = worker ? process.env.CONTEXTOS_MICRO_REPORT_ROOT || root : root;
      const recordUsage = (row) => appendRoleUsage(ledgerRoot, { ...row, ...(worker ? { parentTaskId: process.env.CONTEXTOS_MICRO_REPORT_JOB || null } : {}) });
      return requestContextOS(tool, input, {
        projectRoot: root,
        onUsage: recordUsage,
        agent: (args, options) => executeAgent(args, { ...options, onUsage: recordUsage, workerEntry: fileURLToPath(import.meta.url) }),
      });
    }
    // Diagnostics and platform sync must remain available when context import itself is invalid.
    if (tool === 'ops' && input.capability === 'system' && input.action === 'doctor') {
      return runDoctor({ ...(input.args || {}), projectRoot: root });
    }
    if (tool === 'ops' && input.capability === 'system' && (input.action === 'init' || input.action === 'sync')) {
      return runInit({ ...(input.args || {}), projectRoot: root, injectEditors: true });
    }
    ensureWorkspace(root);
    const service = getService(root);
    const orchestrator = new Orchestrator({
      service,
      projectRoot: root,
      projectId: service.projectId,
      system: {
        init: runInit,
        doctor: runDoctor,
        sync: (args) => runInit({ ...args, injectEditors: true }),
      },
    });
    return orchestrator.dispatch(tool, input);
  };

  server.registerTool(
    'contextos',
    {
      description: 'With a known goal, ask({onboard:{goal:"ModuleIndex"}}) returns local overview, trusted graph/owners and verified source; ambiguity is partial, no model fallback. Without a goal use ask({overview:true}). ask({request|inspect}) gets exact source evidence. micro delegates bounded API work; agent delegates implementation to a configured CLI. command runs once; command({action:"get",id}) retrieves. change applies edits/verify. ops({capability,action,args}) exposes state and advanced operations. Put parameters in args; projectRoot absolute.',
      inputSchema: z.object({
        action: z.string().describe('micro | ask | command | agent | change'),
        args: z.record(z.any()).optional().describe('Action parameters; advanced operations use capability/action/args.'),
        projectRoot: z.string().describe('Absolute repository root.'),
      }).passthrough(),
    },
    async (input, extra) => {
      recordCallMeta(input, extra);
      const heartbeat = startProgressHeartbeat(extra, input);
      try {
      let args = { ...(input.arguments || {}), ...(input.args || {}) };
      if (input.action === 'micro') {
        const root = requireProjectRoot(input.projectRoot);
        const { action: microAction, ...microArgs } = args;
        const data = await dispatch('ops', {
          capability: 'micro',
          action: microAction || 'run',
          args: microArgs,
          projectRoot: root,
        });
        return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
      }
      if (['ask', 'command', 'agent'].includes(input.action)) {
        for (const field of ['overview', 'onboard', 'request', 'known', 'purpose', 'blockId', 'chainId', 'inspect', 'command', 'cwd', 'focus', 'background', 'id', 'resultId', 'maxChars', 'timeoutMs', 'task', 'workspace', 'context', 'adapter']) {
          if (input[field] !== undefined) args[field] = input[field];
        }
        const root = requireProjectRoot(input.projectRoot);
        const createdBefore = Date.now();
        const data = await dispatch(input.action, { ...args, projectRoot: root });
        const claims = claimMicroDeliveries(root, { createdBefore });
        const messageRoot = process.env.CONTEXTOS_WORKER_MODE === '1' ? process.env.CONTEXTOS_MICRO_REPORT_ROOT || root : root;
        const messageJobId = data.messageJobId || (process.env.CONTEXTOS_WORKER_MODE === '1' ? process.env.CONTEXTOS_MICRO_REPORT_JOB : null);
        const messages = data.messages || (messageJobId ? receiveMicroMessages(messageRoot, messageJobId, { peek: true }) : []);
        const delivered = [];
        const deliveredSourceRecords = [];
        let renderedSourceMetrics = null;
        let text;
        const claimedReports = claims.map((claim) => ({ id: claim.deliveryId, content: claim.content }));
        const renderedReports = [];
        const supersededReports = [];
        for (const report of claimedReports) {
          const reportJob = reportJobId(report.content);
          const job = reportJob ? readMicroJob(root, reportJob) : null;
          const terminalJobReport = job && job.status !== 'running' && hasAgentReportContent(job.report);
          const sameTerminalReport = input.action === 'agent'
            && hasAgentReportContent(data.report)
            && reportJob === data.id;
          if (terminalJobReport || sameTerminalReport) supersededReports.push(report.id);
          else renderedReports.push(report);
        }
        try {
          text = renderRequestResult({ ...data, reports: renderedReports, messages }, { maxChars: args.maxChars, onReportDelivered: (id) => delivered.push(id), onMessagesDelivered: (ids) => { if (messageJobId) acknowledgeMicroMessages(messageRoot, messageJobId, ids); }, onSourceDelivered: (record) => deliveredSourceRecords.push(record), onSourceMetrics: (metrics) => { renderedSourceMetrics = metrics; } });
          delivered.push(...supersededReports);
          if (delivered.length) completeMicroDeliveryClaims(root, delivered);
        } finally {
          const pending = claims.filter((claim) => !delivered.includes(claim.deliveryId)).map((claim) => claim.deliveryId);
          if (pending.length) releaseMicroDeliveryClaims(root, pending);
        }
        const sourceDelivery = input.action === 'ask' && data.resultId && deliveredSourceRecords.length
          ? await recordEvidenceDelivery(root, data.resultId, deliveredSourceRecords)
          : null;
        const measuredSource = sourceDelivery?.recorded
          ? sourceDelivery
          : renderedSourceMetrics;
        const accounting = input.action === 'ask' ? {
          materializedEvidenceBytes: Number.isSafeInteger(data.accounting?.materializedEvidenceBytes)
            ? data.accounting.materializedEvidenceBytes : null,
          materializedEvidenceChars: Number.isSafeInteger(data.accounting?.materializedEvidenceChars)
            ? data.accounting.materializedEvidenceChars : null,
          renderedSourceBytes: Number.isSafeInteger(measuredSource?.renderedSourceBytes)
            ? measuredSource.renderedSourceBytes : null,
          renderedSourceChars: Number.isSafeInteger(measuredSource?.renderedSourceChars)
            ? measuredSource.renderedSourceChars : null,
        } : undefined;
        const status = text.startsWith('status=partial') ? 'partial' : (data.status || (data.ok === false ? 'failed' : 'completed'));
        const response = {
          content: [{ type: 'text', text }],
          ...(status === 'failed' ? { isError: true } : {}),
        };
        if (!textOnlyResults()) {
          response.structuredContent = {
            status,
            ...(data.overview ? { overview: data.overview, lifecycle: data.lifecycle } : {}),
            ...(data.navigation ? { navigation: data.navigation } : {}),
            ...(data.navigation?.mode === 'onboard' && data.owners ? { owners: data.owners } : {}),
            ...(publicAgentProgress(data.progress) ? { progress: publicAgentProgress(data.progress) } : {}),
            ...(typeof data.cliSessionId === 'string' ? { cliSessionId: data.cliSessionId.slice(0, 160) } : {}),
            ...(data.jobStatus ? { jobStatus: data.jobStatus } : {}),
            ...(data.errorCode ? { errorCode: data.errorCode } : {}),
            ...(data.resultId ? { resultId: data.resultId } : {}),
            ...(sourceDelivery ? { sourceDelivery: sourceDelivery.recorded ? 'recorded' : 'unrecorded' } : {}),
            ...(accounting ? { accounting } : {}),
            ...(data.id || data.jobId ? { id: data.id || data.jobId } : {}),
            ...(data.receipt ? { receiptId: data.receipt.id, exitCode: data.receipt.exitCode } : {}),
          };
        }
        return response;
      }
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
      if (input.action === 'search') {
        const scope = {};
        for (const field of ['paths', 'root', 'maxResults', 'caseSensitive']) {
          if (args[field] !== undefined) scope[field] = args[field];
        }
        if (args.path !== undefined && scope.root === undefined) scope.root = args.path;
        const normalizeSearch = (value) => typeof value === 'string'
          ? { ...scope, query: value }
          : { ...scope, ...(value || {}), query: value?.query ?? args.query ?? '' };
        args.search = Array.isArray(args.search)
          ? args.search.map(normalizeSearch)
          : normalizeSearch(args.search);
        // Search paths constrain the query; they must not become work.inspect.
        delete args.paths;
        delete args.path;
      }
      // Named legacy actions stay reachable as `contextos({action:"plan",...})`.
      // They normalize onto the ops capability without changing the flat args
      // shape that callers already use, so both entry points stay equivalent.
      const namedActionCapabilities = {
        plan: 'plan', task: 'task', block: 'block', chain: 'chain',
        run_command: 'run_command', process: 'process', knowledge: 'knowledge',
        session: 'session', profile: 'profile',
      };
      if (namedActionCapabilities[input.action]) {
        const capability = namedActionCapabilities[input.action];
        const innerAction = args.action || (input.action === 'profile' ? 'get' : undefined);
        const normalized = { ...args };
        delete normalized.action;
        args = {
          capability,
          ...(innerAction !== undefined ? { action: innerAction } : {}),
          args: normalized,
        };
      }
      const compactAction = input.action === 'search' || (input.action === 'explore' && input.search !== undefined)
        ? 'work'
        : (input.action === 'create' ? 'change' : (namedActionCapabilities[input.action] ? 'ops' : input.action));
      if (compactAction === 'ops' && input.capability !== undefined && args.capability === undefined) {
        args.capability = input.capability;
      }
      if (compactAction === 'ops') {
        const knownCapabilities = new Set([
          'os_context', 'plan', 'task', 'block', 'chain', 'architecture', 'code', 'run_command', 'process',
          'knowledge', 'session', 'system', 'profile', 'micro', 'artifact', 'usage', 'telemetry',
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
      const normalizeProbe = (probe) => {
          if (!probe || typeof probe !== 'object' || typeof probe.ranges !== 'string') return probe;
          const ranges = probe.ranges.split(',').map((part) => {
            const match = part.trim().match(/^(\d+)\s*[-:]\s*(\d+)$/);
            if (!match || Number(match[1]) < 1 || Number(match[2]) < Number(match[1])) {
              throw new Error('Invalid ranges: use [[startLine,endLine]] or "start-end"; no source was read.');
            }
            return { startLine:Number(match[1]), endLine:Number(match[2]) };
          });
          return { ...probe, ranges };
        };
        if (args.inspect) args.inspect = Array.isArray(args.inspect)
          ? args.inspect.map(normalizeProbe) : normalizeProbe(args.inspect);
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
          action: args.action || 'run',
          args: { ...args },
          projectRoot: input.projectRoot,
        }));
      }
      if (compactAction === 'resume') {
        return textResult(await dispatch('ops', { ...payload, capability: 'session', action: 'resume' }));
      }
      const output = await dispatch(compactAction, payload);
      const response = ['change', 'work'].includes(compactAction) ? mutationResult(output) : textResult(output);
      if (textOnlyResults()) delete response.structuredContent;
      return response;
      } finally {
        heartbeat.stop();
      }
    }
  );

  return server;
}

if (process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1])) {
  const cliArgs = process.argv.slice(2);
  if (cliArgs[0] === '--agent-worker') {
    runAgentWorkerCli(cliArgs[1], cliArgs[2]).then((code) => {
      process.exitCode = code;
    });
  } else if (cliArgs.length > 0) {
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
