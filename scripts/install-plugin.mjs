/**
 * Sync the freshly built plugin into the local Codex plugin cache(s) and the
 * canonical server location.
 *
 * Without this step the installed plugin keeps serving the bundle and SKILL.md
 * from the moment it was installed, so every "lets test the new surface" session
 * silently measures the old build.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const pluginDir = path.join(repoRoot, "plugins", "contextos");
const bundle = path.join(pluginDir, "server", "contextos-mcp.mjs");
const skillDir = path.join(pluginDir, "skills", "contextos");
const manifestDir = path.join(pluginDir, ".codex-plugin");
const mcpConfig = path.join(pluginDir, ".mcp.json");

if (!fs.existsSync(bundle)) {
  console.error("Missing bundle. Run `npm run plugin:build` first.");
  process.exit(1);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else fs.copyFileSync(source, target);
  }
}

function stripLegacyHookState(configPath) {
  if (!fs.existsSync(configPath)) return;
  const original = fs.readFileSync(configPath, "utf8");
  const cleaned = original
    .replace(/\[hooks\.state\."contextos@personal:[^"]+"\][\s\S]*?(?=\n\[|\n*$)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd() + "\n";
  if (cleaned === original) return;
  fs.copyFileSync(configPath, `${configPath}.contextos.bak`);
  fs.writeFileSync(`${configPath}.contextos.tmp`, cleaned, "utf8");
  fs.renameSync(`${configPath}.contextos.tmp`, configPath);
  console.log("✓ 已清除 Codex 中遗留的 ContextOS hook 状态。");
}

function findPluginInstalls() {
  const cacheRoot = path.join(os.homedir(), ".codex", "plugins", "cache");
  if (!fs.existsSync(cacheRoot)) return [];
  const installs = [];
  for (const marketplace of fs.readdirSync(cacheRoot)) {
    const marketplaceDir = path.join(cacheRoot, marketplace);
    if (!fs.statSync(marketplaceDir).isDirectory()) continue;
    for (const plugin of fs.readdirSync(marketplaceDir)) {
      if (!plugin.toLowerCase().includes("contextos")) continue;
      const pluginEntry = path.join(marketplaceDir, plugin);
      if (!fs.statSync(pluginEntry).isDirectory()) continue;
      for (const version of fs.readdirSync(pluginEntry)) {
        installs.push(path.join(pluginEntry, version));
      }
    }
  }
  return installs;
}

function findLocalSourceInstalls() {
  const sourceTarget = path.join(os.homedir(), "plugins", "contextos");
  return fs.existsSync(sourceTarget) ? [sourceTarget] : [];
}

const targets = [...new Set([...findPluginInstalls(), ...findLocalSourceInstalls()])];
if (!targets.length) console.log("! 未找到已安装的 ContextOS 插件缓存，跳过缓存同步。");

for (const target of targets) {
  fs.mkdirSync(path.join(target, "server"), { recursive: true });
  fs.copyFileSync(bundle, path.join(target, "server", "contextos-mcp.mjs"));
  fs.chmodSync(path.join(target, "server", "contextos-mcp.mjs"), 0o755);
  copyDir(skillDir, path.join(target, "skills", "contextos"));
  // Drop stale reference docs that the current skill no longer ships.
  const staleReferences = path.join(target, "skills", "contextos", "references");
  if (!fs.existsSync(path.join(skillDir, "references")) && fs.existsSync(staleReferences)) {
    fs.rmSync(staleReferences, { recursive: true, force: true });
  }
  copyDir(manifestDir, path.join(target, ".codex-plugin"));
  if (fs.existsSync(mcpConfig)) {
    fs.copyFileSync(mcpConfig, path.join(target, ".mcp.json"));
  }
  // Remove hook assets and experimental adapters from older installs.
  for (const stale of ["hooks.json", "scripts", "adapters"]) {
    fs.rmSync(path.join(target, stale), { recursive: true, force: true });
  }
  const assets = path.join(pluginDir, "assets");
  if (fs.existsSync(assets)) copyDir(assets, path.join(target, "assets"));
  const adapters = path.join(pluginDir, "adapters");
  if (fs.existsSync(adapters)) copyDir(adapters, path.join(target, "adapters"));
  console.log(`✓ 已同步插件缓存：${target}`);
}

const canonicalDir = path.join(os.homedir(), ".contextos", "server");
fs.mkdirSync(canonicalDir, { recursive: true });
fs.copyFileSync(bundle, path.join(canonicalDir, "contextos-mcp.mjs"));
fs.chmodSync(path.join(canonicalDir, "contextos-mcp.mjs"), 0o755);
console.log(`✓ 已同步权威服务端：${path.join(canonicalDir, "contextos-mcp.mjs")}`);
stripLegacyHookState(path.join(os.homedir(), ".codex", "config.toml"));
const legacyHooksDir = path.join(os.homedir(), ".contextos", "hooks");
for (const stale of ["contextos-hook.mjs", "contextos-hook-launcher.mjs", "runtime-policy.mjs", "host-adapters.mjs", "opencode-plugin.mjs", "HOST_ADAPTER_GUIDE.md", ".contextos-hook-manifest.json"]) {
  fs.rmSync(path.join(legacyHooksDir, stale), { force: true });
}
try {
  if (fs.existsSync(legacyHooksDir) && fs.readdirSync(legacyHooksDir).length === 0) fs.rmdirSync(legacyHooksDir);
} catch (_) {}
console.log("  MCP server 在会话启动时加载，需新开会话才生效。");
