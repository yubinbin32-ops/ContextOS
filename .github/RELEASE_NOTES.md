# ContextOS 3.0.0 — The context exoskeleton for AI development

Release preparation from `4706c38`. ContextOS optimizes the full AI development lifecycle: project understanding, planning, evidence, execution, implementation, verification, review, and continuity. Its evidence, commands, pipelines, changes, Blocks, Chains, plans, Micro, and CLI work toward the same goal: reduce unnecessary token use and context occupancy.

## One OS for the full development lifecycle

- **Evidence and commands:** exact source inspection, recoverable results, and durable execution receipts.
- **Pipelines and changes:** serial/parallel batches, scoped edits, verification, and integration.
- **Architecture and continuity:** Blocks, Chains, plans, tasks, and sessions connected to actual implementation.
- **Task-appropriate assistance:** API Micro handles bounded work; CLI adapters execute complex implementations in isolated workspaces.
- **Desktop visibility:** the App presents project structure, progress, evidence, and configuration.

The main agent retains the task contract, decisions, and final review while OS carries execution and project memory.

## Measured effect

The recorded plan-dependency feature experiment, based on commit `0dd6431`, compared fresh conversations and isolated worktrees. Peak main-thread input fell from **234,174 tokens with native tools** to **145,694 with OS + Micro (−37.8%)** and **84,681 with OS + Micro + CLI (−63.8%)**. All three implementations passed their test suites.

These are historical single-run measurements, not a new benchmark of this release. The full workflow used more combined raw tokens across workers; peak main context, cumulative raw tokens, and price-weighted cost are different metrics. See [the complete comparison and assumptions](../README.md#three-development-workflows-measured).

## Install and configure with AI

Send your coding assistant:

> 读取 (https://github.com/yubinbin32-ops/ContextOS/blob/main/setup.md) ，为我安装OS

[setup.md](../setup.md) guides the agent through version selection, installation, host plugins/skills, project registration, mandatory API Micro setup, CLI adapter creation, authentication, and actual acceptance checks. Node.js 22+ is required. The one-line prompt requires 3.0.0 or newer. Before publication, the agent verifies candidate availability and reports an unpublished version if no suitable build can be obtained; it must not silently install 2.x.

Micro requires its own API connection. Recommended options are [Command Code GOAT](https://commandcode.ai/docs/plans/goat), [OpenCode Go](https://opencode.ai/v2/docs/console/go), or your own compatible provider. For bounded tasks, use DeepSeek V4.1 Flash with `medium` reasoning where supported; the installer verifies the provider's actual model ID and parameters.


## Global settings and model synchronization

The App now supports shared model and reasoning settings with `Use Global` inheritance for each role. Model synchronization reads each Micro provider and CLI adapter's available models and effort options. Empty API key fields preserve an existing key for the same origin; changing origin requires a new key.

The final settings layout uses compact cards and a single dropdown arrow, fixes the scrollbar layout, and retains the normal 756 × 710 macOS window size. Windows settings also adapt to smaller screens. The README settings image remains an earlier accepted capture.

Validation passed: Swift 45 tests, Windows TypeScript build, seven model-catalog Node tests, and live catalogs for Micro (36 entries), Codex (5 with effort information), and AGY (14, including 12 variants). The user also confirmed manual login and invocation tests passed. The final macOS package, version checks, benchmark recalculation and hashes, diff checks, and a 321-file global/project credential scan passed.

The final settings UI has no new tool-verified native screenshot because native App binding failed. Windows Rust/Tauri was not compiled because Cargo was unavailable. This session made no commit, push, or Release.

[English overview](../README.md) · [中文介绍](../README_zh.md) · [Report an issue](https://github.com/yubinbin32-ops/ContextOS/issues)
