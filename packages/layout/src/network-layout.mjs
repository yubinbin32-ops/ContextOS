/**
 * Deterministic DAG Layout Engine for Architecture Graph.
 * Solves the long-snake layout issue through:
 * - Chain clustering
 * - DAG topological ranking
 * - Grid wrapping on max horizontal width
 * - Deterministic coordinate projection
 */

export class NetworkLayoutEngine {
  static computeLayout({
    blocks = [],
    chains = [],
    links = [],
    options = {},
  }) {
    const nodeWidth = options.nodeWidth || 220;
    const nodeHeight = options.nodeHeight || 100;
    const gapX = options.gapX || 60;
    const gapY = options.gapY || 80;
    const maxColumns = options.maxColumns || 4;

    const blockMap = new Map();
    for (const b of blocks) {
      blockMap.set(b.id, b);
    }

    // 1. Cluster: Determine primary chain for each block
    const blockToChain = new Map();
    for (const chain of chains) {
      for (const mId of chain.memberIds || []) {
        if (!blockToChain.has(mId)) {
          blockToChain.set(mId, chain.id);
        }
      }
    }

    // 2. Build adjacency for ranking
    const inDegree = new Map();
    const adj = new Map();
    for (const b of blocks) {
      inDegree.set(b.id, 0);
      adj.set(b.id, []);
    }

    for (const link of links) {
      if (adj.has(link.from) && inDegree.has(link.to)) {
        adj.get(link.from).push(link.to);
        inDegree.set(link.to, (inDegree.get(link.to) || 0) + 1);
      }
    }

    // 3. Topological Rank (Kahn's algorithm with cycle tolerance)
    const queue = [];
    const ranks = new Map();

    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) {
        queue.push(id);
        ranks.set(id, 0);
      }
    }

    while (queue.length > 0) {
      const u = queue.shift();
      const currentRank = ranks.get(u) || 0;

      for (const v of adj.get(u) || []) {
        const nextRank = currentRank + 1;
        if (!ranks.has(v) || nextRank > ranks.get(v)) {
          ranks.set(v, nextRank);
        }
        const newDeg = inDegree.get(v) - 1;
        inDegree.set(v, newDeg);
        if (newDeg === 0) {
          queue.push(v);
        }
      }
    }

    // Fallback for cyclic or isolated components
    for (const b of blocks) {
      if (!ranks.has(b.id)) {
        ranks.set(b.id, 0);
      }
    }

    // 4. Group by rank and apply grid wrapping
    const rankGroups = new Map();
    for (const b of blocks) {
      const r = ranks.get(b.id) || 0;
      if (!rankGroups.has(r)) rankGroups.set(r, []);
      rankGroups.get(r).push(b);
    }

    const sortedRanks = Array.from(rankGroups.keys()).sort((a, b) => a - b);

    const placedNodes = [];
    let currentY = 40;

    for (const r of sortedRanks) {
      const group = rankGroups.get(r).sort((a, b) => a.id.localeCompare(b.id));

      // Wrap lines if group exceeds maxColumns
      for (let i = 0; i < group.length; i += maxColumns) {
        const row = group.slice(i, i + maxColumns);
        for (let col = 0; col < row.length; col++) {
          const b = row[col];
          const x = 40 + col * (nodeWidth + gapX);
          const y = currentY;

          placedNodes.push({
            id: b.id,
            title: b.title,
            chainId: blockToChain.get(b.id) || null,
            kind: 'block',
            x,
            y,
            width: nodeWidth,
            height: nodeHeight,
            rank: r,
          });
        }
        currentY += nodeHeight + gapY;
      }
    }

    // Calculate bounding box
    let maxX = 0;
    let maxY = 0;
    for (const n of placedNodes) {
      maxX = Math.max(maxX, n.x + n.width + 40);
      maxY = Math.max(maxY, n.y + n.height + 40);
    }

    return {
      nodes: placedNodes,
      edges: links.map((l) => ({
        id: l.id,
        from: l.from,
        to: l.to,
        kind: l.kind,
      })),
      bounds: {
        width: Math.max(800, maxX),
        height: Math.max(600, maxY),
      },
    };
  }
}
