import { EditorPlatformStatus } from './models';
import { AppUpdater } from './appUpdater';

async function invokeTauri<T>(cmd: string, args?: Record<string, any>): Promise<T | null> {
  if (typeof window !== 'undefined' && ((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<T>(cmd, args);
    } catch (e) {
      console.warn(`Tauri invoke '${cmd}' failed:`, e);
      return null;
    }
  }
  return null;
}

export class PluginInstaller {
  static readonly fallbackVersion = AppUpdater.currentAppVersion;
  static readonly targetBuild = `build-${AppUpdater.currentAppVersion}`;
  projectRoot: string | null = null;

  constructor(projectRoot?: string | null) {
    this.projectRoot = projectRoot || null;
  }

  static async detectAllPlatforms(): Promise<EditorPlatformStatus[]> {
    try {
      const tauriData = await invokeTauri<EditorPlatformStatus[]>('detect_installed_editors');
      if (Array.isArray(tauriData) && tauriData.length > 0) {
        return tauriData;
      }
    } catch {
      // Fallback
    }

    // Default editor platforms schema for browser dev preview
    return [
      {
        id: 'claude',
        name: 'Claude Desktop',
        iconSystemName: 'bubble.left.and.text.bubble.right.fill',
        isAppInstalled: false,
        isSynced: false,
        installedVersion: null,
        targetVersion: AppUpdater.currentAppVersion,
        isOutdated: false,
        configPath: '~/AppData/Roaming/Claude/claude_desktop_config.json',
        appVersion: AppUpdater.currentAppVersion,
        installedBuild: null,
        targetBuild: PluginInstaller.targetBuild,
      },
      {
        id: 'cursor',
        name: 'Cursor',
        iconSystemName: 'chevron.left.forwardslash.chevron.right',
        isAppInstalled: false,
        isSynced: false,
        installedVersion: null,
        targetVersion: AppUpdater.currentAppVersion,
        isOutdated: false,
        configPath: '~/.cursor/mcp.json',
        appVersion: AppUpdater.currentAppVersion,
        installedBuild: null,
        targetBuild: PluginInstaller.targetBuild,
      },
      {
        id: 'antigravity',
        name: 'Antigravity',
        iconSystemName: 'sparkles',
        isAppInstalled: false,
        isSynced: false,
        installedVersion: null,
        targetVersion: AppUpdater.currentAppVersion,
        isOutdated: false,
        configPath: '~/.gemini/config/mcp_config.json',
        appVersion: AppUpdater.currentAppVersion,
        installedBuild: null,
        targetBuild: PluginInstaller.targetBuild,
      },
      {
        id: 'opencode',
        name: 'OpenCode',
        iconSystemName: 'curlybraces',
        isAppInstalled: false,
        isSynced: false,
        installedVersion: null,
        targetVersion: AppUpdater.currentAppVersion,
        isOutdated: false,
        configPath: '~/.config/opencode/mcp.json',
        appVersion: AppUpdater.currentAppVersion,
        installedBuild: null,
        targetBuild: PluginInstaller.targetBuild,
      },
      {
        id: 'codex',
        name: 'Codex',
        iconSystemName: 'command',
        isAppInstalled: false,
        isSynced: false,
        installedVersion: null,
        targetVersion: AppUpdater.currentAppVersion,
        isOutdated: false,
        configPath: '~/.codex/config.toml',
        appVersion: AppUpdater.currentAppVersion,
        installedBuild: null,
        targetBuild: PluginInstaller.targetBuild,
      },
    ];
  }

  static async syncPlatform(id: string, projectRoot?: string | null): Promise<void> {
    if (typeof window !== 'undefined' && ((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('sync_editor_plugin', { platformId: id, projectRoot: projectRoot || undefined });
      return;
    }
    // In web dev mode, simulate successful sync
    console.info(`[Web Dev] syncPlatform(${id}) completed.`);
  }

  async syncPlatform(id: string): Promise<void> {
    return PluginInstaller.syncPlatform(id, this.projectRoot);
  }

  async installAll(): Promise<void> {
    const platforms = await PluginInstaller.detectAllPlatforms();
    for (const p of platforms) {
      await this.syncPlatform(p.id);
    }
  }

  static async installAll(projectRoot?: string | null): Promise<void> {
    const platforms = await this.detectAllPlatforms();
    for (const p of platforms) {
      await this.syncPlatform(p.id, projectRoot);
    }
  }
}
