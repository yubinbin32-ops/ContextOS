import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { receiveMicroMessages } from './micro-mailbox.mjs';

export function microMutation(action, args) {
  return action === 'change' || (action === 'work' && ['create', 'edits', 'delete', 'deletes', 'path', 'slot', 'append', 'symbol', 'replacement', 'replacementContent', 'target', 'targetContent', 'content', 'overwrite', 'fullFile', 'architecture'].some((key) => args[key] !== undefined));
}

export async function createMicroWorker(options) {
  const owner = fs.realpathSync(options.projectRoot || process.cwd());
  const workspace = fs.realpathSync(options.workspace || owner);
  const implementation = options.execution === 'implement';
  const paths = options.context?.allowedPaths;
  if (implementation && (!Array.isArray(paths) || !paths.length || !options.context?.acceptance?.length)) {
    throw new Error('Implementation requires allowedPaths and acceptance criteria.');
  }
  // A child gets its own local state, telemetry, receipts and capabilities.
  const { ContextOSV2Service } = await import('../../mcp/src/v2-service.mjs');
  const { Orchestrator } = await import('./index.mjs');
  const service = new ContextOSV2Service({ projectRoot: workspace, projectId: `micro-${crypto.createHash('sha256').update(workspace).digest('hex').slice(0, 16)}` });
  const worker = new Orchestrator({ service, projectRoot: workspace });
  function allowed(candidate) {
    const absolute = path.resolve(workspace, candidate || '');
    const relative = path.relative(workspace, absolute).split(path.sep).join('/');
    if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) return false;
    // Resolve existing ancestors too: an allowed symlink must not escape.
    let ancestor = absolute;
    while (!fs.existsSync(ancestor) && ancestor !== workspace) ancestor = path.dirname(ancestor);
    const canonical = fs.realpathSync(ancestor);
    if (canonical !== workspace && !canonical.startsWith(`${workspace}${path.sep}`)) return false;
    return paths?.some((entry) => relative === entry || (String(entry).endsWith('/') && relative.startsWith(entry)));
  }
  return {
    close: () => service.close(),
    dispatch: async (action, args = {}) => {
      if (action === 'ops' && args.capability === 'micro') throw new Error('Child tasks cannot delegate recursively.');
      const mutation = microMutation(action, args);
      if (mutation) {
        if (!implementation) throw new Error('Analysis tasks cannot edit files.');
        const list = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
        const targets = [...list(args.edits), ...list(args.create), ...list(args.delete), ...list(args.deletes), ...(args.path ? [args.path] : [])];
        if (!targets.length || targets.some((target) => !allowed(typeof target === 'string' ? target : target.path))) throw new Error('Change exceeds the assigned allowedPaths.');
      }
      const result = await worker.dispatchInternal(action, args);
      if (!options.agentJobId) return result;
      let messages;
      try { messages = receiveMicroMessages(owner, options.agentJobId); }
      catch { return result; }
      if (!messages.length) return result;
      try { return JSON.stringify({ ...JSON.parse(result), microMessages: messages }); }
      catch { return JSON.stringify({ result, microMessages: messages }); }
    },
  };
}
