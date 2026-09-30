<div align="center">
  <img src="assets/logo.png" width="80" alt="ContextOS 标志" />
  <h1>ContextOS</h1>
  <p><strong>AI 编码智能体的上下文外骨骼管理系统：将证据检索、命令执行、代码修改与架构状态移出主会话</strong></p>

[![GitHub release](https://img.shields.io/github/v/release/yubinbin32-ops/ContextOS)](https://github.com/yubinbin32-ops/ContextOS/releases/latest)
[![GitHub stars](https://img.shields.io/github/stars/yubinbin32-ops/ContextOS?style=flat)](https://github.com/yubinbin32-ops/ContextOS/stargazers)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933)](https://nodejs.org)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

<p>当前版本：<span id="contextos-version">2.7.2</span> · 本地 MCP 服务 · AST 切片 · 验证回执 · 持久化项目状态</p>

[**下载与安装**](#5-下载与安装) · [**实测数据**](#4-实测数据与基准评估) · [**解决方案与核心功能**](#3-解决方案与核心功能) · [**发布页**](https://github.com/yubinbin32-ops/ContextOS/releases) · [**English**](README.md)
</div>

![ContextOS 项目横幅](assets/github-social-banner.png)
*图 1：ContextOS 上下文外骨骼系统的项目横幅与核心指标概览。*

---

## 1. 系统定义

**ContextOS** 是一个为 AI 编码智能体打造的底层开发脚手架与**上下文外骨骼（Context Exoskeleton）管理系统**。在传统的智能体工作流中，源码检索、终端命令行调用、测试构建日志以及试探性的代码修改全部直接输入主对话窗口。这会导致对话上下文迅速膨胀、关键系统指令被冲淡稀释，并显著增加主模型的推理开销。

ContextOS 将机械执行与语义推理严格解耦。通过在智能体与代码仓库之间构建独立的执行层，ContextOS 将证据检索、命令执行、原子修改与架构状态全面移出主会话，仅向主模型回传高确定性的 AST 代码切片、持久化执行回执以及精准的失败诊断，从而维持轻量、聚焦且具备持久连续性的开发闭环。

![ContextOS 工作流演示](assets/contextos-demo.gif)
*图 2：ContextOS 驱动智能体执行、代码修改与架构画布联动的端到端工作流演示。*

---

## 2. 痛点分析

在未经受控脚手架管理的开发环境中，自主编码智能体面临以下五大核心瓶颈：

1. **整文件读取与日志污染上下文**：
   传统文件检查工具往往直接读入完整源文件（成百上千行代码）以查看局部函数；构建与测试命令输出的数千行日志亦全量涌入对话。单轮交互即消耗数万 token，不仅挤占有限的上下文预算，而且削弱模型对全局设计意图的注意力，迫使对话提早截断。
2. **多轮命令调用造成脏对话与重复请求**：
   完整的工程检查通常涉及 `lint`、`typecheck`、`test`、`build` 等串行步骤。传统模式下智能体必须多轮往返触发，每一轮的输入输出都永久沉淀在对话历史中，导致后续每一步的上下文输入基数呈几何倍数累积，大幅推高计费。
3. **修改与架构漂移**：
   缺乏架构边界约束的智能体在多文件修改时，极易产生非原子性或越界修改，且未能即时结合回归验证。无边界的所有权缺失会导致私有模块被非预期篡改，引发隐蔽的接口破坏与架构漂移。
4. **跨对话丢失进度**：
   当上下文触顶或开启新会话时，智能体面临“记忆归零”。新会话必须从头扫描目录、重读依赖、重新理解工程上下文，耗费巨额冷启动 token，且容易产生与先前决策冲突的不一致修改。
5. **主模型 Token 成本高**：
   将机械的文件检索、日志解析和低级命令调用交由昂贵的旗舰级前沿模型处理，不仅未提升语义决策质量，反而造成不必要的经济成本负担。

---

## 3. 解决方案与核心功能

针对上述痛点，ContextOS 提供了统一的执行外骨骼。系统对外暴露紧凑的 MCP 接口 `contextos({ action, args, projectRoot })`，并配套桌面端架构画布环境。

![桌面端架构画布概览](assets/canvas-overview.png)
*图 3：桌面端 Block/Chain 地铁图架构画布与上下文反馈检查器。*

### 3.1 确定性证据检索与结果复用（`ask` / `inspect`）
ContextOS 采用 AST 驱动的符号切片与确定性行区间替代整文件读取（`ask` 配合 `inspect: [{ path, ranges: [[first, last]] }]`）。
- 仅检索目标语法节点，并生成密码学内容校验哈希。
- 检索结果以 `resultId` 建立索引；当后续需要再次引用该部分代码时，系统通过版本校验确认内容无变化，返回零正文负载的 `unchanged` 回执，彻底消除重复读取。

![应用内 README 阅读器与能力表](assets/readme-reader.png)
*图 4：应用内内嵌的 README 结构化阅读器与能力对照表。*

### 3.2 本地持久化回执与日志外置（`command`）
`command` 机制在隔离的本地子进程中执行终端命令，杜绝终端日志向会话漫延。
- 冗长的 stdout 与 stderr 数据完整保存在本地磁盘，生成持久化日志回执。
- 对话上下文仅接收包含退出码、执行耗时与关键过滤信息的轻量回执。
- 历史命令输出可通过执行 `id`（`command({ action: "get", id })`）随时提取，无需重新运行命令即可调取诊断依据。

![Checkpoint PASSED 与验证回执](assets/checkpoint-detail.png)
*图 5：Checkpoint 验证回执，展示 PASSED 状态与紧凑差异回执。*

### 3.3 批量串联与并联流水线（`pipeline`）
为消除多轮命令往返带来的上下文膨胀，`pipeline` 支持将多个操作（`inspect`、`change`、`verify`、`command`、`run`）串行或并行编排在单次调用中。
- 所有步骤在本地运行时内依次或并发执行。
- 主智能体在单个交互轮次中即可获取全部步骤的综合回执，极大降低往返延迟与会话堆积。

### 3.4 原子修改验证与 Block 所有权（`change` + `verify`）
ContextOS 通过事务性修改确保代码库健壮性：
- **修改与验证强绑定**：源码编辑（`edits: [{ path, target, replacement }]`）与测试命令（`verify: ["npm test"]`）同轮执行；若测试未通过，支持即时回滚（`autoRevert: true`）。
- **架构 Block 所有权**：工程文件按边界纳入 Block 与 Chain 管理。处于受控边界内的文件修改必须具备明确的 Block 所有权，未经授权的跨界修改将被直接拦截，杜绝架构漂移。

![影响路径高亮](assets/path-impact.png)
*图 6：架构边界与依赖链上的影响路径高亮展示。*

### 3.5 跨会话连续性与持久化状态图（`plan` / `task` / `session`）
开发进度沉淀于本地 `.contextos/` 目录，不受对话截断影响：
- **状态黑板**：运行时持续记录任务意图、分解步骤（`plan`、`task`）、修改记录与验证回执，自动渲染并同步 `.contextos/blackboard.md`。
- **零冷启动复原**：新会话通过 `ops({ capability: "session", action: "status" })` 秒级重建项目全景认知，无缝续接任务，免除冗余扫描。

![知识列表视图](assets/knowledge-reader.png)
*图 7：整理项目 README、架构规范与操作规则的知识列表视图。*

### 3.6 双层子代理委派机制（`api-micro` 与 `cli-agent`）
ContextOS 提供分级委派能力，分担主模型负荷：
- **API Micro**：轻量级同步执行器，专门负责语义检索、日志提炼、有界命令执行与小批量验证，以极小开销直接返回处理就绪的精简总结。
- **CLI Agent**：隔离的 CLI 子代理适配器，处理多步骤重构与需要独立工具循环的复杂实现任务。采用 `background: true` 异步调度，规避宿主工具超时（如 AGY 约 3 分钟限制）。
- **会话复用与 233k 窗口规则**：系统最多保留 5 个已完成的会话以供复用（`sessionId` / `cliSessionId`）。在任务连续且背景一致时复用会话；一旦 CLI 上下文占用达到 233k token 临界值，或进入全新独立任务，立即轮转开启全新会话，防止模型注意衰减。

![插件页：MCP 与技能管理](assets/mcp-integration.png)
*图 8：插件管理界面展示本地 MCP 服务注册与技能安装状态。*

![多平台设置同步](assets/settings-sync.png)
*图 9：面向 Codex、Claude、Cursor、Antigravity 与 OpenCode 的多平台 MCP 及技能配置同步。*

---

## 4. 实测数据与基准评估

为真实评估 ContextOS 在实际工程开发中的效能，团队进行了严格的端到端对比评测。

### 4.1 测试方法与实验设计
- **实验设置**：将 ContextOS 仓库复制为四个完全隔离的工作副本。使用四个全新的 AGY 主会话（模型：`gemini-3.8-flash-high`，思考强度：`high`）独立实现同一个真实业务功能：`ops session handoff` 开发交接报告生成机制。
- **准出条件**：所有对照组均必须通过独立的业务验收测试与全量仓库测试套件（`npm test`）。
- **实验分组（Arms）**：
  - **A 组（原生 Native）**：使用传统原生文件读取与终端命令工具开发。
  - **B 组（仅使用 OS 原语）**：仅使用 ContextOS 核心原语（`pipeline`、`command`、`change`、`inspect`）。
  - **C 组（OS + API Micro）**：使用 OS 原语并结合 API Micro 进行语义检索与验证批处理。
  - **D 组（OS + API Micro + CLI Agent）**：使用 OS 原语并同时引入 API Micro 与 CLI 子代理委派。
- **指标定义**：
  - `raw`：未缓存输入 + 缓存读取 + 输出 token 总量。
  - `peak`：单步交互的最大上下文占用（`input + cache`）。
  - `cost`：按标准 API 费率核算的实际财务支出（未缓存输入 $2.00/M，缓存读取 $0.10/M，输出 $10.00/M）。
  - `adjusted raw`：加权折算总 token（`main raw + micro raw / 7 + cli raw / 7`）。
  - `adjusted cost`：加权折算总费用（`main cost + micro cost / 7 + cli cost / 7`）。

### 4.2 实测数据对比

| 实验组 (Arm) | main raw | micro raw | cli raw | adjusted raw | 对比 A 组 | peak | main cost | adjusted cost | 对比 A 组 | turns |
| :--- | ---: | ---: | ---: | ---: | :---: | ---: | ---: | ---: | :---: | :---: |
| **A native** | 12,626,564 | 0 | 0 | 12,626,564 | — | 221,221 | $3.0415 | $3.0415 | — | 102 |
| **B OS only** | 9,965,559 | 0 | 0 | 9,965,559 | **-21.1%** | 171,915 | $2.7931 | $2.7931 | **-8.2%** | 101 |
| **C OS+micro** | 10,671,004 | 40,605 | 0 | 10,676,805 | -15.4% | 183,521 | $4.0187 | $4.0281 | +32.4% | 102 |
| **D OS+micro+CLI** | 18,594,536 | 0 | 4,522,517 | 19,240,610 | +52.4% | 235,531 | $3.9567 | $4.1465 | +36.3% | 141 |

### 4.3 客观结论与局限性分析

实测数据呈现出严谨、客观的工程事实：

1. **OS 核心原语成效显著（B 组）**：
   在仅使用 ContextOS 核心原语（`pipeline`、`command`、`change`）的 B 组中，主会话 raw token 稳定下降 **21.1%**（从 1,262 万降至 996 万），单步峰值上下文压缩 **22.3%**（从 221,221 降至 171,915），实际费用减少 **8.2%**（$2.7931 对比 $3.0415），交互轮次保持稳定（101 轮对 102 轮）。这证明代码切片与外置日志回执能够有效保护主对话窗口。
2. **子代理委派开销与缓存失效（C/D 组）**：
   在 C 组与 D 组中，子代理委派并未真正替代主对话的工作量，而是呈现叠加效应。主会话仍承担了繁重的任务协调、结果确认与后台轮询工作（D 组交互轮次增至 141 轮）。同时，跨智能体上下文切换导致主会话 Prompt 缓存频繁失效，反而显著增加了整体 token 消耗（D 组折算 raw 增加 52.4%）与财务成本（C 组增加 32.4%，D 组增加 36.3%）。
3. **当前局限与未来演进**：
   实测表明，底层执行外骨骼能够确切压缩上下文与开销，但自主子代理委派在当前仍伴随显著的协作损耗与轮询开销。这并非已经彻底解决的问题，而是 ContextOS 当前的局限与下一阶段的重点攻坚方向：我们将聚焦于零轮询事件响应机制、严格的工作量替代语义以及面向上下文缓存对齐的会话序列化设计。

---

## 5. 下载与安装

### 5.1 一句话智能体安装
用户可通过向 AI 编码智能体发送一句话指令完成自动化安装引导：

> **「请你读取 setup.md 指引为我安装」**

智能体将自动检测宿主操作系统、CPU 架构与 Node.js 运行时环境，推荐最适安装包，引导配置 API Key 并完成 MCP 注册。

### 5.2 官方发布产物
预编译版本可从 [GitHub Releases](https://github.com/yubinbin32-ops/ContextOS/releases) 下载：

- **macOS**（支持 `arm64` Apple Silicon 与 `x64` Intel）：
  - **Standard 包**（`ContextOS-macos-<arch>.zip`）：轻量级版本，直接利用系统现有 Node.js（需 Node.js 22+）。
  - **Full 包**（`ContextOS-macos-full-<arch>.zip`）：内置独立 Node.js 运行时，免去系统环境配置。
- **Windows x64**（需 Node.js 22+）：
  - **安装器版**（`ContextOS-Setup-x64.exe`）：标准安装程序，自动配置全局 PATH。
  - **便携版**（`ContextOS-win-x64.zip`）：解压即用，适合受限或免安装环境。

### 5.3 源码安装
开发者若需基于源码构建或进行二次开发（需 **Node.js 22+**）：

```bash
git clone https://github.com/yubinbin32-ops/ContextOS.git
cd ContextOS
npm ci
npm run plugin:build
```

### 5.4 宿主集成方式
- **Codex 插件**：
  ```bash
  codex plugin marketplace add .
  codex plugin add contextos@contextos-development
  npm run plugin:install
  npm run plugin:install:check
  ```
- **通用 MCP 宿主（Claude Desktop、Cursor、Antigravity、OpenCode）**：
  在宿主的 MCP 配置文件中添加 stdio 服务：
  ```json
  {
    "mcpServers": {
      "contextos": {
        "command": "node",
        "args": ["/absolute/path/to/ContextOS/plugins/contextos/server/contextos-mcp.mjs"]
      }
    }
  }
  ```

---

## 6. 日常使用方式

安装完成后，智能体日常开发将自动接入 ContextOS 作为底层执行脚手架。

### 6.1 常用提示词示例
智能体原生支持以下调度指令：
- `「把开发文档写入 plan 后开始执行」`
- `「为我配置 CLI」`
- `「切换到 deepseek API」`

### 6.2 智能体 MCP 调用示例
智能体通过统一的 `contextos` 接口执行原子操作：

```javascript
// 示例：单轮流水线批量完成精确检查、原子修改与自动化回归测试
contextos({
  action: "pipeline",
  args: {
    steps: [
      { action: "ask", inspect: [{ path: "src/cart.ts", ranges: [[45, 60]] }] },
      {
        action: "change",
        edits: [{
          path: "src/cart.ts",
          target: "const total = price * quantity;",
          replacement: "const total = price * quantity - discount;"
        }],
        verify: ["npm test"],
        autoRevert: true
      }
    ]
  },
  projectRoot: "/absolute/path/to/project"
});
```

### 6.3 本地验证与质量准出
```bash
npm test
npm run plugin:verify
```

---

<div align="center">

[贡献指南](CONTRIBUTING.md) · [安全策略](SECURITY.md) · [发布说明](.github/RELEASE_NOTES.md) · [MIT 协议](LICENSE)

</div>