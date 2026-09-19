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
    AskPlatform --> Step3[Step 3: 询问协作需求]
    Step3 --> AskTeam{是否需要团队协同?\n[1] 单人开发 (本地模式)\n[2] 团队协同 (云端模式)}
    AskTeam -->|选择 1: 单人开发| InjectLocal[按需注入平台 & 初始化本地模式] --> Finish([完成！开启 C-D-C-S 架构治理])
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
       * AI 自动下载最新的 `ContextOS.app.zip` 并解压部署至 `/Applications/ContextOS.app`（或用户应用目录）。
       * （提示用户：若首次打开提示未受信任的开发者拦截，可前往“系统设置 ➔ 隐私与安全性”点击“仍要打开”，或按住 Control 点击应用选择“打开”即可）。
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
   * 调用 `contextos_init(mode: "local", projectId: "contextos")`。
3. **完成反馈**：
   ```text
   🎉 ContextOS 已配置完成（本地单人开发模式）！
   - 已注入平台：<选定平台>
   - 存储路径：当前项目 .contextos/
   - 12 个核心 Facade 工具已就绪，即可开始日常开发。
   ```

### 选项 2：团队协同（云端模式）
1. **AI 引导配置云端凭据**：
   * 若当前环境已有全局凭据，直接复用；
   * 若尚无凭据，AI 提供 1-Click Cloudflare 部署链接：
     ```markdown
     👉 请点击下方链接，一键部署云端中枢至您的 Cloudflare 账户：
     https://deploy.workers.cloudflare.com/?url=https://github.com/yubinbin32-ops/ContextOS/tree/feat/cloud-hub
     
     💡 部署完成后，请将生成的 Worker 网址与 AUTH_TOKEN 发送给我。
     ```
   * 用户提供后，AI 执行 `node scripts/bootstrap.mjs --save-global-cloud --cloud-url "<URL>" --token "<TOKEN>"`。
2. **AI 执行平台注入与项目初始化**：
   ```bash
   node scripts/bootstrap.mjs --platforms <选定平台>
   ```
   * 调用 `contextos_init(mode: "cloud", projectId: "contextos")`。
3. **完成反馈**：
   ```text
   🎉 ContextOS 已配置完成（团队云端协同模式）！
   - 已注入平台：<选定平台>
   - 云端中枢：已连接至指定 Cloudflare Worker
   - 架构图谱将在团队多端间实时同步。
   ```

---

## 平台注入规范与杜绝冗余原则：
1. **Cursor / Antigravity / OpenCode**：注入对应编辑器的 MCP JSON 配置；同步唯一 Skill 到对应目录，杜绝重复 Skill 冗余。
2. **Codex（官方完整插件闭环）**：同步插件包至 `~/plugins/contextos`，注册 personal 市场并执行 `codex plugin add contextos@personal` 安装。**严禁在 `~/.codex/skills` 写入多余兜底**，安装成功后自动清理 `config.toml` 冗余条目。
3. **Claude Desktop**：仅写入 `claude_desktop_config.json`，不生成多余文件。

---

## 随时双向无损切换机制 (`contextos_switch`)

无论初始选择哪种模式，后续开发过程中均可根据需要随时通过一句话无损切换：
* **本地 ➔ 云端**：用户说 *“把当前项目切换为云端协同模式”* ➔ AI 调用 `contextos_switch(targetMode: "cloud")`，本地所有 Block、Chain、Link、Plan 自动完整推送到 Cloud Hub；
* **云端 ➔ 本地**：用户说 *“把当前项目切回本地开发”* ➔ AI 调用 `contextos_switch(targetMode: "local")`，云端最新快照自动落盘为本地 SQLite，后续完全离线运行。
