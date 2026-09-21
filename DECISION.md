# ContextOS Architecture Decision Records

This document records ContextOS's architectural history, lessons learned from past wrong paths, and permanent design decisions. Historical entries are retained for traceability; decisions marked as superseded no longer describe the current architecture.

## 架构演进速览

| 阶段 | 主要变化 | 结果 |
| --- | --- | --- |
| 0.4.x 及以前 (DEC-001) | 正则伪 AST、Ghost Block、49 个工具的单一 MCP 面、碎片化 Checkpoint、桌面端直接访问 SQLite | 架构事实不可靠，工具选择和元数据维护吞掉大量 AI 回合 |
| V2 重建 (DEC-001/002/008/009) | 独立 Plugin 与 SwiftUI App 分层、Action Facade、C-D-C-S、真实代码 Block、SQLite + `graph.json` 双物化 | 建立可回滚、可验证的架构事实，但治理流程逐步膨胀 |
| AST 与上下文引擎升级 (DEC-006/010/011) | Tree-sitter WASM 多语言解析、`mtime + SHA256` 外部修改检测、符号级读写、命令出舱 Receipt | 从“整文件倾倒”升级为编译器级切片与证据化执行 |
| Artifact Ledger 试验与回退 (DEC-013/015) | 移除逐文件 Artifact/BuildRun 台账，改用目录树锚点与 manifest/content Hash | 减少重复状态和图谱噪声，保留有界依赖边界 |
| 意图级架构 (DEC-016/017/018/019) | 对外收敛为 `explore/change/verify/ship/ops`，服务端编排器接管流程，模块派生，治理默认 advisory，V2 facade 退出主入口 | AI 只表达意图，不再手工驱动状态机；上下文与调用往返显著下降 |
| 2.5.0 生产加固 (DEC-012/020/021/022) | 项目身份派生、显式 workspace root、原子 changeset、图谱同步自愈、分发/升级验证、Plan/Task 生命周期门禁、Cloud 鉴权 | 从功能可用推进到可发布、可升级、可审计的工程状态 |

当前公开入口固定为 `explore`、`change`、`verify`、`ship`、`ops`。代码事实由真实文件与 AST 锚点维护；SQLite 负责事务状态，`graph.json` 负责 Git 可移植投影；Cloud Hub 仍为实验能力。

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

> 状态：已被 DEC-010（Tree-sitter WebAssembly 引擎）取代，保留作历史。

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

> 状态：已被 DEC-016 / DEC-017 取代。AI 不再驱动 C-D-C-S 状态机，覆盖率门禁在 V3 路径下降为 advisory，保留作历史。

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

> 状态：已被 DEC-017 取代。Skill 已重写为 ≤10KB 的意图级手册，保留作历史。

### 1. 背景
曾尝试把 Skill 从约 37KB 压缩为约 5KB 路由卡，并把完整工具说明拆到独立 `tool-routing.md`。该实验减少了单次加载体积，却削弱了 AI 对工具用途、使用时机和操作顺序的直接感知，容易产生工具误用、漏用或行动迟疑。Skill 不是普通文档，而是智能体的默认操作手册。

### 2. 决策
恢复原有单文件、覆盖全部 13 个工具的完整 Skill 结构。新能力只允许在原章节内部做最小增量修订，不删除既有工具说明，不把基础路由拆成必须额外读取的多文件协议。`references/` 可以保留原有的可选深潜资料，但不能成为理解工具基本用法的前置条件。

### 3. 原因与替代方案取舍
大而全的 Skill 会增加固定上下文，但相比模型不知道何时使用工具、错误选择工具或完全跳过 OS，这一成本更可控。仅保留简短工具列表的做法看似节省 tokens，实际会把成本转移到误操作、重复探索和用户纠正上。

### 4. 影响与后果
Skill 的维护原则改为“先保留完整认知，再做局部精确更新”。新增工具、状态安全或 Block 绑定规则时，必须直接写进对应工具的原始章节，并通过 plugin smoke 检查关键工具说明仍然存在，防止后续再次以压缩为名删除操作知识。

## [DEC-015] Remove Artifact Ledger and Promote Directory Tree Bindings

> 状态：已完成的清理动作（Artifact 体系已移除），保留作历史。

### 1. 背景
DEC-013 为了解决生成物与构建来源追踪引入了 Artifact Ledger、Artifact Inbox 和 BuildRun。实际自举后，53 条 Artifact 中有 44 条是 Block 已经管理的源码，UI 只展示前十项且无法表达目录型依赖边界。该方案把文件台账、构建来源和覆盖门禁混在一起，造成重复状态、持续清理成本和错误的产品价值预期。

### 2. 决策
彻底移除 Artifact Ledger、Artifact Inbox、BuildRun 图谱实体和 `artifact` MCP 工具。Block 的 artifactRefs 增加 `anchorKind: "tree"`，支持 `hashMode: "content"` 与 `hashMode: "manifest"`。依赖目录使用一个 dependency Block 和 manifest Hash 锚定，不枚举目录内文件；第一方资源目录使用 content Hash；生成目录不进入架构图谱。`run_command` 只保留脱敏 Receipt、日志、ExitCode 和证据链，不再推断或持久化构建产物来源。

### 3. 原因与替代方案取舍
继续逐文件记录生成物会重复源码 Block、放大 `graph.json`、制造无用户决策价值的 Inbox，并迫使 AI 学习额外工具。尝试修补 Artifact 状态机无法解决根源：架构图谱缺少目录锚定。目录锚定使 `node_modules`、vendor 与资源目录成为有界 Block，同时用 lockfile Hash 避免扫描整棵依赖树。生成文件仍不是架构能力，因此不创建 Block，也不进入长期图谱。

### 4. 影响与后果
MCP 工具从 13 个缩减为 12 个，Artifact 表、服务、桌面页面和 CLI 命令被删除。Task Sync 对所有 workingSet 文件执行精确 file/symbol 或 tree 覆盖校验；源码覆盖门禁不再依赖 Artifact 分类。历史 graph.json 中的 artifacts 与 buildRuns 在导入时忽略，旧 SQLite 表在 schema v3 迁移中删除。构建追溯仍需时，使用 `.contextos/logs` 与 Receipt，而不是架构图。

---

## [DEC-016] Inversion of Control: Intent-Level Ingress with Server-Side Orchestration

### 1. 背景
V2 收敛出 12 个 facade、57 个 action，并强制 AI 手工驱动 C-D-C-S 状态机与 100% Block 覆盖门禁。随着能力增长，工具面、参数包（`taskData`/`checkData`/`syncData`/`blockData`/`chainData`/`linkData` 全为自由结构）与 Skill 散文同步膨胀：SKILL.md 达 35KB，本仓库自身维护 69 blocks / 20 chains / 109 links。AI 的回合被消耗在"选择工具 + 元数据记账 + 门禁修复舞"上，而不是写代码。诊断结论是：省上下文的只有 AST 切片与日志脱敏，治理层是纯成本。

### 2. 决策
控制反转：AI 只表达意图，OS 在服务端编排内部能力。新增 `packages/orchestrator`（IntentRouter / Pipeline / ContextBudget / Observer / SessionStore / Tracer）与 `packages/mcp/src/v3-server.mjs`，对外只暴露 5 个意图级工具 `explore` / `change` / `verify` / `ship` / `ops`。V2 的 12 个 facade 全部降级为内部能力，通过 `ops({ capability, action, args })` 直通保留。会话状态由 git 与编辑行为派生（SessionStore 只有 open / closed 两态），覆盖率与证据门禁默认降级为 advisory，`.contextos/profile.json` 的 `strict: true` 可恢复硬门禁。

### 3. 原因与替代方案取舍
备选方案一是继续给 V2 打补丁（合并 action、精简 Skill），但工具面与状态机是同一套治理模型的两面，补丁只能缓解调用次数，无法消除"AI 必须知道该点哪个工具"的认知负担。备选方案二是让服务端调用模型做规划，会引入延迟、成本与不可复现性；最终采用确定性路由（关键词 + 结构特征打分）+ 固定流水线，零额外模型调用且可追踪。保留 `ops` 直通是为了不丢失任何既有能力，也让误判有逃生舱。

### 4. 影响与后果
V2 入口与插件产物在 P0 阶段保持不变（plugin smoke 仍校验 12 工具），V3 以 `npm run mcp:v3` 并行启用，由 `npm run v3:smoke` 守卫。服务工厂（`service-factory.mjs`）与三个系统能力（`system-tools.mjs`）从 `v2-server.mjs` 抽出，v2-server 由 671 行降至 295 行且行为不变；顺带修复了 `contextos_switch` 到 cloud 分支中 `dbPath` 未定义导致的崩溃。后续 P1 落地流水线与派生索引、P2 移除手工绑定义务、P3 下线旧 facade 并精简 Skill（届时 DEC-014 的 Skill 保留条款需一并修订）。

---

## [DEC-017] Derived Module Index, Advisory Governance and Retirement of the V2 Facade Surface

### 1. 背景
DEC-016 把入口收敛到 5 个意图级工具后，治理层仍有一处结构性成本：模块必须人工声明（本仓库 69 blocks / 20 chains / 109 links），`task.sync` 的 100% 覆盖率门禁把元数据缺失升级为硬失败，AI 因此要先做图书管理员再做程序员。同时 DEC-014 要求保留 35KB 的综合性 Skill 手册，与"减少 AI 认知负担"的目标直接冲突。

### 2. 决策
1. 新增 `ModuleIndex`：由 AST（`LanguageRegistry.parseStructure`）与目录聚类派生 `mod-*` 模块，按 mtime+size 增量缓存于 `.contextos/module-index.json`；`explore` 优先展示派生模块。`ship` 对被改动且无归属的文件执行 best-effort `block.bind_auto`，把派生模块写回图谱 —— 永不阻塞、永不打断闭环。
2. 治理降级为 advisory：V3 路径不再触发任何覆盖率或证据硬门禁（无绿色回执仍可 `ship`，仅标记 unverified）；`.contextos/profile.json` 的 `strict: true` 为需要强制的团队保留硬门禁。
3. 插件产物改为打包 `v3-server.mjs`，V2 facade 全部经 `ops` 直通保留；SKILL.md 重写为 ≤10KB 的意图级手册；`plugin-smoke` 改为校验 5 工具 + 完整循环 + 脱敏 + ops 可达性。`npm run mcp:v2` 保留 V2 入口作为回滚通道。

### 3. 原因与替代方案取舍
替代方案是继续保留双入口并行（V2 与 V3 同时暴露 17 个工具）：但工具定义本身占上下文，双入口让 AI 重新陷入"该点哪个"的选择负担，与 DEC-016 的目标相悖。完全删除 V2 facade 则会丢失 Plan/Checkpoint/Chain 等仍有用户价值的治理能力，因此改为 `ops` 内层保留、外层收敛。Skill 瘦身上，DEC-014 的"最小增量"条款在入口已反转后不再成立：手册的主要篇幅是在教 12 个 facade 的用法，而这正是被移除的认知负担本身。

### 4. 影响与后果
MCP 工具 12 → 5，SKILL.md 35KB → 约 5.5KB，单次 `explore` 实测约 3KB（≈750 token）即可命中目标模块与符号。派生模块会随首次 `ship` 写入 graph.json（kind: `module`），桌面端可见但不再要求 AI 创建；`no-ghost-blocks` 不变式仍然成立，因为每个派生 Block 都由真实文件与 AST 符号锚定。代价是架构图谱的语义质量从"人工策展"下降为"自动聚类"，需要策展语义时仍可用 `ops` 的 block/chain 覆盖。

---

## [DEC-018] Development-Flow Simulation as the Acceptance Gate

### 1. 背景
前 17 条决策全部以"理论上的上下文节省率"作为验收依据（DEC-011 的双基准、DEC-016 的单次返回体积）。但真正的判据是：AI 能不能用这套接口把一个真实开发任务从头做完。缺少端到端的行为验证，就无法判断精简后的接口是否还能覆盖开发需要。

### 2. 决策
新增 `scripts/dev-flow-sim.mjs` 作为验收门禁，并纳入 `npm run verify`。它用同一份 fixture 跑四个真实开发任务（新增功能并补测试、修 bug、第一版修复失败后迭代到通过、纯理解定位），分别在 V3 意图面与 V2 facade 上各跑一遍，统计调用次数、返回字符数、因门禁触发的修复回合与最终状态是否落库。V3 侧的智能体只提供 intent 与补丁，其余步骤全部取自 OS 返回的 `👉 tool({...})` 机器可读提示。

### 3. 原因与替代方案取舍
替代方案是继续维护 `comprehensive-dev-eval.mjs` 这类按维度打分的静态评测，但它只检查能力是否存在，不检查完成一个任务要付多少代价。模拟真实流程才能同时覆盖"功能不丢失"与"成本是否下降"两个判据。V2 对照实验中特意让智能体只记录通过的 check —— 若照文档如实记录一次失败 check，`task.sync` 会直接拒绝（`Cannot sync task with 1 failed checks`），任务再也无法推进，这本身就是门禁代价的证据。

### 4. 影响与后果
实测（2026-09-20，M1/Node 22）：V3 15 次调用 / 7108 字符 vs V2 48 次调用 / 22666 字符，往返与上下文各降约 69%；V2 因覆盖率门禁产生 6 个修复回合，V3 为 0。四个场景 V3 均完成且状态落库（会话 closed + 绿色回执）。门禁判据固定为：完成、`≤ maxCalls`、零修复回合、调用数与字符数均低于 V2 —— 任一项失败则 `npm run verify` 退出非零。

---

## [DEC-019] Delete the V2 Facade Surface and Its Tooling

### 1. 背景
DEC-017 之后 V2 的 12 个 facade 只剩回滚价值，但它们的存在本身是成本：`tool-contract.mjs` 与 `v2-server.mjs` 需要同步维护，`plugin-smoke` 之外还有一整套 V2 端到端脚本，AI 侧还要在文档里看到两套入口。保留双入口与 DEC-016 的"减少选择负担"目标相悖。

### 2. 决策
删除 `packages/mcp/src/v2-server.mjs`、`server.mjs`、`service.mjs`、`tool-contract.mjs`、`packages/mcp/test/v2-mcp.test.mjs`、`scripts/manual-zero-project-verification.mjs` 与 `scripts/v3-smoke.mjs`；移除 `mcp:v2`、`plugin:build:v2`、`v3:smoke` 三个 npm 脚本与 `dist/contextos-mcp-v2.mjs` 产物。V3 的 MCP 面测试迁入 `packages/mcp/test/v3-mcp.test.mjs`（随 `npm test` 运行），出货产物仍由 `plugin-smoke` 守，验收由 `dev-flow-sim` 守。`dev-flow-sim` 的 V2 对照改为直接驱动 `ContextOSV2Service`（服务层仍在，供 `ops` 与编排器复用），因此 A/B 测量继续有效。

### 3. 原因与替代方案取舍
替代方案是把 V2 冻结为"不再维护但保留"的死代码：省一次删除，却要长期承担文档分叉、契约漂移与新人误用的成本，且 `tool-contract` 的单源真理约束会持续制造维护负担。删除的唯一真实损失是回滚通道 —— 但 V2 协议的问题正是本次重构要消除的对象（覆盖率门禁、失败 check 卡死、状态机记账），回滚到它没有意义；真要回滚可用 git 历史。V2 端到端脚本覆盖的云端切换、chain/link、进程托管等能力仍可通过 `ops` 手工验证，`system-tools.mjs` 未删。

### 4. 影响与后果
`npm test` 由 79 降为 70 项（删 11 项 V2 MCP 测试、增 2 项 V3 MCP 测试），`npm run verify` 链路缩短且全绿。仓库内已无任何代码 import 被删模块；`self-adopt.mjs` 中的文件清单同步更新为 V3 入口。`worker.js` / `apps/cloud` 中的 C-D-C-S 文案属于云端 Hub 侧，本次不动。

---

## [DEC-020] Chinese Graph Re-foundation and Rule / Plan Purge

### 1. 背景
图谱里还留着英文时代的状态：19 个英文 Block（其中 `block-mcp-facades` 还写着 "Consolidated 12 MCP Facades"，与 V3 事实冲突）、3 条粗粒度 Chain、18 条 Link，以及 10 个已完成的 Plan 与 22 个 Task 的历史台账；规则库 8 条里 `rule-cdcs-workflow` 已被意图闭环取代，`rule-out-of-context-commands` 与 `rule-command-sessions` 内容重叠，`rule-product-contract` 与 `rule-no-ghost-blocks` 同属"架构真理"命题。这些陈旧事实会被 `explore` 直接注入上下文，等于让 AI 读到错误的架构。

### 2. 决策
新增 `scripts/manual-rearchitect.mjs`（`npm run rearchitect`，幂等）：先清空历史 Plan/Task 与全部 Block/Chain/Link，再按 V3 的真实代码结构重建 **22 个中文 Block / 7 条 Chain / 21 条跨链 Link**，全部经 `bind_auto` 绑定真实文件与 AST 锚点。规则库由 8 条合并为 6 条并全部改写为中文：`rule-intent-loop`、`rule-out-of-context-execution`（合并两条命令规则）、`rule-surgical-code-editing`、`rule-context-budget`（取代 context-reduction）、`rule-architecture-truth`（合并 product-contract 与 no-ghost-blocks）、`rule-ui-aesthetic-precision`。DECISION.md 对已失效条目（DEC-004/008/014/015）加"状态：已被 X 取代"标记，保留历史但不再具备规范效力。

### 3. 原因与替代方案取舍
替代方案是就地改标题与摘要：成本低，但 Chain 只有 3 条、跨链关系 18 条且新旧混杂，无法表达"意图入口 → 编排内核 → 内部能力 → AST/存储/执行"的真实调用方向，地铁图也会继续呈现一团乱麻。全量重建的风险是丢失人工策展语义，因此重建时按包边界与调用方向重新划分（意图编排 / AST 代码智能 / 状态存储 / 执行 / 渲染布局 / 桌面端 / 分发云端验证），并用带类型的 Link 显式记录 `calls` 与 `depends_on`。历史 Plan 全部 completed/archived，删除不影响任何进行中的工作；Task 随外键级联删除。

### 4. 影响与后果
`graph.json` 重新导出（rev 428+），`explore` 现在会注入中文模块名与中文规则标题，跨语言一致。规则从 8 条降至 6 条，注入候选更聚焦；`rule-architecture-truth` 把"中文命名 Block/Chain"写成硬约束，防止再次漂移回英文。代价：桌面端地铁图的旧收藏与布局坐标失效，需要重新摆放一次。

## [DEC-021] 派生产物分歧自愈与只读动作免门禁

### 1. 背景
图谱重整导出 graph.json（rev 428）后，后续 npm test / plugin:verify / sim 改写了 SQLite（rev 432）却未回写派生产物。reconcileExternalChange 把“磁盘落后于数据库”判定为致命冲突，而 code / block / chain / knowledge / verify 全部走写锁 + 冲突门禁，于是连读一行代码都被拒绝。实测：AI 在 explore 成功后连续两次被挡（ops code outline、verify），被迫退回 cat/rg/sed 整段读取，单次会话上下文涨到 112k。

### 2. 决策
(1) 只读动作（code 的 outline/read/search、block 的 list/open/search、chain 的 list/open/links/validate、knowledge 的 rule_list/rule_open/decision_open）不再经过冲突门禁；(2) 新增 healStateConflict() 与编排器的 _selfHeal()：每次 dispatch 先 reconcile，再按版本方向消解分歧——数据库更新则重导出 graph.json，磁盘更新则导入；(3) verify 接受单个 command 参数，不再静默退化到 profile 默认值。

### 3. 原因与替代方案取舍
也可以在存储层直接把“旧图”改成自动重导出，但那会破坏 storage 层既有测试语义（旧图必须是 conflict，而不是隐式回滚）。放在编排层可以保留原语语义，同时把自愈限定在 AI 路径上。

### 4. 影响与后果
回归测试“stale graph.json 被自愈而不是卡死”加入后共 74 项单测通过；真实仓库实测自愈后 explore 4077 字符、ops outline 3767 字符、verify PASS。代价：graph.json 会被自动重导出覆盖，人工手改 graph.json 的场景应以 SQLite 为准。

## [DEC-022] Cold-start identity and lifecycle truth

Project identity is derived once from the workspace directory. Legacy state created under the bootstrap ID 'contextos' is adopted atomically only when the target project is empty and the repository root matches; conflicting projects are refused rather than merged. Plan completion requires all checkpoints to pass and all linked tasks to be completed. Raw Plan/Task updates may not bypass lifecycle actions. Failed receipts are superseded only by a later successful run of the same normalized command in the same or unknown cwd. The Skill, bundle, and installed plugin cache must be hash-aligned before cold-start acceptance is considered valid.
