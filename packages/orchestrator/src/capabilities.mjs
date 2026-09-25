import { runMicroTask, runMicroTasksParallel } from './micro-client.mjs';

/**
 * Internal capability registry.
 *
 * The V2 facades (os_context/plan/task/block/chain/code/run_command/process/knowledge)
 * are no longer exposed as MCP tools: they stay reachable here, wrapped so a single
 * failing capability cannot abort a pipeline.
 */

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
    blocks: () => safe('block', async () => {
      const result = await service.block({ action: 'list', format: 'json' });
      return Array.isArray(result) ? result : [];
    }),
    chain: (args = {}) => safe('chain', () => service.chain(args)),
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
