import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createV3Server } from "../src/v3-server.mjs";
import { createFixtureProject } from "../../../scripts/fixture-project.mjs";

const EXPECTED_TOOLS = ["explore", "change", "verify", "ship", "ops"];

async function boot() {
  const server = createV3Server();
  const client = new Client({ name: "contextos-v3-test", version: "2.5.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test("V3 server entrypoint works through a symlinked path", { skip: process.platform === "win32" }, () => {
  const tempDir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "contextos-entry-"));
  const linkPath = path.join(tempDir, "contextos-mcp.mjs");
  const sourcePath = path.resolve("packages/mcp/src/v3-server.mjs");
  fs.symlinkSync(sourcePath, linkPath);

  const request = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "entrypoint-test", version: "1.0.0" },
    },
  });
  const result = spawnSync(process.execPath, [linkPath], {
    input: `${request}\n`,
    encoding: "utf8",
    timeout: 10000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\"protocolVersion\":\"2024-11-05\"/);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("V3 MCP surface exposes exactly the intent-level tools", async () => {
  const client = await boot();
  const listing = await client.listTools();
  const names = listing.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [...EXPECTED_TOOLS].sort());
  await client.close();
});

test("V3 rejects calls without an explicit projectRoot", async () => {
  const client = await boot();
  const res = await client.callTool({ name: "explore", arguments: { intent: "no workspace" } });
  assert.equal(res.isError, true);
  const text = (res.content || []).map((chunk) => chunk.text ?? "").join("\n");
  assert.match(text, /projectRoot|Invalid arguments/i);
  await client.close();
});

test("V3 ops block bind rejects Ghost Blocks", async () => {
  const fixture = createFixtureProject({ prefix: "ctxos-v3-ghost" });
  const client = await boot();
  const res = await client.callTool({
    name: "ops",
    arguments: {
      projectRoot: fixture.root,
      capability: "block",
      action: "bind",
      args: {
        id: "block-ghost",
        blockData: { title: "Ghost", artifactRefs: [] },
      },
    },
  });
  assert.equal(res.isError, true);
  const text = (res.content || []).map((chunk) => chunk.text ?? "").join("\n");
  assert.match(text, /Ghost Block rejected/);
  await client.close();
  fixture.cleanup();
});

test("V3 change preflights the whole changeset and never leaves a partial edit", async () => {
  const fixture = createFixtureProject({ prefix: "ctxos-v3-atomic" });
  const client = await boot();
  const before = fixture.read("src/math.mjs");

  const failed = await client.callTool({
    name: "change",
    arguments: {
      projectRoot: fixture.root,
      edits: [
        { path: "src/math.mjs", startLine: 1, endLine: 1, replacement: "export const changed = true;" },
        { path: "src/math.mjs", target: "this target does not exist", replacement: "never" },
      ],
    },
  });
  const failedText = (failed.content || []).map((chunk) => chunk.text ?? "").join("\n");
  assert.match(failedText, /changeset rejected|no files were modified/i);
  assert.equal(fixture.read("src/math.mjs"), before);

  const ranged = await client.callTool({
    name: "change",
    arguments: {
      projectRoot: fixture.root,
      edits: [{ path: "src/math.mjs", startLine: 1, endLine: 1, replacement: "export const ranged = true;" }],
    },
  });
  const rangedText = (ranged.content || []).map((chunk) => chunk.text ?? "").join("\n");
  assert.match(rangedText, /edited `src\/math\.mjs`/);
  assert.match(fixture.read("src/math.mjs"), /export const ranged = true;/);

  await client.close();
  fixture.cleanup();
});

test("V3 ops search, receipt logs, plan update, and optional Rules are usable end to end", async () => {
  const fixture = createFixtureProject({ prefix: "ctxos-v3-p5" });
  const client = await boot();
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: { projectRoot: fixture.root, ...args } });
    assert.ok(!res.isError, `${name} failed: ${(res.content || []).map((chunk) => chunk.text ?? "").join("\n")}`);
    return (res.content || []).map((chunk) => chunk.text ?? "").join("\n");
  };

  const ruleText = await call("ops", {
    capability: "knowledge",
    action: "rule_write",
    args: {
      ruleData: {
        id: "rule-optional-p5",
        title: "Optional Rule",
        category: "workflow",
        summary: "Only bind when relevant.",
        content: "Apply this rule when the task explicitly opts in.",
      },
    },
  });
  assert.match(ruleText, /rule-optional-p5/);

  const searchFile = JSON.parse(await call("ops", {
    capability: "code",
    action: "search",
    args: { query: "export", root: "src/math.mjs", format: "json" },
  }));
  assert.ok(searchFile.scannedFiles > 0, "file-root search must scan the requested file");
  assert.ok(searchFile.text.some((hit) => hit.path === "src/math.mjs"));

  const searchRoot = JSON.parse(await call("ops", {
    capability: "code",
    action: "search",
    args: { query: "export", root: ".", format: "json" },
  }));
  assert.ok(searchRoot.scannedFiles > 0, "root '.' search must scan the workspace");

  const plan = JSON.parse(await call("ops", {
    capability: "plan",
    action: "create",
    args: {
      id: "plan-p5-optional",
      format: "json",
      planData: {
        title: "P5 optional Rules",
        phases: [{
          id: "P0",
          order: 0,
          objective: "Exercise optional Rules through the MCP facade.",
          acceptance: ["Rules remain optional and traceable."],
          status: "active",
        }],
      },
    },
  }));
  assert.equal(plan.id, "plan-p5-optional");
  const updated = JSON.parse(await call("ops", {
    capability: "plan",
    action: "update",
    args: {
      id: "plan-p5-optional",
      format: "json",
      planData: { title: "P5 updated", ruleRefs: ["rule-optional-p5"] },
    },
  }));
  assert.equal(updated.title, "P5 updated");
  assert.deepEqual(updated.ruleRefs, ["rule-optional-p5"]);

  const task = JSON.parse(await call("ops", {
    capability: "task",
    action: "create",
    args: {
      format: "json",
      taskData: {
        id: "task-p5-optional",
        planId: "plan-p5-optional",
        phaseId: "P0",
        title: "P5 optional task",
        contextSlice: { objective: "preserve this" },
        rules: ["rule-optional-p5"],
      },
    },
  }));
  assert.deepEqual(task.rules, ["rule-optional-p5"]);
  const restarted = JSON.parse(await call("ops", {
    capability: "task",
    action: "start",
    args: { id: "task-p5-optional", taskData: {}, format: "json" },
  }));
  assert.equal(restarted.preserved, true);
  assert.equal(restarted.task.contextSlice.objective, "preserve this");
  assert.deepEqual(restarted.task.rules, ["rule-optional-p5"]);

  const unknownRule = await client.callTool({
    name: "ops",
    arguments: {
      projectRoot: fixture.root,
      capability: "task",
      action: "create",
      args: {
        taskData: {
          id: "task-p5-unknown",
          planId: "plan-p5-optional",
          phaseId: "P0",
          title: "Unknown Rule",
          rules: ["rule-does-not-exist"],
        },
      },
    },
  });
  assert.equal(unknownRule.isError, true);
  assert.match((unknownRule.content || []).map((chunk) => chunk.text ?? "").join("\n"), /Unknown Rule reference/);

  const verified = await call("verify", { command: "node --test test/*.test.mjs" });
  const receipt = verified.match(/receipt (receipt-[A-Za-z0-9-]+)/)?.[1];
  assert.ok(receipt, "verify must return a receipt id");
  const logs = await call("verify", { mode: "logs", id: receipt, lines: 5 });
  assert.match(logs, /Receipt:/);
  assert.match(logs, /test/);

  await client.close();
  fixture.cleanup();
});

test("V3 loop completes a real change with evidence and attribution", async () => {
  const fixture = createFixtureProject({ prefix: "ctxos-v3-mcp" });
  const client = await boot();

  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: { projectRoot: fixture.root, ...args } });
    assert.ok(!res.isError, `${name} failed`);
    return (res.content || []).map((chunk) => chunk.text ?? "").join("\n");
  };

  const explored = await call("explore", { intent: "了解 src/math.mjs 的结构", paths: ["src/math.mjs"] });
  assert.match(explored, /# ContextOS explore/);
  assert.ok(explored.length <= 5200, `explore must respect the context budget (${explored.length} chars)`);

  await call("change", {
    edits: [{ path: "src/math.mjs", target: "export function add(a, b) {", replacement: "export function add(a, b, c = 0) {" }],
  });
  assert.match(fixture.read("src/math.mjs"), /c = 0/);

  const verified = await call("verify", { commands: ["node --test test/*.test.mjs"] });
  assert.match(verified, /Verdict: PASS/);

  const shipped = await call("ship", { summary: "add() optional operand" });
  assert.match(shipped, /Closure/);
  assert.match(shipped, /Attribution/);

  const session = JSON.parse(fs.readFileSync(path.join(fixture.root, ".contextos", "session.json"), "utf8"));
  assert.equal(session.status, "closed");
  assert.ok(session.receipts.some((receipt) => receipt.exitCode === 0));

  const passthrough = await call("ops", { capability: "block", action: "list", args: { format: "json" } });
  assert.ok(passthrough.length > 0);

  await client.close();
  fixture.cleanup();
});
