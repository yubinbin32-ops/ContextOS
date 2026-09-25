# ContextOS Capability Reference

Read this when the intent-level loop is not enough, or when the task needs durable decisions, rules, plans, architecture relationships, process control, or project configuration. These are capabilities, not a required sequence. Choose one because it changes the state the next turn can rely on.

## Decision and rules

Use decisions for durable rationale. Use rules for durable constraints that should be applied repeatedly.

| Need | Capability/action | State it creates | When it is worth using |
| :--- | :--- | :--- | :--- |
| Recover existing project decisions | `ops({ capability: "knowledge", action: "decision_open", args: { sectionId? } })` | Reads `DECISION.md` or one section | Before changing an established architecture, compatibility contract, or prior tradeoff |
| Record a design choice and why alternatives were rejected | `ops({ capability: "knowledge", action: "decision_write", args: { sectionId, sectionTitle, content } })` | Upserts a durable decision section | A future agent would otherwise re-litigate the same choice; not for routine edits |
| Close a goal with its rationale | `ship({ summary, decision: { id, title, content } })` | Ships evidence and writes the decision atomically | The current change itself establishes a lasting decision |
| Discover project rules | `ops({ capability: "knowledge", action: "rule_list" })` | Returns rule summaries | Before implementation when constraints may exist |
| Read one rule exactly | `ops({ capability: "knowledge", action: "rule_open", args: { ruleId } })` | Returns the full rule | A rule summary affects the implementation |
| Create or update a reusable rule | `ops({ capability: "knowledge", action: "rule_write", args: { ruleData: { id, title, category, summary, content, priority? } } })` | Writes a rule document | The team wants a persistent constraint, not a one-off instruction |
| Attach rules to future work | `plan.create/update` with `planData.ruleRefs`; `task.start/create/update` with `rules`; `task.bind_rule/unbind_rule` | Plan or Task carries validated rule references | Work must remain traceable to constraints after the conversation moves on |

Plans can also carry `decisionRefs`; Tasks can carry `references.decisionSections`. Use those links when future work should start from an established rationale rather than reopening it. Rules and decisions serve different purposes: a rule says what must remain true; a decision explains why one path was chosen. Keep them concise and reusable. Do not turn a single bug fix or transient preference into a project-wide rule.

## Plans, tasks, probes, and evidence

Plans represent multi-step outcomes. Tasks represent the active unit of work. A lightweight Task can auto-create a lightweight Plan when no plan exists.

`plan.list` returns a compact page (10 items by default, maximum 25) with `total`, `offset`, `hasMore`, and `nextOffset`. Use `plan.open` for one plan's full summary, phases, and checkpoints.

| Need | Capability/action | State it creates | When it is worth using |
| :--- | :--- | :--- | :--- |
| Find current work | `ops({ capability: "os_context", action: "brief" })`, `plan.list/open`, `task.open` | Resumption anchor | A new turn, long task, or context reset must recover the active objective |
| Track phases and checkpoints | `plan.create/update/upsert`, `plan.check`, `plan.complete` | Plan, phases, checkpoints, rule/decision refs | Multiple milestones, approvals, dependencies, or session-spanning work |
| Start or resume a work unit | `task.start/create/open/activate/develop/resume` | Active Task with working set and context slice | Work needs ownership, rules, notes, files, or evidence across turns |
| Capture exploratory experiments | `task.probe`, then `task.graduate_probe` | Probe notes plus promoted files/Block binding | Investigation is not yet production work, but findings should survive and later become scoped work |
| Attach rules to a Task | `task.bind_rule` / `task.unbind_rule` | Validated Task rule references | One Task needs constraints different from the Plan |
| Record a check | `task.check` with a receipt or evidence | Check entry | Evidence already exists and only needs recording |
| Check and finish in one action | `task.finish` with `checkData.command`, `receiptId`, or `evidence` | Passing check, Task sync, possible lightweight-plan completion | The Task is ready to close and verification can run now |
| Reconcile a Task with disk state | `task.reconcile`, `task.sync` | Working-set and graph synchronization | Files changed outside the active flow or a Task needs completion without rerunning checks |
| Repair blocked state | `task.resume` after resolving the cause | Task returns to active | A dependency, missing binding, or failed check has been repaired |

Do not use Plans and Tasks as mandatory bookkeeping. Use them when they preserve decisions, constraints, progress, or evidence that would otherwise be lost. Small edits stay in `inspect -> change({ edits, verify })`; `ship` is reserved for actual final closure. When a verified session is closed before the final host turn, pass its `receiptId` (or `receiptIds`) to `ship`; ContextOS reuses it only when its state hash still matches the current workspace and blocks stale evidence.

## Blocks, chains, and links

A Block is a curated semantic boundary anchored to files, symbols, or directory trees. A Chain groups Blocks into a meaningful flow. A Link records a typed relationship. The AST-derived ModuleIndex is for navigation only: its `mod-*` entries are not semantic owners, and must never be auto-bound as replacement architecture.

| Need | Capability/action | State it creates | When it is worth using |
| :--- | :--- | :--- | :--- |
| Find existing architecture | `block.list/open/search`, `chain.list/open/links/validate` | Readable graph neighborhood and integrity report | Before cross-module changes or when ownership is unclear |
| Bind or refresh a semantic Block | `block.bind` or `block.bind_auto`; use `replacePaths: true` when moving/replacing file ownership | Curated Block plus current file/symbol anchors | A meaningful subsystem or responsibility has a stable boundary |
| Bind architecture with a code edit | `change({ edits, architecture: { blocks, chains } })` | Code edits, Block bindings, and Chain membership in one transaction | A change creates a new boundary or alters existing ownership |
| Add Blocks to a feature flow | `chain.compose({ chainData: { id, title, memberIds } })` | Chain membership; existing members are retained by default | Several semantic Blocks form one user-facing or architectural flow |
| Express dependency or call direction | `chain.link({ linkData: { from, to, kind, reason? } })` | Typed directed Link, not Chain membership | Direction matters beyond grouping |
| Remove obsolete graph state | `chain.unlink`, `chain.delete`, `block.delete`; `block.prune_derived` only removes legacy generated `mod-*` nodes | Explicit graph cleanup | A boundary or relationship is obsolete |

Before editing, find the existing semantic owner. Refresh that Block when the change remains within its responsibility. For a new responsibility, choose a meaningful Block identity and title, then bind it and compose its Chain in the same `change` call. Group related files under one semantic boundary; never mint a one-file “module” Block just to satisfy attribution. A changed path must have exactly one curated Block owner and belong to at least one Chain. Strict `ship` blocks on gaps; normal `ship` reports them as advisory. ModuleIndex hints can help locate code but do not satisfy ownership.

`block.list` and `chain.list` return paginated compact summaries by default: 20 items, maximum page size 25, with `total`, `offset`, `hasMore`, and `nextOffset`. Use `block.open` or `chain.open` for full details. Internal pipelines explicitly page through full refs and members for architecture checks.

Architecture discovery is two-layer. `block.search` and `os_context.search` match semantic titles/summaries, not artifact paths; an empty graph search means "no semantic match", not "no code". If the path or symbol is the known fact, locate it first with `explore` or `code.search`, then open known Blocks or create/refresh the appropriate boundary. Normal `explore` gives navigation and compact signatures; request `depth: "deep"` only when previews or action slots avoid extra turns. Derived ModuleIndex IDs are not architecture owners. `os_context.brief` prioritizes active work; after closure, recover completed context with `session.history`, `plan.list/open`, and `task.open`.

## Code, commands, processes, and context state

| Need | Capability/action | State it creates | When it is worth using |
| :--- | :--- | :--- | :--- |
| Work with low-level code operations | `ops({ capability: "code", action: "outline|read|search|create|edit|changeset", args })` | Readable slice or atomic create/edit/delete mutation; unchanged `read/search` requests reuse session receipts by default | The intent-level tools need a precise lower-level operation; set `dedupeReads:false` only for an intentional fresh replay |
| Reinspect unchanged source | `inspect` / `work.inspect` with `path`, `symbol`, or `ranges` | Stat-validated unchanged reads return a compact reuse receipt without rereading source | Use `refresh:true` or `dedupeReads:false` only when a fresh slice is needed |
| Read one known AST declaration | `ops({ capability: "code", action: "read", args: { path, symbol } })` | Source for one matched declaration | The file path and symbol are known |
| Run a bounded command | `ops({ capability: "run_command", args: { command, cwd?, maxChars?, timeoutMs?, raw?, mode? } })` | Redacted receipt and bounded output | A command is useful but should not become raw terminal noise |
| Manage long-running processes | `process.start/list/status/logs/stop/clear` | Named process plus log handle | Dev servers, watchers, or background jobs need lifecycle control |
| Inspect or restore project state | `os_context.brief/search/open/reconcile` | Resumption anchor, entity view, or graph reconciliation | Starting/resuming work or resolving graph/disk divergence |
| Operate the current session | `ops({ capability: "session", action: "note|close|history" })` | Session note, closure, or compact recent history | History is compact and can use `args.sessionId`; request `args.full: true` only for a deliberate diagnostic |
| Configure project execution | `ops({ capability: "profile", action: "set", args: { micro: { url, model, key }, autoTriage: false } })` | `.contextos/profile.json` | Set Micro endpoint, default verify commands, timeout, output budget, or strict governance; do not persist transport `projectRoot` |
| Read a truncated response | `ops({ capability: "artifact", action: "read", args: { id, startLine?, endLine?, grep?, contextLines?, maxChars? } })` | Bounded artifact excerpt | Only the missing slice is needed; never replay the full tool response |
| Inspect or evict stored artifacts | `ops({ capability: "artifact", action: "stat|list|evict", args: { id|ids?, policy?: { maxArtifacts?, maxTotalBytes?, maxAgeMs? } } })` | Artifact metadata or compact eviction receipt | Diagnose retention, remove exact stale artifacts, or apply age/count/byte limits; policy may also be supplied flat for compatibility; eviction never returns the full index |
| Compare recorded telemetry | `ops({ capability: "telemetry", action: "compare", args: { leftSessionId, rightSessionId, scope?: "external"|"internal"|"all" } })` | Compact JSON with session metrics and right-minus-left delta; external is the default | Compare host-visible cost by default; inspect internal Pipeline work separately when diagnosing routing |
| Audit OS versus OS+Micro routing | `ops({ capability: "telemetry", action: "audit", args: { sessionId, baselineSessionId?, limit? } })` | Compact joined host/Micro metrics, including host peak context chars/tokens, internal OS work, route counts, warnings, delivery outcomes, evidence quality, and optional savings delta | `sessionId` is required; get it from compact `session.status` first. Use for a real comparison; actual savings stays null unless complete host and provider usage receipts exist |
| Execute one-shot or parallel Micro work | `ops({ capability: "micro", action: "run|batch", args: { preset, task, inputRef|inputArtifact|inputReceipt?, withOS?, delivery?, invocation?, tasks?, maxConcurrency? } })` | Bounded provider result with artifact-only traces, request/input budgets, provider-token enforcement, and a scheduler capped at 4 concurrent tasks by default (hard maximum 8) | Log triage, contract synthesis, structural relationship analysis, or independent tasks that do not need session continuity; when tasks share evidence, attach one Pipeline instead of duplicating reads |
| Attach bounded OS evidence to Micro | `micro({ ..., pipeline: { steps, onFailure?, allowCommands?, maxChars?, cache? } })` or the compatible `preload` form; session creation accepts the same `pipeline` alias | OS runs the Pipeline once, briefly caches unchanged read-only evidence, stores the raw result as an artifact, injects only bounded evidence into Micro, and returns only a compact receipt | Known test/log/file context that should not be copied through the host transcript |
| Run a multi-turn Micro subagent | `ops({ capability: "micro", args: { sessionAction: "create|send|get|list|close|delete", sessionId, objective?, task?, runFirst?, limit?, offset? } })` | Persistent bounded state under `.contextos/micro-sessions/`; `runFirst:true` combines creation, attached preload, first provider turn, and delivery in one host round; `list` returns a bounded recent page, while `get(id)` opens one session | Multi-step diagnosis or relationship reasoning where only the final answer and receipt should return to the main context |
| Initialize, diagnose, or switch storage | `system.init/doctor/switch` | Project configuration or storage migration | Installation, health checks, and local/cloud mode changes |

Telemetry summaries default to `scope: "external"` through the OS interface, so host-context measurements do not accidentally include internal Pipeline children. Pass `scope: "internal"` only when diagnosing routing fan-out, or `scope: "all"` when an aggregate operational view is explicitly needed.

After repeated discovery turns without a mutation or verification, the OS may append one compact routing hint. Treat it as a convergence signal: batch the next known reads/searches, then edit or verify; do not answer the hint with another single-file read.

The public intent tools already wrap most common code and command operations. `work` accepts `search` and `inspect` together, then can apply supplied edits, architecture bindings, and verification in the same request. Use one batched discovery request when findings must determine the patch, then one edit-and-verify request. Reach for `ops` when a lower-level action creates a state that the higher-level tools do not expose, not because the wrapper is unfamiliar.

Use Micro when raw input or intermediate reasoning would otherwise persist in the host transcript, especially for several source bodies, noisy test output, or logs. Keep exact reads, mutations, verification receipts, and trivial deterministic commands in OS. Micro is optional: choose it when the host-context savings exceed the extra orchestration and provider cost.

Routing heuristics:

- Use `graph` for bounded structure and relationship analysis, `triage` for noisy failures/logs, and `custom` only when the task needs a specific output shape. Match the task to the preset; do not request a graph when you need a prose implementation plan.
- Use the preset provider budget unless the input is genuinely tiny. After one budget, empty-response, or max-step failure, narrow the input or fall back to OS instead of repeating the same call. Build preload ranges from current evidence; refresh line ranges after any edit or branch change, and keep simple chores within the bounded input/provider budgets.
- For direct Pipeline evidence, use `invocation.provider.maxRequests: 1` and `invocation.tools.enabled: false` unless a multi-step Micro route is intentional. Multi-step attached Pipelines auto-partition the evidence cap; explicit child caps remain the most precise control, while one oversized step still returns `TRUNCATED` so the host can narrow it. `invocation.provider.maxInputTokens` admits the complete prompt before network dispatch; a rejected admission is cheaper than a repeated oversized call. Delivery mode does not lower provider cost.
- Keep one exact file read, edit, or verification in OS. If a known pipeline can produce bulky evidence, use `preload` so raw output is stored as an artifact and only a bounded result returns to the host.
- `preload` does not grant Micro OS tools. Set `withOS: true` only when Micro needs further bounded reads or an explicitly assigned curated Block bind/additive Chain composition. The host supplies Block/Chain IDs and semantic purpose; Micro applies only the supplied path/member bindings. Micro gets no code edits, shell commands, deletes, or member replacement.
- With `withOS:true`, read-only Micro OS calls are routed through internal ContextOS telemetry and identical reads in the same turn reuse the first bounded result. Prefer one attached Pipeline/preload for known evidence instead of repeated Micro reads.
- Prefer `batch` for independent Micro analyses and a `session` only for dependent follow-ups. Batch independent simple edits in one OS `work` call; do not route trivial edits through Micro.
- `delivery:"immediate"` returns the answer now (the default); `"errors-only"` is for assigned Block binds or additive Chain compositions and hides success text only when the write succeeded, while always returning failures; `"defer"` stores the answer for the next top-level OS response. Choose defer only when the host's intervening action does not depend on that answer. `"auto"` works with any preset: Micro supplies `needsHost`; true defers the answer, false hides successful content, and a missing/invalid decision falls back to immediate. Use auto only when the host can continue before the next-call recovery.
- A read-only attached evidence Pipeline requested after a successful mutation and verification is skipped as `late-read-only-evidence` to prevent a post-implementation replay loop. Pass `allowLate:true` only for an explicit audit that genuinely needs fresh evidence.

Preload executes a read-only pipeline before the Micro provider call; it is useful when the main agent already knows exactly which evidence to gather. ContextOS extracts the action outputs from the Pipeline artifact and injects bounded evidence directly into Micro; the host receives only a compact receipt. The default evidence cap is 2,400 characters and `maxChars` can raise it to 16,000. Multi-step Pipelines partition that cap across child outputs and retain truncation markers; a single oversized step reports `TRUNCATED` and skips the provider request so the host can narrow the path or line range. Unchanged read-only evidence is cached briefly by workspace fingerprint; use `refresh:true` when a fresh result is required. Commands require `allowCommands:true`; nested Micro and mutations are rejected. Use `onFailure:"collect"` when test failure output is evidence and later inspection steps still matter.

```js
// One-shot: OS executes the attached pipeline once before the Micro provider call.
micro({
  preset: "evidence",
  delivery: "auto",
  task: "Analyze the failure and return the smallest repair direction.",
  pipeline: {
    onFailure: "collect",
    allowCommands: true,
    steps: [
      { verify: { command: "npm test", autoTriage: false } },
      { inspect: { paths: ["src/queue.mjs", "test/queue.test.mjs"], budget: "compact" } }
    ]
  }
})

// Session: attach the pipeline at creation and start the first turn in the same round.
ops({ capability: "micro", args: { sessionAction: "create", sessionId: "queue-fix", task: "Analyze the queue failure.", runFirst: true, pipeline: { steps: [...] } } })
```

## Composition patterns

These are examples of matching shape to dependency, not fixed workflows.

```js
// Independent evidence in one request
pipeline({
  mode: "receipt",
  parallelConcurrency: 3,
  parallel: [
    { inspect: { path: "src/a.mjs", ranges: [{ startLine: 1, endLine: 80 }] } },
    { run: "rg -n \"featureFlag|configKey\" src test", raw: true, maxChars: 4000 },
    { block: { action: "search", query: "feature" } }
  ]
})

// Dependent write/delete then proof in one request
pipeline({
  chain: [
    { change: { edits: [{ path: "src/a.mjs", target: "old", replacement: "new" }] } },
    { verify: "npm test" }
  ]
})

// Atomic deletion is a first-class mutation
change({
  delete: [{ path: "src/legacy.mjs" }],
  verify: ["npm test"],
  autoRevert: true
})

// Final closure with durable rationale
ship({
  summary: "switch persistence boundary",
  decision: { id: "DEC-024", title: "Persistence boundary", content: "Why this boundary was chosen." }
})
```

Prefer the smallest state transition that removes the current uncertainty. A pipeline is valuable when it expresses real parallel or dependency structure; it is harmful when it merely hides unrelated work behind one request.

Pass pipeline actions as structured objects. Nested payloads should remain objects (`{ change: { edits: [...] } }`), not JSON strings; stringification prevents the normalizer from seeing the intended action fields.
