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
| 2.5.3 动作槽位与改测合一闭环 (DEC-023) | Action Slots [S1]、change 原地原子 verify 与 autoRevert、独立 inspect 深度切片、纯提问自适应节流、精简双安装模式 | 彻底消灭参数行号对齐失误，多轮开发压缩为 2 轮极速闭环，纯提问上下文再降 50% |

当前默认公开入口是单一 `contextos` transport，通过 `action:"explore"`、`"inspect"`、`"work"`、`"change"`、`"verify"`、`"ship"`、`"pipeline"`、`"ops"` 路由；`CONTEXTOS_LEAN_SURFACE=0` 才启用命名工具兼容面。代码事实由真实文件与 AST 锚点维护；SQLite 负责事务状态，`graph.json` 负责 Git 可移植投影；安装方式统一收敛为 macOS 桌面端和一句话发给 AI 自动配置两种方式。

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
1. 新增 `ModuleIndex`：由 AST（`LanguageRegistry.parseStructure`）与目录聚类派生 `mod-*` 导航提示，按 mtime+size 增量缓存于 `.contextos/module-index.json`；`explore` 优先展示这些提示。它们不写入语义 Block，`ship` 也不对无归属文件自动执行 `block.bind_auto`；需要持久化 ownership 时，必须由开发者提供稳定的 curated Block 与 Chain。
2. 治理降级为 advisory：V3 路径不再触发任何覆盖率或证据硬门禁（无绿色回执仍可 `ship`，仅标记 unverified）；`.contextos/profile.json` 的 `strict: true` 为需要强制的团队保留硬门禁。
3. 插件产物改为打包 `v3-server.mjs`，V2 facade 全部经 `ops` 直通保留；SKILL.md 重写为 ≤10KB 的意图级手册；`plugin-smoke` 改为校验 5 工具 + 完整循环 + 脱敏 + ops 可达性。`npm run mcp:v2` 保留 V2 入口作为回滚通道。

### 3. 原因与替代方案取舍
替代方案是继续保留双入口并行（V2 与 V3 同时暴露 17 个工具）：但工具定义本身占上下文，双入口让 AI 重新陷入"该点哪个"的选择负担，与 DEC-016 的目标相悖。完全删除 V2 facade 则会丢失 Plan/Checkpoint/Chain 等仍有用户价值的治理能力，因此改为 `ops` 内层保留、外层收敛。Skill 瘦身上，DEC-014 的"最小增量"条款在入口已反转后不再成立：手册的主要篇幅是在教 12 个 facade 的用法，而这正是被移除的认知负担本身。

### 4. 影响与后果
MCP 工具 12 → 5，入口 SKILL.md 初版压缩到约 6.3KB，后续生命周期与 Micro 约束补齐后稳定在约 7.0KB；单次 `explore` 实测约 3KB（≈750 token）即可命中目标模块与符号。`mod-*` 只作为导航提示，不进入 curated Block/Chain ownership；旧状态中的 legacy module 可用 `block.prune_derived` 清理。代价是架构图谱不会替开发者猜测语义，需持久化 ownership 时必须显式提供稳定的 Block/Chain。

---

## [DEC-018] 真实子对话作为工作流验收

### 1. 背景

静态能力检查和合成分数无法发现 ContextOS 在真实开发中的脏对话、重复调用、Micro 误用、Block/Chain 误绑定和旧 MCP 进程问题。验收必须模拟复杂任务，而不是优化一个可刷分的 runner。

### 2. 决策

采用手动 A/B/C 子对话：A 使用普通 shell/edit/test，B 只使用 ContextOS，C 使用 ContextOS 加 Micro。三组使用同一 fixture、同一测试和 acceptance oracle、独立工作目录，固定五轮：发现、失败记录、证据诊断、修复验证、验收收口。B/C 的主流程优先合并为一次有界 Pipeline 或 work；C 只有在主对话确实需要结果且证据足够重时才启用 Micro。

外部主对话调用、OS 内部 Pipeline 扇出、provider usage 分开记账。宿主真实 token 不可见时只能报告字符/代理指标；缺少相同轮次、相同实现 hash、相同 MCP build 和完整验收时，不发布节省率结论。

### 3. 影响

复杂多轮任务中的错误会以真实失败收口，而不是被静态分数掩盖。验收记录必须包含每轮目的、工具动作、receipt/artifact、测试结果、provider 请求数和最终 Block/Chain 状态。旧 MCP 进程必须标记为无效证据并新开会话。

## [DEC-019] 单一意图入口与能力路由

### 1. 决策

默认 MCP surface 使用 explore、inspect、change、verify、ship、pipeline 和 ops；高级能力通过 ops 路由。Pipeline 负责把多个动作压成一个有界宿主调用，不能把每个 Block、Chain 或 receipt 再拆成主对话轮次。命名 facade 只作为兼容入口，新增流程不得依赖重复工具面。

### 2. 约束

一次请求只选择必要能力：探索用 bounded inspect，修改用原子 change/work，验证复用 receipt，收口用显式 ship architecture。只读结果返回摘要、receipt 或 artifact 引用；完整内容必须显式请求。任何失败都要保留可恢复证据，不能用无上下文的 BLOCKED 或 OK 敷衍。

## [DEC-020] 中文语义图谱与完整所有权刷新

### 1. 背景

旧图谱存在英文标题、重复 artifact locator、已删除脚本、跨职责混用和把 ModuleIndex 当成语义 Block 的问题。这些状态会直接污染 explore 上下文，并让后续 AI 误以为模块提示是真实架构。

### 2. 决策

当前图谱按稳定职责重新编排为中文语义 Block、按业务/运行流程编排 Chain、按跨职责依赖保留 Link。ModuleIndex 的 mod-* 只做导航，永远不能成为 ownership。Block 重新绑定必须使用 replacePaths=true 完整刷新路径集合；否则移动文件和旧脚本会残留。Chain membership 使用 chain.compose，chain.link 只表达关系，不能替代成员关系。

当前仓库已通过 ContextOS ops 完成 31 个 Block、12 条 Chain、32 条 Link 的整理；校验为 valid，重复 locator、已删除路径、mod-* Block、孤立 Block 和悬空成员均为零。验证 Block 只挂载当前可运行的 fixture、smoke、acceptance 脚本，不挂载已删除的合成测试脚本。

### 3. 维护规则

新增代码先选择稳定语义边界，再一次性提交 Block 与 Chain；修复或移动文件先刷新原所有权，再检查 Chain validate；导出 graph.json 只能通过正式同步路径。任何“自动创建 module Block 来填 gap”的实现都视为回归。


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

---

## [DEC-023] Action Slots, In-Situ Verify, First-Class inspect, and Adaptive Query Budgeting

### 1. 背景
尽管 V3 将接口收敛为意图级，但在复杂的跨模块重构与真实开发中暴露了两个新痛点：
1. **参数对齐成本高与行号猜测幻觉**：AI 在调用 `change` 时经常需要反复比对目标文件行号或猜测 verbatim 匹配字串，容易引发参数对齐失败；
2. **多轮改测往返消耗累积上下文**：改代码（change）、开子进程测代码（verify）分别占用独立轮次，加上测试输出和调试往返，一次小任务往往需要 6~9 轮交互，导致宿主编辑器（如 Codex / Cursor）累积 Token 激增；
3. **定位查询场景上下文冗余**：当 AI 仅仅提问“某个符号在哪里、谁在调用它”时，若仍旧返回代码修改槽位与多余代码切片，会白白浪费上下文窗口；
4. **安装方式分散**：此前文档提供三种安装方式（桌面端、一键 AI 指南、手动下载 mjs 纯插件），第三种极客方式需要用户手动配置复杂路径且容易缺乏治理，造成认知分散。

### 2. 决策
1. **动作槽位 (Action Slots [S1], [S2])**：`explore` 在探索阶段自动预切片候选文件并注册动作槽位，AI 可直接通过选择题模式引用 `change({ slot: "S1", append: "..." })` 或按符号改写，零歧义、零参数对齐失误；
2. **改测合一 (In-Situ Verify) 与原子回滚**：`change` 步骤原地接受 `verify` 参数（如 `verify: "npm test"`），在一个动作内原子完成“代码写盘 + 单测运行 + 凭证回执签发”。若单测未通过且开启 `autoRevert: true`，OS 会在毫秒级自动还原磁盘代码，防止中间态脏代码污染仓库；
3. **深度切片专用工具 `inspect`**：对外正式开放为 6 大工具体系（`explore`、`inspect`、`change`、`verify`、`ship`、`ops`），支持按槽位或路径按需提取 AST 语义切片，坚决杜绝整文件倾倒；
4. **纯提问自适应节流 (Adaptive Query Budgeting)**：自动识别纯理解/提问/定位意图（如“在何处实现”、“谁在调用”），智能跳过生成修改槽位与多余代码切片，单次探索上下文字符数直接压减 50%（从 ~2,000 压至 ~1,100 字符）；
5. **轻量实时黑板 (`.contextos/blackboard.md`)**：会话进行中的任务目标、修改文件与测试回执实时落盘黑板，支持跨会话/清屏后通过 `explore` 在 ~150 tokens 内秒级复原上下文；
6. **收敛为双安装模式**：去除手动配置 mjs 的第三种方式，全面推行【方案 A：macOS 桌面端开箱即用】与【方案 B：一句话发给 AI 自动自举配置】两种极简途径。

### 3. 影响与收益
- 极速开发闭环由 6~9 轮往返大幅压缩至 **2 轮实质动作**（explore ➔ change + verify ➔ ship）；
- 彻底消灭了因行号或字符串错位导致的 `Target not unique` 报错；
- 提问场景上下文预算再降 50%，安装引导门槛大幅降低。

---

## [DEC-024] 精选所有权与有界结果生命周期

### 1. 背景

真实开发暴露出两类会抵消 ContextOS 收益的错误：ModuleIndex 导航提示被误当成语义 Block；session、artifact 和 Micro 中间结果把完整数组或 raw trace 带回主对话，造成脏上下文和重复调用。

### 2. 决策

1. mod-* 只做导航，ship 不自动创建或绑定 module Block。持久化架构必须使用开发者选择的 curated Block，并通过 Chain 建立 membership。
2. 默认 MCP 响应只返回有界摘要、receipt 或 artifact 引用。session.history 使用 compact 摘要，session.status 不回传 durable receipt 数组，完整内容必须显式 full=true。
3. Micro 的只读 Pipeline 在同一次 Micro 调用中执行；pipeline、task、provider 结果不重复带回主对话。defer/auto 写入 OS delivery queue，下一次顶层调用只恢复一次；需要返回给主对话时才恢复，否则保留在 OS。
4. Micro 创建或运行时可以直接接收 pipeline，禁止先由主对话探索、再让 Micro 重复探索。默认 evidence route 最多一个 provider request；达到上限时停止，而不是重试制造脏对话。
5. A/B/C 记账分离 external host、internal Pipeline 和 provider usage。只有完整验收、相同轮次、相同实现 hash 和相同 MCP 版本同时成立时，才允许计算对比；字符代理值不能冒充宿主账单 token。
6. micro.batch 与 pipeline.parallel 保持单轮调用但限制并发，任务按原序返回。成功 mutation/verification 后再次附着只读 evidence 默认跳过，只有显式 allowLate=true 才启动事后审计。
7. `task.open` 必须保持纯读取；扫描 working set、刷新 AST locator 和追加 host-change note 只能由显式 `task.reconcile` 或 `reconcile: true` 触发，避免跨轮恢复把紧凑状态查询变成大范围持久化写入。

### 3. 结果

入口 Skill 保持精简，精确 payload 下沉到 capability reference；Block/Chain ownership 不再被派生模块污染；Micro 的输入、provider 请求和交付状态都有可追溯 receipt；内部 Pipeline 扇出不会伪装成主对话轮次。当前单元测试、bundle smoke、真实 MCP、Micro direct Pipeline、图谱校验和手动五轮 A/B/C 已覆盖上述边界。

### 4. 未解决的边界

Micro 不是默认加速器。小任务或证据不足时，provider 输入成本可能超过节省；旧 MCP 进程在新 bundle 安装后仍需新开会话；复杂场景的节省幅度只能通过新的、同调度手动子对话复验确认，不能从单一 fixture 外推到全场景。

## [DEC-025] 跨会话 Receipt 复用必须经过状态指纹校验

### 1. 背景

复杂开发常把验证和最终收口分到不同宿主轮次或不同 ContextOS 会话。若新会话只能看到当前 session，就会重复运行昂贵测试；若无条件读取历史 receipt，又可能把旧代码的通过证据错误地用于当前代码。

### 2. 决策

`ship` 接受显式 `receiptId` 或 `receiptIds`。ContextOS 只从同一 workspace 的历史会话中查找指定 receipt，并同时校验通过状态、命令工作目录和当前 workspace fingerprint；校验失败时阻断收口并明确区分“不存在”和“状态已变更”，绝不静默降级为 advisory。有效 receipt 被导入当前 session，并在正常 ship 摘要中显式报告，避免主对话重复验证或误以为没有证据。

### 3. 后果

跨轮收口可少一次重复 verify，且保留可审计证据；历史凭证不是默认全量注入，必须由调用方显式选择。receipt 仍受历史保留上限约束，缺失时应重新 verify。

### 4. 架构覆盖边界

Block/Chain 覆盖只约束源码、可执行脚本和明确的资源/依赖边界。README、DECISION、Rule、安装说明等已经由 Overview 或 Knowledge 呈现的内容不创建伪 Block；package/config 与派生 bundle 也不参与源码 ownership 门禁。依赖或资源目录使用 `anchorKind: "tree"` 绑定整个目录，避免把稳定边界拆成大量文件级 Block。
