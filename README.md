<div align="center">
  <img src="assets/logo.png" width="76" alt="ContextOS" />
  <h1>Let the AI remember the project and continue from the last conversation.</h1>
  <p><strong>ContextOS keeps architecture, progress, command results, and exact code locations in one synchronized project memory.</strong></p>
  <p><a href="https://github.com/yubinbin32-ops/ContextOS/releases/latest"><strong>Download the macOS App</strong></a> · <a href="#start-in-three-minutes">Start in three minutes</a> · <a href="README_zh.md">中文</a></p>
</div>

![ContextOS architecture and workflow](assets/contextos-demo.gif)

## What problem does ContextOS solve?

An AI coding conversation often starts by rebuilding the project map: reading files, finding module relationships, checking design decisions, and locating unfinished work. As the repository grows, architecture notes, progress updates, and build logs compete with the task itself for context space.

ContextOS stores that working memory beside the code in one OS graph. Each conversation receives the architecture and progress relevant to its task, and the App shows the same information. A new conversation can continue from the recorded state.

## What changes in daily development?

**1. Architecture becomes a map.** Blocks describe modules and responsibilities, typed Links describe real relationships, and Chains describe observable feature paths. The agent can understand how a feature connects before opening implementation code.

**2. Progress stays synchronized.** Plans, PlanChanges, ChainScopes, source bindings, checkpoints, and handoffs record the state of the work. Block transitions from ghost to implementing to complete cross the same synchronization boundary, and extending a feature also updates its existing Chain nodes and Links.

**3. Commands return a useful summary.** `run_command` stores a traceable execution receipt with redacted output, failure clues, and verification state. Routine build output remains available in the receipt while the current task receives an actionable summary.

**4. Code locations stay precise.** Source bindings keep a file, symbol, signature, and derived line range. `chain_code_stream` returns locator-only feature paths, while `block_code_stream` returns a bounded AST slice for one implementation when code is needed.

**5. Knowledge has one clear entrance.** Proposals, audits, designs, and guides live as OS Documents and are read by chapter in the App. `README.md` and `README_zh.md` remain at the repository root and appear read-only in the App Knowledge view, with images and relative links intact.

![A feature path with exact code locations](assets/path-impact.png)

![OS Documents and README in the same Knowledge drawer](assets/knowledge-reader.png)

After installation, describe the work in ordinary language. ContextOS reads and updates project memory in the background and brings the relevant architecture, progress, command receipt, or code locator into the conversation when the task calls for it.

## Start in three minutes

### macOS App

1. [Download the latest App](https://github.com/yubinbin32-ops/ContextOS/releases/latest), unzip it, and open **ContextOS**.
2. Open **Settings**, choose the detected AI editor, and click **Install / Sync Plugin**.
3. Open the project in Codex, confirm **ContextOS** appears in the installed plugin list, and start working.

The desktop App supports macOS 14 or later. The MCP runtime uses Node.js 22 or later. The App writes the editor configuration and plugin entry for you.

![One-click editor and MCP synchronization](assets/settings-sync.png)

### Other operating systems

Install the ContextOS plugin / MCP entry in the AI editor you use. The repository also provides a headless CLI:

```bash
npx -y github:yubinbin32-ops/ContextOS init --scan
npx -y github:yubinbin32-ops/ContextOS setup
```

Use `serve` as the MCP command when your editor asks for a server. After installation, `status` and `sync` show whether the project memory is connected.

## A normal conversation

Installation is a one-time step. These examples cover the usual entry points:

- **Starting an existing project:** Write the project architecture to OS.
- **Continuing across conversations:** Check OS and assess the current progress.
- **Development documentation:** Write this development document to OS, then begin the implementation.

Describe the feature, fix, review, or design in the same way you would with a teammate. At the end of a task, the agent records source locations, command receipts, verification, and the next action in project memory.

![The App's project map and detail drawer](assets/readme-reader.png)

## Reproducible benchmark

The measurements below were run on September 12, 2026 against an isolated graph revision 1052 snapshot. They measure service responses and JavaScript UTF-16 characters, showing the content boundary returned to the AI.

| Measurement | Result |
|---|---:|
| Full graph reference | 902,651 characters |
| Task context budget | 4,000 characters |
| Context reduction | **99.56%** (902,651 → 4,000) |
| Four complete source files → locator stream | **99.09%** (226,522 → 2,071) |
| Fixed synthetic build log | **91.78%** (10,071 → 828), with the error and failure retained |
| Context query samples | 12 local calls |
| Query latency p50 / p95 | **896.97 ms / 960.26 ms** |

Each of the four task queries returned the expected Block and visible locator within the 4,000-character budget:

| Query | Expected Block | Latencies (ms) | Reduction |
|---|---|---:|---:|
| OpenCode platform support and MCP injection | `in-app-plugin-install` | 944.04 · 896.06 · 901.90 | 99.56% |
| Git Discard and SQLite hot reload | `sqlite-graph-store` | 915.15 · 894.62 · 896.94 | 99.56% |
| CJK tokenization and BM25 weighted search | `context-retrieval` | 942.46 · 960.26 · 896.97 | 99.56% |
| SourceBinding path and symbol synchronization | `live-binding-refresh` | 927.23 · 895.67 · 895.24 | 99.56% |

The Chain measurement used `chain-context-os` and returned four anchored locators: `ast-facade-engine/extractSymbols`, `progressive-materializer/addSourceRef`, `terminal-sanitizer/sanitizeTerminalOutput`, and `desktop-context-console/chainCodeStreamSection`. The full raw data is in [`docs/benchmarks/2026-09-12-v040.json`](docs/benchmarks/2026-09-12-v040.json).

In daily use, context compaction feels roughly 60% less frequent.

The benchmark records service responses, character reduction, and local call latency. Full graph size, full-file size, MCP tool descriptions, skills, follow-up source reads, model tokens, cost, and task success are separate observation dimensions. The 12 calls cover both first reads and warm reads, so the latency values are useful for version-to-version comparison.

Run the measurement again after changing the service or graph:

```bash
npm run benchmark -- --output docs/benchmarks/2026-09-12-v040.json
```

## For contributors

```bash
git clone https://github.com/yubinbin32-ops/ContextOS.git
cd ContextOS
npm ci
npm test
npm run plugin:verify
npm run desktop:build       # macOS + Swift/Xcode
```

The versioned `.contextos/graph.json` is the project's portable graph projection. Internal proposals, audits, and guides belong in OS Documents; benchmark JSON and public README files remain repository artifacts.

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT License](LICENSE)
