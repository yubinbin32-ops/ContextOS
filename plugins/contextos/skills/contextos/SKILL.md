---
name: contextos
description: Required execution layer for repository code work. Use ContextOS for locating, reading, changing, verifying, and closing code tasks. Defaults to bounded summaries and artifact references; rich output is explicit.
---

# ContextOS

Use ContextOS as the default repository execution layer. It must reduce replayed
context and host turns, not merely wrap shell commands. This skill is the routing contract; there is no hook process.

## Execution Rule

For repository code work, do not start with `pwd`, `ls`, `find`, `cat`, `rg`, `sed`, `git status`, `git diff`, or a native editor. `apply_patch`, shell heredocs, and other native writes are not
allowed while ContextOS can express the mutation. Use this call budget:

1. Unknown target: use one bounded `explore`, `inspect`, or `pipeline` call.
2. Known target: use one `work` call containing optional bounded `inspect`, all
   `create`/`edits`/`delete`, and `verify`. Do not split `inspect`, `change`, and `verify`
   into separate calls merely because Micro or another analysis step ran first.
3. If `work` cannot express the transaction, use one `inspect`, then one `change`
   with all creates/edits/deletes and `verify`.
4. After a successful `work`, `change`, or `verify`, stop probing. Do not rerun
   the same command after PASS or repeat `git diff`/`git status`.
5. Use `ship` only when the whole multi-turn task is finished or the user asks to close it.

If ContextOS cannot express an operation, use the narrowest shell fallback and
say why. Shell is never allowed for routine reads, edits, or project discovery.

## Route And Turn Budget

Enforce these bounds yourself:

- Turn 1 is `inspect-only`: at most two ContextOS calls, no mutation.
- Turns 2-5 are `mutate-first`: allow at most one inspection-only call, then
  mutate with verification in the same `work` or `change` call; at most three
  ContextOS calls total.
- After a failure, inspect at most once, then repair and verify in one call.
  Schema retries do not consume the turn budget.
- The final turn uses `work`, `change`, or `verify` and repairs any failure in
  the same turn.

Keep `.contextos/recovery.json` and the objective contract stable. If
`.contextos/targets.json` exists, mutations must stay inside its allowed paths.
`create` may not replace an existing file without `overwrite:true`.

## Calls

All actions use one transport:

```js
contextos({ action: "<name>", args: { ... }, projectRoot })
```

Do not nest an action inside `args`. The wire shape for the two most common
Micro routes is:

```js
contextos({ action: "micro", args: { preset: "triage", inputRef: "diagnostic.log", task: "..." }, projectRoot })
contextos({ action: "ops", args: { capability: "micro", action: "batch", withOS: true, args: { tasks: [...] } }, projectRoot })
```

- `explore`: only when entry points are unknown.
- `work`: preferred known-target transaction; batch `inspect`, `create`/`edits`/`delete`, `verify`.
- `inspect`: known path, glob, symbol, slot, or line range. Use `globs` for file
  discovery, not a fabricated field. For text or regex search use
  `ops({ capability: "code", action: "search", args: { query, globs } })`.
- `change`: batch creates/edits/deletes with `verify` in the same call. Edit targets must
  be exact source text; the `// path [Lx-Ly] (hash: ...)` line is read metadata and
  is never part of the file. For a whole-file replacement, pass `fullFile:true`.
  Delete is a first-class mutation: use `delete: [{ path }]`; do not fall back to
  shell `rm` when ContextOS is available.
- `verify`: one command set; use `mode` only for processes or receipt logs.
- `pipeline`: only for genuinely parallel probes or dependent chains. Pass
  `parallel`, `chain`, or `steps` as arrays of structured action objects.
- `ops`: artifacts, plans, profiles, processes, and lower-level capabilities.
- `micro`: isolated bounded analysis; see below.
- `ship`: final closure only.

Mutation payloads are explicit; do not infer schema by inspecting the plugin.

```js
contextos({
  action: "change",
  args: {
    create: [{ path: "test/new.test.mjs", content: "..." }],
    edits: [{ path: "src/a.mjs", target: "old", replacement: "new" }],
    delete: [{ path: "src/legacy.mjs" }],
    verify: { commands: ["npm test"] }
  },
  projectRoot
})
```

Pass pipeline actions as structured objects. Use `{ run: "command" }` or
`{ tool: "ops", args: { capability: "run_command", ... } }`; do not write
`{ action: "run" }`.

Prefer one MCP call per turn; batch independent paths, globs, and ranges.
Stop probing after a PASS and never issue one read per file.

## Context Contract

Responses are hard-bounded. Use `full` only for an immediate decision. Never
create probe scripts or use `verify` to read files; run only commands approved by
`contract.json`. Fetch an artifact only when its exact slice is needed:

```js
ops({ capability: "artifact", action: "read", args: { id, startLine, endLine, grep, contextLines, maxChars } })
```

`grep` is a case-insensitive regular expression. Invalid regular expressions fall
back to literal matching. Never replay full logs, diffs, or files when a receipt, range, or artifact is
enough. After a verified change, report the result and evidence; do not inspect
the same code again.

## Micro

Micro is an out-of-context worker, not a second conversation. Its value is
economic: move large inputs and intermediate reasoning out of the persistent host
transcript, then return only a bounded answer and receipt. The host should not
carry raw logs, whole-file context, relationship exploration, or rejected patch
candidates into later turns.

Use Micro when the persistent-context cost exceeds provider overhead plus the
bounded answer; keep a single exact read, edit, or verification in OS. Prefer
`batch` for independent work and `session` for dependent follow-ups. Route
multi-file or raw-log analysis through Micro, and batch independent simple edits
into one `work` call. See `references/capabilities.md` for detailed heuristics.

### Work Boundary

Treat Micro as a low-cost worker for bounded grunt work: file relationships,
bounded pipelines, routine incidents, website lookup, or a simple one-off update.
Do not delegate complex or long-lived edits that would need rereading or rework.

### Route Matrix

| Need | Preferred call | Why |
|---|---|---|
| Triage a large log or receipt | `micro` with `inputRef` / `inputReceipt` | The raw source never enters the main transcript |
| Preload known expensive context | `micro` with `preload` | OS runs a bounded pipeline once; raw output stays in an artifact and Micro context, while the host receives only a receipt |
| Extract API contracts or invariants | `micro` preset `contract` | Returns only the contract surface |
| Understand file/module/test relationships | `micro` preset `graph` with `withOS:true` | Bounded OS reads stay inside the Micro artifact |
| Inspect structure without replaying files | `micro` preset `custom` with `withOS:true` | The main context receives only the bounded answer |
| Propose a focused patch | `micro` preset `patch` | Keeps candidate code out of the main context until selected |
| Run independent analyses together | `ops` + `capability:"micro"`, `action:"batch"`, `withOS:true` | One host turn, isolated parallel provider work |
| Narrow a decision across turns | `ops` + `micro` `sessionAction:create/send` | Persistent Micro state with TTL and locking |

Use `withOS:true` when the input cannot be narrowed before dispatch. Bounded OS
tool output remains in the Micro artifact; `requireBulkInput` still rejects
unbounded inline input, but it does not block a bounded OS-backed Micro task.

Use `preload` when the main agent already knows the bounded OS steps that should
produce the evidence. OS executes the pipeline before the Micro provider call;
raw output stays in an artifact, only a bounded summary enters Micro, and the
host receives only a receipt. Preload is read-only unless `allowCommands:true`;
use `onFailure:"collect"` for test failures and see `references/capabilities.md`
for the schema.

```js
// One-shot or batch: keep bulk inputs outside the host transcript.
micro({ preset: "triage", inputRef: "diagnostic.log", task: "Root cause and repair direction." })
ops({ capability: "micro", action: "batch", withOS: true, args: { tasks: [...] } })
// Multi-turn: create once, then send dependent follow-ups.
ops({ capability: "micro", args: { sessionAction: "create", sessionId: "analysis" } })
ops({ capability: "micro", args: { sessionAction: "send", sessionId: "analysis", task: "Reconcile findings." } })
```

Micro can also be a bounded step in a chain or pipeline; use the structured
`pipeline` examples in `references/capabilities.md`.

Rules:

- Once Micro consumes an `inputRef`, never read, search, or inspect that original
  input again. Treat the Micro answer and receipt as the replacement.
- Prefer `preload` over loading context in the host and passing it inline. OS
  executes the preload; raw output stays in artifacts and Micro context.
- Preload is read-only unless `allowCommands:true` is explicit. Never let Micro
  choose arbitrary shell commands.
- Use `withOS` only with bounded `inspect`, `search`, or context actions.
- Micro `inspect` supports `path`, `paths`, `globs`, `ranges`; `search`
  supports `query`, `globs`. Batch related files into one task.
- Start with preset budgets (`graph` 16000, `custom` 20000). On a budget,
  empty-response, or max-step failure, narrow the task or fall back to OS;
  do not repeat the same call.
- Do not send full-diff audits, broad refactors, or long-lived edits to Micro.
- Preload read-only steps may use `inspect`, `search`, `verify`, and approved
  `run`.
- Provider usage is local-only; report that gap when comparing cost.

## Cold Start And Recovery

If ContextOS tools are not loaded, read the installed `SKILL.md` once using the
exact host path and one complete command, then use `tool_search` once for
`ContextOS`. Never probe with `pwd`, `ls`, `find`, `rg`, `command -v`, or
`git status`. If `tool_search` fails, report the blocker and stop; do not
fall back to shell. Recover state with `ops({ capability: "os_context", action: "brief" })` or
`ops({ capability: "plan", action: "get" })`.

## Plans And Decisions

Keep an active Plan for cross-session work; its summary is the design contract.
Read `references/capabilities.md` only when a lower-level lifecycle action is
actually needed.

## Completion Bar

A task is complete only when:

- the requested behavior is implemented;
- the relevant test, build, or runtime check passed;
- unresolved failures are explicit;
- the final response points to evidence instead of restating raw output.

## Tool Behavior Guarantees

- `inspect` accepts `path`, `paths`, `globs`, `symbol`, `slot`, and `ranges`.
  Default output is bounded; use `budget: "full"` only when the decision requires it.
- `work({ inspect, create/edits/delete, verify })` keeps inspection, mutation, and proof
  in one response. Delete operations are atomic, reject missing/out-of-root paths,
  and participate in verification rollback when `autoRevert:true`.
- If a response contains `artifact=<id>`, fetch only the needed slice with
  `ops` + `capability: "artifact"` + `action: "read"`.
- `verify` accepts `command: "npm test"` or `commands: ["npm test"]`.
  Non-string or empty entries are rejected as `Verdict: FAIL`; never treat an
  empty command list as a passing check.
