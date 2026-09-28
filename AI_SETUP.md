# ContextOS 全智能体自动化自举与配置指南 (AI-to-AI Setup Guide)

> [!IMPORTANT]
> **致正在阅读此指南的 AI 智能体（Codex / Claude Code / Cursor / Antigravity / OpenCode 等）**：
> 本文档是专门为您编写的**自动化自举安装规范**。
> **核心原则**：
> 1. 不要给用户输出繁琐的终端命令或手动修改指引，用户只做选择题，由您（AI）在后台自动完成环境检测、下载部署、MCP 注入与自检！
> 2. 避免冗余兜底，防止为宿主加载重复 Skill。
> 3. 目前 **Codex 平台**已原生适配官方插件一键闭环；**其他平台**（Cursor、Claude Code、Antigravity、OpenCode 等）需由 AI 根据下文规范检测并自动注入 MCP 与 Skills。

---

## 总体安装执行决策树

```mermaid
graph TD
    Start([用户唤起: 请帮我安装配置 ContextOS]) --> Step1[Step 1: 环境探测与版本推荐]
    Step1 -->|macOS / Windows| AskDesktop{推荐安装原生桌面端?}
    Step1 -->|Linux| Step2[Step 2: 目标编辑器平台探测与注入]
    AskDesktop -->|选择 1: 安装桌面端| DeployApp[自动下载部署桌面 App ContextOS] --> Step2
    AskDesktop -->|选择 2: 纯插件模式| Step2
    Step2 --> AskCloud{Step 3: 询问是否配置云端协同?\n[1] 本地模式 (推荐)\n[2] 云端协同 (测试中)}
    AskCloud -->|选择 1: 推荐本地| AskMicro
    AskCloud -->|选择 2: 云端协同| SetupCloud[引导配置 Cloudflare Worker] --> AskMicro
    AskMicro{Step 4: 询问是否配置 Micro 外接小脑?\n[1] 配置 Micro (推荐)\n[2] 暂不配置}
    AskMicro -->|选择 1: 推荐配置| SetupMicro[写入 profile.json 并通过 ping 自检] --> Step5[Step 5: Doctor 全局自检]
    AskMicro -->|选择 2: 跳过| Step5
    Step5 --> Finish([配置完成！输出就绪看板])
```

---

## Step 1: 环境探测与推荐类型 (Environment Inspection & Recommendation)

AI 在后台先检测当前操作系统与 Node 环境，然后向用户发起**精准推荐询问**：

1. **若当前系统为 macOS**：
   ```text
   检测到您当前系统为 macOS (Apple Silicon / Intel)。
   ContextOS 提供了官方原生的架构地铁图桌面端（ContextOS.app），支持实时架构可视化拓扑与一键插件同步。
   
   请选择您期望的安装方式：
   [1] 安装官方桌面端 + 插件（推荐 ⭐⭐⭐⭐⭐，内置独立 Node 22 零依赖，拥有可视化地铁图）
   [2] 仅安装 AI 插件（轻量模式，直接为当前编辑器注入 ContextOS MCP 与 Skills）
   ```
   - 若用户选择 `[1]`：AI 自动从 GitHub Releases 下载 `ContextOS-macos-full-arm64.zip`（或 `x64`），解压部署为 `/Applications/ContextOS.app`。
     *(提示用户：若首次打开提示“未受信任的开发者”，前往“系统设置 ➔ 隐私与安全性”点击“仍要打开”，或右键点击应用选择“打开”即可)*。
   - 若用户选择 `[2]`：直接进入 Step 2。

2. **若当前系统为 Windows**：
   ```text
   检测到您当前系统为 Windows。
   ContextOS 现已推出官方 Windows 原生桌面端，支持 1:1 地铁图谱与编辑器快捷集成。
   
   请选择：
   [1] 下载安装 Windows 桌面端（推荐 ⭐⭐⭐⭐⭐，带可视化拓扑与快捷设置）
   [2] 仅安装 AI 插件（轻量模式，仅注入当前编辑器 MCP）
   ```
   - 若用户选择 `[1]`：AI 引导下载 `ContextOS_<version>_x64-setup.exe` 或解压 `ContextOS-windows-x64.zip`。
   - 若用户选择 `[2]`：直接进入 Step 2。

3. **若当前系统为 Linux**：
   - 跳过桌面端询问，直接进入 Step 2（轻量 CLI / MCP 模式）。

---

## Step 2: 目标编辑器探测与平台注入 (Target Platform Injection)

AI 在后台自检已安装的编辑器环境，并向用户确认注入目标：

```text
检测到您的电脑上安装了以下编辑器平台：
[1] Codex (已官方原生适配插件闭环)
[2] Cursor
[3] Claude Code / Claude Desktop
[4] Antigravity
[5] OpenCode
[6] 全部配置
```

用户回复编号后，AI 执行注入逻辑：
1. **Codex（官方完整插件闭环）**：
   - 同步插件包至 `~/plugins/contextos`；
   - 注册个人市场并在后台执行 `codex plugin add contextos@personal`；
   - 安装完成后自动清理 `config.toml` 冗余项，杜绝重复 Skill 冗余。
2. **其他平台（Cursor / Claude / Antigravity / OpenCode 等）**：
   - AI 运行自带自举脚本：
     ```bash
     node scripts/bootstrap.mjs --target-root <当前项目根目录> --platforms <用户选定的平台列表>
     ```
   - 脚本会自动将单一紧凑 `contextos` MCP 服务器配置写入对应配置（如 Cursor `mcp.json`、Antigravity `mcp_config.json` 等），并将 `contextos` 与 `contextos-ops` 技能同步至对应 skills 目录。

---

## Step 3: 询问是否配置 Cloud 协同 (Cloud Collaboration Inquiry)

AI 向用户发起存储模式确认，并客观说明两者的价值与当前状态：

```text
请确认当前项目的存储与协作模式：

[1] 单人开发·本地模式（强烈推荐 ⭐⭐⭐⭐⭐）
    - 价值与意义：架构数据保存在项目目录 .contextos/state.sqlite，0 毫秒网络延迟，100% 离线、私密、稳定。
    - 状态说明：生产就绪，最可靠的开发模式。如无团队多人协同需求，推荐且无需配置云端。

[2] 团队协同·云端模式（实验公测中 ⚠️）
    - 价值与意义：通过 Cloudflare D1 边缘数据库，在团队多成员或跨设备之间实时同步架构拓扑与进度。
    - 状态说明：目前处于公测阶段，接口与稳定性仍在持续迭代。需要配置 Cloudflare Worker。
```

- **若用户选择 `[1]`（推荐）**：
  AI 初始化本地模式：
  `ops({ capability: "system", action: "init", args: { projectRoot, mode: "local" } })`。
- **若用户选择 `[2]`**：
  1. AI 提示用户一键部署 Cloudflare Worker：
     ```text
     👉 请点击下方链接，一键部署云端中枢至您的 Cloudflare 账户：
     https://deploy.workers.cloudflare.com/?url=https://github.com/yubinbin32-ops/ContextOS/tree/main
     
     💡 部署完成后，请将生成的 Worker URL 与 AUTH_TOKEN 发送给我。
     ```
  2. 用户提供后，AI 执行：
     `node scripts/bootstrap.mjs --save-global-cloud --cloud-url "<URL>" --token "<TOKEN>"`
     并调用 `ops({ capability: "system", action: "init", args: { projectRoot, mode: "cloud" } })`。

*(提示：后续任意时刻，用户均可对 AI 说“把当前项目切换为云端协同”或“切回本地模式”进行无损切换)*。

---

## Step 4: 询问是否配置 Micro 外接小脑 (Micro Dual-Brain Inquiry)

AI 向用户发起 Micro 外接小脑配置询问，清晰解释其意义与成本控制：

```text
💡 ContextOS 支持接入 OpenAI 兼容的 Micro 任务子代理（双脑协同）：

- 价值与意义（为什么强烈推荐配置？⭐⭐⭐⭐⭐）：
  在长程编码中，单测跑挂时经常抛出数万字符的终端报错堆栈。如果直接回传给主模型，会导致主会话上下文急剧膨胀，迅速引发注意力稀释与幻觉。
  Micro 作为舱外轻量任务子代理，独立在后台将会话日志、报错堆栈进行脱毒和提纯，只向主模型返回几行核心结论（Receipt），不仅大幅降低 Token 消耗，更能显著提高长程任务的稳定性。
- 适用模型：
  兼容任意 OpenAI 格式端点。推荐接入超低成本的高速模型（如 OpenCode Go 订阅、DeepSeek deepseek-chat 或本地免费的 Ollama）。
- 成本边界：
  默认限制单次请求与上下文长度，主上下文只接收精炼结论。不配置亦可正常使用核心功能。

请选择：
[1] 配置 Micro 外接小脑（强烈推荐 ⭐⭐⭐⭐⭐，拥有后台日志脱毒与契约提纯能力）
[2] 暂不配置（使用单脑模式，后续可随时通过对话唤起配置）
```

- **若用户选择 `[1]`**：
  1. AI 索取凭据（本地免密服务可直接回车）：
     - API URL（如 `https://api.deepseek.com/v1` 或 `https://opencode.ai/zen/go/v1` 或 `http://localhost:11434/v1`）
     - Model 名称（如 `deepseek-chat` 或 `deepseek-v4.1-flash`）
     - API Key
  2. AI 写入 `.contextos/profile.json`：
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
         "timeoutMs": 30000,
         "maxTurns": 6,
         "maxContextChars": 24000
       }
     }
     ```
  3. AI 调用自检：
     - `ops({ capability: "micro", args: { sessionAction: "create", sessionId: "setup-check", objective: "ping" } })`
     - `ops({ capability: "micro", args: { sessionAction: "send", sessionId: "setup-check", task: "Reply with pong only." } })`
- **若用户选择 `[2]`**：直接进入 Step 5。

---

## Step 5: 全局自检 (Doctor) 与完成反馈

AI 调用 MCP `doctor` 验证整体状态：
```javascript
contextos({
  action: "ops",
  args: { capability: "system", action: "doctor" },
  projectRoot: "<当前项目绝对路径>"
})
```

确认 Node 运行时、存储模式、已注入平台全部正常后，向用户输出清爽的就绪卡片：

```text
🎉 ContextOS 自动化配置已完成！

- 运行状态：🟢 正常就绪 (Node 22+)
- 存储模式：<本地模式 (Local) 或 云端协同 (Cloud)>
- 外部小脑：<已挂载 (Model: ...) 或 暂未配置>
- 已注入平台：<Cursor / Codex / Antigravity / ...>
- 管理副技能：已同步 contextos-ops（随时可唤起诊断、切换模式或配置 Micro）

💡 现在您可以直接开始编码：
- "请阅读项目并梳理当前架构"
- "探索并实现 XXX 功能"
- "运行 doctor 检查环境"
```
