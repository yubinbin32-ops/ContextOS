---
name: contextos
description: MUST be used for non-trivial repository engineering (architecture exploration, multi-file edits, in-session verification, refactoring). For a trivial 1-line edit, use direct change or native tools to avoid fixed context overhead.
---

# ContextOS

Default transport: `contextos({action,args,projectRoot})`.

## Hard gates
- Use OS for non-trivial repository work. Do not replace it with per-file `cat`/`sed`/`rg`, ad-hoc `npm test`, or native `apply_patch` loops.
- If the compact tool is not visible, call `tool_search` once with `ContextOS compact repository tool`; do not call `list_mcp_resources`.
- Load this Skill body once at session start. If it is not already present in context, read it once; never reread it or use shell reads as a recovery loop. Do not call host `update_plan` in an OS-owned task.
- A/B/C launchers must install/enable the plugin and export `CONTEXTOS_HOME` before `codex exec`; do not spend a turn checking it.
- After `decision=complete` or `read_complete=true`, native `apply_patch`, `rg`, `cat`, `sed`, and `npm test` are protocol violations. Use `change`/`work`; a passing verify is final evidence.

## Route work
- Trivial one-line change: one `change({edits,verify})`; skip `explore` and `ship`.
- Complex task: the first OS call must be exactly one `pipeline` containing `explore`, known exact `inspect`, and baseline `verify`; then one `change`/`work` containing all edits, verify, architecture, and ship. Do not open with a standalone `explore`, `inspect`, or `work`. Do not add a directory-wide `inspect` (`paths:["."]`) to the first pipeline; `explore` already returns the map.
- After `change` reports `verified and shipped`, finalize immediately; do not issue another `change` unless a failing check or an unmet requirement is explicitly present.
- A decision packet is final: do not call `resume` or replay raw artifacts. After `read_complete=true`, mutate directly; after `false`, make only the named bounded recovery read.
- Search with `work.search` or pipeline `{tool:"search",args:{query,root|paths}}`; use `maxLogBytes` on noisy commands. Do not place native `sed`/`cat`/`rg`/`npm test` between OS calls.
- `verify.commands` is an array of command strings; pass a top-level `maxLogBytes` when the batch may be noisy.

## Inspection
- Prefer exact `inspect({path,symbol|ranges:[{startLine,endLine}]})`. Explicit ranges are honored exactly; do not ask for a whole file when a slice is enough.
- Use `inspect({paths,budget:"shallow"})` for maps. A multi-file inspect returns outlines and locators.
- Use `budget:"full"` only for one bounded file or symbol. Whole-file replacement belongs in `change`/`work` edit payloads.
- Read a large file once. Do not reconstruct it with many 80-line slices.

## Micro
- Micro is an explicitly assigned out-of-context executor, not the decision maker.
- Health check: `ops({capability:"micro",action:"doctor"})`; it validates URL, model, and key without reading the ops Skill.
- Run shape: `micro({preset:"triage",task:"...",pipeline:{steps:[...]},withOS:true,invocation:{tools:{enabled:true,allowCommands:true},provider:{maxRequests:5}}})`. Do not call `ops.micro.help` before an assigned run.
- Attach bulky evidence to the first Micro call with `pipeline:{steps:[...]}`; do not run a separate pipeline and copy its output.
- Use Micro when raw failure/log evidence exceeds 2,000 characters; not for trivial edits or already triaged evidence.
- Use `delivery:"defer"` or `"auto"` when the host can continue; `"immediate"` only when the next decision depends on it; `"errors-only"` for fire-and-forget.
- Executor validation: set `withOS:true`, `invocation.tools.enabled:true`, `invocation.tools.allowCommands:true`, and enough `provider.maxRequests`; check `providerRequests`, `toolRounds`, `toolCalls`, and `executionMode`.

## Architecture
- Blocks are semantic ownership boundaries; Chains group Blocks; Links express directed relationships.
- Never use `mod-*` or `kind:"module"` as ownership.
- After changing business code, include `architecture.blocks` and `architecture.chains` in the same `change`/`work`. A state-only `change({architecture})` is valid.
- Bind only paths touched by this change; do not enumerate unrelated repository paths. For a bounded repair, one semantic Block for the changed surface plus one Chain is valid; split only for real ownership boundaries.
- Every tracked source path needs exactly one curated Block and at least one Chain membership.
- A failing `verify` blocks `ship` unless `allowUnverified:true`. A blocked architecture contract must not leave partial ownership.
- Compact shape:
```js
architecture:{blocks:[{id,title,kind,paths,summary}],chains:[{id,title,memberIds}]}
```
- Discover with `ops({capability:"architecture",action:"list|open|search"})`; `block.get` and `block.inspect` alias `open`.

## Advanced
Legal capabilities: `os_context`, `plan`, `task`, `block`, `chain`, `architecture`, `code`, `run_command`, `process`, `knowledge`, `session`, `system`, `profile`, `micro`, `artifact`, `telemetry`. Route them through `ops({capability,action,args})`; do not shell-read capability source.
