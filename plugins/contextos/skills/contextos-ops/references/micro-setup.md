# ContextOS setup and switching guide

ContextOS is the project's required development scaffold. This guide provides concrete, executable configuration details, switching steps, CLI adapter setup, and diagnostic troubleshooting for API Micro and CLI agent roles.

## Profile schema and key paths

Configuration is loaded from the global profile (`~/.contextos/profile.json` or `$CONTEXTOS_HOME/profile.json`) and project overrides (`<project>/.contextos/profile.json`).

### Canonical profile structure

```json
{
  "micro": {
    "url": "https://api.deepseek.com/v1",
    "model": "deepseek-v4.1-flash",
    "keyEnv": "CONTEXTOS_API_MICRO_KEY",
    "transport": "chat",
    "thinking": "medium"
  },
  "agents": {
    "default": "agy",
    "adapters": {
      "agy": {
        "command": "agy",
        "args": [
          "--input-format", "stream-json",
          "--output-format", "stream-json",
          "--model", "{model}",
          "--mode", "{mode}",
          "--dangerously-skip-permissions"
        ],
        "resumeArgs": ["--conversation", "{sessionId}"],
        "input": {
          "format": "jsonl",
          "keepOpen": true,
          "template": { "event": "user", "message": { "content": "{task}" } }
        },
        "output": {
          "format": "jsonl",
          "terminal": { "path": "event", "value": "result" },
          "resultPath": "result",
          "contentPath": "response",
          "statusPath": "status",
          "successValues": ["SUCCESS"],
          "usage": {
            "path": "usage",
            "input": "input_tokens",
            "output": "output_tokens",
            "cache": "cache_read_tokens",
            "reasoning": "thinking_tokens",
            "inputIncludesCache": false,
            "reasoningIncludedInOutput": true
          },
          "contextUsage": {
            "path": "step_update.usage",
            "input": "input_tokens",
            "cache": "cache_read_tokens",
            "window": 233000,
            "inputIncludesCache": false
          }
        },
        "modes": { "analyze": "plan", "implement": "accept-edits" }
      }
    }
  }
}
```

### Key path reference

- `micro.url`: Base URL of the OpenAI-compatible API endpoint (e.g. `https://api.deepseek.com/v1`).
- `micro.model`: Exact model identifier (e.g. `deepseek-v4.1-flash`).
- `micro.keyEnv`: Environment variable name containing the API key (e.g. `CONTEXTOS_API_MICRO_KEY`).
- `micro.transport`: Transport format (`chat` for chat completions).
- `micro.thinking`: Thinking effort level (`off`, `low`, `medium`, `high`).
- `agents.default`: Name of the active CLI adapter (`codex` for the default Codex setup, `agy` for Antigravity).
- `agents.adapters.<name>`: Adapter definition including CLI command, process arguments, stream parsing, and task modes.

## Setting and switching providers, models, and keys

### 1. View effective configuration

Read current configuration with secrets redacted:

```js
contextos({
  action: "ops",
  args: {
    capability: "profile",
    action: "get"
  }
})
```

### 2. Set API key via environment variable (recommended)

Export the key in your shell or host environment:

```bash
export CONTEXTOS_API_MICRO_KEY="sk-your-api-key-here"
```

Configure `profile.json` to reference the environment variable:

```js
contextos({
  action: "ops",
  args: {
    capability: "profile",
    action: "set",
    args: {
      scope: "global",
      values: {
        "micro.keyEnv": "CONTEXTOS_API_MICRO_KEY",
        "micro.url": "https://api.deepseek.com/v1",
        "micro.model": "deepseek-v4.1-flash",
        "micro.thinking": "medium"
      }
    }
  }
})
```

### 3. Key resolution order

Credentials resolve in strict order:
1. `profile.key` (in profile JSON)
2. `profile.apiKey` (in profile JSON)
3. Environment variable named by `profile.keyEnv` (default: `CONTEXTOS_API_MICRO_KEY`)

Prefer storing secrets in the host environment and setting `keyEnv` in the profile.

### 4. Isolated credential testing

For automated or isolated testing without altering user profiles, set `CONTEXTOS_API_MICRO_PROFILE`:

```bash
export CONTEXTOS_API_MICRO_PROFILE="/tmp/test-profile.json"
```

Where `/tmp/test-profile.json` contains:

```json
{
  "micro": {
    "url": "https://api.deepseek.com/v1",
    "model": "deepseek-v4.1-flash",
    "key": "sk-temporary-test-key",
    "transport": "chat",
    "thinking": "medium"
  }
}
```

### 5. Validate with Doctor and Probe

Run offline local doctor check:

```js
contextos({
  action: "ops",
  args: {
    capability: "micro",
    action: "doctor"
  }
})
```

Run a live bounded network probe (only upon explicit request):

```js
contextos({
  action: "ops",
  args: {
    capability: "micro",
    action: "doctor",
    args: { probe: true }
  }
})
```

## CLI adapter setup (Codex, default)

Codex CLI is the default adapter. It is a full agent with a large background prompt, so reserve it for multi-file or open-ended implementation and route bounded retrieval, summarization, verification, or at most one small single-file edit to API Micro.

### 1. Install and log in

```bash
codex --version
codex login status
```

### 2. Install the JSONL bridge

ContextOS expects one JSON payload per task. The bridge converts `codex exec --json` events into that payload and adds `context_usage`, the peak per-request prompt size of the retained conversation.

```bash
mkdir -p ~/.contextos/adapters
cp <repo>/scripts/adapters/codex-cli-bridge.mjs ~/.contextos/adapters/codex-cli-bridge.mjs
```

### 3. Configure adapter in profile

Use the absolute bridge path (`~` is not expanded by the process spawn):

```json
{
  "agents": {
    "default": "codex",
    "adapters": {
      "codex": {
        "command": "node",
        "args": ["/Users/username/.contextos/adapters/codex-cli-bridge.mjs", "--model", "{model}", "--workspace", "{workspace}", "--thinking", "{thinking}"],
        "resumeArgs": ["--session-id", "{sessionId}"],
        "model": "deepseek-v4.1-flash",
        "thinking": "high",
        "input": { "format": "text", "template": "{task}" },
        "output": {
          "format": "json",
          "contentPath": "content",
          "statusPath": "status",
          "successValues": ["SUCCESS"],
          "sessionPath": "thread_id",
          "usage": {
            "path": "usage",
            "input": "input_tokens",
            "output": "output_tokens",
            "cache": "cached_input_tokens",
            "reasoning": "reasoning_output_tokens",
            "inputIncludesCache": true,
            "reasoningIncludedInOutput": true,
            "aggregation": "invocation"
          },
          "contextUsage": {
            "path": "context_usage",
            "input": "input_tokens",
            "cache": "cached_input_tokens",
            "window": 233000,
            "inputIncludesCache": true
          }
        }
      }
    }
  }
}
```

The bridge reports usage for the current invocation, so `output.usage.aggregation` must be `invocation`, including on resume; `session` would incorrectly subtract per-invocation values as cumulative counters. The sample context window is adapter/model specific and must be verified for the selected model.

The bridge passes `--dangerously-bypass-approvals-and-sandbox` to `codex exec` so background jobs never block on a confirmation prompt. Do not add `--sandbox` or approval flags in `args`; the bridge owns them.

### 4. Read the usage report

- `cliUsage.usedTokens` is the peak per-request prompt of the retained conversation and `cliUsage.percent` is that over the 233k window. Reuse the conversation while it stays below roughly 80%; start a new conversation once it crosses the line or when the next task no longer continues the same context.
- `role-usage.jsonl` still records the turn aggregate (`inputTokens`, `cachedInputTokens`, `outputTokens`) for cost accounting; the two numbers answer different questions.

### 5. Verify CLI adapter readiness

```js
contextos({
  action: "ops",
  args: { capability: "micro", action: "doctor", args: { role: "cli", adapter: "codex", probe: true } }
})
```

A probe passes when connectivity returns `PONG`.

## CLI adapter setup (Antigravity `agy`)

### 1. Local installation and verification

Install `agy` using its official package installer, then verify locally:

```bash
agy --version
agy --help
```

Ensure user account is authenticated:

```bash
agy auth status
```

### 2. Configure adapter in profile

Add or update the `agy` adapter in `~/.contextos/profile.json`:

```json
{
  "agents": {
    "default": "agy",
    "adapters": {
      "agy": {
        "command": "agy",
        "args": [
          "--input-format", "stream-json",
          "--output-format", "stream-json",
          "--model", "{model}",
          "--mode", "{mode}",
          "--dangerously-skip-permissions"
        ],
        "resumeArgs": ["--conversation", "{sessionId}"],
        "input": {
          "format": "jsonl",
          "keepOpen": true,
          "template": { "event": "user", "message": { "content": "{task}" } }
        },
        "output": {
          "format": "jsonl",
          "terminal": { "path": "event", "value": "result" },
          "resultPath": "result",
          "contentPath": "response",
          "statusPath": "status",
          "successValues": ["SUCCESS"],
          "contextUsage": {
            "path": "step_update.usage",
            "input": "input_tokens",
            "cache": "cache_read_tokens",
            "window": 233000,
            "inputIncludesCache": false
          }
        },
        "modes": { "analyze": "plan", "implement": "accept-edits" }
      }
    }
  }
}
```

### 3. Preconfigure tool permissions

Grant automatic permission for ContextOS MCP tools in `~/.gemini/antigravity-cli/settings.json` so child tasks do not block on confirmation prompts:

```json
{
  "permissions": {
    "allow": [
      "mcp(contextos/contextos)"
    ]
  }
}
```

AGY encodes reasoning effort in the model id; do not pass `--effort` with a suffixed model. Do not force `--sandbox` for MCP-backed work because it can isolate the CLI from its ContextOS MCP server. Keep `--dangerously-skip-permissions` for automation.

### 4. Register ContextOS OS MCP server

In the CLI host's MCP configuration (`mcp_config.json`):

```json
{
  "mcpServers": {
    "contextos": {
      "command": "node",
      "args": [
        "--no-warnings=ExperimentalWarning",
        "/Users/username/.contextos/server/contextos-mcp.mjs"
      ]
    }
  }
}
```

### 5. Sync skill package

Copy or link the skill package to the CLI skills directory:

```bash
cp -R plugins/contextos/skills/* ~/.gemini/antigravity-cli/skills/
```

### 6. Verify CLI adapter readiness

Run doctor check for the CLI adapter:

```js
contextos({
  action: "ops",
  args: {
    capability: "micro",
    action: "doctor",
    args: { role: "cli", adapter: "agy" }
  }
})
```

## Doctor output interpretation

Doctor reports readiness across standardized dimensions as `yes`, `no`, or `unknown`:

| Dimension | Meaning | Expected |
| --- | --- | --- |
| `installed` | CLI executable binary or API URL is reachable | `yes` |
| `authenticated` | Valid credentials or active CLI login detected | `yes` |
| `model` | Configured model identifier confirmed supported | `yes` |
| `effort` | Thinking effort parameter mapped and accepted | `yes` |
| `analyze` | Analysis / planning mode supported by adapter | `yes` |
| `implement` | Implementation / editing mode supported with allowed paths | `yes` |

> [!NOTE]
> Offline local doctor checks (`probe: false`) do not make outbound model requests. Fields such as `authenticated`, `analyze` (`task_analyze`), or `implement` (`task_implement`) reporting `unknown; not probed` are expected normal states and do not indicate a failure or block delegation. As long as `installed`, `model`, and credential sources are configured, dispatch micro normally. Live network verification is performed only when `probe: true` is explicitly passed.

## Common errors and fixes

### 1. HTTP 401 / 403 Forbidden or Unauthorized
- **Cause**: Invalid, expired, or deactivated API key; insufficient account balance.
- **Fix**: Check `CONTEXTOS_API_MICRO_KEY` value, verify balance on provider dashboard, update key in environment.

### 2. HTTP 404 Not Found / Model Not Found
- **Cause**: Endpoint URL path missing `/v1` (e.g. `https://api.deepseek.com` instead of `https://api.deepseek.com/v1`), or requested model ID does not exist on this route.
- **Fix**: Verify `micro.url` path and ensure `micro.model` matches provider documentation.

### 3. Connection Refused / DNS Resolution Failure / Timeout
- **Cause**: Pre-authentication network failure, proxy misconfiguration, or firewall blocking outbound connections.
- **Fix**: Verify host internet connectivity, DNS resolution, and proxy settings (`HTTP_PROXY` / `HTTPS_PROXY`).

### 4. HTTP 200 with Parse Failure
- **Cause**: Model endpoint returned non-JSON response or incompatible stream events.
- **Fix**: Confirm endpoint supports OpenAI-compatible Chat Completions, and check `micro.transport` setting.

### 5. CLI Agent Permission Prompt Blocking
- **Cause**: CLI command lacks permission bypass flags or MCP tool permissions are missing.
- **Fix**: Add `--dangerously-skip-permissions`, remove conflicting `--effort` when the model id already contains an effort suffix, remove `--sandbox` for MCP-backed work, and add `"mcp(contextos/contextos)"` to the `settings.json` allowlist.

### 6. YAML Frontmatter Parse Failure in Skills
- **Cause**: Unquoted colon inside description scalar (e.g. `description: Required: do this`).
- **Fix**: Quote description with double quotes: `description: "Required: do this"`.

### 7. CLI Subagent Timeout on Host Tool Calls (~3 Minutes)
- **Cause**: Complex multi-step CLI tasks running synchronously can exceed the host MCP client timeout (AGY enforces ~3 minutes per tool call). When timed out, the host kills the child process, losing both the structured report and token accounting.
- **Fix**: Dispatch long-running CLI subagent tasks with `background: true` to get the job `id` immediately without blocking. Retrieve the structured report via `agent({action: "get", id})` or listen to mailbox messages with `agent({action: "messages", jobId, waitMs})`.

