import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve("packages/mcp/src/server.mjs");

test("cli: --version and --help", async () => {
  const { stdout: versionOut } = await execFileAsync(process.execPath, [CLI_PATH, "--version"]);
  assert.match(versionOut, /ContextOS v0\.4\.1/);

  const { stdout: helpOut } = await execFileAsync(process.execPath, [CLI_PATH, "--help"]);
  assert.match(helpOut, /Usage:/);
  assert.match(helpOut, /init \[--scan\]/);
  assert.match(helpOut, /status/);
  assert.match(helpOut, /code --path/);
});

test("cli: code reads one symbol range without returning the containing file", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-cli-code-"));
  await fs.mkdir(path.join(tmpDir, ".contextos"), { recursive: true });
  await fs.writeFile(path.join(tmpDir, ".contextos", "project.json"), JSON.stringify({
    schemaVersion: "2.0.0", id: "cli-code", name: "CLI Code", defaultLocale: "en", supportedLocales: ["en"],
  }));
  await fs.writeFile(path.join(tmpDir, "sample.js"), "export function first() { return 1; }\nexport function second() { return 2; }\n");
  const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, "code", "--path", "sample.js", "--symbol", "first"], { cwd: tmpDir });
  assert.match(stdout, /return 1/);
  assert.doesNotMatch(stdout, /return 2/);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("cli: status on current repo", async () => {
  const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, "status"]);
  assert.match(stdout, /Project: contextos/);
  assert.match(stdout, /Blocks: \d+/);
  assert.match(stdout, /Chains: \d+/);
});

test("cli: init --scan in temporary project", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextos-cli-scan-"));
  // Create sample directories and files
  await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
  await fs.mkdir(path.join(tmpDir, "tests"), { recursive: true });
  await fs.writeFile(path.join(tmpDir, "src", "server.js"), "// server");
  await fs.writeFile(path.join(tmpDir, "tests", "api.test.js"), "// test");

  const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, "init", "--scan"], {
    cwd: tmpDir,
  });

  assert.match(stdout, /Initialized new contextos project/);
  assert.match(stdout, /Created 3 initial blocks and 1 baseline chain/);

  // Check that .contextos/graph.json exists
  const graphJson = JSON.parse(await fs.readFile(path.join(tmpDir, ".contextos", "graph.json"), "utf8"));
  assert.equal(graphJson.data.blocks.length, 3);
  assert.equal(graphJson.data.chains.length, 1);

  // Check status in that temp directory
  const { stdout: statusOut } = await execFileAsync(process.execPath, [CLI_PATH, "status"], {
    cwd: tmpDir,
  });
  assert.match(statusOut, /Blocks: 3/);
  assert.match(statusOut, /Chains: 1/);

  await fs.rm(tmpDir, { recursive: true, force: true });
});
