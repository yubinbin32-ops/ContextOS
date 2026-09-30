import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runMicroTask } from './micro-client.mjs';
import { hasAgentReportContent, normalizeAgentReport } from './micro-agent-report.mjs';
import { createMicroJob, updateMicroJob, readMicroJob, listMicroJobs, enqueueMicroDelivery, reportMicroJob } from './micro-delivery.mjs';
import { sendMicroMessage, receiveMicroMessages, waitForMicroMessages } from './micro-mailbox.mjs';

const active = new Map();
const key = (root, id) => `${root}\0${id}`;
const compactJob = (job) => {
  if (!job) return {
    status: 'missing',
    mailbox: { canSend: false, waitingForHost: false, needsHostReason: 'none' },
  };
  const report = job.report
    ? normalizeAgentReport(job.report, {
        jobId: job.jobId,
        status: job.status,
        answeredQuestions: Array.isArray(job.answeredQuestions) ? job.answeredQuestions : [],
        cliUsage: job.cliUsage,
      })
    : null;
  const needsHostReason = report?.needsHostReason || (report?.needsHost ? 'reported' : 'none');
  return {
    id: job.jobId,
    status: job.status,
    report,
    mailbox: {
      canSend: job.status === 'running',
      waitingForHost: report?.waitingForHost === true,
      needsHostReason,
    },
    ...(job.cliSessionId ? { cliSessionId: job.cliSessionId } : {}),
    ...(job.deniedActions ? { deniedActions: job.deniedActions } : {}),
    ...(job.error ? { missing: [job.error] } : {}),
    ...(job.usageAccounting ? { usageAccounting: job.usageAccounting } : {}),
    ...(job.deliveryAccounting ? { deliveryAccounting: job.deliveryAccounting } : {}),
    ...(job.executionAccounting ? { executionAccounting: job.executionAccounting } : {}),
  };
};

function resultFromError(error) {
  const partialResult = error?.result && typeof error.result === 'object' && !Array.isArray(error.result)
    ? error.result : {};
  return {
    ...partialResult,
    ok: false,
    error: partialResult.error || error?.message || String(error),
    providerUsage: partialResult.providerUsage ?? partialResult.usage ?? error?.providerUsage ?? error?.usage ?? null,
    usageRaw: partialResult.usageRaw ?? error?.usageRaw ?? null,
    providerUsageComplete: partialResult.providerUsageComplete ?? error?.providerUsageComplete ?? null,
    providerLaunches: partialResult.providerLaunches ?? error?.providerLaunches,
    invocation: partialResult.invocation ?? error?.invocation ?? null,
    actualModel: partialResult.actualModel ?? error?.actualModel ?? null,
    requestedModel: partialResult.requestedModel ?? error?.requestedModel ?? null,
    contextUsage: partialResult.contextUsage ?? error?.contextUsage ?? null,
  };
}

function pathValue(value, dottedPath) {
  if (typeof dottedPath !== 'string' || !dottedPath) return null;
  return dottedPath.split('.').filter(Boolean).reduce((current, key) => current?.[key], value) ?? null;
}

function usageNumber(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function cliUsageEvidence(result, adapter) {
  const raw = result?.usageRaw ?? null;
  // Role adapters are stored flat (`output.usage`); legacy Micro config nests
  // the same CLI fields under `cli.output.usage`. Support both shapes because
  // runMicroTask returns the raw terminal usage regardless of which role shape
  // selected the adapter.
  const mapping = adapter?.output?.usage ?? adapter?.cli?.output?.usage;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !mapping || typeof mapping !== 'object') {
    return {
      usage: null,
      providerReportedUsage: raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null,
      providerReportedTotalTokens: null,
      usageMapping: mapping || null,
      unmappedProviderUsage: result?.providerUsage ?? result?.usage ?? null,
    };
  }
  const input = usageNumber(pathValue(raw, mapping.input));
  const output = usageNumber(pathValue(raw, mapping.output));
  const cached = mapping.cache ? usageNumber(pathValue(raw, mapping.cache)) : null;
  const reasoning = mapping.reasoning ? usageNumber(pathValue(raw, mapping.reasoning)) : null;
  const reportedTotal = mapping.total ? usageNumber(pathValue(raw, mapping.total)) : null;
  // A resumed session reports cumulative provider usage. runMicroTask already
  // converted it to this invocation's delta; recomputing from the cumulative
  // raw usage would bill the earlier session again.
  const delta = result?.usage && typeof result.usage === 'object' && !Array.isArray(result.usage)
    ? result.usage : null;
  if (delta && Object.values(delta).some((value) => Number.isFinite(value))) {
    return {
      // runMicroTask returns the provider-shaped delta (snake_case); the ledger
      // contract is camelCase, so map it here instead of dropping metrics.
      usage: {
        inputTokens: delta.inputTokens ?? delta.prompt_tokens ?? null,
        cachedInputTokens: delta.cachedInputTokens ?? delta.cached_input_tokens ?? null,
        uncachedInputTokens: delta.uncachedInputTokens ?? delta.uncached_input_tokens ?? null,
        outputTokens: delta.outputTokens ?? delta.completion_tokens ?? null,
        reasoningTokens: delta.reasoningTokens ?? delta.reasoning_tokens ?? null,
        // The provider total includes cache reads and is not a delta; leave it
        // for providerReportedTotalTokens instead of contradicting the ledger.
        reportedTotalTokens: null,
      },
      providerReportedUsage: raw,
      providerReportedTotalTokens: reportedTotal,
      usageMapping: mapping,
    };
  }
  let inputTokens = null;
  let uncachedInputTokens = null;
  if (input !== null && mapping.inputIncludesCache === true) {
    inputTokens = input;
    if (cached !== null && cached <= input) uncachedInputTokens = input - cached;
  } else if (input !== null && mapping.inputIncludesCache === false) {
    uncachedInputTokens = input;
    // The provider reports uncached input only; the ledger wants total input.
    inputTokens = input + (cached ?? 0);
  }
  let outputTokens = output;
  if (output !== null && mapping.reasoning && mapping.reasoningIncludedInOutput === false) {
    outputTokens = reasoning === null ? null : output + reasoning;
  }
  return {
    usage: {
      inputTokens,
      cachedInputTokens: cached,
      uncachedInputTokens,
      outputTokens,
      reasoningTokens: reasoning,
      reportedTotalTokens: reportedTotal,
    },
    providerReportedUsage: raw,
    providerReportedTotalTokens: reportedTotal,
    usageMapping: mapping,
  };
}

function usageGap(reason) {
  return { status: 'gap', reason, evidencePersistedInJob: true };
}

function cliUsageSummary(contextUsage) {
  if (!contextUsage || typeof contextUsage !== 'object' || Array.isArray(contextUsage)) return null;
  if (contextUsage.percent === null || contextUsage.percent === undefined || (typeof contextUsage.percent === 'string' && !contextUsage.percent.trim())) return null;
  const percent = Number(contextUsage.percent);
  if (!Number.isFinite(percent) || percent < 0) return null;
  return {
    percent: Math.round(percent * 10) / 10,
    usedTokens: usageNumber(contextUsage.usedTokens),
    windowTokens: usageNumber(contextUsage.windowTokens),
    source: contextUsage.source === 'provider' ? 'provider' : 'derived',
  };
}

function deniedActionText(value) {
  if (!Array.isArray(value) || !value.length) return null;
  const detail = value.slice(0, 3).map((item) => {
    const text = typeof item === 'string' ? item : JSON.stringify(item);
    return text.length > 240 ? `${text.slice(0, 240)}...` : text;
  }).join(', ');
  return detail ? `Permission denied: ${detail}` : null;
}

function cliProviderName(adapter, resultProvider = null) {
  if (typeof resultProvider === 'string' && resultProvider !== 'cli') return resultProvider;
  const configured = adapter?.provider || adapter?.transport || adapter?.name || adapter?.command;
  if (Array.isArray(configured)) return typeof configured[0] === 'string' && configured[0].trim() ? configured[0] : 'cli';
  return typeof configured === 'string' && configured.trim() ? configured : 'cli';
}

export async function executeAgent(args, { projectRoot, adapter, name, roles, runner = runMicroTask, onUsage, signal, workerEntry } = {}) {
  const action = args.action || 'run';
  const jobId = args.jobId || args.id;
  const workerResume = args.workerResume === true;
  if (workerResume) {
    if (action !== 'run' || !jobId) throw new Error('A detached worker requires a persisted running job.');
    const existing = readMicroJob(projectRoot, jobId);
    const definition = existing?.worker;
    if (!existing || !definition || definition.version !== 1) throw new Error(`Agent job '${jobId}' has no valid persisted worker definition.`);
    const { workerResume: _workerResume, background: _background, ...persistedArgs } = definition.args || {};
    args = { ...persistedArgs, background: false, delivery: definition.deliveryMode || persistedArgs.delivery };
    adapter = definition.adapter ?? adapter;
    name = definition.name ?? name;
  }
  if (action === 'get') return compactJob(readMicroJob(projectRoot, jobId));
  if (action === 'list') return { status: 'completed', jobs: listMicroJobs(projectRoot, args).map(compactJob) };
  if (action === 'cancel') {
    const controller = active.get(key(projectRoot, jobId));
    controller?.abort();
    return { ...compactJob(readMicroJob(projectRoot, jobId)), cancellationRequested: Boolean(controller) };
  }
  if (action === 'wait') {
    // One bounded wait replaces repeated get/messages polling loops: it returns
    // the terminal report as soon as the job finishes, or the running snapshot
    // when the wait window closes.
    // Stay below the host's 300s MCP call ceiling so a long job returns a
    // resumable running snapshot instead of a hard tool-call timeout.
    const waitMs = Math.min(290_000, Math.max(0, Number(args.waitMs) || 0));
    const startedWait = Date.now();
    const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
    let job = readMicroJob(projectRoot, jobId);
    while (job && !terminalStatuses.has(job.status) && Date.now() - startedWait < waitMs && !signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, waitMs - (Date.now() - startedWait)))));
      job = readMicroJob(projectRoot, jobId);
    }
    const snapshot = { ...compactJob(job), waitedMs: Date.now() - startedWait, terminal: Boolean(job && terminalStatuses.has(job.status)) };
    if (!snapshot.terminal) {
      snapshot.status = 'partial';
      snapshot.partial = true;
      snapshot.resume = { kind: 'agent', action: 'wait', jobId };
      snapshot.guidance = `Job is still running; call agent({action:"wait", jobId:"${jobId}", waitMs:290000}) again to refresh the window.`;
    }
    return snapshot;
  }
  if (action === 'send') {
    const worker = process.env.CONTEXTOS_WORKER_MODE === '1';
    const assignedJob = process.env.CONTEXTOS_MICRO_REPORT_JOB || null;
    if (worker && (!assignedJob || (jobId && jobId !== assignedJob))) {
      throw new Error('Message id must match the assigned CLI task.');
    }
    const targetJob = worker ? assignedJob : jobId;
    const root = worker ? process.env.CONTEXTOS_MICRO_REPORT_ROOT : projectRoot;
    return { status: 'completed', direction: 'host-to-worker', ...sendMicroMessage(root, targetJob, args.message) };
  }
  if (action === 'messages' || action === 'report') {
    const worker = process.env.CONTEXTOS_WORKER_MODE === '1';
    if (worker && jobId !== process.env.CONTEXTOS_MICRO_REPORT_JOB) throw new Error('Message/report id must match the assigned CLI task.');
    const root = worker ? process.env.CONTEXTOS_MICRO_REPORT_ROOT : projectRoot;
    const waitMs = Math.min(290_000, Math.max(0, Number(args.waitMs) || 0));
    return action === 'messages'
      ? {
          status: 'completed',
          jobStatus: readMicroJob(root, jobId)?.status || null,
          mode: waitMs > 0 ? 'wait' : 'peek',
          direction: 'worker-inbox',
          messages: waitMs > 0
            ? await waitForMicroMessages(root, jobId, { waitMs, signal })
            : receiveMicroMessages(root, jobId, { peek: true }),
          messageJobId: jobId,
        }
      : { status: 'completed', ...reportMicroJob(root, jobId, args.content) };
  }
  if (action === 'batch') {
    if (!Array.isArray(args.tasks)) throw new Error('Agent batch requires tasks.');
    const jobs = await Promise.all(args.tasks.map((task) => executeAgent({ ...args, ...task, action: 'run', tasks: undefined }, { projectRoot, adapter, name, roles, runner, onUsage })));
    const hasTerminalFailure = jobs.some((job) => ['failed', 'cancelled', 'partial'].includes(job.status));
    return { status: hasTerminalFailure ? 'partial' : jobs.some((job) => job.status === 'running') ? 'running' : 'completed', jobs };
  }
  if (action !== 'run') throw new Error(`Unknown CLI task action '${action}'. Available: run, wait, get, list, cancel, send, messages, report, batch.`);
  if (process.env.CONTEXTOS_WORKER_MODE === '1') throw new Error('A CLI task can request evidence with ask, but cannot delegate another CLI task.');
  if (!(args.task || args.prompt)) throw new Error('CLI task text is required.');
  if (args.execution === 'implement') {
    const missingScope = [];
    if (!args.workspace) missingScope.push('workspace');
    if (!Array.isArray(args.context?.allowedPaths) || args.context.allowedPaths.length === 0) missingScope.push('context.allowedPaths');
    if (!Array.isArray(args.context?.acceptance) || args.context.acceptance.length === 0) missingScope.push('context.acceptance');
    if (missingScope.length) throw new Error(`Implementation dispatch rejected before the job starts; missing[${missingScope.length}]: ${missingScope.join(', ')}.`);
  }
  const id = jobId || `agent-${crypto.randomUUID()}`;
  const implementationScope = args.execution === 'implement' && args.workspace
    ? {
        workspace: String(args.workspace),
        allowedPaths: Array.isArray(args.context?.allowedPaths) ? args.context.allowedPaths : [],
        acceptance: Array.isArray(args.context?.acceptance) ? args.context.acceptance : [],
        verify: Array.isArray(args.context?.verify) ? args.context.verify : [],
        baseRevision: args.context?.baseRevision || null,
      }
    : null;
  const requestedDelivery = ['immediate', 'defer', 'errors-only', 'auto'].includes(args.delivery)
    ? args.delivery : args.background === true ? 'auto' : 'immediate';
  const deliveryMode = args.background === true && requestedDelivery === 'immediate' ? 'defer' : requestedDelivery;
  const workerDefinition = {
    version: 1,
    args: { ...args, background: true },
    adapter,
    name,
    deliveryMode,
  };
  const created = workerResume
    ? { created: false, job: readMicroJob(projectRoot, id) }
    : createMicroJob(projectRoot, {
        jobId: id,
        kind: 'agent',
        provider: 'cli',
        adapter: name,
        hostSessionId: null,
        worker: workerDefinition,
        ...(implementationScope ? { implementation: implementationScope } : {}),
      });
  if (!created.created && !workerResume) return compactJob(created.job);
  if (args.background === true && !workerResume && process.env.CONTEXTOS_AGENT_INPROCESS !== '1') {
    const workerArgs = workerEntry
      ? [workerEntry, '--agent-worker', projectRoot, id]
      : [fileURLToPath(new URL('./agent-worker.mjs', import.meta.url)), projectRoot, id];
    let workerStderr = 'ignore';
    try {
      const jobDir = path.join(projectRoot, '.contextos', 'micro-deliveries', 'jobs');
      fs.mkdirSync(jobDir, { recursive: true });
      workerStderr = fs.openSync(path.join(jobDir, `${id}.worker.log`), 'a');
    } catch {}
    const child = spawn(process.execPath, workerArgs, {
      detached: true,
      stdio: ['ignore', 'ignore', workerStderr],
      env: process.env,
    });
    child.on('error', () => {});
    if (Number.isInteger(child.pid)) {
      try { updateMicroJob(projectRoot, id, { leasePid: child.pid }); } catch {}
    }
    child.unref();
    return { id, status: 'running' };
  }
  const controller = new AbortController();
  active.set(key(projectRoot, id), controller);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const run = async () => {
    let result = null;
    let runnerError = null;
    let usageReceipt = null;
    let usageAccounting = null;
    let usageCallbackAttempted = false;
    try {
      try {
        result = await runner({ provider: 'cli', cli: adapter, model: adapter.model, thinking: adapter.thinking }, {
          ...args, delivery: deliveryMode, provider: 'cli', projectRoot, agentJobId: id, reportJobId: id, withOS: true,
          evidenceBroker: true, apiMicro: roles?.micro,
          reportFormat: 'structured', signal: controller.signal,
        });
      } catch (error) {
        runnerError = error;
        result = resultFromError(error);
      }

      const completed = !runnerError && result?.ok === true;
      const status = controller.signal.aborted ? 'cancelled' : completed ? 'completed' : 'failed';
      const errorMessage = runnerError?.message || result?.error || (completed ? null : 'CLI task failed.');
      const providerLaunches = result?.providerLaunches ?? result?.invocation?.providerLaunches ?? null;
      const actualModel = result?.actualModel || result?.invocation?.actualModel || null;
      const requestedModel = result?.requestedModel || adapter.model || null;
      const provider = cliProviderName(adapter, result?.provider);
      const usageEvidence = cliUsageEvidence(result, adapter);
      const cliUsage = cliUsageSummary(result?.contextUsage);
      usageReceipt = {
        role: 'cli-agent',
        taskId: id,
        requestId: `${id}:aggregate`,
        evidenceScope: 'task-aggregate',
        provider,
        model: actualModel,
        actualModel,
        requestedModel,
        providerLaunches,
        usage: usageEvidence.usage,
        usageRaw: result?.usageRaw ?? null,
        providerReportedUsage: usageEvidence.providerReportedUsage,
        providerReportedTotalTokens: usageEvidence.providerReportedTotalTokens,
        usageMapping: usageEvidence.usageMapping,
        unmappedProviderUsage: usageEvidence.unmappedProviderUsage ?? null,
        startedAt,
        durationMs: Date.now() - started,
        status,
      };
      const previousJob = readMicroJob(projectRoot, id);
      const previousReport = previousJob?.report || null;
      const answeredQuestions = Array.isArray(previousJob?.answeredQuestions) ? previousJob.answeredQuestions : [];
      const normalizedReport = normalizeAgentReport(result?.agentReport || result?.structured || {
        answer: result?.content || errorMessage || '', needsHost: !completed,
      }, { jobId: id, status, answeredQuestions, cliUsage });
      const report = !hasAgentReportContent(normalizedReport) && hasAgentReportContent(previousReport)
        ? {
            ...normalizedReport,
            summary: previousReport.summary || '',
            changes: Array.isArray(previousReport.changes) ? previousReport.changes : [],
            checks: Array.isArray(previousReport.checks) ? previousReport.checks : [],
            ...(cliUsage ? { cliUsage } : {}),
            needsHostReason: normalizedReport.needsHostReason === 'none'
              && Array.isArray(previousReport.changes) && previousReport.changes.length > 0
              ? 'changes'
              : normalizedReport.needsHostReason,
          }
        : normalizedReport;
      const deniedDetail = deniedActionText(result?.deniedActions);
      if (deniedDetail) {
        report.blockers = [...report.blockers, deniedDetail].slice(0, 50);
        report.needsHost = true;
      }

      // Persist the CLI outcome and its usage evidence before the independent
      // central metering callback; a ledger failure must not rewrite task status.
      let job = updateMicroJob(projectRoot, id, {
        status,
        report,
        error: errorMessage,
        cliSessionId: result?.cliSessionId || null,
        deniedActions: result?.deniedActions || null,
        delivery: deliveryMode,
        providerUsageComplete: result?.providerUsageComplete ?? null,
        usageReceipt,
        cliUsage,
      });
      const shouldQueue = !completed || deliveryMode === 'defer'
        || (deliveryMode === 'auto' && report.needsHost === true);
      let deliveryAccounting = { status: 'not-requested' };
      if (shouldQueue) {
        try {
          const queued = enqueueMicroDelivery(projectRoot, { deliveryId: id, receiptId: id, content: JSON.stringify(report), hostSessionId: null });
          deliveryAccounting = { status: queued.duplicate ? 'already-queued' : 'queued', deliveryId: id };
        } catch {
          deliveryAccounting = { status: 'gap', reason: 'The task result persisted, but deferred delivery could not be queued.' };
        }
      }

      if (providerLaunches === 0) {
        const contradictoryUsage = usageReceipt.usage !== null || usageReceipt.usageRaw !== null
          || usageReceipt.unmappedProviderUsage !== null;
        usageAccounting = contradictoryUsage
          ? usageGap('Usage was returned while providerLaunches was zero; evidence is retained without counting a launched call.')
          : { status: 'not-launched', providerLaunches: 0 };
      } else if (typeof onUsage !== 'function') {
        usageAccounting = usageGap('No central usage-ledger callback was available.');
      } else {
        try {
          usageCallbackAttempted = true;
          const receipt = await onUsage(usageReceipt);
          usageAccounting = receipt?.accepted === false || receipt?.status === 'conflict'
            ? usageGap('The central usage ledger rejected conflicting evidence.')
            : { status: 'recorded' };
        } catch {
          usageAccounting = usageGap('The central usage ledger could not persist this receipt.');
        }
      }
      try {
        job = updateMicroJob(projectRoot, id, { usageAccounting, deliveryAccounting }) || { ...job, usageAccounting, deliveryAccounting };
      } catch {
        job = { ...job, usageAccounting: usageGap('The task result persisted, but its metering status could not be persisted.'), deliveryAccounting };
      }
      const response = compactJob(job);
      const shouldDeferReport = completed && (deliveryMode === 'defer' || deliveryMode === 'errors-only'
        || (deliveryMode === 'auto' && report.needsHost === true));
      if (shouldDeferReport && deliveryAccounting.status !== 'gap') {
        response.report = null;
        response.deliveryStatus = deliveryMode === 'errors-only' ? 'quiet-success' : 'deferred';
      }
      return response;
    } catch (error) {
      if (args.background !== true) throw error;
      // A background invocation has no awaiting caller, so convert unexpected
      // post-launch errors into a durable failed receipt where storage permits.
      try {
        const existing = readMicroJob(projectRoot, id);
        if (!existing) return;
        const failedUsageReceipt = usageReceipt
          ? { ...usageReceipt, status: 'failed' }
          : {
            role: 'cli-agent', taskId: id, requestId: `${id}:aggregate`, evidenceScope: 'task-aggregate',
            provider: cliProviderName(adapter), model: null, actualModel: null,
            requestedModel: adapter?.model || null, providerLaunches: null, usage: null,
            startedAt, durationMs: Date.now() - started, status: 'failed',
          };
        let failedUsageAccounting = existing.usageAccounting || usageAccounting;
        if (!failedUsageAccounting) {
          if (failedUsageReceipt.providerLaunches === 0 && failedUsageReceipt.usage === null) {
            failedUsageAccounting = { status: 'not-launched', providerLaunches: 0 };
          } else if (!usageCallbackAttempted && typeof onUsage === 'function' && failedUsageReceipt.providerLaunches !== 0) {
            try {
              usageCallbackAttempted = true;
              const receipt = await onUsage(failedUsageReceipt);
              failedUsageAccounting = receipt?.accepted === false || receipt?.status === 'conflict'
                ? usageGap('The central usage ledger rejected conflicting evidence.') : { status: 'recorded' };
            } catch {
              failedUsageAccounting = usageGap('The central usage ledger could not persist this receipt.');
            }
          } else {
            failedUsageAccounting = usageGap('Background processing failed before complete usage accounting was persisted.');
          }
        }
        const stillRunning = existing.status === 'running';
        const errorMessage = error?.message || String(error);
        const report = existing.report || normalizeAgentReport({
          answer: `Background CLI task failed before its result could be saved: ${errorMessage}`,
          needsHost: true,
        }, { jobId: id, status: 'failed' });
        let job = updateMicroJob(projectRoot, id, {
          ...(stillRunning ? { status: 'failed', report, error: errorMessage } : {}),
          ...(!existing.usageReceipt ? { usageReceipt: failedUsageReceipt } : {}),
          usageAccounting: failedUsageAccounting,
          executionAccounting: { status: 'gap', reason: 'Background task processing terminated unexpectedly after launch.' },
        }) || existing;
        let deliveryAccounting = job.deliveryAccounting || { status: 'not-requested' };
        if (stillRunning || job.status === 'failed') {
          try {
            const queued = enqueueMicroDelivery(projectRoot, { deliveryId: id, receiptId: id, content: JSON.stringify(report), hostSessionId: null });
            deliveryAccounting = { status: queued.duplicate ? 'already-queued' : 'queued', deliveryId: id };
          } catch {
            deliveryAccounting = { status: 'gap', reason: 'The background task failure was saved, but its error report could not be queued.' };
          }
        }
        updateMicroJob(projectRoot, id, { deliveryAccounting });
      } catch {
        // Keep the server alive even when the project store itself is unwritable.
      }
    } finally { active.delete(key(projectRoot, id)); }
  };
  if (args.background === true) {
    void run().catch((error) => {
      const message = error?.message || String(error);
      try {
        const existing = readMicroJob(projectRoot, id);
        if (!existing) return;
        const isStillRunning = existing.status === 'running';
        const report = existing.report || normalizeAgentReport({
          answer: `Background CLI task failed before its result could be saved: ${message}`,
          needsHost: true,
        }, { jobId: id, status: 'failed' });
        let job = updateMicroJob(projectRoot, id, {
          ...(isStillRunning ? { status: 'failed', report, error: message } : {}),
          executionAccounting: { status: 'gap', reason: 'Background task processing terminated unexpectedly after launch.' },
        }) || existing;
        let deliveryAccounting = job.deliveryAccounting || { status: 'not-requested' };
        if (isStillRunning || job.status === 'failed') {
          try {
            const queued = enqueueMicroDelivery(projectRoot, { deliveryId: id, receiptId: id, content: JSON.stringify(report), hostSessionId: null });
            deliveryAccounting = { status: queued.duplicate ? 'already-queued' : 'queued', deliveryId: id };
          } catch {
            deliveryAccounting = { status: 'gap', reason: 'The background task failure was saved, but its error report could not be queued.' };
          }
        }
        updateMicroJob(projectRoot, id, { deliveryAccounting });
      } catch {
        // The initial job record is the durable fallback. A storage error here
        // must not become an unhandled rejection in the MCP server.
      }
    });
    return { id, status: 'running' };
  }
  return run();
}
