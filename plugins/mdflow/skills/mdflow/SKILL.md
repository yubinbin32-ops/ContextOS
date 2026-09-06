---
name: mdflow
description: Use a verified local mdflow project graph to retrieve task-scoped development context and synchronize architecture, contracts, code locations, ordered Plans, progress, risks, and checkpoint evidence. Applies when a project contains .mdflow/project.json or the user asks to use mdflow.
---

# mdflow

Use mdflow as the canonical development-context system after its graph has passed validation. Public/release documentation may remain Markdown; ordinary development architecture, planning, progress, evidence, and implementation locations belong in mdflow.

AI-facing development context is returned as deterministic Markdown projections, not as a second free-form Markdown source. Do not create an orphan design, decision, runbook, or status `.md` file merely because the handoff is naturally readable as Markdown. Map that intent to the existing mdflow record below, then let MCP render the Markdown view.

## Trust gate

- Resolve the absolute repository root and pass it as `projectRoot` to every tool call. Never reuse entity IDs across project roots.
- If `.mdflow/project.json` is absent, register the project, then build its graph from verified source facts. Do not claim Markdown replacement until the graph can reconstruct the project's essential architecture, contracts, decisions, Plans, checkpoints, and code locations.
- If the graph is known to be incomplete, stale, under migration, or under repair, treat it as untrusted. Read the smallest explicitly relevant source/document set, repair and validate the graph, then switch back to mdflow-first use.
- Never copy examples, test-project facts, or another repository's graph into the active project.

## Read progressively

For a trusted graph, call `context_for_task` before broad file discovery, opening development Markdown, or reading implementation files for orientation. Use this order:

1. `context_for_task` with the actual task and a modest character budget.
2. `plan_context` when implementing or reviewing a Plan. Read its ChainScopes, inline entity changes, prohibitions, code locations, and gates before opening files.
3. `project_map` when whole-project order or active Plan sequencing matters.
4. `entity_open` for exact Block, Chain, Link, Decision, or non-Plan details.
5. `changes_since` after a known change sequence to synchronize only incremental mutations.
6. `graph_search` only when the returned references are insufficient.
7. Open source references returned by mdflow and the smallest immediately related code neighborhood.

Read-tool response budget:

- Every MCP tool is Markdown-first by default, including mutation, checkpoint, validation, and read tools. MCP clients may place both `content` and `structuredContent` in model context, so a duplicate JSON projection wastes context and can create conflicting facts.
- Pass `includeStructured: true` only when the caller must programmatically inspect exact fields, IDs, evidence, receipts, or before/after values. That opt-in returns the full structured payload; it is not part of ordinary reasoning.
- Write and validation results include changeSet IDs, revisions, and validation errors in their Markdown receipt; request `includeStructured: true` only when a follow-up needs machine-readable fields.
- Markdown projections are deterministic: coverage summary → execution order → direct Block work → Chain paths and gates → Plan acceptance → uncovered or failing items. Stable `block:`, `chain:`, `plan:`, `checkpoint:`, and `plan_change:` refs are required; Markdown is a structured projection, not free-form pasted prose.
- Keep the Markdown `maxChars` budget modest. Do not copy full entity bodies into Plans, Chain paths, or History; use `entity_open` with an exact ref when more detail is needed.

The context must cover the facts needed for the task: positive requirements, prohibitions, state transitions, architecture, interfaces/contracts, current progress, decisions, risks, code locations, ordered steps, checkpoint gates, and relevant history. If a required fact is missing, record the gap, investigate narrowly, and repair it before relying on mdflow later.

## AI-facing development record contract

Treat a Markdown-shaped need as a semantic record, not as permission to add another prose source:

| Need | Canonical mdflow record | Write when | Read with |
| --- | --- | --- | --- |
| Architecture or component | Block, Link, Chain, source ref | When a responsibility or relationship is discovered or changed | `context_for_task`, `project_map`, `entity_open` |
| Requirement or risk | Block with the appropriate kind and contract | When the requirement is accepted, narrowed, or invalidated | `context_for_task`, `entity_open` |
| Scoped project rule | Background rule with explicit project/lens/chain/repo scope | Before work that depends on the rule, and when the rule changes | Context rule index first; expand only on demand |
| Implementation order | Plan, PlanChange, Plan step, ChainScope | Before coding a new responsibility or changing intended scope | `plan_context`, `entity_open` |
| Design rationale or durable architecture decision | A scoped `Decision` record; keep Plan-specific execution rationale in the owning PlanChange | At the moment the choice is made, including alternatives and consequences | `decision_list` for the index, then `decision_open`/`entity_open(type=decision)` for one record |
| Verification | Atomic Checkpoint, evidence, dependency DAG | Immediately after the check or when its criteria changes | `checkpoint_list`, `entity_open`, `changes_since` |
| Timeline or implementation handoff | History plus Plan step status | Automatically through every MCP mutation; reconcile before handoff | `changes_since`, `entity_open`, `plan_context` |
| Reusable operational procedure | A Plan (or a dedicated Block only when it is a durable capability) | When the procedure will be reused across tasks | `plan_context` |
| README, release note, store copy, landing page | Public/release Markdown outside the graph | During release preparation | Open the explicit public file; never treat it as current architecture |

History is the automatic audit ledger, not a long-form decision document. Do not write a separate runbook or decision note for every mutation. A Decision record is justified only when a future agent needs the alternatives, chosen trade-off, or long-lived consequence; ordinary before/after fields, changed fields, source refs, Plan ownership, and evidence stay in History and Checkpoints. Decision records are project memory with explicit `project`, `lens`, `chain`, or `repo` scopes: they are not Blocks, never appear on Canvas, never receive Block/Chain/Plan checkpoints, and are returned as an index unless their body is explicitly opened.

Rules are constraints, not design essays. Keep the rule's scope and enforceable statement in the scoped rule system. Put explanatory architecture rationale in the affected Block/PlanChange or an explicitly linked decision record. Rules never become Canvas nodes and their full bodies are not appended to every context pack.

If no existing record can express a fact, stop and repair the graph model or add the smallest semantic Block/Link/Plan/Checkpoint needed. Do not bypass the gap by writing an untracked development Markdown file.

## Timely write protocol

Write the canonical record at the same boundary where the fact becomes true:

1. After discovering or reconciling architecture, write Blocks, Links, source refs, and scope before editing implementation files.
2. Before coding a planned responsibility, write or update the Direct PlanChange, current behavior, proposed behavior, prohibitions, and expected effects.
3. After a meaningful code/config/schema change, update the affected source refs and Plan/step state in the same task turn; do not defer all graph writes to the end of a long task.
4. Immediately after a test, manual review, or real-target run, record the Checkpoint status, evidence level, command, result, and limitations. Never mark a test as passed only in prose.
5. When a requirement, scope, design choice, or blocker changes, update the owning record before proceeding on the new assumption. Write a scoped `create_decision`/`update_decision` record for a durable cross-entity choice; keep a Plan-local rationale in the PlanChange and let History capture the mutation. Never create a `decision` Block.
6. Before handing work to another AI or ending a task, read back the changed entities, call `changes_since` from the last known sequence, run `graph_validate` for structural/completion changes, and sync the Git head where relevant.

Use `graph_patch` with a current `base` for small AI-authored updates. Every write must preserve omitted fields, advance one revision, and produce a compact Markdown receipt. The next read must use the returned refs/revision; do not continue from an unverified assumption.

For normal AI reads, request the Markdown projection (`context_for_task` → `plan_context` → exact `entity_open` → `changes_since`). Request `includeStructured=true` only when code needs exact IDs, evidence arrays, before/after values, or a machine-readable receipt. Public Markdown is readable by people, but it is never a substitute for the current mdflow context during development.

## Build and maintain the graph in semantic order

1. Create stable global Blocks for durable responsibilities. A Block is not a file, Todo, Plan, or arbitrary note. A Block may exist without a checkpoint while the architecture is being modeled; create an atomic checkpoint when the requirement has a verification criterion, the Block enters implementation work in a Plan, a Chain/Plan gate depends on it, or the user explicitly requests verification. When that intent is already known, create the Block and checkpoint in the same `graph_mutate` ChangeSet with `create_block` plus `create_checkpoint`.
2. Create typed global Links for real relationships. Link style and meaning come from `kind`, never Chain membership.
3. Define ordered Chains as reusable paths over existing Block and Link IDs. A Block may be in multiple Chains; Chains never own or duplicate Blocks.
4. Create ordered Plans that cover all intended work. A Plan may directly change a Block or Link even when it belongs to no Chain; do not require a Chain merely to make work visible. Add `plan_chain_scopes` only for exact reusable paths that the Plan changes or integrates.
5. Define one canonical `plan_change` per affected Block, Link, or Chain. Bind the affected Block's checkpoint to its PlanChange when that verification is required for the Plan. Record current behavior, proposed behavior, reason, prohibitions, expected effects, and exact source locations. Reuse that same change from multiple ChainScopes through references; never duplicate it.
6. Build checkpoint bindings and a dependency DAG. Atomic checks bind to the affected change/entity; aggregate Chain gates derive from required children; integration gates become eligible only after their children pass; Plan gates aggregate Chain and cross-Chain acceptance.
7. Attach implementation/test/schema/configuration locations to Blocks using source references. Keep one canonical fact in one storage location and derive other views from it.

### Decision records are project memory

- Use `create_decision` when a choice has alternatives, a selected trade-off, or a consequence that a later task must remember. Give it an explicit scope (`project`, `lens`, `chain`, or `repo`); use `decision_list` in ordinary context and `decision_open` only when the rationale is relevant.
- A Decision is deliberately outside the Block/Link/Chain/Plan graph. Do not add it to Canvas, Chain nodes, PlanChanges, checkpoint bindings, or coverage counts. A PlanChange may reference a Decision in prose or source refs when the implementation rationale needs a stable pointer.
- `History` still records every Decision create/update and scope change. Do not duplicate that audit trail with a second decision note. Mark a Decision `superseded` and set `supersedesDecisionId` when a later choice replaces it.
- If an old graph contains `kind=decision` Blocks, treat them as legacy data: do not create more, do not put them on Canvas, and migrate the durable rationale to a scoped Decision record.

Plan phase/order should make a new project readable from foundation through delivery. Todo is derived from unfinished Plan steps, gates, blockers, and next actions; do not create Todo Blocks or Plan Chains.

## Initialize a project before implementation

When requirements describe a system that has not been implemented yet:

1. Build the complete Block/Link architecture first. Mark unimplemented Blocks `proposed` or `planned`; do not omit Blocks simply because no Chain exists yet. Record durable cross-cutting choices separately as scoped Decisions; Decisions are not architecture Blocks.
2. Give every Block that is actually being verified an atomic checkpoint with explicit criteria for that Block's own responsibility. Use `graph_mutate` `create_checkpoint`, `checkpoint_record`, or compact `checkpoint`/`checkpoint=auto` only when the verification requirement exists. A reusable Test Block verifies the test capability itself; whole-system acceptance is a Plan integration checkpoint, not a Test Block.
3. Define Chains only for meaningful reusable paths through the existing network. A Block may remain outside every Chain; it becomes required work or verification only when a Plan, requirement, or gate says so.
4. Create a foundation Plan with direct Block PlanChanges for all Blocks that need implementation, including Blocks outside Chains. Prefer `foundation_plan_create` after the complete Block/Link architecture is present: it creates missing atomic Block checkpoints, dependency-ordered parallel groups, exact Direct Block PlanChanges, Chain integration gates, and the final Plan acceptance gate in one transaction. Use `graph_mutate` only when the Plan needs a deliberately custom structure; use compact receipts instead of repeating full objects.
5. Add Chain integration checkpoints after the necessary Block checkpoints exist. Make Chain gates depend on their required Block/Link checks, then make the final Plan gate depend on the required direct and Chain evidence.
6. Inspect architecture coverage before implementation: total Blocks, Blocks with checkpoints, verified Blocks, Blocks covered by Plans, Blocks outside Chains, unplanned Blocks, and Blocks whose verification is required but whose checkpoint is missing. A checkpoint-free Block is visible and intentional until a requirement makes verification necessary; missing required checkpoint or Plan coverage is incomplete.

Do not claim a verification requirement is complete while its required checkpoint is missing, or claim architecture initialization is complete while intended Plan coverage is missing. A Plan with direct Block work is valid even when it has no target Chain.

## Mutation fidelity

- Keep every mutation small, cohesive, and truthful. Use current `expectedRevision`; on conflict, reopen and reconcile.
- For small AI-authored edits, prefer the `graph_patch` MCP tool with the `mdflow/1` Markdown-like format. It is only a compact transport: the server expands it into the same atomic ChangeSet, history, revision, validation, and canonical graph writes as `graph_mutate`.
- A compact patch should normally include `base=<graphRevision>` and a `reason="..."` header. Example:

  ```text
  mdflow/1 base=539 plan=foundation reason="Record the verified layout change"
  update block:city-layout@3
  summary="Bounded overview routing is in place"
  delivery=verifying
  checkpoint block:city-layout@1 status=partial_pass evidenceLevel=real_target evidence="Overview smoke test passed"
  ```

- `update block|chain|link|plan:<id>` changes only the listed fields; omitted fields are preserved. `create block:<id> ... checkpoint=auto` explicitly requests the Block's atomic checkpoint in the same ChangeSet; when the header includes `plan=<id>`, it also creates the direct PlanChange and binds that checkpoint. A plain Block create does not manufacture a verification obligation. `checkpoint <type>:<id>` updates the target's existing atomic checkpoint (or creates one when absent). `update plan_change:<id>` requires or infers its owning `plan`; `source block:<id>` attaches a source reference.
- Do not use compact syntax to bypass graph validation, Plan/ChainScope ownership, or checkpoint evidence rules. If the patch base is stale, the server must reject the whole patch; reopen context and retry with a new base revision.
- The default patch receipt is Markdown and includes the ChangeSet, graph revision, applied refs, validation result, and compact coverage summary. Request `includeStructured=true` only when exact machine-readable receipts are required.
- Prefer `graph_mutate` actions that compose a known verification requirement in one ChangeSet: `create_block` + `create_checkpoint`, then `set_plan_changes` and `set_checkpoint_bindings` when a Plan directly owns the work. For architecture-only discovery, create the Block without a checkpoint and let Foundation/Plan planning add the required check later.
- When implementing a Plan, pass its `planId` to `graph_mutate` and `checkpoint_record`. Once work is narrowed to a ChainScope, also pass `chainScopeId`; do not rely on prose summaries to reconstruct task ownership later. The service validates the relationship and records it in compact History metadata.
- Use `change_set_revert` only for a fully reversible update-only ChangeSet. It creates a new reverse ChangeSet and preserves the original audit trail. If the target is stale, contains creates/deletes/relation replacement, or cannot be reversed completely, accept the rejection and reconcile explicitly; never simulate success with a partial revert.
- Store each project fact once, in the language used by the project or current author. Do not generate or maintain translated copies of Block, Link, Chain, Plan, Checkpoint, evidence, or history fields unless the user explicitly asks to translate project content.
- Treat App interface localization as separate from graph content. A `locale` argument may select tool-generated headings or labels, but it must not cause entity fields to be translated or duplicated. Do not send `localizations` merely because the App supports English and Chinese.
- After every meaningful write:
  1. inspect every returned `ref`, `revision`, and `uiLocation` receipt;
  2. call `entity_open` for every changed semantic entity;
  3. compare the read-back against the intended positive requirements, prohibitions, ordering, contracts, and acceptance conditions;
  4. run `graph_validate` when topology, Plan workflow, completion, or contracts changed.
- If read-back loses or distorts a fact, stop implementing from that graph. Correct the graph/schema/Skill before recording more progress.
- When implementation disproves the documented architecture, update the architecture immediately.

## Progress and evidence

- Block/Chain delivery lifecycle: `proposed`, `planned`, `implementing`, `verifying`, `complete`, `deprecated`.
- Plan status: `draft`, `ready`, `active`, `verifying`, `complete`, `blocked`, `failed`, `retest_required`, `cancelled`.
- Plan step status: `pending`, `active`, `complete`, `blocked`, `failed`, `skipped`.
- Checkpoint outcome: `pending`, `running`, `passed`, `partial_pass`, `failed`, `blocked`, `not_supported`, `retest_required`.
- Evidence level, weakest to strongest: `none`, `static`, `simulated`, `integration`, `real_target`, `human_review`.
- A passed gate requires complete coverage and evidence at least as strong as its required level. Static analysis is not real-target proof.
- Aggregate checkpoint status is derived and cannot be manually forced to passed. Required failure/blocked/retest states propagate; optional failures remain visible warnings without blocking success.
- Reject checkpoint dependency cycles. A Chain integration checkpoint runs only after its required Block/Link children pass.
- Mark stale evidence `retest_required` when the implementation or environment invalidates it.
- Never declare a Plan complete while dependencies, required steps, or required gates are incomplete.

## Storage vocabulary

- Block `kind`: `principle`, `product`, `requirement`, `flow`, `ui`, `service`, `function`, `integration`, `data`, `database`, `risk`, `test`, `checkpoint`.
- Decision: `id`, `title`, `summary`, `rationale`, `alternatives`, `consequences`, `status`, optional `supersedesDecisionId`, and scoped `project`/`lens`/`chain`/`repo` records. It is project memory, not a Canvas entity or checkpoint target.
- Block `architectureLayer`: `client`, `boundary`, `application`, `domain`, `data`, `external`, `quality`, `infrastructure`, `unspecified`.
- Link `kind`: `flows_to`, `calls`, `reads`, `writes`, `depends_on`, `implements`, `validates`, `constrains`, `supersedes`.
- `scope` is semantic metadata only; it does not imply Canvas position. Set `localOrder` only to stabilize order inside a semantic area.

The desktop App is a live read-only projection. MCP writes must produce a change-feed event and become visible without manual refresh.

When a Git checkout or atomic replacement changes `.mdflow/mdflow.sqlite`, both the desktop reader and any long-lived MCP router must detect the file identity change, discard the stale connection, and reopen the new database before serving the next read or write. A path that stayed the same is not proof that the active graph is current.
