import { indexSources, reconcileChainNetwork, reconcileChainTopology } from "./reconciliation.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { openDatabase, exportGraphToJson, importGraphFromJson, getSyncMeta, setSyncMeta, transaction, flushProjection, inTransaction, markProjectionPending } from "./database.mjs";
import { resolveProjectPaths } from "./paths.mjs";
import { extractSymbolSlice, buildChainCodeStream, detectLanguage } from "./ast.mjs";
import { redactSensitiveText, sanitizeTerminalOutput } from "./sanitizer.mjs";
import { getTimelineState, syncTimeline, advanceStep } from "./timeline.mjs";
import { applyArrowFlow } from "./flow.mjs";
import { suggestLinksForBlock, connectBlocks } from "./architecture-link.mjs";
import { inspectChainComposition } from "./chain-composition.mjs";

function writeFileAtomically(filePath, content) {
  const temporaryPath = `${filePath}.contextos-tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporaryPath, content, "utf8");
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* best effort cleanup */ }
    throw error;
  }
}

function gitCommand(projectRoot, args) {
  const result = spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
    maxBuffer: 2_000_000,
  });
  return result.status === 0 ? String(result.stdout ?? "").trim() : null;
}

function executionGitIdentity(projectRoot) {
  const head = gitCommand(projectRoot, ["rev-parse", "HEAD"]);
  const diff = gitCommand(projectRoot, ["diff", "--binary", "HEAD"]);
  return {
    gitHead: head,
    dirtyDiffHash: diff == null ? null : crypto.createHash("sha256").update(diff).digest("hex"),
  };
}

function parseExecutionSummary(command, output, success) {
  const text = String(output ?? "");
  const tests = text.match(/(?:tests?|suites?)\s+(\d+).*?(?:passed|pass)\s+(\d+).*?(?:failed|fail)\s+(\d+)/is);
  const testSummary = tests ? { total: Number(tests[1]), passed: Number(tests[2]), failed: Number(tests[3]) } : {};
  const artifacts = [...text.matchAll(/(?:written|created|built|output)\s+(?:to\s+)?[`']?([^\s`']+\.(?:app|js|mjs|json|zip|dmg|html|css|js))[`']?/gi)]
    .slice(0, 12).map((match) => match[1]);
  return {
    testSummary: { ...testSummary, inferred: Object.keys(testSummary).length > 0, success },
    artifactSummary: { paths: artifacts, inferred: artifacts.length > 0 },
    kind: /test|spec|lint|check/i.test(command) ? "test" : /build|compile|package/i.test(command) ? "build" : "command",
  };
}

const SOURCE_BACKED_BLOCK_KINDS = new Set(["flow", "ui", "service", "function", "integration", "api", "data", "database"]);
const INVALID_BINDING_STATUSES = new Set(["missing", "unreadable", "outside_project", "stale", "ambiguous"]);

import {
  now,
  identifier,
  parseJson,
  entityExists,
  normalizeBlock,
  normalizeDecision,
  normalizeChain,
  normalizeLink,
  normalizePlan,
  normalizePlanChainScope,
  normalizePlanChange,
  deriveCheckpointStates,
  derivePlanState,
  normalizeLocalizations,
} from "./schema.mjs";

import { buildContextForTask } from "./context-engine.mjs";
import { renderPlanContext, createFoundationPlan } from "./plan-engine.mjs";
import { listCheckpoints, recordCheckpoint } from "./checkpoint-engine.mjs";
import {
  createCheckpointFreshnessContext,
  evaluateCheckpointFreshness,
  extractCheckpointIdentity,
  stripCheckpointIdentity,
} from "./checkpoint-freshness.mjs";
import { bindingIdentity, scanSourceBindings, suggestSourceBindings, suggestBindingsForChangedFiles } from "./source-binding.mjs";
import {
  renderProjectMap,
  listDecisions,
  searchEntities,
  openEntity,
  getChangesSince,
  validateGraph,
  renderGraphStatus,
  analyzeGraphDrift,
} from "./query-engine.mjs";
import {
  executeMutate,
  executeGraphPatch,
  executeRevertChangeSet,
  historyState,
  historyStateForOperation,
  uiLocationFor,
} from "./mutation-engine.mjs";

export * from "./schema.mjs";
export * from "./context-engine.mjs";
export * from "./plan-engine.mjs";
export * from "./checkpoint-engine.mjs";
export * from "./query-engine.mjs";
export * from "./mutation-engine.mjs";

export class ContextOSService {
  constructor(options = {}) {
    const resolvedOptions = typeof options === "string" ? { projectRoot: options } : options;
    this.paths = resolveProjectPaths(resolvedOptions);
    this.database = openDatabase(this.paths.databasePath);
    this.sourceBindingState = new Map();
    this.sourceFileCache = new Map();
    this.sourceSyncRevision = 0;
    this.sourceSyncState = null;
    const persisted = getSyncMeta(this.database);
    this.sourceSyncHistory = JSON.parse(persisted.binding_history ?? '[]');
    this.sourceSyncRevision = Number(persisted.binding_revision ?? 0);
    this.sourceBindingState = new Map(JSON.parse(persisted.binding_baseline ?? '[]').map(b => [b.id,b]));
    this.ensureProject();
    this.ensureSynced();
  }

  close() {
    this.database.close();
  }

  ensureSynced() {
    if (inTransaction(this.database)) return false;
    const graphJsonPath = this.paths.graphJsonPath;
    if (!graphJsonPath) return false;
    if (getSyncMeta(this.database).projection_pending) {
      flushProjection(this.database, graphJsonPath);
      return true;
    }
    if (!fs.existsSync(graphJsonPath)) {
      const hasProject = this.database.prepare("SELECT count(*) as count FROM projects").get()?.count > 0;
      if (hasProject) {
        exportGraphToJson(this.database, graphJsonPath);
        return true;
      }
      return false;
    }

    const stat = fs.statSync(graphJsonPath);
    const meta = getSyncMeta(this.database);
    const hasProject = this.database.prepare("SELECT count(*) as count FROM projects").get()?.count > 0;

    if (!hasProject) {
      importGraphFromJson(this.database, graphJsonPath);
      return true;
    }

    // Hash canonical content: timestamp equality alone misses checkout/rapid writes.

    const content = fs.readFileSync(graphJsonPath, "utf8");
    const currentHash = crypto.createHash("sha256").update(content).digest("hex");
    if (meta.graph_json_hash !== currentHash) {
      importGraphFromJson(this.database, graphJsonPath);
      return true;
    } else {
      setSyncMeta(this.database, "graph_json_mtime", String(stat.mtimeMs));
      return false;
    }
  }

  ensureProject() {
    const timestamp = now();
    // The checkout path is runtime state, not canonical project truth. Store a
    // stable repository-relative marker so clones and Git worktrees do not
    // dirty the versioned graph merely by opening it. Snapshot readers expose
    // the resolved absolute root from `this.paths.projectRoot` instead.
    const storedRepoRoot = ".";
    this.database
      .prepare(
        `INSERT INTO projects(id, name, repo_root, schema_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, repo_root = excluded.repo_root,
           schema_version = excluded.schema_version, updated_at = excluded.updated_at
         WHERE projects.name IS NOT excluded.name
            OR projects.repo_root IS NOT excluded.repo_root
            OR projects.schema_version IS NOT excluded.schema_version`,
      )
      .run(
        this.paths.descriptor.id,
        this.paths.descriptor.name,
        storedRepoRoot,
        this.paths.descriptor.schemaVersion ?? 1,
        timestamp,
        timestamp,
      );
  }

  /**
   * Scan only files already bound by SourceRefs.  This is deliberately a
   * read-time fence: external editor/exec/git changes become visible at the
   * next contextos boundary without requiring a fragile filesystem watcher.
   * Line ranges are refreshed in memory from the current symbol; callers may
   * persist derived coordinates after an explicit code mutation.
   */
  syncSourceBindings({ includeUnchanged = false } = {}) {
    const projectId = this.paths.descriptor.id;
    const refs = this.database
      .prepare(
        `SELECT sr.id, sr.block_id, sr.path, sr.start_line, sr.end_line, sr.symbol, sr.role, sr.git_commit
         FROM source_refs sr
         JOIN blocks b ON b.id = sr.block_id
        WHERE b.project_id = ? AND b.archived = 0
        ORDER BY sr.path, sr.start_line, sr.id`,
      )
      .all(projectId)
      .map((row) => ({
        id: row.id,
        blockId: row.block_id,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        symbol: row.symbol,
        role: row.role,
        gitCommit: row.git_commit,
      }));
    const previousById = this.sourceBindingState;
    const result = scanSourceBindings({
      projectRoot: this.paths.projectRoot,
      sourceRefs: refs,
      previous: previousById,
      fileCache: this.sourceFileCache,
    });
    const previousRevision = this.sourceSyncState?.sourceRevision ?? getSyncMeta(this.database).binding_source_revision ?? null;
    const inventoryChanged = previousById.size !== result.bindings.length ||
      [...previousById.keys()].some((id) => !result.bindings.some((item) => item.id === id));
    const changed = Boolean(previousRevision && previousRevision !== result.sourceRevision) || inventoryChanged;
    if (changed) {
      this.sourceSyncRevision += 1;
      this.sourceSyncHistory.push({
        revision: this.sourceSyncRevision,
        scannedAt: result.scannedAt,
        changes: result.changes,
      });
      if (this.sourceSyncHistory.length > 100) this.sourceSyncHistory.shift();
    }
    this.sourceBindingState = new Map(result.bindings.map((binding) => [binding.id, binding]));
    const updateRange = this.database.prepare("UPDATE source_refs SET start_line=?,end_line=? WHERE id=? AND (start_line IS NOT ? OR end_line IS NOT ?)");
    for (const binding of result.bindings) if (binding.symbol && !INVALID_BINDING_STATUSES.has(binding.bindingStatus)) {
      updateRange.run(binding.startLine, binding.endLine, binding.id, binding.startLine, binding.endLine);
    }
    if (changed || !previousRevision) {
      setSyncMeta(this.database, 'binding_revision', String(this.sourceSyncRevision));
      setSyncMeta(this.database, 'binding_source_revision', result.sourceRevision);
      setSyncMeta(this.database, 'binding_history', JSON.stringify(this.sourceSyncHistory));
      setSyncMeta(this.database, 'binding_baseline', JSON.stringify(result.bindings.map(({content, ...binding}) => binding)));
    }
    this.sourceSyncState = {
      revision: this.sourceSyncRevision,
      sourceRevision: result.sourceRevision,
      scannedAt: result.scannedAt,
      changed,
      bindingCount: result.bindings.length,
      changedBindingCount: result.changes.length,
      invalidBindingCount: result.bindings.filter((item) => ["missing", "unreadable", "outside_project", "stale", "ambiguous"].includes(item.bindingStatus)).length,
      affectedBlockIds: [...new Set(result.changes.map((item) => item.blockId).filter(Boolean))],
      changes: result.changes,
    };
    return {
      ...this.sourceSyncState,
      bindings: (includeUnchanged ? result.bindings : result.bindings.filter((item) =>
        item.bindingStatus !== "fresh" || item.implementationStatus === "changed" ||
        result.changes.some((change) => change.refId === item.id),
      )).map(bindingIdentity),
    };
  }

  sourceBindingReport(options = {}) {
    this.ensureSynced();
    const autoReconciliation = this.reconcileSourceBackedBlocks();
    const repositorySync = indexSources(this);
    const report = this.syncSourceBindings(options);
    const sinceRevision = Number.isInteger(options.sinceRevision) ? options.sinceRevision : null;
    const historicalChanges = sinceRevision == null
      ? report.changes
      : this.sourceSyncHistory.filter((item) => item.revision > sinceRevision).flatMap((item) => item.changes);
    const chainIds = new Set();
    for (const change of historicalChanges) {
      this.database
        .prepare("SELECT chain_id FROM chain_nodes WHERE block_id = ?")
        .all(change.blockId)
        .forEach((row) => chainIds.add(row.chain_id));
    }
    const changedPaths = [...new Set(historicalChanges.map((item) => item.path).filter(Boolean))];
    const unboundCandidates = changedPaths.length
      ? suggestBindingsForChangedFiles({
        projectRoot: this.paths.projectRoot,
        blocks: this.snapshot().blocks.filter((block) => SOURCE_BACKED_BLOCK_KINDS.has(block.kind)),
        existingRefs: this.database.prepare("SELECT path, symbol FROM source_refs").all(),
        changedPaths,
        limit: 8,
      })
      : [];
    return {
      ...report,
      repositorySync,
      autoReconciliation,
      sourceSyncRevision: report.revision,
      changes: historicalChanges,
      changed: historicalChanges.length > 0,
      affectedBlockIds: [...new Set(historicalChanges.map((item) => item.blockId).filter(Boolean))],
      affectedChainIds: [...chainIds],
      unboundCandidates,
      editPath: unboundCandidates.length
        ? "native-edit-then-accept"
        : (report.invalidBindingCount ? "rebind-before-mutate" : "bound-symbol-mutate"),
    };
  }

  suggestSourceBindings({ blockId, limit = 12, maxFiles = 600 } = {}) {
    if (!blockId?.trim()) throw new Error("blockId is required");
    this.ensureSynced();
    const block = this.snapshot().blocks.find((item) => item.id === blockId);
    if (!block) throw new Error(`Block not found: ${blockId}`);
    const existingRefs = this.database.prepare(
      "SELECT path, symbol, role FROM source_refs WHERE block_id = ? ORDER BY path, symbol",
    ).all(blockId);
    return suggestSourceBindings({
      projectRoot: this.paths.projectRoot,
      block,
      existingRefs,
      limit,
      maxFiles,
    });
  }

  acceptSourceBindings({ blockId, bindings = [], actor = "agent", reason = "Accept SourceBinding candidates" } = {}) {
    if (!blockId?.trim()) throw new Error("blockId is required");
    if (!Array.isArray(bindings) || bindings.length === 0) throw new Error("bindings must contain at least one candidate");
    if (bindings.length > 20) throw new Error("bindings cannot exceed 20 candidates per operation");
    this.ensureSynced();
    if (!this.snapshot().blocks.some((item) => item.id === blockId)) throw new Error(`Block not found: ${blockId}`);
    const existing = new Set(this.database.prepare(
      "SELECT path, symbol FROM source_refs WHERE block_id = ?",
    ).all(blockId).map((item) => `${item.path}:${item.symbol ?? ""}`));
    const accepted = [];
    for (const candidate of bindings) {
      if (!candidate?.path?.trim() || !candidate?.symbol?.trim()) throw new Error("Each binding requires path and symbol");
      const absolutePath = path.resolve(this.paths.projectRoot, candidate.path);
      const relativePath = path.relative(this.paths.projectRoot, absolutePath);
      if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) throw new Error(`Binding path must stay inside project: ${candidate.path}`);
      if (!fs.existsSync(absolutePath)) throw new Error(`Binding source file not found: ${candidate.path}`);
      const content = fs.readFileSync(absolutePath, "utf8");
      const slice = extractSymbolSlice(content, {
        symbol: candidate.symbol,
        language: detectLanguage(absolutePath),
        filePath: absolutePath,
        maxLines: 4,
      });
      if (!slice.found) throw new Error(`Binding symbol is ${slice.reason ?? "missing"}: ${candidate.path}:${candidate.symbol}`);
      const normalizedPath = relativePath.split(path.sep).join("/");
      const key = `${normalizedPath}:${candidate.symbol}`;
      if (existing.has(key)) continue;
      existing.add(key);
      accepted.push({
        path: normalizedPath,
        symbol: candidate.symbol,
        role: candidate.role ?? "implementation",
        startLine: slice.startLine,
        endLine: slice.endLine,
      });
    }
    if (!accepted.length) return { blockId, accepted: [], changed: false, graphRevision: this.project().graph_revision };
    const mutation = this.mutate({
      actor,
      reason,
      operations: accepted.map((binding) => ({ action: "add_source_ref", id: blockId, fields: binding })),
    });
    const sourceSync = this.syncSourceBindings({ includeUnchanged: true });
    return { ...mutation, blockId, accepted, changed: true, sourceSync };
  }

  /**
   * Advance source-backed Blocks from a ghost/planned blueprint to an
   * implementing state as soon as a valid symbol binding exists. This is a
   * deliberately safe transition: verification is still required before a
   * Block can become complete. The helper is called at context, source-sync,
   * and task-reconcile boundaries so an agent does not need to remember a
   * separate ghost cleanup command.
   */
  reconcileSourceBackedBlocks({ blockIds = null, actor = "system", reason = "Reconcile anchored source Blocks" } = {}) {
    this.ensureSynced();
    const sourceSync = this.syncSourceBindings({ includeUnchanged: true });
    const snapshot = this.snapshot();
    const allowed = blockIds == null ? null : new Set(blockIds);
    const operations = snapshot.blocks
      .filter((block) => SOURCE_BACKED_BLOCK_KINDS.has(block.kind))
      .filter((block) => !allowed || allowed.has(block.id))
      .filter((block) => ["proposed", "planned"].includes(block.deliveryState))
      .filter((block) => [...this.sourceBindingState.values()].some((binding) =>
        binding.blockId === block.id && binding.symbol && !INVALID_BINDING_STATUSES.has(binding.bindingStatus),
      ))
      .map((block) => ({
        action: "update_block",
        id: block.id,
        expectedRevision: block.currentRevision,
        fields: { deliveryState: "implementing" },
      }));
    if (!operations.length) return { changed: false, advancedBlockIds: [], sourceSync };
    const mutation = this.mutate({ actor, reason, task: "source-reconcile", operations });
    return {
      ...mutation,
      changed: true,
      advancedBlockIds: operations.map((operation) => operation.id),
      sourceSync: this.syncSourceBindings({ includeUnchanged: true }),
    };
  }

  sealBlock({ blockId, checkpointId = null, executionId = null, actor = "agent", reason = "Seal verified Block implementation" } = {}) {
    if (!blockId?.trim()) throw new Error("blockId is required");
    this.ensureSynced();
    const snapshot = this.snapshot();
    const block = snapshot.blocks.find((item) => item.id === blockId);
    if (!block) throw new Error(`Block not found: ${blockId}`);

    const bindings = this.syncSourceBindings({ includeUnchanged: true }).bindings.filter((item) => item.blockId === blockId);
    if (SOURCE_BACKED_BLOCK_KINDS.has(block.kind)) {
      if (!bindings.length) throw new Error(`Source-backed Block has no SourceBinding: ${blockId}`);
      const invalid = bindings.find((binding) => INVALID_BINDING_STATUSES.has(binding.bindingStatus));
      if (invalid) throw new Error(`Cannot seal Block with ${invalid.bindingStatus} SourceBinding: ${invalid.path}:${invalid.symbol ?? ""}`);
    }

    const directCheckpoints = snapshot.checkpoints.filter((checkpoint) =>
      checkpoint.targetType === "block" && checkpoint.targetId === blockId,
    );
    const checkpoint = checkpointId
      ? directCheckpoints.find((item) => item.id === checkpointId)
      : directCheckpoints.find((item) => item.status === "passed" && item.freshness?.status === "fresh");
    if (!checkpoint) throw new Error(checkpointId
      ? `Checkpoint is not attached to block:${blockId}: ${checkpointId}`
      : `Block requires a direct passed Checkpoint: ${blockId}`);
    if (checkpoint.status !== "passed") throw new Error(`Checkpoint must be passed before sealing: ${checkpoint.id} (${checkpoint.status})`);
    if (checkpoint.freshness?.status !== "fresh") throw new Error(`Checkpoint must be fresh before sealing: ${checkpoint.id} (${checkpoint.freshness?.status ?? "unknown"})`);

    let executionReceipt = null;
    if (executionId) {
      executionReceipt = this.database.prepare(
        "SELECT id, status, exit_code, execution_kind, duration_ms, source_revision FROM execution_receipts WHERE id = ? AND project_id = ?",
      ).get(executionId, this.paths.descriptor.id);
      if (!executionReceipt) throw new Error(`Execution receipt not found in project: ${executionId}`);
      if (executionReceipt.status !== "passed" || executionReceipt.exit_code !== 0) {
        throw new Error(`Execution receipt must be successful before sealing: ${executionId}`);
      }
      const cited = checkpoint.evidence.some((item) => item?.kind === "execution_receipt" && item.executionId === executionId);
      if (!cited) throw new Error(`Checkpoint ${checkpoint.id} does not cite execution receipt: ${executionId}`);
    }

    if (block.deliveryState === "complete") {
      return {
        blockId,
        sealed: true,
        changed: false,
        idempotent: true,
        checkpointId: checkpoint.id,
        executionId: executionReceipt?.id ?? null,
        graphRevision: this.project().graph_revision,
      };
    }
    const mutation = this.mutate({
      actor,
      reason,
      operations: [{
        action: "update_block",
        id: blockId,
        expectedRevision: block.currentRevision,
        summary: `Sealed with checkpoint:${checkpoint.id}${executionReceipt ? ` and execution:${executionReceipt.id}` : ""}`,
        fields: { deliveryState: "complete", healthState: "healthy" },
      }],
    });
    return {
      ...mutation,
      blockId,
      sealed: true,
      changed: true,
      idempotent: false,
      previousDeliveryState: block.deliveryState,
      deliveryState: "complete",
      checkpointId: checkpoint.id,
      executionId: executionReceipt?.id ?? null,
    };
  }

  project() {
    this.ensureSynced();
    return this.database.prepare("SELECT * FROM projects WHERE id = ?").get(this.paths.descriptor.id);
  }

  snapshot() {
    this.ensureSynced();
    const sourceSync = this.syncSourceBindings();
    const projectId = this.paths.descriptor.id;
    const blocks = this.database
      .prepare("SELECT * FROM blocks WHERE project_id = ? AND archived = 0 ORDER BY title")
      .all(projectId)
      .map(normalizeBlock);
    const chains = this.database
      .prepare("SELECT * FROM chains WHERE project_id = ? AND archived = 0 ORDER BY updated_at DESC")
      .all(projectId)
      .map(normalizeChain);
    let plans = this.database
      .prepare("SELECT * FROM plans WHERE project_id = ? AND archived = 0 ORDER BY phase, plan_order, priority, updated_at DESC")
      .all(projectId)
      .map(normalizePlan);
    const links = this.database
      .prepare("SELECT * FROM links WHERE project_id = ? AND archived = 0 ORDER BY created_at")
      .all(projectId)
      .map(normalizeLink);
    const chainNodes = this.database
      .prepare(
        `SELECT cn.* FROM chain_nodes cn JOIN chains c ON c.id = cn.chain_id
         WHERE c.project_id = ? AND c.archived = 0 ORDER BY cn.chain_id, cn.position`,
      )
      .all(projectId)
      .map((row) => ({ chainId: row.chain_id, blockId: row.block_id, position: row.position, role: row.role }));
    const chainMembers = this.database
      .prepare(
        `SELECT cm.* FROM chain_members cm JOIN chains c ON c.id = cm.chain_id
         WHERE c.project_id = ? AND c.archived = 0 ORDER BY cm.chain_id, cm.position, cm.member_type, cm.member_id`,
      )
      .all(projectId)
      .map((row) => ({
        chainId: row.chain_id,
        memberType: row.member_type,
        memberId: row.member_id,
        position: row.position,
        role: row.role ?? "stage",
        required: row.required !== 0,
      }));
    const chainEdges = this.database
      .prepare(
        `SELECT ce.* FROM chain_edges ce JOIN chains c ON c.id = ce.chain_id
         WHERE c.project_id = ? AND c.archived = 0 ORDER BY ce.chain_id, ce.position`,
      )
      .all(projectId)
      .map((row) => ({ chainId: row.chain_id, linkId: row.link_id, position: row.position }));
    const planChainRefs = this.database
      .prepare(
        `SELECT pcr.* FROM plan_chain_refs pcr JOIN plans p ON p.id = pcr.plan_id
         WHERE p.project_id = ? AND p.archived = 0 ORDER BY pcr.plan_id, pcr.position`,
      )
      .all(projectId)
      .map((row) => ({ planId: row.plan_id, chainId: row.chain_id, position: row.position }));
    const planDependencies = this.database
      .prepare(
        `SELECT pd.* FROM plan_dependencies pd JOIN plans p ON p.id = pd.plan_id
         WHERE p.project_id = ? AND p.archived = 0 ORDER BY pd.plan_id, pd.position`,
      )
      .all(projectId)
      .map((row) => ({ planId: row.plan_id, dependsOnPlanId: row.depends_on_plan_id, position: row.position }));
    const planSteps = this.database
      .prepare(
        `SELECT ps.* FROM plan_steps ps JOIN plans p ON p.id = ps.plan_id
         WHERE p.project_id = ? AND p.archived = 0 ORDER BY ps.plan_id, ps.position`,
      )
      .all(projectId)
      .map((row) => ({
        id: row.id, planId: row.plan_id, position: row.position, title: row.title, action: row.action,
        status: row.status, targetRefs: parseJson(row.target_refs_json, []), proposedDelta: parseJson(row.proposed_delta_json, []),
        updatedAt: row.updated_at,
      }));
    const planCheckpointRefs = this.database
      .prepare(
        `SELECT pcr.* FROM plan_checkpoint_refs pcr JOIN plans p ON p.id = pcr.plan_id
         WHERE p.project_id = ? AND p.archived = 0 ORDER BY pcr.plan_id, pcr.position`,
      )
      .all(projectId)
      .map((row) => ({
        planId: row.plan_id, checkpointId: row.checkpoint_id, stepId: row.step_id,
        position: row.position, required: Boolean(row.required),
      }));
    const planChainScopes = this.database
      .prepare(
        `SELECT pcs.* FROM plan_chain_scopes pcs JOIN plans p ON p.id = pcs.plan_id
         WHERE p.project_id = ? AND p.archived = 0 ORDER BY pcs.plan_id, pcs.position`,
      )
      .all(projectId)
      .map(normalizePlanChainScope);
    const planChanges = this.database
      .prepare(
        `SELECT pc.* FROM plan_changes pc JOIN plans p ON p.id = pc.plan_id
         WHERE p.project_id = ? AND p.archived = 0 ORDER BY pc.plan_id, pc.position`,
      )
      .all(projectId)
      .map(normalizePlanChange);
    const planChainChangeRefs = this.database
      .prepare(
        `SELECT pccr.* FROM plan_chain_change_refs pccr
         JOIN plan_chain_scopes pcs ON pcs.id = pccr.chain_scope_id
         JOIN plans p ON p.id = pcs.plan_id
         WHERE p.project_id = ? AND p.archived = 0 ORDER BY pccr.chain_scope_id, pccr.position`,
      )
      .all(projectId)
      .map((row) => ({
        chainScopeId: row.chain_scope_id, planChangeId: row.plan_change_id,
        role: row.role, position: row.position,
      }));
    const backgroundScopes = this.database
      .prepare(
        `SELECT bs.* FROM background_scopes bs JOIN blocks b ON b.id = bs.block_id
         WHERE b.project_id = ? ORDER BY bs.block_id, bs.scope_type, bs.scope_value`,
      )
      .all(projectId)
      .map((row) => ({ blockId: row.block_id, scopeType: row.scope_type, scopeValue: row.scope_value }));
    const decisions = this.database
      .prepare("SELECT * FROM decisions WHERE project_id = ? AND archived = 0 ORDER BY updated_at DESC, id")
      .all(projectId)
      .map(normalizeDecision);
    const decisionScopes = this.database
      .prepare(
        `SELECT ds.* FROM decision_scopes ds JOIN decisions d ON d.id = ds.decision_id
         WHERE d.project_id = ? AND d.archived = 0 ORDER BY ds.decision_id, ds.scope_type, ds.scope_value`,
      )
      .all(projectId)
      .map((row) => ({ decisionId: row.decision_id, scopeType: row.scope_type, scopeValue: row.scope_value }));
    const sourceRefs = this.database
      .prepare(
        `SELECT sr.* FROM source_refs sr JOIN blocks b ON b.id = sr.block_id
         WHERE b.project_id = ? ORDER BY sr.path, sr.start_line`,
      )
      .all(projectId)
      .map((row) => ({
        id: row.id,
        blockId: row.block_id,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        symbol: row.symbol,
        role: row.role,
        gitCommit: row.git_commit,
      }));
    const rawCheckpoints = this.database
      .prepare("SELECT * FROM checkpoints WHERE project_id = ? ORDER BY updated_at DESC, id ASC")
      .all(projectId);
    const freshnessContext = createCheckpointFreshnessContext(this);
    const checkpoints = rawCheckpoints
      .map((row) => {
        const storedEvidence = parseJson(row.evidence_json, []);
        const freshness = evaluateCheckpointFreshness(this, extractCheckpointIdentity(storedEvidence), freshnessContext);
        const effectiveStatus = row.status === "passed" && freshness.status !== "fresh" ? "retest_required" : row.status;
        this.database.prepare(`INSERT INTO checkpoint_runtime VALUES(?,?,?) ON CONFLICT(checkpoint_id) DO UPDATE SET checkpoint_revision=excluded.checkpoint_revision,status=excluded.status WHERE checkpoint_runtime.checkpoint_revision<>excluded.checkpoint_revision OR checkpoint_runtime.status<>excluded.status`).run(row.id,row.current_revision,effectiveStatus);
        return {
          id: row.id,
          targetType: row.target_type,
          targetId: row.target_id,
          title: row.title,
          criteria: row.criteria,
          recordedStatus: row.status,
          status: effectiveStatus,
          checkpointKind: row.checkpoint_kind,
          aggregationPolicy: parseJson(row.aggregation_policy_json, {}),
          eligibleAfterChildren: Boolean(row.eligible_after_children),
          evidenceLevel: row.evidence_level,
          requiredEvidenceLevel: row.required_evidence_level,
          coverage: row.coverage,
          evidence: stripCheckpointIdentity(storedEvidence),
          freshness,
          invalidatedAt: row.invalidated_at,
          currentRevision: row.current_revision,
          updatedAt: row.updated_at,
        };
      });
    const checkpointBindings = this.database
      .prepare(
        `SELECT cb.* FROM checkpoint_bindings cb JOIN checkpoints c ON c.id = cb.checkpoint_id
         WHERE c.project_id = ? ORDER BY cb.checkpoint_id, cb.position`,
      )
      .all(projectId)
      .map((row) => ({
        checkpointId: row.checkpoint_id, subjectType: row.subject_type, subjectId: row.subject_id,
        role: row.role, required: Boolean(row.required), position: row.position,
      }));
    const checkpointDependencies = this.database
      .prepare(
        `SELECT cd.* FROM checkpoint_dependencies cd JOIN checkpoints c ON c.id = cd.parent_checkpoint_id
         WHERE c.project_id = ? ORDER BY cd.parent_checkpoint_id, cd.position`,
      )
      .all(projectId)
      .map((row) => ({
        parentCheckpointId: row.parent_checkpoint_id, childCheckpointId: row.child_checkpoint_id,
        position: row.position, required: Boolean(row.required),
      }));
    const derivedCheckpoints = deriveCheckpointStates(checkpoints, checkpointDependencies);
    plans = plans.map((plan) => derivePlanState(
      plan, plans, planDependencies, planSteps, planCheckpointRefs, derivedCheckpoints,
      planChainScopes, planChanges, checkpointBindings,
    ));
    const localizations = normalizeLocalizations(
      this.database
        .prepare(
          `SELECT lt.* FROM localized_text lt
           WHERE EXISTS (
             SELECT 1 FROM blocks b WHERE b.project_id = ? AND lt.entity_type = 'block' AND b.id = lt.entity_id
             UNION ALL
             SELECT 1 FROM chains c WHERE c.project_id = ? AND lt.entity_type = 'chain' AND c.id = lt.entity_id
             UNION ALL
             SELECT 1 FROM links l WHERE l.project_id = ? AND lt.entity_type = 'link' AND l.id = lt.entity_id
             UNION ALL
             SELECT 1 FROM plans p WHERE p.project_id = ? AND lt.entity_type = 'plan' AND p.id = lt.entity_id
           )`,
        )
        .all(projectId, projectId, projectId, projectId),
    );
    const changeSequence =
      this.database
        .prepare("SELECT COALESCE(MAX(sequence), 0) AS value FROM change_feed WHERE project_id = ?")
        .get(projectId).value ?? 0;

    return {
      project: {
        id: projectId,
        name: this.paths.descriptor.name,
        graphRevision: this.project().graph_revision,
        root: this.paths.projectRoot,
      },
      changeSequence,
      blocks,
      chains,
      plans,
      links,
      chainMembers,
      chainNodes,
      chainEdges,
      planChainRefs,
      planDependencies,
      planSteps,
      planCheckpointRefs,
      planChainScopes,
      planChanges,
      planChainChangeRefs,
      backgroundScopes,
      decisions,
      decisionScopes,
      sourceRefs,
      sourceSync,
      checkpoints: derivedCheckpoints,
      checkpointBindings,
      checkpointDependencies,
      localizations,
    };
  }

  chainCodeStream({ chainId, maxTotalChars = 4000, mode = "contract", maxLinesPerSymbol = 12 } = {}) {
    if (!chainId?.trim()) throw new Error("chainId is required");
    if (mode && mode !== "contract") throw new Error("chain_code_stream is locator-only; implementation bodies are not returned");
    mode = "contract";
    this.ensureSynced();
    // Capture the binding scan for this response before topology reconciliation.
    // Reconciliation reads a fresh snapshot, which would otherwise consume a
    // transient moved/changed status before the caller sees the code stream.
    const sourceSync = this.syncSourceBindings({ includeUnchanged: true });
    const streamBindingState = new Map(this.sourceBindingState);
    const chainNetwork = this.reconcileChainNetwork({
      chainId,
      autoExpand: true,
      reason: "Reconcile Chain feature network before code stream",
    });
    const chainReconciliation = this.reconcileChainTopology({
      chainId,
      autoReorder: true,
      reason: "Reconcile Chain topology before code stream",
    });
    const snapshot = this.snapshot();
    const chain = snapshot.chains.find((c) => c.id === chainId);
    if (!chain) throw new Error(`Chain not found: ${chainId}`);

    if (chain.chainType === "composite") {
      const members = snapshot.chainMembers
        .filter((member) => member.chainId === chain.id)
        .sort((left, right) => left.position - right.position || left.memberType.localeCompare(right.memberType) || left.memberId.localeCompare(right.memberId));
      const edges = snapshot.chainEdges.filter((edge) => edge.chainId === chain.id).sort((left, right) => left.position - right.position);
      const composition = inspectChainComposition({
        chain, members, edges, chains: snapshot.chains, blocks: snapshot.blocks, links: snapshot.links,
      });
      const childBlockCount = (childId, seen = new Set()) => {
        if (seen.has(childId)) return 0;
        seen.add(childId);
        const childMembers = snapshot.chainMembers.filter((member) => member.chainId === childId);
        if (!childMembers.length) return snapshot.chainNodes.filter((node) => node.chainId === childId).length;
        return childMembers.reduce((total, member) => total + (member.memberType === "chain"
          ? childBlockCount(member.memberId, seen)
          : 1), 0);
      };
      const streamNodes = members.map((member) => {
        const ref = `${member.memberType}:${member.memberId}`;
        const item = member.memberType === "chain"
          ? snapshot.chains.find((candidate) => candidate.id === member.memberId)
          : snapshot.blocks.find((candidate) => candidate.id === member.memberId);
        const childNodes = member.memberType === "chain"
          ? snapshot.chainNodes.filter((node) => node.chainId === member.memberId).length
          : null;
        const childEdges = member.memberType === "chain"
          ? snapshot.chainEdges.filter((edge) => edge.chainId === member.memberId).length
          : null;
        const source = member.memberType === "block"
          ? this.database.prepare("SELECT path, start_line, end_line, symbol, role FROM source_refs WHERE block_id = ? ORDER BY id").all(member.memberId)[0]
          : null;
        return {
          memberType: member.memberType,
          memberId: member.memberId,
          ref,
          title: item?.title ?? member.memberId,
          role: member.role ?? "stage",
          required: member.required !== false,
          deliveryState: item?.deliveryState ?? "missing",
          healthState: item?.healthState ?? "unknown",
          childBlockCount: member.memberType === "chain" ? childBlockCount(member.memberId) : 1,
          childNodeCount: childNodes,
          childEdgeCount: childEdges,
          filePath: source?.path ?? null,
          symbol: source?.symbol ?? null,
          startLine: source?.start_line ?? null,
          endLine: source?.end_line ?? null,
          contract: member.memberType === "chain"
            ? item?.outputContract || item?.intent || ""
            : item?.contract || item?.summary || "",
        };
      });
      const orderedMemberIds = composition.topology.orderedMemberIds ?? members.map((member) => `${member.memberType}:${member.memberId}`);
      const orderedNodes = orderedMemberIds.map((id) => streamNodes.find((node) => node.ref === id)).filter(Boolean);
      const codeStream = [
        `# Composite Chain: ${chain.title} (${chain.id})`,
        `Members: ${orderedNodes.length} macro stage(s) · underlying Blocks are expanded on demand`,
        `Composition: ${composition.complete ? "valid" : "needs attention"} · ${edges.length} typed route edge(s)`,
        "",
        ...orderedNodes.flatMap((node, index) => [
          `${index + 1}. [${node.ref}] ${node.title} — ${node.deliveryState}/${node.healthState}`,
          `   Role: ${node.role}${node.required ? " · required" : " · optional"}`,
          node.memberType === "chain"
            ? `   Child Chain: ${node.childNodeCount} path Block(s), ${node.childEdgeCount} route Link(s), ${node.childBlockCount} recursive Block(s)`
            : `   Locator: ${node.filePath ? `${node.filePath}${node.symbol ? ` :: ${node.symbol}` : ""}${node.startLine ? ` L${node.startLine}-${node.endLine}` : ""}` : "virtual/no SourceRef"}`,
          node.contract ? `   Contract: ${node.contract}` : "",
        ].filter(Boolean)),
        ...(edges.length ? ["", "## Composition route", ...edges.map((edge) => {
          const link = snapshot.links.find((candidate) => candidate.id === edge.linkId);
          return link ? `- ${link.sourceType}:${link.sourceId} -[${link.kind}]-> ${link.targetType}:${link.targetId}` : `- missing link:${edge.linkId}`;
        })] : []),
        ...(composition.topology.issues.length ? ["", "## Composition issues", ...composition.topology.issues.map((issue) => `- ${issue.detail}`)] : []),
      ].join("\n");
      return {
        chainId: chain.id,
        title: chain.title,
        chainType: chain.chainType,
        mode,
        sourceSync: {
          revision: sourceSync.revision,
          changed: sourceSync.changed,
          changedBindingCount: sourceSync.changedBindingCount,
          invalidBindingCount: sourceSync.invalidBindingCount,
          changes: sourceSync.changes.slice(0, 12),
        },
        chainNetwork,
        chainReconciliation,
        composition,
        nodes: orderedNodes,
        codeStream,
        markdown: codeStream,
      };
    }

    const nodeIds = snapshot.chainNodes
      .filter((node) => node.chainId === chain.id)
      .sort((a, b) => a.position - b.position)
      .map((node) => node.blockId);

    const streamNodes = [];
    for (const blockId of nodeIds) {
      const block = snapshot.blocks.find((b) => b.id === blockId);
      if (!block) continue;

      const sourceRefs = this.database
        .prepare("SELECT id, path, start_line, end_line, symbol, role FROM source_refs WHERE block_id = ? ORDER BY id")
        .all(block.id);

      let code = null;
      let filePath = null;
      let symbol = null;
      let signature = null;
      let startLine = null;
      let endLine = null;
      let sourceStatus = "virtual";
      let sourceHash = null;

      if (sourceRefs.length > 0) {
        const ref = sourceRefs.find((candidate) => candidate.role === "implementation" && candidate.symbol)
          || sourceRefs.find((candidate) => candidate.symbol)
          || sourceRefs.find((candidate) => candidate.role === "implementation")
          || sourceRefs[0];
        const binding = streamBindingState.get(ref.id) ?? this.sourceBindingState.get(ref.id);
        filePath = binding?.relativePath ?? ref.path;
        symbol = ref.symbol;
        startLine = binding?.startLine ?? ref.start_line;
        endLine = binding?.endLine ?? ref.end_line;
        sourceStatus = "missing";
        if (binding) {
          sourceStatus = binding.sourceStatus;
          sourceHash = binding.fileHash;
          signature = binding.signature;
          if (binding.content && !["missing", "unreadable", "outside_project", "stale", "ambiguous"].includes(binding.bindingStatus)) {
            const fullPath = binding.absolutePath;
            const slice = extractSymbolSlice(binding.content, {
              symbol: ref.symbol,
              startLine: ref.symbol ? null : binding.startLine ?? ref.start_line,
              endLine: ref.symbol ? null : binding.endLine ?? ref.end_line,
              maxLines: maxLinesPerSymbol,
              language: binding.language,
              filePath: fullPath,
            });
            signature = slice.signature;
            startLine = slice.startLine;
            endLine = slice.endLine;
            code = null;
          }
        }
        if (!ref.symbol && sourceStatus === "anchored") sourceStatus = "line_only";
      }

      streamNodes.push({
        blockId: block.id,
        title: block.title,
        filePath,
        symbol,
        code,
        signature,
        startLine,
        endLine,
        sourceStatus,
        sourceHash,
        contract: block.contract || block.summary,
      });
    }

    const codeStream = buildChainCodeStream(streamNodes, { maxTotalChars, mode });
    return {
      chainId: chain.id,
      title: chain.title,
      chainType: chain.chainType,
      mode,
      sourceSync: {
        revision: sourceSync.revision,
        changed: sourceSync.changed,
        changedBindingCount: sourceSync.changedBindingCount,
        invalidBindingCount: sourceSync.invalidBindingCount,
        changes: sourceSync.changes.slice(0, 12),
      },
      chainNetwork,
      chainReconciliation,
      nodes: streamNodes,
      codeStream,
      markdown: [
        `# Chain Code Stream: ${chain.title} (${chain.id})`,
        `Nodes: ${streamNodes.length} · Locator-only path + symbol indexes`,
        ...(chainNetwork.changedChainIds?.length ? [`Chain network reconciled: ${chainNetwork.changedChainIds.map((id) => `chain:${id}`).join(", ")}`] : []),
        ...(chainReconciliation.changedChainIds?.length ? [`Chain order reconciled: ${chainReconciliation.changedChainIds.map((id) => `chain:${id}`).join(", ")}`] : []),
        ...(chainReconciliation.issues?.length ? ["Chain topology issues:", ...chainReconciliation.issues.map((issue) => `- ${issue.detail}`)] : []),
        `Source sync: r${sourceSync.revision} · ${sourceSync.changedBindingCount} binding change(s) · ${sourceSync.invalidBindingCount} invalid`,
        ...(sourceSync.changes.length ? ["", "## Source changes", ...sourceSync.changes.slice(0, 8).map((change) =>
          `- block:${change.blockId} ${change.symbol ?? change.path} · ${change.kinds.join(", ")}`)] : []),
        "",
        codeStream,
      ].join("\n"),
    };
  }

  /**
   * Return one Block's AST-bounded implementation only when the caller asks
   * for a slice. The normal context and Chain stream remain locator-only.
   * This gives an agent a safe edit/read path without opening the containing
   * file in full.
   */
  blockCodeStream({ blockId, maxChars = 8000, maxLines = 80, mode = "slice" } = {}) {
    if (!blockId?.trim()) throw new Error("blockId is required");
    if (!Number.isInteger(maxChars) || maxChars < 500) throw new Error("maxChars must be at least 500");
    if (!Number.isInteger(maxLines) || maxLines < 4) throw new Error("maxLines must be at least 4");
    if (!['contract', 'slice'].includes(mode)) throw new Error("mode must be contract or slice");
    this.ensureSynced();
    const snapshot = this.snapshot();
    const block = snapshot.blocks.find((item) => item.id === blockId);
    if (!block) throw new Error(`Block not found: ${blockId}`);
    const ref = this.database
      .prepare("SELECT id, path, start_line, end_line, symbol, role FROM source_refs WHERE block_id = ? ORDER BY id")
      .all(blockId)
      .find((candidate) => candidate.role === "implementation" && candidate.symbol)
      ?? this.database
        .prepare("SELECT id, path, start_line, end_line, symbol, role FROM source_refs WHERE block_id = ? ORDER BY id")
        .all(blockId)
        .find((candidate) => candidate.symbol)
      ?? this.database
        .prepare("SELECT id, path, start_line, end_line, symbol, role FROM source_refs WHERE block_id = ? ORDER BY id")
        .all(blockId)[0];

    const node = {
      blockId: block.id,
      title: block.title,
      filePath: ref?.path ?? null,
      symbol: ref?.symbol ?? null,
      role: ref?.role ?? null,
      signature: null,
      startLine: ref?.start_line ?? null,
      endLine: ref?.end_line ?? null,
      sourceStatus: ref ? "missing" : "virtual",
      sourceHash: null,
      contract: block.contract || block.summary,
      code: null,
      codeChars: 0,
      readMode: mode === "slice" ? "ast-slice" : "locator-only",
      containingFileReturned: false,
      truncated: false,
      reason: ref ? "source binding unavailable" : "Block has no SourceRef",
    };

    if (ref) {
      const binding = this.sourceBindingState.get(ref.id);
      node.filePath = binding?.relativePath ?? ref.path;
      node.symbol = ref.symbol;
      node.startLine = binding?.startLine ?? ref.start_line;
      node.endLine = binding?.endLine ?? ref.end_line;
      node.sourceStatus = binding?.sourceStatus ?? "missing";
      node.sourceHash = binding?.fileHash ?? null;
      node.signature = binding?.signature ?? null;
      node.reason = binding?.reason ?? null;
      const invalid = ["missing", "unreadable", "outside_project", "stale", "ambiguous", "line_only"];
      if (mode === "slice" && binding?.content && !invalid.includes(binding.bindingStatus) && !invalid.includes(binding.sourceStatus)) {
        const slice = extractSymbolSlice(binding.content, {
          symbol: ref.symbol,
          startLine: ref.symbol ? null : binding.startLine ?? ref.start_line,
          endLine: ref.symbol ? null : binding.endLine ?? ref.end_line,
          maxLines,
          language: binding.language,
          filePath: binding.absolutePath,
        });
        node.signature = slice.signature;
        node.startLine = slice.startLine;
        node.endLine = slice.endLine;
        node.reason = slice.reason ?? null;
        if (slice.found) {
          node.code = slice.code;
          node.codeChars = slice.code.length;
          node.truncated = slice.totalLines > maxLines || slice.code.length > maxChars;
          if (node.code.length > maxChars) {
            node.code = `${node.code.slice(0, Math.max(0, maxChars - 64))}\n... [slice truncated; use the locator in an editor]`;
            node.codeChars = node.code.length;
          }
        }
      }
    }

    const lines = [
      `# Block Code Stream: ${block.title} (${block.id})`,
      `Mode: ${mode} · AST-bounded ${mode === "slice" ? "slice" : "locator"}; containing file is not returned`,
      `Locator: ${node.filePath ? `${node.filePath}${node.symbol ? ` :: ${node.symbol}` : ""}${node.startLine ? ` L${node.startLine}-L${node.endLine}` : ""}` : "—"}`,
      `Source status: ${node.sourceStatus}`,
      `Contract: ${node.contract || "(not declared)"}`,
    ];
    if (node.signature) lines.push(`Signature: ${node.signature}`);
    if (node.reason) lines.push(`Note: ${node.reason}`);
    if (node.code != null) {
      lines.push("", "## AST slice", "```", node.code, "```");
    } else if (mode === "slice") {
      lines.push("", "No safe slice returned; rebind the SourceRef before opening implementation.");
    }
    const codeStream = lines.join("\n");
    return {
      blockId: block.id,
      title: block.title,
      mode,
      node,
      readMode: node.code != null ? "ast-slice" : "locator-only",
      containingFileReturned: false,
      truncated: node.truncated || codeStream.length > maxChars,
      codeStream,
    };
  }

  sanitizeLog({ rawOutput, maxChars = 3000, exitCode = null } = {}) {
    return sanitizeTerminalOutput(rawOutput, { maxChars, exitCode, projectRoot: this.paths.projectRoot });
  }

  runCommand({ command, cwd = ".", timeoutMs = 30000, maxChars = 3000, executionKind = null } = {}) {
    if (!command?.trim()) throw new Error("command is required");
    // Establish a source baseline before an external command can edit files;
    // the post-command scan then turns exec/git/script edits into a compact
    // contextos-visible change receipt.
    this.ensureSynced();
    this.syncSourceBindings();
    const projectRoot = path.resolve(this.paths.projectRoot);
    const targetCwd = path.resolve(projectRoot, cwd || ".");
    const relativeCwd = path.relative(projectRoot, targetCwd);
    if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) {
      throw new Error("cwd must stay inside the registered project");
    }

    const startedAt = Date.now();
    const result = spawnSync(process.env.SHELL || "/bin/sh", ["-lc", command], {
      cwd: targetCwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 2_000_000,
      env: process.env,
    });
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    const rawOutput = [stdout, stderr ? `[stderr]\n${stderr}` : ""].filter(Boolean).join("\n");
    const timedOut = result.error?.code === "ETIMEDOUT";
    const exitCode = typeof result.status === "number" ? result.status : (timedOut ? 124 : 1);
    const sanitized = sanitizeTerminalOutput(rawOutput || result.error?.message || "", {
      exitCode,
      maxChars,
      projectRoot,
    });
    const safeCommand = redactSensitiveText(command, { projectRoot }).text
      .replace(/[\r\n]+/g, " ")
      .replace(/`/g, "\\`");
    const sourceSync = this.syncSourceBindings();
    const success = exitCode === 0 && !result.error;
    const executionSummary = parseExecutionSummary(command, sanitized.text, success);
    const gitIdentity = executionGitIdentity(projectRoot);
    const executionId = identifier("exec");
    const receipt = {
      id: executionId,
      projectId: this.paths.descriptor.id,
      command: safeCommand,
      cwd: relativeCwd || ".",
      executionKind: executionKind || executionSummary.kind,
      status: success ? "passed" : timedOut ? "timed_out" : "failed",
      exitCode,
      timedOut,
      signal: result.signal ?? null,
      durationMs: Date.now() - startedAt,
      stdoutBytes: Buffer.byteLength(stdout, "utf8"),
      stderrBytes: Buffer.byteLength(stderr, "utf8"),
      output: sanitized.text,
      originalChars: sanitized.originalChars,
      finalChars: sanitized.finalChars,
      redactions: sanitized.redactions,
      gitHead: gitIdentity.gitHead,
      dirtyDiffHash: gitIdentity.dirtyDiffHash,
      sourceSyncRevision: sourceSync.revision,
      sourceRevision: sourceSync.sourceRevision,
      testSummary: executionSummary.testSummary,
      artifactSummary: executionSummary.artifactSummary,
      external: false,
    };
    transaction(this.database, () => {
      this.database.prepare(`
        INSERT INTO execution_receipts(
          id, project_id, command, cwd, execution_kind, status, exit_code, timed_out, signal,
          duration_ms, stdout_bytes, stderr_bytes, output, original_chars, final_chars, redactions,
          git_head, dirty_diff_hash, source_sync_revision, source_revision,
          test_summary_json, artifact_summary_json, external, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receipt.id, receipt.projectId, receipt.command, receipt.cwd, receipt.executionKind, receipt.status,
        receipt.exitCode, Number(receipt.timedOut), receipt.signal, receipt.durationMs,
        receipt.stdoutBytes, receipt.stderrBytes, receipt.output, receipt.originalChars, receipt.finalChars,
        receipt.redactions, receipt.gitHead, receipt.dirtyDiffHash, receipt.sourceSyncRevision,
        receipt.sourceRevision, JSON.stringify(receipt.testSummary), JSON.stringify(receipt.artifactSummary),
        Number(receipt.external), now(),
      );
    });
    return {
      executionId,
      durationMs: receipt.durationMs,
      stdoutBytes: receipt.stdoutBytes,
      stderrBytes: receipt.stderrBytes,
      executionKind: receipt.executionKind,
      gitHead: receipt.gitHead,
      dirtyDiffHash: receipt.dirtyDiffHash,
      testSummary: receipt.testSummary,
      artifactSummary: receipt.artifactSummary,
      external: receipt.external,
      success,
      command: safeCommand,
      cwd: relativeCwd || ".",
      exitCode,
      timedOut,
      signal: result.signal ?? null,
      output: sanitized.text,
      originalChars: sanitized.originalChars,
      finalChars: sanitized.finalChars,
      compressionRatio: sanitized.compressionRatio,
      hasErrors: sanitized.hasErrors,
      redactions: sanitized.redactions,
      sourceSync: {
        revision: sourceSync.revision,
        changed: sourceSync.changed,
        changedBindingCount: sourceSync.changedBindingCount,
        invalidBindingCount: sourceSync.invalidBindingCount,
        changes: sourceSync.changes.slice(0, 12),
      },
    };
  }

  checkpointRefreshCandidates({ executionId = null } = {}) {
    this.ensureSynced();
    const snapshot = this.snapshot();
    const stale = snapshot.checkpoints.filter((checkpoint) =>
      checkpoint.status === "retest_required" || checkpoint.freshness?.status === "stale",
    );
    const changedBlockIds = new Set((snapshot.sourceSync?.changes ?? this.syncSourceBindings().changes ?? []).map((item) => item.blockId).filter(Boolean));
    const receipt = executionId
      ? this.database.prepare("SELECT id, status, command, exit_code FROM execution_receipts WHERE id = ? AND project_id = ?").get(executionId, this.paths.descriptor.id)
      : null;
    const candidates = stale.filter((checkpoint) =>
      checkpoint.targetType !== "block" || changedBlockIds.size === 0 || changedBlockIds.has(checkpoint.targetId),
    ).slice(0, 20).map((checkpoint) => ({
      checkpointId: checkpoint.id,
      targetType: checkpoint.targetType,
      targetId: checkpoint.targetId,
      title: checkpoint.title,
      status: checkpoint.status,
    }));
    return {
      executionId: receipt?.id ?? null,
      receiptStatus: receipt?.status ?? null,
      changedBlockIds: [...changedBlockIds],
      candidates,
      markdown: [
        "# Checkpoint refresh candidates",
        `- Execution: ${receipt?.id ?? "none"}`,
        `- Candidates: ${candidates.length}`,
        ...candidates.map((item) => `- ${item.targetType}:${item.targetId} · checkpoint:${item.checkpointId} · ${item.title}`),
      ].join("\n"),
    };
  }

  projectMap(options = {}) {
    return renderProjectMap(this, options);
  }

  decisionList(options = {}) {
    return listDecisions(this, options);
  }

  listDecisions(options = {}) {
    return this.decisionList(options);
  }

  search(options = {}) {
    return searchEntities(this, options);
  }

  entityOpen(options = {}) {
    return openEntity(this, options);
  }

  openEntity(options = {}) {
    return this.entityOpen(options);
  }

  checkpointList(options = {}) {
    return listCheckpoints(this, options);
  }

  listCheckpoints(options = {}) {
    return this.checkpointList(options);
  }

  planContext(options = {}) {
    return renderPlanContext(this, options);
  }

  changesSince(options = {}) {
    return getChangesSince(this, options);
  }

  revertChangeSet(options = {}) {
    return executeRevertChangeSet(this, options);
  }

  getTimeline() {
    return getTimelineState(this);
  }

  commitTimelineMutation(callback) {
    this.ensureSynced();
    const result = transaction(this.database, () => {
      const value = callback();
      this.database.prepare("UPDATE projects SET graph_revision=graph_revision+1 WHERE id=?").run(this.paths.descriptor.id);
      markProjectionPending(this.database);
      return {...value, graphRevision:this.project().graph_revision};
    });
    try { result.projection=flushProjection(this.database,this.paths.graphJsonPath); }
    catch(error) { result.success=false; result.projection={status:'pending',error:error.message}; }
    return result;
  }

  syncTimeline(payload = {}) {
    return this.commitTimelineMutation(() => syncTimeline(this, payload));
  }

  advanceStep(payload = {}) {
    return this.commitTimelineMutation(() => advanceStep(this, payload));
  }

  applyArrowFlow(flowExpression, options = {}) {
    return applyArrowFlow(this, flowExpression, options);
  }

  suggestLinks(blockId) {
    return suggestLinksForBlock(this, blockId);
  }

  connectBlocks(payload = {}) {
    return connectBlocks(this, payload);
  }

  appendPlanChanges({ planId, expectedRevision, changes, actor = "agent", reason = "Append work to an existing Plan" } = {}) {
    if (!planId?.trim()) throw new Error("planId is required");
    return this.mutate({
      actor,
      reason,
      planId,
      task: "plan-append",
      operations: [{ action: "append_plan_changes", id: planId, expectedRevision, fields: { changes } }],
    });
  }

  appendPlanChainScope({ planId, expectedRevision, scope, actor = "agent", reason = "Append a ChainScope to an existing Plan" } = {}) {
    if (!planId?.trim()) throw new Error("planId is required");
    return this.mutate({
      actor,
      reason,
      planId,
      task: "plan-append",
      operations: [{ action: "append_plan_chain_scope", id: planId, expectedRevision, fields: { scope } }],
    });
  }

  updatePlanChanges({ planId, expectedRevision, updates, actor = "agent", reason = "Advance existing Plan changes" } = {}) {
    if (!planId?.trim()) throw new Error("planId is required");
    return this.mutate({
      actor,
      reason,
      planId,
      task: "plan-sync",
      operations: [{ action: "update_plan_changes", id: planId, expectedRevision, fields: { updates } }],
    });
  }

  appendChainPath({ chainId, expectedRevision, nodeIds = [], linkIds = [], actor = "agent", reason = "Append nodes and links to an existing Chain" } = {}) {
    if (!chainId?.trim()) throw new Error("chainId is required");
    return this.mutate({
      actor,
      reason,
      task: "chain-append",
      operations: [{ action: "append_chain_path", id: chainId, expectedRevision, fields: { nodeIds, linkIds } }],
    });
  }

  setChainComposition({ chainId, expectedRevision, memberRefs = [], members = null, linkIds = [], actor = "agent", reason = "Set Composite Chain composition" } = {}) {
    if (!chainId?.trim()) throw new Error("chainId is required");
    return this.mutate({
      actor,
      reason,
      task: "chain-compose",
      operations: [{ action: "set_chain_composition", id: chainId, expectedRevision, fields: { memberRefs: members ?? memberRefs, linkIds } }],
    });
  }

  appendChainComposition({ chainId, expectedRevision, memberRefs = [], members = null, linkIds = [], actor = "agent", reason = "Append members to a Composite Chain" } = {}) {
    if (!chainId?.trim()) throw new Error("chainId is required");
    return this.mutate({
      actor,
      reason,
      task: "chain-compose",
      operations: [{ action: "append_chain_composition", id: chainId, expectedRevision, fields: { memberRefs: members ?? memberRefs, linkIds } }],
    });
  }

  reconcileChainTopology({ chainId = null, autoReorder = true, reason = "Reconcile Chain topology" } = {}) {
    this.ensureSynced();
    return reconcileChainTopology(this, { chainId, autoReorder, reason });
  }

  reconcileChainNetwork({ chainId = null, autoExpand = true, reason = "Reconcile Chain feature network" } = {}) {
    this.ensureSynced();
    return reconcileChainNetwork(this, { chainId, autoExpand, reason });
  }

  contextForTask(options = {}) {
    const repositorySync = indexSources(this);
    const autoReconciliation = this.reconcileSourceBackedBlocks();
    const chainNetwork = this.reconcileChainNetwork({
      autoExpand: true,
      reason: "Reconcile Chain feature networks at context boundary",
    });
    const chainReconciliation = this.reconcileChainTopology({
      autoReorder: true,
      reason: "Reconcile Chain topology at context boundary",
    });
    return { ...buildContextForTask(this, {...options, repositorySync}), repositorySync, autoReconciliation, chainNetwork, chainReconciliation };
  }

  resolveHistoryContext(planId = null, chainScopeId = null) {
    let resolvedPlanId = planId || null;
    if (resolvedPlanId && !entityExists(this.database, this.paths.descriptor.id, "plan", resolvedPlanId)) {
      throw new Error(`plan:${resolvedPlanId} not found`);
    }
    if (chainScopeId) {
      const scope = this.database.prepare(
        `SELECT pcs.plan_id FROM plan_chain_scopes pcs JOIN plans p ON p.id = pcs.plan_id
         WHERE p.project_id = ? AND pcs.id = ?`,
      ).get(this.paths.descriptor.id, chainScopeId);
      if (!scope) throw new Error(`plan_chain_scope:${chainScopeId} not found`);
      if (resolvedPlanId && scope.plan_id !== resolvedPlanId) {
        throw new Error(`plan_chain_scope:${chainScopeId} does not belong to plan:${resolvedPlanId}`);
      }
      resolvedPlanId = scope.plan_id;
    }
    return { planId: resolvedPlanId, chainScopeId: chainScopeId || null };
  }

  createFoundationPlan(options = {}) {
    return createFoundationPlan(this, options);
  }

  graphPatch(options = {}) {
    return executeGraphPatch(this, options);
  }

  mutate(options, limits) {
    return executeMutate(this, options, limits);
  }

  historyStateForOperation(operation, entityType, id) {
    return historyStateForOperation(this, operation, entityType, id);
  }

  historyState(entityType, id) {
    return historyState(this, entityType, id);
  }

  uiLocationFor(entityType, id) {
    return uiLocationFor(entityType, id);
  }

  recordCheckpoint(options = {}) {
    return recordCheckpoint(this, options);
  }

  validate() {
    this.reconcileChainNetwork({
      autoExpand: true,
      reason: "Reconcile Chain feature networks before validation",
    });
    this.reconcileChainTopology({
      autoReorder: true,
      reason: "Reconcile Chain topology before validation",
    });
    return validateGraph(this);
  }

  validateGraph() {
    return this.validate();
  }

  graphStatus(options = {}) {
    return renderGraphStatus(this, options);
  }
}

export function createService(options = {}) {
  return new ContextOSService(options);
}
