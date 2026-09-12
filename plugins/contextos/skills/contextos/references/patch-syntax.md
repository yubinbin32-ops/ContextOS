# contextos/1 Patch Syntax Reference

`graph_patch` accepts a compact Markdown-like patch and atomically expands it into the standard ChangeSet operations.

## Header Syntax

```text
contextos/1 [base=<revision>] [plan=<planId>] [scope=<chainScopeId>] [reason="<string>"]
```
- `base`: Expected graph revision. The server rejects the patch on revision mismatch to prevent lost updates.
- `plan`: Owning Plan ID for inline PlanChanges and checkpoint bindings.
- `scope`: Owning ChainScope ID when working within a specific chain path.
- `reason`: Human-readable rationale recorded in the ChangeSet receipt and History.

## Entity Directives

### 1. Blocks
```text
create block:<id> [title="<title>"] [kind=<kind>] [layer=<layer>] [scope=<scope>] [checkpoint=auto]
update block:<id> [title="..."] [delivery=<deliveryState>] [health=<healthState>]
```
- Omitted fields on `update` are preserved.
- Setting `checkpoint=auto` creates the Block's atomic checkpoint in the same transaction.
- When `plan` is set in the header, `checkpoint=auto` also creates a Direct PlanChange and binds the checkpoint.

### 2. Natural Flow
```text
flow: <source> -> <target> -> <target2>
flow: <source> -[calls]-> <target> -[reads:config]-> <db>
```
- Automatically resolves Block IDs and creates or updates validated `flows_to`, `calls`, `reads`, or `writes` Links.

### 3. Checkpoints
```text
checkpoint <type>:<id> [status=<status>] [evidenceLevel=<level>] [evidence="<summary>"]
```
- Updates existing checkpoint or creates one if absent.
- `status`: `pending`, `running`, `passed`, `partial_pass`, `failed`, `blocked`, `not_supported`, `retest_required`.

### 4. Source References
```text
source block:<id> path="<file-path>" [symbol="<name>"] [role="<role>"]
```
- Binds source file path and AST symbol directly to an architecture Block.

### 5. Plan Changes & Steps
```text
update plan_change:<id> [status=<status>] [rationale="..."]
update plan_step:<id> [status=<status>] [title="..."]
```

### 6. Deletions (Full CRUD)
```text
delete <entityType>:<id>
```
- Supported entity types: `block`, `chain`, `link`, `decision`, `plan`, `checkpoint`.
- Automatically executes cascading cleanup across links, child nodes, checkpoints, and bindings.

