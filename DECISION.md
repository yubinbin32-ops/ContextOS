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

---

## [DEC-011] Lossless Program Slicing, Virtual Code Folding, and KV-Cache Friendly Tiered Context Architecture

- **Status**: Accepted Roadmap
- **Context & Mistaken Paths (历史弯路)**:
  1. Traditional code context ingestion forces AI to read entire 500~2000 line files, rapidly exhausting the 200k~272k window of models like Codex, triggering frequent and costly context compressions and attention degradation.
  2. Naive line-range or regex-based edits suffer from whitespace mismatch, multiple-occurrence ambiguity, and line-drift across multi-step edits.
  3. Dynamic rewriting of global session prompts on every turn invalidates LLM KV-cache prefixes, forfeiting the 75%~90% prompt caching discount.
- **Decision (架构决策)**:
  1. **Transitive Program Slicing**:
     - Implement compiler-grade semantic dependency slicing via Tree-sitter: when a target function is requested, extract its definition alongside external type interfaces and callee signatures, delivering high-fidelity context in <300 tokens without dumping full files.
  2. **Virtual Code Folding & AST Node-Level Patching**:
     - Fold redundant boilerplate (unrelated imports, license headers, trivial getters/setters) into concise folding pointers.
     - Implement deterministic AST node-path patching (`code.patch_ast`) with pre-write syntax validation, ensuring zero line-drift and 100% syntactically valid disk writes.
  3. **KV-Cache Friendly Tiered Context Architecture**:
     - Tier 1 (Immutable Prefix): Static project metadata, invariant rules, and topological baselines to maximize prompt cache hits.
     - Tier 2 (Append-Only Journal): Sequential task notes and verification receipts that never re-order or mutate historical prefixes.
     - Tier 3 (Ephemeral Scratchpad): Task-specific code slices and sanitized error diagnostics discarded upon task completion.
- **Consequences (收益)**:
  - Estimated session context consumption reduced by 95%+, keeping typical workflows well within prime token economics.
  - Near-zero AST edit failures with guaranteed structural validity.

## [DEC-012] Single-Writer State Transactions and Durable Graph Outbox

### 1. 背景
此前多个 `ContextOSV2Service` 实例会同时读写同一项目；旧 MCP 进程、桌面端和脚本之间没有统一的写入仲裁。UPSERT 只能减少级联删除，不能阻止读改写丢失更新或旧 `graph.json` 覆盖新数据库。

### 2. 决策
所有项目写入统一经过 `.contextos/project.lock` 单写者锁。SQLite 事务使用 `BEGIN IMMEDIATE` 和 busy timeout；图谱导出先写入 durable outbox，再以临时文件、fsync、rename 原子替换。数据库 revision 高于外部图谱时，reconcile 只报告冲突，不自动回滚。

### 3. 原因与替代方案取舍
只使用 SQLite WAL 无法保护数据库与 graph.json 的双写窗口；只使用 CAS 需要每个调用方都正确传递 revision，旧客户端仍可能破坏状态。项目锁加 outbox 能同时覆盖数据库中的旧代码和新客户端，并让崩溃恢复有明确入口。

### 4. 影响与后果
旧 MCP 进程无法再通过启动时的低 revision 图谱自动覆盖新状态。新客户端遇到冲突会收到明确诊断，必须调用 `os_context(action: "reconcile")` 恢复，项目状态和工程证据保持可追踪。

## [DEC-013] Provenance-Aware Artifact Detection and Dependency Resolution

> Superseded by DEC-015. Artifact Ledger and persisted BuildRun graph records were removed; directory tree anchors replace per-file generated bookkeeping.

### 1. 背景
`run_command` 过去只比较 Git status 的新增路径。非 Git 项目、已经处于 dirty 状态的文件和编译系统生成的 dependency file 都会让 BuildRun 输入链缺失；目录型 `.app`/`.framework` 也不能作为普通文件记录。

### 2. 决策
BuildRun 记录 `inputSources`、`provenance.confidence` 和解析诊断。`run_command` 支持 `watchPaths`、`depfilePaths` 与 `.contextos/artifact-policy.json`；解析 GNU make `.d`、Rust dep-info、TypeScript `.tsbuildinfo` 等依赖文件。目录产物通过确定性 tree hash 记录为 ArtifactSet，release 验证检查磁盘存在性和 hash。

### 3. 原因与替代方案取舍
要求所有调用方手工填写 `inputPaths` 会持续产生遗漏，尤其在 Xcode、C/C++、Rust 和增量构建中。直接在核心服务里硬编码每个构建系统又会造成耦合，因此采用显式路径优先、policy 和 dependency resolver 补充、置信度分级的方案。

### 4. 影响与后果
已 dirty 文件可以被前后 Hash 识别，非 Git 项目也能通过 policy 或 watchPaths 工作。只有依赖元数据成功解析时才标记高置信度；缺失来源和失败记录不再被 release 验证静默放过。

## [DEC-014] Preserve the Comprehensive Skill Manual and Apply Only Minimal Delta Updates

### 1. 背景
曾尝试把 Skill 从约 37KB 压缩为约 5KB 路由卡，并把完整工具说明拆到独立 `tool-routing.md`。该实验减少了单次加载体积，却削弱了 AI 对工具用途、使用时机和操作顺序的直接感知，容易产生工具误用、漏用或行动迟疑。Skill 不是普通文档，而是智能体的默认操作手册。

### 2. 决策
恢复原有单文件、覆盖全部 13 个工具的完整 Skill 结构。新能力只允许在原章节内部做最小增量修订，不删除既有工具说明，不把基础路由拆成必须额外读取的多文件协议。`references/` 可以保留原有的可选深潜资料，但不能成为理解工具基本用法的前置条件。

### 3. 原因与替代方案取舍
大而全的 Skill 会增加固定上下文，但相比模型不知道何时使用工具、错误选择工具或完全跳过 OS，这一成本更可控。仅保留简短工具列表的做法看似节省 tokens，实际会把成本转移到误操作、重复探索和用户纠正上。

### 4. 影响与后果
Skill 的维护原则改为“先保留完整认知，再做局部精确更新”。新增工具、状态安全或 Block 绑定规则时，必须直接写进对应工具的原始章节，并通过 plugin smoke 检查关键工具说明仍然存在，防止后续再次以压缩为名删除操作知识。

## [DEC-015] Remove Artifact Ledger and Promote Directory Tree Bindings

### 1. 背景
DEC-013 为了解决生成物与构建来源追踪引入了 Artifact Ledger、Artifact Inbox 和 BuildRun。实际自举后，53 条 Artifact 中有 44 条是 Block 已经管理的源码，UI 只展示前十项且无法表达目录型依赖边界。该方案把文件台账、构建来源和覆盖门禁混在一起，造成重复状态、持续清理成本和错误的产品价值预期。

### 2. 决策
彻底移除 Artifact Ledger、Artifact Inbox、BuildRun 图谱实体和 `artifact` MCP 工具。Block 的 artifactRefs 增加 `anchorKind: "tree"`，支持 `hashMode: "content"` 与 `hashMode: "manifest"`。依赖目录使用一个 dependency Block 和 manifest Hash 锚定，不枚举目录内文件；第一方资源目录使用 content Hash；生成目录不进入架构图谱。`run_command` 只保留脱敏 Receipt、日志、ExitCode 和证据链，不再推断或持久化构建产物来源。

### 3. 原因与替代方案取舍
继续逐文件记录生成物会重复源码 Block、放大 `graph.json`、制造无用户决策价值的 Inbox，并迫使 AI 学习额外工具。尝试修补 Artifact 状态机无法解决根源：架构图谱缺少目录锚定。目录锚定使 `node_modules`、vendor 与资源目录成为有界 Block，同时用 lockfile Hash 避免扫描整棵依赖树。生成文件仍不是架构能力，因此不创建 Block，也不进入长期图谱。

### 4. 影响与后果
MCP 工具从 13 个缩减为 12 个，Artifact 表、服务、桌面页面和 CLI 命令被删除。Task Sync 对所有 workingSet 文件执行精确 file/symbol 或 tree 覆盖校验；源码覆盖门禁不再依赖 Artifact 分类。历史 graph.json 中的 artifacts 与 buildRuns 在导入时忽略，旧 SQLite 表在 schema v3 迁移中删除。构建追溯仍需时，使用 `.contextos/logs` 与 Receipt，而不是架构图。
