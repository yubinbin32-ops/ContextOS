---
name: contextos-ops
description: Manage ContextOS environment operations: run doctor health checks, configure external Micro subagent, deploy Cloudflare Hub, and switch between local and cloud modes (运行 ContextOS 环境自检、配置外接 Micro 小脑、部署云端协同与本地/云端无损切换时调用).
---

# ContextOS Operations & Management Guide (副 Skill)

本指南专门负责 ContextOS 的**环境自检、外部小脑（Micro）配置、存储模式切换（本地/云端）与性能诊断**。
日常代码开发读写请使用主 `contextos` Skill；当用户在对话中提出以下需求时唤起本操作流：
1. *"检查 ContextOS 状态 / 运行 doctor"*
2. *"配置 Micro / 接入外部小脑 / 接入 DeepSeek/OpenCode"*
3. *"切换为云端协同模式 / 切回本地开发"*
4. *"部署 Cloudflare Worker 云端中枢"*
5. *"测试或对比 Token 消耗 (A/B Test)"*

---

## 一、 系统状态诊断与自检 (Doctor Health Check)

当需要确认环境状态或排查连接问题时，调用：
```javascript
// Lean 紧凑传输
contextos({
  action: "ops",
  args: { capability: "system", action: "doctor" },
  projectRoot: "<当前项目绝对路径>"
})
```

### 诊断报告项解读：
- **Node Runtime**：必须 `>= 22.0.0`（ContextOS 原生依赖轻量级实验性 SQLite 驱动）；若使用 macOS `ContextOS.app`，会内置专用 Node。
- **Active Storage Mode**：当前生效的存储模式（`local` 或 `cloud`）。
- **Cloud Hub Connectivity**：云端中枢连通性状态。
- **Detected Editors**：探测系统中已安装的编辑器（Cursor、Codex、Claude Code、Antigravity、OpenCode 等）。

---

## 二、 存储模式配置与无损切换 (Local vs Cloud)

### 1. 核心定位与推荐原则
- **本地模式 (Local Storage Mode · 强烈推荐 ⭐⭐⭐⭐⭐)**：
  - 数据保存在当前项目 `.contextos/state.sqlite`；
  - 100% 离线运行，0 毫秒网络延迟，完全保护代码与架构隐私；
  - **对于单人开发或绝大部分项目，默认且唯一推荐本地模式**。
- **云端模式 (Cloud Hub Mode · 实验公测中 ⚠️)**：
  - 通过 Cloudflare D1 边缘数据库进行多端、团队多人架构图谱同步；
  - **重要提醒**：云端协作目前处于公测阶段，接口与稳定性仍在迭代中。如无团队多人实时协作的刚需，**无需配置云端**。

### 2. 部署 Cloudflare Worker 云端中枢（仅团队需要时）
1. 提供一键部署链接给用户：
   👉 [一键部署 Cloudflare Worker](https://deploy.workers.cloudflare.com/?url=https://github.com/yubinbin32-ops/ContextOS/tree/main)
2. 部署完成后，索取用户的 Worker URL（如 `https://contextos-hub.your-subdomain.workers.dev`）与 `AUTH_TOKEN`。
3. 全局保存凭据：
   在后台执行 `node scripts/bootstrap.mjs --save-global-cloud --cloud-url "<URL>" --token "<TOKEN>"`。

### 3. 本地 ➔ 云端无损切换
用户说：*“把当前项目切换为云端协同模式”*
```javascript
contextos({
  action: "ops",
  args: {
    capability: "system",
    action: "switch",
    args: {
      targetMode: "cloud",
      cloudUrl: "<Cloudflare Worker 网址>",
      token: "<AUTH_TOKEN>"
    }
  },
  projectRoot: "<当前项目绝对路径>"
})
```
- **效果**：本地 SQLite 中现有的 Block、Chain、Link、Task 架构拓扑将被原子推送到云端 D1 数据库，后续操作与云端实时同步。

### 4. 云端 ➔ 本地无损切回
用户说：*“把当前项目切回本地离线开发”*
```javascript
contextos({
  action: "ops",
  args: {
    capability: "system",
    action: "switch",
    args: { targetMode: "local" }
  },
  projectRoot: "<当前项目绝对路径>"
})
```
- **效果**：从云端下载最新架构快照并完整落盘为本地 SQLite，断开网络依赖，恢复完全离线运行。

---

## 三、 配置 Micro 外接小脑 (Dual-Brain Subagent)

### 1. 价值与意义（为什么强烈推荐配置？⭐⭐⭐⭐⭐）
- **职责**：作为主对话舱外的“脏活累活处理专员”。
- **痛点解决**：当单测跑挂抛出 20,000~50,000 字符的巨型终端堆栈、或需要提炼庞杂接口契约时，传统流程会直接把巨型日志喂给主模型，造成**上下文暴涨与注意力严重稀释**。
- **运作机制**：Micro 在独立会话中消化日志与切片，只向主上下文返回几行精炼的失败原因或契约结论（Receipt），节省 80% 以上的主模型 Token。
- **推荐端点**：兼容任意 OpenAI 格式接口。推荐低成本模型（如 OpenCode Go 订阅、DeepSeek `deepseek-chat` 或本地免费的 Ollama）。

### 2. 引导配置步骤
用户说：*“帮我配置 Micro 小脑”*
1. 询问用户获取凭据（若用户已有配置直接复用）：
   - **API URL**（如 `https://api.deepseek.com/v1` 或 `https://opencode.ai/zen/go/v1` 或本地 `http://localhost:11434/v1`）
   - **Model 名称**（如 `deepseek-chat` 或 `deepseek-v4.1-flash`）
   - **API Key**（本地免密服务可直接填空）
2. AI 在后台写入项目或全局 `.contextos/profile.json`：
   ```json
   {
     "micro": {
       "url": "<用户提供的 URL>",
       "model": "<用户提供的 Model>",
       "key": "<用户提供的 API Key>",
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
3. 执行挂载测试与自检：
   ```javascript
   // Step 1: 创建测试会话
   contextos({
     action: "ops",
     args: {
       capability: "micro",
       args: { sessionAction: "create", sessionId: "setup-check", objective: "ping" }
     },
     projectRoot: "<当前项目绝对路径>"
   });
   
   // Step 2: 发送测试任务
   contextos({
     action: "ops",
     args: {
       capability: "micro",
       args: { sessionAction: "send", sessionId: "setup-check", task: "Reply with pong only." }
     },
     projectRoot: "<当前项目绝对路径>"
   });
   ```
4. 验证通过后向用户反馈已成功接入。

---

## 四、 真实 A/B 测试与 Token 审计 (Telemetry & Benchmark)

当需要评估使用 ContextOS 相比原生开发的真实 Token 消耗与收益时，调用：
```javascript
// 审计会话 Token 消耗
contextos({
  action: "ops",
  args: {
    capability: "telemetry",
    action: "audit",
    args: { sessionId: "<当前会话ID>", baselineSessionId: "<对照组会话ID>" }
  },
  projectRoot: "<当前项目绝对路径>"
})
```

### 客观 A/B 测试基准准则：
1. **简单任务（单文件修改、1~2 轮日常修复）**：
   - 原生开发消耗 ~500-800 Tokens；
   - 若使用全套 ContextOS（explore + inspect + change + ship），由于协议元数据与图谱交互，消耗约为 3,000-5,000 Tokens，**表现为负收益**；
   - **规范**：简单任务请直接调用原生编辑或轻量单步 `change`，严禁触发全套 explore/ship！
2. **复杂长程任务（跨文件重构、深层单测报错、10+ 轮多步协同）**：
   - 原生开发中日志反复倾倒与上下文重述容易消耗 80,000~150,000 Tokens 甚至导致注意力崩溃；
   - ContextOS 带外执行 + 原地诊断 + Micro 脱毒 + 300 字节黑板，可将总消耗压缩至 25,000~45,000 Tokens，**展现 50%~70% 的高正收益**。
