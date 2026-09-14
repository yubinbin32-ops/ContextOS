---
name: contextos
description: Context operating system for AI coding agents. Controls context pollution via C-D-C-S lifecycle, AST outline/surgical read/edit, compressed command receipts, and strict Block code coverage.
---

# ContextOS V2 操作指引

ContextOS 是面向 AI 开发者全生命周期的上下文控制运行时与开发操作系统。通过结构化索引、按需展开、手术刀式代码读写、脱离上下文的命令沙箱与 C-D-C-S 生命周期状态机，可显著降低 75%~95% 的上下文 Token 消耗，杜绝模型幻觉与上下文挤压。

---

## 核心开发节奏：C-D-C-S

在进行任何真实功能开发或修复时，推荐遵循 **`Create → Develop → Check → Sync`** 的标准工程闭环：

```text
[1. Create]   os_context(brief) ──> plan(open/create) ──> task(create/develop)
                    │
[2. Develop]  code(search/outline) ──> code(read) ──> code(edit) ──> task(note)
                    │
[3. Check]    run_command(test) ──> task(check with receiptId)
                    │
[4. Sync]     task(sync with 100% coverage gate) ──> plan(complete)
```

---

## 一、工具全景与使用时机 (When & How to Use)

ContextOS 收敛为 9 个高内聚的统一 Facade 工具，覆盖开发全链路：

| 工具名称 | 最佳使用时机 | 核心入参与用法 | 最省上下文建议 |
|---|---|---|---|
| **`os_context`** | 对话开始、任务恢复、快速了解项目全局时 | `action: "brief"` (获取 L0 简报)<br>`action: "search", query: "..."`<br>`action: "open", entityId: "..."` | **最省推荐**：对话首选 `action: "brief"`，仅消耗 ~800 tokens 获取当前 Plan、Task、后台进程与核心架构，无需扫描全项目。 |
| **`plan`** | 规划大型需求、查看里程碑与验收阶段时 | `action: "list"` / `action: "open", id: "..."`<br>`action: "create", planData: { ... }`<br>`action: "check"` / `action: "complete"` | **最省推荐**：Checkpoints 属于 Plan 独占。按 Phase 划分清晰交付目标与验收条件，完结时触发自动压缩归档。 |
| **`task`** | 开启具体功能开发、记录进展与同步架构时 | `action: "create", taskData: { ... }`<br>`action: "develop", id: "..."`<br>`action: "note", id: "...", text: "..."`<br>`action: "check", id: "...", checkData: { ... }`<br>`action: "sync", id: "...", syncData: { ... }` | **最省推荐**：严格遵循 C-D-C-S。开发过程中记录 `note`，测试通过后一次性执行 `sync`，避免每次微小修改都重复同步架构。 |
| **`code`** | 代码检索、结构分析、局部阅读与精确修改时 | `action: "search", query: "..."` (符号检索)<br>`action: "outline", path: "..."` (AST 大纲)<br>`action: "read", path: "...", selector: { symbol: "..." }`<br>`action: "edit", path: "...", targetContent: "...", replacementContent: "..."` | **最省推荐**：**首选“search 定位 → outline 审视 → read 手术刀提取 → edit 精确写入”**。<br>只读写目标函数本身，AST 会自动重锚符号位置，单次函数阅读仅需 ~100 tokens（比全文件省 80%+）。 |
| **`run_command`** | 执行构建、测试、代码检查、脚本运行时 | `command: "npm test"`, `cwd: "..."`<br>`maxChars: 1500`, `timeoutMs: 60000` | **最省推荐**：自动将几百行构建噪声保存到 `.contextos/logs/`，仅向上下文返回精简回执与失败诊断，节省 98% 终端日志上下文。 |
| **`process`** | 启动长期运行的 Dev Server、Watcher、Worker 时 | `action: "start", command: "..."`<br>`action: "list"` / `action: "status"`<br>`action: "logs", id: "...", grep: "..."`<br>`action: "stop", id: "..."` | **最省推荐**：长期任务放后台由守护托管，在桌面端左下角实时监控 PID 和端口，结束时调用 stop 彻底释放进程树。 |
| **`block`** | 架构功能块查询与源码绑定时 | `action: "open", id: "..."`<br>`action: "search", query: "..."` | **最省推荐**：Block 是真实代码能力的抽象，始终确保每个 Block 绑定物理文件与 AST 符号（`artifactRefs`）。 |
| **`chain`** | 查看业务流水线、地铁路线图及依赖关系时 | `action: "list"` / `action: "open", id: "..."`<br>`action: "validate_layout"` | **最省推荐**：每条 Chain 是水平平行的地铁轨道，Block 是沿线站台，跨轨关系使用有类型的 Link 连接。 |
| **`knowledge`** | 查询技术架构决策与项目规则时 | `action: "rule_list"` (规则大纲)<br>`action: "rule_open", id: "..."`<br>`action: "decision_open"` / `action: "decision_write"` | **最省推荐**：先通过 `rule_list` 浏览标题，按需打开相关分类规则；重大技术选型记录在单文件 `DECISION.md`。 |

---

## 二、开发全流程无缝衔接最佳实践 (Seamless Development Workflow)

为了在开发中实现最佳协同与最少上下文占用，推荐按以下 5 个阶段流转：

### 阶段 1：项目上下文初始化与恢复 (Session Bootstrap)
- **推荐做法**：会话伊始调用 `os_context(action: "brief")`。
- **上下文收益**：以 ~800 tokens 获取活跃 Plan、活跃 Task、工作集列表、运行中服务与架构概要，快速进入开发状态。
- *非推荐做法（消耗较大）*：遍历整个仓库目录或直接查看大量历史文件。

### 阶段 2：任务创建与激活 (Task Activation)
- **推荐做法**：
  1. 调用 `task(action: "create", taskData: { planId, phaseId, title, workingSet: [...] })` 创建任务。
  2. 调用 `task(action: "develop", id: "...")` 激活任务进入开发态。
- **上下文收益**：明确本任务所聚焦的工作文件集合（`workingSet`），隔离无关代码的干扰。

### 阶段 3：代码探索、阅读与写入 (Surgical Code Engineering)
- **推荐做法**：
  1. **定位符号**：调用 `code(action: "search", query: "函数名")`，快速获取目标符号的位置与签名。
  2. **结构审视**：调用 `code(action: "outline", path: "...")`，查看文件的 AST 类结构、函数列表与起始行号。
  3. **手术刀式阅读**：调用 `code(action: "read", path: "...", selector: { symbol: "函数名" })`，仅提取目标函数代码片段（例如 20 行，而不是 500 行的整个文件）。
  4. **手术刀式写入**：调用 `code(action: "edit", path: "...", targetContent: "...", replacementContent: "...")`，对目标代码块进行唯一性精确替换。系统会自动重新解析 AST 语法树并完成符号重锚（Re-anchoring）。
  5. **记录思考**：在开发中若有重要技术决议，调用 `task(action: "note", id: "...", text: "...")`。
- **上下文收益**：全流程不加载多余代码体，每次交互控制在数百 tokens 以内。
- *非推荐做法（消耗较大）*：读取整篇长文件后全部重写，既容易引入语法错误，又严重消耗会话上下文。

### 阶段 4：沙箱验证与证据沉淀 (Sandboxed Verification)
- **推荐做法**：
  1. 调用 `run_command(command: "npm test ...")` 运行自动化测试或构建命令。
  2. 系统自动剥离 ANSI 颜色码与冗余编译日志，将全量日志存盘在 `.contextos/logs/`，返回精简回执（Receipt）。
  3. 调用 `task(action: "check", id: "...", checkData: { receiptId: "...", description: "单元测试全部通过", passed: true })` 将验证证据固化到任务中。
- **上下文收益**：几百行的终端构建与测试日志被压缩为数十 tokens 的精简摘要，若有报错自动提取关键堆栈，零信息损失。

### 阶段 5：架构写回与里程碑达成 (Sync & Plan Completion)
- **推荐做法**：
  1. 调用 `task(action: "sync", id: "...", syncData: { blocks: [...] })` 完成最终架构同步。
  2. **100% 覆盖率门禁**：系统内置 `CoverageChecker` 会自动校验本次任务修改的所有代码文件。确保每个修改文件都归属于对应 Block 的 `artifactRefs`，自动防止孤儿代码产生。
  3. 同步成功后，SQLite 与 Git 追踪的 `graph.json` 完成原子写回。
  4. 当 Plan 的各个阶段与 Checkpoint 全部达成后，调用 `plan(action: "complete", id: "...")` 将计划压缩归档为历史摘要。
- **上下文收益**：集中原子同步，保证项目代码与架构模型实时 1:1 精确映射，跨会话无需二次重新扫描。

---

## 三、上下文节省对比总结 (Token Economy)

| 开发环节 | 传统开发交互（非推荐，消耗大） | ContextOS 渐进式开发（推荐最佳实践） | 平均节约比例 |
|---|---|---|---|
| **会话启动** | 扫描整个项目或读取全量状态 (~9,400 tokens) | `os_context brief` (~800 tokens) | **节约 91.5%** |
| **代码定位与查阅** | 盲读整个 500 行源码文件 (~1,800 tokens) | `code outline` + `code read` 目标函数 (~180 tokens) | **节约 90.0%** |
| **代码修改与同步** | 全文覆写 + 每次改动全量推流 (~3,000 tokens) | `code edit` 手术刀补丁 + 自动重锚 (~150 tokens) | **节约 95.0%** |
| **命令运行与测试** | 原始 300 行编译器/测试日志进入对话 (~4,200 tokens) | `run_command` 脱敏回执 + 关键诊断 (~60 tokens) | **节约 98.5%** |
| **一次标准任务全周期** | 累计消耗 ~25,000 tokens | 累计消耗 ~2,600 tokens | **总体节约 89.6%** |

---

## 四、架构抽象与 Block 划分设计指南 (Block Design & AI Navigation)

### 1. Block 是抽象功能的单一职责单元
- **抽象功能定义**：Block 是代码能力的抽象封装，代表系统中的一个独立能力站台（例如“Metro 地铁画布”、“SQLite WAL 引擎”、“代码 AST 抽取工具”）。
- **合理拆分，拒绝臃肿**：避免把整条功能链路或包含十几个文件的子包压入单一 Block。若一个 Block 包含了整个模块所有文件，其实质已经变成了 Chain，不仅使图谱失去拓扑意义，还会导致 AI 调阅 Block 时产生大量冗余 Outline。
- **推荐粒度**：每个 Block 推荐绑定 **1 ~ 3 个高内聚的代码文件与关键符号**。保持 Block 职责精炼，AI 即可一眼识别该模块的作用并实现精准导航。

### 2. 开放灵活的 Block 类型 (`kind`)
- ContextOS 对 Block 的 `kind` 保持完全自由开放，不设僵硬限制，AI 可根据语义自由写入：
  - 常见界面类：`ui`, `view`, `presentation`
  - 常见数据与存储类：`database`, `data`, `storage`, `model`
  - 常见服务与逻辑类：`service`, `engine`, `worker`, `lifecycle`
  - 常见网关与通信类：`gateway`, `api`, `protocol`, `router`
- 准确的 `kind` 将使桌面端 Metro 画布呈现出清晰的颜色区分（蓝色 UI、绿色 Service、橙色 Data/Database、青色 Gateway/API）与多维视图透镜。

### 3. AI 架构导航三级流转法则
在开发与定位代码时，AI 推荐遵循自顶向下的三级导航，杜绝盲目倾倒代码：
1. **第一级：宏观查 Chain** —— 通过 `chain(action: "list")` 理解系统主干地铁线（如业务流水线、内核引擎线、网关调度线）；
2. **第二级：微观定 Block** —— 沿线找到具体负责该能力的 Block 站台，通过 `block(action: "open", id: "...")` 获悉其责任范围与关联源码；
3. **第三级：手术刀级提取** —— 通过 `code(action: "search")` 与 `code(action: "read")` 精准提取目标函数体，只把必要的几十行代码装入当前上下文。

