# AI-managed Micro configuration

## Choice and detection

Offer existing Key/API, an installed CLI, or skip Micro. Discover the selected executable with PATH and standard user bin directories; inspect its actual `--version`, `--help`, available model list, headless input/output and resume semantics. CLI names are not a closed list. Desktop apps do not universally expose an authenticated CLI: verify each selected provider.

If missing, install only the selected CLI using its verified official installer. Reuse an existing login; let the user complete an interactive login when needed. For Antigravity the executable is `agy`; the official installer is `https://antigravity.google/cli/install.sh`. Old `gemini` has a different protocol. Never treat their mappings as interchangeable. Authentication and installed status are separate.

## Write the mapping

Use `ops({capability:"profile",action:"set",args:{values:{micro:...}}})` if available, or atomically merge `.contextos/profile.json`. A local absolute executable path belongs in private/local settings; portable project configuration uses a command name. Keep credentials out of committed files. Legacy `micro:{url,key,model}` remains an API configuration; `provider:"api"` is optional.

CLI example for verified agy 1.2.14 (AI must inspect the installed version before reuse):
```json
{
  "micro": {
    "provider": "cli",
    "model": "gemini-3.8-flash-high",
    "thinking": "high",
    "timeoutMs": 120000,
    "maxInputChars": 16000,
    "cli": {
      "command": "agy",
      "args": ["--input-format", "stream-json", "--output-format", "stream-json", "--model", "{model}", "--effort", "{thinking}", "--mode", "{mode}"],
      "modes": {"analyze": "plan", "implement": "accept-edits"},
      "input": {"format": "jsonl", "keepOpen": true, "template": {"event": "user", "message": {"content": "{task}"}}},
      "output": {
        "format": "jsonl",
        "terminal": {"path": "event", "value": "result"},
        "resultPath": "result",
        "contentPath": "response",
        "structuredPath": "structured_output",
        "blockedPath": "structured_output.blocked",
        "statusPath": "status",
        "successValues": ["SUCCESS"],
        "deniedPath": "denied_actions",
        "modelPath": "init.model",
        "sessionPath": "conversation_id",
        "usage": {"path": "usage", "input": "input_tokens", "output": "output_tokens", "cache": "cache_read_tokens", "reasoning": "thinking_tokens", "inputIncludesCache": false, "reasoningIncludedInOutput": true}
      }
    }
  }
}
```

Arguments are passed directly, without a shell. Supported placeholders: task, model, thinking, mode, sessionId, workspace. JSON/JSONL templates are rendered recursively. Use dotted output paths; `"."` maps the root object. Terminal JSONL mapping must identify one final result. Plain text output cannot prove usage/model/status; report those fields unavailable. Set a timeout/output limit. Respect the CLI's own permission system; never add a blanket bypass flag as a default. Before an implementation task inspect the actual policy for its workspace file reads/writes and the required test and diagnostic commands. Headless permission denial ends the assignment. For AGY, verify installed-version [permission rules](https://antigravity.google/docs/cli/permissions); do not discover missing command permissions one paid retry at a time. OS workers may not dispatch Micro recursively.

Configure both short ContextOS skills (`contextos` and its sibling `contextos-ops`) and one lean MCP surface in the selected CLI's supported project/global configuration. Avoid duplicate skills/server definitions. For agy, follow its actual `mcp add --help`; check CLI skills at `~/.gemini/antigravity-cli/skills`, legacy `~/.gemini/config/skills`, and project `.agents/skills`. Inspect one task trace to verify which path it actually loads; update an existing legacy installation too. Store backups outside skill discovery directories. For other CLIs use their documented locations. No Hook is installed. Verify local server startup/tool schema before one bounded actual assignment.

## Dispatch and completion

Call `ops` with capability `micro`, action `run`, and nested arguments containing task, input or inputArtifact/inputReceipt, context and timeoutMs. `context` fields are objective, allowedPaths, acceptance, constraints, state, baseRevision and evidence. Keep exact relevant code and failure information; use references for bulk data. Context exceeding the limit is rejected; narrow it intentionally.

Both transports accept the task context manifest. API retains analysis/patch proposals; explicit workspace implementation is a CLI capability and needs its own real acceptance test. Analysis tasks default to read-only instructions and native CLI permission policy. This is a task contract, not an OS sandbox guarantee. Implementation also supplies `execution:"implement"` and `workspace` pointing to a separate checkout/worktree. AI chooses correct paths and scope, then the host independently validates the diff and acceptance. The runtime does not auto-merge changes or launch another worker.

Configure `resumeArgs` only after testing the CLI conversation flag and declaring usage.aggregation as `invocation` (one resumed invocation) or `session` (whole conversation cumulative). Use `cliSessionId` only with this tested mapping and the same task/workspace; it sends the new task without replaying old history. A fresh task receives bounded OS session history. Do not reuse an unrelated conversation.

Doctor is local by default. A model probe and task smoke test are separate paid checks; choose one useful bounded assignment rather than repeated greetings. Failure, empty output, model mismatch, required permission denial and missing terminal result are incomplete. Usage does not prove functional success. AGY can report SUCCESS after permission denial; the mapped denied_actions field must reject that.

Usage is mapped from one terminal result, never added to repeated progress/cumulative records. AGY 1.2.14 reports cache reads separately from input_tokens. Keep raw fields and the mapping/version as evidence. Unknown semantics => usage unavailable. Terminal-only reporting cannot enforce an in-flight token cap; wall time/output caps terminate execution, token caps are checked after the report. Cost/paid quota remains unknown unless verified separately.

## Both API and CLI, switching and cost estimates

Keep both transports; set `micro.priority` to `cli-first` or `api-first`. Per-call `provider` explicitly pins one transport. Priority inspects local configuration/installation before dispatch. A task failure does not silently retry through the other provider. Both desktop settings expose the priority switch; AI can also merge `micro.priority` through `profile.set` without removing the other transport.

Legacy API url/key/model remain supported. If providers use different models, set `micro.api:{url,key,model,...}` and `micro.cli.model`; the CLI mapping stays in `micro.cli`. This avoids changing an API model to a CLI slug. The top-level model remains a compatible default.

Set `micro.cost:{tokenDivisor:7}` for a personal estimate where Micro tokens are priced at one seventh of the main model. Report raw tokens alongside `mainEquivalentTokens`. Whole-task equivalent = actual main-model tokens + all Micro equivalent tokens. This is a user assumption, not a provider price or invoice. Default divisor is 1; do not advertise one user's subscription price as a universal result. Cached and reasoning fields keep their original counting semantics.
