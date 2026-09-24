// 1:1 Port of apps/desktop/Sources/ContextOSDesktop/NetworkLayoutEngine.swift

export interface CGPoint {
  x: number;
  y: number;
}

export interface CGSize {
  width: number;
  height: number;
}

export interface CGRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function rect(x: number, y: number, width: number, height: number): CGRect {
  return { x, y, width, height };
}

export function rectInset(r: CGRect, dx: number, dy: number): CGRect {
  return {
    x: r.x + dx,
    y: r.y + dy,
    width: Math.max(0, r.width - 2 * dx),
    height: Math.max(0, r.height - 2 * dy),
  };
}

export function rectUnion(a: CGRect, b: CGRect): CGRect {
  const minX = Math.min(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.width, b.x + b.width);
  const maxY = Math.max(a.y + a.height, b.y + b.height);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function rectIntersects(a: CGRect, b: CGRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

export function rectContains(r: CGRect, p: CGPoint): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

export function rectContainsStrictly(r: CGRect, p: CGPoint): boolean {
  return p.x > r.x && p.x < r.x + r.width && p.y > r.y && p.y < r.y + r.height;
}

export interface LayoutEdge {
  id: string;
  sourceID: string;
  targetID: string;
}

export interface LayoutNodeMetadata {
  layer: number;
  scope: string;
  order: number;
}

export interface LayoutBand {
  id: string;
  title: string;
  frame: CGRect;
}

export interface NetworkLayoutSnapshot {
  positions: Record<string, CGPoint>;
  routes: Record<string, CGPoint[]>;
  layerBands: LayoutBand[];
  scopeBands: LayoutBand[];
  size: CGSize;
}

interface PlacementSegment {
  id: string;
  memberIds: string[];
  anchorIds: string[];
  insertAfterAnchorID?: string | null;
}

interface ShelfCandidate {
  columns: number;
  rows: string[][];
  score: number;
}

interface Cell {
  x: number;
  y: number;
}

export class NetworkLayoutEngine {
  static readonly horizontalStreetWidth: number = 70;
  static readonly verticalStreetWidth: number = 60;

  static make({
    nodeIDs,
    edges,
    focusPaths,
    districts = {},
    metadata = {},
    cardSize,
    topInset = 70,
  }: {
    nodeIDs: string[];
    edges: LayoutEdge[];
    focusPaths: string[][];
    districts?: Record<string, number>;
    metadata?: Record<string, LayoutNodeMetadata>;
    cardSize: CGSize;
    topInset?: number;
  }): NetworkLayoutSnapshot {
    const nodes = Array.from(new Set(nodeIDs)).sort();
    if (nodes.length === 0) {
      return {
        positions: {},
        routes: {},
        layerBands: [],
        scopeBands: [],
        size: { width: 900, height: 620 },
      };
    }

    const visible = new Set(nodes);
    const validEdges = edges.filter(
      (e) => visible.has(e.sourceID) && visible.has(e.targetID) && e.sourceID !== e.targetID
    );
    const chains = focusPaths
      .map((p) => p.filter((id) => visible.has(id)))
      .filter((p) => p.length > 0)
      .sort((a, b) => {
        if (a.length !== b.length) return b.length - a.length;
        return a.join('\0').localeCompare(b.join('\0'));
      });

    const cells = this.place(nodes, validEdges, chains, metadata, districts, cardSize);
    const cellVals = Object.values(cells);
    const minimumX = cellVals.length > 0 ? Math.min(...cellVals.map((c) => c.x)) : 0;
    const minimumY = cellVals.length > 0 ? Math.min(...cellVals.map((c) => c.y)) : 0;
    const xStep = cardSize.width + 80;
    const yStep = cardSize.height + 90;
    const sideInset = 120;
    const effectiveTopInset = 120;

    const positions: Record<string, CGPoint> = {};
    for (const [node, cell] of Object.entries(cells)) {
      positions[node] = {
        x: sideInset + (cell.x - minimumX) * xStep,
        y: effectiveTopInset + (cell.y - minimumY) * yStep,
      };
    }

    const frames: Record<string, CGRect> = {};
    for (const [node, pos] of Object.entries(positions)) {
      frames[node] = rect(pos.x, pos.y, cardSize.width, cardSize.height);
    }

    const chainPriority = this.prioritizedEdges(validEdges, chains);
    const routes = this.route(validEdges, frames, cardSize, chainPriority);

    const frameList = Object.values(frames);
    let bounds: CGRect = frameList[0] || rect(0, 0, 0, 0);
    for (let i = 1; i < frameList.length; i++) {
      bounds = rectUnion(bounds, frameList[i]);
    }

    return {
      positions,
      routes,
      layerBands: [],
      scopeBands: [],
      size: {
        width: Math.max(1200, bounds.x + bounds.width + sideInset + 60),
        height: Math.max(800, bounds.y + bounds.height + effectiveTopInset + 60),
      },
    };
  }

  static orthogonalRoute(source: CGPoint, target: CGPoint, cardSize: CGSize, lane: number): CGPoint[] {
    const sourceFrame = rect(source.x, source.y, cardSize.width, cardSize.height);
    const targetFrame = rect(target.x, target.y, cardSize.width, cardSize.height);
    const sMidX = sourceFrame.x + sourceFrame.width / 2;
    const sMidY = sourceFrame.y + sourceFrame.height / 2;
    const tMidX = targetFrame.x + targetFrame.width / 2;
    const tMidY = targetFrame.y + targetFrame.height / 2;
    const horizontal = Math.abs(tMidX - sMidX) >= Math.abs(tMidY - sMidY);
    return (
      this.directFirstRoute(sourceFrame, targetFrame, [], [], lane) ??
      this.fallbackRoute(sourceFrame, targetFrame, horizontal, lane, lane)
    );
  }

  private static place(
    nodes: string[],
    edges: LayoutEdge[],
    chains: string[][],
    metadata: Record<string, LayoutNodeMetadata>,
    districts: Record<string, number>,
    cardSize: CGSize
  ): Record<string, Cell> {
    const sortedNodes = [...nodes].sort();
    if (sortedNodes.length === 0) return {};

    const nodeSet = new Set(sortedNodes);
    const edgeNeighbors = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!edgeNeighbors.has(e.sourceID)) edgeNeighbors.set(e.sourceID, new Set());
      if (!edgeNeighbors.has(e.targetID)) edgeNeighbors.set(e.targetID, new Set());
      edgeNeighbors.get(e.sourceID)!.add(e.targetID);
      edgeNeighbors.get(e.targetID)!.add(e.sourceID);
    }

    const xStep = Math.max(1, cardSize.width + 80);
    const yStep = Math.max(1, cardSize.height + 90);
    const ownedBlocks = new Set<string>();
    const segments: PlacementSegment[] = [];

    for (const path of chains) {
      const seen = new Set<string>();
      const members = path.filter((id) => nodeSet.has(id) && !seen.has(id) && seen.add(id));
      const unownedIndices: number[] = [];
      for (let i = 0; i < members.length; i++) {
        if (!ownedBlocks.has(members[i])) unownedIndices.push(i);
      }
      if (unownedIndices.length === 0) continue;

      let run: number[] = [];
      const flushRun = () => {
        if (run.length === 0) return;
        const first = run[0];
        const last = run[run.length - 1];
        let previous: string | null = null;
        for (let i = first - 1; i >= 0; i--) {
          if (ownedBlocks.has(members[i])) {
            previous = members[i];
            break;
          }
        }
        let next: string | null = null;
        for (let i = last + 1; i < members.length; i++) {
          if (ownedBlocks.has(members[i])) {
            next = members[i];
            break;
          }
        }
        const anchors = [previous, next].filter((a): a is string => Boolean(a));
        segments.push({
          id: `chain:${members.join('\0')}:${first}`,
          memberIds: run.map((idx) => members[idx]),
          anchorIds: anchors,
          insertAfterAnchorID: previous,
        });
        run = [];
      };

      for (let i = 0; i < members.length; i++) {
        if (ownedBlocks.has(members[i])) {
          flushRun();
        } else {
          run.push(i);
        }
      }
      flushRun();
      for (const idx of unownedIndices) ownedBlocks.add(members[idx]);
    }

    const chainOwnedBlocks = new Set(ownedBlocks);
    for (const node of sortedNodes) {
      if (!ownedBlocks.has(node)) {
        const anchors = Array.from(edgeNeighbors.get(node) || [])
          .filter((n) => chainOwnedBlocks.has(n))
          .sort();
        segments.push({
          id: `block:${node}`,
          memberIds: [node],
          anchorIds: anchors,
          insertAfterAnchorID: anchors[0] || null,
        });
        ownedBlocks.add(node);
      }
    }

    const chooseShelf = (): ShelfCandidate => {
      let best: ShelfCandidate | null = null;

      for (let columns = 1; columns <= sortedNodes.length; columns++) {
        const chunks: PlacementSegment[] = [];
        let splitCount = 0;

        for (const segment of segments) {
          const count = segment.memberIds.length;
          if (count > columns) {
            splitCount += Math.floor((count - 1) / columns);
          }
          let start = 0;
          while (start < count) {
            const end = Math.min(start + columns, count);
            chunks.push({
              id: `${segment.id}:${Math.floor(start / columns)}`,
              memberIds: segment.memberIds.slice(start, end),
              anchorIds: [],
              insertAfterAnchorID: null,
            });
            start += columns;
          }
        }

        chunks.sort((a, b) => {
          if (a.memberIds.length !== b.memberIds.length) {
            return b.memberIds.length - a.memberIds.length;
          }
          return a.id.localeCompare(b.id);
        });

        const rows: string[][] = [];
        for (const chunk of chunks) {
          let target: number | null = null;
          for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
            if (rows[rowIndex].length + chunk.memberIds.length <= columns) {
              if (target === null || rows[rowIndex].length < rows[target].length) {
                target = rowIndex;
              }
            }
          }
          if (target !== null) {
            rows[target].push(...chunk.memberIds);
          } else {
            rows.push([...chunk.memberIds]);
          }
        }

        const rowWidths = rows.map((r) => r.length);
        const maxWidth = rowWidths.length > 0 ? Math.max(...rowWidths) : 0;
        const minWidth = rowWidths.length > 0 ? Math.min(...rowWidths) : 0;
        const pixelWidth = (maxWidth - 1) * xStep + cardSize.width + 240;
        const pixelHeight = (rows.length - 1) * yStep + cardSize.height + 240;
        const squareness = Math.abs(Math.log(pixelWidth / pixelHeight));
        const fill = sortedNodes.length / (columns * rows.length);
        const balance = (maxWidth - minWidth) / columns;
        const score = squareness + splitCount * 0.16 + (1 - fill) * 0.18 + balance * 0.08;
        const candidate: ShelfCandidate = { columns, rows, score };

        if (!best) {
          best = candidate;
        } else {
          if (
            candidate.score < best.score - 1e-9 ||
            (Math.abs(candidate.score - best.score) <= 1e-9 && candidate.columns > best.columns)
          ) {
            best = candidate;
          }
        }
      }

      return best!;
    };

    const shelf = chooseShelf();
    let rows = shelf.rows.map((r) => [...r]);

    const anchoredSegments = segments.filter((s) => s.anchorIds.length > 0);
    const anchoredIDs = new Set(anchoredSegments.flatMap((s) => s.memberIds));
    if (anchoredIDs.size > 0) {
      rows = rows.map((r) => r.filter((id) => !anchoredIDs.has(id))).filter((r) => r.length > 0);

      for (const segment of anchoredSegments) {
        const anchorCells: { row: number; column: number }[] = [];
        for (const anchorID of segment.anchorIds) {
          for (let rIndex = 0; rIndex < rows.length; rIndex++) {
            const colIndex = rows[rIndex].indexOf(anchorID);
            if (colIndex !== -1) {
              anchorCells.push({ row: rIndex, column: colIndex });
              break;
            }
          }
        }

        if (anchorCells.length === 0) {
          rows.push([...segment.memberIds]);
          continue;
        }

        const anchorRowCounts: Record<number, number> = {};
        for (const c of anchorCells) {
          anchorRowCounts[c.row] = (anchorRowCounts[c.row] || 0) + 1;
        }
        const sortedRows = Object.keys(anchorRowCounts)
          .map(Number)
          .sort((a, b) => {
            if (anchorRowCounts[a] !== anchorRowCounts[b]) {
              return anchorRowCounts[b] - anchorRowCounts[a];
            }
            return a - b;
          });
        const targetRow = sortedRows[0];
        const targetColumns = anchorCells.filter((c) => c.row === targetRow).map((c) => c.column);

        let insertionIndex: number;
        if (segment.insertAfterAnchorID) {
          const rIndex = rows.findIndex((r) => r.includes(segment.insertAfterAnchorID!));
          if (rIndex !== -1) {
            const anchorIdx = rows[rIndex].indexOf(segment.insertAfterAnchorID);
            insertionIndex = Math.min(rows[rIndex].length, anchorIdx + 1);
          } else {
            insertionIndex = Math.min(rows[targetRow].length, Math.min(...targetColumns, rows[targetRow].length));
          }
        } else {
          insertionIndex = Math.min(rows[targetRow].length, Math.min(...targetColumns, rows[targetRow].length));
        }

        rows[targetRow].splice(insertionIndex, 0, ...segment.memberIds);
      }
    }

    const result: Record<string, Cell> = {};
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < rows[r].length; c++) {
        result[rows[r][c]] = { x: c, y: r };
      }
    }
    return result;
  }

  private static prioritizedEdges(edges: LayoutEdge[], chains: string[][]): Record<string, number> {
    const pairPriority = new Map<string, number>();
    let order = 0;
    for (const chain of chains) {
      for (let i = 0; i < chain.length - 1; i++) {
        const key = `${chain[i]}:${chain[i + 1]}`;
        const cur = pairPriority.get(key) ?? Number.MAX_SAFE_INTEGER;
        pairPriority.set(key, Math.min(cur, order));
        order++;
      }
    }
    const result: Record<string, number> = {};
    for (const edge of edges) {
      const p = pairPriority.get(`${edge.sourceID}:${edge.targetID}`);
      if (p !== undefined) {
        result[edge.id] = p;
      }
    }
    return result;
  }

  private static route(
    edges: LayoutEdge[],
    frames: Record<string, CGRect>,
    cardSize: CGSize,
    priorities: Record<string, number>
  ): Record<string, CGPoint[]> {
    const outgoing = new Map<string, LayoutEdge[]>();
    const incoming = new Map<string, LayoutEdge[]>();
    for (const e of edges) {
      if (!outgoing.has(e.sourceID)) outgoing.set(e.sourceID, []);
      outgoing.get(e.sourceID)!.push(e);
      if (!incoming.has(e.targetID)) incoming.set(e.targetID, []);
      incoming.get(e.targetID)!.push(e);
    }
    for (const list of outgoing.values()) list.sort((a, b) => a.id.localeCompare(b.id));
    for (const list of incoming.values()) list.sort((a, b) => a.id.localeCompare(b.id));

    // Parallel lane offsets
    const undirectedGroups = new Map<string, LayoutEdge[]>();
    for (const e of edges) {
      const uKey = e.sourceID <= e.targetID ? `${e.sourceID}:${e.targetID}` : `${e.targetID}:${e.sourceID}`;
      if (!undirectedGroups.has(uKey)) undirectedGroups.set(uKey, []);
      undirectedGroups.get(uKey)!.push(e);
    }
    const parallelLaneOffsets: Record<string, number> = {};
    for (const group of undirectedGroups.values()) {
      group.sort((a, b) => a.id.localeCompare(b.id));
      const center = (group.length - 1) / 2;
      group.forEach((edge, index) => {
        parallelLaneOffsets[edge.id] = (index - center) * 14;
      });
    }

    const routingObstacleInset = 32;
    const obstacles = Object.values(frames).map((f) => rectInset(f, -routingObstacleInset, -routingObstacleInset));
    const used: CGPoint[][] = [];
    const result: Record<string, CGPoint[]> = {};

    const orderedEdges = [...edges].sort((a, b) => {
      const left = priorities[a.id] ?? Number.MAX_SAFE_INTEGER;
      const right = priorities[b.id] ?? Number.MAX_SAFE_INTEGER;
      return left === right ? a.id.localeCompare(b.id) : left - right;
    });

    const useBoundedRouting = Object.keys(frames).length <= 32 && edges.length <= 64;

    for (const edge of orderedEdges) {
      const source = frames[edge.sourceID];
      const target = frames[edge.targetID];
      if (!source || !target) continue;

      const sMidX = source.x + source.width / 2;
      const sMidY = source.y + source.height / 2;
      const tMidX = target.x + target.width / 2;
      const tMidY = target.y + target.height / 2;
      const horizontal = Math.abs(tMidX - sMidX) >= Math.abs(tMidY - sMidY);

      const outList = outgoing.get(edge.sourceID) || [];
      const inList = incoming.get(edge.targetID) || [];
      const sourceIndex = outList.findIndex((e) => e.id === edge.id);
      const targetIndex = inList.findIndex((e) => e.id === edge.id);
      const sourceOffset = this.portOffset(
        sourceIndex >= 0 ? sourceIndex : 0,
        outList.length || 1,
        horizontal ? cardSize.height : cardSize.width
      );
      const targetOffset = this.portOffset(
        targetIndex >= 0 ? targetIndex : 0,
        inList.length || 1,
        horizontal ? cardSize.height : cardSize.width
      );
      const parallelOffset = parallelLaneOffsets[edge.id] ?? 0;
      const separatedSourceOffset = sourceOffset + parallelOffset;
      const separatedTargetOffset = targetOffset + parallelOffset;

      const excluded = [
        rectInset(source, -routingObstacleInset, -routingObstacleInset),
        rectInset(target, -routingObstacleInset, -routingObstacleInset),
      ];
      const activeObstacles = obstacles.filter((obs) => !excluded.some((ex) => this.nearlyEqual(ex, obs)));
      const lane = Math.abs(separatedSourceOffset - separatedTargetOffset) < 0.1 ? separatedSourceOffset : 0;

      let path: CGPoint[];
      if (useBoundedRouting) {
        path =
          this.directFirstRoute(source, target, activeObstacles, used, lane) ??
          this.gridRoute(
            source,
            target,
            horizontal,
            separatedSourceOffset,
            separatedTargetOffset,
            activeObstacles,
            used
          ) ??
          this.fallbackRoute(source, target, horizontal, separatedSourceOffset, separatedTargetOffset);
      } else {
        path =
          this.directFirstRoute(source, target, activeObstacles, [], lane) ??
          this.fallbackRoute(
            source,
            target,
            horizontal,
            separatedSourceOffset,
            separatedTargetOffset,
            activeObstacles
          );
      }

      const clean = this.compact(path);
      result[edge.id] = clean;
      used.push(clean);
    }

    return result;
  }

  private static directFirstRoute(
    source: CGRect,
    target: CGRect,
    obstacles: CGRect[],
    used: CGPoint[][],
    lane: number
  ): CGPoint[] | null {
    const sMidX = source.x + source.width / 2;
    const sMidY = source.y + source.height / 2;
    const tMidX = target.x + target.width / 2;
    const tMidY = target.y + target.height / 2;
    const dx = tMidX - sMidX;
    const dy = tMidY - sMidY;

    const horizontalStart: CGPoint = { x: dx >= 0 ? source.x + source.width : source.x, y: sMidY + lane };
    const horizontalEnd: CGPoint = { x: dx >= 0 ? target.x : target.x + target.width, y: tMidY + lane };
    const verticalStart: CGPoint = { x: sMidX + lane, y: dy >= 0 ? source.y + source.height : source.y };
    const verticalEnd: CGPoint = { x: tMidX + lane, y: dy >= 0 ? target.y : target.y + target.height };

    const candidates: CGPoint[][] = [];
    if (Math.abs(horizontalStart.y - horizontalEnd.y) < 0.5) {
      candidates.push([horizontalStart, horizontalEnd]);
    }
    if (Math.abs(verticalStart.x - verticalEnd.x) < 0.5) {
      candidates.push([verticalStart, verticalEnd]);
    }
    candidates.push([horizontalStart, { x: horizontalEnd.x, y: horizontalStart.y }, horizontalEnd]);
    candidates.push([verticalStart, { x: verticalStart.x, y: verticalEnd.y }, verticalEnd]);
    const middleX = (horizontalStart.x + horizontalEnd.x) / 2;
    candidates.push([
      horizontalStart,
      { x: middleX, y: horizontalStart.y },
      { x: middleX, y: horizontalEnd.y },
      horizontalEnd,
    ]);
    const middleY = (verticalStart.y + verticalEnd.y) / 2;
    candidates.push([
      verticalStart,
      { x: verticalStart.x, y: middleY },
      { x: verticalEnd.x, y: middleY },
      verticalEnd,
    ]);

    const validCandidates = candidates
      .map((pts) => this.compact(pts))
      .filter((points) => {
        for (let i = 0; i < points.length - 1; i++) {
          if (!this.segmentIsClear(points[i], points[i + 1], obstacles)) return false;
        }
        return true;
      });

    if (validCandidates.length === 0) return null;

    validCandidates.sort((a, b) => this.routeScore(a, used) - this.routeScore(b, used));
    return validCandidates[0];
  }

  private static routeScore(points: CGPoint[], used: CGPoint[][]): number {
    const bends = Math.max(0, points.length - 2);
    let overlap = 0;
    for (let i = 0; i < points.length - 1; i++) {
      for (const u of used) {
        overlap += this.segmentOverlap(points[i], points[i + 1], u);
      }
    }
    let length = 0;
    for (let i = 0; i < points.length - 1; i++) {
      length += Math.abs(points[i + 1].x - points[i].x) + Math.abs(points[i + 1].y - points[i].y);
    }
    return bends * 10000 + overlap * 1000 + length;
  }

  private static gridRoute(
    source: CGRect,
    target: CGRect,
    horizontal: boolean,
    sourceOffset: number,
    targetOffset: number,
    obstacles: CGRect[],
    used: CGPoint[][]
  ): CGPoint[] | null {
    const clearance = 18;
    const endpoints = this.routeEndpoints(source, target, horizontal, sourceOffset, targetOffset, clearance);
    const { start, escape, approach, end } = endpoints;

    const corridor = rectInset(rectUnion(source, target), -72, -72);
    const routingObstacles = obstacles.filter((o) => rectIntersects(o, corridor));

    const xsList = [escape.x, approach.x, corridor.x, corridor.x + corridor.width];
    const ysList = [escape.y, approach.y, corridor.y, corridor.y + corridor.height];
    for (const obs of routingObstacles) {
      xsList.push(obs.x - clearance, obs.x + obs.width + clearance);
      ysList.push(obs.y - clearance, obs.y + obs.height + clearance);
    }
    const xs = this.uniqueSorted(xsList);
    const ys = this.uniqueSorted(ysList);

    const escapeKey = `${escape.x}:${escape.y}`;
    const approachKey = `${approach.x}:${approach.y}`;

    const pointMap = new Map<string, CGPoint>();
    for (const x of xs) {
      for (const y of ys) {
        const pt = { x, y };
        if (!obstacles.some((o) => rectContainsStrictly(o, pt))) {
          pointMap.set(`${x}:${y}`, pt);
        }
      }
    }
    if (!pointMap.has(escapeKey) || !pointMap.has(approachKey)) return null;

    const neighbors = new Map<string, string[]>();
    const connectAdjacent = (pts: string[]) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const p1 = pointMap.get(pts[i])!;
        const p2 = pointMap.get(pts[i + 1])!;
        if (this.segmentIsClear(p1, p2, obstacles)) {
          if (!neighbors.has(pts[i])) neighbors.set(pts[i], []);
          if (!neighbors.has(pts[i + 1])) neighbors.set(pts[i + 1], []);
          neighbors.get(pts[i])!.push(pts[i + 1]);
          neighbors.get(pts[i + 1])!.push(pts[i]);
        }
      }
    };

    for (const y of ys) {
      const row = xs.map((x) => `${x}:${y}`).filter((k) => pointMap.has(k));
      connectAdjacent(row);
    }
    for (const x of xs) {
      const col = ys.map((y) => `${x}:${y}`).filter((k) => pointMap.has(k));
      connectAdjacent(col);
    }

    interface RouteState {
      key: string;
      direction: 'h' | 'v' | null;
    }
    const stateKey = (s: RouteState) => `${s.key}:${s.direction ?? 'none'}`;

    const initial: RouteState = { key: escapeKey, direction: null };
    const costs = new Map<string, number>();
    costs.set(stateKey(initial), 0);
    const previous = new Map<string, RouteState>();

    // Priority queue
    const pq: { cost: number; state: RouteState }[] = [{ cost: 0, state: initial }];

    let destination: RouteState | null = null;
    while (pq.length > 0) {
      pq.sort((a, b) => a.cost - b.cost);
      const current = pq.shift()!;
      const curKey = stateKey(current.state);
      if (current.cost > (costs.get(curKey) ?? Infinity)) continue;
      if (current.state.key === approachKey) {
        destination = current.state;
        break;
      }

      const curPt = pointMap.get(current.state.key)!;
      const nbrs = neighbors.get(current.state.key) || [];
      for (const nextKey of nbrs) {
        const nextPt = pointMap.get(nextKey)!;
        const axis: 'h' | 'v' = nextPt.x === curPt.x ? 'v' : 'h';
        const dist = Math.abs(nextPt.x - curPt.x) + Math.abs(nextPt.y - curPt.y);
        const turnCost = current.state.direction === null || current.state.direction === axis ? 0 : 16;
        let overlapCount = 0;
        for (const u of used) {
          overlapCount += this.segmentOverlap(curPt, nextPt, u);
        }
        const overlapCost = overlapCount * 36;
        const nextState: RouteState = { key: nextKey, direction: axis };
        const newCost = current.cost + dist + turnCost + overlapCost;
        const nKey = stateKey(nextState);
        if (newCost < (costs.get(nKey) ?? Infinity)) {
          costs.set(nKey, newCost);
          previous.set(nKey, current.state);
          pq.push({ cost: newCost, state: nextState });
        }
      }
    }

    if (!destination) return null;

    const middle: CGPoint[] = [pointMap.get(destination.key)!];
    let cursor: RouteState | undefined = destination;
    while (cursor) {
      const parent = previous.get(stateKey(cursor));
      if (!parent) break;
      cursor = parent;
      middle.push(pointMap.get(cursor.key)!);
    }
    middle.reverse();
    return this.compact([start, ...middle, end]);
  }

  private static routeEndpoints(
    source: CGRect,
    target: CGRect,
    horizontal: boolean,
    sourceOffset: number,
    targetOffset: number,
    clearance: number
  ): { start: CGPoint; escape: CGPoint; approach: CGPoint; end: CGPoint } {
    const sMidX = source.x + source.width / 2;
    const sMidY = source.y + source.height / 2;
    const tMidX = target.x + target.width / 2;
    const tMidY = target.y + target.height / 2;

    if (horizontal) {
      const forward = tMidX >= sMidX;
      const start: CGPoint = { x: forward ? source.x + source.width : source.x, y: sMidY + sourceOffset };
      const end: CGPoint = { x: forward ? target.x : target.x + target.width, y: tMidY + targetOffset };
      return {
        start,
        escape: { x: start.x + (forward ? clearance : -clearance), y: start.y },
        approach: { x: end.x + (forward ? -clearance : clearance), y: end.y },
        end,
      };
    }
    const downward = tMidY >= sMidY;
    const start: CGPoint = { x: sMidX + sourceOffset, y: downward ? source.y + source.height : source.y };
    const end: CGPoint = { x: tMidX + targetOffset, y: downward ? target.y : target.y + target.height };
    return {
      start,
      escape: { x: start.x, y: start.y + (downward ? clearance : -clearance) },
      approach: { x: end.x, y: end.y + (downward ? -clearance : clearance) },
      end,
    };
  }

  private static fallbackRoute(
    source: CGRect,
    target: CGRect,
    horizontal: boolean,
    sourceOffset: number,
    targetOffset: number,
    obstacles: CGRect[] = []
  ): CGPoint[] {
    const points = this.routeEndpoints(source, target, horizontal, sourceOffset, targetOffset, 18);
    let direct: CGPoint[];
    if (horizontal) {
      const trackY = (points.escape.y + points.approach.y) / 2;
      direct = this.compact([
        points.start,
        points.escape,
        { x: points.escape.x, y: trackY },
        { x: points.approach.x, y: trackY },
        points.approach,
        points.end,
      ]);
    } else {
      const trackX = (points.escape.x + points.approach.x) / 2;
      direct = this.compact([
        points.start,
        points.escape,
        { x: trackX, y: points.escape.y },
        { x: trackX, y: points.approach.y },
        points.approach,
        points.end,
      ]);
    }
    if (obstacles.length === 0) return direct;

    const isClear = (cand: CGPoint[]) => {
      for (let i = 0; i < cand.length - 1; i++) {
        if (!this.segmentIsClear(cand[i], cand[i + 1], obstacles)) return false;
      }
      return true;
    };
    if (isClear(direct)) return direct;

    const clearance = 36;
    if (horizontal) {
      const minYs = obstacles.map((o) => o.y);
      const maxYs = obstacles.map((o) => o.y + o.height);
      const tracks = this.uniqueSorted([
        (points.escape.y + points.approach.y) / 2,
        Math.min(...minYs) - clearance,
        Math.max(...maxYs) + clearance,
      ]);
      for (const trackY of tracks) {
        const candidate = this.compact([
          points.start,
          points.escape,
          { x: points.escape.x, y: trackY },
          { x: points.approach.x, y: trackY },
          points.approach,
          points.end,
        ]);
        if (isClear(candidate)) return candidate;
      }
    } else {
      const minXs = obstacles.map((o) => o.x);
      const maxXs = obstacles.map((o) => o.x + o.width);
      const tracks = this.uniqueSorted([
        (points.escape.x + points.approach.x) / 2,
        Math.min(...minXs) - clearance,
        Math.max(...maxXs) + clearance,
      ]);
      for (const trackX of tracks) {
        const candidate = this.compact([
          points.start,
          points.escape,
          { x: trackX, y: points.escape.y },
          { x: trackX, y: points.approach.y },
          points.approach,
          points.end,
        ]);
        if (isClear(candidate)) return candidate;
      }
    }
    return direct;
  }

  private static portOffset(index: number, count: number, span: number): number {
    if (count <= 1) return 0;
    const step = Math.min(13, Math.max(4, (span - 34) / (count - 1)));
    return (index - (count - 1) / 2) * step;
  }

  private static segmentIsClear(start: CGPoint, end: CGPoint, obstacles: CGRect[]): boolean {
    return obstacles.every((obs) => !this.segmentCrossesRect(start, end, obs));
  }

  private static segmentCrossesRect(start: CGPoint, end: CGPoint, rect: CGRect): boolean {
    if (start.x === end.x) {
      return (
        start.x > rect.x &&
        start.x < rect.x + rect.width &&
        Math.max(start.y, end.y) > rect.y &&
        Math.min(start.y, end.y) < rect.y + rect.height
      );
    }
    if (start.y === end.y) {
      return (
        start.y > rect.y &&
        start.y < rect.y + rect.height &&
        Math.max(start.x, end.x) > rect.x &&
        Math.min(start.x, end.x) < rect.x + rect.width
      );
    }
    return true;
  }

  private static segmentOverlap(start: CGPoint, end: CGPoint, path: CGPoint[]): number {
    for (let i = 0; i < path.length - 1; i++) {
      if (this.segmentsOverlap(start, end, path[i], path[i + 1])) return 1;
    }
    return 0;
  }

  private static segmentsOverlap(a1: CGPoint, a2: CGPoint, b1: CGPoint, b2: CGPoint): boolean {
    if (a1.x === a2.x && b1.x === b2.x && a1.x === b1.x) {
      return Math.max(Math.min(a1.y, a2.y), Math.min(b1.y, b2.y)) < Math.min(Math.max(a1.y, a2.y), Math.max(b1.y, b2.y));
    }
    if (a1.y === a2.y && b1.y === b2.y && a1.y === b1.y) {
      return Math.max(Math.min(a1.x, a2.x), Math.min(b1.x, b2.x)) < Math.min(Math.max(a1.x, a2.x), Math.max(b1.x, b2.x));
    }
    return false;
  }

  private static nearlyEqual(a: CGRect, b: CGRect): boolean {
    return (
      Math.abs(a.x - b.x) < 0.1 &&
      Math.abs(a.y - b.y) < 0.1 &&
      Math.abs(a.width - b.width) < 0.1 &&
      Math.abs(a.height - b.height) < 0.1
    );
  }

  private static uniqueSorted(values: number[]): number[] {
    const rounded = values.map((v) => Math.round(v * 10) / 10);
    return Array.from(new Set(rounded)).sort((a, b) => a - b);
  }

  static compact(points: CGPoint[]): CGPoint[] {
    const result: CGPoint[] = [];
    for (const point of points) {
      if (result.length > 0) {
        const last = result[result.length - 1];
        if (Math.abs(last.x - point.x) < 0.001 && Math.abs(last.y - point.y) < 0.001) continue;
      }
      if (result.length >= 2) {
        const a = result[result.length - 2];
        const b = result[result.length - 1];
        if (
          (Math.abs(a.x - b.x) < 0.001 && Math.abs(b.x - point.x) < 0.001) ||
          (Math.abs(a.y - b.y) < 0.001 && Math.abs(b.y - point.y) < 0.001)
        ) {
          result[result.length - 1] = point;
          continue;
        }
      }
      result.push(point);
    }
    return result;
  }
}
