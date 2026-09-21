/**
 * Shared throwaway project fixture for the V3 smoke test, the plugin smoke test
 * and the development-flow simulation.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MATH_SOURCE = `export function add(a, b) {
  return a + b;
}

export function sub(a, b) {
  return a - b;
}
`;

const STRINGS_SOURCE = `export function greet(name) {
  return \`hello \${name}\`;
}
`;

const TEST_SOURCE = `import assert from "node:assert/strict";
import test from "node:test";
import { add, sub } from "../src/math.mjs";
import { greet } from "../src/strings.mjs";

test("add", () => {
  assert.equal(add(1, 2), 3);
});

test("sub", () => {
  assert.equal(sub(5, 3), 2);
});

test("greet", () => {
  assert.equal(greet("ada"), "hello ada");
});
`;

export function createFixtureProject({ prefix = "ctxos-fixture", withTests = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      { name: "fixture", version: "0.0.0", scripts: withTests ? { test: "node --test test/*.test.mjs" } : {} },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(root, "src", "math.mjs"), MATH_SOURCE);
  fs.writeFileSync(path.join(root, "src", "strings.mjs"), STRINGS_SOURCE);
  if (withTests) {
    fs.mkdirSync(path.join(root, "test"), { recursive: true });
    fs.writeFileSync(path.join(root, "test", "math.test.mjs"), TEST_SOURCE);
  }
  try {
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  } catch (_) {}

  return {
    root,
    read: (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8"),
    write: (relativePath, content) => fs.writeFileSync(path.join(root, relativePath), content, "utf8"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
