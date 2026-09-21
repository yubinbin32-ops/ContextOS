---
id: rule-out-of-context-execution
title: 命令出舱与进程治理
category: execution
priority: high
summary: 一次性命令走 verify 出舱执行，常驻服务走 verify(mode:"serve") 托管；原始日志永不进上下文。
---

# 命令出舱与进程治理

1. **一次性命令优先走 `verify`**：它会剥离 ANSI 与密钥、把全量日志写入 `.contextos/logs/`，只回传退出码、耗时、Receipt ID 与失败片段。直接跑原生命令也可以，但必须过滤或只取尾部输出。
2. **常驻进程**：dev server、watcher 用 `verify({ mode: "serve" })` 启动，用 `mode: "logs"` 按需过滤调阅，`mode: "stop"` 结束。谁启动谁释放，`ship` 前必须停掉自己拉起的服务。
3. **不倾倒日志**：不要把成百上千行的终端原文贴进对话；需要更多细节就指定行号或关键词再取。
4. **证据来自 Receipt**：走 `verify` 的结论必须能追溯到 `receipt-xxx`；用原生方式跑的命令，至少保留退出码与关键输出作为凭据。
