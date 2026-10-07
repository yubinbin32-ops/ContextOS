#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ContextOSV2Service } from '../packages/mcp/src/v2-service.mjs';
import { repoRoot, syncPluginVersion, syncServerJsonVersion } from './version.mjs';

// 1. Automatically update plugin.json & server.json from root package.json
syncPluginVersion();
syncServerJsonVersion();

// 2. Run esbuild bundle
const entrypoint = path.join(repoRoot, 'packages/mcp/src/v3-server.mjs');
const outfile = path.join(repoRoot, 'plugins/contextos/server/contextos-mcp.mjs');
execSync(`npx esbuild "${entrypoint}" --bundle --preserve-symlinks --platform=node --format=esm --target=node22 --outfile="${outfile}"`, {
  cwd: repoRoot,
  stdio: 'inherit',
});

// Keep the generated bundle clean for git diff checks; bundled dependencies can
// contain trailing whitespace that is not part of the ContextOS source.
const bundled = fs.readFileSync(outfile, 'utf8');
const normalized = bundled
  .split('\n')
  .map((line) => line.replace(/[ \t]+$/, ''))
  .join('\n');
if (normalized !== bundled) fs.writeFileSync(outfile, normalized, 'utf8');
// Keep the shipped entrypoint executable for npm bin and direct invocation.
try { fs.chmodSync(outfile, 0o755); } catch (_) {}

// Re-anchor the generated bundle in an existing ContextOS graph so source
// freshness validation does not report drift after a build.
const bundleRelativePath = path.relative(repoRoot, outfile).split(path.sep).join('/');
let service;
try {
  if (fs.existsSync(path.join(repoRoot, '.contextos', 'state.sqlite'))) {
    const projectFile = path.join(repoRoot, '.contextos', 'project.json');
    const projectId = fs.existsSync(projectFile)
      ? JSON.parse(fs.readFileSync(projectFile, 'utf8')).id
      : null;
    if (!projectId) throw new Error('ContextOS project id unavailable');
    service = new ContextOSV2Service({ projectRoot: repoRoot, projectId });
    const ownership = await service.block({
      action: 'owners',
      paths: [bundleRelativePath],
      format: 'json',
    });
    const ownerId = ownership?.items?.[0]?.owners?.[0]?.id;
    if (ownerId) {
      await service.block({
        action: 'bind_auto',
        id: ownerId,
        path: bundleRelativePath,
        anchorKind: 'file',
        refreshPaths: true,
      });
    }
  }
} catch (_) {
  // A missing or unhealthy graph must not fail artifact generation.
} finally {
  try { service?.close(); } catch (_) {}
}

// Ship the parser runtime beside the bundled server. A plugin cache lives
// outside the repository and cannot rely on the repo's node_modules/grammars.
const runtimeDir = path.dirname(outfile);
fs.copyFileSync(path.join(repoRoot, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'), path.join(runtimeDir, 'web-tree-sitter.wasm'));
const pluginGrammars = path.join(repoRoot, 'plugins', 'contextos', 'grammars');
fs.rmSync(pluginGrammars, { recursive: true, force: true });
fs.cpSync(path.join(repoRoot, 'packages', 'code-intel', 'grammars'), pluginGrammars, { recursive: true });
