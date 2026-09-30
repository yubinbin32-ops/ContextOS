/**
 * Pure JavaScript structured-report normalizer for micro-agent executions.
 * Normalizes varied agent outputs into a consistent, bounded report object.
 */

function questionKey(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function isAnsweredQuestion(question, answeredQuestions) {
  const key = questionKey(question);
  if (!key || !Array.isArray(answeredQuestions)) return false;
  return answeredQuestions.some((answered) => questionKey(answered) === key);
}

function parseJsonIfString(val) {
  if (typeof val !== 'string') return val;
  let trimmed = val.trim();
  // Some CLIs wrap their final JSON report in one Markdown code fence.
  // Accept only a whole fenced payload, never extract JSON from execution prose.
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  if (fenced) trimmed = fenced[1].trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return val;
    }
  }
  return val;
}

function normalizeStringArray(val, maxItems = 50, maxItemChars = 300) {
  if (val == null) return [];
  const arr = Array.isArray(val) ? val : [val];
  const result = [];
  for (const item of arr) {
    if (item == null) continue;
    let str;
    if (typeof item === 'string') {
      str = item;
    } else if (typeof item === 'object') {
      str = item.path || item.file || item.name || item.message || item.check || item.command || '';
      if (typeof str !== 'string') str = '';
      const check = item.check || item.command;
      if (typeof check === 'string') {
        const outcome = typeof item.outcome === 'string'
          ? item.outcome.slice(0, 80)
          : (item.ok === true ? 'passed' : item.ok === false ? 'failed' : '');
        const countParts = [
          Number.isInteger(item.passed) ? `passed=${item.passed}` : '',
          Number.isInteger(item.failed) ? `failed=${item.failed}` : '',
        ].filter(Boolean);
        const counts = countParts.length > 0 ? ` ${countParts.join(' ')}` : '';
        const exitCode = Number.isInteger(item.exitCode) ? ` exit=${item.exitCode}` : '';
        str = `${check}${outcome ? `: ${outcome}` : ''}${counts}${exitCode}`;
      }
    } else {
      str = String(item);
    }
    str = str.trim();
    if (str.length > 0) {
      if (str.length > maxItemChars) {
        str = str.slice(0, maxItemChars);
      }
      result.push(str);
      if (result.length >= maxItems) break;
    }
  }
  return result;
}

function unwrapPayload(input) {
  let explicitNeedsHost = undefined;
  let parsed = parseJsonIfString(input);

  // If parsed is still a string (plain text)
  if (typeof parsed === 'string') {
    return {
      payload: { summary: parsed },
      explicitNeedsHost
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      payload: {},
      explicitNeedsHost
    };
  }

  // Iterate up to 5 levels to unwrap nested envelopes (auto envelope, report envelope, answer, etc.)
  let current = { ...parsed };
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current.needsHost === 'boolean' && explicitNeedsHost === undefined) {
      explicitNeedsHost = current.needsHost;
    }

    let unwrapped = false;

    // Check for auto envelope or answer wrapper
    if (current.answer !== undefined) {
      const parsedAns = parseJsonIfString(current.answer);
      if (parsedAns && typeof parsedAns === 'object' && !Array.isArray(parsedAns)) {
        if (typeof parsedAns.needsHost === 'boolean' && explicitNeedsHost === undefined) {
          explicitNeedsHost = parsedAns.needsHost;
        }
        current = { ...current, ...parsedAns };
        delete current.answer;
        unwrapped = true;
      } else if (typeof parsedAns === 'string' && !current.summary) {
        current.summary = parsedAns;
      }
    }

    // Check for report envelope
    if (current.report !== undefined) {
      const parsedRep = parseJsonIfString(current.report);
      if (parsedRep && typeof parsedRep === 'object' && !Array.isArray(parsedRep)) {
        if (typeof parsedRep.needsHost === 'boolean' && explicitNeedsHost === undefined) {
          explicitNeedsHost = parsedRep.needsHost;
        }
        current = { ...current, ...parsedRep };
        delete current.report;
        unwrapped = true;
      } else if (typeof parsedRep === 'string' && !current.summary) {
        current.summary = parsedRep;
      }
    }

    if (!unwrapped) break;
  }

  return { payload: current, explicitNeedsHost };
}

/**
 * Normalizes input from a micro-agent into a structured report.
 *
 * @param {unknown} input - Raw agent output (plain text, JSON string, object, auto envelope, report envelope)
 * @param {object} [options]
 * @param {string|number|null} [options.jobId=null]
 * @param {string} [options.status='completed']
 * @param {number} [options.maxChars=2400]
 * @param {string[]} [options.answeredQuestions=[]]
 * @returns {object} Normalized report { jobId, status, summary, changes, checks, blockers, question, questionAnswered, needsHost, needsHostReason, waitingForHost, hostReason }
 */
export function hasAgentReportContent(report) {
  return Boolean(report && (
    String(report.summary || '').trim()
    || (Array.isArray(report.changes) && report.changes.length > 0)
    || (Array.isArray(report.checks) && report.checks.length > 0)
    || (Array.isArray(report.blockers) && report.blockers.length > 0)
    || String(report.question || '').trim()
  ));
}

function normalizeCliUsageSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.percent === null || value.percent === undefined || (typeof value.percent === 'string' && !value.percent.trim())) return null;
  const percent = Number(value.percent);
  if (!Number.isFinite(percent) || percent < 0) return null;
  const usedTokens = Number.isSafeInteger(Number(value.usedTokens)) && Number(value.usedTokens) >= 0 ? Number(value.usedTokens) : null;
  const windowTokens = Number.isSafeInteger(Number(value.windowTokens)) && Number(value.windowTokens) > 0 ? Number(value.windowTokens) : null;
  return {
    percent: Math.round(percent * 10) / 10,
    usedTokens,
    windowTokens,
    source: value.source === 'provider' ? 'provider' : 'derived',
  };
}

export function normalizeAgentReport(input, { jobId = null, status = 'completed', maxChars = 2400, answeredQuestions = [], cliUsage = null } = {}) {
  const { payload, explicitNeedsHost } = unwrapPayload(input);

  const resolvedJobId = String(jobId ?? payload.jobId ?? '').slice(0, 160) || null;
  maxChars = Math.max(80, Number.isFinite(Number(maxChars)) ? Math.floor(Number(maxChars)) : 2400);

  // Extract raw fields with aliases
  const rawSummary = typeof payload.summary === 'string' ? payload.summary : (typeof payload.answer === 'string' ? payload.answer : '');
  const rawChanges = payload.changes ?? payload.filesChanged ?? payload.changedFiles;
  const rawChecks = payload.checks ?? payload.tests ?? payload.verification ?? payload.verifications;
  const rawBlockers = payload.blockers ?? payload.blocker;
  const rawQuestion = typeof payload.question === 'string' && payload.question.trim().length > 0 ? payload.question.trim() : null;
  const questionAnswered = isAnsweredQuestion(rawQuestion, answeredQuestions);
  const normalizedCliUsage = normalizeCliUsageSummary(cliUsage);
  const rawHostReason = typeof payload.hostReason === 'string' && payload.hostReason.trim().length > 0 ? payload.hostReason.trim() : null;
  const isBlocked = Boolean(payload.blocked) || payload.status === 'blocked';

  // Normalize string arrays
  const changes = normalizeStringArray(rawChanges);
  const checks = normalizeStringArray(rawChecks);
  const blockers = normalizeStringArray(rawBlockers);

  // Status resolution:
  // 1. Runtime status=failed always overrides a claimed success.
  // 2. Nonempty blockers or blocked=true means blocked unless runtime failed.
  // 3. Explicit failed status in payload means failed.
  // 4. Default to payload status if valid, else runtime status ('completed').
  let finalStatus;
  if (status === 'failed') {
    finalStatus = 'failed';
  } else if (blockers.length > 0 || isBlocked) {
    finalStatus = 'blocked';
  } else if (payload.status === 'failed') {
    finalStatus = 'failed';
  } else if (payload.status === 'completed' || payload.status === 'success') {
    finalStatus = 'completed';
  } else {
    finalStatus = ['running', 'blocked', 'cancelled', 'failed', 'completed'].includes(status) ? status : 'completed';
  }

  // needsHost is an attention signal, not a generic change notice. Changes
  // remain visible through needsHostReason without waking the host; only a
  // question, blocker, terminal failure/cancellation, or explicit request does.
  const waitingForHost = rawQuestion !== null && !questionAnswered;
  const finalNeedsHost = waitingForHost || blockers.length > 0 || isBlocked
    || ['blocked', 'failed', 'cancelled'].includes(finalStatus)
    || (explicitNeedsHost === true && !questionAnswered);

  let needsHostReason;
  if (waitingForHost) needsHostReason = 'question';
  else if (finalStatus === 'failed') needsHostReason = 'failed';
  else if (finalStatus === 'cancelled') needsHostReason = 'cancelled';
  else if (blockers.length > 0 || isBlocked || finalStatus === 'blocked') needsHostReason = 'blocked';
  else if (changes.length > 0) needsHostReason = 'changes';
  else if (finalNeedsHost) needsHostReason = 'reported';
  else needsHostReason = 'none';

  let summary = typeof rawSummary === 'string' ? rawSummary.trim() : (rawSummary ? String(rawSummary).trim() : '');
  if (summary.length > maxChars) {
    summary = summary.slice(0, maxChars);
  }

  let question = rawQuestion;
  if (question && question.length > maxChars) {
    question = question.slice(0, maxChars);
  }

  let hostReason = questionAnswered ? null : rawHostReason;
  if (hostReason && hostReason.length > maxChars) {
    hostReason = hostReason.slice(0, maxChars);
  }

  // Construct report with ONLY recognized fields
  const report = {
    jobId: resolvedJobId,
    status: finalStatus,
    summary,
    changes,
    checks,
    blockers,
    question,
    needsHost: finalNeedsHost,
    needsHostReason,
    waitingForHost,
    hostReason,
    ...(normalizedCliUsage ? { cliUsage: normalizedCliUsage } : {}),
    ...(questionAnswered ? { questionAnswered: true } : {})
  };
  const recognized = ['summary', 'answer', 'changes', 'filesChanged', 'checks', 'tests', 'blockers', 'blocker', 'question', 'questionAnswered', 'blocked', 'status', 'needsHost', 'needsHostReason', 'waitingForHost', 'hostReason', 'cliUsage'];
  if (Object.keys(payload).length && !recognized.some((key) => payload[key] !== undefined)) {
    report.summary = 'Unrecognized report fields; inspect the result artifact.';
    report.needsHost = true;
  }
  const clippedArray = (value) => {
    const items = Array.isArray(value) ? value : value == null ? [] : [value];
    return items.length > 50 || items.some((item) => {
      const text = typeof item === 'string' ? item : item?.path || item?.file || item?.name || item?.message;
      return typeof text === 'string' && text.trim().length > 300;
    });
  };
  if ([rawChanges, rawChecks, rawBlockers].some(clippedArray)) report.truncated = true;

  // Check serialization length against maxChars budget
  if (JSON.stringify(report).length <= maxChars) {
    return report;
  }

  // Bounded output reduction: mark truncated=true and reduce fields while retaining status/needsHost
  report.truncated = true;

  if (JSON.stringify(report).length > maxChars) {
    report.checks = report.checks.slice(0, 3);
  }
  if (JSON.stringify(report).length > maxChars) {
    report.changes = report.changes.slice(0, 3);
  }
  if (JSON.stringify(report).length > maxChars) {
    report.checks = [];
  }
  if (JSON.stringify(report).length > maxChars) {
    report.changes = [];
  }
  if (JSON.stringify(report).length > maxChars) {
    report.blockers = report.blockers.slice(0, 1);
  }

  if (JSON.stringify(report).length > maxChars && report.hostReason) {
    const excess = JSON.stringify(report).length - maxChars;
    const newLen = Math.max(0, report.hostReason.length - excess - 10);
    report.hostReason = newLen > 0 ? report.hostReason.slice(0, newLen) : null;
  }

  if (JSON.stringify(report).length > maxChars && report.summary.length > 0) {
    const excess = JSON.stringify(report).length - maxChars;
    const newLen = Math.max(0, report.summary.length - excess - 10);
    report.summary = report.summary.slice(0, newLen);
  }

  if (JSON.stringify(report).length > maxChars && report.question) {
    const excess = JSON.stringify(report).length - maxChars;
    const newLen = Math.max(0, report.question.length - excess - 10);
    report.question = newLen > 0 ? report.question.slice(0, newLen) : null;
  }

  if (JSON.stringify(report).length > maxChars) {
    report.blockers = [];
    report.summary = '';
    report.question = null;
    report.hostReason = null;
  }

  if (JSON.stringify(report).length > maxChars) {
    const minimal = {
      status: report.status,
      needsHost: report.needsHost,
      needsHostReason: report.needsHostReason,
      waitingForHost: report.waitingForHost,
      truncated: true
    };
    if (JSON.stringify(minimal).length <= maxChars) {
      return minimal;
    }
    const tiny = { status: report.status, needsHost: report.needsHost, truncated: true };
    if (JSON.stringify(tiny).length <= maxChars) {
      return tiny;
    }
  }

  for (const key of ['summary', 'question']) {
    while (JSON.stringify(report).length > maxChars && report[key]?.length) report[key] = report[key].slice(0, -1);
  }
  return report;
}

export default normalizeAgentReport;
