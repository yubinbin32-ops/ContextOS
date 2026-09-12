import assert from "node:assert/strict";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = process.cwd();
const transport = new StdioClientTransport({
  command: "node",
  args: ["plugins/contextos/server/contextos-mcp.mjs"],
  cwd: projectRoot,
});
const client = new Client({ name: "contextos-plugin-smoke", version: "0.4.0" });
const packageVersion = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const pluginVersion = JSON.parse(fs.readFileSync("plugins/contextos/.codex-plugin/plugin.json", "utf8")).version;
const appVersion = fs.readFileSync("apps/desktop/Resources/Info.plist", "utf8").match(/CFBundleShortVersionString<\/key>\s*<string>([^<]+)/)?.[1];
assert.equal(packageVersion, pluginVersion, "package and plugin versions must match");
assert.equal(packageVersion, appVersion, "package and desktop app versions must match");

try {
  await client.connect(transport);
  const listing = await client.listTools();
  const names = new Set(listing.tools.map((tool) => tool.name));
  for (const required of ["context_for_task", "chain_code_stream", "chain_reconcile", "block_code_stream", "architecture_link_suggest", "architecture_connect", "chain_append", "plan_append_changes", "plan_append_chain_scope", "source_sync", "run_command", "log_sanitize", "document_list", "document_open", "task_begin", "task_scope", "task_reconcile", "task_finish", "runtime_info"]) {
    assert.ok(names.has(required), `missing MCP tool: ${required}`);
  }

  const runtime = await client.callTool({name:"runtime_info",arguments:{projectRoot,includeStructured:true}});
  assert.ok(!runtime.isError);assert.match(JSON.stringify(runtime),/0\.4\.0/);
  const documents = await client.callTool({name:"document_list",arguments:{projectRoot}});
  assert.ok(!documents.isError);assert.match(JSON.stringify(documents),/documents/);
  const chainTool = listing.tools.find((tool) => tool.name === "chain_code_stream");
  assert.ok(!listing.tools.some((tool) => tool.name === "block_code_mutate"), "block_code_mutate must be removed");
  assert.ok(listing.tools.find((tool) => tool.name === "changes_since").inputSchema.properties.sourceSyncRevision, "changes_since must expose sourceSyncRevision");
  assert.ok(listing.tools.find((tool) => tool.name === "context_for_task").inputSchema.properties.budgetChars, "context_for_task must expose budgetChars");
  const contextResult = await client.callTool({
    name: "context_for_task",
    arguments: { projectRoot, task: "plugin smoke budget", maxChars: 1000, budgetChars: 4000 },
  });
  const contextText = contextResult.content?.map((item) => item.text ?? "").join("\n") ?? "";
  const taskContextId = contextText.match(/Context ID: (task_[0-9a-f-]{36})/)?.[1];
  assert.ok(taskContextId, "context_for_task must return a taskContextId");
  for (const redundant of ["Unplanned:", "Checkpoint-free Blocks", "Uncovered direct Blocks", "Outside this Plan"]) {
    assert.ok(!contextText.includes(redundant), `context_for_task leaked redundant label: ${redundant}`);
  }
  const focusedChain = await client.callTool({
    name: "chain_code_stream",
    arguments: {
      projectRoot,
      chainId: "chain-mcp-modular-architecture",
      taskContextId,
      maxTotalChars: 1000,
    },
  });
  assert.ok(focusedChain.content?.some((item) => typeof item.text === "string"), "focused Chain read failed");
  const chainReconcile = await client.callTool({
    name: "chain_reconcile",
    arguments: { projectRoot, chainId: "chain-mcp-modular-architecture", autoReorder: true, includeStructured: true },
  });
  assert.ok(!chainReconcile.isError, "Chain topology reconciliation failed");
  const focusedBlock = await client.callTool({
    name: "block_code_stream",
    arguments: {
      projectRoot,
      blockId: "ast-facade-engine",
      mode: "slice",
      maxChars: 1200,
      maxLines: 24,
      includeStructured: true,
    },
  });
  assert.ok(focusedBlock.content?.some((item) => typeof item.text === "string" && item.text.includes("AST slice")), "AST Block slice failed");
  const focusedBlockData = focusedBlock.structuredContent?.data ?? focusedBlock.structuredContent;
  assert.equal(focusedBlockData?.containingFileReturned, false, "Block slice must not return the containing file");
  const planContext = await client.callTool({
    name: "plan_context",
    arguments: { projectRoot, id: "knowledge-sync-delivery", maxChars: 2000 },
  });
  assert.ok(planContext.content?.some((item) => typeof item.text === "string" && item.text.includes("统一知识阅读与同步闭环交付")), "Plan context failed");
  const suggestions = await client.callTool({
    name: "architecture_link_suggest",
    arguments: { projectRoot, blockId: "ast-facade-engine", includeStructured: true },
  });
  assert.ok(!suggestions.isError, "architecture link suggestion failed");
  assert.equal(listing.tools.find((tool) => tool.name === "chain_append").inputSchema.properties.expectedRevision.type, "integer");
  assert.equal(listing.tools.find((tool) => tool.name === "plan_append_changes").inputSchema.properties.planId.type, "string");
  const graphMutateActions = listing.tools.find((tool) => tool.name === "graph_mutate").inputSchema.properties.operations.items.properties.action.enum;
  for (const action of ["append_plan_changes", "update_plan_changes", "append_chain_path"]) {
    assert.ok(graphMutateActions.includes(action), `graph_mutate must expose ${action}`);
  }
  const sourceSync = await client.callTool({
    name: "source_sync",
    arguments: { projectRoot, taskContextId, includeUnchanged: false },
  });
  assert.ok(sourceSync.content?.some((item) => typeof item.text === "string"), "source_sync failed");
  const runResult = await client.callTool({
    name: "run_command",
    arguments: {
      projectRoot,
      command: `printf 'OPENAI_API_KEY=sk-plugin-smoke\\n%s\\n' "$PWD"`,
      maxChars: 500,
    },
  });
  const rendered = runResult.content?.map((item) => item.text ?? "").join("\n") ?? "";
  assert.ok(!rendered.includes("sk-plugin-smoke"), "run_command leaked a credential");
  assert.ok(!rendered.includes(projectRoot), "run_command leaked the project path");
  assert.match(rendered, /\[REDACTED\]/);

  console.log(`# contextos plugin smoke\n- MCP tools: ${names.size}\n- Contract-first Chain stream: exposed\n- AST-bounded Block stream: passed\n- Plan/Chain append surfaces: exposed\n- Architecture link review: passed\n- Source binding sync: exposed\n- Sanitized command gateway: passed\n- Version contract: ${packageVersion}`);
  console.log(`- Shared task budget: exposed (${taskContextId})`);
} finally {
  await client.close();
  await transport.close();
}
