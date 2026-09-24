// 1:1 Port of apps/desktop/Sources/ContextOSDesktop/Theme.swift

export const ContextOSTheme = {
  // Adaptive workspace colors
  canvas: '#ffffff',
  surface: '#ffffff',
  card: '#ffffff',
  ink: '#0f172a',
  muted: '#64748b',
  hairline: '#e2e8f0',
  focus: '#007aff',
  success: '#34c759',
  pending: '#ff9500',
  failure: '#ff3b30',
  unstable: '#af52de',

  healthColor(state: string): string {
    switch (state) {
      case 'healthy':
        return this.success;
      case 'warning':
        return this.pending;
      case 'failing':
        return this.failure;
      case 'unstable':
      case 'disputed':
        return this.unstable;
      default:
        return 'rgba(100, 116, 139, 0.55)';
    }
  },

  deliveryColor(state: string): string {
    switch (state) {
      case 'complete':
        return this.success;
      case 'implementing':
        return this.focus;
      case 'verifying':
        return this.pending;
      case 'deprecated':
        return 'rgba(100, 116, 139, 0.35)';
      case 'planned':
        return '#5856d6';
      default:
        return 'rgba(100, 116, 139, 0.6)';
    }
  },

  planColor(status: string): string {
    switch (status) {
      case 'complete':
        return this.success;
      case 'active':
        return this.focus;
      case 'verifying':
      case 'ready':
        return this.pending;
      case 'blocked':
      case 'failed':
        return this.failure;
      case 'retest_required':
        return '#ff9500';
      case 'cancelled':
        return 'rgba(100, 116, 139, 0.35)';
      default:
        return 'rgba(100, 116, 139, 0.65)';
    }
  },

  linkKindColor(kind: string): string {
    switch (kind) {
      case 'flows_to':
        return '#8e8e93';
      case 'calls':
        return '#007aff';
      case 'reads':
        return '#5ac8fa';
      case 'writes':
        return '#ff9500';
      case 'depends_on':
        return '#af52de';
      case 'implements':
        return '#34c759';
      case 'validates':
        return '#5856d6';
      case 'constrains':
        return '#a2845e';
      case 'supersedes':
        return '#ff3b30';
      default:
        return this.muted;
    }
  },

  checkpointColor(status: string): string {
    switch (status) {
      case 'passed':
        return this.success;
      case 'partial_pass':
        return this.pending;
      case 'running':
        return this.focus;
      case 'failed':
        return this.failure;
      case 'blocked':
        return this.unstable;
      case 'retest_required':
        return '#ff9500';
      default:
        return this.muted;
    }
  },

  chainPalette: [
    '#007aff',
    '#ff9500',
    '#34c759',
    '#af52de',
    '#ff3b30',
    '#5ac8fa',
    '#ff2d55',
    '#a2845e',
    '#5856d6',
    '#ffcc00',
    '#007aff',
    '#00c7be',
  ],

  chainColor(indexOrId: number | string): string {
    if (typeof indexOrId === 'number') {
      return this.chainPalette[Math.abs(indexOrId) % this.chainPalette.length];
    }
    let hash = 0;
    for (let i = 0; i < indexOrId.length; i++) {
      hash = (hash << 5) - hash + indexOrId.charCodeAt(i);
      hash |= 0;
    }
    const idx = Math.abs(hash) % this.chainPalette.length;
    return this.chainPalette[idx];
  },

  blockKindColor(kind: string): string {
    switch (kind) {
      case 'ui':
      case 'flow':
        return '#007aff';
      case 'service':
        return '#34c759';
      case 'function':
        return '#5ac8fa';
      case 'integration':
        return '#af52de';
      case 'data':
        return '#ff9500';
      case 'database':
        return '#ff2d55';
      case 'test':
      case 'checkpoint':
        return '#5856d6';
      case 'risk':
        return this.failure;
      case 'principle':
      case 'decision':
      case 'requirement':
      case 'product':
        return '#a2845e';
      default:
        return this.muted;
    }
  },

  blockKindTitle(kind: string): string {
    const titles: Record<string, string> = {
      ui: '界面',
      flow: '流程',
      service: '服务',
      function: '函数',
      integration: '集成',
      data: '数据',
      database: '数据库',
      test: '测试',
      checkpoint: '检查点',
      risk: '风险',
      principle: '规范',
      decision: '决策',
      requirement: '需求',
      product: '产品',
    };
    return titles[kind] || kind;
  },

  blockSymbol(kind: string): string {
    switch (kind) {
      case 'ui':
        return 'sidebar.left';
      case 'flow':
        return 'arrow.triangle.branch';
      case 'service':
        return 'gearshape.2';
      case 'function':
        return 'function';
      case 'integration':
        return 'puzzlepiece.extension';
      case 'data':
        return 'doc.text.below.ecg';
      case 'database':
        return 'cylinder.split.1x2';
      case 'test':
      case 'checkpoint':
        return 'checkmark.seal';
      case 'risk':
        return 'exclamationmark.triangle';
      case 'principle':
      case 'decision':
      case 'requirement':
      case 'product':
        return 'book.closed';
      default:
        return 'square.stack.3d.up';
    }
  },

  deliverySymbol(state: string): string {
    switch (state) {
      case 'complete':
        return 'checkmark.circle.fill';
      case 'implementing':
        return 'hammer.fill';
      case 'verifying':
        return 'testtube.2';
      case 'deprecated':
        return 'archivebox.fill';
      case 'planned':
        return 'clock.fill';
      default:
        return 'circle.dashed';
    }
  },
};

export const theme = ContextOSTheme;
