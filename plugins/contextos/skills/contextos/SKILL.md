---
name: contextos
description: "Required project development scaffold: every development task must read current ContextOS state and use ContextOS for delegation, evidence, commands, edits, architecture, and continuity."
---

# ContextOS

ContextOS is this project's required underlying development scaffold. Every development task starts by reading current OS state, and every source change goes through ContextOS so Block ownership, receipts and cross-session continuity stay current. Native tools are fallbacks.

Single entry point: `contextos({action, args, projectRoot})`. All parameters go inside `args`; `projectRoot` must be an absolute path.

## First contact

With a known exact goal, `ask({onboard:{goal:"<symbol, title, path or Block id>"}})` resolves existing graph IDs/titles/symbols/paths locally and returns project overview, actual owners and verified source in one zero-model call; ambiguity returns candidates instead of guessing.
A path goal resolves to the Block that owns the path, so the source that comes back is that owner's anchors, not the file body; use `ask({inspect:[{path, ranges}]})` when you need the file itself.
`status=partial` is not a failed resolution. Read `partialReason` and `resultStatus` before reacting:
`ambiguous` means no exact graph entity matched and you must narrow the goal; `evidence-capped` means the anchor read hit its bounded limit;
`evidence-gap`, `display-budget` and `source-budget` mean part of the reply was bounded. In every non-ambiguous case recover the saved result by `resultId` (or read a narrower range) instead of re-asking the same question. Matching uses only real IDs, titles, symbols, normalized paths and exact filenames. Onboard defaults to 32000 output characters; a smaller explicit `maxChars` may return partial with the remainder recoverable.

Without a goal, start or resume with `ask({overview:true})`. It returns bounded entries, build/test commands, Block/Chain navigation and current session/plan/task summaries in one local zero-model request, and does not bootstrap architecture.

Repeated calls check freshness, reuse navigation and return a body; a previously returned hash is not context by itself. Read these first instead of spending calls walking the project by hand.

## Roles and scope

- **main thread - brain**: owns the task contract, acceptance criteria, architecture decisions, integration and final judgement. It does not pre-explore or implement work that can be delegated.
- **micro - small brain**: bounded retrieval, summarization, verification, or one small single-file edit. Multi-file implementation belongs to CLI.
- **agent (CLI) - hands**: complex multi-file implementation, refactoring or repair in an isolated workspace. It can call micro and ContextOS itself.
- **change / integrate - the only code mutation paths**. Every source edit goes through one of them so Block ownership and receipts stay current.

Delegation is the default; delegate when possible.

**Context firewall**: main context holds only the task contract, acceptance criteria, dispatch receipts and compact worker reports. Do not ingest source files, logs, diffs or architecture dumps; workers fetch evidence in their own context and return references.

## Tool index

| Need | Call |
| --- | --- |
| Understand a project, or find the entry for a known goal | `ask({onboard:{goal:"<symbol/title/path/id>"}})`; with no goal `ask({overview:true})` |
| Exact source read (no model) | `ask({inspect:[{path, ranges:[[first,last]]}]})` |
| Named graph anchor read (no model) | `ask({blockId})` or `ask({chainId})` |
| Semantic discovery | `ask({request, known?, purpose?})` |
| Recover saved evidence | `ask({resultId, inspect:[{path, ranges}]})` |
| Bounded retrieval/verification or one single-file edit | `micro({prompt, execution, invocation})`; several at once `micro({action:"batch", tasks:[...]})` |
| Execute a command | `command({command, id?, focus?})`, then `command({action:"get", id})` |
| Batch 3+ known independent actions | one `pipeline({mode:"parallel", steps:[{tool, args}, ...]})` |
| Multi-file or open-ended implementation | `agent({task, workspace, execution:"implement", context:{allowedPaths, acceptance, verify}, background:true})` |
| Collect a report-only worker | `agent({action:"wait", jobId, waitMs})`; `integrate` already waits for implementation jobs |
| Merge an isolated diff | `integrate({jobId, verify?})` |
| Edit files | `change({edits:[{path, target, replacement}], verify?})` |
| Plan, task, block, chain, architecture, session, profile, knowledge, usage | `ops({capability, action, args})` |
| Batch Block ownership audit | `ops({capability:"block", action:"owners", args:{paths:[...], format:"json"}})` |
| Role readiness | `ops({capability:"micro", action:"doctor"})` |

`ops` capabilities: `os_context, plan, task, block, chain, architecture, code, run_command, process, knowledge, session, system, profile, micro, artifact, usage, telemetry`.

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

4. **Native tools are the fallback**, for a quick single command or read that needs no OS evidence, architecture or delegation.

## Micro lifecycle

Use `micro({prompt, execution, invocation})`; commands need `invocation.tools.allowCommands:true`, and edits need `execution:"implement"` with `context.allowedPaths`. Use `delivery:"defer"` or `"errors-only"` when no immediate dependency; pending reports surface on the next ContextOS call. Use `"immediate"` when the next step needs the answer.

At 290s micro returns `status:"partial"` plus a retained session and persists `partial`, not `running`. Sessions are retained for follow-up; at most 5 dormant, oldest evicted first. Repeated unchanged reads yield a partial checkpoint; continue with a named gap rather than redispatching. Source mutations and verification reset the no-progress count. Budget exhaustion returns a resumable checkpoint: continue its handle instead of replaying tools.

## CLI lifecycle

**Substitutive flow.** Dispatch in background to an isolated copy, then collect and merge in one call.
The workspace must already exist: create it first with `git -C <projectRoot> worktree add /tmp/<isolated-copy> HEAD`, or copy the tree when the CLI must run npm scripts.
A missing path is rejected before the job starts as `CLI_WORKSPACE_MISSING`, so a typo never becomes a silently failed background job.

```js
contextos({action:"agent", args:{
  task:"<bounded implementation contract with acceptance criteria>",
  workspace:"/tmp/<isolated-copy>",
  execution:"implement",
  context:{allowedPaths:["<files>"], acceptance:["<command>"], verify:["<command>"]},
  background:true
}}, projectRoot)
contextos({action:"integrate", args:{jobId:"<id>", waitMs:280000}}, projectRoot)
```

- `integrate` waits up to 280s and merges in the same call; a separate `agent wait` is a pure status round - use it only for report-only jobs.
- After integrate succeeds, never re-implement the same files; run only remaining project checks.
- A closed window returns `status:"partial"` with `jobStatus`, `window:"expired"`, `doNotRedispatch:true`, `resume` and `continueWith`; resend only that handle, never redispatch or replay. Missing jobs return `status:"missing"`/`JOB_NOT_FOUND`.

**In-place implementation.** Omit `workspace` when the change belongs in the live working tree: dispatch `execution:"implement"` with `context.allowedPaths` and the dispatch records a pre-dispatch snapshot of those paths. `integrate({jobId})` then reviews the real diff (`mode=in-place`) and `integrate({jobId, revert:true})` restores the recorded content byte-for-byte, including removing files the worker created under those paths. Prefer an isolated copy when the worker must run builds or its edits should not touch the live tree.

**One-call delegation.** `pipeline` chains the lifecycle in one round:

```js
contextos({action:"pipeline", args:{continueOnFailure:false, steps:[
  {tool:"agent", args:{task:"<contract>", workspace:"/tmp/<copy>", execution:"implement",
    context:{allowedPaths:["<files>"], acceptance:["<command>"], verify:["<command>"]}, background:true}},
  {tool:"integrate", args:{jobId:"<id from step 1>", waitMs:280000}}
]}}, projectRoot)
```

Step results carry the job id forward: write `{jobId:"<id from step 1>"}` (or the shorter `$step1.jobId`) and the pipeline substitutes the id produced by that completed step before dispatching; an unresolvable reference fails that step instead of sending a literal placeholder to `integrate`. If the pipeline returns a partial handle, resend the same steps with `resume:<handle>` and completed steps are skipped.

**Progress and cancellation.** `get`/`wait` expose stage, last activity, idle/no-progress and `processAlive` separately; an alive process is not proof of development progress. Mailbox operation status `completed` means retrieval completed, while `jobStatus` describes the worker. Use `messages` for communication, not tight polling. Cancellation retains the available report, usage and session identity.

**Session continuity.** Reuse a retained CLI session when the task is continuous and occupancy is below 233k; start a new conversation at 233k or when the task is independent. Keep at most 5 completed sessions.

## Evidence

- `ask({inspect:[{path, ranges}]})` bypasses model calls and reads exact line slices from disk. Batch multiple paths in one call.
- `known: {refs:[{resultId, path, ranges}]}` reuses previously retrieved evidence; unchanged covered source is cited under `reused` and only new or changed ranges are delivered as source. Short `known` text notes give context but do not prove source contents.
- The caller must hold the source marked known. A result ID alone does not deliver source; recover saved coverage with `ask({resultId, inspect:[{path, ranges}]})` without an API request.
- Semantic `ask` seeds from explicit entities or literal graph IDs/titles, not arbitrary behavior. Stale hashes or ranges and missing members are gaps; never substitute source. Anchor lines are hints until verified.
- `maxChars` limits Unicode characters delivered in one call; omitted source appears under `missing` and stays recoverable by result ID and ranges.
- **Read-only preload**: attach `preload` (or `invocation.evidence.pipeline`) with read-only steps, plus `allowCommands:true` when command steps are used. ContextOS runs it inside the micro lifecycle and injects the bounded result into micro instead of the main transcript.

## Commands

Execute once with `command({command, id})`, then retrieve stored output with `command({action:"get", id, ranges?, full?})`; `command({action:"cancel", id})` halts execution and retains captured output. Never rerun a command just to re-read its log. Focus, or failed output beyond `logChars`, can trigger API interpretation and there is no opt-out flag; for deterministic local checks omit `focus` and set a sufficient `logChars` limit.

## Change, verification, and architecture

- `change({edits, create?, delete?, verify?, architecture?})` performs atomic file modifications and runs verification commands.
- `integrate({jobId, verify?, autoRevert?})` applies a completed isolated CLI job's recorded `implementation` metadata, restricts additions/edits/deletions strictly to `allowedPaths`, passes them through `changePipeline`, and rolls back when `autoRevert:true` and verification fails. Replay-safe: a second call on an applied job reports `status=noop changed=0`.
- Every curated code file in scope requires Block ownership. One actual explicit owner (file, symbol or tree binding) is required for each edited curated file; missing or multiple owners block mutation. Never infer owner identity from directories and never create fallback Chains. Audit in one call with `ops({capability:"block", action:"owners", args:{paths:[...], format:"json"}})`.
- Standalone Blocks are valid; Chains are optional feature navigation with linear/feature/leaf/composite kinds. Links connect Blocks only. Unlink by ID or kind removes one relation; legacy endpoint pairs without kind remove all pair relations. Validate source freshness with `ops({capability:"chain", action:"validate", args:{checkSources:true, paths?}})`.
- Architecture orientation goes to `ops`: `block open` returns one Block card (tier, responsibility, upstream/downstream edges with reasons, bound locators) and `chain open` returns the member cards in order plus internal flow, so one call explains a feature end to end. Use `ask({blockId|chainId})` when you need the bound source, not for orientation.
- Architecture reads (`os_context` brief, `block` and `chain` reads) get their own bounded budget of 6000 characters instead of the compact ops budget, so one orientation call returns the whole outline rather than a clipped head. For a pathologically large Chain, pass `full:true` inside its `args` (or reuse the returned artifact) instead of re-reading members one by one.
- Read and update architecture through `ops({capability:"architecture"|"block"|"chain"})`.

## Plan, task, session continuity

- `ops({capability:"session", action:"status"})` exposes intent, touched files, recent receipts and milestones.
- `ops({capability:"plan"})` and `ops({capability:"task"})` hold the long-term breakdown across turns; read them before starting work and update them as tasks move.
- `.contextos/blackboard.md` is rendered from session state on every save; read session state through `ops` rather than maintaining parallel tracking documents.
- State under `.contextos` is runtime-managed; read it through `ops`, not by opening or editing its files.

## Doctor checks

`ops({capability:"micro", action:"doctor"})` is an offline local readiness check. `unknown; not probed` for `authentication`, `task_analyze` or `task_implement` is normal and does not block micro delegation. As long as `endpoint`, `configured_model` and `credential_source` are set, dispatch micro normally. Run live probes with `probe:true` only on explicit request.

## Configuration and installation

Provider/model/key switching, credential debugging, CLI adapter installation, OS MCP registration, skill installation, permission preconfiguration and deeper diagnostics live in the sibling `contextos-ops` skill (`contextos-ops/SKILL.md`), which is installed alongside this one.
