---
name: contextos
description: Use ContextOS to inspect, change, verify, and retain repository work with bounded output and semantic architecture ownership.
---

# ContextOS

Default: call the single compact `contextos` transport with `action` `explore|inspect|work|change|verify|ship|pipeline|ops`. Named tools are compatibility-only when `CONTEXTOS_LEAN_SURFACE=0`; never add a host turn to translate. Choose the smallest action that resolves uncertainty; optimize replay and host turns, not call count.

## Route work

- Unknown target: make one bounded `explore` or `inspect`; reuse its paths, symbols, artifacts, and receipts. Unchanged reads/searches are memoized. Use `refresh:true` or `dedupeReads:false` only when external state actually changed or a fresh replay is required.
- Known symbol/path: use `inspect` with `{path,symbol}` or a narrow range. Do not read a whole file when one declaration or range answers the question.
- Known edit: make the first executable call a `work` or `change`; combine only the needed search/inspect, edits, architecture, and verification. A focused task normally needs one discovery, one mutation, and one closure.
- Use `pipeline` for real independent or dependent batches. Nest each action's arguments; do not split one known job into per-step host calls or hide unrelated work in a batch. Parallel fan-out is bounded at four concurrent actions by default (hard maximum eight); use `parallelConcurrency` only to tune one known batch.
- Default responses are summaries, receipts, and artifact references. Read an artifact once when a result says `artifact=<id>`; request `full:true` only for a small, deliberate slice. Never replay raw logs or source bodies just to rediscover a result.
- After a failure, read its receipt/diagnostic before retrying. After PASS, reuse the receipt while the workspace fingerprint is unchanged. A convergence hint means stop discovery and mutate, verify, or run the dependent Pipeline.
- `work` can search/inspect before edits and verify afterward; trust `done: verified` and do not rerun the same command. Use `ship` only for final closure.

For lower-level work use `ops` with explicit `capability:` and `action:`; consult [references/capabilities.md](references/capabilities.md) for exact Plan, Task, Block, Chain, artifact, telemetry, and Micro payloads. Do not enumerate capabilities for a routine edit.

## Plans and Tasks

Use a Plan/Task only when progress, decisions, rules, ownership, or evidence must survive phases or turns. `plan.list` is a compact index; open one plan/task when resuming. `task.start` activates/resumes it; use `{id}`, not a guessed `taskId`. A one-turn edit needs no bookkeeping.

## Block and Chain ownership

A Block is a curated semantic code boundary; a Chain groups Blocks into a meaningful flow; a Link is a directed relationship.

- `ModuleIndex` and `mod-*` values are navigation hints only. They never establish semantic ownership, and `ship` must not create semantic Blocks from them.
- Use one stable curated Block for a coherent subsystem, not one Block per file. A changed live file must have exactly one curated owner and, for strict closure, membership in at least one Chain.
- For new/unowned code, put all known `architecture.blocks` and `architecture.chains` in the same `work`/`change` request. `block.bind_auto` anchors the developer-chosen semantic id; it does not invent ownership. `chain.compose` adds membership; `chain.link` does not.
- If several graph facts are needed, make one bounded parallel Pipeline for `block.list`, `chain.list`, `chain.validate`, and `os_context.brief`; do not spend one host call per read or per Block. Use direct `ops` writes only for a missing/failed edge.
- Normal `ship` reports architecture gaps; strict `ship` blocks. Never satisfy a gap with `kind:"module"` or a `mod-*` id.

## Micro

Micro is conditional delegation for bulky evidence, noisy logs, or relationship synthesis—not a default route for small edits or verification. Keep exact edits and verification in OS.

- Attach read-only evidence directly to the first Micro call: `pipeline:{steps:[...]}` or `preload`. OS runs it once, stores the raw result as an artifact, and injects only bounded evidence. Do not call Pipeline separately and copy its output into Micro or the host.
- Make evidence surgical: a failure receipt plus exact symbols/ranges, normally 1,800–2,400 chars. Multi-step attached Pipelines partition that budget across child outputs; explicit child caps are preferred, and an oversized step returns deliberate `TRUNCATED`. Commands require `allowCommands:true`; preload rejects mutation, nested Micro, and nested Pipeline.
- Prefer one provider request with tools disabled: `invocation:{evidence:{mode:"pipeline",maxChars:2400},provider:{maxRequests:1},tools:{enabled:false}}`. Narrow after `TRUNCATED`, empty, or budget failure; do not repeat the same oversized call.
- For independent Micro tasks, use one `ops({ capability:"micro", action:"batch", args:{ tasks } })` call. Batch preloads and provider requests are concurrency-bounded (4 by default, hard maximum 8); use `maxConcurrency` only to tune scheduling, not to create separate host rounds. If tasks share evidence, prefer one attached Pipeline instead of a batch of duplicate reads.
- Use `inputRef`, `inputArtifact`, or `inputReceipt` instead of copying bulk text. `withOS:true` is only for additional bounded reads or an explicitly assigned curated Block bind/additive Chain compose; it does not grant code edits, shell, delete, or member replacement.
- Choose delivery deliberately: `immediate` when the next decision depends on the answer; `defer`/`auto` when the host can continue; `errors-only` for assigned Block/Chain writes. Deferred results are stored and recovered once with the next OS response—do not poll `micro get/list`; close a session when its objective ends. For immediate persistent startup, pass `runFirst:true` with the first `task` and attached `pipeline` in `sessionAction:"create"`; this combines preload, provider turn, and delivery in one host round. Omit it only when phases intentionally differ.
- Put read-only Micro evidence before the implementation decision. After a successful mutation plus verification, a new read-only attached Pipeline is treated as late replay and is skipped by default; set `allowLate:true` only for an intentional post-verify audit.
- `defer` changes visibility, not provider cost. Read actual `providerUsage`, not estimates, and use `telemetry.audit` for A/B/C; host metrics exclude internal Pipeline work. Reuse cached read-only preload evidence until the workspace changes.

## Completion

Close only after the requested behavior, verification, and relevant architecture/evidence gates pass. Never treat an empty verification list as PASS. Report unresolved failures and retain their receipt or artifact id.
