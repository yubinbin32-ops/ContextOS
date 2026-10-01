# ContextOS setup for AI assistants

AI completes environment detection and configuration. The user selects the target host and optionally a Micro provider/model; they do not need to write an adapter.

1. Detect OS and Node 22+. Respect the user's requested desktop or plugin installation. Choose the actual matching release asset; verify its published checksum when provided. Do not replace an existing installation unnecessarily.
2. Configure only the selected host. From a source checkout, run `node scripts/bootstrap.mjs --target-root <workspace> --platforms <selected ids>`; `--dry-run` previews writes. Codex can use its plugin installer. Preserve unrelated configuration and avoid duplicate MCP/Skill entries.
3. Initialize local project state. Cloud Hub is removed. Legacy cloud metadata normalizes to local with a backup, without contacting a server or deleting local state. Remote-only data is not automatically recovered; import an existing export separately.
4. Offer optional Micro: existing API/Key, selected CLI, or skip. No model call is needed for core setup. Inspect the selected CLI; if missing, install it from verified official instructions, then reuse/complete login. AI writes and validates the installed version's request/result/model/thinking mapping in project settings. See [Micro setup](plugins/contextos/skills/contextos-ops/references/micro-setup.md).
5. Install the short ContextOS skill and one lean MCP server in that CLI. Configure only task-needed permissions; preserve explicit user deny rules. There are no Hooks. Inject a precise task manifest before actual delegation, allow bounded missing-context retrieval, and independently check returned changes/results.
6. Run local system/provider doctor. Report runtime, host injection, CLI installed/authenticated/model verification and optional task-smoke status separately. Do not say authenticated or task-ready merely because an executable/model name exists.

App-only downloads: ask the user's coding assistant to configure Micro in conversation using the bundled `contextos-ops` reference. A downloaded desktop app does not itself configure every CLI provider. API remains supported. CLI provider access can consume subscriptions, quota or API billing; savings are evaluated across the whole task.
