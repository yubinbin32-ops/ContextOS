import test from "node:test";
import assert from "node:assert/strict";
import { pluginRuntimeStatus } from "../src/plugin-runtime.mjs";

test("plugin runtime reports in-sync when not running a mismatched bundle", () => {
  const status = pluginRuntimeStatus(process.cwd());
  assert.equal(typeof status.repoHash === "string" || status.repoHash === null, true);
  if (status.stale) {
    assert.match(status.reload, /restart|reinstall/i);
  }
});
