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

Do not use Plans and Tasks as mandatory bookkeeping. Use them when they preserve decisions, constraints, progress, or evidence that would otherwise be lost. Small edits stay in `inspect -> change({ edits, verify })`; `ship` is reserved for actual final closure.

## Blocks, chains, and links

A Block is a semantic architecture unit anchored to real files, symbols, or directory trees. A Chain groups Blocks into a meaningful horizontal flow. A Link records a typed relationship between Blocks. Derived `mod-*` Blocks come from the AST/module index; curated Blocks add human-meaningful names and boundaries.

| Need | Capability/action | State it creates | When it is worth using |
| :--- | :--- | :--- | :--- |
| Find existing architecture | `block.list/open/search`, `chain.list/open/links/validate` | Readable graph neighborhood and integrity report | Before cross-module changes or when ownership is unclear |
| Create/update a semantic Block | `ops({ capability: "block", action: "bind", args: { id, blockData } })` | Curated Block plus anchored artifact refs | A stable subsystem deserves an explicit identity |
| Bind files/directories with AST anchors | `ops({ capability: "block", action: "bind_auto", args: { id, path|paths, symbols?, blockData? } })` | File/symbol/tree anchors with hashes | The boundary exists on disk and should be tracked without manual locator bookkeeping |
| Group Blocks by feature or flow | `ops({ capability: "chain", action: "compose", args: { chainData: { id, title, kind?, memberIds } } })` | Chain membership | Several Blocks form one user-facing or architectural flow |
| Express relationships | `ops({ capability: "chain", action: "link", args: { linkData: { from, to, kind, reason? } } })` | Typed directed Link | Dependency or call direction matters beyond membership |
| Remove relationships | `chain.unlink`, `chain.delete`, `block.delete` | Removes graph state | A boundary or relationship is obsolete; prefer this over leaving contradictory graph facts |

Curate the architecture that needs shared meaning. Do not create a Block for every file, and do not hand-maintain anchors that `bind_auto` can derive. In strict profiles, `ship` can require major changed files to be covered by curated Blocks; in normal profiles, derived attribution is advisory.

Architecture discovery is two-layer. `block.search` and `os_context.search` match semantic titles/summaries, not artifact paths; an empty graph search means "no semantic match", not "no code". If the path or symbol is the known fact, locate it first with `explore` or `code.search`, then open known Blocks or create/refresh the appropriate boundary. `os_context.brief` prioritizes active work; after closure, recover completed context with `session.history`, `plan.list/open`, and `task.open`.

## Code, commands, processes, and context state

| Need | Capability/action | State it creates | When it is worth using |
| :--- | :--- | :--- | :--- |
| Work with low-level code operations | `ops({ capability: "code", action: "outline|read|search|create|edit|changeset", args })` | Readable slice or atomic create/edit/delete mutation | The intent-level tools need a precise lower-level operation |
| Run a bounded command | `ops({ capability: "run_command", args: { command, cwd?, maxChars?, timeoutMs?, raw?, mode? } })` | Redacted receipt and bounded output | A command is useful but should not become raw terminal noise |
| Manage long-running processes | `process.start/list/status/logs/stop/clear` | Named process plus log handle | Dev servers, watchers, or background jobs need lifecycle control |
| Inspect or restore project state | `os_context.brief/search/open/reconcile` | Resumption anchor, entity view, or graph reconciliation | Starting/resuming work or resolving graph/disk divergence |
| Operate the current session | `ops({ capability: "session", action: "note|close|history" })` | Session note, closure, or recent history | Information should survive context clearing or closure needs to be explicit |
| Configure project execution | `ops({ capability: "profile", action: "set", args })` | `.contextos/profile.json` | Set default verify commands, timeout, output budget, or strict governance |
| Read a truncated response | `ops({ capability: "artifact", action: "read", args: { id, startLine?, endLine?, grep?, contextLines?, maxChars? } })` | Bounded artifact excerpt | Only the missing slice is needed; never replay the full tool response |
| Inspect or evict stored artifacts | `ops({ capability: "artifact", action: "stat|list|evict", args })` | Artifact metadata or lifecycle cleanup | Diagnose retention, size, or stale output |
| Execute one-shot or parallel Micro work | `ops({ capability: "micro", action: "run|batch", args: { preset, task, inputRef|inputArtifact|inputReceipt?, withOS?, tasks? } })` | Bounded provider result with artifact-only traces and provider-token budget enforcement | Log triage, contract synthesis, structural relationship analysis, or independent tasks that do not need session continuity |
| Preload bounded OS evidence into Micro | `micro({ ..., preload: { steps, onFailure?, allowCommands?, maxChars? } })` or `ops({ capability: "micro", args: { sessionAction: "create", ..., preload } })` | Pipeline output is stored as an artifact and injected only into Micro; the host gets a compact preload receipt | Known test/log/file context that should not be copied through the host transcript |
| Run a multi-turn Micro subagent | `ops({ capability: "micro", args: { sessionAction: "create|send|get|list|close|delete", sessionId, objective?, task? } })` | Persistent bounded state under `.contextos/micro-sessions/` with TTL and cross-process locking | Multi-step diagnosis or relationship reasoning where only the final answer and receipt should return to the main context |
| Initialize, diagnose, or switch storage | `system.init/doctor/switch` | Project configuration or storage migration | Installation, health checks, and local/cloud mode changes |

The public intent tools already wrap most common code and command operations. Reach for `ops` when a lower-level action creates a state that the higher-level tools do not expose, not because the wrapper is unfamiliar.

Use Micro when raw input or intermediate reasoning would otherwise persist and be replayed in later turns. Keep exact reads, mutations, verification receipts, and trivial deterministic commands in OS; Micro is a context-cost decision, not a required step. Treat it as a low-cost worker for bounded grunt work such as file-relationship summaries, bounded pipelines, routine incident handling, website information gathering, or simple one-off updates. Do not assign complex implementation or long-lived code/document changes that will need rereading or rework.

Routing heuristics:

- Micro OS tools support `inspect` with `path`, `paths`, `globs`, `ranges`;
  `search` with `query`, `globs`; `context`; and `artifact`. Use the preset
  default provider budget (`graph` 16000, `custom` 20000) unless the input is
  genuinely tiny. After one budget, empty-response, or max-step failure, narrow
  the input or fall back to OS instead of repeating the same call.
- Keep a single exact file read, edit, or verification in OS.
- If a relationship or incident analysis would leave multiple source bodies, test output, or a raw log in the host transcript, prefer Micro `graph`, `triage`, or `preload`; the host should receive only the bounded answer and references.
- Prefer `batch` for independent Micro work and a `session` for dependent follow-ups.
- Batch independent simple edits (for example a version bump plus changelog) into one OS `work` call. Do not split them into separate transactions or route a trivial one-line change through Micro merely to satisfy a quota.

When the main agent already knows the bounded OS steps that produce the evidence, prefer `preload` over `OS read -> host transcript -> Micro input`. Preload executes once inside the Micro boundary, stores raw output as an artifact, and returns only a bounded summary and receipt to the host. It is read-only unless `allowCommands:true`; nested Micro and mutations are rejected. Use `onFailure:"collect"` for test failures so later evidence steps still run.

```js
// One-shot: OS executes the pipeline before the Micro provider call.
micro({
  preset: "evidence",
  task: "Analyze the failure and return the smallest repair direction.",
  preload: {
    onFailure: "collect",
    allowCommands: true,
    steps: [
      { verify: { command: "npm test", autoTriage: false } },
      { inspect: { paths: ["src/queue.mjs", "test/queue.test.mjs"], budget: "compact" } }
    ]
  }
})

// Session: preload once, then reuse it across sends.
ops({ capability: "micro", args: { sessionAction: "create", sessionId: "queue-fix", preload: { steps: [...] } } })
```

## Composition patterns

These are examples of matching shape to dependency, not fixed workflows.

```js
// Independent evidence in one request
pipeline({
  mode: "receipt",
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
