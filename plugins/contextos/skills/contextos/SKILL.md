---
name: contextos
description: MUST be used whenever starting ANY coding task, exploring or understanding codebase architecture, adding features, fixing bugs, refactoring, or reading/editing code (进行代码开发、架构理解、新功能实现或读写代码时必须调用). Activates ContextOS C-D-C-S workflow and AST surgical tools (os_context, code, task, plan) to replace blind file reading.
---

# ContextOS · 智能体上下文操作系统开发指南

> [!CRITICAL]
> **ContextOS 开发准入硬性守则（Mandatory Zero-Tolerance Rules）**：
> 1. **首要动作必须调用 OS（Mandatory First Action & Resumption Anchor）**：每次对话开始、承接新功能、理解项目、排查缺陷或**经历长上下文截断（Compaction）后**，第一步必须调用 `os_context(action: "brief")` 获取系统拓扑、活跃 Plan、Task 切片、已绑定规则清单及顶部专属的 **【ContextOS Resumption Anchor 自愈锚点】**，无缝恢复状态机。
> 2. **显式规则绑定与渐进披露（Progressive Rule Disclosure）**：在创建计划或任务（`plan.create` / `task.create` / `task.bind_rule`）时，根据任务性质**显式绑定关联规约（`rules: ["rule-xxx", ...]`）**。在执行任务时，`os_context(brief)` 与 `task(open)` 会自动按需展示已绑定规则的标题与要点；智能体仅在需要查阅规则深层细节时按需调用 `knowledge(action: "rule_open", ruleId: "...")`，严禁脱离既定规则凭空臆造，亦严禁机械化全量扫表。重点遵循 `rule-ui-aesthetic-precision`、`rule-product-contract`、`rule-command-sessions`、`rule-out-of-context-commands` 与 `rule-surgical-code-editing` 等核心规约。
> 3. **严禁全量盲读（FORBIDDEN Blind Reading）**：在未调用 `os_context(action: "brief")` 建立认知前，严禁直接调用原生 `view_file`、`cat`、`read_file` 遍历或通读业务源码来了解架构。
> 4. **手术刀式读写（Surgical Code Operations）**：必须遵循 `rule-surgical-code-editing`。优先使用 `code(action: "search")` / `code(action: "outline")` 定位结构，再用 `code(action: "read")` 手术刀提取目标方法，禁止倾倒整文件内容进上下文。
> 5. **AST 2-Hop 调用拓扑感知（2-Hop Call Graph Navigation）**：调用 `code(action: "outline")` 时，系统已深度分析 Tree-sitter AST 并自动输出直接被调用者（Callees）拓扑（格式如 `foo() -> calls: [bar, baz]`）。智能体必须基于该调用拓扑梳理上下游调用依赖，禁止盲猜代码流向或倾倒完整函数体。
> 6. **命令出舱脱敏（Out-of-Context Execution）**：必须遵循 `rule-out-of-context-commands` 与 `rule-command-sessions`。所有构建、测试与脚本检查必须通过 `run_command` 执行，守护服务必须通过 `process` 托管，日志出舱存盘，严禁将成百上千行终端原始日志直接倾倒进会话。
> 7. **生命周期与证据闭环（C-D-C-S + Evidence Protocol）**：必须遵循 `os_context(brief)` ➔ `plan/task(create/open with rules: [...])` ➔ `code` ➔ `run_command` ➔ `task(check)` ➔ `task(sync)` 的原子闭环。代码绑定必须优先使用 `block(action: "bind_auto")` 智能挂载；`task(sync)` 会硬门禁校验有效符号与哈希，并要求至少一项由 Receipt 或明确人工证据支撑的通过检查，禁止零检查直接同步。

ContextOS 是面向自主 AI 智能体（Agent）全生命周期的上下文控制与架构治理操作系统。它通过拓扑图谱结构化索引、按需切片展开、编译器级 AST 手术刀读写、脱敏出舱命令沙箱、分类规则库、章节式架构决议以及 C-D-C-S 状态机，保障大规模与复杂项目在长对话周期中的上下文极度精炼与架构一致性。

---

## 任务路径选择（先选轻量或完整，不要机械套流程）

### A. 轻量任务路径（推荐：1~3 个文件、无新架构、无 UI 改动）

```text
os_context(brief)
  -> task(action: "start", taskData: { title, workingSet, rules })
  -> code(outline/read/edit)
  -> task(action: "finish", id, checkData: { command, description }, syncData: { blocks? })
```

- `task.start` 一次完成“创建 Task + 绑定 workingSet/规则 + 激活”；没有 Plan 时会自动创建 `plan-light-*`。
- `task.finish` 一次完成“执行命令 + 记录 Receipt + 记录 check + 覆盖率门禁 + sync”；轻量 Plan 会在全部 Task 完成后自动完成。
- 仍必须提供真实命令、Receipt 和 100% 覆盖率。轻量路径只减少调用步骤，不跳过证据门禁。

### B. 完整架构路径（多模块、新功能、重构、UI、跨系统依赖）

```text
os_context(brief)
  -> plan(create/open)
  -> task(start/create with rules)
  -> code
  -> block(bind_auto) / chain(compose/link)
  -> run_command -> task(check/finish)
  -> task(sync) -> plan(check/complete)
```

- 涉及新架构边界、跨模块契约、UI/UX 或共享数据流时，必须走完整路径。
- `task.sync` 的 100% Block 覆盖门禁不可绕过；覆盖率失败时先绑定 uncovered 文件，再 `task.resume` 重试。

> 无论走哪条路径，第一步都必须是 `os_context(brief)`；任何代码改动都不得跳过真实检查和 Receipt。

## 核心开发节奏：C-D-C-S 闭环（规约优先与全生命周期硬性门禁）

在进行任何真实功能开发、重构或缺陷修复时，**必须强制遵循** **`Create → Develop → Check → Sync`** 的确定性工程闭环，并在各阶段严格贯彻规约检查：

```text
[1. Create]   os_context(brief) ──> task.start 或 plan/task(create/open with rules: [...])
                    │
[2. Develop]  Bound Rules Awareness (按需 rule_open) ──> code(search/outline) ──> code(read) ──> code(edit) ──> task(note)
                    │
[3. Check]    run_command(test/lint) ──> task(check/finish with receiptId)
                    │
[4. Sync]     task(sync with 100% coverage gate) ──> plan(check/complete)
```

1. **Create（创建任务与规则绑定）**：
   - 从 `os_context(brief)` 获悉当前系统概况与活跃拓扑；
   - **【规则绑定与渐进披露】**：在创建或认领任务时，显式指定关联规约（如 `task(create, taskData: { ..., rules: ["rule-surgical-code-editing", "rule-product-contract"] })`）。`os_context(brief)` 与 `task(open)` 自动聚合并呈现已绑定的规则条目。若涉及具体规约细则，仅需精准针对该规则调用 `knowledge(rule_open)`，无需每次盲目全量拉取 `rule_list`；
   - 锚定或创建 Plan，建立具体 Task 并明确 `workingSet`（本任务修改的文件范围）。
2. **Develop（规约遵从与手术刀开发）**：
   - **【规约遵从门禁】**：所有新代码、UI 界面、命令设计必须 100% 贴合绑定的规则契约（通过简报提示按需阅读）；
   - 使用 AST 手术刀：`code(search)` 定位符号 ➔ `code(outline)` 审视结构与 `-> calls: [...]` 2-Hop 调用拓扑 ➔ `code(read, selector)` 精准切片 ➔ `code(edit)` 原位安全替换；
   - 随时调用 `task(note)` 记录关键思考、技术决策与规则对齐记录。
3. **Check（验证沉淀）**：
   - 使用 `run_command` 运行编译、构建与单测，脱敏日志出舱存盘，并返回可写入 `task.check` 的 Receipt；
   - 将生成的精简回执凭据（Receipt ID）写入 `task(check)`。Receipt 必须真实存在且退出码为 0；无法自动化的验证至少填写明确 `evidence`，否则 `task(sync)` 会拒绝执行。
4. **Sync（原子同步）**：
   - 调用 `task(sync)` 触发 **100% 工作区覆盖率门禁**，确保所有改动文件均归属于明确的 Block 站台；
   - 原子更新 Git 与图谱状态，完结 Task 并推进 Plan Checkpoint。

---

## 一、12 大核心 Facade 工具全景与参数规范

ContextOS 收敛为 12 个高内聚 Facade 工具，覆盖 AI 开发全生命周期：

### 1. `os_context` —— 项目全景与上下文切片
- **核心作用**：会话启动引导、实体快速搜索、按需提取上下文切片。
- **关键 Action 与入参**：
  - `action: "brief"`：获取 L0 简报（当前活跃 Plan、进行中 Task、后台常驻服务、核心 Metro 拓扑概览）。
  - `action: "search", query: "关键词"`：跨 Block、Chain、Task 全局搜索实体。
  - `action: "open", entityId: "实体ID"`：获取特定实体的结构化上下文切片。
- **最佳使用时机**：**每次新对话开启或任务切换时的第一步操作**。调用 `brief` 仅消耗几百 tokens 即可完整掌握项目状态，无需遍历全仓库。

### 2. `plan` —— 里程碑与阶段计划管理
- **核心作用**：承载大型工程目标，按有序阶段（Phases）与检查点（Checkpoints）追踪开发全流程。
- **关键 Action 与入参**：
  - `action: "list"`：列出所有计划及其状态（`active`, `draft`, `completed`）。
  - `action: "create", planData: { title, summary, phases: [{ id, name, description, checkpoints: [{ id, title, status }], tasks: [{ title, description, workingSet, rules: ["rule-xxx"] }] }] }`：创建结构化多阶段计划（可直接内嵌定义阶段 Task 及其显式绑定的 rules）。
  - `action: "open", id: "计划ID"`：查看计划完整阶段与检查点进展。
  - `action: "check", id: "计划ID", checkpointId: "检查点ID", passed: true, evidenceRef: "凭据"`：标记检查点完成。
  - `action: "complete", id: "计划ID", planData: { completedSummary: "..." }`：归档完结计划，生成历史摘要。
- **最佳使用时机**：承接复杂需求、重构或版本发布时。通过有序 Checkpoints 确保每一步均有始有终、可验证。

### 3. `task` —— C-D-C-S 任务状态机与覆盖率门禁
- **核心作用**：执行原子开发任务，绑定物理工作集，显式关联规约规则，记录笔记与检查证据，并在最终 Sync 时执行覆盖率门禁。
- **关键 Action 与入参**：
  - `action: "start", taskData: { title, workingSet, rules }`：**【轻量入口，推荐】** 一次完成创建、绑定、激活；未提供 `planId` 时优先复用活跃 Plan，没有活跃 Plan 时自动创建 `plan-light-*`。
  - `action: "create", taskData: { planId, phaseId, title, description, workingSet: ["src/..."], rules: ["rule-surgical-code-editing"] }`：创建任务并显式绑定相关规约规则。
  - `action: "bind_rule", id: "任务ID", ruleId: "rule-xxx"`：为进行中任务追加绑定规约规则。
  - `action: "unbind_rule", id: "任务ID", ruleId: "rule-xxx"`：为任务解绑指定规约规则。
  - `action: "update", id: "任务ID", taskData: { title, description, workingSet, rules }`：更新任务元数据或绑定的规约规则列表。
  - `action: "develop", id: "任务ID"`：将任务切换至激活开发态。
  - `action: "note", id: "任务ID", text: "记录内容", kind: "decision" | "discovery" | "progress"`：在任务流中沉淀重要决策与发现。
  - `action: "probe", id: "任务ID", hypothesis: "假设描述", script: "scratch/probe_script.py", findings: "实验结论"`：**【探针/逆向探索态】**。在算法探索或逆向工程初期沉淀摸索成果，不强加严格 Block 绑定要求。
  - `action: "graduate_probe", id: "任务ID", targetBlockId: "BlockID", files: ["..."]`：**【探针晋级】**。探索验证成功后，一键将探针代码推入正式 workingSet，并自动触发 AST 智能绑定到目标 Block。
  - `action: "check", id: "任务ID", checkData: { receiptId: "...", description: "单元测试通过", passed: true }`：记录命令回执验证；`checkData.command` 可直接执行命令并自动生成 Receipt。
  - `action: "finish", id: "任务ID", checkData: { command: "npm test", description: "测试通过" }, syncData: { blocks: [...] }`：**【轻量收尾，推荐】** 一次完成命令验证、Receipt、check 和 sync；轻量 Plan 会在最后自动完结。
  - `action: "sync", id: "任务ID", syncData: { blocks: [...], chains: [...], links: [...] }`：**原子写回**。workingSet 中每个文件必须由精确 file/symbol 锚点或目录 tree 锚点覆盖；未覆盖文件会阻断同步。依赖目录使用 manifest Hash，不枚举文件。
- **最佳使用时机**：日常功能实现与 bugfix 的主战场。摸索阶段调用 `probe`，开发过程中随时记录 `note`，测试通过后一次性执行 `sync`。

### 4. `code` —— 编译器级真 AST 手术刀读写（14 种主流语言 + 2-Hop 调用拓扑）
- **核心作用**：结构大纲审视、2-Hop Callees 调用图谱感知、精准符号抽取、补丁式安全写入、自动符号重锚。
- **支持语言**：原生编译解析 JavaScript, TypeScript, TSX, Python, Rust, Go, Swift, Java, Kotlin, C/C++, C#, PHP, Ruby。
- **关键 Action 与入参**：
  - `action: "outline", path: "文件路径"`：提取类、接口、函数、方法及**直接调用者列表（`-> calls: [callee1, callee2]`）**，无需通读方法体即可掌握 2-Hop 依赖链路。
  - `action: "search", query: "符号名"`：全局跨文件检索符号签名与位置。
  - `action: "read", path: "文件路径", selector: { symbol: "类名.方法名" }` 或 `{ startLine: 10, endLine: 35 }`：仅提取目标代码片段。
  - `action: "edit", path: "文件路径", targetContent: "原代码", replacementContent: "新代码"`：唯一性文本精准替换，系统自动重新解析 AST 并重锚所有符号。
- **最佳使用心智**：
  - **杜绝全量盲读**：禁止直接读入成百上千行的整个源文件，严禁倾倒无关实现代码；
  - **四步精准工作法**：`code(search)` 定位符号位置 ➔ `code(outline)` 审视类/接口结构与 `-> calls: [...]` 调用拓扑 ➔ `code(read, selector)` 手术刀提取目标方法 ➔ `code(edit)` 局部原位修改；
  - **修改后免重读**：`code(edit)` 执行后，系统底层自动重新解析 AST 并返回新符号哈希和重锚确认。AI **无需再调用 read 二次读取整个文件**，单次修改直接节省 80%+ 上下文。

### 5. `run_command` —— 出舱脱敏命令执行沙箱
- **核心作用**：执行有限生命周期的命令（编译、单次测试、代码扫描、脚本检查）。
- **关键参数**：`command: "npm test"`, `cwd: "可选工作路径"`, `maxChars: 1500`, `timeoutMs: 60000`。
- **运行机制**：
  1. 自动剔除 ANSI 终端着色符与格式控制符；
  2. 自动检测并脱敏 API 密钥、Token 与敏感命令行凭据；
  3. 全量脱敏输出保存至 `.contextos/logs/<timestamp>-<hash>.log`，供持久排查；
  4. 仅向对话上下文返回紧凑的 **Receipt 回执**（包含 ExitCode、耗时、Receipt ID 以及关键错误堆栈诊断）。
  5. 只保存命令 Receipt 与脱敏日志，不把生成文件写入架构图谱；构建产物仍可通过日志和 Receipt 追溯。
- **证据链闭环**：`run_command` 返回的 `receipt.id`（例如 `receipt-178944...`）是客观真实的执行依据。在调用 `task(action: "check")` 时，必须将该 `receiptId` 传入 `checkData.receiptId`，形成不可篡改的工程质量证据链。

### 6. `process` —— 长期常驻后台守护进程管理器
- **核心作用**：托管持续运行的进程（Dev Server、文件 Watcher、持续监听测试、模拟后台服务）。
- **关键 Action 与入参**：
  - `action: "start", command: "npm run dev", id: "可选进程标识"`：在独立进程组中启动守护进程。
  - `action: "list"`：列出所有托管进程的 PID、状态、运行时间与监听端口。
  - `action: "status", id: "进程ID"`：查看特定进程状态与资源开销。
  - `action: "logs", id: "进程ID", lines: 50, grep: "关键词"`：按需过滤调阅进程实时输出日志。
  - `action: "stop", id: "进程ID"`：向整棵进程组发送 `SIGTERM/SIGKILL` 递归终止整棵进程树，彻底释放端口与内存。
  - `action: "clear"`：清除已停止的进程历史记录。
- **自清理准则**：**谁启动，谁负责释放**。在 Task 验证完成或会话结束前，AI **必须主动调用 `process(action: "stop")` 释放服务**，杜绝端口被长期僵死霸占（详见第六章）。

### 7. `block` —— 真实代码能力的物理站台
- **核心作用**：定义和管理系统的基础功能块，绑定物理源文件与关键 AST 符号。
- **关键 Action 与入参**：
  - `action: "list"`：列出所有 Block 及其绑定文件。
  - `action: "open", id: "BlockID"`：查看 Block 职责描述、关联符号与依赖关系。
  - `action: "search", query: "关键词"`：根据职责或代码路径搜索 Block。
  - `action: "bind_auto", id: "BlockID", path: "文件路径", paths: ["..."], symbols: ["..."]`：**【一键智能 AST 自动绑定（强烈推荐）】**。文件会通过 Tree-sitter 抽取顶层符号与 Hash；目录会生成一个 `anchorKind: "tree"` 绑定，不枚举目录内文件。
  - `action: "bind_auto", id: "BlockID", path: "node_modules", hashMode: "manifest", manifest: "package-lock.json"`：依赖目录使用一个 `dependency` Block 和 manifest Hash 表达边界，适用于 node_modules、vendor、Pods 等大目录。
  - `action: "bind", id: "BlockID", blockData: { artifactRefs: [...] }`：手工高级绑定。
- **约束规范**：优先用 `bind_auto`，不要让 Block 长期停留在无物理锚点状态。源码使用 `anchorKind: "symbol"` 并要求 `symbol + hash`；配置文件使用 `anchorKind: "file"`；资源或依赖目录使用 `anchorKind: "tree"`，`hashMode: "content"` 计算目录内容，`hashMode: "manifest"` 只使用 lockfile/manifest Hash。`block.bind` 可以暂时建立待补锚点的 Block，但 `task.sync` 会拒绝未锚定 Block。
- **边界原则**：generated/build/dist 产物不创建 Block，也不进入架构图谱；需要追溯时查看 `run_command` Receipt 与 `.contextos/logs`。

### 8. `chain` —— 地铁主线与正交换乘链接
- **核心作用**：将 Block 串接为清晰的业务轨道，管理系统的数据流向与依赖拓扑。
- **关键 Action 与入参**：
  - `action: "list"`：查看系统所有地铁线（Feature Chains）。
  - `action: "open", id: "ChainID"`：查看整条线路的车站顺序与跨线换乘。
  - `action: "compose", id: "ChainID", chainData: { blocks: [...] }`：编排线路沿途站点。
  - `action: "link", linkData: { from: "...", to: "...", kind: "calls" | "depends_on" | "imports" | "implements" }`：建立跨线连接。
  - `action: "validate"` / `"validate_layout"`：校验孤立 Block、缺失成员、悬空 Link 与地铁拓扑布局。
- **设计哲学**：Chain 是平行的轨道，Link 是带类型的垂直换乘，让整体架构如地铁图般清晰直观。

### 9. `knowledge` —— 项目规则库与单文件架构决议
- **核心作用**：全项目工程规范（Rules）与重大架构决议（Decisions）的治理中心。
- **关键 Action 与入参**：
  - `action: "rule_list"`：列出所有已分类规则的概要与优先级。
  - `action: "rule_open", ruleId: "规则ID"`：读取完整规则规范内容。
  - `action: "rule_write", ruleData: { id, title, category, priority, summary, content }`：新建或更新分类规则。
  - `action: "decision_open", sectionId: "可选DEC-ID"`：调阅 ADR 决策文档或指定章节。
  - `action: "decision_write", sectionId: "DEC-xxx", sectionTitle: "...", content: "..."`：按章节增量追加或修正重大架构决策。
- **最佳使用时机**：形成工程规范时写 Rule；做出技术取舍、重构设计或经历路线弯路教训时写 Decision。

### 10. `contextos_init` —— 模式切换与自举初始化
- **核心作用**：在当前工作区初始化或切换存储模式（本地模式 vs 云端协同模式）。
- **关键入参**：
  - `mode: "local" | "cloud"`（模式选择，默认 `local`）
  - `projectId: "contextos"`（项目名称，默认预设为 `contextos`）
  - `cloudUrl: "https://..."`（云端 Hub URL）
  - `token: "..."`（鉴权 Token）
  - `injectEditors: true`（是否自动同步宿主编辑器配置）
- **核心价值**：用户只做二选一选择，由 AI 在后台直接调用该工具完成项目元数据建立与编辑器注入。

### 11. `contextos_doctor` —— 环境与中枢连接自检
- **核心作用**：全方位诊断当前宿主环境、Node 运行时、存储路由模式、Cloudflare 连通性以及各大已安装编辑器的 MCP 配置状态。
- **使用时机**：配置完毕后进行自检，或在遇到连接异常时快速获取排障诊断报告。

### 12. `contextos_switch` —— 本地与实验性云端切换
- **核心作用**：在当前项目切换本地离线模式与实验性 Cloud Hub 模式，并尝试完成架构快照迁移。
- **关键入参**：`targetMode: "local" | "cloud"`, `cloudUrl?: "..."`, `token?: "..."`。
- **迁移机制**：
  - `local ➔ cloud`：读取本地 SQLite 中的架构快照并推送到兼容的 Cloud Hub，更新 project.json；
  - `cloud ➔ local`：拉取兼容的云端快照写入本地 SQLite，更新 project.json 并回到离线模式。
- **边界**：切换到云端前必须确认 Hub 可达且版本兼容；切换失败时不得改写 `project.json`。本地模式始终可独立离线运行，不应因为全局旧云端配置而尝试联网。
- **实验状态**：Cloud Hub 的多端并发、跨版本快照和远程 CRUD 尚未达到本地模式同等稳定性；不得把云端切换作为本版本的关键依赖。

### 12 工具 Action 契约速查

| Tool | Actions |
| --- | --- |
| `os_context` | `brief`, `search`, `open`, `reconcile` |
| `plan` | `list`, `create`, `open`, `check`, `complete`, `delete` |
| `task` | `create`, `start`, `open`, `note`, `check`, `finish`, `sync`, `resume`, `activate`, `develop`, `bind_rule`, `unbind_rule`, `update`, `probe`, `graduate_probe`, `reconcile` |
| `block` | `list`, `open`, `search`, `bind`, `bind_auto`, `delete` |
| `chain` | `list`, `open`, `compose`, `delete`, `link`, `unlink`, `links`, `validate_layout`, `validate` |
| `code` | `outline`, `read`, `edit`, `search`, `create` |
| `run_command` | 无 action，直接传 `command` |
| `process` | `start`, `list`, `status`, `logs`, `stop`, `clear` |
| `knowledge` | `rule_list`, `rule_open`, `rule_write`, `decision_open`, `decision_write` |
| `contextos_init` | 无 action，直接传 `mode` |
| `contextos_doctor` | 无 action |
| `contextos_switch` | 无 action，直接传 `targetMode` |

---

## 二、项目规则 (Rules) 治理与已固化核心规则库

项目规则是团队与 AI 协作的契约标准。存盘于 `.contextos/rules/<id>.md`，由 Git 统一版本控制，在桌面端侧边栏的“项目规则”中以只读抽屉高亮展示。

### 1. 显式绑定与按需渐进式披露（Progressive Rule Disclosure）
**规约严格，但拒绝机械官僚扫表！**
- **显式绑定**：在 `plan(create)` 或 `task(create)` 阶段，根据任务性质显式绑定关联规约（`rules: ["rule-xxx", ...]`）。亦可在任务执行中随时通过 `task(action: "bind_rule", ruleId: "...")` 动态补充；
- **按需渐进披露**：调用 `os_context(brief)` 或 `task(open)` 时，系统会在简报中自动提取并结构化展示已绑定的规约标题与类别（`## 💡 Bound Rules (按需调阅)`）。AI 无需在每次会话强制执行无意义的 `knowledge(rule_list)` 扫表，直接感知关联规则；
- **精准查阅细则**：当且仅当智能体需要查阅该规则的具体限制、边界条件或详细代码范式时，按需调用 `knowledge(action: "rule_open", ruleId: "...")` 进行单项精读，实现上下文极简与规约严谨的统一。

### 2. 项目已固化核心规则矩阵（Core Rule Matrix）
ContextOS 仓库已内置并严格强制以下核心规则，智能体在相应场景必须无条件遵从：

1. **`rule-ui-aesthetic-precision`**：涉及 ContextOS 原生界面的任务必须读取该规则后执行；UI 细节不在 Skill 内重复展开。
2. **`rule-out-of-context-commands`（命令出舱脱敏与回执凭据治理）**：
   - 严禁倾倒冗长终端日志进对话上下文；单次测试、构建与脚本必须经由 `run_command` 执行；
   - 全量日志出舱持久化存盘至 `.contextos/logs/<timestamp>-<hash>.log`；
   - 上下文仅保留结构化 Receipt 回执（Receipt ID、耗时、ExitCode 与关键故障堆栈），用于填入 `task(check)`。
3. **`rule-command-sessions`（长期守护进程与一次性命令可见可控规约）**：
   - 一次性命令与构建严格经由 `run_command`；持续运行的 Server、Watcher、Worker 必须通过 `process` 托管；
   - 原生 App 界面实时渲染常驻命令 HUD（展示 PID、端口、运行状态及日志入口），支持用户一键终止；在无 UI 的纯插件环境中由 AI 自觉自闭环管理，严禁后台僵尸残留。
4. **`rule-surgical-code-editing`（编译器级 AST 手术刀读写规约）**：
   - 严禁全量通读文件；通过 `code(outline)` 掌握结构与 2-Hop 调用拓扑（Callees）；
   - 通过 `code(read, selector)` 精确提取目标符号，通过 `code(edit)` 原位替换并自动重锚。
5. **`rule-product-contract`（ContextOS 产品契约与架构真理唯一源）**：
   - 项目事实只保存在结构化图（`.contextos/graph.json` / SQLite）中；
   - README 说明产品能力，Skill 说明 AI 的任务路由，两者不得替代图中的结构事实；严禁脱离图谱与代码凭空臆造。
6. **`rule-no-ghost-blocks`（杜绝虚空站台）**：
   - 禁止创建无源码对应的幽灵 Block；每一个 Block 必须在物理磁盘有明确对应的实现文件。
7. **`rule-cdcs-workflow` & `rule-context-reduction`（C-D-C-S 闭环与渐进式降噪）**：
   - 强制遵循 Create ➔ Develop ➔ Check ➔ Sync 状态机；Sync 阶段触发 100% 工作区覆盖率门禁。

### 3. 规则分类标准与自由拓展
ContextOS 对 `category` 保持开放，常见分类如：
- `ui_ux`：界面设计、精密网格、色彩与排版；
- `architecture`：架构分层原则、模块单向依赖、解耦规约；
- `code_style`：编程语言风格、命名约定、注释纪律；
- `testing`：单元测试覆盖标准、mock 策略、冒烟测试；
- `security`：敏感信息脱敏、凭据防护、校验规范；
- `performance`：响应延迟阈值、并发控制、资源释放；
- `workflow`：Git 提交规范、分支管理、发布节奏。

### 4. 写入规则实战代码示例
当建立新的规范时，调用 `knowledge` 工具：

```json
{
  "action": "rule_write",
  "ruleData": {
    "id": "rule-ui-design-principles",
    "title": "白色精密工程语言与 iOS 克制艺术",
    "category": "ui_ux",
    "priority": "high",
    "summary": "定义 ContextOS 原生界面的白色精密工程美学、严谨间距网格与克制动效原则。",
    "content": "### 1. 视觉基调\n- 采用高对比度坚实白底工作台（#FFFFFF / #FBFBFD），0.5pt/1pt 发丝细线（#E5E5EA）；\n- 状态标识遵循语义色点（通行绿 #34C759、冷核蓝 #007AFF、静谧紫 #5856D6、警示橙 #FF9500、故障红 #FF3B30）；\n\n### 2. 字体与间距\n- 统一采用 SF Pro 作为界面排版字体，SF Mono 等宽字体展示哈希、行号与路径；\n- 严格基于 4pt/8pt 几何网格对齐，禁止随意硬编码非标 padding。"
  }
}
```

---

## 三、架构决策 (ADR Decision) 的章节式管理与写入规范

重大架构决议集中收录于单个根文件 `DECISION.md` 中。每一次重大重构、方案选型或**走过技术弯路后的反思纠偏**，都必须通过章节追加或修正。

### 1. 为什么必须沉淀决策？
- 防止后续对话或新会话再次重蹈覆辙（例如：为什么放弃传统长终端日志而采用脱敏回执？为什么放弃正则语法抽取而引入 AST 引擎？）；
- 让接手的 AI 智能体能够明确了解系统“为何演变至此”。

### 2. 决策章节标准四段式结构
每一个 ADR 章节推荐包含以下结构：
1. **背景 (Context)**：遇到了什么痛点或性能瓶颈？
2. **决策 (Decision)**：最终确立了何种方案？
3. **原因与替代方案取舍 (Rationale & Tradeoffs)**：尝试了哪些失败路线？为何放弃其他做法？
4. **影响与后果 (Consequences)**：带来了哪些积极收益与潜在考量？

### 3. 写入决策实战代码示例
调用 `knowledge` 工具执行 `decision_write`：

```json
{
  "action": "decision_write",
  "sectionId": "DEC-011",
  "sectionTitle": "代码大纲引入 2-Hop 调用拓扑与显式任务规则绑定",
  "content": "### 1. 背景\nAST 符号大纲过去仅提供孤立符号与起止行号，缺乏调用流向感知；且规则系统缺乏与任务生命周期的强绑定，导致规则难以被智能体渐进式发现。\n\n### 2. 决策\n在 Tree-sitter AST 大纲提取中引入轻量级直接调用拓扑（2-Hop Call Graph），并在 Task 创建与执行生命周期中建立显式规则绑定。\n\n### 3. 原因与替代方案取舍\n全量提取跨文件全调用图在超大项目中开销过大且容易膨胀；局部 2-Hop 调用链配合任务关联规则在零额外性能负担下达到极佳上下文精准度。\n\n### 4. 影响与后果\n智能体在单次代码大纲调用中即可获悉函数调用流向，并在任务上下文中获得针对性规约指引，彻底消除盲目全量读取。"
}
```

---

## 四、架构抽象与 Block 划分设计指南

### 1. Block 是代码能力的物理站台
- **真实单一职责**：Block 描述系统中的一个独立能力（如“SQLite WAL 存储引擎”、“Metro 路线图画布”、“AST 代码抽取工具”）。
- **适度拆分**：每个 Block 推荐绑定 **1 ~ 3 个高内聚代码文件与关键符号**。避免将包含数十个文件的整个子系统压缩为单一 Block（那本质是 Chain）。
- **杜绝 Ghost Block**：新建 Block 时必须确保磁盘上存在对应的实现文件，并通过 `block.bind` 关联 `artifactRefs`。

### 2. 开放自由的 Block 类型 (`kind`)
ContextOS 对 `kind` 保持开放，支持 AI 根据工程语义自由定义：
- 界面层：`ui`, `view`, `presentation`
- 存储层：`database`, `storage`, `data`, `model`
- 服务与业务层：`service`, `engine`, `worker`, `lifecycle`
- 接口与通信层：`gateway`, `api`, `protocol`, `router`
- 工具与支撑层：`utility`, `infra`, `tooling`

### 3. 架构导航三级递进法则
面对陌生或大型项目时，AI **必须强制遵循**自顶向下的三级导航（严禁直接全量阅读未建立索引的文件）：
1. **宏观查 Chain**：`chain(list)` 查看系统主干业务流；
2. **微观定 Block**：沿线路找到相关 Block，`block(open)` 查看绑定源文件；
3. **手术刀提取**：`code(outline)` 审视函数大纲与 2-Hop 调用关系，`code(read)` 提取目标方法，精准修改。

---

## 五、跨会话开发无缝衔接指引

ContextOS 的数据同时持久化在本地 SQLite 与 Git 追踪的结构化文件（`.contextos/graph.json`、`.contextos/rules/`、`DECISION.md`）中。

1. **新会话启动**：第一句话调用 `os_context(brief)`，瞬间获取上次对话遗留的活跃 Plan、进行中 Task 及核心拓扑；
2. **继续未完成工作**：`task(open, id)` 获取上下文切片与历史 `note`，无缝接续开发；
3. **规则与决策遵循**：从 `os_context(brief)` / `task(open)` 获悉当前 Task 绑定的规约标题，必要时按需调用 `knowledge(rule_open)` 查阅细则，确保新代码符合团队既定规约；
4. **沉淀新知**：技术选型写入 `decision_write`，新规约写入 `rule_write`；
5. **收尾与同步**：运行测试并记录 `task(check)`，执行 `task(sync)` 确保 100% 覆盖率，最终完结 Plan。

---

## 六、长期运行进程 (Process) 托管与自闭环清理指南

在进行包含本地预览服务器、编译器持续监听（Watcher）或测试热重载任务时，AI 可以使用 `process` 工具托管常驻后台进程。**特别强调：对于不打开桌面 App 的纯插件用户，他们没有图形化界面的红色停止按钮，后台服务的生命周期完全依赖 AI 自觉闭环！**

### 1. 启动场景与工具选型原则
- **短暂命令用 `run_command`**：单次测试（`npm test`）、构建（`npm run build`）、代码扫描、git 操作等，一律调用 `run_command`。它出舱脱敏、写入日志并返回精简回执，不常驻后台；
- **长时服务用 `process.start`**：仅当开发过程中需要持续监听文件变动（如 `npm run test:watch`、`tsc --watch`）或启动本地 API/Web 预览服务时，才使用 `process(action: "start", command: "...")`。

### 2. 启动前防冲突探测
在启动新的常驻服务之前，若该服务可能占用固定端口（如 `:3000`、`:8080`）：
1. 先调用 `process(action: "list")` 盘点当前已有的活跃进程；
2. 若发现同类型或可能产生端口冲突的老旧进程，先调用 `process(action: "stop", id: "...")` 释放旧服务；
3. 再调用 `process(action: "start")` 启动新服务，避免抛出 `EADDRINUSE` 端口占用错误。

### 3. Clean-on-Finish 闭环铁律（核心工程纪律）
**“谁启动，谁负责释放”是 AI 智能体最基本的工程素养。**
1. **任务完成即清理**：一旦当前 Task 的验证完成（`task(check)` 通过），或者即将调用 `task(sync)` 提交成果，或者即将结束当前对话前，**AI 必须主动调用 `process(action: "list")` 检查自己启动的临时服务，并逐一调用 `process(action: "stop", id: "...")` 停止！**
2. **整棵进程树彻底拔除**：`process.stop` 会向整棵子进程组发送 `SIGTERM` 与 `SIGKILL`，杜绝任何僵尸进程或孤儿子进程在后台持续消耗系统资源与电量；
3. **清理退出记录**：停止后可调用 `process(action: "clear")` 清除已停止的历史记录，保持工作区干净整洁。

---

## 七、项目初始化与随时双向切换规范

在日常开发中，**遵循最少打扰原则：项目初始化直接默认走本地模式，无需询问用户是否上云；用户明确要求上云时再执行切换。**

### 1. 默认直接初始化本地模式
若当前工作区尚未初始化（`.contextos/project.json` 不存在）：
- **无需询问用户**，AI 直接调用 `contextos_init(mode: "local", projectId: "contextos")` 完成本地初始化；
- 系统在工作区 `.contextos/project.json` 标记 `"storage": "local"` 并建立本地 SQLite；
- 初始化完成后，直接进入 C-D-C-S 正常开发流程。

### 2. 实验性云端切换规范
仅当用户在对话中主动提出切换要求时才执行切换：
- 用户说：“把本项目切换到云端协同模式” ➔ AI 调用 `contextos_switch(targetMode: "cloud")`，推送兼容快照到 Cloud Hub；
- 用户说：“把本项目切回本地模式” ➔ AI 调用 `contextos_switch(targetMode: "local")`，拉取兼容快照并回到本地离线模式。
- Cloud Hub 为实验功能；如果 Hub 不可达、版本不兼容或快照字段缺失，必须明确报告失败并保留本地状态。

---
