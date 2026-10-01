---
name: contextos-ops
description: Configure ContextOS or an API/CLI Micro provider, inspect local health, and measure whole-task usage. Load only for setup, provider configuration or diagnostics.
---

# ContextOS setup and diagnosis

Core state is local to the project. No Hook or Cloud Hub setup is needed. Ordinary coding can use the main ContextOS skill or native tools.

For installation, use [AI_SETUP.md](../../../../AI_SETUP.md) from the source distribution. For Micro mapping, read [CLI/API setup](references/micro-setup.md). In a plugin cache these references are packaged beside this skill; use the local reference when repository setup files are unavailable.

AI performs detection and writes mappings; users choose a provider and model rather than editing adapter JSON themselves. Preserve existing settings. Reuse the user's existing CLI login or API key storage. Do not print secrets or copy them into a public project.

`contextos({action:"ops",args:{capability:"system",action:"doctor"},projectRoot})` checks local runtime/configuration without model requests. `capability:"micro",action:"doctor"` checks provider configuration locally; `args:{probe:true}` makes one explicitly requested model call. Report installed, authenticated, mapped model and actual task completion separately.

Before delegation inject a bounded task manifest: objective, workspace, allowedPaths, acceptance, constraints, state, base revision and necessary evidence. Give CLI workers the short ContextOS skill and a narrow missing-context retrieval route. Implementation tasks require a separate work directory and independent host review/testing. Required permission denial stops the assignment; do not bypass existing explicit deny rules or silently weaken CLI permissions.

Measure completed tasks, including parent and all workers, cached/uncached input, output, peak input, requests, elapsed time and retries. Keep provider raw usage and cache semantics. CLI terminal cumulative values count once; reasoning included in output is not added twice. CLI login can use paid quota. Parent token reduction alone is not a total cost saving. Do not automatically retry, switch models, or advertise a percentage without qualifying evidence.
