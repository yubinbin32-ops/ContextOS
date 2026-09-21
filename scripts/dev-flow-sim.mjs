/**
 * Development-flow simulation.
 *
 * Runs four real development jobs (feature, bugfix, fail-then-fix iteration,
 * comprehension) against fresh fixtures twice: once with the V3 intent surface
 * and once with the legacy V2 C-D-C-S facades.
 *
 * The V3 agent authors only the intent and the patch; every other step comes
 * from the `## Next` affordance returned by the OS. The V2 agent follows the
 * documented protocol including the coverage-gate repair dance.
 *
 * Prints an A/B table and exits non-zero when the V3 loop misses a dev-need gate.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createV3Server } from "../packages/mcp/src/v3-server.mjs";
import { ContextOSV2Service } from "../packages/mcp/src/v2-service.mjs";
import { createFixtureProject } from "./fixture-project.mjs";

const MULTIPLY_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { multiply } from "../src/math.mjs";

test("multiply", () => {
  assert.equal(multiply(3, 4), 12);
});
`;

const EXTRA_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { sub, multiply } from "../src/math.mjs";

test("sub stays correct", () => {
  assert.equal(sub(5, 3), 2);
});

test("multiply", () => {
  assert.equal(multiply(3, 4), 12);
});
`;

const SCENARIOS = [
  {
    id: "feature",
    name: "新增 multiply() 并补测试",
    intent: "给 src/math.mjs 增加 multiply(a, b) 并补上单元测试",
    workingSet: ["src/math.mjs"],
    rounds: [
      {
        edits: [
          {
            path: "src/math.mjs",
            target: "export function sub(a, b) {",
            replacement: "export function multiply(a, b) {\n  return a * b;\n}\n\nexport function sub(a, b) {",
          },
        ],
        create: [{ path: "test/multiply.test.mjs", content: MULTIPLY_TEST }],
      },
    ],
    verifyCommands: ["node --test test/*.test.mjs"],
    summary: "multiply() with unit test",
    expect: (fx) => fx.read("src/math.mjs").includes("multiply") && fx.read("test/multiply.test.mjs").includes("multiply"),
    maxCalls: 4,
  },
  {
    id: "bugfix",
    name: "修复 sub() 返回值错误",
    intent: "sub() 应该返回 a - b，但现在返回了 a + b，修掉它",
    workingSet: ["src/math.mjs"],
    prepare: (fx) => fx.write("src/math.mjs", "export function add(a, b) {\n  return a + b;\n}\n\nexport function sub(a, b) {\n  return a + b;\n}\n"),
    rounds: [
      {
        edits: [
          {
            path: "src/math.mjs",
            target: "export function sub(a, b) {\n  return a + b;\n}",
            replacement: "export function sub(a, b) {\n  return a - b;\n}",
          },
        ],
      },
    ],
    verifyCommands: ["node --test test/*.test.mjs"],
    summary: "sub() returns a - b",
    expect: (fx) => /return a - b;/.test(fx.read("src/math.mjs")),
    maxCalls: 4,
  },
  {
    id: "iterate",
    name: "第一版修复测试失败后迭代到通过",
    intent: "sub() 被写坏了，同时补上 multiply()；测试要求 sub(5,3)=2 且 multiply(3,4)=12",
    workingSet: ["src/math.mjs"],
    prepare: (fx) => {
      fx.write("src/math.mjs", "export function add(a, b) {\n  return a + b;\n}\n\nexport function sub(a, b) {\n  return a + b;\n}\n");
      fx.write("test/extra.test.mjs", EXTRA_TEST);
    },
    rounds: [
      {
        edits: [
          {
            path: "src/math.mjs",
            target: "export function sub(a, b) {\n  return a + b;\n}",
            // First attempt: sub fixed, but multiply is implemented wrongly.
            replacement: "export function multiply(a, b) {\n  return a + b;\n}\n\nexport function sub(a, b) {\n  return a - b;\n}",
          },
        ],
      },
      {
        edits: [
          {
            path: "src/math.mjs",
            target: "export function multiply(a, b) {\n  return a + b;\n}",
            replacement: "export function multiply(a, b) {\n  return a * b;\n}",
          },
        ],
      },
    ],
    verifyCommands: ["node --test test/*.test.mjs"],
    summary: "sub() and multiply() both correct after one failed attempt",
    expect: (fx) => {
      const source = fx.read("src/math.mjs");
      return /return a - b;/.test(source) && /return a \* b;/.test(source);
    },
    requireFailThenPass: true,
    maxCalls: 6,
  },
  {
    id: "comprehension",
    name: "定位 greet() 的实现",
    intent: "greet() 在哪里实现？谁在调用它？",
    workingSet: [],
    rounds: [],
    verifyCommands: [],
    expect: () => true,
    expectExplore: (text) => text.includes("strings.mjs") && text.includes("greet"),
    maxCalls: 1,
  },
];

function parseHint(text) {
  const match = String(text).match(/👉\s*(\w+)\((\{.*\})\)/);
  if (!match) return null;
  try {
    return { tool: match[1], args: JSON.parse(match[2]) };
  } catch (_) {
    return null;
  }
}

async function boot(serverFactory) {
  const server = serverFactory();
  const client = new Client({ name: "contextos-dev-flow-sim", version: "2.5.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function makeMetrics() {
  return { calls: 0, chars: 0, repairs: 0, osDriven: 0, errors: [], ms: 0 };
}

function instrumentMcp(client, root, m) {
  return async (tool, args, { tolerate = false } = {}) => {
    m.calls += 1;
    const res = await client.callTool({ name: tool, arguments: { projectRoot: root, ...args } });
    const text = (res.content || []).map((chunk) => chunk.text ?? "").join("\n");
    m.chars += text.length;
    if (res.isError) {
      m.repairs += 1;
      m.errors.push(`${tool}: ${text.slice(0, 120)}`);
      if (!tolerate) throw new Error(`${tool} failed: ${text.slice(0, 200)}`);
    }
    return text;
  };
}

/**
 * The legacy V2 facade surface was removed with DEC-019, so the baseline drives
 * the same service methods directly. Metrics stay comparable: one call is one
 * protocol step, and the payload is what the agent would have received.
 */
function instrumentService(service, m) {
  return async (capability, args = {}, { tolerate = false } = {}) => {
    m.calls += 1;
    let payload;
    try {
      switch (capability) {
        case "os_context":
          payload = await service.osContext(args);
          break;
        case "code":
          payload = await service.code(args);
          break;
        case "run_command":
          payload = await service.runCommand(args);
          break;
        case "task":
          payload = await service.task(args);
          break;
        case "block":
          payload = await service.block(args);
          break;
        default:
          throw new Error(`unknown capability ${capability}`);
      }
    } catch (error) {
      m.repairs += 1;
      const text = String(error.message);
      m.errors.push(`${capability}: ${text.slice(0, 120)}`);
      m.chars += text.length;
      if (!tolerate) throw error;
      return text;
    }
    const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    m.chars += text.length;
    return text;
  };
}

async function runV3(scenario) {
  const fx = createFixtureProject({ prefix: `ctxos-v3-${scenario.id}` });
  if (scenario.prepare) scenario.prepare(fx);
  const client = await boot(createV3Server);
  const m = makeMetrics();
  const started = Date.now();
  const call = instrumentMcp(client, fx.root, m);

  let out = await call("explore", { intent: scenario.intent });

  if (scenario.rounds.length === 0) {
    assert.ok(scenario.expectExplore(out), `[${scenario.id}] explore did not surface the target`);
    await client.close();
    fx.cleanup();
    return { ...m, ms: Date.now() - started, ok: true };
  }

  const verdicts = [];
  for (let round = 0; round < scenario.rounds.length; round += 1) {
    out = await call("change", { intent: scenario.intent, ...scenario.rounds[round] });
    const hint = parseHint(out);
    assert.ok(hint && hint.tool === "verify", `[${scenario.id}] OS did not steer to verify (got ${hint?.tool})`);
    out = await call("verify", { commands: hint.args.commands || scenario.verifyCommands });
    m.osDriven += 1;
    verdicts.push(/Verdict: PASS/.test(out) ? "pass" : "fail");
    if (/Verdict: PASS/.test(out)) break;
  }

  if (scenario.requireFailThenPass) {
    assert.deepEqual(verdicts, ["fail", "pass"], `[${scenario.id}] expected a failed attempt then a pass, got ${verdicts.join(",")}`);
  }
  assert.equal(verdicts[verdicts.length - 1], "pass", `[${scenario.id}] verification never passed`);

  const hint = parseHint(out);
  assert.ok(hint && hint.tool === "ship", `[${scenario.id}] OS did not steer to ship (got ${hint?.tool})`);
  out = await call("ship", { summary: scenario.summary });
  m.osDriven += 1;

  assert.ok(scenario.expect(fx), `[${scenario.id}] final code state is wrong`);
  assert.match(out, /Closure/, `[${scenario.id}] ship did not close the session`);

  const session = JSON.parse(fs.readFileSync(path.join(fx.root, ".contextos", "session.json"), "utf8"));
  assert.equal(session.status, "closed");
  assert.ok(session.receipts.some((receipt) => receipt.exitCode === 0), `[${scenario.id}] no green receipt recorded`);

  await client.close();
  fx.cleanup();
  return { ...m, ms: Date.now() - started, ok: true };
}

async function runV2(scenario) {
  const fx = createFixtureProject({ prefix: `ctxos-v2-${scenario.id}` });
  if (scenario.prepare) scenario.prepare(fx);
  const service = new ContextOSV2Service({ projectRoot: fx.root, projectId: "fixture" });
  const m = makeMetrics();
  const started = Date.now();
  const call = instrumentService(service, m);

  await call("os_context", { action: "brief" });

  if (scenario.rounds.length === 0) {
    const searched = await call("code", { action: "search", query: "greet" });
    service.close();
    fx.cleanup();
    return { ...m, ms: Date.now() - started, ok: searched.includes("greet") };
  }

  const startedTask = await call("task", {
    action: "start",
    taskData: { title: scenario.intent, workingSet: { files: scenario.workingSet } },
    format: "json",
  });
  const taskId = JSON.parse(startedTask).task.id;

  await call("code", { action: "outline", path: "src/math.mjs" });
  await call("code", { action: "read", path: "src/math.mjs", startLine: 1, endLine: 12 });

  for (const round of scenario.rounds) {
    for (const edit of round.edits || []) {
      await call("code", { action: "edit", path: edit.path, targetContent: edit.target, replacementContent: edit.replacement });
    }
    for (const created of round.create || []) {
      await call("code", { action: "create", path: created.path, content: created.content });
    }
    const receipt = JSON.parse(await call("run_command", { command: scenario.verifyCommands[0] }));
    // A V2-savvy agent only records passing checks: recording a failed one makes
    // task.sync refuse to run later ("Cannot sync task with N failed checks").
    if (receipt.exitCode === 0) {
      await call("task", {
        action: "check",
        id: taskId,
        checkData: { receiptId: receipt.id, description: "tests pass", passed: true },
      });
    }
  }

  // Coverage gate: without Block ownership the first sync fails, which is the
  // repair dance the V3 derived attribution removes.
  await call("task", { action: "sync", id: taskId, syncData: {} }, { tolerate: true });
  await call("task", { action: "resume", id: taskId }, { tolerate: true });
  const files = scenario.workingSet.concat(
    scenario.rounds.flatMap((round) => [...(round.edits || []).map((edit) => edit.path), ...(round.create || []).map((entry) => entry.path)])
  );
  await call("block", { action: "bind_auto", id: "block-fixture-math", paths: [...new Set(files)] }, { tolerate: true });
  await call("task", { action: "resume", id: taskId }, { tolerate: true });
  await call("task", { action: "sync", id: taskId, syncData: {} }, { tolerate: true });

  const state = JSON.parse(await call("task", { action: "open", id: taskId, format: "json" }));
  const synced = state?.status === "completed";
  const codeOk = scenario.expect(fx);

  service.close();
  fx.cleanup();
  return { ...m, ms: Date.now() - started, ok: codeOk && synced };
}

function row(label, m) {
  return `| ${label} | ${m.calls} | ${m.chars} | ~${Math.round(m.chars / 4)} | ${m.repairs} | ${m.ms} | ${m.ok ? "yes" : "no"} |`;
}

async function main() {
  const report = [];
  let failures = 0;

  for (const scenario of SCENARIOS) {
    const v3 = await runV3(scenario);
    const v2 = await runV2(scenario);

    console.log(`\n## ${scenario.name} (${scenario.id})`);
    console.log("| path | calls | chars | ~tokens | repair turns | ms | completed |");
    console.log("| --- | --- | --- | --- | --- | --- | --- |");
    console.log(row("V3 intent loop", v3));
    console.log(row("V2 C-D-C-S facades", v2));
    if (v3.errors.length) console.log(`V3 errors: ${v3.errors.join(" | ")}`);
    if (v2.errors.length) console.log(`V2 errors: ${v2.errors.join(" | ")}`);

    const gates = [
      ["V3 completes the job", v3.ok],
      [`V3 uses <= ${scenario.maxCalls} calls`, v3.calls <= scenario.maxCalls],
      ["V3 needs no repair turns", v3.repairs === 0],
      ["V3 costs fewer calls than V2", v3.calls < v2.calls],
      ["V3 costs fewer chars than V2", v3.chars < v2.chars],
    ];
    for (const [label, passed] of gates) {
      console.log(`  ${passed ? "PASS" : "FAIL"} — ${label}`);
      if (!passed) failures += 1;
    }
    report.push({ scenario: scenario.id, v3, v2 });
  }

  const sum = (pick) => report.reduce((total, entry) => total + pick(entry), 0);
  const callsV3 = sum((entry) => entry.v3.calls);
  const callsV2 = sum((entry) => entry.v2.calls);
  const charsV3 = sum((entry) => entry.v3.chars);
  const charsV2 = sum((entry) => entry.v2.chars);
  const repairsV2 = sum((entry) => entry.v2.repairs);

  console.log("\n## Totals");
  console.log(`- calls: V3 ${callsV3} vs V2 ${callsV2} (${Math.round((1 - callsV3 / callsV2) * 100)}% fewer round trips)`);
  console.log(`- response chars: V3 ${charsV3} vs V2 ${charsV2} (${Math.round((1 - charsV3 / charsV2) * 100)}% less context)`);
  console.log(`- V2 repair turns caused by gates: ${repairsV2}; V3: 0`);
  console.log(failures === 0 ? "\n✓ Development-flow simulation passed: the V3 loop satisfies the dev-need gates." : `\n✗ ${failures} gate(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
