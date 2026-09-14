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

// 3. Assemble .app Bundle
console.log('📂 Step 3/5: Assembling ContextOS.app bundle...');
const distDir = path.join(repoRoot, 'dist');
const appDir = path.join(distDir, 'ContextOS.app');
const contentsDir = path.join(appDir, 'Contents');
const macosDir = path.join(contentsDir, 'MacOS');
const resourcesDir = path.join(contentsDir, 'Resources');
const marketplaceDir = path.join(resourcesDir, 'MarketplaceRoot');

if (fs.existsSync(appDir)) {
  fs.rmSync(appDir, { recursive: true, force: true });
}

fs.mkdirSync(macosDir, { recursive: true });
fs.mkdirSync(resourcesDir, { recursive: true });
fs.mkdirSync(marketplaceDir, { recursive: true });

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

// 4. Code Signing
console.log('✍️  Step 4/5: Ad-hoc code signing ContextOS.app...');
execSync(`codesign --force --deep --sign - "${appDir}"`, { cwd: repoRoot, stdio: 'inherit' });
execSync(`codesign --verify --verbose "${appDir}"`, { cwd: repoRoot, stdio: 'inherit' });

// 5. Package into .zip distribution
console.log('🗜️  Step 5/5: Creating release zip archives...');
const zipV2 = path.join(distDir, 'contextos-macos-v2.0.0.zip');
const zipLatest = path.join(distDir, 'contextos-macos.zip');

if (fs.existsSync(zipV2)) fs.rmSync(zipV2);
if (fs.existsSync(zipLatest)) fs.rmSync(zipLatest);

// Use -r -y -q as specified in CONTRIBUTING.md
execSync(`zip -r -y -q "${zipV2}" ContextOS.app`, { cwd: distDir, stdio: 'inherit' });
fs.copyFileSync(zipV2, zipLatest);

const zipStats = fs.statSync(zipV2);
const appStats = fs.statSync(targetBinary);

console.log('\n========================================');
console.log('🎉 ContextOS macOS Release Packaging Complete!');
console.log(`📦 Application:  dist/ContextOS.app`);
console.log(`⚙️  Binary:       ContextOS (${(appStats.size / 1024 / 1024).toFixed(2)} MB)`);
console.log(`🏷️  Version:      2.0.0 (Build 200)`);
console.log(`🤐 Zip Archives: dist/contextos-macos-v2.0.0.zip (${(zipStats.size / 1024 / 1024).toFixed(2)} MB)`);
console.log(`                dist/contextos-macos.zip`);
console.log('========================================\n');
