import { ContextOSService } from "../packages/mcp/src/service.mjs";
import { sanitizeTerminalOutput } from "../packages/mcp/src/sanitizer.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");
const reduction = (before, after) => before ? Number(((1 - after / before) * 100).toFixed(2)) : null;

// Measures response size, not model tokens or agent session compactions.
export async function runBenchmark() {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const graphText = await fs.readFile(path.join(repoRoot, ".contextos/graph.json"), "utf8");
  const graph = JSON.parse(graphText);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-benchmark-"));
  let service;
  try {
    await fs.mkdir(path.join(temp, ".contextos"));
    await fs.writeFile(path.join(temp, ".contextos/graph.json"), graphText);
    await fs.copyFile(path.join(repoRoot, ".contextos/project.json"), path.join(temp, ".contextos/project.json"));
    const sourceManifest = [];
    for (const relative of [...new Set(graph.data.source_refs.map((ref) => ref.path))].sort()) {
      const safeRelative = path.relative(repoRoot, path.resolve(repoRoot, relative));
      if (safeRelative.startsWith("..") || path.isAbsolute(safeRelative)) throw new Error(`External binding: ${relative}`);
      try {
        const content = await fs.readFile(path.join(repoRoot, safeRelative));
        await fs.mkdir(path.dirname(path.join(temp, safeRelative)), { recursive: true });
        await fs.writeFile(path.join(temp, safeRelative), content);
        sourceManifest.push({ path: safeRelative, sha256: hash(content) });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        sourceManifest.push({ path: safeRelative, missing: true });
      }
    }
    service = new ContextOSService({ projectRoot: temp });
    const snapshot = service.snapshot();
    const queries = [
      { task: "OpenCode 平台支持与 MCP 注入", expected: "in-app-plugin-install" },
      { task: "Git Discard 撤回与本地 SQLite 热重载", expected: "sqlite-graph-store" },
      { task: "CJK 中文分词与 BM25 字段加权检索", expected: "context-retrieval" },
      { task: "源码 SourceBinding 路径符号同步", expected: "live-binding-refresh" },
    ];
    const taskResults = [];
    for (const query of queries) {
      const times = [];
      let result;
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        result = service.contextForTask({ task: query.task, maxChars: 4000 });
        times.push(Number((performance.now() - start).toFixed(2)));
      }
      taskResults.push({ ...query, chars: result.markdown.length, latencyMs: times,
        expectedRefReturned: result.refs.includes(`block:${query.expected}`),
        expectedRefVisible: result.markdown.includes(`[block:${query.expected}]`),
        truncated: result.markdown.includes("[truncated;"),
        versusFullGraphReductionPercent: reduction(graphText.length, result.markdown.length) });
    }
    const chain = service.chainCodeStream({ chainId: "chain-context-os", maxTotalChars: 4000 });
    const files = [...new Set(chain.nodes.map((node) => node.filePath).filter(Boolean))];
    let fullFileChars = 0;
    for (const file of files) fullFileChars += (await fs.readFile(path.join(temp, file), "utf8")).length;
    const rawLog = Array.from({ length: 200 }, (_, i) => `\u001b[32m[${i + 1}/200]\u001b[0m Compiling module package_${i + 1}.ts\n`).join("")
      + "Error: Cannot find module '@contextos/missing-engine'\nCommand failed with exit code 1.\n";
    const compressed = sanitizeTerminalOutput(rawLog, { maxChars: 1500, exitCode: 1 });
    const afterGraph = await fs.readFile(path.join(repoRoot, ".contextos/graph.json"), "utf8");
    if (hash(afterGraph) !== hash(graphText)) throw new Error("Source graph changed during measurement; rerun without concurrent graph writers");
    const latencies = taskResults.flatMap((item) => item.latencyMs).sort((a, b) => a - b);
    const report = {
      schemaVersion: 1, measuredAt: new Date().toISOString(),
      environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model },
      source: { gitHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
        graphRevision: snapshot.project.graphRevision, graphSha256: hash(graphText),
        scriptSha256: hash(await fs.readFile(new URL(import.meta.url))), sourceManifest,
        isolatedCopyWithoutGitOrExecutionReceipts: true, sourceGraphUnchanged: true },
      scope: { blocks: snapshot.blocks.length, chains: snapshot.chains.length, links: snapshot.links.length, checkpoints: snapshot.checkpoints.length },
      unit: "JavaScript UTF-16 string length; not model tokens",
      taskContext: { fullGraphChars: graphText.length, budgetChars: 4000, cases: taskResults,
        samples: latencies.length, p50Ms: latencies[Math.ceil(latencies.length * 0.5) - 1], p95Ms: latencies[Math.ceil(latencies.length * 0.95) - 1] },
      chain: { chainId: "chain-context-os", files, fullFileChars, locatorChars: chain.codeStream.length,
        reductionPercent: reduction(fullFileChars, chain.codeStream.length),
        nodes: chain.nodes.map(({ blockId, filePath, symbol, sourceStatus }) => ({ blockId, filePath, symbol, sourceStatus })),
        truncated: chain.codeStream.includes("Remaining nodes truncated") },
      syntheticLog: { fixture: "200 deterministic compilation lines plus one module error; NOT a real build",
        rawChars: rawLog.length, compressedChars: compressed.text.length, reductionPercent: reduction(rawLog.length, compressed.text.length),
        errorRetained: compressed.text.includes("Cannot find module"), failureRetained: compressed.text.includes("exit code 1") },
      limitations: ["Service-level only: excludes MCP envelope, tool definitions, skill, follow-up source reads and reasoning.",
        "Full graph and full files are size references, not a controlled competent-agent baseline.",
        "12 local calls include mixed first/warm reads; not production latency percentiles.",
        "Four expected refs are diagnostics, not general recall; hidden structured refs are not visible recall.",
        "No session compaction count, model token usage, cost or task success comparison measured."],
    };
    const outputIndex = process.argv.indexOf("--output");
    if (outputIndex >= 0) {
      const output = process.argv[outputIndex + 1];
      if (!output) throw new Error("--output requires a file path");
      await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
      await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    service?.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
}

runBenchmark().catch((error) => { console.error(error); process.exitCode = 1; });
