---
name: contextos
description: Context operating system for AI coding agents. Governs context lifecycle via C-D-C-S state machines, AST outlines, surgical reads/edits across 10+ languages, out-of-context command receipts, categorized rules, and single-file chapter decisions.
---

# ContextOS · 智能体上下文操作系统开发指南

ContextOS 是面向自主 AI 智能体（Agent）全生命周期的上下文控制与架构治理操作系统。它通过拓扑图谱结构化索引、按需切片展开、编译器级 AST 手术刀读写、脱敏出舱命令沙箱、分类规则库、章节式架构决议以及 C-D-C-S 状态机，保障大规模与复杂项目在长对话周期中的上下文极度精炼与架构一致性。

---

## 核心开发节奏：C-D-C-S 闭环

在进行任何真实功能开发、重构或缺陷修复时，推荐遵循 **`Create → Develop → Check → Sync`** 的确定性工程闭环：

```text
[1. Create]   os_context(brief) ──> plan(open/create) ──> task(create/develop)
                    │
[2. Develop]  code(search/outline) ──> code(read) ──> code(edit) ──> task(note)
                    │
[3. Check]    run_command(test/lint) ──> task(check with receiptId)
                    │
[4. Sync]     task(sync with 100% coverage gate) ──> plan(check/complete)
```

1. **Create（创建任务）**：从 `os_context(brief)` 获悉当前系统概况，锚定或创建 Plan，建立具体 Task 并明确 `workingSet`（本任务修改的文件范围）。
2. **Develop（手术刀开发）**：通过 AST 大纲与局部符号提取进行精准阅读与修改，随时调用 `task(note)` 记录关键思考与中间推理。
3. **Check（验证沉淀）**：使用 `run_command` 运行构建与测试，日志出舱存盘，将生成的精简回执（Receipt ID）写入 `task(check)` 作为验证证据。
4. **Sync（原子同步）**：调用 `task(sync)` 触发 **100% 工作区覆盖率门禁**，确保所有改动文件均归属于明确的 Block 站台，原子更新 Git 与图谱状态。

---

## 一、9 大核心 Facade 工具全景与参数规范

ContextOS 收敛为 9 个高内聚 Facade 工具，覆盖 AI 开发全生命周期：

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
  - `action: "create", planData: { title, summary, phases: [{ id, name, description, checkpoints: [{ id, title, status }] }] }`：创建结构化多阶段计划。
  - `action: "open", id: "计划ID"`：查看计划完整阶段与检查点进展。
  - `action: "check", id: "计划ID", checkpointId: "检查点ID", passed: true, evidenceRef: "凭据"`：标记检查点完成。
  - `action: "complete", id: "计划ID", planData: { completedSummary: "..." }`：归档完结计划，生成历史摘要。
- **最佳使用时机**：承接复杂需求、重构或版本发布时。通过有序 Checkpoints 确保每一步均有始有终、可验证。

### 3. `task` —— C-D-C-S 任务状态机与覆盖率门禁
- **核心作用**：执行原子开发任务，绑定物理工作集，记录笔记与检查证据，并在最终 Sync 时执行覆盖率门禁。
- **关键 Action 与入参**：
  - `action: "create", taskData: { planId, phaseId, title, description, workingSet: ["src/..."] }`：创建任务。
  - `action: "develop", id: "任务ID"`：将任务切换至激活开发态。
  - `action: "note", id: "任务ID", text: "记录内容", kind: "decision" | "discovery" | "progress"`：在任务流中沉淀重要决策与发现。
  - `action: "check", id: "任务ID", checkData: { receiptId: "...", description: "单元测试通过", passed: true }`：记录命令回执验证。
  - `action: "sync", id: "任务ID", syncData: { blocks: [...] }`：**原子写回**。触发 100% 工作区覆盖率校验。
- **最佳使用时机**：日常功能实现与 bugfix 的主战场。开发过程中随时记录 `note`，测试通过后一次性执行 `sync`。

### 4. `code` —— 编译器级真 AST 手术刀读写（10+ 语言）
- **核心作用**：结构大纲审视、精准符号抽取、补丁式安全写入、自动符号重锚。
- **支持语言**：原生支持 JavaScript/TypeScript (JSX/TSX), Python, Swift, Java, Kotlin, C/C++, C#, Go, Rust, PHP, Ruby。
- **关键 Action 与入参**：
  - `action: "outline", path: "文件路径"`：提取类、接口、函数、方法、导入列表与行号范围，不倾倒函数体。
  - `action: "search", query: "符号名"`：全局跨文件检索符号签名与位置。
  - `action: "read", path: "文件路径", selector: { symbol: "类名.方法名" }` 或 `{ startLine: 10, endLine: 35 }`：仅提取目标代码片段。
  - `action: "edit", path: "文件路径", targetContent: "原代码", replacementContent: "新代码"`：唯一性文本精准替换，系统自动重新解析 AST 并重锚所有符号。
- **最佳使用心智**：
  - **杜绝全量盲读**：禁止直接读入成百上千行的整个源文件，严禁倾倒无关实现代码；
  - **四步精准工作法**：`code(search)` 定位符号位置 ➔ `code(outline)` 审视类/接口结构与函数签名 ➔ `code(read, selector)` 手术刀提取目标方法 ➔ `code(edit)` 局部原位修改；
  - **修改后免重读**：`code(edit)` 执行后，系统底层自动重新解析 AST 并返回新符号哈希和重锚确认。AI **无需再调用 read 二次读取整个文件**，单次修改直接节省 80%+ 上下文。

### 5. `run_command` —— 出舱脱敏命令执行沙箱
- **核心作用**：执行有限生命周期的命令（编译、单次测试、代码扫描、脚本检查）。
- **关键参数**：`command: "npm test"`, `cwd: "可选工作路径"`, `maxChars: 1500`, `timeoutMs: 60000`。
- **运行机制**：
  1. 自动剔除 ANSI 终端着色符与格式控制符；
  2. 自动检测并脱敏 API 密钥、Token 与敏感命令行凭据；
  3. 全量原始输出保存至 `.contextos/logs/<timestamp>-<hash>.log`，供持久排查；
  4. 仅向对话上下文返回紧凑的 **Receipt 回执**（包含 ExitCode、耗时、Receipt ID 以及关键错误堆栈诊断）。
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
  - `action: "bind", id: "BlockID", blockData: { artifactRefs: [...] }`：将新增源码文件绑定到 Block。
- **约束规范**：**杜绝虚空 Block（Ghost Block）**。每一个 Block 必须在物理磁盘上存在对应的源码实现。

### 8. `chain` —— 地铁主线与正交换乘链接
- **核心作用**：将 Block 串接为清晰的业务轨道，管理系统的数据流向与依赖拓扑。
- **关键 Action 与入参**：
  - `action: "list"`：查看系统所有地铁线（Feature Chains）。
  - `action: "open", id: "ChainID"`：查看整条线路的车站顺序与跨线换乘。
  - `action: "compose", id: "ChainID", chainData: { blocks: [...] }`：编排线路沿途站点。
  - `action: "link", linkData: { from: "...", to: "...", kind: "calls" | "depends_on" | "imports" | "implements" }`：建立跨线连接。
  - `action: "validate_layout"`：校验地铁拓扑布局，防止出现长蛇乱绕。
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

---

## 二、项目规则 (Rules) 的定义与写入规范

项目规则是团队与 AI 协作的契约标准。存盘于 `.contextos/rules/<id>.md`，由 Git 统一版本控制，在桌面端侧边栏的“项目规则”中以只读抽屉高亮展示。

### 1. 规则分类标准（高自由度，AI 自主决定）
- **分类完全开放**：ContextOS 对 `category` 不做任何硬性枚举约束，AI 可根据工程语义自由定义分类标识，常见参考如：
  - `ui_ux`：界面设计、精密网格、色彩与排版；
  - `architecture`：架构分层原则、模块单向依赖、解耦规约；
  - `code_style`：编程语言风格、命名约定、注释纪律；
  - `testing`：单元测试覆盖标准、mock 策略、冒烟测试；
  - `security`：敏感信息脱敏、凭据防护、校验规范；
  - `performance`：响应延迟阈值、并发控制、资源释放；
  - `workflow`：Git 提交规范、分支管理、发布节奏；
  - 或根据业务自由创建其他任何分类标签（如 `database`, `api`, `infra` 等）。

### 2. 写入规则实战代码示例
当建立新的规范（例如 UI 设计语言规约）时，调用 `knowledge` 工具：

```json
{
  "action": "rule_write",
  "ruleData": {
    "id": "rule-ui-design-principles",
    "title": "白色精密工程语言与 iOS 克制艺术",
    "category": "ui_ux",
    "priority": "high",
    "summary": "定义 ContextOS 桌面端原生界面的黑白灰精密工程美学、严谨间距网格与克制动效原则。",
    "content": "### 1. 视觉基调\n- 采用高对比度精密工程黑白灰调，杜绝高饱和度大面积杂色；\n- 状态标识遵循语义色点（青色 Gateway、蓝色 UI、绿色 Service、橙色 Data）；\n\n### 2. 字体与间距\n- 统一采用系统等宽字体展示哈希、行号与路径；\n- 严格基于 4pt/8pt 几何网格对齐，禁止随意硬编码非标 padding。"
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
  "sectionId": "DEC-010",
  "sectionTitle": "AST 多语言编译器级代码分析引擎设计",
  "content": "### 1. 背景\n随着项目支持语言扩展到 Java、Kotlin、C++、C#、Go、Rust、PHP、Ruby，早期基于粗粒度正则的符号识别容易受到字符串内花括号和多行注释的干扰，导致方法识别错位。\n\n### 2. 决策\n引入带注释与字符串状态感知的嵌套花括号匹配器（Comment- and String-Aware Brace Matcher），并针对不同语言设计专用语义扫描器。\n\n### 3. 原因与替代方案取舍\n- 曾尝试全量引入多语言 Tree-sitter C++ 本地二进制绑定，但在多平台跨机器编译打包时体积膨胀且容易失败；\n- 纯正则方案无法处理深层嵌套类和字符串中包含的花括号；\n- 最终采纳轻量级纯 JavaScript 实现的无依赖状态机，兼顾零环境依赖与精确语法树解析。\n\n### 4. 影响与后果\n10+ 种主流语言全面支持 outline 大纲提取、符号搜索与精确代码块替换，单测覆盖率 100%。"
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
面对陌生或大型项目时，AI 推荐遵循自顶向下的三级导航：
1. **宏观查 Chain**：`chain(list)` 查看系统主干业务流；
2. **微观定 Block**：沿线路找到相关 Block，`block(open)` 查看绑定源文件；
3. **手术刀提取**：`code(outline)` 审视函数大纲，`code(read)` 提取目标方法，精准修改。

---

## 五、跨会话开发无缝衔接指引

ContextOS 的数据同时持久化在本地 SQLite 与 Git 追踪的结构化文件（`.contextos/graph.json`、`.contextos/rules/`、`DECISION.md`）中。

1. **新会话启动**：第一句话调用 `os_context(brief)`，瞬间获取上次对话遗留的活跃 Plan、进行中 Task 及核心拓扑；
2. **继续未完成工作**：`task(open, id)` 获取上下文切片与历史 `note`，无缝接续开发；
3. **沉淀新知**：技术选型写入 `decision_write`，新规约写入 `rule_write`；
4. **收尾与同步**：运行测试并记录 `task(check)`，执行 `task(sync)` 确保 100% 覆盖率，最终完结 Plan。

---

## 六、长期运行进程 (Process) 托管与自闭环清理指南

在进行包含本地预览服务器、编译器持续监听（Watcher）或测试热重载任务时，AI 可以使用 `process` 工具托管常驻后台进程。**特别强调：对于不打开桌面 App 的纯插件用户，他们没有图形化界面的红色停止按钮，后台服务的生命周期完全依赖 AI 自觉闭环！**

### 1. 启动场景与工具选型原则
- **短暂命令用 `run_command`**：单次测试（`npm test`）、构建（`npm run build`）、代码扫描、git 操作等，一律调用 `run_command`。它出舱脱敏、写入日志并返回精简回执，不常驻后台；
- **长时服务用 `process.start`**：仅当开发过程中需要持续监听文件变动（如 `npm run test:watch`、`tsc --watch`）或启动本地 API/Web 预览服务时，才使用 `process(action: "start", command: "...")`。

### 2. 启动前防冲突探测
在启动新的常驻服务之前，若该服务可能占用固定端口（如 `:3000`、`:4004`）：
1. 先调用 `process(action: "list")` 盘点当前已有的活跃进程；
2. 若发现同类型或可能产生端口冲突的老旧进程，先调用 `process(action: "stop", id: "...")` 释放旧服务；
3. 再调用 `process(action: "start")` 启动新服务，避免抛出 `EADDRINUSE` 端口占用错误。

### 3. Clean-on-Finish 闭环铁律（核心工程纪律）
**“谁启动，谁负责释放”是 AI 智能体最基本的工程素养。**
1. **任务完成即清理**：一旦当前 Task 的验证完成（`task(check)` 通过），或者即将调用 `task(sync)` 提交成果，或者即将结束当前对话前，**AI 必须主动调用 `process(action: "list")` 检查自己启动的临时服务，并逐一调用 `process(action: "stop", id: "...")` 停止！**
2. **整棵进程树彻底拔除**：`process.stop` 会向整棵子进程组发送 `SIGTERM` 与 `SIGKILL`，杜绝任何僵尸进程或孤儿子进程在后台持续消耗系统资源与电量；
3. **清理退出记录**：停止后可调用 `process(action: "clear")` 清除已停止的历史记录，保持工作区干净整洁。



