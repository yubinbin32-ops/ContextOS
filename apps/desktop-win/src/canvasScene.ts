// 1:1 Port of apps/desktop/Sources/ContextOSDesktop/CanvasScene.swift

import { BlockItem, GraphSnapshot, LinkItem } from './models';
import {
  CGPoint,
  CGRect,
  CGSize,
  NetworkLayoutEngine,
  NetworkLayoutSnapshot,
  rect,
  rectContains,
  rectContainsStrictly,
  rectInset,
  rectIntersects,
  rectUnion,
} from './networkLayout';

export interface ChainEnvelopeGeometry {
  nodeFrames: CGRect[];
  routes: CGPoint[][];
  corridorFrames: CGRect[];
  contours: CGPoint[][];
  expansion: number;
}

export function chainEnvelopeIntersectsUnrelatedBlock(geom: ChainEnvelopeGeometry, frame: CGRect): boolean {
  return geom.corridorFrames.some((c) => rectIntersects(c, frame));
}

export function chainEnvelopeContains(geom: ChainEnvelopeGeometry, point: CGPoint): boolean {
  let intersections = 0;
  for (const contour of geom.contours) {
    if (polygonContains(point, contour)) intersections++;
  }
  return intersections % 2 === 1;
}

function polygonContains(point: CGPoint, polygon: CGPoint[]): boolean {
  if (polygon.length <= 2) return false;
  let inside = false;
  let previous = polygon[polygon.length - 1];
  for (const current of polygon) {
    if ((current.y > point.y) !== (previous.y > point.y)) {
      const crossing = ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x;
      if (point.x < crossing) inside = !inside;
    }
    previous = current;
  }
  return inside;
}

interface Edge {
  start: CGPoint;
  end: CGPoint;
}

export class ChainEnvelopeEngine {
  static readonly baseExpansion: number = 10;
  static readonly laneSpacing: number = 9;

  static make({
    nodeIDs,
    linkIDs,
    layout,
    cardSize,
    expansion,
  }: {
    nodeIDs: string[];
    linkIDs: string[];
    layout: NetworkLayoutSnapshot;
    cardSize: CGSize;
    expansion: number;
  }): ChainEnvelopeGeometry {
    const nodeFrames: CGRect[] = [];
    for (const id of nodeIDs) {
      const pos = layout.positions[id];
      if (pos) {
        nodeFrames.push(rectInset(rect(pos.x, pos.y, cardSize.width, cardSize.height), -expansion, -expansion));
      }
    }

    const routes: CGPoint[][] = [];
    for (const id of linkIDs) {
      const r = layout.routes[id];
      if (r && r.length > 1) {
        routes.push(r);
      }
    }

    const halfWidth = 15 + expansion;
    const corridors: CGRect[] = [];
    for (const route of routes) {
      for (let i = 0; i < route.length - 1; i++) {
        const start = route[i];
        const end = route[i + 1];
        if (start.x === end.x) {
          corridors.push(
            rect(start.x - halfWidth, Math.min(start.y, end.y), halfWidth * 2, Math.abs(end.y - start.y))
          );
        } else {
          corridors.push(
            rect(Math.min(start.x, end.x), start.y - halfWidth, Math.abs(end.x - start.x), halfWidth * 2)
          );
        }
      }
    }

    const contours = this.unionContours([...nodeFrames, ...corridors]);
    return {
      nodeFrames,
      routes,
      corridorFrames: corridors,
      contours,
      expansion,
    };
  }

  private static unionContours(rectangles: CGRect[], allowCoarsening = true): CGPoint[][] {
    const standardized = rectangles
      .map((r) => ({
        x: r.width < 0 ? r.x + r.width : r.x,
        y: r.height < 0 ? r.y + r.height : r.y,
        width: Math.abs(r.width),
        height: Math.abs(r.height),
      }))
      .filter((r) => r.width > 0 && r.height > 0);

    if (standardized.length === 0) return [];

    const xsSet = new Set<number>();
    const ysSet = new Set<number>();
    for (const r of standardized) {
      xsSet.add(r.x);
      xsSet.add(r.x + r.width);
      ysSet.add(r.y);
      ysSet.add(r.y + r.height);
    }
    const xs = Array.from(xsSet).sort((a, b) => a - b);
    const ys = Array.from(ysSet).sort((a, b) => a - b);
    if (xs.length <= 1 || ys.length <= 1) return [];

    const maximumAxisCells = 160;
    if (allowCoarsening && (xs.length > maximumAxisCells + 1 || ys.length > maximumAxisCells + 1)) {
      const xRange = xs[xs.length - 1] - xs[0];
      const yRange = ys[ys.length - 1] - ys[0];
      const xStep = Math.max(1, xRange / maximumAxisCells);
      const yStep = Math.max(1, yRange / maximumAxisCells);
      const quantize = (val: number, min: number, step: number, upper: number) => {
        return Math.min(upper, min + Math.floor((val - min) / step) * step);
      };
      const coarse = standardized.map((r) => {
        const minX = quantize(r.x, xs[0], xStep, xs[xs.length - 1]);
        const minY = quantize(r.y, ys[0], yStep, ys[ys.length - 1]);
        const xCeiling = xs[0] + Math.ceil((r.x + r.width - xs[0]) / xStep) * xStep;
        const yCeiling = ys[0] + Math.ceil((r.y + r.height - ys[0]) / yStep) * yStep;
        const maxX = Math.min(xs[xs.length - 1], Math.max(minX + xStep, xCeiling));
        const maxY = Math.min(ys[ys.length - 1], Math.max(minY + yStep, yCeiling));
        const width = Math.max(1, maxX - minX);
        const height = Math.max(1, maxY - minY);
        return rect(minX, minY, width, height);
      });
      return this.unionContours(coarse, false);
    }

    const occupied: boolean[][] = Array.from({ length: xs.length - 1 }, () =>
      Array(ys.length - 1).fill(false)
    );
    for (let xIdx = 0; xIdx < xs.length - 1; xIdx++) {
      for (let yIdx = 0; yIdx < ys.length - 1; yIdx++) {
        const center: CGPoint = {
          x: (xs[xIdx] + xs[xIdx + 1]) / 2,
          y: (ys[yIdx] + ys[yIdx + 1]) / 2,
        };
        occupied[xIdx][yIdx] = standardized.some((r) => rectContains(r, center));
      }
    }

    const edges: Edge[] = [];
    const edgeKey = (e: Edge) => `${e.start.x},${e.start.y}->${e.end.x},${e.end.y}`;
    const edgeSet = new Set<string>();

    const addEdge = (start: CGPoint, end: CGPoint) => {
      const e: Edge = { start, end };
      const k = edgeKey(e);
      if (!edgeSet.has(k)) {
        edgeSet.add(k);
        edges.push(e);
      }
    };

    for (let xIdx = 0; xIdx < xs.length - 1; xIdx++) {
      for (let yIdx = 0; yIdx < ys.length - 1; yIdx++) {
        if (!occupied[xIdx][yIdx]) continue;
        const x0 = xs[xIdx],
          x1 = xs[xIdx + 1],
          y0 = ys[yIdx],
          y1 = ys[yIdx + 1];
        if (yIdx === 0 || !occupied[xIdx][yIdx - 1]) addEdge({ x: x0, y: y0 }, { x: x1, y: y0 });
        if (xIdx === xs.length - 2 || !occupied[xIdx + 1][yIdx]) addEdge({ x: x1, y: y0 }, { x: x1, y: y1 });
        if (yIdx === ys.length - 2 || !occupied[xIdx][yIdx + 1]) addEdge({ x: x1, y: y1 }, { x: x0, y: y1 });
        if (xIdx === 0 || !occupied[xIdx - 1][yIdx]) addEdge({ x: x0, y: y1 }, { x: x0, y: y0 });
      }
    }

    const outgoing = new Map<string, Edge[]>();
    for (const e of edges) {
      const k = `${e.start.x},${e.start.y}`;
      if (!outgoing.has(k)) outgoing.set(k, []);
      outgoing.get(k)!.push(e);
    }
    for (const list of outgoing.values()) {
      list.sort((a, b) => this.edgeOrder(a, b));
    }

    const activeEdges = new Set(edges);
    const contours: CGPoint[][] = [];

    const getMinEdge = (): Edge | null => {
      let min: Edge | null = null;
      for (const e of activeEdges) {
        if (!min || this.edgeOrder(e, min) < 0) min = e;
      }
      return min;
    };

    while (activeEdges.size > 0) {
      const first = getMinEdge();
      if (!first) break;

      const contour = [first.start];
      let edge = first;
      activeEdges.delete(edge);
      let safety = activeEdges.size + 2;

      while (
        (edge.end.x !== first.start.x || edge.end.y !== first.start.y) &&
        safety > 0
      ) {
        contour.push(edge.end);
        const candidates = outgoing.get(`${edge.end.x},${edge.end.y}`) || [];
        const next = candidates.find((c) => activeEdges.has(c));
        if (!next) break;
        edge = next;
        activeEdges.delete(next);
        safety--;
      }

      if (edge.end.x === first.start.x && edge.end.y === first.start.y && contour.length >= 4) {
        contours.push(this.removeCollinearPoints(contour));
      }
    }

    return contours.sort((a, b) => this.absoluteArea(b) - this.absoluteArea(a));
  }

  private static edgeOrder(left: Edge, right: Edge): number {
    if (left.start.y !== right.start.y) return left.start.y - right.start.y;
    if (left.start.x !== right.start.x) return left.start.x - right.start.x;
    if (left.end.y !== right.end.y) return left.end.y - right.end.y;
    return left.end.x - right.end.x;
  }

  private static removeCollinearPoints(points: CGPoint[]): CGPoint[] {
    if (points.length <= 3) return points;
    const result: CGPoint[] = [];
    for (let i = 0; i < points.length; i++) {
      const prev = points[(i - 1 + points.length) % points.length];
      const curr = points[i];
      const next = points[(i + 1) % points.length];
      if ((prev.x === curr.x && curr.x === next.x) || (prev.y === curr.y && curr.y === next.y)) {
        continue;
      }
      result.push(curr);
    }
    return result;
  }

  private static absoluteArea(points: CGPoint[]): number {
    if (points.length === 0) return 0;
    const closed = [...points.slice(1), points[0]];
    let total = 0;
    for (let i = 0; i < points.length; i++) {
      total += points[i].x * closed[i].y - closed[i].x * points[i].y;
    }
    return Math.abs(total) / 2;
  }
}

export class ChainEnvelopeLaneAllocator {
  static make(chainNodes: Record<string, string[]>): Record<string, number> {
    const nodeSets: Record<string, Set<string>> = {};
    for (const [id, nodes] of Object.entries(chainNodes)) {
      nodeSets[id] = new Set(nodes);
    }
    const chainIDs = Object.keys(nodeSets).sort();

    const isDisjoint = (a: Set<string>, b: Set<string>) => {
      for (const item of a) {
        if (b.has(item)) return false;
      }
      return true;
    };

    const neighbors: Record<string, Set<string>> = {};
    for (const id of chainIDs) {
      const overlapping = chainIDs.filter((other) => other !== id && !isDisjoint(nodeSets[id], nodeSets[other]));
      neighbors[id] = new Set(overlapping);
    }

    const order = [...chainIDs].sort((a, b) => {
      const leftDegree = neighbors[a].size;
      const rightDegree = neighbors[b].size;
      return leftDegree === rightDegree ? a.localeCompare(b) : rightDegree - leftDegree;
    });

    const result: Record<string, number> = {};
    for (const id of order) {
      const unavailable = new Set<number>();
      for (const n of neighbors[id]) {
        if (result[n] !== undefined) unavailable.add(result[n]);
      }
      let lane = 0;
      while (unavailable.has(lane)) lane++;
      result[id] = lane;
    }
    return result;
  }
}

export class CanvasScene {
  projectID: string;
  graphRevision: number;
  blocks: BlockItem[];
  links: LinkItem[];
  cardSize: CGSize;
  layout: NetworkLayoutSnapshot;
  chainNodes: Record<string, string[]>;
  chainLinks: Record<string, string[]>;
  chainEnvelopes: Record<string, ChainEnvelopeGeometry>;
  adjacency: Record<string, Set<string>>;

  constructor({
    projectID,
    graphRevision,
    blocks,
    links,
    cardSize,
    layout,
    chainNodes,
    chainLinks,
    chainEnvelopes,
    adjacency,
  }: {
    projectID: string;
    graphRevision: number;
    blocks: BlockItem[];
    links: LinkItem[];
    cardSize: CGSize;
    layout: NetworkLayoutSnapshot;
    chainNodes: Record<string, string[]>;
    chainLinks: Record<string, string[]>;
    chainEnvelopes: Record<string, ChainEnvelopeGeometry>;
    adjacency: Record<string, Set<string>>;
  }) {
    this.projectID = projectID;
    this.graphRevision = graphRevision;
    this.blocks = blocks;
    this.links = links;
    this.cardSize = cardSize;
    this.layout = layout;
    this.chainNodes = chainNodes;
    this.chainLinks = chainLinks;
    this.chainEnvelopes = chainEnvelopes;
    this.adjacency = adjacency;
  }

  static empty(): CanvasScene {
    return new CanvasScene({
      projectID: '',
      graphRevision: -1,
      blocks: [],
      links: [],
      cardSize: { width: 224, height: 128 },
      layout: {
        positions: {},
        routes: {},
        layerBands: [],
        scopeBands: [],
        size: { width: 900, height: 620 },
      },
      chainNodes: {},
      chainLinks: {},
      chainEnvelopes: {},
      adjacency: {},
    });
  }

  static compile(
    snapshot: GraphSnapshot,
    hiddenKinds: Set<string> = new Set(),
    topInset: number = 70
  ): CanvasScene {
    const backgroundRuleIDs = new Set(snapshot.backgroundScopes.map((s) => s.blockId));
    const blocks = snapshot.blocks.filter(
      (b) => !backgroundRuleIDs.has(b.id) && !hiddenKinds.has(b.kind)
    );
    const visibleIDs = new Set(blocks.map((b) => b.id));
    const links = snapshot.links.filter(
      (l) =>
        l.sourceType === 'block' &&
        l.targetType === 'block' &&
        visibleIDs.has(l.sourceId) &&
        visibleIDs.has(l.targetId)
    );
    const cardSize: CGSize = { width: 224, height: 128 };

    const directChainNodes: Record<string, string[]> = {};
    for (const chain of snapshot.chains) {
      directChainNodes[chain.id] = snapshot.chainNodes
        .filter((cn) => cn.chainId === chain.id)
        .sort((a, b) => a.position - b.position)
        .map((cn) => cn.blockId);
    }

    const membersByChain = new Map<string, typeof snapshot.chainMembers>();
    for (const m of snapshot.chainMembers) {
      if (!membersByChain.has(m.chainId)) membersByChain.set(m.chainId, []);
      membersByChain.get(m.chainId)!.push(m);
    }

    const resolvedChainNodes = (chainID: string, visited: Set<string> = new Set()): string[] => {
      if (visited.has(chainID)) return [];
      const nextVisited = new Set(visited);
      nextVisited.add(chainID);
      const result: string[] = [...(directChainNodes[chainID] || [])];
      const members = (membersByChain.get(chainID) || []).sort((a, b) => a.position - b.position);
      for (const m of members) {
        if (m.memberType === 'block') {
          if (!result.includes(m.memberId)) result.push(m.memberId);
        } else {
          for (const bId of resolvedChainNodes(m.memberId, nextVisited)) {
            if (!result.includes(bId)) result.push(bId);
          }
        }
      }
      return result;
    };

    const chainNodes: Record<string, string[]> = {};
    for (const chain of snapshot.chains) {
      chainNodes[chain.id] = resolvedChainNodes(chain.id).filter((id) => visibleIDs.has(id));
    }

    const visibleLinkIDs = new Set(links.map((l) => l.id));
    const chainLinks: Record<string, string[]> = {};
    for (const chain of snapshot.chains) {
      chainLinks[chain.id] = snapshot.chainEdges
        .filter((ce) => ce.chainId === chain.id && visibleLinkIDs.has(ce.linkId))
        .sort((a, b) => a.position - b.position)
        .map((ce) => ce.linkId);
    }

    const districts: Record<string, number> = {};
    const metadata: Record<string, { layer: number; scope: string; order: number }> = {};
    for (const b of blocks) {
      districts[b.id] = this.districtIndex(b.kind);
      metadata[b.id] = {
        layer: this.architectureIndex(b.architectureLayer),
        scope: b.scope,
        order: b.localOrder,
      };
    }

    const focusPaths = snapshot.chains
      .map((c) => chainNodes[c.id] || [])
      .filter((p) => p.length > 0);

    const layout = NetworkLayoutEngine.make({
      nodeIDs: blocks.map((b) => b.id),
      edges: links.map((l) => ({ id: l.id, sourceID: l.sourceId, targetID: l.targetId })),
      focusPaths,
      districts,
      metadata,
      cardSize,
      topInset,
    });

    const chainLaneIndices = ChainEnvelopeLaneAllocator.make(chainNodes);
    const chainEnvelopes: Record<string, ChainEnvelopeGeometry> = {};
    for (const chain of snapshot.chains) {
      const expansion =
        ChainEnvelopeEngine.baseExpansion +
        (chainLaneIndices[chain.id] ?? 0) * ChainEnvelopeEngine.laneSpacing;
      chainEnvelopes[chain.id] = ChainEnvelopeEngine.make({
        nodeIDs: chainNodes[chain.id] || [],
        linkIDs: chainLinks[chain.id] || [],
        layout,
        cardSize,
        expansion,
      });
    }

    const adjacency: Record<string, Set<string>> = {};
    for (const b of blocks) adjacency[b.id] = new Set();
    for (const l of links) {
      if (!adjacency[l.sourceId]) adjacency[l.sourceId] = new Set();
      if (!adjacency[l.targetId]) adjacency[l.targetId] = new Set();
      adjacency[l.sourceId].add(l.targetId);
      adjacency[l.targetId].add(l.sourceId);
    }

    return new CanvasScene({
      projectID: snapshot.project.id,
      graphRevision: snapshot.project.graphRevision,
      blocks,
      links,
      cardSize,
      layout,
      chainNodes,
      chainLinks,
      chainEnvelopes,
      adjacency,
    });
  }

  connectedComponent(fromBlockID: string): Set<string> {
    if (!this.adjacency[fromBlockID]) return new Set([fromBlockID]);
    const visited = new Set<string>([fromBlockID]);
    const queue = [fromBlockID];
    let index = 0;
    while (index < queue.length) {
      const current = queue[index++];
      const neighbors = this.adjacency[current] || new Set();
      for (const next of neighbors) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    return visited;
  }

  bounds(blockIDs: Set<string>, padding = 28): CGRect | null {
    const frames: CGRect[] = [];
    for (const id of blockIDs) {
      const pos = this.layout.positions[id];
      if (pos) {
        frames.push(rect(pos.x, pos.y, this.cardSize.width, this.cardSize.height));
      }
    }
    if (frames.length === 0) return null;
    let b = frames[0];
    for (let i = 1; i < frames.length; i++) {
      b = rectUnion(b, frames[i]);
    }
    return rectInset(b, -padding, -padding);
  }

  private static districtIndex(kind: string): number {
    switch (kind) {
      case 'principle':
      case 'requirement':
      case 'product':
        return 0;
      case 'ui':
      case 'flow':
        return 1;
      case 'service':
      case 'function':
        return 2;
      case 'integration':
        return 3;
      case 'data':
      case 'database':
        return 4;
      case 'test':
      case 'checkpoint':
        return 5;
      case 'risk':
        return 6;
      default:
        return 7;
    }
  }

  private static architectureIndex(layer: string): number {
    const layers = [
      'client',
      'boundary',
      'application',
      'domain',
      'data',
      'external',
      'quality',
      'infrastructure',
      'unspecified',
    ];
    const idx = layers.indexOf(layer);
    return idx >= 0 ? idx : 8;
  }
}
