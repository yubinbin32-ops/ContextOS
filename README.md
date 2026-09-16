<div align="center">
  <img src="assets/logo.png" width="76" alt="ContextOS" />
  <h1>A High-Precision Powered Exoskeleton for AI Coding</h1>
  <p><strong>Auto-governing context via MCP, reducing context window waste by 90%+ in practice.</strong></p>
  <p>Stopping context window explosion and hallucination in large codebases: surgical AST read/write instead of dumping whole files, out-of-context command receipts, and an intuitive Metro Map architecture.</p>
  <p><a href="https://github.com/yubinbin32-ops/ContextOS/releases/latest"><strong>Download macOS Desktop App</strong></a> · <a href="#start-in-three-minutes">Start in three minutes</a> · <a href="README_zh.md">中文文档</a></p>
  <p>
    <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/yubinbin32-ops/ContextOS/tree/main" target="_blank">
      <img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare Workers" />
    </a>
  </p>
</div>

![ContextOS Interactive Workflow Demo](assets/contextos-demo.gif)

## What problem does ContextOS solve?

**ContextOS acts as a high-precision powered exoskeleton for AI coding assistants**:
In traditional workflows with large repositories, an AI agent is forced to haul massive raw files, noisy build dumps, and repetitive documentation in its prompt. It quickly runs out of breath — the context window explodes, hallucinations multiply, and previous design decisions are forgotten.

With ContextOS, the AI sheds the deadweight and lets the **MCP protocol auto-govern context**:
1. **Exoskeleton-Powered Precision**: Compiler-grade AST tools surgically inspect and edit only the relevant symbols and syntax blocks, eliminating whole-file dumps;
2. **Out-of-Context Isolation**: Terminal logs are safely captured to a sandboxed disk store, returning compact diagnostic receipts to strip 98%+ of terminal noise;
3. **Unified Neural Metro Map**: Architectural memory and the C-D-C-S task lifecycle are synchronized in a visual subway map, giving the AI immediate full-picture clarity.

**In real-world multi-step tasks, ContextOS reduces redundant context consumption by over 90%**, eliminating context explosion and memory loss across long-running sessions.

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

ContextOS provides flexible setup options tailored to your environment:

### Option 1: macOS Desktop App (Visual Architecture & One-Click Setup)

Download the package matching your environment from [GitHub Releases](https://github.com/yubinbin32-ops/ContextOS/releases/latest):

| Package | File | Size | Node.js Requirement | Best For |
|---|---|---|---|---|
| **Full Standalone** *(Recommended)* | `ContextOS-macos-full.zip` | ~35 MB | **None** (Bundles standalone Node 22) | Zero-setup, plug-and-play. Ideal if you don't have Node installed. |
| **Standard Lite** | `ContextOS-macos.zip` | ~1.6 MB | Requires Node.js 22+ on system | Ultra-compact download if you already have Node installed. |

#### Setup Steps:
1. Unzip the downloaded file and drag **ContextOS.app** into `/Applications`.
2. Launch **ContextOS**, open **Settings** (gear icon or `Cmd+,`), select your detected AI editor (Cursor / Claude Desktop / Antigravity / OpenCode / Codex), and click **Install / Sync Plugin**.
3. The App configures your editor to connect to ContextOS MCP. **Once configured, you can close the desktop App; it does NOT need to stay running in the background.**
4. In your AI coding chat, activate ContextOS with a simple prompt:
   > *"Write this proposal into ContextOS and start execution"* or *"Inspect ContextOS and resume development"*

   The AI agent will immediately follow the C-D-C-S task lifecycle, perform surgical AST code reads/writes, generate compact command receipts, and safely clean up long-running background processes.

![One-click editor and MCP synchronization](assets/settings-sync.png)

### Option 2: Lightweight Pure Plugin Stream (For Headless, Linux, or CLI-Only Workflows)

> [!NOTE]
> **Best for remote servers, Docker containers, or purely terminal-driven setups without a macOS desktop GUI.**
> The plugin package is extremely lightweight and runs directly via `npx` or as an editor plugin.
> **Prerequisites**: Node.js 22 or later installed on the host machine.

```bash
# Launch MCP server directly from command line
npx -y github:yubinbin32-ops/ContextOS
```

### Option 3: Deploy ContextOS Cloud Hub (Serverless on Cloudflare)

> [!TIP]
> **Best for multi-device sync, remote teams, and cloud-hosted architecture graphs.**
> Deploy your private ContextOS Cloud Hub in under 60 seconds using Cloudflare Workers and D1 SQLite.

1. Click the **Deploy to Cloudflare Workers** button above (or fork this repo).
2. Follow Cloudflare's prompts to deploy the serverless hub to your Cloudflare account.
3. Once deployed, get your live Cloud Hub URL (e.g. `https://contextos-cloud.<user>.workers.dev`).
4. **Connect your Local MCP**:
   ```bash
   export CONTEXTOS_MODE="cloud"
   export CONTEXTOS_CLOUD_URL="https://contextos-cloud.<user>.workers.dev"
   export CONTEXTOS_PROJECT_ID="my-project"
   ```
5. **Connect Desktop App**: In ContextOS Desktop, open the top-left menu, choose **Connect Cloud MCP Project…**, and enter your Cloud Hub URL!

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
