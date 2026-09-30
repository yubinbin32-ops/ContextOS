---
name: contextos
description: "Use ContextOS for repository exploration, cross-module changes, and larger repairs. Skip this skill for small local function repairs; use native tools directly. Resolve ancestor/nested instructions and known reads once; batch tests/diff checks and use python3 on macOS."
---

# ContextOS

Call `contextos({action,args,projectRoot})`; projectRoot is absolute. Load this skill once. If the tool is missing, search once.

## Route work

For a local repair to one function plus focused tests, whose complete touched source and test files together contain at most 120 lines (count whole files, not changed lines) and no ownership change, prefer native tools and finish after the relevant check. Resolve all applicable ancestor/nested AGENTS and known reads once; trust an explicit launcher preflight. Do not re-read source while rechecking instructions. Run the relevant tests and diff check together, then finish. This avoids plugin execution overhead.

Known task paths need no code search or repository map. The initial native call may load this skill and locate AGENTS.md; do not append broad source searches. Known paths: one `work` with `inspect:[{path,symbol|ranges}]` and `verify:{commands:["relevant check"]}`. Unknown paths: one scoped `pipeline` with `explore`, `inspect`, baseline `verify`. Use symbols or `ranges:[[startLine,endLine]]` up to 240 lines, and read only what the repair needs. Use the project's available interpreter (commonly python3 on macOS). Keep new regression coverage focused; do not draft speculative helper frameworks.

Then `change({edits,verify})`. Use the shortest unique source target; omit unchanged code. Forms:
```js
edits:[{path,target:"old source",replacement:"new source"}]
create:[{path,content}]
delete:[{path}]
```
Aliases: oldText/newText, targetContent/replacementContent. Also supported: symbol/replacementContent, startLine/endLine/replacementContent, append, fullFile/content. `patch` is unsupported. Before renaming a declaration, search its old name and include all affected calls in the same change.

Existing ownership refreshes automatically; omit architecture for preserved boundaries. For new ownership, use `architecture:{blocks:[{id,title,paths}],chains:[{id,memberIds}]}`. Reuse receipt IDs/titles, never mod-* identities.

For a failed command, recover its existing receipt with `verify({mode:"logs",id:"receipt-...",lines:80,maxChars:4000})`; correct the reported failure, then verify the repair. Do not search the tool inventory for receipts or repeat the failing command just to get its log. Read only the failure's named symbol or nearby lines; do not reload whole files for a localized error.

After read_complete=true, mutate. If partial, make one named recovery read. status=blocked means no changes: correct the named fields and retry once using its receipt. status=verified means finish; use ship for session archival. Do not repeat successful reads/checks, open graphs to recover known owners, or use native reads/tests between OS calls.

Start unknown locations with one exact identifier and bounded source context: `work({search:{query:"identifier",paths:["known/source"],contextLines:20},inspect:[{path:"focused/test",ranges:[[1,120]]}]})`. Matching source ranges are merged and returned in that call. Read only a named missing dependency next; batch remaining source and tests, then mutate. Do not perform serial single-range discovery when a batch can resolve it. Search matches and outlines are locators; read_complete requires source bodies. maxLogBytes bounds verification logs. Precise work returns bounded source bodies; paths alone may return outlines.

Advanced ops use `ops({capability:"block",action:"open",args:{id}})`. Legal capabilities: architecture, block, chain, telemetry, micro, run_command. See [capabilities](references/capabilities.md). Micro runs only when explicitly assigned; load its reference then. Launchers install/enable the plugin before testing.
