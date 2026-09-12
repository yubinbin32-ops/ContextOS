#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pluginRuntimeStatus } from "./plugin-runtime.mjs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { ProjectServiceRouter } from "./project-router.mjs";
import { runCli } from "./cli.mjs";
import { sanitizeTerminalOutput } from "./sanitizer.mjs";
import { boundTaskResponse, setTaskSourceBaseline, startTaskBudget, taskBudget, taskSourceBaseline } from "./task-budget.mjs";
import { normalizeMcpIds } from "./reference.mjs";

import { registerWorkspaceTools } from "./workspace-tools.mjs";

const router = new ProjectServiceRouter();
const server = new McpServer(
  { name: "contextos", version: "0.4.0" },
  {
    instructions:
      "contextos is project-scoped and runs in the background after installation; the user does not need to mention ContextOS in every conversation. At task start call context_for_task with the absolute projectRoot instead of reading documentation files broadly. For Plan work call plan_context: Plans contain direct Block work, ordered ChainScopes, canonical per-entity PlanChanges, and checkpoint gates. A Block is an independent architecture unit and may own its own Checkpoint; Blocks can form serial or parallel Chains, and a Chain may own a separate integration Checkpoint. A Plan records development intent and scope over that architecture; it does not own every Block or Chain, and unplanned architecture is valid. A Chain gate is required only when an integration Checkpoint is explicitly declared or bound to a Plan ChainScope. Active source bindings are rescanned at context, stream, validation, checkpoint, and project-command boundaries; file plus symbol/method name is stable identity, line ranges are derived. Use source_sync or changes_since(sourceSyncRevision=...) for compact drift deltas. An explicitly allowed external shell/IDE edit is detected at the next contextos boundary, not treated as a blocker. Chain reconciliation audits feature membership and order together: a related new Block should carry chain:<chain-id> and an explicit route Link, while safe forward route Links and high-confidence affiliated Blocks are attached automatically; an affinity tag without a route stays as an actionable membership gap; an intentional standalone Block carries standalone:<reason>. Feedback, read and dependency relations remain visible as cross-cutting edges when they would create a cycle. Repeat projectRoot when practical and change it explicitly when switching projects. Use graph_mutate for durable architecture/progress changes, checkpoint_record for evidence, changes_since for compact synchronization, change_set_revert only for safe update-only rollback, and graph_validate after structural or completion updates. Register an uninitialized directory with project_register before other tools.",
  },
);
const projectRootInput = {
  projectRoot: z.string().min(1).optional(),
  taskContextId: z.string().min(1).optional(),
};

function withProject(input, callback) {
  const service = router.serviceFor(input);
  const runtime = { version: '0.4.0', protocolVersion: 2, observedAt: new Date().toISOString(), pid: process.pid, projectRoot: service.paths.projectRoot, capabilities: ['documents','readme-readonly','task-sessions','source-index','projection-recovery','chapter-context','plan-append','chain-append','chain-reconcile','block-ast-slice','source-cache'], plugin: pluginRuntimeStatus(service.paths.projectRoot) };
  const runtimePath = path.join(service.paths.projectRoot, '.contextos', 'runtime.json');
  try { fs.writeFileSync(runtimePath + '.' + process.pid, JSON.stringify(runtime)); fs.renameSync(runtimePath + '.' + process.pid, runtimePath); } catch { /* read-only project: tools still report their result */ }
  const { projectRoot: _projectRoot, ...payload } = normalizeMcpIds(input);
  const data = callback(service, payload);
  if (data && typeof data === "object" && input.taskContextId) {
    Object.defineProperty(data, "__taskContextId", { value: input.taskContextId, enumerable: false });
  }
  return data;
}

function operationEnvelope(data, structured, operation, budget = null) {
  if (structured === undefined) return undefined;
  const truncated = Boolean(structured?.truncated);
  return {
    ok: data?.success === false ? false : data?.valid === false ? false : !Boolean(data?.error) && !["needs_work","projection_pending"].includes(data?.status),
    operation: operation ?? data?.operation ?? null,
    graphRevision: data?.graphRevision ?? null,
    sourceSyncRevision: data?.sourceSync?.revision ?? data?.sourceSyncRevision ?? null,
    changed: data?.sourceSync?.changed ?? data?.changed ?? false,
    truncated,
    budget: budget ?? data?.budget ?? structured?.budget ?? null,
    data: structured,
  };
}

function readResult(data, markdown, includeStructured = false, operation = null) {
  const bounded = boundTaskResponse({
    taskContextId: data?.__taskContextId,
    markdown,
    data,
    includeStructured,
  });
  return response(data, bounded.markdown, operationEnvelope(data, bounded.structured, operation, bounded.budget));
}

function writeResult(data, markdown, includeStructured = false, operation = null) {
  const text = (markdown ?? data?.markdown ?? writeReceiptMarkdown(data)) + (data?.projection?.status === "pending" ? `\nProjection pending: ${data.projection.error}` : "");
  const bounded = boundTaskResponse({
    taskContextId: data?.__taskContextId,
    markdown: text,
    data,
    includeStructured,
    critical: true,
  });
  return response(data, bounded.markdown, operationEnvelope(data, bounded.structured, operation, bounded.budget));
}

function writeReceiptMarkdown(data = {}) {
  if (data?.changeSetId && Number.isInteger(data?.graphRevision)) {
    return [
      "# Graph mutation",
      `- ChangeSet: ${data.changeSetId}`,
      `- Graph revision: ${data.graphRevision}`,
      ...(Array.isArray(data.receipts) && data.receipts.length
        ? ["", "## Applied operations", ...data.receipts.map((receipt) =>
          `- ${receipt.action ?? "updated"} ${receipt.ref ?? `${receipt.entityType ?? "entity"}:${receipt.id ?? "?"}`} · r${receipt.revision ?? "?"}`)]
        : []),
    ].join("\n");
  }
  if (data?.checkpoint && data?.changeSetId) {
    const checkpoint = data.checkpoint;
    return [
      "# Checkpoint recorded",
      `- Checkpoint: ${checkpoint.id}`,
      `- Status: ${checkpoint.status}`,
      `- Target: ${checkpoint.targetType ?? "?"}:${checkpoint.targetId ?? "?"}`,
      `- Revision: ${checkpoint.revision ?? "?"}`,
      `- Graph revision: ${data.graphRevision}`,
      `- ChangeSet: ${data.changeSetId}`,
    ].join("\n");
  }
  if (typeof data?.valid === "boolean") {
    return [
      "# Graph validation",
      `- Status: ${data.valid ? "valid" : "invalid"}`,
      `- Graph revision: ${data.graphRevision ?? "?"}`,
      `- Errors: ${data.errors?.length ?? 0}`,
      `- Warnings: ${data.warnings?.length ?? 0}`,
      ...(data.errors?.length ? ["", "## Errors", ...data.errors.map((item) => `- ${item}`)] : []),
      ...(data.warnings?.length ? ["", "## Warnings", ...data.warnings.map((item) => `- ${item}`)] : []),
    ].join("\n");
  }
  return "# contextos operation\n- Completed";
}

// Read tools are Markdown-first. MCP clients may place both content and
// structuredContent in the model context, so duplicating a projection in both
// fields wastes tokens and can make the model choose stale values. Every tool
// is Markdown-first; callers opt into the exact JSON projection with
// includeStructured=true.
function response(data, markdown, structuredContent) {
  const output = { content: [{ type: "text", text: markdown ?? JSON.stringify(data) }] };
  if (structuredContent !== undefined) output.structuredContent = structuredContent;
  return output;
}

registerWorkspaceTools(server, withProject, readResult, writeResult);

server.registerTool(
  "project_register",
  {
    description:
      "Register an existing directory as an contextos project. This creates only .contextos/project.json and is idempotent when the descriptor already exists.",
    inputSchema: {
      projectRoot: z.string().min(1),
      name: z.string().min(1).optional(),
      id: z.string().min(1).optional(),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = router.register(input);
    return writeResult(data, `${data.created ? "Registered" : "Opened"} ${data.descriptor.name} at ${data.projectRoot}.`, input.includeStructured);
  },
);

server.registerTool(
  "project_map",
  {
    description: "Read a compact project map with architecture coverage, ordered Plans, Chain paths, explicit integration gates, and source-sync status without loading entity bodies.",
    inputSchema: { ...projectRootInput, locale: z.enum(["en", "zh-Hans"]).optional(), includeStructured: z.boolean().default(false) },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.projectMap(payload));
    return readResult(data, data.markdown, input.includeStructured);
  },
);

server.registerTool(
  "decision_list",
  {
    description: "Read the compact project-scoped Decision index. Bodies, rationale, alternatives, and consequences are omitted; use decision_open or entity_open(type=decision) for one record.",
    inputSchema: { ...projectRootInput, locale: z.enum(["en", "zh-Hans"]).optional(), includeStructured: z.boolean().default(false) },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.decisionList(payload));
    return readResult(data, data.markdown, input.includeStructured);
  },
);

server.registerTool(
  "decision_open",
  {
    description: "Open one architecture Decision. Returns its rationale, alternatives, consequences, scope, supersession, and compact History.",
    inputSchema: { ...projectRootInput, id: z.string().min(1), historyLimit: z.number().int().min(0).max(30).optional(), locale: z.enum(["en", "zh-Hans"]).optional(), includeStructured: z.boolean().default(false) },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.entityOpen({ ...payload, type: "decision" }));
    return readResult(data, data.markdown, input.includeStructured);
  },
);

server.registerTool(
  "chain_code_stream",
  {
    description: "Return locator-only source indexes along a Chain: path, symbol, signature, derived line range, source status, and contract. Never returns implementation bodies.",
    inputSchema: {
      ...projectRootInput,
      chainId: z.string().min(1),
      maxTotalChars: z.number().int().min(100).max(20000).optional(),
      mode: z.enum(["contract"]).default("contract"),
      maxLinesPerSymbol: z.number().int().min(4).max(40).optional(),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.chainCodeStream(payload));
    return readResult(data, data.markdown, input.includeStructured);
  },
);

server.registerTool(
  "block_code_stream",
  {
    description:
      "Return one Block's exact source locator and, only when explicitly requested, an AST-bounded symbol slice. The containing file is never returned.",
    inputSchema: {
      ...projectRootInput,
      blockId: z.string().min(1),
      maxChars: z.number().int().min(500).max(20000).optional(),
      maxLines: z.number().int().min(4).max(240).optional(),
      mode: z.enum(["contract", "slice"]).default("slice"),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.blockCodeStream(payload));
    return readResult(data, data.codeStream, input.includeStructured, "block_code_stream");
  },
);

server.registerTool(
  "source_sync",
  {
    description:
      "Scan current files for bound symbols without loading source into the response. Reports moved, changed, missing, or ambiguous bindings and affected Blocks/Chains.",
    inputSchema: {
      ...projectRootInput,
      sinceRevision: z.number().int().min(0).optional(),
      includeUnchanged: z.boolean().default(false),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.sourceBindingReport(payload));
    const md = [
      "# Source Synchronization",
      `- Status: ${data.invalidBindingCount ? "attention required" : data.changed ? "updated" : "in sync"}`,
      `- Revision: ${data.sourceSyncRevision} · Bindings: ${data.bindingCount} · Invalid: ${data.invalidBindingCount}`,
      ...(data.affectedBlockIds?.length ? [`- Affected Blocks: ${data.affectedBlockIds.map((id) => `block:${id}`).join(", ")}`] : []),
      ...(data.affectedChainIds?.length ? [`- Affected Chains: ${data.affectedChainIds.map((id) => `chain:${id}`).join(", ")}`] : []),
      ...(data.changes?.length ? ["", "## Changes", ...data.changes.slice(0, 20).map((change) =>
        `- block:${change.blockId} ${change.symbol ?? change.path} · ${change.kinds.join(", ")}`)] : []),
      ...(data.unboundCandidates?.length ? ["", "## Unbound candidates", ...data.unboundCandidates.map((candidate) =>
        `- block:${candidate.blockId} \`${candidate.path}:${candidate.symbol}\` · ${candidate.role} · ${candidate.confidence}`)] : []),
      ...(data.editPath ? [`- Edit path: ${data.editPath}`] : []),
    ].join("\n");
    return readResult(data, md, input.includeStructured);
  },
);

server.registerTool(
  "source_binding_suggest",
  {
    description:
      "Suggest source bindings for a Block from AST symbols and project semantics. Suggestions are read-only; use source_binding_accept to persist an explicitly chosen candidate.",
    inputSchema: {
      ...projectRootInput,
      blockId: z.string().min(1),
      limit: z.number().int().min(1).max(50).optional(),
      maxFiles: z.number().int().min(1).max(2000).optional(),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.suggestSourceBindings(payload));
    const md = [
      `# Source Binding Suggestions: block:${data.blockId}`,
      `- Scanned files: ${data.scannedFiles}`,
      `- Candidates: ${data.candidates.length}`,
      ...(data.candidates.length ? ["", ...data.candidates.map((candidate, index) =>
        `${index + 1}. \`${candidate.path}:${candidate.symbol}\` · ${candidate.role} · confidence ${candidate.confidence} · ${candidate.reasons.join("; ")}`)] : ["", "No candidate bindings found."]),
      "",
      "Suggestions are read-only. Confirm a candidate explicitly with source_binding_accept.",
    ].join("\n");
    return readResult(data, md, input.includeStructured, "source_binding_suggest");
  },
);

server.registerTool(
  "source_binding_accept",
  {
    description:
      "Persist explicitly selected AST source binding candidates for a Block. Every candidate is re-resolved against current source before a SourceRef is created.",
    inputSchema: {
      ...projectRootInput,
      blockId: z.string().min(1),
      bindings: z.array(z.object({
        path: z.string().min(1),
        symbol: z.string().min(1),
        role: z.enum(["facade", "implementation", "persistence", "renderer", "controller", "test", "config"]).optional(),
      })).min(1).max(20),
      actor: z.string().optional(),
      reason: z.string().optional(),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.acceptSourceBindings(payload));
    const md = [
      `# Source Bindings Accepted: block:${data.blockId}`,
      `- Added: ${data.accepted.length}`,
      `- Changed: ${data.changed ? "yes" : "no"}`,
      ...(data.accepted.length ? ["", ...data.accepted.map((binding) => `- ${binding.role}: \`${binding.path}:${binding.symbol}\` (${binding.startLine}-${binding.endLine})`)] : []),
      ...(data.sourceSync ? [`- Source sync revision: ${data.sourceSync.revision}`] : []),
    ].join("\n");
    return writeResult(data, md, input.includeStructured, "source_binding_accept");
  },
);

server.registerTool(
  "block_seal",
  {
    description:
      "Seal a verified Block implementation as complete. Requires valid current SourceBindings and a fresh passed direct Checkpoint; an executionId, when supplied, must be a successful receipt cited by that Checkpoint.",
    inputSchema: {
      ...projectRootInput,
      blockId: z.string().min(1),
      checkpointId: z.string().min(1).optional(),
      executionId: z.string().min(1).optional(),
      actor: z.string().optional(),
      reason: z.string().optional(),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.sealBlock(payload));
    const md = [
      `# Block Seal: ${data.sealed ? "complete" : "not sealed"}`,
      `- Block: block:${data.blockId}`,
      `- Delivery state: ${data.deliveryState ?? "complete"}`,
      `- Checkpoint: ${data.checkpointId}`,
      ...(data.executionId ? [`- Execution: ${data.executionId}`] : []),
      `- Changed: ${data.changed ? "yes" : "no"}${data.idempotent ? " (already sealed)" : ""}`,
      ...(data.graphRevision !== undefined ? [`- Graph revision: ${data.graphRevision}`] : []),
    ].join("\n");
    return writeResult(data, md, input.includeStructured, "block_seal");
  },
);

server.registerTool(
  "run_command",
  {
    description:
      "Run one project-local command and return only a redacted, compressed terminal summary. Raw stdout/stderr never enters the MCP response; use this gateway for tests, builds, and mutation verification.",
    inputSchema: {
      ...projectRootInput,
      command: z.string().min(1),
      cwd: z.string().min(1).optional(),
      timeoutMs: z.number().int().min(100).max(120000).optional(),
      maxChars: z.number().int().min(100).max(10000).optional(),
      executionKind: z.enum(["command", "test", "build"]).optional(),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.runCommand(payload));
    const markdown = [
      `# Command Result: ${data.success ? "PASSED" : "FAILED"}`,
      `- Execution: ${data.executionId} · Kind: ${data.executionKind} · Duration: ${data.durationMs}ms`,
      `- Command: \`${data.command}\``,
      `- Exit code: ${data.exitCode} · Output: ${data.originalChars} → ${data.finalChars} chars · Redactions: ${data.redactions}`,
      "",
      "```text",
      data.output,
      "```",
    ].join("\n");
    return readResult(data, markdown, input.includeStructured, "run_command");
  },
);

server.registerTool(
  "checkpoint_refresh_candidates",
  {
    description:
      "List stale checkpoints that a recorded execution receipt can refresh. Does not auto-pass checkpoints; it only maps changed bindings onto retest_required items.",
    inputSchema: {
      ...projectRootInput,
      executionId: z.string().min(1).optional(),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.checkpointRefreshCandidates(payload));
    return readResult(data, data.markdown, input.includeStructured, "checkpoint_refresh_candidates");
  },
);

server.registerTool(
  "log_sanitize",
  {
    description: "Sanitize build, test, or terminal command outputs. Strips ANSI noise, collapses routine compiler stdout, and isolates actionable failure stack traces to protect context window from token flooding.",
    inputSchema: {
      ...projectRootInput,
      rawOutput: z.string().min(1),
      exitCode: z.number().int().optional(),
      maxChars: z.number().int().min(100).max(10000).optional(),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = input.projectRoot
      ? withProject(input, (service, payload) => service.sanitizeLog(payload))
      : sanitizeTerminalOutput(input.rawOutput, {
        exitCode: input.exitCode,
        maxChars: input.maxChars,
      });
    const markdown = [
      `# Sanitized Output (${data.reductionRatio} noise reduced)`,
      `- Original: ${data.originalLength} chars | Cleaned: ${data.sanitizedLength} chars`,
      `- State: ${data.hasErrors ? "Failures detected" : "Clean routine output"}`,
      "",
      "```text",
      data.text,
      "```",
    ].join("\n");
    return readResult(data, markdown, input.includeStructured);
  },
);

server.registerTool(
  "foundation_plan_create",
  {
    description:
      "Generate one Foundation Plan from every non-deprecated unimplemented Block. Because this is an explicit implementation/verification Plan, the operation creates missing atomic Block checkpoints, direct Block PlanChanges, dependency-ordered parallel steps, Chain integration gates, and a final Plan acceptance gate in one transaction; plain architecture-only create_block does not.",
    inputSchema: {
      ...projectRootInput,
      id: z.string().min(1).default("foundation-plan"),
      title: z.string().min(1).default("Foundation Plan"),
      goal: z.string().min(1).optional(),
      requiredEvidenceLevel: z.enum(["none", "static", "simulated", "integration", "real_target", "human_review"]).default("integration"),
      actor: z.string().optional(),
      reason: z.string().min(1).optional(),
      gitHead: z.string().nullable().optional(),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.createFoundationPlan(payload));
    const text = `Generated plan:${data.plan?.id ?? input.id} with ${data.generated?.blockIds?.length ?? 0} direct Block(s), ${data.generated?.chainIds?.length ?? 0} Chain gate(s), and acceptance checkpoint ${data.generated?.planAcceptanceCheckpointId ?? "—"}.`;
    return writeResult(data, text, input.includeStructured);
  },
);

server.registerTool(
  "context_for_task",
  {
    description:
      "Get a budgeted Markdown context pack for the current development task. Use at task start and expand only selected refs.",
    inputSchema: {
      ...projectRootInput,
      task: z.string().min(1),
      focusRefs: z.array(z.string()).max(20).optional(),
      maxChars: z.number().int().min(1000).max(24000).default(6000),
      budgetChars: z.number().int().min(4000).max(48000).default(12000),
      locale: z.enum(["en", "zh-Hans"]).optional(),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const budget = startTaskBudget({
      projectRoot: input.projectRoot,
      taskContextId: input.taskContextId,
      budgetChars: input.budgetChars,
    });
    const data = withProject(
      { ...input, taskContextId: budget.taskContextId },
      (service, payload) => service.contextForTask(payload),
    );
    data.taskContextId = budget.taskContextId;
    setTaskSourceBaseline(budget.taskContextId, {
      sourceSyncRevision: data.sourceSync?.revision ?? null,
      sourceRevision: data.sourceSync?.sourceRevision ?? null,
    });
    data.taskBudget = taskBudget(budget.taskContextId);
    const budgetLine = `\n\n## Task budget\n- Context ID: ${budget.taskContextId} · Total: ${budget.budgetChars} chars · Shared across focused reads.`;
    return readResult(data, `${data.markdown}${budgetLine}`, input.includeStructured);
  },
);

server.registerTool(
  "plan_context",
  {
    description:
      "Read one Plan as a compact hierarchical development document: overview, ordered ChainScopes, inline Block/Link/Chain changes, checkpoint gates, and exact source refs. This is the primary read before implementing a Plan.",
    inputSchema: {
      ...projectRootInput,
      id: z.string().min(1),
      maxChars: z.number().int().min(1000).max(24000).default(12000),
      locale: z.enum(["en", "zh-Hans"]).optional(),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.planContext(payload));
    return readResult(data, data.markdown, input.includeStructured);
  },
);

server.registerTool(
  "plan_append_changes",
  {
    description:
      "Append new canonical Block, Link, or Chain work to an existing Plan without replacing its prior changes. Use the current Plan revision returned by plan_context.",
    inputSchema: {
      ...projectRootInput,
      planId: z.string().min(1),
      expectedRevision: z.number().int().min(1),
      changes: z.array(z.object({
        id: z.string().min(1).optional(),
        entityType: z.enum(["block", "link", "chain"]),
        entityId: z.string().min(1),
        title: z.string().min(1),
        summary: z.string().optional(),
        currentBehavior: z.string().optional(),
        proposedBehavior: z.string().optional(),
        rationale: z.string().optional(),
        prohibitions: z.array(z.string()).optional(),
        expectedEffects: z.array(z.string()).optional(),
        sourceRefs: z.array(z.string()).optional(),
        localizations: z.record(z.string(), z.unknown()).optional(),
        status: z.enum(["pending", "active", "complete", "blocked", "failed", "skipped"]).optional(),
      }).strict()).min(1).max(20),
      actor: z.string().optional(),
      reason: z.string().optional(),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.appendPlanChanges(payload));
    return writeResult(data, `Appended Plan changes to plan:${input.planId}. Graph revision ${data.graphRevision}.`, input.includeStructured, "plan_append_changes");
  },
);

server.registerTool(
  "plan_append_chain_scope",
  {
    description:
      "Append one ordered ChainScope to an existing Plan while preserving its other scopes. Use this when an existing feature Plan grows to cover another Chain path.",
    inputSchema: {
      ...projectRootInput,
      planId: z.string().min(1),
      expectedRevision: z.number().int().min(1),
      scope: z.object({
        id: z.string().min(1).optional(),
        chainId: z.string().min(1),
        title: z.string().min(1),
        summary: z.string().optional(),
        rationale: z.string().optional(),
        startBlockId: z.string().optional(),
        endBlockId: z.string().optional(),
        nodeIds: z.array(z.string()).optional(),
        linkIds: z.array(z.string()).optional(),
        expectedDelta: z.array(z.unknown()).optional(),
        prohibitions: z.array(z.string()).optional(),
        localizations: z.record(z.string(), z.unknown()).optional(),
        status: z.enum(["pending", "active", "complete", "blocked", "failed", "skipped"]).optional(),
      }).strict(),
      actor: z.string().optional(),
      reason: z.string().optional(),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.appendPlanChainScope(payload));
    return writeResult(data, `Appended ChainScope to plan:${input.planId}. Graph revision ${data.graphRevision}.`, input.includeStructured, "plan_append_chain_scope");
  },
);

server.registerTool(
  "timeline_view",
  {
    description:
      "Read the unified project Timeline: execution phases, ordered plans (P0 > P1 > P2), and current active cursor (nowDoing, nextUp, lastFinished).",
    inputSchema: { ...projectRootInput, includeStructured: z.boolean().default(false) },
  },
  async (input) => {
    const data = withProject(input, (service) => service.getTimeline());
    return readResult(data, data.markdown, input.includeStructured);
  },
);

server.registerTool(
  "timeline_sync",
  {
    description:
      "Synchronize development cursor and active focus across conversations. Updates nowDoing, nextUp, and active step in the timeline.",
    inputSchema: {
      ...projectRootInput,
      planId: z.string().optional(),
      stepId: z.string().optional(),
      nowDoing: z.string().optional(),
      nextUp: z.string().optional(),
      lastFinished: z.string().optional(),
      touchedFiles: z.array(z.string()).optional(),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.syncTimeline(payload));
    const md = [
      "# Timeline Synchronized",
      `- Plan: \`plan:${data.activePlanId ?? "none"}\``,
      ...(data.activeStepId ? [`- Step: \`${data.activeStepId}\``] : []),
      `- Now Doing: ${data.nowDoing}`,
      ...(data.nextUp ? [`- Next Up: ${data.nextUp}`] : []),
      ...(data.lastFinished ? [`- Last Finished: ${data.lastFinished}`] : []),
    ].join("\n");
    return writeResult(data, md, input.includeStructured);
  },
);

server.registerTool(
  "step_advance",
  {
    description:
      "Advance the active step of a Plan to complete, automatically updating progress and pointing nowDoing to the next step.",
    inputSchema: {
      ...projectRootInput,
      planId: z.string().optional(),
      stepId: z.string().optional(),
      status: z.enum(["complete", "active", "skipped", "failed"]).default("complete"),
      summary: z.string().optional(),
      nextStepId: z.string().optional(),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.advanceStep(payload));
    const md = [
      "# Step Advanced",
      `- Plan: \`plan:${data.activePlanId ?? "none"}\``,
      `- Finished: ${data.lastFinished}`,
      `- Now Doing: ${data.nowDoing}`,
      ...(data.nextUp ? [`- Next Up: ${data.nextUp}`] : []),
    ].join("\n");
    return writeResult(data, md, input.includeStructured);
  },
);

server.registerTool(
  "changes_since",
  {
    description:
      "Read only graph/checkpoint mutations after a known change sequence. Use this for live synchronization and compact read-back instead of reloading the project.",
    inputSchema: {
      ...projectRootInput,
      sequence: z.number().int().min(0).default(0),
      sourceSyncRevision: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(500).default(100),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const baseline = taskSourceBaseline(input.taskContextId);
    const data = withProject(input, (service, payload) => service.changesSince({
      ...payload,
      sourceSyncRevision: payload.sourceSyncRevision ?? baseline?.sourceSyncRevision ?? null,
    }));
    return readResult(data, data.markdown, input.includeStructured);
  },
);

server.registerTool(
  "change_set_revert",
  {
    description:
      "Create a new reverse ChangeSet for a safe, fully reversible update-only ChangeSet. Original History is preserved; stale or unsupported changes are rejected instead of partially reverted.",
    inputSchema: {
      ...projectRootInput,
      changeSetId: z.string().min(1),
      actor: z.string().optional(),
      reason: z.string().optional(),
      task: z.string().optional(),
      gitHead: z.string().nullable().optional(),
      planId: z.string().optional(),
      chainScopeId: z.string().optional(),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.revertChangeSet(payload));
    return writeResult(data, `Reverted ChangeSet ${input.changeSetId}. Graph revision ${data.graphRevision}. New ChangeSet ${data.changeSetId}.`, input.includeStructured);
  },
);

server.registerTool(
  "entity_open",
  {
    description: "Open one Block, Chain, Link, Plan, or Decision with only relevant details and recent History.",
    inputSchema: {
      ...projectRootInput,
      type: z.enum(["block", "chain", "link", "plan", "decision"]),
      id: z.string().min(1),
      historyLimit: z.number().int().min(0).max(30).optional(),
      locale: z.enum(["en", "zh-Hans"]).optional(),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.entityOpen(payload));
    return readResult(data, data.markdown, input.includeStructured);
  },
);

server.registerTool(
  "checkpoint_list",
  {
    description:
      "List checkpoints by status, target, Plan or ChainScope, including standalone checkpoints that are not referenced by any Plan. Use this for a compact verification inbox instead of opening every entity.",
    inputSchema: {
      ...projectRootInput,
      status: z.enum(["pending", "running", "passed", "partial_pass", "failed", "blocked", "not_supported", "retest_required"]).optional(),
      targetType: z.enum(["block", "chain", "link", "plan"]).optional(),
      targetId: z.string().min(1).optional(),
      planId: z.string().min(1).optional(),
      chainScopeId: z.string().min(1).optional(),
      unassignedOnly: z.boolean().default(false),
      limit: z.number().int().min(1).max(500).default(100),
      locale: z.enum(["en", "zh-Hans"]).optional(),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.checkpointList(payload));
    return readResult(data, data.markdown, input.includeStructured);
  },
);

server.registerTool(
  "graph_search",
  {
    description: "Search graph entities and source paths without loading the entire project.",
    inputSchema: {
      ...projectRootInput,
      query: z.string().min(1),
      kinds: z.array(z.string()).optional(),
      states: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      locale: z.enum(["en", "zh-Hans"]).optional(),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.search(payload));
    return readResult(data, data.markdown, input.includeStructured);
  },
);

server.registerTool(
  "graph_mutate",
  {
    description:
      "Atomically create or patch Blocks, project-scoped Decisions, global Links, Chain paths, independent Plans, atomic Checkpoints, Background scopes, Decision scopes, and source refs. Decisions are not Canvas Blocks and never enter Block/Chain/Plan coverage. A plain create_block records architecture only; use create_checkpoint in the same ChangeSet when a requirement, Plan, Chain gate, or explicit verification request makes the check necessary. Link kinds are flows_to, calls, reads, writes, depends_on, implements, validates, constrains, and supersedes. Keep each call small and provide expectedRevision for updates.",
    inputSchema: {
      ...projectRootInput,
      actor: z.string().optional(),
      reason: z.string().min(1),
      task: z.string().optional(),
      gitHead: z.string().nullable().optional(),
      planId: z.string().optional(),
      chainScopeId: z.string().optional(),
      includeStructured: z.boolean().default(false),
      operations: z
        .array(
          z.object({
            action: z.enum([
              "create_block",
              "update_block",
              "delete_block",
              "create_decision",
              "update_decision",
              "delete_decision",
              "create_checkpoint",
              "delete_checkpoint",
              "record_checkpoint",
              "add_source_ref",
              "remove_source_ref",
              "create_chain",
              "update_chain",
              "delete_chain",
              "create_link",
              "update_link",
              "delete_link",
              "create_plan",
              "update_plan",
              "delete_plan",
              "set_plan_chains",
              "set_plan_dependencies",
              "set_plan_steps",
              "update_plan_step",
              "set_plan_checkpoints",
              "set_plan_chain_scopes",
              "update_plan_chain_scope",
              "set_plan_changes",
              "append_plan_changes",
              "update_plan_change",
              "update_plan_changes",
              "set_plan_chain_change_refs",
              "set_checkpoint_bindings",
              "set_checkpoint_dependencies",
              "set_chain_path",
              "append_chain_path",
              "set_background_scopes",
              "set_decision_scopes",
            ]),
            id: z.string().optional(),
            expectedRevision: z.number().int().optional(),
            fields: z.record(z.string(), z.unknown()).optional(),
            summary: z.string().optional(),
          }),
        )
        .min(1)
        .max(20),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.mutate(payload));
    const text = `Applied ${data.receipts.length} operation(s). Graph revision ${data.graphRevision}. ChangeSet ${data.changeSetId}.`;
    return writeResult(data, text, input.includeStructured);
  },
);

server.registerTool(
  "graph_patch",
  {
    description:
      "Apply a compact contextos/1 Markdown-like patch. The server expands it into the same atomic ChangeSet used by graph_mutate, preserves omitted fields, and can create an atomic Block checkpoint with checkpoint=auto.",
    inputSchema: {
      ...projectRootInput,
      patch: z.string().min(1).max(65536),
      actor: z.string().optional(),
      reason: z.string().optional(),
      task: z.string().optional(),
      gitHead: z.string().nullable().optional(),
      planId: z.string().optional(),
      chainScopeId: z.string().optional(),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.graphPatch(payload));
    return writeResult(data, data.markdown, input.includeStructured);
  },
);

server.registerTool(
  "graph_flow",
  {
    description:
      "Declare architectural flows and pipelines using natural arrow expressions like 'block:A -> block:B -> block:C' or 'A -[calls]-> B'. Automatically creates or updates links without complex JSON crafting.",
    inputSchema: {
      ...projectRootInput,
      flow: z.string().min(1),
      actor: z.string().optional(),
      reason: z.string().optional(),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) =>
      service.applyArrowFlow(payload.flow, { actor: payload.actor, reason: payload.reason }),
    );
    const md = [
      "# Flow Applied",
      `- Flow: \`${data.flow}\``,
      `- Links modified: ${data.links?.length ?? 0}`,
      `- Graph revision: ${data.graphRevision}`,
      ...(Array.isArray(data.links) && data.links.length
        ? ["", "## Links", ...data.links.map((l) => `- \`block:${l.sourceId}\` -[${l.kind}]-> \`block:${l.targetId}\` (${l.updated ? "updated" : "created"})`)]
        : []),
    ].join("\n");
    return writeResult(data, md, input.includeStructured);
  },
);

server.registerTool(
  "chain_append",
  {
    description:
      "Append Blocks and Links to an existing Chain without replaying its complete path. Use graph_flow or architecture_connect first so every appended Link has explicit endpoints.",
    inputSchema: {
      ...projectRootInput,
      chainId: z.string().min(1),
      expectedRevision: z.number().int().min(1),
      nodeIds: z.array(z.string()).default([]),
      linkIds: z.array(z.string()).default([]),
      actor: z.string().optional(),
      reason: z.string().optional(),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.appendChainPath(payload));
    return writeResult(data, `Appended Chain path to chain:${input.chainId}. Graph revision ${data.graphRevision}.`, input.includeStructured, "chain_append");
  },
);

server.registerTool(
  "chain_reconcile",
  {
    description:
      "Reconcile an existing Chain's feature membership and declared order. Explicitly affiliated or high-confidence linked Blocks and missing forward route Links are added automatically; an affinity Block without a route is returned as a membership gap. Feedback, read and dependency relations stay visible as cross-cutting edges when they would create a cycle. Cycles, backward edges and disconnected components remain actionable issues.",
    inputSchema: {
      ...projectRootInput,
      chainId: z.string().min(1),
      autoExpand: z.boolean().default(true),
      autoReorder: z.boolean().default(true),
      actor: z.string().optional(),
      reason: z.string().optional(),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => {
      const network = service.reconcileChainNetwork({ chainId: payload.chainId, autoExpand: payload.autoExpand, reason: payload.reason || "Reconcile Chain feature network" });
      const topology = service.reconcileChainTopology({ chainId: payload.chainId, autoReorder: payload.autoReorder, reason: payload.reason || "Reconcile Chain topology" });
      return { ...network, topology, changedChainIds: [...new Set([...(network.changedChainIds || []), ...(topology.changedChainIds || [])])], issues: [...(network.reports || []).flatMap((report) => report.issues || []), ...(topology.issues || [])], graphRevision: service.project().graph_revision };
    });
    const markdown = [
      `# Chain topology reconciliation: ${input.chainId}`,
      `- Graph revision: ${data.graphRevision}`,
      `- Reconciled: ${data.changedChainIds?.length ? data.changedChainIds.map((id) => `chain:${id}`).join(", ") : "none"}`,
      ...(data.issues?.length ? ["", "## Issues", ...data.issues.map((issue) => `- ${issue.detail}`)] : ["- Topology is ordered and connected."]),
    ].join("\n");
    return writeResult(data, markdown, input.includeStructured, "chain_reconcile");
  },
);

server.registerTool(
  "architecture_link_suggest",
  {
    description:
      "Suggest high-confidence architectural links for an architecture Block based on AST source imports and layered conventions.",
    inputSchema: {
      ...projectRootInput,
      blockId: z.string().min(1),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.suggestLinks(payload.blockId));
    const suggestions = Array.isArray(data) ? data : [];
    const md = [
      `# Link Suggestions for block:${input.blockId}`,
      `- Found: ${suggestions.length} suggestion(s)`,
      ...(suggestions.length
        ? ["", ...suggestions.map((s) => `- \`block:${s.sourceId}\` -[${s.kind}]-> \`block:${s.targetId}\` (${s.confidence} confidence): ${s.reason}`)]
        : ["- No new link suggestions found."]),
    ].join("\n");
    return readResult(data, md, input.includeStructured);
  },
);

server.registerTool(
  "architecture_connect",
  {
    description:
      "Connect two architecture Blocks with a validated Link in one simple call without crafting manual operations.",
    inputSchema: {
      ...projectRootInput,
      sourceId: z.string().min(1),
      targetId: z.string().min(1),
      kind: z.enum(["flows_to", "calls", "reads", "writes", "depends_on", "implements", "validates", "constrains", "supersedes"]).default("calls"),
      label: z.string().optional(),
      contract: z.string().optional(),
      actor: z.string().optional(),
      reason: z.string().optional(),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.connectBlocks(payload));
    const md = [
      "# Architecture Connected",
      `- Link: \`block:${input.sourceId}\` -[${input.kind}]-> \`block:${input.targetId}\``,
      `- Graph revision: ${data.graphRevision}`,
      `- ChangeSet: ${data.changeSetId}`,
    ].join("\n");
    return writeResult(data, md, input.includeStructured);
  },
);

server.registerTool(
  "checkpoint_record",
  {
    description:
      "Create or update a checkpoint with evidence. Passed checkpoints are the only basis for healthy completion states.",
    inputSchema: {
      ...projectRootInput,
      actor: z.string().optional(),
      id: z.string().optional(),
      targetType: z.enum(["block", "chain", "link", "plan"]),
      targetId: z.string().min(1),
      title: z.string().min(1),
      criteria: z.string().optional(),
      status: z.enum(["pending", "running", "passed", "partial_pass", "failed", "blocked", "not_supported", "retest_required"]),
      checkpointKind: z.enum(["atomic", "aggregate", "integration"]).optional(),
      aggregationPolicy: z.record(z.string(), z.unknown()).optional(),
      eligibleAfterChildren: z.boolean().optional(),
      evidenceLevel: z.enum(["none", "static", "simulated", "integration", "real_target", "human_review"]).optional(),
      requiredEvidenceLevel: z.enum(["none", "static", "simulated", "integration", "real_target", "human_review"]).optional(),
      coverage: z.enum(["complete", "partial"]).optional(),
      evidence: z.array(z.record(z.string(), z.unknown())).optional(),
      evidenceExecutionIds: z.array(z.string().min(1)).optional(),
      invalidatedAt: z.string().nullable().optional(),
      expectedRevision: z.number().int().optional(),
      planId: z.string().optional(),
      chainScopeId: z.string().optional(),
      gitHead: z.string().nullable().optional(),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.recordCheckpoint(payload));
    return writeResult(data, `Recorded checkpoint ${data.checkpoint.id} for ${data.checkpoint.status}. Graph revision ${data.graphRevision}.`, input.includeStructured, "checkpoint_record");
  },
);

server.registerTool(
  "graph_validate",
  {
    description: "Validate global graph references, Chain paths, Plan targets, Background scopes, contracts, and checkpoint-backed completion.",
    inputSchema: { ...projectRootInput, includeStructured: z.boolean().default(false) },
  },
  async (input) => {
    const data = withProject(input, (service) => service.validate());
    return writeResult(data, undefined, input.includeStructured, "graph_validate");
  },
);

server.registerTool(
  "graph_status",
  {
    description: "Inspect project architecture health, live drift detection, isolated blocks, ghost blocks with code, and pending verification gates.",
    inputSchema: {
      ...projectRootInput,
      locale: z.enum(["en", "zh-Hans"]).optional(),
      includeStructured: z.boolean().default(false),
    },
  },
  async (input) => {
    const data = withProject(input, (service, payload) => service.graphStatus(payload));
    return readResult(data, data.markdown, input.includeStructured);
  },
);

const cliArgs = process.argv.slice(2);
if (cliArgs.length > 0 && cliArgs[0] !== "serve" && !cliArgs[0].startsWith("--mcp")) {
  await runCli(cliArgs, router);
  process.exit(process.exitCode ?? 0);
}

const transport = new StdioServerTransport();
await server.connect(transport);

process.on("SIGINT", () => {
  router.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  router.close();
  process.exit(0);
});
