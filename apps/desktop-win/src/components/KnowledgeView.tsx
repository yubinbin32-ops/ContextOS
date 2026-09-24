// 1:1 Port of apps/desktop/Sources/ContextOSDesktop/KnowledgeView.swift

import React, { useEffect, useState } from 'react';
import { GraphStore } from '../graphStore';
import { MarkdownPage } from '../markdownPage';
import { GraphSelection } from '../models';
import { ContextOSTheme } from '../theme';

export interface KnowledgeDocument {
  id: string;
  title: string;
  body: string;
  html: string;
  sourcePath: string;
  revision: number;
  kind: string;
  relations: string[];
}

export class KnowledgeLibrary {
  documents: KnowledgeDocument[] = [];
  error: string | null = null;
  private listeners: Set<() => void> = new Set();

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    for (const l of this.listeners) l();
  }

  async reload(projectRoot?: string | null) {
    try {
      if (typeof window !== 'undefined' && ((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)) {
        const { invoke } = await import('@tauri-apps/api/core');
        const docs = await invoke<KnowledgeDocument[]>('load_knowledge', {
          projectRoot: projectRoot || undefined,
        });
        if (Array.isArray(docs)) {
          this.documents = docs.map((d) => ({
            ...d,
            html: d.html || MarkdownPage.render(d.body),
          }));
          this.error = null;
          this.notify();
          return;
        }
      }
    } catch (err: any) {
      this.error = err.message;
    }
    this.notify();
  }
}

export const globalKnowledge = new KnowledgeLibrary();

interface KnowledgeViewProps {
  store: GraphStore;
  library: KnowledgeLibrary;
  documentID: string;
  section?: string | null;
  close: () => void;
  openDocument: (id: string, section?: string | null) => void;
}

export const KnowledgeView: React.FC<KnowledgeViewProps> = ({
  store,
  library,
  documentID,
  close,
  openDocument,
}) => {
  const [copied, setCopied] = useState(false);
  const chinese = store.activeLocale === 'zh-Hans';
  const selected = library.documents.find((d) => d.id === documentID);

  useEffect(() => {
    library.reload(store.projectRoot);
  }, [documentID, store.projectRoot]);

  if (!selected) {
    return (
      <div className="flex-1 h-full flex flex-col justify-center items-center p-8 bg-white border-l border-slate-200">
        <div className="text-slate-400 mb-2">📄</div>
        <div className="text-sm font-medium text-slate-700">
          {chinese ? '正在读取文档…' : 'Loading document…'}
        </div>
        <div className="text-xs text-slate-400 mt-1">
          {library.error || (chinese ? '请从左侧知识栏目选择文档。' : 'Select a document in the Knowledge section.')}
        </div>
        <button
          onClick={close}
          className="mt-4 px-3 py-1 text-xs rounded bg-slate-100 hover:bg-slate-200 text-slate-700"
        >
          {chinese ? '关闭' : 'Close'}
        </button>
      </div>
    );
  }

  const copyMarkdown = () => {
    navigator.clipboard.writeText(selected.body);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const openReference = (ref: string) => {
    const parts = ref.split(':');
    if (parts.length === 2) {
      const type = parts[0] as GraphSelection['type'];
      close();
      store.select({ type, id: parts[1] });
    }
  };

  const referenceTitle = (ref: string): string => {
    const parts = ref.split(':');
    if (parts.length === 2) {
      const type = parts[0] as GraphSelection['type'];
      return store.title({ type, id: parts[1] });
    }
    return ref;
  };

  return (
    <div className="flex-1 h-full flex flex-col bg-white border-l border-slate-200 overflow-hidden select-text">
      {/* Top Header */}
      <div className="p-4 border-b border-slate-100 flex flex-col gap-2 shrink-0">
        <div className="flex items-start justify-between gap-2">
          <h2
            className="text-[17px] font-semibold tracking-tight line-clamp-2 leading-snug"
            style={{ color: ContextOSTheme.ink }}
          >
            {selected.title}
          </h2>
          <button
            onClick={close}
            className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
            title={chinese ? '关闭详情' : 'Close details'}
          >
            ✕
          </button>
        </div>

        <div className="text-xs text-slate-400">
          {selected.kind === 'readme'
            ? chinese
              ? '仓库原文件 · 只读'
              : 'Repository file · Read only'
            : selected.kind === 'rule'
            ? chinese
              ? '项目规范 · 只读'
              : 'Project Rule · Read only'
            : selected.kind === 'decision'
            ? chinese
              ? '架构决策记录 · 只读'
              : 'Architecture Decision · Read only'
            : `OS · ${selected.kind} · r${selected.revision}`}
        </div>

        <div className="flex items-center gap-2 mt-1">
          <button
            onClick={copyMarkdown}
            className="px-2.5 py-1 text-[11px] font-medium rounded border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 transition-colors"
          >
            {copied ? (chinese ? '✓ 已复制全文' : '✓ Copied') : (chinese ? '复制全文' : 'Copy Markdown')}
          </button>
        </div>

        {/* References pills */}
        {selected.relations.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto py-1">
            {selected.relations.map((ref) => (
              <button
                key={ref}
                onClick={() => openReference(ref)}
                className="px-2 py-0.5 text-[10px] font-medium rounded-full bg-slate-100 hover:bg-slate-200 text-slate-700 whitespace-nowrap transition-colors"
              >
                {referenceTitle(ref)}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Rendered HTML Container */}
      <div
        className="flex-1 overflow-y-auto p-6 markdown-body prose prose-slate max-w-none text-slate-800 text-[13px] leading-relaxed"
        dangerouslySetInnerHTML={{ __html: selected.html }}
      />
    </div>
  );
};
