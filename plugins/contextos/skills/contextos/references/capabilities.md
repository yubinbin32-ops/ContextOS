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

Do not use Plans and Tasks as mandatory bookkeeping. Use them when they preserve decisions, constraints, progress, or evidence that would otherwise be lost. Small single-turn edits can remain in the normal `explore -> change -> verify -> ship` loop.

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
| Work with low-level code operations | `ops({ capability: "code", action: "outline|read|search|create|edit|changeset", args })` | Readable slice or file mutation | The intent-level tools need a precise lower-level operation |
| Run a bounded command | `ops({ capability: "run_command", args: { command, cwd?, maxChars?, timeoutMs?, raw?, mode? } })` | Redacted receipt and bounded output | A command is useful but should not become raw terminal noise |
| Manage long-running processes | `process.start/list/status/logs/stop/clear` | Named process plus log handle | Dev servers, watchers, or background jobs need lifecycle control |
| Inspect or restore project state | `os_context.brief/search/open/reconcile` | Resumption anchor, entity view, or graph reconciliation | Starting/resuming work or resolving graph/disk divergence |
| Operate the current session | `ops({ capability: "session", action: "note|close|history" })` | Session note, closure, or recent history | Information should survive context clearing or closure needs to be explicit |
| Configure project execution | `ops({ capability: "profile", action: "set", args })` | `.contextos/profile.json` | Set default verify commands, timeout, output budget, or strict governance |
| Initialize, diagnose, or switch storage | `system.init/doctor/switch` | Project configuration or storage migration | Installation, health checks, and local/cloud mode changes |

The public intent tools already wrap most common code and command operations. Reach for `ops` when a lower-level action creates a state that the higher-level tools do not expose, not because the wrapper is unfamiliar.

## Composition patterns

These are examples of matching shape to dependency, not fixed workflows.

```js
// Independent evidence in one request
pipeline({
  parallel: [
    { inspect: { path: "src/a.mjs", ranges: [{ startLine: 1, endLine: 80 }] } },
    { run: "rg -n \"featureFlag|configKey\" src test", raw: true, maxChars: 4000 },
    { block: { action: "search", query: "feature" } }
  ]
})

// Dependent write then proof in one request
pipeline({
  chain: [
    { change: { edits: [{ path: "src/a.mjs", target: "old", replacement: "new" }] } },
    { verify: "npm test" },
    { ship: { summary: "implement feature" } }
  ]
})

// Durable rationale and constraint
ship({
  summary: "switch persistence boundary",
  decision: { id: "DEC-024", title: "Persistence boundary", content: "Why this boundary was chosen." }
})
```

Prefer the smallest state transition that removes the current uncertainty. A pipeline is valuable when it expresses real parallel or dependency structure; it is harmful when it merely hides unrelated work behind one request.

Pass pipeline actions as structured objects. Nested payloads should remain objects (`{ change: { edits: [...] } }`), not JSON strings; stringification prevents the normalizer from seeing the intended action fields.
