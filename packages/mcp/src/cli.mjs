import { indexSources, reconcileTask } from "./reconciliation.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerProject, resolveProjectPaths } from "./paths.mjs";
import { exportGraphToJson, importGraphFromJson } from "./database.mjs";

const VERSION = "0.4.1";

const HELP = `
ContextOS v${VERSION}: A context operating system for AI coding agents.

Usage:
  contextos [command] [options]

Commands:
  serve                 Start MCP stdio server (default when invoked by AI editors)
  init [--scan]         Initialize .contextos project (optionally scan code to seed blocks)
  sync                  Reconcile source inventory and unfinished tasks
  status                Show graph revision, blocks, chains, and active plans
  code --path <file>    Read one bounded source range returned by a locator
  export                Export .contextos/graph.json from local SQLite cache
  import                Import .contextos/graph.json into local SQLite cache
  setup                 Configure MCP in Cursor, Claude Desktop, and VS Code

Options:
  -v, --version         Show version
  -h, --help            Show this help
`;

export async function runCli(args, router) {
  const command = args[0]?.toLowerCase();

  if (!command || command === "-h" || command === "--help" || command === "help") {
    console.log(HELP.trim());
    return;
  }

  if (command === "-v" || command === "--version" || command === "version") {
    console.log(`ContextOS v${VERSION}`);
    return;
  }

  if (command === "code" || command === "source") {
    const projectRoot = process.cwd();
    const value = (name) => {
      const index = args.findIndex((item) => item === name);
      return index >= 0 ? args[index + 1] : undefined;
    };
    const filePath = value("--path") ?? value("--file");
    const symbol = value("--symbol");
    const startLine = value("--start") ?? value("--start-line");
    const endLine = value("--end") ?? value("--end-line");
    const maxLines = value("--max-lines");
    const maxChars = value("--max-chars");
    const expectedHash = value("--hash");
    const asJson = args.includes("--json");
    try {
      if (!filePath) throw new Error("code requires --path <file>");
      if (!symbol && (!startLine || !endLine)) {
        throw new Error("code requires --symbol <name> or --start <line> --end <line>");
      }
      const service = router.serviceFor({ projectRoot, autoRegister: false });
      const result = service.readSourceSlice({
        filePath,
        symbol: symbol ?? null,
        startLine: startLine ? Number(startLine) : null,
        endLine: endLine ? Number(endLine) : null,
        maxLines: maxLines ? Number(maxLines) : 240,
        maxChars: maxChars ? Number(maxChars) : 12000,
        expectedHash: expectedHash ?? null,
      });
      if (asJson) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`# ${result.path}${result.symbol ? ` :: ${result.symbol}` : ""}`);
        console.log(`# Lines: ${result.startLine ?? "?"}-${result.endLine ?? "?"} · Status: ${result.status}${result.truncated ? " · truncated" : ""}`);
        if (result.reason) console.log(`# Note: ${result.reason}`);
        if (result.code) console.log(result.code);
      }
      if (!result.found) process.exitCode = 2;
    } catch (error) {
      console.error(`Code read failed: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "sync") {
    try {
      const service = router.serviceFor({ projectRoot: process.cwd(), autoRegister: false });
      const index = indexSources(service);
      const tasks = service.database.prepare("SELECT id FROM task_sessions WHERE status='active'").all();
      const results = tasks.map(t => reconcileTask(service, {taskId:t.id}));
      service.snapshot();
      console.log(JSON.stringify({revision:index.revision, changed:index.changes.length, unbound:index.unboundCount, tasks:results.map(r=>({taskId:r.taskId,status:r.status,issues:r.issues.length}))}));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
    return;
  }
  if (command === "status") {
    const projectRoot = process.cwd();
    try {
      const service = router.serviceFor({ projectRoot, autoRegister: false });
      const snap = service.snapshot();
      const timeline = service.getTimeline();
      console.log(`Project: ${snap.project.name} (${snap.project.id})`);
      console.log(`Graph Revision: ${snap.project.graphRevision}`);
      console.log(`Blocks: ${snap.blocks.length} | Chains: ${snap.chains.length} | Plans: ${snap.plans.length} | Checkpoints: ${snap.checkpoints.length}`);
      if (timeline?.activeCursor?.nowDoing) {
        console.log(`Timeline Focus: ${timeline.activeCursor.nowDoing}`);
        if (timeline.activeCursor.nextUp) {
          console.log(`Next Up: ${timeline.activeCursor.nextUp}`);
        }
      }
      const activePlans = snap.plans.filter((p) => p.status === "active");
      if (activePlans.length > 0) {
        console.log(`Active Plans (${activePlans.length}):`);
        for (const p of activePlans) {
          console.log(`  - [${p.id}] ${p.title} (${p.status})`);
        }
      }
      const statusReport = service.graphStatus();
      if (statusReport.drift?.hasDrift) {
        console.log(`\n⚠️  Architecture Drift Alerts:`);
        for (const g of statusReport.drift.ghostDrifts) {
          console.log(`  - 👻 Ghost with code: block:${g.blockId} (${g.path}) -> update deliveryState to complete`);
        }
        for (const b of statusReport.drift.isolatedBlocks) {
          console.log(`  - ⛓️  Isolated block: block:${b.id} -> connect to chain/link`);
        }
        for (const r of statusReport.drift.retestRequired) {
          console.log(`  - 🔄 Retest required: checkpoint:${r.id}`);
        }
      }
    } catch (err) {
      console.error(`Failed to read status: ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "init") {
    const projectRoot = process.cwd();
    const shouldScan = args.includes("--scan") || args.includes("-s");
    try {
      const reg = registerProject({ projectRoot, name: path.basename(projectRoot) });
      console.log(`✓ ${reg.created ? "Initialized new" : "Opened existing"} contextos project at ${projectRoot}`);
      
      const service = router.serviceFor({ projectRoot });
      if (shouldScan && reg.created) {
        console.log("Scanning repository structure to bootstrap initial architecture...");
        const bootstrapped = bootstrapProject(service, projectRoot);
        console.log(`✓ Created ${bootstrapped.blocks} initial blocks and 1 baseline chain.`);
      }

      // Ensure graph.json exists
      if (!fs.existsSync(service.paths.graphJsonPath)) {
        exportGraphToJson(service.database, service.paths.graphJsonPath);
        console.log(`✓ Created .contextos/graph.json text source of truth`);
      }
      console.log("\nReady! Launch the ContextOS Desktop App or connect your AI editor via MCP.");
    } catch (err) {
      console.error(`Failed to initialize project: ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "export") {
    const projectRoot = process.cwd();
    try {
      const service = router.serviceFor({ projectRoot });
      const res = exportGraphToJson(service.database, service.paths.graphJsonPath);
      console.log(`✓ Exported .contextos/graph.json (revision ${res.graphRevision}, hash: ${res.hash.slice(0, 12)})`);
    } catch (err) {
      console.error(`Export failed: ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "import") {
    const projectRoot = process.cwd();
    try {
      const service = router.serviceFor({ projectRoot });
      const res = importGraphFromJson(service.database, service.paths.graphJsonPath);
      console.log(`✓ Imported .contextos/graph.json (revision ${res.graphRevision}, hash: ${res.hash.slice(0, 12)})`);
    } catch (err) {
      console.error(`Import failed: ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "setup") {
    setupEditors();
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.log(HELP.trim());
  process.exitCode = 1;
}

function bootstrapProject(service, projectRoot) {
  const operations = [];
  const pkgPath = path.join(projectRoot, "package.json");
  let pkg = {};
  if (fs.existsSync(pkgPath)) {
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); } catch {}
  }

  const projectName = pkg.name || path.basename(projectRoot);
  const coreBlockId = "core-application";
  operations.push({
    action: "create_block",
    id: coreBlockId,
    fields: {
      title: `${projectName} Core`,
      summary: pkg.description || "Core application logic and entry points",
      kind: "service",
      architectureLayer: "application",
      scope: "general",
    },
  });

  // Check common directories
  const dirs = fs.readdirSync(projectRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
    .map((d) => d.name);

  if (dirs.some((d) => ["src", "app", "lib"].includes(d))) {
    operations.push({
      action: "create_block",
      id: "domain-services",
      fields: {
        title: "Domain Services",
        summary: "Business domain models, utilities, and core algorithms",
        kind: "service",
        architectureLayer: "domain",
        scope: "general",
      },
    });
  }

  if (dirs.some((d) => ["api", "routes", "controllers", "server"].includes(d)) || pkg.dependencies?.express || pkg.dependencies?.hono) {
    operations.push({
      action: "create_block",
      id: "api-boundary",
      fields: {
        title: "API Gateway & Endpoints",
        summary: "External API routing, validation, and serialization",
        kind: "service",
        architectureLayer: "boundary",
        scope: "general",
      },
    });
  }

  if (dirs.some((d) => ["test", "tests", "__tests__"].includes(d))) {
    operations.push({
      action: "create_block",
      id: "verification-suite",
      fields: {
        title: "Verification Suite",
        summary: "Automated unit, integration, and regression tests",
        kind: "test",
        architectureLayer: "quality",
        scope: "general",
      },
    });
  }

  // Create baseline chain if we have multiple blocks
  if (operations.length >= 2) {
    operations.push({
      action: "create_chain",
      id: "baseline-flow",
      fields: {
        title: "Main Request Pipeline",
        purpose: "architecture",
        intent: "End-to-end execution flow from entry point to domain core",
      },
    });
  }

  service.mutate({
    reason: "Bootstrap initial project architecture",
    operations,
  });

  return { blocks: operations.filter((op) => op.action === "create_block").length, chains: operations.some((op) => op.action === "create_chain") ? 1 : 0 };
}

function setupEditors() {
  const cwd = process.cwd();
  console.log("=== Setting up ContextOS MCP Server ===");

  // 1. Cursor Setup
  const cursorDir = path.join(cwd, ".cursor");
  const cursorMcpFile = path.join(cursorDir, "mcp.json");
  try {
    fs.mkdirSync(cursorDir, { recursive: true });
    let cursorConfig = { mcpServers: {} };
    if (fs.existsSync(cursorMcpFile)) {
      try { cursorConfig = JSON.parse(fs.readFileSync(cursorMcpFile, "utf8")); } catch {}
    }
    cursorConfig.mcpServers = cursorConfig.mcpServers || {};
    cursorConfig.mcpServers.contextos = {
      command: "npx",
      args: ["-y", "github:yubinbin32-ops/ContextOS", "serve"],
    };
    fs.writeFileSync(cursorMcpFile, JSON.stringify(cursorConfig, null, 2));
    console.log(`✓ Configured Cursor: ${cursorMcpFile}`);
  } catch (err) {
    console.log(`- Cursor setup skipped: ${err.message}`);
  }

  // 2. Claude Desktop Setup (macOS)
  const claudeConfigPath = path.join(os.homedir(), "Library/Application Support/Claude/claude_desktop_config.json");
  try {
    if (fs.existsSync(path.dirname(claudeConfigPath))) {
      let claudeConfig = { mcpServers: {} };
      if (fs.existsSync(claudeConfigPath)) {
        try { claudeConfig = JSON.parse(fs.readFileSync(claudeConfigPath, "utf8")); } catch {}
      }
      claudeConfig.mcpServers = claudeConfig.mcpServers || {};
      claudeConfig.mcpServers.contextos = {
        command: "npx",
        args: ["-y", "github:yubinbin32-ops/ContextOS", "serve"],
      };
      fs.writeFileSync(claudeConfigPath, JSON.stringify(claudeConfig, null, 2));
      console.log(`✓ Configured Claude Desktop: ${claudeConfigPath}`);
    }
  } catch (err) {
    console.log(`- Claude Desktop setup skipped: ${err.message}`);
  }

  console.log("\nMCP server configuration for other tools (Windsurf / VS Code / Roo Code):");
  console.log(JSON.stringify({
    contextos: {
      command: "npx",
      args: ["-y", "github:yubinbin32-ops/ContextOS", "serve"]
    }
  }, null, 2));
}
