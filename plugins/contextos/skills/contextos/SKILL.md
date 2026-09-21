---
name: contextos
description: MUST be used whenever starting ANY coding task, exploring or understanding codebase architecture, adding features, fixing bugs, refactoring, or reading/editing code (进行代码开发、架构理解、新功能实现或读写代码时必须调用). If the ContextOS tools are not loaded, call tool_search for ContextOS first. Prefer explore to locate, change to edit or create files, verify to run tests and builds, ship to close the loop with receipts; the OS orchestrates AST slicing, out-of-context commands, derived module indexing and evidence capture on the server side. Native tools are allowed only for the explicit exceptions in section 7 and the reason must be stated.
---

# ContextOS · 意图级开发入口（操作手册）

> [!IMPORTANT]
> **默认工作路径（Default Path）—— 能看到 ContextOS 工具时必须优先走 OS；原生工具仅限第七节列出的例外**
> 0. **冷启动先加载工具与 Skill**：新会话若看不到 `explore` / `change` / `verify` / `ship` / `ops`，先调用 `tool_search` 搜索 `ContextOS`。Skill 列表里的 `rN`、`r0`、`r1` 等是根别名，不是目录名；必须用对应根展开相对路径。Codex personal 插件通常在 `~/.codex/plugins/cache/personal/contextos/<version>/skills/contextos/SKILL.md`，不要先猜 `~/.codex/skills/contextos/SKILL.md`。工具加载后第一动作仍是 `explore`。
> 1. **首要动作优先 `explore`**：新会话、承接新功能、排查缺陷、**或经历上下文压缩后**，先 `explore({ intent })` 建立认知，再动手。已经在上下文里明确了目标位置的小改动，可以直接 `change`。
> 2. **写文件走 `change`**：`edits` 改已有代码（`target` 唯一匹配；重复时用 `symbol` 或 `startLine`/`endLine`，行号必须成对）；`create` 新建中小文件。它直接写盘、自动重锚 AST 符号并登记 touched。只有第七节列出的批量机械改写、超长新文件、二进制、git/文件系统操作或 OS 不可用时，才使用原生写工具，并说明原因。
> 3. **读文件走 `ops code`**：先 `action: "outline" | "search"` 定位，再 `action: "read"` 配 `symbol` / `startLine` / `endLine` 取正文；代码、日志 jsonl、配置 json、文档都一样。`search` 的 `root` 可以是目录、单个文件或 `.`。仅在 OS 读取不可用时使用 `cat` / `sed` / `head` / `find`，并说明原因。
> 4. **跑命令优先 `verify`**：日志出舱存盘，只回退出码、耗时、Receipt ID 与失败片段。若直接跑原生命令，请把输出过滤或只取尾部，不要把成百上千行倒进上下文；常驻服务谁启动谁停。
> 5. **收尾前先落图谱，再 `ship`**：本次改动新增了模块 / 能力 / 入口时，先用 `ops block bind` 建 Block（锚定真实文件）、用 `chain link` 连好关系、跑 `chain validate`，再 `ship({ summary })` 归档证据与图谱。只改了几行现有逻辑可以不建图谱；不 `ship` 会丢失跨会话记忆。
> 6. **不需要手工记账**：touched、覆盖率、回执、会话状态、派生模块 `mod-*` 都由 OS 从 git 与编辑行为派生，不要自己维护台账。
> 7. **OS 报错可以退回原生工具**：这是允许的逃生通道，请在回复里说一句原因；下一次调用 OS 时它会自动对账你改过的文件，所以随时可以回到循环里。

---

## 一、决策路由：你要做的事 → 建议调用 → 改用原生时

| 你现在要做什么 | 优先调用 | 改用原生工具时请注意 |
| --- | --- | --- |
| 接手陌生代码 / 找实现在哪 / 压缩后恢复 | `explore({ intent })` | 仅当 OS 不可用时可先 `rg` 定位，随后必须回到 `explore`/`ops code` |
| 看结构或某个方法 | `ops({ capability: "code", action: "outline" \| "read" \| "search" })` | 整读只在确实需要全文时做 |
| 读日志 / 配置 / 文档 | `ops({ capability: "code", action: "read", args: { path, startLine, endLine } })` | 不要用 `sed` / `head` / `find` |
| 修改已有代码 | `change({ edits: [{ path, target, replacement }] })` | 批量/格式化/重命名走原生更快，改完继续走循环 |
| 新建文件 | `change({ create: [{ path, content }] })` | 很长的新文件用原生写更顺手 |
| 跑测试 / 构建 / 脚本 | `verify({ command })` 或 `verify({ commands })` | 直接跑也行，务必过滤输出 |
| 起停 dev server / watcher | `verify({ mode: "serve" \| "stop" \| "logs" })` | 原生起进程要记得收尾停掉 |
| 把模块 / 关系固化进图谱 | `ops({ capability: "block", action: "bind" })`、`ops({ capability: "chain", action: "compose" \| "link" })` | 见第五节 |
| 改完收尾 | `ship({ summary })` | 不 ship 则无归档与跨会话记忆 |
| 需要精细控制内部能力 | `ops({ capability, action, args })` | — |

**默认顺序是 explore → change → verify → ship；偏离它不违规，只是要自己承担上下文与证据成本。**

---

## 二、标准循环（照做即可，不必自己编排）

```text
explore({ intent })                 1. 理解 / 定位 / 续接，读返回值开头的 "## Next"
change({ edits | create })          2. 手术刀改写，写盘并自动重锚
verify({ command | commands })      3. 出舱执行；失败就回到 change 再改
ops block bind + chain link         4. 新增模块 / 能力 / 入口时：挂进图谱（真实文件锚定）
ops chain validate                  5. 校验：无孤立 Block、无悬空 Link
ship({ summary })                   6. 归档：证据 + 派生归属 + 图谱
```

返回值开头的 `## Next` 是 OS 依据真实状态算出的下一步，照抄调用即可。

---

## 三、各工具详解

### 1. `explore` —— 理解、定位、续接

- **核心作用**：一次调用带回会话状态、git 脏文件、派生模块候选、命中符号与最相关的项目规则。
- **关键参数**：`intent`（必填，自然语言）、`paths?`（文件或目录，目录会自动展开）、`depth?`（`shallow` / `normal` / `deep`）。
- **返回值怎么用**：先看 `## Next`，再看 `## Where to look`；`## Applicable rules` 只给标题，细则用 `ops({ capability: "knowledge", action: "rule_open", args: { ruleId } })`。

### 2. `change` —— 直接改代码（首选写文件入口）

- **核心作用**：AST 定位 + 唯一匹配替换 + 写盘 + 自动重锚符号 + 登记 touched。
- **关键参数**：
  - `edits: [{ path, target, replacement, symbol?, startLine?, endLine? }]`
  - `create: [{ path, content }]`
  - `dryRun?: true`（只预览 before/after 与 `Target unique`，不写盘）
  - `intent?`（说明这次改动要达成什么）
- **要求**：`target` 在文件内唯一匹配；重复时用 `symbol` 或行号收窄。不传 `edits`/`create` 时返回只读预览。
- **返回值怎么用**：`edited \`path\` (hash xxx, N locators re-anchored)` 即成功，不需要再读一遍文件确认。

### 3. `verify` —— 证明它能跑

- **核心作用**：出舱执行、脱敏、日志存盘，只回退出码、耗时、Receipt ID 与失败片段。
- **关键参数**：`command`（单条）或 `commands`（多条）、`mode?`（`once` / `serve` / `list` / `status` / `logs` / `stop`）、`timeoutMs?`。
- **Receipt 日志**：`verify({ mode: "logs", id: "receipt-..." })` 读取 `.contextos/logs/<receipt-id>.log`；`process logs` 仍用于常驻进程日志。
- **缺省行为**：都不传时依次取 `.contextos/profile.json` 的 `verify` 与 package.json 的 `test` / `lint` / `build`。
- **最佳使用时机**：改完就跑；`Verdict: FAIL` 时回到 `change` 修，再 `verify`，PASS 后 `ship`。

### 4. `ship` —— 收尾归档

- **核心作用**：汇总 touched 与回执、把未归属文件挂到派生模块、导出 `graph.json`、关闭会话写入历史。
- **关键参数**：`summary`、`verify?: true | string[]`、`dryRun?: true`、`decision?: { id, title, content }`（顺手写 ADR）。
- **治理强度**：默认 advisory（无绿色回执也能收尾，标记 unverified）；`strict` 由 `.contextos/profile.json` 控制，不是 `ship` 参数。
- **前置**：本次新增了模块 / 能力 / 入口，先按第五节建 Block + Chain 并跑 `chain validate`；改了 `packages/*` 下 OS 自身源码，先跑 `npm run plugin:build` 更新 bundle，再运行 `plugin:verify`。`plugin:install` 会写入本机编辑器配置，是破坏性安装步骤，不能当作普通构建命令。
- **唯一允许的最终顺序**：最后编辑 → `verify` 全绿 → 图谱校验 → Plan/Task 关闭 → `ship({ summary })` → `git add/commit` → 停止调用任何 OS 工具。`ship` 会关闭当前 session；之后再调用 `explore` / `verify` / `ops` 会开启新 session，并再次弄脏 `.contextos/session.json`。如果必须先提交再 ship，请把 git 操作视为普通外部动作，并在提交后最后一次 ship；不要再混用两种顺序。

### 5. `ops` —— 手动直通舱（需要精细控制时用）

`ops({ capability, action, args })`：

| capability | 典型 action |
| --- | --- |
| `code` | `outline` / `read` / `edit` / `search`（符号 + 全文，可 `root` 限定、`maxResults` 控量）/ `create` |
| `knowledge` | `rule_list` / `rule_open` / `rule_write` / `decision_open` / `decision_write` |
| `session` | 查看 / `note` / `close` / `history` |
| `block` | `list` / `open` / `search` / `bind` / `bind_auto` / `delete` |
| `chain` | `list` / `open` / `compose` / `link` / `unlink` / `links` / `validate` / `delete` |
| `plan` `task` | `plan` 支持 `list/create/open/update/upsert/check/complete/delete`；`task` 支持 `start/create/open/update/bind_rule/unbind_rule/note/check/finish` |
| `run_command` `process` `os_context` | 单次命令、常驻进程、原始简报 |
| `system` | `init` / `doctor` / `switch` |
| `profile` | 读写 `.contextos/profile.json` |

### 6. `ops code search` 用法（找代码的标准动作）

```text
ops({ capability: "code", action: "search", args: { query: "observer", root: "packages/orchestrator", maxResults: 20 } })
```

- `query`（必填）：要找的词，写一个 token 最稳（`"observer"`，不要写整句）。
- `root`（可选）：目录、单个文件或 `.`；不确定就别传，默认全仓。文件路径只扫描该文件，`.` 扫描整个工作区。若真实存在的单个文件返回 `scannedFiles: 0`，不要改回 `rg`：先检查相对路径是否以 `projectRoot` 为基准，再运行 `npm run plugin:build` 同步已安装 bundle；这是分发版本过旧的信号。
- `maxResults`（可选）：默认 8，最多返回的命中总数。
- 返回两段：`## Symbols` 是声明位置（类/函数/方法，带 `L起始-L结束`），`## Textual matches` 是出现位置（路径 + 行号 + 行内容，单文件最多 3 条）。末尾会告诉你扫描了多少文件、是否被遍历预算截断。
- **零命中时的正确动作**：换成更短的关键词 → 去掉 `root` → 换 `explore({ intent })`。**不要退回 `rg`**：`rg` 的整段输出会进上下文，OS 只回带行号的单行命中。
- 命中后取正文：`ops({ capability: "code", action: "read", args: { path, startLine, endLine } })`，或先 `action: "outline"` 拿符号表。

### 7. Plan / Task / Rule：结构契约与按需使用

- **Plan 和 Task 都是可选的**：小改动直接 `explore → change → verify → ship`，不强制创建。Rule 也可选、数量不限；需要时绑定，不需要时不要添加。
- **Plan 状态**：`draft | active | completed | archived`。`create` 的产品行为是创建为 `active`；合法转换是 `draft→active|archived`、`active→completed|archived`、`completed→archived`。不要用 `plan update` 直接伪造 `completed`。
- **Phase 契约**：每个 phase 必须有唯一 `id`、唯一且非负整数 `order`、非空 `objective`、至少一条 `acceptance`；`P0/P1/...` 同时要显式写 `order: 0/1/...`。只有 `plan-light-*` 允许空阶段。错误示例：两个 phase 都写 `order: 0`。
- **Plan 完成门槛**：`plan complete` 或更新为 `completed` 前，所有 checkpoint 必须 `passed`，所有已关联 Task 必须是 `completed`，phase/Task 关联必须一致。禁用“完成 Plan 时把 draft Task 自动 block 掉”的旧行为；未完成任务会直接拒绝完成。
- **Task 状态**：`draft | active | checking | syncing | completed | blocked | sync_failed`。正常链是 `draft→active→checking→syncing→completed`；失败恢复为 `sync_failed→checking|active`，阻塞为 `blocked→active`。不要通过 `task update` 改 `status`、`planId`、`phaseId`；必须用 `start`、`resume`、`check`、`finish` 等生命周期动作。
- **Task 归属**：`task create` 要求已有 Plan 和目标 Phase；不写 `planId` 的 `task start` 会自动寻找 active Plan，找不到时创建 `plan-light-*` 轻量 Plan。轻量 Plan 只适用于单任务闭环，不应冒充正式多阶段 Plan。
- **Rule 契约**：`ruleRefs`（Plan）和 `rules`（Task）都接受字符串数组，不限制数量，也不要求 Plan/Task 必须绑定。未知 Rule 必须由 `rule_list` / `rule_open` 验证后拒绝写入。已绑定规则必须在 SQLite、graph.json 和桌面 Plan 详情中可追溯。
- **最小合法 Plan**：

```json
{
  "capability": "plan",
  "action": "create",
  "args": {
    "id": "plan-example",
    "planData": {
      "title": "Example plan",
      "phases": [{
        "id": "P0",
        "order": 0,
        "objective": "Produce a verifiable result.",
        "scope": "Relevant modules.",
        "deliverables": ["Working change"],
        "acceptance": ["Unified verification passes."],
        "status": "pending"
      }],
      "checkpoints": [{
        "id": "cp-example",
        "title": "Acceptance",
        "criteria": "Unified verification passes.",
        "status": "pending"
      }]
    }
  }
}
```

- **最小合法 Task**：

```json
{
  "capability": "task",
  "action": "create",
  "args": {
    "taskData": {
      "id": "task-example",
      "planId": "plan-example",
      "phaseId": "P0",
      "title": "Implement the phase",
      "contextSlice": { "objective": "Implement and verify." },
      "workingSet": { "files": ["src/example.mjs"] }
    }
  }
}
```

- **常用生命周期**：`task start` 激活；`task check` 记录已有 receipt/evidence；`task finish` 在未提供 receipt 时运行 `checkData.command`，失败不会进入 `completed`；`task resume` 从 `blocked/sync_failed` 继续。`plan check` 只能修改单个 checkpoint，`plan complete` 必须满足上述完成门槛。

---

## 四、OS 自动替你做的事（不要手工再做）

- **自动对账**：每次入口调用先跑 `git status`，**无论你用什么工具改的文件**都会进入会话。
- **派生模块**：`mod-*` 模块由 AST 与目录聚类算出并在 `ship` 时自动 `bind_auto`，日常开发不需要手工建 Block。
- **自动证据**：`verify` 的 Receipt 自动挂进会话，`ship` 直接引用。
- **规则按需注入**：只回最相关的 ≤3 条规则标题。
- **上下文预算**：返回按字符预算裁剪，被裁段落标在尾部注释；要全量传 `depth: "deep"`。

---

## 五、架构图谱：Block / Chain / Link

- **Block** 是一个必须锚定真实文件或符号的架构单元；**Chain/Link** 表达 Block 间关系（`from -[kind]-> to`）。`kind` 和绑定粒度自由选择，但不能创建 Ghost Block。
- 只有任务新增模块 / 能力 / 入口 / dispatch 路由时才必须建图谱；几行内部修改、已有 `mod-*` 派生模块和临时脚本不需要。
- 建前先 `block search` 查重，再用 `block bind`（文件 / symbol / 目录）和 `chain compose/link`；最后必须跑 `chain validate` 检查孤立 Block、缺失成员和悬空 Link。
- 最小写法：`block bind {id, blockData:{title,kind,artifactRefs:[{path,symbol?}]}}`；`chain compose {chainData:{id,title,memberIds}}`；`chain link {linkData:{from,to,kind,reason}}`。
- `graph.json` 是 SQLite 的派生投影，OS 在调用边界自动发布；不要手改。发布失败会保留 dirty/outbox，修复后重试 `verify` 或 `ship`。


---

## 六、故障与恢复

1. **看不到 OS 工具**：先调用 `tool_search` 搜索 `ContextOS` 并加载工具；加载成功后从 `explore` 开始。仍失败才使用原生工具，并在回复里说明。
2. **OS 返回错误**：读错误原因并按提示重试（`state conflict` 类问题 OS 会自愈，重试一次即可）；仍不行才退回原生工具，之后随时可以回来。
3. **改了 OS 自身源码后**：MCP server 跑的是打包产物，需要 `npm run plugin:build`（验证）或明确需要安装时 `npm run plugin:install`，然后新开会话，不要误判为"改了没用"。

---

## 七、原生工具例外（允许，但必须说明原因）

仅以下场景优先用原生工具；其余读写、命令执行和收尾都走 OS：

- **整文件新建且内容很长**（新模块、长文档、配置模板）：原生写更顺手，`change({ create })` 适合中小文件。
- **批量机械改写**：全仓库重命名、格式化、批量替换、机械性重构 —— 原生脚本更快；做完继续走 `verify`/`ship` 即可。
- **非代码与非文本资产**：图片、二进制、锁文件、超长生成物。
- **git 与文件系统操作**：提交、分支、移动、删除目录。
- **OS 不可用时**：工具没连上或连续报错。

无论用哪种方式改，**下一次调用 OS 入口时它会自动对账你改过的文件**，所以不用额外补登记；只是原生路径下你会自己承担读入的上下文与缺失的 Receipt。

---

## 八、项目规则

`explore` 会自动注入最相关的规则标题；需要细则时用 `ops({ capability: "knowledge", action: "rule_open", args: { ruleId } })`。Rule 可选、数量不限，不要求 Plan/Task 必须绑定。

---

## 九、跨会话续接与最终提交

- 新会话第一句必须 `explore({ intent })`，它会带回未完成会话、脏文件、最近回执与相关决策。
- 想沉淀结论：`ops({ capability: "session", action: "note", args: { text } })`，或 `ship({ decision: { id, title, content } })` 写进 `DECISION.md`。
- git commit 与 ship 的唯一最终顺序见第四节；不要在两套顺序间反复切换。
