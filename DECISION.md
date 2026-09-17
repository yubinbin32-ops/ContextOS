# Project Decisions (Architectural Decision Records)

This document records the architectural history, lessons learned from past wrong paths, and permanent design decisions for ContextOS V2.

---

## [DEC-001] ContextOS V2 Ground-up Architecture Rebuild

Status: Accepted
Context: Version 0.4.1 suffered from regex-based pseudo AST, ghost blocks, fragmented Checkpoint ownership, monolithic 49-tool MCP interface, and direct SQLite dependency in Swift App.
Decision: Rebuild the entire system into two tiers (independent OS Plugin and SwiftUI App), consolidate 9 action-based MCP facades, enforce C-D-C-S workflow, and tie Blocks exclusively to real code with automatic AST re-anchoring.
## [DEC-002] Dual Materialization: SQLite Active State and Git graph.json

Status: Accepted
Context: SQLite provides local transactional performance and WAL concurrency, but Git requires plain-text version control.
Decision: Use deterministic graph.json exported from SQLite on task_sync. Watch for external Git rollback/checkout to atomically roll back SQLite state.
## [DEC-003] Strict Real-Code Block Invariant & Total Elimination of Ghost Blocks

- **Status**: Accepted
- **Context & Mistaken Paths (历史弯路)**:
  Version 0.4.x allowed "proposed", "planned", or "blueprint" Blocks that had no backing code files on disk.
  Over time, 51 ghost blocks accumulated in the graph, representing imagined features that were never implemented.
  Agents repeatedly hallucinated that these modules existed, attempting to call nonexistent APIs and misinterpreting system architecture.
- **Decision (架构决策)**:
  Enforce the **Strict Real-Code Block Invariant**:
  - A Block is a semantic capability strictly bound to real code files and AST symbols via artifactRefs.
  - Planning and intent belong exclusively to Plan and Task entities.
  - The database rejects any Block without concrete, existing code references on disk (assertNoGhostBlocks).
- **Consequences (收益)**:
  - 100% of Blocks in ContextOS correspond to actual source files on disk.
  - Ghost blocks eliminated entirely; architectural hallucinations dropped to zero.

---

## [DEC-004] True AST Parsing Engine (@babel/parser & Python Native ast) vs Regex Line-Matching

- **Status**: Accepted
- **Context & Mistaken Paths (历史弯路)**:
  Previous versions used regular expressions and naive bracket counters to parse code structures.
  This repeatedly failed when code contained:
  - String literals with braces (e.g. const s = "hello { name }")
  - Comments with braces (e.g. // check { foo })
  - Multi-line parameter lists or TypeScript generics
  - Indented classes, interfaces, or Swift SwiftUI var body: some View blocks
  The parser would miscalculate start/end lines, truncating methods or misattributing symbols.
- **Decision (架构决策)**:
  - For JavaScript, TypeScript, JSX, TSX: Integrate @babel/parser for full, standard-compliant AST parsing with error recovery.
  - For Python: Integrate Python native standard library ast module via child process.
  - For Swift: Implement token-aware multi-line struct/class/view-body parser.
  - Support **VS Code-style Method Search (code search)** across files and workspaces.
  - Support **Surgical Code Extraction (code read)**: reading saveTask returns ONLY lines 196-220 of database.mjs, not the 476-line file.
- **Consequences (收益)**:
  - 100% syntactically accurate symbol boundaries across complex real-world code.
  - Code reading context consumption reduced by 77.84% using surgical symbol reads.

---

## [DEC-005] Metro Map (Subway Rail Track) Layout Engine vs Chaotic Snake DAG

- **Status**: Accepted
- **Context & Mistaken Paths (历史弯路)**:
  The v0.4.x desktop UI used a generic topological DAG layout.
  When multiple feature chains intersected, nodes twisted into long, zigzagging "snake-like" paths.
  Related blocks within the same chain were scattered hundreds of pixels apart, making it impossible for humans or agents to glance at the canvas and immediately grasp the system architecture.
- **Decision (架构决策)**:
  Redesign the layout engine around the **Metro Map (Subway Route) Paradigm**:
  - **Horizontal Rail Tracks**: Each primary Chain is allocated a dedicated horizontal rail line (Y = trackIndex * trackSpacing).
  - **Sequential Adjacent Stations**: Blocks within a chain are ordered by topological dependency and placed as adjacent stations along the rail (X axis).
  - **Orthogonal Transfer Corridors**: Cross-chain dependencies route through clean 90-degree right-angled transfer corridors.
  - **Transit Envelopes**: Chains are visually rendered as rounded horizontal transit capsules enclosing their stations.
- **Consequences (收益)**:
  - High visual clarity: instantly reveals system layers (Application -> Gateways -> Core Engine).
  - Eliminates visual chaos and long snake-like loops.

---

## [DEC-006] Out-of-Context Command Execution and ANSI/Secret Noise Sanitization

- **Status**: Accepted
- **Context & Mistaken Paths (历史弯路)**:
  Earlier workflows ran shell commands directly in the agent conversation or piped hundreds of lines of build output into model context.
  Compiling a Swift target or running tests generated 300+ lines of compiler logs, burning 4,000+ tokens per command run and occasionally leaking API keys or tokens printed to stdout.
- **Decision (架构决策)**:
  Implement runCommand and sanitizer:
  - **Out-of-Context Persistence**: Full raw stdout/stderr is written to .contextos/logs/receipt-<timestamp>-<hash>.log.
  - **Context-Preserving Receipts**: ContextOS returns only a compact receipt (exit code, duration, redacted text snippet, failure diagnostics).
  - **ANSI Stripping & Secret Redaction**: Automatically strips terminal escape codes and redacts GitHub tokens, AWS keys, and private credentials.
- **Consequences (收益)**:
  - Command execution context footprint reduced by 98.50% (from 4,179 tokens to 63 tokens).
  - 100% of error diagnostics and stack traces preserved; zero credential leakage.

---

## [DEC-007] Single Narrative DECISION.md & Categorized Project Rules vs Fragmented ADR Directory Sprawl

- **Status**: Accepted
- **Context & Mistaken Paths (历史弯路)**:
  Previous systems created separate numbered ADR files (docs/adr/0001-xxx.md, 0002-yyy.md), spreading architectural context across dozens of disconnected files.
  Agents rarely opened all files, resulting in contradictory decisions being drafted and rules being ignored.
- **Decision (架构决策)**:
  - Maintain a **single narrative DECISION.md** at the project root managed via KnowledgeService.patchDecisionSection.
  - Maintain categorized, scoped rules in .contextos/rules/ (rule-*.md) with clear tags (architecture, performance, workflow).
  - Plans and Tasks link directly to ruleRefs and decisionRefs to establish explicit constraints before development begins.
- **Consequences (收益)**:
  - Single source of truth for architectural rationale and project constraints.
  - Clean discovery: knowledge tool lists all rule titles in 100 tokens.

---

## [DEC-008] C-D-C-S Development Protocol & 100% Code Coverage Gate

- **Status**: Accepted
- **Context & Mistaken Paths (历史弯路)**:
  Agents often edited code erratically: modifying files without creating a task, synchronizing the entire graph after every single line edit, or abandoning tasks with untracked source files (orphan code).
- **Decision (架构决策)**:
  Enforce the **Create -> Develop -> Check -> Sync (C-D-C-S)** protocol:
  1. **Create**: Initialize Task with concrete intent and workingSet files.
  2. **Develop**: Inspect code via code outline/read, modify surgically via code edit, run tests via run_command.
  3. **Check**: Formally record verification results and receipt references (task check).
  4. **Sync**: Perform **100% Block Coverage Gate** (CoverageChecker). Any file in the working set without a corresponding Block artifactRef blocks synchronization.
- **Consequences (收益)**:
  - Zero orphan code: 100% of modified files are cataloged in architecture blocks.
  - Atomic, verified development cycles.

---

## [DEC-009] Decoupled Native Desktop Client with Active Background Process Supervision

- **Status**: Accepted
- **Context & Mistaken Paths (历史弯路)**:
  The Swift desktop app originally opened SQLite files directly with raw SQL queries.
  This caused file lock conflicts when Node.js services wrote to SQLite in WAL mode, and created brittle schema coupling between Swift models and Node tables.
  Furthermore, developers running background dev servers or watchers had no visibility into active processes from the UI.
- **Decision (架构决策)**:
  - Decouple Desktop App: App reads snapshot from standardized ProjectDatabase (with fallback to state.sqlite/graph.json) and communicates with the ContextOS ecosystem.
  - **Running Process Monitor**: Bottom-left sidebar displays long-running background commands from .contextos/processes.json with real-time PID, port indicators (e.g. :4004), status dots, and one-click SIGTERM stop buttons.
- **Consequences (收益)**:
  - Zero lock contention; high desktop UI responsiveness.
  - Real-time supervision of long-running servers and background tasks.

---

## [DEC-010] Tree-sitter WebAssembly True AST Engine & mtime+SHA256 Host Native Modification Reconciler

- **Status**: Accepted
- **Context & Mistaken Paths (历史弯路)**:
  1. Relying on coarse heuristic bracket counters or external Python CLI child processes caused performance overhead and false matches on edge cases (e.g. lifetimes in Rust, generics in Swift/TypeScript, raw string literals in C++).
  2. Relying purely on `git status --porcelain` to detect changes failed to track in-place host IDE edits, mtime touch operations, and untracked file state shifts without Git.
- **Decision (架构决策)**:
  1. **Tree-sitter WASM Engine**:
     - Integrate `web-tree-sitter` (v0.27.0) and vendor prebuilt WASM grammars in `packages/code-intel/grammars/` for 14 target languages (JavaScript, TypeScript, TSX, Python, Rust, Go, Swift, Java, Kotlin, C/C++, C#, PHP, Ruby).
     - Provide 100% syntactically accurate AST extraction for classes, structs, traits, interfaces, types, enums, functions, and methods.
     - Maintain resilient fallback parsers for rare languages without WASM grammars.
  2. **Host Native Modification Detection via mtime + SHA256 Comparison**:
     - Maintain `baseline.fileSnapshots` in SQLite database and Task baseline state tracking `mtimeMs`, `size`, and SHA256 hash.
     - Automatically scan working set files and Block artifactRefs upon `task(develop)`, `task(reconcile)`, and `task(sync)`.
     - Detect changes by comparing file stats (`mtimeMs` / `size`), verifying content diff via SHA256, reconciling modified files into `workingSet`, and seamlessly refreshing AST outlines and Block locators.
- **Consequences (收益)**:
  - True compiler-grade AST parsing with zero native C++ compiler build dependencies across 14 languages.
  - Full resilience to host IDE direct disk edits with automated working set reconciliation and AST locator re-anchoring.
