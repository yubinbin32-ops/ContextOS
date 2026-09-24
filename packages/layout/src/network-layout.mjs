/**
 * Chain-aware square shelf layout for architecture graphs.
 *
 * Each Chain remains a contiguous placement segment where possible, then
 * segments are packed into balanced rows. The column count is chosen from
 * pixel aspect ratio, grid fill, and the cost of splitting a Chain. This keeps
 * related Blocks together without allowing a large graph to collapse into a
 * sparse vertical strip.
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
    const xStep = nodeWidth + gapX;
    const yStep = nodeHeight + gapY;

    const blockMap = new Map();
    for (const block of blocks) {
      if (!blockMap.has(block.id)) blockMap.set(block.id, block);
    }
    const blockIds = [...blockMap.keys()];

    const placedNodes = [];
    const placedMap = new Map();
    const placeBlock = (id, title, chainId, cellX, cellY) => {
      placedMap.set(id, { x: cellX, y: cellY });
      placedNodes.push({
        id,
        title,
        chainId,
        kind: 'block',
        x: paddingX + cellX * xStep,
        y: paddingY + cellY * yStep,
        width: nodeWidth,
        height: nodeHeight,
      });
    };

    if (blockIds.length === 0) {
      return {
        nodes: [],
        edges: links.map((link) => ({
          id: link.id,
          from: link.from || link.sourceId,
          to: link.to || link.targetId,
          kind: link.kind || 'depends_on',
        })),
        bounds: { width: 1200, height: 800 },
      };
    }

    // A Block belongs to the first sorted Chain that contains it. The rest of
    // the Chains still describe relationships, but do not create duplicate
    // placement groups for the same Block.
    const normalizedChains = chains
      .map((chain, sourceIndex) => {
        const seen = new Set();
        const memberIds = (chain.memberIds || []).filter((id) => {
          if (!blockMap.has(id) || seen.has(id)) return false;
          seen.add(id);
          return true;
        });
        return {
          id: String(chain.id ?? `chain-${sourceIndex}`),
          memberIds,
          sourceIndex,
        };
      })
      .filter((chain) => chain.memberIds.length > 0)
      .sort((left, right) =>
        right.memberIds.length - left.memberIds.length ||
        left.id.localeCompare(right.id) ||
        left.sourceIndex - right.sourceIndex
      );

    const assignedChain = new Map();
    const edgeNeighbors = new Map();
    for (const link of links) {
      const source = link.from || link.sourceId;
      const target = link.to || link.targetId;
      if (!source || !target || source === target) continue;
      if (!edgeNeighbors.has(source)) edgeNeighbors.set(source, new Set());
      if (!edgeNeighbors.has(target)) edgeNeighbors.set(target, new Set());
      edgeNeighbors.get(source).add(target);
      edgeNeighbors.get(target).add(source);
    }

    const ownedBlocks = new Set();
    const segments = [];
    for (const chain of normalizedChains) {
      const members = chain.memberIds;
      const unownedIndices = members
        .map((id, index) => (ownedBlocks.has(id) ? -1 : index))
        .filter((index) => index >= 0);
      if (unownedIndices.length === 0) continue;

      // Keep each unowned run attached to its nearest owned Chain neighbours
      // instead of treating a shared-chain suffix as a standalone Block.
      let run = [];
      const flushRun = () => {
        if (run.length === 0) return;
        const first = run[0];
        const last = run[run.length - 1];
        const previous = members.slice(0, first).reverse().find((id) => ownedBlocks.has(id));
        const next = members.slice(last + 1).find((id) => ownedBlocks.has(id));
        const anchorIds = [previous, next].filter(Boolean);
        segments.push({
          id: `chain:${chain.id}:${first}`,
          memberIds: run.map((index) => members[index]),
          anchorIds,
          insertAfterAnchorID: previous || null,
        });
        run = [];
      };

      for (let index = 0; index < members.length; index += 1) {
        if (ownedBlocks.has(members[index])) {
          flushRun();
        } else {
          run.push(index);
        }
      }
      flushRun();
      for (const index of unownedIndices) {
        const id = members[index];
        ownedBlocks.add(id);
        assignedChain.set(id, chain.id);
      }
    }

    const chainOwnedBlocks = new Set(ownedBlocks);
    for (const id of blockIds.filter((blockId) => !ownedBlocks.has(blockId)).sort()) {
      const anchorIds = [...(edgeNeighbors.get(id) || [])]
        .filter((anchorId) => chainOwnedBlocks.has(anchorId))
        .sort();
      segments.push({
        id: `block:${id}`,
        memberIds: [id],
        anchorIds,
        insertAfterAnchorID: anchorIds[0] || null,
      });
      ownedBlocks.add(id);
    }

    const chooseShelf = () => {
      let best = null;

      for (let columns = 1; columns <= blockIds.length; columns += 1) {
        const chunks = [];
        let splitCount = 0;

        for (const segment of segments) {
          if (segment.memberIds.length > columns) {
            splitCount += Math.ceil(segment.memberIds.length / columns) - 1;
          }
          for (let start = 0; start < segment.memberIds.length; start += columns) {
            chunks.push({
              id: `${segment.id}:${start / columns}`,
              memberIds: segment.memberIds.slice(start, start + columns),
              anchorIds: [],
              insertAfterAnchorID: null,
            });
          }
        }

        chunks.sort((left, right) =>
          right.memberIds.length - left.memberIds.length || left.id.localeCompare(right.id)
        );

        const rows = [];
        for (const chunk of chunks) {
          let target = -1;
          for (let row = 0; row < rows.length; row += 1) {
            if (rows[row].length + chunk.memberIds.length > columns) continue;
            if (target === -1 || rows[row].length < rows[target].length) target = row;
          }
          if (target === -1) rows.push([...chunk.memberIds]);
          else rows[target].push(...chunk.memberIds);
        }

        const rowWidths = rows.map((row) => row.length);
        const maxWidth = Math.max(...rowWidths);
        const minWidth = Math.min(...rowWidths);
        const pixelWidth = (maxWidth - 1) * xStep + nodeWidth + paddingX * 2;
        const pixelHeight = (rows.length - 1) * yStep + nodeHeight + paddingY * 2;
        const squareness = Math.abs(Math.log(pixelWidth / pixelHeight));
        const fill = blockIds.length / (columns * rows.length);
        const balance = (maxWidth - minWidth) / columns;
        const score = squareness + splitCount * 0.16 + (1 - fill) * 0.18 + balance * 0.08;

        const candidate = { columns, rows, score };
        if (
          best === null ||
          candidate.score < best.score - 1e-9 ||
          (Math.abs(candidate.score - best.score) <= 1e-9 && candidate.columns > best.columns)
        ) {
          best = candidate;
        }
      }

      return best;
    };

    const shelf = chooseShelf();
    let rows = shelf.rows;
    // Shelf packing owns density; this pass restores local topology by
    // inserting anchored runs beside their already placed neighbours.
    const anchoredSegments = segments.filter((segment) => segment.anchorIds.length > 0);
    const anchoredIDs = new Set(anchoredSegments.flatMap((segment) => segment.memberIds));
    if (anchoredIDs.size > 0) {
      rows = rows
        .map((row) => row.filter((id) => !anchoredIDs.has(id)))
        .filter((row) => row.length > 0);

      for (const segment of anchoredSegments) {
        const anchorCells = [];
        for (const anchorID of segment.anchorIds) {
          const rowIndex = rows.findIndex((row) => row.includes(anchorID));
          if (rowIndex < 0) continue;
          anchorCells.push({ row: rowIndex, column: rows[rowIndex].indexOf(anchorID) });
        }
        if (anchorCells.length === 0) {
          rows.push([...segment.memberIds]);
          continue;
        }

        const anchorRowCounts = new Map();
        for (const cell of anchorCells) {
          anchorRowCounts.set(cell.row, (anchorRowCounts.get(cell.row) || 0) + 1);
        }
        const targetRow = [...anchorRowCounts.keys()].sort((left, right) => {
          const countDelta = anchorRowCounts.get(right) - anchorRowCounts.get(left);
          return countDelta || left - right;
        })[0];
        const targetColumns = anchorCells
          .filter((cell) => cell.row === targetRow)
          .map((cell) => cell.column);
        let insertionIndex = Math.min(rows[targetRow].length, Math.min(...targetColumns));
        if (segment.insertAfterAnchorID) {
          const rowIndex = rows.findIndex((row) => row.includes(segment.insertAfterAnchorID));
          if (rowIndex >= 0) {
            insertionIndex = Math.min(
              rows[rowIndex].length,
              rows[rowIndex].indexOf(segment.insertAfterAnchorID) + 1,
            );
          }
        }
        rows[targetRow].splice(insertionIndex, 0, ...segment.memberIds);
      }
    }

    rows.forEach((row, rowIndex) => {
      row.forEach((id, columnIndex) => {
        const block = blockMap.get(id) || { id, title: id };
        placeBlock(id, block.title, assignedChain.get(id) || null, columnIndex, rowIndex);
      });
    });

    let maxX = 0;
    let maxY = 0;
    for (const node of placedNodes) {
      maxX = Math.max(maxX, node.x + node.width + paddingX);
      maxY = Math.max(maxY, node.y + node.height + paddingY);
    }

    return {
      nodes: placedNodes,
      edges: links.map((link) => ({
        id: link.id,
        from: link.from || link.sourceId,
        to: link.to || link.targetId,
        kind: link.kind || 'depends_on',
      })),
      bounds: { width: Math.max(1200, maxX), height: Math.max(800, maxY) },
    };
  }

}
