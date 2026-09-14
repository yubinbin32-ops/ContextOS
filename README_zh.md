<div align="center">
  <img src="assets/logo.png" width="76" alt="ContextOS" />
  <h1>让 AI 记住项目，下一次对话从上次进度继续。</h1>
  <p><strong>ContextOS 把项目架构、开发进度、命令结果和代码位置放在同一份可同步的项目记忆里。</strong></p>
  <p><a href="https://github.com/yubinbin32-ops/ContextOS/releases/latest"><strong>下载 macOS App</strong></a> · <a href="#三分钟开始使用">三分钟开始使用</a> · <a href="README.md">English</a></p>
</div>

![ContextOS 交互工作流演示](assets/contextos-demo.gif)

## ContextOS 解决什么问题？

AI 开始一段新的编程对话时，通常要重新读文件、寻找模块关系、确认设计取舍，再回忆上一段对话做到哪里。随着项目变大，架构说明、进度记录和命令日志会一起挤进上下文，真正要做的工作反而变慢。

ContextOS 把这些项目记忆放在代码旁边，由 OS 图谱统一保存。AI 每次拿到与当前任务相关的架构和进度，App 里也能看到同一份信息。换一个对话，工作可以从已有状态继续。

![ContextOS V2 Metro Map 地铁路线图架构与桌面端实景](docs/images/contextos-desktop-v2.png)

## 它带来的核心开发变化

### 1. 架构化身地铁路线图 (Metro Map)
Block 描述真实的物理代码能力（杜绝虚空 Ghost Block）。Chain 代表水平平行的地铁铁轨，带类型的 Link 形成正交的跨线换乘。AI 一眼看清系统骨架，无需盲读代码。

![功能链与精确 AST 代码定位](assets/path-impact.png)

### 2. 进度遵循 C-D-C-S 严格生命周期
开发严格按照 **Create（创建任务）→ Develop（手术刀开发）→ Check（验证沉淀）→ Sync（原子写回）** 节拍流转。任务携带上下文切片与中间思考，并在 Sync 时触发 **100% 工作区覆盖率门禁**。

### 3. 命令运行出舱脱敏 (Out-of-Context Execution)
`run_command` 剥离 ANSI 终端控制符与敏感密钥，全量原始日志存盘于 `.contextos/logs/`，仅向上下文返回精简回执（Receipt），削减 98% 以上的终端输出噪声。

### 4. 代码工具手术刀级读写 (Surgical Code Engineering)
集成编译器级真 AST 引擎（JS/TS/JSX/TSX 采用 `@babel/parser`，Python 采用官方标准库 `ast`，Swift 采用视图体解析），支持 VS Code 风格全局符号搜索、大纲审视、方法级抽取和补丁式精准写盘并自动重锚。

### 5. 单一入口的知识与架构决议
项目方案、设计取舍与规则规约归纳为单文件叙事 `DECISION.md` 与分类 Rules。`README.md` 与 `README_zh.md` 在 App 的知识抽屉中以只读方式直接预览。

![OS 文档和 README 的知识抽屉](assets/knowledge-reader.png)

### 6. 长期运行进程常驻监控
通过守护进程托管 Dev Server、Watcher 与后台 Worker，在桌面端左下角实时监控 PID、端口号与生命周期，支持一键安全释放进程树。

![节点抽屉与详情查看](assets/readme-reader.png)

## 三分钟开始使用

### macOS App

1. [下载最新 App](https://github.com/yubinbin32-ops/ContextOS/releases/latest)，解压并打开 **ContextOS**。
2. 打开 **设置**，选择检测到的 AI 编辑器，点击 **安装 / 同步插件**。
3. 在 Codex 中打开项目，在插件列表确认出现 **ContextOS**，然后开始工作。

桌面版支持 macOS 14 及以上，MCP 运行时使用 Node.js 22 或以上。App 会把编辑器配置和插件入口写好，安装完成即可使用。

![一键同步编辑器和 MCP](assets/settings-sync.png)

## 实测 V2 上下文节省基准

在自我托管的 ContextOS V2 自身代码库（10 Blocks, 3 Chains, 12 Links, 49 源码文件，100% 覆盖率）测定：

| 研发环节 | 传统开发交互（非推荐，消耗大） | ContextOS V2 渐进式最佳实践 | 节省比率 |
|---|---|---|---:|
| **会话启动 (Bootstrap)** | 全量加载架构与图谱 (61,902 字符 / ~15,476 tokens) | 渐进式 L0-L1 Markdown (1,987 字符 / ~497 tokens) | **96.79%** |
| **代码大纲审视** | 盲读 4 个核心全量源码 (34,045 字符 / ~8,512 tokens) | AST 符号大纲提取 (4,374 字符 / ~1,093 tokens) | **87.15%** |
| **代码阅读与查阅** | 逐文件展开全部代码 (34,045 字符) | 手术刀提取目标方法 (6,898 字符) | **79.74%** |
| **命令运行与构建** | 终端原始输出 (16,713 字符 / ~4,179 tokens) | 精简回执 + 失败提取 (251 字符 / ~63 tokens) | **98.50%** |
| **单任务全流程综合** | **129,373 字符 (~32,344 tokens)** | **13,761 字符 (~3,441 tokens)** | **89.36% (节省 28,903 tokens)** |

本地运行基准验证：

```bash
node scripts/benchmark.mjs
node scripts/practical-test.mjs
node scripts/e2e-project-lifecycle.mjs
node scripts/comprehensive-dev-eval.mjs
```

## 开发者接入

```bash
git clone https://github.com/yubinbin32-ops/ContextOS.git
cd ContextOS
npm ci
npm test
npm run plugin:verify
npm run desktop:build       # macOS + Swift/Xcode
```

版本化的 `.contextos/graph.json` 是项目可移植的图谱投影。

[贡献指南](CONTRIBUTING.md) · [安全策略](SECURITY.md) · [MIT 协议](LICENSE)
