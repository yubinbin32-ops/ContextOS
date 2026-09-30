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
import { createHash } from "node:crypto";

const repoRoot = process.cwd();
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const contextosHome = process.env.CONTEXTOS_HOME || path.join(os.homedir(), ".contextos");
const pluginDir = path.join(repoRoot, "plugins", "contextos");
const bundle = path.join(pluginDir, "server", "contextos-mcp.mjs");
const skillsDir = path.join(pluginDir, "skills");
const skillNames = fs.readdirSync(skillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, "SKILL.md")))
  .map((entry) => entry.name)
  .sort();
if (!skillNames.includes("contextos")) {
  throw new Error(`Missing required skill: ${path.join(skillsDir, "contextos", "SKILL.md")}`);
}

// AGY parses skill frontmatter with strict YAML. An unquoted colon inside a
// scalar (e.g. `description: Required scaffold: use this`) is rejected and the
// skill is silently dropped from the session, so validate before installing.
function assertSkillFrontmatter() {
  for (const skillName of skillNames) {
    const skillFile = path.join(skillsDir, skillName, "SKILL.md");
    const raw = fs.readFileSync(skillFile, "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
    if (!match) throw new Error(`Skill ${skillFile} has no YAML frontmatter block.`);
    const lines = match[1].split(/\r?\n/);
    let name = null;
    let description = null;
    let blockScalar = false;
    for (const line of lines) {
      const nameMatch = /^name:\s*(.+)$/.exec(line);
      if (nameMatch) { name = nameMatch[1].trim(); continue; }
      const descriptionMatch = /^description:\s*(.*)$/.exec(line);
      if (!descriptionMatch) continue;
      const value = descriptionMatch[1].trim();
      if (value === "" || /^[>|][+-]?$/.test(value)) { blockScalar = true; continue; }
      const quoted = (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"));
      if (!quoted && value.includes(": ")) {
        throw new Error(`Skill ${skillFile} has an unquoted ': ' in its description; AGY's strict YAML parser rejects it. Quote the description.`);
      }
      description = value;
    }
    if (!name) throw new Error(`Skill ${skillFile} is missing a frontmatter name.`);
    if (name !== skillName) throw new Error(`Skill ${skillFile} declares name '${name}' but lives in '${skillName}'.`);
    if (!description && !blockScalar) throw new Error(`Skill ${skillFile} is missing a frontmatter description.`);
  }
}
assertSkillFrontmatter();

function assertCliSkillLogClean(home) {
  const logDir = path.join(home, ".gemini", "antigravity-cli", "log");
  let logs = [];
  try {
    logs = fs.readdirSync(logDir).filter((name) => /^cli-.*\.log$/.test(name)).sort().slice(-5);
  } catch (_) {
    return;
  }
  for (const name of logs) {
    let text = "";
    try { text = fs.readFileSync(path.join(logDir, name), "utf8"); } catch (_) { continue; }
    const failures = text.split(/\r?\n/).filter((line) => line.includes("Failed to parse skill file") && /contextos/i.test(line));
    if (failures.length) {
      throw new Error(`AGY failed to parse the ContextOS skill (${name}): ${failures[0].trim()}. Reinstall after fixing the frontmatter.`);
    }
  }
}
const manifestDir = path.join(pluginDir, ".codex-plugin");
const mcpConfig = path.join(pluginDir, ".mcp.json");
const checkOnly = process.argv.includes("--check");
const checkRuntime = process.argv.includes("--runtime-check");
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

function syncDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  const sourceNames = new Set(fs.readdirSync(from));
  for (const entry of fs.readdirSync(to, { withFileTypes: true })) {
    if (!sourceNames.has(entry.name)) fs.rmSync(path.join(to, entry.name), { recursive: true, force: true });
  }
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    const destinationStat = fs.existsSync(target) ? fs.lstatSync(target) : null;
    if (entry.isDirectory()) {
      if (destinationStat && !destinationStat.isDirectory()) fs.rmSync(target, { force: true });
      syncDir(source, target);
    } else {
      if (destinationStat?.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
      fs.copyFileSync(source, target);
    }
  }
}

function relativeFiles(root, current = root) {
  return fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(current, entry.name);
    return entry.isDirectory()
      ? relativeFiles(root, target)
      : [path.relative(root, target)];
  }).sort();
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

function configureCodexMcpEnv(configPath, env) {
  if (!fs.existsSync(configPath)) return;
  let content = fs.readFileSync(configPath, "utf8");
  const lines = content.split("\n");
  const isHeader = (line) => /^\[\[?[^\]]+\]\]?$/.test(line.trim());
  const baseIndex = lines.findIndex((line) => line.trim() === "[mcp_servers.contextos]");
  const firstEnvIndex = lines.findIndex((line) => line.trim() === "[mcp_servers.contextos.env]");
  if (baseIndex === -1 && firstEnvIndex === -1) return;
  // Collect the base table and every env table, wherever they appear. Earlier
  // writers could leave an orphaned env table, and TOML rejects duplicates.
  const removed = new Set();
  const envLines = new Map();
  let baseBody = "";
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed === "[mcp_servers.contextos]") {
      let end = index + 1;
      while (end < lines.length && !isHeader(lines[end])) end += 1;
      for (let cursor = index; cursor < end; cursor += 1) removed.add(cursor);
      baseBody = lines.slice(index + 1, end).join("\n").replace(/\n+$/, "");
      continue;
    }
    if (trimmed !== "[mcp_servers.contextos.env]") continue;
    let end = index + 1;
    while (end < lines.length && !isHeader(lines[end])) end += 1;
    for (let cursor = index; cursor < end; cursor += 1) removed.add(cursor);
    for (const line of lines.slice(index + 1, end)) {
      const match = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line.trim());
      if (match) envLines.set(match[1], match[2].trim());
    }
    index = end - 1;
  }
  for (const [key, value] of Object.entries(env)) envLines.set(key, JSON.stringify(value));
  const renderedEnv = [...envLines].map(([key, value]) => `${key} = ${value}`).join("\n");
  const contextosStart = Math.min(...[baseIndex, firstEnvIndex].filter((index) => index !== -1));
  const updated = `[mcp_servers.contextos]${baseBody ? `\n${baseBody}` : ""}\n\n[mcp_servers.contextos.env]\n${renderedEnv}\n\n`;
  const output = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (index === contextosStart) output.push(updated);
    if (removed.has(index)) continue;
    output.push(lines[index]);
  }
  if (contextosStart >= lines.length) output.push(updated);
  content = output.join("\n").replace(/\n{3,}/g, "\n\n");
  fs.writeFileSync(configPath, content.endsWith("\n") ? content : `${content}\n`);
  console.log(`✓ 已写入 Codex MCP 环境变量：${Object.keys(env).join(", ")}`);
}

function syncCliAgentSkills() {
  const home = process.env.CONTEXTOS_CLI_HOME || os.homedir();
  const canonicalSkills = path.join(home, ".gemini", "antigravity-cli", "skills");
  const legacySkills = path.join(home, ".gemini", "config", "skills");
  const legacyConfig = path.join(home, ".gemini", "config", "mcp_config.json");
  const targets = [canonicalSkills, ...(fs.existsSync(legacySkills) || fs.existsSync(legacyConfig) ? [legacySkills] : [])];
  const synced = [];
  for (const targetRoot of targets) {
    for (const skillName of skillNames) {
      syncDir(path.join(skillsDir, skillName), path.join(targetRoot, skillName));
    }
    synced.push(targetRoot);
  }
  if (fs.existsSync(legacyConfig)) {
    const parsed = JSON.parse(fs.readFileSync(legacyConfig, "utf8"));
    const server = parsed?.mcpServers?.contextos;
    if (server) {
      let changed = false;
      if (server.env?.CONTEXTOS_LEAN_SURFACE !== undefined) {
        delete server.env.CONTEXTOS_LEAN_SURFACE;
        if (Object.keys(server.env).length === 0) delete server.env;
        changed = true;
      }
      const expectedArgs = ["--no-warnings=ExperimentalWarning", path.join(contextosHome, "server", "contextos-mcp.mjs")];
      if (JSON.stringify(server.args) !== JSON.stringify(expectedArgs)) {
        server.args = expectedArgs;
        changed = true;
      }
      if (typeof server.command !== "string" || !fs.existsSync(server.command)) {
        server.command = process.execPath;
        changed = true;
      }
      if (changed) {
        fs.writeFileSync(legacyConfig, `${JSON.stringify(parsed, null, 2)}\n`);
        console.log(`✓ 已刷新 CLI 的 ContextOS MCP 注册：${legacyConfig}`);
      }
    }
  }
  if (checkRuntime) assertCliSkillLogClean(home);
  const cliSettings = path.join(home, ".gemini", "antigravity-cli", "settings.json");
  if (fs.existsSync(cliSettings)) {
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(cliSettings, "utf8")); } catch (_) { settings = {}; }
    settings.permissions = settings.permissions && typeof settings.permissions === "object" ? settings.permissions : {};
    const allow = new Set(Array.isArray(settings.permissions.allow) ? settings.permissions.allow : []);
    if (!allow.has("mcp(contextos/contextos)")) {
      allow.add("mcp(contextos/contextos)");
      settings.permissions.allow = [...allow];
      fs.writeFileSync(cliSettings, `${JSON.stringify(settings, null, 2)}\n`);
      console.log(`✓ 已授予 CLI 的 ContextOS MCP 权限：${cliSettings}`);
    }
  }
  syncGlobalCliPermissions();
  syncCliMcpMetadata(home);
  if (synced.length) console.log(`✓ 已同步 CLI Skill：${synced.join(", ")}`);
}

function assertCliSkillParity() {
  const home = process.env.CONTEXTOS_CLI_HOME || os.homedir();
  const roots = [
    path.join(home, ".gemini", "antigravity-cli", "skills"),
    path.join(home, ".gemini", "config", "skills"),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const skillName of skillNames) {
      const expectedDir = path.join(skillsDir, skillName);
      const actualDir = path.join(root, skillName);
      const expectedFiles = relativeFiles(expectedDir);
      const actualFiles = fs.existsSync(actualDir) ? relativeFiles(actualDir) : [];
      if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
        throw new Error(`CLI skill tree differs from canonical: ${actualDir}. Run npm run plugin:install.`);
      }
      for (const relative of expectedFiles) {
        const expected = path.join(expectedDir, relative);
        const actual = path.join(actualDir, relative);
        if (!fs.readFileSync(actual).equals(fs.readFileSync(expected))) {
          throw new Error(`CLI skill content differs from canonical: ${actual}. Run npm run plugin:install.`);
        }
      }
    }
  }
}

function syncRuntimeSkills() {
  const runtimeSkills = path.join(contextosHome, "skills");
  for (const skillName of skillNames) {
    syncDir(path.join(skillsDir, skillName), path.join(runtimeSkills, skillName));
  }
  return runtimeSkills;
}

function assertRuntimeSkillParity() {
  const runtimeSkills = path.join(contextosHome, "skills");
  for (const skillName of skillNames) {
    const expectedDir = path.join(skillsDir, skillName);
    const actualDir = path.join(runtimeSkills, skillName);
    const expectedFiles = relativeFiles(expectedDir);
    const actualFiles = fs.existsSync(actualDir) ? relativeFiles(actualDir) : [];
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
      throw new Error(`Runtime skill tree differs from canonical: ${actualDir}. Run npm run plugin:install.`);
    }
    for (const relative of expectedFiles) {
      const expected = path.join(expectedDir, relative);
      const actual = path.join(actualDir, relative);
      if (!fs.readFileSync(actual).equals(fs.readFileSync(expected))) {
        throw new Error(`Runtime skill content differs from canonical: ${actual}. Run npm run plugin:install.`);
      }
    }
  }
}

function syncGlobalCliPermissions() {
  const profilePath = path.join(contextosHome, "profile.json");
  if (!fs.existsSync(profilePath)) return;
  let profile;
  try {
    profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse ContextOS profile ${profilePath}: ${error.message}`);
  }
  const adapter = profile?.agents?.adapters?.agy;
  if (!adapter || !Array.isArray(adapter.args)) return;
  const next = [];
  for (let index = 0; index < adapter.args.length; index += 1) {
    const arg = adapter.args[index];
    if (arg === "--disable-slash-commands" || arg === "--sandbox") continue;
    if (arg === "--effort") { index += 1; continue; }
    next.push(arg);
  }
  if (!next.includes("--dangerously-skip-permissions")) next.push("--dangerously-skip-permissions");
  if (JSON.stringify(next) === JSON.stringify(adapter.args)) return;
  adapter.args = next;
  fs.writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { mode: fs.statSync(profilePath).mode & 0o777 });
  console.log(`✓ 已预配置 AGY 全量工具权限：${profilePath}`);
}

function mcpEntryForConfig(parsed) {
  const nested = parsed?.mcpServers?.contextos;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && typeof parsed.command === "string" && Array.isArray(parsed.args)) return parsed;
  return null;
}

function syncMcpMetadata(configPath, version, buildHash) {
  if (!fs.existsSync(configPath)) return false;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse MCP config ${configPath}: ${error.message}`);
  }
  const entry = mcpEntryForConfig(parsed);
  if (!entry) return false;
  let changed = false;
  if (entry._version !== version) {
    entry._version = version;
    changed = true;
  }
  if (entry._build !== undefined && entry._build !== buildHash) {
    entry._build = buildHash;
    changed = true;
  }
  if (!changed) return false;
  fs.writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
  console.log(`✓ 已刷新 MCP 版本元数据：${configPath}`);
  return true;
}

function assertMcpMetadata(configPath, version, buildHash) {
  if (!fs.existsSync(configPath)) return;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse MCP config ${configPath}: ${error.message}`);
  }
  const entry = mcpEntryForConfig(parsed);
  if (!entry || entry._version === undefined) return;
  if (entry._version !== version) {
    throw new Error(`MCP config ${configPath} reports version ${entry._version}; expected ${version}. Run npm run plugin:install.`);
  }
  if (entry._build !== undefined && entry._build !== buildHash) {
    throw new Error(`MCP config ${configPath} reports a stale build hash. Run npm run plugin:install.`);
  }
}

function cliMcpMetadataPaths(home = process.env.CONTEXTOS_CLI_HOME || os.homedir()) {
  return [
    path.join(home, ".gemini", "config", "mcp_config.json"),
    path.join(home, ".gemini", "antigravity-cli", "mcp_config.json"),
    path.join(contextosHome, "mcp.json"),
    path.join(repoRoot, ".agents", "mcp_config.json"),
  ];
}

function syncCliMcpMetadata(home) {
  for (const configPath of cliMcpMetadataPaths(home)) {
    syncMcpMetadata(configPath, expectedVersion, expectedBuild);
  }
}

function assertCliMcpMetadata(home) {
  for (const configPath of cliMcpMetadataPaths(home)) {
    assertMcpMetadata(configPath, expectedVersion, expectedBuild);
  }
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
    const skillFiles = [];
    for (const skillName of skillNames) {
      const expectedSkillFiles = relativeFiles(path.join(skillsDir, skillName));
      const installedSkillDir = path.join(target, "skills", skillName);
      const installedSkillFiles = fs.existsSync(installedSkillDir) ? relativeFiles(installedSkillDir) : [];
      if (JSON.stringify(installedSkillFiles) !== JSON.stringify(expectedSkillFiles)) {
        throw new Error(`Installed skill tree is missing or has stale files: ${installedSkillDir}. Run npm run plugin:install.`);
      }
      skillFiles.push(...expectedSkillFiles.map((relative) => path.join("skills", skillName, relative)));
    }
    for (const relative of ["server/contextos-mcp.mjs", "server/web-tree-sitter.wasm", ".codex-plugin/plugin.json", ".mcp.json", ...skillFiles, ...shippedGrammarFiles()]) {
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
const expectedBuild = createHash("sha256").update(fs.readFileSync(bundle)).digest("hex");
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
  assertCliMcpMetadata();
  assertCliSkillParity();
  assertRuntimeSkillParity();
  console.log(`✓ ContextOS ${expectedVersion} 注册版本和安装文件已核验。`);
  if (checkRuntime) {
    const { probeRuntime } = await import('./runtime-admission.mjs');
    const runtime = await probeRuntime({
      command: process.execPath,
      args: ['--no-warnings=ExperimentalWarning', path.join(contextosHome, 'server/contextos-mcp.mjs')],
      env: { CONTEXTOS_HOME: contextosHome },
      expectedVersion,
      timeoutMs: 5000,
    });
    if (!runtime.ok) throw new Error(`Fresh MCP runtime rejected: ${runtime.errors.join('; ')}`);
    console.log(`✓ 新进程 MCP ${runtime.version}: ${runtime.toolNames.join(', ')}（单工具）。`);
  }
  console.log('当前对话可能仍缓存旧 MCP；文件同步或新进程检查不代表已重载。若仍看到旧七工具，请重新连接或新开会话。');
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
  for (const skillName of skillNames) {
    syncDir(path.join(skillsDir, skillName), path.join(target, "skills", skillName));
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
const runtimeSkills = syncRuntimeSkills();
assertRuntimeSkillParity();
console.log(`✓ 已同步运行时 Skill：${runtimeSkills}`);
stripLegacyHookState(path.join(codexHome, "config.toml"));
configureCodexMcpEnv(path.join(codexHome, "config.toml"), { CONTEXTOS_TEXT_ONLY_RESULTS: "1" });
syncCliAgentSkills();
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
assertCliMcpMetadata();
assertCliSkillParity();
console.log(`✓ ContextOS ${expectedVersion} 已安装并通过内容一致性核验。`);
console.log("  MCP server 在会话启动时加载，需新开会话才生效。");
