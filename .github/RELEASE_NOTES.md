# ContextOS — Focused code, compact results, Micro assistants

Draft for the next release. Source-build functionality is tested. The 60% user-equivalent token-cost reduction is a working target, not a measured guarantee.

ContextOS helps your AI coding agent read functions instead of whole files, batch edits and tests, and recover specific failure logs. Keep the main model responsible for the plan and final review, and assign bounded review or implementation work to a Micro assistant.

Micro can use an OpenAI-compatible API or an existing CLI login. Dispatch a background task and keep working: the assistant can return every result, report only what needs attention, or keep successful work quiet. Important reports arrive with a later OS call, without progress polling.

Attach a focused read pipeline when delegating, so task source goes directly to the assistant while the main model reviews the resulting diff and checks. Reuse existing evidence instead of repeating reads.

The comparison formula is `main raw + api-micro raw / 7 + cli-agent raw / 7`. The `/7` factor is a user-specific relative-price estimate, not an invoice. Validate the target on real tasks with visible host conversations and complete role usage.

Requires Node.js 22+. [Install and configure](https://github.com/yubinbin32-ops/ContextOS/blob/main/setup.md) · [中文介绍](https://github.com/yubinbin32-ops/ContextOS/blob/main/README_zh.md)

If ContextOS helps your workflow, [give it a star](https://github.com/yubinbin32-ops/ContextOS). Share a reproducible task or report repeated reads, oversized responses, and task drift so we can improve it.
