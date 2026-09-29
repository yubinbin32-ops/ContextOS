# ContextOS 真实开发 A/B/C 测试方案与第一轮报告

## 1. 测试目标

本测试不采用 benchmark 分数作为通过门槛，也不把“主线程省 token”直接等同于收益。目标是回答以下问题：

1. ContextOS 在真实复杂开发任务中是否减少总请求、工具调用、上下文峰值和总 token。
2. ContextOS 是否真的被调用；如果可用却不用，原因是什么。
3. Micro 是否在出现大块证据时被调用，增加的主模型与 provider 成本是否能换来净收益。
4. Skill、MCP 工具目录、审批、路由和返回契约是否存在缺陷。
5. 修复缺陷后，重新做严格单变量对比，判断效果与适用边界。

## 2. A/B/C 定义

三组是三个独立工作单元，不是同一对话内重复三轮，也不是同一目录切换配置。

| 组 | 条件 | Skill | ContextOS MCP | Micro | 工作区 |
| --- | --- | --- | --- | --- | --- |
| A | Native 对照 | 无 | 无 | 无 | 独立 worktree |
| B | ContextOS | 有 | 有 | 显式关闭 | 独立 worktree |
| C | ContextOS + Micro | 有 | 有 | 已配置 | 独立 worktree |

第一轮冻结提交：`ab6edf562bc5204ca7b0bdb15486e9fab93d8cec`

第一轮工作区：

- A: `/Users/a1-6/.codex/worktrees/ab-os-r1-native/mdflow`
- B: `/Users/a1-6/.codex/worktrees/ab-os-r1-os/mdflow`
- C: `/Users/a1-6/.codex/worktrees/ab-os-r1-micro/mdflow`

## 3. 严格隔离规则

1. 每组使用独立 worktree、独立 Codex session、独立 MCP 进程、独立 `.contextos`。
2. 三组使用同一提交、同一模型、同一 reasoning、同一权限、同一任务提示。
3. 依赖必须在正式计时前预装，避免把 `npm ci` 的输出和工具调用混入开发任务。
4. 正式任务期间，主控不得修改被测 worktree。
5. A/B/C 不能互相续跑或共享会话历史。
6. 发现实现缺陷后，旧 worktree 只能用于复盘；修复后的正式测试必须新建 worktree。
7. 没有真实 rollout usage 时必须记为 unavailable，不能用字符估算补齐。

## 4. 第一轮真实任务

任务不是修改几个文件，而是给 ContextOS 增加真实的 Codex rollout token 导入能力：

1. 解析 `token_usage_record` 与 `token_count` 两套 JSONL 事件。
2. 按 `response_id` 去重，优先使用 per-request usage，禁止把 cumulative usage再次相加。
3. 将真实 host usage 通过 `ops telemetry rollout` 暴露，并在 `compare` 中与字符估算分开。
4. 对缺失、损坏、矛盾的数据返回 `metrics:null` 和明确 diagnostics。
5. 添加聚焦测试，执行 telemetry、MCP 和完整测试。

这个任务同时覆盖架构探索、跨模块协议、解析器实现、测试设计、失败验证和文档更新。

## 5. 指标与采集

从每组 Codex rollout JSONL 读取：

- 总请求数：唯一 `response_id` 数量。
- 工具调用数：`function_call`、`custom_tool_call`、`tool_search_call`、MCP call 分开统计。
- 输入 token：每个请求 `usage.input_tokens` 求和。
- 缓存输入 token：每个请求 `usage.cached_input_tokens` 求和。
- 输出 token：每个请求 `usage.output_tokens` 求和。
- reasoning token：每个请求 `usage.reasoning_output_tokens` 求和。
- 总 token：每个请求 `usage.total_tokens` 求和。
- 上下文峰值：最大 per-request `input_tokens`。
- 模型窗口：最大 `model_context_window`。
- Micro provider 增量：从 `.contextos/logs/micro-usage.jsonl` 读取 provider usage。

同时保存：

- 每组完整 rollout JSONL。
- 每组最终 diff 和测试结果。
- 每组 `.contextos/logs/telemetry.jsonl`。
- 每组实际 MCP 调用和失败信息。

## 6. 第一轮结果

| 指标 | A Native | B ContextOS, Micro 关闭 | C ContextOS + Micro |
| --- | ---: | ---: | ---: |
| 总请求数 | 41 | 33 | 38 |
| function call | 51 | 42 | 53 |
| custom tool call | 13 | 7 | 10 |
| tool search | 0 | 2 | 1 |
| ContextOS MCP call | 0 | 0 | 0 |
| Micro call | 0 | 0 | 0 |
| 工具调用合计 | 64 | 51 | 64 |
| 输入 token | 4,330,587 | 2,870,342 | 3,758,904 |
| 缓存输入 token | 4,181,888 | 2,695,424 | 3,477,888 |
| 输出 token | 46,550 | 46,860 | 53,270 |
| reasoning token | 23,221 | 26,425 | 27,364 |
| 总 token | 4,377,137 | 2,917,202 | 3,812,174 |
| 峰值输入 token | 150,865 | 140,284 | 149,939 |
| 模型上下文窗口 | 332,500 | 332,500 | 332,500 |
| 运行时长 | 8m05s | 8m06s | 9m16s |

相对 A：

- B 总 token 少 33.35%，请求少 19.5%，工具调用少 20.3%。
- C 总 token 少 12.91%，请求少 7.3%，工具调用相同。
- C 输出 token 比 A 高 14.44%，reasoning token 比 A 高 17.85%。

## 7. 第一轮核心结论

### 7.1 B 的 token 优势不能归因给 ContextOS

B 和 C 的正式 rollout 中 `mcp_tool_call=0`。B/C 的 `.contextos` 只有预检 doctor 记录，正式 sessionId 没有任何 telemetry；C 没有 Micro 记录。

因此：

- B 更低的总 token和请求数来自模型选择了不同的原生工作路径。
- C 没有执行承诺中的 OS + Micro 工作流。
- 第一轮不能用于判断 ContextOS 的真实收益或负收益。

### 7.2 Skill 已加载不等于 MCP 可执行

B/C 都能加载 `contextos:contextos` Skill。B 在推理中通过 `tool_search` 发现了 compact tool，但没有调用。C 也进行了 tool discovery，最终仍全部使用 shell 和 apply_patch。

这是当前最严重的用户价值缺口：提示层可用，执行层没有进入实际工作流。

### 7.3 大日志会被 native 手段绕开

A/B/C 都运行了会超过 2,000 字符的测试输出。B/C 使用了重定向到 `/tmp`、`tail`、`rg` 等方式控制输出，没有触发 Micro。Skill 中“超过 2,000 字符必须调用 Micro”的文字规则没有形成自动路由。

### 7.4 Micro 通路本身可用

Skill 修复后，强制 C 组执行一个 Micro 诊断：

- provider requests: 1
- prompt tokens: 465
- completion tokens: 85
- total tokens: 550
- pipeline runs: 1
- preload artifact: 1,451 chars
- usage source: provider

结论：正式 C 轮未使用 Micro 是路由和执行策略问题，不是凭据、provider 或工具故障。

## 8. 已发现问题

### P0: 插件 `.mcp.json` 包装格式错误

原文件顶层使用 camelCase `mcpServers` 包装。官方插件契约要求：

- 直接 server map；或
- snake_case `mcp_servers` 包装。

这会导致 Skill 可见、MCP 不可见。第一轮预检已改为直接 server map。

### P0: compact MCP 工具延迟发现

全新会话初始 catalog 不直接显示 `mcp__contextos__contextos`，需要额外 `tool_search`。尝试将插件 server 设置 `required:true` 后仍然如此，证明不是启动等待问题。该无效改动已撤回。

当前修复：在 `contextos` Skill 顶部明确要求在工具不可见时先执行：

`tool_search("ContextOS compact repository tool")`

并明确说明“Skill 已加载”不等于“MCP 不可用”。新会话复验后 `doctor` MCP 调用成功。

### P0: MCP 审批摩擦

在 `approval_policy=never` 的自动化会话中，ContextOS MCP 调用仍可能要求 approval。测试隔离配置需要显式设置：

```toml
[plugins."contextos@contextos-development".mcp_servers.contextos]
default_tools_approval_mode = "approve"
```

否则工具虽然可见，调用仍会失败。

### P1: rollout telemetry 返回契约未冻结

同一提示下，三份实现的核心指标一致，但 schema 分叉：

| 字段 | A | B | C |
| --- | --- | --- | --- |
| `files` | 路径数组 | 数量 | 路径数组 |
| context window key | `modelContextWindow` | `highestModelContextWindow` | `highestModelContextWindow` |
| compare rollout | `rollout.delta` | `leftRollout/rightRollout` | `rollout.left/right` |
| `records` | 事件数 | 请求数 | 请求数 |

后续必须冻结唯一 schema，再通过 source、MCP、测试和文档共同约束。

### P1: 自动 host usage 仍未闭环

新功能可以从 rollout 导入真实 usage，但现有 `recordTelemetry` 主调度路径仍没有自动获得当前 host response usage。测试报告仍需要人工从 rollout 计算，而不是由 OS 自动产出。

### P1: MCP 资源能力造成无效调用

强制 Micro 测试中，客户端先调用了 `list_mcp_resources(server=contextos)`，服务端返回 `-32601 Method not found`。这会浪费一个工具轮次。后续要明确是否实现、隐藏或拒绝资源能力，避免模型误探。

### P2: 沙箱测试噪声

正式组的所有 worktree 都使用 workspace-write，完整测试中有 37 个用例因为 `listen EPERM` 失败，涉及 loopback HTTP 或 Unix socket。A/B/C 相同，因此不影响组间对比，但会影响完整验收。

下一轮建议三组统一使用受控的 full-access 测试环境，或者先运行同一个环境兼容测试集，确保 310/310。

## 9. 代码实现复盘

三组都实现了可用功能，独立用同一批真实 rollout 验证时，解析结果完全一致：

- requestCount: 112
- inputTokens: 10,959,833
- cachedInputTokens: 10,355,200
- outputTokens: 146,680
- reasoningOutputTokens: 77,010
- totalTokens: 11,106,513
- peakRequestInputTokens: 150,865
- context window: 332,500

实现风格：

- A：直接扩展 `telemetry.mjs`，约 1,164 行 diff；功能完整，但文件职责膨胀，返回契约与另外两组不同。
- B：新增独立 `rollout-telemetry.mjs`，约 952 行 diff；模块边界最清晰，解析、聚合、compare 分离最好。
- C：直接扩展 `telemetry.mjs`，约 1,143 行 diff；测试覆盖和 cumulative validation 最积极，但契约仍未冻结。

当前不立即合并某一组实现。先冻结 schema、修复发现的问题，再做第二轮，避免把第一轮的分叉带进正式版本。

## 10. 第二轮执行条件

1. 使用当前主分支上的 `.mcp.json` 和 Skill discovery 修复。
2. 新建三组全新 worktree，不复用第一轮目录。
3. B/C 明确设置插件级 approval，A 保持无插件。
4. 三组统一使用 full-access 或等价可运行 socket 的测试环境。
5. 预装完全一致的依赖。
6. 正式任务不包含第一轮实现代码，使用新的跨层真实任务。
7. 任务提示不要求必须使用 ContextOS；观察 Skill 修复后模型是否自然调用。
8. 任务包含大日志失败，但不要提供“提前重定向即可绕过”的唯一捷径。
9. 收集 rollout、MCP calls、telemetry、Micro provider usage、diff 和测试报告。
10. 只有在 B/C 确实调用工具时，才计算 ContextOS 或 Micro 的净收益。

## 11. 判定方式

第一轮不设置收益门槛。第二轮仍以发现和解释问题为主，但必须满足有效性门槛：

- A 组无 ContextOS Skill/MCP。
- B/C 组 MCP 可见并可调用。
- B 组 Micro 关闭且无 Micro provider usage。
- C 组 Micro 可用，并在大证据路径中实际调用。
- 三组任务、模型、权限、依赖和验收测试一致。
- 所有 token 数据来自 rollout 或 provider usage，缺失时明确为 null。
- 比较结果同时报告正确性、请求数、工具调用、峰值上下文、总 token 和 Micro 增量成本。

## 12. 相关文件

- Living plan: `.contextos/graph.json`, plan id `plan-contextos-daily-savings`
- Plugin MCP 配置: `plugins/contextos/.mcp.json`
- Skill discovery 修复: `plugins/contextos/skills/contextos/SKILL.md`
- 第一轮 A rollout: `/Users/a1-6/.codex/sessions/2026/09/28/rollout-2026-09-28T22-07-31-01a0e857-9ced-74a1-85d3-aeeb8bb63df2.jsonl`
- 第一轮 B rollout: `/Users/a1-6/.codex/sessions/2026/09/28/rollout-2026-09-28T22-07-31-01a0e857-9cef-7832-b92a-4cd667f90441.jsonl`
- 第一轮 C rollout: `/Users/a1-6/.codex/sessions/2026/09/28/rollout-2026-09-28T22-07-31-01a0e857-9cea-7f53-87e0-6ccba28ad059.jsonl`

## 13. 第二轮结果：修复 discovery 后的有效对比

第二轮使用全新 worktree，统一 full-access 权限，因此完整测试可以运行。

| 指标 | A Native | B ContextOS, Micro 关闭 | C ContextOS + Micro |
| --- | ---: | ---: | ---: |
| 总请求数 | 36 | 57 | 40 |
| exec_command | 58 | 40 | 60 |
| apply_patch | 9 | 17 | 2 |
| ContextOS MCP call | 0 | 16 | 13 |
| tool search | 0 | 1 | 1 |
| Micro call | 0 | 0 | 0 |
| 工具调用合计 | 67 | 74 | 76 |
| 输入 token | 4,026,442 | 5,015,638 | 4,982,069 |
| 缓存输入 token | 3,861,248 | 4,588,288 | 4,829,696 |
| 输出 token | 45,416 | 52,236 | 49,063 |
| reasoning token | 18,571 | 27,272 | 22,911 |
| 总 token | 4,071,858 | 5,067,874 | 5,031,132 |
| 峰值输入 token | 167,865 | 152,684 | 192,934 |
| 运行时长 | 7m44s | 28m25s | 5m51s |
| 新测试文件总测试数 | 313 | 309 | 310 |
| 完整测试结果 | 313/313 | 309/309 | 310/310 |

相对 A：

- B 总 token 增加 24.46%，请求增加 58.3%，工具调用增加 10.4%，运行时间增加约 3.7 倍。
- C 总 token 增加 23.56%，请求增加 11.1%，工具调用增加 13.4%，运行时间减少约 24%。
- C 峰值输入 token 增加 14.9%，因此该轮不能证明 ContextOS 降低了主上下文峰值。
- B/C 的 Micro call 仍为 0。C 通过 ContextOS Pipeline 获取测试摘要，没有形成需要 Micro 处理的大日志路径。
- C 仍有 60 次 `exec_command`，几乎与 A 的 58 次相同；13 次 ContextOS 调用主要是叠加层，而不是替换原生读取和执行。

### 第二轮结论

1. Skill discovery 修复有效，ContextOS 能被实际调用。
2. 在这一次真实功能开发任务上，ContextOS 和 ContextOS+Micro 都是总 token 负收益。
3. B 的成本主要来自架构 ownership、反复自审和长链路编排。
4. C 比 B 收敛更快，但没有降低峰值输入，也没有触发 Micro。
5. 下一轮不应继续扩大“默认全流程 ContextOS”，而应寻找能够真正替代多次 native 往返的任务边界，例如多文件契约探索、失败日志诊断、跨模块影响面分析。
6. 若继续验证 Micro，需要单独构造必须在宿主 context 外消化的大证据任务，并把 Micro provider token 计入总成本。

### 第二轮 rollout 路径

- A: `/Users/a1-6/.codex/sessions/2026/09/28/rollout-2026-09-28T22-25-38-01a0e868-34ef-77d0-8a0d-33c6044940f2.jsonl`
- B: `/Users/a1-6/.codex/sessions/2026/09/28/rollout-2026-09-28T22-25-38-01a0e868-34e7-7b10-8fb5-d5168bba2e54.jsonl`
- C: `/Users/a1-6/.codex/sessions/2026/09/28/rollout-2026-09-28T22-25-38-01a0e868-34f0-7cb0-8e89-5da4d98c5f6d.jsonl`

## 14. 第二轮后修复与协议冻结

### 14.1 Rollout telemetry schema v1

候选实现的字段漂移已收敛为唯一 schema。source、MCP、测试和文档都使用以下语义：

```json
{
  "schemaVersion": 1,
  "ok": true,
  "files": ["/absolute/path/rollout.jsonl"],
  "records": 72,
  "duplicateRecords": 0,
  "incomplete": false,
  "warnings": [],
  "metrics": {
    "requestCount": 36,
    "inputTokens": 4026442,
    "cachedInputTokens": 3861248,
    "outputTokens": 45416,
    "reasoningOutputTokens": 18571,
    "totalTokens": 4071858,
    "peakRequestInputTokens": 167865,
    "modelContextWindow": 332500
  }
}
```

- `files` 永远是规范化后的路径数组，不是文件数量。
- `records` 是匹配到的相关 rollout usage 事件数；请求数只放在 `metrics.requestCount`。
- `modelContextWindow` 是最高观测窗口，不使用 `highestModelContextWindow` 别名。
- `token_usage_record` 是权威请求记录；`token_count.last_token_usage` 只补齐没有 primary record 的请求。
- `thread_token_usage`、`turn_token_usage` 和 `total_token_usage` 用于去重/校验，绝不再次累加。
- 数据损坏、字段缺失、矛盾重复或缺少窗口时，`metrics` 必须为 `null`，不得返回估算值。
- `compare` 固定返回 `rollout.left/right/delta`；字符估算仍保留在顶层 `left/right/delta`，两者不能混写。

实现已用第一轮三份真实 rollout 复验：合并结果为 112 请求、10,959,833 输入 token、11,106,513 总 token、峰值 150,865、窗口 332,500；第二轮 A 复验为 36 请求、4,071,858 总 token、峰值 167,865、窗口 332,500。

### 14.2 C 组 Micro 配置污染

第二轮 C 的 `.contextos/profile.json` 包含：

```json
{
  "micro": {
    "url": "",
    "model": "",
    "key": ""
  }
}
```

`loadProfile` 会合并全局和项目配置。这些空字符串覆盖了全局 Micro URL/model/key，因此 C 的 Micro 实际不可用。第二轮 C 的零 Micro 调用不能只归因于模型路由。

第三轮规则：

1. C 不得写入空 Micro override。
2. 正式计时前，C 必须先执行 `ops({ capability: "micro", action: "doctor" })`，证明 URL、model 和 key 都可用。
3. C 的 `doctor` 预检不计入正式任务指标，但必须保存证据。
4. A/B 不得暴露 Micro provider 配置；B 仍关闭 Micro。

### 14.3 宿主 usage 自动闭环的边界

`recordTelemetry` 已能保存调用方显式传入的 `hostUsage`，但 MCP 工具调用发生在宿主 response 完成之前，工具进程无法读取该 response 的最终 usage。因此：

- 不在工具内部伪造、推断或字符估算 host usage。
- 正式比较继续从完整 rollout JSONL 导入真实 per-request usage。
- 如果未来宿主暴露 post-response hook 或把 usage 注入下一次调用，才允许实现自动闭环。

### 14.4 MCP resource 探测

强制 Micro 诊断中出现一次 `list_mcp_resources`，服务端返回 `-32601 Method not found`。ContextOS 当前是 tool-only server，不声明 resource capability。第三轮 Skill 明确禁止把 resource 探测当成 Micro/OS 可用性检查；应直接调用 compact tool 或 `doctor`。

## 15. 第三轮手动 A/B/C 协议

第三轮不再重复“实现一个新 API”这种以 native 编辑为中心的题。任务必须满足：

1. 有 6 个以上互相依赖的模块，不能靠修改两三个文件完成。
2. 起始验收测试失败，并产生超过 2,000 字符的真实 TAP/堆栈/差异输出。
3. 根因跨越 store、runner、queue、API、错误模型和 report 中至少三个边界。
4. 子线程只收到业务任务，不收到 ContextOS/Micro 使用步骤。
5. A/B/C 使用同一初始 commit、同一任务文本、同一模型、同一 reasoning、同一权限和同一验收命令。
6. A/B/C 是三个独立 worktree、三个独立会话、三个独立 `.contextos` 和三个独立 MCP 进程。
7. 正式比较同时报告：正确性、总请求数、工具调用分类、ContextOS/Micro 调用、峰值 input token、输入/缓存/输出/推理/总 token、Micro provider token、运行时间和失败。
8. 不设分数门槛；是否有效由正确性和完整成本证据判断。

第三轮任务骨架：

> 快速理解当前项目并修复失败验收。批量回放必须保留幂等键、冲突检测、终态、重试次数和事件顺序，并据此生成审计报告。不得修改测试或降低断言。完成生产代码后运行完整验收测试。

第三轮启动前检查：

- A：ContextOS 插件关闭。
- B：ContextOS 插件开启，Micro 配置不可用。
- C：ContextOS 插件开启，先 `doctor` 通过，再处理同一任务。
- 三组依赖预装，正式计时不包含 `npm install`。
- 三组完整测试在 full-access 下都应以真实结果结束，不能重复第二轮的 socket EPERM 噪声。

## 16. R3/R4 样本的可追溯性

R3 与 R4 在不同主机目录下运行，证据完整度不同，必须分开引用。

### 16.1 R3：不可追溯的历史汇总

R3 的原始 rollout 在当前环境中已不可检索，只剩 plan 汇总，因此只能作为线索，不能作为严格证据：

| 指标 | A Native | B ContextOS | C ContextOS + Micro |
| --- | ---: | ---: | ---: |
| 总请求数 | 12 | 23 | 25 |
| 工具调用 | 26 | 37 | 30 |
| ContextOS MCP | 0 | 24 | 9 |
| Micro call | 0 | 0 | 0 |
| 峰值输入 token | 34,731 | 57,021 | 48,566 |
| 总 token | 274,903 | 816,847 | 788,697 |

三组均正确完成，Micro 均为 0。C 暴露了 `ship` 未自动绑定显式 architecture、Pipeline 对无匹配搜索整体 HALTED、`micro doctor` 不验证连通性三个缺陷。

### 16.2 R4：可追溯样本与重新核算

R4 使用 noisy fixture，B/C 的 rollout 与验收结果都可追溯，本次用 `scripts/contextos-ab-metrics.mjs` 重新核算：

| 指标 | B ContextOS, Micro 关闭 | C ContextOS + Micro |
| --- | ---: | ---: |
| 总请求数 | 17 | 21 |
| 工具调用（function + custom + tool_search） | 25 | 23 |
| exec_command | 21 | 11 |
| ContextOS MCP | 2 | 8 |
| Micro call | 0 | 0 |
| 失败工具调用 | 1 | 2 |
| 输入 token | 394,189 | 468,022 |
| 缓存输入 token | 363,136 | 434,816 |
| 输出 token | 17,256 | 13,436 |
| reasoning token | 10,156 | 7,899 |
| 总 token | 411,445 | 481,458 |
| 峰值输入 token | 37,609 | 34,498 |
| 运行时长 | 168s | 152s |

B/C 均通过外部验收。C 的 `npm test` 失败证据为 3,408 字符，但 `verify(mode:"full")` 被误判成 process action，退回 native `exec_command`，Micro 仍为 0。R4 的计数口径差异说明：plan 汇总只统计 `function_call`，本报告脚本把 `custom_tool_call` 与 `tool_search_call` 一起计入，引用时以本表为准。

R4 rollout：

- B: `/Users/a1-6/ab-r4-micro-routing/codex-b/sessions/2026/09/28/rollout-2026-09-28T23-50-23-01a0e8b5-ca71-7333-8c34-a669f7f915ed.jsonl`
- C: `/Users/a1-6/ab-r4-micro-routing/codex-c/sessions/2026/09/28/rollout-2026-09-28T23-55-18-01a0e8ba-4b0a-73b3-bc74-9e26149cc0b6.jsonl`

## 17. 路由探针 C6/C7（不计入正式 A/B/C）

R4 之后先做了两个 C 轮探针，只验证路由，不参与收益结论。

| 指标 | C6 沙箱探针 | C7 严格 clone 探针 |
| --- | ---: | ---: |
| 总请求数 | 22 | 17 |
| 工具调用合计 | 17（含 12 ContextOS、5 exec） | 34（25 exec、6 ContextOS、2 apply_patch、1 tool_search） |
| ContextOS MCP | 12 | 6 |
| Micro call | 1 | 1 |
| Micro provider token | 553 + 337 = 890 | 609 + 166 = 775 |
| 峰值输入 token | 36,270 | 42,956 |
| 主模型总 token | 511,856 | 468,954 |
| 功能正确性 | 通过 | 通过 |

- C6 的 `.git` 指向沙箱外，隔离不完整，只能作为路由探针。
- C7 使用严格 clone，但插件 bundle 仍是伪工具修复前的版本：Micro 返回未执行的伪工具调用文本却标记 `ok:true`，主模型判定不可用后回退 native 全量读取。该缺陷已在源码修复，本轮 bundle 已包含修复。

## 18. R6 严格单变量 A/B/C

### 18.1 隔离条件

| 项 | A7 | B7 | C8 |
| --- | --- | --- | --- |
| fixture commit | `6408896981f4b6a98c087b1e52d0db5a8ff6a13d` | 同左 | 同左 |
| worktree | `/Users/a1-6/ab-r6-micro-routing/a7/mdflow` | `.../b7/mdflow` | `.../c8/mdflow` |
| CODEX_HOME | `codex-a7` | `codex-b7` | `codex-c8` |
| ContextOS MCP | 无 | 有 | 有 |
| Micro | 无 | 未配置 | 已配置（provider 连通） |
| session | `01a0e8d7-6c30-73e3-acb2-5260932ddeb3` | `01a0e8d7-6c30-7782-b3be-066e815faabf` | `01a0e8da-fb1e-7c81-98e5-8128f7a3674e` |

三组使用同一任务文本、`deepseek-v4.1-flash`、`model_reasoning_effort=xhigh`、`--dangerously-bypass-approvals-and-sandbox`，并在同一时间窗内分别运行。任务是修复完整失败的批量回放与审计报告实现，要求保留幂等键、冲突语义、终态、重试次数与事件顺序，且不得修改测试。

### 18.2 结果

| 指标 | A7 Native | B7 ContextOS, Micro 关闭 | C8 ContextOS + Micro |
| --- | ---: | ---: | ---: |
| 总请求数 | 14 | 15 | 21 |
| 工具调用合计 | 25 | 17 | 27 |
| exec_command | 21 | 7 | 14 |
| ContextOS MCP | 0 | 8 | 7 |
| tool_search | 0 | 1 | 1 |
| apply_patch | 2 | 1 | 1 |
| Micro call | 0 | 0 | 1 |
| 失败工具调用 | 2 | 0 | 1 |
| 输入 token | 346,549 | 349,889 | 592,142 |
| 缓存输入 token | 313,600 | 314,112 | 550,784 |
| 输出 token | 15,333 | 14,355 | 18,526 |
| reasoning token | 7,262 | 9,557 | 10,479 |
| 主模型总 token | 361,882 | 364,244 | 610,668 |
| Micro provider token | 0 | 0 | 593 + 214 = 807 |
| 主模型 + Micro 总 token | 361,882 | 364,244 | 611,475 |
| 峰值输入 token | 36,589 | 35,897 | 42,350 |
| 运行时长 | 137s | 140s | 184s |
| 外部验收 | 通过 | 通过 | 通过 |
| `npm test` | 3/3 | 3/3 | 3/3 |
| 修改测试文件 | 无 | 无 | 无 |

ContextOS 动作分布：

- B7：`explore` 1、`pipeline` 1、`inspect` 1、`verify` 2、`ship` 2、`change` 1。
- C8：`explore` 1、`pipeline` 2、`verify` 1、`ship` 3。

相对 A7：

- B7 请求 +7.1%，工具调用 -32.0%，总 token +0.65%，峰值输入 -1.9%。
- C8 请求 +50.0%，工具调用 +8.0%，总 token +68.8%，峰值输入 +15.7%；再计入 Micro provider token 后合计 +69.0%。

三组都正确完成，因此本轮数据有效，可以直接用于判断负收益。

### 18.3 Micro 路由证据

C8 的 Micro 由 `verify` 失败的 3,233 字符证据自动触发，`preset=triage`、`providerRequests=1`、`promptTokens=593`、`completionTokens=214`、耗时 4.4s，诊断结论是 `src/batch-replay.mjs` 的 `replayBatch` 仍是未实现桩。

诊断本身正确，但主模型没有看到它：

- 完整 Pipeline artifact（`art-mulgsq33-b57f5790.json`）的 verify 输出里包含 `## 👉 Micro-Triage` 段落。
- 主模型收到的是文本投影（`art-mulgsq35-e9adc8ea.txt`，2,853 字符，被 2,800 字符预算截断），其中 verify 只留下 `FAIL: ## Verdict: FAIL | error: |- | receipt=...`，Micro 段落被整段裁掉。
- 主模型随后发起第二次 `pipeline`，重新 inspect 9 个源文件与 3 个测试文件，自行推断出同一根因。

结论：这一轮 Micro 的 provider 成本已支付，收益为 0。这是 C8 相对 A7 大幅负收益的直接机制，不是 provider 故障。

## 19. 负收益根因

1. **OS 是叠加层而不是替代层。** C8 仍有 14 次 `exec_command`，代码编辑仍走 native `apply_patch`，ContextOS 的 7 次调用加在原有往返之上；B7 把 exec 从 21 次压到 7 次，但补上 8 次 OS 调用与 1 次 tool_search，总 token 与 A 基本持平，说明压缩读取有效但被协议开销抵消。
2. **P0：Micro 结果在 Pipeline summary 中被裁掉。** 证据见 18.3。已修复。
3. **P1：架构绑定后置导致 ship 反复往返。** C8 的 `ship` 调用 3 次：第一次缺 `src/index.mjs` 的 Block owner，第二次用了 `kind:"module"` 被拒，第三次才成功；每次约 0.5K 字符返回与一次完整模型往返。
4. **P1：`change` 架构-only 调用是静默 no-op。** B7 用 `change({ architecture, edits: [] })` 期望绑定所有权，实际只得到 `# ContextOS change (propose)` 预览，架构未应用，浪费一次往返。
5. **P1：advisory `ship` 关闭会话后，重开会话丢失 receipt 关联。** B7 第一次 `ship` 带 4 个架构 gap 仍关闭了 `sess-mulgninq-d907f3`；修复架构后新会话 `sess-mulgpzgf-3bc2fc` 的最终 `ship` 报 `Passing receipts: 0 (unverified, advisory mode)`，已有的通过证据无法被看见。
6. **固定协议成本。** `explore + pipeline + verify + ship` 本身约 4 至 8 次调用、3 至 10K 字符返回。任务越接近单文件修复，这部分越难被节省抵消。

## 20. 工具合格性审查

本轮重点检查“可用却未用”和“用了但暴露缺陷”。

| 工具 | 状态 | 证据与判断 |
| --- | --- | --- |
| `change`（OS 内编辑） | 可用但基本未用 | C8 完全未调用，改用 native `apply_patch`；B7 调用一次但 `edits` 为空，是 no-op。OS 因此失去在编辑事务内绑定架构的机会，把成本推到 ship。 |
| `work`（search + inspect + edits + verify 合并） | 可用但三组都未用 | 没有任何一组用它合并探索与编辑，B/C 仍分多轮。 |
| `micro` | C8 仅自动触发一次 | 模型未主动调用；B7 按设计不可用。自动 triage 生效，但结果被裁剪。 |
| `ops telemetry rollout` | 三组都未用 | 成本报告仍需人工解析 rollout，宿主 usage 自动闭环仍未形成。 |
| `list_mcp_resources` | 本轮 0 次 | Skill 中禁止资源探测的修复生效，R1 的 `-32601` 噪声未复现。 |
| `tool_search` | B7/C8 各 1 次 | 全新会话仍需要一次发现 compact tool，属于可接受的固定成本，但应继续观察。 |

暴露出的接口缺陷：

- Pipeline failure 投影只保留 `Verdict: FAIL` 与 TAP 片段，丢弃 Micro-Triage（已修）。
- `change({ architecture })` 无编辑时既不应用也不明确拒绝（已修提示）。
- `ship` 的 `kind:"module"` 报错只说“derived module identity”，没有给出可用 kind 列表（已修文案与文档）。
- advisory `ship` 重开会话后不提示 `receiptIds` 恢复通道（已修提示）。

## 21. 本轮修复

1. `packages/orchestrator/src/pipelines.mjs`
   - 新增 `extractMicroTriage`，Pipeline 失败投影优先保留 Micro-Triage 段落（上限 900 字符），再回退到原始失败片段。
   - `change` 收到 `architecture` 但没有 `edits/create/delete` 时，明确输出 `NOT applied` 并指向 `block.bind_auto` / `chain.compose`。
   - `ship` 在无 passing receipt 时提示 `ship({ receiptIds: [...] })` 恢复通道。
   - `kind:"module"` / `mod-*` 的报错补充可用语义 kind 列表。
2. `plugins/contextos/skills/contextos/SKILL.md` 与 `references/capabilities.md`：明确 `kind` 白名单与 `module` 禁止规则。
3. `scripts/contextos-ab-metrics.mjs`：新增可复跑的指标采集脚本，统一 rollout 与 Micro usage 口径。
4. 新增 3 个回归测试，`npm test` 从 315/315 提升到 318/318。

## 22. 下一轮待验证

1. 在全新隔离 C 会话中确认：保留 Micro-Triage 后，主模型不再发起第二次全量 inspect，并实际减少请求与工具往返。
2. 观察模型是否改用 `change` 承载编辑与架构绑定，从而把 `ship` 收敛到一次。
3. 验证 `ship({ receiptIds })` 在重开会话后的恢复是否被模型采用。
4. 继续评估 `work` 合并探索与编辑的可行性，以及 `ops telemetry rollout` 是否能替代人工解析。

## 23. 指标复跑

```bash
node scripts/contextos-ab-metrics.mjs \
  --label C8 \
  --rollout <rollout.jsonl> \
  --micro-usage <project>/.contextos/logs/micro-usage.jsonl
```

脚本从 rollout 读取请求数、输入/缓存/输出/reasoning/总 token、峰值输入、上下文窗口、工具调用分类、ContextOS 动作与失败项，并从 `micro-usage.jsonl` 读取 provider 请求数与 token；缺失 usage 时保持 0/null，不做字符估算。

## 24. 为什么主模型不适应 OS 开发

这一轮不是“模型不愿意配合”的问题，而是几个可验证的激励与信息结构问题。

1. **native 路径是保真的，OS 路径是有损投影。** `exec_command` + `apply_patch` 返回的就是原始字节；OS 的 `pipeline`/`verify` 返回的是受预算约束的摘要。当投影把 Micro-Triage 裁掉时，模型无法区分“没有诊断”与“诊断被截断”，理性选择是回到 native 重读。
2. **native 路径是确定的，OS 路径需要信任。** 模型对 `npm test` 的 TAP 输出有稳定的心智模型；对 `verify` 的 verdict/receipt 语义、`change` 的 propose/apply 边界、`ship` 的 advisory/strict 模式则需要额外推理。本轮 B7/C8 各自在 `change` 与 `ship` 上浪费了往返，正是这种信任成本。
3. **OS 的固定协议成本是显性的，收益是概率性的。** `explore → pipeline → verify → ship` 至少 4 次调用；节省则取决于任务是否真的需要跨模块探索。模型在“完成用户任务”的目标下偏好局部确定性，于是先做 native 修改，再把架构绑定推到 ship。
4. **接口摩擦把注意力从任务转移到工具。** compact tool 的 `args` 嵌套、动作推断、`change (propose)` 这种看似成功实为 no-op 的返回，都要求模型额外维护工具状态机。native 工具没有这层状态。
5. **验证所有权不清。** native `npm test` 的证据留在模型上下文里；OS `verify` 的证据留在 receipt/session 里。当 ship 关闭会话、重开后 `Passing receipts: 0` 时，模型会认为 OS 丢失了它的工作，从而进一步降低信任。
6. **架构簿记是用户目标之外的税。** 用户要的是“修复失败验收”，`ship` 的 Block/Chain 完整性属于系统自身治理。模型会把这类要求排到最后一刻，导致 ship 阶段集中暴露问题、反复往返。

对应到修复方向：OS 若要被自然采用，必须做到“投影不丢关键结论、接口不产生假成功、验证证据跨会话可追溯、协议成本低于它替代的 native 往返”。本轮已修前两项与第三项的提示，第四项仍需下一轮验证。

## 25. 直接原因：convergence gate 会拒绝正常读取

R6 报告完成后，用真实 MCP stdio 会话做了一次对照，发现 OS 被弃用有一个比“心智”更底层的原因：**OS 会在会话累计 6 次 discovery 调用后，拒绝返回数据本身。**

实测序列（同一个 MCP 进程，接入仓库里尚未关闭的旧 session）：

| 调用 | 结果 |
| --- | --- |
| `inspect(path, budget:"shallow")` | 329 字符，内容是 `# ContextOS convergence gate`，没有任何文件内容 |
| `inspect(path, budget:"full")` | 103,887 字符，绕过门控并返回整份文件 |
| `ops code.search`（顶层 `refresh:true`） | 330 字符，仍是门控文本 |
| `inspect(path, budget:"shallow", refresh:true)` | 2,022 字符，正常返回 |
| `ops code.search`（`args.refresh:true`） | 556 字符，正常返回 |

同一时刻 native 对照：`sed -n '1,60p'` 返回 2,391 字符，`rg -n` 返回 172 字符，均无需任何解锁参数。

这段实测暴露四个缺陷：

1. **门控替代了数据，而不是附加提示。** 调用方无法区分“没有命中”与“被策略拦下”，而 native 工具从不拒绝读取。
2. **唯一的逃生口都在关闭省上下文机制。** `refresh:true`、`dedupeReads:false`、`full:true`、`budget:"full"` 中，后两者直接返回全量内容（实测 103,887 字符）。门控把模型推向最贵的读取模式。
3. **被拦截的调用仍被记为 discovery telemetry。** 实测计数 6 → 8 → 10，越试越锁死，只有 mutation/verification 才能清零。
4. **计数是 session 级的，知识是对话级的。** 新对话接入未关闭的旧 session 时，会因为别的对话产生的 discovery 记录而被拦下，即使模型从未读过那些内容。实测第一次调用即被拦。

这四点叠加的结果是：模型只要尝试用 OS 读取或搜索，就有概率拿到一段没有数据的策略文本，并且重试会让情况更糟。任何理性的 agent 都会在此之后回到 native，OS 因此永远没有机会展示节省。

修复：`convergenceGate` 改为 `convergenceHint`，门控不再替换结果，而是把一句不超过 180 字符的收敛提示附加在真实 payload 之后；读取与搜索始终返回数据。修复后真实 MCP 复测：`inspect` 返回 2,212 字符数据 + 提示，`code.search` 返回 746 字符结果 + 提示。

## 26. 总 token 的分解：为什么 C 更贵，B 没优势

rollout 的 `total_tokens` 是逐请求 `input_tokens + output_tokens` 的累加，而每轮 input 约等于当轮完整上下文。因此可以近似为：

```
总 token ≈ 请求轮数 N × 平均上下文 C
```

R6 实测：

| 组 | N | 总 token | 平均上下文 |
| --- | ---: | ---: | ---: |
| A7 | 14 | 361,882 | ≈25,849 |
| B7 | 15 | 364,244 | ≈24,283 |
| C8 | 21 | 610,668 | ≈29,079 |

C 相对 A 多出的 248,786 token 可以拆成两部分：

- 多 7 轮 × A 的平均上下文 25,849 ≈ **+181,000（约 73%）**
- 平均上下文从 25,849 涨到 29,079 × 21 轮 ≈ **+68,000（约 27%）**

结论：**C 的负收益主要不是 OS 返回内容太大，而是多出来的模型往返。** 在 25K 至 30K 的平均上下文下，一次无效往返（契约错误、被裁掉的结论、重复 ship）本身就是约 25K 至 30K token。C8 的第二次 pipeline 与两次多余 ship 合计约 3 轮，直接对应约 90K token。

B 的 exec_command 从 21 次降到 7 次，但没有换来 token 优势，原因是省下的读取被这些成本抵消：

- 8 次 ContextOS 调用 + 1 次 tool_search，把请求轮数从 14 推到 15；
- OS 输出合计约 19.8K 字符（explore 561、pipeline 2,930、inspect 10,322、verify 3,141+331、ship 1,454+687、change 353）；
- 其中单次 `inspect` 返回 10,322 字符，等于把多份源码换个通道塞进主上下文。

也就是说，B 改变了信息的**传输方式**，没有改变进入主上下文的**信息量**。

### 26.1 底层架构问题

1. **OS 目前是传输层，不是过滤器。** 只要内容最终仍进入主上下文，native 读取与 OS 读取的上下文成本相同，OS 还多出协议往返。要省钱，信息必须在 OS 内部被消费，只把结论、计数与定位符交给主模型。
2. **优化目标错配。** OS 设计上优化峰值/瞬时上下文，宿主实际付费的是“轮数 × 每轮上下文”。降低峰值但增加轮数会净亏。
3. **生命周期串行化。** `explore → inspect → change → verify → ship` 每一步都是一次 MCP 调用，即一次模型往返；native 允许一轮内并行发起多个工具调用。除非用 `pipeline`/`work` 把多步压进一次调用，OS 结构上就输。
4. **Micro 位置错误。** 当前 Micro 摘要的是“已经产生并部分进入主上下文”的失败证据，属于对已付费内容再做一次付费。Micro 只有站在数据路径前面才有价值：命令在 OS 内执行，原始输出永不进入主上下文，只返回 verdict、triage 与 receipt。
5. **契约错误等于全额上下文税。** schema 缺 `projectRoot`、convergence gate、`kind:"module"`、`change` no-op、receipt 丢失，每一个都消耗一整轮完整上下文。
6. **宿主上下文不可淘汰。** 主上下文只增不减，OS 唯一的杠杆是阻止内容进入，因此“默认返回定位符而不是内容”必须是硬契约。
7. **反馈不对称与计数跨对话。** OS 节省是隐性的，OS 失败是显性的；再加上 session 级计数会被新对话继承，模型会形成“用 OS 有概率被拒绝、且省了也看不见”的学习结果。

### 26.2 开发期工具落后于代码

本会话的 ContextOS MCP 进程运行在 `~/.codex/plugins/cache/contextos-development/contextos/2.6.1`，而修复写在仓库并只重建了仓库 bundle。MCP 进程长驻，不会热加载，因此：

- 仓库里已修复的门控，在当前对话中仍然按旧行为拒绝读取；
- 每次修复都需要重装插件并重启会话才生效；
- 开发者在“开发 OS”的同时，手里用的永远是旧版本 OS，这本身就会强化“OS 不可靠”的判断。

### 26.3 可直接落地的减耗顺序

1. 默认响应改为“结论 + 计数 + 定位符 + top-k 行”，内容必须显式展开；目标 95% 的 OS 响应小于 300 token。
2. 一轮只发一次 OS 调用，用 `pipeline`/`work` 合并 3 至 6 个内部步骤；小任务取消 `explore`/`ship` 仪式。
3. 所有可能产生大输出的命令在 OS 内执行，只回 verdict、triage 与 receipt，禁止原始 TAP 进入主上下文。
4. 把每个契约错误当作 P0 修掉：`projectRoot` 可选、门控不吞数据、错误可执行、ship 幂等、receipt 跨会话可恢复。
5. 指标改为 turns-to-done、tokens-per-completed-task 与每轮上下文增量，而不是只看峰值。
6. 明确边界：多文件探索与长输出命令用 OS；单文件小修用 native。
7. 对目标任务类别让 OS 成为默认路径；否则 native 永远赢在“确定、无损、零准备”。

## 27. 当前 OS 的上限与重构方向

### 27.1 上限的量化

仍然使用 `总 token ≈ 轮数 N × 平均上下文 C`：

| 形态 | N | C_avg | 总 token | 相对 A7 |
| --- | ---: | ---: | ---: | ---: |
| A7 native 实测 | 14 | ≈25,849 | 361,882 | 基准 |
| C8 OS+Micro 实测 | 21 | ≈29,079 | 610,668 | +68.8% |
| 当前架构修好全部契约后的最好情况 | 8-10 | 20-22K | 176-220K | −39% 至 −51% |
| 目标形态（决策对齐批处理，宿主仍是唯一决策者） | 5-6 | 12-15K | 60-90K | −75% 至 −83% |

理论下限由系统提示、工具 schema 与 Skill 决定，约 10K 至 14K token。由于 OS 不是智能体，宿主必须保留全部语义决策，真实任务至少需要 5 至 6 个决策轮，因此**理论上限约 75% 至 83%，而不是无限接近 100%**。

但当前架构的上限明显更低：OS 仍然被宿主逐轮调用，每一轮都要重新发送完整上下文。即使把所有契约缺陷修完，也只能做到约 40% 至 50% 的节省。**40% 到 80% 之间的差距是架构差距，不是 bug 差距。**

### 27.2 四个硬边界

1. **宿主上下文只增不减。** OS 只能阻止内容进入，不能移除已进入的内容。所以“默认返回定位符”是硬契约，而不是优化项。
2. **一次宿主轮次只能触发一次工具往返。** OS 无法在同一轮里连续执行多个内部步骤（除 Pipeline 这种显式批处理），因此 N 的下限等于宿主需要做的决策数。
3. **OS 不能自主行动。** 每次执行都必须由宿主发起并等待返回，无法与宿主工作重叠，也无法在宿主不调用时推进。
4. **结论必须回到宿主。** 至少需要 1 至 2 轮把 verdict 和下一步交给宿主，这部分不可能省掉。

### 27.3 可优化项（不动架构，预计 40% 至 50%）

1. 默认响应改为“结论 + 计数 + 定位符 + top-k”，95% 响应小于 300 token。
2. 一轮一次 OS 调用，`work`/`pipeline` 合并搜索、读取、编辑、验证；小任务取消 explore/ship 仪式。
3. 所有大输出命令在 OS 内执行，只回 verdict + triage + receipt。
4. 消灭契约错误（每个约等于一整轮上下文）。
5. 度量改为 turns-to-done、每轮新增字节、toolRounds、hostTurnsSaved。

### 27.4 需要重构项（预计 70% 至 85%）

前提修正：**OS 不是智能体，它是外骨骼。** 它不能决定“改什么、为什么改、失败了怎么办”，也不能自主跑一个需要判断的循环。任何“把目标交给 OS，让它自己完成”的设计都不成立。分工只能是：

- 宿主模型：唯一的规划者与决策者；
- OS：执行、记忆与 IO 过滤，忠实执行宿主预声明的流程；
- Micro：宿主显式指派的受限专家（分类、摘要、诊断），不是智能体。

因此优化单位不是“轮数”，而是**决策点**：宿主每做一个判断，就应该只花一次往返，而这次往返要携带该判断所需的全部机械工作。

把 A7 的 14 轮拆开看，其中大部分不是决策，而是机械 IO（读文件、grep、跑测试、看输出）。机械轮可以整体压进 OS；决策轮不可省。重构目标就是把 N 从 14 压到真实决策数（约 5 至 6），同时让 C 从 25.8K 降到 12 至 15K：

| 决策点 | 宿主需要判断的事 | 一次 OS 调用应完成 | 宿主看到的 |
| --- | --- | --- | --- |
| 1 | 架构在哪、边界是什么 | 搜索 + 多文件符号级 inspect + 依赖关系 | 模块图与关键符号，约 500-1,000 token |
| 2 | 具体改什么 | 目标符号切片 + 失败语义 + 调用方 | 3-5 段精确代码 + 失败摘要 |
| 3 | 应用并验证 | 编辑 + 架构绑定 + 运行验证 | verdict + diff 摘要，约 200 token |
| 4 | 失败原因与修法 | 条件分支：验证失败则 triage 并给假设 | triage + 最小失败断言 |
| 5 | 确认收尾 | 幂等 ship + 证据归档 | 结论与引用 |

关键能力是**宿主预声明条件分支**：宿主写下“运行测试；若失败，则 triage 失败并返回前三个假设”，OS 忠实执行这个决策树。判断仍由宿主做出，OS 只负责执行分支，这不是自主循环。

**方案 B：上下文虚拟化。**
宿主只持有引用，内容全部留在 OS，按需 rehydrate 切片。降低 C 的增长速度，但不改变 N，预计 50% 至 60%。与外骨骼定位一致：OS 是外部记忆，宿主是注意力。

**方案 C：决策对齐批处理（推荐先做）。**
把 `work`/`pipeline` 从“单遍执行”升级为“一个决策所需的全部机械工作”，并支持宿主预声明的条件分支、预算上限与紧凑结果契约。这是外骨骼形态下唯一能同时压低 N 与 C 的路径。

### 27.5 对“平均 70%”目标的判断

70% 作为**全任务平均**不现实：单文件小修只需 1 至 3 轮，系统提示下限占比过高，OS 的开销无法摊薄。合理的分档目标是：

- 多步骤任务（≥5 个工具往返）：目标 70% 至 85%；
- 中等任务（3 至 4 轮）：目标 30% 至 50%；
- 单文件小修：目标 0% 至 20%，甚至允许使用 native；
- 按真实任务分布加权后，平均目标应设在 35% 至 50%，而不是 70%。

### 27.6 落地顺序

1. 阶段一：契约修复（门控、projectRoot、triage 保留、ship 幂等、receipt 恢复）。成本低，立刻消除负收益。
2. 阶段二：默认紧凑响应 + Micro 执行化（withOS、toolRounds ≥ 2）+ 真异步投递。
3. 阶段三：`work` 升级为决策对齐批处理，支持宿主预声明的条件分支与预算上限。
4. 阶段四：引入上下文虚拟化，让宿主只持引用，并度量“决策轮 / 机械轮”的比例。

每一阶段都必须用同任务 A/B/C 复验，且只有当 N 与 C 同时下降时才宣告收益。

## 28. 决策轮与机械轮基线（重构前）

`scripts/contextos-ab-metrics.mjs` 现在按 token_count 边界把每次模型请求还原成一个轮次，并按该轮的工具批次分类：mutation / verification / closure / decision（最终答复）算决策轮，纯读取、搜索、规划算机械轮。

| 组 | 轮数 | 决策轮 | 机械轮 | 工具/轮 | 最大批宽 | 上下文增长 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A7 native | 14 | 6 | 4 | 1.79 | 4 | 27,828 |
| B7 OS | 15 | 7 | 7 | 1.13 | 2 | 26,282 |
| C8 OS+Micro | 21 | 6 | 11 | 1.29 | 4 | 32,735 |

这组数据把前面的诊断钉死了：

1. **C8 的决策轮与 native 完全相同（6 轮），多出的 7 轮全部是机械轮。** 与总 token 分解中"73% 的惩罚来自多出的往返"完全对应。OS 没有增加决策负担，它增加的是机械往返。
2. **B7 的机械轮也比 native 多（7 对 4）。** 即使 exec_command 从 21 次降到 7 次，OS 的协议调用把机械轮推高了，所以总 token 持平。
3. **native 的批宽更高（1.79 对 1.13）。** A7 一轮最多并行 4 个工具调用，B7 最多 2 个。OS 的生命周期把可并行的工作串行化了。
4. **C8 的上下文增长比 native 还大（32,735 对 27,828）。** OS 既没有减少轮数，也没有减少每轮上下文。

重构目标由此可量化：**把机械轮从 11 压到 ≤4，把批宽提到 ≥2，决策轮保持 6 不变。** 若做到，C 组总 token 应落到 native 的 50% 以内；再叠加每轮上下文压缩，才有机会进入 70% 区间。

### 28.1 C8 的 21 轮逐轮拆解

| 轮次 | 输入 token | 内容 |
| ---: | ---: | --- |
| 1 | 9,615 | exec_command |
| 2 | 11,536 | 阶段答复（无工具） |
| 3 | 13,360 | update_plan |
| 4 | 13,622 | contextos:explore |
| 5-6 | 14,020 / 15,325 | contextos:pipeline ×2（第一次被预算截断，第二次重读） |
| 7-9 | 16,752 / 21,262 / 24,819 | 原生 exec_command ×8/×3/×2（13 条命令） |
| 10 | 27,277 | update_plan |
| 11 | 33,264 | apply_patch |
| 12 | 34,494 | contextos:verify |
| 13-15 | 34,894 / 37,411 / 38,174 | 原生 exec_command ×2/×1/×1（冒烟测试） |
| 16 | 39,645 | update_plan |
| 17-19 | 40,246 / 40,717 / 41,328 | contextos:ship ×3 |
| 20 | 42,031 | update_plan |
| 21 | 42,350 | 最终答复 |

可以直接归因的浪费：

- **update_plan ×4 轮**，且都发生在上下文 27K 至 42K 时，合计约 14 万输入 token 的重复发送，纯簿记。
- **原生 exec_command ×7 轮共 13 条命令**，与 OS 的 pipeline/verify 职责重叠，是"OS 与 native 并行两套流程"的直接成本。
- **pipeline 第二轮**源于第一次输出被 2,800 字符预算截断并丢掉 Micro 诊断（已修）。
- **ship ×3** 源于架构归属缺失与 `kind:"module"` 误用（已补文案与文档）。

理想形态只需 3 至 4 轮：合并 explore+inspect 的一次调用 → 一次 change+verify → 一次 ship。

## 29. 重构批次 1：执行器化与协议瘦身（R7 前置）

本轮不宣称 A/B/C 收益，只记录进入下一轮严格测试前已经消除的负收益来源。

### 29.1 Micro 从摘要器变成受指派执行器

- OS 层对无 preload 的 Micro 调用默认启用 `withOS`，宿主不再需要记住隐藏开关。
- 附有 pipeline/preload 的调用仍默认 `summarizer-only`，只有显式 `withOS:true` 才继续发起工具轮，避免把摘要任务意外升级成额外成本。
- 新增受限 `run` 工具，只有 `invocation.tools.allowCommands:true` 时才会暴露给 Micro。
- usage 新增 `executionMode`、`summarizerOnly`、`hostTurnsSaved`，并区分 `executor`、`executor-idle`、`summarizer-only`。

真实 provider 验收：

| 场景 | providerRequests | toolRounds | toolCalls | 结果 |
| --- | ---: | ---: | ---: | --- |
| 强制 `os inspect` 后回答 | 2 | 1 | 1 | 正确 |
| 强制 `run` 执行测试后诊断 | 2 | 1 | 1 | 正确 |

### 29.2 无尾 Micro 变成真异步

`delivery:"defer", background:true` 现在立即创建持久化 job 并返回，provider 在后台完成；结果进入原有 delivery queue，由后续顶层 OS 调用领取。真实 provider 实测主调用 26ms 返回 `running`，随后领取到完整答案。关闭 Micro session 不再丢弃未领取结果，只有显式删除 session 才会清理它自己的 pending delivery。

### 29.3 MCP 固定协议成本

同一会话内，MCP server instructions 与 compact tool description 会随每次 provider 请求重新注入，因此它们属于轮数乘数成本：

| 项目 | 重构前字符 | 重构后字符 | 降幅 |
| --- | ---: | ---: | ---: |
| Server instructions | 3,096 | 258 | −91.7% |
| Compact tool description | 1,646 | 342 | −79.2% |
| 合计 | 4,742 | 600 | −87.3% |

按 C8 的 21 轮计算，仅这一项每任务少注入约 87K 字符，约 21K token。详细操作说明移入只加载一次的 Skill，不再作为每轮工具 schema 重发。

### 29.4 计划状态缺陷

计划阶段把 Task 写成了 phase 使用的 `pending`，但 Task 生命周期只接受 `draft`。这会让任务无法 activate、note 或 finish。Task 构造器现在把旧 `pending` 迁移为 `draft`，并在迁移后继续执行正常生命周期校验。

### 29.5 宿主预声明条件分支

`pipeline` / `work` 现在接受：

```js
branches: [{ when: { failed: true, tool: "verify" }, then: [...] }]
budget: { maxActions, maxFailures, maxDurationMs }
```

OS 只匹配宿主写下的条件并执行对应分支，不自行判断修法。分支成功时状态为 `RECOVERED`；预算耗尽时熔断为 `HALTED` 并返回具体预算字段。这样“验证失败则 triage”可以发生在同一次宿主决策里，而不是等宿主看到失败后再发起一轮。

## 30. R7：决策对齐后的首轮真实复验

R7 使用三个独立 worktree、三个独立 `CODEX_HOME`、三个独立 MCP 进程，统一模型 `deepseek-v4.1-flash`、`xhigh`、权限与提示。任务是在一个真实 job-system fixture 中修复批量回放、幂等冲突、任务终态、重试次数和审计事件顺序，并运行完整 `npm test`。三组都修改了生产代码，均通过完整测试，未修改测试文件。

### 30.1 原始指标

| 指标 | A7 native | B7 OS | C7 OS+Micro |
| --- | ---: | ---: | ---: |
| 总请求数 | 20 | 14 | 18 |
| 工具调用数 | 41 | 13 | 17 |
| ContextOS 调用 | 0 | 10 | 12 |
| Micro 调用 | 0 | 0 | 0 |
| 输入 token | 628,293 | 326,315 | 374,845 |
| 缓存输入 token | 583,296 | 292,096 | 344,704 |
| 输出 token | 23,336 | 11,097 | 10,408 |
| reasoning token | 11,079 | 6,690 | 5,974 |
| 总 token | 651,629 | 337,412 | 385,253 |
| 峰值输入 token | 48,297 | 35,003 | 29,939 |
| 机械轮 | 4 | 8 | 12 |
| 决策轮 | 6 | 5 | 5 |
| 最大批宽 | 4 | 1 | 1 |
| 上下文增长 | 39,531 | 25,499 | 20,435 |

相对 A7，B7 总 token 降低 48.2%、请求降低 30%、峰值输入降低 27.5%；C7 总 token 降低 40.9%、请求降低 10%、峰值输入降低 38.0%。

### 30.2 有效性与测试污染

C7 第一次 `ship` 被阻止，原因不是生产代码缺架构归属，而是测试准备时把 smoke 状态放进了工作区：`.contextos-smoke/*` 被架构门控当成源文件。宿主因此重试 `ship`，多出一个请求。该请求不计入 C 方案的有效负收益。

按逐轮证据移除该重复收尾请求后，C7 约为 17 请求、346K 输入、355K 总 token，仍比 B7 多 3 个请求、约 6% 输入。剩余差异来自宿主行为，而不是 Micro provider：

- 两次宿主 `update_plan` 纯簿记轮，B7 为 0；
- 一次 ContextOS 读取未与前一决策完全合并；
- C7 使用原生 `apply_patch` 后另起 `verify`，没有采用 `change(edits + verify)`。

因此，这一轮不能证明 Micro 有收益，也不能证明 Micro 有负收益：C7 全程 `micro=0`，原始测试输出已被 OS triage 压到预算内，没有出现必须进入宿主的大块证据。Micro 的真实收益必须由后续专门制造大日志/堆栈且要求宿主诊断的任务验证。

### 30.3 R7 发现的工具缺陷

1. `contextos-ab-metrics.mjs` 只认旧的 `response_item/event_msg`，对当前 `codex exec --json` 的 `item.completed/turn.completed` 输出全部计为零。现在传入 exec stream 时可用 `--codex-home <dir>` 自动解析对应 `sessions/**/rollout-*.jsonl`；找不到逐请求 usage 会直接失败，不再返回假零值。
2. `.contextos-smoke`、`.contextos.tmp` 等保留状态路径会污染工作区指纹和架构门控。现在统一按 `.contextos`、`.contextos-*`、`.contextos.*` 忽略。
3. Skill 已明确禁止宿主在 OS 生命周期内额外调用 `update_plan`，并禁止把非平凡编辑拆成原生 `apply_patch` 后另起 verify。

### 30.4 下一轮验收条件

R8 必须从干净 worktree 开始，smoke 目录只能放在工作区外。除 R7 的功能任务外，另加一个“需要处理超过 2,000 字符原始失败证据”的任务，检查 C 是否按需触发 Micro，且把 Micro provider token 计入总成本。门槛仍是：机械轮 ≤4、最大批宽 ≥2、决策轮不高于 native，并且功能正确性全部通过。

## 31. R12：安装门禁缺失导致无效样本

R12 的三组都只配置了 marketplace/可见性，没有执行 `codex plugin add`。正式 rollout 中 ContextOS MCP 调用为 0，因此它实际上是三个 native 会话，不能用于收益判断。

结论：

- marketplace 配置只让插件可发现，不等于插件已安装并启用。
- 有效测试必须在启动前检查 `codex plugin list --json` 中存在 installed + enabled 的 ContextOS 插件。
- 修复：`scripts/install-plugin.mjs` 现在把安装状态作为硬门禁，新增 `npm run plugin:install:check`，并支持 `CODEX_HOME` 与 `CONTEXTOS_HOME` 隔离目录。

## 32. R13：有效 A/B/C 与仍未达到目标的证据

R13 使用同一提交、同一任务文本、同一模型和 full-access 条件。B/C 均实际调用 ContextOS 8 次，bundle 哈希一致。

| 指标 | A Native | B OS | C OS+Micro |
| --- | ---: | ---: | ---: |
| 请求 | 15 | 12 | 13 |
| 工具调用 | 23 | 14 | 12 |
| ContextOS 调用 | 0 | 8 | 8 |
| Micro 调用 | 0 | 0 | 2 |
| 主模型输入 token | 298,229 | 210,192 | 240,907 |
| 缓存输入 token | 272,000 | 187,136 | 218,496 |
| 主模型输出 token | 14,969 | 11,566 | 8,425 |
| reasoning token | 8,896 | 7,432 | 5,089 |
| 主模型总 token | 313,198 | 221,758 | 249,332 |
| 正式任务 Micro token | 0 | 0 | 755 |
| 合计总 token | 313,198 | 221,758 | 250,087 |
| 峰值输入 token | 30,094 | 29,376 | 28,851 |
| 决策轮 | 6 | 4 | 2 |
| 机械轮 | 6 | 7 | 10 |

相对 A：

- B 主模型总 token 下降约 29.2%。
- C 主模型总 token 下降约 20.2%；把正式 Micro provider token 计入后仍下降约 20.2%。
- C 的 `micro-usage.jsonl` 还包含一次预检调用 95 token；正式成本必须排除它，预检也不能复用正式 `.contextos` session。

三组都完成生产代码修改并通过 3/3 测试，测试文件未被修改。

## 33. R13 核心调用链与根因

C 的调用链：

1. 首次 `pipeline(explore + verify)` 返回 `PARTIAL`，已经包含 Micro-Triage、根因、首个栈帧和 receipt。
2. 宿主仍调用 `resume` 两次：第一次请求 `full:true` 和 `maxChars:30000`，第二次只传 artifact。
3. 宿主随后执行 3 次 `inspect`，其中包括 `budget:"shallow"` 扫描 `src`/`test`，以及显式 `maxChars:30000` 的多文件读取。
4. 宿主穿插原生 `rg --files` 和 `rg -n`。
5. 最后 `change(edits + verify + architecture + ship)` 一次成功，`npm test` PASS。

根因不是 Micro provider，而是决策包在宿主侧不可用：

- Pipeline receipt 模式把每个成功动作压成 `ok`，丢掉 `Where to look` 和 `Next`，导致宿主必须 resume。
- `inspect` 的显式 `maxChars` 可以绕过默认预算，把多文件正文重新灌回主上下文。
- `budget:"shallow"` 对小于阈值的文件仍返回完整正文，没有兑现“outline only”。
- `CONTEXTOS_HOME` 没有进入插件 `env_vars`，预检读取了全局 profile，隔离证据不成立。
- 当前会话仍可能运行旧 bundle，源码已修的 convergence hint 在安装版本中仍表现为 gate；因此任何修复都必须 rebuild + reinstall + 新会话复验。
- R13 的两次 Micro 都是 summarizer-only，`toolRounds=0`，没有证明执行型 Micro 的收益。

## 34. R13 后已落地的修复

1. `pipeline` receipt 模式从 180 字符状态码升级为 700 字符决策包，保留 `Next`、`Where to look`、失败根因、receipt 和下一步动作；总 response budget 仍限制在 1200 字符。
2. Pipeline failure projection 增加 `next=change(...)`，让宿主看到根因后直接进入修改，不再为了恢复证据额外 resume。
3. `resume` 遇到 `response:pipeline` 时不再 raw replay，只返回有界 preview；原始 artifact 读取必须显式走 `ops artifact.read full:true`。
4. `inspect` 的 `budget:"shallow"` 强制返回 AST Outline；显式 `maxChars` 不能再突破 inspect 默认上限。
5. 默认响应预算整体收紧：inspect/work 2400，pipeline 1600，ops 1200，micro 1200；显式 `format:"json"` 的 ops 仍保持完整 JSON 契约。
6. `.mcp.json` 的 `env_vars` 增加 `CONTEXTOS_HOME`；system doctor 同时显示 ContextOS Home 与 global profile 路径。
7. `scripts/install-plugin.mjs` 增加安装门禁、`CODEX_HOME`/`CONTEXTOS_HOME` 隔离支持与 `--check` 模式；未安装时拒绝继续同步旧 bundle。
8. Skill 明确禁止通过 shell 重读自身、禁止在已有 Pipeline 决策包后 resume，并给出执行型 Micro 的显式参数与验收字段。

## 35. R14 启动条件

R14 必须满足：

1. A/B/C 各自使用全新 worktree、`CODEX_HOME`、`CONTEXTOS_HOME` 和 MCP 进程。
2. 每个 OS 组先执行 `npm run plugin:install:check`，并确认插件 installed + enabled。
3. 预检使用独立 `CONTEXTOS_HOME`，正式 rollout 不得继承预检 session、delivery 或 Micro usage。
4. B/C bundle 哈希必须与仓库 build 一致；C 的 Micro provider probe 返回 `PONG`。
5. C 额外执行一次执行型 Micro probe：`withOS:true`、`invocation.tools.enabled:true`、`allowCommands:true`、`provider.maxRequests >= 3`，要求 `toolRounds >= 2`、`toolCalls >= 1`，并单独记录 provider token。
6. 首个 Pipeline 返回决策包后，宿主不得调用 `resume`，不得在 OS 调用之间穿插 `rg`/`cat`/`npm test`，编辑与验证必须走同一次 `change`/`work`。
7. 验收指标仍为正确性、请求数、工具调用、ContextOS/Micro 调用、决策轮、机械轮、峰值输入、主模型 token 和 Micro provider token。

R14 的最低机械轮目标：机械轮 ≤4，最大批宽 ≥2，决策轮不高于 native，总 token 相对 native 至少下降 40%；随后再向多步骤任务 70% 目标迭代。

## 36. R14-C：修复后复测前的架构门禁

R14-C 使用隔离的 `codex-home`、`contextos-home` 和仓库快照，正式 rollout 指标为：18 请求、18 工具调用、11 次 ContextOS、1 次 Micro；主模型总 token 421,377，峰值输入 33,744；Micro 851 token 且 `toolRounds=0`、`summarizer-only`。调用中仍然出现 4 次 `inspect`、3 次只读 `work`、原生 `rg`、原生 `apply_patch`，以及先 `ship` 关闭 session、再 `verify`、再开新 session `ship` 的顺序。

本轮确认的架构缺陷：

1. 多文件或目录 `inspect({ budget:"full", paths:[...] })` 仍可能把批量正文灌回宿主；现在批量请求强制 AST outline/locator，`full` 只对单文件或单符号展开。
2. `work.search` 不接受模型自然产生的 `{ query, paths:[...] }` / `{ query, path }`，导致搜索结果为空后回退原生 `rg`；现在归一化为搜索根目录，并保留多根目录的有界展开。
3. `explore` 只给两三个文件 outline，没有直接 import、反向 caller、test entry；现在在同一响应预算内追加一跳依赖闭包与关键符号，使下一次宿主决策可以直接进入编辑。
4. 无 passing receipt 的 `ship` 会关闭 session，迫使宿主在 verify 后重新开启 session；现在非严格模式也会以 `BLOCKED (verification evidence)` 阻断并保持 session，只有显式 `allowUnverified:true` 才允许未验证关闭。
5. Skill 已同步 `work.search` 别名、批量 outline、依赖闭包和无证据 ship 规则；插件构建与安装状态必须通过 `npm run plugin:install:check` 后才能做正式 R14 复测。

新增回归覆盖：批量 full inspect 不返回正文、`work.search.paths` 映射、`explore` 返回 direct import/test entry、无证据 ship 阻断与验证后关闭。`npm test`、`npm run plugin:verify`、`npm run plugin:install` 均已通过。

R14-C 的下一轮有效门槛保持为：零 `resume`、机械轮 ≤4、最大批宽 ≥2、OS 内编辑、无多文件 full dump、独立 home 预检、bundle 哈希一致；主指标继续记录请求数、工具调用数、OS/Micro 调用、决策/机械轮、峰值输入、主模型 token 和 Micro provider token。

## 37. R34：工具不可见与决策包不完整的复合负收益

R34 使用三个独立 worktree、三个独立 `CODEX_HOME`、三个独立 `CONTEXTOS_HOME` 和三个独立 MCP 进程，执行同一项真实多文件开发任务。三组生产代码均完成，完整测试均通过，测试文件未修改；因此这轮是有效功能样本，但仍不是有效收益样本。

### 37.1 指标

| 组 | 请求 | 工具 | ContextOS | Micro | 峰值 input | 总 token | 相对 A |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A Native | 32 | 47 | 0 | 0 | 120,866 | 2,459,609 | baseline |
| B OS | 59 | 76 | 0 | 0 | 134,289 | 5,094,714 | +107.1% |
| C OS+Micro | 40 | 79 | 17 | 0 | 129,267 | 3,466,406 | +40.9% |

B 和 C 的总 token 都高于 native。C 的 17 次 ContextOS 调用没有把请求数压到 native 以下，反而叠加了恢复读取；Micro 全程为 0，不能声称执行器收益。

### 37.2 根因一：B 没有跨过 `tool_search` 发现门槛

当前 Codex 0.150.1 会把插件提供的 MCP 工具延迟到 `tool_search` 后才加入可见目录。`tool_search_always_defer_mcp_tools` 已进入 `removed` 状态，配置 `false` 或 `--disable` 都不能恢复首轮可见性。R34-B 没有执行这次发现，所以 59 次请求和 76 次工具调用实际上仍是 native 轨迹，只是多了 Skill 与协议噪声。

修复：安装脚本不再声称关闭旧 flag 后工具会首轮可见，而是显式报告 `tool_search` discovery mode；Skill 要求非平凡任务在原生探索前先执行一次 `tool_search`；隔离 A/B/C 的 B/C 启动提示必须包含同一步。隔离 launcher 还必须直接导出 `CONTEXTOS_HOME`，因为插件配置里的 `env` 不会覆盖 MCP 进程环境，`.mcp.json` 只会转发调用方已有的环境变量。

### 37.3 根因二：C 的首包不可直接执行

C 的实际形状是 `1 pipeline + 7 inspect + native fallback`，不是目标形状 `pipeline(explore + inspect + verify) -> change(edits + verify + ship)`。首个决策包 `read_complete=false`，遗漏 `process-manager.mjs`、`v2-service.mjs`、`sanitizer.mjs`；宿主随后用多次单文件读取和原生探索补回，恢复了被 OS 压缩掉的全部上下文成本。

已定位并修复的具体缺陷：

1. 冷启动全局 symbol search 只搜索已有 Block 中的文件；没有 Block 时无法发现 `v2-service.mjs`。现在先做 bounded textual search，再把命中文件加入 symbol search candidate，无命中时回退 workspace source files。
2. 大文件 focus 只标记 missing，没有按 intent identifier 做 AST symbol 切片。现在对超过 8000 字符的实现文件返回最多 4 个匹配 symbol 的 bounded slice；只有完整切片才计入 `read_complete=true`，超大符号仍保持 partial。
3. 嵌套 `inspect.full:true` / `budget:"full"` / `maxChars` 被外层 response finalizer 二次截断到 inspect 2400 字符预算。现在嵌套请求会向外层 finalizer 透传 widening，单次 full recovery 的上限为 32000 字符。
4. compact inspect 对 `inspect: [...]` 数组别名返回 `No target path provided`。现在数组、对象、path、paths、symbol、query、ranges 都能归一化。
5. `ship` 架构预检在部分 Block 已持久化后才因同路径多 owner 失败。现在所有 path owner / existing Block owner 冲突在写入前预检，失败不留下部分所有权。
6. Skill 原文件约 10.5KB，B 还用 shell 重读一次，固定协议成本随每轮重放。现在 Skill 压缩到约 4.8KB，明确禁止重读，并给出两次 OS 调用的目标形状。

### 37.4 为什么 OS 会输给 native

这不是“OS 没有搜索功能”这么简单，而是四个层次同时失配：

- **可见性失配**：插件 MCP 工具不在首轮目录里，宿主必须执行一次 `tool_search` 发现；若跳过该步骤，模型自然先走 native。Skill 已加载不等于 MCP 工具已进入当前工具目录。
- **决策包失配**：OS 返回了 `read_complete=false`，却没有把下一步真正需要的精确切片放入同一次响应，宿主只能再次探索。
- **生命周期失配**：宿主把 `explore`、`inspect`、`verify`、`change`、`ship` 拆成多轮，OS 的会话和 artifact 没有成为可替代的执行面，反而成为额外重放层。
- **心智失配**：在 native 工具始终可用且 OS 有额外协议开销时，模型会优先选择熟悉路径；OS 必须通过首轮可见、首包可执行、失败可恢复来主动替代 native，而不是等待模型自发迁移。

OS 不是智能体，只是宿主智能体的外骨骼。外骨骼不能替宿主决定改什么，但必须把宿主已经决定的机械工作一次完成、只返回执行所需的精确信息，并在失败时给出可继续的 bounded recovery。R34 的负收益来自外骨骼没有接上，而不是宿主必须替外骨骼思考。

### 37.5 修复后的验证状态

- `node --test packages/orchestrator/test/orchestrator.test.mjs`：81/81 PASS。
- `npm test`：369/369 PASS。
- `npm run plugin:verify`：构建、V3 工具面、命令脱敏、Knowledge/Architecture passthrough PASS。
- 新增回归覆盖：数组 inspect 别名、嵌套 full 不二次截断、冷启动大文件符号切片、超大符号保持 partial、架构 owner 冲突预检。

### 37.6 R35 有效样本门槛

1. A/B/C 使用全新 worktree、`CODEX_HOME`、`CONTEXTOS_HOME`、marketplace 和 MCP 进程；正式 rollout 不继承预检 session、delivery 或 Micro usage。
2. B/C 在原生探索前先执行一次 `tool_search`，query 固定为 `ContextOS compact repository tool`；确认随后出现并实际调用 `mcp__contextos__contextos`，而不是再次退化成 native。启动进程必须显式导出各自的 `CONTEXTOS_HOME`。
3. 首个决策包必须 `read_complete=true`；允许 0 至 2 次 recovery inspect，不允许源码探索类 native `cat`/`sed`/`rg`，不允许重读 Skill。
4. C 必须在需要超过 2KB 原始失败证据的任务中实际调用 Micro；检查 `providerRequests`、`toolRounds`、`toolCalls`、`executionMode`，并单独记录 Micro provider token。
5. 指标仍同时报告请求数、工具调用数、ContextOS/Micro 调用、峰值 input、主模型 token、Micro provider token 和总 token。最低门槛先让 B/C 总 token 低于 A，再继续逼近多步骤真实开发任务下降 70%。

## 38. R35：有效但未达目标的 A/B/C 与工具自描述缺陷

R35 使用快照 `836ecded66e20280f5be280bfd297d04fdf7a909`，A/B/C 各自使用独立 worktree、`CODEX_HOME`、`CONTEXTOS_HOME` 和 MCP 进程，执行同一项真实多文件开发任务。B/C 都实际调用了 compact ContextOS；三组功能均完成，B/C 的 `npm test` 由主控在会话结束后独立复跑并退出 0。

### 38.1 指标

| 组 | 请求 | 工具 | ContextOS | Micro | 输入 token | 输出 token | 总 token | 峰值 input | context growth | 失败 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A Native | 44 | 66 | 0 | 0 | 3,882,551 | 49,621 | 3,932,172 | 142,652 | 133,670 | 2 |
| B OS | 40 | 39 | 30 | 0 | 2,014,985 | 43,211 | 2,058,196 | 82,868 | 72,960 | 0 |
| C OS+Micro | 46 | 47 | 43 | 0 | 2,241,071 | 41,246 | 2,282,317 | 85,267 | 75,359 | 4 |

相对 A：B 总 token 下降 47.7%，C 下降 41.9%。B 比 C 少 224,121 total token，约 9.8%。B 的 ContextOS actions 为 `pipeline 2, work 4, inspect 9, change 3, ops 9, verify 2, ship 1`；C 为 `pipeline 5, inspect 12, work 7, ops 11, change 5, verify 2, ship 1`。

结论：B 已是当前最好组，但远未达到 70% 目标；C 的负差主要来自更多请求、更多 OS 调用和 MCP contract 失败，不是 Micro provider 成本。

### 38.2 C 的 4 次 MCP 失败

1. 尝试 `ops({ capability: "architecture" })`，但 capability 未公开。
2. 尝试 `ops({ capability: "block", action: "get" })`，实际只接受 `open`。
3. 尝试 `block.inspect`，实际只接受 `open`。
4. 尝试未经 schema 自描述的 `change` edit 和 chain compose 形状，宿主只能靠错误响应重新试。

B 之所以没有这些失败，是因为它用 native `cat/rg/sed` 读取了 Skill、capability 文档和工具实现。这说明 OS 自身文档与错误预检不合格，不能用“B 没失败”掩盖协议缺陷。

### 38.3 已落地修复

1. 合并 B 的 bounded-log 实现：`run_command` 和 `process` 支持 `maxLogBytes`，日志只保留尾部并写入精确 `[contextos:log-truncated]` 标记；receipt 返回 `logBytes` 与 `logTruncated`。
2. 补上 C 的 MCP 透传：`run_command`、`process`、`verify` 和 `change` 验证路径都能把 `maxLogBytes` 传到 runner/process manager。
3. compact tool 描述现在自描述 `work/change/inspect` 形状和全部合法 `ops` capabilities；`architecture` 成为公开 capability，`block.get`/`block.inspect` 自动 alias 到 `block.open`。
4. `change({ architecture })` 现在是合法的 state-only 原子写入，直接复用 `bindChangedArchitecture` 的全量预检和 Block/Chain 写入，不再先返回“NOT applied”再要求第二次 `bind_auto/compose`。
5. `architecture` capability 提供 `list/open/search/bind_auto/compose` 的 compact 发现路径；Block/Chain 发现不再依赖 shell 读 capability 文档。
6. Micro `errors-only` 从“只允许 curated Block/Chain 写入”改为通用 fire-and-forget：成功结果写入 artifact/receipt 并从宿主响应隐藏，任何失败的 tool call 仍返回错误。`delivery:"defer"` 继续在后续顶层 OS 调用恢复。
7. Skill 不再要求 shell 重读 capability reference；明确列出合法 capabilities、state-only architecture、`maxLogBytes` 和通用 `errors-only` 语义。

### 38.4 修复后的本地证据

- `npm test`：374/374 PASS。
- `npm run plugin:verify`：PASS。
- `npm run acceptance:micro`：PASS。
- `npm run dist:smoke`：PASS。
- `node scripts/micro-executor-acceptance.mjs`：PASS，输出为 `providerRequests=3, toolRounds=2, toolCalls=2, executionMode=executor, totalTokens=101, errorsOnlyDelivery=success-hidden`。该验收不是 A/B/C benchmark，只用于验证 Micro 生命周期和执行型证据；A/B/C 仍必须用真实会话手动运行。

### 38.5 为什么 Micro 轮数没有自动下降

Micro 不是“把脏对话丢出去”就会自动省轮次。当前架构中它只减少宿主可见的中间证据，不减少宿主必须做出的决策；如果宿主没有把足够证据绑定在第一次 Micro 调用上，或者任务本身没有超过 2KB 的证据，Micro 就不会被路由。R35 的 C 组 Micro=0 是因为基线直接通过，按当前 Skill 路由规则确实不应触发；这不等于 Micro 生命周期已验证。R36 必须用专门的 C-only 大失败证据任务检查 `providerRequests/toolRounds/toolCalls/executionMode`，不能把 summarizer-only 或未触发当成收益。

### 38.6 R36 门槛

1. A/B/C 仍使用同快照、同模型、同提示、独立 worktree、独立 home、独立 MCP 进程，不并行运行。
2. B/C 在正式任务中 MCP schema/discoverability 失败必须为 0；不得用 native `cat/sed/rg` 重读 Skill、capability 或工具实现。
3. 首包必须让宿主在最多一次 bounded recovery 后进入修改；多文件 inspect 只能返回 outline/locator，不能把多文件正文灌回宿主。
4. C 必须有一个超过 2KB 的真实失败证据任务，第一次 Micro 调用直接携带 pipeline evidence，并至少出现 `toolRounds>=2`、`toolCalls>=1`、`executionMode!=summarizer-only`；Micro provider token 计入总成本。
5. 记录总请求、工具调用、ContextOS/Micro 调用、峰值 input、主模型 token、Micro provider token、总 token 和正确性；正确性不通过时收益无效。
6. 最终目标仍是多步骤真实开发任务总 token 相对 native 下降 ≥70%；未达到时必须给出可复现瓶颈，不能把缺失 usage 或主线程省 token 当作收益。

## 39. R42/R43 最终闭环：温度控制下的 ≥70% 有效样本

### 39.1 控制条件

- fixture commit：`6408896981f4b6a98c087b1e52d0db5a8ff6a13d`。
- 模型：`deepseek-v4.1-flash`，`model_reasoning_effort=xhigh`，R43 run5 增加 `model_temperature=0`。
- A/B/C 使用独立 clone、`CODEX_HOME`、`CONTEXTOS_HOME`、marketplace 与 MCP 进程，按 A → B → C 串行执行。
- 三组提示词完全一致：`快速理解当前项目并修复失败验收。批量回放必须保留幂等键、冲突检测、终态、重试次数和事件顺序，并据此生成审计报告。不得修改测试或降低断言。完成生产代码后运行完整验收测试。`
- 三组均在会话结束后由主控独立执行 `npm test`；三组生产代码均完成，测试文件未修改。

### 39.2 R43 run5 指标

| 组 | 请求 | 工具调用 | OS 调用 | Micro | 峰值 input | 总 token | 相对 A | 正确性 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| A Native | 14 | 23 | 0 | 0 | 31,633 | 307,243 | baseline | PASS 3/3 |
| B OS | 5 | 4 | 2 | 0 | 21,816 | 79,299 | -74.2% | PASS 3/3 |
| C OS+Micro | 5 | 4 | 2 | 0 | 24,031 | 83,779 | -72.7% | PASS 3/3 |

B/C 的 OS 调用形状稳定为一次 `pipeline` + 一次 `change`，没有 `resume`、没有多轮 `inspect`、没有原生源码探索，也没有在 `change` 已 `verified and shipped` 后再次运行 `npm test`。C 的 Micro 配置可用，但这轮失败证据是明显的未实现桩函数且体积很小，按新门控正确地没有调用 Micro；把这类失败强塞给 Micro 只会增加 provider token。

### 39.3 R43 迭代中的方差与失败样本

| 运行 | A 总 token | B 总 token | C 总 token | 结论 |
| --- | ---: | ---: | ---: | --- |
| R43 run1 | 264,343 | 85,200 | 88,213（含 Micro 809） | B -67.8%，C -66.6%；形状已接近目标，但 C 有 summarizer-only 负调用 |
| R43 run2 | 281,181 | 779,274 | 887,670 | 禁止读 Skill 的启动指令实验失败；宿主回退到 19–24 次原生命令 |
| R43 run3 | 354,281 | 306,718 | 210,675 | Skill 压缩过度，宿主把决策拆成 10–14 个 OS 回合 |
| R43 run4 | 269,440 | 119,916 | 108,815 | 协议恢复但未固定温度；宿主额外跑了 1 次原生验收 |
| R43 run5 | 307,243 | 79,299 | 83,779 | `temperature=0` 后 B -74.2%、C -72.7%，达到目标 |

结论：ContextOS 当前的上限已经能覆盖目标，但收益高度依赖宿主是否遵守“一个决策一次 OS 调用”。温度、Skill 完整度和工具返回形状会共同放大或抵消收益；单一运行不能替代重复样本。

### 39.4 本轮根因与修复

1. `shouldAutoVerifyExplore` 一度把任何非空 intent/task 都当成自动验证信号，导致信息型 explore 额外执行基线 verify。现在只对修复/实现+验证意图或显式任务验证词生效。
2. `bindChangedArchitecture` 允许没有 Chain 成员的 Block 写入，迫使宿主再发一次 `change` 补 Chain。现在对未覆盖的准备态 Block 自动合成确定性的 `chain-changed-surface`，并保留既有 Chain 的成员合并语义。
3. profile 的 `autoTriage=true` 会强制把明显的 `not implemented` 桩函数也送进 Micro，R43 run1 C 因此多花 809 token 的 summarizer-only 调用。现在显式 `autoTriage:true` 仍可强制；profile 自动分诊会跳过 obvious root cause 和 full-evidence 模式。
4. Skill 不能压缩成只保留口号；宿主需要完整的“首调用 pipeline、禁止目录级重复 inspect、`change` 已 shipped 后立即收口、只绑定本次变更路径”协议。R43 run5 使用恢复后的完整协议。
5. 架构 payload 改为只绑定本次变更路径，避免为了修两个文件枚举整个仓库。OS 仍要求每个 tracked path 有唯一 Block owner 和至少一个 Chain 成员。
6. `model_temperature=0` 是控制宿主采样方差的关键实验变量；它不是 ContextOS 运行时依赖，但缺少它时宿主可能把一个决策拆成多个回合，从而掩盖 OS 的真实收益。

### 39.5 Micro 的当前结论

- 本轮 A/B/C 任务不需要 Micro：基线失败已经由 pipeline 的 compact verify 证据直接暴露，Micro 的 summarizer-only 路径是负收益。
- 独立执行器探针已验证生命周期：`providerRequests=3`、`toolRounds=2`、`toolCalls=4`、`executionMode=executor`；主 Micro 调用约 11,633 provider token，另有 summarizer 766 token。
- Micro 应按证据体积和任务边界路由：只有原始失败/日志证据超过约 2KB，或宿主明确分配一个 bounded executor 任务时才应启用；`errors-only` 适合 fire-and-forget，`defer`/`auto` 适合宿主还能继续工作的场景。

### 39.6 剩余架构缺口

- OS 无法拦截宿主原生工具；宿主仍可能在非零温度或指令遵循波动时额外跑一次 native `npm test`。当前依靠 Skill、工具描述和 `change` 的 `verified and shipped` 收口提示约束，尚未形成硬门禁。
- convergence gate 目前是提示而非硬阻断；可在“已有 `read_complete=true` 决策包且没有 mutation/verify”时，把后续 standalone `explore`/`inspect` 直接拒绝，逼宿主进入 `change`/`work`。
- 峰值 input 的下降仍有限（31.6k → 21.8k/24.0k）；主要收益来自请求数和工具链的坍缩，而不是单次返回的极端压缩。
- 自动生成的 `chain-changed-surface` 保证结构完整，但语义质量仍取决于宿主提供的 Block 边界；后续需要在真实复杂任务中验证它不会成为“形式上有 Chain”的伪闭环。

### 39.7 当前验证状态

- `npm test`：PASS。
- `npm run plugin:verify`：PASS。
- `npm run plugin:build`：PASS；最终 bundle hash `5a389b18c9f074a36829c3ca416d58087f8499a6c06b92f4759136d393889dcc`。
- R43 run5 A/B/C fixture：`npm test` 全部 PASS，测试文件未修改。
- R43 run5 rollout：A `/Users/a1-6/ab-r43-run5/a.jsonl`，B `/Users/a1-6/ab-r43-run5/b.jsonl`，C `/Users/a1-6/ab-r43-run5/c.jsonl`。

### 39.8 下一轮门槛

1. 在同一 `temperature=0` 条件下至少重复 R43 run5 两次，报告 A/B/C 的中位数和分布，不能只拿单次最优样本。
2. ~~增加 decision-packet 后只读硬门禁~~：R47-R51 验证发现硬拒绝会阻断只读 recovery、复用型 `explore` 和 search alias，属于能力损失；已撤销，改为 Skill 收敛引导 + 非阻断 convergence hint。
3. 设计 C-only >2KB 原始失败证据任务，首次 Micro 调用直接携带 pipeline evidence，并同时记录 `providerRequests`、`toolRounds`、`toolCalls`、`executionMode` 与 provider token。
4. 保持“只绑定本次变更路径”的架构负载约束，验证自动 `chain-changed-surface` 在复杂多模块任务中的语义正确性。
5. 继续以总 token 相对 native 下降 ≥70%、请求/工具坍缩、峰值 input 和正确性四项一起作为有效样本门槛。

## 40. R47-R51 严格隔离复验：真实收益、方差与边界

### 40.1 隔离修正

R43 及更早的 A 组使用 `--dangerously-bypass-approvals-and-sandbox`，宿主可以读取同级 fixture、原始仓库和 git remote；这会把 A 的探索成本抬高，制造出偏高的节省比例。R47 起改为：

- 三组各自位于独立顶层目录：`/private/tmp/contextos-ab/<run>-{a,b,c}`，不再共享父目录。
- 克隆后执行 `git remote remove origin`，宿主无法从 remote 推断源仓库。
- 每组独立 `CODEX_HOME`、`CONTEXTOS_HOME`、marketplace、MCP 进程和临时目录。
- 外层 `sandbox-exec` 拒绝 `/Users/a1-6` 读取，仅放行自己的 run root；探针确认 `cat /Users/a1-6/ab-r6-micro-routing/c8/mdflow/package.json` 返回 `Operation not permitted`，同时 ContextOS 工具仍可正常调用。
- 三组仍按 A → B → C 串行执行；A 不使用插件，B 使用 OS，C 使用 OS+Micro profile。

### 40.2 关键样本

| 运行 | A 请求/工具/峰值 input/总 token | B 请求/工具/峰值 input/总 token | C 请求/工具/峰值 input/总 token | 正确性 |
| --- | --- | --- | --- | --- |
| R47 严格隔离 | 9 / 24 / 30,960 / 192,406 | 5 / 4 / 28,683 / 93,373 | 5 / 4 / 24,266 / 84,600 | A/B/C 全部 PASS |
| R48 严格隔离 | 13 / 26 / 33,536 / 303,958 | 5 / 4 / 24,196 / 93,490 | 5 / 4 / 24,266 / 84,600 | A/B/C 全部 PASS；B/C 均更新 barrel |
| R49 A + B | 15 / 24 / 33,226 / 340,754 | 8 / 7 / 25,420 / 151,181 | 未跑 | A/B PASS |
| R50 B/C（最终 Skill + 归一化） | 使用 R49 A 基线 | 6 / 5 / 24,088 / 107,334 | 5 / 4 / 23,762 / 83,950 | B/C PASS；B 因宿主一次错误 target 多一轮，C barrel 正确 |
| R51 C（`task` alias 修复后） | 使用 R49 A 基线 | 未跑 | 7 / 6 / 24,646 / 133,346 | PASS；宿主把 verify/ship 拆成额外轮次 |

三组 A 的 native 总 token 为 192k、304k、341k，中位数 304k；请求 9/13/15，工具 24/26/24，峰值 input 31.0k/33.5k/33.2k。A 的方差主要来自宿主是否批量读取、是否使用 `update_plan`、是否额外跑验收命令，而不是 ContextOS 行为。

C 在协议合规的 R47/R48/R50 三次都落在 84.0k-84.6k、5 请求、4 工具、峰值 23.8k-24.3k；相对中位数 A 节省约 72%，相对最省 A 节省约 56%。R51 因宿主把 `change` 拆成 `change -> verify -> ship`，退化为 7 请求/133k，但仍低于 A。B 的合规样本为 93k-107k；R49 的 151k 是 Skill 过度压缩导致协议退化的负样本。

### 40.3 本轮确认的缺陷与修复

1. **硬读取门禁是错误方向**：它阻断只读 `work`、复用型 `explore`、search alias，违反“读取/搜索永不返回策略文本代替数据”的契约；已删除，保留读取预算跨 mutation/verify 重置。
2. **public surface 闭包漏判**：只检查 `focus.paths`，没有检查 decision package 里的 stub 模块，导致 `src/index.mjs` 明明缺少 `audit-report`/`batch-replay` 却提示“已全部导出”。现改为以 decision-package modules 计算，并增加回归测试。
3. **test fixture 污染决策包**：`test/fixtures/*` 被当成测试契约内联，浪费约 1KB+ 上下文；现在只内联真实 `*.test.*`/`*.spec.*` 契约。
4. **架构 schema 常见错误造成额外轮次**：宿主写 `kind:"module"` 时 compact `change` 直接拒绝并让宿主重试；现在自动归一化为 `component`，仍拒绝 `mod-*` 派生身份。
5. **Skill 过度压缩产生负收益**：R49 把 Skill 压缩到 1.5KB 后，宿主不遵守“首包 pipeline / 不拆 inspect / 不调 update_plan”，退化为 8 请求/151k；恢复详细协议后 R50 C 回到 5 请求/84k。
6. **`task` 未作为 `intent` 别名**：宿主常用 `explore({task})`，旧实现显示 `Intent: (none yet)`，大型仓库会丢失 focus；现改为 `intent || task`，并验证 session intent。
7. **隔离测试装置本身是缺陷源**：`dangerously-bypass` + 同级 fixture + git remote 使早期样本不再可比；新增 `.contextos/tmp/contextos-ab-isolated-{setup,run}.sh`，用外层 Seatbelt 做只读隔离。

### 40.4 质量审查：测试 PASS 不等于任务完成

- R50 C 的 `npm test` PASS，但 `buildAuditReport` 只输出事件计数，没有像 B 一样保留 `eventLog`/sequence；如果“保留事件顺序”是硬要求，C 的可见测试通过但语义质量仍不足。后续任务必须把这类非测试断言的要求单独审查。
- R50 B 因宿主把一个 `src/index.mjs` 的 target 文本误写成 `src/batch-replay.mjs` 的内容，第一次 `change` 被 changeset 拒绝；OS 正确做到“未修改任何文件”，但宿主仍多花一轮。这是宿主编辑错误，不是 OS 静默假成功。
- R51 C 把 `verify`/`ship` 拆出 `change`，说明当前协议只能靠 Skill 引导，不能硬性保证“一个决策一次事务”。

### 40.5 Micro 结论与剩余门槛

- R47-R51 的 Micro 调用均为 0；该任务失败证据是明显 stub 且小于 2KB，OS triage 后继续走 Micro 只会增加 provider token，跳过是正确的。
- 因此本轮不能宣称 Micro 节省；执行型 Micro 仍只有早期探针证据（`providerRequests=3`、`toolRounds=2`、`toolCalls=4`、`executionMode=executor`）。
- 剩余必须补的测试：C-only >2KB 原始失败/日志证据，首次 Micro 调用直接携带 pipeline evidence，并同时记录 provider token、`providerRequests`、`toolRounds`、`toolCalls`、`executionMode`。
- 剩余架构边界：OS 是外骨骼，不能阻止宿主使用原生工具或写错 target；峰值 input 目前只降到 ~24k，主要节省来自请求/工具坍缩，而不是单次上下文极端压缩。

### 40.6 当前验证状态

- `npm test`：PASS。
- `npm run plugin:verify`：PASS。
- 最终 bundle hash：`bf7e617eac9e34564c6bc4cfc0361c437734a6082d01c5b409b50a149ad5008c`。
- 严格隔离样本：`/private/tmp/contextos-ab/ab-r47-isolated-*`、`ab-r48-isolated-*`、`ab-r49-isolated-*`、`ab-r50-isolated-*`、`ab-r51-isolated-*`。
- 早期 R43 的 74% 结果保留为历史记录，但在严格隔离口径下不再作为主证据。

## 41. 最终 bundle 复验、Micro 执行证据与 2.7.0 发布门禁

### 41.1 本轮修复

1. **移除 decision package 后的 directed-expansion 硬门禁**：显式 `symbol` 或 bounded `ranges` 不再因为 8 次扩展计数被降级成 outline。计数器仍保留为 telemetry，但读取始终返回数据；第 9 次以后的有界读取也按真实内容返回。
2. **批量 inspect 尊重显式 ranges**：batch 中只要目标带显式 ranges/symbol，即使同批存在大文件，也不再强制全部降级为 outline。同时修复 `numberCodeLines` 把 `// [Lx-Ly]` 元数据当正文导致的行号偏移。
3. **ship 阻塞语义修正**：只阻塞“最后一次通过验证之后”的失败。更早的 timeout、脱敏探针或同命令旧 FAIL 不会污染最终收口；同命令 PASS 仍会 supersede 旧 FAIL，失败之后没有新 PASS 仍然阻塞。
4. **A/B/C 隔离装置修正**：harness 现在显式执行 `codex plugin add contextos@contextos-development`，并写入 `[plugins."contextos@contextos-development"] enabled=true`。此前只配置 marketplace 会让 B/C 实际退化为 native；R52-B 和 R53-B 样本因此作废。

### 41.2 真实执行型 Micro 证据

在独立 fixture 中，首次 Micro 调用直接携带 Pipeline，Pipeline 包含 `npm test` 失败证据和 `src/queue.mjs` 的有界 inspect。Micro 任务明确要求先执行 `run`、再执行 `inspect`，并返回实际工具调用。

实测结果：

- `executionMode=executor`
- `providerRequests=3`
- `toolRounds=2`
- `pipelineRuns=1`
- `evidenceMode=pipeline`
- `providerUsage.totalTokens=9628`
- `usageSource=provider`
- `preload.status=PARTIAL`

该调用不是 summarizer-only：Micro 实际执行了 `run({command:"npm test"})` 和 `inspect({path:"src/queue.mjs"})`，并返回了根因与最小修复方向。该证据只证明执行路径可用，不与 A/B/C 的宿主 token 混算。

### 41.3 最终 A/B/C

| 运行 | 请求/工具/峰值 input/总 token | ContextOS 调用 | Micro | 可见测试 | 隐藏质量 |
| --- | --- | --- | --- | --- | --- |
| A R52 native | 16 / 28 / 32,709 / 360,361 | 0 | 0 | PASS | PASS |
| B R54 OS | 5 / 4 / 25,741 / 87,969 | 2（pipeline、change） | 0 | PASS | PASS |
| C R54 OS+Micro profile | 5 / 4 / 26,571 / 89,554 | 2（pipeline、change） | 0 | PASS | PASS |

说明：

- B/C 相对 A 的总 token 降幅约为 75.6% / 75.2%；请求从 16 降到 5，工具从 28 降到 4。
- 峰值 input 只降低约 19% / 21%，主要节省来自请求与工具调用坍缩，而不是单次上下文极限压缩。
- C 的 Micro=0 是正确路由：Pipeline 已经把 2KB+ 失败证据 triage 到决策所需根因，继续调用 Micro 只会增加 provider token。Micro 执行能力由 41.2 的独立真实调用证明，不把该 C 样本计入 Micro 节省。
- B/C 都走了 `pipeline -> change(edits+architecture+verify+ship)`，没有 native fallback，没有拆分事务。
- 隐藏质量检查由 `/private/tmp/contextos-ab/ab-r52-hidden-check.mjs` 执行，覆盖幂等键、冲突、终态、重试次数、有序 `eventLog`/sequence 和 `src/index.mjs` 公共入口闭包。

### 41.4 最终验证与发布状态

- `npm test`：PASS。
- `npm run plugin:verify`：PASS。
- `npm run acceptance:real`：PASS。
- `npm run acceptance:micro`：PASS。
- `npm run acceptance:micro:executor`：PASS。
- `npm run dist:smoke`：PASS。
- `npm run desktop:build`：PASS。
- `git diff --check`：PASS。
- 版本：`2.7.0`。
- 最终 bundle hash：`e17b2f4930f2ff9c2d759bf7b8f8f5873bef010e69ee636f6ecaffca37fac617`。
- 宿主绕过仍不可完全禁止；当前合格标准是 OS 路径本身不产生负收益、契约错误为零、复杂任务正确性通过，并在协议合规会话中形成可复现的正收益。
