---
id: rule-surgical-code-editing
title: 手术刀式代码读写
category: code-quality
priority: high
summary: 先大纲与符号定位，再切片读取，最后唯一匹配改写；改完由 OS 自动重锚，无需回读整文件。
---

# 手术刀式代码读写

1. **先定位再读**：优先 `explore` 拿到大纲与候选模块，再定位目标符号；确实需要全文（例如整篇重写）时才整读。
2. **切片优先**：用 `ops({ capability: "code", action: "read", args: { path, selector } })` 或 `change` 的 `symbol` / `startLine` / `endLine` 精确取片段。
3. **唯一匹配改写**：`change` 的 `target` 必须在文件内唯一；不唯一就补上 `symbol` 或行号范围。批量替换、格式化、重命名这类机械改写用原生脚本更高效。
4. **改完不回读**：写盘后 AST 自动重解析并重锚符号，返回值里带新哈希与重锚数量，直接采信，不要再读一遍文件确认。
5. **新建文件**：中小文件用 `create`（锚点与哈希一次建立）；很长的新文件用原生写入更顺手。
