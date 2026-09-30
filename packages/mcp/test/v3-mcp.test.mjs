import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createV3Server } from "../src/v3-server.mjs";
import { createFixtureProject } from "../../../scripts/fixture-project.mjs";
import { packageVersion } from "../../../scripts/version.mjs";
import { SessionStore } from "../../orchestrator/src/session-store.mjs";

const EXPECTED_TOOLS = ["explore", "inspect", "change", "verify", "ship", "ops", "pipeline"];

async function boot() {
  const server = createV3Server({ surface: "legacy" });
  const client = new Client({ name: "contextos-v3-test", version: packageVersion });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test("ops honors a top-level refresh instead of silently reusing a stale receipt", async () => {
  const client = await boot();
  const fixture = createFixtureProject({ prefix: "ctxos-v3-ops-refresh" });
  try {
    const read = async (extra = {}) => {
      const result = await client.callTool({
        name: "ops",
        arguments: {
          capability: "code",
          action: "read",
          args: { path: "src/math.mjs" },
          projectRoot: fixture.root,
          ...extra,
        },
      });
      return (result.content || []).map((chunk) => chunk.text ?? "").join("\n");
    };

    const first = await read();
    assert.match(first, /add\(a, b\)/);

    const second = await read();
    assert.match(second, /unchanged|reuse|receipt/i);

    // An external write is invisible to the session store; the top-level
    // refresh must therefore bypass the receipt and return the new body.
    fixture.write("src/math.mjs", "export function add(a, b) {\n  return a + b + 1;\n}\n");
    const refreshed = await read({ refresh: true });
    assert.match(refreshed, /a \+ b \+ 1/);
  } finally {
    fixture.cleanup();
    await client.close();
  }
});

test("V3 default surface exposes one compact transport tool", async () => {
  const server = createV3Server();
  const client = new Client({ name: "contextos-v3-lean-test", version: packageVersion });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const listing = await client.listTools();
  assert.deepEqual(listing.tools.map((tool) => tool.name), ["contextos"]);
  assert.match(JSON.stringify(listing.tools[0].inputSchema), /work/);
  assert.match(listing.tools[0].description, /Known paths.*work/i);
  assert.match(listing.tools[0].description, /Micro only when explicitly assigned/i);
  assert.ok(
    listing.tools[0].description.length < 600,
    `the per-request compact tool description must stay below 600 chars, got ${listing.tools[0].description.length}`,
  );
  assert.deepEqual(Object.keys(listing.tools[0].inputSchema.properties).sort(), ['action', 'args', 'projectRoot']);
  assert.notEqual(listing.tools[0].inputSchema.additionalProperties, false, 'legacy sibling aliases must still be accepted');
  assert.ok(JSON.stringify(listing.tools[0].inputSchema).length < 1000, 'lean transport schema must stay below 1000 characters');
  const fixture = createFixtureProject({ prefix: "ctxos-v3-lean-work" });
  const work = await client.callTool({
    name: "contextos",
    arguments: {
      action: "work",
      args: {
        create: [{ path: "src/lean-work.mjs", content: "export const value = 1;\n" }],
        verify: ["node --check src/lean-work.mjs"],
      },
      projectRoot: fixture.root,
    },
  });
  const workText = (work.content || []).map((chunk) => chunk.text ?? "").join("\n");
  assert.ok(!work.isError, workText);
  assert.match(workText, /work=OK/);
  assert.match(fixture.read("src/lean-work.mjs"), /value = 1/);

  const siblingFields = await client.callTool({
    name: "contextos",
    arguments: {
      action: "change",
      intent: "edit and verify in one compact call",
      edits: [{ path: "src/lean-work.mjs", target: "value = 1", replacement: "value = 2" }],
      verify: ["node --check src/lean-work.mjs"],
      projectRoot: fixture.root,
    },
  });
  const siblingText = (siblingFields.content || []).map((chunk) => chunk.text ?? "").join("\n");
  assert.ok(!siblingFields.isError, siblingText);
  assert.match(siblingText, /ContextOS change/);
  assert.match(siblingText, /done: verified/i);
  assert.match(fixture.read("src/lean-work.mjs"), /value = 2/);
  await client.close();
  fixture.cleanup();
});

test("V3 compact normalizes common pipeline, range, capability, and edit shapes", async () => {
  const server = createV3Server();
  const client = new Client({ name: "contextos-v3-normalize-test", version: packageVersion });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const fixture = createFixtureProject({ prefix: "ctxos-v3-normalize" });
  const text = (result) => (result.content || []).map((chunk) => chunk.text ?? "").join("\n");

  try {
    const shorthand = await client.callTool({
      name: "contextos",
      arguments: {
        action: "pipeline",
        intent: "inspect math",
        pipeline: { inspect: { path: "src/math.mjs" } },
        projectRoot: fixture.root,
      },
    });
    const shorthandText = text(shorthand);
    assert.ok(!shorthand.isError, shorthandText);
    assert.match(shorthandText, /pipeline=OK/);
    assert.doesNotMatch(shorthandText, /No steps provided/);

    const staged = await client.callTool({
      name: "contextos",
      arguments: {
        action: "pipeline",
        pipeline: { stages: [{ type: "inspect", path: "src/math.mjs", full: true }] },
        projectRoot: fixture.root,
      },
    });
    const stagedText = text(staged);
    assert.ok(!staged.isError, stagedText);
    assert.match(stagedText, /pipeline=OK/);
    assert.match(stagedText, /add\(a, b\)/);

    const bare = await client.callTool({
      name: "contextos",
      arguments: {
        action: "pipeline",
        task: "inspect math and verify the fixture",
        projectRoot: fixture.root,
      },
    });
    const bareText = text(bare);
    assert.ok(!bare.isError, bareText);
    assert.match(bareText, /pipeline=/);
    assert.doesNotMatch(bareText, /No steps provided/);

    const command = await client.callTool({
      name: "contextos",
      arguments: {
        action: "ops",
        arguments: { action: "run_command", commands: ["git status --short"] },
        projectRoot: fixture.root,
      },
    });
    const commandText = text(command);
    assert.match(commandText, /\"exitCode\":0/);
    assert.match(commandText, /git status --short/);

    const ranged = await client.callTool({
      name: "contextos",
      arguments: {
        action: "inspect",
        ranges: [{ path: "src/math.mjs", startLine: 1, endLine: 1 }],
        projectRoot: fixture.root,
      },
    });
    assert.match(text(ranged), /add\(a, b\)/);

    const rangedArray = await client.callTool({
      name: "contextos",
      arguments: {
        action: "inspect",
        path: "src/math.mjs",
        ranges: [[1, 1]],
        budget: "full",
        refresh: true,
        dedupeReads: false,
        projectRoot: fixture.root,
      },
    });
    const rangedArrayText = text(rangedArray);
    assert.match(rangedArrayText, /add\(a, b\)/);
    assert.doesNotMatch(rangedArrayText, /return a \+ b;/);

    const absoluteBatch = await client.callTool({
      name: "contextos",
      arguments: {
        action: "inspect",
        paths: [
          path.join(fixture.root, "src/math.mjs"),
          path.join(fixture.root, "src/strings.mjs"),
        ],
        refresh: true,
        dedupeReads: false,
        projectRoot: fixture.root,
      },
    });
    const absoluteBatchText = text(absoluteBatch);
    assert.match(absoluteBatchText, /add\(a, b\)/);
    assert.match(absoluteBatchText, /greet\(name\)/);
    assert.doesNotMatch(absoluteBatchText, /AST Outline/);

    const capability = await client.callTool({
      name: "contextos",
      arguments: {
        action: "ops",
        capability: "code",
        args: { action: "read", path: "src/math.mjs" },
        refresh: true,
        dedupeReads: false,
        projectRoot: fixture.root,
      },
    });
    const capabilityText = text(capability);
    assert.match(capabilityText, /add\(a, b\)/);
    assert.doesNotMatch(capabilityText, /Unknown capability 'undefined'/);

    const edit = await client.callTool({
      name: "contextos",
      arguments: {
        action: "change",
        edits: [{ path: "src/math.mjs", content: "export function add(a, b) {\n  return a + b + 1;\n}\n" }],
        verify: ["node --check src/math.mjs"],
        projectRoot: fixture.root,
      },
    });
    const editText = text(edit);
    assert.ok(!edit.isError, editText);
    assert.match(editText, /done: verified/i);
    assert.match(fixture.read("src/math.mjs"), /a \+ b \+ 1/);
  } finally {
    fixture.cleanup();
    await client.close();
  }
});

test("V3 compact search/create aliases route through work and change", async () => {
  const server = createV3Server();
  const client = new Client({ name: "contextos-v3-alias-test", version: packageVersion });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const fixture = createFixtureProject({ prefix: "ctxos-v3-aliases" });

  try {
    const search = await client.callTool({
      name: "contextos",
      arguments: { action: "search", query: "add", projectRoot: fixture.root },
    });
    const searchText = (search.content || []).map((chunk) => chunk.text ?? "").join("\n");
    assert.ok(!search.isError, searchText);
    assert.match(searchText, /Search: `add`/);

    const exploreSearch = await client.callTool({
      name: "contextos",
      arguments: { action: "explore", search: { query: "add(a" }, projectRoot: fixture.root },
    });
    const exploreText = (exploreSearch.content || []).map((chunk) => chunk.text ?? "").join("\n");
    assert.ok(!exploreSearch.isError, exploreText);
    assert.match(exploreText, /Search: `add\(a`/);

    const created = await client.callTool({
      name: "contextos",
      arguments: {
        action: "create",
        create: [{ path: "src/alias.mjs", content: "export const alias = 1;\n" }],
        verify: ["node --check src/alias.mjs"],
        projectRoot: fixture.root,
      },
    });
    const createdText = (created.content || []).map((chunk) => chunk.text ?? "").join("\n");
    assert.ok(!created.isError, createdText);
    assert.match(createdText, /ContextOS change/);
    assert.match(fixture.read("src/alias.mjs"), /alias = 1/);
  } finally {
    fixture.cleanup();
    await client.close();
  }
});

test("V3 compact ops exposes frozen rollout telemetry and rollout-aware comparison", async () => {
  const fixture = createFixtureProject({ prefix: "ctxos-v3-rollout" });
  const usage = (inputTokens, outputTokens) => ({
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inputTokens + outputTokens,
  });
  const writeRollout = (filePath, entries) => {
    fs.writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  };
  const record = (responseId, inputTokens, outputTokens, contextWindow) => ({
    type: "token_usage_record",
    payload: {
      response_id: responseId,
      usage: usage(inputTokens, outputTokens),
      thread_token_usage: usage(inputTokens, outputTokens),
      model_context_window: contextWindow,
    },
  });
  const leftRolloutPath = path.join(fixture.root, "left-rollout.jsonl");
  const rightRolloutPath = path.join(fixture.root, "right-rollout.jsonl");
  writeRollout(leftRolloutPath, [record("left-1", 10, 2, 128000)]);
  writeRollout(rightRolloutPath, [record("right-1", 8, 1, 256000)]);

  const server = createV3Server();
  const client = new Client({ name: "contextos-v3-rollout-test", version: packageVersion });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const rolloutResult = await client.callTool({
      name: "contextos",
      arguments: {
        action: "ops",
        args: {
          capability: "telemetry",
          action: "rollout",
          args: { paths: [leftRolloutPath] },
        },
        projectRoot: fixture.root,
      },
    });
    const rolloutText = (rolloutResult.content || []).map((chunk) => chunk.text ?? "").join("\n");
    assert.ok(!rolloutResult.isError, rolloutText);
    const rollout = JSON.parse(rolloutText);
    assert.equal(rollout.schemaVersion, 1);
    assert.deepEqual(rollout.files, [leftRolloutPath]);
    assert.equal(rollout.records, 1);
    assert.equal(rollout.metrics.requestCount, 1);
    assert.equal(rollout.metrics.inputTokens, 10);
    assert.equal(rollout.metrics.outputTokens, 2);
    assert.equal(rollout.metrics.totalTokens, 12);
    assert.equal(rollout.metrics.modelContextWindow, 128000);

    const compareResult = await client.callTool({
      name: "contextos",
      arguments: {
        action: "ops",
        args: {
          capability: "telemetry",
          action: "compare",
          args: { leftRolloutPath, rightRolloutPath },
        },
        projectRoot: fixture.root,
      },
    });
    const compareText = (compareResult.content || []).map((chunk) => chunk.text ?? "").join("\n");
    assert.ok(!compareResult.isError, compareText);
    const comparison = JSON.parse(compareText);
    assert.equal(comparison.left, null);
    assert.equal(comparison.right, null);
    assert.equal(comparison.delta, null);
    assert.equal(comparison.rollout.left.metrics.totalTokens, 12);
    assert.equal(comparison.rollout.right.metrics.totalTokens, 9);
    assert.equal(comparison.rollout.delta.totalTokens, -3);
    assert.equal(comparison.rollout.delta.modelContextWindow, 128000);
  } finally {
    await client.close();
    fixture.cleanup();
  }
});

test("V3 change preserves the content alias for fullFile edits", async () => {
  const fixture = createFixtureProject({ prefix: "ctxos-v3-fullfile" });
  fs.writeFileSync(path.join(fixture.root, "note.txt"), "old\n");
  const client = await boot();
  try {
    const result = await client.callTool({
      name: "change",
      arguments: {
        edits: [{ path: "note.txt", content: "new\n", fullFile: true }],
        projectRoot: fixture.root,
      },
    });
    const text = (result.content || []).map((chunk) => chunk.text ?? "").join("\n");
    assert.ok(!result.isError, text);
    assert.equal(fixture.read("note.txt"), "new\n");
  } finally {
    await client.close();
    fixture.cleanup();
  }
});

test("V3 change preserves curated architecture for same-turn Block and Chain binding", async () => {
  const fixture = createFixtureProject({ prefix: "ctxos-v3-architecture" });
  fs.writeFileSync(path.join(fixture.root, "note.txt"), "old\n");
  const client = await boot();
  try {
    const result = await client.callTool({
      name: "change",
      arguments: {
        edits: [{ path: "note.txt", content: "new\n", fullFile: true }],
        verify: "node -e \"0\"",
        architecture: {
          blocks: [{
            id: "block-note-service",
            title: "Note service",
            kind: "service",
            paths: ["note.txt"],
          }],
          chains: [{
            id: "chain-note-flow",
            title: "Note flow",
            kind: "feature",
            memberIds: ["block-note-service"],
          }],
        },
        projectRoot: fixture.root,
      },
    });
    const text = (result.content || []).map((chunk) => chunk.text ?? "").join("\n");
    assert.ok(!result.isError, text);
    assert.match(text, /1 curated Block\(s\) bound/);
    assert.match(text, /1 Chain\(s\) composed/);
  } finally {
    await client.close();
    fixture.cleanup();
  }
});

test("V3 lean micro forwards bulk input args into the Micro client", async () => {
  const fixture = createFixtureProject({ prefix: "ctxos-v3-lean-micro" });
  const requests = [];
  const provider = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      requests.push(parsed);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "micro final answer" } }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      }));
    });
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${provider.address().port}`;
  fs.writeFileSync(path.join(fixture.root, "diagnostic.log"), "failure trace\ncorrelation=42\n");
  fs.mkdirSync(path.join(fixture.root, ".contextos"), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, ".contextos", "profile.json"), JSON.stringify({
    micro: { url, model: "mock-micro", requireBulkInput: true },
  }, null, 2));

  const server = createV3Server();
  const client = new Client({ name: "contextos-v3-lean-micro-test", version: packageVersion });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = await client.callTool({
      name: "contextos",
      arguments: {
        action: "micro",
        args: { preset: "triage", inputRef: "diagnostic.log", task: "summarize the failure" },
        projectRoot: fixture.root,
      },
    });
    const text = (result.content || []).map((chunk) => chunk.text ?? "").join("\n");
    assert.ok(!result.isError, text);
    assert.match(text, /micro final answer/);
    assert.equal(requests.length, 1);
    const usageLine = fs.readFileSync(path.join(fixture.root, ".contextos", "logs", "micro-usage.jsonl"), "utf8")
      .split("\n").filter(Boolean).at(-1);
    const usage = JSON.parse(usageLine);
    assert.equal(usage.inputSource, "inputRef");
    assert.equal(usage.preset, "triage");
    assert.equal(usage.totalTokens, 15);
  } finally {
    await client.close();
    await new Promise((resolve) => provider.close(resolve));
    fixture.cleanup();
  }
});

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
  const exploreTool = listing.tools.find((tool) => tool.name === "explore");
  const inspectTool = listing.tools.find((tool) => tool.name === "inspect");
  assert.match(JSON.stringify(exploreTool?.inputSchema), /refresh/);
  assert.match(JSON.stringify(exploreTool?.inputSchema), /dedupeReads/);
  assert.match(JSON.stringify(inspectTool?.inputSchema), /refresh/);
  assert.match(JSON.stringify(inspectTool?.inputSchema), /dedupeReads/);
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

test("V3 session history returns a compact targeted summary by default", async () => {
  const fixture = createFixtureProject({ prefix: "ctxos-v3-session-history" });
  const store = new SessionStore({ projectRoot: fixture.root, projectId: "fixture" });
  const session = store.ensureSession("history intent ".repeat(60));
  store.touch(Array.from({ length: 200 }, (_, index) => ({ path: `src/generated-${index}.mjs` })));
  for (let index = 0; index < 10; index += 1) {
    store.attachReceipt({
      id: `receipt-history-${index}`,
      command: `npm test ${"verbose ".repeat(20)}`,
      cwd: fixture.root,
      exitCode: index === 9 ? 0 : 1,
      durationMs: 5,
    });
  }
  store.close("history summary ".repeat(120));

  const client = await boot();
  try {
    const result = await client.callTool({
      name: "ops",
      arguments: {
        projectRoot: fixture.root,
        capability: "session",
        action: "history",
        args: { sessionId: session.id, limit: 10 },
      },
    });
    const text = (result.content || []).map((chunk) => chunk.text ?? "").join("\n");
    assert.ok(!result.isError, text);
    assert.ok(text.length < 2200, `history must stay bounded (${text.length} chars)`);
    const parsed = JSON.parse(text);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].id, session.id);
    assert.equal(parsed[0].touchedFileCount, 200);
    assert.ok(parsed[0].touchedFiles.length <= 4);
    assert.ok(parsed[0].receipts.length <= 2);

    store.ensureSession("large open session");
    store.touch(Array.from({ length: 200 }, (_, index) => ({ path: `src/open-${index}.mjs` })));
    for (let index = 0; index < 50; index += 1) {
      store.attachReceipt({
        id: `open-receipt-${index}`,
        command: `npm test ${index}`,
        cwd: fixture.root,
        exitCode: 0,
        durationMs: 1,
      });
    }
    const raw = store.current;
    raw.readReceipts = Array.from({ length: 200 }, (_, index) => ({ path: `src/open-${index}.mjs`, hash: `hash-${index}` }));
    store.save(raw);
    const statusResult = await client.callTool({
      name: "ops",
      arguments: {
        projectRoot: fixture.root,
        capability: "session",
        action: "status",
      },
    });
    const statusText = (statusResult.content || []).map((chunk) => chunk.text ?? "").join("\n");
    assert.ok(!statusResult.isError, statusText);
    assert.ok(statusText.length < 2200, `status must stay bounded (${statusText.length} chars)`);
    const status = JSON.parse(statusText);
    assert.equal(status.touchedFileCount, 200);
    assert.equal(status.receiptCount, 50);
    assert.equal(Object.hasOwn(status, "readReceipts"), false);
  } finally {
    await client.close();
    fixture.cleanup();
  }
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

  const activePlan = JSON.parse(await call("ops", {
    capability: "plan",
    action: "get",
    args: { format: "json" },
  }));
  assert.equal(activePlan.id, "plan-p5-optional");

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
        workingSet: { files: ["src/math.mjs"] },
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

  const compactOpen = JSON.parse(await call("ops", {
    capability: "task",
    action: "open",
    args: { id: "task-p5-optional", format: "json" },
  }));
  assert.equal(compactOpen.contextSlice.locators.length, 0, "task open must not reconcile or expand locators implicitly");
  assert.equal(compactOpen.notes.length, 0, "task open must not append host-change notes implicitly");

  // Make the explicit path observable: reconcile refreshes AST locators when
  // the scoped file actually changed, while the preceding open remains pure.
  fs.appendFileSync(path.join(fixture.root, "src/math.mjs"), "\nexport const extra = 1;\n");
  const reconciledOpen = JSON.parse(await call("ops", {
    capability: "task",
    action: "open",
    args: { id: "task-p5-optional", reconcile: true, format: "json" },
  }));
  assert.ok(reconciledOpen.contextSlice.locators.length > 0, "reconciliation remains available when explicitly requested");

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

test("V3 loop completes a real change with evidence and advisory architecture gaps", async () => {
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
  const reused = await call("explore", { intent: "了解 src/math.mjs 的结构", paths: ["src/math.mjs"] });
  assert.match(reused, /explore \(reused\)/);
  const refreshed = await call("explore", { intent: "了解 src/math.mjs 的结构", paths: ["src/math.mjs"], refresh: true });
  assert.doesNotMatch(refreshed, /explore \(reused\)/);

  await call("change", {
    edits: [{ path: "src/math.mjs", target: "export function add(a, b) {", replacement: "export function add(a, b, c = 0) {" }],
  });
  assert.match(fixture.read("src/math.mjs"), /c = 0/);

  const verified = await call("verify", { commands: ["node --test test/*.test.mjs"] });
  assert.match(verified, /Verdict: PASS/);

  const shipped = await call("ship", { summary: "add() optional operand" });
  assert.match(shipped, /Closure/);
  assert.match(shipped, /Curated architecture: 1 gap/);
  assert.match(shipped, /Module index hints \(navigation only\)/);
  assert.match(shipped, /src\/math\.mjs/);
  assert.ok(!shipped.includes("BLOCKED"));

  const session = JSON.parse(fs.readFileSync(path.join(fixture.root, ".contextos", "session.json"), "utf8"));
  assert.equal(session.status, "closed");
  assert.ok(session.receipts.some((receipt) => receipt.exitCode === 0));

  const passthrough = await call("ops", { capability: "block", action: "list", args: { format: "json" } });
  assert.ok(!passthrough.includes('"mod-'));

  await client.close();
  fixture.cleanup();
});

test("V3 MCP surface handles inspect ranges and change overwrite", async () => {
  const fixture = createFixtureProject({ prefix: "ctxos-v3-inspect-change" });
  const client = await boot();

  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: { projectRoot: fixture.root, ...args } });
    assert.ok(!res.isError, `${name} failed: ${(res.content || []).map((c) => c.text).join('\n')}`);
    return (res.content || []).map((chunk) => chunk.text ?? "").join("\n");
  };

  const inspected = await call("inspect", {
    path: "src/math.mjs",
    ranges: [{ startLine: 1, endLine: 2 }],
    budget: "full",
  });
  assert.match(inspected, /# ContextOS inspect/);
  assert.match(inspected, /\[L1-L2\]/);

  const changed = await call("change", {
    path: "src/math.mjs",
    content: "export const version = '3.0.0';\n",
    overwrite: true,
  });
  assert.match(changed, /ContextOS change/);
  assert.equal(fixture.read("src/math.mjs"), "export const version = '3.0.0';\n");

  await client.close();
  fixture.cleanup();
});

test("V3 inspect resolves globs and pipeline accepts receipt plus run aliases", async () => {
  const fixture = createFixtureProject({ prefix: "ctxos-v3-pipeline-contract" });
  const client = await boot();

  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: { projectRoot: fixture.root, ...args } });
    assert.ok(!res.isError, `${name} failed: ${(res.content || []).map((chunk) => chunk.text).join('\n')}`);
    return (res.content || []).map((chunk) => chunk.text ?? "").join("\n");
  };

  const inspected = await call("inspect", { globs: ["src/*.mjs"], mode: "outline" });
  assert.match(inspected, /src\/math\.mjs/);
  assert.match(inspected, /src\/strings\.mjs/);

  const changed = await call("change", {
    path: "src/math.mjs",
    append: "export const verified = true;\n",
    verify: { command: "node --test test/math.test.mjs" },
  });
  assert.match(changed, /verify: PASS/);

  const parallel = await call("pipeline", {
    mode: "receipt",
    parallel: [
      { run: "node -e \"console.log('ok')\"" },
      { inspect: { path: "src/math.mjs" } },
    ],
  });
  assert.match(parallel, /pipeline=OK/);
  assert.match(parallel, /ops=OK/);
  assert.match(parallel, /inspect=OK/);

  const chained = await call("pipeline", {
    chain: [
      { action: "run", args: { command: "node -e \"process.exit(0)\"" } },
      { verify: { command: "node --test test/math.test.mjs" } },
    ],
  });
  assert.match(chained, /pipeline=OK/);
  assert.match(chained, /Verdict: PASS/);

  await client.close();
  fixture.cleanup();
});

test("V3 compact surface exposes architecture aliases and bounded command logs", async () => {
  const fixture = createFixtureProject({ prefix: "ctxos-v3-architecture-contract" });
  const server = createV3Server();
  const client = new Client({ name: "contextos-v3-architecture-contract", version: packageVersion });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const call = async (args) => {
    const result = await client.callTool({ name: "contextos", arguments: { ...args, projectRoot: fixture.root } });
    const text = (result.content || []).map((chunk) => chunk.text ?? "").join("\n");
    assert.ok(!result.isError, text);
    return text;
  };

  try {
    const changed = await call({
      action: "change",
      args: {
        architecture: {
          blocks: [{ id: "block-math-api", title: "Math API", kind: "api", paths: ["src/math.mjs"] }],
          chains: [{ id: "chain-math-flow", title: "Math flow", memberIds: ["block-math-api"] }],
        },
      },
    });
    assert.match(changed, /1 curated Block\(s\) bound/);
    assert.match(changed, /1 Chain\(s\) composed/);

    const architecture = JSON.parse(await call({
      action: "ops",
      args: { capability: "architecture", action: "list", args: { format: "json" } },
    }));
    assert.ok(Array.isArray(architecture.blocks?.items));
    assert.ok(Array.isArray(architecture.chains?.items));

    const opened = JSON.parse(await call({
      action: "ops",
      args: { capability: "block", action: "get", args: { id: "block-math-api", format: "json" } },
    }));
    assert.equal(opened.id, "block-math-api");

    const receipt = JSON.parse(await call({
      action: "ops",
      args: {
        capability: "run_command",
        args: {
          command: "node -e \"process.stdout.write('x'.repeat(200))\"",
          maxLogBytes: 64,
        },
      },
    }));
    assert.equal(receipt.logBytes, 64);
    assert.equal(receipt.logTruncated, true);
  } finally {
    await client.close();
    fixture.cleanup();
  }
});
