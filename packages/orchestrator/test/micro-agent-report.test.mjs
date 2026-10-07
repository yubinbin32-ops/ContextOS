import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgentReport } from '../src/micro-agent-report.mjs';

it('failed reports cannot be hidden and arbitrary status/objects do not leak into reports', () => {
  const failed = normalizeAgentReport({ needsHost: false }, { status: 'failed' });
  assert.equal(failed.needsHost, true);
  assert.equal(failed.needsHostReason, 'failed');
  const report = normalizeAgentReport({ status: 'arbitrary_private_flow', changes: [{ transcript: 'PRIVATE_FLOW' }] });
  assert.equal(report.status, 'completed');
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_FLOW|arbitrary_private_flow/);
});
it('runtime cancellation preserves evidence while overriding claimed payload outcomes', () => {
  const cliUsage = { percent: 5, usedTokens: 11650, windowTokens: 233000, source: 'provider' };
  for (const status of ['failed', 'completed', 'success', 'blocked']) {
    const report = normalizeAgentReport({ status, summary: 'Completed one module', changes: ['src/amount.mjs'], checks: ['unit test passed'], blockers: ['Unfinished work'], needsHost: true }, { status: 'cancelled', cliUsage });
    assert.equal(report.status, 'cancelled');
    assert.equal(report.needsHostReason, 'cancelled');
    assert.equal(report.summary, 'Completed one module');
    assert.deepEqual(report.changes, ['src/amount.mjs']);
    assert.deepEqual(report.checks, ['unit test passed']);
    assert.deepEqual(report.blockers, ['Unfinished work']);
    assert.deepEqual(report.cliUsage, cliUsage);
    const replay = normalizeAgentReport(report, { status: 'cancelled', cliUsage });
    assert.equal(replay.status, 'cancelled');
    assert.equal(replay.needsHostReason, 'cancelled');
  }
  const withoutUsage = normalizeAgentReport({ status: 'failed', summary: 'cancelled' }, { status: 'cancelled' });
  assert.equal(withoutUsage.status, 'cancelled');
  assert.equal(withoutUsage.cliUsage, undefined);
});
it('carries a bounded CLI usage summary only when real context telemetry is present', () => {
  const report = normalizeAgentReport({ summary: 'done', needsHost: false }, {
    cliUsage: { percent: 50.04, usedTokens: 116600, windowTokens: 233000, source: 'derived', privateTrace: 'DO_NOT_RETURN' },
  });
  assert.deepEqual(report.cliUsage, { percent: 50, usedTokens: 116600, windowTokens: 233000, source: 'derived' });
  assert.doesNotMatch(JSON.stringify(report), /privateTrace|DO_NOT_RETURN/);
  assert.equal(normalizeAgentReport({ summary: 'done' }, { cliUsage: { percent: null } }).cliUsage, undefined);
});
it('JSON escaping and oversized identities stay within a useful bounded report', () => {
  const report = normalizeAgentReport({ summary: '\\"'.repeat(1000), question: '\\"'.repeat(1000) }, { jobId: 'x'.repeat(5000), maxChars: 300 });
  assert.ok(JSON.stringify(report).length <= 300);
  assert.equal(report.needsHost, true);
  assert.equal(report.needsHostReason, 'question');
  assert.equal(report.waitingForHost, true);
  assert.equal(report.truncated, true);
});

describe('normalizeAgentReport', () => {
  describe('legacy and plain fallback', () => {
    it('normalizes plain text input', () => {
      const report = normalizeAgentReport('Task completed cleanly with no issues.');
      assert.deepEqual(report, {
        jobId: null,
        status: 'completed',
        summary: 'Task completed cleanly with no issues.',
        changes: [],
        checks: [],
        blockers: [],
        question: null,
        needsHost: false,
        needsHostReason: 'none',
        waitingForHost: false,
        hostReason: null
      });
    });

    it('normalizes valid JSON string input', () => {
      const input = JSON.stringify({
        summary: 'Refactored report handler',
        changes: ['src/report.mjs'],
        checks: ['test/report.test.mjs']
      });
      const report = normalizeAgentReport(input, { jobId: 'job-101' });
      assert.equal(report.jobId, 'job-101');
      assert.equal(report.status, 'completed');
      assert.equal(report.summary, 'Refactored report handler');
      assert.deepEqual(report.changes, ['src/report.mjs']);
      assert.deepEqual(report.checks, ['test/report.test.mjs']);
      assert.deepEqual(report.blockers, []);
      assert.equal(report.question, null);
      assert.equal(report.needsHost, false);
      assert.equal(report.needsHostReason, 'changes');
      assert.equal(report.waitingForHost, false);
    });

    it('falls back gracefully on null, undefined, or empty input without inventing data', () => {
      const nullReport = normalizeAgentReport(null);
      assert.deepEqual(nullReport, {
        jobId: null,
        status: 'completed',
        summary: '',
        changes: [],
        checks: [],
        blockers: [],
        question: null,
        needsHost: false,
        needsHostReason: 'none',
        waitingForHost: false,
        hostReason: null
      });

      const undefReport = normalizeAgentReport(undefined);
      assert.deepEqual(undefReport, {
        jobId: null,
        status: 'completed',
        summary: '',
        changes: [],
        checks: [],
        blockers: [],
        question: null,
        needsHost: false,
        needsHostReason: 'none',
        waitingForHost: false,
        hostReason: null
      });
    });

    it('maps filesChanged to changes and tests to checks', () => {
      const report = normalizeAgentReport({
        summary: 'Applied migrations',
        filesChanged: ['schema.sql'],
        tests: ['schema.test.sql']
      });
      assert.deepEqual(report.changes, ['schema.sql']);
      assert.deepEqual(report.checks, ['schema.test.sql']);
    });

    it('maps AGY changedFiles and verification into structured changes and checks', () => {
      const report = normalizeAgentReport({
        needsHost: false,
        answer: {
          summary: 'Implemented the bounded plan dependency feature.',
          changedFiles: ['packages/domain/src/plan.mjs'],
          verification: [
            { command: 'node --test packages/domain/test/domain.test.mjs', passed: 14, failed: 0, exitCode: 0 },
          ],
        },
      });
      assert.deepEqual(report.changes, ['packages/domain/src/plan.mjs']);
      assert.equal(report.checks.length, 1);
      assert.match(report.checks[0], /node --test packages\/domain\/test\/domain\.test\.mjs/);
      assert.match(report.checks[0], /passed=14 failed=0 exit=0/);
    });

    it('accepts singular AGY changedFiles and verification values', () => {
      const report = normalizeAgentReport({
        answer: { changedFiles: 'packages/domain/src/plan.mjs', verification: { command: 'npm test', ok: true } },
      });
      assert.deepEqual(report.changes, ['packages/domain/src/plan.mjs']);
      assert.deepEqual(report.checks, ['npm test: passed']);
    });

    it('does not invent a zero for an unreported verification count', () => {
      const passedOnly = normalizeAgentReport({
        answer: { verification: [{ command: 'npm test', passed: 3 }] },
      });
      const failedOnly = normalizeAgentReport({
        answer: { verification: [{ command: 'npm test', failed: 2 }] },
      });
      assert.deepEqual(passedOnly.checks, ['npm test passed=3']);
      assert.deepEqual(failedOnly.checks, ['npm test failed=2']);
    });
  });

  describe('nested auto and report envelopes', () => {
    it('handles auto envelope with string answer and hostReason', () => {
      const input = {
        needsHost: true,
        answer: 'Awaiting deployment credentials',
        hostReason: 'credential_required'
      };
      const report = normalizeAgentReport(input, { jobId: 'deploy-42' });
      assert.equal(report.jobId, 'deploy-42');
      assert.equal(report.summary, 'Awaiting deployment credentials');
      assert.equal(report.needsHost, true);
      assert.equal(report.needsHostReason, 'reported');
      assert.equal(report.waitingForHost, false);
      assert.equal(report.hostReason, 'credential_required');
    });

    it('handles auto envelope with structured answer object', () => {
      const input = {
        needsHost: false,
        answer: {
          summary: 'Read configuration',
          checks: ['config.test.mjs']
        }
      };
      const report = normalizeAgentReport(input);
      assert.equal(report.summary, 'Read configuration');
      assert.deepEqual(report.checks, ['config.test.mjs']);
      assert.equal(report.needsHost, false); // no changes/blockers/question
      assert.equal(report.needsHostReason, 'none');
    });

    it('handles report envelope at top level', () => {
      const input = {
        report: {
          summary: 'Audited dependencies',
          checks: ['npm audit']
        }
      };
      const report = normalizeAgentReport(input);
      assert.equal(report.summary, 'Audited dependencies');
      assert.deepEqual(report.checks, ['npm audit']);
    });

    it('handles nested auto envelope containing report envelope and JSON string answer', () => {
      const innerReport = JSON.stringify({
        report: {
          summary: 'Deeply nested report',
          changes: ['packages/orchestrator/src/deep.mjs']
        }
      });
      const input = {
        needsHost: false,
        answer: innerReport,
        hostReason: null
      };
      const report = normalizeAgentReport(input);
      assert.equal(report.summary, 'Deeply nested report');
      assert.deepEqual(report.changes, ['packages/orchestrator/src/deep.mjs']);
      assert.equal(report.needsHost, false);
      assert.equal(report.needsHostReason, 'changes');
      assert.equal(report.waitingForHost, false);
    });
  });

  describe('dropping a very large execution trace', () => {
    it('drops reasoning, steps, messages, toolCalls, transcript and other unrecognized fields', () => {
      const largeInput = {
        summary: 'Refactored successfully',
        changes: ['src/core.mjs'],
        checks: ['test/core.test.mjs'],
        reasoning: 'Detailed reasoning step by step... '.repeat(1000),
        steps: Array.from({ length: 200 }, (_, i) => ({ step: i, action: 'read', result: 'ok'.repeat(100) })),
        messages: Array.from({ length: 50 }, (_, i) => ({ role: 'assistant', content: 'Message '.repeat(50) })),
        toolCalls: Array.from({ length: 50 }, (_, i) => ({ tool: 'exec', args: { cmd: 'test' } })),
        transcript: 'Full transcript output... '.repeat(500),
        extraMetadata: { debug: true, internalId: 12345 }
      };

      const report = normalizeAgentReport(largeInput, { jobId: 'job-clean' });

      // Ensure no execution trace fields are present
      assert.equal('reasoning' in report, false);
      assert.equal('steps' in report, false);
      assert.equal('messages' in report, false);
      assert.equal('toolCalls' in report, false);
      assert.equal('transcript' in report, false);
      assert.equal('extraMetadata' in report, false);

      // Verify exact expected keys
      const allowedKeys = new Set(['jobId', 'status', 'summary', 'changes', 'checks', 'blockers', 'question', 'needsHost', 'needsHostReason', 'waitingForHost', 'hostReason']);
      for (const key of Object.keys(report)) {
        assert.ok(allowedKeys.has(key), `Unexpected key: ${key}`);
      }

      assert.equal(report.summary, 'Refactored successfully');
      assert.deepEqual(report.changes, ['src/core.mjs']);
      assert.deepEqual(report.checks, ['test/core.test.mjs']);
      assert.equal(report.needsHost, false);
      assert.equal(report.needsHostReason, 'changes');
      assert.equal(report.waitingForHost, false);
      assert.equal(report.truncated, undefined); // payload fits within maxChars once traces dropped
    });
  });

  describe('failure and blocker overrides', () => {
    it('runtime status=failed overrides claimed success', () => {
      const input = {
        status: 'completed',
        summary: 'Model claimed complete success'
      };
      const report = normalizeAgentReport(input, { status: 'failed' });
      assert.equal(report.status, 'failed');
      assert.equal(report.needsHostReason, 'failed');
    });

    it('runtime status=failed overrides blocked status and blockers', () => {
      const input = {
        status: 'completed',
        blockers: ['Cannot reach host'],
        blocked: true
      };
      const report = normalizeAgentReport(input, { status: 'failed' });
      assert.equal(report.status, 'failed');
      assert.deepEqual(report.blockers, ['Cannot reach host']);
      assert.equal(report.needsHost, true);
      assert.equal(report.needsHostReason, 'failed');
      assert.equal(report.waitingForHost, false);
    });

    it('nonempty blockers set status to blocked when runtime is not failed', () => {
      const input = {
        status: 'completed',
        blockers: ['Missing database URL']
      };
      const report = normalizeAgentReport(input, { status: 'completed' });
      assert.equal(report.status, 'blocked');
      assert.deepEqual(report.blockers, ['Missing database URL']);
      assert.equal(report.needsHost, true);
      assert.equal(report.needsHostReason, 'blocked');
      assert.equal(report.waitingForHost, false);
    });

    it('blocked=true sets status to blocked even if blockers array is empty', () => {
      const input = {
        status: 'completed',
        blocked: true,
        summary: 'Waiting on approval'
      };
      const report = normalizeAgentReport(input);
      assert.equal(report.status, 'blocked');
      assert.equal(report.needsHost, true);
      assert.equal(report.needsHostReason, 'blocked');
    });

    it('preserves payload failed status when runtime is completed', () => {
      const input = {
        status: 'failed',
        summary: 'Compilation error'
      };
      const report = normalizeAgentReport(input, { status: 'completed' });
      assert.equal(report.status, 'failed');
      assert.equal(report.needsHostReason, 'failed');
    });
  });

  describe('critical false-needsHost corrections', () => {
    it('keeps completed changes informational when the model reports needsHost=false', () => {
      const input = {
        needsHost: false,
        summary: 'Made changes silently',
        changes: ['packages/orchestrator/src/important.mjs']
      };
      const report = normalizeAgentReport(input);
      assert.equal(report.needsHost, false);
      assert.equal(report.needsHostReason, 'changes');
      assert.equal(report.waitingForHost, false);
    });

    it('keeps filesChanged informational when the model reports needsHost=false', () => {
      const input = {
        needsHost: false,
        summary: 'Updated documentation',
        filesChanged: ['README.md']
      };
      const report = normalizeAgentReport(input);
      assert.equal(report.needsHost, false);
      assert.equal(report.needsHostReason, 'changes');
      assert.equal(report.waitingForHost, false);
    });

    it('forces needsHost=true when model reports blockers with needsHost=false', () => {
      const input = {
        needsHost: false,
        summary: 'Stuck on auth',
        blockers: ['Missing GitHub token']
      };
      const report = normalizeAgentReport(input);
      assert.equal(report.needsHost, true);
      assert.equal(report.status, 'blocked');
      assert.equal(report.needsHostReason, 'blocked');
      assert.equal(report.waitingForHost, false);
    });

    it('forces needsHost=true when model provides a question with needsHost=false', () => {
      const input = {
        needsHost: false,
        summary: 'Need confirmation',
        question: 'Should the table be dropped and recreated?'
      };
      const report = normalizeAgentReport(input);
      assert.equal(report.needsHost, true);
      assert.equal(report.needsHostReason, 'question');
      assert.equal(report.waitingForHost, true);
      assert.equal(report.question, 'Should the table be dropped and recreated?');
    });

    it('keeps needsHost=false for harmless success with no changes, blockers, or question', () => {
      const input = {
        needsHost: false,
        summary: 'Read configuration successfully',
        changes: [],
        checks: ['npm test'],
        blockers: [],
        question: null
      };
      const report = normalizeAgentReport(input);
      assert.equal(report.needsHost, false);
      assert.equal(report.needsHostReason, 'none');
      assert.equal(report.waitingForHost, false);
      assert.equal(report.status, 'completed');
    });

    it('treats an answered question as historical without waking the host', () => {
      const report = normalizeAgentReport({
        summary: 'continued after the decision',
        changes: ['src/a.mjs'],
        question: 'Should this use A or B?',
        needsHost: true,
      }, { answeredQuestions: ['Should this use A or B?'] });
      assert.equal(report.question, 'Should this use A or B?');
      assert.equal(report.questionAnswered, true);
      assert.equal(report.waitingForHost, false);
      assert.equal(report.needsHost, false);
      assert.equal(report.needsHostReason, 'changes');
    });

    it('still waits when the worker asks a new question after an earlier reply', () => {
      const report = normalizeAgentReport({
        summary: 'another decision is required',
        question: 'Should this use C or D?',
        needsHost: true,
      }, { answeredQuestions: ['Should this use A or B?'] });
      assert.equal(report.questionAnswered, undefined);
      assert.equal(report.waitingForHost, true);
      assert.equal(report.needsHost, true);
      assert.equal(report.needsHostReason, 'question');
    });
  });

  describe('bounded output', () => {
    it('reduces fields and marks truncated=true when JSON serialization exceeds maxChars', () => {
      const input = {
        summary: 'Summary text '.repeat(100),
        changes: ['file1.js', 'file2.js', 'file3.js'],
        checks: ['check1', 'check2'],
        blockers: []
      };
      const maxChars = 200;
      const report = normalizeAgentReport(input, { maxChars });

      const jsonStr = JSON.stringify(report);
      assert.ok(jsonStr.length <= maxChars, `Expected JSON length <= ${maxChars}, got ${jsonStr.length}`);
      assert.equal(report.truncated, true);
      assert.equal(report.status, 'completed');
      assert.equal(report.needsHost, false);
      assert.equal(report.needsHostReason, 'changes');
      assert.equal(report.waitingForHost, false);
    });

    it('retains status and needsHost under very tight maxChars limits', () => {
      const input = {
        summary: 'Massive output '.repeat(500),
        changes: ['a.js', 'b.js'],
        checks: ['c.js']
      };
      const maxChars = 80;
      const report = normalizeAgentReport(input, { maxChars });

      const jsonStr = JSON.stringify(report);
      assert.ok(jsonStr.length <= maxChars, `Expected JSON length <= ${maxChars}, got ${jsonStr.length}`);
      assert.equal(report.truncated, true);
      assert.ok('status' in report);
      assert.ok('needsHost' in report);
    });

    it('caps individual array items and array length before serialization', () => {
      const longItem = 'X'.repeat(1000);
      const input = {
        summary: 'Test run',
        changes: [longItem]
      };
      const report = normalizeAgentReport(input, { maxChars: 2400 });
      assert.ok(report.changes[0].length <= 300);
      assert.equal(report.truncated, true); // an individual item was clipped
    });
  });
});
