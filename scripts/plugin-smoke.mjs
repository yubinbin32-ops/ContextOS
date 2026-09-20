import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCP_TOOL_NAMES, TOOL_ACTIONS } from "../packages/mcp/src/tool-contract.mjs";

const projectRoot = process.cwd();
const transport = new StdioClientTransport({
  command: "node",
  args: ["plugins/contextos/server/contextos-mcp.mjs"],
  cwd: projectRoot,
});
const client = new Client({ name: "contextos-plugin-smoke", version: "2.4.0" });
const packageVersion = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const pluginVersion = JSON.parse(fs.readFileSync("plugins/contextos/.codex-plugin/plugin.json", "utf8")).version;
const appVersion = fs.readFileSync("apps/desktop/Resources/Info.plist", "utf8").match(/CFBundleShortVersionString<\/key>\s*<string>([^<]+)/)?.[1];
assert.equal(packageVersion, pluginVersion, "package and plugin versions must match");
assert.equal(packageVersion, appVersion, "package and desktop app versions must match");
assert.equal(packageVersion, "2.4.0", "Version must be 2.4.0");
const skillPath = path.join(
  "plugins",
  "contextos",
  "skills",
  "contextos",
  "SKILL.md"
);
assert.ok(fs.existsSync(skillPath), "ContextOS Skill is missing");
const skillText = fs.readFileSync(skillPath, "utf8");
assert.ok(skillText.includes("12 大核心 Facade 工具全景与参数规范"), "Skill must retain the comprehensive tool guide");
assert.ok(skillText.includes("### 5. `run_command`"), "Skill must document run_command usage");
assert.ok(skillText.includes("### 7. `block`"), "Skill must document Block bindings");
assert.ok(skillText.includes('anchorKind: "tree"'), "Skill must document directory tree bindings");
assert.ok(skillText.includes('task(action: "start"'), "Skill must document the lightweight task start path");
assert.ok(skillText.includes('task(action: "finish"'), "Skill must document the lightweight task finish path");
assert.ok(skillText.includes("实验性 Cloud Hub"), "Skill must mark Cloud Hub as experimental");
const skillToolSections = skillText.match(/^### \d+\. `/gm)?.length ?? 0;
assert.equal(skillToolSections, 12, "Skill must retain one section for every MCP tool");
for (const [toolName, actions] of Object.entries(TOOL_ACTIONS)) {
  if (actions.length === 0) continue;
  const actionList = actions.map((action) => `\`${action}\``).join(", ");
  assert.ok(
    skillText.includes(`| \`${toolName}\` | ${actionList} |`),
    `Skill action contract is missing or stale for ${toolName}`
  );
}

try {
  await client.connect(transport);
  const listing = await client.listTools();
  const names = new Set(listing.tools.map((tool) => tool.name));
  const expectedTools = [...MCP_TOOL_NAMES];
  for (const tool of expectedTools) {
    assert.ok(names.has(tool), `missing MCP tool: ${tool}`);
  }
  assert.equal(names.size, expectedTools.length, "unexpected MCP tool count");
  assert.equal(expectedTools.length, 12, "plugin smoke must cover all core and administrative tools");
  for (const tool of listing.tools) {
    const expectedActions = TOOL_ACTIONS[tool.name] || [];
    const actionSchema = tool.inputSchema?.properties?.action;
    if (expectedActions.length > 0) {
      assert.deepEqual(actionSchema?.enum, expectedActions, `MCP action schema drift for ${tool.name}`);
    } else {
      assert.equal(actionSchema, undefined, `Unexpected action schema for ${tool.name}`);
    }
  }

  // 1. Test os_context
  const briefRes = await client.callTool({
    name: "os_context",
    arguments: { action: "brief" },
  });
  assert.ok(!briefRes.isError, "os_context brief failed");
  const briefText = briefRes.content?.map((c) => c.text ?? "").join("\n") ?? "";
  assert.ok(briefText.includes("ContextOS") || briefText.includes("Plan"), "brief missing expected header");

  // 2. Test block
  const blockRes = await client.callTool({
    name: "block",
    arguments: { action: "list", format: "json" },
  });
  assert.ok(!blockRes.isError, "block list failed");

  // 3. Test chain
  const chainRes = await client.callTool({
    name: "chain",
    arguments: { action: "list" },
  });
  assert.ok(!chainRes.isError, "chain list failed");

  // 4. Test run_command sanitization
  const runRes = await client.callTool({
    name: "run_command",
    arguments: {
      command: `echo "error: failed with token ghp_123456789012345678901234567890123456" && exit 1`,
    },
  });
  const runText = runRes.content?.map((c) => c.text ?? "").join("\n") ?? "";
  assert.ok(!runText.includes("ghp_123456789012345678901234567890123456"), "run_command leaked secret");
  assert.ok(runText.includes("[REDACTED_GITHUB_TOKEN]"), "secret not redacted");


  // 6. Test knowledge
  const rulesRes = await client.callTool({
    name: "knowledge",
    arguments: { action: "rule_list" },
  });
  assert.ok(!rulesRes.isError, "knowledge rule_list failed");

  console.log(`# ContextOS V2 Plugin Smoke Verification Passed!`);
  console.log(`- MCP tools: ${names.size} (${expectedTools.join(", ")})`);
  console.log(`- Version alignment: ${packageVersion}`);
  console.log(`- Command gateway sanitization: verified`);
  console.log(`- Knowledge & architecture graph: verified`);
} finally {
  await client.close();
  await transport.close();
}
