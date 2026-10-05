import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const HOME = os.homedir();
const contextosHome = path.resolve(process.env.CONTEXTOS_HOME || path.join(HOME, '.contextos'));
const codexHome = path.resolve(process.env.CODEX_HOME || path.join(HOME, '.codex'));

export function deriveProjectId(projectRoot) {
  const baseName = path.basename(path.resolve(projectRoot || process.cwd())).trim();
  const slug = baseName.toLowerCase().replace(/ +/g, '-');
  return slug || 'contextos';
}

export function resolveNodeExecutable() {
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const candidates = [process.execPath];

  if (isWin) {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || path.join(HOME, 'AppData\\Local');
    const appData = process.env.APPDATA || path.join(HOME, 'AppData\\Roaming');
    candidates.push(
      path.join(programFiles, 'nodejs\\node.exe'),
      path.join(programFilesX86, 'nodejs\\node.exe'),
      path.join(appData, 'nvm\\current\\node.exe'),
      path.join(localAppData, 'Programs\\node\\node.exe'),
      path.join(localAppData, 'ContextOS\\bin\\node.exe')
    );
  } else if (isMac) {
    candidates.push(
      '/Applications/ContextOS.app/Contents/Resources/bin/node',
      path.join(HOME, 'Applications/ContextOS.app/Contents/Resources/bin/node'),
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
      path.join(HOME, '.nvm/current/bin/node'),
      '/usr/bin/node'
    );
  } else {
    // Linux / other Unix
    candidates.push(
      '/usr/bin/node',
      '/usr/local/bin/node',
      '/snap/bin/node',
      path.join(HOME, '.nvm/current/bin/node'),
      path.join(HOME, '.local/share/nvm/current/bin/node'),
      path.join(HOME, '.local/bin/node')
    );
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch (_) {}
    }
  }
  throw new Error('Unable to locate an executable Node.js runtime. Install Node.js 22+ or use the full ContextOS edition.');
}

function resolveCodexExecutable() {
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const candidates = [process.env.CONTEXTOS_CODEX_BIN];

  if (isWin) {
    const localAppData = process.env.LOCALAPPDATA || path.join(HOME, 'AppData\\Local');
    candidates.push(
      path.join(localAppData, 'Programs\\Codex\\codex.exe'),
      path.join(HOME, '.cargo\\bin\\codex.exe')
    );
  } else if (isMac) {
    candidates.push(
      '/Applications/Codex.app/Contents/Resources/codex',
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      path.join(HOME, 'Applications/Codex.app/Contents/Resources/codex'),
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      path.join(HOME, '.cargo/bin/codex'),
      path.join(HOME, '.local/bin/codex')
    );
  } else {
    candidates.push(
      '/usr/bin/codex',
      '/usr/local/bin/codex',
      path.join(HOME, '.cargo/bin/codex'),
      path.join(HOME, '.local/bin/codex')
    );
  }

  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      try {
        fs.accessSync(c, fs.constants.X_OK);
        return c;
      } catch (_) {}
    }
  }
  return null;
}

export function deployCanonicalServer(sourceScriptPath = null) {
  const canonicalDir = path.join(contextosHome, 'server');
  const canonicalScript = path.join(canonicalDir, 'contextos-mcp.mjs');
  fs.mkdirSync(canonicalDir, { recursive: true });

  const candidates = [
    sourceScriptPath,
    '/Applications/ContextOS.app/Contents/Resources/server/contextos-mcp.mjs',
    path.join(HOME, 'Applications/ContextOS.app/Contents/Resources/server/contextos-mcp.mjs'),
  ].filter(Boolean);

  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error('Cannot locate the ContextOS MCP server bundle. Install the app or pass a valid source script path.');
  }
  if (path.resolve(found) !== path.resolve(canonicalScript)) {
    const tempPath = `${canonicalScript}.contextos-${process.pid}-${randomUUID()}.tmp`;
    fs.copyFileSync(found, tempPath);
    fs.renameSync(tempPath, canonicalScript);
  }
  // Portable parser assets are part of the runtime, not optional repo dependencies.
  const runtimeWasm = path.join(path.dirname(found), 'web-tree-sitter.wasm');
  if (fs.existsSync(runtimeWasm) && path.resolve(runtimeWasm) !== path.join(canonicalDir, 'web-tree-sitter.wasm')) {
    const tempWasm = path.join(canonicalDir, `web-tree-sitter.wasm.${randomUUID()}.tmp`);
    fs.copyFileSync(runtimeWasm, tempWasm);
    fs.renameSync(tempWasm, path.join(canonicalDir, 'web-tree-sitter.wasm'));
  }
  const grammarSource = path.resolve(path.dirname(found), '..', 'grammars');
  const grammarTarget = path.join(contextosHome, 'grammars');
  if (fs.existsSync(grammarSource) && grammarSource !== grammarTarget) {
    replaceDirectoryAtomically(grammarSource, grammarTarget);
  }
  return canonicalScript;
}

export function antigravitySkillPaths(home = HOME) {
  const paths = [path.join(home, '.gemini', 'antigravity-cli', 'skills', 'contextos')];
  const legacy = path.join(home, '.gemini', 'config', 'skills', 'contextos');
  if (fs.existsSync(legacy)) paths.push(legacy);
  return paths;
}

function copyDirectoryRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const backupPath = `${filePath}.contextos.bak`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function writeFileAtomic(filePath, content, mode = null) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  backupFile(filePath);
  const tempPath = `${filePath}.contextos-${process.pid}-${randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: mode ?? 0o644 });
  if (mode !== null) fs.chmodSync(tempPath, mode);
  fs.renameSync(tempPath, filePath);
}

function readJsonObject(filePath, label) {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('root value must be an object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`Refusing to overwrite invalid JSON at '${filePath}' (${label}): ${error.message}`);
  }
}

export function mergePersonalMarketplaceDocument(parsed) {
  let marketplaces = [];
  let marketplaceWasArray = false;
  if (Array.isArray(parsed)) {
    marketplaces = parsed;
    marketplaceWasArray = true;
  } else if (parsed && typeof parsed === 'object') {
    // A clean install passes {}: do not emit an invalid [{}, personal] catalog.
    marketplaces = Object.keys(parsed).length ? [parsed] : [];
  } else {
    throw new Error('Marketplace root must be an object or array');
  }
  const existingPersonal = marketplaces.find((entry) => entry?.name === 'personal');
  const existingPlugins = Array.isArray(existingPersonal?.plugins) ? existingPersonal.plugins : [];
  const contextosEntry = {
    name: 'contextos',
    source: { source: 'local', path: './plugins/contextos' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Productivity',
  };
  const mergedPlugins = existingPlugins.filter((plugin) => plugin?.name !== 'contextos');
  mergedPlugins.push(contextosEntry);
  const personalEntry = {
    ...(existingPersonal || {}),
    name: 'personal',
    interface: existingPersonal?.interface || { displayName: 'Personal' },
    plugins: mergedPlugins,
  };
  const filtered = marketplaces.filter((m) => m?.name !== 'personal');
  filtered.push(personalEntry);
  return marketplaceWasArray || filtered.length > 1 ? filtered : filtered[0];
}

function replaceDirectoryAtomically(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`Plugin source does not exist: '${source}'`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const token = `${process.pid}-${randomUUID()}`;
  const tempDestination = `${destination}.contextos-${token}.tmp`;
  const backupDestination = `${destination}.contextos-${token}.bak`;
  copyDirectoryRecursive(source, tempDestination);
  let movedExisting = false;
  try {
    if (fs.existsSync(destination)) {
      fs.renameSync(destination, backupDestination);
      movedExisting = true;
    }
    fs.renameSync(tempDestination, destination);
    if (movedExisting) fs.rmSync(backupDestination, { recursive: true, force: true });
  } catch (error) {
    try {
      if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
      if (movedExisting && fs.existsSync(backupDestination)) fs.renameSync(backupDestination, destination);
    } catch (_) {}
    try { fs.rmSync(tempDestination, { recursive: true, force: true }); } catch (_) {}
    throw error;
  }
}

export function configureJsonMcp({ configPath, serverScript, nodePath, env = null, version = null }) {
  const json = readJsonObject(configPath, 'MCP config');
  json.mcpServers = json.mcpServers && typeof json.mcpServers === 'object' && !Array.isArray(json.mcpServers)
    ? json.mcpServers
    : {};
  const serverEntry = {
    command: nodePath,
    args: ['--no-warnings=ExperimentalWarning', serverScript],
  };
  if (version) serverEntry._version = version;

  if (env && Object.keys(env).length > 0) {
    serverEntry.env = env;
  }

  json.mcpServers.contextos = serverEntry;
  writeFileAtomic(configPath, JSON.stringify(json, null, 2) + '\n');
  return true;
}

export function configureOpenCodeMcp({ configPath, serverScript, nodePath, env = null, version = null }) {
  const json = readJsonObject(configPath, 'OpenCode config');
  json.$schema = json.$schema || 'https://opencode.ai/config.json';
  json.mcp = json.mcp && typeof json.mcp === 'object' && !Array.isArray(json.mcp) ? json.mcp : {};
  const entry = {
    type: 'local',
    command: [nodePath, '--no-warnings=ExperimentalWarning', serverScript],
    enabled: true,
  };
  if (version) entry._version = version;
  if (env && Object.keys(env).length > 0) entry.environment = env;
  json.mcp.contextos = entry;
  writeFileAtomic(configPath, JSON.stringify(json, null, 2) + '\n');
  return true;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

export function configureTomlCodex({ configPath, serverScript, nodePath, env = null }) {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });

  let content = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';

  const sectionHeader = '[mcp_servers.contextos]';
  const startIndex = content.indexOf(sectionHeader);
  if (startIndex !== -1) {
    const nextSectionIndex = content.indexOf('\n[', startIndex + sectionHeader.length);
    if (nextSectionIndex !== -1) {
      content = content.slice(0, startIndex) + content.slice(nextSectionIndex + 1);
    } else {
      content = content.slice(0, startIndex);
    }
  }

  content = content.trimEnd();
  let tomlBlock = `\n\n[mcp_servers.contextos]\ncommand = ${tomlString(nodePath)}\nargs = ["--no-warnings=ExperimentalWarning", ${tomlString(serverScript)}]\n`;
  if (env && Object.keys(env).length > 0) {
    tomlBlock += `[mcp_servers.contextos.env]\n`;
    for (const [k, v] of Object.entries(env)) {
      tomlBlock += `${k} = ${tomlString(v)}\n`;
    }
  }

  fs.writeFileSync(`${configPath}.contextos.tmp`, (content + tomlBlock).trim() + '\n', 'utf8');
  backupFile(configPath);
  fs.renameSync(`${configPath}.contextos.tmp`, configPath);
}

export function cleanTomlCodex({ configPath }) {
  if (!fs.existsSync(configPath)) return;
  let content = fs.readFileSync(configPath, 'utf8');
  const mcpRegex = /\[mcp_servers\.contextos(?:\.[^\]]+)?\][\s\S]*?(?=\n\[|\n*$)/g;
  const hookRegex = /\[hooks\.state\."contextos@personal:[^"]+"\][\s\S]*?(?=\n\[|\n*$)/g;
  content = content.replace(mcpRegex, '').replace(hookRegex, '').replace(/\n{3,}/g, '\n\n');
  writeFileAtomic(configPath, content.trim() + '\n');
}

function installCodexPlugin({ serverScript, nodePath, env = null, pluginSource = null, skillSource = null }) {
  const userPluginsContextOS = path.join(HOME, 'plugins', 'contextos');
  const personalMarketplaceDir = path.join(HOME, '.agents', 'plugins');
  const personalMarketplaceURL = path.join(personalMarketplaceDir, 'marketplace.json');
  const codexConfigURL = path.join(codexHome, 'config.toml');

  // 1. Sync official plugin bundle to ~/plugins/contextos
  if (pluginSource && fs.existsSync(pluginSource)) {
    replaceDirectoryAtomically(pluginSource, userPluginsContextOS);
  } else if (!fs.existsSync(userPluginsContextOS)) {
    fs.mkdirSync(path.join(userPluginsContextOS, '.codex-plugin'), { recursive: true });
    fs.mkdirSync(path.join(userPluginsContextOS, 'server'), { recursive: true });
    fs.copyFileSync(serverScript, path.join(userPluginsContextOS, 'server', 'contextos-mcp.mjs'));
  }

  // 2. Ensure marketplace.json has personal marketplace with contextos
  fs.mkdirSync(personalMarketplaceDir, { recursive: true });
  let parsedMarketplace = null;
  if (fs.existsSync(personalMarketplaceURL)) {
    try {
      parsedMarketplace = JSON.parse(fs.readFileSync(personalMarketplaceURL, 'utf8'));
    } catch (error) {
      throw new Error(`Refusing to overwrite invalid marketplace JSON at '${personalMarketplaceURL}': ${error.message}`);
    }
  }
  const output = mergePersonalMarketplaceDocument(parsedMarketplace ?? {});
  writeFileAtomic(personalMarketplaceURL, JSON.stringify(output, null, 2) + '\n');

  // Codex marketplace commands require their configuration home to exist.
  fs.mkdirSync(codexHome, { recursive: true });
  // 3. Attempt official codex CLI plugin add
  const codexBin = resolveCodexExecutable();
  let installedViaCli = false;
  if (codexBin) {
    try {
      // Current CLI versions require registering a marketplace source first.
      // Older versions may auto-discover the personal catalog and lack this subcommand.
      try { execFileSync(codexBin, ['plugin', 'marketplace', 'add', HOME, '--json'], { stdio: 'pipe' }); } catch (_) {}
      try { execFileSync(codexBin, ['plugin', 'remove', 'contextos@personal', '--json'], { stdio: 'ignore' }); } catch (_) {}
      execFileSync(codexBin, ['plugin', 'add', 'contextos@personal', '--json'], { stdio: 'pipe' });
      installedViaCli = true;
    } catch (_) {}
  }

  // 4. Fallback or clean up TOML (guarantee zero redundant skill/server definitions)
  if (!installedViaCli) {
    configureTomlCodex({ configPath: codexConfigURL, serverScript, nodePath, env });
    // CLI versions without plugins still need both operational skills.
    if (skillSource && fs.existsSync(skillSource)) {
      const skillRoot = path.join(HOME, '.agents', 'skills');
      for (const name of ['contextos', 'contextos-ops']) {
        const source = path.join(path.dirname(skillSource), name);
        if (fs.existsSync(source)) replaceDirectoryAtomically(source, path.join(skillRoot, name));
      }
    }
    return 'Codex (config.toml MCP + local skills)';
  } else {
    cleanTomlCodex({ configPath: codexConfigURL });
    return 'Codex (Official Plugin & Skill)';
  }
}

export function detectInstalledPlatforms() {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  const platforms = [];

  const localAppData = isWin ? (process.env.LOCALAPPDATA || path.join(HOME, 'AppData\\Local')) : '';
  const appData = isWin ? (process.env.APPDATA || path.join(HOME, 'AppData\\Roaming')) : '';

  // 1. Claude Desktop
  let claudeConfigPath = '';
  if (isMac) {
    claudeConfigPath = path.join(HOME, 'Library/Application Support/Claude/claude_desktop_config.json');
  } else if (isWin) {
    claudeConfigPath = path.join(appData, 'Claude\\claude_desktop_config.json');
  } else {
    claudeConfigPath = path.join(HOME, '.config/Claude/claude_desktop_config.json');
  }
  let claudeAppExists = false;
  if (isMac) {
    claudeAppExists =
      fs.existsSync('/Applications/Claude.app') ||
      fs.existsSync(path.join(HOME, 'Applications/Claude.app')) ||
      fs.existsSync(path.dirname(claudeConfigPath));
  } else if (isWin) {
    claudeAppExists =
      fs.existsSync(path.join(localAppData, 'Programs\\Claude\\Claude.exe')) ||
      fs.existsSync(path.dirname(claudeConfigPath));
  } else {
    claudeAppExists =
      fs.existsSync('/usr/bin/claude') ||
      fs.existsSync('/snap/bin/claude') ||
      fs.existsSync(path.dirname(claudeConfigPath));
  }
  platforms.push({
    id: 'claude',
    name: 'Claude Desktop',
    isInstalled: claudeAppExists,
    configPath: claudeConfigPath,
    type: 'json',
  });

  // 2. Claude Code
  const claudeCodeDir = path.join(HOME, '.claude');
  const claudeCodeConfigPath = path.join(HOME, '.claude.json');
  const claudeCodeAppExists = fs.existsSync(claudeCodeDir) || fs.existsSync(claudeCodeConfigPath)
    || fs.existsSync('/usr/bin/claude') || fs.existsSync('/usr/local/bin/claude');
  platforms.push({
    id: 'claude-code',
    name: 'Claude Code',
    isInstalled: claudeCodeAppExists,
    configPath: claudeCodeConfigPath,
    type: 'claude-code',
  });

  // 2. Cursor
  const cursorDir = path.join(HOME, '.cursor');
  let cursorAppExists = false;
  if (isMac) {
    cursorAppExists =
      fs.existsSync('/Applications/Cursor.app') ||
      fs.existsSync(path.join(HOME, 'Applications/Cursor.app')) ||
      fs.existsSync(cursorDir);
  } else if (isWin) {
    cursorAppExists =
      fs.existsSync(path.join(localAppData, 'Programs\\cursor\\Cursor.exe')) ||
      fs.existsSync(cursorDir);
  } else {
    cursorAppExists =
      fs.existsSync('/usr/bin/cursor') ||
      fs.existsSync('/opt/Cursor/cursor') ||
      fs.existsSync(path.join(HOME, '.local/share/cursor')) ||
      fs.existsSync(cursorDir);
  }
  platforms.push({
    id: 'cursor',
    name: 'Cursor',
    isInstalled: cursorAppExists,
    configPath: path.join(cursorDir, 'mcp.json'),
    skillPath: path.join(cursorDir, 'skills', 'contextos'),
    type: 'cursor',
  });

  // 3. Antigravity
  const geminiDir = path.join(HOME, '.gemini/config');
  let antigravityAppExists = false;
  if (isMac) {
    antigravityAppExists =
      fs.existsSync('/Applications/Antigravity.app') ||
      fs.existsSync(path.join(HOME, 'Applications/Antigravity.app')) ||
      fs.existsSync(geminiDir);
  } else if (isWin) {
    antigravityAppExists =
      fs.existsSync(path.join(localAppData, 'Programs\\Antigravity\\Antigravity.exe')) ||
      fs.existsSync(geminiDir);
  } else {
    antigravityAppExists =
      fs.existsSync('/usr/bin/antigravity') ||
      fs.existsSync(path.join(HOME, '.local/share/antigravity')) ||
      fs.existsSync(geminiDir);
  }
  platforms.push({
    id: 'antigravity',
    name: 'Antigravity',
    isInstalled: antigravityAppExists || fs.existsSync(path.join(HOME, '.local', 'bin', 'agy')),
    configPath: path.join(geminiDir, 'mcp_config.json'),
    skillPath: path.join(HOME, '.gemini', 'antigravity-cli', 'skills', 'contextos'),
    skillPaths: antigravitySkillPaths(),
    type: 'json',
  });

  // 4. OpenCode
  const opencodeDir = path.join(HOME, '.config/opencode');
  let opencodeAppExists = false;
  if (isMac) {
    opencodeAppExists =
      fs.existsSync('/Applications/OpenCode.app') ||
      fs.existsSync(path.join(HOME, 'Applications/OpenCode.app')) ||
      fs.existsSync(opencodeDir);
  } else if (isWin) {
    opencodeAppExists =
      fs.existsSync(path.join(localAppData, 'Programs\\OpenCode\\OpenCode.exe')) ||
      fs.existsSync(opencodeDir);
  } else {
    opencodeAppExists =
      fs.existsSync('/usr/bin/opencode') ||
      fs.existsSync(path.join(HOME, '.local/share/opencode')) ||
      fs.existsSync(opencodeDir);
  }
  platforms.push({
    id: 'opencode',
    name: 'OpenCode',
    isInstalled: opencodeAppExists,
    configPath: path.join(opencodeDir, 'opencode.json'),
    skillPath: path.join(opencodeDir, 'skills', 'contextos'),
    type: 'opencode',
  });

  // 5. Codex
  const codexDir = codexHome;
  let codexAppExists = false;
  if (isMac) {
    codexAppExists =
      fs.existsSync('/Applications/ChatGPT.app') ||
      fs.existsSync('/Applications/Codex.app') ||
      fs.existsSync(codexDir) ||
      fs.existsSync(path.join(HOME, '.agents/plugins'));
  } else if (isWin) {
    codexAppExists =
      fs.existsSync(path.join(localAppData, 'Programs\\Codex\\Codex.exe')) ||
      fs.existsSync(codexDir) ||
      fs.existsSync(path.join(HOME, '.agents/plugins'));
  } else {
    codexAppExists =
      fs.existsSync('/usr/bin/codex') ||
      fs.existsSync(path.join(HOME, '.local/bin/codex')) ||
      fs.existsSync(codexDir) ||
      fs.existsSync(path.join(HOME, '.agents/plugins'));
  }
  platforms.push({
    id: 'codex',
    name: 'Codex',
    isInstalled: codexAppExists,
    configPath: path.join(codexDir, 'config.toml'),
    type: 'codex-plugin',
  });

  // 6. Generic MCP host
  platforms.push({
    id: 'generic',
    name: 'Generic MCP Host',
    isInstalled: true,
    configPath: path.join(contextosHome, 'mcp.json'),
    skillPath: path.join(contextosHome, 'skills', 'contextos'),
    type: 'json',
  });

  return platforms;
}

export function syncAllPlatforms({
  serverScript,
  nodePath,
  env = null,
  targetRoot = null,
  skillSource = null,
  pluginSource = null,
  forceAll = false,
  selectedPlatforms = null,
  version = null,
}) {
  const allPlatforms = detectInstalledPlatforms();
  const knownPlatformIds = new Set(allPlatforms.map((platform) => platform.id));
  const requestedPlatforms = selectedPlatforms && selectedPlatforms.length > 0
    ? [...new Set(selectedPlatforms)]
    : null;
  if (requestedPlatforms) {
    const unknown = requestedPlatforms.filter((id) => !knownPlatformIds.has(id));
    if (unknown.length > 0) {
      throw new Error(`Unknown platform id(s): ${unknown.join(', ')}. Supported: ${[...knownPlatformIds].join(', ')}`);
    }
  }
  const modified = [];
  const platforms = requestedPlatforms
    ? allPlatforms.filter((platform) => requestedPlatforms.includes(platform.id))
    : allPlatforms;

  for (const platform of platforms) {
    // An explicit platform selection is installation intent, including a clean home.
    if (!platform.isInstalled && !forceAll && !requestedPlatforms) continue;

    if (platform.id === 'codex') {
      modified.push(installCodexPlugin({ serverScript, nodePath, env, pluginSource, skillSource }));
      continue;
    }

    for (const skillPath of platform.skillPaths || (platform.skillPath ? [platform.skillPath] : [])) {
      if (!skillSource || !fs.existsSync(skillSource)) continue;
      copyDirectoryRecursive(skillSource, skillPath);
      const parentSource = path.dirname(skillSource);
      const opsSource = path.join(parentSource, 'contextos-ops');
      const opsTarget = path.join(path.dirname(skillPath), 'contextos-ops');
      if (fs.existsSync(opsSource)) {
        copyDirectoryRecursive(opsSource, opsTarget);
      }
    }

    if (platform.id === 'claude-code') {
      configureJsonMcp({ configPath: platform.configPath, serverScript, nodePath, env, version });
      modified.push(platform.name);
      continue;
    }

    if (platform.id === 'cursor') {
      configureJsonMcp({ configPath: platform.configPath, serverScript, nodePath, env, version });
      modified.push(platform.name);
      continue;
    }

    if (platform.id === 'opencode') {
      configureOpenCodeMcp({ configPath: platform.configPath, serverScript, nodePath, env, version });
      modified.push(platform.name);
      continue;
    }

    if (platform.type === 'json') {
      configureJsonMcp({ configPath: platform.configPath, serverScript, nodePath, env, version });
      modified.push(platform.name);
    }
  }

  if (targetRoot) {
    const shouldSyncCursor = !selectedPlatforms || selectedPlatforms.includes('cursor');
    const shouldSyncAntigravity = !selectedPlatforms || selectedPlatforms.includes('antigravity');
    const shouldSyncOpencode = !selectedPlatforms || selectedPlatforms.includes('opencode');

    if (shouldSyncCursor) {
      configureJsonMcp({
        configPath: path.join(targetRoot, '.cursor', 'mcp.json'),
        serverScript,
        nodePath,
        env,
        version,
      });
      modified.push('Workspace .cursor configuration');
    }

    if (shouldSyncAntigravity) {
      configureJsonMcp({
        configPath: path.join(targetRoot, '.agents', 'mcp_config.json'),
        serverScript,
        nodePath,
        env,
        version,
      });
      modified.push('Workspace .agents/mcp_config.json');
    }

    if (shouldSyncOpencode) {
      configureOpenCodeMcp({
        configPath: path.join(targetRoot, 'opencode.json'),
        serverScript,
        nodePath,
        env,
        version,
      });
      modified.push('Workspace OpenCode configuration');
    }
  }

  return modified;
}

export function initProjectWorkspace({ projectRoot = process.cwd(), mode = 'local', projectId = null } = {}) {
  if (mode !== 'local') throw new Error('Unsupported mode: only local storage is available.');
  const dotContextos = path.join(projectRoot, '.contextos');
  fs.mkdirSync(dotContextos, { recursive: true });
  const projectJsonPath = path.join(dotContextos, 'project.json');
  const existing = readJsonObject(projectJsonPath, 'project metadata');
  const resolvedProjectId = projectId || existing.id || deriveProjectId(projectRoot);
  const projectConfig = {
    ...existing, id: resolvedProjectId,
    name: existing.name || (resolvedProjectId === 'contextos' ? 'ContextOS' : resolvedProjectId),
    storage: 'local',
    createdAt: existing.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  if (existing.storage === 'cloud' || existing.isCloud === true) {
    projectConfig.localMigration = { from: 'cloud', remoteDataImported: false };
  }
  for (const key of ['isCloud', 'cloudUrl', 'cloudToken', 'token']) delete projectConfig[key];
  writeFileAtomic(projectJsonPath, JSON.stringify(projectConfig, null, 2) + '\n', 0o600);
  if (fs.existsSync(projectJsonPath + '.contextos.bak')) fs.chmodSync(projectJsonPath + '.contextos.bak', 0o600);
  return projectConfig;
}
