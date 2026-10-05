# ContextOS 3.0.0 — The context exoskeleton for AI development

ContextOS supports the full AI development lifecycle: understand a project, plan work, inspect evidence, execute, implement, verify, review, and resume. It keeps project state inspectable while reducing repeated token use and main-agent context occupancy.

## One OS across the lifecycle

- **Evidence and commands:** precise source reads, reusable results, and execution receipts.
- **Pipelines and changes:** serial or parallel batches, scoped edits, verification, and integration.
- **Blocks and Chains:** architecture connected to the implementation and its dependencies.
- **Plans, tasks, and sessions:** persistent intent, progress, decisions, and continuity across conversations.
- **Micro and CLI:** bounded assistance and isolated implementation workers, with the main agent retaining decisions and final review.

## App settings and model synchronization

Configure shared models and reasoning levels, then use `Use Global` for role-level inheritance or choose role-specific settings. Synchronize the models and effort options available from your Micro provider and CLI adapters.

The App has compact settings cards, a single dropdown arrow, improved scrolling, and a responsive Windows layout. An empty key field preserves the existing API key for the same origin; changing origin requires a new key.

Verified checks include **45 macOS Swift tests**, the **Windows frontend build**, and **7 model-catalog tests**. Live Micro, Codex, and AGY catalog checks passed, and manual login and invocation tests passed.

## Historical measurement

A real plan-dependency task starting at [`0dd6431`](https://github.com/yubinbin32-ops/ContextOS/tree/0dd6431) used fresh conversations and isolated worktrees. Peak main-thread input was **234,174 tokens with native tools**, **145,694 with OS + Micro (−37.8%)**, and **84,681 with OS + Micro + CLI (−63.8%)**.

Under the specified comparison model, equivalent USD was **$1.6230556 native**, **$1.3157976 OS only**, **$1.4137650 OS + Micro**, and **$0.7900901 OS + Micro + CLI**. Rates are $2/$0.10/$10 per million uncached-input/cached-input/output tokens, with assistant cost divided by 7. Cached input is included in input; reasoning is included in output.

These are one task's historical results, not a new release benchmark or actual provider invoices. The full workflow used more combined raw tokens. Its **51.3% equivalent-cost reduction is an observed subtotal**: D Micro reported usage for 128 of 129 started requests, with one request's usage unknown.

[Methodology](https://github.com/yubinbin32-ops/ContextOS/blob/v3.0.0/docs/benchmarks/plan-dependencies/README.md) · [Usage JSON](https://github.com/yubinbin32-ops/ContextOS/blob/v3.0.0/docs/benchmarks/plan-dependencies/historical-usage.json) · [Role costs CSV](https://github.com/yubinbin32-ops/ContextOS/blob/v3.0.0/docs/benchmarks/plan-dependencies/usage-by-role.csv) · [Four-arm totals CSV](https://github.com/yubinbin32-ops/ContextOS/blob/v3.0.0/docs/benchmarks/plan-dependencies/comparison.csv) · [Recalculation script](https://github.com/yubinbin32-ops/ContextOS/blob/v3.0.0/docs/benchmarks/plan-dependencies/recalculate.py) · [SHA-256 hashes](https://github.com/yubinbin32-ops/ContextOS/blob/v3.0.0/docs/benchmarks/plan-dependencies/SHA256SUMS)

## Install with AI

Send your coding assistant:

> 读取 (https://github.com/yubinbin32-ops/ContextOS/blob/main/setup.md) ，为我安装OS

The [installation guide](https://github.com/yubinbin32-ops/ContextOS/blob/v3.0.0/setup.md) covers installation, host plugins and skills, project registration, Micro API configuration, CLI adapters, authentication, and acceptance checks. Node.js 22+ is required. Micro needs its own API connection; a CLI login alone does not configure it.

[English overview](https://github.com/yubinbin32-ops/ContextOS/blob/v3.0.0/README.md) · [中文介绍](https://github.com/yubinbin32-ops/ContextOS/blob/v3.0.0/README_zh.md) · [Report an issue](https://github.com/yubinbin32-ops/ContextOS/issues)
