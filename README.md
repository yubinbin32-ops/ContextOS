<div align="center">
  <img src="assets/logo.png" width="80" alt="ContextOS logo" />
  <h1>ContextOS</h1>
  <p><strong>The context exoskeleton for AI development.</strong></p>
  <p>Optimize the full development lifecycle. Reduce repeated token use and keep context focused.</p>

[![GitHub release](https://img.shields.io/github/v/release/yubinbin32-ops/ContextOS)](https://github.com/yubinbin32-ops/ContextOS/releases/latest)
[![GitHub stars](https://img.shields.io/github/stars/yubinbin32-ops/ContextOS?style=flat)](https://github.com/yubinbin32-ops/ContextOS/stargazers)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933)](https://nodejs.org)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

<p>Local MCP runtime · Precise evidence · Persistent receipts · Live architecture</p>

[中文](README_zh.md) · [Install with AI](#install-with-one-prompt) · [Measured results](#three-development-workflows-measured) · [Desktop App](#see-your-project-in-the-app)
</div>

## Give your agent an exoskeleton

![ContextOS desktop walkthrough](assets/contextos-demo.gif)

ContextOS is a local development runtime between an AI coding agent and your repository. It keeps source evidence, command logs, plans, architecture, and verification receipts outside the main conversation, then returns the pieces needed for the next decision.

OS supports the **entire AI development lifecycle**: understand the project, plan, inspect evidence, execute, implement, verify, review, and resume. Precise reads, reusable commands, pipelines, Blocks, Chains, persistent plans, Micro, and CLI all serve the same purpose: reduce unnecessary token consumption and context occupancy while keeping development grounded in inspectable project state.

Your existing coding assistant stays in charge. OS supplies the execution and memory layer beneath it, including bounded API Micro assistance and isolated CLI implementation when a task benefits from delegation.

In a recorded real development task, the full OS + Micro + CLI workflow reduced **peak main-thread context by 63.8%** and main-thread cumulative raw tokens by 77.4% compared with native tools. [See the task, comparison, and limits below.](#three-development-workflows-measured)

## Why long coding sessions get expensive

A small question often triggers a large file read. A failed test fills the conversation with logs. The agent revisits the same code, repeats a command, and spends its attention reconstructing decisions made earlier. Multi-file implementation then shares the same context window as planning and review.

The result is familiar: a crowded conversation, repeated explanations, uncertain project state, and less room for the next useful decision. A larger context window postpones the problem; development needs a way to carry this work across tools and sessions.

## How OS carries the work

```text
You → Main agent: plan, scope, architecture, review
          │
          └─ ContextOS: evidence, commands, changes, persistent state
                ├─ API Micro: bounded discovery, summaries, small checks
                ├─ CLI worker: isolated implementation → report → integration
                └─ Desktop App: architecture, plans, checkpoints, settings
```

Evidence and logs are saved locally. Workers read task evidence in their own contexts and return compact reports. Changes pass through OS so file ownership, verification, and the project graph stay connected. A fresh session can recover the plan and receipts instead of reconstructing the entire transcript.

### Capabilities and their practical effect

| Capability | How it works | What it achieves |
| --- | --- | --- |
| **Evidence · `ask`** | Inspect exact paths, line ranges, and AST symbols; recover earlier evidence by result ID and check source versions. | Read the relevant implementation and reuse valid evidence instead of repeatedly loading whole files. |
| **Commands · `command`** | Execute once, persist stdout/stderr and exit status, then retrieve a focused section by command ID. | Keep build noise outside the main context and recover the useful failure without rerunning the process. |
| **Batches · `pipeline`** | Combine known steps in serial or parallel execution, with per-step results and continuation. | Reduce tool round trips; group independent reads and checks in one call. |
| **Architecture · Block** | Bind curated source files to architecture units with boundaries, state, and verification evidence. | Make ownership visible and keep implementation changes connected to the architecture. |
| **Architecture · Chain** | Connect Blocks into project paths and record their relationships and progress. | See which capabilities depend on each other and follow a feature across module boundaries. |
| **Changes · `change` / `integrate`** | Apply scoped changes through OS or merge a worker's isolated diff, with verification receipts. | Review actual changes and keep architecture state current during implementation. |
| **Small assistant · `micro`** | A configured API model performs bounded retrieval, summarization, diagnosis, or a small edit and returns a compact report. | Move routine tool loops into a lower-cost assistant context; keep the main agent available for judgement. |
| **Implementation · `agent`** | A configured CLI adapter runs a task in an isolated workspace, supports background collection, and returns changes, checks, and blockers. | Move complex implementation out of the main conversation and integrate a reviewable result. |
| **Continuity · plans, tasks, sessions** | Persist intent, progress, rules, decisions, and receipts in the project's OS state. | Resume real project work across conversations and inspect progress in the App. |

Micro and CLI help when the task contract is clear. A small deterministic read can use OS directly; a broad implementation belongs to a CLI worker. Delegation has overhead, so OS makes its execution and results inspectable.

### Three development workflows, measured

The recorded comparison started from commit [`0dd6431`](https://github.com/yubinbin32-ops/ContextOS/tree/0dd6431). Fresh host conversations and isolated worktrees received the same real feature: plan dependency add/remove/list, persistence, validation of unknown targets, duplicates, self-reference and cycles, MCP routing, and tests across domain, application, storage, and MCP layers. [Historical measurement record](https://github.com/yubinbin32-ops/ContextOS/blob/4706c38/README.md#4-empirical-evaluation).

| Workflow | Peak main-thread context | Reduction vs native | Main-thread raw tokens | Tests passed |
| --- | ---: | ---: | ---: | ---: |
| **Native tools** | 234,174 | baseline | 8,016,375 | 778 / 778 |
| **OS + API Micro** | 145,694 | **37.8%** | 4,993,135 | 778 / 778 |
| **OS + API Micro + CLI** | 84,681 | **63.8%** | 1,809,566 | 781 / 781 |

**What “60% less context” means here:** peak input to a main-agent request fell from 234,174 to 84,681 tokens. It describes this measured task, rather than a promise for every repository or the combined tokens of every worker.

<details>
<summary>Full token usage, specified equivalent USD costs, and the OS-only control</summary>

Raw tokens are cumulative input plus output; peak context is the largest single main-agent input. **Cached input is included in input**, so `uncached = input − cached`. Reasoning tokens are included in output and are not counted or charged twice.

The specified comparison uses `equivalent tokens = main raw + (Micro raw + CLI raw) / 7`:

| Arm / workflow | Main raw | Micro raw | CLI raw | Observed total raw | Equivalent tokens | Reduction vs native |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A · Native | 8,016,375 | 0 | 0 | 8,016,375 | 8,016,375 | baseline |
| B · OS only, no assistant | 6,119,582 | 0 | 0 | 6,119,582 | 6,119,582 | 23.7% |
| C · OS + Micro | 4,993,135 | 734,551 | 0 | 5,727,686 | 5,098,070.9 | 36.4% |
| D · OS + Micro + CLI | 1,809,566 | 3,258,709† | 4,393,118 | 9,461,393† | 2,902,684.1† | 63.8%† |

For USD, the **user-specified comparison rates per million tokens** are $2 for uncached input, $0.10 for cached input, and $10 for output:

`base USD = (uncached input × 2 + cached input × 0.1 + output × 10) / 1,000,000`

`equivalent USD = main base USD + (Micro base USD + CLI base USD) / 7`

| Arm | Role | Input | Cached input | Uncached input | Output | Base USD | Divisor | Equivalent USD |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | Main | 7,971,486 | 7,773,056 | 198,430 | 44,889 | $1.6230556 | 1 | $1.6230556 |
| B | Main | 6,073,014 | 5,945,216 | 127,798 | 46,568 | $1.3157976 | 1 | $1.3157976 |
| C | Main | 4,952,753 | 4,710,016 | 242,737 | 40,382 | $1.3602956 | 1 | $1.3602956 |
| C | Micro | 720,163 | 636,800 | 83,363 | 14,388 | $0.3742860 | 7 | $0.053469428571 |
| D | Main | 1,788,852 | 1,746,560 | 42,292 | 20,714 | $0.4663800 | 1 | $0.4663800 |
| D | Micro | 3,211,208† | 3,007,232† | 203,976† | 47,501† | $1.1836852† | 7 | $0.169097885714† |
| D | CLI | 4,355,283 | 4,214,016 | 141,267 | 37,835 | $1.0822856 | 7 | $0.154612228571 |

| Workflow | Total equivalent USD | Reduction vs native |
| --- | ---: | ---: |
| Native | $1.623055600000 | baseline |
| OS only | $1.315797600000 | 18.9% |
| OS + Micro | $1.413765028571 | 12.9% |
| OS + Micro + CLI | $0.790090114286† | 51.3%† |

These are **equivalent consumption and costs under the specified model**, not actual provider invoices or verified provider rates. The assistant divisor of 7 is a chosen comparison assumption. All main sessions reported the `deepseek-v4.1-flash` alias with `max` reasoning effort and a custom provider; Micro C/D retained the same session `lastModel`, and D CLI reported the same alias/custom provider. This does not independently verify the underlying backend model.

Main usage is deduplicated by provider response ID and matches terminal cumulative totals. C Micro has 2 receipts and provider usage for all 26/26 started requests. D CLI has 51 unique cumulative states whose last-usage sum matches its terminal total. **† D Micro has 5 receipts, 129 started requests and 128 usage-bearing responses. One continuation timeout request has unknown usage.** D totals and the 51.3% cost reduction are observed subtotals; the missing request is not assigned zero. Original Micro reasoning fields are unavailable and remain unknown.

The full workflow used **more observed total raw tokens** than native tools while reducing peak main context. OS-only reached 184,507 peak tokens (−21.2%) and lower equivalent USD than OS + Micro in this run. This is one feature's historical single-run comparison; results vary with task, model, caching and delegation.

[Inspect the frozen evidence and methodology](docs/benchmarks/plan-dependencies/README.md), [original usage fields and coverage](docs/benchmarks/plan-dependencies/historical-usage.json), [role costs CSV](docs/benchmarks/plan-dependencies/usage-by-role.csv), and [four-arm totals CSV](docs/benchmarks/plan-dependencies/comparison.csv). Recompute and check the published file hashes with:

```sh
python3 docs/benchmarks/plan-dependencies/recalculate.py --check
```

</details>

## See your project in the App

The desktop App projects the same OS state that agents use: Blocks, Chains, plans, checkpoints, rules, and knowledge. Its white canvas, restrained color, and precise connections make a large project readable.

![Live Block and Chain architecture canvas](assets/canvas-overview.png)

**Read the whole system at a glance.** Follow a Chain through its Blocks, inspect the selected capability, and see implementation and verification progress alongside the graph.

<details open>
<summary>Trace a feature and inspect its evidence</summary>

![A feature path across integration, UI, and testing Blocks](assets/path-impact.png)

**Follow impact across modules.** A highlighted Chain connects integration, packaging, and verification work.

![A passed checkpoint with its receipt reference](assets/checkpoint-detail.png)

**See the evidence behind completion.** Checkpoints expose their status and receipt references.

</details>

<details>
<summary>Read project knowledge and synchronize your tools</summary>

![Project knowledge and rules navigation](assets/knowledge-reader.png)

**Keep project knowledge close.** Open repository documentation and rules from the project sidebar.

![Repository README in the desktop reader](assets/readme-reader.png)

**Read documentation inside the App.** The reader opens repository content alongside the project; performance figures follow the reproducible evidence below.

![Desktop settings and AI editor synchronization](assets/settings-sync.png)

**Manage your development environment.** Settings bring preferences and host integration into the App. Configure shared models and reasoning levels, let each role inherit them with `Use Global`, and synchronize available models and effort options for Micro and CLI adapters.

*The settings image above shows an earlier accepted layout.*

![MCP and skill integration in an AI host](assets/mcp-integration.png)

**Use OS from your coding assistant.** The host loads the MCP runtime and matching skill so the agent can operate on project state.

Some gallery images were captured from earlier builds and retain the former `mdflow` name or earlier version labels. They demonstrate the workflow; follow the installer for the current runtime and configuration.

</details>

## Install with one prompt

Paste this into your AI coding assistant:

> 读取 (https://github.com/yubinbin32-ops/ContextOS/blob/main/setup.md) ，为我安装OS

The agent reads [setup.md](setup.md), installs OS and matching host plugins/skills, registers your repository, configures API Micro and your CLI, and verifies the result with real tool calls. It handles dependency checks, adapter creation, plugin setup, and diagnosis for you.

**You do not need to download and configure a Release package by hand.** The setup guide is written for the installing agent, including diagnosis, adapter configuration, plugin installation, and acceptance checks.

### Micro is required

Micro is the small assistant for routine work, and its **API connection is required for the OS workflow**. Prepare an API key, provider base URL, and model. A main-agent subscription or CLI login alone does not configure API Micro.

Recommended options:

- **[Command Code GOAT](https://commandcode.ai/docs/plans/goat):** includes Provider API access. Create a key in its console; let the agent use the provider's current endpoint and exact model ID.
- **[OpenCode Go](https://opencode.ai/v2/docs/console/go):** provides a subscription API key and available coding models. Have the agent check the current model list and API configuration.
- **Your own compatible API:** use a provider you already trust, including the [DeepSeek API](https://api-docs.deepseek.com/).

For bounded Micro tasks, we recommend **DeepSeek V4.1 Flash with `medium` reasoning** where the provider supports it. The [official DeepSeek model ID is `deepseek-flash`](https://api-docs.deepseek.com/updates/); gateways can use different IDs. The installer must verify model availability and map the provider's reasoning setting instead of assuming every API accepts the same parameters.

Keep the key in the local credential/configuration path established by the installer. Do not paste it into repository documentation or tracked source.

### CLI setup is completed by the agent

CLI workers require a working CLI installation, an adapter, the matching ContextOS plugin/skills, and a verified authenticated execution path. Tell the agent which CLI you use; it should consult that CLI's official documentation, write the adapter, configure OS, and run a real probe and isolated implementation check.

A login, browser authorization, or operating-system permission may require your action. The agent should identify that exact step, continue the remaining setup, and verify readiness after you complete it. A discovered binary or saved adapter alone is not a successful installation.

Node.js **22 or later** is required. After a plugin/runtime update, reload the host's MCP process as directed by setup. Keep the App, plugin, skills, and runtime on matching versions.

## Daily use, in ordinary language

| What you want | Prompt to your agent |
| --- | --- |
| Start a planned task | “Write this plan into OS and start executing it.” |
| Resume tomorrow | “Read the current OS plan and session state, then continue the next unfinished task.” |
| Configure the small assistant | “Configure Micro for me, verify its API connection, and use it for bounded tasks.” |
| Configure implementation workers | “Configure my CLI for me. Write its adapter, install the ContextOS plugin, and test an isolated implementation.” |
| Explore a bug | “Use Micro to locate the cause; return the relevant evidence and one compact diagnosis.” |
| Implement a feature | “Delegate this implementation to CLI in an isolated workspace, verify it, and integrate the result through OS.” |
| Review progress | “Update the Blocks, Chains, and checkpoints so I can inspect progress in the App.” |
| Change tools | “Switch to my other configured CLI adapter and verify it before the next task.” |

The main agent keeps the acceptance criteria and final review. Micro and CLI take bounded assignments; OS retains the evidence and progress between them.

## What's new in 3.0.0

The 3.0 line, prepared from `4706c38`, restructures ContextOS into an exoskeleton for the full AI development lifecycle:

- **Precise evidence and reusable commands** keep source inspection and execution results focused and recoverable.
- **Pipelines and verified changes** connect batched execution, scoped edits, and reviewable results.
- **Architecture and continuity** keep plans, tasks, sessions, Blocks, Chains, and receipts available across conversations and in the desktop App.
- **Task-appropriate delegation** adds bounded API Micro assistance and isolated CLI implementation to the same OS lifecycle.
- **AI-led installation** makes provider configuration, host plugins, CLI adapters, diagnosis, and real acceptance checks part of setup.

See [the 3.0 release notes](.github/RELEASE_NOTES.md), [installation guide](setup.md), and [release history](https://github.com/yubinbin32-ops/ContextOS/releases).

If ContextOS helps your agent stay focused, [give the project a star](https://github.com/yubinbin32-ops/ContextOS/stargazers). Reproducible tasks and [issue reports](https://github.com/yubinbin32-ops/ContextOS/issues) help us improve the next release.
