import { selectMicroProvider } from './micro-provider.mjs';
import { cliDoctor } from './micro-cli.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SessionStore, workspaceFingerprint } from './session-store.mjs';
import { Tracer } from './tracer.mjs';
import { createCapabilities } from './capabilities.mjs';
import { globalProfilePath, loadProfile, saveProfile } from './profile.mjs';
import { changePipeline, explorePipeline, extractFailureEvidence, inspectPipeline, integratePipeline, pipelinePipeline, shipPipeline, verifyPipeline, workPipeline } from './pipelines.mjs';
import { executeAgent } from './agent-service.mjs';
import { MICRO_PRESETS, runMicroTask, runMicroTasksParallel } from './micro-client.mjs';
import { microPreloadReceipt, runTaskMicroPreload } from './micro-preload.mjs';
import { buildMicroHistory, closeMicroSession, completeMicroTurn, createMicroSession, deleteMicroSession, failMicroTurn, listMicroSessions, microSessionSnapshot, readMicroSession, startMicroTurn } from './micro-session.mjs';
import { evictArtifacts, listArtifacts, readArtifact, statArtifact, storeArtifact } from './artifact-store.mjs';
import { RESPONSE_BUDGETS, clipText, compactJson, finalizeResponse, projectMicroResult, summarizeMicroUsage } from './response-budget.mjs';
import { parseRolloutTelemetry } from './rollout-telemetry.mjs';
import { compareTelemetry, recordTelemetry, summarizeTelemetry } from './telemetry.mjs';
import { auditRouting } from './routing-audit.mjs';
import { claimMicroDeliveries, completeMicroDeliveryClaims, createMicroJob, readMicroJob, reportMicroJob, listMicroJobs, releaseMicroDeliveryClaims, renderMicroDeliveries, updateMicroJob, enqueueMicroDelivery } from './micro-delivery.mjs';
import { receiveMicroMessages, sendMicroMessage, waitForMicroMessages } from './micro-mailbox.mjs';
import { resolveMicroRoles } from './micro-role-config.mjs';
import { createEvidenceTransport } from './api-transports.mjs';
import { appendRoleUsage, readRoleUsage, summarizeRoleUsage } from './role-usage-ledger.mjs';

export * from './context-budget.mjs';
export * from './intent-router.mjs';
export * from './micro-client.mjs';
export * from './micro-cli.mjs';
export * from './micro-provider.mjs';
export * from './micro-delivery.mjs';
export * from './micro-preload.mjs';
export * from './micro-session.mjs';
export * from './module-index.mjs';
export * from './observer.mjs';
export * from './profile.mjs';
export * from './rollout-telemetry.mjs';
export * from './routing-audit.mjs';
export * from './session-store.mjs';

export const OPS_CAPABILITIES = [
  'os_context',
  'plan',
  'task',
  'block',
  'chain',
  'architecture',
  'code',
  'run_command',
  'process',
  'knowledge',
  'session',
  'system',
  'profile',
  'micro',
  'artifact',
  'usage',
  'telemetry',
];

function render(value) {
  return typeof value === 'string' ? value : compactJson(value);
}

const SECRET_FIELD_PATTERN = /(^|[-_.])(api[-_]?key|key|token|secret|password|passwd|credential|credentials|authorization|auth|cookie)([-_.]|$)/i;
const SECRET_MAP_PATTERN = /(^|[-_.])(headers?|env|env[-_]?vars?)([-_.]|$)/i;

/**
 * Profile responses are user-visible. Replace credential material with a
 * placeholder while keeping structural fields (for example `keyEnv`) visible.
 */
export function redactProfileSecrets(value, fieldName = '') {
  if (Array.isArray(value)) return value.map((item) => redactProfileSecrets(item, fieldName));
  if (value === null || typeof value !== 'object') {
    return SECRET_FIELD_PATTERN.test(fieldName) && typeof value === 'string' && value ? '[redacted]' : value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (SECRET_MAP_PATTERN.test(key) && item !== null && typeof item === 'object' && !Array.isArray(item)) {
      return [key, Object.fromEntries(Object.entries(item).map(([name, mapValue]) => [
        name,
        typeof mapValue === 'string' && mapValue ? '[redacted]' : redactProfileSecrets(mapValue, name),
      ]))];
    }
    return [key, redactProfileSecrets(item, key)];
  }));
}

const MUTATION_INPUT_KEYS = new Set([
  'create', 'edits', 'delete', 'deletes', 'append', 'symbol', 'replacement',
  'replacementContent', 'target', 'targetContent', 'content', 'overwrite',
  'fullFile', 'architecture',
]);

function routeKind(tool, input = {}) {
  if (tool === 'change' || (tool === 'work' && [...MUTATION_INPUT_KEYS].some((key) => input[key] !== undefined))) {
    return 'mutation';
  }
  if (tool === 'work' && (input.verify !== undefined || input.commands !== undefined)) return 'verification';
  if (tool === 'work') return 'discovery';
  if (tool === 'verify') return 'verification';
  if (tool === 'ship') return 'closure';
  if (tool === 'explore' || tool === 'inspect') return 'discovery';
  if (tool === 'pipeline') return 'orchestration';
  if (tool !== 'ops') return 'unknown';

  const capability = input.capability;
  const action = String(input.action || '');
  if (capability === 'micro') return 'delegation';
  if (capability === 'code' && ['create', 'edit', 'changeset'].includes(action)) return 'mutation';
  if (capability === 'block' && ['bind', 'bind_auto', 'prune_derived'].includes(action)) return 'mutation';
  if (capability === 'chain' && ['compose', 'link', 'unlink', 'delete'].includes(action)) return 'mutation';
  if (capability === 'plan' && ['create', 'update', 'complete', 'delete', 'archive'].includes(action)) return 'mutation';
  if (capability === 'task' && ['create', 'start', 'update', 'finish', 'complete', 'delete', 'archive'].includes(action)) return 'mutation';
  if (capability === 'knowledge' && ['decision_write', 'rule_write', 'rule_delete', 'delete'].includes(action)) return 'mutation';
  if (capability === 'session' && ['note', 'close'].includes(action)) return 'mutation';
  if (capability === 'profile' && action === 'set') return 'mutation';
  if (capability === 'artifact' && action === 'evict') return 'mutation';
  if (capability === 'telemetry' || capability === 'artifact' || capability === 'session') return 'diagnostic';
  if (capability === 'run_command' || capability === 'process') return 'verification';
  return 'discovery';
}

const SEMANTIC_OPS_READS = new Set([
  'os_context:brief', 'os_context:search', 'os_context:status',
  'plan:list', 'plan:open', 'plan:check',
  'task:list', 'task:open', 'task:check', 'task:status',
  'block:list', 'block:open', 'block:search',
  'chain:list', 'chain:open', 'chain:validate',
  'knowledge:list', 'knowledge:read', 'knowledge:status',
  'session:history', 'session:resume', 'session:status',
  'profile:get', 'artifact:read', 'artifact:stat', 'artifact:list',
  'telemetry:audit', 'telemetry:compare', 'telemetry:summary',
]);

const CONVERGENCE_DISCOVERY_LIMIT = 6;
const INSPECT_RESPONSE_HARD_CAP = 32000;
const MICRO_BATCH_DEFAULT_CONCURRENCY = 4;
const MICRO_ACTION_NAMES = ['run', 'batch', 'doctor', 'help', 'schema', 'get', 'list', 'cancel', 'report', 'send', 'messages', 'session', 'continue', 'resume'];
const MICRO_ACTION_SET = new Set(MICRO_ACTION_NAMES);

function normalizeMicroBatchConcurrency(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) return MICRO_BATCH_DEFAULT_CONCURRENCY;
  return Math.max(1, Math.floor(requested));
}

function shouldEnableMicroOS(args = {}) {
  const explicit = args.withOS;
  const toolsEnabled = args.invocation?.tools?.enabled;
  if (explicit === false || toolsEnabled === false) return false;
  if (explicit === true || toolsEnabled === true) return true;
  const hasAttachedEvidence = args.pipeline != null
    || args.preload != null
    || args.inputArtifact != null
    || args.artifactId != null
    || args.artifact != null;
  if (hasAttachedEvidence) return false;
  const maxRequests = args.invocation?.provider?.maxRequests ?? args.maxRequests;
  return maxRequests == null || Number(maxRequests) >= 2;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function recentUnproductiveCalls(projectRoot, sessionId) {
  const filePath = path.join(projectRoot, '.contextos', 'logs', 'telemetry.jsonl');
  if (!fs.existsSync(filePath)) return 0;
  let entries = [];
  try {
    entries = fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.sessionId === sessionId && entry.internal !== true);
  } catch (_) {
    return 0;
  }
  let count = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const kind = entries[index].routeKind;
    if (['mutation', 'verification', 'closure'].includes(kind)) break;
    if (kind === 'discovery' || kind === 'diagnostic') count += 1;
  }
  return count;
}

function isUnproductiveDiscovery(tool, input = {}) {
  if (tool === 'explore' || tool === 'inspect') return true;
  if (tool === 'work') {
    const hasMutation = [...MUTATION_INPUT_KEYS].some((key) => input[key] !== undefined);
    const hasVerification = input.verify !== undefined || input.commands !== undefined;
    return !hasMutation && !hasVerification;
  }
  if (tool !== 'ops' || input.capability === 'telemetry' || input.capability === 'micro') return false;
  return [
    'code', 'artifact', 'os_context', 'plan', 'task', 'block', 'chain', 'knowledge', 'session', 'profile',
  ].includes(input.capability)
    && !['create', 'update', 'complete', 'delete', 'archive', 'start', 'finish', 'close', 'set', 'bind', 'bind_auto', 'compose', 'link', 'unlink', 'evict', 'edit', 'changeset'].includes(String(input.action || ''));
}

function decisionPackageMetadata(tool, result) {
  const text = typeof result === 'string' ? result : '';
  if (!text) return null;
  const pipelineStatus = text.match(/^(?:pipeline|work)=([A-Z]+)/m)?.[1] || null;
  const readComplete = text.match(/\bread_complete=(true|false)\b/)?.[1] || null;
  const decisionComplete = readComplete === 'true' || /\bdecision=complete\b/.test(text);
  if (pipelineStatus) {
    const artifactId = text.match(/\bartifact\s*[=:]\s*([A-Za-z0-9._-]+)/i)?.[1] || null;
    const receiptId = text.match(/\breceipt(?:\s+|[=:~-])([A-Za-z0-9._-]+)/i)?.[1] || null;
    return {
      status: readComplete === 'false' ? 'partial' : pipelineStatus,
      decisionComplete,
      artifactId,
      receiptId,
    };
  }
  if (tool === 'explore'
    && /##\s+Where to look/i.test(text)
    && /##\s+Critical slices/i.test(text)) {
    const artifactId = text.match(/\bartifact\s*[=:]\s*([A-Za-z0-9._-]+)/i)?.[1] || null;
    return { status: 'OK', decisionComplete: true, artifactId, receiptId: null };
  }
  return null;
}

// Discovery calls are never refused: a caller that asked for new information
// cannot tell "nothing matched" from "the guard ate the result", and native
// tools never refuse a read. Over-limit sessions get a bounded convergence
// hint attached to the real payload instead of a policy message replacing it.
// Refusing reads also made the counter a ratchet: every gated call was itself
// recorded as discovery telemetry, so the session could never recover.
function convergenceHint(projectRoot, sessionId, tool, input, semanticReceipt) {
  if (semanticReceipt || !isUnproductiveDiscovery(tool, input)) return null;
  if (input.refresh === true || input.dedupeReads === false || input.full === true || input.budget === 'full') return null;
  const nested = input.args && typeof input.args === 'object' && !Array.isArray(input.args) ? input.args : {};
  if (nested.refresh === true || nested.dedupeReads === false || nested.full === true || nested.budget === 'full') return null;
  const count = recentUnproductiveCalls(projectRoot, sessionId);
  if (count < CONVERGENCE_DISCOVERY_LIMIT) return null;
  return `${count} discovery/diagnostic calls since the last mutation or verification; converge with one bounded work/change/verify or a dependent pipeline. Result returned in full.`;
}

function shouldAutoVerifyExplore(input = {}, commands = []) {
  if (input.autoVerify === false || input.verify === false) return false;
  if (!Array.isArray(commands) || commands.length === 0) return false;
  const intent = String(input.intent || '');
  const task = String(input.task || '');
  const repairIntent = /(?:修复|失败|报错|缺陷|故障|诊断|fix(?:ing)?|fail(?:ing|ure)?|error|bug|debug|repair|diagnos(?:e|is|tic)|regression)/i.test(intent);
  const implementationIntent = /(?:实现|开发|修改|重构|implement(?:ation|ing|s)?|develop(?:ment|ing)?|feature|refactor(?:ing)?|modify|modification|update|build)/i.test(intent);
  const verificationIntent = /(?:测试|验证|校验|test(?:s|ing)?|spec(?:s)?|verify|verification|failure(?:s)?|error(?:s)?)/i.test(intent);
  const taskVerificationIntent = /(?:基线|baseline|测试|验证|校验|验收|acceptance|test(?:s|ing)?|spec(?:s)?|verify|verification)/i.test(task);
  return repairIntent
    || (implementationIntent && verificationIntent)
    || taskVerificationIntent;
}

function exploreBaselineCommands(input = {}, profile = {}) {
  if (input.verify === true) {
    return Array.isArray(profile.verify) ? profile.verify.filter(Boolean) : [];
  }
  if (typeof input.verify === 'string') return input.verify.trim() ? [input.verify.trim()] : [];
  if (Array.isArray(input.verify)) {
    return input.verify.filter((command) => typeof command === 'string' && command.trim());
  }
  if (input.verify && typeof input.verify === 'object') {
    if (Array.isArray(input.verify.commands)) {
      return input.verify.commands.filter((command) => typeof command === 'string' && command.trim());
    }
    if (typeof input.verify.command === 'string' && input.verify.command.trim()) {
      return [input.verify.command.trim()];
    }
  }
  return [];
}

function semanticOpsMemoSpec(input = {}) {
  if (input.capability === 'telemetry') return null;
  const capability = String(input.capability || '');
  const action = String(input.action || '');
  if (!SEMANTIC_OPS_READS.has(`${capability}:${action}`)) return null;
  const nested = input.args && typeof input.args === 'object' && !Array.isArray(input.args)
    ? input.args
    : {};
  if (input.refresh === true || input.dedupeReads === false || input.full === true || input.budget === 'full'
    || nested.refresh === true || nested.dedupeReads === false || nested.full === true || nested.budget === 'full') {
    return null;
  }
  const controls = new Set(['projectRoot', 'capability', 'action', 'args', 'refresh', 'dedupeReads', 'full', 'budget', 'maxChars']);
  const body = {};
  for (const [key, value] of Object.entries({ ...input, ...nested })) {
    if (!controls.has(key)) body[key] = value;
  }
  const canonical = JSON.stringify(canonicalize(body));
  const key = crypto.createHash('sha256')
    .update(`${capability}:${action}:${canonical}`)
    .digest('hex');
  return { key: `${capability}:${action}:${key}`, capability, action };
}

function semanticOpsReuse(spec, receipt) {
  const artifact = receipt?.artifactId ? ` artifact=${receipt.artifactId}` : '';
  const hash = receipt?.hash || 'unchanged';
  const chars = Number(receipt?.fullChars) || 0;
  return [
    `# ContextOS ${spec.capability}.${spec.action} (reused)`,
    `- unchanged result hash=${hash} chars=${chars}${artifact}`,
    '- Prior diagnostic replay suppressed; use refresh:true or dedupeReads:false for fresh state.',
  ].join('\n');
}

function isDecisionArtifactKind(kind) {
  return kind === 'response:pipeline' || kind === 'response:explore' || kind === 'response:work';
}

function compactPipelineArtifactPreview(projectRoot, artifact, maxChars = 1400) {
  if (!artifact || !isDecisionArtifactKind(artifact.kind)) return null;
  try {
    if (artifact.kind !== 'response:pipeline') {
      const preview = readArtifact(projectRoot, artifact.id, { maxChars, lineNumbers: false });
      if (!preview?.text) return null;
      return `${preview.text}${preview.truncated ? '\n[preview clipped; raw replay requires allowRawPipeline:true plus auditReason]' : ''}`;
    }
    const full = readArtifact(projectRoot, artifact.id, { maxChars: Infinity, lineNumbers: false });
    const payload = full && !full.truncated ? JSON.parse(full.text) : null;
    if (!payload || !Array.isArray(payload.steps)) return null;
    const lines = [`status=${payload.status || 'UNKNOWN'} actions=${payload.totalActions || 0}`];
    for (const step of payload.steps) {
      const items = Array.isArray(step?.items) ? step.items : [step];
      for (const item of items) {
        const body = String(item?.output ?? item?.error ?? '')
          .replace(/\s+/g, ' ')
          .trim();
        const label = `step=${step?.step ?? '?'}${item?.index ? `.${item.index}` : ''} tool=${item?.tool || step?.tool || 'action'} ${item?.ok === false ? 'FAIL' : 'OK'}`;
        lines.push(`- ${label}${body ? `: ${body.slice(0, 240)}` : ''}`);
      }
    }
    const preview = lines.join('\n');
    if (!preview || preview.length > maxChars + 1) {
      const limit = Math.max(200, maxChars);
      return `${preview.slice(0, Math.max(0, limit - 68))}\n[preview clipped; use full:true for the artifact]`;
    }
    return preview;
  } catch (_) {
    return null;
  }
}

function readReceiptLogExcerpt(projectRoot, receiptId, { maxChars = 1800 } = {}) {
  const id = String(receiptId || '').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    return { id, error: 'invalid-receipt-id' };
  }
  const filePath = path.join(projectRoot, '.contextos', 'logs', `${id}.log`);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return { id, error: 'not-found' };
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const evidence = extractFailureEvidence(content);
  const selected = [evidence.test, evidence.cause, evidence.stackFrame]
    .filter(Boolean)
    .filter((line, index, values) => values.indexOf(line) === index);
  const fallback = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12);
  const body = (selected.length ? selected : fallback).join('\n');
  const text = clipText(body, maxChars, { label: 'receipt excerpt' });
  return {
    id,
    text,
    fullChars: content.length,
    truncated: text.length < body.length,
  };
}

function applyDottedProfileValues(target, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return target;
  for (const [key, value] of Object.entries(values)) {
    const parts = String(key).split('.').filter(Boolean);
    if (parts.length < 2) {
      target[key] = value;
      continue;
    }
    let cursor = target;
    for (const part of parts.slice(0, -1)) {
      if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) cursor[part] = {};
      cursor = cursor[part];
    }
    cursor[parts.at(-1)] = value;
  }
  return target;
}

function microPreloadSpec(args = {}) {
  if (args.preload !== undefined && args.preload !== null) return args.preload;
  if (args.invocation?.evidence?.pipeline !== undefined) {
    return {
      invocation: { evidence: args.invocation.evidence },
      ...(args.maxChars !== undefined ? { maxChars: args.maxChars } : {}),
      ...(args.onFailure !== undefined ? { onFailure: args.onFailure } : {}),
    };
  }
  if (args.pipeline !== undefined) {
    return {
      pipeline: args.pipeline,
      ...(args.maxChars !== undefined ? { maxChars: args.maxChars } : {}),
      ...(args.onFailure !== undefined ? { onFailure: args.onFailure } : {}),
    };
  }
  return null;
}

function microPreloadFailure(preload, requestedDelivery = null) {
  return {
    ok: false,
    error: preload?.error || `Micro preload ended with ${preload?.status || 'ERROR'}.`,
    budgetExceeded: preload?.status === 'TRUNCATED',
    requestedDelivery,
    preload,
  };
}

function compactMicroJob(job) {
  if (!job) return null;
  return { jobId: job.jobId, status: job.status, provider: job.provider,
    ...(job.receiptId ? { receiptId: job.receiptId } : {}),
    ...(job.artifactId ? { artifactId: job.artifactId } : {}),
    ...(job.report ? { report: job.report } : {}),
    ...(job.error ? { error: job.error.slice(0, 500) } : {}),
    ...(job.result?.costEstimate ? { costEstimate: job.result.costEstimate } : {}) };
}
function attachChildMessages(result) {
  if (process.env.CONTEXTOS_WORKER_MODE !== '1' || !process.env.CONTEXTOS_MICRO_REPORT_JOB || !process.env.CONTEXTOS_MICRO_REPORT_ROOT) return result;
  let messages;
  try { messages = receiveMicroMessages(process.env.CONTEXTOS_MICRO_REPORT_ROOT, process.env.CONTEXTOS_MICRO_REPORT_JOB); }
  catch { return result; } // A mailbox failure must not make an executed edit appear unexecuted.
  if (!messages.length) return result;
  if (typeof result !== 'string') return { ...result, microMessages: messages };
  try { return compactJson({ ...JSON.parse(result), microMessages: messages }); }
  catch { return compactJson({ result, microMessages: messages }); }
}

function structuredDelivery(content) {
  try {
    const value = JSON.parse(content);
    if (value && typeof value === 'object' && typeof value.summary === 'string' && typeof value.needsHost === 'boolean') return { report: value };
  } catch {}
  return { content };
}

function attachMicroDeliveryData(result, claims = [], warning = null) {
  const microRecovered = claims.map(({ deliveryId, receiptId, artifactId, content, truncated }) => ({
    deliveryId,
    receiptId,
    artifactId,
    ...structuredDelivery(content),
    ...(truncated ? { truncated: true } : {}),
  }));
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return {
      ...result,
      ...(microRecovered.length ? { microRecovered } : {}),
      ...(warning ? { microRecoveryWarning: warning } : {}),
    };
  }
  if (typeof result === 'string') {
    try {
      const parsed = JSON.parse(result);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return compactJson({
          ...parsed,
          ...(microRecovered.length ? { microRecovered } : {}),
          ...(warning ? { microRecoveryWarning: warning } : {}),
        });
      }
      if (microRecovered.length || warning) {
        return compactJson({
          result: parsed,
          ...(microRecovered.length ? { microRecovered } : {}),
          ...(warning ? { microRecoveryWarning: warning } : {}),
        });
      }
    } catch (_) {}
    const recovered = renderMicroDeliveries(claims);
    const notice = warning ? `## Deferred Micro recovery notice\n${warning}` : '';
    return [recovered, notice, result].filter(Boolean).join('\n\n');
  }
  if (microRecovered.length || warning) {
    return {
      result,
      ...(microRecovered.length ? { microRecovered } : {}),
      ...(warning ? { microRecoveryWarning: warning } : {}),
    };
  }
  return result;
}

function attachRoutingHint(result, hint = null) {
  if (!hint) return result;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return { ...result, routingHint: hint };
  }
  if (typeof result === 'string') {
    try {
      const parsed = JSON.parse(result);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return compactJson({ ...parsed, routingHint: hint });
      }
      if (parsed !== null) return result;
    } catch (_) {}
    return result;
  }
  return result;
}

function retainContinuableMicroSession(ctx, args, result, projected, { withOS = false } = {}) {
  const providerTruncated = result?.providerTruncated === true
    || ['length', 'max_tokens', 'max_output_tokens'].includes(String(result?.finishReason || '').toLowerCase());
  if ((!result?.partial && !providerTruncated) || !result?.sessionId) return null;
  try {
    const task = String(args.firstTask ?? args.task ?? args.prompt ?? '').trim() || 'Continue the partial Micro task.';
    const session = createMicroSession(ctx.projectRoot, {
      sessionId: result.sessionId,
      objective: task,
      preset: args.preset,
      withOS,
      preload: null,
    });
    startMicroTurn(ctx.projectRoot, session.id, task);
    const completed = completeMicroTurn(ctx.projectRoot, session.id, {
      result: {
        ...result,
        content: projected?.content || result.content || result.guidance || 'Partial Micro work retained.',
      },
      receiptId: projected?.receiptId || null,
    });
    return {
      session: completed,
      resume: projected?.resume || { kind: 'micro', action: 'send', sessionId: completed.id },
    };
  } catch (error) {
    return { retentionWarning: `Partial Micro work could not be retained: ${error.message}` };
  }
}

async function runMicroSessionTurn(ctx, args, session) {
  const task = args.firstTask ?? args.task ?? args.prompt;
  if (!String(task || '').trim()) {
    throw new Error('Micro session runFirst requires a non-empty task, firstTask, or prompt.');
  }
  const startedSession = startMicroTurn(ctx.projectRoot, session.id, task);
  if (startedSession.turnCount === 0 && startedSession.preload && startedSession.preload.ok === false) {
    const failedSession = failMicroTurn(ctx.projectRoot, startedSession.id);
    const projected = projectMicroResult(microPreloadFailure(startedSession.preload, args.delivery), {
      projectRoot: ctx.projectRoot,
      hostSessionId: ctx.sessionId,
      full: args.full === true,
      maxChars: args.maxChars,
    });
    return {
      ...projected,
      preload: microPreloadReceipt(startedSession.preload),
      session: failedSession,
    };
  }

  const preset = MICRO_PRESETS[startedSession.preset] || null;
  const sessionWithOS = startedSession.withOS === false ? false : shouldEnableMicroOS(args);
  const history = buildMicroHistory(startedSession, {
    systemPrompt: preset?.system || '',
    // Preload is a one-time evidence handoff. Repeating the same raw slice on
    // every persistent turn pays provider tokens again and defeats the point
    // of keeping it in the Micro session.
    includePreload: startedSession.turnCount === 0,
  });
  try {
    const result = await runMicroTask(ctx.profile?.micro || {}, {
      ...args,
      prompt: '',
      input: undefined,
      inputRef: undefined,
      inputReceipt: undefined,
      inputArtifact: undefined,
      history,
      preload: undefined,
      sessionId: startedSession.id,
      sessionMode: 'persistent',
      withOS: sessionWithOS,
      outputMode: args.full ? 'full' : 'answer',
      caps: sessionWithOS ? ctx.caps : null,
      orchestrator: ctx.orchestrator,
      projectRoot: ctx.projectRoot,
    });
    const projected = projectMicroResult(result, {
      projectRoot: ctx.projectRoot,
      hostSessionId: ctx.sessionId,
      full: args.full === true,
      maxChars: args.maxChars,
    });
    const nextSession = result.ok || result.partial
      ? completeMicroTurn(ctx.projectRoot, startedSession.id, {
          result: result.ok
            ? result
            : { ...result, content: projected.content || result.content || result.guidance || 'Partial Micro work retained.' },
          receiptId: projected.receiptId,
        })
      : failMicroTurn(ctx.projectRoot, startedSession.id);
    return { ...projected, session: nextSession };
  } catch (error) {
    failMicroTurn(ctx.projectRoot, startedSession.id);
    throw error;
  }
}

const backgroundMicroControllers = new Map();
const backgroundKey = (root, id) => `${fs.realpathSync(root)}:${id}`;

function startBackgroundMicroRun(ctx, { args, microConfig, preload, action, effectiveWithOS }) {
  const jobId = String(args.jobId || `micro-job-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  const created = createMicroJob(ctx.projectRoot, {
    jobId,
    kind: 'micro',
    preset: args.preset || null,
    provider: selectMicroProvider(microConfig, args).provider || null,
    hostSessionId: ctx.sessionId,
    inputSource: preload ? 'preload' : (args.prompt || args.task ? 'task' : 'none'),
  });
  if (!created.created) {
    return {
      ok: true,
      delivery: created.job.status === 'running' ? 'running' : created.job.delivery || created.job.status,
      jobId,
      status: created.job.status,
      duplicate: true,
      ...(preload ? { preload: microPreloadReceipt(preload) } : {}),
    };
  }

  const controller = new AbortController();
  const key = backgroundKey(ctx.projectRoot, jobId);
  backgroundMicroControllers.set(key, controller);
  const run = async () => {
    try {
      const result = await runMicroTask(microConfig, {
        ...args,
        delivery: args.delivery === 'immediate' ? 'defer' : (args.delivery || 'auto'),
        signal: controller.signal,
        reportJobId: jobId,
        agentJobId: jobId,
        preload,
        action,
        withOS: effectiveWithOS,
        outputMode: args.full ? 'full' : 'answer',
        caps: effectiveWithOS ? ctx.caps : null,
        orchestrator: ctx.orchestrator,
        projectRoot: ctx.projectRoot,
      });
      const projected = projectMicroResult({ ...result, receiptId: jobId }, {
        projectRoot: ctx.projectRoot,
        hostSessionId: ctx.sessionId,
        full: false,
        maxChars: args.maxChars,
      });
      const retained = retainContinuableMicroSession(ctx, args, result, projected, { withOS: effectiveWithOS });
      if (projected.status === 'partial') {
        const content = projected.guidance || projected.content || 'Micro background job reached the 290s continuation window.';
        enqueueMicroDelivery(ctx.projectRoot, {
          deliveryId: jobId,
          receiptId: projected.receiptId || jobId,
          artifactId: projected.artifactId || null,
          content: `Micro background job partial: ${content}`,
        });
        updateMicroJob(ctx.projectRoot, jobId, {
          status: 'partial',
          receiptId: projected.receiptId || jobId,
          artifactId: projected.artifactId || null,
          result: { ...projected, ...(retained || {}) },
          report: result.agentReport ? { ...result.agentReport, status: 'partial', needsHost: true } : null,
          error: null,
        });
        return;
      }
      if (projected.ok) {
        if (projected.delivery === 'immediate') enqueueMicroDelivery(ctx.projectRoot, { deliveryId: jobId, receiptId: projected.receiptId || jobId, artifactId: projected.artifactId, content: projected.content || 'Micro completed; read the result artifact.' });
        updateMicroJob(ctx.projectRoot, jobId, {
          status: 'completed',
          receiptId: projected.receiptId || jobId,
          artifactId: projected.artifactId || null,
          delivery: projected.delivery || null,
          result: projected,
          report: result.agentReport || null,
        });
        return;
      }
      const message = projected.error || 'Micro background job failed.';
      enqueueMicroDelivery(ctx.projectRoot, {
        deliveryId: jobId,
        receiptId: projected.receiptId || jobId,
        artifactId: projected.artifactId || null,
        content: `Micro background job failed: ${message}`,
      });
      updateMicroJob(ctx.projectRoot, jobId, {
        status: 'failed',
        receiptId: projected.receiptId || jobId,
        artifactId: projected.artifactId || null,
        result: projected,
        report: result.agentReport ? { ...result.agentReport, status: 'failed', needsHost: true } : null,
        error: message,
      });
    } catch (error) {
      const message = error?.message || String(error);
      try {
        enqueueMicroDelivery(ctx.projectRoot, {
          deliveryId: jobId,
          receiptId: jobId,
          content: `Micro background job failed: ${message}`,
        });
      } catch (_) {}
      updateMicroJob(ctx.projectRoot, jobId, { status: 'failed', error: message });
    } finally {
      backgroundMicroControllers.delete(key);
    }
  };

  void run().catch(() => {
    // A deleted/unwritable workspace must not crash the MCP host.
    process.stderr.write(`ContextOS could not persist terminal state for Micro job ${jobId}.\n`);
  });
  return {
    ok: true,
    delivery: 'running',
    jobId,
    receiptId: jobId,
    ...(preload ? { preload: microPreloadReceipt(preload) } : {}),
  };
}

function isJsonValueString(value) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null;
  } catch (_) {
    return false;
  }
}

function nestedResponseRequests(input = {}) {
  const values = [];
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object') return;
    values.push(value);
    if (value.args && typeof value.args === 'object') visit(value.args);
    for (const key of ['inspect', 'verify', 'change', 'ship', 'ops', 'run', 'search']) {
      if (value[key] && typeof value[key] === 'object') visit(value[key]);
    }
  };
  visit(input);
  return values;
}

function nestedFullRequest(values = []) {
  return values.some((value) => (
    value.full === true
    || value.fullFile === true
    || value.budget === 'full'
    || value.mode === 'full'
  ));
}

function nestedMaxChars(values = []) {
  let maxChars = null;
  for (const value of values) {
    const candidate = Number(value.maxChars);
    if (Number.isFinite(candidate) && candidate > 0) {
      maxChars = maxChars === null ? candidate : Math.max(maxChars, candidate);
    }
  }
  return maxChars;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function repositoryRelativePath(projectRoot, value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const root = path.resolve(projectRoot);
  const fullPath = path.resolve(root, value);
  const relativePath = path.relative(root, fullPath).split(path.sep).join('/');
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null;
  return { relativePath, fullPath };
}

function codeReadMemoSpec(projectRoot, args = {}) {
  const resolved = repositoryRelativePath(projectRoot, args.path);
  if (!resolved) return null;
  const selector = args.selector && typeof args.selector === 'object' && !Array.isArray(args.selector)
    ? args.selector
    : {};
  const ranges = Array.isArray(args.ranges)
    ? args.ranges.map((range) => ({
        startLine: range?.startLine ?? null,
        endLine: range?.endLine ?? null,
      }))
    : (Array.isArray(selector.ranges)
        ? selector.ranges.map((range) => ({
            startLine: range?.startLine ?? null,
            endLine: range?.endLine ?? null,
          }))
        : null);
  const symbol = args.symbol || selector.symbol || selector.method || null;
  const range = ranges
    ? JSON.stringify(ranges)
    : (args.startLine !== undefined || args.endLine !== undefined || selector.startLine !== undefined || selector.endLine !== undefined)
        ? `${args.startLine ?? selector.startLine ?? ''}:${args.endLine ?? selector.endLine ?? ''}`
        : (args.fullFile === true || selector.fullFile === true ? 'full' : ':');
  let stat = null;
  try {
    const fileStat = fs.statSync(resolved.fullPath);
    if (fileStat.isFile()) stat = { mtimeMs: fileStat.mtimeMs, size: fileStat.size };
  } catch (_) {}
  return {
    ...resolved,
    range,
    symbol: symbol ? String(symbol) : null,
    stat,
  };
}

function codeReadOutputMeta(value, spec) {
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const header = text.match(/\/\/\s+[^\n]+\s+\[L(\d+)-L(\d+)\]\s+\(hash:\s*([0-9a-f]+)\)/i);
  const hash = object?.hash || object?.data?.hash || header?.[3]
    || crypto.createHash('sha256').update(text).digest('hex');
  return {
    hash: String(hash),
    startLine: Number(object?.startLine ?? object?.data?.startLine ?? header?.[1]) || null,
    endLine: Number(object?.endLine ?? object?.data?.endLine ?? header?.[2]) || null,
    symbol: object?.symbol || object?.data?.symbol || spec.symbol || null,
  };
}

function isExplicitReadReplay(args = {}) {
  return args.dedupeReads === false
    || args.full === true
    || args.budget === 'full'
    || args.maxChars !== undefined
    || args.fullFile === true;
}

function readMemoStillValid(spec, receipt) {
  if (!spec?.stat || !receipt) return false;
  return Number(receipt.mtimeMs) === Number(spec.stat.mtimeMs)
    && Number(receipt.size) === Number(spec.stat.size);
}

function renderReadReuse(spec, receipt, format = 'markdown') {
  const data = {
    ok: true,
    reused: true,
    filePath: spec.relativePath,
    range: spec.range,
    symbol: spec.symbol,
    hash: receipt.hash || null,
    artifactId: receipt.artifactId || receipt.receiptId || null,
    message: 'This unchanged source slice was already returned earlier in the session; no source was replayed.',
  };
  if (format === 'json') return data;
  const artifact = receipt.artifactId || receipt.receiptId;
  return `# ContextOS code read (reused)\n- ${spec.relativePath} range=${spec.range} hash=${receipt.hash || 'unchanged'}${artifact ? ` artifact=${artifact}` : ''}\n- Source replay suppressed; use dedupeReads:false for a fresh slice.`;
}

function recordCodeReadMemo(projectRoot, store, args, value, spec) {
  const meta = codeReadOutputMeta(value, spec);
  let artifact = null;
  try {
    artifact = storeArtifact(projectRoot, value, {
      kind: 'code-read',
      metadata: {
        path: spec.relativePath,
        range: spec.range,
        symbol: spec.symbol,
        hash: meta.hash,
      },
    });
  } catch (_) {}
  store.recordReadReceipt({
    path: spec.relativePath,
    hash: meta.hash,
    range: spec.range,
    symbol: meta.symbol,
    receiptId: artifact?.id || null,
    artifactId: artifact?.id || null,
    mtimeMs: spec.stat?.mtimeMs,
    size: spec.stat?.size,
  });
  return value;
}

function searchMemoKey(args = {}) {
  return JSON.stringify(canonicalize({
    query: args.query || '',
    root: args.root || null,
    limit: args.limit ?? null,
    maxResults: args.maxResults ?? null,
    format: args.format || 'markdown',
  }));
}

function renderSearchReuse(receipt, format = 'markdown') {
  const data = {
    ok: true,
    reused: true,
    artifactId: receipt.artifactId || receipt.receiptId || null,
    message: 'This unchanged search was already executed in the session; its result was not replayed.',
  };
  if (format === 'json') return data;
  const artifact = receipt.artifactId || receipt.receiptId;
  return `# ContextOS code search (reused)\n- reused${artifact ? ` artifact=${artifact}` : ''}\n- Search replay suppressed; change the query/root or use dedupeReads:false.`;
}

function recordSearchMemo(projectRoot, store, args, value, revision) {
  let artifact = null;
  try {
    artifact = storeArtifact(projectRoot, value, {
      kind: 'code-search',
      metadata: { query: args.query || '', root: args.root || null, revision },
    });
  } catch (_) {}
  store.recordSearchReceipt({
    key: searchMemoKey(args),
    revision,
    receiptId: artifact?.id || null,
    artifactId: artifact?.id || null,
  });
  return value;
}

function exploreMemoKey(args = {}) {
  return JSON.stringify(canonicalize({
    intent: args.intent || '',
    paths: args.paths || null,
    depth: args.depth || null,
    maxChars: args.maxChars ?? null,
    full: args.full === true,
  }));
}

function isExplicitExploreReplay(args = {}) {
  return args.dedupeReads === false
    || args.refresh === true
    || args.full === true
    || args.budget === 'full';
}

function renderExploreReuse(receipt, format = 'markdown') {
  const data = {
    ok: true,
    reused: true,
    artifactId: receipt.artifactId || receipt.receiptId || null,
    message: 'This unchanged discovery was already returned earlier in the session; its summary was not replayed.',
  };
  if (format === 'json') return data;
  const artifact = receipt.artifactId || receipt.receiptId;
  return `# ContextOS explore (reused)\n- reused${artifact ? ` artifact=${artifact}` : ''}\n- Discovery replay suppressed; use dedupeReads:false or refresh:true for a fresh summary.`;
}

function recordExploreMemo(projectRoot, store, args, value, revision) {
  let artifact = null;
  try {
    artifact = storeArtifact(projectRoot, value, {
      kind: 'explore-discovery',
      metadata: { intent: args.intent || '', paths: args.paths || null, revision },
    });
  } catch (_) {}
  store.recordExploreReceipt({
    key: exploreMemoKey(args),
    revision,
    receiptId: artifact?.id || null,
    artifactId: artifact?.id || null,
  });
  return value;
}

/**
 * The OS-side orchestrator.
 *
 * The agent states an intent; the orchestrator picks and sequences the internal
 * capabilities itself, keeps every response inside a context budget, and records
 * a trace so the run stays debuggable.
 */
export class Orchestrator {
  constructor({ service, projectRoot, projectId, system = {} }) {
    this.service = service;
    this.projectRoot = projectRoot;
    this.projectId = projectId || service?.projectId || 'contextos';
    this.system = system;
    this.store = new SessionStore({ projectRoot: this.projectRoot, projectId: this.projectId });
    this.healed = null;
    this.healCompleted = false;
  }

  /**
   * The OS heals itself: a graph.json that diverged from SQLite used to wedge
   * every read/write entry point, which pushed agents back to reading whole
   * files by hand. Reconcile, then resolve the divergence before doing work.
   */
  async _selfHeal() {
    const { service } = this;
    if (!service || typeof service.osContext !== 'function') return;
    try {
      const graphDirty = typeof service.db?.isGraphDirty === 'function'
        ? service.db.isGraphDirty(this.projectId)
        : true;
      if (this.healCompleted && !graphDirty) return;
      await service.osContext({ action: 'reconcile' });
      if (typeof service.healStateConflict === 'function') {
        this.healed = service.healStateConflict();
      }
      this.healCompleted = true;
    } catch (_) {
      this.healed = null;
    }
  }

  _context(tracer, { turnMemo = new Map(), internal = false, actionEvidence = null } = {}) {
    return {
      service: this.service,
      caps: createCapabilities({ service: this.service, projectRoot: this.projectRoot, projectId: this.projectId }),
      store: this.store,
      tracer,
      profile: loadProfile(this.projectRoot),
      projectRoot: this.projectRoot,
      projectId: this.projectId,
      sessionId: tracer?.sessionId || null,
      turnMemo,
      internal,
      actionEvidence,
      // Pipeline children are internal work. Only the top-level host request
      // restores deferred Micro results, once, after its own action completes.
      orchestrator: {
        dispatch: (tool, input = {}, childActionEvidence = null) => this._dispatch(tool, input, {
          recoverMicroDeliveries: false,
          internal: true,
          turnMemo,
          actionEvidence: childActionEvidence,
        }),
      },
    };
  }

  async dispatch(tool, input = {}) {
    return this._dispatch(tool, input, {
      recoverMicroDeliveries: true,
      internal: false,
    });
  }

  async dispatchInternal(tool, input = {}) {
    return this._dispatch(tool, input, {
      recoverMicroDeliveries: false,
      internal: true,
    });
  }

  async _dispatch(tool, input = {}, { recoverMicroDeliveries = false, internal = false, turnMemo = null, actionEvidence = null } = {}) {
    await this._selfHeal();
    const seed = this.store.current || this.store.ensureSession(input.intent || input.summary || '');
    const route = routeKind(tool, input);
    // A command or source mutation may have changed a previously memoized
    // slice even when the caller did not go through the high-level `change`.
    // Invalidate durable read/search receipts before the operation so a failed
    // mutation cannot accidentally make a stale source look reusable.
    if (route === 'mutation'
      || tool === 'verify'
      || tool === 'ship'
      || (tool === 'ops' && ['run_command', 'process'].includes(input.capability))) {
      this.store.invalidateReadReceipts();
      this.store.invalidateSearchReceipts();
      this.store.invalidateSemanticReceipts();
      if (input.dryRun !== true && typeof this.store.resetReadPolicy === 'function') {
        this.store.resetReadPolicy();
      }
      if (turnMemo instanceof Map) turnMemo.clear();
    }
    const tracer = new Tracer({ projectRoot: this.projectRoot, sessionId: seed.id });
    const ctx = this._context(tracer, { turnMemo: turnMemo || new Map(), internal, actionEvidence });
    if (this.healed) tracer.step('heal', this.healed);
    const startedAt = Date.now();
    const routingHint = internal ? null : this._routingHint(seed.id, tool, input);
    const exploreRevision = tool === 'explore' && !isExplicitExploreReplay(input)
      ? workspaceFingerprint(this.projectRoot)
      : null;
    const exploreKey = exploreRevision ? exploreMemoKey(input) : null;
    const exploreReceipt = exploreKey
      ? this.store.findExploreReceipt({ key: exploreKey, revision: exploreRevision })
      : null;
    let deliveryClaims = [];
    let activeMicroReceiptIds = [];
    let deliveryWarning = null;
    let deliveryClaimsCompleted = false;
    const semanticMemo = tool === 'ops' ? semanticOpsMemoSpec(input) : null;
    const semanticReceipt = semanticMemo
      ? this.store.findSemanticReceipt({ key: semanticMemo.key })
      : null;
    const convergence = convergenceHint(this.projectRoot, seed.id, tool, input, semanticReceipt);
    const hostHint = [routingHint, convergence].filter(Boolean).join(' ') || null;
    const publishGraph = input.exportGraph === true
      || (tool === 'ship' && ctx.profile?.shipExportsGraph === true);
    try {
      if (recoverMicroDeliveries) {
        try {
          // Detect an exited worker once; terminal failures enter the report queue.
          const active = listMicroJobs(this.projectRoot, { status: 'running', limit: 100 });
          // A report generated by the current Micro call belongs to the next
          // host call; an earlier worker may finish during ordinary host work.
          if (!(tool === 'ops' && input.capability === 'micro')) activeMicroReceiptIds = active.map(job => job.jobId);
        } catch (error) {
          deliveryWarning = `Deferred Micro result recovery will retry on a later OS call: ${error.message}`;
        }
      }
      let result;
      if (semanticReceipt) {
        result = semanticOpsReuse(semanticMemo, semanticReceipt);
      } else {
        switch (tool) {
          case 'explore': {
            const baselineCommands = exploreBaselineCommands(input, ctx.profile);
            const inferredCommands = baselineCommands.length
              ? baselineCommands
              : (Array.isArray(ctx.profile?.verify) ? ctx.profile.verify.filter(Boolean) : []);
            if (!internal
              && !exploreReceipt
              && shouldAutoVerifyExplore(input, inferredCommands)
              && inferredCommands.length) {
              result = await pipelinePipeline(ctx, {
                steps: [
                  { tool: 'explore', args: { ...input, autoVerify: false } },
                  { tool: 'verify', args: { commands: inferredCommands } },
                ],
                continueOnFailure: true,
                decisionPackage: true,
                maxChars: RESPONSE_BUDGETS.pipelineDecision,
              });
            } else {
              result = exploreReceipt
                ? renderExploreReuse(exploreReceipt, input.format)
                : await explorePipeline(ctx, input);
            }
            break;
          }
          case 'inspect':
            result = await inspectPipeline(ctx, input);
            break;
          case 'change':
            result = await changePipeline(ctx, input);
            break;
          case 'integrate':
            result = await integratePipeline(ctx, input);
            break;
          case 'verify':
            result = await verifyPipeline(ctx, input);
            break;
          case 'ship':
            result = await shipPipeline(ctx, input);
            break;
          case 'agent': {
            // Pipeline-visible CLI delegation so dispatch, wait and integrate can
            // be chained in one call instead of costing a round each.
            const agentRoles = resolveMicroRoles(ctx.profile || {});
            const adapterName = input.adapter || agentRoles.agents?.default || null;
            const configured = adapterName ? agentRoles.agents?.adapters?.[adapterName] : null;
            if (!configured) throw new Error(`CLI adapter '${adapterName || '(none)'}' is not configured; set agents.default in the profile.`);
            result = await executeAgent(input, {
              projectRoot: ctx.projectRoot,
              adapter: configured.cli && typeof configured.cli === 'object' ? configured.cli : configured,
              name: adapterName,
              roles: agentRoles,
              onUsage: (row) => appendRoleUsage(ctx.projectRoot, {
                ...row,
                ...(process.env.CONTEXTOS_WORKER_MODE === '1' ? { parentTaskId: process.env.CONTEXTOS_MICRO_REPORT_JOB || null } : {}),
              }),
            });
            break;
          }
          case 'ops':
            result = await this._ops(ctx, input);
            break;
          case 'pipeline':
            result = await pipelinePipeline(ctx, input);
            break;
          case 'work':
            result = await workPipeline(ctx, input);
            break;
          default:
            throw new Error(`Unknown orchestrator tool '${tool}'`);
        }
        if (semanticMemo && !semanticReceipt && typeof result === 'string') {
          const rawHash = crypto.createHash('sha256').update(result).digest('hex');
          const artifactId = result.match(/artifact=([A-Za-z0-9._-]+)/)?.[1] || null;
          this.store.recordSemanticReceipt({
            key: semanticMemo.key,
            capability: semanticMemo.capability,
            action: semanticMemo.action,
            hash: rawHash,
            fullChars: result.length,
            artifactId,
          });
        }
      }
      if (tool === 'explore' && exploreRevision && !exploreReceipt && typeof result === 'string') {
        recordExploreMemo(this.projectRoot, this.store, input, result, exploreRevision);
      }
      if (recoverMicroDeliveries) {
        try { deliveryClaims = claimMicroDeliveries(this.projectRoot, { createdBefore: startedAt, activeReceiptIds: activeMicroReceiptIds }); }
        catch (error) { deliveryWarning = `Micro report recovery will retry: ${error.message}`; }
      }
      if (typeof result !== 'string') {
        const combined = attachRoutingHint(
          attachChildMessages(attachMicroDeliveryData(result, deliveryClaims, deliveryWarning)),
          hostHint
        );
        recordTelemetry(this.projectRoot, {
          sessionId: seed.id,
          tool,
          input,
          output: combined,
          internal,
          routeKind: route,
          durationMs: Date.now() - startedAt,
        });
        if (deliveryClaims.length) {
          completeMicroDeliveryClaims(this.projectRoot, deliveryClaims.map((item) => item.deliveryId));
          deliveryClaimsCompleted = true;
        }
        return combined;
      }
      const response = attachRoutingHint(
        result,
        hostHint
      );
      const decisionPackage = decisionPackageMetadata(tool, result);
      if (!internal && decisionPackage && typeof this.store.markDecisionPackage === 'function') {
        this.store.markDecisionPackage({
          tool,
          status: decisionPackage.status,
          decisionComplete: decisionPackage.decisionComplete === true,
          artifactId: decisionPackage.artifactId,
          receiptId: decisionPackage.receiptId,
        });
      }
      const responseArgs = input.args && typeof input.args === 'object' && !Array.isArray(input.args)
        ? input.args
        : {};
      const nestedRequests = nestedResponseRequests(input);
      const requestedMaxChars = nestedMaxChars(nestedRequests);
      const responseMaxChars = typeof input.maxChars === 'number'
        ? input.maxChars
        : (typeof responseArgs.maxChars === 'number'
            ? responseArgs.maxChars
            : (requestedMaxChars ?? undefined));
      const focusedWorkRead = tool === 'work' && (input.inspect !== undefined || input.read !== undefined)
        && responseMaxChars !== undefined
        && ![...MUTATION_INPUT_KEYS].some((key) => input[key] !== undefined);
      const explicitInspectWiden = tool === 'inspect' && responseMaxChars !== undefined;
      const receiptLogRecovery = tool === 'verify' && input.mode === 'logs' && responseMaxChars !== undefined;
      const failureSourceRecovery = tool === 'change' && /(?:^|\n)## Failure source\n/.test(response);
      const decisionPackageBudget = focusedWorkRead
        ? Math.min(responseMaxChars ?? RESPONSE_BUDGETS.pipelineDecision, INSPECT_RESPONSE_HARD_CAP)
        : receiptLogRecovery
        ? Math.min(responseMaxChars, 8000)
        : failureSourceRecovery
        ? Math.min(responseMaxChars ?? 4000, 4000)
        : explicitInspectWiden
        ? Math.min(responseMaxChars, INSPECT_RESPONSE_HARD_CAP)
        : (decisionPackage && responseMaxChars === undefined && tool !== 'work'
            ? RESPONSE_BUDGETS.pipelineDecision
            : responseMaxChars);
      const nestedFull = nestedFullRequest(nestedRequests);
      const allowWiden = input.allowWiden === true
        || responseArgs.allowWiden === true
        || nestedFull
        || explicitInspectWiden
        || receiptLogRecovery
        || failureSourceRecovery
        || focusedWorkRead
        || Boolean(decisionPackage);
      const full = input.full === true || input.budget === 'full' || input.mode === 'full'
        || responseArgs.full === true || responseArgs.budget === 'full'
        || nestedFull
        || (tool === 'ops' && responseArgs.format === 'json')
        || isJsonValueString(response);
      const finalized = finalizeResponse(response, {
        projectRoot: this.projectRoot,
        tool,
        maxChars: decisionPackageBudget,
        allowWiden,
        full,
        routingHint: isJsonValueString(response) ? null : hostHint,
      });
      const deliveredText = attachChildMessages(attachMicroDeliveryData(finalized.text, deliveryClaims, deliveryWarning));
      recordTelemetry(this.projectRoot, {
        sessionId: seed.id,
        tool,
        input,
        output: deliveredText,
        internal,
        routeKind: route,
        artifactId: finalized.meta.artifactId,
        truncated: finalized.meta.truncated,
        durationMs: Date.now() - startedAt,
      });
      if (deliveryClaims.length) {
        completeMicroDeliveryClaims(this.projectRoot, deliveryClaims.map((item) => item.deliveryId));
        deliveryClaimsCompleted = true;
      }
      return deliveredText;
    } catch (error) {
      if (deliveryClaims.length && !deliveryClaimsCompleted) {
        try {
          releaseMicroDeliveryClaims(this.projectRoot, deliveryClaims.map((item) => item.deliveryId));
        } catch (_) {}
      }
      throw error;
    } finally {
      // graph.json is a derived projection: publish once, at the boundary.
      try {
        if (publishGraph) {
          this.service?.syncEngine?.publishIfDirty(this.projectId, this.projectRoot);
        }
      } catch (_) {}
      tracer.flush();
    }
  }

  _routingHint(sessionId, tool, input = {}) {
    if (tool === 'ops' && input.capability === 'telemetry') return null;
    const host = summarizeTelemetry(this.projectRoot, {
      sessionId,
      scope: 'external',
      limit: 500,
    });
    const internal = summarizeTelemetry(this.projectRoot, {
      sessionId,
      scope: 'internal',
      limit: 500,
    });
    const counts = host.routeCounts || {};
    const discovery = Number(counts.discovery) || 0;
    const mutation = Number(counts.mutation) || 0;
    const verification = Number(counts.verification) || 0;
    if ([5, 9].includes(host.calls) && discovery >= 4 && mutation === 0 && verification === 0) {
      return 'Batch known reads in one bounded work/Pipeline call, then mutate or verify.';
    }
    if (host.calls >= 5 && internal.calls > Math.max(3, host.calls * 4)) {
      return 'Narrow Pipeline steps and reuse the existing artifact; do not repeat reads.';
    }
    return null;
  }

  async _ops(ctx, input = {}) {
    let { capability, action, args: nestedArgs = {}, projectRoot: _projectRoot, ...directArgs } = input;
    const requestedAction = action ?? nestedArgs.operation ?? directArgs.operation;
    if (!action && typeof requestedAction === 'string') action = requestedAction;
    // Accept the natural `ops({ action: "artifact.read", ... })` spelling as
    // well as the canonical capability/action pair. This avoids a full host
    // round spent discovering that a dot was the only schema difference.
    if (!capability && typeof action === 'string' && action.includes('.')) {
      const separator = action.indexOf('.');
      capability = action.slice(0, separator);
      action = action.slice(separator + 1);
    }
    if (capability === 'code' && !action) {
      const query = nestedArgs.query ?? directArgs.query;
      const path = nestedArgs.path ?? directArgs.path;
      if (!path && typeof query === 'string' && query.trim()) action = 'search';
    }
    if (capability === 'block' && ['get', 'inspect', 'show'].includes(action)) action = 'open';
    if (capability === 'chain' && ['get', 'inspect', 'show'].includes(action)) action = 'open';
    const args = {
      ...directArgs,
      ...(nestedArgs && typeof nestedArgs === 'object' && !Array.isArray(nestedArgs) ? nestedArgs : {}),
    };
    const { service, store, tracer } = ctx;
    tracer.step('ops', { capability, action });

    switch (capability) {
      case 'os_context':
        return render(await service.osContext({ ...args, action }));
      case 'plan':
        return render(await service.plan({ ...args, action }));
      case 'task':
        return render(await service.task({ ...args, action }));
      case 'architecture': {
        const architectureAction = action || 'list';
        if (architectureAction === 'bind_auto') {
          return render(await service.block({ ...args, action: 'bind_auto' }));
        }
        if (architectureAction === 'compose') {
          return render(await service.chain({ ...args, action: 'compose' }));
        }
        if (architectureAction === 'open' || architectureAction === 'get' || architectureAction === 'inspect') {
          const id = args.id || args.blockId || args.chainId;
          if (!id) throw new Error("architecture.open requires 'id' (or blockId/chainId).");
          try {
            return render({ block: await service.block({ action: 'open', id, format: 'json' }) });
          } catch (blockError) {
            try {
              return render({ chain: await service.chain({ action: 'open', id, format: 'json' }) });
            } catch (_) {
              throw new Error(`Architecture entity '${id}' was not found as a Block or Chain.`);
            }
          }
        }
        if (architectureAction === 'search') {
          const query = String(args.query || '').toLowerCase();
          const [blocks, chains] = await Promise.all([
            service.block({ action: 'search', query: args.query || '', format: 'json' }),
            service.chain({ action: 'list', format: 'json', includeMembers: false, limit: 25 }),
          ]);
          const chainItems = Array.isArray(chains?.items) ? chains.items : [];
          return render({
            blocks: Array.isArray(blocks) ? blocks : [],
            chains: chainItems.filter((chain) => (
              String(chain.id || '').toLowerCase().includes(query)
              || String(chain.title || '').toLowerCase().includes(query)
            )),
          });
        }
        if (architectureAction === 'list' || architectureAction === 'summary') {
          const [blocks, chains] = await Promise.all([
            service.block({
              action: 'list',
              format: 'json',
              includeRefs: args.includeRefs === true,
              limit: args.limit,
              offset: args.offset,
            }),
            service.chain({
              action: 'list',
              format: 'json',
              includeMembers: args.includeMembers === true,
              limit: args.limit,
              offset: args.offset,
            }),
          ]);
          return render({ blocks, chains });
        }
        throw new Error(`Unknown architecture action '${architectureAction}'. Available: list, open, search, bind_auto, compose`);
      }
      case 'block':
        return render(await service.block({ ...args, action }));
      case 'chain':
        return render(await service.chain({ ...args, action }));
      case 'code':
        if (action === 'help' || (!action && !args.path && !args.query)) {
          return [
            '# ContextOS code',
            '- Read: `ops({ capability: "code", action: "read", path, ranges })`.',
            '- Search: `ops({ capability: "code", action: "search", query, root|paths })`.',
            '- Mutate: prefer `change({ edits: [{ path, target|startLine+endLine, replacement }], verify })`.',
            '- Full-file edit: `change({ edits: [{ path, content, fullFile: true }], verify })`.',
          ].join('\n');
        }
        if (action === 'read' && args.dedupeReads !== false && !isExplicitReadReplay(args)) {
          const spec = codeReadMemoSpec(this.projectRoot, args);
          if (spec) {
            const prior = store.findLatestReadReceipt({
              path: spec.relativePath,
              range: spec.range,
              symbol: spec.symbol,
            });
            if (prior && readMemoStillValid(spec, prior)) {
              return render(renderReadReuse(spec, prior, args.format));
            }
          }
        }
        if (action === 'search' && args.dedupeReads !== false && !isExplicitReadReplay(args)) {
          const revision = workspaceFingerprint(this.projectRoot);
          if (revision) {
            const prior = store.findSearchReceipt({ key: searchMemoKey(args), revision });
            if (prior) return render(renderSearchReuse(prior, args.format));
          }
          const data = await service.code({ ...args, action });
          if (revision) recordSearchMemo(this.projectRoot, store, args, data, revision);
          return render(data);
        }
        {
          const data = await service.code({ ...args, action });
          if (action === 'read' && args.dedupeReads !== false && !isExplicitReadReplay(args)) {
            const spec = codeReadMemoSpec(this.projectRoot, args);
            if (spec?.stat) recordCodeReadMemo(this.projectRoot, store, args, data, spec);
          }
          return render(data);
        }
      case 'run_command': {
        const receipt = await service.runCommand(args);
        if (receipt && typeof receipt === 'object' && receipt.command) {
          store.attachReceipt(receipt);
        }
        return render(receipt);
      }
      case 'process':
        return render(await service.process({ ...args, action }));
      case 'knowledge':
        return render(await service.knowledge({ ...args, action }));
      case 'session': {
        if (action === 'note') return render(store.note(args.text, args.kind || 'note'));
        if (action === 'close') return render(store.close(args.summary || ''));
        if (action === 'history') {
          return render(store.recentHistory(args.limit, {
            sessionId: args.sessionId,
            full: args.full === true,
          }));
        }
        if (action === 'resume') {
          const session = store.current;
          if (!session) return render({ status: 'no-open-session' });
          const artifactId = args.artifact || args.artifactId || null;
          const receiptId = args.receipt || args.receiptId || null;
          if (artifactId || receiptId) {
            const diagnostic = {
              id: session.id,
              status: session.status,
            };
            if (artifactId) {
              const artifactStat = statArtifact(this.projectRoot, artifactId);
              if (isDecisionArtifactKind(artifactStat?.kind)) {
                const preview = compactPipelineArtifactPreview(this.projectRoot, artifactStat, 900);
                diagnostic.artifact = {
                  id: artifactId,
                  kind: artifactStat.kind,
                  preview: preview || 'Pipeline artifact is not previewable.',
                  truncated: true,
                  fullChars: artifactStat.contentChars || 0,
                  rawReplay: false,
                  hint: 'Resume returns a bounded decision preview. Use ops artifact.read full:true only for an intentional audit.',
                };
              } else {
                const artifact = readArtifact(this.projectRoot, artifactId, {
                  maxChars: Math.min(Math.max(Number(args.maxChars) || 1800, 200), 4000),
                });
                diagnostic.artifact = artifact
                  ? {
                      id: artifact.id,
                      kind: artifact.kind || null,
                      text: artifact.text,
                      truncated: artifact.truncated,
                      fullChars: artifact.contentChars || artifact.text.length,
                    }
                  : { id: artifactId, error: 'not-found' };
              }
            }
            if (receiptId) {
              diagnostic.receipt = readReceiptLogExcerpt(this.projectRoot, receiptId, {
                maxChars: Math.min(Math.max(Number(args.maxChars) || 1800, 200), 4000),
              });
            }
            return render(diagnostic);
          }
          return render({
            id: session.id,
            status: session.status,
            intent: session.intent || null,
            files: (session.touchedFiles || []).slice(-8).map((entry) => entry.path),
            receipts: (session.receipts || []).slice(-3).map((receipt) => ({
              command: receipt.command,
              exitCode: receipt.exitCode,
              status: receipt.status,
            })),
            notes: (session.notes || []).slice(-3).map((entry) => entry.text),
          });
        }
        if (action === 'status' || args.full !== true) return render(store.summary());
        return render(store.current || { status: 'no-open-session' });
      }
      case 'profile': {
        if (action === 'set') {
          const { scope, values, ...patch } = args;
          return render(redactProfileSecrets(saveProfile(this.projectRoot, applyDottedProfileValues(patch, values), { scope })));
        }
        return render(redactProfileSecrets(loadProfile(this.projectRoot)));
      }
      case 'artifact': {
        if (action === 'read' || action === 'get' || action === 'open') {
          const artifactId = args.id || args.artifactId || args.artifact;
          const artifactStat = statArtifact(this.projectRoot, artifactId);
          const decisionArtifact = isDecisionArtifactKind(artifactStat?.kind);
          const auditReason = typeof args.auditReason === 'string' ? args.auditReason.trim() : '';
          const rawPipelineRequested = args.allowRawPipeline === true;
          const allowRawPipeline = rawPipelineRequested && auditReason.length > 0;
          // Decision artifacts are bounded transport packets, not source files.
          // A `full:true` request must not replay the transcript they replaced.
          const fullArtifact = (args.full === true || args.budget === 'full')
            && (!decisionArtifact || allowRawPipeline);
          const requestedArtifactChars = Number(args.maxChars);
          const artifactReadArgs = {
            ...args,
            id: artifactId,
            maxChars: fullArtifact
              ? Infinity
              : (Number.isFinite(requestedArtifactChars) && requestedArtifactChars > 0
                  ? Math.min(Math.floor(requestedArtifactChars), 1400)
                  : 1400),
          };
          const artifact = readArtifact(this.projectRoot, artifactId, artifactReadArgs);
          if (!artifact) return `# ContextOS artifact\n- Not found: \`${artifactId || '(missing)'}\``;
          const canPreviewDecision = decisionArtifact
            && !allowRawPipeline
            && !args.grep
            && args.startLine === undefined
            && args.endLine === undefined;
          if (canPreviewDecision) {
            const preview = compactPipelineArtifactPreview(this.projectRoot, artifactStat, 1400);
            if (preview) {
              return [
                `# ContextOS artifact ${artifact.id}`,
                `- Decision artifact preview (${artifactStat.kind}); fullChars=${artifactStat.contentChars}.`,
                '- Next: use `change`/`work` directly; raw replay requires `allowRawPipeline:true` plus a non-empty `auditReason` for an intentional audit.',
                '',
                '```text',
                preview,
                '```',
              ].join('\n');
            }
          }
          return [
            `# ContextOS artifact ${artifact.id}`,
            `- Range: L${artifact.range.startLine}-L${artifact.range.endLine} (${artifact.returnedLines}/${artifact.totalLines} lines)`,
            `- Truncated: ${artifact.truncated}`,
            '',
            '```text',
            artifact.text,
            '```',
          ].join('\n');
        }
        if (action === 'stat') return render(statArtifact(this.projectRoot, args.id) || { ok: false, id: args.id, error: 'not-found' });
        if (action === 'list') return render(listArtifacts(this.projectRoot, { limit: args.limit || 20 }));
        if (action === 'evict') {
          // Accept both the documented flat policy and a nested `policy`
          // object. Unknown nesting used to be silently ignored, producing a
          // successful-looking no-op when an agent tried to apply retention.
          const nestedPolicy = args.policy && typeof args.policy === 'object' ? args.policy : {};
          const result = evictArtifacts(this.projectRoot, { ...nestedPolicy, ...args });
          return render({
            ok: true,
            requested: result.requested || [],
            evicted: result.evicted || [],
            notFound: result.notFound || [],
            remainingCount: Array.isArray(result.entries) ? result.entries.length : 0,
            totalBytes: result.totalBytes || 0,
          });
        }
        throw new Error(`Unknown artifact action '${action}'. Available: read, get, open, stat, list, evict`);
      }
      case 'usage': {
        if (action === 'record') {
          const receipt = await appendRoleUsage(this.projectRoot, { role: 'main', ...args });
          return render(receipt);
        }
        if (!action || action === 'report' || action === 'summary') {
          const { rows, ledgerPath } = await readRoleUsage(this.projectRoot);
          return render({
            ledgerPath: path.relative(this.projectRoot, ledgerPath).split(path.sep).join('/'),
            ...summarizeRoleUsage(rows),
          });
        }
        throw new Error(`Unknown usage action '${action}'. Available: record, report`);
      }
      case 'telemetry': {
        if (action === 'audit') {
          return render(auditRouting(this.projectRoot, {
            sessionId: args.sessionId,
            baselineSessionId: args.baselineSessionId,
            limit: args.limit,
          }));
        }
        if (action === 'compare') {
          return render(compareTelemetry(this.projectRoot, {
            leftSessionId: args.leftSessionId,
            rightSessionId: args.rightSessionId,
            leftRolloutPath: args.leftRolloutPath,
            rightRolloutPath: args.rightRolloutPath,
            limit: args.limit,
            scope: args.scope || 'external',
          }));
        }
        if (action === 'rollout') {
          return render(parseRolloutTelemetry(
            { paths: args.paths },
            { projectRoot: this.projectRoot }
          ));
        }
        if (action === 'summary' || action === undefined) {
          const telemetrySessionId = args.sessionId || store.current?.id || null;
          return render({
            ...summarizeTelemetry(this.projectRoot, {
              sessionId: telemetrySessionId,
              limit: args.limit,
              scope: args.scope || 'external',
            }),
            microProvider: summarizeMicroUsage(this.projectRoot, {
              limit: args.limit,
              hostSessionId: telemetrySessionId,
            }),
          });
        }
        if (action === 'list') {
          const telemetrySessionId = args.sessionId || null;
          return render({
            ...summarizeTelemetry(this.projectRoot, {
              sessionId: telemetrySessionId,
              limit: args.limit,
              scope: args.scope || 'external',
            }),
            microProvider: summarizeMicroUsage(this.projectRoot, {
              limit: args.limit,
              hostSessionId: telemetrySessionId,
            }),
          });
        }
        throw new Error(`Unknown telemetry action '${action}'. Available: summary, list, compare, audit, rollout`);
      }
      case 'micro': {
        const requestedMicroAction = String(action ?? 'run').trim().toLowerCase() || 'run';
        if (!MICRO_ACTION_SET.has(requestedMicroAction)) {
          throw new Error(`Unsupported micro action '${action}'. Supported actions: ${MICRO_ACTION_NAMES.join(', ')}.`);
        }
        action = requestedMicroAction;
        if (action === 'session' && !args.sessionAction) {
          throw new Error('Micro action session requires sessionAction. Available: create, send, continue, resume, get, list, close, delete.');
        }
        if ((action === 'continue' || action === 'resume') && !args.sessionAction) {
          args.sessionAction = 'send';
        }
        if (action === 'send' && !args.sessionAction) {
          if (process.env.CONTEXTOS_WORKER_MODE === '1') throw new Error('Child tasks cannot message other jobs.');
          return render({ ok: true, ...sendMicroMessage(this.projectRoot, args.jobId, args.message) });
        }
        if (action === 'messages') {
          const worker = process.env.CONTEXTOS_WORKER_MODE === '1';
          if (worker && args.jobId !== process.env.CONTEXTOS_MICRO_REPORT_JOB) throw new Error('Message job must match the assigned job.');
          const root = worker ? process.env.CONTEXTOS_MICRO_REPORT_ROOT : this.projectRoot;
          if (!root) throw new Error('No assigned message channel.');
          return render({ ok: true, jobId: args.jobId, messages: await waitForMicroMessages(root, args.jobId, { waitMs: args.waitMs }) });
        }
        if (action === 'report') {
          const worker = process.env.CONTEXTOS_WORKER_MODE === '1';
          if (worker && args.jobId !== process.env.CONTEXTOS_MICRO_REPORT_JOB) throw new Error('Report job must match the assigned job.');
          const root = worker ? process.env.CONTEXTOS_MICRO_REPORT_ROOT : this.projectRoot;
          if (!root) throw new Error('No assigned report channel.');
          return render({ ok: true, ...reportMicroJob(root, args.jobId, args.content) });
        }
        if (action === 'get') {
          const job = readMicroJob(this.projectRoot, args.jobId);
          return render({ ok: Boolean(job), job: args.full ? job : compactMicroJob(job) });
        }
        if (action === 'list') {
          return render({
            ok: true,
            jobs: listMicroJobs(this.projectRoot, { ...args, excludeAgentJobs: true }).map(compactMicroJob),
          });
        }
        if (action === 'cancel') {
          const job = readMicroJob(this.projectRoot, args.jobId);
          const controller = backgroundMicroControllers.get(backgroundKey(this.projectRoot, args.jobId));
          if (controller) controller.abort();
          return render({ ok: Boolean(job), jobId: args.jobId, status: job?.status || 'missing', cancellationRequested: Boolean(controller) });
        }
        let microConfig = ctx.profile?.micro || {};
        if (action === 'help' || action === 'schema') {
          return render({
            ok: true,
            local: true,
            capability: 'micro',
            actions: ['doctor', 'run', 'batch', 'get', 'list', 'cancel', 'report', 'send', 'messages'],
            background: { enabled: true, defaultDelivery: 'auto', materialReports: true, delivery: ['auto', 'defer', 'errors-only'], reportOn: 'next top-level OS response', pollingRequired: false },
            sessionActions: ['create', 'send', 'continue', 'resume', 'get', 'list', 'close', 'delete'],
            executor: {
              withOS: true,
              invocation: {
                tools: { enabled: true, allowCommands: true },
                provider: { maxRequests: 5 },
              },
            },
            note: 'Micro help is resolved locally and never calls the provider.',
          });
        }
        if (action === 'doctor') {
          const roles = resolveMicroRoles(ctx.profile || {});
          const requestedRole = args.role ? String(args.role).toLowerCase() : null;
          const cliSelected = requestedRole === 'cli' || requestedRole === 'adapter' || (!requestedRole && Boolean(args.adapter));
          if (requestedRole && !['api', 'cli', 'adapter'].includes(requestedRole)) {
            return render({ ok: false, status: 'invalid-role', errorCode: 'MICRO_DOCTOR_ROLE_INVALID', error: 'Choose role api or cli.' });
          }
          if (requestedRole === 'api' && args.adapter) {
            return render({ ok: false, status: 'invalid-role', errorCode: 'MICRO_DOCTOR_ROLE_CONFLICT', error: 'An adapter can only be checked with role cli.' });
          }

          if (cliSelected) {
            const adapterName = args.adapter || roles.agents?.default;
            const adapter = adapterName ? roles.agents?.adapters?.[adapterName] : null;
            if (!adapter || typeof adapter !== 'object') {
              return render({
                ok: false,
                status: 'unconfigured',
                role: 'cli-agent',
                errorCode: 'CLI_ADAPTER_NOT_CONFIGURED',
                error: adapterName ? `CLI adapter '${adapterName}' is not configured.` : 'No CLI adapter is selected.',
                checks: [{ name: 'adapter', ok: false, value: adapterName || null }],
                note: 'API Micro is a separate role; this explicit CLI check never falls back to API.',
              });
            }
            const cli = adapter.cli && typeof adapter.cli === 'object' ? adapter.cli : adapter;
            const model = adapter.model || cli.model || args.model || null;
            const report = cliDoctor({ model, cli });
            report.role = 'cli-agent';
            report.adapter = adapterName;
            report.routing = { provider: 'cli', reason: 'explicit CLI role/adapter selection' };
            report.status = report.ok ? 'configured-unverified' : 'misconfigured';
            if (report.ok && args.probe === true) {
              const result = await runMicroTask({ model, cli }, {
                provider: 'cli',
                projectRoot: this.projectRoot,
                prompt: 'Reply with exactly PONG. No tools are needed.',
                timeoutMs: args.timeoutMs || 60000,
              });
              const projected = projectMicroResult(result, { projectRoot: this.projectRoot, hostSessionId: ctx.sessionId, maxChars: 200 });
              const check = { name: 'connectivity', ok: projected.ok === true && String(projected.content || '').trim() === 'PONG', value: projected.error || projected.content, receiptId: projected.receiptId };
              report.checks.push(check);
              report.status = check.ok ? 'probe-passed' : 'probe-failed';
              report.ok = check.ok;
              report.taskModes = { analyze: null, implement: null };
            } else if (report.ok) report.ok = null;
            return render(report);
          }

          const api = roles.micro || {};
          const endpoint = api.baseUrl || api.url || null;
          const model = api.model || null;
          const credentialConfigured = Boolean(api.apiKey || api.key || api.keyEnv);
          const provider = api.provider || api.vendor || (/^deepseek-/i.test(String(model || '')) ? 'deepseek' : null);
          const requestedThinkingValue = api.thinking ?? api.effort ?? null;
          const requestedThinking = typeof requestedThinkingValue === 'object' && requestedThinkingValue
            ? requestedThinkingValue.effort ?? requestedThinkingValue.level ?? requestedThinkingValue.mode ?? null
            : requestedThinkingValue;
          const transport = /\/responses\/?$/i.test(String(endpoint || '')) || ['responses', 'response'].includes(String(api.transport || api.protocol || '').toLowerCase())
            ? 'responses' : 'chat';
          const deepseek = String(provider || '').toLowerCase() === 'deepseek' || /^deepseek-/i.test(String(model || ''));
          const deepseekMap = { off: 'none', none: 'none', minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'high', max: 'max', ultra: 'max' };
          const configuredMap = api.thinkingMap?.[transport] || {};
          const normalizedThinking = String(requestedThinking || '').toLowerCase();
          const mappedThinking = deepseek ? (deepseekMap[normalizedThinking] || null) : (configuredMap[normalizedThinking] || null);
          const supportedThinking = deepseek ? ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
            : Object.entries(configuredMap).filter(([, value]) => value !== null && value !== false).map(([level]) => level).sort();
          const requestLimits = {
            maxTransportInvocations: api.budget?.maxTransportInvocations ?? null,
            maxToolCalls: api.budget?.maxToolCalls ?? null,
            maxEvidenceBytes: api.budget?.maxEvidenceBytes ?? null,
            maxOutputTokens: api.maxOutputTokens ?? null,
            timeoutMs: api.timeoutMs ?? null,
          };
          const requestLimitsComplete = Object.values(requestLimits).every((value) => Number.isSafeInteger(value) && value > 0);
          const requestLimitsInvalid = Object.values(requestLimits).some((value) => value !== null && (!Number.isSafeInteger(value) || value < 1));
          const report = {
            ok: null,
            status: endpoint && model ? 'configured-unverified' : 'unconfigured',
            role: 'api-micro',
            provider: provider || 'api',
            routing: { provider: 'api', reason: 'API Micro is the default evidence role; CLI agents are a separate optional role' },
            checks: [
              { name: 'endpoint', ok: Boolean(endpoint), value: endpoint ? 'configured (value hidden)' : 'not configured' },
              { name: 'configured_model', ok: Boolean(model), value: model },
              { name: 'credential_source', ok: credentialConfigured ? true : null, value: credentialConfigured ? 'configured (secret hidden)' : 'unknown/not configured; unauthenticated endpoints may be valid' },
              { name: 'authentication', ok: null, value: 'unknown; not probed' },
              { name: 'thinking', ok: requestedThinking ? (mappedThinking ? true : null) : null, value: { requested: requestedThinking || null, mapped: mappedThinking, supported: supportedThinking.length ? supportedThinking : null } },
              { name: 'request_limits', ok: requestLimitsInvalid ? false : (requestLimitsComplete ? true : null), value: requestLimits },
              { name: 'task_analyze', ok: null, value: 'unknown; text connectivity does not verify analyze task quality' },
              { name: 'task_implement', ok: null, value: 'unknown; requires a separate isolated implementation smoke' },
            ],
            globalProfile: globalProfilePath(),
            projectProfile: `${this.projectRoot}/.contextos/profile.json`,
            note: 'No provider call is made by default. Use probe:true only for one explicit bounded text-connectivity request; that does not certify analyze or implement readiness.',
          };
          if (args.probe === true && endpoint && model) {
            const transportResult = await createEvidenceTransport(api)({
              system: 'This is a bounded API connectivity check. Do not call tools or expose secrets.',
              input: 'Reply with exactly PONG.',
              thinking: requestedThinking || undefined,
              signal: args.signal,
            });
            const connected = transportResult.ok === true && String(transportResult.summary || '').trim() === 'PONG';
            report.checks.push({ name: 'connectivity', ok: connected, value: connected ? 'PONG' : (transportResult.error || transportResult.summary || 'provider did not return exact PONG') });
            if (credentialConfigured) report.checks.find((check) => check.name === 'authentication').ok = transportResult.ok === true ? true : false;
            report.checks.push({ name: 'actual_model', ok: transportResult.model ? transportResult.model === model : null, value: { requested: model, actual: transportResult.model } });
            report.ok = connected;
            report.status = connected ? 'probe-passed' : 'probe-failed';
            report.usage = transportResult.usage;
            report.providerLaunches = transportResult.invocation?.providerLaunches ?? null;
          }
          return render(report);
        }
        const microWithOS = shouldEnableMicroOS(args);
        const caps = microWithOS ? ctx.caps : null;

        if (args.sessionAction) {
          const requestedSessionAction = String(args.sessionAction).toLowerCase();
          const sessionAction = requestedSessionAction === 'continue' || requestedSessionAction === 'resume'
            ? 'send'
            : requestedSessionAction;
          if (sessionAction === 'send' && !String(args.firstTask ?? args.task ?? args.prompt ?? '').trim()) {
            args.task = 'Continue the previous task from its partial state.';
          }
          const sessionId = args.sessionId;
          if (sessionAction === 'create') {
            let existing = null;
            if (sessionId) {
              try {
                existing = readMicroSession(this.projectRoot, sessionId);
              } catch (error) {
                if (!/not found/i.test(error.message)) throw error;
              }
            }
            if (existing) return render({ ok: true, existing: true, session: microSessionSnapshot(existing) });
            if (args.runFirst === true && !String(args.firstTask ?? args.task ?? args.prompt ?? '').trim()) {
              throw new Error('Micro session runFirst requires a non-empty task, firstTask, or prompt.');
            }
            const preloadSpec = microPreloadSpec(args);
            const preload = preloadSpec ? await runTaskMicroPreload(ctx, preloadSpec, args) : null;
            // Do not persist a poisoned session. A failed or truncated preload
            // is a complete create-turn failure; making the host call `send`
            // just to rediscover the same error creates a dirty extra round.
            if (preload && preload.ok === false) {
              const projected = projectMicroResult(microPreloadFailure(preload, args.delivery), {
                projectRoot: this.projectRoot,
                hostSessionId: ctx.sessionId,
                full: args.full === true,
                maxChars: args.maxChars,
              });
              return render({
                ...projected,
                preload: microPreloadReceipt(preload),
                hint: 'Narrow the attached Pipeline steps or maxChars, then create the session again.',
              });
            }
            const session = createMicroSession(this.projectRoot, {
              ...args,
              withOS: microWithOS,
              preload,
            });
            if (args.runFirst === true) {
              const firstTurn = await runMicroSessionTurn(ctx, args, session);
              return render({
                ...firstTurn,
                created: true,
                ...(preload ? { preload: microPreloadReceipt(preload) } : {}),
              });
            }
            return render({
              ok: true,
              session: microSessionSnapshot(session),
              ...(preload ? { preload: microPreloadReceipt(preload) } : {}),
            });
          }
          if (sessionAction === 'list') {
            return render({
              ok: true,
              sessions: listMicroSessions(this.projectRoot, {
                limit: args.limit,
                offset: args.offset,
              }),
            });
          }
          if (sessionAction === 'get') {
            return render({ ok: true, session: microSessionSnapshot(readMicroSession(this.projectRoot, sessionId)) });
          }
          if (sessionAction === 'close') {
            return render({ ok: true, session: closeMicroSession(this.projectRoot, sessionId) });
          }
          if (sessionAction === 'delete') {
            return render({ ok: true, deleted: deleteMicroSession(this.projectRoot, sessionId), sessionId: String(sessionId || '') });
          }
          if (sessionAction === 'send') {
            const session = readMicroSession(this.projectRoot, sessionId);
            const result = await runMicroSessionTurn(ctx, args, session);
            return render(result);
          }
          throw new Error(`Unknown micro sessionAction '${sessionAction}'. Available: create, send, continue, resume, get, list, close, delete`);
        }

        if (action === 'batch') {
          const taskInputs = Array.isArray(args.tasks) ? args.tasks : [];
          const batchConcurrency = normalizeMicroBatchConcurrency(args.maxConcurrency);
          // Read evidence after obtaining the provider's workspace reservation.
          // Otherwise queued writers can receive source from before an earlier edit.
          const tasks = await mapWithConcurrency(taskInputs, batchConcurrency, async (task, index) => {
            const preloadSpec = microPreloadSpec(task);
            return {
              ...task,
              id: task.id || `task-${index + 1}`,
              withOS: shouldEnableMicroOS({ ...args, ...task }),
              preparePreload: preloadSpec ? () => runTaskMicroPreload(ctx, preloadSpec, { ...args, ...task }) : undefined,
            };
          });
          const batchNeedsCaps = tasks.some((task) => Boolean(task.withOS));
          const runnableTasks = tasks.filter((task) => !task.preload || task.preload.ok !== false);
          const { tasks: _taskInputs, maxConcurrency: _requestedConcurrency, ...batchDefaults } = args;
          if (args.background === true) return render({ ok: tasks.every((task) => task.preload?.ok !== false), tasks: tasks.map((task) => task.preload?.ok === false
            ? { id: task.id, ...microPreloadFailure(task.preload, task.delivery) }
            : { id: task.id, ...startBackgroundMicroRun(ctx, { args: { ...batchDefaults, ...task, jobId: task.jobId, maxConcurrency: batchConcurrency }, microConfig, preload: task.preload, action: 'run', effectiveWithOS: task.withOS }) }) });
          const result = await runMicroTasksParallel(microConfig, runnableTasks, { ...batchDefaults, batch: true, maxConcurrency: batchConcurrency, withOS: microWithOS, outputMode: args.full ? 'full' : 'answer', caps: batchNeedsCaps ? ctx.caps : null, orchestrator: ctx.orchestrator, projectRoot: this.projectRoot });
          const resultById = new Map((result.tasks || []).map((task, index) => [String(task.id || `task-${index + 1}`), task]));
          return render({
            ok: tasks.every((task) => task.preload?.ok === false ? false : resultById.get(String(task.id))?.ok !== false),
            totalDurationMs: result.totalDurationMs,
            tasks: tasks.map((task, index) => {
              const id = String(task.id);
              const rawResult = task.preload?.ok === false
                ? microPreloadFailure(task.preload, task.delivery)
                : (resultById.get(id) || { ok: false, error: `Micro batch task '${id}' did not return a result.` });
              return {
                id,
                ...projectMicroResult(rawResult, {
                  projectRoot: this.projectRoot,
                  hostSessionId: ctx.sessionId,
                  full: args.full === true,
                  maxChars: args.maxChars,
                }),
                ...(rawResult.preload ? { preload: rawResult.preload } : {}),
              };
            }),
          });
        }
        const preloadSpec = microPreloadSpec(args);
        const preload = null;
        const taskArgs = { ...args, ...(preloadSpec ? {preparePreload: () => runTaskMicroPreload(ctx, preloadSpec, args)} : {}) };
        const effectiveWithOS = microWithOS;
        if (args.background === true) {
          return render(startBackgroundMicroRun(ctx, {
            args: taskArgs,
            microConfig,
            preload,
            action,
            effectiveWithOS,
          }));
        }
        const result = await runMicroTask(microConfig, { ...taskArgs, preload, action, withOS: effectiveWithOS, outputMode: args.full ? 'full' : 'answer', caps: effectiveWithOS ? ctx.caps : null, orchestrator: ctx.orchestrator, projectRoot: this.projectRoot });
        const projected = projectMicroResult(result, {
          projectRoot: this.projectRoot,
          hostSessionId: ctx.sessionId,
          full: args.full === true,
          maxChars: args.maxChars,
        });
        const retained = retainContinuableMicroSession(ctx, taskArgs, result, projected, { withOS: effectiveWithOS });
        return render({
          ...projected,
          ...(retained || {}),
          ...(result.preload ? { preload: result.preload } : {}),
        });
      }
      case 'system': {
        const fn = this.system[action];
        if (!fn) {
          throw new Error(`Unknown system action '${action}'. Available: ${Object.keys(this.system).join(', ')}`);
        }
        return render(await fn({ projectRoot: this.projectRoot, ...args }));
      }
      default:
        throw new Error(`Unknown capability '${capability}'. Available: ${OPS_CAPABILITIES.join(', ')}`);
    }
  }
}
