---
name: contextos
description: MUST be used whenever starting ANY coding task, exploring or understanding codebase architecture, adding features, fixing bugs, refactoring, or reading/editing code (进行代码开发、架构理解、新功能实现或读写代码时必须调用). Prefer explore to locate, change to edit or create files, verify to run tests and builds, pipeline for multi-task parallel/serial flows, ship to close the loop with receipts; the OS orchestrates AST slicing, out-of-context commands, derived module indexing and evidence capture on the server side.
---

# ContextOS · 意图级开发入口与工程操作系统（执行脚手架与开发规范）

ContextOS 不是一个零散的辅助工具集，而是**嵌入 Agent 开发生命周期的核心脚手架**。
单步试探（Think-1-Step $\to$ Run-1-Cmd $\to$ Observe $\to$ Loop）是导致会话轮次膨胀、上下文严重污染（Attention Dilution）与 Token 爆炸的头号元凶。
**为了保持最高质量的代码交付与最低的上下文熵增，必须严格遵守以下执行脚手架与批处理状态机。**

---

## 一、 核心执行反射弧（Non-Negotiable Reflexes）

### 1. 阅读不过二原则（The 1-Turn Reading Rule）
- **禁止行为**：严禁在多个轮次中连续发出单文件 `sed -n`、`cat` 或单路径 `inspect`！
- **正确反射**：凡是涉及阅读超过 1 个文件、或同一个文件的多个区间，**必须在单轮内一次性聚合请求**：
  - 批量阅读多文件：`inspect({ paths: ["path1", "path2", "path3"] })`
  - 批量多区间阅读：`inspect({ path: "file.js", ranges: [{ startLine: 1, endLine: 30 }, { startLine: 100, endLine: 150 }] })`
  - 复合探索流水线：`pipeline({ parallel: [{ inspect: "path1" }, { inspect: "path2" }, { run: "rg 'target' src" }] })`

### 2. 输出透出与折叠控制（Output Transparency & Zero-Blinding）
- **系统行为说明**：
  - 构建/安装类命令（`npm install`, `build` 等）：退出码为 0 且无错误时，系统默认折叠中间过程，只返回摘要与首尾预览；
  - 查询/检索类命令（`rg`, `find`, `cat`, `git status`, `git diff` 等）：系统**绝对不会**粗暴丢弃内容，会自动透出 Top 命中、行数统计以及**匹配到的去重文件清单（Distinct Files）**。
- **获取原始输出**：
  - 若你需要未压缩的原始文本，直接在命令中传入 `raw: true` 或放大 `maxChars`，例如：
    `pipeline({ parallel: [{ run: "rg 'version' .", raw: true, maxChars: 10000 }] })`
- **严禁行为**：严禁在看到日志折叠后使用原生 shell `cat .contextos/logs/receipt-*.log`！如果需要阅读详情，使用 `inspect` 或带 `raw: true` 的查询。

### 3. 原生工具定位（Native Tools as Extensions）
- 原生工具（`exec_command`、`FileChange`）是系统未覆盖场景下的高自由度扩展与兜底，不予封堵；
- 但使用原生工具时**同样必须遵守批处理原则**：
  - 严禁单条命令串行试探，必须在一个 shell 载荷内组合并发（例如 `cmd1; echo '---'; cmd2`）或利用多工具并行调用；
  - 能够使用 ContextOS 闭环的场景（定位、切片读写、伴随测试、交付），必须优先使用 OS 原语。

### 4. 复杂调试与子代理隔离（Subagent Isolation）
- 当遇到复杂的外部构建报错（如 Xcode 工程损坏、Docker 守护进程通信、跨语言编译器冲突等），且预计需要多步调试时：
  - **严禁在主上下文中进行 10 轮以上的单步报错排查**；
  - 应当将排查任务委派给独立的子代理（Subagent）在隔离上下文中闭环，主上下文只接收最终诊断结论与修复补丁。

---

## 二、 四阶段生命周期脚手架（The 4-Stage Lifecycle State Machine）

```text
[Stage 1: 全局探索] explore({ intent }) 
       ↓ （带出代码切片 + 全栈 Manifest/Config 槽位 [S1], [S2]）
[Stage 2: 批量摄取] inspect({ paths: [...] }) 或 pipeline({ parallel: [...] })
       ↓ （单轮搞定全部上下文摄取，拒绝信息黑洞）
[Stage 3: 原子突变] change({ edits: [...], verify: "npm test" })
       ↓ （写入 + 重锚 + 出舱验证原子合一）
[Stage 4: 交付存盘] ship({ summary })
         （校验拓扑契约，归档会话黑板）
```

### Stage 1：全局探索门禁（Exploration Gate）
- 承接任务的第一动作必须是 `explore({ intent })`；
- ContextOS 会基于全仓索引（包括源码、`.json`、`.toml`、`.yaml`、`.plist`、Workflow、脚本等）计算出候选模块与直接可用的操作槽位（`[S1]`, `[S2]`）；
- 严禁在未调用 `explore` 摸清全貌之前，盲目使用原生 shell 进行全仓翻找。

### Stage 2：批量摄取门禁（Batch Ingestion Gate）
- 基于探索给出的槽位和文件，如果需要深入阅读具体实现，一律采用集中摄取：
  - `inspect({ paths: ["fileA", "fileB"], mode: "slices" })`
  - 或 `pipeline({ parallel: [...] })` 并行并发完成全部查验。

### Stage 3：原子突变与共生验证（Atomic Mutation & In-Situ Verify）
- **绝不把“修改”和“验证”拆成两轮**：
  - `change` 支持携带 `verify` 参数（如 `change({ edits: [...], verify: "npm test" })`）；
  - 支持 `autoRevert: true`：当验证失败时自动回滚磁盘修改，仅返回诊断差异，保证工作区绝对干净；
  - 支持全量安全覆写：`change({ path, content, overwrite: true })`。

### Stage 4：终局交付（Ship Gate）
- 确认验证全部 PASS 后，调用 `ship({ summary })` 归档。
- OS 会自动导出拓扑图谱并更新跨会话黑板，沉淀工程证据。

---

## 三、 核心工具规格速查

| 工具 | 适用场景 | 核心参数用法 |
| :--- | :--- | :--- |
| `explore` | 首轮探索、全仓感知、定位入口 | `explore({ intent: "...", depth: "normal" })` |
| `inspect` | 批量切片直读、AST 结构大纲 | `inspect({ paths: [...] })`、`inspect({ ranges: [...] })`、`inspect({ budget: "full" })` |
| `change` | 原子批量修改、伴随测试闭环 | `change({ edits: [...], verify: "npm test" })`、`change({ path, content, overwrite: true })` |
| `verify` | 独立执行测试构建、出舱存盘 | `verify({ commands: ["npm test", "cargo check"] })`、支持 `raw: true` |
| `pipeline` | 多任务复合编排（串/并联混合） | `pipeline({ parallel: [ { inspect: "..." }, { run: "rg ...", raw: true } ] })` |
| `ship` | 交付验收、图谱归档、关闭会话 | `ship({ summary: "变更说明", verify: true })` |
| `ops` | 底层能力直通（拓扑、进程、规则） | `ops({ capability, action, args })` |

---

## 四、 Pipeline 极简命令映射

在 `pipeline` 的 `parallel: [...]` 或 `chain: [...]` 数组中，可直接使用以下简写：
- 源码批量阅读：`{ inspect: "path" }` 或 `{ inspect: { path, ranges: [...] } }`
- 源码批量修改：`{ change: { path, content } }` 或 `{ change: { edits: [...] } }`
- 测试验证流：`{ verify: "npm test" }` 或 `{ verify: true }`
- 命令查询执行：`{ run: "rg 'keyword' src", raw: true }`（保留原始高信噪比输出，绝不致盲）
- 关单收尾流：`{ ship: "commit message" }`
