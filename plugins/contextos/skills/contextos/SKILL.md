---
name: contextos
description: "Required project development scaffold: every development task must read current ContextOS state and use ContextOS for delegation, evidence, commands, edits, architecture, and continuity."
---

# ContextOS

ContextOS is this project's required underlying development scaffold. Every development task starts by reading current OS state, and every source change goes through ContextOS so Block ownership, receipts and cross-session continuity stay current. Native tools are fallbacks.

Single entry point: `contextos({action, args, projectRoot})`. All parameters go inside `args`.

## Operating model

- **main thread - brain**: owns the task contract, acceptance criteria, architecture decisions, integration and final judgement. It does not pre-explore or implement work that can be delegated.
- **micro - small brain**: bounded retrieval, summarization, verification, or one small single-file edit. Multi-file implementation belongs to CLI.
- **agent (CLI) - hands**: complex multi-file implementation, refactoring or repair in an isolated workspace. It can call micro and ContextOS itself.
- **change / integrate - the only code mutation paths**. Every source edit goes through one of them so Block ownership and receipts stay current.

Delegation is the default; delegate when possible.

## Hard rules

1. **Route diagnosis by scope.** Bounded diagnosis/retrieval belongs to micro; multi-file implementation and open-ended repair belong to CLI. A micro task must state its goal, evidence, allowed operations, return format, and stop condition.
2. **Code changes go through change or integrate.** The main thread never writes project files with native tools.
3. **Use one pipeline as the default batch.** For 3+ independent reads, searches, commands, or edits, use one parallel pipeline call. It returns full step results; do not habitually split the work across pipeline or single calls.

```js
contextos({action:"pipeline",args:{mode:"parallel",steps:[
  {tool:"ask",args:{inspect:[{path:"a.mjs",ranges:[[1,80]]}]}},
  {tool:"command",args:{command:"rg -n foo src",id:"find"}},
]}},projectRoot)
```
```
4. **Native tools are the fallback**, for a quick single command or read that needs no OS evidence, architecture or delegation. They are not the path for exploration or diagnosis.

## Context firewall

Main context holds only the task contract, acceptance criteria, dispatch receipts and compact worker reports. Do not ingest source files, logs, diffs or architecture dumps; workers fetch evidence in their own context and return references.

## Delegation lifecycle

**micro** - one compact report for bounded retrieval, summarization, verification, or one small single-file edit; multi-file work is CLI.

```js
contextos({action:"micro", args:{
  prompt:"Locate the pipeline entry points, persistence helpers and architecture owners. Return file:line references and risks only.",
  execution:"analyze",
  invocation:{tools:{enabled:true, allowCommands:true}}
}}, projectRoot)
```

Micro sessions are retained for follow-up; at most 5 dormant, oldest evicted first.

Use `delivery:"defer"` (or `"errors-only"`) when you do not need the result this turn: the call returns once queued and the pending report surfaces on your next ContextOS call. Use `delivery:"immediate"` only when the next step depends on the answer.

- At 290s Micro returns `status:"partial"` and a session handle; continue that session instead of restarting.

**CLI** - dispatch in the background, then collect with one bounded wait:

```js
contextos({action:"agent", args:{
  task:"<bounded implementation contract with acceptance criteria>",
  workspace:"/tmp/<isolated-copy>",
  execution:"implement",
  context:{allowedPaths:["<files>"], acceptance:["<command>"], verify:["<command>"]},
  background:true
}}, projectRoot)
```

```js
contextos({action:"agent", args:{action:"wait", jobId:"<id>", waitMs:290000}}, projectRoot)
contextos({action:"integrate", args:{jobId:"<id>"}}, projectRoot)
```

- A 290s wait or pipeline returns `status:"partial"` plus a resume handle. Resend only that handle or remaining steps to refresh the window; never redispatch a running job or replay completed steps.
- After integrate succeeds, never re-implement the same files; review the report and run only the remaining project-level checks.
- Reuse a retained CLI session when work is continuous and occupancy is below 233k; otherwise start a new conversation. Keep at most 5 completed sessions.

**One-call delegation.** `pipeline` chains the whole lifecycle in one round:

```js
contextos({action:"pipeline", args:{continueOnFailure:false, steps:[
  {tool:"agent", args:{task:"<contract>", workspace:"/tmp/<copy>", execution:"implement",
    context:{allowedPaths:["<files>"], acceptance:["<command>"], verify:["<command>"]}, background:true}},
  {tool:"agent", args:{action:"wait", jobId:"<id from step 1>", waitMs:240000}},
  {tool:"integrate", args:{jobId:"<id from step 1>"}}
]}}, projectRoot)
```

Step results carry the job id forward; read it from step 1 rather than inventing one. If wait returns a running snapshot, rerun only the wait and integrate steps - never re-dispatch a running job.

## Tool guide

| Need | Call |
| --- | --- |
| Exact source read | `ask` with `inspect:[{path, ranges:[[first,last]]}]` - deterministic, no model request |
| Semantic discovery | `ask` with `request`, optional `known`, `purpose` |
| Bounded retrieval/verification or one single-file edit | `micro({prompt, execution, invocation})`, or `pipeline` steps with `{ops:{capability:"micro",...}}` |
| Execute a command | `command({command, focus})`, then `command({action:"get", id})` for its saved output |
| Batch 3+ known independent actions | One `pipeline` call, often parallel, returns full step results. |
| Multi-file or open-ended implementation | `agent({task, workspace, execution:"implement", context:{allowedPaths, acceptance, verify}, background:true})` |
| Collect a worker | `agent({action:"wait", jobId, waitMs})` |
| Merge an isolated diff | `integrate({jobId, verify?})` |
| Edit files | `change({edits:[{path, target, replacement}], verify})` |
| Plan, task, block, chain, architecture, session | `ops({capability, action, args})` |
| Role readiness | `ops({capability:"micro", action:"doctor"})` |

## Architecture

Every curated code file requires Block ownership. Read and update architecture through `ops({capability:"architecture"|"block"|"chain"})`; never read or edit `.contextos/graph.json` directly. `change` and `integrate` bind Blocks for the paths they touch.

## Plan, task and continuity

- `ops({capability:"session", action:"status"})` exposes intent, touched files, recent receipts and milestones.
- `ops({capability:"plan"})` and `ops({capability:"task"})` hold the long-term breakdown across turns; read them before starting work and update them as tasks move.
- State under `.contextos` is runtime-managed; read it through `ops`, not by opening files.
