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
const EXPECTED_TOOLS = ["contextos"];
const transport = new StdioClientTransport({
  command: "node",
  args: ["plugins/contextos/server/contextos-mcp.mjs"],
  cwd: projectRoot,
  env: { ...process.env, CONTEXTOS_TEXT_ONLY_RESULTS: "1" },
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
// Skills are single self-contained files: the tool index and setup guide must be
// inside SKILL.md, because installed hosts load only the skill body and never
// resolve sibling reference files.
for (const relative of ["plugins/contextos/skills/contextos-ops/SKILL.md"]) {
  assert.ok(fs.existsSync(relative), `Skill is missing: ${relative}`);
}
for (const required of ["## Tool index", "ops({capability", "pipeline(", "integrate", "onboard"]) {
  assert.ok(skillText.includes(required), `ContextOS skill lost required guidance: ${required}`);
}
const opsSkillText = fs.readFileSync("plugins/contextos/skills/contextos-ops/SKILL.md", "utf8");
assert.ok(opsSkillText.includes("Full setup and switching guide"), "Ops skill must be self-contained");
assert.ok(opsSkillText.includes("Common errors and fixes"), "Ops skill must carry setup troubleshooting");

try {
  await client.connect(transport);
  const listing = await client.listTools();
  const names = listing.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [...EXPECTED_TOOLS].sort(), "bundled server must expose exactly the V3 tools");
  const transportTool = listing.tools.find((tool) => tool.name === "contextos");
  assert.match(JSON.stringify(transportTool?.inputSchema), /ask \| command \| agent \| change/);
  assert.match(transportTool?.description || "", /ops\(\{capability,action,args\}\)/);

  // Every capability is reachable through the single transport tool. This
  // helper keeps the smoke readable while exercising the real public surface.
  const call = async (name, args) => {
    const res = await client.callTool({
      name: "contextos",
      arguments: { action: name, args: { ...args }, projectRoot: fixture.root },
    });
    assert.ok(!res.isError, `${name} failed`);
    return (res.content || []).map((chunk) => chunk.text ?? "").join("\n");
  };

  const pipelined = await call("pipeline", {
    steps: [{ command: { command: "node --version", focus: "version" } }],
  });
  assert.match(pipelined, /pipeline=OK/);

  const envProbe = `${JSON.stringify(process.execPath)} -e "if(process.env.CONTEXTOS_TEXT_ONLY_RESULTS)process.exit(3);console.log('clean')"`;
  const pipelinedEnv = await call("pipeline", {
    steps: [{ command: { command: envProbe, focus: "clean" } }],
  });
  assert.match(pipelinedEnv, /pipeline=OK/);

  // 1. explore
  const explored = await call("explore", { intent: "了解 src/math.mjs" });
  assert.match(explored, /# ContextOS explore/);

  // 2. change
  await call("change", {
    edits: [{ path: "src/strings.mjs", target: "return `hello ${name}`;", replacement: "return `hi ${name}`;" }],
  });
  assert.match(fixture.read("src/strings.mjs"), /hi \$\{name\}/, "surgical edit must land on disk");

  fixture.write("src/obsolete.mjs", "export const obsolete = true;\n");
  const deleted = await call("change", {
    delete: [{ path: "src/obsolete.mjs" }],
  });
  assert.equal(fs.existsSync(path.join(fixture.root, "src", "obsolete.mjs")), false, "bundled delete must land on disk");
  assert.match(deleted, /deleted `src\/obsolete\.mjs`/);

  // 3. verify + sanitization of a leaked secret
  const retryCommand = `node -e "const fs=require('node:fs');if(!fs.existsSync('verify.ok')){console.error('error: failed with token ghp_123456789012345678901234567890123456');process.exit(1)}"`;
  const runText = await call("verify", {
    commands: [retryCommand],
  });
  assert.ok(!runText.includes("ghp_123456789012345678901234567890123456"), "command gateway leaked secret");
  assert.ok(runText.includes("[REDACTED_GITHUB_TOKEN]"), "secret not redacted");

  // 4. ship requires passing evidence, then closes the session
  const blockedShip = await call("ship", { summary: "greet() wording" });
  assert.match(blockedShip, /BLOCKED \(verification evidence\)/);
  fixture.write("verify.ok", "ready\n");
  const passingVerify = await call("verify", { commands: [retryCommand] });
  assert.match(passingVerify, /Verdict: PASS/);
  const shipped = await call("ship", { summary: "greet() wording" });
  assert.match(shipped, /Closure/);
  const blocksAfterShip = JSON.parse(await call("ops", {
    capability: "block",
    action: "list",
    args: { format: "json" },
  }));
  assert.ok(
    !blocksAfterShip.items.some((block) => String(block.id || "").startsWith("mod-") || block.kind === "module"),
    "ship must not turn ModuleIndex navigation hints into semantic module Blocks"
  );

  // 5. ops passthrough keeps every legacy capability reachable
  const rules = await call("ops", { capability: "knowledge", action: "rule_list" });
  assert.ok(!rules.includes("isError"), "ops knowledge rule_list failed");
  const blocks = await call("ops", { capability: "block", action: "list", args: { format: "json" } });
  assert.ok(blocks.length > 0, "ops block list returned nothing");

  // 6. the single surface forwards object verify commands to the runner
  const leanResult = await client.callTool({
    name: "contextos",
    arguments: {
      action: "change",
      args: {
        create: [{ path: "src/lean-verify.mjs", content: "export const verified = true;\n" }],
        verify: { commands: ["node --check src/lean-verify.mjs"] },
      },
      projectRoot: fixture.root,
    },
  });
  const leanText = (leanResult.content || []).map((chunk) => chunk.text ?? "").join("\n");
  assert.ok(!leanResult.isError, leanText);
  assert.match(leanText, /`node --check src\/lean-verify\.mjs`/);
  assert.match(leanText, /Verify: PASS/);
  assert.doesNotMatch(leanText, /- `` → exit/);

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
