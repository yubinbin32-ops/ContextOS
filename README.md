<div align="center">
  <img src="assets/logo.png" width="76" alt="ContextOS" />
  <h1>ContextOS · Context Operating System for AI Coding Agents</h1>
  <p><strong>Governing AI coding context via compiler-grade AST surgical tools, Metro Map architecture topology, and deterministic C-D-C-S state machines.</strong></p>
  <p><a href="https://github.com/yubinbin32-ops/ContextOS/releases/latest"><strong>Download macOS Desktop App</strong></a> · <a href="#start-in-three-minutes">Start in three minutes</a> · <a href="README_zh.md">中文说明</a></p>
</div>

![ContextOS Interactive Workflow Demo](assets/contextos-demo.gif)

## What problem does ContextOS solve?

An AI coding conversation often starts by rebuilding the project map: reading files, finding module relationships, checking design decisions, and locating unfinished work. As the repository grows, architecture notes, progress updates, and build logs compete with the task itself for context space.

ContextOS stores that working memory beside the code in one synchronized OS graph. Each conversation receives the architecture and progress relevant to its task, and the Native Desktop App visualizes the exact same state as an intuitive Metro Map. A new conversation can continue seamlessly from the recorded state.

![ContextOS V2 Metro Map Architecture and Desktop App](docs/images/contextos-desktop-v2.png)

## What changes in daily development?

### 1. Architecture becomes a Metro Map
Blocks describe real, verified code modules (zero ghost blocks allowed). Chains represent horizontal subway rails, and typed Links connect transfer stations orthogonally. The agent understands the big picture without touching the code.

![Feature Path with Exact Code Locations](assets/path-impact.png)

### 2. Progress follows the C-D-C-S lifecycle
Work flows strictly through **Create → Develop → Check → Sync**. Tasks carry an explicit context slice, intermediate development notes, and sandboxed test checks, completing with an atomic sync that enforces a 100% workspace code coverage gate.

### 3. Commands run out-of-context
`run_command` strips ANSI noise, redacts secrets, saves full raw logs into `.contextos/logs/`, and returns a compact receipt with critical error diagnostics, reducing terminal noise by over 98%.

### 4. Code tools operate surgically
Multi-language AST engines (compiler-grade parsing for JS/TS/JSX/TSX, Python, Swift, Java, Kotlin, C/C++, C#, Go, Rust, PHP, Ruby) allow VS Code-style symbol search, outline inspection, and surgical reading/editing with automatic symbol re-anchoring.

### 5. Unified Knowledge & Architectural Decisions
Proposals, audits, architectural decisions, and rules live as OS Documents. `README.md` and `README_zh.md` appear read-only in the App Knowledge view with images and links intact.

![OS Documents and README in the Knowledge Drawer](assets/knowledge-reader.png)

### 6. Long-running processes are monitored live
Dev servers, watchers, and background workers are managed by the Process Host and displayed in the Desktop App's bottom-left sidebar with live PID and port tracking.

![Station Detail and Drawer Inspection](assets/readme-reader.png)

## Start in three minutes

### macOS App

1. [Download the latest App](https://github.com/yubinbin32-ops/ContextOS/releases/latest), unzip it, and open **ContextOS**.
2. Open **Settings**, choose the detected AI editor (Cursor / Claude Desktop / Antigravity / Windsurf, etc.), and click **Install / Sync Plugin**.
3. Open your project in the editor and verify the plugin is active.
4. During your AI conversation, simply activate ContextOS with a single sentence (e.g., **"把这个方案写入os后开始执行"** / *"Write this proposal into the OS and start execution"*, or **"查看os继续开发"** / *"Inspect the OS and resume development"*). The AI will automatically leverage ContextOS for progressive context budgeting, C-D-C-S tasks, surgical code tools, and receipt verification.

The desktop App supports macOS 14 or later. The MCP runtime uses Node.js 22 or later. The App writes the editor configuration and plugin entry for you.

![One-click editor and MCP synchronization](assets/settings-sync.png)

## Reproducible V2 Benchmark

The measurements below were verified on the self-adopted ContextOS V2 repository (18 Blocks, 3 Chains, 18 Links, 49 files, 100% coverage).

| Development Phase | Traditional AI Workflow | ContextOS V2 Workflow | Reduction Rate |
|---|---|---|---:|
| **Session Bootstrap (Ingestion)** | Read full graph & repo files (61,902 chars / ~15,476 tokens) | Progressive L0-L1 Markdown (1,987 chars / ~497 tokens) | **96.79%** |
| **Code Structure Exploration** | Full file inspections (34,045 chars / ~8,512 tokens) | AST Symbol Outlines (4,374 chars / ~1,093 tokens) | **87.15%** |
| **Code Reading & Inspection** | Full file reads across 4 modules (34,045 chars) | Surgical Method Extraction (6,898 chars) | **79.74%** |
| **Terminal & Test Noise** | Raw build & test logs (16,713 chars / ~4,179 tokens) | Compact Receipt + Diagnostics (251 chars / ~63 tokens) | **98.50%** |
| **Cumulative Session Total** | **129,373 chars (~32,344 tokens)** | **13,761 chars (~3,441 tokens)** | **89.36% (~28,903 tokens saved)** |

Run the benchmarks locally:

```bash
node scripts/benchmark.mjs
node scripts/practical-test.mjs
node scripts/e2e-project-lifecycle.mjs
node scripts/comprehensive-dev-eval.mjs
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

The versioned `.contextos/graph.json` is the project's portable graph projection.

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT License](LICENSE)
