---
id: rule-product-contract
title: ContextOS Product Specification and Non-Negotiable Contracts
category: product
priority: high
summary: Define graph truth, C-D-C-S evidence gates, single-writer safety, and first-class file/symbol/tree Block bindings.
---

# ContextOS Product Specification and Non-Negotiable Contracts

# ContextOS Product Specification and Non-Negotiable Contracts

## 1. Product Truth & Grounding
1. System facts and architectural truth are preserved exclusively in the structured graph (`.contextos/graph.json` / SQLite `state.sqlite`) and verified disk bindings.
2. The product README explains user-facing capabilities; the agent Skill defines task routing and protocol workflows. Neither replaces ground-truth AST graph data.
3. Hallucination or speculation without grounding in real disk files and registered blocks is strictly prohibited.

## 2. Invariant Contracts
1. **Strict Real-Code Block Invariant**: Every registered block must bind to real source code, configuration/resource files, AST symbols, or an existing directory tree. Ghost blocks are strictly rejected at the database level.
2. **C-D-C-S Development Protocol**: All engineering work must follow Create -> Develop -> Check -> Sync with a 100% working-set coverage gate before sync. A task sync requires at least one passing check backed by a receipt or explicit manual evidence.
3. **Out-of-Context Command Execution**: Terminal commands run through `run_command` with full sanitized logs stored in `.contextos/logs/` and concise receipts returned to context.
4. **Progressive Rule Disclosure**: Tasks explicitly bind relevant rules; rule specifications are disclosed on demand via `knowledge(rule_open)`.
5. **Single Writer and Graph Safety**: Mutating operations acquire `.contextos/project.lock`; SQLite uses immediate transactions and graph exports use a recoverable outbox. A lower-revision `graph.json` is a conflict, never an implicit rollback.
6. **Directory Bindings, Not File Ledgers**: Dependency, vendor, and first-party resource directories are represented by one `tree` artifactRef on a meaningful Block. `hashMode: "manifest"` uses a lockfile for dependency boundaries; `hashMode: "content"` hashes first-party directory contents. Generated build outputs are not architecture graph entities and remain in receipts/logs.
