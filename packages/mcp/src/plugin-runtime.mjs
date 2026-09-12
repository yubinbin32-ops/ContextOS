import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function hashFile(filePath) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

export function pluginRuntimeStatus(projectRoot = process.cwd()) {
  const runningPath = process.argv[1] ? path.resolve(process.argv[1]) : fileURLToPath(import.meta.url);
  const repoBundle = path.join(projectRoot, "plugins/contextos/server/contextos-mcp.mjs");
  const runningHash = hashFile(runningPath);
  const repoHash = hashFile(repoBundle);
  const runningIsBundle = path.basename(runningPath) === "contextos-mcp.mjs";
  const stale = Boolean(runningIsBundle && runningHash && repoHash && runningHash !== repoHash);
  return {
    runningPath,
    repoBundle,
    runningHash,
    repoHash,
    stale,
    reload: stale
      ? "Restart the editor or reinstall ContextOS from the configured plugin marketplace"
      : null,
  };
}
