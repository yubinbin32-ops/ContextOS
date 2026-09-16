import { ContextOSV2Service } from './v2-service.mjs';
import { ContextOSCloudClient } from './cloud-client.mjs';

/**
 * Hybrid ContextOS Service
 * Combines local execution (file AST operations, shell commands, process management)
 * with cloud-hosted context memory (plans, tasks, architecture graphs, blocks, chains).
 */
export class HybridContextOSService {
  constructor({ cloudUrl, token, projectId = 'contextos', projectRoot = process.cwd() } = {}) {
    this.cloudUrl = cloudUrl;
    this.token = token;
    this.projectId = projectId;
    this.projectRoot = projectRoot;

    this.cloudClient = new ContextOSCloudClient({
      cloudUrl,
      token,
      projectId,
    });

    this.localService = new ContextOSV2Service({
      projectRoot,
      projectId,
    });
  }

  close() {
    this.localService.close();
  }

  // ================= 1. os_context =================
  async osContext(input) {
    const { action = 'brief', format = 'markdown' } = input;

    if (action === 'reconcile') {
      return await this.localService.osContext(input);
    }

    try {
      const cloudRes = await this.cloudClient.call('os_context', input);
      if (action === 'brief' && format === 'markdown' && typeof cloudRes === 'string') {
        const header = [
          `> [!NOTE]`,
          `> **ContextOS Mode**: ☁️ Cloud Connected (\`${this.cloudUrl}\`) | **Project**: \`${this.projectId}\``,
          `> **Execution**: Local AST & Shell (\`code\`, \`run_command\`) + Cloud Memory (\`plan\`, \`task\`, \`graph\`).`,
          `> Follow C-D-C-S workflow: Create Plan/Task -> Develop -> Check -> Sync.`,
          '',
        ].join('\n');
        return `${header}\n${cloudRes}`;
      }
      return cloudRes;
    } catch (err) {
      if (action === 'brief') {
        const warning = [
          `> [!WARNING]`,
          `> **ContextOS Cloud Unavailable**: Unable to connect to \`${this.cloudUrl}\`.`,
          `> Reason: ${err.message}`,
          `> Falling back to local workspace context. Verify \`CONTEXTOS_CLOUD_URL\` or unset it to run offline.`,
          '',
        ].join('\n');
        const localBrief = await this.localService.osContext(input);
        return format === 'markdown' && typeof localBrief === 'string' ? `${warning}\n${localBrief}` : localBrief;
      }
      throw err;
    }
  }

  // ================= 2. plan =================
  async plan(input) {
    return await this.cloudClient.call('plan', input);
  }

  // ================= 3. task =================
  async task(input) {
    return await this.cloudClient.call('task', input);
  }

  // ================= 4. block =================
  async block(input) {
    return await this.cloudClient.call('block', input);
  }

  // ================= 5. chain =================
  async chain(input) {
    return await this.cloudClient.call('chain', input);
  }

  // ================= 6. code (100% Local) =================
  async code(input) {
    return await this.localService.code(input);
  }

  // ================= 7. run_command (100% Local) =================
  async runCommand(input) {
    return await this.localService.runCommand(input);
  }

  // ================= 8. process (100% Local) =================
  async process(input) {
    return await this.localService.process(input);
  }

  // ================= 9. knowledge =================
  async knowledge(input) {
    try {
      return await this.cloudClient.call('knowledge', input);
    } catch {
      // Fallback to local knowledge files if cloud knowledge endpoint is not provisioned
      return await this.localService.knowledge(input);
    }
  }
}
