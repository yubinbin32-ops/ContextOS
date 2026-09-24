import { AppRelease, AppReleaseAsset, LocalNodeEnvironment, UpdateEdition, UpdateState } from './models';
import packageMetadata from '../../../package.json';

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

export class AppUpdater {
  static readonly defaultRepository = 'yubinbin32-ops/ContextOS';
  static readonly currentAppVersion = packageMetadata.version;

  state: UpdateState = { type: 'idle' };
  repository: string;
  selectedEdition: UpdateEdition = 'full';
  selectedReleaseId: number | null = null;
  showReleaseNotes = false;
  nodeEnvironment: LocalNodeEnvironment = {
    isQualified: false,
    version: null,
    executablePath: 'node',
    message: '正在检测系统 Node.js 环境...',
  };

  private listeners: (() => void)[] = [];

  constructor() {
    const savedRepo = typeof localStorage !== 'undefined' ? localStorage.getItem('contextos.update_repo') : null;
    this.repository = savedRepo && savedRepo.trim().length > 0 ? savedRepo.trim() : AppUpdater.defaultRepository;
    this.detectNodeEnvironment();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private notify() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // ignore
      }
    }
  }

  setRepository(repo: string) {
    this.repository = repo.trim();
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('contextos.update_repo', this.repository);
    }
    this.notify();
    this.checkForUpdates(true);
  }

  setSelectedEdition(edition: UpdateEdition) {
    this.selectedEdition = edition;
    this.notify();
  }

  setSelectedReleaseId(id: number | null) {
    this.selectedReleaseId = id;
    this.notify();
  }

  setShowReleaseNotes(show: boolean) {
    this.showReleaseNotes = show;
    this.notify();
  }

  async detectNodeEnvironment() {
    try {
      const tauriRes = await invokeTauri<LocalNodeEnvironment>('check_node_environment');
      if (tauriRes) {
        this.nodeEnvironment = tauriRes;
        if (!this.nodeEnvironment.isQualified) {
          this.selectedEdition = 'full';
        }
        this.notify();
        return;
      }
    } catch {
      // Fallback
    }

    // Default web preview fallback - not pretending to be v22.0.0 qualified unless checked
    this.nodeEnvironment = {
      isQualified: false,
      version: null,
      executablePath: 'node',
      message: 'Node 22+ (Web 预览环境 - 未检测到真实环境)',
    };
    this.notify();
  }

  static cleanVersion(raw: string): string {
    let clean = raw.trim();
    if (clean.toLowerCase().startsWith('v')) {
      clean = clean.slice(1);
    }
    return clean;
  }

  static compareVersions(v1: string, v2: string): number {
    const clean1 = this.cleanVersion(v1);
    const clean2 = this.cleanVersion(v2);

    const parts1 = (clean1.split('-')[0] || '').split('.').map((n) => parseInt(n, 10) || 0);
    const parts2 = (clean2.split('-')[0] || '').split('.').map((n) => parseInt(n, 10) || 0);

    const count = Math.max(parts1.length, parts2.length);
    for (let i = 0; i < count; i++) {
      const p1 = i < parts1.length ? parts1[i] : 0;
      const p2 = i < parts2.length ? parts2[i] : 0;
      if (p1 > p2) return 1;
      if (p1 < p2) return -1;
    }
    return 0;
  }

  static isNewer(remote: string, current: string): boolean {
    return this.compareVersions(remote, current) > 0;
  }

  checkOnLaunch() {
    this.checkForUpdates(true);
  }

  checkOnSettingsOpen() {
    this.checkForUpdates(true);
  }

  async checkForUpdates(force = false) {
    if (this.state.type === 'checking' && !force) return;

    this.state = { type: 'checking' };
    this.notify();

    const repo = this.repository.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '');
    if (!repo) {
      this.state = { type: 'failed', message: '无效的 Git 仓库地址' };
      this.notify();
      return;
    }

    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases`, {
        headers: {
          Accept: 'application/vnd.github+json',
        },
      });

      if (res.status === 404) {
        this.state = { type: 'failed', message: `未找到仓库 ${repo} 或无公开 Release` };
        this.notify();
        return;
      }
      if (!res.ok) {
        this.state = { type: 'failed', message: `GitHub API 错误 (状态码: ${res.status})` };
        this.notify();
        return;
      }

      const rawReleases = await res.json();
      const releases: AppRelease[] = (Array.isArray(rawReleases) ? rawReleases : []).map((r: any) => ({
        id: r.id,
        tagName: r.tag_name || '',
        version: AppUpdater.cleanVersion(r.tag_name || r.name || ''),
        name: r.name || r.tag_name || '',
        body: r.body || '',
        publishedAt: r.published_at || null,
        htmlUrl: r.html_url || '',
        isPrerelease: !!r.prerelease,
        assets: (r.assets || []).map((a: any) => ({
          id: a.id,
          name: a.name || '',
          downloadUrl: a.browser_download_url || '',
          size: a.size || 0,
        })),
      }));

      const latest = releases.find((r) => !r.isPrerelease) || releases[0];
      if (!latest) {
        this.state = { type: 'upToDate', checkedAt: new Date().toISOString() };
        this.notify();
        return;
      }

      if (this.selectedReleaseId == null || !releases.some((r) => r.id === this.selectedReleaseId)) {
        this.selectedReleaseId = latest.id;
      }

      if (AppUpdater.isNewer(latest.version, AppUpdater.currentAppVersion)) {
        this.state = {
          type: 'updateAvailable',
          latest,
          releases,
        };
      } else {
        this.state = {
          type: 'upToDate',
          checkedAt: new Date().toISOString(),
        };
      }
    } catch (err: any) {
      this.state = {
        type: 'failed',
        message: err?.message || '网络连接失败，请检查网络或稍后重试',
      };
    }
    this.notify();
  }

  async downloadAndApplyUpdate(release: AppRelease, edition: UpdateEdition) {
    const asset = release.assets.find((a) => {
      const lower = a.name.toLowerCase();
      if (edition === 'full') {
        return lower.includes('full') || lower.includes('setup');
      }
      return !lower.includes('full') && (lower.endsWith('.zip') || lower.endsWith('.exe'));
    }) || release.assets[0];

    if (!asset) {
      this.state = { type: 'failed', message: '未找到匹配当前系统的更新安装包' };
      this.notify();
      return;
    }

    this.state = {
      type: 'downloading',
      progress: 0,
      bytesWritten: 0,
      totalBytes: asset.size,
    };
    this.notify();

    try {
      const tauriRes = await invokeTauri<string>('download_and_install_update', {
        downloadUrl: asset.downloadUrl,
        assetName: asset.name,
      });

      if (tauriRes) {
        this.state = {
          type: 'readyToInstall',
          stagedAppURL: tauriRes,
          version: release.version,
        };
        this.notify();
        return;
      }
    } catch (err: any) {
      console.warn('Tauri update invoke error:', err);
    }

    // Browser fallback: open the download URL directly
    if (typeof window !== 'undefined' && asset.downloadUrl) {
      window.open(asset.downloadUrl, '_blank');
      this.state = {
        type: 'readyToInstall',
        stagedAppURL: asset.downloadUrl,
        version: release.version,
      };
      this.notify();
    }
  }

  async applyStagedUpdate(): Promise<boolean> {
    if (this.state.type !== 'readyToInstall' || !this.state.stagedAppURL) return false;
    const res = await invokeTauri<void>('execute_staged_installer', {
      installerPath: this.state.stagedAppURL,
    });
    return res !== null;
  }

  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }
}
