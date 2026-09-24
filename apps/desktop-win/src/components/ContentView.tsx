// 1:1 Port of apps/desktop/Sources/ContextOSDesktop/ContentView.swift

import React, { useEffect, useState } from 'react';
import { AppUpdater } from '../appUpdater';
import { GraphStore } from '../graphStore';
import { EditorPlatformStatus, SidebarSection } from '../models';
import { ContextOSTheme } from '../theme';
import { DetailView } from './DetailView';
import { GraphCanvasView } from './GraphCanvasView';
import { globalKnowledge, KnowledgeLibrary, KnowledgeView } from './KnowledgeView';
import { WrappingHStackLayout } from './WrappingLayout';

interface ContentViewProps {
  store: GraphStore;
}

export const ContentView: React.FC<ContentViewProps> = ({ store }) => {
  const [, setTick] = useState(0);
  const [knowledge] = useState<KnowledgeLibrary>(globalKnowledge);
  const [requestedDocument, setRequestedDocument] = useState<string | null>(null);
  const [requestedSection, setRequestedSection] = useState<string | null>(null);
  const [completedPlansCollapsed, setCompletedPlansCollapsed] = useState(true);

  // Subscribe to store updates
  useEffect(() => {
    return store.subscribe(() => setTick((t) => t + 1));
  }, [store]);

  // Subscribe to knowledge library updates
  useEffect(() => {
    const unsub = knowledge.subscribe(() => setTick((t) => t + 1));
    return () => {
      unsub();
    };
  }, [knowledge]);

  useEffect(() => {
    knowledge.reload(store.projectRoot);
  }, [store.projectRoot]);

  const openDocument = (id: string, section?: string | null) => {
    store.clearSelection();
    setRequestedSection(section || null);
    setRequestedDocument(id);
    store.setSidebarSection('knowledge', false);
  };

  const closeDocument = () => {
    setRequestedDocument(null);
    setRequestedSection(null);
  };

  const chinese = store.activeLocale === 'zh-Hans';

  // Detail drawer width matching Swift
  const getDrawerWidth = () => {
    if (!store.selection) return 0;
    return store.selection.type === 'plan' ? 460 : 360;
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-white text-slate-800 antialiased font-sans select-none">
      {/* Sidebar: exactly 248px matching Swift */}
      <div className="w-[248px] h-full flex flex-col border-r border-slate-200 bg-white/95 shrink-0 z-20">
        <ProjectHeader store={store} />
        <div className="h-[1px] bg-slate-200 mx-3.5" />

        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          {/* Knowledge Section */}
          <SidebarCollapsibleSection
            store={store}
            section="knowledge"
            title={chinese ? '知识' : 'Knowledge'}
          >
            {knowledge.documents
              .filter((d) => d.kind === 'readme')
              .map((doc) => (
                <SidebarItemButton
                  key={doc.id}
                  title={doc.title}
                  subtitle={chinese ? '仓库原文件 · 只读' : 'REPOSITORY · READ ONLY'}
                  color={ContextOSTheme.blockKindColor('principle')}
                  selected={requestedDocument === doc.id}
                  onClick={() => openDocument(doc.id)}
                />
              ))}
            {knowledge.documents.filter((d) => d.kind === 'readme').length === 0 && (
              <div className="text-xs text-slate-400 px-4 py-1">
                {chinese ? 'README 与项目文档' : 'README and project documents'}
              </div>
            )}
          </SidebarCollapsibleSection>

          {/* Project Rules Section */}
          <SidebarCollapsibleSection
            store={store}
            section="projectRules"
            title={store.text('projectRules')}
          >
            {knowledge.documents
              .filter((d) => d.kind === 'rule')
              .map((rule) => (
                <SidebarItemButton
                  key={rule.id}
                  title={rule.title}
                  subtitle={chinese ? '规范 · 只读' : 'RULE · SPEC'}
                  color={ContextOSTheme.blockKindColor('principle')}
                  selected={requestedDocument === rule.id}
                  onClick={() => openDocument(rule.id)}
                />
              ))}
            {store.snapshot.backgroundScopes.map((scope) => {
              const b = store.block(scope.blockId);
              if (!b) return null;
              return (
                <SidebarItemButton
                  key={`bg-${b.id}`}
                  title={store.blockText(b, 'title')}
                  subtitle={`${store.ruleScopeLabel(b.id).toUpperCase()} · ${b.deliveryState.toUpperCase()}`}
                  color={ContextOSTheme.blockKindColor(b.kind)}
                  selected={store.selection?.type === 'block' && store.selection.id === b.id}
                  onClick={() => {
                    closeDocument();
                    store.select({ type: 'block', id: b.id });
                  }}
                />
              );
            })}
          </SidebarCollapsibleSection>

          {/* Decisions Section */}
          <SidebarCollapsibleSection
            store={store}
            section="decisions"
            title={store.text('decisions')}
          >
            {knowledge.documents
              .filter((d) => d.id === 'DECISION.md')
              .map((doc) => (
                <SidebarItemButton
                  key={doc.id}
                  title="DECISION.md"
                  subtitle={chinese ? '架构决策记录 · 只读' : 'ADR · READ ONLY'}
                  color={ContextOSTheme.blockKindColor('principle')}
                  selected={requestedDocument === doc.id}
                  onClick={() => openDocument(doc.id)}
                />
              ))}
            {store.snapshot.decisions.map((dec) => (
              <SidebarItemButton
                key={dec.id}
                title={dec.title}
                subtitle={`${dec.status.toUpperCase()} · ${store.decisionScopeLabel(dec.id)}`}
                color={ContextOSTheme.blockKindColor('principle')}
                selected={store.selection?.type === 'decision' && store.selection.id === dec.id}
                onClick={() => {
                  closeDocument();
                  store.select({ type: 'decision', id: dec.id });
                }}
              />
            ))}
          </SidebarCollapsibleSection>

          {/* Plans Section */}
          <SidebarCollapsibleSection
            store={store}
            section="plans"
            title={store.text('plans')}
          >
            {(() => {
              const activePlans = store.plans.filter((p) => {
                const s = p.status.toLowerCase();
                const ds = p.derivedStatus.toLowerCase();
                const isDone = s === 'completed' || s === 'archived' || ds === 'completed' || ds === 'archived';
                const isActive = s === 'active' || s === 'draft' || s === 'pending' || ds === 'active' || ds === 'draft' || ds === 'pending';
                return (isActive || !isDone) && !isDone && ds !== 'cancelled';
              });
              const completedPlans = store.plans.filter((p) => {
                const s = p.status.toLowerCase();
                const ds = p.derivedStatus.toLowerCase();
                return (s === 'completed' || s === 'archived' || ds === 'completed' || ds === 'archived') && ds !== 'cancelled';
              });

              return (
                <>
                  {activePlans.length === 0 ? (
                    <div className="px-4 py-1 text-[8.5px] text-slate-400">
                      {chinese ? '暂无进行中的规划' : 'No active plans'}
                    </div>
                  ) : (
                    activePlans.map((plan) => (
                      <SidebarItemButton
                        key={plan.id}
                        title={`${plan.phase.toUpperCase()} ${plan.order} · ${store.planText(plan, 'title')}`}
                        subtitle={`${plan.priority.toUpperCase()} · ${plan.derivedStatus.toUpperCase()} · ${plan.progress.completedSteps}/${plan.progress.totalSteps}`}
                        color={ContextOSTheme.planColor(plan.derivedStatus)}
                        selected={store.selection?.type === 'plan' && store.selection.id === plan.id}
                        onClick={() => {
                          closeDocument();
                          store.focusPlan(plan.id);
                        }}
                      />
                    ))
                  )}

                  {completedPlans.length > 0 && (
                    <div className="mt-2 pt-1 border-t border-slate-100">
                      <button
                        onClick={() => setCompletedPlansCollapsed(!completedPlansCollapsed)}
                        className="w-full flex items-center justify-between px-4 py-1 text-[8px] font-mono font-bold text-slate-400 hover:text-slate-600 transition-colors uppercase tracking-wider"
                      >
                        <span className="flex items-center gap-1.5">
                          <span className="text-[7px]">{completedPlansCollapsed ? '▶' : '▼'}</span>
                          {chinese ? '已完结归档' : 'COMPLETED / ARCHIVED'}
                        </span>
                        <span className="px-1.5 py-0.2 rounded-full bg-emerald-100 text-emerald-700 font-bold text-[7.5px]">
                          {completedPlans.length}
                        </span>
                      </button>
                      {!completedPlansCollapsed &&
                        completedPlans.map((plan) => {
                          const timeText = plan.completedAt ? ` · ${plan.completedAt.slice(0, 10)}` : '';
                          return (
                            <SidebarItemButton
                              key={plan.id}
                              title={`${plan.phase.toUpperCase()} ${plan.order} · ${store.planText(plan, 'title')}`}
                              subtitle={`${plan.derivedStatus.toUpperCase()}${timeText} · ${plan.progress.completedSteps}/${plan.progress.totalSteps}`}
                              color={ContextOSTheme.success}
                              selected={store.selection?.type === 'plan' && store.selection.id === plan.id}
                              onClick={() => {
                                closeDocument();
                                store.focusPlan(plan.id);
                              }}
                            />
                          );
                        })}
                    </div>
                  )}
                </>
              );
            })()}
          </SidebarCollapsibleSection>

          {/* Chains Section */}
          <SidebarCollapsibleSection
            store={store}
            section="chains"
            title={store.text('chains')}
          >
            {store.snapshot.chains.map((chain) => {
              const nodeCount = store.chainNodeIDs(chain.id).length;
              return (
                <SidebarItemButton
                  key={chain.id}
                  title={store.chainText(chain, 'title')}
                  subtitle={
                    chain.chainType === 'composite'
                      ? `${store.chainMembers(chain.id).length} STAGES · COMPOSITE`
                      : `${nodeCount} BLOCKS · ${chain.deliveryState.toUpperCase()}`
                  }
                  color={store.chainColor(chain.id)}
                  selected={store.selection?.type === 'chain' && store.selection.id === chain.id}
                  onClick={() => {
                    closeDocument();
                    store.select({ type: 'chain', id: chain.id });
                  }}
                />
              );
            })}
          </SidebarCollapsibleSection>

          {/* Verification Section */}
          {store.unassignedCheckpoints.length > 0 && (
            <SidebarCollapsibleSection
              store={store}
              section="verification"
              title={store.text('verification')}
            >
              <div className="px-4 py-1 text-[8px] font-mono font-bold text-slate-400 uppercase">
                {store.text('unassigned')} ({store.unassignedCheckpoints.length})
              </div>
              {store.unassignedCheckpoints.slice(0, 5).map((cp) => (
                <SidebarItemButton
                  key={cp.id}
                  title={cp.title}
                  subtitle={`${cp.status.toUpperCase()} · ${store.checkpointOwner(cp)}`}
                  color={ContextOSTheme.checkpointColor(cp.status)}
                  selected={store.selection?.id === cp.targetId}
                  onClick={() => {
                    closeDocument();
                    store.select({
                      type: cp.targetType as any,
                      id: cp.targetId,
                    });
                  }}
                />
              ))}
            </SidebarCollapsibleSection>
          )}
        </div>

        <div className="h-[1px] bg-slate-200 mx-3.5" />
        <RunningProcessesSection store={store} />
        <div className="h-[1px] bg-slate-200 mx-3.5" />
        <SidebarLegend store={store} />
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col h-full overflow-hidden bg-slate-50 relative">
        {/* Canvas Toolbar */}
        <CanvasToolbar store={store} />

        <div className="h-[1px] bg-slate-200 w-full" />

        {/* Canvas + Inspector Drawer */}
        <div className="flex-1 flex flex-row h-full overflow-hidden relative">
          <GraphCanvasView store={store} />

          {/* Error Banner */}
          {store.errorMessage && (
            <div className="absolute top-4 left-4 p-3 rounded-lg bg-white border border-rose-200 shadow-md flex items-center gap-3 z-30">
              <span className="text-rose-500 font-bold text-sm">⚠</span>
              <span className="text-xs text-rose-700">{store.errorMessage}</span>
            </div>
          )}

          {/* Knowledge Document View Drawer */}
          {requestedDocument && (
            <div className="w-[480px] h-full shadow-2xl z-30 flex shrink-0">
              <KnowledgeView
                store={store}
                library={knowledge}
                documentID={requestedDocument}
                section={requestedSection}
                close={closeDocument}
                openDocument={openDocument}
              />
            </div>
          )}

          {/* Detail View Drawer */}
          {!requestedDocument && store.selection && (
            <div
              className="h-full shadow-2xl z-30 flex shrink-0 transition-all duration-200"
              style={{ width: `${getDrawerWidth()}px` }}
            >
              <DetailView store={store} selection={store.selection} />
            </div>
          )}
        </div>
      </div>

      {/* Settings Modal Sheet */}
      {store.settingsPresented && <SettingsModal store={store} />}
    </div>
  );
};

// --- Project Header ---
const ProjectHeader: React.FC<{ store: GraphStore }> = ({ store }) => {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const totalCps = store.totalCheckpointsCount;
  const passedCps = store.passedCheckpointsCount;
  const pct = store.checkpointPassPercentage;
  const isCloud =
    store.snapshot.project.name.includes('(Cloud)') ||
    store.projectRoot.includes('.contextos/cloud_projects');

  return (
    <div className="p-4 flex flex-col gap-2">
      <div className="relative">
        <button
          onClick={() => setDropdownOpen(!dropdownOpen)}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-slate-100 hover:bg-slate-200 border border-slate-200/80 transition-colors w-full text-left"
        >
          <span className="text-blue-500 text-xs">{isCloud ? '☁' : '📁'}</span>
          <span className="text-[14px] font-semibold text-slate-800 truncate flex-1">
            {store.snapshot.project.name}
          </span>
          <span className="text-[9px] font-bold text-slate-400">▾</span>
        </button>

        {dropdownOpen && (
          <div className="absolute top-full left-0 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-xl py-1 z-50 text-xs">
            <div className="px-3 py-1 font-mono font-bold text-[8px] text-slate-400 uppercase">
              {store.text('recentProjects')}
            </div>
            {store.recentProjects.map((p) => (
              <button
                key={p.path}
                onClick={() => {
                  store.openProject(p);
                  setDropdownOpen(false);
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-slate-100 flex items-center justify-between cursor-pointer"
              >
                <span className="truncate">{p.name}</span>
                {p.path === store.projectRoot && <span className="text-blue-600 font-bold">✓</span>}
              </button>
            ))}
            <div className="h-[1px] bg-slate-100 my-1" />
            <button
              onClick={() => {
                setDropdownOpen(false);
                store.chooseProject();
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-blue-600 font-semibold cursor-pointer"
            >
              {store.text('openProject')}
            </button>
          </div>
        )}
      </div>

      {/* Checkpoints Progress */}
      {totalCps > 0 ? (
        <div className="flex flex-col gap-1 mt-1">
          <div className="flex items-center justify-between text-[9px] font-bold font-mono text-slate-500">
            <span
              style={{
                color:
                  pct === 100
                    ? ContextOSTheme.success
                    : pct >= 80
                    ? ContextOSTheme.focus
                    : ContextOSTheme.pending,
              }}
            >
              {passedCps}/{totalCps} {store.text('checkpointsPassed')}
            </span>
            <span
              style={{
                color:
                  pct === 100
                    ? ContextOSTheme.success
                    : pct >= 80
                    ? ContextOSTheme.focus
                    : ContextOSTheme.pending,
              }}
            >
              {pct}%
            </span>
          </div>
          <div className="w-full bg-slate-200 h-1 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${pct}%`,
                backgroundColor:
                  pct === 100
                    ? ContextOSTheme.success
                    : pct >= 80
                    ? ContextOSTheme.focus
                    : ContextOSTheme.pending,
              }}
            />
          </div>
        </div>
      ) : (
        <div className="text-[8.5px] font-mono text-slate-400 mt-1">
          ● {store.text('noCheckpoints')}
        </div>
      )}
    </div>
  );
};

// --- Sidebar Item & Collapsible Section ---
const SidebarCollapsibleSection: React.FC<{
  store: GraphStore;
  section: SidebarSection;
  title: string;
  children: React.ReactNode;
}> = ({ store, section, title, children }) => {
  const collapsed = store.isSidebarSectionCollapsed(section);
  return (
    <div className="flex flex-col">
      <button
        onClick={() => store.setSidebarSection(section, !collapsed)}
        className="flex items-center gap-1.5 px-4 pt-3.5 pb-1.5 text-left text-slate-400 hover:text-slate-600 transition-colors"
      >
        <span className="text-[8px] font-bold">{collapsed ? '▸' : '▾'}</span>
        <span className="text-[9px] font-bold font-mono tracking-[1.35px] uppercase flex-1">
          {title}
        </span>
      </button>
      {!collapsed && <div className="flex flex-col gap-0.5">{children}</div>}
    </div>
  );
};

const SidebarItemButton: React.FC<{
  title: string;
  subtitle: string;
  color: string;
  selected: boolean;
  onClick: () => void;
}> = ({ title, subtitle, color, selected, onClick }) => {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2.5 px-2.5 py-1.5 mx-2 rounded-lg text-left transition-colors ${
        selected ? 'bg-slate-100' : 'hover:bg-slate-50'
      }`}
      style={{
        backgroundColor: selected ? `${color}18` : undefined,
      }}
    >
      <div
        className="w-[4px] h-[30px] rounded shrink-0"
        style={{ backgroundColor: color }}
      />
      <div className="flex flex-col min-w-0 flex-1">
        <span
          className="text-[11.5px] font-medium leading-tight truncate"
          style={{ color: ContextOSTheme.ink }}
        >
          {title}
        </span>
        <span
          className="text-[7.5px] font-bold font-mono tracking-[0.7px] truncate mt-0.5"
          style={{ color }}
        >
          {subtitle}
        </span>
      </div>
    </button>
  );
};

// --- Running Processes Section ---
const RunningProcessesSection: React.FC<{ store: GraphStore }> = ({ store }) => {
  const chinese = store.activeLocale === 'zh-Hans';
  const count = store.runningProcesses.length;

  return (
    <div className="mx-3 my-2 p-2.5 rounded-lg border border-slate-200/90 bg-slate-50/90 shadow-2xs flex flex-col gap-2">
      <div className="flex items-center justify-between text-[8.5px] font-mono font-bold text-slate-600 tracking-wider uppercase">
        <span className="flex items-center gap-1.5">
          <span
            className={`w-2 h-2 rounded-full ${count > 0 ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}`}
          />
          {chinese ? '后台守护进程' : 'RUNNING PROCESSES'}
        </span>
        <div className="flex items-center gap-1">
          <span className="text-[7px] font-mono bg-slate-200/70 text-slate-500 px-1 py-0.5 rounded">
            SYS-OPS
          </span>
          {count > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-600 font-bold text-[8px]">
              {count}
            </span>
          )}
        </div>
      </div>
      {count === 0 ? (
        <div className="text-[8.5px] text-slate-400 pl-1">
          ● {chinese ? '暂无运行中的长期任务' : 'No active background tasks'}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {store.runningProcesses.map((proc) => (
            <div
              key={proc.id}
              className="flex items-center justify-between p-1.5 rounded bg-white border border-slate-200/80 text-xs shadow-2xs"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{
                    backgroundColor:
                      proc.status === 'running' ? ContextOSTheme.success : ContextOSTheme.muted,
                  }}
                />
                <div className="flex flex-col min-w-0">
                  <span className="font-mono text-[9px] font-semibold truncate text-slate-800">
                    {proc.command}
                  </span>
                  <div className="flex items-center gap-2 text-[7.5px] font-mono text-slate-400">
                    <span>PID {proc.pid}</span>
                    {proc.port && <span className="text-blue-500 font-bold">:{proc.port}</span>}
                  </div>
                </div>
              </div>
              <button
                onClick={() => store.stopProcess(proc.id)}
                className="text-rose-500 hover:text-rose-700 ml-2 font-bold p-1 rounded hover:bg-rose-50 transition-colors"
                title={chinese ? '停止此长期任务' : 'Stop process'}
              >
                ■
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// --- Sidebar Legend ---
const SidebarLegend: React.FC<{ store: GraphStore }> = ({ store }) => {
  const chinese = store.activeLocale === 'zh-Hans';
  return (
    <div className="p-3.5 flex flex-col gap-2">
      <div className="text-[8px] font-mono font-bold text-slate-400 uppercase tracking-wider">
        {chinese ? '图例' : 'LEGEND'}
      </div>
      <div className="flex items-center gap-3 text-[8.5px] font-medium text-slate-600">
        <div className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: ContextOSTheme.blockKindColor('ui') }} />
          <span>{store.text('ui')}</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: ContextOSTheme.blockKindColor('service') }} />
          <span>{store.text('service')}</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: ContextOSTheme.blockKindColor('database') }} />
          <span>{store.text('data')}</span>
        </div>
      </div>
      <div className="flex items-center gap-3 text-[8.5px] font-medium text-slate-600">
        <div className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: ContextOSTheme.deliveryColor('complete') }} />
          <span>{chinese ? '完成' : 'Done'}</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: ContextOSTheme.deliveryColor('implementing') }} />
          <span>{chinese ? '进行中' : 'Active'}</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: ContextOSTheme.failure }} />
          <span>{chinese ? '失败/阻塞' : 'Failed'}</span>
        </div>
      </div>
      <div className="text-[9px] text-slate-400 leading-tight">
        {chinese
          ? '左侧色条＝Block 类型 · 图标＝交付状态 · 线色/虚线＝关系类型 · 外框＝Chain'
          : 'Left rail = Block type · icon = delivery · line = Link kind · enclosure = Chain'}
      </div>
    </div>
  );
};

// --- Canvas Toolbar ---
const CanvasToolbar: React.FC<{ store: GraphStore }> = ({ store }) => {
  const chinese = store.activeLocale === 'zh-Hans';
  return (
    <div className="px-4 py-2 bg-white flex items-center justify-between gap-4 z-10">
      <WrappingHStackLayout spacing={10} rowSpacing={6} className="flex-1">
        {store.availableKinds.map((kind) => {
          const isChecked = !store.hiddenKinds.has(kind);
          return (
            <label
              key={kind}
              className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-700 cursor-pointer select-none"
            >
              <input
                type="checkbox"
                checked={isChecked}
                onChange={(e) => store.setKindVisible(kind, e.target.checked)}
                className="rounded text-blue-600 focus:ring-0 cursor-pointer w-3.5 h-3.5"
              />
              <span>{store.kindTitle(kind)}</span>
            </label>
          );
        })}
      </WrappingHStackLayout>

      <div className="flex items-center gap-3 shrink-0">
        <button
          onClick={() => store.fitOverview()}
          className="p-1.5 rounded hover:bg-slate-100 text-slate-700 transition-colors"
          title={chinese ? '居中自适应视图' : 'Fit overview'}
        >
          ⤢
        </button>
        <span
          className="text-[9px] font-mono font-semibold text-slate-500"
          title={chinese ? '触控板捏合、⌘滚动或双击缩放' : 'Pinch or scroll to zoom'}
        >
          {Math.round(store.canvasScale * 100)}%
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            store.setSettingsPresented(true);
          }}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 text-[11px] font-semibold text-slate-800 transition-colors cursor-pointer select-none"
        >
          <span>⚙</span>
          <span>{store.text('settings')}</span>
        </button>
      </div>
    </div>
  );
};

// --- Settings Modal (1:1 Port of SettingsView, SoftwareUpdateSection, EditorPlatformRow) ---
export const SettingsModal: React.FC<{ store: GraphStore }> = ({ store }) => {
  const chinese = store.activeLocale === 'zh-Hans';
  const [isEditingRepo, setIsEditingRepo] = useState(false);
  const [customRepoInput, setCustomRepoInput] = useState(store.updater.repository);

  const sectionHeader = (title: string) => (
    <div className="text-[9.5px] font-mono font-bold text-slate-400 uppercase tracking-[1.1px] pl-1.5 mb-1.5">
      {title}
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-in fade-in duration-150">
      <div className="w-[740px] max-h-[88vh] bg-[#fafafa] rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-slate-200/80">
        {/* Navigation Bar */}
        <div className="px-6 py-3.5 bg-white border-b border-slate-200/70 flex items-center justify-between shrink-0">
          <h3 className="text-[15px] font-semibold text-slate-900 tracking-tight">
            {store.text('settings')}
          </h3>
          <button
            onClick={() => store.setSettingsPresented(false)}
            className="px-3 py-1 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-sm transition-colors cursor-pointer"
          >
            {store.text('done')}
          </button>
        </div>

        {/* Content Body: Two Columns */}
        <div className="flex-1 overflow-y-auto p-5 grid grid-cols-[330px_1fr] gap-4">
          {/* Left Column: Preferences + Software Update + Live Data */}
          <div className="flex flex-col gap-3.5">
            {/* 1. Preferences */}
            <div>
              {sectionHeader(chinese ? '偏好设置' : 'PREFERENCES')}
              <div className="bg-white rounded-xl border border-slate-200/70 shadow-xs divide-y divide-slate-100 overflow-hidden">
                {/* Language Row */}
                <div className="px-3 py-2 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 text-slate-800 font-medium">
                    <span className="text-slate-400 text-sm">🌐</span>
                    <span>{store.text('language')}</span>
                  </div>
                  <select
                    value={store.language}
                    onChange={(e) => store.setLanguage(e.target.value as any)}
                    className="px-2 py-0.5 border border-slate-200 rounded text-xs text-slate-700 bg-slate-50 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="system">{store.text('system')}</option>
                    <option value="zhHans">{store.text('chinese')}</option>
                    <option value="english">{store.text('english')}</option>
                  </select>
                </div>

                {/* Appearance Row */}
                <div className="px-3 py-2 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 text-slate-800 font-medium">
                    <span className="text-slate-400 text-sm">◐</span>
                    <span>{store.text('appearance')}</span>
                  </div>
                  <select
                    value={store.appearance}
                    onChange={(e) => store.setAppearance(e.target.value as any)}
                    className="px-2 py-0.5 border border-slate-200 rounded text-xs text-slate-700 bg-slate-50 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="system">{store.text('system')}</option>
                    <option value="light">{store.text('light')}</option>
                    <option value="dark">{store.text('dark')}</option>
                  </select>
                </div>
              </div>
            </div>

            {/* 2. Software Update Section */}
            <div>
              {sectionHeader(store.text('softwareUpdate').toUpperCase())}
              <div className="bg-white rounded-xl border border-slate-200/70 shadow-xs overflow-hidden flex flex-col">
                {/* Header Row: App Info & Status */}
                <div className="p-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-[6.5px] bg-slate-50 border border-black/10 flex items-center justify-center text-slate-700 text-sm shadow-2xs">
                      🔄
                    </div>
                    <div className="flex flex-col">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-semibold text-slate-900 tracking-tight">ContextOS</span>
                        <span className="text-[9.5px] font-mono font-bold text-slate-500 px-1 py-0.5 bg-black/5 rounded">
                          v{AppUpdater.currentAppVersion}
                        </span>
                      </div>
                      {/* Status Line */}
                      <div className="text-[10px] text-slate-500 flex items-center gap-1 mt-0.5">
                        {store.updater.state.type === 'idle' && <span>{store.text('checkUpdate')}</span>}
                        {store.updater.state.type === 'checking' && (
                          <span className="flex items-center gap-1">
                            <span className="animate-spin text-[9px]">⌛</span>
                            <span>{store.text('checkingUpdate')}</span>
                          </span>
                        )}
                        {store.updater.state.type === 'upToDate' && (
                          <span className="flex items-center gap-1 text-emerald-600 font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                            <span>{store.text('upToDate')}</span>
                          </span>
                        )}
                        {store.updater.state.type === 'updateAvailable' && (
                          <span className="flex items-center gap-1 text-blue-600 font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                            <span>
                              {store.text('newVersionFound')}: v{store.updater.state.latest.version}
                            </span>
                          </span>
                        )}
                        {store.updater.state.type === 'downloading' && (
                          <span className="text-blue-600 font-medium">
                            {store.text('downloadingUpdate')} {Math.round(store.updater.state.progress * 100)}%
                          </span>
                        )}
                        {store.updater.state.type === 'readyToInstall' && (
                          <span className="flex items-center gap-1 text-emerald-600 font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                            <span>{store.text('restartAndUpdate')}</span>
                          </span>
                        )}
                        {store.updater.state.type === 'failed' && (
                          <span className="flex items-center gap-1 text-rose-500 font-medium">
                            <span>⚠</span>
                            <span className="truncate max-w-[150px]">{store.updater.state.message}</span>
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Header Action Button */}
                  <div>
                    {store.updater.state.type === 'checking' ? (
                      <span className="animate-spin text-xs text-slate-400">⌛</span>
                    ) : store.updater.state.type === 'failed' ? (
                      <button
                        onClick={() => store.updater.checkForUpdates(true)}
                        className="px-2 py-1 text-[11px] font-medium rounded border border-slate-200 hover:bg-slate-50 text-slate-700 transition-colors"
                      >
                        {store.text('retry')}
                      </button>
                    ) : store.updater.state.type === 'idle' || store.updater.state.type === 'upToDate' ? (
                      <button
                        onClick={() => store.updater.checkForUpdates(true)}
                        className="px-2 py-1 text-[11px] font-medium rounded border border-slate-200 hover:bg-slate-50 text-slate-700 transition-colors"
                      >
                        {store.text('checkUpdate')}
                      </button>
                    ) : null}
                  </div>
                </div>

                {/* Update Controls (When update available) */}
                {store.updater.state.type === 'updateAvailable' && (() => {
                  const updateState = store.updater.state as Extract<typeof store.updater.state, { type: 'updateAvailable' }>;
                  return (
                    <div className="border-t border-slate-100 flex flex-col p-3 gap-2.5 bg-slate-50/50">
                      {/* Version Selector */}
                      <div className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-1.5 text-slate-700 font-medium">
                          <span className="text-slate-400">🏷️</span>
                          <span>{store.text('selectVersion')}</span>
                        </div>
                        <select
                          value={store.updater.selectedReleaseId || updateState.latest.id}
                          onChange={(e) => store.updater.setSelectedReleaseId(Number(e.target.value))}
                          className="px-2 py-0.5 border border-slate-200 rounded text-xs bg-white text-slate-700"
                        >
                          {updateState.releases.map((rel) => (
                            <option key={rel.id} value={rel.id}>
                              {rel.name || rel.tagName}
                              {rel.id === updateState.latest.id ? (chinese ? ' (最新)' : ' (Latest)') : ''}
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* Edition Selector */}
                      <div className="flex flex-col gap-1 text-xs">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5 text-slate-700 font-medium">
                            <span className="text-slate-400">📦</span>
                            <span>{store.text('selectEdition')}</span>
                          </div>
                          <div className="flex items-center bg-slate-200/80 p-0.5 rounded-md text-[11px]">
                            <button
                              onClick={() => store.updater.setSelectedEdition('full')}
                              className={`px-2 py-0.5 rounded ${
                                store.updater.selectedEdition === 'full'
                                  ? 'bg-white font-semibold text-slate-900 shadow-2xs'
                                  : 'text-slate-600 hover:text-slate-900'
                              }`}
                            >
                              {chinese ? '全功能版' : 'Full'}
                            </button>
                            <button
                              onClick={() => store.updater.setSelectedEdition('standard')}
                              className={`px-2 py-0.5 rounded ${
                                store.updater.selectedEdition === 'standard'
                                  ? 'bg-white font-semibold text-slate-900 shadow-2xs'
                                  : 'text-slate-600 hover:text-slate-900'
                              }`}
                            >
                              {chinese ? '轻量版' : 'Standard'}
                            </button>
                          </div>
                        </div>

                        {/* Node Qualification Badge */}
                        <div className="pl-5 text-[9px] flex items-center gap-1">
                          {store.updater.nodeEnvironment.isQualified ? (
                            <span className="text-slate-500 flex items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                              <span>
                                {chinese ? '系统 Node 22+ 合格 (推荐轻量版)' : 'System Node 22+ qualified (Standard recommended)'}
                              </span>
                            </span>
                          ) : (
                            <span className="text-amber-600 flex items-center gap-1 font-medium">
                              <span>⚠</span>
                              <span>
                                {chinese
                                  ? '系统未检测到 Node 22+ (已默认选全功能版)'
                                  : 'Node 22+ missing locally, Full edition auto-selected'}
                              </span>
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Release Notes Toggle */}
                      {updateState.latest.body && (
                        <div className="flex flex-col gap-1.5 pt-1">
                          <button
                            onClick={() => store.updater.setShowReleaseNotes(!store.updater.showReleaseNotes)}
                            className="flex items-center gap-1 text-[10px] font-medium text-blue-600 hover:text-blue-700"
                          >
                            <span>{store.updater.showReleaseNotes ? '▼' : '▶'}</span>
                            <span>
                              {store.updater.showReleaseNotes
                                ? store.text('hideReleaseNotes')
                                : store.text('viewReleaseNotes')}
                            </span>
                          </button>
                          {store.updater.showReleaseNotes && (
                            <div className="max-h-28 overflow-y-auto p-2 bg-white rounded border border-slate-200 text-[10px] font-mono text-slate-700 whitespace-pre-wrap leading-relaxed select-text">
                              {updateState.latest.body}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Action Buttons */}
                      <div className="flex items-center justify-between pt-1 border-t border-slate-200/60">
                        <button
                          onClick={() => window.open(updateState.latest.htmlUrl, '_blank')}
                          className="px-2 py-1 text-[10px] font-medium rounded border border-slate-200 bg-white hover:bg-slate-50 text-slate-700"
                        >
                          {store.text('openInBrowser')}
                        </button>
                        <button
                          onClick={() =>
                            store.updater.downloadAndApplyUpdate(
                              updateState.latest,
                              store.updater.selectedEdition
                            )
                          }
                          className="px-3 py-1 text-[10px] font-semibold rounded bg-blue-600 hover:bg-blue-700 text-white shadow-2xs flex items-center gap-1"
                        >
                          <span>⬇</span>
                          <span>{store.text('updateNow')}</span>
                        </button>
                      </div>
                    </div>
                  );
                })()}

                {/* Downloading Progress Bar */}
                {store.updater.state.type === 'downloading' && (
                  <div className="border-t border-slate-100 p-3 flex flex-col gap-1.5 bg-slate-50/50">
                    <div className="flex items-center justify-between text-[10px] text-slate-600">
                      <span>{store.text('downloadingUpdate')}</span>
                      <span className="font-mono font-semibold">
                        {Math.round(store.updater.state.progress * 100)}%
                      </span>
                    </div>
                    <div className="w-full bg-slate-200 rounded-full h-1.5 overflow-hidden">
                      <div
                        className="bg-blue-600 h-1.5 rounded-full transition-all duration-300"
                        style={{ width: `${Math.round(store.updater.state.progress * 100)}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Ready to Install Button */}
                {store.updater.state.type === 'readyToInstall' && (
                  <div className="border-t border-slate-100 p-3 bg-emerald-50/50 flex items-center justify-between">
                    <span className="text-[10px] text-emerald-700 font-medium flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                      <span>{store.text('restartAndUpdate')}</span>
                    </span>
                    <button
                      onClick={async () => {
                        if (store.updater.state.type === 'readyToInstall') {
                          const launched = await store.updater.applyStagedUpdate();
                          if (!launched && store.updater.state.stagedAppURL && store.updater.state.stagedAppURL.startsWith('http')) {
                            window.open(store.updater.state.stagedAppURL, '_blank');
                          }
                        }
                      }}
                      className="px-3 py-1 text-[10px] font-semibold rounded bg-emerald-600 hover:bg-emerald-700 text-white shadow-2xs"
                    >
                      {chinese ? '完成更新' : 'Install Update'}
                    </button>
                  </div>
                )}

                {/* Git Repository Row */}
                <div className="border-t border-slate-100 px-3 py-2 flex items-center justify-between text-xs bg-slate-50/30">
                  <div className="flex items-center gap-1.5 text-slate-500">
                    <span className="text-[11px]">ᛘ</span>
                    <span className="text-[10.5px]">{store.text('gitRepository')}</span>
                  </div>
                  {isEditingRepo ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={customRepoInput}
                        onChange={(e) => setCustomRepoInput(e.target.value)}
                        className="px-1.5 py-0.5 border border-slate-300 rounded text-[10px] font-mono w-36 bg-white"
                        placeholder="owner/repo"
                      />
                      <button
                        onClick={() => {
                          if (customRepoInput.trim()) {
                            store.updater.setRepository(customRepoInput.trim());
                          }
                          setIsEditingRepo(false);
                        }}
                        className="px-2 py-0.5 text-[10px] font-semibold bg-blue-600 text-white rounded hover:bg-blue-700"
                      >
                        {chinese ? '确定' : 'OK'}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        setCustomRepoInput(store.updater.repository);
                        setIsEditingRepo(true);
                      }}
                      className="flex items-center gap-1 text-[9.5px] font-mono text-slate-700 hover:text-slate-900 group"
                    >
                      <span>{store.updater.repository}</span>
                      <span className="text-slate-400 group-hover:text-slate-600 text-[10px]">✏️</span>
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* 3. Live Data Engine */}
            <div>
              {sectionHeader(store.text('liveData').toUpperCase())}
              <div className="bg-white rounded-xl border border-slate-200/70 shadow-xs divide-y divide-slate-100 overflow-hidden flex flex-col">
                <div className="p-3 flex items-center justify-between gap-3">
                  <div className="flex flex-col min-w-0">
                    <span className="text-[8px] font-mono font-bold text-slate-400 uppercase tracking-wider">
                      {chinese ? '当前数据库' : 'DATABASE'}
                    </span>
                    <span className="text-[10px] font-mono text-slate-800 truncate select-text">
                      {store.databasePath}
                    </span>
                  </div>
                  <button
                    onClick={() => store.chooseProject()}
                    className="px-2 py-0.5 text-[10px] font-medium rounded border border-slate-200 hover:bg-slate-50 text-slate-700 shrink-0"
                  >
                    {store.text('changeProject')}
                  </button>
                </div>
                <div className="px-3 py-1.5 flex items-center justify-between text-[10px] text-slate-500 bg-slate-50/40">
                  <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    <span>{store.text('liveHelp')}</span>
                  </div>
                  <span className="text-[7.5px] font-mono font-bold text-slate-400 tracking-wider">
                    SQLITE · GRAPH.JSON
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: AI Client MCP Bridges (1:1 with EditorPlatformRow) */}
          <div className="flex flex-col gap-2">
            {sectionHeader(store.text('plugin').toUpperCase())}

            {/* Sync Error Banner */}
            {store.syncErrorMessage && (
              <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 flex items-center justify-between text-xs text-rose-700">
                <div className="flex items-center gap-2">
                  <span>⚠</span>
                  <span className="text-[10.5px] font-medium">{store.syncErrorMessage}</span>
                </div>
                <button
                  onClick={() => (store.syncErrorMessage = null)}
                  className="text-rose-400 hover:text-rose-600 font-bold ml-2 text-xs"
                >
                  ✕
                </button>
              </div>
            )}

            {/* Editor Platform Rows Container */}
            <div className="bg-white rounded-xl border border-slate-200/70 shadow-xs divide-y divide-slate-100 overflow-hidden flex flex-col">
              {store.editorStatuses.map((status) => (
                <EditorPlatformRow key={status.id} status={status} store={store} />
              ))}
            </div>

            {/* Runtime Handshake & Help Text */}
            <div className="px-1 flex flex-col gap-1 mt-1">
              <span className="font-mono text-[9.5px] text-slate-500 select-text">
                {store.runtimeHandshake}
              </span>
              <p className="text-[10px] text-slate-500 leading-relaxed">
                {store.text('pluginHelp')}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// --- Editor Platform Row (1:1 with EditorPlatformRow.swift) ---
const EditorPlatformRow: React.FC<{ status: EditorPlatformStatus; store: GraphStore }> = ({
  status,
  store,
}) => {
  const chinese = store.activeLocale === 'zh-Hans';

  const getPlatformIcon = (id: string) => {
    switch (id) {
      case 'claude':
        return '💬';
      case 'cursor':
        return '</>';
      case 'antigravity':
        return '✨';
      case 'opencode':
        return '{}';
      case 'codex':
        return '⌘';
      default:
        return '⚙';
    }
  };

  const isSyncing = store.syncingPlatformId === status.id;

  return (
    <div className="p-2.5 flex items-center justify-between gap-3 hover:bg-slate-50/60 transition-colors">
      {/* Precision Icon Squircle */}
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="w-7 h-7 rounded-[6.5px] bg-slate-50 border border-black/10 flex items-center justify-center text-xs text-slate-800 shadow-2xs shrink-0">
          {getPlatformIcon(status.id)}
        </div>

        {/* Platform Details */}
        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              className={`text-xs font-medium tracking-tight ${
                status.isAppInstalled ? 'text-slate-900' : 'text-slate-400'
              }`}
            >
              {status.name}
            </span>

            {/* Status Pills */}
            {!status.isAppInstalled ? (
              <span className="text-[7.5px] font-mono font-bold text-slate-400 tracking-wide px-1.5 py-0.5 bg-black/4 rounded-full">
                {store.text('notDetected')}
              </span>
            ) : status.appVersion && status.targetVersion && status.appVersion !== status.targetVersion ? (
              <span className="text-[7.5px] font-medium text-amber-700 px-1.5 py-0.5 bg-amber-50 rounded-full border border-amber-200/50">
                App v{status.appVersion} ↔ Plugin v{status.targetVersion} · {store.text('versionMismatch')}
              </span>
            ) : status.isSynced ? (
              <span className="text-[7.5px] font-semibold text-emerald-700 px-1.5 py-0.5 bg-emerald-50 rounded-full border border-emerald-200/50">
                v{status.installedVersion || status.targetVersion} · {store.text('latest')}
              </span>
            ) : status.installedBuild && status.targetBuild && status.installedBuild !== status.targetBuild ? (
              <span className="text-[7.5px] font-bold text-amber-700 px-1.5 py-0.5 bg-amber-50 rounded-full border border-amber-200/50">
                {store.text('bundleChanged')}
              </span>
            ) : status.isOutdated ? (
              <span className="text-[7.5px] font-medium text-amber-700 px-1.5 py-0.5 bg-amber-50 rounded-full border border-amber-200/50">
                v{status.installedVersion || '?'} ➔ v{status.targetVersion} · {store.text('updateAvailable')}
              </span>
            ) : (
              <span className="text-[7.5px] font-mono font-bold text-slate-400 tracking-wide px-1.5 py-0.5 bg-black/4 rounded-full">
                {store.text('notConfigured')}
              </span>
            )}
          </div>

          <span
            className={`font-mono text-[8.5px] truncate max-w-[210px] select-text ${
              status.isAppInstalled ? 'text-slate-500' : 'text-slate-400/60'
            }`}
          >
            {status.configPath}
          </span>
        </div>
      </div>

      {/* Trailing Actions */}
      <div className="shrink-0 flex items-center gap-2">
        {!status.isAppInstalled ? (
          <span className="text-[10px] font-medium text-slate-400/70 w-12 text-right">
            {store.text('skipped')}
          </span>
        ) : isSyncing ? (
          <span className="flex items-center gap-1 text-[10px] text-blue-600 font-medium">
            <span className="animate-spin text-[9px]">⌛</span>
            <span>{store.text('syncing')}</span>
          </span>
        ) : status.isSynced ? (
          <div className="flex items-center gap-1.5">
            <span className="flex items-center gap-1 text-[10px] text-emerald-600 font-medium">
              <span className="text-xs">✓</span>
              <span>{store.text('synced')}</span>
            </span>
            <button
              onClick={() => store.syncEditor(status.id)}
              className="px-2 py-0.5 text-[9.5px] font-medium rounded border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 transition-colors flex items-center gap-0.5"
            >
              <span className="text-[9px]">↻</span>
              <span>{store.text('reinstall')}</span>
            </button>
          </div>
        ) : (
          <button
            onClick={() => store.syncEditor(status.id)}
            className="px-2.5 py-0.5 text-[10px] font-semibold rounded bg-blue-600 hover:bg-blue-700 text-white shadow-2xs transition-colors"
          >
            {store.text('syncSingle')}
          </button>
        )}
      </div>
    </div>
  );
};

