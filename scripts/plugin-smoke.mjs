/**
 * Plugin smoke test: runs the shipped bundle (plugins/contextos/server/contextos-mcp.mjs)
 * over stdio against a throwaway project and verifies the V3 intent surface,
 * command sanitization, the `ops` passthrough and version alignment.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createFixtureProject } from "./fixture-project.mjs";
import { packageVersion } from "./version.mjs";

const projectRoot = process.cwd();
const EXPECTED_TOOLS = ["explore", "inspect", "change", "verify", "ship", "ops", "pipeline"];
const transport = new StdioClientTransport({
  command: "node",
  args: ["plugins/contextos/server/contextos-mcp.mjs"],
  cwd: projectRoot,
});
const client = new Client({ name: "contextos-plugin-smoke", version: packageVersion });
const fixture = createFixtureProject({ prefix: "ctxos-plugin" });

const pluginVersion = JSON.parse(fs.readFileSync("plugins/contextos/.codex-plugin/plugin.json", "utf8")).version;
assert.equal(packageVersion, pluginVersion, "package and plugin versions must match");
assert.ok(
  fs.readFileSync("apps/desktop/Resources/Info.plist", "utf8").includes("<string>$(MARKETING_VERSION)</string>"),
  "desktop app version must be injected from package.json"
);

const skillPath = path.join("plugins", "contextos", "skills", "contextos", "SKILL.md");
assert.ok(fs.existsSync(skillPath), "ContextOS Skill is missing");
const skillText = fs.readFileSync(skillPath, "utf8");
assert.ok(skillText.includes("意图级开发入口"), "Skill must document the intent-level entry");
for (const tool of EXPECTED_TOOLS) {
  assert.ok(skillText.includes(`\`${tool}\``), `Skill must document the ${tool} tool`);
}
assert.ok(skillText.includes("ops({ capability"), "Skill must document the ops passthrough");
assert.ok(skillText.length < 12000, `Skill must stay lean for context budgets (got ${skillText.length} chars)`);

try {
  await client.connect(transport);
  const listing = await client.listTools();
  const names = listing.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [...EXPECTED_TOOLS].sort(), "bundled server must expose exactly the V3 tools");

  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: { projectRoot: fixture.root, ...args } });
    assert.ok(!res.isError, `${name} failed`);
    return (res.content || []).map((chunk) => chunk.text ?? "").join("\n");
  };

  // 1. explore
  const explored = await call("explore", { intent: "了解 src/math.mjs" });
  assert.match(explored, /# ContextOS explore/);

  // 2. change
  await call("change", {
    edits: [{ path: "src/strings.mjs", target: "return `hello ${name}`;", replacement: "return `hi ${name}`;" }],
  });
  assert.match(fixture.read("src/strings.mjs"), /hi \$\{name\}/, "surgical edit must land on disk");

  // 3. verify + sanitization of a leaked secret
  const runText = await call("verify", {
    commands: ['echo "error: failed with token ghp_123456789012345678901234567890123456" && exit 1'],
  });
  assert.ok(!runText.includes("ghp_123456789012345678901234567890123456"), "command gateway leaked secret");
  assert.ok(runText.includes("[REDACTED_GITHUB_TOKEN]"), "secret not redacted");

  // 4. ship closes the session
  const shipped = await call("ship", { summary: "greet() wording" });
  assert.match(shipped, /Closure/);

  // 5. ops passthrough keeps every legacy capability reachable
  const rules = await call("ops", { capability: "knowledge", action: "rule_list" });
  assert.ok(!rules.includes("isError"), "ops knowledge rule_list failed");
  const blocks = await call("ops", { capability: "block", action: "list", args: { format: "json" } });
  assert.ok(blocks.length > 0, "ops block list returned nothing");

  console.log("# ContextOS Plugin Smoke Verification Passed!");
  console.log(`- MCP tools: ${names.length} (${names.join(", ")})`);
  console.log(`- Version alignment: ${packageVersion}`);
  console.log("- Command gateway sanitization: verified");
  console.log("- Knowledge & architecture graph: verified via ops passthrough");
} finally {
  await client.close();
  await transport.close();
  fixture.cleanup();
}
