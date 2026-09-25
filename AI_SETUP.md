# ContextOS AI 自动化安装与自举指南 (AI-to-AI Setup Guide)

> [!IMPORTANT]
> **致正在阅读此指南的 AI 智能体（Codex / Claude Code / OpenCode / Cursor / Antigravity）**：
> 本文档是专门为您编写的**自举安装规范**。
> **核心原则：不要给用户输出繁琐的代码修改指引或命令，用户只做选择，由您（AI）在后台自动完成所有检测、下载、配置与注入！同时注意不要有兜底冗余，防止编辑器加载多个重复 Skill。**

---

## 总体执行决策树

```mermaid
graph TD
    Start([用户唤起 AI 安装指令]) --> Step0[Step 0: 系统与桌面端检测]
    Step0 -->|macOS| AskMacDesktop{询问是否安装 macOS 桌面端?}
    Step0 -->|Windows| AskWinDesktop{询问是否安装 Windows 桌面端?}
    Step0 -->|Linux| Step1[Step 1: 运行环境检测 Node >= 22]
    AskMacDesktop -->|选择 1: 是| InstallMacApp[自动下载部署 ContextOS.app] --> Step1
    AskMacDesktop -->|选择 2: 否| Step1
    AskWinDesktop -->|选择 1: 是| InstallWinApp[自动下载部署 Windows 桌面端] --> Step1
    AskWinDesktop -->|选择 2: 否| Step1
    Step1 --> Step2[Step 2: 平台探测与多选]
    Step2 --> AskPlatform{询问用户配置哪些编辑器?\n[1] Cursor [2] Codex [3] Claude Code\n[4] Antigravity [5] OpenCode [6] 全部}
    Step3 --> AskTeam{是否需要团队协同?\n[1] 单人开发 (本地模式)\n[2] 团队协同 (云端模式)}
    AskTeam -->|选择 1: 单人开发| InjectLocal[按需注入平台 & 初始化本地模式] --> Finish([完成！开启意图级开发循环])
    AskTeam -->|选择 2: 团队协同| CloudSetup[索取/配置 Cloudflare 凭据 & 初始化云端] --> Finish
```

---

## Step 0: 系统与桌面端检测 (OS & Client Inspection)

1. **AI 自检操作系统**：
   * 若当前操作系统为 **macOS**：
     * **向用户发起且仅发起此项选择**：
       ```text
       检测到您当前系统为 macOS。ContextOS 提供了原生架构图谱桌面端（ContextOS.app），支持实时地铁图拓扑交互。
       请选择：
       [1] 安装桌面端 + 插件（拥有可视化图谱与原生交互）
       [2] 仅安装插件（轻量命令行与 MCP 模式）
       ```
     * 若用户选择 `1`：
       * AI 自动下载最新 release 中的 `ContextOS-macos-full.zip`（或轻量版 `ContextOS-macos.zip`），解压并部署为 `/Applications/ContextOS.app`。
       * （提示用户：若首次打开提示未受信任的开发者拦截，可前往“系统设置 ➔ 隐私与安全性”点击“仍要打开”，或按住 Control 点击应用选择“打开”即可）。
     * 若用户选择 `2`：直接进入 Step 1。
   * 若当前操作系统为 **Windows**：
     * **向用户发起选择**：
       ```text
       检测到您当前系统为 Windows。ContextOS 现已推出官方 Windows 原生桌面端（支持 1:1 地铁图谱与编辑器集成）。
       请选择：
       [1] 下载安装 Windows 桌面端（推荐，带可视化拓扑与快捷设置）
       [2] 仅配置插件（轻量命令行与 MCP 模式）
       ```
     * 若用户选择 `1`：AI 下载并运行 `ContextOS_<version>_x64-setup.exe` 或解压 `ContextOS-windows-x64.zip`。
     * 若用户选择 `2`：直接进入 Step 1。
   * 若操作系统为 **Linux**：
     * 跳过桌面端提示，直接进入 Step 1。

---

## Step 1: 运行时环境自检 (Runtime Inspection)

1. **AI 检查 Node.js 环境**：
   * 执行 `node -v`。
   * **要求**：Node.js `>= 22.0.0`（ContextOS 原生依赖轻量级实验性 SQLite 驱动，需 Node 22+）。
   * **特殊情况**：若用户在 Step 0 中安装了 `ContextOS.app`，其内部已自带捆绑的 Node 二进制（位于 `/Applications/ContextOS.app/Contents/Resources/bin/node`），AI 可直接使用该路径，用户无需再单独安装 Node。
   * 若未安装且无 App：AI 提示用户一键执行 `brew install node` (macOS) 或使用安装包，随后继续。

---

## Step 2: 目标编辑器平台多选 (Target Platform Selection)

AI 先在后台探测用户电脑中实际安装的平台，然后向用户发起多选询问（**严禁未经确认无差别全部注入**）：

```text
检测到您的电脑上安装了以下主要编辑器平台：
[1] Cursor
[2] Codex
[3] Claude Code
[4] Antigravity
[5] OpenCode
[6] 全部配置

其他平台不在原生适配名单内。若用户使用其他宿主，AI 只配置 MCP 与 Skill，并明确标记为实验适配；不得恢复已删除的 Hook 层。
```

用户回复选择（例如 `1` 或 `1,2` 或 `6`），AI 记录目标平台列表（如 `cursor,codex`）。

Codex 使用 MCP + Skill；Claude Code、OpenCode、Cursor、Antigravity 在宿主级 smoke 证据完成前均视为实验功能。

---

## Step 3: 询问协作需求并按需配置 (Collaboration Mode & Injection)

AI 询问用户的实际开发需求：

```text
请确认您的项目协作需求：
[1] 单人开发（使用本地模式，数据存放于当前项目 .contextos/，离线运行）
[2] 团队协同（使用云端模式，通过 Cloudflare D1 进行多端与多人同步）
```

### 选项 1：单人开发（本地模式）
1. **AI 执行平台注入**：
   ```bash
   node scripts/bootstrap.mjs --platforms <选定平台>
   ```
2. **初始化当前项目**：
   * 调用 `ops({ capability: "system", action: "init", args: { projectRoot, mode: "local" } })`。
   * 不要传入固定 `projectId`；项目身份默认从 workspace 目录派生。只有明确采用旧项目状态时才使用迁移入口。
3. **完成反馈**：
   ```text
   🎉 ContextOS 已配置完成（本地单人开发模式）！
   - 已注入平台：<选定平台>
   - 存储路径：当前项目 .contextos/
   - 单一紧凑 `contextos` 传输工具（包含 explore/change/verify/ship/ops 动作）已就绪，即可开始日常开发。
   ```

### 选项 2：团队协同（实验性云端模式）

> Cloud Hub 仍为实验能力；除排障外优先使用本地模式。
1. **AI 引导配置云端凭据**：
   * 若当前环境已有全局凭据，直接复用；
   * 若尚无凭据，AI 提供 1-Click Cloudflare 部署链接：
     ```markdown
     👉 请点击下方链接，一键部署云端中枢至您的 Cloudflare 账户：
     https://deploy.workers.cloudflare.com/?url=https://github.com/yubinbin32-ops/ContextOS/tree/main
     
     💡 部署完成后，请将生成的 Worker 网址与 AUTH_TOKEN 发送给我。
     ```
   * 用户提供后，AI 执行 `node scripts/bootstrap.mjs --save-global-cloud --cloud-url "<URL>" --token "<TOKEN>"`。
   * Cloud Hub 默认关闭匿名访问：必须配置 `AUTH_TOKEN` Worker secret；只有在明确测试时才设置 `ALLOW_OPEN_ACCESS=true`。跨域访问需通过 `ALLOWED_ORIGINS` allowlist，不接受 URL query token。
2. **AI 执行平台注入与项目初始化**：
   ```bash
   node scripts/bootstrap.mjs --platforms <选定平台>
   ```
   * 调用 `ops({ capability: "system", action: "init", args: { projectRoot, mode: "cloud" } })`。
   * 同样不要固定 `projectId`；云同步使用从 workspace 派生的稳定身份。
3. **完成反馈**：
   ```text
   🎉 ContextOS 已配置完成（团队云端协同模式）！
   - 已注入平台：<选定平台>
   - 云端中枢：已连接至指定 Cloudflare Worker
   - 架构图谱将在团队多端间实时同步。
   ```

---

## Step 4: 配置 Micro 任务外接小脑 (可选双脑协同增强)

AI 向用户发起可选的 Micro 小脑配置询问：

```text
💡 ContextOS 支持接入 OpenAI 兼容的 Micro 任务子代理，用于在后台处理日志脱毒、契约提纯、诊断摘要等有界任务。
- 职责：作为可控的多轮小任务子代理，在独立会话中消化冗长日志、代码切片与诊断上下文，避免主对话上下文膨胀；
- 运行机制：会话状态保存在 `.contextos/micro-sessions/`，默认限制轮次和上下文，工具默认关闭，主上下文只接收最终结果与 receipt；会话带 TTL，跨进程写入使用锁，过期或陈旧任务不会无限占用后台资源；
- 成本边界：默认按 preset 限制 provider token；如需美元预算，可额外配置 `maxCostUsd`、`inputUsdPerMillion`、`outputUsdPerMillion`；
- 推荐：优先推荐 OpenCode Go 订阅作为低接入成本的托管端点，也支持 DeepSeek、本地 Ollama 等任意 OpenAI 格式接口；
- 不配置亦可正常使用核心功能。

请选择：
[1] 配置外接 Micro 小脑（推荐，拥有后台日志脱毒与契约提纯能力）
[2] 暂不配置（使用单脑模式，后续可随时配置）
```

若用户选择 `1`：
1. **AI 引导用户提供凭据**：
   ```text
   请提供您的微模型 API 接入信息（兼容任意 OpenAI 格式接口，如 OpenCode / DeepSeek / 本地 Ollama 等）：
   - API URL（如 https://opencode.ai/zen/go/v1 或 https://api.deepseek.com/v1）
   - Model 名称（如 deepseek-v4.1-flash 或 deepseek-chat）
   - API Key（支持输入密钥；本地免密服务可直接回车）
   - [可选] Session Header（默认 x-opencode-session）
   ```
2. **AI 在后台自动写入 `.contextos/profile.json`**：
   ```json
   {
     "micro": {
       "url": "<用户提供的 URL>",
       "model": "<用户提供的 Model>",
       "key": "<用户提供的 Key>",
       "sessionHeader": "x-opencode-session",
       "thinking": "low",
       "maxTokens": 1024,
       "maxProviderTokens": 8000,
       "requireBulkInput": false,
       "ttlMs": 86400000,
       "lockTimeoutMs": 2000,
       "timeoutMs": 30000,
       "maxTurns": 6,
       "maxContextChars": 24000
     }
   }
   ```
3. **AI 自动进行自检验证**：
   * 调用 `ops({ capability: "micro", args: { sessionAction: "create", sessionId: "setup-check", objective: "ping" } })`；
   * 调用 `ops({ capability: "micro", args: { sessionAction: "send", sessionId: "setup-check", task: "Reply with pong only." } })`；
   * 验证通过后向用户反馈（答案模式还会按 preset 上限自动收紧输出）：
     ```text
     🎉 Micro 任务子代理已成功挂载！
     - 诊断模型：<model>
     - 接口端点：<url>
     - 多轮会话状态：.contextos/micro-sessions/
     - 主上下文只接收最终结果与 receipt
     ```

---

## 平台注入规范与杜绝冗余原则：
1. **无 Hook 层**：ContextOS 只安装 MCP 配置与 Skill，不创建 `~/.contextos/hooks`，不写宿主 Hook 状态。
2. **单一证据路径**：路由、恢复和轮次纪律由 Skill 与 MCP 响应负责；仓库读写和验证仍必须经过 ContextOS MCP。
3. **Cursor / Antigravity / OpenCode**：注入对应编辑器的 MCP JSON 配置；同步唯一 Skill 到对应目录，杜绝重复 Skill 冗余。OpenCode 与 Antigravity 适配保持实验标记，直到有宿主级 smoke 证据。
4. **Codex（官方完整插件闭环）**：同步插件包至 `~/plugins/contextos`，注册 personal 市场并执行 `codex plugin add contextos@personal` 安装。**严禁在 `~/.codex/skills` 写入多余兜底**，安装成功后自动清理 `config.toml` 冗余条目。
5. **Claude Code**：配置 MCP 与 Skill，不生成重复的 Skill 副本。
6. **Claude Desktop**：仅写入 `claude_desktop_config.json`，不生成多余文件。

---

## 随时双向无损切换机制 (`ops system switch`)

无论初始选择哪种模式，后续开发过程中均可根据需要随时通过一句话无损切换：
* **本地 ➔ 云端**：用户说 *“把当前项目切换为云端协同模式”* ➔ AI 调用 `ops({ capability: "system", action: "switch", args: { projectRoot, targetMode: "cloud" } })`，本地所有 Block、Chain、Link、Plan、Task 自动完整推送到 Cloud Hub；
* **云端 ➔ 本地**：用户说 *“把当前项目切回本地开发”* ➔ AI 调用 `ops({ capability: "system", action: "switch", args: { projectRoot, targetMode: "local" } })`，云端最新快照自动落盘为本地 SQLite，后续完全离线运行。
