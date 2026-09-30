<div align="center">
  <img src="assets/logo.png" width="80" alt="ContextOS 标志" />
  <h1>ContextOS</h1>
  <p><strong>让 AI 只读需要的代码，让冗长日志留在上下文之外。</strong></p>

[![GitHub release](https://img.shields.io/github/v/release/yubinbin32-ops/ContextOS)](https://github.com/yubinbin32-ops/ContextOS/releases/latest)
[![GitHub stars](https://img.shields.io/github/stars/yubinbin32-ops/ContextOS?style=flat)](https://github.com/yubinbin32-ops/ContextOS/stargazers)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933)](https://nodejs.org)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

<p>当前版本：<span id="contextos-version">2.7.1</span> · 本地 MCP 服务 · AST 切片 · 验证回执 · 持久化项目状态</p>

[**快速安装**](#快速安装) · [**完整测评**](docs/BENCHMARK.md) · [**发布页**](https://github.com/yubinbin32-ops/ContextOS/releases) · [**English**](README.md)
</div>

ContextOS 是 AI 编码智能体与代码仓库之间的开源执行层。它返回指定函数和代码区间，在对话之外执行命令，再把简短的验证回执和必要的失败诊断送回模型。项目状态保存在 `.contextos/`，供后续开发复用。

**本仓库两个文件的实测：整文件读取改为符号切片，返回 token 从 1,459 降到 336、从 43,031 降到 280。** 这些数字衡量工具返回上下文，不代表模型账单或完整任务的总 token 节省。[查看方法、对照组与原始数据 →](docs/BENCHMARK.md)

![ContextOS 开发流程与架构地铁图演示](assets/contextos-demo.gif)

## 它能解决什么？

| 开发中的上下文浪费 | ContextOS 的做法 |
| --- | --- |
| 改一个函数，却把大文件全部读入 | 按 AST 符号或精确行区间读取，并提供源码位置 |
| 反复读取未变化的代码 | 返回 unchanged 回执，避免重复送入正文 |
| 把成功构建的长日志塞进对话 | 日志留在磁盘，只返回命令、退出码和回执 |
| 测试失败信息被噪声淹没 | 同轮返回验证结果和必要的失败证据 |
| 多个文件、修改和测试分散往返 | 批量流水线执行，修改时直接验证 |
| 新会话重复重建项目认知 | 持久化会话状态与 Block/Chain/Link 架构图 |

默认 MCP 接口只有一个 **`contextos` 工具**。Codex 可按插件加载，其他 MCP 宿主可运行同一个本地服务。桌面端提供架构地铁图；Micro 是可选的外接执行器，核心功能和本次基准都不需要模型 API key。

## 实测结果与适用范围

五次独立临时工作区运行，使用 `o200k_base` 分词器，报告中位数。**下表只计算工具响应正文。**

| 场景 | 原生返回 token | ContextOS 返回 token | 变化 |
| --- | ---: | ---: | --- |
| 大文件整读 → 单个符号 | 43,031 | 280 | 减少 99.35% |
| 较小源码文件整读 → 单个符号 | 1,459 | 336 | 减少 76.97% |
| 重复读取未变化的符号 | 165 | 36 | 减少 78.18% |
| 合成成功构建，1,000 行日志 | 14,003 | 83 | 减少 99.41% |
| 合成失败构建，1,000 行日志 | 14,016 | 150 | 减少 98.93% |
| 原生工具已精确切出同一大文件符号 | 165 | 280 | 多 115 |
| 极小文件 | 6 | 66 | 多 60 |

**任务越能复用读取结果、避免大段日志，越值得使用。** 紧凑工具定义、服务端说明与技能正文一起加载时，本次测得固定上下文约 **2,504 token**。首次读取已有精确切片时，原生工具可能更省；简单一行修改应跳过完整探索流程。合成日志展示的是受控噪声下的压缩效果，不代表所有项目。模型推理、缓存折扣、实际账单与任务完成质量仍需要智能体级 A/B 测试。

单工具定义为 1,056 token，七工具兼容接口为 2,922 token。[完整测评与优化方向](docs/BENCHMARK.md)。

## 快速安装

需要 **Node.js 22+**。本版本推荐可复现的源码安装方式。

```bash
git clone https://github.com/yubinbin32-ops/ContextOS.git
cd ContextOS
npm ci
npm run plugin:build
```

### Codex 插件

使用支持插件的 Codex CLI，注册本仓库附带的市场：

```bash
codex plugin marketplace add .
codex plugin add contextos@contextos-development
npm run plugin:install
npm run plugin:install:check
```

安装后新开聊天，才能加载更新的服务端与技能。安装检查会比对注册版本及实际文件；仅把新 bundle 复制到旧缓存目录，不算完成升级。

### 其他 MCP 宿主

在宿主的 MCP 配置中添加 stdio 服务，将路径替换为实际绝对路径：

```json
{
  "mcpServers": {
    "contextos": {
      "command": "node",
      "args": ["/absolute/path/ContextOS/plugins/contextos/server/contextos-mcp.mjs"]
    }
  }
}
```

让智能体加载 [ContextOS 技能](plugins/contextos/skills/contextos/SKILL.md)，或遵循 [自动配置指南](AI_SETUP.md)。不同宿主的配置格式有所差异，指南提供 Cursor、Claude、Antigravity 和 OpenCode 的接入说明。

### 使用示例

下面是智能体发起的 MCP 调用，`projectRoot` 使用项目绝对路径：

```js
contextos({
  action: "inspect",
  args: { path: "src/cart.ts", symbol: "calculateTotal" },
  projectRoot: "/absolute/path/to/project"
})

contextos({
  action: "change",
  args: {
    edits: [{ path: "src/cart.ts", target: "price * quantity", replacement: "price * quantity - discount" }],
    verify: ["npm test"],
    autoRevert: true
  },
  projectRoot: "/absolute/path/to/project"
})
```

复杂任务按技能中的流程批量探索、精确读取和验证，再集中修改。需要更多证据时，可显式请求符号、区间或恢复读取。

## 2.7.1 修复了什么？

- 批量读取保留指定的符号和行区间，无需隐藏参数才能生效。
- 不连续的多个源码区间分别保留原始行号。
- 安装时刷新 Codex 注册版本，核验真实文件，并保留未启用的历史缓存。
- `--check` 只读检查，拒绝过期注册信息和旧 bundle。
- 插件构建与安装附带解析器 WASM 和语法资源，离开源码目录后仍保留 Python 方法哈希与调用信息。
- 新增公开基准，包含精确原生对照、负收益场景、固定开销与质量断言。

[发布说明](.github/RELEASE_NOTES.md) · [最新发布页](https://github.com/yubinbin32-ops/ContextOS/releases/latest)

## 本地状态与可选功能

本地模式将项目状态保存在工作区，核心服务不依赖云端账号。云协作仍属实验功能；Micro 仅在配置并调用时请求外部模型。

桌面包及支持的平台以各版本发布页为准。2.7.1 的节省数据来自 macOS arm64 上的 MCP 服务，不代表 Windows 桌面、云协作或 Micro 的收益。

## 复现与参与

```bash
npm test
npm run plugin:verify
npm run dist:smoke
npm run acceptance:real
npm run benchmark:context -- --runs 5 --output .contextos/benchmarks/my-run.json
```

欢迎附带仓库规模、任务、宿主、分词器和对照方式提交测评。发现“不省 token”的场景，同样能帮助改进。

如果精确读取和简短回执对你有帮助，欢迎 **[Star ContextOS](https://github.com/yubinbin32-ops/ContextOS)** 关注后续进展。[提交缺陷](https://github.com/yubinbin32-ops/ContextOS/issues/new/choose) 或贡献改进。

[贡献指南](CONTRIBUTING.md) · [安全策略](SECURITY.md) · [MIT 协议](LICENSE)
