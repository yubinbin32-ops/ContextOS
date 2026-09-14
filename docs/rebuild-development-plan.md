# ContextOS 重构开发文档

> 基线：`main@248cc82`、`contextos@0.4.1`
> 设计依据：`docs/rebuild.md`
> 状态：尚未开始 V2 开发

## 1. 文档定位

这不是 V2 详细设计说明书，而是开发者开始重构前的工作文档。

它说明：

1. 当前代码实际是什么状态。
2. 哪些问题不能继续沿用。
3. 哪些代码可以复用。
4. V2 要形成什么基本结构。
5. 按什么顺序重构，每一步达到什么条件才继续。

详细产品目标以 `docs/rebuild.md` 为准。

## 2. 当前状态

### 2.1 结论

- 当前项目仍是 0.4.1 旧架构，没有开始 rebuild。
- `codex/os-v2-implementation` 分支目前只增加了一份 `docs/os-v2-refactor-blueprint.md`，没有 V2 代码。
- 当前 90 个 Node 测试全部通过，Swift App 可以构建。这只能证明旧版本自身可运行，不能证明符合 rebuild 目标。
- 工作区中的 `.contextos/graph.json` 已写入一些 V2 规划内容，但对应代码并不存在，不能把它当成 V2 已实现的证据。

### 2.2 代码组成

| 模块 | 当前职责 | 重构判断 |
|---|---|---|
| `packages/mcp/src/server.mjs` | 49 个 MCP 工具入口 | 删除旧接口，重做少量 facade |
| `packages/mcp/src/service.mjs` | 服务门面、上下文、命令、源码同步 | 可参考流程，业务实现基本重写 |
| `packages/mcp/src/database.mjs` | SQLite schema、SQL/JSON 同步 | 只保留原子写和 outbox 思路 |
| `packages/mcp/src/ast.mjs` | 正则式“AST” | 淘汰，改用 tree-sitter |
| `packages/mcp/src/mutation-engine.mjs` | Block、Plan、Checkpoint、Chain 写入 | 旧领域模型淘汰 |
| `packages/mcp/src/context-engine.mjs` | 按任务检索上下文 | 可复用检索思路 |
| `packages/mcp/src/sanitizer.mjs` | 日志清洗、脱敏 | 可以复用 |
| `apps/desktop` | 直接读取 SQLite 的 SwiftUI App | 保留视觉资产，数据层重做 |
| `plugins/contextos` | Skill、插件配置和打包入口 | 重做协议、Skill 和安装方式 |

### 2.3 当前主要问题

#### 1. AST 不是真正 AST

`packages/mcp/src/ast.mjs` 主要按行使用正则匹配，并通过数花括号寻找结束位置。它不能可靠处理注释、字符串、嵌套类型、重载、多行签名和多种语言。

后果：

- 符号读取和整段替换会误判。
- 修改代码后不能可靠更新 Block 的代码位置。
- 不能作为 V2 Code Tools 的基础。

#### 2. Block 允许没有真实代码

当前支持 `proposed`、`planned` 等 ghost/blueprint Block，并认为完整文件可以对应 Block。MCP 也没有正式的精确代码编辑工具来自动维护代码归属。

后果：

- Block 可以长期只是规划项。
- 代码可以没有 Block。
- 无法满足“真实代码功能归属”的核心要求。

#### 3. Checkpoint 归属错误

当前 Checkpoint 可以属于 Block、Chain、Link 或 Plan，并且 `block_seal`、`foundation_plan_create` 会继续强化旧语义。

目标：

- Checkpoint 只属于 Plan。
- Task 的验证记录叫 Check，不是 Checkpoint。
- Block 不负责正式验收。

这是数据模型冲突，不能只改工具说明。

#### 4. Task 只是临时任务会话

当前 `task_sessions` 只保存 intent、scope 和状态，没有：

- Plan Phase 归属。
- 完整 context slice。
- Journal、Check、Sync 分区。
- `Create -> Develop -> Check -> Sync` 状态机。

它不能直接成为 V2 Task。

#### 5. Run Command 无法管理长期任务

当前 `run_command` 使用同步阻塞执行，最长 120 秒，没有 session、PID、进程组、端口、日志文件或停止接口。原始日志也不会被完整保存用于后续展开。

因此 dev server、watch、worker 等任务无法可靠使用。

#### 6. SQL、JSON、Git 不是同一份逻辑数据

当前 `graph.json` 只导出部分表，Task、Command Receipt、Source Index 和同步问题不在其中。同步依赖 revision、mtime 和启发式判断，也没有 branch/worktree 隔离。

后果：

- Git 回退 graph 后，Task 和运行证据可能对不上。
- 切换分支或 worktree 可能混入其他状态。
- 无法保证 JSON 回退时 SQLite 精确回退。

#### 7. MCP 工具和 Skill 在训练旧行为

当前暴露 49 个工具，存在多套重叠写入口。Skill 还要求先创建 Block 再开发，并在开发过程中频繁执行 reconciliation、Checkpoint 和 finish。

这与 rebuild 要求相反：

- 代码完成后才创建 Block。
- 开发中只做必要记录。
- 验证通过后统一 Sync。

#### 8. Decision、Rule 和 History 不符合目标

- Decision 当前是多个数据库记录，不是单文件章节。
- Rule 当前借助 Block/Background scope 表达，不是分类 Rule 文件。
- History 与通用 ChangeSet 混用，Plan 完成后不会压缩为总结。

#### 9. App 依赖数据库实现

Swift App 直接只读 SQLite，没有统一 daemon，也没有长期进程控制。

目标：

- Plugin、daemon、CLI 可以脱离 App 独立运行。
- App 只连接 daemon。
- App 关闭后长期进程继续运行。

#### 10. 安装依赖系统 Node

当前插件配置直接执行 `node`。目标发布包必须携带固定版本 Node，并保证无需用户预先安装 Node。

## 3. 复用边界

### 可以保留

1. 日志 ANSI 清洗、进度压缩和敏感信息脱敏。
2. Markdown heading 解析、章节读取和 revision 校验思路。
3. CJK 分词和字段加权的上下文检索思路。
4. 外部源码修改检测、符号移动和 ambiguity 报告思路。
5. Swift 的 Theme、Knowledge Reader、Selection 和基础 Inspector。
6. 日志脱敏、同名符号、数据库被 Git 替换等测试夹具。
7. `graph.json` 原子写入、冲突拒绝和崩溃恢复的基本思路。

### 不保留

1. 49 个旧 MCP 工具及其输入输出协议。
2. ghost Block、`block_seal` 和通用 target Checkpoint。
3. PlanChange、ChainScope、TaskSession 作为 V2 核心实体。
4. 正则 AST 作为符号身份和编辑边界。
5. Swift App 直接读取 SQLite 的数据层。
6. 每次编辑后同步架构的工作流。

## 4. 目标结构

### 4.1 产品层

```text
ContextOS
├── Plugin
│   ├── Run Command
│   ├── File / Code Tools
│   └── Architecture / Lifecycle
└── Swift App
    ├── Plan / Task / Process
    ├── Architecture
    └── Knowledge
```

Plugin 必须独立运行。Swift App 只是控制和展示层。

### 4.2 运行结构

```text
MCP / CLI / Swift App
          |
        daemon
          |
  Domain / Code Intel / Process / Storage
          |
   Git / Files / SQLite / graph.json
```

建议 daemon 成为唯一写入口，避免 MCP、CLI 和 App 各自实现一套业务逻辑。

### 4.3 核心对象

```text
Plan
├── Phase
├── Checkpoint
└── Task
    ├── Context Slice
    ├── Journal
    ├── Check
    └── Sync Result

Block
├── ArtifactRef
└── History

Chain
├── Block / Child Chain
└── typed Link

Rule
Decision
History
Command Receipt / Command Session
```

关系约束：

- Plan 是验收和 Checkpoint 的唯一所有者。
- Task 属于 Plan Phase，是跨对话恢复入口。
- Block 必须对应真实代码，不能提前创建。
- Chain 的语义来自 Link，不来自任意 position。
- Decision 只有一个文件。
- Rule 可以有多个文件，但必须有 category 和 summary。
- History 默认不进入上下文。

### 4.4 MCP 入口

V2 不保留 49 个窄工具，收敛为 action-based facade：

```text
os_context   brief / search / open / reconcile
plan         list / create / open / update / check / complete
task         create / open / note / check / sync / resume
block        search / open / bind / history
chain        list / open / compose / link / validate
code         outline / search / read / edit
run_command  单次命令
process      list / status / logs / input / stop / clear
knowledge    rule_list / rule_open / rule_write / decision_open / decision_write
```

读取默认返回 Markdown，并按 L0-L3 逐层展开。只有明确请求时才返回完整代码、完整日志、完整历史或 JSON。

## 5. 重构流程

### P0：冻结规格

完成：

- 确定 V2 状态机和实体边界。
- 确定 MCP facade 和错误码。
- 确定 `Create -> Develop -> Check -> Sync` 流程。
- 确定 coverage、revision 和 SQL/JSON 同步规则。
- 准备旧数据 fixture。

退出条件：

- 开发者能明确判断一条数据应该属于 Plan、Task、Block、Rule、Decision 还是 History。
- 所有旧模型都能说明迁移去向。

### P1：建立 Runtime 和 Storage

完成：

- daemon 和 IPC。
- SQLite schema 和 migration。
- `graph.json` exporter/importer/watcher。
- outbox、digest、单写者和崩溃恢复。
- repository/worktree/branch/ref 隔离。

退出条件：

- Plugin 在没有 App 时可以运行。
- SQL 写入能生成稳定 JSON。
- Git 回退 JSON 后 SQLite 能精确回退。
- 分支和 worktree 数据不会混用。

### P2：实现 Code Tools

完成：

- tree-sitter language registry。
- `outline`、`search`、`read`、`edit`。
- stable symbol identity、hash 和 ambiguity。
- 编辑后自动重锚。
- WorkingSet、coverage gap 和 Block 映射。

退出条件：

- 默认不读取整文件。
- 能先看 outline，再读取指定符号或行范围。
- 修改后 locator 自动更新。
- 新代码不会先产生 ghost Block。
- 不支持的语言会明确降级，不伪装成功。

### P3：实现 Run Command 和 Process Host

完成：

- 单次命令 receipt。
- 长期 session、PID/进程组、日志文件。
- readiness、端口和 URL 识别。
- logs、input、stop、clear。
- TERM 后 KILL 的进程树清理。

退出条件：

- 构建和测试日志不直接进入上下文。
- dev server 能立即返回 session。
- App 可以查看并停止长期任务。
- daemon 重启后状态可以恢复或明确标记 lost。

### P4：实现 Lifecycle 和 Graph

完成：

- Plan、Phase、Plan Checkpoint。
- Task、Journal、Check、Sync。
- Block、ArtifactRef、Chain、Link。
- coverage gate。
- History 压缩。

退出条件：

- 可以完成一次无 ghost 的新项目开发。
- 可以完成一次已有项目 adopt。
- 未通过 Check 和 coverage 时不能完成 Sync。
- Task Check 不会被当成 Plan Checkpoint。
- Plan 完成后只保留总结、风险和引用。

### P5：实现 Context 和 Skill

完成：

- L0-L3 Markdown renderer。
- 显式 JSON 模式。
- Rule 索引和 Decision 单文件。
- 全周期 Skill。

退出条件：

- 新对话可以通过 `os_context brief -> task resume` 恢复。
- AI 不再默认读全文或返回长日志。
- AI 只在 Sync 阶段批量写回架构。
- ContextOS 可以被 V2 自己接管开发。

### P6：改造 Swift App

完成：

- App 只连接 daemon。
- 左侧 Plans、Tasks、Processes。
- Architecture、Task Workspace、Knowledge。
- Process stop/clear 和日志入口。
- 基于真实关系的稳定布局。

退出条件：

- App 关闭后 Plugin 和进程继续运行。
- 长功能不再渲染成单条长蛇。
- 相同 graph snapshot 得到稳定布局。

### P7：迁移、打包和发布

完成：

- 旧 JSON dry-run 和导入。
- 内置 Node runtime。
- 安装、升级、回滚和版本检查。
- E2E、性能和故障恢复测试。
- README、架构图、截图和使用教程。

退出条件：

- 新机器不安装 Node 也能使用插件。
- 现有项目可以安全迁移并继续开发。
- App 不是 Plugin 的运行前提。

## 6. 开发规则

开发从 P0 开始，必须遵守：

1. 不在旧 MCP 接口上叠加新语义。
2. 不先写 UI，再反推领域模型。
3. 不为旧 API 做兼容，只兼容旧 JSON 导入。
4. 不创建 ghost Block。
5. 不让 Block、Task 或 Link 拥有 Checkpoint。
6. 不默认读取完整文件、完整日志或完整 History。
7. 不让 AI 手工维护行号。
8. 不在每次编辑后执行完整 Sync。
9. 所有写入必须 revision-checked、事务化、可恢复。
10. SQL 与 JSON 的同步必须有 snapshot digest 和外部回退处理。
11. 数据必须区分 repository、worktree、branch/ref。
12. 长期进程必须属于 daemon，不能属于 MCP 或 App 生命周期。
13. 先完成纵向闭环，再扩展语言和 UI 数量。
14. 每个阶段都必须有可运行结果和失败测试。

## 7. 第一批开发任务

建议按以下顺序开工：

1. 在 `v0.4.1` tag 上建立新的 V2 实现分支。
2. 完成 P0 实体、状态机和迁移表。
3. 建立 `apps/daemon`、`packages/domain`、`packages/storage`。
4. 实现 daemon 启停、IPC 和 project/worktree router。
5. 实现 SQLite、outbox、graph exporter/importer。
6. 实现最小 tree-sitter adapter 和 `code outline/read/edit`。
7. 实现最小 command receipt 和 process session。
8. 打通一个 `Plan -> Task -> Check -> Sync -> Block` 的纵向样例。

第一轮验收不是“支持多少语言”或“App 多好看”，而是：

```text
一个真实 Task
  -> 通过 MCP 读取代码结构
  -> 精确修改代码
  -> 运行测试
  -> Check 绑定证据
  -> Sync 创建或更新真实 Block
  -> coverage 无缺口
  -> graph.json 和 SQLite 一致
```

这个闭环稳定后，再进入全语言覆盖、App 改造和旧数据迁移。

## 8. 最终验收摘要

1. 旧 MCP 工具全部移除。
2. Plugin 可以脱离 App 独立运行。
3. Run Command 支持单次回执和长期进程。
4. Code Tools 使用 tree-sitter，并支持精确重建 locator。
5. Block 只对应真实代码。
6. Checkpoint 只属于 Plan。
7. Task 可以跨对话恢复。
8. Decision 和 Rule 符合单文件/多规则文件模型。
9. SQL/JSON/Git 回退保持一致。
10. branch/worktree 不混状态。
11. Swift App 只连接 daemon。
12. 长 Chain 有稳定布局。
13. Skill 不再训练全文读取、长日志和频繁 Sync。
14. 旧项目可以 dry-run、迁移和继续开发。
15. ContextOS 自身完成 self-adopt。
