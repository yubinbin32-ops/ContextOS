<div align="center">
  <img src="assets/logo.png" width="76" alt="ContextOS" />
  <h1>让 AI 记住项目，下一次对话从上次进度继续。</h1>
  <p><strong>ContextOS 把项目架构、开发进度、命令结果和代码位置放在同一份可同步的项目记忆里。</strong></p>
  <p><a href="https://github.com/yubinbin32-ops/ContextOS/releases/latest"><strong>下载 macOS App</strong></a> · <a href="#三分钟开始使用">三分钟开始使用</a> · <a href="README.md">English</a></p>
</div>

![ContextOS 架构与工作流](assets/contextos-demo.gif)

## ContextOS 解决什么问题？

AI 开始一段新的编程对话时，通常要重新读文件、寻找模块关系、确认设计取舍，再回忆上一段对话做到哪里。随着项目变大，架构说明、进度记录和命令日志会一起挤进上下文，真正要做的工作反而变慢。

ContextOS 把这些项目记忆放在代码旁边，由 OS 图谱统一保存。AI 每次拿到与当前任务相关的架构和进度，App 里也能看到同一份信息。换一个对话，工作可以从已有状态继续。

## 它带来的五个变化

**1. 架构有地图。** Block 描述模块和职责，带类型的 Link 描述真实关系，Chain 描述一条可观察的功能路径。AI 先看到功能如何连接，再按需定位实现代码。

**2. 进度有记录。** Plan、PlanChange、ChainScope、源码绑定、Checkpoint 和任务交接记录开发状态。Block 从 ghost、implementing 到 complete 的变化会在同步边界被带回，扩展功能时已有 Chain 也会及时补齐节点和 Link。

**3. 命令输出有摘要。** `run_command` 保存一次可追溯的执行回执，把脱敏后的结果、失败线索和验证状态带回对话。例行编译输出留在回执里，当前任务看到的是可行动的摘要。

**4. 代码定位有边界。** SourceBinding 保存文件、符号、签名和动态行号。`chain_code_stream` 返回整条功能链的定位信息，`block_code_stream` 按 AST 返回单个 Block 的有界代码片段，读取范围跟着符号变化。

**5. 文档有统一入口。** 项目方案、审计、设计和教材写入 OS Documents，按章节阅读并在 App 中展示。`README.md` 与 `README_zh.md` 继续位于仓库根目录，在 App 的 Knowledge 中以只读方式预览，图片和相对链接保持原样。

## 复杂功能也能一眼看懂

一条很长的功能不必再平铺成几十个 Block。**叶子 Chain** 负责一段聚焦的 Block 路径，**组合 Chain** 把几条叶子 Chain（必要时也可以放入少量直接 Block）组成一条短的宏观路线。父 Chain 只展示“边界 → 上下文 → 源码 → 知识 → 验证”这样的阶段；点击阶段后，再查看它自己的 Block、Link、源码符号和 AST 定位。

当前反馈闭环试点把 42 个实现 Block 拆成 7 条阶段 Chain。父 Chain 只有 7 个成员和 6 条明确的 `flows_to` Link，新对话先看到 7 项就能理解全貌，需要实现细节时再展开对应阶段。同一模型也支持嵌套组合、分支、可选阶段、环检测，以及子 Chain 状态向父 Chain 回传。

![功能链与精确代码定位](assets/path-impact.png)

![OS 文档和 README 的知识抽屉](assets/knowledge-reader.png)

安装后直接用自然语言描述工作即可。ContextOS 在后台读取和更新项目记忆，任务需要时把相关内容带回对话。项目架构、进度、命令回执和代码定位都沿着同一个同步边界更新。

## 三分钟开始使用

### macOS App

1. [下载最新 App](https://github.com/yubinbin32-ops/ContextOS/releases/latest)，解压并打开 **ContextOS**。
2. 打开 **设置**，选择检测到的 AI 编辑器，点击 **安装 / 同步插件**。
3. 在 Codex 中打开项目，在插件列表确认出现 **ContextOS**，然后开始工作。

桌面版支持 macOS 14 及以上，MCP 运行时使用 Node.js 22 或以上。App 会把编辑器配置和插件入口写好，安装完成即可使用。

![一键同步编辑器和 MCP](assets/settings-sync.png)

### 其他操作系统

在你使用的 AI 编辑器中安装 ContextOS 插件 / MCP 入口即可。仓库也提供无界面 CLI：

```bash
npx -y github:yubinbin32-ops/ContextOS init --scan
npx -y github:yubinbin32-ops/ContextOS setup
```

编辑器要求填写 MCP 服务时使用 `serve`。安装完成后可用 `status` 和 `sync` 查看项目记忆是否已连接。

## 日常怎么使用？

安装一次后，日常对话保持原来的表达方式。下面三句话就覆盖了最常见的开始方式：

- **现有项目从零开始：** 把项目架构写入 OS。
- **跨对话持续：** 查看 OS，判断目前进度。
- **开发文档：** 把这部分开发文档写入 OS，然后开始执行。

开发过程中可以继续使用自然语言描述需求、修复、审查或设计。完成一项工作后，AI 会把源码位置、命令回执、验证结果和下一步写回项目记忆。

![项目地图和右侧详情抽屉](assets/readme-reader.png)

## 可复现 benchmark

下面的数据来自 2026 年 9 月 12 日对 graph revision 1093 隔离快照的测量，单位是 JavaScript UTF-16 字符；它展示 ContextOS 返回给 AI 的内容边界。

| 测量内容 | 结果 |
|---|---:|
| 完整图谱参考大小 | 1,216,655 字符 |
| 单次任务上下文预算 | 4,000 字符 |
| 上下文缩减 | **99.67%**（1,216,655 → 4,000） |
| 4 个完整源码文件 → Chain 定位流 | **99.09%**（226,522 → 2,071） |
| 固定模拟构建日志 | **91.78%**（10,071 → 828），错误和失败信息保留 |
| 查询样本 | 12 次本地调用 |
| 查询延迟 p50 / p95 | **1,161.29 ms / 1,349.72 ms** |

四个任务查询都在 4,000 字符预算内返回了预期 Block 和可见定位信息：

| 查询 | 预期 Block | 延迟（ms） | 缩减 |
|---|---|---:|---:|
| OpenCode 平台支持与 MCP 注入 | `in-app-plugin-install` | 1226.01 · 1155.62 · 1160.94 | 99.67% |
| Git Discard 撤回与 SQLite 热重载 | `sqlite-graph-store` | 1151.74 · 1161.29 · 1174.02 | 99.67% |
| CJK 分词与 BM25 字段加权检索 | `context-retrieval` | 1150.43 · 1162.48 · 1151.02 | 99.67% |
| SourceBinding 路径与符号同步 | `live-binding-refresh` | 1349.72 · 1173.70 · 1214.53 | 99.67% |

Chain 测量使用 `chain-context-os`，返回了 4 个已锚定定位：`ast-facade-engine/extractSymbols`、`progressive-materializer/addSourceRef`、`terminal-sanitizer/sanitizeTerminalOutput`、`desktop-context-console/chainCodeStreamSection`。完整原始数据见 [`docs/benchmarks/2026-09-12-v040-chain-network.json`](docs/benchmarks/2026-09-12-v040-chain-network.json)。

日常使用体感上下文压缩频率大约减少 60%。

benchmark 记录服务响应、字符缩减和本地调用延迟；完整图谱、完整文件大小、MCP 工具说明、skill、后续源码读取、模型 token、成本与任务成功率属于其他观察维度。12 次调用同时覆盖首次读取和热读取，延迟数据用于版本间比较。

修改服务或图谱后，可以重新测量：

```bash
npm run benchmark -- --output docs/benchmarks/2026-09-12-v040-chain-network.json
```

## 开发者

```bash
git clone https://github.com/yubinbin32-ops/ContextOS.git
cd ContextOS
npm ci
npm test
npm run plugin:verify
npm run desktop:build       # macOS + Swift/Xcode
```

版本化的 `.contextos/graph.json` 是项目可移植的图谱投影。内部方案、审计和教材属于 OS Documents；benchmark JSON 与公开 README 保留在仓库中。

[参与贡献](CONTRIBUTING.md) · [安全政策](SECURITY.md) · [MIT License](LICENSE)
