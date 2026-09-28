---
name: contextos
description: MUST be used for non-trivial repository engineering (architecture exploration, multi-file edits, in-situ test verification, refactoring). For trivial 1-line edits, use direct change or native tools to avoid fixed context overhead.
---

# ContextOS (核心开发执行中枢)

Default transport: call the single compact `contextos` tool with `action: "explore"|"inspect"|"work"|"change"|"verify"|"ship"|"pipeline"|"micro"|"ops"`.
Named tools are legacy compatibility when `CONTEXTOS_LEAN_SURFACE=0`.

---

## Route work

### 1. 任务分级与自适应路由 (Adaptive Routing — 避免负收益)
- **极简任务（单行修改、微调、简单代码问答）**：
  - **严禁**对简单微调发起重型全仓 `explore` 或最后的 `ship` 仪式，否则会产生 3,000+ Tokens 的固定协议负收益！
  - 直接使用一次性 `change({ edits: [...] })` 或原生编辑工具迅速闭环。
- **常规/复杂任务（跨文件开发、特性实现、单测排错、重构）**：
  - 严格进入四阶段生命周期：`explore` ➔ `inspect/pipeline` ➔ `change` (带原地 `verify`) ➔ `ship`。
- **未知架构/入口**：单次 `explore({ intent: "..." })` 获取模块槽位 `[S1]`, `[S2]`，禁止无脑全仓 `cat`/`grep` 盲目试探。
- **精确切片阅读**：使用 `inspect({ path, ranges: [...] })` 或 `inspect({ symbol: "..." })` 读取方法级 AST 切片，避免整文件 Dump。多文件阅读用 `inspect({ paths: [...] })` 单轮并发搞定。
- **原子改测合一 (In-Situ Verify)**：
  - 修改与测试必须原子合并：`change({ edits: [...], verify: "npm test" })`。
  - 单测跑挂时，系统就地提取 `extractDiagnosticBlocks` 失败断言与堆栈，**0 额外查日志轮次**即可原地定位并修复。
  - 支持 `autoRevert: true`：单测未通过时毫秒级自动回滚工作区。
- **收尾归档**：最终验证通过后调用一次 `ship({ summary: "..." })`，持久化拓扑并更新 300 字节极简黑板。

### 2. 批量与流水线 (Pipeline)
- 多个只读查询合并为：`pipeline({ parallel: [{ inspect: "..." }, { run: "rg 'target' src", raw: true }] })`。
- 多个测试命令：独立无冲突用 `parallel: [{ verify: "..." }]`；有顺序依赖用 `verify({ commands: ["cmd1", "cmd2"] })`。
- 默认返回 receipts 与 diagnostic 摘要；只有明确需要原始正文时才设置 `raw: true` 或 `mode: "full"`。

### 3. Micro 舱外双脑子代理 (何时调用 Micro?)
- **定位**：Micro 是独立于主对话的后台轻量级任务子代理，用于执行“重日志脱毒、契约提取、诊断分析”。
- **触发阈值与原则**：
  - **不要**将 Micro 用于简单代码编辑或普通单步测试。
  - **触发时机**：当测试报错、编译器堆栈或日志输出**超过 2,000 字符**，或者排查需要分析数万字冗长追踪时，必须调用 `micro`！
  - **调用方式**：将证据流水线直接附着在第一次调用中：
    `contextos({ action: "micro", args: { pipeline: { steps: [{ run: "npm test", allowCommands: true }] }, invocation: { evidence: { maxChars: 2400 }, provider: { maxRequests: 1 } } } })`
  - Micro 在舱外独立消化海量输出，主上下文只接收结构化失败结论（Receipt），避免主上下文被数万字日志污染冲垮。

### 4. 系统自检与环境运维 (Doctor & Ops)
- 检查 ContextOS 运行状态、Node 版本、存储模式与已连接编辑器：
  `ops({ capability: "system", action: "doctor" })`。
- 高级操作（Plans、Tasks、Blocks、Chains、Telemetry）使用 `ops` 接口配合显式 `capability:`，详见 [references/capabilities.md](references/capabilities.md)。
- **进阶运维导流**：配置 Micro API、切换云端/本地存储模式、部署 Cloudflare 中枢，请唤起副 Skill `contextos-ops`。

## Block and Chain ownership

- Block 代表稳定的语义责任边界；Chain 将 Blocks 组织成端到端流程；Link 表达跨责任关系。
- `ModuleIndex` 与 `mod-*` 仅用于导航提示，严禁用于建立正式所有权。
- 业务代码修改后，在同一个 `change` 或 `work` 中包含 `architecture.blocks` 与 `architecture.chains`。
- 普通 `ship` 会提示架构间隙；严格 `ship` 在存在孤立文件时会阻断交付。

## Completion

只有当请求的功能、伴随验证以及架构拓扑全部确认 PASS 后才算完工。严禁将空验证视为通过。
