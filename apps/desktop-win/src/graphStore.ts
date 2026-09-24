// 1:1 Port of apps/desktop/Sources/ContextOSDesktop/GraphStore.swift

import { AppUpdater } from './appUpdater';
import { PluginInstaller } from './pluginInstaller';
import {
  AppLanguage,
  ArchitectureCoverage,
  BlockCoverage,
  BlockItem,
  ChainEdge,
  ChainItem,
  ChainMemberItem,
  ChainNode,
  CheckpointItem,
  EditorPlatformStatus,
  emptyGraphSnapshot,
  GraphSelection,
  GraphSnapshot,
  HistoryItem,
  LinkItem,
  PlanChainScopeItem,
  PlanChangeItem,
  PlanCheckpointReference,
  PlanItem,
  PlanStep,
  RecentProject,
  RunningProcessItem,
  SidebarSection,
  SourceReference,
} from './models';
import { ContextOSTheme } from './theme';

export class GraphStore {
  // State
  updater = new AppUpdater();
  appearance: 'system' | 'light' | 'dark' = 'system';
  snapshot: GraphSnapshot = emptyGraphSnapshot();
  recentProjects: RecentProject[] = [];
  selection: GraphSelection | null = null;
  highlightedChainIDs: Set<string> = new Set();
  focusTarget: GraphSelection | null = null;
  focusRequestID: string = crypto.randomUUID();
  overviewFitRequestID: string = crypto.randomUUID();
  isolateFocused: boolean = false;
  hiddenKinds: Set<string> = new Set();
  collapsedSidebarSections: Set<SidebarSection> = new Set();
  recentlyChangedRefs: Set<string> = new Set();
  errorMessage: string | null = null;
  settingsPresented: boolean = false;
  editorStatuses: EditorPlatformStatus[] = [];
  runningProcesses: RunningProcessItem[] = [];
  syncingPlatformId: string | null = null;
  syncErrorMessage: string | null = null;
  canvasScale: number = 1;
  canvasOffset: { width: number; height: number } = { width: 0, height: 0 };
  hasRestoredCamera: boolean = false;
  cameraRestoreRequestID: string = crypto.randomUUID();
  snapshotPresentationID: string = crypto.randomUUID();
  language: AppLanguage = 'system';
  sourcePollingError: string | null = null;

  projectRoot: string = '';
  databasePath: string = 'Unavailable';

  // Subscriptions
  private listeners: Set<() => void> = new Set();
  private pollTimer: any = null;
  private changeTimer: any = null;

  constructor() {
    const savedLang = (localStorage.getItem('contextos.language') as AppLanguage) || 'system';
    this.language = savedLang;
    const savedApp = (localStorage.getItem('contextos.appearance') as any) || 'system';
    this.appearance = savedApp;
    try {
      const savedProjects = localStorage.getItem('contextos.recentProjects');
      if (savedProjects) {
        this.recentProjects = JSON.parse(savedProjects);
      }
    } catch {}
    this.updater.subscribe(() => this.notify());
    this.init();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    for (const l of this.listeners) l();
  }

  async init() {
    await this.loadProject();
    this.startLiveUpdates();
    this.refreshEditorStatuses();
    this.refreshRunningProcesses();
  }

  async chooseProject() {
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({
          directory: true,
          multiple: false,
          title: this.text('openProject'),
        });
        if (selected && typeof selected === 'string') {
          await this.loadProject(selected);
          return;
        }
      } catch {}
    }

    // Priority 1: Tauri IPC choose_project
    if (typeof window !== 'undefined' && ((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const chosen = await invoke<string | null>('choose_project');
        if (chosen) {
          await this.loadProject(chosen);
          return;
        }
        return;
      } catch (err) {
        console.warn('Tauri choose_project error:', err);
      }
    }

    // Web fallback via prompt
    if (typeof window !== 'undefined') {
      const p = window.prompt(this.text('openProjectHelp'), this.projectRoot);
      if (p && p.trim()) {
        await this.loadProject(p.trim());
      }
    }
  }

  async openProject(project: RecentProject) {
    await this.loadProject(project.path);
  }

  normalizeGraphData(raw: any, rootPath: string): GraphSnapshot {
    if (!raw) return emptyGraphSnapshot();
    if (raw.blocks && raw.chains && raw.project) {
      return raw as GraphSnapshot;
    }

    const data = raw.data || {};
    const repoRoot = rootPath || (raw.projectId ? `/${raw.projectId}` : '.');

    const blocks: BlockItem[] = (data.blocks || []).map((b: any) => {
      let layer = b.layer || b.architectureLayer || '';
      if (!layer) {
        const paths = (b.artifactRefs || []).map((r: any) => r.path).join(' ');
        const combined = `${paths} ${b.kind || ''} ${b.title || ''} ${b.id || ''}`.toLowerCase();
        if (combined.includes('gateway') || combined.includes('api') || combined.includes('mcp') || combined.includes('server')) {
          layer = 'gateway';
        } else if (combined.includes('engine') || combined.includes('ast') || combined.includes('parser') || combined.includes('intel')) {
          layer = 'engine';
        } else if (combined.includes('storage') || combined.includes('db') || combined.includes('sqlite') || combined.includes('schema')) {
          layer = 'storage';
        } else if (combined.includes('desktop') || combined.includes('presentation') || combined.includes('ui') || combined.includes('view')) {
          layer = 'presentation';
        } else if (combined.includes('service') || combined.includes('app')) {
          layer = 'service';
        } else {
          layer = 'module';
        }
      }

      return {
        id: b.id,
        kind: b.kind || 'service',
        title: b.title || b.id,
        summary: b.summary || '',
        body: b.details || b.body || '',
        contract: b.contract || '',
        scope: b.scope || '',
        architectureLayer: layer,
        localOrder: b.localOrder || 0,
        deliveryState: b.deliveryState || (b.artifactRefs && b.artifactRefs.length > 0 ? 'complete' : 'ghost'),
        healthState: b.healthState || (b.artifactRefs && b.artifactRefs.length > 0 ? 'healthy' : 'missing'),
        priority: b.priority || 'normal',
        isGhost: !b.artifactRefs || b.artifactRefs.length === 0,
        revision: b.revision || 1,
      };
    });

    const chains: ChainItem[] = (data.chains || []).map((c: any) => ({
      id: c.id,
      title: c.title || c.id,
      chainType: c.chainType || (c.kind === 'linear' ? 'leaf' : c.kind) || 'leaf',
      purpose: c.summary || c.purpose || '',
      intent: c.summary || c.intent || '',
      inputContract: c.inputContract || '',
      outputContract: c.outputContract || '',
      deliveryState: c.deliveryState || 'complete',
      healthState: c.healthState || 'healthy',
      priority: c.priority || 'normal',
      revision: c.revision || 1,
    }));

    const chainNodes: ChainNode[] = [];
    const chainEdges: ChainEdge[] = [];
    for (const c of data.chains || []) {
      const members = c.memberIds || [];
      members.forEach((m: string, idx: number) => {
        chainNodes.push({
          chainId: c.id,
          blockId: m,
          position: idx,
          role: 'stage',
        });
      });
    }

    const links: LinkItem[] = (data.links || []).map((l: any) => {
      const sourceId = l.from || l.sourceId;
      const targetId = l.to || l.targetId;
      return {
        id: l.id,
        sourceType: 'block',
        sourceId,
        targetType: 'block',
        targetId,
        kind: l.kind || 'depends_on',
        label: l.reason || l.label || '',
        contract: l.contract || l.reason || '',
        healthState: l.healthState || 'healthy',
        revision: l.revision || 1,
        reason: l.reason || '',
      };
    });

    for (const c of data.chains || []) {
      const members = c.memberIds || [];
      for (let i = 0; i < members.length - 1; i++) {
        const s = members[i];
        const t = members[i + 1];
        const matched = links.find((l) => l.sourceId === s && l.targetId === t);
        if (matched) {
          chainEdges.push({
            chainId: c.id,
            linkId: matched.id,
            position: i,
          });
        }
      }
    }

    const checkpoints: CheckpointItem[] = [];
    const plans: PlanItem[] = (data.plans || []).map((p: any) => {
      const phases = p.phases || [];
      const completedPhases = phases.filter((ph: any) => ph.status === 'completed').length;
      const pCheckpoints = p.checkpoints || [];
      pCheckpoints.forEach((cp: any) => {
        checkpoints.push({
          id: cp.id,
          targetType: cp.targetType || 'plan',
          targetId: cp.targetId || p.id,
          title: cp.title || cp.id,
          criteria: cp.criteria || '',
          status: cp.status || 'pending',
          kind: cp.kind || 'verification',
          aggregationPolicy: cp.aggregationPolicy || 'all',
          eligibleAfterChildren: cp.eligibleAfterChildren ?? true,
          evidenceLevel: cp.evidenceLevel || 'none',
          requiredEvidenceLevel: cp.requiredEvidenceLevel || 'none',
          coverage: cp.coverage || (cp.status === 'passed' ? 'complete' : 'unknown'),
          evidence: cp.evidence || '[]',
          invalidatedAt: cp.invalidatedAt || null,
          revision: 1,
          updatedAt: cp.updatedAt || new Date().toISOString(),
        });
      });

      return {
        id: p.id,
        title: p.title || p.id,
        summary: p.summary || '',
        goal: p.completedSummary || p.goal || '',
        status: p.status || 'active',
        derivedStatus: p.status === 'completed' ? 'completed' : p.status || 'active',
        statusReason: p.statusReason || '',
        priority: p.priority || 'normal',
        phase: phases[0]?.id || 'P0',
        order: phases[0]?.order || 0,
        proposedDelta: '[]',
        completionPolicy: '{}',
        nextAction: '',
        blockers: '[]',
        startedAt: null,
        completedAt: p.status === 'completed' ? (p.updatedAt || p.createdAt || null) : null,
        invalidatedAt: null,
        progress: {
          completedSteps: completedPhases,
          totalSteps: phases.length || 1,
          directBlockChanges: { completed: 0, total: 0 },
          chainChanges: { completed: 0, total: 0 },
          linkChanges: { completed: 0, total: 0 },
          chainIntegrationGates: { passed: 0, total: 0 },
          planAcceptanceGates: { passed: 0, total: 0 },
          passedRequiredCheckpoints: pCheckpoints.filter((cp: any) => cp.status === 'passed').length,
          totalRequiredCheckpoints: pCheckpoints.length,
        },
        revision: 1,
        ruleRefs: p.ruleRefs || [],
      };
    });

    const sourceReferences: SourceReference[] = [];
    for (const b of data.blocks || []) {
      for (const ref of b.artifactRefs || []) {
        sourceReferences.push({
          id: `${b.id}:${ref.path}:${ref.symbol || ''}`,
          blockId: b.id,
          path: ref.path,
          symbol: ref.symbol || null,
          startLine: ref.startLine || null,
          endLine: ref.endLine || null,
          role: ref.role || 'implementation',
          anchorKind: ref.anchorKind || 'symbol',
          hash: ref.hash || '',
          hashMode: ref.hashMode || null,
          manifest: ref.manifest || null,
        });
      }
    }

    return {
      project: {
        id: raw.projectId || 'contextos',
        name: raw.projectId || 'ContextOS',
        root: repoRoot,
        graphRevision: raw.graphRevision || 1,
      },
      blocks,
      chains,
      chainNodes,
      chainMembers: [],
      links,
      chainEdges,
      plans,
      planDependencies: [],
      planSteps: [],
      planChainScopes: [],
      planChanges: [],
      planChainReferences: [],
      planChainChangeReferences: [],
      checkpoints,
      checkpointBindings: [],
      checkpointDependencies: [],
      planCheckpointReferences: [],
      backgroundScopes: [],
      decisions: [],
      decisionScopes: [],
      sourceReferences,
      localizations: [],
      history: [],
      latestChanges: [],
      changeSequence: raw.graphRevision || 1,
    };
  }

  async loadProject(customPath?: string) {
    try {
      let data: GraphSnapshot | null = null;
      let rootPath = customPath || '';

      if (typeof window !== 'undefined' && ((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const raw = await invoke<any>('load_snapshot', { path: customPath || null });
          rootPath = await invoke<string>('get_project_root');
          if (raw) {
            data = this.normalizeGraphData(raw, rootPath);
          }
        } catch (err: any) {
          console.warn('Tauri load_snapshot error:', err);
        }
      }

      if (!data) {
        try {
          const res = await fetch('/.contextos/graph.json');
          if (res.ok) {
            const raw = await res.json();
            data = this.normalizeGraphData(raw, rootPath);
          }
        } catch {}
      }

      if (data) {
        this.snapshot = data;
        this.projectRoot = rootPath || (data.project as any)?.repoRoot || data.project.root || '';
        this.databasePath = `${this.projectRoot}/.contextos/state.sqlite`;
        this.snapshotPresentationID = crypto.randomUUID();
        this.errorMessage = null;

        // Track and persist in recentProjects
        const projectName = data.project.name || this.projectRoot.split('/').pop() || 'Project';
        const existingIdx = this.recentProjects.findIndex((p) => p.path === this.projectRoot);
        if (existingIdx >= 0) {
          this.recentProjects.splice(existingIdx, 1);
        }
        this.recentProjects.unshift({
          id: data.project.id || this.projectRoot,
          name: projectName,
          path: this.projectRoot,
          lastOpened: new Date().toISOString(),
        });
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('contextos.recentProjects', JSON.stringify(this.recentProjects));
        }

        this.restoreProjectViewState(data.project.id);
      } else {
        this.errorMessage = '未能加载架构图谱数据 (.contextos/graph.json)';
      }
    } catch (err: any) {
      this.errorMessage = err?.message || 'Failed to load project snapshot';
    }
    this.notify();
  }

  startLiveUpdates() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(async () => {
      await this.refreshIfChanged();
    }, 2000);
  }

  async refreshIfChanged() {
    try {
      this.refreshRunningProcesses();

      let nextRaw: any = null;
      if (typeof window !== 'undefined' && ((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          nextRaw = await invoke<any>('load_snapshot', { path: this.projectRoot || null });
        } catch {}
      } else {
        try {
          const res = await fetch('/.contextos/graph.json');
          if (res.ok) {
            nextRaw = await res.json();
          }
        } catch {}
      }

      if (nextRaw) {
        const next = this.normalizeGraphData(nextRaw, this.projectRoot);
        if (
          next.project.graphRevision !== this.snapshot.project.graphRevision ||
          next.changeSequence !== this.snapshot.changeSequence
        ) {
          const prevSeq = this.snapshot.changeSequence;
          this.snapshot = next;
          this.snapshotPresentationID = crypto.randomUUID();

          const changed = next.latestChanges
            .filter((c) => c.sequence > prevSeq)
            .map((c) => `${c.entityType}:${c.entityId}`);
          this.recentlyChangedRefs = new Set(changed);
          this.errorMessage = null;

          if (this.changeTimer) clearTimeout(this.changeTimer);
          this.changeTimer = setTimeout(() => {
            this.recentlyChangedRefs.clear();
            this.notify();
          }, 1400);

          this.notify();
        }
      }
    } catch {
      // background tick ignore
    }
  }

  async refreshRunningProcesses() {
    try {
      if (typeof window !== 'undefined' && ((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)) {
        const { invoke } = await import('@tauri-apps/api/core');
        const items = await invoke<RunningProcessItem[]>('list_processes', {
          projectRoot: this.projectRoot || null,
        });
        if (Array.isArray(items) && JSON.stringify(this.runningProcesses) !== JSON.stringify(items)) {
          this.runningProcesses = items;
          this.notify();
        }
      }
    } catch {
      // ignore
    }
  }

  async stopProcess(id: string) {
    try {
      if (typeof window !== 'undefined' && ((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)) {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('stop_process', {
          id,
          projectRoot: this.projectRoot || null,
        });
      }
      await this.refreshRunningProcesses();
    } catch {
      // ignore
    }
  }

  // --- Project State Persistence ---

  private restoreProjectViewState(projectID: string) {
    const savedLenses = localStorage.getItem(`contextos.hiddenKinds.${projectID}`);
    if (savedLenses) {
      try {
        this.hiddenKinds = new Set(JSON.parse(savedLenses));
      } catch {}
    }
    const savedSidebar = localStorage.getItem(`contextos.sidebar.${projectID}.collapsed`);
    if (savedSidebar) {
      try {
        this.collapsedSidebarSections = new Set(JSON.parse(savedSidebar));
      } catch {}
    }
    const scale = parseFloat(localStorage.getItem(`contextos.camera.${projectID}.scale`) || '1');
    const x = parseFloat(localStorage.getItem(`contextos.camera.${projectID}.x`) || '0');
    const y = parseFloat(localStorage.getItem(`contextos.camera.${projectID}.y`) || '0');
    if (!isNaN(scale) && !isNaN(x) && !isNaN(y)) {
      this.canvasScale = Math.min(1.8, Math.max(0.25, scale));
      this.canvasOffset = { width: x, height: y };
      this.hasRestoredCamera = true;
    }
  }

  private persistCameraState() {
    if (!this.snapshot.project.id) return;
    const pid = this.snapshot.project.id;
    localStorage.setItem(`contextos.camera.${pid}.scale`, String(this.canvasScale));
    localStorage.setItem(`contextos.camera.${pid}.x`, String(this.canvasOffset.width));
    localStorage.setItem(`contextos.camera.${pid}.y`, String(this.canvasOffset.height));
  }

  private persistHiddenKinds() {
    if (!this.snapshot.project.id) return;
    localStorage.setItem(
      `contextos.hiddenKinds.${this.snapshot.project.id}`,
      JSON.stringify(Array.from(this.hiddenKinds).sort())
    );
  }

  private persistSidebarState() {
    if (!this.snapshot.project.id) return;
    localStorage.setItem(
      `contextos.sidebar.${this.snapshot.project.id}.collapsed`,
      JSON.stringify(Array.from(this.collapsedSidebarSections))
    );
  }

  // --- View Control ---

  setLanguage(lang: AppLanguage) {
    this.language = lang;
    localStorage.setItem('contextos.language', lang);
    this.notify();
  }

  get activeLocale(): 'zh-Hans' | 'en' {
    if (this.language === 'zhHans') return 'zh-Hans';
    if (this.language === 'english') return 'en';
    return typeof navigator !== 'undefined' && navigator.language.startsWith('zh') ? 'zh-Hans' : 'en';
  }

  setKindVisible(kind: string, visible: boolean) {
    if (visible) {
      this.hiddenKinds.delete(kind);
    } else {
      this.hiddenKinds.add(kind);
    }
    this.persistHiddenKinds();
    this.notify();
  }

  setSidebarSection(section: SidebarSection, collapsed: boolean) {
    if (collapsed) {
      this.collapsedSidebarSections.add(section);
    } else {
      this.collapsedSidebarSections.delete(section);
    }
    this.persistSidebarState();
    this.notify();
  }

  isSidebarSectionCollapsed(section: SidebarSection): boolean {
    return this.collapsedSidebarSections.has(section);
  }

  showOverview() {
    this.selection = null;
    this.highlightedChainIDs.clear();
    this.focusTarget = null;
    this.isolateFocused = false;
    this.overviewFitRequestID = crypto.randomUUID();
    this.notify();
  }

  focusPlan(id: string) {
    const target: GraphSelection = { type: 'plan', id };
    this.selection = target;
    this.highlightedChainIDs = this.planChainIDs(id);
    this.requestFocus(target);
  }

  select(value: GraphSelection) {
    this.selection = value;
    switch (value.type) {
      case 'block':
        this.highlightedChainIDs.clear();
        this.focusTarget = null;
        break;
      case 'chain':
        this.highlightedChainIDs = new Set([value.id]);
        this.requestFocus(value);
        break;
      case 'plan':
        this.highlightedChainIDs = this.planChainIDs(value.id);
        this.requestFocus(value);
        break;
      case 'link':
        break;
      case 'decision':
        this.highlightedChainIDs.clear();
        this.focusTarget = null;
        break;
    }
    this.notify();
  }

  clearSelection() {
    this.selection = null;
    this.highlightedChainIDs.clear();
    this.focusTarget = null;
    this.notify();
  }

  fitOverview() {
    this.overviewFitRequestID = crypto.randomUUID();
    this.notify();
  }

  exitFocus() {
    this.focusTarget = null;
    this.isolateFocused = false;
    this.notify();
  }

  requestFocus(target: GraphSelection) {
    this.selection = target;
    this.focusTarget = target;
    this.focusRequestID = crypto.randomUUID();
    this.notify();
  }

  magnify(target: GraphSelection, minimumScale = 1.08) {
    this.canvasScale = Math.max(this.canvasScale, minimumScale);
    this.requestFocus(target);
  }

  isRelatedToFocus(blockID: string): boolean {
    if (!this.focusTarget) return true;
    return this.relatedBlockIDs(this.focusTarget).has(blockID);
  }

  setCanvasOffset(val: { width: number; height: number }) {
    this.canvasOffset = val;
    this.persistCameraState();
    this.notify();
  }

  setCamera(scale: number, offset: { width: number; height: number }) {
    this.canvasScale = Math.min(1.8, Math.max(0.25, scale));
    this.canvasOffset = offset;
    this.persistCameraState();
    this.notify();
  }

  zoom(by: number) {
    this.canvasScale = Math.min(1.8, Math.max(0.25, this.canvasScale + by));
    this.persistCameraState();
    this.notify();
  }

  setZoom(val: number) {
    this.canvasScale = Math.min(1.8, Math.max(0.25, val));
    this.persistCameraState();
    this.notify();
  }

  resetZoom() {
    this.canvasScale = 1;
    this.persistCameraState();
    this.notify();
  }

  // --- Computed Architecture Metrics & Data ---

  get plans(): PlanItem[] {
    return [...this.snapshot.plans].sort((a, b) => {
      const phaseA = a.phase.toLowerCase();
      const phaseB = b.phase.toLowerCase();
      if (phaseA !== phaseB) return phaseA.localeCompare(phaseB);
      const rankA = this.priorityRank(a.priority);
      const rankB = this.priorityRank(b.priority);
      if (rankA !== rankB) return rankA - rankB;
      return a.order - b.order;
    });
  }

  priorityRank(priority: string): number {
    switch (priority.trim().toLowerCase()) {
      case 'p0':
      case 'critical':
        return 0;
      case 'p1':
      case 'high':
        return 1;
      case 'p2':
      case 'normal':
        return 2;
      case 'p3':
      case 'low':
        return 3;
      default:
        return 2;
    }
  }

  get totalCheckpointsCount(): number {
    return this.snapshot.checkpoints.length;
  }

  get passedCheckpointsCount(): number {
    return this.snapshot.checkpoints.filter((c) => this.checkpointPasses(c)).length;
  }

  get checkpointPassPercentage(): number {
    return this.totalCheckpointsCount > 0
      ? Math.round((this.passedCheckpointsCount / this.totalCheckpointsCount) * 100)
      : 0;
  }

  checkpointPasses(checkpoint: CheckpointItem): boolean {
    const levels = ['none', 'static', 'simulated', 'integration', 'real_target', 'human_review'];
    const actual = levels.indexOf(checkpoint.evidenceLevel) >= 0 ? levels.indexOf(checkpoint.evidenceLevel) : 0;
    const required = levels.indexOf(checkpoint.requiredEvidenceLevel) >= 0 ? levels.indexOf(checkpoint.requiredEvidenceLevel) : 0;
    return (
      checkpoint.status === 'passed' &&
      checkpoint.coverage === 'complete' &&
      !checkpoint.invalidatedAt &&
      actual >= required
    );
  }

  get availableKinds(): string[] {
    const kinds = this.snapshot.blocks.map((b) => b.kind.trim()).filter(Boolean);
    return Array.from(new Set(kinds)).sort();
  }

  kindTitle(kind: string): string {
    return kind;
  }

  get visibleBlocks(): BlockItem[] {
    const bgRuleIDs = new Set(this.snapshot.backgroundScopes.map((s) => s.blockId));
    return this.snapshot.blocks.filter(
      (b) => !this.hiddenKinds.has(b.kind) && !bgRuleIDs.has(b.id)
    );
  }

  get unassignedCheckpoints(): CheckpointItem[] {
    const planIDs = new Set(this.snapshot.planCheckpointReferences.map((r) => r.checkpointId));
    const boundToPlan = new Set(
      this.snapshot.checkpointBindings
        .filter((b) => ['plan', 'plan_change', 'plan_chain_scope'].includes(b.subjectType))
        .map((b) => b.checkpointId)
    );
    const activeBlockIDs = new Set(this.snapshot.blocks.map((b) => b.id));
    const activeChainIDs = new Set(this.snapshot.chains.map((c) => c.id));
    const activePlanIDs = new Set(this.snapshot.plans.map((p) => p.id));
    const activeLinkIDs = new Set(this.snapshot.links.map((l) => l.id));

    return this.snapshot.checkpoints.filter((cp) => {
      if (planIDs.has(cp.id) || boundToPlan.has(cp.id)) return false;
      if (cp.status.trim().toLowerCase() === 'passed') return false;
      switch (cp.targetType) {
        case 'block':
          return activeBlockIDs.has(cp.targetId);
        case 'chain':
          return activeChainIDs.has(cp.targetId);
        case 'plan':
          return activePlanIDs.has(cp.targetId);
        case 'link':
          return activeLinkIDs.has(cp.targetId);
        default:
          return false;
      }
    });
  }

  checkpointOwner(checkpoint: CheckpointItem): string {
    if (checkpoint.targetType === 'block') {
      const b = this.snapshot.blocks.find((x) => x.id === checkpoint.targetId);
      if (b) return b.title;
    }
    if (checkpoint.targetType === 'chain') {
      const c = this.snapshot.chains.find((x) => x.id === checkpoint.targetId);
      if (c) return c.title;
    }
    if (checkpoint.targetType === 'plan') {
      const p = this.snapshot.plans.find((x) => x.id === checkpoint.targetId);
      if (p) return p.title;
    }
    if (checkpoint.targetType === 'link') {
      const l = this.snapshot.links.find((x) => x.id === checkpoint.targetId);
      if (l) return l.label || l.kind;
    }
    return `${checkpoint.targetType}:${checkpoint.targetId}`;
  }

  ruleScopeLabel(blockID: string): string {
    return this.snapshot.backgroundScopes
      .filter((s) => s.blockId === blockID)
      .map((s) => `${s.scopeType}:${s.scopeValue}`)
      .join(' · ');
  }

  decisionScopeLabel(decisionID: string): string {
    const scopes = this.snapshot.decisionScopes
      .filter((s) => s.decisionID === decisionID)
      .map((s) => `${s.scopeType}:${s.scopeValue}`);
    return scopes.length === 0
      ? this.activeLocale === 'zh-Hans'
        ? '项目范围'
        : 'PROJECT'
      : scopes.join(' · ');
  }

  title(val: GraphSelection): string {
    switch (val.type) {
      case 'block':
        return this.snapshot.blocks.find((b) => b.id === val.id)?.title || val.id;
      case 'chain':
        return this.snapshot.chains.find((c) => c.id === val.id)?.title || val.id;
      case 'link':
        return this.snapshot.links.find((l) => l.id === val.id)?.label || this.text('link');
      case 'plan':
        return this.snapshot.plans.find((p) => p.id === val.id)?.title || val.id;
      case 'decision':
        return this.snapshot.decisions.find((d) => d.id === val.id)?.title || val.id;
    }
  }

  blockText(block: BlockItem, field: string): string {
    switch (field) {
      case 'title':
        return block.title;
      case 'summary':
        return block.summary;
      case 'body':
        return block.body;
      default:
        return block.contract;
    }
  }

  chainText(chain: ChainItem, field: string): string {
    switch (field) {
      case 'title':
        return chain.title;
      case 'intent':
        return chain.intent;
      case 'inputContract':
        return chain.inputContract;
      default:
        return chain.outputContract;
    }
  }

  planText(plan: PlanItem, field: string): string {
    switch (field) {
      case 'title':
        return plan.title;
      case 'summary':
        return plan.summary;
      case 'goal':
        return plan.goal;
      default:
        return plan.nextAction;
    }
  }

  planChainIDs(planID: string): Set<string> {
    const r1 = this.snapshot.planChainReferences.filter((r) => r.planId === planID).map((r) => r.chainId);
    const r2 = this.snapshot.planChainScopes.filter((s) => s.planId === planID).map((s) => s.chainId);
    return new Set([...r1, ...r2]);
  }

  planBlockIDs(planID: string): Set<string> {
    const result = new Set<string>();
    for (const c of this.snapshot.planChanges) {
      if (c.planId === planID && c.entityType === 'block') result.add(c.entityId);
    }
    for (const s of this.snapshot.planSteps) {
      if (s.planId === planID) {
        for (const ref of this.structuredStringList(s.targetReferences)) {
          if (ref.startsWith('block:')) result.add(ref.slice('block:'.length));
        }
      }
    }
    for (const sc of this.snapshot.planChainScopes) {
      if (sc.planId === planID) {
        for (const id of this.structuredStringList(sc.nodeIds)) result.add(id);
        for (const id of this.chainBlockIDs(sc.chainId)) result.add(id);
      }
    }
    for (const cId of this.planChainIDs(planID)) {
      for (const id of this.chainBlockIDs(cId)) result.add(id);
    }
    return result;
  }

  chainMembers(chainID: string): ChainMemberItem[] {
    return this.snapshot.chainMembers
      .filter((m) => m.chainId === chainID)
      .sort((a, b) => a.position - b.position || a.memberId.localeCompare(b.memberId));
  }

  chainBlockIDs(chainID: string, visited: Set<string> = new Set()): string[] {
    if (visited.has(chainID)) return [];
    const nextVisited = new Set(visited);
    nextVisited.add(chainID);

    const result = this.snapshot.chainNodes
      .filter((cn) => cn.chainId === chainID)
      .sort((a, b) => a.position - b.position)
      .map((cn) => cn.blockId);

    for (const member of this.chainMembers(chainID)) {
      if (member.memberType === 'block') {
        if (!result.includes(member.memberId)) result.push(member.memberId);
      } else {
        for (const bId of this.chainBlockIDs(member.memberId, nextVisited)) {
          if (!result.includes(bId)) result.push(bId);
        }
      }
    }
    return result;
  }

  chainNodeIDs(chainID: string): string[] {
    return this.snapshot.chainNodes
      .filter((cn) => cn.chainId === chainID)
      .sort((a, b) => a.position - b.position)
      .map((cn) => cn.blockId);
  }

  chainLinkIDs(chainID: string): Set<string> {
    return new Set(this.snapshot.chainEdges.filter((ce) => ce.chainId === chainID).map((ce) => ce.linkId));
  }

  chains(containingBlockID: string): ChainItem[] {
    const matchingIDs = new Set(
      this.snapshot.chains.filter((c) => this.chainBlockIDs(c.id).includes(containingBlockID)).map((c) => c.id)
    );
    return this.snapshot.chains.filter((c) => matchingIDs.has(c.id)).sort((a, b) => a.id.localeCompare(b.id));
  }

  chainColor(chainID: string): string {
    const ordered = this.snapshot.chains.map((c) => c.id).sort();
    const idx = ordered.indexOf(chainID);
    return ContextOSTheme.chainColor(idx >= 0 ? idx : 0);
  }

  incomingLinks(blockID: string): LinkItem[] {
    return this.snapshot.links
      .filter((l) => l.sourceType === 'block' && l.targetType === 'block' && l.targetId === blockID)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  outgoingLinks(blockID: string): LinkItem[] {
    return this.snapshot.links
      .filter((l) => l.sourceType === 'block' && l.targetType === 'block' && l.sourceId === blockID)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  block(id: string): BlockItem | undefined {
    return this.snapshot.blocks.find((b) => b.id === id);
  }

  chainPosition(chainID: string, blockID: string): { index: number; count: number } | null {
    const nodes = this.snapshot.chainNodes
      .filter((cn) => cn.chainId === chainID)
      .sort((a, b) => a.position - b.position);
    const index = nodes.findIndex((cn) => cn.blockId === blockID);
    if (index === -1) return null;
    return { index, count: nodes.length };
  }

  plansContaining(blockID: string): PlanItem[] {
    const chainIDs = new Set(
      this.snapshot.chains.filter((c) => this.chainBlockIDs(c.id).includes(blockID)).map((c) => c.id)
    );
    const planIDs = new Set<string>();
    for (const r of this.snapshot.planChainReferences) {
      if (chainIDs.has(r.chainId)) planIDs.add(r.planId);
    }
    for (const sc of this.snapshot.planChainScopes) {
      if (chainIDs.has(sc.chainId)) planIDs.add(sc.planId);
    }
    for (const ch of this.snapshot.planChanges) {
      if (ch.entityType === 'block' && ch.entityId === blockID) planIDs.add(ch.planId);
    }
    for (const st of this.snapshot.planSteps) {
      if (this.structuredStringList(st.targetReferences).includes(`block:${blockID}`)) {
        planIDs.add(st.planId);
      }
    }
    return this.snapshot.plans.filter((p) => planIDs.has(p.id));
  }

  relatedBlockIDs(selection: GraphSelection): Set<string> {
    switch (selection.type) {
      case 'block': {
        const links = this.snapshot.links.filter((l) => l.sourceType === 'block' && l.targetType === 'block');
        const adj: Record<string, Set<string>> = {};
        for (const l of links) {
          if (!adj[l.sourceId]) adj[l.sourceId] = new Set();
          if (!adj[l.targetId]) adj[l.targetId] = new Set();
          adj[l.sourceId].add(l.targetId);
          adj[l.targetId].add(l.sourceId);
        }
        const visited = new Set<string>([selection.id]);
        const queue = [selection.id];
        while (queue.length > 0) {
          const curr = queue.shift()!;
          const nbrs = Array.from(adj[curr] || []).sort();
          for (const n of nbrs) {
            if (!visited.has(n)) {
              visited.add(n);
              queue.push(n);
            }
          }
        }
        return visited;
      }
      case 'chain':
        return new Set(this.chainBlockIDs(selection.id));
      case 'plan':
        return this.planBlockIDs(selection.id);
      case 'link': {
        const l = this.snapshot.links.find((x) => x.id === selection.id);
        return l ? new Set([l.sourceId, l.targetId]) : new Set();
      }
      case 'decision':
        return new Set();
    }
  }

  structuredStringList(val: string): string[] {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  architectureCoverage(planID?: string | null): ArchitectureCoverage {
    const blocks = this.snapshot.blocks.filter((b) => b.deliveryState !== 'deprecated');
    const blockIDs = new Set(blocks.map((b) => b.id));
    const chainMemberIDs = new Set(
      this.snapshot.chains.flatMap((c) => this.chainBlockIDs(c.id)).filter((id) => blockIDs.has(id))
    );
    const candidatePlanIDs = new Set(
      this.snapshot.plans.filter((p) => !planID || p.id === planID).map((p) => p.id)
    );

    const directlyPlanned = new Set<string>();
    for (const c of this.snapshot.planChanges) {
      if (candidatePlanIDs.has(c.planId) && c.entityType === 'block' && blockIDs.has(c.entityId)) {
        directlyPlanned.add(c.entityId);
      }
    }
    for (const step of this.snapshot.planSteps) {
      if (candidatePlanIDs.has(step.planId)) {
        for (const ref of this.structuredStringList(step.targetReferences)) {
          if (ref.startsWith('block:')) directlyPlanned.add(ref.slice('block:'.length));
        }
      }
    }

    const chainPlanned = new Set<string>();
    for (const sc of this.snapshot.planChainScopes) {
      if (candidatePlanIDs.has(sc.planId)) {
        for (const id of this.structuredStringList(sc.nodeIds)) {
          if (blockIDs.has(id)) chainPlanned.add(id);
        }
      }
    }
    const planned = new Set([...directlyPlanned, ...chainPlanned]);

    const checkpointGroups: Record<string, CheckpointItem[]> = {};
    for (const cp of this.snapshot.checkpoints) {
      if (cp.targetType === 'block') {
        if (!checkpointGroups[cp.targetId]) checkpointGroups[cp.targetId] = [];
        checkpointGroups[cp.targetId].push(cp);
      }
    }

    const bindingsByCheckpoint: Record<string, typeof this.snapshot.checkpointBindings> = {};
    for (const b of this.snapshot.checkpointBindings) {
      if (!bindingsByCheckpoint[b.checkpointId]) bindingsByCheckpoint[b.checkpointId] = [];
      bindingsByCheckpoint[b.checkpointId].push(b);
    }

    const explicitlyRequiredBlockIDs = new Set(
      this.snapshot.checkpointBindings
        .filter((b) => b.required && b.subjectType === 'block')
        .map((b) => b.subjectId)
    );
    for (const ref of this.snapshot.planCheckpointReferences) {
      if (ref.required && candidatePlanIDs.has(ref.planId)) {
        const cp = this.snapshot.checkpoints.find((x) => x.id === ref.checkpointId);
        if (cp && cp.targetType === 'block') explicitlyRequiredBlockIDs.add(cp.targetId);
      }
    }

    const changesByBlock: Record<string, PlanChangeItem[]> = {};
    for (const c of this.snapshot.planChanges) {
      if (candidatePlanIDs.has(c.planId) && c.entityType === 'block') {
        if (!changesByBlock[c.entityId]) changesByBlock[c.entityId] = [];
        changesByBlock[c.entityId].push(c);
      }
    }

    const candidateScopes = this.snapshot.planChainScopes.filter((sc) => candidatePlanIDs.has(sc.planId));
    const chainGateIDs = new Set<string>();
    if (!planID) {
      for (const cp of this.snapshot.checkpoints) {
        if (cp.targetType === 'chain' && cp.kind === 'integration') chainGateIDs.add(cp.targetId);
      }
    } else {
      for (const b of this.snapshot.checkpointBindings) {
        if (b.required && b.subjectType === 'plan_chain_scope') {
          const sc = candidateScopes.find((s) => s.id === b.subjectId);
          const cp = this.snapshot.checkpoints.find((x) => x.id === b.checkpointId);
          if (sc && cp && cp.kind === 'integration') chainGateIDs.add(sc.chainId);
        }
      }
    }

    const chainIDsByBlock: Record<string, string[]> = {};
    for (const chain of this.snapshot.chains) {
      for (const bId of this.chainBlockIDs(chain.id)) {
        if (blockIDs.has(bId)) {
          if (!chainIDsByBlock[bId]) chainIDsByBlock[bId] = [];
          chainIDsByBlock[bId].push(chain.id);
        }
      }
    }

    const blockCoverage: BlockCoverage[] = blocks.map((b) => {
      const cps = checkpointGroups[b.id] || [];
      const cIDs = new Set((changesByBlock[b.id] || []).map((x) => x.id));
      const cpBindings = cps.flatMap((cp) => bindingsByCheckpoint[cp.id] || []);
      const exactBinding = cpBindings.some(
        (bi) => bi.subjectType === 'plan_change' && cIDs.has(bi.subjectId)
      );
      const memberChainIDs = new Set(chainIDsByBlock[b.id] || []);
      const relevantChainIDs =
        planID == null
          ? memberChainIDs
          : new Set(
              candidateScopes
                .filter((s) => this.structuredStringList(s.nodeIds).includes(b.id))
                .map((s) => s.chainId)
            );
      const checkpointRequired = explicitlyRequiredBlockIDs.has(b.id);
      return {
        blockID: b.id,
        hasCheckpoint: cps.length > 0,
        checkpointRequired,
        missingRequiredCheckpoint: checkpointRequired && cps.length === 0,
        isCoveredByPlan: planned.has(b.id),
        isCoveredByChain: chainMemberIDs.has(b.id),
        isCoveredByAnyVerification: cpBindings.length > 0 || cps.some((cp) => this.checkpointPasses(cp)),
        checkpointUnbound: planned.has(b.id) && cps.length > 0 && !exactBinding,
        chainGateMissing:
          relevantChainIDs.size > 0 && Array.from(relevantChainIDs).some((cId) => !chainGateIDs.has(cId)),
      };
    });

    const verified = new Set(
      blocks
        .filter((b) => (checkpointGroups[b.id] || []).some((cp) => this.checkpointPasses(cp)))
        .map((b) => b.id)
    );
    const failing = blocks
      .filter((b) =>
        (checkpointGroups[b.id] || []).some((cp) =>
          ['failed', 'blocked', 'retest_required'].includes(cp.status)
        )
      )
      .map((b) => b.id);
    const withCheckpoints = new Set(Object.keys(checkpointGroups));

    return {
      totalBlocks: blocks.length,
      verifiedBlocks: verified.size,
      plannedBlocks: planned.size,
      blocksWithCheckpoints: blocks.filter((b) => withCheckpoints.has(b.id)).length,
      outsideChainIDs: blocks.filter((b) => !chainMemberIDs.has(b.id)).map((b) => b.id),
      unplannedIDs: blocks.filter((b) => !planned.has(b.id)).map((b) => b.id),
      withoutCheckpointIDs: blocks
        .filter((b) => !withCheckpoints.has(b.id) && (planID == null || planned.has(b.id)))
        .map((b) => b.id),
      requiredCheckpointMissingIDs: blockCoverage
        .filter((bc) => bc.missingRequiredCheckpoint)
        .map((bc) => bc.blockID),
      failingIDs: failing,
      verificationCoveredBlocks: blockCoverage.filter((bc) => bc.isCoveredByAnyVerification).length,
      checkpointUnboundIDs: blockCoverage.filter((bc) => bc.checkpointUnbound).map((bc) => bc.blockID),
      chainGateMissingIDs: blockCoverage.filter((bc) => bc.chainGateMissing).map((bc) => bc.blockID),
      blocks: blockCoverage,
    };
  }

  directPlanChanges(planID: string): PlanChangeItem[] {
    const scopedIDs = new Set(this.snapshot.planChainChangeReferences.map((r) => r.planChangeId));
    return this.planChanges(planID).filter((c) => !scopedIDs.has(c.id));
  }

  targetCheckpoints(change: PlanChangeItem): CheckpointItem[] {
    return this.snapshot.checkpoints.filter(
      (cp) => cp.targetType === change.entityType && cp.targetId === change.entityId
    );
  }

  checkpointsForSelection(selection: GraphSelection): CheckpointItem[] {
    if (selection.type === 'plan') {
      const referenced = new Set(
        this.snapshot.planCheckpointReferences
          .filter((r) => r.planId === selection.id)
          .map((r) => r.checkpointId)
      );
      return this.snapshot.checkpoints.filter(
        (cp) => (cp.targetType === selection.type && cp.targetId === selection.id) || referenced.has(cp.id)
      );
    }
    return this.snapshot.checkpoints.filter(
      (cp) => cp.targetType === selection.type && cp.targetId === selection.id
    );
  }

  checkpointsBySubject(subjectType: string, subjectID: string): CheckpointItem[] {
    const ids = this.snapshot.checkpointBindings
      .filter((b) => b.subjectType === subjectType && b.subjectId === subjectID)
      .sort((a, b) => a.position - b.position)
      .map((b) => b.checkpointId);
    return ids.map((id) => this.snapshot.checkpoints.find((cp) => cp.id === id)).filter(Boolean) as CheckpointItem[];
  }

  checkpointBlockers(checkpointID: string): CheckpointItem[] {
    const deps = this.snapshot.checkpointDependencies
      .filter((d) => d.parentCheckpointId === checkpointID)
      .sort((a, b) => a.position - b.position);
    const blockers: CheckpointItem[] = [];
    for (const d of deps) {
      if (d.required) {
        const cp = this.snapshot.checkpoints.find((x) => x.id === d.childCheckpointId);
        if (cp && cp.status !== 'passed') blockers.push(cp);
      }
    }
    return blockers;
  }

  locatePlanChange(change: PlanChangeItem) {
    const type = change.entityType as GraphSelection['type'];
    if (type) {
      this.select({ type, id: change.entityId });
      this.requestFocus({ type, id: change.entityId });
    }
  }

  checkpointReference(planID: string, checkpointID: string): PlanCheckpointReference | undefined {
    return this.snapshot.planCheckpointReferences.find(
      (r) => r.planId === planID && r.checkpointId === checkpointID
    );
  }

  planDependencies(planID: string): PlanItem[] {
    const ids = this.snapshot.planDependencies
      .filter((d) => d.planId === planID)
      .sort((a, b) => a.position - b.position)
      .map((d) => d.dependsOnPlanId);
    return ids.map((id) => this.snapshot.plans.find((p) => p.id === id)).filter(Boolean) as PlanItem[];
  }

  planSteps(planID: string): PlanStep[] {
    return this.snapshot.planSteps.filter((s) => s.planId === planID).sort((a, b) => a.position - b.position);
  }

  planStepTargets(step: PlanStep): string {
    const blockMap = new Map(this.snapshot.blocks.map((b) => [b.id, b]));
    const chainMap = new Map(this.snapshot.chains.map((c) => [c.id, c]));
    const linkMap = new Map(this.snapshot.links.map((l) => [l.id, l]));
    const planMap = new Map(this.snapshot.plans.map((p) => [p.id, p]));

    return this.structuredStringList(step.targetReferences)
      .map((ref) => {
        const parts = ref.split(':');
        if (parts.length < 2) return ref;
        const type = parts[0];
        const id = parts.slice(1).join(':');
        switch (type) {
          case 'block':
            return blockMap.get(id)?.title || ref;
          case 'chain':
            return chainMap.get(id)?.title || ref;
          case 'link':
            return linkMap.get(id)?.label || ref;
          case 'plan':
            return planMap.get(id)?.title || ref;
          default:
            return ref;
        }
      })
      .join(' · ');
  }

  planChainScopes(planID: string): PlanChainScopeItem[] {
    return this.snapshot.planChainScopes
      .filter((s) => s.planId === planID)
      .sort((a, b) => a.position - b.position);
  }

  planChainNodePath(scope: PlanChainScopeItem): string {
    const requested = this.structuredStringList(scope.nodeIds);
    const nodeIDs =
      requested.length === 0
        ? this.snapshot.chainNodes
            .filter((cn) => cn.chainId === scope.chainId)
            .sort((a, b) => a.position - b.position)
            .map((cn) => cn.blockId)
        : requested;
    return nodeIDs
      .map((id) => this.snapshot.blocks.find((b) => b.id === id)?.title || `block:${id}`)
      .join(' → ');
  }

  planChainLinks(scope: PlanChainScopeItem): string[] {
    const requested = this.structuredStringList(scope.linkIds);
    const linkIDs =
      requested.length === 0
        ? this.snapshot.chainEdges
            .filter((ce) => ce.chainId === scope.chainId)
            .sort((a, b) => a.position - b.position)
            .map((ce) => ce.linkId)
        : requested;
    return linkIDs.map((id) => {
      const l = this.snapshot.links.find((x) => x.id === id);
      return l ? l.label || l.kind : `link:${id}`;
    });
  }

  planChanges(planIDOrScope: string | PlanChainScopeItem): PlanChangeItem[] {
    if (typeof planIDOrScope === 'string') {
      return this.snapshot.planChanges
        .filter((c) => c.planId === planIDOrScope)
        .sort((a, b) => a.position - b.position);
    }
    const ids = this.snapshot.planChainChangeReferences
      .filter((r) => r.chainScopeId === planIDOrScope.id)
      .sort((a, b) => a.position - b.position)
      .map((r) => r.planChangeId);
    return ids.map((id) => this.snapshot.planChanges.find((c) => c.id === id)).filter(Boolean) as PlanChangeItem[];
  }

  history(val: GraphSelection): HistoryItem[] {
    return this.snapshot.history.filter((h) => h.entityType === val.type && h.entityId === val.id);
  }

  sourceReferences(blockID: string): SourceReference[] {
    return this.snapshot.sourceReferences.filter((sr) => sr.blockId === blockID);
  }

  async revealSource(source: SourceReference) {
    if (typeof window !== 'undefined' && ((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('reveal_source', { path: source.path, projectRoot: this.projectRoot });
        return;
      } catch {}
    }
    console.info(`[Reveal Source] ${source.path}`);
  }

  setSettingsPresented(val: boolean) {
    this.settingsPresented = val;
    if (val) {
      this.updater.checkOnSettingsOpen();
      this.refreshEditorStatuses();
    }
    this.notify();
  }

  setAppearance(app: 'system' | 'light' | 'dark') {
    this.appearance = app;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('contextos.appearance', app);
    }
    this.notify();
  }

  get runtimeHandshake(): string {
    return `contextos mcp v${AppUpdater.currentAppVersion} (Node.js 22+)`;
  }

  async refreshEditorStatuses() {
    this.editorStatuses = await PluginInstaller.detectAllPlatforms();
    this.notify();
  }

  async syncEditor(id: string) {
    this.syncErrorMessage = null;
    this.syncingPlatformId = id;
    this.notify();
    try {
      await PluginInstaller.syncPlatform(id, this.projectRoot);
      await this.refreshEditorStatuses();
    } catch (err: any) {
      this.syncErrorMessage = err.message || 'Sync failed';
    } finally {
      this.syncingPlatformId = null;
      this.notify();
    }
  }

  async syncAllEditors() {
    try {
      await PluginInstaller.installAll(this.projectRoot);
      await this.refreshEditorStatuses();
    } catch (err: any) {
      this.syncErrorMessage = err.message || 'Sync all failed';
      this.notify();
    }
  }


  text(key: string): string {
    const zh: Record<string, string> = {
      overview: '整体网络',
      plans: '计划',
      chains: '链路',
      settings: '设置',
      done: '完成',
      summary: '摘要',
      details: '详情',
      contract: '契约',
      files: '文件与代码',
      checkpoints: '检查点',
      history: '历史',
      plugin: '多平台 AI 编辑器同步',
      pluginHelp:
        '管理各大 AI 客户端（Claude、Cursor、Antigravity、OpenCode、Codex）的 MCP 直连配置。更新 Bundle 或重新同步后，需重启对应编辑器以重载常驻 MCP 进程。',
      syncAll: '一键同步全部',
      syncSingle: '同步配置',
      updateSingle: '更新',
      resync: '重新同步',
      reinstall: '重新安装',
      versionMismatch: '版本不一致',
      bundleChanged: 'Bundle 已变化',
      synced: '已就绪',
      notSynced: '未连接',
      notDetected: '未检测到客户端',
      notConfigured: '待同步',
      skipped: '未安装',
      latest: '最新',
      updateAvailable: '可更新',
      syncing: '正在同步…',
      installPlugin: '一键安装',
      installingPlugin: '正在安装…',
      checkingPlugin: '正在检查编辑器状态…',
      pluginNotInstalled: '尚未安装',
      pluginInstalled: '已安装；新任务中即可使用',
      pluginInstallFailed: '安装失败',
      liveData: '实时数据内核',
      liveHelp: '底层图数据变动自动秒级热重载，无需手动刷新。',
      language: '界面语言',
      appearance: '外观模式',
      system: '跟随系统',
      light: '浅色',
      dark: '深色',
      english: 'English',
      chinese: '中文',
      link: '关系',
      input: '输入',
      output: '输出',
      goal: '目标',
      nextAction: '下一步',
      targetChains: '目标 Chain',
      proposedDelta: '计划中的图变更',
      blockers: '阻塞',
      upstream: '直接上游',
      downstream: '直接下游',
      memberships: '所在 Chain',
      relatedPlans: '关联 Plan',
      path: '路径',
      revision: '版本',
      fitNetwork: '适配全图',
      focusMode: '聚焦',
      exitFocus: '退出聚焦',
      isolate: '仅显示关联',
      projectRules: '项目规则',
      decisions: '架构决策',
      openProject: '打开项目',
      changeProject: '切换项目',
      recentProjects: '最近项目',
      openProjectHelp: '请选择包含 .contextos/project.json 的项目目录。',
      open: '打开',
      connectCloudProject: '连接到云端 MCP 项目…',
      cloudUrl: '云端服务器地址',
      projectId: '项目 ID',
      authToken: '访问令牌 (可选)',
      connectAndImport: '连接并导入图谱',
      connecting: '正在连接云端…',
      cloudProject: '云端项目',
      all: '全部',
      verification: '验证',
      unassigned: '独立验证',
      verified: '已验证',
      checkpointsPassed: '检查点通过',
      noCheckpoints: '0 检查点',
      directBlockWork: '直接 Block 工作',
      principle: '原则',
      product: '产品',
      requirement: '需求',
      decision: '决策',
      flow: '流程',
      ui: '界面',
      service: '服务',
      function: '函数',
      api: 'API',
      integration: '集成',
      data: '数据',
      database: '数据库',
      risk: '风险',
      test: '测试',
      checkpoint: '检查点',
      softwareUpdate: '软件更新',
      currentVersion: '当前版本',
      checkUpdate: '检查更新',
      checkingUpdate: '正在检查更新…',
      upToDate: '当前已是最新版本',
      newVersionFound: '发现新版本',
      updateNow: '立即更新',
      updating: '正在处理更新…',
      restartAndUpdate: '重启并完成更新',
      viewReleaseNotes: '发行说明',
      hideReleaseNotes: '收起说明',
      selectEdition: '安装包规格',
      fullEdition: '全功能版 (内置 Node 22 · 推荐)',
      standardEdition: '轻量版 (依赖系统 Node)',
      openInBrowser: '在浏览器中查看',
      openReleasePage: '打开 GitHub Release 页面',
      gitRepository: 'Git 仓库',
      selectVersion: '选择更新版本',
      retry: '重试',
      devModeUpdateNotice: '开发模式下已解压至缓存目录',
      cancelDownload: '取消下载',
      releaseNotes: '更新日志',
      downloadingUpdate: '正在下载更新…',
    };

    const en: Record<string, string> = {
      overview: 'Full Network',
      plans: 'Plans',
      chains: 'Chains',
      settings: 'Settings',
      done: 'Done',
      summary: 'Summary',
      details: 'Details',
      contract: 'Contract',
      files: 'Files & Code',
      checkpoints: 'Checkpoints',
      history: 'History',
      plugin: 'AI EDITOR MCP BRIDGES',
      pluginHelp:
        'Sync contextos architecture context to Claude Desktop, Cursor, Antigravity, OpenCode, and Codex. After re-syncing, restart editor clients to reload running MCP processes.',
      syncAll: 'Sync All',
      syncSingle: 'Sync',
      updateSingle: 'Update',
      resync: 'Re-sync',
      reinstall: 'Reinstall',
      versionMismatch: 'Version mismatch',
      bundleChanged: 'Bundle changed',
      synced: 'Connected',
      notSynced: 'Not Connected',
      notDetected: 'Not Detected',
      notConfigured: 'Not Configured',
      skipped: 'Skipped',
      latest: 'Latest',
      updateAvailable: 'Update',
      syncing: 'Syncing…',
      installPlugin: 'Install Plugin',
      installingPlugin: 'Installing…',
      checkingPlugin: 'Checking editor statuses…',
      pluginNotInstalled: 'Not installed',
      pluginInstalled: 'Installed; available in new tasks',
      pluginInstallFailed: 'Installation failed',
      liveData: 'LIVE DATA',
      liveHelp: 'Changes appear automatically; no refresh is required.',
      language: 'Language',
      appearance: 'Appearance',
      system: 'System',
      light: 'Light',
      dark: 'Dark',
      english: 'English',
      chinese: '中文',
      link: 'Link',
      input: 'Input',
      output: 'Output',
      goal: 'Goal',
      nextAction: 'Next Action',
      targetChains: 'Target Chains',
      proposedDelta: 'Proposed Graph Delta',
      blockers: 'Blockers',
      upstream: 'Direct Upstream',
      downstream: 'Direct Downstream',
      memberships: 'Chain Memberships',
      relatedPlans: 'Related Plans',
      path: 'Path',
      revision: 'Revision',
      fitNetwork: 'Fit Network',
      focusMode: 'Focus',
      exitFocus: 'Exit Focus',
      isolate: 'Related Only',
      projectRules: 'Project Rules',
      decisions: 'Architecture Decisions',
      openProject: 'Open Project',
      changeProject: 'Change Project',
      recentProjects: 'Recent Projects',
      openProjectHelp: 'Choose a project folder containing .contextos/project.json.',
      open: 'Open',
      connectCloudProject: 'Connect Cloud MCP Project…',
      cloudUrl: 'Cloud Server URL',
      projectId: 'Project ID',
      authToken: 'Auth Token (Optional)',
      connectAndImport: 'Connect & Import Graph',
      connecting: 'Connecting to Cloud…',
      cloudProject: 'Cloud Project',
      all: 'All',
      verification: 'Verification',
      unassigned: 'Standalone checks',
      verified: 'Verified',
      checkpointsPassed: 'checkpoints passed',
      noCheckpoints: '0 Checkpoints',
      directBlockWork: 'Direct Block work',
      principle: 'Principle',
      product: 'Product',
      requirement: 'Requirement',
      decision: 'Decision',
      flow: 'Flow',
      ui: 'UI',
      service: 'Service',
      function: 'Function',
      api: 'API',
      integration: 'Integration',
      data: 'Data',
      database: 'Database',
      risk: 'Risk',
      test: 'Test',
      checkpoint: 'Checkpoint',
      softwareUpdate: 'SOFTWARE UPDATE',
      currentVersion: 'Current Version',
      checkUpdate: 'Check for Updates',
      checkingUpdate: 'Checking for updates…',
      upToDate: 'ContextOS is up to date',
      newVersionFound: 'New Version Available',
      updateNow: 'Update Now',
      updating: 'Processing update…',
      restartAndUpdate: 'Restart & Install',
      viewReleaseNotes: 'Release Notes',
      hideReleaseNotes: 'Hide Notes',
      selectEdition: 'Package Edition',
      fullEdition: 'Full (Bundled Node 22 · Recommended)',
      standardEdition: 'Standard Lite (Requires Node.js)',
      openInBrowser: 'View in Browser',
      openReleasePage: 'Open GitHub Release',
      gitRepository: 'Git Repository',
      selectVersion: 'Select Version',
      retry: 'Retry',
      devModeUpdateNotice: 'Extracted to cache directory in development mode',
      cancelDownload: 'Cancel',
      releaseNotes: 'Release Notes',
      downloadingUpdate: 'Downloading update…',
    };

    return (this.activeLocale === 'zh-Hans' ? zh : en)[key] ?? key;
  }
}

export const globalStore = new GraphStore();
