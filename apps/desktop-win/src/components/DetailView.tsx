// 1:1 Port of apps/desktop/Sources/ContextOSDesktop/DetailView.swift

import React, { useState } from 'react';
import { GraphStore } from '../graphStore';
import {
  BlockItem,
  ChainItem,
  CheckpointItem,
  GraphSelection,
  HistoryItem,
  LinkItem,
  PlanChangeItem,
  PlanItem,
  PlanStep,
  SourceReference,
} from '../models';
import { ContextOSTheme } from '../theme';

interface DetailViewProps {
  store: GraphStore;
  selection: GraphSelection;
}

export const DetailView: React.FC<DetailViewProps> = ({ store, selection }) => {
  const [expandedScopeIDs, setExpandedScopeIDs] = useState<Set<string>>(new Set());
  const [expandedChangeIDs, setExpandedChangeIDs] = useState<Set<string>>(new Set());
  const [expandedStepIDs, setExpandedStepIDs] = useState<Set<string>>(new Set());
  const [expandedCheckpointIDs, setExpandedCheckpointIDs] = useState<Set<string>>(new Set());
  const [expandedHistoryIDs, setExpandedHistoryIDs] = useState<Set<number>>(new Set());
  const [showCodeStream, setShowCodeStream] = useState(false);
  const [copiedStream, setCopiedStream] = useState(false);

  const toggleSet = <T,>(item: T, currentSet: Set<T>, setter: (s: Set<T>) => void) => {
    const next = new Set(currentSet);
    if (next.has(item)) next.delete(item);
    else next.add(item);
    setter(next);
  };

  const chinese = store.activeLocale === 'zh-Hans';

  return (
    <div className="flex-1 h-full overflow-y-auto bg-white border-l border-slate-200 select-text">
      <div className="p-4 flex flex-col gap-4">
        {/* Header with Title & Close button */}
        <div className="flex items-start justify-between gap-2">
          <h2
            className="text-[17px] font-semibold tracking-tight line-clamp-3 leading-snug"
            style={{ color: ContextOSTheme.ink }}
          >
            {store.title(selection)}
          </h2>
          <button
            onClick={() => store.clearSelection()}
            className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
            title={chinese ? '关闭详情' : 'Close details'}
          >
            ✕
          </button>
        </div>

        {/* Entity specific content */}
        {selection.type === 'block' && <BlockDetail store={store} blockID={selection.id} />}
        {selection.type === 'chain' && (
          <ChainDetail
            store={store}
            chainID={selection.id}
            showCodeStream={showCodeStream}
            setShowCodeStream={setShowCodeStream}
            copiedStream={copiedStream}
            setCopiedStream={setCopiedStream}
          />
        )}
        {selection.type === 'link' && <LinkDetail store={store} linkID={selection.id} />}
        {selection.type === 'plan' && (
          <PlanDetail
            store={store}
            planID={selection.id}
            expandedScopeIDs={expandedScopeIDs}
            setExpandedScopeIDs={setExpandedScopeIDs}
            expandedChangeIDs={expandedChangeIDs}
            setExpandedChangeIDs={setExpandedChangeIDs}
            expandedStepIDs={expandedStepIDs}
            setExpandedStepIDs={setExpandedStepIDs}
            toggleSet={toggleSet}
          />
        )}
        {selection.type === 'decision' && <DecisionDetail store={store} decisionID={selection.id} />}

        {/* Revision Section */}
        <RevisionSection store={store} selection={selection} />

        {/* Checkpoints Section */}
        <CheckpointsSection
          store={store}
          selection={selection}
          expandedIDs={expandedCheckpointIDs}
          setExpandedIDs={setExpandedCheckpointIDs}
          toggleSet={toggleSet}
        />

        {/* History Section */}
        <HistorySection
          store={store}
          selection={selection}
          expandedIDs={expandedHistoryIDs}
          setExpandedIDs={setExpandedHistoryIDs}
          toggleSet={toggleSet}
        />
      </div>
    </div>
  );
};

// --- Subsections ---

const SectionHeader: React.FC<{ title: string }> = ({ title }) => (
  <div className="text-[9px] font-bold font-mono tracking-[1.4px] text-slate-500 uppercase mt-2">
    {title}
  </div>
);

const DetailSection: React.FC<{ title: string; text?: string }> = ({ title, text }) => {
  if (!text || text.trim() === '') return null;
  return (
    <div className="flex flex-col gap-1.5">
      <SectionHeader title={title} />
      <div className="text-[12px] text-slate-800 leading-relaxed whitespace-pre-wrap">{text}</div>
    </div>
  );
};

const MetadataPills: React.FC<{ items: string[] }> = ({ items }) => (
  <div className="flex items-center gap-2 flex-wrap">
    {items.filter(Boolean).map((item, idx) => (
      <React.Fragment key={idx}>
        {idx > 0 && <span className="text-[9px] font-bold text-slate-300">·</span>}
        <span className="text-[8px] font-bold font-mono tracking-[0.7px] text-slate-500 uppercase">
          {item}
        </span>
      </React.Fragment>
    ))}
  </div>
);

// --- Block Detail ---
const BlockDetail: React.FC<{ store: GraphStore; blockID: string }> = ({ store, blockID }) => {
  const block = store.block(blockID);
  if (!block) return null;
  const chinese = store.activeLocale === 'zh-Hans';
  const ruleScope = store.ruleScopeLabel(block.id);
  const sources = store.sourceReferences(block.id);
  const hasSymbol = sources.some((s) => s.symbol !== null && s.symbol !== undefined);
  const chains = store.chains(block.id);
  const incoming = store.incomingLinks(block.id);
  const outgoing = store.outgoingLinks(block.id);
  const plans = store.plansContaining(block.id);

  return (
    <div className="flex flex-col gap-3">
      <MetadataPills
        items={[
          block.architectureLayer,
          block.scope,
          ruleScope ? (chinese ? `规则 · ${ruleScope}` : `RULE · ${ruleScope}`) : '',
          block.localOrder !== 0 ? `#${block.localOrder}` : '',
        ]}
      />

      {/* Ghost or Solid Badge */}
      <div className="flex items-center gap-2">
        {block.isGhost ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold bg-indigo-50 text-indigo-600">
            ✦ {chinese ? '虚拟蓝图 (Ghost Blueprint) · 0 代码消耗' : 'Ghost Blueprint · 0 Token Overhead'}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold bg-emerald-50 text-emerald-600">
            ■ {hasSymbol
              ? chinese
                ? '实体落地 · AST 门面压缩'
                : 'Solid · AST Facade Compressed'
              : chinese
              ? '实体落地 (Solid Anchored)'
              : 'Solid Anchored'}
          </span>
        )}
      </div>

      <DetailSection title={store.text('summary').toUpperCase()} text={store.blockText(block, 'summary')} />
      <DetailSection title={store.text('details').toUpperCase()} text={store.blockText(block, 'body')} />
      <DetailSection title={store.text('contract').toUpperCase()} text={store.blockText(block, 'contract')} />

      {/* Memberships in Chains */}
      {chains.length > 0 && (
        <div className="flex flex-col gap-1.5 mt-2">
          <SectionHeader title={store.text('memberships').toUpperCase()} />
          {chains.map((chain) => {
            const pos = store.chainPosition(chain.id, block.id);
            return (
              <button
                key={chain.id}
                onClick={() => store.select({ type: 'chain', id: chain.id })}
                className="flex items-center gap-2.5 py-1.5 border-b border-slate-100 hover:bg-slate-50 text-left transition-colors"
              >
                <div
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: store.chainColor(chain.id) }}
                />
                <div className="flex flex-col flex-1 min-w-0">
                  <span className="text-[11.5px] font-medium text-slate-800 truncate">
                    {store.chainText(chain, 'title')}
                  </span>
                  <span className="text-[8.5px] font-mono font-bold text-slate-400">
                    {pos ? `${pos.index + 1} / ${pos.count}` : ''} · {chain.deliveryState.toUpperCase()}
                  </span>
                </div>
                <span className="text-slate-400 text-xs">→</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Upstream & Downstream Links */}
      {incoming.length > 0 && (
        <div className="flex flex-col gap-1.5 mt-2">
          <SectionHeader title={store.text('upstream').toUpperCase()} />
          {incoming.map((link) => (
            <button
              key={link.id}
              onClick={() => store.select({ type: 'link', id: link.id })}
              className="flex items-center gap-2 py-1.5 border-b border-slate-100 hover:bg-slate-50 text-left transition-colors"
            >
              <span
                className="text-xs"
                style={{ color: ContextOSTheme.healthColor(link.healthState) }}
              >
                ←
              </span>
              <div className="flex flex-col flex-1 min-w-0">
                <span className="text-[11.5px] font-medium text-slate-800 truncate">
                  {store.block(link.sourceId)?.title || link.sourceId}
                </span>
                <span className="text-[8.5px] font-mono font-bold text-slate-400 uppercase">
                  {link.label || link.kind}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      {outgoing.length > 0 && (
        <div className="flex flex-col gap-1.5 mt-2">
          <SectionHeader title={store.text('downstream').toUpperCase()} />
          {outgoing.map((link) => (
            <button
              key={link.id}
              onClick={() => store.select({ type: 'link', id: link.id })}
              className="flex items-center gap-2 py-1.5 border-b border-slate-100 hover:bg-slate-50 text-left transition-colors"
            >
              <span
                className="text-xs"
                style={{ color: ContextOSTheme.healthColor(link.healthState) }}
              >
                →
              </span>
              <div className="flex flex-col flex-1 min-w-0">
                <span className="text-[11.5px] font-medium text-slate-800 truncate">
                  {store.block(link.targetId)?.title || link.targetId}
                </span>
                <span className="text-[8.5px] font-mono font-bold text-slate-400 uppercase">
                  {link.label || link.kind}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Related Plans */}
      {plans.length > 0 && (
        <div className="flex flex-col gap-1.5 mt-2">
          <SectionHeader title={store.text('relatedPlans').toUpperCase()} />
          {plans.map((p) => (
            <button
              key={p.id}
              onClick={() => store.select({ type: 'plan', id: p.id })}
              className="flex items-center justify-between py-1.5 border-b border-slate-100 hover:bg-slate-50 text-left transition-colors"
            >
              <div className="flex items-center gap-2 min-w-0">
                <div
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: ContextOSTheme.planColor(p.status) }}
                />
                <span className="text-[11.5px] font-medium text-slate-800 truncate">
                  {store.planText(p, 'title')}
                </span>
              </div>
              <span
                className="text-[8px] font-bold font-mono ml-2 uppercase shrink-0"
                style={{ color: ContextOSTheme.planColor(p.status) }}
              >
                {p.status}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* File & Code Locators (Sources) */}
      {sources.length > 0 && (
        <div className="flex flex-col gap-2 mt-2">
          <div className="flex items-center justify-between">
            <SectionHeader title={store.text('files').toUpperCase()} />
            <span className="text-[8.5px] font-mono font-semibold text-blue-600">
              {chinese ? '代码与目录绑定' : 'Code & Directory Bindings'}
            </span>
          </div>
          {sources.map((src) => (
            <div key={src.id} className="flex flex-col gap-1 py-1.5 border-b border-slate-100">
              <button
                onClick={() => store.revealSource(src)}
                className="flex items-start gap-2 text-left hover:bg-slate-50 rounded p-1 transition-colors"
              >
                <span className="text-slate-500 font-mono text-xs">📄</span>
                <div className="flex flex-col min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[11px] font-mono font-semibold text-slate-800 truncate">
                      {src.path}
                    </span>
                    {src.startLine && src.endLine && (
                      <span className="text-[8.5px] font-mono font-bold px-1 py-0.5 bg-slate-100 text-slate-500 rounded">
                        L{src.startLine}-L{src.endLine}
                      </span>
                    )}
                  </div>
                  {src.symbol ? (
                    <span className="text-[10px] font-mono font-medium text-blue-600 truncate">
                      {src.symbol}
                    </span>
                  ) : (
                    <span className="text-[9.5px] font-mono text-slate-400">{src.role}</span>
                  )}
                </div>
                <span className="text-slate-400 text-xs">↗</span>
              </button>
              {src.startLine && src.endLine && (
                <div className="pl-6 text-[8.5px] font-mono text-slate-400 flex items-center gap-1">
                  <span className="text-emerald-500">🛡</span>
                  {chinese
                    ? `按定位读取：仅切片 ${src.endLine - src.startLine + 1} 行（约 ${(src.endLine - src.startLine + 1) * 7} tokens）`
                    : `Exact locator read: ~${(src.endLine - src.startLine + 1) * 7} tokens (${src.endLine - src.startLine + 1} LOC)`}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// --- Chain Detail ---
const ChainDetail: React.FC<{
  store: GraphStore;
  chainID: string;
  showCodeStream: boolean;
  setShowCodeStream: (b: boolean) => void;
  copiedStream: boolean;
  setCopiedStream: (b: boolean) => void;
}> = ({
  store,
  chainID,
  showCodeStream,
  setShowCodeStream,
  copiedStream,
  setCopiedStream,
}) => {
  const chain = store.snapshot.chains.find((c) => c.id === chainID);
  if (!chain) return null;
  const chinese = store.activeLocale === 'zh-Hans';
  const nodeIDs = store.chainNodeIDs(chain.id);
  const linkIDs = store.chainLinkIDs(chain.id);

  const copyCodeStream = () => {
    let text = `# Chain Code Stream: ${chain.id}\n## Purpose: ${chain.intent || chain.title}\n\n`;
    for (let i = 0; i < nodeIDs.length; i++) {
      const b = store.block(nodeIDs[i]);
      if (!b) continue;
      text += `### Node ${i + 1}: [block:${b.id}] ${b.title} (${b.isGhost ? 'Ghost' : 'Solid'})\n`;
      text += `- Layer: ${b.architectureLayer} · Delivery: ${b.deliveryState}\n`;
      if (b.contract) text += `- Contract: ${b.contract}\n`;
      text += '\n';
    }
    navigator.clipboard.writeText(text);
    setCopiedStream(true);
    setTimeout(() => setCopiedStream(false), 2000);
  };

  return (
    <div className="flex flex-col gap-3">
      <MetadataPills
        items={[
          chain.chainType === 'composite' ? 'COMPOSITE CHAIN' : 'LEAF CHAIN',
          chain.deliveryState,
          chain.healthState,
        ]}
      />

      <DetailSection title={store.text('summary').toUpperCase()} text={store.chainText(chain, 'intent')} />

      {/* Contract (Input & Output) */}
      {(chain.inputContract || chain.outputContract) && (
        <div className="flex flex-col gap-1.5">
          <SectionHeader title={store.text('contract').toUpperCase()} />
          {chain.inputContract && (
            <div className="text-[11.5px] text-slate-700">
              <span className="font-bold text-slate-500">{store.text('input')} — </span>
              {store.chainText(chain, 'inputContract')}
            </div>
          )}
          {chain.outputContract && (
            <div className="text-[11.5px] text-slate-700">
              <span className="font-bold text-slate-500">{store.text('output')} — </span>
              {store.chainText(chain, 'outputContract')}
            </div>
          )}
        </div>
      )}

      {/* Contract Stream & Token Economy */}
      <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/50 flex flex-col gap-2 mt-2">
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-bold font-mono tracking-wider text-slate-500 uppercase">
            {chinese ? '契约流与 TOKEN 预算' : 'CONTRACT STREAM & TOKEN BUDGET'}
          </span>
          <span className="text-[8px] font-bold font-mono px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded-full">
            85% SAVED
          </span>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-slate-600 font-medium">
          <span>● {nodeIDs.length} Nodes</span>
          <span>● AST Facade Mode</span>
        </div>
        <div className="flex items-center gap-2 mt-1">
          <button
            onClick={copyCodeStream}
            className="px-2.5 py-1 text-[10px] font-semibold rounded bg-white border border-slate-200 hover:bg-slate-100 text-slate-700 transition-colors"
          >
            {copiedStream ? (chinese ? '✓ 已复制契约流' : '✓ Copied') : (chinese ? '复制链契约流' : 'Copy Contract Stream')}
          </button>
          <button
            onClick={() => setShowCodeStream(!showCodeStream)}
            className="px-2 py-1 text-[10px] font-semibold text-blue-600 hover:underline"
          >
            {showCodeStream ? (chinese ? '收起契约流' : 'Hide') : (chinese ? '预览契约流' : 'Preview')}
          </button>
        </div>
        {showCodeStream && (
          <pre className="p-2 mt-2 text-[9px] font-mono bg-white border border-slate-200 rounded text-slate-700 max-h-48 overflow-y-auto whitespace-pre-wrap">
            {nodeIDs.map((id, i) => `${i + 1}. [block:${id}] ${store.block(id)?.title}\n`).join('')}
          </pre>
        )}
      </div>

      {/* Path with Stations (1:1 with Swift chainPathSection) */}
      <div className="flex flex-col gap-2 mt-2">
        <SectionHeader title={store.text('path').toUpperCase()} />
        {nodeIDs.map((id, idx) => {
          const b = store.block(id);
          const nextID = idx < nodeIDs.length - 1 ? nodeIDs[idx + 1] : null;
          const link = nextID
            ? store.snapshot.links.find(
                (l) => linkIDs.has(l.id) && l.sourceId === id && l.targetId === nextID
              )
            : null;

          return (
            <div key={id} className="flex flex-col">
              <button
                onClick={() => store.select({ type: 'block', id })}
                className="flex items-start gap-2.5 p-1 rounded hover:bg-slate-50 text-left transition-colors"
              >
                {/* Station circle badge */}
                <div
                  className="w-[18px] h-[18px] rounded-full flex items-center justify-center text-[9px] font-bold font-mono shrink-0 mt-0.5"
                  style={{
                    color: store.chainColor(chain.id),
                    backgroundColor: `${store.chainColor(chain.id)}1a`,
                  }}
                >
                  {idx + 1}
                </div>
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-[11.5px] font-semibold text-slate-800 truncate">
                    {b?.title || id}
                  </span>
                  {b && (
                    <span className="text-[8px] font-bold font-mono text-slate-400">
                      {b.kind.toUpperCase()}{b.architectureLayer ? ` · ${b.architectureLayer.toUpperCase()}` : ''}
                    </span>
                  )}
                  {b && b.summary && (
                    <span className="text-[10px] text-slate-500 line-clamp-2 mt-0.5">
                      {b.summary}
                    </span>
                  )}
                </div>
                <span className="text-slate-400 text-xs">↗</span>
              </button>

              {/* Connecting link line */}
              {link && (() => {
                const sourceBlock = store.block(id);
                const targetBlock = store.block(nodeIDs[idx + 1]);
                const sourceTitle = sourceBlock?.title || id;
                const targetTitle = targetBlock?.title || nodeIDs[idx + 1];
                const subtitle = (
                  link.contract ||
                  link.reason ||
                  (link.label && link.label.toLowerCase() !== link.kind.toLowerCase() ? link.label : '') ||
                  `${sourceTitle} ${link.kind.toLowerCase().includes('call') ? 'invokes' : (link.kind.toLowerCase().includes('depend') ? 'depends on' : link.kind)} ${targetTitle}`
                ).trim();
                const hasSubtitle = Boolean(subtitle);

                return (
                  <div className={`flex items-start gap-2 pl-4 ${hasSubtitle ? 'my-1' : 'my-0.5'}`}>
                    <div
                      className={`w-[1px] shrink-0 ${hasSubtitle ? 'h-6' : 'h-3.5'}`}
                      style={{ backgroundColor: ContextOSTheme.linkKindColor(link.kind) }}
                    />
                    <div className="flex flex-col">
                      <span
                        className="text-[8px] font-bold font-mono uppercase"
                        style={{ color: ContextOSTheme.linkKindColor(link.kind) }}
                      >
                        {link.label || link.kind}
                      </span>
                      {hasSubtitle && (
                        <span className="text-[9px] text-slate-400 truncate max-w-[240px]">
                          {subtitle}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// --- Link Detail ---
const LinkDetail: React.FC<{ store: GraphStore; linkID: string }> = ({ store, linkID }) => {
  const link = store.snapshot.links.find((l) => l.id === linkID);
  if (!link) return null;

  return (
    <div className="flex flex-col gap-3">
      <SectionHeader title={store.text('link').toUpperCase()} />
      <div className="flex items-center gap-2">
        <button
          onClick={() => store.select({ type: 'block', id: link.sourceId })}
          className="text-xs font-semibold text-slate-800 hover:text-blue-600 underline"
        >
          {store.block(link.sourceId)?.title || link.sourceId}
        </button>
        <span
          className="text-xs font-bold"
          style={{ color: ContextOSTheme.healthColor(link.healthState) }}
        >
          →
        </span>
        <button
          onClick={() => store.select({ type: 'block', id: link.targetId })}
          className="text-xs font-semibold text-slate-800 hover:text-blue-600 underline"
        >
          {store.block(link.targetId)?.title || link.targetId}
        </button>
      </div>

      <div className="text-[8.5px] font-mono font-bold text-slate-400 uppercase">
        {(link.label || link.kind) + ' · ' + link.healthState}
      </div>

      <DetailSection title={store.text('contract').toUpperCase()} text={link.contract} />
    </div>
  );
};

// --- Plan Detail ---
const PlanDetail: React.FC<{
  store: GraphStore;
  planID: string;
  expandedScopeIDs: Set<string>;
  setExpandedScopeIDs: (s: Set<string>) => void;
  expandedChangeIDs: Set<string>;
  setExpandedChangeIDs: (s: Set<string>) => void;
  expandedStepIDs: Set<string>;
  setExpandedStepIDs: (s: Set<string>) => void;
  toggleSet: <T>(item: T, set: Set<T>, setter: (s: Set<T>) => void) => void;
}> = ({
  store,
  planID,
  expandedScopeIDs,
  setExpandedScopeIDs,
  expandedChangeIDs,
  setExpandedChangeIDs,
  expandedStepIDs,
  setExpandedStepIDs,
  toggleSet,
}) => {
  const plan = store.snapshot.plans.find((p) => p.id === planID);
  if (!plan) return null;
  const chinese = store.activeLocale === 'zh-Hans';
  const coverage = store.architectureCoverage(plan.id);
  const steps = store.planSteps(plan.id);
  const scopes = store.planChainScopes(plan.id);
  const directChanges = store.directPlanChanges(plan.id);
  const dependencies = store.planDependencies(plan.id);

  return (
    <div className="flex flex-col gap-3">
      <MetadataPills
        items={[
          `${plan.phase} #${plan.order}`,
          plan.priority,
          plan.derivedStatus,
        ]}
      />

      {/* Progress Bar */}
      <div className="flex flex-col gap-1.5 p-2 rounded bg-slate-50 border border-slate-100">
        <div className="flex items-center justify-between text-[8.5px] font-mono font-bold text-slate-500">
          <span>{chinese ? '进度' : 'PROGRESS'}</span>
          <span>
            {plan.progress.completedSteps}/{plan.progress.totalSteps} · {plan.progress.passedRequiredCheckpoints}/{plan.progress.totalRequiredCheckpoints} gates
          </span>
        </div>
        <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{
              width: `${
                Math.round(
                  ((plan.progress.completedSteps + plan.progress.passedRequiredCheckpoints) /
                    Math.max(1, plan.progress.totalSteps + plan.progress.totalRequiredCheckpoints)) *
                    100
                )
              }%`,
              backgroundColor: ContextOSTheme.planColor(plan.derivedStatus),
            }}
          />
        </div>
      </div>

      <DetailSection title={store.text('summary').toUpperCase()} text={store.planText(plan, 'summary')} />
      <DetailSection title={store.text('goal').toUpperCase()} text={store.planText(plan, 'goal')} />
      <DetailSection title={store.text('nextAction').toUpperCase()} text={store.planText(plan, 'nextAction')} />

      {/* Prerequisites */}
      {dependencies.length > 0 && (
        <div className="flex flex-col gap-1 mt-2">
          <SectionHeader title={chinese ? '前置计划' : 'PREREQUISITES'} />
          {dependencies.map((dep) => (
            <button
              key={dep.id}
              onClick={() => store.focusPlan(dep.id)}
              className="flex items-center justify-between py-1.5 border-b border-slate-100 hover:bg-slate-50 text-left transition-colors"
            >
              <span className="text-[11.5px] font-medium text-slate-800 truncate">
                {store.planText(dep, 'title')}
              </span>
              <span
                className="text-[8px] font-bold font-mono uppercase"
                style={{ color: ContextOSTheme.planColor(dep.derivedStatus) }}
              >
                {dep.derivedStatus}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Architecture Coverage */}
      <div className="flex flex-col gap-1.5 mt-2">
        <SectionHeader title={chinese ? '架构覆盖' : 'ARCHITECTURE COVERAGE'} />
        <div className="text-[10.5px] font-mono text-slate-700">
          {coverage.verifiedBlocks}/{coverage.totalBlocks} {store.text('verified')} · {coverage.plannedBlocks}/{coverage.totalBlocks} {chinese ? '由此 Plan 覆盖' : 'covered'}
        </div>
        {coverage.requiredCheckpointMissingIDs.length > 0 && (
          <div className="text-[9.5px] font-mono text-amber-600">
            {chinese ? '验证待补' : 'Verification needed'}: {coverage.requiredCheckpointMissingIDs.slice(0, 6).join(', ')}
          </div>
        )}
      </div>

      {/* Ordered Steps */}
      {steps.length > 0 && (
        <div className="flex flex-col gap-2 mt-2">
          <SectionHeader title={chinese ? '有序步骤' : 'ORDERED STEPS'} />
          {steps.map((st) => {
            const isExp = expandedStepIDs.has(st.id);
            return (
              <div key={st.id} className="border-b border-slate-100 pb-1.5">
                <button
                  onClick={() => toggleSet(st.id, expandedStepIDs, setExpandedStepIDs)}
                  className="flex items-start gap-2 w-full text-left py-1 hover:bg-slate-50 transition-colors"
                >
                  <span className="text-[9px] font-mono font-bold text-slate-400">
                    {String(st.position + 1).padStart(2, '0')}
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className="text-[11.5px] font-semibold text-slate-800 block truncate">
                      {st.title}
                    </span>
                  </div>
                  <span className="text-slate-400 text-xs">{isExp ? '▾' : '▸'}</span>
                </button>
                {isExp && (
                  <div className="pl-6 pt-1 text-[11px] text-slate-600 space-y-1">
                    {(st.summary || st.action) && <div>{st.summary || st.action}</div>}
                    {st.targetReferences && (
                      <div className="text-[9.5px] font-mono text-slate-400">
                        {store.planStepTargets(st)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Plan Scopes & Changes */}
      {scopes.length > 0 && (
        <div className="flex flex-col gap-2 mt-2">
          <SectionHeader title={chinese ? '链路范围与修改' : 'CHAIN SCOPES & CHANGES'} />
          {scopes.map((scope) => {
            const isExp = expandedScopeIDs.has(scope.id);
            const changes = store.planChanges(scope);
            return (
              <div key={scope.id} className="border-b border-slate-100 pb-2">
                <button
                  onClick={() => toggleSet(scope.id, expandedScopeIDs, setExpandedScopeIDs)}
                  className="flex items-start gap-2 w-full text-left py-1 hover:bg-slate-50 transition-colors"
                >
                  <span className="text-[9px] font-bold font-mono text-blue-600">
                    SCOPE #{scope.position + 1}
                  </span>
                  <span className="text-[11.5px] font-semibold text-slate-800 flex-1 truncate">
                    {scope.title}
                  </span>
                  <span className="text-slate-400 text-xs">{isExp ? '▾' : '▸'}</span>
                </button>
                {isExp && (
                  <div className="pl-4 pt-1 space-y-2">
                    {scope.summary && <div className="text-[11px] text-slate-600">{scope.summary}</div>}
                    <div className="text-[9.5px] font-mono text-slate-400">
                      {store.planChainNodePath(scope)}
                    </div>
                    {changes.map((ch) => (
                      <div
                        key={ch.id}
                        className="p-2 rounded bg-slate-50 border border-slate-100 flex flex-col gap-1 text-[11px]"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-slate-800">{ch.title}</span>
                          <span className="text-[8px] font-mono uppercase text-slate-400">{ch.entityType}</span>
                        </div>
                        {ch.summary && <div className="text-slate-600">{ch.summary}</div>}
                        <button
                          onClick={() => store.locatePlanChange(ch)}
                          className="text-[9.5px] font-mono font-bold text-blue-600 self-start mt-1 hover:underline"
                        >
                          {chinese ? '在 Canvas 中定位 ↗' : 'Locate on Canvas ↗'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Direct Changes */}
      {directChanges.length > 0 && (
        <div className="flex flex-col gap-2 mt-2">
          <SectionHeader title={chinese ? '直接图变更' : 'DIRECT GRAPH CHANGES'} />
          {directChanges.map((ch) => (
            <div key={ch.id} className="p-2 rounded bg-slate-50 border border-slate-100 flex flex-col gap-1 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-800">{ch.title}</span>
                <span className="text-[8px] font-mono uppercase text-slate-400">{ch.entityType}</span>
              </div>
              {ch.summary && <div className="text-slate-600">{ch.summary}</div>}
              <button
                onClick={() => store.locatePlanChange(ch)}
                className="text-[9.5px] font-mono font-bold text-blue-600 self-start mt-1 hover:underline"
              >
                {chinese ? '在 Canvas 中定位 ↗' : 'Locate on Canvas ↗'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// --- Decision Detail ---
const DecisionDetail: React.FC<{ store: GraphStore; decisionID: string }> = ({ store, decisionID }) => {
  const dec = store.snapshot.decisions.find((d) => d.id === decisionID);
  if (!dec) return null;
  const chinese = store.activeLocale === 'zh-Hans';

  return (
    <div className="flex flex-col gap-3">
      <MetadataPills
        items={[
          chinese ? '架构决策' : 'DECISION',
          dec.status,
          store.decisionScopeLabel(dec.id),
        ]}
      />
      <DetailSection title={store.text('summary').toUpperCase()} text={dec.summary} />
      <DetailSection title={chinese ? '决策理由' : 'RATIONALE'} text={dec.rationale} />
    </div>
  );
};

// --- Revision Section ---
const RevisionSection: React.FC<{ store: GraphStore; selection: GraphSelection }> = ({
  store,
  selection,
}) => {
  let rev = 0;
  if (selection.type === 'block') rev = store.snapshot.blocks.find((b) => b.id === selection.id)?.revision ?? 0;
  if (selection.type === 'chain') rev = store.snapshot.chains.find((c) => c.id === selection.id)?.revision ?? 0;
  if (selection.type === 'link') rev = store.snapshot.links.find((l) => l.id === selection.id)?.revision ?? 0;
  if (selection.type === 'plan') rev = store.snapshot.plans.find((p) => p.id === selection.id)?.revision ?? 0;

  return (
    <div className="flex items-center justify-between border-t border-slate-100 pt-3">
      <span className="text-[9px] font-bold font-mono tracking-[1.4px] text-slate-500 uppercase">
        {store.text('revision').toUpperCase()}
      </span>
      <span className="text-[9px] font-bold font-mono text-slate-400">r{rev}</span>
    </div>
  );
};

// --- Checkpoints Section ---
const CheckpointsSection: React.FC<{
  store: GraphStore;
  selection: GraphSelection;
  expandedIDs: Set<string>;
  setExpandedIDs: (s: Set<string>) => void;
  toggleSet: <T>(item: T, set: Set<T>, setter: (s: Set<T>) => void) => void;
}> = ({ store, selection, expandedIDs, setExpandedIDs, toggleSet }) => {
  const checkpoints = store.checkpointsForSelection(selection);
  if (checkpoints.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 border-t border-slate-100 pt-3">
      <SectionHeader title={store.text('checkpoints').toUpperCase()} />
      {checkpoints.map((cp) => {
        const isExp = expandedIDs.has(cp.id);
        const color = ContextOSTheme.checkpointColor(cp.status);
        return (
          <div key={cp.id} className="border-b border-slate-100 pb-1.5">
            <button
              onClick={() => toggleSet(cp.id, expandedIDs, setExpandedIDs)}
              className="flex items-center gap-2 w-full text-left py-1 hover:bg-slate-50 transition-colors"
            >
              <span className="text-xs" style={{ color }}>
                {cp.status === 'passed' ? '✓' : '●'}
              </span>
              <span className="text-[12px] font-medium text-slate-800 flex-1 truncate">{cp.title}</span>
              <span className="text-[8px] font-bold font-mono uppercase" style={{ color }}>
                {cp.status}
              </span>
              <span className="text-slate-400 text-xs">{isExp ? '▾' : '▸'}</span>
            </button>
            {isExp && (
              <div className="pl-5 pt-1 text-[11px] text-slate-600 space-y-1">
                <div className="text-[8px] font-mono font-bold uppercase text-slate-400">
                  {cp.evidenceLevel} / {cp.requiredEvidenceLevel} · {cp.coverage}
                </div>
                {cp.criteria && <div>{cp.criteria}</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

// --- History Section ---
const HistorySection: React.FC<{
  store: GraphStore;
  selection: GraphSelection;
  expandedIDs: Set<number>;
  setExpandedIDs: (s: Set<number>) => void;
  toggleSet: <T>(item: T, set: Set<T>, setter: (s: Set<T>) => void) => void;
}> = ({ store, selection, expandedIDs, setExpandedIDs, toggleSet }) => {
  const history = store.history(selection);
  if (history.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 border-t border-slate-100 pt-3">
      <SectionHeader title={store.text('history').toUpperCase()} />
      {history.slice(0, 12).map((item) => {
        const isExp = expandedIDs.has(item.id);
        return (
          <div key={item.id} className="border-b border-slate-100 pb-1.5">
            <button
              onClick={() => toggleSet(item.id, expandedIDs, setExpandedIDs)}
              className="flex items-start gap-2 w-full text-left py-1 hover:bg-slate-50 transition-colors"
            >
              <span className="text-[9px] font-bold font-mono text-slate-400 w-7 shrink-0">
                r{item.revision}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[11.5px] font-medium text-slate-800 truncate">{item.summary}</div>
                <div className="text-[8px] font-bold font-mono text-slate-400 uppercase tracking-wider">
                  {item.action}
                </div>
              </div>
              <span className="text-slate-400 text-xs">{isExp ? '▾' : '▸'}</span>
            </button>
            {isExp && (
              <div className="pl-9 pt-1 text-[9.5px] font-mono text-slate-500 space-y-1">
                {item.changedFields.length > 0 && (
                  <div>CHANGED: {item.changedFields.join(', ')}</div>
                )}
                {item.affectedRefs.length > 0 && (
                  <div>AFFECTED: {item.affectedRefs.join(' · ')}</div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
