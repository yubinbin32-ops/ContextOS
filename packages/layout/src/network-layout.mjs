/**
 * Metro Map Layout Engine for Architecture Graph.
 *
 * Models the architecture as a Transit / Subway Network:
 * - Each Chain is an independent Metro Rail Line running horizontally along its assigned Track Y.
 * - Blocks in each Chain are adjacent Stations positioned sequentially from left to right.
 * - Cross-Chain Links form orthogonal 90° transfer corridors between lines.
 * - Standalone Blocks reside neatly on dedicated baseline tracks.
 * - Eliminates long-snake looping, scattered diamond searches, and nested box envelopes.
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
    const gapX = options.gapX || 80;
    const gapY = options.gapY || 100;
    const paddingX = options.paddingX || 120;
    const paddingY = options.paddingY || 120;

    const blockMap = new Map();
    for (const b of blocks) {
      blockMap.set(b.id, b);
    }

    const occupied = new Set();
    const cellKey = (x, y) => `${x},${y}`;
    const placedNodes = [];
    const placedMap = new Map();

    let currentTrackY = 0;

    // 1. Place each Chain as a clean horizontal metro track
    for (const chain of chains) {
      const memberIds = chain.memberIds || [];
      if (memberIds.length === 0) continue;

      const trackY = currentTrackY;
      currentTrackY += 1;
      let nextX = 0;

      for (const mId of memberIds) {
        if (placedMap.has(mId)) {
          // Interchange station already placed on a previous track
          continue;
        }
        while (occupied.has(cellKey(nextX, trackY))) {
          nextX += 1;
        }
        occupied.add(cellKey(nextX, trackY));
        placedMap.set(mId, { x: nextX, y: trackY });
        const b = blockMap.get(mId) || { id: mId, title: mId };
        placedNodes.push({
          id: mId,
          title: b.title,
          chainId: chain.id,
          kind: 'block',
          x: paddingX + nextX * (nodeWidth + gapX),
          y: paddingY + trackY * (nodeHeight + gapY),
          width: nodeWidth,
          height: nodeHeight,
        });
        nextX += 1;
      }
    }

    // 2. Place unchained standalone blocks on bottom tracks
    const unchained = blocks.filter((b) => !placedMap.has(b.id)).sort((a, b) => a.id.localeCompare(b.id));
    if (unchained.length > 0) {
      let nextX = 0;
      let trackY = currentTrackY;
      for (const b of unchained) {
        while (occupied.has(cellKey(nextX, trackY))) {
          nextX += 1;
        }
        occupied.add(cellKey(nextX, trackY));
        placedMap.set(b.id, { x: nextX, y: trackY });
        placedNodes.push({
          id: b.id,
          title: b.title,
          chainId: null,
          kind: 'block',
          x: paddingX + nextX * (nodeWidth + gapX),
          y: paddingY + trackY * (nodeHeight + gapY),
          width: nodeWidth,
          height: nodeHeight,
        });
        nextX += 1;
        if (nextX >= 4) {
          nextX = 0;
          trackY += 1;
        }
      }
    }

    let maxX = 0;
    let maxY = 0;
    for (const n of placedNodes) {
      maxX = Math.max(maxX, n.x + n.width + paddingX);
      maxY = Math.max(maxY, n.y + n.height + paddingY);
    }

    return {
      nodes: placedNodes,
      edges: links.map((l) => ({
        id: l.id,
        from: l.from || l.sourceId,
        to: l.to || l.targetId,
        kind: l.kind || 'depends_on',
      })),
      bounds: { width: Math.max(1200, maxX), height: Math.max(800, maxY) },
    };
  }
}
