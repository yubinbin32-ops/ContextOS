# Project Decisions

## [DEC-001] ContextOS V2 Ground-up Architecture Rebuild

Status: Accepted
Context: Version 0.4.1 suffered from regex-based pseudo AST, ghost blocks, fragmented Checkpoint ownership, monolithic 49-tool MCP interface, and direct SQLite dependency in Swift App.
Decision: Rebuild the entire system into two tiers (independent OS Plugin and SwiftUI App), consolidate 9 action-based MCP facades, enforce C-D-C-S workflow, and tie Blocks exclusively to real code with automatic AST re-anchoring.
## [DEC-002] Dual Materialization: SQLite Active State and Git graph.json

Status: Accepted
Context: SQLite provides local transactional performance and WAL concurrency, but Git requires plain-text version control.
Decision: Use deterministic graph.json exported from SQLite on task_sync. Watch for external Git rollback/checkout to atomically roll back SQLite state.
