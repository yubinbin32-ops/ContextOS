# ContextOS capability reference

ContextOS is the required underlying development scaffold for this project. Every development task must read the current OS state and use ContextOS as the primary path for evidence, commands, edits, architecture, and progress; native tools are fallbacks for operations ContextOS cannot perform.

Single entry point: `contextos({action, args, projectRoot})` with an absolute workspace root. Operation arguments go inside `args`.

## Capability summary

| Need | Action and arguments | Result |
| --- | --- | --- |
| Exact source inspection | `ask` with `inspect: [{path, ranges: [[first, last]]}]` | Deterministic source read without an API request. Batch multiple paths in one call. |
| Semantic code discovery | `ask` with `request`, optional `known`, `purpose` | API Micro locates relevant evidence; returns paths, line ranges, and content hashes. |
| Run bounded micro task | `ops` with `capability: "micro"`, `action: "run"`, `args: {prompt, execution, invocation}` | API Micro runs its own bounded tool loop and returns one compact report. Use `action: "batch"` to run several bounded tasks together. |
| Recover saved evidence | `ask` with `resultId`, optional `inspect` | Current source from saved coverage; verifies file versions and reports changes. |
| Execute bounded command | `command` with `command`, optional `id`, `focus`, `background` | One execution with durable local log receipts; long process output stays off the host. |
| Recover command output | `command` with `action: "get"`, `id`, optional `ranges`, `full` | Saved output from earlier execution without re-running the command. |
| Stop command | `command` with `action: "cancel"`, `id` | Halts execution and retains captured output. |
| Batch steps | `pipeline` with `steps` or `parallel` using `inspect`, `change`, `verify`, `command`, `run` | Default container for 3+ known independent actions; one parallel call may run many actions and returns full step results. |
| Delegate CLI task | `agent` with `task`, `workspace`, `context`, `background` | Configured CLI subagent executes bounded work and returns structured reports. |
| Collect background task | `agent` with `action: "wait"`, `jobId`, optional `waitMs` | Bounded wait returning terminal report on completion, or running snapshot if timed out. Avoids polling. |
| Merge isolated implementation | `integrate` with `jobId`, optional `verify`, `autoRevert` | Waits for the running job, merges the verified diff from the isolated CLI workspace via `changePipeline`, applies only `allowedPaths`, auto-binds new paths to Blocks/Chains, and carries worker verification checks. |
| Assistant communication | `agent` with `action: "send|messages|cancel"`, `jobId` | Bidirectional host-worker communication; `messages` returns inbox items with `jobStatus`. |
| Apply verified change | `change` with `edits`, optional `verify`, `architecture` | Scoped atomic file modifications verified against tests; keeps Block ownership current. |
| System and state ops | `ops` with `capability`, `action`, `args` | Direct access to plan, task, block, chain, architecture, session, profile, and usage. |
| Diagnostic checks | `ops` with `capability: "micro"`, `action: "doctor"` | Local role readiness and effective settings without making a model request. |

## Why and when to use each capability

Delegation is the default. The main conversation owns the task contract, acceptance criteria, architecture decisions, integration, and final judgment; it must not pre-explore or implement work it can delegate. Micro owns bounded tasks and returns compact reports. CLI owns complex multi-file implementation in an isolated workspace. The context firewall keeps source, logs, diffs, architecture dumps, and full evidence out of main context for delegated work.

Hard rules:

1. **Route diagnosis by scope.** Bounded diagnosis/retrieval belongs to micro; open-ended, multi-goal, unknown-path root-cause investigation belongs to CLI. A micro task must state its goal, known evidence entry, allowed operations, return format, and stop condition.
2. Every code change goes through `change` or `integrate`. The main conversation never writes project files with native tools.
3. Prefer `pipeline`: one call that runs several steps beats several rounds of single calls, including chaining dispatch, wait and integrate.
4. Native tools are the fallback for a quick single command or read that needs no OS evidence, architecture or delegation.

- **pipeline**: The default container for 3 or more known independent reads, searches, commands, or edits. One parallel call may run many actions at once and returns full step results. Do not habitually split known work across multiple pipeline calls or repeated single calls.
- **command**: Executes one bounded command and returns the useful result without exposing the full process. Use it for builds, test suites, linters, and git checks. Output is stored in durable receipts, and `focus` or line ranges extract relevant lines without dumping entire logs.
- **api-micro**: The default executor for bounded diagnosis/retrieval, discovery, summarization, command batches, verification, packaging, and small changes. Invoke it as `ops({capability:"micro", action:"run", args:{prompt, execution, invocation}})`. It runs its own tool loop and returns one compact report; `action:"batch"` runs several bounded tasks together. It can execute commands (`invocation.tools.allowCommands: true`) and edits (`execution: "implement"` with `context.allowedPaths` and Block ownership). Semantic `ask` is the evidence-only broker. API Micro cannot dispatch another agent.
- **cli-agent**: Subagent for complex multi-step work, implementation workflows, refactoring, and cross-file repairs. Runs in an isolated process with independent tool loops, can use native tools and ContextOS, and returns structured reports.
- **integrate**: Merges verified diffs from a completed isolated CLI implementation into the project. This makes delegation substitutive rather than additive: the host merges the verified diff once instead of re-implementing the same files.

## Substitutive CLI implementation lifecycle

When delegating complex multi-file implementation to a CLI subagent, use the 4-step substitutive lifecycle:
1. **Dispatch (background)**: Dispatch implementation to an isolated workspace copy:
   `agent({task, workspace: <isolated copy>, execution: "implement", context: {allowedPaths, acceptance, verify}, background: true})`
2. **One bounded wait**: Collect the terminal report with a single bounded wait call:
   `agent({action: "wait", jobId, waitMs})`
   If `terminal: false` is returned, call `integrate` once; integrate waits for a running job in the same call and returns a terminal receipt or a running snapshot.
3. **Merge back with integrate**: Call `integrate({jobId})`. It waits for a running job, applies only files within `allowedPaths`, auto-binds new paths to Blocks/Chains, and carries the worker's verification checks. Pass `verify` only when the host must run an additional check; do not repeat the worker's own verification.
4. **Do not re-implement**: After `integrate` succeeds, the host must **NOT** re-implement the same files. Review the report and integrated diff, and run only remaining project-level checks.

## Evidence reuse and exact inspection

- `ask({inspect: [{path, ranges}]})` bypasses model calls and reads exact line slices from disk.
- `known: { refs: [{ resultId, path, ranges }] }` reuses previously retrieved evidence. Unchanged covered source is cited under `reused`; only new or changed ranges are delivered as source.
- Short `known` text notes provide task context but do not prove source contents.
- The current caller must hold the source marked known. A result ID alone does not deliver source; use `ask({resultId, inspect: [{path, ranges}]})` to recover saved coverage locally without an API request.
- **Read-only preload**: attach `preload` (or `invocation.evidence.pipeline`) with read-only steps/commands and `allowCommands:true` when command steps are used. ContextOS executes the pipeline inside the micro lifecycle and injects its bounded result into micro instead of entering the main transcript.

```js
contextos({action:"micro", args:{
  prompt:"Assess the attached evidence and return only findings.",
  preload:{pipeline:{steps:[
    {inspect:{path:"src/a.mjs"}},
    {run:"node -p \"process.version\""}
  ], allowCommands:true}}
}}, projectRoot)
```

- `maxChars` limits Unicode characters delivered in a single call. Omitted source blocks appear under `missing` and remain recoverable by result ID and ranges.
- Command results are durable: `command({action: "get", id})` retrieves prior command output by ID; do not rerun a command just to re-read its logs.

## Change, verification, and architecture

- `change({edits, verify, architecture})` performs atomic file modifications and runs verification commands.
- `integrate({jobId, verify?, autoRevert?})` applies changes produced by a completed isolated CLI job:
  - Reads the completed job's recorded `implementation` metadata (`workspace`, `allowedPaths`, `verify`).
  - Restricts file additions, edits, and deletions strictly to `allowedPaths`; any path outside is ignored.
  - Passes modifications through `changePipeline`, guaranteeing Block ownership preflight, atomic file writing, architecture graph refresh, and auto-reversion if verification fails.
  - Replay-safe: if called again on an already-applied job, reports `status=noop changed=0`.
- **Block/Chain architecture**: All code files within curated project boundaries require Block ownership. Target paths without Block owners are rejected before writing. Architecture state is queried and updated via `ops({capability: "architecture"})`, `ops({capability: "block"})`, and `ops({capability: "chain"})`. Never edit or inspect `.contextos/graph.json` directly.
- Optional `autoRevert: true` rolls back changes if verification commands fail.

## Plan, task, session continuity, and blackboard

- `ops({capability: "session", action: "status"})` exposes the active session state: user intent, touched files, recent command receipts, and milestone notes.
- **Blackboard purpose**: `.contextos/blackboard.md` is rendered from session state on every save. Read session state via `ops` rather than maintaining parallel tracking documents.
- `ops({capability: "plan"})` and `ops({capability: "task"})` store long-term task breakdowns and status across turns. State files in `.contextos` are managed exclusively by the runtime.

## CLI agent continuity, long tasks, and mailbox

- **CLI session continuity rule**: reuse when the task is continuous, background is coherent, and current CLI context occupancy is below 233k; start a new conversation at 233k or when the next task is independent. Retain up to 5 completed sessions for reuse via `cliSessionId`.
- **Long CLI tasks and timeout prevention**: CLI subagent tasks that may exceed host MCP tool call timeouts (e.g. AGY ~3 minutes) must be dispatched with `background: true` to obtain the job `id` immediately without blocking. Synchronous calls that hit host timeouts abort the child process, losing both the structured report and token accounting. Short tasks can run synchronously, and micro tasks must remain bounded.
- **Collecting background reports without polling**: Collect the terminal report using a single bounded `agent({action: "wait", jobId, waitMs})` call. If the task completes within `waitMs`, it returns the full terminal report and token accounting; if it times out, it returns a running snapshot with `waitedMs` and `terminal: false`. When a snapshot is returned, proceed with other host work and call `wait` again later. **Do not poll in a tight loop** with repeated `get` or `messages` calls.
- **Context-usage reporting**: Completed CLI reports include `report.cliUsage` (`{percent, usedTokens, windowTokens, source}`) when the adapter maps context usage from stream output.
- **Mailbox communication (bidirectional only)**:
  - `messages` is reserved strictly for bidirectional host-worker communication, not polling task completion. It returns message history along with `jobStatus`.
  - `agent({action: "send", jobId, message})`: Host sends instructions or clarifications to worker (`direction: "host-to-worker"`).
  - `agent({action: "messages", jobId, waitMs})`: Reads worker inbox (`direction: "worker-inbox"`). Returns inbox items and `jobStatus`. Set `waitMs > 0` to await worker updates.
  - `needsHost`: Attention flag indicating host decision or response required.
  - `needsHostReason`: Explains status (`question`, `blocked`, `failed`, `cancelled`, `changes`, `reported`, `none`). A `question` sets `waitingForHost: true` and pauses worker execution until answered.
  - `mailbox.canSend`: Indicates whether the worker process is running and accepting messages.

## Doctor checks and readiness semantics

- `ops({capability: "micro", action: "doctor"})` is an offline local check of effective profile configuration.
- Fields reporting `unknown; not probed` (such as `authentication`, `task_analyze`, `task_implement`) are normal expected states and do not constitute a blockage or problem.
- As long as `endpoint`, `configured_model`, and `credential_source` are configured, API Micro should be dispatched normally. Run live network probes with `probe: true` only upon explicit user request.

## Configuration and operations guide

For provider/model/key switching, credential debugging, CLI adapter installation, OS MCP registration, skill installation, permission preconfiguration, and doctor diagnostics, see the [contextos-ops operations guide](../../contextos-ops/SKILL.md) and [micro-setup.md](../../contextos-ops/references/micro-setup.md).
