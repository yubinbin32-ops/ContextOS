---
name: contextos
description: Keep project architecture, progress, source locators and verified handoffs synchronized with ContextOS in the background. Use compact context packs and targeted AST slices instead of broad file reads.
---

# ContextOS background workflow

ContextOS is a project memory layer for AI coding work. The user describes the task normally; the plugin performs the OS reads and writes in the background. Do not ask the user to repeat “use ContextOS” in every conversation.

The graph stores architecture and intent. Source files define implementation behavior. OS Documents store project narratives. README stays in its repository location and is read-only in the App.

## Start a task

1. Call `context_for_task` once with the absolute `projectRoot`. Register an uninitialized directory with `project_register` first. Keep the returned `taskContextId` for budgeted reads.
2. Read only the relevant rules, Decisions, Plans and source locators. Use `plan_context` for a Plan and `entity_open` for one Block, Chain, Link or Decision. Do not reread the repository to reconstruct an architecture already present in the graph.
3. Reuse a matching active TaskSession from `context_for_task` or `sync_issues`. Otherwise register new Blocks and Decisions, then call `task_begin` with the relevant Block IDs. Pass `planId` when the work extends a Plan; pass `chainId` or a feature descriptor for a user-visible feature. A genuinely independent Block may use `standaloneReason`. A review-only task may use `readOnly: true`.
4. `task_begin` and `task_reconcile` safely append new PlanChanges and ChainScopes. They never replace an existing Plan list. When a task grows, use `plan_append_changes` or `plan_append_chain_scope`; use full replacement only for an intentional reorder or removal.

## Keep the architecture connected

- A Block is an independent architecture unit. A Link is a typed relation such as `calls`, `reads`, `writes`, `validates` or `constrains`.
- A Chain is an observable feature network. A Leaf Chain owns a focused Block path; a Composite Chain owns a short typed route of child Chains and/or direct Blocks. Every route edge has explicit endpoints in its declared members and points forward in the member order. Forward DAGs are reordered automatically at context, stream and task boundaries. Cycles, disconnected components and missing endpoints remain visible validation issues.
- `chain_reconcile` audits membership as well as order. It attaches a safe forward route Link when both endpoints are already in the Chain, and it expands a related Block when the Block carries `chain:<chain-id>` (or `chain-affinity:<chain-id>`) or has a high-confidence feature match plus a declared route Link touching the Chain. An affinity tag without a route Link stays visible as a membership gap until the forward relationship is declared. It then reorders the resulting DAG and returns the added Block/Link IDs. Read-back, dependency and feedback relations remain cross-cutting when placing them in the forward route would create a cycle; the relation is still visible in the global graph.
- Run `architecture_link_suggest` as a review inbox. High-confidence candidates require target-symbol use in the Block's AST slice. Shared files and layer conventions are weak evidence. Do not connect every import, and do not create meaningless Links just to remove an alert.
- Persist accepted relationships with `architecture_connect` or `graph_flow`, then extend an existing Chain with `chain_append`. `graph_flow` creates or updates Links; it does not automatically make Chain membership. For a new feature Block, add its explicit route Link and the `chain:<chain-id>` affinity tag in the same mutation when the feature is known. Use `chain_reconcile` to inspect or repair an existing Chain after a Block or Link was added. A deliberately independent Block carries `standalone:<reason>` so it is distinguishable from a missing feature assignment.
- Keep long features readable by grouping their focused paths into a Composite Chain with `chain_compose`. The parent is the macro map; child Chain paths remain the implementation map. Use `mode:"set"` for a complete ordered route and `mode:"append"` when a stage is added. The operation checks typed endpoints, forward DAG order, duplicate members, cycles and child existence before writing.
- `graph_status` reports isolated Blocks, ghost implementations, disconnected Chain paths, stale checkpoints and semantic reviews. `linksOutsideChains` is diagnostic: cross-cutting Links may intentionally stay outside feature Chains.

## Read and edit source precisely

- Normal `context_for_task`, `entity_open` and `chain_code_stream` responses are locator-first: path, symbol, derived line range, signature and contract. They never return a containing file body.
- Use `block_code_stream(mode:"slice")` for the implementation of one Block. It returns a bounded AST symbol slice only when the SourceRef is valid; otherwise it returns the locator and a reason to rebind. Treat a full-file read as an explicit fallback for parser failure or a file-level change.
- Source bindings are rescanned at ContextOS boundaries. Line numbers are derived from the current symbol; do not trust stale ranges. Use `source_binding_suggest` and `source_binding_accept` when a symbol moved or a new file needs a binding.
- Use `run_command` for tests and builds. It returns a redacted, compressed receipt so routine logs do not fill the model context. Use `log_sanitize` only for logs supplied outside the command gateway.

## Synchronize and finish

1. After edits call `task_reconcile`. It indexes changed files, advances a safely anchored ghost Block to implementing, reconciles the feature Chain topology, appends explicit task Blocks/Links even when the Blocks already belong to the Chain, refreshes Plan coverage, and records unresolved issues.
2. Resolve invalid bindings, missing route Links, disconnected Chain paths and required checkpoints. Keep cross-cutting relations explicit in the global graph and place them in a feature Chain when their direction fits the forward route.
3. Record evidence with `checkpoint_record`. A fresh passed direct Block checkpoint is required before sealing a source-backed Block. A Chain integration checkpoint is required only when explicitly declared or bound to a Plan ChainScope.
4. Call `task_finish` with the latest `sourceRevision`, `graphRevision` and a stable `idempotencyKey`. It completes verified Blocks/Chains and advances matching PlanChanges together. Retry the same key after an uncertain response.
5. Call `graph_validate`. Report unresolved legacy warnings separately; never claim the graph is healthy when validation fails. If projection is pending, recover it before declaring the work synchronized.
6. Use `timeline_sync` for the current focus and next action. Do not advance an unrelated Plan merely because the current task finished.

## Project knowledge

- Write internal reports, designs and guides with `document_write`, then return the document's `openURL`. Use `document_patch` with `expectedRevision` for a chapter update.
- Keep README as a public, repository-owned file. The App previews `README.md` and `README_zh.md` read-only, including relative images. Internal `docs/` narratives belong in OS Documents after migration review; machine-readable benchmark JSON may remain in the repository.
- A Decision records one durable choice with rationale, alternatives and consequences. It is not a replacement for a report, Plan or architecture Block.
- Keep measurements separate from experience. The author's “about 60% fewer context compactions” is a usage impression, not a controlled benchmark.

## Tool reference

| Purpose | Tools |
|---|---|
| Orient | `context_for_task`, `project_map`, `plan_context`, `entity_open`, `graph_search` |
| Knowledge | `document_list`, `document_open`, `document_write`, `document_patch`, `document_import` |
| Architecture | `graph_mutate`, `graph_patch`, `graph_flow`, `architecture_link_suggest`, `architecture_connect`, `chain_append`, `chain_compose`, `chain_reconcile` |
| Plan growth | `plan_append_changes`, `plan_append_chain_scope`, `task_begin(planId)`, `task_scope(planId)` |
| Source | `source_sync`, `source_index`, `source_binding_suggest`, `source_binding_accept`, `chain_code_stream`, `block_code_stream` |
| Task lifecycle | `task_begin`, `task_scope`, `task_reconcile`, `task_finish`, `sync_issues` |
| Verify | `run_command`, `checkpoint_record`, `block_seal`, `graph_status`, `graph_validate` |
| Runtime | `runtime_info` after installation or an update |

The parser adapters are syntax-based locators, not a complete semantic compiler. Unsupported or ambiguous symbols stay explicit. Feature intent is declared by the agent or user; import graphs alone do not prove a business flow.
