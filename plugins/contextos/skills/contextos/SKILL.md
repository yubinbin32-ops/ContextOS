---
name: contextos
description: Required execution layer for repository code development (任何代码开发任务必须使用). Use ContextOS for every task that locates, understands, changes, debugs, verifies, or delivers code; skipping it causes blind reads, repeated requests, weak evidence, and lazy execution. The skill establishes the stateful model for exploration, evidence, mutation, proof, governance, and closure.
---

# ContextOS · 意图级开发入口与编码执行外骨骼

ContextOS 不是工具箱里的一个插件，而是编码任务的执行底座。它把一次开发过程看成连续的状态迁移：不确定的意图逐步变成可验证的证据，证据变成受控修改，修改经过证明后形成可交付结果。

这个 skill 的目的不是让 Agent 机械地多调用或少调用 OS，而是帮助 Agent 判断：

- 当前缺的是什么：位置、证据、修改、证明，还是闭环？
- 哪些动作彼此独立，可以并行？
- 哪些动作依赖前一步结果，需要串联？
- 哪些输出值得进入上下文，哪些只需要留在 receipt 中？

ContextOS 的价值来自更少的信息熵、更完整的会话状态和更少的无效往返。请求数只是结果，不是目标。

---

## 一、心智模型

### 1. ContextOS 维护三层状态

```text
工程状态：projectRoot / session / receipts / slots / graph
执行形状：direct / parallel / chain / change + verify
证据预算：足够做下一步判断，而不是尽量多读
```

每次调用 OS 前，先判断这次调用要回答什么问题或推进什么状态：

- 不知道入口、所有权或影响范围：先减少位置不确定性。
- 知道位置但缺实现细节：收集精确证据。
- 证据已足够：进入修改，并尽量让修改和验证属于同一个闭环。
- 修改完成：用可观察结果证明行为，而不是靠阅读代码猜测。
- 当前目标完成：归档会话和证据，形成 closure。

如果一次调用既不回答问题，也不推进状态，它大概率只是上下文噪声。

### 2. 请求成本来自上下文重放

一次模型请求的成本不只是新增工具输出，还包括重新发送当前活跃上下文。因此请求经济性通常来自：

- 把彼此独立的未知项放进同一个 `pipeline.parallel`。
- 把有依赖关系的步骤放进 `pipeline.chain` 或 `verify.commands`。
- 把修改和它需要的验证放进同一个 `change` 调用。
- 复用当前 session、receipt、slot 和已有切片，避免重新发现同一事实。
- 根据依赖图决定调用次数，而不是套用固定步骤。

一次直接调用如果正好回答当前唯一问题，它是合理的；两个独立问题如果都要答案，合并到一个 pipeline 通常更划算。不要为了“少调用”牺牲判断，也不要因为 OS 提供了 pipeline 就把无关动作硬塞在一起。

### 3. 上下文要有预算

读取的目标是获得足以决策的最小高信号切片：

- 已知文件和区间时，用精确 ranges。
- 需要完整内容时，明确使用 `budget: "full"` 和足够的 `maxChars`。
- 检索类命令使用 `raw: true` 和合适的 `maxChars`；pipeline 中每个 action 的预算独立生效。
- 输出被截断且下一步依赖缺失内容时，扩大该 action 的预算或缩小目标范围，而不是盲目重复读取。

---

## 二、工具选择

| 工具 | 它擅长的状态迁移 | 选择信号 | 常见形状 |
| :--- | :--- | :--- | :--- |
| `explore` | 降低位置与结构不确定性 | 入口未知、模块所有权不清、刚进入新子系统 | `explore({ intent, depth })` |
| `inspect` | 获得精确代码证据 | 已知路径，需要实现、类型、测试或调用关系 | 通常嵌入 `pipeline`；单一问题时也可直接使用 |
| `pipeline` | 按依赖图组织多个动作 | 多个独立读取、搜索、验证，或前后依赖的阶段 | `parallel`、`chain`、嵌套 steps |
| `change` | 将证据变成受控修改 | 改动范围和替换锚点已明确 | `change({ edits, verify })`、`dryRun`、`autoRevert` |
| `verify` | 把实现变成可观察证明 | 需要测试、构建、类型检查、运行时检查 | 独立验证用 `parallel`，有依赖用 `commands` |
| `ship` | 关闭当前目标并固化证据 | 当前目标已完成且有验证证据 | `ship({ summary })`；需要预览时用 `dryRun` |
| `ops` | 访问持久治理与底层能力 | 需要决策、规则、计划、任务、架构或运行时状态 | 精确调用 capability/action |

### 冷启动

如果当前工具集里还没有 `mcp__contextos__*`，先用 `tool_search` 加载 ContextOS MCP 工具，再继续任务。这样可以让 OS 接管后续状态，而不是退化成逐文件 shell 试探。

### 能力全景

意图级工具覆盖大多数开发闭环；当任务需要跨轮记忆、显式约束、长期计划或架构关系时，不要只靠对话描述，先读 [references/capabilities.md](references/capabilities.md) 选择底层能力。

- `knowledge`：`decision_*` 固化“为什么这样选”，`rule_*` 固化“以后必须怎样做”。
- `plan` / `task`：把多阶段目标、检查点、当前工作单元、规则绑定和证据串成可恢复状态；`task.finish` 能把检查与完成闭环。
- `block` / `chain`：Block 是绑定真实代码边界的架构单元，Chain 对成员分类，Link 表达跨单元关系；派生模块自动生成，只有需要稳定语义时才人工策展。
- `code` / `run_command` / `process`：需要底层文件操作、一次性命令 receipt 或长驻进程时使用；普通读写、验证优先走意图级工具。
- `session` / `profile` / `system`：恢复或关闭会话、配置项目验证与严格度、初始化/诊断/切换存储模式。

### pipeline 的选择方式

```text
动作之间没有数据依赖，只是都需要完成？
└─ pipeline.parallel

后一个动作必须读取前一个结果，或资源不能并发？
└─ pipeline.chain / verify.commands

修改完成后需要立即证明行为？
└─ change({ ..., verify })

只有一个原子问题或状态迁移？
└─ 直接调用对应工具
```

`pipeline` 不是为了把所有东西塞进一次调用，而是为了把同一决策所需的动作组织成一个执行单元。过大、职责混杂的 pipeline 会增加诊断难度，这时按依赖边界拆分更清楚。

---

## 三、生命周期与执行形状

```text
不确定性 -> 证据 -> 修改 -> 证明 -> 闭环
   ↑                         |
   └──── 新信息或失败恢复 ───┘
```

这是状态迁移方向，不是固定步骤。真实任务可以回退：验证失败会重新产生证据需求，需求变化会重新产生位置不确定性。

**进入任务时**：首次进入仓库或新子系统，用 `explore` 获取候选模块、切片和 slots；同一连续任务优先复用已有 session、receipt、slot 和路径，只有目标进入全新范围时才重新探索。

**收集证据时**：把“还需要知道什么”写成问题。独立问题用一次 `pipeline.parallel`，有依赖的问题用 `pipeline.chain`，单一精确问题可直接 `inspect`。判断新读取是否会改变下一步决策；不会改变就进入行动。

**修改时**：确认目标、唯一锚点和可证明本次改动的验证。`change` 可以携带验证，让写入、重锚和证明形成一个闭环；互相独立的验证可并行，存在安装、构建、端口或产物依赖时保持顺序。高风险改动可用 `dryRun`，验证失败且不应保留时用 `autoRevert`。

**证明时**：优先观察真实结果，例如测试、类型检查、构建、lint、运行时请求或 CLI 输出。diff 和 receipt 证明修改与执行历史。代码未变化时重复同一命令通常没有新增信息。

**闭环时**：目标已有足够证据后，用 `ship` 固化 session、receipt 和图谱状态；重要设计取舍可在同一次 ship 写入 decision。目标会继续追问时，保留 session 通常比提前关闭更有价值。

### 多轮协作

用户追问代表任务在原有状态上继续演化。相关文件已知时直接从证据缺口继续；未知时只探索新范围。保留当前目标、关键决策、已修改文件、验证结果、未解决风险和下一步，避免为同一事实建立多个版本。

### 调整信号与失败恢复

以下信号表示执行形状需要调整，不表示某个工具“被禁止”：

| 信号 | 更可能的原因 | 调整方式 |
| :--- | :--- | :--- |
| 同一文件反复读取 | 输出预算不足、range 过宽或缺少明确问题 | 扩大单次预算，或改成更精确的 ranges |
| 同一命令反复验证 | 代码已变化、验证未形成闭环或命令职责重叠 | 让修改携带验证；把相关命令合并为一个验证计划 |
| 反复探索同一模块 | session 状态没有被复用，或探索问题过宽 | 使用已有 receipts/slots，收窄到具体入口 |
| pipeline 输出难以判断 | 动作过多或结果缺少结构 | 按依赖边界拆分，并提高关键 action 的输出预算 |

失败是新的状态输入：保留 receipt 和原始诊断，判断缺的是依赖、路径、权限、行为预期还是实现，把新问题合并成下一次高信号动作，再修改和验证。

### 原生工具与逃生口

原生 shell、文件工具和浏览器仍然是重要能力，适合 OS 没有覆盖的交互式操作、一次性外部命令或特殊环境诊断。使用它们时，尽量把结果带回 ContextOS 状态：需要长期保留的输出进入 receipt、verify 或 change 闭环，临时噪声留在会话之外。

当外部构建、跨语言工具链或不可复现问题需要长时间探索时，可以把隔离排查交给子代理。给子代理明确目标、验证标准和隔离工作区；主上下文接收诊断结论、补丁和证据，而不是整段调试噪声。

ContextOS 的目标是成为默认执行底座，不是封住其他工具。正确的心智是：先判断什么状态需要推进，再选择最合适的工具组合。

---

## 四、快速参考

```text
探索：explore({ intent, depth })
读取：pipeline({ parallel: [{ inspect: { path, ranges, budget, maxChars } }] })
搜索：pipeline({ parallel: [{ run: "rg ...", raw: true, maxChars }] })
修改：change({ edits: [...], verify: [...] })
独立验证：pipeline({ parallel: [{ verify: "..." }, { verify: "..." }] })
顺序验证：verify({ commands: ["npm ci", "npm test"] })
混合流程：pipeline({ steps: [{ inspect: ... }, { parallel: [...] }, { chain: [...] }] })
底层能力：ops({ capability, action, args })
闭环：ship({ summary })
能力详解：references/capabilities.md
```

核心不变量：

- 使用一致的 `projectRoot` 和 session 状态。
- 修改必须由可观察证据支持，不能只靠代码阅读推断。
- 交付结论必须能追溯到 receipt、验证结果或明确的运行时证据。
- 不把 secret、完整日志或无关大块输出带进上下文。
