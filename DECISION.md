# ContextOS Architecture Decisions

This file records only decisions that describe the current system. Superseded
designs, benchmark ledgers, and historical migration notes are removed instead
of being preserved in the product tree.

## DEC-101 Single MCP Entry with Full Capability Passthrough

Status: Accepted

The public MCP surface exposes exactly one tool:

```js
contextos({ action, args, projectRoot })
```

`ask`, `command`, `agent`, and `change` are the primary actions. Orchestration
and advanced capabilities remain available without a second tool surface:

```js
contextos({ action: "pipeline", args: { steps: [...] }, projectRoot })
contextos({ action: "plan", args: { ... }, projectRoot })
contextos({ action: "ops", args: { capability: "task", action: "open", args: {} }, projectRoot })
```

The main thread may use native tools or any original ContextOS capability
directly. API Micro and the optional CLI agent are convenience paths, not
mandatory hops. There is no legacy seven-tool compatibility surface.

## DEC-102 API Micro Is the Semantic Assistant

Status: Accepted

API Micro is the configured semantic "cerebellum" for ContextOS. It receives
natural-language requests, reads code or command evidence through a restricted
read-only broker, and returns selected source or log evidence to the host.

- It never edits files, runs host commands, or recursively delegates.
- Exact known-path reads bypass the model and require no API request.
- Provider requests, failures, and observed usage are recorded under the
  `api-micro` role.
- Missing configuration disables semantic retrieval; it does not silently
  fall back to another provider.

The effective configuration is the top-level `micro` object in the private
profile. The runtime reads only the canonical `micro` and `agents` shapes.

## DEC-103 CLI Agent Is an Optional Subagent

Status: Accepted

The CLI agent is an optional subagent selected through `agents.default` and
`agents.adapters`. It is used for bounded analysis or isolated implementation
work and is expected to have the ContextOS MCP tool installed so it can call
`ask` for evidence.

- A CLI worker may talk with the host through `agent({ action: "send" })` and
  `agent({ action: "messages", waitMs })`.
- A worker may call `ask`, `command`, and `change` as allowed by its task, but
  worker mode rejects nested `agent` dispatch.
- A finished conversation can continue with its persisted `cliSessionId` when
  the adapter defines `resumeArgs`.
- Permission denial is a blocker; the runtime does not bypass host approval.
- The host reviews the diff and runs independent acceptance checks before
  integrating CLI work.

CLI usage is recorded under `cli-agent`. Its provider usage may be lower than
the host model, so complex bounded work should be delegated when appropriate,
but delegation is always the agent's decision.

## DEC-104 Configuration and Switching Are Visible

Status: Accepted

The macOS and Windows settings surfaces display the effective API Micro and
CLI agent configuration without exposing credentials. Installation, key
debugging, provider/model switching, thinking changes, adapter mapping, and
permission grants are documented in the ContextOS skill package:

- `plugins/contextos/skills/contextos-ops/SKILL.md`

When a user asks to switch a role, the AI follows those instructions rather
than editing runtime code or inventing flags.

## DEC-105 Cost Target and Evaluation Method

Status: Accepted

The working target is a 60% reduction in user-equivalent token cost for a
complete development task:

```text
main raw + api-micro raw / 7 + cli-agent raw / 7
```

The `/7` factor is a user-specific relative-price estimate, not an invoice.
Raw usage and the estimate are reported separately. Missing usage stays
unknown, and failed or interrupted work keeps any observed usage.

Evaluation uses real development scenarios in visible host conversations or
host subagents. It does not use an in-repository benchmark runner as the
source of truth. A result counts only when the task, acceptance checks,
implementation hash, and complete per-role usage are all available.

## DEC-106 Installation Must Prove the Fresh Runtime

Status: Accepted

The plugin installer must:

1. Build and synchronize the current bundle and skill tree.
2. Verify the installed files match the build.
3. Start a fresh MCP process and require exactly one `contextos` tool with the
   `action`, `args`, and `projectRoot` schema.
4. Tell the user that an existing conversation may still cache the previous
   MCP process and that a new conversation is required.

The install and configuration paths must be exercised from a fresh host
conversation before a release is considered verified.

## [deterministic-memory-and-lifecycle] ContextOS 三层确定性记忆索引、Blackboard 闭环与单轮生命周期压缩架构规范

### 一、 架构红线与确定性原则（严禁违背）
1. **工具表面积精简与正交分类（零新增顶层工具）**：
   - 保持 `packages/mcp/src/v3-server.mjs` 单一入口 `contextos({action, args, projectRoot})`。
   - 所有能力严格收敛在 4 个正交分类：
     1) **感知与三级记忆寻址（`ask`）**：统一承载 L1（`overview` / `blockId` / `chainId`）、L2（`onboard` 符号/文件定位）、L3（`inspect` 精确切片 / `resultId` 恢复 / `request` 语义检索）。
     2) **隔离委托与合并（`micro` / `agent` / `integrate`）**：`micro` 负责有界分析与单文件修改；`agent` 负责 CLI 复杂实现；`integrate` 负责等待、审计 Diff、验证与原子合入。
     3) **原子变更与命令执行（`change` / `command`）**：`change` 负责源码修改 + 显式架构绑定 + 单测验证；`command` 负责命令执行与日志按 ID 读取。
     4) **单轮编排与底层状态（`pipeline` / `ops`）**：`pipeline` 负责并发批处理与跨步骤句柄传递（降低请求轮次与 Prefix Cache 重复计费的核心）；`ops` 负责低频图谱/计划/会话管理。
2. **严禁基于目录或启发式的「新文件自动归类 Block」**：
   - `Block` 是业务职责单元（Semantic Responsibility Unit），绝非物理文件夹（`mod-*`）。例如 `packages/orchestrator/src/` 同目录下同时存在 `block-orchestrator`、`block-module-index`、`block-command-gateway`、`block-micro-runtime` 等多个语义 Block。
   - 对未归属的新文件（`owners.length === 0`）或冲突文件（`owners.length > 1`），必须保留 `pipelines.mjs` 中 `bindChangedArchitecture` 的 `ARCHITECTURE_REQUIRED` 预检门禁，只返回只读 `suggestion`，必须由调用方在 `change({ ..., architecture: { blocks: [...] } })` 中显式声明，严禁静默猜测绑定。
3. **仅允许 100% 数学确定性的底层自动同步（Deterministic State Sync）**：
   - **允许 1（唯一已归属文件的 AST 重锚定）**：当文件已明确属于唯一 `Block`（`owners.length === 1`）时，文件修改后通过 Tree-sitter AST（`LanguageRegistry.parseStructure`）重算该文件内已绑定 `symbol` 锚点的最新 `startLine / endLine` 与 SHA-256 哈希。
   - **允许 2（精确路径匹配的缓存与句柄失效）**：当文件被 `SessionStore.touch` 修改或删除时，按精确路径匹配剔除已过期的 `readReceipts` 及 `memoryHandles` 中的关联 `resultId`。
   - **允许 3（显式指针 + SHA-256 强校验的第 0 轮水合）**：仅当显式传入 `resultId`（如 `$step1.resultId` 或 `context.evidenceRefs`）且磁盘文件当前 SHA-256 与记录的 `contentHash` 完全一致时，才将切片注入子代理首轮上下文。

### 二、 四大核心修复模块（执行蓝图）
- **模块 1（`task-p1-onboard-and-anchor-sync`）**：修复 `ask({onboard})` 精确匹配优先配额分配（防同 Block 无关文件挤占 16 个锚点配额）与 AST 符号锚点动态行号对齐（防行号平移导致假阳性 `stale source anchors`）。
- **模块 2（`task-p2-blackboard-memory-handles`）**：重构 `SessionStore` 与 `Blackboard` 生命周期——引入脏标记按需落盘（内部 `readReceipts/searchReceipts/semanticReceipts/exploreReceipts` 更新不重写 `blackboard.md`），新增 `memoryHandles`（有效 `resultId` 与可复用子代理会话 ID，`touch` 时自动失效），并与 `compactSessionState`（`ask({overview:true})`）同源输出。
- **模块 3（`task-p3-pipeline-handle-and-hydration`）**：打通 `pipeline` 证据句柄直通（扩展 `resolvePipelineStepReferences` 支持 `$stepN.resultId` 与 `$stepN.receiptId`，`ask` 支持 `delivery: "handle-only"`）与 `agent` / `micro` 第 0 轮 SHA-256 校验水合（`context.evidenceRefs`）。
- **模块 4（`task-p4-regression-and-acceptance`）**：补齐四模块确定性单元测试矩阵，执行全量回归与 `chain.validate(checkSources:true)` 验收。
