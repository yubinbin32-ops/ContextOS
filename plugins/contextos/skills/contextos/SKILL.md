---
name: contextos
description: Context operating system for AI coding agents. Controls context pollution via C-D-C-S lifecycle, AST outline/surgical read/edit, compressed command receipts, and strict Block code coverage.
---

# ContextOS V2 操作指引

ContextOS 是面向 AI 开发全生命周期的上下文控制运行时。它通过阶梯式按需展开、代码结构化索引和生命周期状态机，大幅降低命令日志、全文件阅读、架构维护和跨对话恢复的上下文开销。

---

## 核心开发节奏：C-D-C-S

任何开发任务必须遵循 **`Create → Develop → Check → Sync`** 统一节奏：

```text
[1. Create]   os_context(brief) -> plan(create) -> task(create)
                    │
[2. Develop]  code(outline) -> code(read) -> code(edit) -> run_command() -> task(note)
                    │
[3. Check]    run_command(test) -> task(check)
                    │
[4. Sync]     task(sync with bound real Blocks) -> plan(check & complete)
```

---

## 一、任务启动与跨会话恢复 (Create)

1. **新对话恢复**：首先调用 `os_context(action: "brief")`。
   - 获取项目简要状态、当前进行中的 Plan、当前 Task、运行中的后台进程与核心 Block。
   - 若有正在进行的任务，调用 `task(action: "open", id: "...")` 恢复开发切片。
2. **制定计划 (Plan)**：
   - 先调用 `knowledge(action: "rule_list")` 浏览规则分类与索引，不要全量读取规则正文。
   - 调用 `plan(action: "create", planData: { title, priority, phases, checkpoints, ruleRefs })`。
   - **核心约束**：正式验收节点（Checkpoint）只属于 Plan，Task 和 Block 都不拥有 Checkpoint。
3. **创建任务 (Task)**：
   - 调用 `task(action: "create", taskData: { planId, phaseId, title, contextSlice, workingSet })`。
   - 任务包含目标、约束、工作文件（workingSet）与上下文切片。

---

## 二、代码开发与命令执行 (Develop)

### 1. 代码网关 (`code`)
**严禁为修改一小段代码而读取整个文件！**
- **第一步：看结构**：调用 `code(action: "outline", path: "...")`，获取函数、类、方法及起止行。
- **第二步：按需读**：根据 outline 结果，调用 `code(action: "read", path: "...", selector: "funcName")` 或指定起止行，仅读取必要的代码片段。
- **第三步：精确改**：调用 `code(action: "edit", path: "...", targetContent: "...", replacementContent: "...")` 进行外科手术式唯一替换。系统会自动重新解析语法并重锚所有代码符号位置。

### 2. 命令执行 (`run_command` & `process`)
**严禁让大量成功日志或冗长编译信息进入对话上下文！**
- **单次命令**：构建、测试、Lint 统一使用 `run_command(command: "...")`。
  - 默认剥离 ANSI 颜色与进度条，提取错误堆栈与关键摘要，原始全量日志保存在 `.contextos/logs/`。
- **长期进程**：dev server、watch 服务调用 `process(action: "start", command: "...")`，后台守护运行。
  - 需要时通过 `process(action: "logs", id: "...", grep: "...")` 过滤查看。
  - 结束时调用 `process(action: "stop", id: "...")` 清理整棵进程树。

### 3. 过程记录 (`task note`)
- 开发过程中有重要中间发现或决策时，调用 `task(action: "note", id: "...", text: "...")`。
- **不要每次改动代码就同步一次 OS**，记录保存在 Task 内部即可。

---

## 三、验证阶段 (Check)

- 运行测试用例：`run_command(command: "npm test ...")`。
- 收集测试结果回执 ID，调用 `task(action: "check", id: "...", checkData: { receiptId, description, passed: true })`。
- 只有全部检查通过，才允许进入 Sync 阶段。

---

## 四、写回与归档 (Sync)

- 调用 `task(action: "sync", id: "...", syncData: { blocks: [...] })`：
  - **核心不变量 1：真实代码绑定**：所有 Block 必须绑定到真实存在且已通过验证的代码（包含 path, symbol, hash），**严禁创建没有代码的 Ghost Block**！
  - **核心不变量 2：工作区全覆盖 (Coverage Gate)**：本次任务修改的所有代码文件必须归属于至少一个 Block。如果有遗漏的孤儿代码，系统将拦截并返回 `coverage_gap`，要求补齐绑定。
  - **自动同步**：Sync 成功后，SQLite 与 Git 追踪的 `graph.json` 自动完成原子写回。
- 当阶段验收满足时，调用 `plan(action: "check", id: "...", checkpointId: "...")`，最后调用 `plan(action: "complete")` 将计划压缩归档。

---

## 五、严禁违背的行为红线

1. ❌ **禁止全文盲读**：不要直接读取上千行的源码文件，必须先 `outline` 再 `read`。
2. ❌ **禁止长日志污染**：不要在终端执行高噪声命令把几百行日志塞进上下文，使用 `run_command`。
3. ❌ **禁止创建 Ghost Block**：没有代码之前不要提前建 Block，代码跑通后再在 `sync` 中绑定。
4. ❌ **禁止高频全量 Sync**：严格遵守 `Create -> Develop -> Check -> Sync` 节奏，不要每改一行代码就同步一次架构。
5. ❌ **禁止手工维护行号**：行号与符号位置由 AST 自动重锚，不要人工填报或信任过期的静态行号。
