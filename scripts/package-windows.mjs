#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { syncWindowsVersion } from './version.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const desktopWinDir = path.join(repoRoot, 'apps', 'desktop-win');
const distDir = path.join(repoRoot, 'dist');
const pkgVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
const isWindows = process.platform === 'win32';
const isCI = process.env.CI === 'true' || process.env.CI === '1';
const requireNativeBundle = isWindows || isCI;

function walkFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function assertWindowsIcon() {
  const iconPath = path.join(desktopWinDir, 'src-tauri', 'icons', 'icon.ico');
  if (!fs.existsSync(iconPath)) {
    throw new Error(`Windows icon not found at: ${iconPath}`);
  }
  const header = fs.readFileSync(iconPath).subarray(0, 4);
  const isIco = header[0] === 0 && header[1] === 0 && header[2] === 1 && header[3] === 0;
  if (!isIco) {
    throw new Error(`Invalid Windows ICO file: ${iconPath}`);
  }
}

console.log('🚀 Starting ContextOS Windows Packaging Pipeline...');

// Auto-sync windows version definitions from root package.json
syncWindowsVersion();
assertWindowsIcon();

// 1. Build plugin MCP server bundle
console.log('📦 Step 1/4: Building plugin MCP server bundle...');
execSync('npm run plugin:build', { cwd: repoRoot, stdio: 'inherit' });

// 2. Build React + Vite frontend
console.log('🔨 Step 2/4: Compiling React + Vite frontend (desktop-win)...');
execSync('npm run build', { cwd: desktopWinDir, stdio: 'inherit' });

// 3. Check for Tauri build environment
console.log('📦 Step 3/4: Building Windows application bundle...');
fs.mkdirSync(distDir, { recursive: true });

if (requireNativeBundle) {
  console.log('   Running Tauri build (NSIS / MSI)...');
  execSync('npm run tauri -- build', { cwd: desktopWinDir, stdio: 'inherit' });
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

// Copy the Tauri executable and every installer produced by the bundler.
const tauriTargetDir = path.join(desktopWinDir, 'src-tauri', 'target', 'release');
const binaryCandidates = [
  path.join(tauriTargetDir, 'contextos-desktop-win.exe'),
  path.join(tauriTargetDir, 'ContextOS.exe'),
];
const nativeBinary = binaryCandidates.find((candidate) => fs.existsSync(candidate));
if (nativeBinary) {
  fs.copyFileSync(nativeBinary, path.join(distDir, 'ContextOS-windows-x64.exe'));
  fs.copyFileSync(nativeBinary, path.join(portableDir, 'ContextOS.exe'));
}

const bundleDir = path.join(tauriTargetDir, 'bundle');
const installers = walkFiles(bundleDir).filter((file) => /\.(exe|msi)$/i.test(file));
for (const installer of installers) {
  const filename = path.basename(installer);
  fs.copyFileSync(installer, path.join(distDir, filename));
  console.log(`   Copied installer: ${filename}`);
}

if (requireNativeBundle && !nativeBinary && installers.length === 0) {
  throw new Error('Tauri completed without producing a Windows executable or installer.');
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

const portableArchive = path.join(distDir, 'ContextOS-windows-x64.zip');
if (fs.existsSync(portableArchive)) fs.rmSync(portableArchive);
execFileSync(
  'tar',
  ['-a', '-c', '-f', portableArchive, '-C', distDir, path.basename(portableDir)],
  { stdio: 'inherit' }
);
console.log(`   Created portable archive: ${path.basename(portableArchive)}`);

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
