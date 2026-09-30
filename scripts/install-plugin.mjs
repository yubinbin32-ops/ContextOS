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
import { execFileSync } from "node:child_process";

const repoRoot = process.cwd();
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const contextosHome = process.env.CONTEXTOS_HOME || path.join(os.homedir(), ".contextos");
const pluginDir = path.join(repoRoot, "plugins", "contextos");
const bundle = path.join(pluginDir, "server", "contextos-mcp.mjs");
const skillDir = path.join(pluginDir, "skills", "contextos");
const manifestDir = path.join(pluginDir, ".codex-plugin");
const mcpConfig = path.join(pluginDir, ".mcp.json");
const checkOnly = process.argv.includes("--check");
const requestedPluginId = process.env.CONTEXTOS_PLUGIN_ID || "contextos@personal";

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
  const cacheRoot = path.join(codexHome, "plugins", "cache");
  return registeredPlugins.map((plugin) => path.join(
    cacheRoot, plugin.marketplaceName || plugin.pluginId.split("@").at(-1),
    "contextos", plugin.version
  )).filter((target) => fs.existsSync(path.join(target, "server", "contextos-mcp.mjs")));
}
function listInstalledContextosPlugins() {
  const codexBin = process.env.CONTEXTOS_CODEX_BIN || "codex";
  try {
    const output = execFileSync(codexBin, ["plugin", "list", "--json"], {
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(output);
    return (parsed.installed || []).filter((plugin) =>
      plugin.name === "contextos" && plugin.installed !== false && plugin.enabled !== false
    );
  } catch (_) {
    return [];
  }
}

function ensureCodexPluginInstalled() {
  const existing = listInstalledContextosPlugins();
  if (existing.length) return existing;
  const codexBin = process.env.CONTEXTOS_CODEX_BIN || "codex";
  try {
    execFileSync(codexBin, ["plugin", "add", requestedPluginId, "--json"], {
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || "unknown error").trim();
    throw new Error(
      `ContextOS is not registered as an installed Codex plugin. Run 'codex plugin add ${requestedPluginId}' first. ${detail}`
    );
  }
  const installed = listInstalledContextosPlugins();
  if (!installed.length) {
    throw new Error(
      `Codex accepted '${requestedPluginId}' but did not report an installed ContextOS plugin. Refusing to continue with an unverified install.`
    );
  }
  return installed;
}

function detectMcpToolDiscovery() {
  if (process.env.CONTEXTOS_TOOL_DISCOVERY_MODE) {
    return {
      ok: true,
      mode: process.env.CONTEXTOS_TOOL_DISCOVERY_MODE,
      source: "environment",
    };
  }
  const codexBin = process.env.CONTEXTOS_CODEX_BIN || "codex";
  let output;
  try {
    output = execFileSync(codexBin, ["features", "list"], {
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return { ok: false, reason: String(error?.stderr || error?.message || "could not inspect feature flags").trim() };
  }
  const lines = output.split(/\r?\n/);
  const hasToolSearch = lines.some((entry) => entry.trim().startsWith("tool_search "));
  const deferralLine = lines.find((entry) => entry.trim().startsWith("tool_search_always_defer_mcp_tools "));
  const deferralEffective = deferralLine
    ? deferralLine.trim().split(/\s+/).at(-1) === "true"
    : false;
  return {
    ok: true,
    mode: hasToolSearch || deferralEffective ? "tool_search" : "direct",
    source: "features-list",
  };
}

function findLocalSourceInstalls() {
  return registeredPlugins.map((plugin) => plugin.source?.path)
    .filter((target) => target && path.resolve(target) !== path.resolve(pluginDir) && fs.existsSync(target));
}

function shippedGrammarFiles() {
  const grammarDir = path.join(pluginDir, "grammars");
  return fs.existsSync(grammarDir) ? fs.readdirSync(grammarDir)
    .filter((name) => name.endsWith(".wasm")).map((name) => `grammars/${name}`) : [];
}

function assertInstalledMatchesBuild(plugins) {
  for (const plugin of plugins) {
    if (plugin.version !== expectedVersion) {
      throw new Error(`Installed ${plugin.pluginId} is ${plugin.version}; expected ${expectedVersion}. Run npm run plugin:install to refresh the registered version.`);
    }
    const target = path.join(codexHome, "plugins", "cache", plugin.marketplaceName || plugin.pluginId.split("@").at(-1), "contextos", plugin.version);
    for (const relative of ["server/contextos-mcp.mjs", "server/web-tree-sitter.wasm", "skills/contextos/SKILL.md", ".codex-plugin/plugin.json", ".mcp.json", ...shippedGrammarFiles()]) {
      const expected = path.join(pluginDir, relative);
      if (!fs.existsSync(expected)) continue;
      const actual = path.join(target, relative);
      if (!fs.existsSync(actual) || !fs.readFileSync(actual).equals(fs.readFileSync(expected))) {
        throw new Error(`Installed plugin differs from this build: ${actual}. Run npm run plugin:install.`);
      }
    }
  }
  const canonicalBundle = path.join(contextosHome, "server", "contextos-mcp.mjs");
  if (!fs.existsSync(canonicalBundle) || !fs.readFileSync(canonicalBundle).equals(fs.readFileSync(bundle))) {
    throw new Error(`Canonical server differs from this build: ${canonicalBundle}. Run npm run plugin:install.`);
  }
  for (const relative of ["server/web-tree-sitter.wasm", ...shippedGrammarFiles()]) {
    const expected = path.join(pluginDir, relative);
    const actual = path.join(contextosHome, relative);
    if (!fs.existsSync(expected)) {
      throw new Error(`Build parser asset is missing: ${expected}. Run npm run plugin:build.`);
    }
    if (!fs.existsSync(actual) || !fs.readFileSync(actual).equals(fs.readFileSync(expected))) {
      throw new Error(`Canonical parser asset is missing or differs from this build: ${actual}. Run npm run plugin:install.`);
    }
  }
}

const expectedVersion = JSON.parse(fs.readFileSync(path.join(manifestDir, "plugin.json"), "utf8")).version;
const registeredPlugins = checkOnly ? listInstalledContextosPlugins() : ensureCodexPluginInstalled();
if (!registeredPlugins.length) throw new Error("ContextOS is not installed/enabled. Run npm run plugin:install first.");
console.log(`✓ Codex 已注册 ContextOS 插件：${registeredPlugins.map((plugin) => plugin.pluginId).join(", ")}`);
const mcpDiscovery = detectMcpToolDiscovery();
if (!mcpDiscovery.ok) {
  throw new Error(
    "无法确认 Codex 的 MCP 工具发现模式；拒绝在未知状态下继续。"
    + ` ${mcpDiscovery.reason || "unknown error"}`
  );
}
if (mcpDiscovery.mode === "tool_search") {
  console.log("✓ ContextOS MCP discovery mode: tool_search（正式会话首轮必须先执行一次 tool_search）。");
} else {
  console.log("✓ ContextOS MCP discovery mode: direct（compact 工具应首轮可见）。");
}
console.log(`  CONTEXTOS_HOME=${contextosHome}`);
if (checkOnly) {
  assertInstalledMatchesBuild(registeredPlugins);
  console.log(`✓ ContextOS ${expectedVersion} 注册版本、插件文件与权威服务端均已核验。`);
  process.exit(0);
}

const targets = [...new Set([...findPluginInstalls(), ...findLocalSourceInstalls()])];
if (!targets.length) {
  throw new Error("未找到已安装的 ContextOS 插件缓存；拒绝在未安装状态下继续同步 bundle。");
}

for (const target of targets) {
  fs.mkdirSync(path.join(target, "server"), { recursive: true });
  fs.copyFileSync(bundle, path.join(target, "server", "contextos-mcp.mjs"));
  fs.chmodSync(path.join(target, "server", "contextos-mcp.mjs"), 0o755);
  const runtimeWasm = path.join(pluginDir, "server", "web-tree-sitter.wasm");
  if (fs.existsSync(runtimeWasm)) fs.copyFileSync(runtimeWasm, path.join(target, "server", "web-tree-sitter.wasm"));
  const grammars = path.join(pluginDir, "grammars");
  if (fs.existsSync(grammars)) copyDir(grammars, path.join(target, "grammars"));
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

const canonicalDir = path.join(contextosHome, "server");
fs.mkdirSync(canonicalDir, { recursive: true });
fs.copyFileSync(bundle, path.join(canonicalDir, "contextos-mcp.mjs"));
fs.chmodSync(path.join(canonicalDir, "contextos-mcp.mjs"), 0o755);
const runtimeWasm = path.join(pluginDir, "server", "web-tree-sitter.wasm");
if (fs.existsSync(runtimeWasm)) fs.copyFileSync(runtimeWasm, path.join(canonicalDir, "web-tree-sitter.wasm"));
const grammarDir = path.join(pluginDir, "grammars");
if (fs.existsSync(grammarDir)) copyDir(grammarDir, path.join(contextosHome, "grammars"));
console.log(`✓ 已同步权威服务端：${path.join(canonicalDir, "contextos-mcp.mjs")}`);
stripLegacyHookState(path.join(codexHome, "config.toml"));
const legacyHooksDir = path.join(contextosHome, "hooks");
for (const stale of ["contextos-hook.mjs", "contextos-hook-launcher.mjs", "runtime-policy.mjs", "host-adapters.mjs", "opencode-plugin.mjs", "HOST_ADAPTER_GUIDE.md", ".contextos-hook-manifest.json"]) {
  fs.rmSync(path.join(legacyHooksDir, stale), { force: true });
}
try {
  if (fs.existsSync(legacyHooksDir) && fs.readdirSync(legacyHooksDir).length === 0) fs.rmdirSync(legacyHooksDir);
} catch (_) {}
// Refresh registration after synchronizing the local marketplace source. Copying
// bytes into an old cache alone does not update Codex's installed-version record.
for (const plugin of registeredPlugins) {
  if (plugin.version === expectedVersion) continue;
  execFileSync(process.env.CONTEXTOS_CODEX_BIN || "codex", ["plugin", "add", plugin.pluginId, "--json"], {
    encoding: "utf8", env: { ...process.env, CODEX_HOME: codexHome }, stdio: ["ignore", "pipe", "pipe"],
  });
}
assertInstalledMatchesBuild(listInstalledContextosPlugins());
console.log(`✓ ContextOS ${expectedVersion} 已安装并通过内容一致性核验。`);
console.log("  MCP server 在会话启动时加载，需新开会话才生效。");
