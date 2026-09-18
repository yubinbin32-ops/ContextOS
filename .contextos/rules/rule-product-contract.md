---
id: rule-product-contract
title: ContextOS Product Specification and Non-Negotiable Contracts
category: product
priority: critical
summary: Preserves system facts in structured graph and enforces non-negotiable architecture invariants.
---

# ContextOS Product Specification and Non-Negotiable Contracts

## 1. Product Truth & Grounding
1. System facts and architectural truth are preserved exclusively in the structured graph (`.contextos/graph.json` / SQLite `state.sqlite`) and verified disk artifacts.
2. The product README explains user-facing capabilities; the agent Skill defines task routing and protocol workflows. Neither replaces ground-truth AST graph data.
3. Hallucination or speculation without grounding in real disk files and registered blocks is strictly prohibited.

## 2. Invariant Contracts
1. **Strict Real-Code Block Invariant**: Every registered block must bind directly to real source code files and AST symbols. Ghost blocks are strictly rejected at the database level.
2. **C-D-C-S Development Protocol**: All engineering work must follow Create -> Develop -> Check -> Sync with 100% block coverage gate before sync.
3. **Out-of-Context Command Execution**: Terminal commands run through `run_command` with full raw logs stored in `.contextos/logs/` and concise receipts returned to context.
4. **Progressive Rule Disclosure**: Tasks explicitly bind relevant rules; rule specifications are disclosed on demand via `knowledge(rule_open)`.
