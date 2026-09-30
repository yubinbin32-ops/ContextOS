# ContextOS Architecture Decisions

This file records only decisions that describe the current system. Superseded
designs, benchmark ledgers, and historical migration notes are removed instead
of being preserved in the product tree.

## DEC-101 Single MCP Entry with Full Capability Passthrough

Status: Accepted

The public MCP surface exposes exactly one tool:

```js
contextos({ action, args, projectRoot })
```

`ask`, `command`, `agent`, and `change` are the primary actions. Orchestration
and advanced capabilities remain available without a second tool surface:

```js
contextos({ action: "pipeline", args: { steps: [...] }, projectRoot })
contextos({ action: "plan", args: { ... }, projectRoot })
contextos({ action: "ops", args: { capability: "task", action: "open", args: {} }, projectRoot })
```

The main thread may use native tools or any original ContextOS capability
directly. API Micro and the optional CLI agent are convenience paths, not
mandatory hops. There is no legacy seven-tool compatibility surface.

## DEC-102 API Micro Is the Semantic Assistant

Status: Accepted

API Micro is the configured semantic "cerebellum" for ContextOS. It receives
natural-language requests, reads code or command evidence through a restricted
read-only broker, and returns selected source or log evidence to the host.

- It never edits files, runs host commands, or recursively delegates.
- Exact known-path reads bypass the model and require no API request.
- Provider requests, failures, and observed usage are recorded under the
  `api-micro` role.
- Missing configuration disables semantic retrieval; it does not silently
  fall back to another provider.

The effective configuration is the top-level `micro` object in the private
profile. The runtime reads only the canonical `micro` and `agents` shapes.

## DEC-103 CLI Agent Is an Optional Subagent

Status: Accepted

The CLI agent is an optional subagent selected through `agents.default` and
`agents.adapters`. It is used for bounded analysis or isolated implementation
work and is expected to have the ContextOS MCP tool installed so it can call
`ask` for evidence.

- A CLI worker may talk with the host through `agent({ action: "send" })` and
  `agent({ action: "messages", waitMs })`.
- A worker may call `ask`, `command`, and `change` as allowed by its task, but
  worker mode rejects nested `agent` dispatch.
- A finished conversation can continue with its persisted `cliSessionId` when
  the adapter defines `resumeArgs`.
- Permission denial is a blocker; the runtime does not bypass host approval.
- The host reviews the diff and runs independent acceptance checks before
  integrating CLI work.

CLI usage is recorded under `cli-agent`. Its provider usage may be lower than
the host model, so complex bounded work should be delegated when appropriate,
but delegation is always the agent's decision.

## DEC-104 Configuration and Switching Are Visible

Status: Accepted

The macOS and Windows settings surfaces display the effective API Micro and
CLI agent configuration without exposing credentials. Installation, key
debugging, provider/model switching, thinking changes, adapter mapping, and
permission grants are documented in the ContextOS skill package:

- `plugins/contextos/skills/contextos-ops/SKILL.md`
- `plugins/contextos/skills/contextos-ops/references/micro-setup.md`

When a user asks to switch a role, the AI follows those instructions rather
than editing runtime code or inventing flags.

## DEC-105 Cost Target and Evaluation Method

Status: Accepted

The working target is a 60% reduction in user-equivalent token cost for a
complete development task:

```text
main raw + api-micro raw / 7 + cli-agent raw / 7
```

The `/7` factor is a user-specific relative-price estimate, not an invoice.
Raw usage and the estimate are reported separately. Missing usage stays
unknown, and failed or interrupted work keeps any observed usage.

Evaluation uses real development scenarios in visible host conversations or
host subagents. It does not use an in-repository benchmark runner as the
source of truth. A result counts only when the task, acceptance checks,
implementation hash, and complete per-role usage are all available.

## DEC-106 Installation Must Prove the Fresh Runtime

Status: Accepted

The plugin installer must:

1. Build and synchronize the current bundle and skill tree.
2. Verify the installed files match the build.
3. Start a fresh MCP process and require exactly one `contextos` tool with the
   `action`, `args`, and `projectRoot` schema.
4. Tell the user that an existing conversation may still cache the previous
   MCP process and that a new conversation is required.

The install and configuration paths must be exercised from a fresh host
conversation before a release is considered verified.
