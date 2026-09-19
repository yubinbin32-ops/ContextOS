---
id: rule-command-sessions
title: Command Sessions and Background Process Supervision
category: execution
priority: high
summary: Governs short-lived commands via run_command and long-lived daemons via process manager.
---

# Command Sessions and Background Process Supervision

## 1. Execution Routing
1. **Short-lived commands** (builds, tests, linters, scripts): Execute through `run_command`. Output is sanitized, ANSI stripped, secrets redacted, and full output persisted to `.contextos/logs/`.
2. **Long-lived processes** (dev servers, watchers, persistent test runners): Must be registered and supervised via `process` facade (`process(action: 'start')`).
3. Never dump raw unbounded output into model context. Always rely on compact receipts.

## 2. Process Hygiene & Clean-on-Finish
1. Agents must check running processes via `process(action: 'list')` before launching duplicate servers.
2. In accordance with Clean-on-Finish discipline, any temporary daemon started during a task must be explicitly stopped via `process(action: 'stop')` before completing work.
3. Process groups are terminated cleanly via SIGTERM/SIGKILL tree traversal to prevent orphan port leaks.
