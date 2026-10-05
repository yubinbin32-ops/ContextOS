# Historical plan-dependency workflow comparison

This record covers the 2026-10-04 real feature comparison starting at commit `0dd6431`: plan dependency add/remove/list, persistence, validation, MCP routing, and tests. Each arm used a fresh main conversation and an isolated worktree. The earlier public summary is recorded at commit `4706c38`; the data here comes from that same experiment, not a later rerun.

| Arm | Workflow | Peak main input tokens | Tests passed |
| --- | --- | ---: | ---: |
| A | Native tools | 234,174 | 778 / 778 |
| B | OS only, no assistant | 184,507 | unknown |
| C | OS + API Micro | 145,694 | 778 / 778 |
| D | OS + API Micro + CLI | 84,681 | 781 / 781 |

A/C/D test counts come from the historical README's functional acceptance summary, separately from the token usage audit. B's test count is unavailable.

## Reproduce

From the repository root:

```sh
python3 docs/benchmarks/plan-dependencies/recalculate.py --check
```

The script uses only the Python standard library and exact rational arithmetic. It checks response-ID deduplication, receipt deduplication, unique cumulative usage states, sums against recorded totals, main context peaks from both unique response usage and per-request last usage, generated CSV contents, and frozen SHA-256 hashes. It prints each role's base USD and equivalent USD, plus all four arms' observed physical raw tokens, equivalent raw tokens, equivalent USD and reductions. CSV values are rounded to 12 decimal places only after calculation.

## Published evidence

- [historical-usage.json](historical-usage.json): allowlisted original usage fields, per-response Main records, per-receipt Micro records, per-event CLI records, metadata, coverage, and SHA-256 hashes of the original audit files.
- [usage-by-role.csv](usage-by-role.csv): input, cached input, uncached input, output, reasoning, raw tokens, base USD, divisor, equivalent USD, and coverage for every role actually used.
- [comparison.csv](comparison.csv): four-arm totals, physical and equivalent raw tokens, equivalent USD, context peaks and percentage reductions.
- [recalculate.py](recalculate.py): deterministic verifier and calculator.
- [SHA256SUMS](SHA256SUMS): integrity hashes for the published evidence and calculator.

Original audit hashes refer to the privately retained metadata/usage-only source files. They identify the source snapshots; this public bundle omits absolute source paths, working directories, prompts, tool arguments, credentials and provider configuration. Public file hashes can be checked entirely from this directory without access to those private files.

## Counting and specified cost model

`raw = input + output`. Cached input is already included in input, so `uncached = input - cached`. Reasoning output is already included in output and is never added again.

`equivalent tokens = main raw + (Micro raw + CLI raw) / 7`

The user-specified USD comparison rates per million tokens are $2 for uncached input, $0.10 for cached input, and $10 for output:

`base USD = (uncached input × 2 + cached input × 0.1 + output × 10) / 1,000,000`

`equivalent USD = main base USD + (Micro base USD + CLI base USD) / 7`

These are **equivalent consumption and cost under a specified model**, not provider invoices, actual billing discounts, or a claim about official rates. The assistant divisor is a chosen comparison assumption even though the recorded roles share the reported model alias.

Main sessions report `deepseek-v4.1-flash` with `max` reasoning effort and a custom provider. Their unique provider response IDs sum exactly to terminal cumulative usage. Micro C and D retain `lastModel: deepseek-v4.1-flash`; a response-resolved underlying model is unavailable. D CLI reports the same alias and custom provider; 51 unique cumulative states produce a last-usage sum equal to terminal usage. An alias is evidence of what was reported, not independent verification of backend model identity.

## Coverage and limits

C Micro has two unique receipts covering all 26 started requests with provider-reported usage. D Micro has five unique receipts, 129 started requests, and 128 usage-bearing responses. One continuation timeout request has unknown usage. D's Micro raw 3,258,709, combined raw 9,461,393 and equivalent USD 0.790090114286 are **observed subtotals**; the unavailable request is never assigned zero. Its 51.3% equivalent USD reduction therefore describes only reported usage.

Original Micro reasoning fields are unavailable and remain `null` in JSON and `unknown` in CSV; they are not filled with zero. Main and CLI reasoning totals are preserved as subsets of output.

Under the specified model, A/B/C/D equivalent USD is 1.623055600000 / 1.315797600000 / 1.413765028571 / 0.790090114286. C equivalent raw is 5,098,070.857142857143; D is 2,902,684.142857142857. The full workflow has more observed physical raw tokens than native tools, while its peak main context is 63.8% lower. OS only is less expensive than OS + Micro in this run. Results describe one task and are not general performance guarantees or a provider ranking.
