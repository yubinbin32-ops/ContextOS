---
name: contextos-ops
description: "Required ContextOS operations guide for the project development scaffold: configure, switch, and diagnose API Micro, CLI agent, provider keys, adapters, OS MCP installation, permissions, and readiness."
---

# ContextOS operations and diagnosis

ContextOS is the project's required development scaffold. Use this guide to configure, switch, and diagnose the roles and adapters that the scaffold delegates to.

ContextOS exists to lower host token/context cost while preserving exact evidence, verified edits, architecture state, and continuity across conversations.

Use this skill for installation, provider/model/key switching, key debugging, CLI adapter installation, OS MCP registration, skill installation, permission preconfiguration, and doctor checks.

## Roles and flexible routing

Keep API Micro and CLI independent and let the AI choose who executes each task; there is no fixed routing table:

- **Pipeline default**: Pipeline is the default container for 3 or more known independent reads, searches, commands, or edits. One parallel pipeline call may run many actions at once and returns full step results; do not habitually split known work across multiple pipeline calls or repeated single calls.

- **api-micro**: Lean worker for bounded retrieval, summarization, verification, command batches, and at most one small single-file edit; route multi-file implementation, refactoring, packaging, and repair to cli-agent. Micro assignments state the goal, evidence entry, allowed operations, return format, and stop condition. It can use OS and returns one host-ready result. Semantic `ask` is read-only. Command/change uses `withOS`; commands require `invocation.tools.allowCommands: true`, edits require `execution: "implement"` plus `context.allowedPaths`, and both bind Blocks. It cannot dispatch another agent.
- **cli-agent**: Subagent for open-ended, multi-goal, or unknown-path root-cause investigation and other complex multi-step work. It runs its own tool loop in an isolated process and can use native tools and OS.

Non-trivial tasks default to planning delegation first before self-executing. The main conversation holds judgment, architecture decisions, and integration, using delegation as a replacement cost rather than additive overhead:
- Micro tasks stay bounded and return synchronously in that call.
- CLI subagent tasks that may exceed host MCP tool call timeouts (AGY ~3 minutes) must be dispatched with `background: true` to avoid host timeouts aborting the child process and losing reports and token accounting. Collect the terminal report with a single bounded `agent({action: "wait", jobId, waitMs})` call, or skip the status round entirely and collect with `integrate({jobId, waitMs})` when the next step is integration. If the window closes, use the returned `resume`/`continueWith` handle, proceed with other work, and wait again later; never poll in a tight loop and never re-dispatch a running job. Use `messages` strictly for bidirectional host-worker communication (which returns `jobStatus`). Short tasks can run synchronously.
- `agent({action: "cancel", jobId})` cancels detached CLI workers too: it writes a cancellation marker, signals the persisted `leasePid` on POSIX, and the worker settles `cancelled` without enqueueing a failure delivery. Cancelled jobs are terminal and are never redelivered.
- **Substitutive CLI implementation flow**:
  1. Dispatch implementation in background to an isolated copy: `agent({task, workspace: <isolated copy>, execution: "implement", context: {allowedPaths, acceptance, verify}, background: true})`.
  2. Collect and merge in one round with `integrate({jobId, waitMs})`: integrate waits up to 280s for completion, then runs through `changePipeline`, enforces Block ownership, applies only `allowedPaths`, and runs recorded verify commands. A separate `agent({action: "wait"})` is a pure status round: use it only for report-only jobs, never before an integrate that can do the waiting itself.
  3. If the job is still running when the window closes, integrate reports `INTEGRATE_JOB_RUNNING`; repeat only the integrate call with the same jobId. Never re-dispatch a running job.
  4. Do not duplicate implementation: after `integrate` succeeds, the host must not re-implement the same files; review/integrate the result and execute only remaining project-level verification.
- To batch several workers, put them in one `pipeline` call.

## Conversation retention

Completed micro and CLI conversations stay resumable. At most five are retained; older ones are evicted automatically. Resume with `sessionId` (micro) or `cliSessionId` (CLI). Start a new conversation when the next task is independent, and for CLI also when its reported context usage exceeds 233k.

## CLI session continuity and reporting

- **CLI session rule**: reuse when the task is continuous, background is coherent, and current CLI context occupancy is below 233k; start a new conversation at 233k or when the next task is independent.
- **Context-usage reporting**: Completed CLI reports include `report.cliUsage` (`{percent, usedTokens, windowTokens, source}`) when the adapter maps context usage from stream output.

## Configuration management

Configuration is loaded from two locations:
1. **Global profile** (`~/.contextos/profile.json` or `$CONTEXTOS_HOME/profile.json`): Stores machine-level adapters, models, and credentials.
2. **Project profile** (`<project>/.contextos/profile.json`): Provides repository-specific overrides.

`loadProfile` merges them deeply for `micro` and `agents.adapters`. Project values override global values; scalar values replace, and explicit `null` clears an inherited key.

- Read effective configuration: `ops({capability: "profile", action: "get"})` (credentials show as `[redacted]`).
- Write global settings: `ops({capability: "profile", action: "set", args: {scope: "global", values: {...}}})`.
- Write project settings: `ops({capability: "profile", action: "set", args: {values: {...}}})`.

## Actionable operational procedures

- **Provider/model/key switching**: Update dotted keys (e.g. `micro.model`, `micro.url`, `micro.thinking`) in the profile. Switching is a profile write, not a code edit. Never print or commit secret keys.
- **Key debugging**:
  - Resolution order: profile `key` -> `apiKey` -> environment variable named in `keyEnv`.
  - Prefer keeping secrets in the host environment and referencing `keyEnv` in the profile.
  - For stdio MCP configurations (such as Codex `.mcp.json`), add only the exact required variable name to `env_vars`.
  - Isolated credential testing: `CONTEXTOS_API_MICRO_PROFILE` points to a JSON file `{"micro": {...}}`.
  - Classify probe errors: HTTP 401/403 (invalid credential), HTTP 404 (route or model ID error), connection/DNS/timeout (pre-auth network issue), 200 with parse failure (response format mapping mismatch).
- **CLI adapter installation**: Install the target CLI via its official installer. Verify locally (`--help`, version, model availability, effort flags) before writing adapter config.
- **OS MCP registration**: Register the canonical server bundle (`~/.contextos/server/contextos-mcp.mjs`) in the CLI host configuration with arguments `["--no-warnings=ExperimentalWarning", "<path-to-bundle>"]`.
- **Skill installation**: ContextOS maintains canonical runtime skills at `~/.contextos/skills/contextos` and `~/.contextos/skills/contextos-ops`. Target editors and CLI hosts discover skills from their configured skills directories (e.g. `~/.cursor/skills`, `~/.gemini/antigravity-cli/skills`, `~/.config/opencode/skills`, or workspace `.cursor/skills` / `.opencode/skills`). Skill frontmatter must be strict YAML; quote any description containing a colon.
- **Permission preconfiguration**: Preconfigure the CLI adapter with documented full-permission flags (e.g. AGY `--dangerously-skip-permissions`) and grant MCP permissions (`mcp(contextos/contextos)`) so execution is not blocked by manual prompts. Do not combine `--effort` with an effort-suffixed model, and do not force `--sandbox` for MCP-backed work.
- **Doctor checks**: Run `ops({capability: "micro", action: "doctor"})`. Local checks make no model call; reporting `unknown; not probed` for `authentication`, `task_analyze`, or `task_implement` is expected normal behavior and does not block micro delegation. As long as `endpoint`, `configured_model`, and `credential_source` are set, dispatch micro normally. Run bounded live checks with `probe: true` only upon explicit request.

## Conversational ops and verification protocols

When requested in conversation to configure, test, or synchronize any of these 5 operational areas, AI must follow these bounded procedures and report concrete verification evidence:

### 1. Configure and test CLI agent (`cli`)
- **Use case**: Configure an adapter for a target CLI agent (e.g. Codex, AGY, Harness, Zcode, Pi, WorkBuddy) and verify execution.
- **Configuration**:
  1. Call `ops({capability: "profile", action: "set", args: {scope: "global", values: {"agents.default": "<adapter>", "agents.adapters.<adapter>": {...}}}}, projectRoot)`.
  2. Populate verified `command`, `args`, `input`, `output`, and `resumeArgs`.
- **Verification**:
  1. Dispatch a minimal non-destructive probe task:
     ```js
     contextos({action: "agent", args: {task: "PING_TEST: echo ok", execution: "analyze", background: false}}, projectRoot)
     ```
  2. Verification criteria: Process exits 0, session identifier (`sessionPath`) or `cliUsage` is captured, and no execution errors occur.

### 2. Configure and test API Micro (`micro`)
- **Use case**: Configure Base URL, model ID, thinking effort, or API key, and verify endpoint connectivity.
- **Configuration**:
  1. Call `ops({capability: "profile", action: "set", args: {scope: "global", values: {"micro.url": "<url>", "micro.model": "<model>", "micro.thinking": "<thinking>", "micro.keyEnv": "<env>"}}}, projectRoot)`. Store raw keys in `micro.key` with redaction preserved.
- **Verification**:
  1. Run doctor connectivity probe:
     ```js
     contextos({action: "ops", args: {capability: "micro", action: "doctor", args: {role: "api", probe: true}}, projectRoot})
     ```
  2. Run a real lightweight Micro analysis task:
     ```js
     contextos({action: "micro", args: {prompt: "Ping test: return 'pong' only.", execution: "analyze"}}, projectRoot)
     ```
  3. Verification criteria: Doctor returns pass, and Micro task returns valid text output with token accounting.

### 3. Check and test App update (`app update`)
- **Use case**: Check ContextOS Desktop App releases, verify update availability, and inspect packaging assets.
- **Verification**:
  1. Read local version from the active ContextOS MCP server via `ops({capability: "system", action: "doctor"})` (or macOS App `Info.plist` / Windows binary metadata).
  2. Query GitHub Releases API for `yubinbin32-ops/ContextOS/releases`:
     Fetch latest release tag, draft status, and asset catalog.
  3. Compare version difference and verify target architecture assets (macOS arm64/x64, Windows x64):
     - Confirm full edition (`-full.zip`) and standard edition (`.zip`) availability;
     - Confirm checksum file (`sha256sums.txt`) exists and download URLs respond with 200/302.
  4. Report local version, remote latest release, recommended edition, and asset readiness.

### 4. Import and test editor plugin synchronization (`editor plugin sync`)
- **Use case**: Sync ContextOS MCP registration into target AI editors (Cursor, Antigravity, OpenCode, Codex, Claude Desktop).
- **Configuration**:
  1. Desktop App UI: In ContextOS Desktop App Settings, click **Sync** or **Sync All** in the Platform Sync section. The App atomically deploys the canonical MCP server (`~/.contextos/server/contextos-mcp.mjs`) and configures target editors.
  2. In-conversation sync: Call `ops({capability: "system", action: "sync", args: {platforms: ["<platform_ids>"]}})` (or `action: "init"` with `injectEditors: true`).
  3. Manual / Profile persistence: Add platform slugs to `.contextos/project.json` and `~/.contextos/profile.json` `platforms` array via `ops({capability: "profile", action: "set", args: {values: {platforms: ["<platform_ids>"]}}})`, updating the target editor's config file (e.g. `~/.cursor/mcp.json`, `~/.gemini/config/mcp_config.json`, `~/.config/opencode/mcp.json`) to invoke `~/.contextos/server/contextos-mcp.mjs` with Node 22+.
- **Verification**:
  1. Inspect target editor configuration files, confirming valid `contextos` MCP block pointing to `~/.contextos/server/contextos-mcp.mjs` and Node 22+ binary path.
  2. Report synced configuration paths and remind user to restart the editor to reload persistent MCP connections.

### 5. Import and test CLI plugin synchronization (`cli plugin sync`)
- **Use case**: Sync ContextOS plugin, CLI adapters, and skills for CLI agents and compilers (Codex, AGY, Claude Code, Cursor, OpenCode, Harness, Zcode, Pi, WorkBuddy).
- **Configuration**:
  1. Canonical runtime skills are maintained by ContextOS App at `~/.contextos/skills/contextos` and `~/.contextos/skills/contextos-ops`.
  2. Sync or link skills from `~/.contextos/skills/` to the target CLI's skills directory (e.g. `~/.cursor/skills/`, `~/.gemini/antigravity-cli/skills/`, `~/.config/opencode/skills/`, or agent-specific paths).
  3. Register adapter and permissions:
     - For Codex: registered via `codex plugin add contextos@personal` or `.codex/config.toml` MCP entry.
     - For custom CLI agents/compilers: configured in `agents.adapters.<adapter>` in `~/.contextos/profile.json` with required full-permission flags and `mcp(contextos/contextos)` access.
- **Verification**:
  1. Verify skill presence: Confirm `contextos/SKILL.md` and `contextos-ops/SKILL.md` exist in the target skills path (or canonical `~/.contextos/skills/`) with valid YAML frontmatter.
  2. Verify adapter execution: Run `ops({capability: "micro", action: "doctor", args: {role: "cli", adapter: "<adapter>", probe: true}})` or dispatch a lightweight probe task `contextos({action: "agent", args: {task: "PING_TEST", execution: "analyze", background: false}})`.
  3. Confirm adapter exits 0 and captures session or usage diagnostics.

## Continuity, blackboard, and architecture

- **Session continuity**: `ops({capability: "session", action: "status"})` exposes active session state, touched files, command receipts, and notes.
- **Blackboard purpose**: `.contextos/blackboard.md` is rendered from session state on every save. Read session state via `ops` rather than maintaining parallel files.
- **Plan and task tracking**: Read and update multi-step progress with `ops({capability: "plan"})` and `ops({capability: "task"})`. Never edit `.contextos` files directly.
- **Block/Chain architecture**: Inspect and update architecture boundaries with `ops({capability: "architecture"})`; never edit `.contextos/graph.json` directly.

## Role usage accounting

Track usage by role: `main`, `api-micro`, and `cli-agent`.
- Raw tokens = `input + output`; diagnostic only. Cached input is included in input and reasoning in output.
- Authoritative weighted cost = `cached input * 0.1 + uncached input * 2 + output * 10`; API Micro and CLI agent divide by 7 for main-equivalent cost, while main uses it directly.
- Report raw tokens, weighted cost, peak input, and main-equivalent cost separately; never double-bill receipts.
