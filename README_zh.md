<div align="center">
  <img src="assets/logo.png" width="80" alt="ContextOS 标志" />
  <h1>ContextOS</h1>
  <p><strong>AI 开发的上下文外骨骼。</strong></p>
  <p>优化 AI 开发全流程，减少重复 token 消耗与上下文占用。</p>

[![GitHub release](https://img.shields.io/github/v/release/yubinbin32-ops/ContextOS)](https://github.com/yubinbin32-ops/ContextOS/releases/latest)
[![GitHub stars](https://img.shields.io/github/stars/yubinbin32-ops/ContextOS?style=flat)](https://github.com/yubinbin32-ops/ContextOS/stargazers)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933)](https://nodejs.org)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

<p>本地 MCP 运行时 · 精确证据 · 持久回执 · 实时架构</p>

[English](README.md) · [一句话安装](#一句话安装) · [实测效果](#三种开发方式的实测对比) · [桌面-app](#在-app-中看见项目)
</div>

## 给 AI 一副上下文外骨骼

![ContextOS 桌面演示](assets/contextos-demo.gif)

ContextOS 是 AI 编程代理与代码仓库之间的本地开发运行时。它把源码证据、命令日志、计划、架构和验证回执保存在主对话之外，按任务提供下一步决策所需的内容。

OS 是覆盖 **理解项目、计划、读取证据、执行、实现、验证、审查与接续开发整个流程** 的 AI 开发外骨骼。精确读取、可复用命令、pipeline、Block、Chain、持久计划、Micro 与 CLI，共同服务于一个目的：减少不必要的 token 消耗与上下文占用，让开发持续建立在可检查的项目状态上。

你仍然使用熟悉的编程助手。OS 为它提供执行层与项目记忆，也在适合的任务中提供 API Micro 有界协助与 CLI 隔离实现。

在已有真实开发任务记录中，完整 OS + Micro + CLI 流程相较原生工具，**主线程峰值上下文降低 63.8%**，主线程累计原始 token 降低 77.4%。[任务、统计口径与适用范围见下文。](#三种开发方式的实测对比)

## 为什么 AI 写得越久，负担越重

为了定位一个函数，代理读入整个文件；为了找到一次失败，它把全部测试日志带进对话。随后又重复读代码、重复执行命令、重新解释之前的决策。跨文件实现继续占据主对话，与计划、架构判断和最终审查共享同一个上下文窗口。

对话越来越长，用户需要反复提醒，项目状态越来越难确认，真正有价值的下一步决策却没有足够空间。开发需要一套能够承载证据、执行和进度，并在不同工具与会话之间持续工作的系统。

## OS 如何承载这些工作

```text
你 → 主代理：计划、任务边界、架构决策、最终审查
          │
          └─ ContextOS：证据、命令、修改、持久项目状态
                ├─ API Micro：有界检索、总结、简单检查
                ├─ CLI 执行器：隔离实现 → 报告 → 集成
                └─ 桌面 App：架构、计划、检查点、配置
```

证据与日志保存在本地。Micro 与 CLI 在自己的上下文中读取任务材料，返回精简报告。源码修改通过 OS 进入项目，让文件所有权、验证结果与架构图保持关联。新会话可以恢复计划与回执，继续实际进度。

### 功能、实现方式与目的

| 功能 | 如何实现 | 带来的效果 |
| --- | --- | --- |
| **证据 · `ask`** | 精确读取文件、行范围与 AST 符号；用 result ID 恢复证据并检查源码版本。 | 按需读取相关实现，复用有效证据，减少重复读入整文件。 |
| **命令 · `command`** | 执行一次，保存 stdout、stderr 与退出码；按命令 ID 提取所需日志。 | 把构建噪声留在主上下文之外，直接找回失败证据。 |
| **批处理 · `pipeline`** | 把已知步骤组合成串行或并行执行，返回各步骤结果并支持继续。 | 减少工具往返，把独立读取与验证放进一次调用。 |
| **架构单元 · Block** | 将受管源码绑定到架构单元，记录边界、状态与验证证据。 | 明确实现归属，让代码变化与架构保持联系。 |
| **架构路径 · Chain** | 把 Blocks 连接成项目路径，记录关系与进度。 | 看清功能依赖，沿一项能力追踪跨模块实现。 |
| **修改 · `change` / `integrate`** | 通过 OS 应用有界修改，或集成 CLI 隔离工作区的差异，并保存验证回执。 | 让实现具备可审查的结果，同时更新项目架构状态。 |
| **小助手 · `micro`** | 使用配置好的 API 模型，完成有界检索、摘要、诊断或小修改，返回精简报告。 | 将日常工具循环交给低成本助手，为主代理保留判断空间。 |
| **执行器 · `agent`** | 通过已配置 CLI adapter 在隔离工作区执行任务，支持后台收集与结构化报告。 | 把复杂实现移出主对话，提交可验证、可集成的结果。 |
| **连续性 · plan / task / session** | 在项目 OS 状态中保存目标、进度、规则、决策与回执。 | 跨会话继续开发，也能在 App 中检查真实进展。 |

任务边界清晰时，Micro 与 CLI 才能发挥作用。一个确定的源码读取可以直接用 OS；复杂实现交给 CLI。委派也有开销，因此 OS 保留执行记录，让结果可以检查。

### 三种开发方式的实测对比

已有对比以 [`0dd6431`](https://github.com/yubinbin32-ops/ContextOS/tree/0dd6431) 为基线，使用独立 worktree 与全新主代理会话完成同一真实功能：计划依赖的添加、移除、查询与持久化，拒绝未知目标、重复、自引用和循环依赖，补齐 MCP 路由与 domain、application、storage、MCP 测试。[历史测量记录](https://github.com/yubinbin32-ops/ContextOS/blob/4706c38/README.md#4-empirical-evaluation)。

| 开发方式 | 主线程峰值上下文 | 相较原生降低 | 主线程原始 token | 测试通过 |
| --- | ---: | ---: | ---: | ---: |
| **原生工具开发** | 234,174 | 基线 | 8,016,375 | 778 / 778 |
| **OS + API Micro** | 145,694 | **37.8%** | 4,993,135 | 778 / 778 |
| **OS + API Micro + CLI** | 84,681 | **63.8%** | 1,809,566 | 781 / 781 |

**“减少约 60% 上下文”的口径：** 这项任务中，主代理单次请求的峰值输入从 234,174 降至 84,681 token。这不是所有仓库的固定保证，也不代表主代理与所有助手的总 token 同比例下降。

<details>
<summary>展开完整 token 用量、指定口径的等价美元成本与 OS 控制组</summary>

原始 token 是累计输入加输出；峰值上下文是主代理单次请求的最大输入。**缓存输入已包含在输入中**，所以 `非缓存输入 = 输入 − 缓存输入`。推理 token 已包含在输出中，不重复计数或计费。

按指定公式折算：`等价 token = 主线程 raw + (Micro raw + CLI raw) / 7`。

| 实验组 / 开发方式 | 主线程 raw | Micro raw | CLI raw | 已观测合计 raw | 等价 token | 相较原生降低 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A · 原生 | 8,016,375 | 0 | 0 | 8,016,375 | 8,016,375 | 基线 |
| B · 仅 OS，不使用助手 | 6,119,582 | 0 | 0 | 6,119,582 | 6,119,582 | 23.7% |
| C · OS + Micro | 4,993,135 | 734,551 | 0 | 5,727,686 | 5,098,070.9 | 36.4% |
| D · OS + Micro + CLI | 1,809,566 | 3,258,709† | 4,393,118 | 9,461,393† | 2,902,684.1† | 63.8%† |

美元计算采用**用户指定的对比费率，单位为美元 / 百万 token**：非缓存输入 $2，缓存输入 $0.10，输出 $10。

`基价美元 = (非缓存输入 × 2 + 缓存输入 × 0.1 + 输出 × 10) / 1,000,000`

`等价美元 = 主线程基价美元 + (Micro 基价美元 + CLI 基价美元) / 7`

| 实验组 | 角色 | 输入 | 缓存输入 | 非缓存输入 | 输出 | 基价美元 | 除数 | 等价美元 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 主线程 | 7,971,486 | 7,773,056 | 198,430 | 44,889 | $1.6230556 | 1 | $1.6230556 |
| B | 主线程 | 6,073,014 | 5,945,216 | 127,798 | 46,568 | $1.3157976 | 1 | $1.3157976 |
| C | 主线程 | 4,952,753 | 4,710,016 | 242,737 | 40,382 | $1.3602956 | 1 | $1.3602956 |
| C | Micro | 720,163 | 636,800 | 83,363 | 14,388 | $0.3742860 | 7 | $0.053469428571 |
| D | 主线程 | 1,788,852 | 1,746,560 | 42,292 | 20,714 | $0.4663800 | 1 | $0.4663800 |
| D | Micro | 3,211,208† | 3,007,232† | 203,976† | 47,501† | $1.1836852† | 7 | $0.169097885714† |
| D | CLI | 4,355,283 | 4,214,016 | 141,267 | 37,835 | $1.0822856 | 7 | $0.154612228571 |

| 开发方式 | 等价美元合计 | 相较原生降低 |
| --- | ---: | ---: |
| 原生 | $1.623055600000 | 基线 |
| 仅 OS | $1.315797600000 | 18.9% |
| OS + Micro | $1.413765028571 | 12.9% |
| OS + Micro + CLI | $0.790090114286† | 51.3%† |

这些数字是**指定口径的等价消耗与成本**，不是实际供应商账单，也不是已核实的供应商费率。助手除以 7 是对比假设。四组主会话记录的模型别名均为 `deepseek-v4.1-flash`、推理强度 `max`、custom provider；Micro C/D 的会话 `lastModel` 也为该别名，D CLI 记录了相同别名与 custom provider。这些记录不能独立证明底层实际模型身份。

主线程用量按供应商 response ID 去重，与终态累计量一致。C Micro 有 2 份 receipt，26/26 个已发起请求均有供应商 usage；D CLI 有 51 个唯一累计状态，单次 usage 之和与终态累计量一致。**† D Micro 有 5 份 receipt，发起 129 个请求，其中 128 个返回 usage；1 个续跑超时请求的用量未知。** D 的合计及 51.3% 等价成本降低仅对应已观测小计，缺失请求没有当作零。原始 Micro 推理字段不可得，保留为未知。

完整流程的**已观测总 raw token 高于原生**，但主线程峰值上下文明显降低。仅 OS 的峰值为 184,507（降低 21.2%），这次等价美元成本也低于 OS + Micro。以上是一项功能的历史单次对比，结果随任务、模型、缓存与委派方式变化。

查看[冻结证据与口径](docs/benchmarks/plan-dependencies/README.md)、[原始 usage 字段与覆盖情况](docs/benchmarks/plan-dependencies/historical-usage.json)、[角色成本 CSV](docs/benchmarks/plan-dependencies/usage-by-role.csv) 和[四组汇总 CSV](docs/benchmarks/plan-dependencies/comparison.csv)。运行以下命令复算并检查公开文件哈希：

```sh
python3 docs/benchmarks/plan-dependencies/recalculate.py --check
```

</details>

## 在 App 中看见项目

桌面 App 展示代理使用的同一份 OS 状态：Blocks、Chains、计划、检查点、规则与知识。白色画布、克制的色彩和精确连线，让大型项目的结构与进度可以直接阅读。

![Block 与 Chain 实时架构画布](assets/canvas-overview.png)

**把系统看清楚。** 沿 Chain 追踪 Blocks，在侧栏查看当前能力，让实现进度与验证状态和架构图并排呈现。

<details open>
<summary>追踪功能路径，检查交付证据</summary>

![从集成到界面和测试的功能路径](assets/path-impact.png)

**沿功能看影响。** 高亮 Chain 串联插件集成、打包与验证工作。

![包含回执引用的已通过检查点](assets/checkpoint-detail.png)

**让完成状态有据可查。** 检查点展示验证状态与回执引用。

</details>

<details>
<summary>阅读项目知识，同步开发工具</summary>

![项目知识与规则导航](assets/knowledge-reader.png)

**随时找回项目约定。** 从侧栏打开仓库文档与项目规则。

![App 内的仓库 README 阅读器](assets/readme-reader.png)

**在 App 中阅读文档。** 阅读器把仓库内容放在项目旁；效果统计以下列可复算证据为准。

![桌面设置与 AI 编辑器同步](assets/settings-sync.png)

**管理开发环境。** 设置集中管理偏好与宿主集成；可配置全局模型和推理强度，让各角色通过 `Use Global` 继承，并同步 Micro 与 CLI adapter 的可用模型和推理等级。

*上方设置截图展示此前已接受的布局。*

![AI 宿主中的 MCP 与 Skill 集成](assets/mcp-integration.png)

**直接从编程助手操作 OS。** 宿主加载 MCP 运行时与匹配的 Skill，让代理访问项目状态。

部分截图来自早期版本，保留了旧名称 `mdflow` 或旧版本标记，用于展示操作流程；安装与配置请以当前 setup 为准。

</details>

## 一句话安装

把下面这句话发给你的 AI 编程助手：

> 读取 (https://github.com/yubinbin32-ops/ContextOS/blob/main/setup.md) ，为我安装OS

AI 会读取 [setup.md](setup.md)，安装 OS 与匹配的宿主插件、Skills，注册仓库，配置 API Micro 与你的 CLI，并用真实工具调用验证结果。依赖检查、adapter 编写、插件配置与诊断，都由 AI 引导完成。

**无需自己去 Release 下载与手动配置。** setup 面向安装代理，包含诊断、adapter 编写、插件配置与验收步骤。

### Micro 是必须配置项

Micro 是处理日常简单任务的小助手，**OS 工作流必须配置它的 API 连接**。准备 API key、供应商 base URL 与 model。主代理订阅或 CLI 登录不能代替 Micro API 配置。

推荐以下方式：

- **[Command Code GOAT](https://commandcode.ai/docs/plans/goat)**：提供 Provider API 权限。在控制台创建 key，让 AI 按官方当前文档配置端点与模型 ID。
- **[OpenCode Go](https://opencode.ai/v2/docs/console/go)**：提供订阅 API key 与可用编程模型，让 AI 核对当前模型列表与 API 配置。
- **自己的兼容 API**：继续使用你信任的供应商，包括 [DeepSeek API](https://api-docs.deepseek.com/)。

有界 Micro 任务推荐 **DeepSeek V4.1 Flash**；供应商支持时，将思考等级设为 **`medium`** 即可。[DeepSeek 官方当前模型 ID 为 `deepseek-flash`](https://api-docs.deepseek.com/updates/)，第三方网关可能使用不同名称。AI 安装时应验证模型可用性，并映射供应商支持的思考参数。

Key 保存在安装器指定的本地凭据或配置路径中，避免写进仓库文档或受版本控制的源码。

### CLI 的配置交给 AI 完成

CLI 执行器需要 CLI 程序、adapter、匹配的 ContextOS 插件与 Skills，以及可验证的登录执行通路。告诉 AI 你想使用哪个 CLI，它应查阅官网，写好 adapter，注册到 OS，配置插件，并执行真实探针和隔离实现验收。

登录、浏览器授权或系统权限可能需要你完成某一步。AI 应明确指出具体操作，继续其他安装工作，并在操作完成后重新验证。只检测到 CLI 程序或保存 adapter，还不能视为安装成功。

需要 **Node.js 22 或更新版本**。插件或运行时更新后，按照 setup 重载宿主 MCP 进程；App、插件、Skills 与运行时应保持版本一致。

## 日常使用，直接说需求

| 想做什么 | 对 AI 说 |
| --- | --- |
| 开始计划 | “请把 plan 写入 OS，开始执行。” |
| 接续开发 | “请读取 OS 当前计划与会话状态，继续下一个未完成任务。” |
| 配置小助手 | “请为我配置 Micro，验证 API 连接，用它处理有界简单任务。” |
| 配置执行器 | “请为我配置 CLI，写好 adapter，安装 ContextOS 插件，并测试隔离实现。” |
| 定位问题 | “请让 Micro 定位问题，返回相关证据和一份精简诊断。” |
| 完成功能 | “请把这个实现委派给隔离工作区中的 CLI，验证后通过 OS 集成。” |
| 检查进展 | “请更新 Blocks、Chains 与检查点，让我在 App 中查看进度。” |
| 切换工具 | “请切换到我配置的另一个 CLI adapter，验证后继续下一项任务。” |

主代理保留验收标准与最终审查。Micro 与 CLI 接受有界任务，OS 保存它们之间的证据与进度。

## 3.0.0 更新介绍

基于 `4706c38` 准备的 3.0 版本，将 ContextOS 重构为覆盖 AI 开发全流程的上下文外骨骼：

- **精确证据与可复用命令** 让源码读取、执行结果保持有界，并能按需恢复。
- **Pipeline 与验证修改** 连接批量执行、作用域内修改与可审查结果。
- **架构与项目连续性** 保存 plan、task、session、Block、Chain 与回执，跨会话恢复并投影到桌面 App。
- **按任务分工执行** 将 API Micro 有界协助与 CLI 隔离实现纳入同一套 OS 开发生命周期。
- **AI 智能安装** 将 API、宿主插件、CLI adapter、诊断与真实验收纳入 setup。

查看 [3.0 发布说明](.github/RELEASE_NOTES.md)、[安装指南](setup.md) 与 [历史版本](https://github.com/yubinbin32-ops/ContextOS/releases)。

如果 ContextOS 帮助你把注意力留给真正的开发，[欢迎点一颗 Star](https://github.com/yubinbin32-ops/ContextOS/stargazers)。也欢迎提交可复现任务和 [问题反馈](https://github.com/yubinbin32-ops/ContextOS/issues)，帮助下一版持续改进。
