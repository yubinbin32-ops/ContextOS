import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const repoRoot = path.resolve(__dirname, '..');
export const packageJsonPath = path.join(repoRoot, 'package.json');

export function readPackageVersion() {
  const metadata = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (typeof metadata.version !== 'string' || metadata.version.trim() === '') {
    throw new Error(`Missing version in ${packageJsonPath}`);
  }
  return metadata.version;
}

export function versionBuildNumber(version) {
  const [core] = String(version).split('-', 1);
  const [major = 0, minor = 0, patch = 0] = core.split('.').map((part) => Number.parseInt(part, 10) || 0);
  return major * 10000 + minor * 100 + patch;
}

export const packageVersion = readPackageVersion();

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function writeIfChanged(relativePath, content, { checkOnly = false, changes = [] } = {}) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (fs.existsSync(absolutePath) && fs.readFileSync(absolutePath, 'utf8') === content) return false;
  changes.push(relativePath);
  if (!checkOnly) fs.writeFileSync(absolutePath, content, 'utf8');
  return true;
}

function replaceRequired(content, pattern, replacement, label) {
  if (!pattern.test(content)) {
    throw new Error(`Cannot update ${label}: expected pattern was not found`);
  }
  return content.replace(pattern, replacement);
}

function updateJson(relativePath, update, opts) {
  const json = JSON.parse(read(relativePath));
  update(json);
  return writeIfChanged(relativePath, `${JSON.stringify(json, null, 2)}\n`, opts);
}

export function syncPluginVersion({ checkOnly = false, version = readPackageVersion(), changes = [] } = {}) {
  const relPath = 'plugins/contextos/.codex-plugin/plugin.json';
  if (fs.existsSync(path.join(repoRoot, relPath))) {
    updateJson(relPath, (json) => {
      json.version = version;
    }, { checkOnly, changes });
  }
  return changes;
}

export function syncServerJsonVersion({ checkOnly = false, version = readPackageVersion(), changes = [] } = {}) {
  const relPath = 'server.json';
  if (fs.existsSync(path.join(repoRoot, relPath))) {
    updateJson(relPath, (json) => {
      json.version = version;
      if (!Array.isArray(json.packages) || !json.packages[0]) {
        throw new Error('server.json must define at least one package');
      }
      json.packages[0].identifier = `ghcr.io/yubinbin32-ops/contextos:${version}`;
    }, { checkOnly, changes });
  }
  return changes;
}

export function syncPackageLockVersion({ checkOnly = false, version = readPackageVersion(), changes = [] } = {}) {
  const relPath = 'package-lock.json';
  if (fs.existsSync(path.join(repoRoot, relPath))) {
    updateJson(relPath, (json) => {
      json.version = version;
      if (json.packages?.['']) json.packages[''].version = version;
    }, { checkOnly, changes });
  }
  return changes;
}

export function syncWindowsVersion({ checkOnly = false, version = readPackageVersion(), changes = [] } = {}) {
  const tauriPath = 'apps/desktop-win/src-tauri/tauri.conf.json';
  if (fs.existsSync(path.join(repoRoot, tauriPath))) {
    const tauriConfig = replaceRequired(
      read(tauriPath),
      /("version"\s*:\s*)"[^"]+"/,
      '$1"../../../package.json"',
      tauriPath
    );
    writeIfChanged(tauriPath, tauriConfig, { checkOnly, changes });
  }

  const cargoPath = 'apps/desktop-win/src-tauri/Cargo.toml';
  if (fs.existsSync(path.join(repoRoot, cargoPath))) {
    const cargoToml = replaceRequired(
      read(cargoPath),
      /^version = "[^"]+"$/m,
      `version = "${version}"`,
      cargoPath
    );
    writeIfChanged(cargoPath, cargoToml, { checkOnly, changes });
  }
  return changes;
}

export function syncDesktopVersion({ checkOnly = false, version = readPackageVersion(), changes = [] } = {}) {
  const buildNumber = versionBuildNumber(version);
  const swiftRelPath = 'apps/desktop/Sources/ContextOSDesktop/ContextOSVersion.swift';
  const generatedSwift = `// Generated from ${path.relative(repoRoot, packageJsonPath)}. Do not edit manually.\n\nenum ContextOSVersion {\n    static let current = "${version}"\n}\n`;
  writeIfChanged(swiftRelPath, generatedSwift, { checkOnly, changes });

  const pbxprojPath = 'apps/desktop/contextos-desktop.xcodeproj/project.pbxproj';
  if (fs.existsSync(path.join(repoRoot, pbxprojPath))) {
    let xcodeProject = replaceRequired(
      read(pbxprojPath),
      /MARKETING_VERSION = [^;]+;/g,
      `MARKETING_VERSION = ${version};`,
      pbxprojPath
    );
    xcodeProject = replaceRequired(
      xcodeProject,
      /CURRENT_PROJECT_VERSION = [^;]+;/g,
      `CURRENT_PROJECT_VERSION = ${buildNumber};`,
      pbxprojPath
    );
    writeIfChanged(pbxprojPath, xcodeProject, { checkOnly, changes });
  }
  return changes;
}

export function syncAllVersions({ checkOnly = false } = {}) {
  const version = readPackageVersion();
  const changes = [];
  const opts = { checkOnly, version, changes };

  syncPluginVersion(opts);
  syncServerJsonVersion(opts);
  syncPackageLockVersion(opts);
  syncWindowsVersion(opts);
  syncDesktopVersion(opts);

  return { version, changes };
}
