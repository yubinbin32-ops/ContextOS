#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { syncWindowsVersion } from './version.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const desktopWinDir = path.join(repoRoot, 'apps', 'desktop-win');
const distDir = path.join(repoRoot, 'dist');
const pkgVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;

console.log('🚀 Starting ContextOS Windows Packaging Pipeline...');

// Auto-sync windows version definitions from root package.json
syncWindowsVersion();

// 1. Build plugin MCP server bundle
console.log('📦 Step 1/4: Building plugin MCP server bundle...');
execSync('npm run plugin:build', { cwd: repoRoot, stdio: 'inherit' });

// 2. Build React + Vite frontend
console.log('🔨 Step 2/4: Compiling React + Vite frontend (desktop-win)...');
execSync('npm run build', { cwd: desktopWinDir, stdio: 'inherit' });

// 3. Check for Tauri build environment
console.log('📦 Step 3/4: Building Windows application bundle...');
fs.mkdirSync(distDir, { recursive: true });

const isWindows = process.platform === 'win32';
let builtInstaller = false;

if (isWindows || process.env.CI) {
  try {
    console.log('   Running Tauri build (NSIS / MSI)...');
    execSync('npm run tauri build', { cwd: desktopWinDir, stdio: 'inherit' });
    builtInstaller = true;
  } catch (err) {
    console.warn('   Tauri build failed or Rust target not found, proceeding with portable package:', err.message);
  }
}

// 4. Assemble Portable Windows Package & Checksums
console.log('📂 Step 4/4: Packaging Windows release artifacts...');
const portableDir = path.join(distDir, 'ContextOS-windows-x64');
fs.rmSync(portableDir, { recursive: true, force: true });
fs.mkdirSync(portableDir, { recursive: true });

// Copy frontend dist
const frontendDist = path.join(desktopWinDir, 'dist');
if (fs.existsSync(frontendDist)) {
  fs.cpSync(frontendDist, path.join(portableDir, 'web'), { recursive: true });
}

// Copy server bundle & plugin
const pluginDir = path.join(repoRoot, 'plugins', 'contextos');
if (fs.existsSync(pluginDir)) {
  fs.cpSync(pluginDir, path.join(portableDir, 'plugins', 'contextos'), { recursive: true });
}

// Copy any built Tauri binaries / installers
const tauriTargetDir = path.join(desktopWinDir, 'src-tauri', 'target', 'release');
if (fs.existsSync(tauriTargetDir)) {
  const exePath = path.join(tauriTargetDir, 'contextos-desktop-win.exe');
  if (fs.existsSync(exePath)) {
    fs.copyFileSync(exePath, path.join(distDir, 'ContextOS-windows-x64.exe'));
    fs.copyFileSync(exePath, path.join(portableDir, 'ContextOS.exe'));
  }
  const bundleDir = path.join(tauriTargetDir, 'bundle');
  if (fs.existsSync(bundleDir)) {
    // Copy nsis exe and msi if found
    for (const sub of ['nsis', 'msi']) {
      const installerPath = path.join(bundleDir, sub);
      if (fs.existsSync(installerPath)) {
        for (const file of fs.readdirSync(installerPath)) {
          if (file.endsWith('.exe') || file.endsWith('.msi')) {
            fs.copyFileSync(path.join(installerPath, file), path.join(distDir, file));
            console.log(`   Copied installer: ${file}`);
          }
        }
      }
    }
  }
}

// Create README for portable package
const readmeContent = `# ContextOS Desktop (Windows Edition)
Version: ${pkgVersion}

## Usage
- Run ContextOS.exe or install via the matching ContextOS installer in this release.
- Ensure Node.js 22+ is available on your PATH for full local MCP execution.
- Project and configuration documentation: https://github.com/yubinbin32-ops/ContextOS
`;
fs.writeFileSync(path.join(portableDir, 'README.txt'), readmeContent, 'utf8');

// Generate SHA256 checksums for any files created in dist
console.log('🔒 Generating SHA256 checksums for Windows release artifacts...');
const checksumLines = [];
for (const item of fs.readdirSync(distDir)) {
  const itemPath = path.join(distDir, item);
  if (fs.statSync(itemPath).isFile() && !item.startsWith('SHA256SUMS')) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(itemPath)).digest('hex');
    checksumLines.push(`${hash}  ${item}`);
  }
}

if (checksumLines.length > 0) {
  fs.writeFileSync(path.join(distDir, 'SHA256SUMS-windows.txt'), checksumLines.join('\n') + '\n', 'utf8');
}

console.log('✅ ContextOS Windows packaging pipeline completed successfully!');
