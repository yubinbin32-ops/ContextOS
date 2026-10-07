# 为我安装 ContextOS

用户只需在 AI 编程工具中说：

> 读取 (https://github.com/yubinbin32-ops/ContextOS/blob/main/setup.md) ，为我安装OS

以下是给安装智能体的执行协议。你负责检测、获取、安装、配置、注册、调试和验收；不要把下载 Release、手写 JSON 或编写 adapter 的工作交还给用户。优先复用现有有效配置。只有 API 凭据缺失、账号登录、付费选择或宿主明确要求授权时才需要用户操作；遇到这一项时先完成其余可完成的工作，再说明具体缺项。

**版本契约：此指南要求 ContextOS 3.0.0 或更新版本。3.0.0 正在准备发布；旧版 Release 或旧版 main 不满足本指南，不可宣称已安装 3.0.0。** 核心 OS 与 API Micro 是安装必需项；CLI 适合复杂实现任务，可以随后增加，但用户要求配置 CLI 时必须完成下述独立验收。

## 1. 确定目标和版本

1. 识别用户当前项目的绝对路径、操作系统、架构、AI 宿主及现有 CLI。不要把 ContextOS 源码目录误当成用户项目。
2. 检查 Node.js 22+、Git 和 npm；使用实际可执行文件的绝对路径。缺少 Node 时由 AI 从 [Node.js 官方渠道](https://nodejs.org/en/download) 安装适合系统的版本。macOS/Windows App 只在真实发布产物可用时安装；Linux 使用 MCP/源码路线。
3. 查询 [GitHub Releases API](https://api.github.com/repos/yubinbin32-ops/ContextOS/releases)，读取每个 release 的 `tag_name`、`draft`、`prerelease`、`assets[].name` 和下载 URL。默认选择最新稳定的、满足版本契约的版本；测试预发布需明确记录所选 ref。**不要拼接未经查询的 App zip/exe 名称、假设存在 v3.0.0，或把 latest 的 v2.x 当成 3.0。**
4. 如果对应版本和平台有完整发布产物，AI 下载、校验随包校验和、解压并安装。服务器必须包含 bundle、`web-tree-sitter.wasm`、`grammars/` 和两个技能。
5. 无合适产物时，AI 克隆官方源码到独立安装目录（例如 `~/.contextos/source`），获取并检出已确认的 tag/ref；检查 `package.json.version` 和提交 SHA。仅当 main 已满足 3.0.0 契约时才可使用 main。如果公开 main 和 Releases 都还是 2.x，报告“3.0.0 尚未发布”，不要悄悄降级。发布准备测试可以使用用户提供的本地候选 worktree，但最终报告必须标明“本地候选，未公开发布”。

以下命令由 AI 执行；尖括号占位符必须替换为实际绝对路径/已验证 ref，不是让用户复制填写：

```bash
git clone https://github.com/yubinbin32-ops/ContextOS.git "<安装源码目录>"
git -C "<安装源码目录>" checkout "<已验证 tag 或 ref>"
```

在安装源码目录中执行：

```bash
npm ci
npm run plugin:build
npm run version:check
npm run dist:smoke
```

记录版本、SHA、操作系统、架构、Node 版本和所选安装路线。不要将下载成功、构建成功等同于宿主已加载成功。

## 2. 注册宿主和安装技能

先读取目标宿主的官方 MCP/插件文档及本机 `--help`。备份既有配置，并合并 ContextOS 配置，保留其他插件、模型、MCP 和权限。

在安装源码目录执行 bootstrap，选中实际使用的宿主，不使用隐式全平台安装：

```bash
node scripts/bootstrap.mjs --target-root "<用户项目绝对路径>" --platforms "<宿主 id>" --dry-run
node scripts/bootstrap.mjs --target-root "<用户项目绝对路径>" --platforms "<宿主 id>"
```

宿主 id：`codex`、`cursor`、`claude-code`、`claude`（Desktop）、`antigravity`、`opencode`、`generic`。多个宿主用逗号分隔。显式选择可以初始化干净用户目录；`--all` 只处理检测到的平台，只有用户要求全平台时才使用。

bootstrap 会把服务器部署到 `~/.contextos/server/contextos-mcp.mjs`（或 `CONTEXTOS_HOME/server/`），同时复制 parser WASM 和 `CONTEXTOS_HOME/grammars/`。通用 MCP 配置在 `CONTEXTOS_HOME/mcp.json`；AI 应导入到宿主的真实配置，不能只创建此文件后宣称连接完成。

服务器统一使用 stdio：

```json
{
  "command": "<Node 22+ 绝对路径>",
  "args": ["--no-warnings=ExperimentalWarning", "<ContextOS Home>/server/contextos-mcp.mjs"]
}
```

两个技能都要安装：`plugins/contextos/skills/contextos` 和 `plugins/contextos/skills/contextos-ops`。不要把 SKILL.md 的 YAML 改成无引号的含冒号描述。

- **Codex**：bootstrap 优先安装官方本地插件 `contextos@personal`，用本机 `codex plugin list --json` 验证；插件版本不支持时退回 `config.toml` MCP + `~/.agents/skills/` 两个技能。两条路线选择一条，避免重复服务器。Codex 配置遵循 `CODEX_HOME`。官方：[MCP](https://developers.openai.com/codex/mcp)、[Skills](https://developers.openai.com/codex/skills)、[非交互执行](https://developers.openai.com/codex/noninteractive)。
- **Claude Code**：使用其 [MCP 官方配置](https://code.claude.com/docs/en/mcp) 和 [Skills](https://code.claude.com/docs/en/skills)，确认 `claude mcp list`、技能目录和项目授权。不要把 Desktop 的配置文件当成 CLI 配置。
- **Antigravity / AGY**：根据 [安装和认证](https://www.antigravity.google/docs/cli/install/)、[MCP](https://www.antigravity.google/docs/mcp?tab=cli)、[Headless](https://www.antigravity.google/docs/cli/headless/) 注册实际版本的 MCP 和技能。当前技能目录为 `~/.gemini/antigravity-cli/skills/`；只更新已存在的 legacy 目录，不新增废弃路径。
- **OpenCode**：根据安装版本读取 [MCP](https://opencode.ai/docs/mcp-servers/) 和 [CLI](https://opencode.ai/docs/cli/) 文档。bootstrap 的 `mcp.contextos` 是 v1 格式；若安装的是 v2，AI 必须按 [v2 文档](https://opencode.ai/v2/docs/mcp-servers) 使用 `mcp.servers.contextos`，不能照搬 v1。运行 `opencode mcp list` 验证连接。

重启或刷新目标宿主的 MCP；在**新宿主会话**确认只有一个 `contextos` 入口，两个技能可发现，并实际调用一次 `ops/session/status`。仅在终端完成 stdio 握手不能证明 App 已刷新。

## 3. 必须配置 API Micro

Micro 是处理检索、总结、验证和小范围任务的助手；复杂多文件实现交给 CLI。安装不能把缺失 Micro 当成“可选项已跳过”。

从有效现有配置或用户指定服务获得 **base URL、模型 ID、API Key**。缺项时一次性询问缺少的字段，其他步骤继续。支持自己的 OpenAI 兼容 API；推荐 `deepseek-v4.1-flash`、思考等级 `medium`。模型必须是服务商实际提供的 ID，不要把 Micro 的模型自动套到 CLI。

| 服务 | 官方说明 | Micro base URL |
| --- | --- | --- |
| OpenCode Go | [Go 与模型端点](https://opencode.ai/docs/go/) | `https://opencode.ai/zen/go/v1` |
| Command Code GOAT | [GOAT](https://commandcode.ai/docs/plans/goat)、[Provider API](https://commandcode.ai/docs/provider) | `https://api.commandcode.ai/provider/v1` |
| 自有 API | 服务商的模型和接口文档 | 使用服务商确认的兼容根 URL |

套餐、额度和模型以官网为准；CLI 登录或订阅不等于已取得可用于 Micro 的 Provider API Key。不要固定已过期价格。

使用 ContextOS profile API 合并配置，所有参数放在 `args` 内：

```js
contextos({
  action: "ops",
  args: {
    capability: "profile", action: "set",
    args: { scope: "global", values: {
      "micro.url": "https://opencode.ai/zen/go/v1",
      "micro.model": "deepseek-v4.1-flash",
      "micro.key": null,
      "micro.apiKey": null,
      "micro.keyEnv": "CONTEXTOS_API_MICRO_KEY",
      "micro.transport": "chat",
      "micro.thinking": "medium"
    }}
  },
  projectRoot: "<用户项目绝对路径>"
})
```

把 API Key 存入宿主可读取的环境/凭据文件；stdio 宿主不会自动继承当前终端 `export`。例如 Codex MCP 的 `env_vars` 只允许转发必要变量名 `CONTEXTOS_API_MICRO_KEY`。环境注入不可行时，使用 profile API 写入全局 `micro.key`，限制文件权限，并验证项目级覆盖不会继续引用旧 Key。解析顺序是 `key → apiKey → keyEnv`，因此改用环境变量时须清除旧字段；项目 profile 对全局 profile 具有优先级。

密钥不能进入 README、setup、Git、截图、终端日志或安装报告；只报告“已配置”和来源。不要读取/输出整个含明文 Key 的 profile。

安装授权包含一次最小连通性验收：

```js
contextos({
  action: "ops",
  args: { capability: "micro", action: "doctor", args: { role: "api", probe: true } },
  projectRoot: "<用户项目绝对路径>"
})
```

再提交一个只返回固定文本、无需源码的 Micro 分析任务，确认实际任务返回而不只是 HTTP 连通。真实开发验证只能在用户授权的仓库/服务上进行。诊断中的 `thinking` 要同时记录配置值和实际 provider 映射值；部分模型会把 `medium` 映射成其支持的 `high`，不可把映射当成配置丢失。

失败分类：401/403 检查凭据/权限/额度；404 检查模型 ID 与路由；DNS/连接/超时先检查网络；200 但解析失败检查 transport/响应映射。只重试已定位的缺项。没有 live probe 时应写“未验证”，不能写“通过”。

## 4. AI 自动配置 CLI 和 adapter

优先复用用户指定/已有 CLI；若没有，说明 CLI 用于多步骤实现、独立工具循环和会话续用，由 AI 安装用户选择的工具。只有选择账号、付费或必须在浏览器完成的 OAuth 才交给用户操作。**不要要求用户自己编写 adapter。**

### 安装、认证和权限

1. 根据对应 CLI 官网安装，并运行 `--version`、`--help`、非交互子命令帮助和模型列表/现有模型配置。保存版本和官方文档链接；不要使用凭记忆编造的 flags。
2. 使用官方 auth/status 命令检查既有登录。未登录时启动官方登录流程，提示用户只完成必要浏览器/设备码动作，再继续验证；不要复制其他 CLI 的凭据库到新宿主。
3. 为 CLI **独立注册 ContextOS MCP/插件和两个技能**；主宿主有 OS 不代表 worker 有 OS。用该 CLI 的 MCP/插件列表验证服务与技能加载，再做一次真实工具调用。
4. 根据官方权限系统允许必要的项目写入、执行和 `contextos` MCP。只改当前 worker 必需的授权；保留其他工具限制。需要全权限 flags 时，在用户授权的隔离 worker 中使用，不修改整台机器的默认策略。Codex bridge 自带 `--dangerously-bypass-approvals-and-sandbox`，因此只能在适合此权限的隔离环境使用，不叠加矛盾的 sandbox flags。组织策略阻止权限时如实记录所需动作。
5. AGY 的模型若已带 effort 后缀，不再同时传入 `--effort`；权限与当前版本的 `--help`/官网核对。OpenCode v1/v2 的配置差异同样适用于 CLI。

### 编写完整 adapter

阅读已安装的 `contextos-ops/SKILL.md`（"Full setup and switching guide" 一节），AI 根据本机实际版本填写并测试以下完整契约：

- `command`：可执行文件绝对路径；Windows 正确处理 exe/cmd，避免只在交互 shell 有效的 alias。
- `args`：真实支持的模型、workspace、模式和输出参数；ContextOS 只展开 `{task}`、`{model}`、`{workspace}`、`{mode}`、`{thinking}` 等 adapter 占位符，`~` 不会由 spawn 自动展开。
- `input`：文本或 JSONL 格式、任务模板、是否保持 stdin 打开。
- `output`：最终结果/内容/状态/会话字段、终止事件、成功值和 token 统计映射。不能把启动日志或中间事件当成最终答复。
- `modes`：analyze/implement 到 CLI 自身执行模式的映射。
- `resumeArgs`：官网且本机支持的会话续用参数；没有续用能力时明确记录，不编造。
- 必要时由 AI 编写 Node bridge，把 CLI JSONL 转为一个完整 JSON envelope；先用真实 CLI 事件校验解析，再配置默认 adapter。
- `osInvocation`：说明 worker 调用其宿主 ContextOS 工具的实际语法，绑定当前 workspace 的绝对 `projectRoot`。

通过 profile API 合并 `agents.adapters.<name>` 和 `agents.default`，保留其他 adapter，供 App 选择切换。不要为了新 adapter 覆盖整个 profile。

**Codex 示例**：仓库已提供 `scripts/adapters/codex-cli-bridge.mjs`。AI 复制至 `<ContextOS Home>/adapters/`，选择该 Codex 当前 provider 确认可用的模型，然后使用以下结构；不要默认把 DeepSeek Micro 模型当成 ChatGPT/Codex 账号模型：

```json
{
  "command": "<Node 绝对路径>",
  "args": ["<bridge 绝对路径>", "--model", "{model}", "--workspace", "{workspace}", "--thinking", "{thinking}"],
  "resumeArgs": ["--session-id", "{sessionId}"],
  "model": "<该 CLI 实际可用模型>",
  "thinking": "medium",
  "input": { "format": "text", "template": "{task}" },
  "output": {
    "format": "json",
    "contentPath": "content",
    "statusPath": "status",
    "successValues": ["SUCCESS"],
    "sessionPath": "thread_id",
    "usage": {
      "path": "usage", "input": "input_tokens", "output": "output_tokens",
      "cache": "cached_input_tokens", "inputIncludesCache": true,
      "reasoning": "reasoning_output_tokens", "reasoningIncludedInOutput": true,
      "aggregation": "invocation"
    },
    "contextUsage": {
      "path": "context_usage", "input": "input_tokens",
      "cache": "cached_input_tokens", "inputIncludesCache": true, "window": 233000
    }
  }
}
```

Codex bridge 的 `usage` 是本次调用统计，因此 `aggregation` 必须是 `invocation`；只有 CLI 真正返回会话累计量时才用 `session`，否则续用会话时会发生错误的累计量差分。`contextUsage.window` 必须按该 adapter/模型的官方上下文容量和实际输出核对；示例的 `233000` 是已观测配置的示例值，不是所有 CLI 或模型的通用常量。AGY 的完整 stream-json/终止事件/会话映射见已安装的 `contextos-ops/SKILL.md`；其他 CLI 不能照搬 AGY 的字段，必须验证实际输出。

### CLI 的独立验收

先做本地 doctor，再做一次 live probe：

```js
contextos({
  action: "ops",
  args: { capability: "micro", action: "doctor", args: { role: "cli", adapter: "<名称>", probe: true } },
  projectRoot: "<用户项目绝对路径>"
})
```

PONG 只证明 worker 可启动并响应。还要在临时工作目录/新 worktree 中验收：

1. analyze 任务通过 **CLI 内的 ContextOS** 读取 session/status，返回工具回执，确认插件确实可调用。
2. implement 任务使用与调度主项目 `projectRoot` 不同的隔离 `workspace`，只修改允许的一份小测试文件，经 `change` 写入并执行验证；明确提供 `context.allowedPaths` 和 `context.acceptance`，前者限定到测试文件。主项目路径与 worker 路径相同会被拒绝，不能把本地 doctor 的同一目录直接复用为实现 workspace。
3. 长任务以 `background: true` 派发，使用 `agent({action:"wait",jobId,waitMs})` 收集；不将运行中的快照当成功。
4. 若 adapter 支持 resume，用返回会话 ID 续用一次，验证会话未丢失。
5. 返回任务状态、验证命令退出码、job/receipt/session ID。默认 adapter 只有在 live probe 和工具调用通过后才标为可用；CLI 未登录或策略阻止时标为“待用户操作”，不能宣称全部通过。

## 5. 新会话和新 worktree 的最终验收

由另一个安装智能体/子代理拿到**只有一句话安装请求**后读取本指南，在新 worktree 和独立测试配置里执行；测试 Key 通过保密配置传递，不嵌入任务文本。可复用本机已验证的 CLI 登录，但须区分“复用登录”与“干净账号登录测试”。本地 3.0.0 候选测试要使用包含待发布修改的候选快照，不能只检出旧 HEAD 后冒充最终版本。

不触碰原项目或全局凭据，依次验证版本选择、构建、完整 parser 运行时、MCP 握手/`tools/list`、两个技能、Micro 本地/实际任务、CLI 本地/实际任务/插件工具调用、测试文件写入和配置可重入。至少用一个 Python 或 TypeScript 的 AST 搜索验证独立 runtime 不依赖源码目录的 `node_modules`。Windows 产物只能在真实 Windows 环境验收，不能拿 macOS 结果代替。

最终给用户一份脱敏安装回执：

```text
版本 / 来源 ref / SHA / 平台 / Node：
安装目录 / 用户项目 / 宿主：
MCP：已注册；新宿主会话已加载 / 待刷新
技能：contextos + contextos-ops
Micro：服务 URL / 模型 / 配置思考等级 / 实际映射 / Key 来源（脱敏）
Micro 本地检查 / live probe / 有界任务：
CLI：版本 / adapter / 模型 / 登录状态 / 权限状态
CLI 插件/技能 / live probe / OS 工具调用 / 写入验证 / 会话续用：
回执与测试位置：
待用户操作 / 未测试平台 / 未公开发布限制：
```

API Key 缺失、登录未完成、模型不可用、宿主未刷新或真实任务未验收时，只能报告“已完成的部分 + 具体剩余动作”。安装完成后用户可以直接说“请把 plan 写入 OS 并开始执行”或“请为我配置/切换 Micro 和 CLI”；日常路由遵循已安装的两个技能。
