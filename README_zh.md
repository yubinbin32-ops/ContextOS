<div align="center">
  <img src="assets/logo.png" width="76" alt="ContextOS" />
  <h1>ContextOS — AI 编码上下文操作系统</h1>
  <p><strong>基于模型上下文协议（MCP）的软件工程上下文操作系统</strong></p>
  <p>针对大模型编码代理中的上下文饱和与注意力退化问题：提供基于语法制导的 AST 语义定位、带外进程执行隔离、单步改测原子验证，以及拓扑优先的自适应预算调度。</p>

  [![GitHub Stars](https://img.shields.io/github/stars/yubinbin32-ops/ContextOS?style=flat-square&logo=github&color=FFD700)](https://github.com/yubinbin32-ops/ContextOS/stargazers)
  [![npm version](https://img.shields.io/npm/v/contextos?style=flat-square&logo=npm&color=CB3837)](https://www.npmjs.com/package/contextos)
  [![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=nodedotjs)](https://nodejs.org)
  [![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)
  [![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-8B5CF6?style=flat-square)](https://modelcontextprotocol.io)

  <br/>

  <p><strong>版本：<span id="contextos-version">2.6.1</span></strong> · 五平台 MCP 与 Skill 适配 · Micro 多轮子代理</p>

  [**下载 macOS App**](https://github.com/yubinbin32-ops/ContextOS/releases/latest) · [**快速配置指南**](#30-秒极速配置ai-自动安装引导) · [**English**](README.md)
</div>

---

![ContextOS 交互工作流演示](assets/contextos-demo.gif)

---

## 背景与系统定位 (Context Window Saturation & Attention Drift)

在基于大语言模型（LLM）的复杂代码库协同中，智能体（AI Coding Agent）的核心瓶颈在于**上下文窗口的快速饱和与注意力退化**（Context Window Saturation & Attention Drift）。传统交互模式下，Agent 依赖整文件全量加载、原始终端构建日志裸露回传、以及一问一答式的串行试错，引发三大系统性缺陷：

1. **有效注意力稀释与幻觉**：未过滤的构建日志与冗长源文件迅速挤占有限的注意力预算，导致模型忽略前置架构约束与类型契约；
2. **多轮故障排查的指数级开销**：单测失败时因日志截断而反复发起诊断查询，单次排查成倍放大历史累积 Token；
3. **架构失明与长程接力断代**：缺乏全局可验证的符号依赖图谱，会话清屏（`/clear`）或跨对话交接时上下文无法无损恢复。

**ContextOS 通过模型上下文协议（MCP）为大模型构建了轻量化的确定性上下文操作系统**：

| 核心子系统 | 架构机制 | 证据边界 |
|---|---|---|
| **语法制导精准访问 (Syntax-Directed Access)** | 基于 Tree-sitter 多语言 AST 引擎，按需提取符号大纲与方法级语义切片 | 用有界符号切片替代全量文件倾倒 |
| **带外执行与诊断内联 (Out-of-Band Execution)** | 进程运行与脱敏日志完全下沉至宿主舱外，仅向模型返回执行凭据与结构化失败诊断帧 | 只回传 receipt 与诊断帧，原始日志不进入主上下文 |
| **拓扑地铁图谱 (Metro Map Topology)** | 将真实文件、符号锚点与依赖关系物化为强类型 Block-Chain-Link 有向图 | 提供确定性的结构导航与影响范围上下文 |
| **持久化状态黑板 (Blackboard Rehydration)** | 轻量增量状态快照，严格解耦交互历史与运行态事实 | 用于冷启动与跨会话接力的恢复 receipt |

> 本文档中的性能数字仅来自下方真实开发对照验证；宿主 token、峰值上下文、provider token 与正确性分开报告。

---

## 它带来的核心开发变化

### 1. 架构化身地铁路线图 (Metro Map)

Block 绑定真实文件、AST 符号或目录树（杜绝虚空 Ghost Block）。依赖与资源目录使用单个有界 tree 锚点，不再逐文件记账；Chain 代表水平平行的地铁铁轨，带类型的 Link 形成正交的跨线换乘。AI 一眼看清系统骨架，无需盲读代码。

![ContextOS 地铁图 — Block、Chain 与实时计划状态](assets/canvas-overview.png)

### 2. 意图级 2 轮极速闭环、动作槽位与单测诊断直出 (Action Slots, In-Situ Verify & Diagnostics)

- **动作槽位与零对齐成本**：`explore` 根据意图自动派发 `[S1]`, `[S2]` 目标槽位，AI 不需要猜测行号或精确对齐匹配，做“选择题”即可通过 `change({ slot: "S1", append: "..." })` 快速填入代码，彻底消灭参数对齐错位。
- **改测合一与单测失败诊断就地直出 (In-Situ Diagnostic Extraction)**：
  - `change` 步骤原地内嵌测试命令（`verify: "npm test"`），同一步骤原子完成“代码修改 + 单测运行 + 凭证回执签发”。
  - **杜绝查日志往返**：传统 AI 跑单测失败后，由于命令行仅给出简略信息，AI 必须额外开启 2~3 轮独立对话专门调用工具查看日志，单次多耗费 20,000~40,000 上下文。ContextOS 内置智能诊断帧提取引擎（`extractDiagnosticBlocks`），自动捕捉 TAP、Mocha、Jest、SyntaxError 等错误上下文，就地提取测试名称、`+ actual - expected` 断言差异与精确 `file:line:col` 堆栈，**AI 在当前轮次一眼看清错误细节，0 额外轮次即刻修复**。
  - **原子回滚 (Auto-Revert)**：测试未通过时，配合 `autoRevert: true` 可毫秒级自动回滚磁盘修改，开发往返由传统的 6~9 轮剧降为 **2 轮极速闭环**（explore 探索 ➔ change+verify 原地改测 ➔ ship 归档）。
- **单轮并发批处理优先 (Parallel Batching Over Serial Turns)**：
  - 传统的 AI 工具交互习惯单文件串行“一问一答”，轮次膨胀且历史 Token 呈阶梯式暴增；
  - ContextOS 原生支持单轮多并发：支持 `edits: [...]` 单步原子批处理多文件修改、`inspect({ paths: [...] })` 单轮并发阅读整组微服务，大幅降低 API 往返延迟与累计上下文。
- **Receipt-First Pipeline 输出**：
  - `pipeline({ mode: "receipt" })` 对成功的批量动作只返回有界的状态、receipt、artifact、verdict 和 exit 引用。只有确实需要动作正文时才使用 `mode: "summary"` 或 `mode: "full"`；批处理必须减少宿主轮次，而不是重新膨胀原始输出。
- **全局拓扑优先级保全 (Topological Retention Priority)**：
  - 采用独创的上下文预算权重算法：`next` (0) → `slots` (1) → `where` (2) → `now` (3) → `slices` (4)。当工程规模庞大时，OS 优先截断局部的代码预览，**绝对保全系统依赖图谱与可用动作槽位**，彻底杜绝 AI 因切片过长而产生的“架构失明”。
- **轻量实时黑板与跨对话秒级复原 (`.contextos/blackboard.md`)**：
  - 会话事实实时持久化于仅 **300 字节（~65 tokens）** 的极简黑板。AI 随时可清屏（`/clear`）或跨对话子代理接力，新会话通过 `explore` 只需 **150 tokens** 即可秒级复水，彻底摆脱多轮会话累积 Token 雪崩。

![地铁图 Block 详情 — AST 锚点、Chain 归属与验证状态](assets/path-impact.png)

### 3. 命令运行出舱脱敏 (Out-of-Context Execution)

`verify` 与 `change.verify` 背后的命令网关会剥离 ANSI 终端控制符与敏感密钥，全量**脱敏后**日志存盘于 `.contextos/logs/`，仅向上下文返回精简回执（Receipt），削减 98% 以上的终端输出噪声。

### 4. 代码工具手术刀级读写与深度切片 (Surgical Code & Inspect)

集成编译器级真 AST 引擎（原生支持 JS/TS/JSX/TSX、Python、Swift、Java、Kotlin、C/C++、C#、Go、Rust、PHP、Ruby 等 10+ 种主流语言）。通过全新的 `inspect` 工具支持 VS Code 风格全局符号搜索、大纲审视、方法级抽取和补丁式精准写盘并自动重锚。当进行纯提问/代码定位时，OS 智能剔除多余槽位与切片，只返回高精度的调用拓扑与符号位置，上下文消耗再降 50%。

### 5. 单一入口的知识与架构决议

项目方案、设计取舍与规则规约归纳为单文件叙事 `DECISION.md` 与分类 Rules。`README.md` 与 `README_zh.md` 在 App 的知识抽屉中以只读方式直接预览。

![README 和 OS 文档在知识抽屉中实时渲染](assets/readme-reader.png)

### 6. 验证与证据管理

每次 `verify` 都产生带签名的回执（Receipt）。检查点（Checkpoint）按任务粒度追踪通过/失败状态，让 AI 与人类共享"什么已被真实证明可用"的唯一事实源。

![检查点详情 — 通过/失败证据与实际测试回执关联](assets/checkpoint-detail.png)

### 7. 长期运行进程常驻监控

通过守护进程托管 Dev Server、Watcher 与后台 Worker，在桌面端左下角实时监控 PID、端口号与生命周期，支持一键安全释放进程树。

## 支持的宿主

ContextOS 目前支持五类主要宿主：Codex、Claude Code、OpenCode、Cursor、Antigravity。每类宿主都使用紧凑 MCP 接口与 ContextOS Skill。旧的宿主生命周期 Hook 层已移除，避免路由、恢复和轮次策略出现第二套实现。

| 宿主 | MCP 与 Skill | 状态 |
|---|---|---|
| Codex | 支持 | 已支持 |
| Claude Code | 支持 | MCP + Skill |
| OpenCode | 支持 | MCP + Skill |
| Cursor | 支持 | MCP + Skill |
| Antigravity | 支持 | MCP + Skill |

MCP 默认暴露单一紧凑 `contextos` 传输；需要旧多工具界面时显式设置 `CONTEXTOS_LEAN_SURFACE=0`。仓库读取、修改和验证统一通过 ContextOS MCP 保留单一证据链。

## Micro 任务子代理

Micro 是一个可选的多轮、可控任务子代理，适合日志脱毒、契约提纯、诊断摘要等有界任务。用户可在 `.contextos/profile.json` 中配置任意 OpenAI 兼容接口的 `url`、`model`、`key` 和 `sessionHeader`。若希望降低接入成本，推荐使用 OpenCode Go 订阅。

Micro 会把会话状态保留在主对话之外，限制轮次和上下文长度，默认关闭工具，只把最终结果和 receipt 返回主上下文；完整推理和工具轨迹留在 artifact。支持的会话动作包括 `create`、`send`、`get`、`list`、`close`、`delete`。

Provider 成本与宿主上下文分开设限。每个 preset 都有默认 provider token 上限；可在 `micro` profile 中配置 `maxProviderTokens`、`maxCostUsd`、`inputUsdPerMillion` 和 `outputUsdPerMillion`。若工作流必须通过 `inputRef`/`inputArtifact`/`inputReceipt` 传递日志或 artifact，而不是内联输入，可设置 `requireBulkInput: true`。会话带 TTL，陈旧的在途任务会在有界时间后恢复，跨进程写入使用 `.contextos/micro-sessions/` 下的锁文件。

2026-09-26 的真实开发对照在同一 artifact-retention 任务上比较了无 OS、仅 OS、修复前 OS+Micro 和修复后 OS+Micro。修复后只调用一次有界 Micro preload，原始 pipeline 输出留在 artifact，主对话只收到 receipt。详细指标和限制见下方真实开发验证。

---

## 快速上手与安装方式

ContextOS 提供了两种开箱即用的极简安装方式，无论小白还是极客均可一键搞定：

```mermaid
graph TD
    User([选择适合您的接入方式]) --> ChoiceA[方案 A: 直接下载 macOS 桌面端]
    User --> ChoiceB[方案 B: 把一句话发给 AI 自动配置]
    
    ChoiceA --> FlowA[开箱即用 · 原生地铁图交互 · 一键注入各编辑器]
    ChoiceB --> FlowB[零操作 · AI 自动检测环境并按需精准注入]
```

---

### 方案 A：直接下载桌面客户端（macOS & Windows · 开箱即用 · 强烈推荐）

从 [GitHub Releases 最新发布页](https://github.com/yubinbin32-ops/ContextOS/releases/latest) 下载对应安装包：

| 平台 | 安装包版本 | 压缩包 / 安装文件 | 体积 | Node.js 依赖 | 适用场景 |
|---|---|---|---|---|---|
| **Windows** | **安装引导包 (NSIS)** *(推荐)* | `ContextOS_<version>_x64-setup.exe` | 约 8 MB | 需系统已有 Node.js 22+ | Windows 10/11 64位系统，自动生成开始菜单与桌面快捷方式 |
| **Windows** | **绿色便携版** | `ContextOS-windows-x64.zip` | 约 10 MB | 需系统已有 Node.js 22+ | 免安装，解压后双击即可运行 |
| **Windows** | **企业部署 MSI** | `ContextOS_<version>_x64.msi` | 约 8 MB | 需系统已有 Node.js 22+ | 适用于企业内网或静默分发环境 |
| **macOS** | **完整版 (Apple Silicon)** | `ContextOS-macos-full-arm64.zip` | 约 35 MB | **零依赖**（内置独立 Node 22） | M 系列 Mac 首选，无需配置任何外部环境 |
| **macOS** | **完整版 (Intel)** | `ContextOS-macos-full-x64.zip` | 约 38 MB | **零依赖**（内置独立 Node 22） | Intel Mac 首选，无需配置任何外部环境 |
| **macOS** | **轻量版 (Standard)** | `ContextOS-macos-arm64.zip` / `x64.zip` | 约 1.6 MB | 需系统已有 Node.js 22+ | 追求极致体积且本地已配置 Node.js 22+ |

#### 极速配置流程：
1. **Windows 用户**：运行 `.exe` 安装程序或解压便携 `.zip`，启动 **ContextOS**。
   **macOS 用户**：解压下载的压缩包，将 **ContextOS.app** 拖入 `Applications`（应用程序）目录。
2. 打开 **ContextOS**，进入 **设置**（齿轮图标），勾选需要配置的 AI 编辑器（Cursor / Claude Desktop / Antigravity / OpenCode / Codex 等），点击 **一键安装 / 同步插件**。

> [!IMPORTANT]
> 请从 `Applications`（应用程序）目录运行 **ContextOS.app**，不要直接从 `Downloads`、已挂载的 DMG 或其他只读卷运行。插件同步只会写入用户级的 `~/.contextos` 与 `~/plugins`，App Bundle 始终被视为只读来源。

3. App 会自动将 MCP 配置及对应运行路径注入编辑器。**配置完成后，你可以随时关闭桌面 App，平时无需保持开启**。
4. 在编辑器对话中只需一句话唤醒 ContextOS 协作：
   > **"把这个方案写入 ContextOS 后开始执行"** 或 **"查看 ContextOS 继续开发"**

> [!IMPORTANT]
> **首次在 macOS 打开提示"无法打开"或"已拦截未受信任的开发者"？**
> 由于独立开源软件尚未加入苹果付费开发者签名公证，macOS Gatekeeper 安全机制会在首次双击启动时弹出风险拦截提示。这是 macOS 的正常保护机制，**仅需在首次启动时放行一次即可**：
> - **方式一（系统设置放行 · 推荐）**：打开 macOS **"系统设置" (System Settings) ➔ "隐私与安全性" (Privacy & Security)**，向下滑动到"安全性"栏目，在"已拦截 ContextOS.app"旁边点击 **"仍要打开" (Open Anyway)** 并确认。
> - **方式二（快捷右键打开）**：在"访达"（Finder）的"应用程序"中找到 `ContextOS`，按住 **Control 键点按（或右键）** 应用图标，在右键菜单中点击 **"打开"**，并在二次弹出的警告窗中点击 **"打开"**。

![一键同步编辑器和 MCP — Antigravity 与 Codex 已连接](assets/settings-sync.png)

---

### 方案 B：把一句话发给 AI，全流程自动配置（零操作）{#30-秒极速配置ai-自动安装引导}

适合已经打开 AI 编程助手（Codex / Claude Code / OpenCode / Cursor / Antigravity）的开发者。其他宿主由 AI 按适配指南自行接入，用户无需敲打命令行：

> **只需复制下方指令，发送给您的 AI 编程助手对话框：**  
> **"请阅读 `https://github.com/yubinbin32-ops/ContextOS/blob/main/AI_SETUP.md`，检测我的系统环境，为我自动安装并配置好 ContextOS。"**

#### AI 将在后台为您自动完成：
1. **系统与桌面端探测**：若检测为 macOS，AI 会主动询问是否需要下载原生的可视化桌面端（ContextOS.app），确认后全自动下载部署。
2. **Node 运行时自检**：自动验证 Node.js 22+ 环境（或使用桌面端自带的内嵌 Node）。
3. **按需精准注入**：向用户确认需要配置哪些编辑器（如 Cursor / Codex / Claude 等），精准注入对应 MCP 配置与唯一 Skill，**杜绝重复 Skill 冗余**。
4. **协作模式按需确认**：询问用户是需要单人本地开发还是团队协同开发，并自动完成对应配置与初始化。
5. **当前项目初始化与工具验证**：根据用户选择初始化本地离线模式或云端模式，并完成轻量自检。

![ContextOS 在 MCP 工具浏览器中的展示 — 一个服务器，全部能力](assets/mcp-integration.png)

---

## 存储模式说明：本地与实验性云端协同

ContextOS 始终以**本地工作区项目目录**为核心基石（代码阅读、AST 手术刀修改、脱敏命令执行均在本地完成）：

- **本地存储模式**：适合单人本地开发。数据保存在项目根目录的 `.contextos/state.sqlite`，0 毫秒响应延迟，100% 离线，完全保护代码与架构隐私。
- **实验性云端协同模式**：用于评估团队协作。通过项目配置将架构图谱托管在 Serverless 云端中枢（Cloudflare D1），多名团队成员协同开发时同步模块契约。API 与运维模型稳定前，请将云端模式视为实验能力。
  - **天然支持多项目严格隔离**：云端中枢基于严格的 `projectId` 分区存储，同一套云端 Worker 和 D1 数据库可同时支持您开发无数个不同项目，彼此独立互不串扰。
- **随时双向无损切换**：开发过程中，您只需对 AI 说：
  - *"把当前项目切换为云端协同模式"* ➔ 本地数据自动完整推送到云端 D1；
  - *"把当前项目切回本地离线模式"* ➔ 云端最新架构快照自动下载至本地 SQLite，后续开发完全离线。

---

## 真实开发对照验证

性能结论以仓库内这次真实开发对照为准。宿主总 token、缓存输入、输出 token、峰值上下文、token 事件数、Micro provider token 与正确性分开报告。

### 1. 四臂真实开发模拟（2026-09-26）

四组使用同一个 artifact-retention 开发任务：profile 合并、store/stat/evict/dry-run、telemetry、focused tests、全量测试和最终提交。每组使用独立 worktree、`deepseek-v4.1-flash` 和 332,500 token 上下文窗口。

| 组 | 策略 | 轮数 | 总 token | 峰值上下文 | token 事件 | Micro 调用 |
|---|---|---:|---:|---:|---:|---|
| A | 无 OS / 无 Micro | 4 | 9,089,235 | 260,646 | 60 | 0 |
| B | 仅 OS | 4 | 6,308,533 | 206,832 | 50 | 0 |
| C | OS + Micro，修复前 | 4 | 8,388,735 | 212,468 | 80 | 10（4 次失败） |
| E | OS + Micro，修复后 | 2 | 1,541,058 | 109,792 | 21 | 1 |

相对无 OS 组：

| 组 | 总 token 变化 | 峰值上下文变化 | token 事件变化 |
|---|---:|---:|---:|
| 仅 OS | **-30.6%** | **-20.6%** | -16.7% |
| OS + Micro，修复前 | -7.7% | -18.5% | +33.3% |
| OS + Micro，修复后 | **-83.0%** | **-57.9%** | -65.0% |

修复后组只调用一次有界 Micro preload/graph，使用默认 16,000 provider token 预算，实际消耗 11,970 provider token，且没有失败。修复前组调用 10 次、4 次失败、消耗 69,201 provider token；这说明调用次数本身不能代表 Micro 使用质量。

可比较真实仓库工作的预期范围：

| 方式 | 本次实测 | 预期范围 |
|---|---:|---:|
| 仅 OS | 总 token **-30.6%**，峰值上下文 **-20.6%** | 当读取、修改和验证都留在 ContextOS 内时，通常可预期 **20-40%** 总 token 与 **15-30%** 峰值上下文下降 |
| OS + Micro，有界使用 | 总 token **-83.0%**，峰值上下文 **-57.9%** | 对日志密集或多文件关系发现任务，当 Micro 只接收一个有界 preload/graph 任务时，通常可预期 **50-80%** 总 token 与 **40-60%** 峰值上下文下降 |
| OS + Micro，边界失控 | 总 token **-7.7%**，token 事件 **+33.3%** | 没有可靠收益；完整 diff audit、预算失败后重复重试、长期编辑都可能让流程更贵 |

修复后 OS+Micro 只用 2 轮完成，而其他组为 4 轮，因此它的总 token 优势不能当作严格同轮次对照。仅 OS 组实现最完整并通过全量测试；修复后 OS+Micro 组验证了运行时和工具纪律，但实现仍漏掉 profile 到 evict 的透传、全 index 过期统计和 dry-run projected 字段。当前证据支持 OS 在这类任务上达到生产可用，OS+Micro 则达到运行时合格，但仍依赖强验收测试保证实现完整。

### 2. Micro Provider 记账

Micro provider 消耗记录在 `.contextos/logs/micro-usage.jsonl`，与宿主 Codex usage 分开。修复后一次有界 preload 任务消耗 11,970 provider token；修复前 10 次调用共消耗 69,201 provider token。Provider usage 是本地记账，可能与 provider 账单不同。

### 3. 已知限制

- 本次真实验证只覆盖一个功能域和一个模型，上面的范围是方向性预期，不是通用保证。
- 总 token 包含缓存输入，不等于实际计费 token。
- 修复后组使用 2 轮，而其他组使用 4 轮，因此其总 token 优势不能当作严格同轮次对照。
- 本次没有配置 Micro provider 单价，estimated USD cost 没有实际意义。
- 修复前失败和修复后实现缺口都保留在文档中；它们说明 Micro 必须保持有界，任务验收必须覆盖完整行为链。

---

## 架构演进历史

ContextOS 会随着真实使用反馈主动修正架构方向：

- **0.4.x**：正则解析、Ghost Block 与 49 个工具的 MCP 面让架构记忆不可靠。
- **V2**：引入真实代码 Block、AST 可见性、SQLite + `graph.json` 双物化和正式开发治理。
- **意图级架构**：公开入口收敛为 `explore` / `inspect` / `change` / `verify` / `ship` / `ops`，编排下沉到 OS，模块信息从代码库自动派生。
- **2.5.0**：加固项目身份、发布升级链路、图谱同步、原子编辑和生命周期门禁。

完整取舍与历史弯路见 [DECISION.md](DECISION.md)。

---

## 开发者接入

```bash
git clone https://github.com/yubinbin32-ops/ContextOS.git
cd ContextOS
npm ci
npm test
npm run plugin:verify
npm run verify             # 完整发布门禁
npm run desktop:build      # macOS + Swift/Xcode
```

版本化的 `.contextos/graph.json` 是项目可移植的图谱投影。

[贡献指南](CONTRIBUTING.md) · [安全策略](SECURITY.md) · [MIT 协议](LICENSE)
