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
