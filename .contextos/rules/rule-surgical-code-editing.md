---
id: rule-surgical-code-editing
title: Surgical Code Editing Protocol
category: code-quality
priority: critical
summary: Prefer AST outline and surgical symbol read/edit over full-file dumps.
---

# Surgical Code Editing Protocol

## Best Practice
1. Inspect file structure with code outline to identify target symbol boundaries and 2-hop calls.
2. Read only the target function or method using code read with selector.symbol.
3. Apply focused modifications with code edit. ContextOS will automatically re-parse the AST and update symbol locators.
4. Reserve full-file reading for small configuration files or formats without structural symbol models.
