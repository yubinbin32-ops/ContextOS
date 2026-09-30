---
name: contextos
description: MUST be used for non-trivial repository engineering (architecture exploration, multi-file edits, in-session verification, refactoring). For a trivial 1-line edit, use direct change or native tools to avoid fixed context overhead.
---

# ContextOS

Default transport: `contextos({action,args,projectRoot})`.

## Hard gates
- Use OS for non-trivial repository work. Do not replace it with per-file `cat`/`sed`/`rg`, ad-hoc `npm test`, or native `apply_patch` loops.
- If the compact tool is not visible, call `tool_search` once with `ContextOS compact repository tool`; do not call `list_mcp_resources`.
- Load this Skill once. Do not reread it, shell-read for recovery, or call host `update_plan`.
- A/B/C launchers must install/enable the plugin and export `CONTEXTOS_HOME` before `codex exec`; do not spend a turn checking it.
- After `decision=complete` or `read_complete=true`, use `change`/`work`; native mutation/reads/tests violate the protocol. Passing verify is final evidence.
- After a complete decision package, prefer `change`/`work`; if a named path is genuinely missing, use one explicit bounded recovery read with `full:true`/`refresh:true`, then mutate.

## Route work
- Trivial one-line change: one `change({edits,verify})`; skip `explore` and `ship`.
- Complex task: first call one `pipeline` with `explore`, known exact `inspect`, and baseline `verify`. Then one `change`/`work` with all edits, verify, architecture, and ship. No standalone opening call or directory-wide `inspect` (`paths:["."]`); exploration supplies the map.
- After `change` reports `verified and shipped`, finalize immediately; do not issue another `change` unless a failing check or an unmet requirement is explicitly present.
- A decision packet is final: do not call `resume` or replay raw artifacts. After `read_complete=true`, mutate directly; after `false`, make only the named bounded recovery read.
- Search with `work.search` or pipeline `{tool:"search",args:{query,root|paths}}`; use `maxLogBytes` on noisy commands. Do not place native `sed`/`cat`/`rg`/`npm test` between OS calls.
- `verify.commands` is an array of command strings; pass a top-level `maxLogBytes` when the batch may be noisy.
- Public surface: if `explore` reports a barrel gap, include the entrypoint/barrel update in the same change when the new capability is public.

## Inspection
- Prefer exact `inspect({path,symbol|ranges:[{startLine,endLine}]})`. Explicit ranges are honored exactly; do not ask for a whole file when a slice is enough.
- Use `inspect({paths,budget:"shallow"})` for maps. A multi-file inspect returns outlines and locators.
- Use `budget:"full"` only for one bounded file or symbol. Whole-file replacement belongs in `change`/`work` edit payloads.
- Read a large file once. Do not reconstruct it with many 80-line slices.

## Micro
- Micro executes explicitly assigned work outside the main context.
- Health: `ops({capability:"micro",action:"doctor"})` validates URL/model/key.
- Run shape: `micro({preset:"triage",task:"...",pipeline:{steps:[...]},withOS:true,invocation:{tools:{enabled:true,allowCommands:true},provider:{maxRequests:5}}})`. Do not call `ops.micro.help` before an assigned run.
- Attach evidence with `pipeline:{steps:[...]}` on the first Micro call; avoid copying raw output.
- Use Micro when raw failure/log evidence exceeds 2,000 characters; not for trivial edits or already triaged evidence.
- Use `delivery:"defer"` or `"auto"` when the host can continue; `"immediate"` only when the next decision depends on it; `"errors-only"` for fire-and-forget.
- Use the executor settings above; check `providerRequests`, `toolRounds`, `toolCalls`, and `executionMode`.

## Architecture
- Blocks are semantic ownership boundaries; Chains group Blocks; Links express directed relationships.
- Use semantic ids/kinds for ownership; never `mod-*` or `kind:"module"`.
- After changing business code, include `architecture.blocks` and `architecture.chains` in the same `change`/`work`. A state-only `change({architecture})` is valid.
- Bind only touched paths. One semantic Block and Chain suffice for a bounded repair; split for real ownership boundaries.
- Every tracked source path needs exactly one curated Block and at least one Chain membership.
- A failing `verify` blocks `ship` unless `allowUnverified:true`. A blocked architecture contract must not leave partial ownership.
- Compact shape:
```js
architecture:{blocks:[{id,title,kind,paths,summary}],chains:[{id,title,memberIds}]}
```
- Discover with `ops({capability:"architecture",action:"list|open|search"})`; `block.get` and `block.inspect` alias `open`.

## Advanced
Legal capabilities: `os_context`, `plan`, `task`, `block`, `chain`, `architecture`, `code`, `run_command`, `process`, `knowledge`, `session`, `system`, `profile`, `micro`, `artifact`, `telemetry`. Route them through `ops({capability: "...", action: "...", args: {...}})`; do not shell-read capability source.

## Scoped calls and architecture ownership

Put the task intent and known file paths in `explore`; an empty exploration can select unrelated files. Use explicit `symbol` or `ranges` for a batch read; `paths` plus `full:true` can still return outlines. A focused test/check command is enough for the baseline.

Example first call (replace the paths and ranges with this task's targets):
```json
{"action":"pipeline","args":{"steps":[{"explore":{"intent":"repair the installer check","paths":["scripts/install-plugin.mjs","packages/mcp/test/plugin-install.test.mjs"]}},{"parallel":[{"inspect":{"path":"scripts/install-plugin.mjs","symbol":"assertInstalledMatchesBuild"}},{"inspect":{"path":"packages/mcp/test/plugin-install.test.mjs","ranges":[[1,120]]}}]},{"verify":{"commands":["node --test packages/mcp/test/plugin-install.test.mjs"]}}]},"projectRoot":"/absolute/repository"}
```

Use `ownership` instead of graph listings. Blocks need **id, title, paths**. Preserve Chain members (omit `replaceMembers`):
```json
{"architecture":{"blocks":[{"id":"existing-semantic-block-id","title":"Existing title","paths":["relative/task-file.mjs"]}],"chains":[{"id":"existing-chain-id","memberIds":["existing-semantic-block-id"]}]}}
```
Reuse the returned owner ids and titles for already owned paths; do not invent a new owner. If no owner exists, choose a semantic Block and Chain for the new responsibility. A rejected architecture transaction changes no files; use its `ownership` receipt and retry the same edits without opening Blocks or repeating discovery.

Exact text mutation: `edits:[{path, target:"old text", replacement:"new text"}]` (`oldText/newText` also accepted). Keep the source text exact; attach `verify:{commands:["node --test path/to/relevant.test.mjs"]}` and the architecture payload to the same call.
