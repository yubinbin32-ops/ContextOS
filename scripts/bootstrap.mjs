#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveNodeExecutable,
  deployCanonicalServer,
  syncAllPlatforms,
  initProjectWorkspace,
  detectInstalledPlatforms,
} from '../packages/mcp/src/bootstrap-util.mjs';

export * from '../packages/mcp/src/bootstrap-util.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`ContextOS bootstrap\n\nUsage:\n  node scripts/bootstrap.mjs --target-root <workspace> (--platforms cursor,codex | --all) [options]\n\nOptions:\n  --project-id <id>          Project id (default: preserve existing or derive from directory)\n  --platforms <list>         Comma-separated platform ids; no implicit all\n  --all                      Explicitly select every detected platform\n  --dry-run                  Print the plan without writing any files\n  --help, -h                 Show this help`);
    process.exit(0);
  }

  let mode = 'local';
  let projectId = null;
  let targetRoot = process.cwd();
  let platformsArg = '';
  let allPlatforms = false;
  let dryRun = false;
  let argIndex = 0;

  const takeValue = (flag) => {
    const value = args[++argIndex];
    if (!value || value.startsWith('--')) {
      console.error(`Missing value for ${flag}`);
      process.exit(2);
    }
    return value;
  };

  for (argIndex = 0; argIndex < args.length; argIndex++) {
    if (args[argIndex] === '--mode') {
      mode = takeValue('--mode');
    } else if (args[argIndex] === '--project-id') {
      projectId = takeValue('--project-id');
    } else if (args[argIndex] === '--target-root') {
      targetRoot = path.resolve(takeValue('--target-root'));
    } else if (args[argIndex] === '--platforms') {
      platformsArg = takeValue('--platforms');
    } else if (args[argIndex] === '--all') {
      allPlatforms = true;
    } else if (args[argIndex] === '--dry-run') {
      dryRun = true;
    } else if (args[argIndex].startsWith('--')) {
      console.error(`Unknown option: ${args[argIndex]}`);
      process.exit(2);
    }
  }

  if (mode !== 'local') {
    console.error(`Unsupported mode: ${mode}. Only local storage is available.`);
    process.exit(2);
  }

  if (!fs.existsSync(targetRoot) || !fs.statSync(targetRoot).isDirectory()) {
    console.error(`Target workspace does not exist or is not a directory: ${targetRoot}`);
    process.exit(2);
  }
  if (!allPlatforms && !platformsArg) {
    console.error('Refusing to install implicitly. Pass --platforms <list> or --all explicitly.');
    process.exit(2);
  }
  if (allPlatforms && platformsArg) {
    console.error('Pass either --all or --platforms, not both.');
    process.exit(2);
  }

  const normalizePlatformId = (id) => String(id).trim().toLowerCase();

  const selectedPlatforms = allPlatforms
    ? null
    : platformsArg.split(',').map(normalizePlatformId).filter(Boolean);
  if (!allPlatforms && selectedPlatforms.length === 0) {
    console.error('No platforms selected. Pass at least one platform id.');
    process.exit(2);
  }
  const availablePlatforms = detectInstalledPlatforms();
  const supportedPlatformIds = new Set(availablePlatforms.map((platform) => platform.id));
  const unknownPlatforms = (selectedPlatforms || []).filter((id) => !supportedPlatformIds.has(id));
  if (unknownPlatforms.length > 0) {
    console.error(`Unknown platform id(s): ${unknownPlatforms.join(', ')}. Supported: ${[...supportedPlatformIds].join(', ')}`);
    process.exit(2);
  }

  console.log(`[ContextOS Bootstrap] Project Storage Mode: ${mode} | Project ID: ${projectId || 'auto (preserve or derive)'}`);
  if (allPlatforms) {
    console.log('[ContextOS Bootstrap] Platforms: All detected (explicit --all)');
  } else {
    console.log(`[ContextOS Bootstrap] Selected Platforms: ${selectedPlatforms.join(', ')}`);
  }

  if (dryRun) {
    const platformsForPlan = allPlatforms
      ? availablePlatforms.filter((platform) => platform.isInstalled)
      : availablePlatforms.filter((platform) => selectedPlatforms.includes(platform.id));
    console.log(`[ContextOS Bootstrap] Dry run for target: ${targetRoot}`);
    console.log(`[ContextOS Bootstrap] Would write project metadata: ${path.join(targetRoot, '.contextos', 'project.json')} (with backup)`);
    console.log('[ContextOS Bootstrap] Would atomically deploy: ~/.contextos/server/contextos-mcp.mjs');
    for (const platform of platformsForPlan) {
      const suffix = platform.configPath ? ` -> ${platform.configPath}` : '';
      console.log(`[ContextOS Bootstrap] Would configure ${platform.name}${suffix}`);
    }
    process.exit(0);
  }


  const nodePath = resolveNodeExecutable();
  console.log(`[ContextOS Bootstrap] Node binary: ${nodePath}`);

  const sourceScript = path.join(REPO_ROOT, 'plugins', 'contextos', 'server', 'contextos-mcp.mjs');
  const serverScript = deployCanonicalServer(sourceScript);
  console.log(`[ContextOS Bootstrap] Canonical server deployed: ${serverScript}`);

  const projectConfig = initProjectWorkspace({
    projectRoot: targetRoot,
    mode,
    projectId,
  });
  console.log(`[ContextOS Bootstrap] Initialized project metadata at ${targetRoot}/.contextos/project.json`);

  const skillSource = path.join(REPO_ROOT, 'plugins', 'contextos', 'skills', 'contextos');
  const pluginSource = path.join(REPO_ROOT, 'plugins', 'contextos');
  const packageVersion = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
  const modified = syncAllPlatforms({
    serverScript,
    nodePath,
    targetRoot,
    skillSource,
    pluginSource,
    selectedPlatforms,
    version: packageVersion,
  });

  console.log(`[ContextOS Bootstrap] Successfully configured target platforms:`);
  for (const m of modified) {
    console.log(`  ✓ ${m}`);
  }

  if (selectedPlatforms && selectedPlatforms.length > 0) {
    try {
      const projPath = path.join(targetRoot, '.contextos', 'project.json');
      if (fs.existsSync(projPath)) {
        const curProj = JSON.parse(fs.readFileSync(projPath, 'utf8'));
        curProj.platforms = [...new Set([...(curProj.platforms || []), ...selectedPlatforms])];
        fs.writeFileSync(projPath, JSON.stringify(curProj, null, 2) + '\n');
      }
      const profPath = path.join(os.homedir(), '.contextos', 'profile.json');
      if (fs.existsSync(profPath)) {
        const curProf = JSON.parse(fs.readFileSync(profPath, 'utf8'));
        curProf.platforms = [...new Set([...(curProf.platforms || []), ...selectedPlatforms])];
        fs.writeFileSync(profPath, JSON.stringify(curProf, null, 2) + '\n');
      }
    } catch (_) {}
  }

  console.log(`[ContextOS Bootstrap] Complete! Ready for AI Agent orchestration.`);
}
