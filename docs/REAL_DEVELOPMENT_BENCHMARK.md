# Real development pilot: usage, quality, and failed runs

2026-09-30 · `gpt-6-luna`, reasoning `max` · macOS arm64 · Codex execution CLI 0.159.2.

**This pilot has not established complete-task token savings.** The native agent completed the repair and passed the independent grader. Both ContextOS runs were stopped without a code change. These negative results guide the fixes below; smaller partial counts are not a successful-task improvement.

## Actual task and controls

The task repairs a real 2.7.1 installer defect: `--check` accepted missing or stale canonical runtime WASM and grammar assets. The agent must reject each corrupted asset, identify its path, preserve read-only behavior and existing registration checks, add meaningful regressions, and run installer tests. The full prompt, its SHA-256, plugin fingerprints, per-request numeric accounting and all quality checks are in [the sanitized JSON](benchmarks/2026-09-30-development.json).

All three runs started from commit `8c1500a98ca4be8d43d318521e6dd41ec423001e` (`v2.7.1`), with identical prompt SHA-256 `2da47ff593abb9e1bedb9f71c0a3c3b709bf3e3176bc96335c6fe50e39170276`. Each had a fresh Git snapshot and isolated Codex home, the same dependencies/model/reasoning setting, and no delegation or web search. Native had no installed plugins. OS was installed, enabled and checked before execution; its local MCP tool was explicitly approved in the isolated home. The candidate's plugin code and skill differed from the released plugin and are identified by separate hashes. It retained the manifest version 2.7.1 and was an **unpublished development candidate**, not the released artifact.

An independent fixed grader, outside the agent workspace, corrupts or removes the runtime WASM and Python/JavaScript grammars: six cases. It checks failure status, the affected path, unchanged asset bytes and registration, then verifies installation repairs the asset and `--check` passes. The agent's own tests cannot redefine this grader. Native changed only the installer and its test file; both stopped OS runs changed no business files.

## Recorded results

| Run | Completion / independent checks | Requests | Input, including cached | Cached input | Uncached input | Output, including reasoning | Peak request input / window | Seconds |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| Native | Complete, 6/6 pass | 9 | 190,287 | 162,560 | 27,727 | 6,444 | 28,659 / 258,400 (11.09%) | 206.83 |
| Released ContextOS 2.7.1 | Manually stopped, 0/6 pass | 13 | ≥402,770 | ≥359,168 | 43,602 recorded | ≥17,106 | 45,578 recorded (17.64%) | 576.61 |
| Candidate 1 | Output budget stop, 0/6 pass | 7 | ≥175,789 | ≥138,496 | 37,293 recorded | ≥13,088 | 39,606 recorded (15.33%) | 297.42 |

The released-plugin diagnostic was stopped after a cost regression; its final trace contains 13 responses, including a response recorded around interruption. It did not have the candidate's predeclared controller limits. Candidate 1 used 12 requests / 300,000 input / 12,000 output / 600 seconds, checked between recorded responses; its last response overshot the output cap. Interrupted values are **observed partial usage**, and may omit an in-flight request. Neither stopped run has reconciled final accounting or a valid completed-task comparison.

For the completed native arm, per-response rollout usage reconciles exactly with the CLI's `turn.completed.usage`. Request IDs deduplicate repeated snapshots. Cached input is already included in input; reasoning tokens are already included in output. These are provider usage records, not a dollar bill. [Codex JSON event documentation](https://learn.chatgpt.com/docs/non-interactive-mode) and [usage accounting definitions](https://developers.openai.com/api/docs/guides/agents-api/observability).

“Peak request input / window” divides the largest recorded input by the model context window reported in the rollout. It measures submitted input occupancy, excludes the current generated response, and is not the desktop app's context indicator. No compaction records appeared. This small task used at most 17.64% of the reported window; **long-session compaction, resumed work and large-repository behavior remain untested**.

## What failed and what changed

| Observed defect / failure | Repair and evidence |
| --- | --- |
| Compact search ignored `args.query` or lost known file scopes | Query/path normalization preserves scoped searches; real MCP tests exclude unrelated file matches and implicit outline reads. |
| First exploration lost known inspection paths and appended a full-suite baseline after focused checks | Known paths propagate into exploration; explicit focused test/check commands satisfy the baseline. Regression captures the actual commands. |
| Complete exploration could suppress an explicit inspection of a different symbol in the same file | Explicit symbol/range requests are retained. A large-file alpha/beta regression requires the requested beta body. |
| Agents queried full Blocks and Chains to reconstruct ownership | Exploration carries a compact ownership receipt from the already-read graph. Regression requires an existing owner and Chain. |
| Released OS attempted an architecture transaction without required `paths` | The skill includes a complete scoped pipeline and architecture example. This is guidance, not proof of model compliance. |
| Candidate invented new owners, then issued two graph opens to recover | **After the model pilot**, architecture rejection now returns owner id/title/kind/Chain IDs and instructs an immediate retry. A real MCP regression retries successfully using only that receipt. |
| Candidate used `oldText/newText`, which the edit interface rejected | **After the model pilot**, exact-edit aliases are accepted, including an empty new value. The MCP retry regression verifies the resulting bytes and passing check. |
| Later scoped updates erased ownership of untouched files in the same Block | **After the pilot**, scoped refresh preserves other paths and removes stale symbols only in parsed paths. The regression fails on released 2.7.1 and passes after repair, including explicit and automatic refresh; complete ownership replacement retains its existing semantics. |
| Canonical parser integrity was not checked | Reviewed and adopted the valid native repair; the main source checks missing/stale runtime and every shipped grammar without writing during `--check`. Installer regressions and the independent six-case grader verify it. |

Five selected pre-candidate regressions failed on the archived 2.7.1 implementation and pass after repair. The final edit-recovery and ownership fixes have deterministic MCP/orchestrator coverage but **have not been rerun with a paid model**. The candidate's partial input count therefore cannot establish savings from them. The older [response-text benchmark](BENCHMARK.md) remains useful for isolated reads/logs; its 2,504-token fixed cost describes the released skill, not this expanded candidate skill.

## Final candidate verification

All **408 tests passed**, with zero failures or skips. Plugin smoke, skill validation and the independent six-case installer grader passed. The final skill is 6,792 characters, below the enforced 7,000-character limit. Final bundle/skill SHA-256 values are in the JSON under `postCandidateRepairs`; they differ from Candidate 1 and have not been evaluated by another model run.

## Reproduce within an explicit budget

This runner invokes Codex and consumes model usage. It defaults to `gpt-6-luna` / `max`, one pair, and the bounds above. It makes no additional agent calls for grading. Use a fresh output directory; raw events and isolated homes stay under the ignored `.contextos/benchmarks/` directory. Copied authentication is removed after each run.

```bash
npm ci
npm run plugin:build
python3 scripts/benchmark-development.py --help
python3 scripts/benchmark-development.py --chatgpt-http
```

`--chatgpt-http` selects the HTTP/SSE route used on this host. Omit it for the default configured provider route. `--codex` chooses the execution CLI; `--setup-codex` chooses a plugin-capable setup CLI (0.150.1 was used here because catalog discovery stalled with the newer CLI). The bug seed defaults to `v2.7.1`; `--plugin` selects the built candidate. The runner alternates AB/BA across `--pairs`, stops on its budgets, writes each patch and private trace, grades independently and reconciles accounting. `validForComparison` requires completion, accounting agreement, quality, scope and actual OS use for the OS arm.

The next useful experiment is one capped pair after the recovery fixes. A successful pair should then be repeated on another repository and a longer task, tracking completion, uncached input, output/reasoning, peak input and compaction. Publish failures alongside successes; establish quality before claiming any reduction or raising run budgets.
