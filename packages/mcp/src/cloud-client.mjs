/**
 * Cloud Client for ContextOS MCP Server
 * Connects to remote ContextOS backend / cloud hub using standard Fetch API
 */

export class ContextOSCloudClient {
  constructor({ cloudUrl, token, projectId = 'contextos', timeoutMs = 15000 }) {
    this.cloudUrl = cloudUrl.replace(/\/+$/, '');
    this.token = token || '';
    this.projectId = projectId;
    this.timeoutMs = timeoutMs;
  }

  getHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'x-contextos-project-id': this.projectId,
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  async call(tool, args = {}) {
    const url = `${this.cloudUrl}/api/v2/call`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          tool,
          input: {
            ...args,
            projectId: args.projectId || this.projectId,
          },
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Cloud server returned HTTP ${response.status}: ${errorText || response.statusText}`);
      }

      const data = await response.json();
      return data.result ?? data;
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        throw new Error(`[ContextOS Cloud] Request to ${url} timed out after ${this.timeoutMs}ms.`);
      }
      throw new Error(`[ContextOS Cloud Error] Failed to call '${tool}' on cloud hub (${this.cloudUrl}): ${err.message}`);
    }
  }

  async fetchSnapshot(projectId) {
    const pid = projectId || this.projectId;
    const url = `${this.cloudUrl}/api/v2/snapshot?projectId=${encodeURIComponent(pid)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Cloud server returned HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (err) {
      clearTimeout(timeout);
      throw new Error(`[ContextOS Cloud Error] Failed to fetch snapshot from ${url}: ${err.message}`);
    }
  }

  async pushSnapshot(snapshot, projectId) {
    const pid = projectId || this.projectId;
    const url = `${this.cloudUrl}/api/v2/snapshot?projectId=${encodeURIComponent(pid)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(snapshot),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        const data = await response.json();
        if (data && data.status === 'ok') {
          return data;
        }
      }
    } catch {
      clearTimeout(timeout);
      // Fall through to resilient individual tool calls
    }

    // Resilient fallback for cloud hubs running earlier worker builds: push via /api/v2/call
    // Push plans first so project anchor is established without triggering child cascades
    let pushedPlans = 0;
    for (const p of snapshot.plans || []) {
      await this.call('plan', {
        action: 'create',
        planData: {
          id: p.id,
          title: p.title || p.id,
          summary: p.summary || '',
          priority: p.priority || 'normal',
        },
      });
      pushedPlans++;
    }

    let pushedBlocks = 0;
    for (const b of snapshot.blocks || []) {
      await this.call('block', {
        action: 'bind',
        id: b.id,
        blockData: {
          title: b.title || b.id,
          kind: b.kind || 'service',
          summary: b.summary || '',
          details: b.details || b.body || '',
          artifactRefs: b.artifactRefs || [],
        },
      });
      pushedBlocks++;
    }

    return { status: 'ok', pushedBlocks, pushedPlans, mode: 'call_fallback' };
  }

  async checkHealth() {
    const url = `${this.cloudUrl}/api/v2/health`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return response.ok;
    } catch {
      clearTimeout(timeout);
      return false;
    }
  }
}
