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
} from '../packages/mcp/src/bootstrap-util.mjs';

export * from '../packages/mcp/src/bootstrap-util.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let mode = 'local';
  let cloudUrl = '';
  let token = '';
  let projectId = 'contextos';
  let targetRoot = process.cwd();
  let platformsArg = '';
  let saveGlobal = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) {
      mode = args[++i];
    } else if (args[i] === '--cloud-url' && args[i + 1]) {
      cloudUrl = args[++i];
    } else if (args[i] === '--token' && args[i + 1]) {
      token = args[++i];
    } else if (args[i] === '--project-id' && args[i + 1]) {
      projectId = args[++i];
    } else if (args[i] === '--target-root' && args[i + 1]) {
      targetRoot = path.resolve(args[++i]);
    } else if (args[i] === '--platforms' && args[i + 1]) {
      platformsArg = args[++i];
    } else if (args[i] === '--save-global-cloud') {
      saveGlobal = true;
    }
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

  if (saveGlobal && cloudUrl) {
    saveGlobalCloudConfig({ cloudUrl, token });
    console.log(`[ContextOS Bootstrap] Saved global cloud credentials to ~/.contextos/cloud.json`);
  }

  const selectedPlatforms = platformsArg
    ? platformsArg.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : null;

  console.log(`[ContextOS Bootstrap] Project Storage Mode: ${mode} | Project ID: ${projectId}`);
  if (selectedPlatforms) {
    console.log(`[ContextOS Bootstrap] Selected Platforms: ${selectedPlatforms.join(', ')}`);
  } else {
    console.log(`[ContextOS Bootstrap] Platforms: All detected`);
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
  const modified = syncAllPlatforms({
    serverScript,
    nodePath,
    env,
    targetRoot,
    skillSource,
    pluginSource,
    selectedPlatforms,
  });

  console.log(`[ContextOS Bootstrap] Successfully configured target platforms:`);
  for (const m of modified) {
    console.log(`  ✓ ${m}`);
  }
  console.log(`[ContextOS Bootstrap] Complete! Ready for AI Agent orchestration.`);
}
