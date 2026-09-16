<div align="center">
  <img src="assets/logo.png" width="76" alt="ContextOS" />
  <h1>AI 编码的高精度外骨骼动力装甲</h1>
  <p><strong>通过 MCP 自动管理上下文，实测减少 90%+ 上下文开销。</strong></p>
  <p>解决大项目上下文挤爆与记忆遗忘：以手术刀级 AST 读写代替盲读长文件，以脱敏沙箱隔绝终端日志，以地铁图谱让 AI 秒懂架构。</p>
  <p><a href="https://github.com/yubinbin32-ops/ContextOS/releases/latest"><strong>下载 macOS App</strong></a> · <a href="#三分钟开始使用">三分钟开始使用</a> · <a href="README.md">English</a></p>
  <p>
    <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/yubinbin32-ops/ContextOS/tree/main" target="_blank">
      <img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare Workers" />
    </a>
  </p>
</div>

![ContextOS 交互工作流演示](assets/contextos-demo.gif)

## ContextOS 解决什么问题？

**ContextOS 就像为 AI 编码助手穿上一套高精度外骨骼动力装甲**：
以往让 AI 参与大型项目开发，AI 必须肉身背负海量源文件、全量终端日志和冗长规范，导致“走两步就喘”——上下文窗口迅速挤爆、产生幻觉并遗忘前置决议。

有了 ContextOS，AI 不再需要背负笨重的全量上下文行走，而是**通过 MCP 自动管理上下文**：
1. **外骨骼精准借力**：通过编译器级 AST 手术刀工具，按需读写关键符号与代码块，杜绝盲读长文件；
2. **终端噪声舱外隔绝**：运行日志安全存盘落入沙箱，仅向上下文回传精简诊断回执，剥离 98% 无关噪声；
3. **全局神经图谱联通**：以地铁图谱（Metro Map）统合沉淀架构记忆与 C-D-C-S 任务流，开箱即懂系统全貌。

**实测在复杂项目开发中，能够直接减少 90%+ 的无谓上下文开销**，彻底告别上下文挤爆与遗忘，让每一次对话都能平滑承接工程进展。

![ContextOS V2 Metro Map 地铁路线图架构与桌面端实景](docs/images/contextos-desktop-v2.png)

## 它带来的核心开发变化

### 1. 架构化身地铁路线图 (Metro Map)
Block 描述真实的物理代码能力（杜绝虚空 Ghost Block）。Chain 代表水平平行的地铁铁轨，带类型的 Link 形成正交的跨线换乘。AI 一眼看清系统骨架，无需盲读代码。

![功能链与精确 AST 代码定位](assets/path-impact.png)

### 2. 进度遵循 C-D-C-S 严格生命周期
开发严格按照 **Create（创建任务）→ Develop（手术刀开发）→ Check（验证沉淀）→ Sync（原子写回）** 节拍流转。任务携带上下文切片与中间思考，并在 Sync 时触发 **100% 工作区覆盖率门禁**。

### 3. 命令运行出舱脱敏 (Out-of-Context Execution)
`run_command` 剥离 ANSI 终端控制符与敏感密钥，全量原始日志存盘于 `.contextos/logs/`，仅向上下文返回精简回执（Receipt），削减 98% 以上的终端输出噪声。

### 4. 代码工具手术刀级读写 (Surgical Code Engineering)
集成编译器级真 AST 引擎（原生支持 JS/TS/JSX/TSX、Python、Swift、Java、Kotlin、C/C++、C#、Go、Rust、PHP、Ruby 等 10+ 种主流语言），支持 VS Code 风格全局符号搜索、大纲审视、方法级抽取和补丁式精准写盘并自动重锚。

### 5. 单一入口的知识与架构决议
项目方案、设计取舍与规则规约归纳为单文件叙事 `DECISION.md` 与分类 Rules。`README.md` 与 `README_zh.md` 在 App 的知识抽屉中以只读方式直接预览。

![OS 文档和 README 的知识抽屉](assets/knowledge-reader.png)

### 6. 长期运行进程常驻监控
通过守护进程托管 Dev Server、Watcher 与后台 Worker，在桌面端左下角实时监控 PID、端口号与生命周期，支持一键安全释放进程树。

![节点抽屉与详情查看](assets/readme-reader.png)

## 三分钟开始使用

ContextOS 提供灵活的运行方式，满足不同开发环境的需求：

### 方式 A：macOS 桌面端（可视化架构与一键配置）

从 [GitHub Releases 最新发布页](https://github.com/yubinbin32-ops/ContextOS/releases/latest) 下载对应安装包：

| 安装包版本 | 压缩包文件 | 体积 | Node.js 依赖 | 适用场景 |
|---|---|---|---|---|
| **完整版 (Full)** *(推荐)* | `ContextOS-macos-full.zip` | 约 35 MB | **零依赖**（内置独立 Node 22） | 电脑未安装 Node 或追求纯傻瓜式开箱即用 |
| **轻量原版 (Standard)** | `ContextOS-macos.zip` | 约 1.6 MB | 需系统已有 Node.js 22+ | 本地已有 Homebrew/nvm Node 环境的开发者 |

#### 极速配置流程：
1. 解压下载的压缩包，将 **ContextOS.app** 拖入 `Applications`（应用程序）目录。
2. 打开 **ContextOS**，进入 **设置**（齿轮图标或快捷键 `Cmd+,`），选择检测到的 AI 编辑器（Cursor / Claude Desktop / Antigravity / OpenCode / Codex 等），点击 **一键安装 / 同步插件**。
3. App 会自动将 MCP 配置及对应运行路径注入编辑器。**配置完成后，你可以随时关闭桌面 App，平时无需保持开启**。
4. 在编辑器对话中只需一句话唤醒 ContextOS 协作：
   > **“把这个方案写入 ContextOS 后开始执行”** 或 **“查看 ContextOS 继续开发”**

   AI 即会自动通过 ContextOS 渐进式管理方案、执行 C-D-C-S 任务闭环、手术刀读写代码、生成脱敏命令回执并自动回收常驻进程。

![一键同步编辑器和 MCP](assets/settings-sync.png)

### 方式 B：轻量纯插件流（针对纯终端 / Linux / 无头环境，无需桌面 App）

> [!NOTE]
> **适合不想下载桌面 App、在远程服务器、容器环境或纯 CLI 模式下开发的开发者。**
> 插件包极度轻量（仅数十 KB），可直接通过 Codex 插件市场安装或直接使用 `npx` 启动。
> **前提环境要求**：由于纯插件直接在宿主环境运行，**需要你的系统已安装 Node.js 22 或以上版本**。

```bash
# 纯命令行直接启动 MCP 服务
npx -y github:yubinbin32-ops/ContextOS
```

### 方式 C：一键部署 ContextOS 云端中枢（Windows / 云端协作 / HTTP 远程 MCP 推荐）

> [!TIP]
> **适用人群：**
> 1. **Windows 用户**：桌面端 App 为 macOS 原生设计。Windows 用户无需桌面 App，直接部署云端中枢并通过 **HTTP/SSE 远程 MCP** 直连，拥有 100% 的上下文削减与 C-D-C-S 交付外骨骼能力，无需本地启动 Node 后台。
> 2. **云端协作与多设备用户**：跨多台电脑、团队成员之间秒级同步空间拓扑图与验收计划。
> 3. 借助 Cloudflare Workers + D1（边缘 SQLite），无需购买或配置服务器，**纯网页点击 60 秒内拥有永久免费的专属私有云端中枢**。

#### 1. 网页一键部署
点击下方按钮，Cloudflare 会自动在你的账户中免费创建 D1 数据库并部署 Worker：

<p>
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/yubinbin32-ops/ContextOS/tree/feat/cloud-hub" target="_blank">
    <img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare Workers" />
  </a>
</p>

*直接部署链接：* [https://deploy.workers.cloudflare.com/?url=https://github.com/yubinbin32-ops/ContextOS/tree/feat/cloud-hub](https://deploy.workers.cloudflare.com/?url=https://github.com/yubinbin32-ops/ContextOS/tree/feat/cloud-hub)

#### 2. 获取云端 URL 与配置鉴权 Token
1. **获取 URL**：部署完成后，在 Cloudflare Workers 控制台概览页直接复制你的专属域名（例如 `https://contextos-cloud.<your-subdomain>.workers.dev`）。
2. **配置私有 Token（安全性）**：
   - 在 Cloudflare 控制台进入 **Workers & Pages** -> 点击进入 **`contextos-cloud`**；
   - 点击 **设置 (Settings)** -> **变量和机密 (Variables and Secrets)**；
   - 点击 **添加 (Add)**：
     - **变量名称**：`AUTH_TOKEN`
     - **变量值**：自行设置的私密密钥（例如 `sk_ctx_12345678`）。
     - *(注：若未配置 `AUTH_TOKEN`，中枢将处于开放访问模式，方便快速体验)。*

#### 3. 通过 HTTP 直连 MCP（Cursor / Windsurf / Claude Desktop）
无需本地运行 Node 脚本！在 AI 编辑器中配置标准 HTTP / SSE 类型的远程 MCP 服务：

##### 在 Cursor / Windsurf / Claude Desktop (`mcp.json`)：
```json
{
  "mcpServers": {
    "contextos": {
      "url": "https://contextos-cloud.<your-subdomain>.workers.dev/sse",
      "headers": {
        "Authorization": "Bearer <YOUR_TOKEN>"
      }
    }
  }
}
```
*(在 Cursor 中操作：打开 **Settings -> Features -> MCP -> Add Server**，Type 选择 `SSE`，输入 URL `.../sse`，并在 Headers 中填入 `Authorization` 即可)*。

##### 备用方式：本地 STDIO 桥接（针对仅支持本地命令行运行的 CLI）：
```json
{
  "mcpServers": {
    "contextos": {
      "command": "node",
      "args": ["./plugins/contextos/server/contextos-mcp.mjs"],
      "env": {
        "CONTEXTOS_MODE": "cloud",
        "CONTEXTOS_CLOUD_URL": "https://contextos-cloud.<your-subdomain>.workers.dev",
        "CONTEXTOS_CLOUD_TOKEN": "<YOUR_TOKEN>",
        "CONTEXTOS_PROJECT_ID": "my-project"
      }
    }
  }
}
```

#### 4. 在桌面 App 左上角一键连接同步
如果你使用 macOS 桌面 App：
1. 打开 ContextOS，点击左上角项目切换菜单 -> **“连接到云端 MCP 项目…”**；
2. 输入 **云端中枢 URL**（`https://contextos-cloud.<your-subdomain>.workers.dev`）、**项目标识** 以及可选的 **Auth Token**；
3. 点击 **连接并同步**，全套空间架构图与计划状态秒级加载呈现，随时双向同步！

## 实测 V2 上下文节省基准

在自我托管的 ContextOS V2 自身代码库（18 Blocks, 3 Chains, 18 Links, 49 源码文件，100% 覆盖率）测定：

| 研发环节 | 传统开发交互（非推荐，消耗大） | ContextOS V2 渐进式最佳实践 | 节省比率 |
|---|---|---|---:|
| **会话启动 (Bootstrap)** | 全量加载架构与图谱 (61,902 字符 / ~15,476 tokens) | 渐进式 L0-L1 Markdown (1,987 字符 / ~497 tokens) | **96.79%** |
| **代码大纲审视** | 盲读 4 个核心全量源码 (34,045 字符 / ~8,512 tokens) | AST 符号大纲提取 (4,374 字符 / ~1,093 tokens) | **87.15%** |
| **代码阅读与查阅** | 逐文件展开全部代码 (34,045 字符) | 手术刀提取目标方法 (6,898 字符) | **79.74%** |
| **命令运行与构建** | 终端原始输出 (16,713 字符 / ~4,179 tokens) | 精简回执 + 失败提取 (251 字符 / ~63 tokens) | **98.50%** |
| **单任务全流程综合** | **129,373 字符 (~32,344 tokens)** | **13,761 字符 (~3,441 tokens)** | **89.36% (节省 28,903 tokens)** |

本地运行基准验证：

```bash
node scripts/benchmark.mjs
node scripts/practical-test.mjs
node scripts/e2e-project-lifecycle.mjs
node scripts/comprehensive-dev-eval.mjs
```

## 开发者接入

```bash
git clone https://github.com/yubinbin32-ops/ContextOS.git
cd ContextOS
npm ci
npm test
npm run plugin:verify
npm run desktop:build       # macOS + Swift/Xcode
```

版本化的 `.contextos/graph.json` 是项目可移植的图谱投影。

[贡献指南](CONTRIBUTING.md) · [安全策略](SECURITY.md) · [MIT 协议](LICENSE)
