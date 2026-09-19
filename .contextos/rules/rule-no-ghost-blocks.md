---
id: rule-no-ghost-blocks
title: Strict Real-Code Block Invariant
category: architecture
priority: high
summary: Every Block must bind to real files, AST symbols, or an existing directory tree.
---

# Strict Real-Code Block Invariant

# Strict Real-Code Block Invariant

Ghost or blueprint blocks without artifact references are strictly prohibited. Every Block must bind to at least one existing file, AST symbol, or directory tree. Dependency and vendor directories bind as a single `tree` anchor with a manifest hash; generated outputs do not become Blocks.
