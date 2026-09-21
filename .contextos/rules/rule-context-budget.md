---
id: rule-context-budget
title: 上下文预算与渐进披露
category: performance
priority: high
summary: 默认只读预算内的切片；要全量必须显式加深，绝不整文件、整表、整日志倾倒。
---

# 上下文预算与渐进披露

1. **默认 L0/L1**：`explore` 与 `change` 的返回都经过字符预算裁剪（默认 4000 字符），被裁掉的段落会标注在尾部注释里。
2. **按需加深**：确实需要更多内容时传 `depth: "deep"`，而不是自己改用原生读文件工具把整个文件读进来。
3. **规则按需取**：`explore` 只注入最相关的 ≤3 条规则标题，细则用 `ops({ capability: "knowledge", action: "rule_open" })` 单条取，禁止全量扫表。
4. **日志按需取**：命令输出只回失败片段；要看更多就指定 `lines` / `grep` 再取。
