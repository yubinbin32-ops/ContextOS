# OS 产品重构总纲

## 一、产品定义

OS 是面向 Codex 和 AI 开发全生命周期的上下文控制系统。它通过 Skill 和 MCP 降低命令日志、文件阅读、架构理解、项目状态维护和跨对话恢复所产生的上下文占用，同时确保项目目标、代码结构、开发进度和验收结果保持一致。

OS 不是传统项目管理工具，不替代 Git、测试系统或代码编辑器，也不是仅服务于某个对话的临时上下文工具。

## 二、产品结构

OS 在产品层面只有两个顶层对象：`OS Plugin` 和 `Swift 可视化 App`。

```text
OS
├── OS Plugin
│   ├── 功能 1：Run Command
│   ├── 功能 2：File / Code Tools
│   ├── 功能 3：Architecture / Lifecycle
│   └── 公共支撑：Skill、代码智能、SQL/JSON、Git 同步
│
└── Swift 可视化 App
    ├── 展示长期运行任务
    ├── 展示 Plan、Task、Block、Chain、Link 和历史
    ├── 展示架构关系图
    └── 提供关闭任务等控制能力
```

`OS Plugin` 必须可以脱离 Swift App 独立运行。Skill、代码智能和持久化是 Plugin 内部公共支撑，不单独算作产品功能。Plugin 对 AI 提供的并列功能只有三个：

1. `Run Command`：执行命令、压缩输出并管理长期任务。
2. `File / Code Tools`：渐进读取、精确搜索和精确编辑。
3. `Architecture / Lifecycle`：管理 Plan、Task、Block、Chain、Link、Checkpoint、Decision、Rule 和 History。

## 三、功能一：Run Command

Run Command 负责把终端执行从“返回全部日志”改成“默认返回关键信息”，并管理需要长期运行的进程。

- 适合快速状态查询、构建、测试、Lint、格式化、代码生成、数据库迁移、长期服务和交互式进程。
- Skill 必须标明哪些命令适合 Run Command，引导 AI 在后续开发中逐步迁移，而不是继续直接使用普通 Shell。
- 默认返回退出码、耗时、错误、警告、失败测试、关键堆栈、文件名、行号和重要产物路径。
- 默认不向 AI 返回完整 stdout 和 stderr。原始日志保存在上下文之外，需要时再按关键词、行号或时间范围精确展开。
- 长期运行任务需要返回 session、PID、工作目录、运行状态、端口或访问地址。
- Swift App 左侧栏展示长期运行任务，并允许用户关闭。
- 任务关闭后自动清除关联进程、session 和临时日志。
- 关闭前已经确认的重要结果应写入 Task、Block 或 Decision，不能依赖临时日志长期保存。
- 对构建、测试、Lint 等命令，应优先提取失败信息，不返回大量成功日志。
- 对输出文件、报告和构建产物，应返回路径和摘要，而不是把文件内容全部读入上下文。
- Run Command 不支持的命令可以回退到普通终端，但 Skill 必须记录回退场景，后续补齐相应能力。

## 四、功能二：File / Code Tools

File 和 Code Tools 的核心原则是“先获取结构，再读取必要部分”，避免为了修改一小段代码而读取整个文件。

### 读取能力

- 可以单独或组合返回 imports、classes、functions、methods、类型和代码位置。
- 每一项都可以选择是否返回，不要求一次性返回全部结构。
- AI 可以先查看文件架构，再根据结果展开具体类、函数、方法、代码块或行范围。
- 支持 `file-function`、`file-Class.method`、`file-L23-L25`、符号搜索和 Block 搜索。
- 支持通过 Block 直接获取该功能涉及的代码位置和内容。
- 默认不返回完整文件，全文读取只在精确读取无法完成任务时使用。
- 输出优先采用易读文本，例如文件、符号、类型和行号，不默认返回复杂的结构化对象。
- 只有 AI 明确要求 JSON 时，才返回 JSON 格式。

### 编辑能力

- 支持唯一文本精确替换。
- 支持函数、方法、类或代码区间整体替换。
- 支持整段替换和受控的整文件覆盖。
- 整文件覆盖属于高成本操作，必须明确知道影响范围。
- 修改前应使用符号、内容和代码位置共同校验，避免替换到错误位置。
- 通过 MCP 修改代码后，应自动更新对应 Block 的代码锚点和内容。

### 语言覆盖

- AST 需要支持主流开发语言，参考 Cursor 和 Zed 的实际覆盖能力。
- 单一 AST 无法覆盖所有语言，底层应使用 tree-sitter、LSP 和语言解析器适配器。
- 不同语言通过统一接口返回 imports、类型、类、函数、方法和代码范围。
- 无法解析的代码文件应提供尽量准确的文本锚点，但不能把不支持语言永久排除在 Block 体系之外。

## 五、代码与 Block 的对应关系

 AI 在开发过程中新增或修改的所有代码都必须对应到至少一个 Block。

代码包括源代码、测试代码、脚本、数据库迁移、构建逻辑和其他实际代码。文档、Decision、Rule、纯数据文件等非代码内容不强制建立 Block 对应关系。

- 一个文件可以对应多个 Block。
- 一个 Block 可以跨越多个文件。
- 一个 Block 可以包含一个文件、一个类、一个函数、多个方法或一段代码。
- 每个代码单元必须找到自己的功能归属，不能让完整文件天然等同于一个 Block。
- 所有 AI 写入的代码都不能成为没有 Block 归属的孤儿代码。
- Block 包含 Summary、详情、代码位置和修改历史。
- 代码位置由代码智能能力自动获取，不要求 AI 手工维护行号。
- 通过 MCP 修改代码后，Block 的代码位置和内容自动重新匹配，不标记为过期。
- 外部手工修改或 Git 引入的代码变化，应在索引或 Sync 阶段重新匹配。
- 如果发现无法归属的代码，必须要求 AI 补全 Block 关系。
- Block 不允许先创建 ghost 内容再补代码。代码完成后再创建或更新 Block，并写入真实数据。
- Block 不拥有 Checkpoint，也不承担 Plan 的验收职责。

## 六、功能三：Architecture / Lifecycle

新架构必须把“代码功能、执行任务、交付计划、验收节点和关系图”分开建模。旧架构混乱的主要原因是共享节点不规范、Chain 排序缺乏明确语义，以及 AI 需要反复通过 MCP 同步进度。

| 实体 | 定义 |
|---|---|
| `Plan` | 交付计划，包含 `P0/P1...` 阶段、阶段顺序、计划优先级、目标、规则引用和验收节点。Plan 可以不绑定任何现有代码。 |
| `Task` | Plan 中某一阶段的执行载体，表示 AI 当前正在开发哪个阶段。 |
| `Checkpoint` | 只属于 Plan 的验收节点。它可以关联某个阶段，但所有权始终在 Plan。 |
| `Block` | 一个抽象功能单元，包含 Summary、详情、代码片段和修改历史。 |
| `Chain` | 多个 Block 聚合出的更高层抽象功能。 |
| `Link` | Block 和 Chain 之间的有方向、有类型关系。 |
| `Decision` | 项目级关键决策记录，每个项目只有一个文件，采用章节叙事。 |
| `Rule` | 项目规则文件，可以有多个，但必须标明规则类别。 |
| `History` | Block 修改历史、Plan 阶段过程和最终摘要，默认不进入上下文。 |

### Plan

- Plan 必须分阶段，例如 `P0`、`P1`、`P2`。
- `P0/P1` 表示阶段顺序，计划优先级必须作为独立字段，避免概念混淆。
- Plan 可以暂时不绑定 Block、Chain 或现有代码。
- 每份 Plan 必须说明目标、范围、依赖、优先级、验收节点和需要参考的 Rule。
- Checkpoint 放在 Plan 中，只有 Plan 拥有正式验收节点。
- Plan 完成后仍然遵循 Create、Develop、Check、Sync 流程。
- Plan 完成后自动精简，默认只保留总结并放入历史区域，不再展示全部过程。

### Task

- Task 属于 Plan，表示当前开发到了哪个阶段。
- Task 需要包含能够跨对话恢复的开发上下文切片。
- 上下文切片不限制字数，按实际需要提供完整信息。
- 上下文切片应包含目标、约束、规则引用、关键 Decision、当前架构、涉及 Block、工作文件、命令状态、完成事项、风险和下一步。
- Task 进行过程中可以写中间记录，用于同步进度和保留关键发现。
- 中间记录不等于 Checkpoint。
- Task 不要求每写完一次代码就同步一次 OS。
- Task 主要节奏是 Create、Develop、Check、Sync。

### Checkpoint

- Checkpoint 只属于 Plan。
- Checkpoint 表示正式验收节点，而不是普通进度记录。
- Checkpoint 可以关联一个或多个 Plan 阶段。
- Task 可以推动 Checkpoint 完成，但不能独立拥有 Checkpoint。
- 只有通过测试、检查或人工确认后，Checkpoint 才能标记完成。

### Block

- Block 是代码的功能归属，不是文件夹、模块或数据库表的简单映射。
- Block 必须包含摘要、详情、代码位置和修改历史。
- Block 可以引用一个文件、多个文件、类、方法或函数。
- Block 可以与其他 Block 建立 Link。
- Block 不再拥有 Checkpoint。
- Block 不允许提前创建没有代码内容的 ghost 记录。

### Chain 与 Link

- Chain 用于表达多个 Block 聚合形成的抽象功能。
- Chain 不是目录结构，也不只是视觉分组。
- Link 继续保留，并必须具有明确方向和语义类型。
- Link 可以表达依赖、组合、调用、流向、层级和其他真实关系。
- Chain 的排序必须来自明确的 Link 和数据关系，不能依赖随意排序。
- 共享 Block 只能存在一个真实节点，不能为了图布局复制出多个虚假节点。
- 非正常共享节点必须显式处理，而不是隐藏在布局算法中。
- 布局引擎需要基于真实关系重新设计，解决长蛇状、排序混乱和节点过多问题。
- 布局应支持功能聚类、层级、稳定增量更新和共享节点处理。
- 最终目标是关系真实、结构清晰、视觉紧凑，而不是强制把所有节点排在一条线上。

### Decision

- 每个项目只有一个 Decision 文件。
- Decision 采用章节叙事，不再拆成多个零散文件。
- 章节应记录决策内容、原因、影响、替代方案和最终结论。
- Task 和 Plan 可以引用相关章节，按需读取，不默认加载全部内容。

### Rule

- Rule 可以有多份文件。
- 每份 Rule 必须说明类别，例如 API 设计、UI 设计、安全、测试和发布规范。
- AI 在创建 Plan 前只需要了解现有 Rule 的标题、类别和摘要，不要求立即读取全文。
- Plan 必须明确本次开发需要参考哪些 Rule。
- 开发到相关阶段时，再选择性读取对应规则。

### History

- History 保存 Block 修改历史、Plan 阶段进展和最终总结。
- 历史内容默认不注入上下文。
- AI 明确查询历史时，采用阶梯方式展开。
- Plan 完成后，默认只展示压缩后的总结。

## 七、完整开发流程

所有开发统一遵循 `Create → Develop → Check → Sync`。

1. `Create Project Context`：新项目创建初始 Plan；已有项目先读取代码架构、规则和实现，再建立 Plan 与 Block 关系。
2. `Create Plan`：确定阶段、阶段顺序、优先级、目标、依赖、Rule 引用和 Checkpoint。
3. `Create Task`：为当前 Plan 阶段创建 Task，并写入完整的开发上下文切片。
4. `Develop`：AI 正常修改代码，命令优先使用 Run Command，文件先读结构再按需展开。
5. `Record Progress`：需要时写入中间记录，但不需要每次改代码都同步架构。
6. `Check`：执行测试、静态检查、人工确认和必要验证，收集 Checkpoint 所需的证据。
7. `Sync`：验证通过后统一写回 Block、代码历史、Chain、Link、Task、Plan、Decision 和 Rule。
8. `Complete`：Plan 完成全部 Checkpoint 后执行最终 Sync，修正 Chain 关系，并压缩为历史总结。
9. `Continue`：继续下一个 Plan 或下一阶段，并在 Task 中保留足够的跨对话上下文切片。

通过 MCP 写入代码时，Block 映射自动维护；生命周期和语义状态仍然只在 Sync 阶段批量写回。这样既避免孤儿代码，也避免每次编辑都产生一次架构同步。

## 八、上下文的渐进读取

所有读取都必须支持阶梯展开，不能默认返回全部内容。

```text
第一层：标题、名称、数量、摘要
第二层：文件结构、Plan 阶段、Chain 组成、Task 状态
第三层：指定函数、方法、代码范围、Block、Decision 章节
第四层：完整文件、完整日志或完整历史
```

- 默认停在第一层或第二层。
- AI 根据结果明确请求下一层内容。
- File、Block、Chain、Plan、Task、Rule、Decision、History 和命令日志都使用相同原则。
- 写入可以使用简化结构化数据，减少 AI 输出负担。
- 读取默认返回可以直接阅读的文本。
- 只有 AI 明确要求时才返回 JSON。
- Task 上下文切片不限制字数，但应有清晰结构，方便跨对话快速加载。

## 九、SQL、JSON 与 Git

SQL 和 JSON 是同一逻辑数据的两种物化形式，不是两套独立数据。

- 正常写入通过 MCP 进入 SQL。
- SQL 变化后自动生成对应 JSON。
- JSON 不供人工编辑，但由 Git 跟踪。
- Git revert、checkout、reset 或分支切换改变 JSON 后，系统必须把 JSON 变化同步回 SQL。
- JSON 回退时，SQL 也必须精确回退，不能只更新结构而保留旧状态。
- 同步需要 revision、digest 和事务标识，避免 SQL 与 JSON 互相触发形成循环。
- 数据需要关联 repository、worktree 和 branch/ref。
- 切换分支时，SQL 必须切换到对应分支的数据状态，不能混入其他分支记录。
- 应用外部 Git 变化前，需要先完成未结束的 SQL 写入。
- 旧 JSON 只提供导入兼容，不保留旧服务和旧业务逻辑。

## 十、Swift 可视化 App

Swift App 是 Plugin 的可视化控制层，不是 Plugin 的运行前提。

- App 左侧栏展示长期运行任务。
- 左侧栏可以关闭任务。
- 任务关闭后自动清除进程和临时数据。
- 主区域展示 Plan、Task、Block、Chain、Link 和历史。
- 架构图必须使用重新设计的布局引擎。
- App 可以观察和控制 Plugin。
- Plugin 不可依赖 App 才能启动。
- App 不可用时，Run Command、File Tools 和 Architecture 仍然可以通过 MCP 正常使用。

## 十一、Skill 的职责

Skill 是 OS Plugin 的全生命周期操作协议，不只是使用说明。

- 引导 AI 先了解项目和 Rule 索引，再创建 Plan。
- 引导 AI 把 Plan 拆分为阶段并明确 Checkpoint。
- 引导 AI 创建带上下文切片的 Task。
- 引导 AI 优先使用 Run Command，避免长日志进入上下文。
- 引导 AI 先读取代码结构，再按需展开函数和代码范围。
- 引导 AI 把开发过程中写入的所有代码关联到 Block。
- 引导 AI 在 Develop 阶段记录必要进度，但不反复执行完整 OS Sync。
- 引导 AI 在 Check 通过后执行 Sync。
- 引导 AI 在 Plan 完成后精简计划、更新 Chain 并写入 History。
- 引导 AI 选择性地读取 Rule、Decision 和 History，不默认加载全部内容。
- 阻止 AI 回退到全文读取、长日志输出和每次编辑都同步架构的旧行为。

## 十二、文档要求

产品 Markdown 文档必须图文并茂，并同时服务用户理解和 AI 上下文读取。

文档至少需要说明：

- OS 是什么。
- OS 解决什么问题。
- 为什么传统对话和终端开发会膨胀上下文。
- Run Command、File / Code Tools、Architecture / Lifecycle 分别如何工作。
- Plan、Task、Block、Chain、Link、Checkpoint、Decision、Rule 和 History 的关系。
- 新项目如何接入。
- 已有项目如何接入。
- 跨对话如何通过 Task 恢复。
- 如何通过 Git 回退代码和 OS 状态。
- 如何查看并关闭长期任务。
- 插件如何独立运行，以及 Swift App 提供哪些增强能力。

文档必须有实际架构图、流程图、界面截图和操作示例，不能只有概念说明。

## 十三、重构与兼容

- 底层架构全部推翻重写。
- 删除旧服务和旧业务实现。
- 只兼容旧 JSON 文件，用于导入和迁移。
- 旧 JSON 导入后转换为新领域模型。
- 不保证旧服务 API、旧 MCP 行为和旧架构逻辑兼容。
- 没有使用 OS 开发过的项目也可以正常接入。
- 对于已有项目，AI 先读取代码架构、文件和功能关系，再写入初始 Plan 和 Block。
- 当前 OS 项目在新版本可用后也应导入新 OS，并依靠新 OS 完成剩余开发。

## 十四、必须冻结的核心规则

1. OS 只有两个顶层产品对象：OS Plugin 和 Swift 可视化 App。
2. Plugin 对 AI 提供三个并列功能：Run Command、File / Code Tools、Architecture / Lifecycle。
3. Skill、代码智能和 SQL/JSON 是公共支撑，不是额外产品层。
4. Plugin 必须可以独立运行，Swift App 只负责可视化和控制。
5. AI 在开发过程中新增或修改的所有代码都必须关联 Block。
6. 非代码文档、Decision、Rule 和纯数据文件不强制关联 Block。
7. Checkpoint 只属于 Plan，Task 和 Block 都不拥有 Checkpoint。
8. Block 只有在真实代码存在后才能创建，不允许 ghost Block。
9. 通过 MCP 修改代码后，Block 自动匹配并更新，不标记过期。
10. 外部代码变化在索引或 Sync 阶段重新匹配，不能让代码失去 Block 归属。
11. Plan 使用 `P0/P1` 表示阶段时，必须与计划优先级分开。
12. Task 包含跨对话上下文切片和中间记录，但不拥有 Checkpoint。
13. 默认不按每次代码编辑同步架构，只在 Create、Develop、Check、Sync 节奏中写回。
14. 所有读取采用阶梯展开，默认不返回完整日志、完整文件或完整历史。
15. 写入可以使用结构化数据，读取默认返回文本，JSON 只在明确要求时返回。
16. Plan 完成后自动压缩，只把总结放入历史区域。
17. Chain 和 Link 必须表达真实关系，布局引擎从底层处理共享节点和长蛇问题。
18. Decision 只有一个文件，使用章节叙事。
19. Rule 可以有多个文件，但必须标明类别，并在 Plan 中明确引用。
20. SQL 与 JSON 双向同步，JSON 不手工编辑，Git 回退 JSON 时 SQL 同步回退。
21. 旧 JSON 只兼容导入，不保留旧服务和旧架构。