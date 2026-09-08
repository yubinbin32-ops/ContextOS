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
  assert.match(versionOut, /mdflow v0\.2\.0/);

  const { stdout: helpOut } = await execFileAsync(process.execPath, [CLI_PATH, "--help"]);
  assert.match(helpOut, /Usage:/);
  assert.match(helpOut, /init \[--scan\]/);
  assert.match(helpOut, /status/);
});

test("cli: status on current repo", async () => {
  const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, "status"]);
  assert.match(stdout, /Project: mdflow/);
  assert.match(stdout, /Blocks: 27/);
  assert.match(stdout, /Chains: 6/);
});

test("cli: init --scan in temporary project", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mdflow-cli-scan-"));
  // Create sample directories and files
  await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
  await fs.mkdir(path.join(tmpDir, "tests"), { recursive: true });
  await fs.writeFile(path.join(tmpDir, "src", "server.js"), "// server");
  await fs.writeFile(path.join(tmpDir, "tests", "api.test.js"), "// test");

  const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, "init", "--scan"], {
    cwd: tmpDir,
  });

  assert.match(stdout, /Initialized new mdflow project/);
  assert.match(stdout, /Created 3 initial blocks and 1 baseline chain/);

  // Check that .mdflow/graph.json exists
  const graphJson = JSON.parse(await fs.readFile(path.join(tmpDir, ".mdflow", "graph.json"), "utf8"));
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
