import path from 'node:path';
import fs from 'node:fs';
import { ContextOSV2Service } from './v2-service.mjs';

function parseArgs(tokens) {
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = tokens[index + 1];
    if (next === undefined || next.startsWith('--')) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  for (const key of ['paths']) {
    if (!options[key]) continue;
    try {
      options[key] = JSON.parse(options[key]);
    } catch (_) {
      options[key] = String(options[key]).split(',').map((item) => item.trim()).filter(Boolean);
    }
  }
  if (options.ttlDays !== undefined) options.ttlDays = Number(options.ttlDays);
  if (options.dryRun !== undefined) options.dryRun = options.dryRun !== 'false';
  if (options.purge !== undefined) options.purge = options.purge !== 'false';
  return options;
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runAdminCli(argv = process.argv.slice(2)) {
  const [command, ...tokens] = argv;
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(
      [
        'Usage: contextos-mcp.mjs <command> [options]',
        '  sync',
        '  context',
      ].join('\n') + '\n'
    );
    return 0;
  }

  const options = parseArgs(tokens);
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  delete options.projectRoot;
  let projectId = options.projectId;
  delete options.projectId;
  if (!projectId) {
    try {
      const projectConfig = JSON.parse(
        fs.readFileSync(path.join(projectRoot, '.contextos', 'project.json'), 'utf8')
      );
      projectId = projectConfig.id;
    } catch (_) {}
  }

  const service = new ContextOSV2Service({ projectRoot, projectId: projectId || 'contextos' });
  try {
    if (command === 'sync' || command === 'reconcile' || command === 'context') {
      const result = await service.osContext({ action: 'reconcile', format: 'json' });
      writeJson({ ok: true, command: 'sync', result });
      return 0;
    }

    throw new Error(`Unknown admin command: ${command}`);
  } catch (err) {
    writeJson({ ok: false, command, error: err.message });
    return 1;
  } finally {
    service.close({ stopProcesses: false });
  }
}
