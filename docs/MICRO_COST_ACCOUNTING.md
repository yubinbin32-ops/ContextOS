# Micro token and personal cost accounting

Record three separate quantities: raw tokens across all models, the host's peak request input, and a personal cost estimate. A lower host context does not prove lower total tokens or a lower bill.

For the user's relative-price assumption `micro.cost.tokenDivisor=7`:

```
rawTaskTokens = mainModelTokens + sum(allMicroTokens)
mainEquivalentTokens = mainModelTokens + sum(allMicroTokens / 7)
equivalentSavings = 1 - mainEquivalentTokens / matchedNativeTokens
```

The divisor defaults to 1 and is configurable. It is an assumed relative token price, not a verified subscription price or actual invoice. Do not pool this estimate into public raw-token savings. Both API/Key and CLI usage use the same estimate. Failed, denied, timed-out and retried work stays in the task total. Missing usage makes the total incomplete, never zero.

AGY 1.2.14 reports cache reads outside `input_tokens`. Its current adapter therefore uses `inputIncludesCache:false`; normalized prompt tokens are input plus cache reads. `thinking_tokens` are already included in `output_tokens`, so reasoning is recorded but not added again. Only a terminal report is charged; progress/cumulative snapshots are not summed as separate calls. Resumed usage needs verified invocation/session semantics and a bound baseline.

CLI terminal usage does not establish the actual provider request count, per-request context peak or billed amount. Those remain unavailable unless the provider's trace supplies them. A terminal-only token limit is checked after execution; timeout and output caps can stop work during execution.

Configure both transports without removing either:

```json
{
  "micro": {
    "priority": "cli-first",
    "cost": { "tokenDivisor": 7 },
    "api": { "url": "https://your-endpoint.example/v1", "model": "your-api-model" },
    "cli": { "command": "your-installed-cli", "model": "your-cli-model" }
  }
}
```

This fragment illustrates routing and accounting; an actual CLI also needs its AI-generated argv, input/output, status and usage mappings. Switch priority to `api-first`, or pin `provider` for one call. Priority chooses a configured transport before execution. A started task's error never silently triggers another provider and another charge. Keep keys in private configuration.

Current live verification: the exact Flash/high AGY model completed a bounded source-read/calculation task in 20.9 seconds, using 34,779 raw tokens (4,968.43 equivalent under /7). Two subsequent implementation attempts were denied before producing any edits: 174,308 and 71,706 tokens. These failures are retained. The implementation transport and isolation contract exist, but this AGY setup has not passed a real implementation acceptance test. No complete-task Micro savings are established.

`telemetry.audit` returns raw-token savings and `personalCostEstimate` separately. An incomplete host/Micro ledger leaves the equivalent total and saving percentage unavailable. This audit describes the recorded session; complete-task evaluation must also import all primary provider calls and all workers. [Retained CLI engineering diagnostics](benchmarks/2026-10-01-micro-refactor.json).
