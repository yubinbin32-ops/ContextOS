<div align="center">
  <img src="assets/logo.png" width="80" alt="ContextOS logo" />
  <h1>ContextOS</h1>
  <p><strong>Give your coding agent the code it needs. Keep noisy logs out of the conversation.</strong></p>

[![GitHub release](https://img.shields.io/github/v/release/yubinbin32-ops/ContextOS)](https://github.com/yubinbin32-ops/ContextOS/releases/latest)
[![GitHub stars](https://img.shields.io/github/stars/yubinbin32-ops/ContextOS?style=flat)](https://github.com/yubinbin32-ops/ContextOS/stargazers)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933)](https://nodejs.org)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

<p>Current Version: <span id="contextos-version">2.7.2</span> · Local MCP runtime · AST slices · Verification receipts · Persistent project state</p>

[**Get started**](#get-started) · [**Real development evaluation**](docs/DEVELOPMENT_QUALIFICATION.md) · [**Releases**](https://github.com/yubinbin32-ops/ContextOS/releases) · [**中文**](README_zh.md)
</div>

ContextOS is an open-source execution layer between an AI coding agent and your repository. It returns focused source slices, runs commands outside the conversation, and brings back compact verification receipts with actionable failure details. Project state stays in `.contextos/` so later work can reuse it.

**Measured on two files from this repository: 1,459 → 336 and 43,031 → 280 returned tokens when replacing whole-file reads with a symbol slice.** These are output-context measurements, not model billing or total-task savings. [Method, controls, and raw results →](docs/BENCHMARK.md)

![ContextOS workflow and architecture map demo](assets/contextos-demo.gif)

## Why use it?

| Common source of context waste | What ContextOS does |
| --- | --- |
| Loading a large file to change one function | Reads a symbol or precise line range, with source locations |
| Re-reading unchanged code | Returns an unchanged receipt instead of replaying the body |
| Pasting successful build logs into a chat | Keeps logs on disk; returns the command, exit code, and receipt |
| Losing the failure detail in a noisy test run | Returns failure evidence alongside the verification result |
| Several file reads and tests across separate turns | Batches work in a pipeline; combines edits and verification |
| Reconstructing project state in a later session | Persists session state and a Block/Chain/Link architecture graph |

The default MCP surface exposes **one `contextos` tool**. Codex can load it as a plugin; other MCP hosts can run the same local server. Optional desktop apps show the architecture as a Metro Map. Micro is an optional external executor; the benchmark and core workflow need no model API key.

## Response-only controls from 2.7.1

Five fresh-workspace runs, `o200k_base` tokenizer, medians. **The table measures response text only.**

| Scenario | Native output tokens | ContextOS output tokens | Change |
| --- | ---: | ---: | --- |
| Large repository file → one symbol | 43,031 | 280 | 99.35% less |
| Smaller repository file → one symbol | 1,459 | 336 | 76.97% less |
| Repeated unchanged symbol read | 165 | 36 | 78.18% less |
| Synthetic successful build, 1,000 log lines | 14,003 | 83 | 99.41% less |
| Synthetic failed build, 1,000 log lines | 14,016 | 150 | 98.93% less |
| Efficient native slice of the same large-file symbol | 165 | 280 | 115 more |
| Tiny file | 6 | 66 | 60 more |

**Use it where the saved context outweighs the setup.** The measured compact tool definition, server instructions, and skill add about **2,504 tokens** when loaded together. Exact native slices can be cheaper on a first read; trivial edits should skip the full exploration lifecycle. Synthetic log results show compression under controlled noise, not typical project performance. The 2,504-token figure applies to the released 2.7.1 skill. An actual coding-task pilot now records provider usage, reasoning, cache and completion quality below.

The compact tool definition uses 1,056 tokens versus 2,922 for the seven-tool compatibility surface. [Full evaluation, fixed costs, and remaining opportunities](docs/BENCHMARK.md).

## Real development evaluation

The 2.7.2 evaluation uses **`gpt-6-luna` / `max`** on completed coding tasks, counts primary provider input/output and cache usage, and checks repairs independently. Small tasks, interruptions and regressions stay in the published data. [Matched results, qualification gates and reproduction](docs/DEVELOPMENT_QUALIFICATION.md) · [Original 2.7.1 interrupted pilot](docs/REAL_DEVELOPMENT_BENCHMARK.md)

## Get started

Requires **Node.js 22+**. Source installation is the reproducible route for this release.

```bash
git clone https://github.com/yubinbin32-ops/ContextOS.git
cd ContextOS
npm ci
npm run plugin:build
```

### Codex plugin

With a Codex CLI that supports plugins, register the marketplace shipped in this repository:

```bash
codex plugin marketplace add .
codex plugin add contextos@contextos-development
npm run plugin:install
npm run plugin:install:check
```

Start a new chat to load the updated server and skill. The check validates the registered version and installed files against this build; copying a newer bundle into an old cache is insufficient.

### Other MCP hosts

Add this stdio server to your host's MCP configuration, replacing the absolute path:

```json
{
  "mcpServers": {
    "contextos": {
      "command": "node",
      "args": ["/absolute/path/ContextOS/plugins/contextos/server/contextos-mcp.mjs"]
    }
  }
}
```

Give your agent the [ContextOS skill](plugins/contextos/skills/contextos/SKILL.md), or ask it to follow [the setup guide](AI_SETUP.md). Host configuration formats differ; the guide covers Cursor, Claude, Antigravity, and OpenCode adapters.

### A small example

These are MCP calls made by your agent, using an absolute `projectRoot`:

```js
contextos({
  action: "work",
  args: { inspect: [{ path: "src/cart.ts", symbol: "calculateTotal" }] },
  projectRoot: "/absolute/path/to/project"
})

contextos({
  action: "change",
  args: {
    edits: [{ path: "src/cart.ts", target: "price * quantity", replacement: "price * quantity - discount" }],
    verify: ["npm test"],
    autoRevert: true
  },
  projectRoot: "/absolute/path/to/project"
})
```

Read the owning function and focused tests together with `work`, then edit and verify in one `change`. Search one exact identifier when the location is unknown. Successful receipts keep logs off the conversation; blocked edits name the fields to correct. Use native tools when the relevant code and checks are already available; no exploration, graph binding or Micro step is mandatory.

## What’s new in 2.7.2?

- A lean three-field MCP surface and shorter skill, with ordinary-tool fallback for small repairs.
- Bounded `work` reads preserve source bodies; search and outlines remain incomplete until the needed source is read.
- Structured mutation outcomes distinguish blocked edits, applied changes, successful verification and reverts.
- Named failure receipts provide bounded logs for recovery; oldText/newText edits remain supported.
- Scoped ownership refresh preserves untouched references and Chain membership; `doctor` diagnoses invalid saved graphs without deleting them.
- Read-only installation checks cover the canonical server, parser runtime and every shipped grammar.
- Real-task A/B tooling records provider usage, cache, reasoning, peak input, quality and compaction under request/token/time limits. CI tests the contracts without model calls.

[Release notes](.github/RELEASE_NOTES.md) · [Latest release](https://github.com/yubinbin32-ops/ContextOS/releases/latest)

## Local state, desktop, and optional services

Project state stays local. Cloud Hub has been removed and no Hooks are installed. Optional Micro supports an existing API/Key or an AI-configured CLI adapter; see [setup](AI_SETUP.md). Workers receive bounded task context and the host verifies their results.

Desktop downloads and their supported platforms are listed per release. The 2.7.1 measurements cover the MCP runtime on macOS arm64; they do not establish Windows desktop performance or Micro savings.

## Lean refactor in development

This branch removes Hub, shortens the default skill and adds generic CLI Micro adapters. Keep API and CLI configuration together; choose `micro.priority: "cli-first"` or `"api-first"`. A started task never silently retries through the other provider. AI checks the selected CLI and configures installation/login guidance, model, effort and its actual headless protocol.

Workers receive an objective, workspace, allowed paths, acceptance checks, current state and necessary evidence. They can fetch missing context with OS or native tools. Implementation runs in a separate workspace; the host verifies and integrates it. Existing Key/API configurations remain supported. See [adapter setup](plugins/contextos/skills/contextos-ops/references/micro-setup.md).

Raw tokens, peak context and personal cost estimates are separate metrics. `micro.cost.tokenDivisor` expresses a user assumption; a personal ÷7 estimate is not a universal savings claim. AGY has passed real bounded analysis and implementation tasks; other CLI mappings need their own validation. Complete-task performance remains unqualified, and the new Windows native bridge has not been validated on Windows.

## Reproduce and contribute

```bash
npm test
npm run plugin:verify
npm run dist:smoke
npm run acceptance:real
npm run benchmark:context -- --runs 5 --output .contextos/benchmarks/my-run.json
```

Share your benchmark with the repository size, task, host, tokenizer, and baseline. Reports where ContextOS costs more are useful too.

If focused reads and compact receipts help your coding workflow, **[star ContextOS](https://github.com/yubinbin32-ops/ContextOS)** to follow its progress. [Report a bug](https://github.com/yubinbin32-ops/ContextOS/issues/new/choose) or contribute an improvement.

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT license](LICENSE)
