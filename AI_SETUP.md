# ContextOS AI 自动化安装与自举指南 (AI-to-AI Setup Guide)

> [!IMPORTANT]
> **致正在阅读此指南的 AI 智能体（Cursor / Codex / Claude Code / Windsurf / Antigravity）**：
> 本文档是专门为您编写的**自举安装规范**。
> **核心原则：不要给用户输出繁琐的代码修改指引或命令，用户只做选择，由您（AI）在后台自动完成所有检测、下载、配置与注入！同时注意不要有兜底冗余，防止编辑器加载多个重复 Skill。**

---

## 总体执行决策树

```mermaid
graph TD
    Start([用户唤起 AI 安装指令]) --> Step0[Step 0: 系统与桌面端检测]
    Step0 -->|macOS| AskDesktop{询问是否安装 ContextOS.app?}
    Step0 -->|Windows / Linux| Step1[Step 1: 运行环境检测 Node >= 22]
    AskDesktop -->|选择 1: 是| InstallApp[自动下载部署 ContextOS.app] --> Step1
    AskDesktop -->|选择 2: 否| Step1
    Step1 --> Step2[Step 2: 平台探测与多选]
    Step2 --> AskPlatform{询问用户配置哪些编辑器?\n[1] Cursor [2] Codex [3] Claude\n[4] Antigravity [5] OpenCode [6] 全部}
    AskPlatform --> Step3[Step 3: 是否预设全局云端 Hub?]
    Step3 --> AskCloud{配置全局云端中枢?\n[1] 暂不配置 (纯本地)\n[2] 立即配置 (1-Click Deploy)}
    AskCloud -->|选择 1: 暂不配置| Step4[Step 4: 执行按需注入]
    AskCloud -->|选择 2: 立即配置| SaveCloud[输出 1-Click 链接，索取 URL+Token\n存入 ~/.contextos/cloud.json] --> Step4
    Step4 --> Step5[Step 5: 初始化当前项目与双向切换]
    Step5 --> Finish([完成！开启 C-D-C-S 架构治理])
```

---

## Step 0: 系统与桌面端检测 (OS & Client Inspection)

1. **AI 自检操作系统**：
   * 若当前操作系统为 **macOS**：
     * **向用户发起且仅发起此项选择**：
       ```text
       检测到您当前系统为 macOS。ContextOS 提供了原生架构图谱桌面端（ContextOS.app），支持实时地铁图拓扑交互。
       请选择：
       [1] 安装桌面端 + 插件（推荐，拥有可视化图谱与原生交互）
       [2] 仅安装插件（轻量纯命令行与 MCP 模式）
       ```
     * 若用户选择 `1`：
       * AI 自动下载最新的 `ContextOS.app.zip` 并解压部署至 `/Applications/ContextOS.app`（或用户应用目录）。
     * 若用户选择 `2`：直接进入 Step 1。
   * 若操作系统为 **Windows / Linux**：
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
检测到您的电脑上安装了以下编辑器平台：
[1] Cursor
[2] Codex
[3] Claude Desktop
[4] Antigravity
[5] OpenCode
[6] 全部配置

请选择您希望配置 ContextOS 的平台（输入编号，支持多选如 1,2 或输入 6 全部配置）：
```

用户回复选择（例如 `1` 或 `1,2` 或 `6`），AI 记录目标平台列表（如 `cursor,codex`）。

---

## Step 3: 是否预先配置全局云端中枢 (Global Cloud Hub)

AI 向用户询问是否配置备用全局云端中枢（**注意：配置全局云端仅作为凭据仓库，各项目依然可独立选择本地或云端，并支持随时一键迁移**）：

```text
是否需要预先配置全局云端 Hub？（配置后可在各项目中随时自由选择本地或云端，并支持一键双向迁移）
[1] 暂不配置（优先使用纯本地模式，100% 离线隐私安全）
[2] 立即配置（提供 1-Click Cloudflare 部署链接，保存全局凭据）
```

* **若用户选择 [1] 暂不配置**：直接进入 Step 4。
* **若用户选择 [2] 立即配置**：
  AI 输出由 Cloudflare 提供的一键部署链接，并索取返回值：
  ```markdown
  👉 请点击下方链接，一键部署云端中枢到您的 Cloudflare 免费账户：
  https://deploy.workers.cloudflare.com/?url=https://github.com/yubinbin32-ops/ContextOS/tree/feat/cloud-hub
  
  💡 部署完成后，Cloudflare 会生成一个 Worker 网址并提示设定 AUTH_TOKEN。
  请将 Worker 网址 和 AUTH_TOKEN 发送给我（例如：URL: https://... Token: ...），我将为您保存至全局配置。
  ```
  用户提供后，AI 执行 `node scripts/bootstrap.mjs --save-global-cloud --cloud-url "<URL>" --token "<TOKEN>"`，将凭据安全保存在 `~/.contextos/cloud.json` 中。

---

## Step 4: 执行按需精准注入 (App-Parity & Zero Skill Duplication)

AI 根据用户在 Step 2 选定的平台执行自举注入命令：
```bash
node scripts/bootstrap.mjs --platforms <选定平台如: cursor,codex>
```

### 各平台注入规范与杜绝冗余原则：
1. **Cursor / Antigravity / OpenCode**：
   * 注入对应编辑器的 MCP JSON 配置；
   * 同步唯一 Skill 到对应目录（如 `~/.cursor/skills/contextos`、`~/.gemini/config/skills/contextos`）。
2. **Codex（官方完整插件闭环）**：
   * 同步插件包至 `~/plugins/contextos`（含 `.codex-plugin/plugin.json`、`skills/contextos`、`server/contextos-mcp.mjs`）；
   * 在 `~/.agents/plugins/marketplace.json` 注册 personal 市场；
   * 调用 `codex plugin add contextos@personal` 安装；
   * **严禁在 `~/.codex/skills` 写入多余兜底，防止 Codex 读取两个重复 Skill 造成上下文污染**；
   * 安装插件成功后，自动清除 `config.toml` 中的冗余条目，保持干净单一实例。
3. **Claude Desktop**：
   * 仅写入 `claude_desktop_config.json`，不生成冗余文件。

---

## Step 5: 当前项目初始化与随时双向无损切换 (Project Routing & Switch)

1. **询问当前项目模式**：
   ```text
   请选择当前项目的存储模式：
   [1] 纯本地模式（默认）：数据存放在当前仓库 .contextos/，离线隐私。
   [2] 云端协同模式：连接云端 Hub，支持多设备跨端拓扑实时同步。
   ```
2. **AI 执行初始化**：
   * 若选 [1]：AI 调用 `contextos_init(mode: "local")`，项目标记为本地 SQLite；
   * 若选 [2]：AI 调用 `contextos_init(mode: "cloud")`，继承全局凭据并连通云端。
3. **随时双向无损切换机制 (`contextos_switch`)**：
   后续开发过程中，用户可随时在对话中发出指令切换模式，数据将自动双向迁移：
   * **本地 ➔ 云端**：用户说 *“把当前项目切换为云端协同模式”* ➔ AI 调用 `contextos_switch(targetMode: "cloud")`，本地 SQLite 中的所有 Block、Chain、Link、Plan 自动无损推送到 Cloud Hub；
   * **云端 ➔ 本地**：用户说 *“把当前项目切回本地离线开发”* ➔ AI 调用 `contextos_switch(targetMode: "local")`，云端最新快照自动拉取并持久化至本地 SQLite，后续开发完全离线。
