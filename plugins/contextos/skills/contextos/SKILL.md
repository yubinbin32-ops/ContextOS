---
name: contextos
description: Keep project architecture, progress, source locators and verified handoffs synchronized with ContextOS while each task reads only the code and knowledge it needs.
---

# ContextOS 工作方式

ContextOS 是项目的结构化记忆层。它保存 Block、Link、Chain、Plan、Decision、Checkpoint 和源码定位，让 AI 能够沿着当前任务直接进入相关架构和代码。

用户按正常方式描述任务。AI 根据任务需要读取项目结构或代码定位，并在结构发生变化时更新 OS。

## 任务开始

1. 任务需要项目进度、规则或交接信息时，使用绝对 `projectRoot` 调用 `context_for_task`。架构已经明确时，可以直接从 `entity_open`、`chain_code_stream` 或 `block_code_stream` 开始。
2. 使用 `plan_context` 展开 Plan，使用 `entity_open` 展开单个 Block、Chain、Link 或 Decision。每次只展开当前工作需要的记录。
3. 延续已有工作时复用 `context_for_task` 或 `sync_issues` 中的 TaskSession。新功能先登记 Block、Link 和 Chain，再使用 `task_begin` 建立任务范围。
4. Plan 扩展使用 `plan_append_changes` 或 `plan_append_chain_scope`，结构重排时使用对应的完整更新操作。

## Block、Chain 与 Composite

- Block 表示一个独立的架构职责，可以是初始蓝图，也可以绑定一个或多个源码入口。
- Leaf Chain 表示一个聚焦的功能路径，按明确顺序连接多个 Block。
- Composite Chain 表示较大的功能路线，成员可以是子 Chain 或直接 Block。父级展示阶段，子级保存实现路径。
- Block 何时组合为 Chain、原 Block 何时从活动架构移除、哪些 Link 属于新结构，由 AI 根据功能语义决定。
- 结构变更优先使用一次完整的 `chain_compose` 或 `graph_mutate`：写入新成员和路线、更新父级关系、移除被替代的活动 Block，然后读取结果确认。
- `chain_reconcile` 用于查看成员、Link、顺序、孤立 Block 和候选关系。AI 根据返回结果选择下一次组合操作。
- `graph_validate` 用于确认成员存在、路线连通、端点有效、Composite 层级无循环以及投影已经同步。
- `architecture_link_suggest` 提供代码关系和架构关系候选。AI 结合功能意图选择真正需要的 Link。

## 精确读取源码

Block 可以覆盖多个文件和多个方法。Block 本身保存主要入口和范围，细粒度方法信息由源码索引按需提供。

1. 调用 `block_code_stream` 获取该 Block 的完整 locator 清单：文件、符号、角色、起止行、源码 hash 和绑定状态。
2. 调用 `chain_code_stream` 获取整个 Chain 的阶段级 locator 清单。Composite 先查看子 Chain，再展开目标阶段。
3. 使用本地 CLI 按 locator 读取代码范围：

   ```text
   contextos code --path <file> --symbol <symbol>
   contextos code --path <file> --start <line> --end <line>
   ```

4. 一个 Block 有多个 SourceRef 时，按当前任务选择需要的 locator，逐个读取对应方法、类型、调用方、被调用方或测试。文件级重构和符号无法定位时，再读取完整文件。
5. 源码修改由 AI 使用常规 CLI 或编辑工具完成。修改后调用 `source_sync`，让符号位置和 hash 重新绑定。

源码索引在服务端扫描文件并保存符号目录，响应只携带选定的定位信息和代码片段，因此索引规模不会直接变成对话上下文。

## 进度与验证

1. 编辑完成后调用 `task_reconcile`，同步变更文件、绑定状态、任务范围和 Plan 覆盖。
2. 使用 `graph_status` 查看孤立 Block、断开路线、过期定位和待验证项目。
3. 使用 `run_command` 执行测试、构建和检查，读取压缩后的结果摘要。
4. 使用 `checkpoint_record` 记录验证证据，再使用 `task_finish` 完成任务收尾。
5. 最后调用 `graph_validate` 确认数据库、图谱投影、成员关系和 Chain 拓扑处于同一版本。
6. 使用 `timeline_sync` 保存当前工作焦点和下一步动作，方便新的对话继续。

## 项目知识

- 内部设计、审计和指南使用 `document_write`，章节更新使用 `document_patch`。
- README 保持在仓库原位置，由 App 以只读方式预览；内部 Markdown 文档作为 OS Document 在 App 中按章节展示。
- Decision 保存长期取舍，Plan 保存执行顺序，Checkpoint 保存验证证据。
- 使用体验数据和可重复的读取统计分开记录。日常使用体感上下文压缩频率大约减少 60%。

## 工具索引

| 目的 | 工具 |
|---|---|
| 定位项目 | `context_for_task`, `project_map`, `entity_open`, `graph_search` |
| 读取知识 | `document_list`, `document_open`, `plan_context` |
| 维护架构 | `graph_mutate`, `graph_patch`, `graph_flow`, `architecture_connect`, `chain_append`, `chain_compose`, `chain_reconcile` |
| 读取源码 | `source_index`, `source_sync`, `source_binding_suggest`, `source_binding_accept`, `chain_code_stream`, `block_code_stream` |
| 维护任务 | `task_begin`, `task_scope`, `task_reconcile`, `task_finish`, `sync_issues` |
| 验证结果 | `run_command`, `checkpoint_record`, `block_seal`, `graph_status`, `graph_validate` |
| 检查运行版本 | `runtime_info` |

解析器提供语法级定位和稳定符号身份。动态调用、反射和不支持的语法会以明确的状态和候选位置返回，AI 结合功能语义选择读取范围和架构关系。
