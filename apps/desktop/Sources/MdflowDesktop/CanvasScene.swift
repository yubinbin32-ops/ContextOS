import Foundation

/// Immutable, precompiled Canvas data. Selection, details and camera changes read
/// this scene without invoking the layout engine again.
struct CanvasScene: Equatable {
    let projectID: String
    let graphRevision: Int
    let blocks: [BlockItem]
    let links: [LinkItem]
    let cardSize: CGSize
    let layout: NetworkLayoutSnapshot
    let chainNodes: [String: [String]]
    let chainLinks: [String: [String]]
    let chainEnvelopes: [String: ChainEnvelopeGeometry]
    let adjacency: [String: Set<String>]

    static let empty = CanvasScene(
        projectID: "", graphRevision: -1, blocks: [], links: [], cardSize: CGSize(width: 224, height: 128),
        layout: NetworkLayoutSnapshot(positions: [:], routes: [:], layerBands: [], scopeBands: [], size: CGSize(width: 900, height: 620)),
        chainNodes: [:], chainLinks: [:], chainEnvelopes: [:], adjacency: [:]
    )

    static func compile(snapshot: GraphSnapshot, lenses: Set<ViewLens>, topInset: CGFloat = 70) -> CanvasScene {
        let backgroundRuleIDs = Set(snapshot.backgroundScopes.map(\.blockId))
        let allCanvasBlocks = snapshot.blocks.filter {
            !backgroundRuleIDs.contains($0.id) && $0.kind.lowercased() != "decision"
        }
        let visibleIDs = Set(allCanvasBlocks.filter { block in
            lenses.contains { $0.includes(block: block) }
        }.map(\.id))
        let blocks = allCanvasBlocks.filter { visibleIDs.contains($0.id) }
        let links = snapshot.links.filter {
            $0.sourceType == "block" && $0.targetType == "block" &&
                visibleIDs.contains($0.sourceId) && visibleIDs.contains($0.targetId)
        }
        let cardSize = CGSize(width: 224, height: 128)
        let chainNodes = Dictionary(uniqueKeysWithValues: snapshot.chains.map { chain in
            (chain.id, snapshot.chainNodes.filter { $0.chainId == chain.id && visibleIDs.contains($0.blockId) }.sorted { $0.position < $1.position }.map(\.blockId))
        })
        let visibleLinkIDs = Set(links.map(\.id))
        let chainLinks = Dictionary(uniqueKeysWithValues: snapshot.chains.map { chain in
            (chain.id, snapshot.chainEdges.filter { $0.chainId == chain.id && visibleLinkIDs.contains($0.linkId) }.sorted { $0.position < $1.position }.map(\.linkId))
        })
        // Recompile the visible subgraph when a lens changes.  The scene
        // transition animates the resulting positions, so filtering changes
        // the distribution without refitting the camera or mutating graph data.
        let layout = NetworkLayoutEngine.make(
            nodeIDs: blocks.map(\.id),
            edges: links.map { LayoutEdge(id: $0.id, sourceID: $0.sourceId, targetID: $0.targetId) },
            focusPaths: snapshot.chains.compactMap { chainNodes[$0.id] }.filter { !$0.isEmpty },
            districts: Dictionary(uniqueKeysWithValues: blocks.map { ($0.id, districtIndex($0.kind)) }),
            metadata: Dictionary(uniqueKeysWithValues: blocks.map {
                ($0.id, LayoutNodeMetadata(layer: architectureIndex($0.architectureLayer), scope: $0.scope, order: $0.localOrder))
            }),
            cardSize: cardSize,
            topInset: topInset
        )
        let chainLaneIndices = ChainEnvelopeLaneAllocator.make(chainNodes: chainNodes)
        let chainEnvelopes = Dictionary(uniqueKeysWithValues: snapshot.chains.map { chain in
            let expansion = ChainEnvelopeEngine.baseExpansion
                + CGFloat(chainLaneIndices[chain.id, default: 0]) * ChainEnvelopeEngine.laneSpacing
            return (chain.id, ChainEnvelopeEngine.make(
                nodeIDs: chainNodes[chain.id] ?? [], linkIDs: chainLinks[chain.id] ?? [],
                layout: layout, cardSize: cardSize, expansion: expansion
            ))
        })
        var adjacency = Dictionary(uniqueKeysWithValues: blocks.map { ($0.id, Set<String>()) })
        for link in links {
            adjacency[link.sourceId, default: []].insert(link.targetId)
            adjacency[link.targetId, default: []].insert(link.sourceId)
        }
        return CanvasScene(
            projectID: snapshot.project.id, graphRevision: snapshot.project.graphRevision,
            blocks: blocks, links: links, cardSize: cardSize, layout: layout,
            chainNodes: chainNodes, chainLinks: chainLinks, chainEnvelopes: chainEnvelopes, adjacency: adjacency
        )
    }

    func connectedComponent(from blockID: String) -> Set<String> {
        guard adjacency[blockID] != nil else { return [blockID] }
        var visited: Set<String> = [blockID]
        var queue = [blockID]
        var index = 0
        while index < queue.count {
            let current = queue[index]
            index += 1
            for next in adjacency[current, default: []] where visited.insert(next).inserted { queue.append(next) }
        }
        return visited
    }

    func bounds(for blockIDs: Set<String>, padding: CGFloat = 28) -> CGRect? {
        let frames = blockIDs.compactMap { layout.positions[$0].map { CGRect(origin: $0, size: cardSize) } }
        guard let first = frames.first else { return nil }
        return frames.dropFirst().reduce(first) { $0.union($1) }.insetBy(dx: -padding, dy: -padding)
    }

    private static func districtIndex(_ kind: String) -> Int {
        switch kind {
        case "principle", "requirement", "product": 0
        case "ui", "flow": 1
        case "service", "function": 2
        case "integration": 3
        case "data", "database": 4
        case "test", "checkpoint": 5
        case "risk": 6
        default: 7
        }
    }

    private static func architectureIndex(_ layer: String) -> Int {
        ["client", "boundary", "application", "domain", "data", "external", "quality", "infrastructure", "unspecified"].firstIndex(of: layer) ?? 8
    }
}

struct ChainEnvelopeGeometry: Equatable {
    let nodeFrames: [CGRect]
    let routes: [[CGPoint]]
    let corridorFrames: [CGRect]
    let contours: [[CGPoint]]
    let expansion: CGFloat

    func intersectsUnrelatedBlock(_ frame: CGRect) -> Bool {
        corridorFrames.contains { $0.intersects(frame) }
    }

    func contains(_ point: CGPoint) -> Bool {
        let intersections = contours.reduce(0) { count, contour in
            count + (polygonContains(point, contour) ? 1 : 0)
        }
        return intersections % 2 == 1
    }

    private func polygonContains(_ point: CGPoint, _ polygon: [CGPoint]) -> Bool {
        guard polygon.count > 2 else { return false }
        var inside = false
        var previous = polygon.last!
        for current in polygon {
            if (current.y > point.y) != (previous.y > point.y) {
                let crossing = (previous.x - current.x) * (point.y - current.y) / (previous.y - current.y) + current.x
                if point.x < crossing { inside.toggle() }
            }
            previous = current
        }
        return inside
    }
}

enum ChainEnvelopeEngine {
    static let baseExpansion: CGFloat = 10
    static let laneSpacing: CGFloat = 9

    private struct Edge: Hashable {
        let start: CGPoint
        let end: CGPoint
    }

    private struct PointKey: Hashable {
        let x: Double
        let y: Double

        init(_ point: CGPoint) {
            x = Double(point.x)
            y = Double(point.y)
        }
    }

    static func make(
        nodeIDs: [String], linkIDs: [String], layout: NetworkLayoutSnapshot,
        cardSize: CGSize, expansion: CGFloat
    ) -> ChainEnvelopeGeometry {
        let nodeFrames = nodeIDs.compactMap { layout.positions[$0].map { CGRect(origin: $0, size: cardSize).insetBy(dx: -expansion, dy: -expansion) } }
        let routes = linkIDs.compactMap { layout.routes[$0] }.filter { $0.count > 1 }
        // Expansion is the distance from the underlying route on each side,
        // matching the node-frame expansion. Every lane therefore keeps the
        // same visible gap around Blocks and along the streets between them.
        let halfWidth = 15 + expansion
        let corridors = routes.flatMap { route in
            zip(route, route.dropFirst()).map { start, end in
                if start.x == end.x {
                    return CGRect(x: start.x - halfWidth, y: min(start.y, end.y), width: halfWidth * 2, height: abs(end.y - start.y))
                }
                return CGRect(x: min(start.x, end.x), y: start.y - halfWidth, width: abs(end.x - start.x), height: halfWidth * 2)
            }
        }
        let contours = unionContours(rectangles: nodeFrames + corridors)
        return ChainEnvelopeGeometry(
            nodeFrames: nodeFrames, routes: routes, corridorFrames: corridors,
            contours: contours, expansion: expansion
        )
    }

    private static func unionContours(rectangles: [CGRect], allowCoarsening: Bool = true) -> [[CGPoint]] {
        let rectangles = rectangles.map(
            { $0.standardized }
        ).filter { !$0.isEmpty && !$0.isNull }
        guard !rectangles.isEmpty else { return [] }
        let xs = Array(Set(rectangles.flatMap { [$0.minX, $0.maxX] })).sorted()
        let ys = Array(Set(rectangles.flatMap { [$0.minY, $0.maxY] })).sorted()
        guard xs.count > 1, ys.count > 1 else { return [] }

        // A long Chain can expose thousands of route/card boundaries. Keep
        // overview contour work bounded without changing the exact corridor
        // frames used for collision checks. Small and medium Chains retain
        // their exact snake contour; only an extreme coordinate grid is
        // quantized to a deterministic 160×160 envelope grid.
        let maximumAxisCells: CGFloat = 160
        if allowCoarsening, xs.count > Int(maximumAxisCells) + 1 || ys.count > Int(maximumAxisCells) + 1 {
            let xRange = xs.last! - xs.first!
            let yRange = ys.last! - ys.first!
            let xStep = max(1, xRange / maximumAxisCells)
            let yStep = max(1, yRange / maximumAxisCells)
            func quantize(_ value: CGFloat, minimum: CGFloat, step: CGFloat, upper: CGFloat) -> CGFloat {
                min(upper, minimum + floor((value - minimum) / step) * step)
            }
            let coarse = rectangles.map { rectangle -> CGRect in
                let minX = quantize(rectangle.minX, minimum: xs.first!, step: xStep, upper: xs.last!)
                let minY = quantize(rectangle.minY, minimum: ys.first!, step: yStep, upper: ys.last!)
                let xCeiling = xs.first! + ceil((rectangle.maxX - xs.first!) / xStep) * xStep
                let yCeiling = ys.first! + ceil((rectangle.maxY - ys.first!) / yStep) * yStep
                let maxX = min(xs.last!, max(minX + xStep, xCeiling))
                let maxY = min(ys.last!, max(minY + yStep, yCeiling))
                let width = max(CGFloat(1), maxX - minX)
                let height = max(CGFloat(1), maxY - minY)
                return CGRect(x: minX, y: minY, width: width, height: height)
            }
            return unionContours(rectangles: coarse, allowCoarsening: false)
        }

        var occupied = Array(repeating: Array(repeating: false, count: ys.count - 1), count: xs.count - 1)
        for xIndex in 0..<(xs.count - 1) {
            for yIndex in 0..<(ys.count - 1) {
                let center = CGPoint(x: (xs[xIndex] + xs[xIndex + 1]) / 2, y: (ys[yIndex] + ys[yIndex + 1]) / 2)
                occupied[xIndex][yIndex] = rectangles.contains { $0.contains(center) }
            }
        }
        var edges = Set<Edge>()
        for xIndex in 0..<(xs.count - 1) {
            for yIndex in 0..<(ys.count - 1) where occupied[xIndex][yIndex] {
                let x0 = xs[xIndex], x1 = xs[xIndex + 1], y0 = ys[yIndex], y1 = ys[yIndex + 1]
                if yIndex == 0 || !occupied[xIndex][yIndex - 1] { edges.insert(Edge(start: CGPoint(x: x0, y: y0), end: CGPoint(x: x1, y: y0))) }
                if xIndex == xs.count - 2 || !occupied[xIndex + 1][yIndex] { edges.insert(Edge(start: CGPoint(x: x1, y: y0), end: CGPoint(x: x1, y: y1))) }
                if yIndex == ys.count - 2 || !occupied[xIndex][yIndex + 1] { edges.insert(Edge(start: CGPoint(x: x1, y: y1), end: CGPoint(x: x0, y: y1))) }
                if xIndex == 0 || !occupied[xIndex - 1][yIndex] { edges.insert(Edge(start: CGPoint(x: x0, y: y1), end: CGPoint(x: x0, y: y0))) }
            }
        }

        // Keep contour walking proportional to the number of boundary edges.
        // The previous implementation filtered the entire active edge set for
        // every next vertex. That is quadratic for a dense Chain envelope and
        // made a 300-Block overview spend unbounded memory/time before the
        // Canvas could present its first frame.
        let outgoing = Dictionary(grouping: edges, by: { PointKey($0.start) })
            .mapValues { $0.sorted(by: edgeOrder) }
        var contours: [[CGPoint]] = []
        while let first = edges.min(by: { edgeOrder($0, $1) }) {
            var contour = [first.start]
            var edge = first
            edges.remove(edge)
            var safety = edges.count + 2
            while edge.end != first.start && safety > 0 {
                contour.append(edge.end)
                guard let candidates = outgoing[PointKey(edge.end)],
                      let next = candidates.first(where: { edges.contains($0) }) else { break }
                edge = next
                edges.remove(next)
                safety -= 1
            }
            if edge.end == first.start, contour.count >= 4 {
                contours.append(removeCollinearPoints(contour))
            }
        }
        return contours.sorted { absoluteArea($0) > absoluteArea($1) }
    }

    private static func edgeOrder(_ left: Edge, _ right: Edge) -> Bool {
        if left.start.y != right.start.y { return left.start.y < right.start.y }
        if left.start.x != right.start.x { return left.start.x < right.start.x }
        if left.end.y != right.end.y { return left.end.y < right.end.y }
        return left.end.x < right.end.x
    }

    private static func removeCollinearPoints(_ points: [CGPoint]) -> [CGPoint] {
        guard points.count > 3 else { return points }
        return points.enumerated().compactMap { index, point in
            let previous = points[(index - 1 + points.count) % points.count]
            let next = points[(index + 1) % points.count]
            return (previous.x == point.x && point.x == next.x) || (previous.y == point.y && point.y == next.y) ? nil : point
        }
    }

    private static func absoluteArea(_ points: [CGPoint]) -> CGFloat {
        let closed = Array(points.dropFirst()) + [points[0]]
        return abs(zip(points, closed).reduce(CGFloat.zero) { result, pair in
            result + pair.0.x * pair.1.y - pair.1.x * pair.0.y
        }) / 2
    }
}

enum ChainEnvelopeLaneAllocator {
    /// Deterministic greedy coloring of the Chain-overlap graph. Chains that
    /// share any Block can never receive the same enclosure lane, while
    /// unrelated Chains may reuse a lane to keep the Canvas compact.
    static func make(chainNodes: [String: [String]]) -> [String: Int] {
        let nodeSets = chainNodes.mapValues(Set.init)
        let chainIDs = nodeSets.keys.sorted()
        let neighbors = Dictionary(uniqueKeysWithValues: chainIDs.map { chainID in
            let overlapping = chainIDs.filter {
                $0 != chainID && !nodeSets[chainID, default: []].isDisjoint(with: nodeSets[$0, default: []])
            }
            return (chainID, Set(overlapping))
        })
        let order = chainIDs.sorted {
            let leftDegree = neighbors[$0, default: []].count
            let rightDegree = neighbors[$1, default: []].count
            return leftDegree == rightDegree ? $0 < $1 : leftDegree > rightDegree
        }
        var result: [String: Int] = [:]
        for chainID in order {
            let unavailable = Set(neighbors[chainID, default: []].compactMap { result[$0] })
            result[chainID] = (0...).first { !unavailable.contains($0) } ?? 0
        }
        return result
    }
}
