---
id: rule-architecture-truth
title: 架构事实唯一源与真实锚点
category: architecture
priority: high
summary: 事实只在图谱与 SQLite 中；每个 Block（含派生模块）必须由真实文件与 AST 符号锚定，README 与 Skill 不得替代事实。
---

# 架构事实唯一源与真实锚点

1. **唯一落点**：架构事实只存在于 `.contextos/graph.json` 与 SQLite。`README.md` 说明产品能力，`SKILL.md` 说明 AI 的调用方式，两者都不得被当作架构事实引用，也不得据此臆造模块。
2. **真实锚点**：任何 Block —— 包括 `ship` 自动派生出的 `mod-*` 模块 —— 都必须绑定磁盘上真实存在的文件或目录，并带符号或内容哈希。禁止无源码对应的幽灵 Block。
3. **派生优先**：模块归属默认由 AST 与目录聚类派生（`block-capability-registry` / `block-module-index`），人工策展只用于补充语义，不作为流程前置条件。
4. **命名要人能读懂**：Block 与 Chain 的 `id` 稳定、`title` 一眼能认出、`summary` 一句话说清职责，便于人读与地铁图展示。
