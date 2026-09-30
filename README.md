<div align="center">
  <img src="assets/logo.png" width="80" alt="ContextOS logo" />
  <h1>ContextOS</h1>
  <p><strong>Give your coding agent the code it needs. Keep noisy logs out of the conversation.</strong></p>

[![GitHub release](https://img.shields.io/github/v/release/yubinbin32-ops/ContextOS)](https://github.com/yubinbin32-ops/ContextOS/releases/latest)
[![GitHub stars](https://img.shields.io/github/stars/yubinbin32-ops/ContextOS?style=flat)](https://github.com/yubinbin32-ops/ContextOS/stargazers)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933)](https://nodejs.org)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

<p>Current Version: <span id="contextos-version">2.7.1</span> · Local MCP runtime · AST slices · Verification receipts · Persistent project state</p>

[**Get started**](#get-started) · [**See the measurements**](docs/BENCHMARK.md) · [**Releases**](https://github.com/yubinbin32-ops/ContextOS/releases) · [**中文**](README_zh.md)
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

## Measured results

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

**Use it where the saved context outweighs the setup.** The measured compact tool definition, server instructions, and skill add about **2,504 tokens** when loaded together. Exact native slices can be cheaper on a first read; trivial edits should skip the full exploration lifecycle. Synthetic log results show compression under controlled noise, not typical project performance. Provider usage, reasoning tokens, cache discounts, and task completion quality require a separate agent A/B study.

The compact tool definition uses 1,056 tokens versus 2,922 for the seven-tool compatibility surface. [Full evaluation, fixed costs, and remaining opportunities](docs/BENCHMARK.md).

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
  action: "inspect",
  args: { path: "src/cart.ts", symbol: "calculateTotal" },
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

For larger tasks, the skill routes exploration, precise inspection, verification, and edits through the pipeline. Files remain editable with ordinary tools. Successful receipts avoid replaying logs; explicit ranges and recovery reads provide detail when needed.

## What's new in 2.7.1?

- Batched inspections honor explicit symbols and line ranges without an undocumented opt-in.
- Non-contiguous code slices preserve each range's original source line numbers.
- Installation refreshes Codex's registered version, checks actual file contents, and preserves inactive historical caches.
- A read-only install check rejects stale registrations or bundles.
- Plugin builds and installs include parser WASM and grammars, preserving Python method hashes and call information outside the source checkout.
- A public benchmark includes efficient native controls, negative results, fixed overhead, and quality assertions.

[Release notes](.github/RELEASE_NOTES.md) · [Latest release](https://github.com/yubinbin32-ops/ContextOS/releases/latest)

## Local state, desktop, and optional services

Local mode stores project state in the workspace. The core server needs no cloud account. Cloud collaboration is experimental; Micro calls an external model only when configured and invoked. Choose these features when your workflow needs them.

Desktop downloads and their supported platforms are listed per release. The 2.7.1 measurements cover the MCP runtime on macOS arm64; they do not establish Windows desktop performance or cloud/Micro savings.

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
