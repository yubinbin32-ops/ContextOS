#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, syncPluginVersion, syncServerJsonVersion } from './version.mjs';

// 1. Automatically update plugin.json & server.json from root package.json
syncPluginVersion();
syncServerJsonVersion();

// 2. Run esbuild bundle
const entrypoint = path.join(repoRoot, 'packages/mcp/src/v3-server.mjs');
const outfile = path.join(repoRoot, 'plugins/contextos/server/contextos-mcp.mjs');
execSync(`npx esbuild "${entrypoint}" --bundle --platform=node --format=esm --target=node22 --outfile="${outfile}"`, {
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
