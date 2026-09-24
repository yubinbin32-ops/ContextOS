# ContextOS v2.6.0 发布说明 (Release Notes)

ContextOS v2.6.0 是一次**关键架构与执行能效跃升里程碑**。本次更新针对复杂跨系统工程开发中 AI Agent 的上下文膨胀瓶颈进行了深层治理，全面重构了执行脚手架、索引引擎与输出透出机制，并实现了全平台无感动的版本自动演化。

---

## 🚀 核心更新内容与重大改进

### 1. 深度执行脚手架升级与反 ReAct 惯性治理
* **问题痛点**：以往大模型在编码时容易陷入“单步试探”（Think-1-Step $\to$ Run-1-Cmd）的惯性循环，导致轮次成百上千次往返，上下文平方级累积重投，消耗数千万 Token。
* **重构落地**：
  * 重塑 `SKILL.md` 为**开发周期执行脚手架（Execution Scaffolding）**，建立明确的四阶段状态机（`explore` 全局感知 $\to$ `inspect/pipeline` 批量摄取 $\to$ `change(verify)` 原子突变 $\to$ `ship` 证据收尾）；
  * 引入 **“阅读不过二原则”** 与批处理反射机制，强制要求跨文件查验与多区间阅读在单轮内一次性聚合请求；
  * 实测将复杂多系统任务的交互轮次从 200+ 轮骤降至 10 余轮，**Token 消耗直降 90% 以上**。

### 2. 全仓工程资产一等公民化（All-Artifact Topology Indexing）
* **功能升级**：彻底打破原有仅索引源码扩展名的限制，解除 AST Bias；
* **覆盖范围**：除常见源码外，全面纳管全仓配置文件与工程元数据（`.json`、`.toml`、`.yaml`、`.plist`、`.env`、GitHub Actions Workflow、Docker 及构建脚本）；
* **收益体验**：`explore` 探索工具可在第一轮首动中即时提取跨端 Manifest（如 `Cargo.toml`、`tauri.conf.json`、`Info.plist` 等）的结构化槽位（`[M1]`, `[M2]`），杜绝 AI 在未知工程中发起盲目全局搜索。

### 3. 输出透出机制革新（彻底告别致盲性折叠）
* **智能语义分流**：
  * 构建与编译日志类输出在成功时保持静默精简；
  * 查询检索类命令（`rg`、`grep`、`find`、`cat`、`sed`、`git diff` 等）**彻底杜绝单句截断**，系统自动聚合输出 **唯一匹配文件清单（Distinct Files）** 与 Top 20 核心命中。
* **透出控制支持**：`pipeline` 与 `verify` 显式支持 `raw: true` 与自定义 `maxChars`，使 AI 能在完全受控的前提下获取高信噪比原文，彻底切断 AI 因看不到信息而逃逸至原生 shell `cat log` 的漏洞。

### 4. 全平台全自动化版本同步（Zero-Manual-Sync Versioning）
* **单一真实源**：统一以根目录 `package.json` 为全工程唯一版本来源；
* **打包自愈与无感知同步**：
  * **插件打包（`plugin:build`）**：自动提取根版本并捆绑写入 `plugin.json` 与 `server.json`；
  * **macOS 桌面端**：打包脚本与 Xcode 生成工程自动对齐 `ContextOSVersion.swift`、`Info.plist` 与 `project.pbxproj`；
  * **Windows 桌面端**：打包与编译期自动更新 `Cargo.toml` 与 `tauri.conf.json`；
  * **测试挂钩**：`npm test` 自动前置执行全仓版本对齐校验。开发者与 CI 仅需调整根 `package.json`，打包与测试命令执行时即可全自动生效，彻底免去手动执行 sync 脚本的认知负担。

### 5. 源码纯净化与伪代码清理
* 清理 Cloud Hub 及 Worker 中的硬编码 mock 回复与未知假成功响应，恢复严格报错规范；
* 管理 CLI 测试桩全面替换为真实的 SHA-256 架构锚点哈希；
* 移除历史无引用的孤立适配器空目录，平台注入工具全面直连根版本。

---

## 💻 下载与安装指引

### Windows 用户
* **标准安装包**：下载 `ContextOS_2.6.0_x64-setup.exe`，按安装向导操作即可。
* **免安装绿色版**：下载 `ContextOS-windows-x64.zip`，解压即用。
* **环境要求**：Windows 10 / 11 64 位，需配置 Node.js 22+。

### macOS 用户
* **Apple Silicon (M1/M2/M3/M4)**：推荐下载内置运行时的 `ContextOS-macos-full-arm64.zip`（开箱即用，免配置环境）。
* **Intel Mac (x86_64)**：推荐下载内置运行时的 `ContextOS-macos-full-x64.zip`。
* **轻量版**：若本机已具备 Node.js 22+，可下载体积精简的 `ContextOS-macos-arm64.zip` 或 `x64.zip`。
* **Gatekeeper 放行**：首次运行若提示未验证开发者，可在“访达”中右键选择“打开”放行。
