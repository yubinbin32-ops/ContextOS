#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

console.log('🚀 Starting ContextOS macOS Packaging Pipeline...');

// 1. Rebuild plugin server bundle
console.log('📦 Step 1/5: Building plugin MCP server bundle...');
execSync('npm run plugin:build', { cwd: repoRoot, stdio: 'inherit' });

// 2. Build Swift Desktop App in release mode
console.log('🔨 Step 2/5: Compiling Swift Desktop App (release mode)...');
const releaseBinaryPath = path.join(repoRoot, 'apps/desktop/.build/arm64-apple-macosx/release/contextos-desktop');
if (!fs.existsSync(releaseBinaryPath)) {
  execSync('swift build --package-path apps/desktop -c release', { cwd: repoRoot, stdio: 'inherit' });
} else {
  console.log(`   Found existing release binary (${(fs.statSync(releaseBinaryPath).size / 1024 / 1024).toFixed(2)} MB). Re-verifying...`);
  execSync('swift build --package-path apps/desktop -c release', { cwd: repoRoot, stdio: 'inherit' });
}

// 2.5 Ensure standalone Node runtime is ready
console.log('📦 Step 2.5/5: Preparing bundled standalone Node runtime...');
const nodeCacheDir = path.join(repoRoot, '.cache');
const cachedNodePath = path.join(nodeCacheDir, 'node-darwin-arm64');
if (!fs.existsSync(cachedNodePath)) {
  fs.mkdirSync(nodeCacheDir, { recursive: true });
  console.log('   Downloading official standalone Node 22 binary (zero external dylibs)...');
  execSync(
    'curl -sL https://nodejs.org/dist/v22.14.0/node-v22.14.0-darwin-arm64.tar.gz | tar -xzf - -C "' +
      nodeCacheDir +
      '" --strip-components=2 node-v22.14.0-darwin-arm64/bin/node',
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
let plistContent = fs.readFileSync(sourcePlistPath, 'utf8');
plistContent = plistContent.replace(/\$\(EXECUTABLE_NAME\)/g, 'ContextOS');
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
fs.copyFileSync(sourcePlistPath, path.join(targetAppPlistDir, 'Info.plist'));

// 4. Code Signing & Packaging Standard Edition (without bundled Node)
console.log('✍️  Step 4/5: Code signing and packaging Standard Edition (ContextOS-macos.zip)...');
execSync(`codesign --force --deep --sign - "${appDir}"`, { cwd: repoRoot, stdio: 'inherit' });
execSync(`codesign --verify --verbose "${appDir}"`, { cwd: repoRoot, stdio: 'inherit' });

const pkgVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
const zipStandardV = path.join(distDir, `contextos-macos-v${pkgVersion}.zip`);
const zipStandardLatest = path.join(distDir, 'contextos-macos.zip');

if (fs.existsSync(zipStandardV)) fs.rmSync(zipStandardV);
if (fs.existsSync(zipStandardLatest)) fs.rmSync(zipStandardLatest);

execSync(`zip -r -y -q "${zipStandardV}" ContextOS.app`, { cwd: distDir, stdio: 'inherit' });
fs.copyFileSync(zipStandardV, zipStandardLatest);
const standardZipStats = fs.statSync(zipStandardV);

// 5. Code Signing & Packaging Full Edition (with bundled standalone Node 22)
console.log('🗜️  Step 5/5: Bundling Node 22 and packaging Full Edition (ContextOS-macos-full.zip)...');
fs.mkdirSync(binDir, { recursive: true });
fs.copyFileSync(cachedNodePath, path.join(binDir, 'node'));
fs.chmodSync(path.join(binDir, 'node'), 0o755);

execSync(`codesign --force --deep --sign - "${appDir}"`, { cwd: repoRoot, stdio: 'inherit' });
execSync(`codesign --verify --verbose "${appDir}"`, { cwd: repoRoot, stdio: 'inherit' });

const zipFullV = path.join(distDir, `contextos-macos-full-v${pkgVersion}.zip`);
const zipFullLatest = path.join(distDir, 'contextos-macos-full.zip');

if (fs.existsSync(zipFullV)) fs.rmSync(zipFullV);
if (fs.existsSync(zipFullLatest)) fs.rmSync(zipFullLatest);

execSync(`zip -r -y -q "${zipFullV}" ContextOS.app`, { cwd: distDir, stdio: 'inherit' });
fs.copyFileSync(zipFullV, zipFullLatest);
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

console.log('\n========================================');
console.log('🎉 ContextOS macOS Dual Release Packaging Complete!');
console.log(`📦 Application:       dist/ContextOS.app (Full standalone with bundled Node 22)`);
console.log(`⚙️  Native Binary:     ContextOS (${(appStats.size / 1024 / 1024).toFixed(2)} MB)`);
console.log(`🏷️  Version:           ${pkgVersion}`);
console.log(`🤐 Standard Archive:  dist/ContextOS-macos.zip (${(standardZipStats.size / 1024 / 1024).toFixed(2)} MB)`);
console.log(`🤐 Full Archive:      dist/ContextOS-macos-full.zip (${(fullZipStats.size / 1024 / 1024).toFixed(2)} MB)`);
console.log(`📜 MCP Server:        dist/contextos-mcp.mjs`);
console.log(`🔑 Checksums:         dist/SHA256SUMS`);
console.log('========================================\n');

