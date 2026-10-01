# Real development qualification — 2.7.2 candidate

**Performance qualification is pending.** Candidate10 completed all three matched tasks but failed the declared gates: the cross-file repair used 73.19% fewer total tokens, the small repair 1.31% fewer, and the long session 10.90% more. Median total-token reduction was 1.31%; peak-input reduction was 3.57%. [The complete candidate10 comparison](benchmarks/2026-10-01-candidate10-comparison.json) remains public. The new lean/API+CLI refactor is a different candidate and has not inherited those results. Functional checks and token/context qualification are reported separately.

## What is being tested

ContextOS returns focused source, keeps full logs on disk, and combines an edit with verification. Its local receipts can reduce conversation traffic. A narrower tool response alone does not prove a cheaper completed task.

The frozen candidate is tested with `gpt-6-luna` and reasoning `max`, serially, using Codex CLI 0.159.2 and the same ChatGPT HTTP provider. No stronger model, subagent, web search, or optional Micro executor is used. Six fresh agent runs cover three matched tasks on two repositories. Both arms receive the same source snapshot, task text, applicable instruction preflight, and independent completion tests.

The small Python task uses ordinary tools under the adaptive skill rule. The two larger tasks explicitly request focused ContextOS work when that tool is exposed; the native arm receives the same conditional instruction. This is an instructed workflow comparison, not a claim that every agent automatically picks the cheapest tool.

For the ContextOS tasks, both business workspaces start from v2.7.1 and receive the same frozen candidate bundle/version metadata. The buggy scoped source remains the repair target; the input-tree hash must match within each pair. These self-repository tasks are familiar defects, not evidence of generalization to arbitrary repositories. The second repository is tested from a source-only archive with saved OS state removed; its name and source are withheld.

## Accounting and quality

- Every completed response uses primary provider `input_tokens`, cached input, output, and reasoning counts. Provider totals must reconcile with the CLI completion totals; the actual model must match the configured model.
- Total tokens = input + output. Cached tokens remain part of context and total token counts. Uncached input = input − cached input. These values are not currency or an API bill.
- Peak context is the largest recorded request input, with the trace's reported 258,400-token window as denominator. It does not measure every hidden server-side prompt component.
- A run must finish normally, stay within the allowed source/test scope, pass an independent grader, and add a regression that fails on the prepared buggy seed and passes on the repair. Partial counts are lower bounds and never task-savings estimates.
- Install repair has six independent cases; ownership refresh has three; JSON alignment has thirteen. The follow-up installer JSON feature has three further independent fixture checks and must preserve the initial six-case repair.
- The long task resumes the same Codex thread after its first repair. Both arms set `model_auto_compact_token_limit=32000`; a trace must record real compaction and the follow-up must pass. This tests controlled context pressure and continuation, not exhaustion of the full natural window.
- Installation/preparation and this engineering conversation are outside the agent-run usage totals. Optimization itself has a cost; diagnostic campaign usage is published separately.

## Predeclared gates

At least three completed matched pairs; one frozen candidate; three task types and two repositories; total-token median reduction ≥20%; peak-input median reduction ≥10%; median uncached input must not increase; no pair may increase total tokens by more than 10%; observed compaction and independent resume validation. Failed or interrupted groups in the frozen campaign remain part of the qualification decision.

## Defects repaired before freezing

- Search stays in requested paths; optional `contextLines` returns merged nearby source in the same work call. Precise symbols and line ranges survive batched inspection.
- Focused work returns bounded source bodies instead of forcing another artifact read. A clipped body remains an incomplete read.
- Search matches, outlines, missing symbols and failed baselines no longer declare `read_complete=true`.
- Mutation outcomes are structured: rejected, applied, verified or reverted. A blocked edit names the correction; aliases such as oldText/newText are supported.
- Scoped ownership refresh preserves untouched references and Chain membership while dropping stale edited symbols. Legacy full replacement remains available.
- `doctor` can diagnose invalid saved graphs before service startup, without deleting blocks or weakening the real-source anchor rule.
- Installation checks all canonical parser runtime and grammar bytes, without writing during a check.
- The lean tool schema has three public fields; the shorter skill skips extra setup for small single-function repairs. Known instructions and source are not repeatedly rediscovered.
- Evaluation processes disable Micro, verify primary accounting, stop repeated semantic rejection, cap requests/tokens/time, and remove temporary authentication copies.

## Reproduce without paid model calls

```bash
npm ci
npm test
npm run plugin:verify
npm run dist:smoke
npm run acceptance:real
```

The evaluation-contract GitHub workflow runs budgets, accounting, recovery, evidence and synthetic transport tests without a model. Synthetic fixture counts are never presented as real token savings.

For paid agent runs, inspect `scripts/benchmark-development.py --help` and the published frozen protocol. Use fresh output directories, `--model gpt-6-luna --effort max`, an execution CLI ≥0.159.2, and a cumulative ledger. The private Python fixture is not distributable; supply a repository with the corresponding known task or adapt the registry and independently validate your replacement. Replacing a task creates a new experiment.

## Limits and next improvements

Small samples are sensitive to agent decisions and provider cache hits. A tiny edit can cost more even after fallback; scoped source reads can accumulate if the agent repeatedly searches instead of batching the owner and tests. Additional independent repositories and repeated fresh pairs are needed before claiming a typical percentage. Follow-up work should target extra discovery turns, recovery after interruption, and host-specific installation behavior while preserving completion quality.

Historical response-only measurements remain in [BENCHMARK.md](BENCHMARK.md). The released 2.7.1 interrupted pilot remains in [REAL_DEVELOPMENT_BENCHMARK.md](REAL_DEVELOPMENT_BENCHMARK.md). All later diagnostic results, including increases and interruptions, accompany this report; they are not pooled across changed candidates into a promotional savings figure.

## Frozen candidate

```json
{
  "version": "2.7.2",
  "bundleSha256": "37596a491c59efeefcfc482fbf17f8b9521d333a5404cd244f0dd59db50f57dc",
  "skillSha256": "c637b5ba97a61d73e0e3e9ce1f2fed087e3535f689d064ca70b90b2c70cebd9c"
}
```

[Protocol](benchmarks/2026-10-01-protocol.json) · [Primary usage and diagnostic history](benchmarks/2026-10-01-development.json)
