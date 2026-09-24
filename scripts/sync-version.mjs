#!/usr/bin/env node
import { syncAllVersions } from './version.mjs';

const checkOnly = process.argv.includes('--check');
const { version, changes } = syncAllVersions({ checkOnly });

if (checkOnly && changes.length > 0) {
  console.error(`Version data is out of sync with package.json (${version}):`);
  for (const file of changes) console.error(`  - ${file}`);
  console.error('Run `npm run version:sync` to update generated version data.');
  process.exit(1);
}

if (!checkOnly) {
  if (changes.length === 0) {
    console.log(`Version data already matches package.json (${version}).`);
  } else {
    console.log(`Synced package.json version ${version} to:`);
    for (const file of changes) console.log(`  - ${file}`);
  }
}
