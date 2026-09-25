import { runMicroTask, runMicroTasksParallel } from './micro-client.mjs';

/**
 * Internal capability registry.
 *
 * The V2 facades (os_context/plan/task/block/chain/code/run_command/process/knowledge)
 * are no longer exposed as MCP tools: they stay reachable here, wrapped so a single
 * failing capability cannot abort a pipeline.
 */

async function collectPages(list, detailFlag) {
  const items = [];
  let offset = 0;
  for (let pageNumber = 0; pageNumber < 1000; pageNumber += 1) {
    const page = await list({ action: 'list', format: 'json', limit: 25, offset, [detailFlag]: true });
    if (Array.isArray(page)) return page;
    if (!Array.isArray(page?.items)) return items;
    items.push(...page.items);
    if (page.hasMore !== true) return items;
    const nextOffset = Number(page.nextOffset);
    if (!Number.isInteger(nextOffset) || nextOffset <= offset) return items;
    offset = nextOffset;
  }
  return items;
}

export function createCapabilities({ service, projectRoot, projectId }) {
  async function safe(name, fn) {
    try {
      const data = await fn();
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: error.message, capability: name };
    }
  }

  return {
    code: (args = {}) => safe('code', () => service.code({ format: 'markdown', ...args })),
    codeJson: (args = {}) => safe('code', () => service.code({ format: 'json', ...args })),
    inspect: (args = {}) => safe('inspect', () => service.code({ format: 'markdown', action: 'read', ...args })),
    run: (args = {}) => safe('run_command', () => service.runCommand(args)),
    process: (args = {}) => safe('process', () => service.process(args)),
    knowledge: (args = {}) => safe('knowledge', () => service.knowledge(args)),
    block: (args = {}) => safe('block', () => service.block(args)),
    blocks: () => safe('block', () => collectPages((args) => service.block(args), 'includeRefs')),
    chain: (args = {}) => safe('chain', () => service.chain(args)),
    chains: () => safe('chain', () => collectPages((args) => service.chain(args), 'includeMembers')),
    task: (args = {}) => safe('task', () => service.task(args)),
    plan: (args = {}) => safe('plan', () => service.plan(args)),
    osContext: (args = {}) => safe('os_context', () => service.osContext(args)),
    rules: () => safe('knowledge', async () => {
      const result = await service.knowledge({ action: 'rule_list', format: 'json' });
      return Array.isArray(result) ? result : [];
    }),
    micro: (args = {}, config = {}) => safe('micro', () => runMicroTask(config, args)),
    microBatch: (tasks = [], config = {}, options = {}) => safe('micro', () => runMicroTasksParallel(config, tasks, options)),
    exportGraph: () => safe('graph', () => service.syncEngine.exportGraphToJson(projectId, projectRoot)),
  };
}
