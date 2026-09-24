#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { syncDesktopVersion } from './version.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const releaseArch = process.env.CONTEXTOS_PACKAGE_ARCH || process.arch;
const nodeVersion = '22.14.0';
const pkgVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
const [major = 0, minor = 0, patch = 0] = pkgVersion.split('-', 1)[0].split('.').map((part) => Number.parseInt(part, 10) || 0);
const pkgBuildNumber = major * 10000 + minor * 100 + patch;

if (!['arm64', 'x64'].includes(releaseArch)) {
  throw new Error(`Unsupported macOS packaging architecture: ${releaseArch}`);
}

if (releaseArch !== process.arch) {
  throw new Error(
    `CONTEXTOS_PACKAGE_ARCH=${releaseArch} does not match runner architecture ${process.arch}. ` +
    'Run this build on a native runner for the target architecture.'
  );
}

console.log('🚀 Starting ContextOS macOS Packaging Pipeline...');

// Auto-sync desktop version definitions from root package.json
syncDesktopVersion();

// 1. Rebuild plugin server bundle
console.log('📦 Step 1/5: Building plugin MCP server bundle...');
execSync('npm run plugin:build', { cwd: repoRoot, stdio: 'inherit' });

// 2. Build Swift Desktop App in release mode
console.log('🔨 Step 2/5: Compiling Swift Desktop App (release mode)...');
execSync('swift build --package-path apps/desktop -c release', { cwd: repoRoot, stdio: 'inherit' });
const swiftBinDir = execSync('swift build --package-path apps/desktop -c release --show-bin-path', { cwd: repoRoot, encoding: 'utf8' }).trim();
const releaseBinaryPath = path.join(swiftBinDir, 'contextos-desktop');
if (!fs.existsSync(releaseBinaryPath)) {
  throw new Error(`Compiled desktop binary not found at: ${releaseBinaryPath}`);
}
console.log(`   Compiled fresh release binary (${(fs.statSync(releaseBinaryPath).size / 1024 / 1024).toFixed(2)} MB) at ${releaseBinaryPath}`);


// 2.5 Ensure standalone Node runtime is ready
console.log('📦 Step 2.5/5: Preparing bundled standalone Node runtime...');
const nodeCacheDir = path.join(repoRoot, '.cache');
const cachedNodePath = path.join(nodeCacheDir, `node-darwin-${releaseArch}`);
if (!fs.existsSync(cachedNodePath)) {
  fs.mkdirSync(nodeCacheDir, { recursive: true });
  console.log(`   Downloading official standalone Node ${nodeVersion} ${releaseArch} binary (zero external dylibs)...`);
  execSync(
    `curl -sL https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-darwin-${releaseArch}.tar.gz | tar -xzf - -C "` +
      nodeCacheDir +
      `" --strip-components=2 node-v${nodeVersion}-darwin-${releaseArch}/bin/node`,
    { stdio: 'inherit' }
  );
  fs.renameSync(path.join(nodeCacheDir, 'node'), cachedNodePath);
  fs.chmodSync(cachedNodePath, 0o755);
}

// 3. Assemble .app Bundle
console.log('📂 Step 3/5: Assembling ContextOS.app bundle...');
const distDir = path.join(repoRoot, 'dist');
const appDir = path.join(distDir, 'ContextOS.app');
const contentsDir = path.join(appDir, 'Contents');
const macosDir = path.join(contentsDir, 'MacOS');
const resourcesDir = path.join(contentsDir, 'Resources');
const marketplaceDir = path.join(resourcesDir, 'MarketplaceRoot');
const binDir = path.join(resourcesDir, 'bin');
const serverDir = path.join(resourcesDir, 'server');

if (fs.existsSync(appDir)) {
  fs.rmSync(appDir, { recursive: true, force: true });
}

fs.mkdirSync(macosDir, { recursive: true });
fs.mkdirSync(resourcesDir, { recursive: true });
fs.mkdirSync(marketplaceDir, { recursive: true });
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(serverDir, { recursive: true });

// Copy server script
fs.copyFileSync(
  path.join(repoRoot, 'plugins/contextos/server/contextos-mcp.mjs'),
  path.join(serverDir, 'contextos-mcp.mjs')
);

// Copy binary
const targetBinary = path.join(macosDir, 'ContextOS');
fs.copyFileSync(releaseBinaryPath, targetBinary);
fs.chmodSync(targetBinary, 0o755);

// Create PkgInfo
fs.writeFileSync(path.join(contentsDir, 'PkgInfo'), 'APPL????');

// Create Info.plist with executable name filled in
const sourcePlistPath = path.join(repoRoot, 'apps/desktop/Resources/Info.plist');
const renderInfoPlist = () => fs.readFileSync(sourcePlistPath, 'utf8')
  .replace(/\$\(EXECUTABLE_NAME\)/g, 'ContextOS')
  .replace(/\$\(MARKETING_VERSION\)/g, pkgVersion)
  .replace(/\$\(CURRENT_PROJECT_VERSION\)/g, String(pkgBuildNumber));
const plistContent = renderInfoPlist();
fs.writeFileSync(path.join(contentsDir, 'Info.plist'), plistContent, 'utf8');

// Copy AppIcon
const sourceIcon = path.join(repoRoot, 'apps/desktop/Resources/AppIcon.icns');
if (fs.existsSync(sourceIcon)) {
  fs.copyFileSync(sourceIcon, path.join(resourcesDir, 'AppIcon.icns'));
}

// Sync MarketplaceRoot contents
// 1. plugins/contextos
const copyRecursive = (src, dest) => {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      if (child === '.DS_Store') continue;
      copyRecursive(path.join(src, child), path.join(dest, child));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
};

copyRecursive(path.join(repoRoot, 'plugins/contextos'), path.join(marketplaceDir, 'plugins/contextos'));
copyRecursive(path.join(repoRoot, '.agents'), path.join(marketplaceDir, '.agents'));
fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(marketplaceDir, 'package.json'));

const targetAppPlistDir = path.join(marketplaceDir, 'apps/desktop/Resources');
fs.mkdirSync(targetAppPlistDir, { recursive: true });
fs.writeFileSync(path.join(targetAppPlistDir, 'Info.plist'), renderInfoPlist(), 'utf8');

// 4. Code Signing & Packaging Standard Edition (without bundled Node)
console.log('✍️  Step 4/5: Code signing and packaging Standard Edition (ContextOS-macos.zip)...');
const signIdentity = process.env.CONTEXTOS_SIGN_IDENTITY || '';
const requireDeveloperID = process.env.CONTEXTOS_REQUIRE_DEVELOPER_ID === '1';
if (requireDeveloperID && !signIdentity) {
  throw new Error('CONTEXTOS_REQUIRE_DEVELOPER_ID=1 requires CONTEXTOS_SIGN_IDENTITY for a Developer ID Application certificate.');
}
const signApp = () => {
  const args = ['--force', '--deep'];
  if (signIdentity) args.push('--timestamp', '--options', 'runtime');
  args.push('--sign', signIdentity || '-', appDir);
  execFileSync('/usr/bin/codesign', args, { cwd: repoRoot, stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appDir], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
};
signApp();

const zipStandardV = path.join(distDir, `contextos-macos-v${pkgVersion}.zip`);
const zipStandardLatest = path.join(distDir, 'contextos-macos.zip');
const zipStandardArch = path.join(distDir, `ContextOS-macos-${releaseArch}.zip`);
const zipStandardVersionedArch = path.join(distDir, `contextos-macos-v${pkgVersion}-${releaseArch}.zip`);

if (fs.existsSync(zipStandardV)) fs.rmSync(zipStandardV);
if (fs.existsSync(zipStandardLatest)) fs.rmSync(zipStandardLatest);
if (fs.existsSync(zipStandardArch)) fs.rmSync(zipStandardArch);
if (fs.existsSync(zipStandardVersionedArch)) fs.rmSync(zipStandardVersionedArch);

execSync(`zip -r -y -q "${zipStandardV}" ContextOS.app`, { cwd: distDir, stdio: 'inherit' });
fs.copyFileSync(zipStandardV, zipStandardLatest);
fs.copyFileSync(zipStandardV, zipStandardArch);
fs.copyFileSync(zipStandardV, zipStandardVersionedArch);
const standardZipStats = fs.statSync(zipStandardV);

// 5. Code Signing & Packaging Full Edition (with bundled standalone Node 22)
console.log('🗜️  Step 5/5: Bundling Node 22 and packaging Full Edition (ContextOS-macos-full.zip)...');
fs.mkdirSync(binDir, { recursive: true });
fs.copyFileSync(cachedNodePath, path.join(binDir, 'node'));
fs.chmodSync(path.join(binDir, 'node'), 0o755);

signApp();

const zipFullV = path.join(distDir, `contextos-macos-full-v${pkgVersion}.zip`);
const zipFullLatest = path.join(distDir, 'contextos-macos-full.zip');
const zipFullArch = path.join(distDir, `ContextOS-macos-full-${releaseArch}.zip`);
const zipFullVersionedArch = path.join(distDir, `contextos-macos-full-v${pkgVersion}-${releaseArch}.zip`);

if (fs.existsSync(zipFullV)) fs.rmSync(zipFullV);
if (fs.existsSync(zipFullLatest)) fs.rmSync(zipFullLatest);
if (fs.existsSync(zipFullArch)) fs.rmSync(zipFullArch);
if (fs.existsSync(zipFullVersionedArch)) fs.rmSync(zipFullVersionedArch);

execSync(`zip -r -y -q "${zipFullV}" ContextOS.app`, { cwd: distDir, stdio: 'inherit' });
fs.copyFileSync(zipFullV, zipFullLatest);
fs.copyFileSync(zipFullV, zipFullArch);
fs.copyFileSync(zipFullV, zipFullVersionedArch);
const fullZipStats = fs.statSync(zipFullV);
const appStats = fs.statSync(targetBinary);

// 6. Provide Capitalized Release Names and Checksums for GitHub Releases
const capStandardZip = path.join(distDir, 'ContextOS-macos.zip');
const capFullZip = path.join(distDir, 'ContextOS-macos-full.zip');
fs.copyFileSync(zipStandardLatest, capStandardZip);
fs.copyFileSync(zipFullLatest, capFullZip);

// Copy MCP standalone bundle for direct release download
const mcpReleaseBundle = path.join(distDir, 'contextos-mcp.mjs');
fs.copyFileSync(path.join(repoRoot, 'plugins/contextos/server/contextos-mcp.mjs'), mcpReleaseBundle);

// Generate SHA256SUMS
console.log('🔒 Step 6/6: Generating SHA256SUMS checksums...');
execSync('shasum -a 256 ContextOS-macos.zip ContextOS-macos-full.zip contextos-mcp.mjs > SHA256SUMS', { cwd: distDir, stdio: 'inherit' });
execSync(
  `shasum -a 256 ContextOS-macos-${releaseArch}.zip ContextOS-macos-full-${releaseArch}.zip contextos-mcp.mjs > SHA256SUMS-${releaseArch}`,
  { cwd: distDir, stdio: 'inherit' }
);

console.log('\n========================================');
console.log('🎉 ContextOS macOS Dual Release Packaging Complete!');
console.log(`📦 Application:       dist/ContextOS.app (Full standalone with bundled Node 22)`);
console.log(`⚙️  Native Binary:     ContextOS (${(appStats.size / 1024 / 1024).toFixed(2)} MB)`);
console.log(`🧩 Release Arch:      ${releaseArch}`);
console.log(`🏷️  Version:           ${pkgVersion}`);
console.log(`🤐 Standard Archive:  dist/ContextOS-macos.zip (${(standardZipStats.size / 1024 / 1024).toFixed(2)} MB)`);
console.log(`🤐 Full Archive:      dist/ContextOS-macos-full.zip (${(fullZipStats.size / 1024 / 1024).toFixed(2)} MB)`);
console.log(`📜 MCP Server:        dist/contextos-mcp.mjs`);
console.log(`🔑 Checksums:         dist/SHA256SUMS`);
console.log('========================================\n');
