# ContextOS 安装与配置引导指南

本指南专供智能体在引导用户安装与初始化 ContextOS 时使用。智能体应作为交互引导者，逐步协助用户检测环境、选择安装方式、配置 API Key 并按需启用 CLI 子代理。

> **面向用户的一句话安装方式**：用户只需对智能体说：**「请你读取 setup.md 指引为我安装」**，智能体即可按照本指南全流程完成环境检测、产物推荐、API Key 配置与 CLI 接入。
>
> 注意：本指南专注于安装与环境配置，不涉及 ContextOS 的具体运行使用方法（日常开发使用请参考 `contextos` 技能手册）。

---

## 阶段一：检测环境并选择安装方式

智能体首先应在宿主环境中检测操作系统、CPU 架构与 Node.js 运行时，向用户展示检测结果并推荐最适安装包：

### 1. 环境检测步骤

1. **操作系统与架构检测**：
   - macOS：Intel (x86_64) 或 Apple Silicon (arm64)。
   - Windows：x64 架构。
   - Linux：x64 或 arm64 架构。
2. **Node.js 版本检测**：
   - 执行 `node -v`。ContextOS 核心运行环境需要 **Node.js 22+**。
   - **Node 缺失或版本过低明确提示**：若检测到系统未安装 Node.js 或版本低于 22，必须明确提示用户：**请安装 Node.js 22+（可前往 [nodejs.org](https://nodejs.org) 下载最新 LTS/Current 版本），或者在 macOS 下直接选择内置独立 Node 运行时的 Full 包**。

### 2. 发布产物名称、获取方式与安装方案推荐

所有预编译发布产物可从 [GitHub Releases](https://github.com/yubinbin32-ops/ContextOS/releases) 获取。根据检测结果向用户推荐对应产物：

- **macOS**：
  - **Standard 包**（产物名称：`ContextOS-macos-<arch>.zip`，需 Node 22+；其中 `<arch>` 为 `arm64` 或 `x64`）：若系统已安装 Node.js 22+，推荐 Standard 包（体积轻巧，直接利用现有 Node 环境）。
  - **Full 包**（产物名称：`ContextOS-macos-full-<arch>.zip`，内置 Node 运行时）：若系统未安装 Node.js 或版本低于 22，明确推荐 Full 包（内置独立 Node.js 运行时，免去系统环境配置）。
- **Windows x64**（需 Node 22+）：
  - **安装器版（Installer）**（产物名称：`ContextOS-Setup-x64.exe`）：提供系统注册与全局 PATH 配置，需 Node 22+。
  - **便携版（Portable）**（产物名称：`ContextOS-win-x64.zip`）：解压即用，适合受限环境或免安装需求，需 Node 22+。
- **源码安装（适用于开发者，需 Node 22+）**：
  - 适用于从 GitHub 仓库直接构建或二次开发：
    ```bash
    git clone https://github.com/yubinbin32-ops/ContextOS.git
    cd ContextOS
    npm ci
    npm run plugin:build
    ```

---

## 阶段二：配置 API Key 与验证

ContextOS 的 API Micro 角色用于轻量级证据检索、代码切片定位与有界任务处理，需要配置模型服务接口。

### 1. 获取 API Key

智能体应主动询问用户：
- **已有 Key**：若用户已有 OpenAI 兼容接口的 API Key（如 DeepSeek 官方 API 或第三方聚合服务），直接复用现有凭据。
- **无现有 Key**：若用户暂无可用凭据，推荐以下高性价比方案：
  - **OpenCode Go**：10 美元套餐，提供高性价比的 API 额度与稳定连接。
  - **Command Code**：1 美元套餐（注意：Command Code Go 的 1 美元套餐为 CLI 订阅，若需使用 Provider API 需选择其独立的 API 套餐方案）。

### 2. 推荐模型与思考参数

- **推荐模型**：`deepseek-v4.1-flash`（兼顾极低上下文占用、快速响应与准确的 AST 切片定位能力）。
- **思考参数（Thinking）**：推荐设置为 `medium`。

### 3. 写入配置文件

将配置写入用户全局配置文件 `~/.contextos/profile.json`（或项目级 `.contextos/profile.json`）。建议将密钥存放在环境变量中（如 `CONTEXTOS_API_MICRO_KEY`），并在配置中通过 `keyEnv` 引用，避免明文硬编码：

```json
{
  "micro": {
    "url": "https://api.deepseek.com/v1",
    "model": "deepseek-v4.1-flash",
    "keyEnv": "CONTEXTOS_API_MICRO_KEY",
    "transport": "chat",
    "thinking": "medium"
  }
}
```

若直接写入密钥字段，可使用 `key` 或 `apiKey`（解析优先级：`profile.key` -> `profile.apiKey` -> `keyEnv` 环境变量）。

### 4. 连通性测试与故障排查

配置完成后，执行一次受限的单次连通性探针（Probe）：
```js
contextos({
  action: "ops",
  args: {
    capability: "micro",
    action: "doctor",
    args: { probe: true }
  }
})
```

若测试未通过，根据返回结果进行分类排查：
- **HTTP 401 / 403**：凭据无效、余额不足或缺少权限。请检查 API Key 拼写与账户状态。
- **HTTP 404**：接口 URL 路径不匹配（例如缺少 `/v1`）或该路由不支持请求的模型 ID。
- **连接超时 / DNS 错误**：前置网络连通性问题或代理设置不当，在请求到达鉴权阶段前已失败。
- **HTTP 200 解析失败**：网络与凭据正常，但返回数据格式与配置的 `transport` 不兼容（非密钥问题）。

---

## 阶段三：可选 CLI 子代理配置

### 1. CLI 的收益说明

智能体应向用户说明启用 CLI 子代理的价值：
- **分担复杂任务**：CLI 子代理（如 AGY、Claude Code 等）拥有独立的执行进程与工具调用循环，适合处理多步骤的复杂重构与端到端实现。
- **会话复用**：已完成的 CLI 会话最多保留 5 个，可通过会话 ID 延续上下文，避免重复发送项目背景。
- **降低主对话成本**：繁重且冗长的中间调试日志保留在子代理本地进程中，仅向主对话回传精炼结构化报告，极大减少主对话 token 与上下文消耗。

### 2. 交互询问

智能体询问用户：“是否需要配置 CLI 子代理？（若不需要，可直接跳过，ContextOS 核心功能与 API Micro 已可正常使用）”

### 3. 配置流程（若用户需要）

若用户确认启用 CLI，依次引导完成以下步骤：

1. **安装官方 CLI**：
   - 引导用户通过其官方安装渠道安装 CLI 工具（例如 Antigravity CLI `agy`）。
   - 验证本地安装与可用性：执行 `agy --version` 与 `agy --help`。
2. **账号登录**：
   - 引导用户完成官方认证登录，复用现有登录会话，切勿复制或硬编码用户敏感凭据。
3. **配置 Adapter**：
   - 在 `~/.contextos/profile.json` 中配置对应的适配器参数并设为默认：
     ```json
     {
       "agents": {
         "default": "agy",
         "adapters": {
           "agy": {
             "command": "agy",
             "args": [
               "--input-format", "stream-json",
               "--output-format", "stream-json",
               "--model", "{model}",
               "--mode", "{mode}",
               "--dangerously-skip-permissions"
             ],
             "resumeArgs": ["--conversation", "{sessionId}"]
           }
         }
       }
     }
     ```
4. **预配置权限**：
   - 为避免执行自动化任务时频繁弹窗阻断，预先配置完整权限参数（如 AGY 的 `--dangerously-skip-permissions`）；不要将 `--effort` 与已带 effort 后缀的模型同时传入，也不要为 MCP 任务强制启用 `--sandbox`，否则 CLI 可能无法连接 ContextOS MCP。
   - 在 CLI 设置中（如 `~/.gemini/antigravity-cli/settings.json`）添加 ContextOS 的 MCP 权限授权：
     ```json
     {
       "permissions": {
         "allow": [
           "mcp(contextos/contextos)"
         ]
       }
     }
     ```
5. **注册 OS MCP 插件**：
   - 在 CLI 宿主的 MCP 配置文件中注册 ContextOS 服务器 bundle：
     - 命令：`node`
     - 参数：`["--no-warnings=ExperimentalWarning", "<用户目录>/.contextos/server/contextos-mcp.mjs"]`
6. **安装与同步技能**：
   - 将 ContextOS 技能目录同步至 CLI 技能目录（如 `~/.gemini/antigravity-cli/skills`）。
7. **本地验证与启用**：
   - 运行本地诊断检查（不发起模型调用）：
     ```js
     contextos({
       action: "ops",
       args: {
         capability: "micro",
         action: "doctor",
         args: { role: "cli", adapter: "agy" }
       }
     })
     ```
   - 确认各项指示器为正常状态后，正式启用该 CLI 适配器。

---

## 安装完成

完成上述配置后，运行 `ops({capability: "micro", action: "doctor"})` 确认环境各组件就绪，即可开始在开发任务中使用 ContextOS。
