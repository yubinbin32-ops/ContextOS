#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveNodeExecutable,
  deployCanonicalServer,
  syncAllPlatforms,
  initProjectWorkspace,
  saveGlobalCloudConfig,
  getGlobalCloudConfig,
  detectInstalledPlatforms,
} from '../packages/mcp/src/bootstrap-util.mjs';

export * from '../packages/mcp/src/bootstrap-util.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`ContextOS bootstrap\n\nUsage:\n  node scripts/bootstrap.mjs --target-root <workspace> (--platforms cursor,codex | --all) [options]\n\nOptions:\n  --mode <local|cloud>       Project storage mode (default: local)\n  --cloud-url <url>          Cloud endpoint for cloud mode\n  --token <token>            Cloud token for cloud mode\n  --project-id <id>          Project id (default: contextos)\n  --platforms <list>         Comma-separated platform ids; no implicit all\n  --all                      Explicitly select every detected platform\n  --save-global-cloud        Persist cloud credentials to ~/.contextos/cloud.json\n  --dry-run                  Print the plan without writing any files\n  --help, -h                 Show this help`);
    process.exit(0);
  }

  let mode = 'local';
  let cloudUrl = '';
  let token = '';
  let projectId = 'contextos';
  let targetRoot = process.cwd();
  let platformsArg = '';
  let allPlatforms = false;
  let saveGlobal = false;
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
    } else if (args[argIndex] === '--cloud-url') {
      cloudUrl = takeValue('--cloud-url');
    } else if (args[argIndex] === '--token') {
      token = takeValue('--token');
    } else if (args[argIndex] === '--project-id') {
      projectId = takeValue('--project-id');
    } else if (args[argIndex] === '--target-root') {
      targetRoot = path.resolve(takeValue('--target-root'));
    } else if (args[argIndex] === '--platforms') {
      platformsArg = takeValue('--platforms');
    } else if (args[argIndex] === '--all') {
      allPlatforms = true;
    } else if (args[argIndex] === '--save-global-cloud') {
      saveGlobal = true;
    } else if (args[argIndex] === '--dry-run') {
      dryRun = true;
    } else if (args[argIndex].startsWith('--')) {
      console.error(`Unknown option: ${args[argIndex]}`);
      process.exit(2);
    }
  }

  if (!['local', 'cloud'].includes(mode)) {
    console.error(`Unsupported mode: ${mode}. Use 'local' or 'cloud'.`);
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

  // If cloudUrl is not provided via CLI but mode is cloud, check global cloud config
  if (mode === 'cloud' && !cloudUrl) {
    const globalCloud = getGlobalCloudConfig();
    if (globalCloud?.cloudUrl) {
      cloudUrl = globalCloud.cloudUrl;
      if (!token && globalCloud.token) {
        token = globalCloud.token;
      }
    }
  }

  const selectedPlatforms = allPlatforms
    ? null
    : platformsArg.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
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
  if (saveGlobal && (mode !== 'cloud' || !cloudUrl)) {
    console.error('--save-global-cloud requires --mode cloud and a cloud URL.');
    process.exit(2);
  }

  console.log(`[ContextOS Bootstrap] Project Storage Mode: ${mode} | Project ID: ${projectId}`);
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
    if (saveGlobal) {
      console.log('[ContextOS Bootstrap] Would save global cloud credentials to ~/.contextos/cloud.json (mode 0600)');
    }
    process.exit(0);
  }

  if (saveGlobal && cloudUrl) {
    saveGlobalCloudConfig({ cloudUrl, token });
    console.log(`[ContextOS Bootstrap] Saved global cloud credentials to ~/.contextos/cloud.json`);
  }

  const nodePath = resolveNodeExecutable();
  console.log(`[ContextOS Bootstrap] Node binary: ${nodePath}`);

  const sourceScript = path.join(REPO_ROOT, 'plugins', 'contextos', 'server', 'contextos-mcp.mjs');
  const serverScript = deployCanonicalServer(sourceScript);
  console.log(`[ContextOS Bootstrap] Canonical server deployed: ${serverScript}`);

  const projectConfig = initProjectWorkspace({
    projectRoot: targetRoot,
    mode,
    cloudUrl,
    token,
    projectId,
  });
  console.log(`[ContextOS Bootstrap] Initialized project metadata at ${targetRoot}/.contextos/project.json`);

  let env = null;
  if (mode === 'cloud' && cloudUrl) {
    env = {
      CONTEXTOS_MODE: 'cloud',
      CONTEXTOS_CLOUD_URL: cloudUrl.replace(/\/+$/, ''),
      CONTEXTOS_PROJECT_ID: projectId,
    };
    if (token) {
      env.CONTEXTOS_CLOUD_TOKEN = token;
    }
  }

  const skillSource = path.join(REPO_ROOT, 'plugins', 'contextos', 'skills', 'contextos');
  const pluginSource = path.join(REPO_ROOT, 'plugins', 'contextos');
  const packageVersion = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
  const modified = syncAllPlatforms({
    serverScript,
    nodePath,
    env,
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
  console.log(`[ContextOS Bootstrap] Complete! Ready for AI Agent orchestration.`);
}
