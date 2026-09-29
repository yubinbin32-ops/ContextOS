---
name: contextos
description: MUST be used for non-trivial repository engineering (architecture exploration, multi-file edits, in-situ test verification, refactoring). For trivial 1-line edits, use direct change or native tools to avoid fixed context overhead.
---

# ContextOS

Default transport is the compact `contextos` tool:
`action: "explore"|"inspect"|"work"|"change"|"verify"|"ship"|"pipeline"|"micro"|"resume"|"ops"`.

## Hard gates

- Use ContextOS for non-trivial repository work. Do not replace it with per-file `cat`/`sed`/`rg`, ad-hoc `npm test`, or native `apply_patch` loops.
- If the compact tool is not visible, call `tool_search` once with `ContextOS compact repository tool` before native exploration. Do not call `list_mcp_resources`. Loading this Skill does not prove the MCP tool is unavailable.
- Never re-read this Skill with shell commands.
- Controlled A/B/C sessions are valid only when the plugin is installed and enabled and the host performs one `tool_search` discovery before native exploration. Do not assume first-turn MCP visibility; current Codex versions defer plugin MCP tools and the old `tool_search_always_defer_mcp_tools` flag is ineffective.
- Isolated test launchers must export `CONTEXTOS_HOME`; plugin configuration alone does not override the MCP process environment.
- Do not call the host `update_plan` during an OS-owned task. OS session state is the plan.

## Route work

- Trivial one-line change: one bounded `change({ edits, verify })`; skip `explore` and `ship`.
- Normal or complex task: first call one `pipeline` containing `explore`, any known `inspect`, and baseline `verify`; then one `change`/`work` containing all edits, `verify`, `architecture`, and final `ship`.
- Do not split the workflow into mechanical `explore -> inspect -> verify -> change -> ship` turns. One host decision is one OS call.
- A pipeline response with `status`, `receipt`, or `Micro-Triage` is already the decision packet. Do not call `resume` or replay raw artifacts.
- After `read_complete=true`, mutate directly. After `read_complete=false`, make only the named bounded recovery read, then mutate.
- Search with `work.search` or pipeline `{ tool: "search", args: { query, root|paths } }`; do not fall back to native `rg`.
- Use `maxLogBytes` on `run_command`, `process`, `verify`, or `change` verification when a command may emit large logs; receipts return `logBytes` and `logTruncated`.
- Do not place native `sed`/`cat`/`rg`/`npm test` between OS calls.
- A passing `verify` is final evidence. Do not rerun it or make speculative cleanup edits after PASS.

## Inspection

- Prefer exact `inspect({ path, symbol })` or `inspect({ path, ranges })` slices.
- Use `inspect({ paths: [...], budget: "shallow" })` for maps. A multi-file inspect returns outlines and locators.
- Use `budget: "full"` only for one bounded file or one symbol. Whole-file replacement belongs in `change`/`work` edit payloads.
- Read a large file once. Do not reconstruct it with many 80-line slices.
- `work` accepts `search`, `inspect`, `create`, `edits`, and `verify` in one call. `change` is the focused mutation route.

## Micro

- Micro is an explicitly assigned out-of-context executor, not the decision maker.
- Attach bulky evidence directly to the first Micro call with `pipeline: { steps: [...] }`; do not run a separate pipeline and copy its output.
- Use Micro when raw failure/log evidence needed by the host exceeds 2,000 characters. Do not use it for a trivial edit or when OS triage already reduced the evidence to budget.
- If the host can continue before the answer is needed, use `delivery: "defer"` or `"auto"`; the result is restored on a later top-level OS call. Use `"immediate"` only when the next decision depends on it.
- `delivery: "errors-only"` is general fire-and-forget: successful output stays in the receipt/artifact and is hidden from the host; only failed tool calls return an error. Use it when the host can continue without the answer.
- For executor validation, set `withOS:true`, `invocation.tools.enabled:true`, `invocation.tools.allowCommands:true`, and enough `provider.maxRequests`. Check `providerRequests`, `toolRounds`, `toolCalls`, and `executionMode`; summarizer-only is not executor evidence.

## Architecture

- Blocks are semantic ownership boundaries. Chains group Blocks. Links express directed relationships.
- Never use `mod-*` ModuleIndex identities or `kind: "module"` as ownership.
- After changing business code, include `architecture.blocks` and `architecture.chains` in the same `change`/`work`.
- A state-only architecture update is valid: `change({ architecture })` binds Blocks and Chains in one atomic call, without dummy edits.
- Discover graph state with `ops({ capability: "architecture", action: "list|open|search" })`; `block.get` and `block.inspect` alias `block.open`.
- Compact schema:

```js
architecture: {
  blocks: [
    { id: "block-api", title: "API boundary", kind: "service", paths: ["src/api.mjs"], summary: "..." }
  ],
  chains: [
    { id: "chain-api-flow", title: "API flow", memberIds: ["block-api"] }
  ]
}
```

- Every tracked source path needs exactly one curated Block owner and at least one Chain membership.
- A failing `verify` blocks `ship` unless `allowUnverified:true` is explicit. A blocked architecture contract must not leave partial ownership behind.

## Advanced capabilities

Stateful capabilities are reachable through `ops({ capability, action, args })`. Legal capabilities: `os_context`, `plan`, `task`, `block`, `chain`, `architecture`, `code`, `run_command`, `process`, `knowledge`, `session`, `system`, `profile`, `micro`, `artifact`, `telemetry`. Use `architecture` for Block/Chain discovery; do not shell-read capability source or re-read this Skill.
