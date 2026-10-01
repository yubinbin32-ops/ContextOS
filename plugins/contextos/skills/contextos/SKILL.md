---
name: contextos
description: Use ContextOS for focused repository reads, batched commands and failure receipt recovery when these save context. Small known edits can use native tools.
---

# ContextOS

Call `contextos({action,args,projectRoot})`; projectRoot is the absolute active workspace. Use native tools when they are simpler. No mandatory explore/change/ship sequence, graph binding, Hook, or Micro call is needed for ordinary development.

Known paths: batch only the needed source ranges and relevant checks:
```js
{action:"work",args:{inspect:[{path:"src/example.mjs",ranges:[[20,80]]}],verify:{commands:["relevant test"]}},projectRoot}
```
Unknown paths: scoped `search` or `work({search:{query,paths,contextLines}})`. Exclude generated bundles, dependencies and build output. Read a named missing dependency when needed; a locator or clipped result is not complete source evidence.

Edits can use native tools or `change({edits:[{path,target,replacement}],verify:["relevant test"]})`; create/delete are `{path,content}` / `{path}` arrays. Existing graph ownership can refresh; new ownership and session `ship` are optional unless the user requests graph governance.

Failed check: reuse its receipt with `verify({mode:"logs",id:"receipt-...",lines:80,maxChars:4000})`. Narrow the named failure source/log range before repairing. Do not rerun the same test merely to retrieve logs. Successful relevant verification is enough to finish a bounded task.

Micro runs only when assigned. CLI workers should follow the injected objective, allowedPaths, acceptance and current evidence; fetch missing data narrowly through OS or native tools. Wait for started checks and return actual results. A denied action, running check or plan is not completion. Do not delegate again from a worker.

For install, CLI/API adapter configuration and diagnosis, load [the setup guide](../contextos-ops/SKILL.md). For requested graph/session operations, load [capabilities](references/capabilities.md) only as needed.
