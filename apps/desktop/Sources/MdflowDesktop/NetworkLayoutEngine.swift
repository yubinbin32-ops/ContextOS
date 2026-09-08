import Foundation

struct LayoutEdge: Equatable {
    let id: String
    let sourceID: String
    let targetID: String
}

struct LayoutNodeMetadata: Equatable {
    let layer: Int
    let scope: String
    let order: Int
}

struct LayoutBand: Equatable, Identifiable {
    let id: String
    let title: String
    let frame: CGRect
}

struct NetworkLayoutSnapshot: Equatable {
    let positions: [String: CGPoint]
    let routes: [String: [CGPoint]]
    let layerBands: [LayoutBand]
    let scopeBands: [LayoutBand]
    let size: CGSize
}

enum NetworkLayoutEngine {
    // Streets include room for Link lanes and nested Chain enclosures on both
    // neighboring Blocks. These values keep the current three-membership
    // project readable without turning the overview into a sparse wall.
    static let horizontalStreetWidth: CGFloat = 70
    static let verticalStreetWidth: CGFloat = 60

    /// Creates one stable project map. `focusPaths` contains every ordered Chain,
    /// not merely the selected one: Chain topology owns the primary roads.
    static func make(
        nodeIDs: [String],
        edges: [LayoutEdge],
        focusPaths: [[String]],
        districts: [String: Int] = [:],
        metadata: [String: LayoutNodeMetadata] = [:],
        cardSize: CGSize,
        topInset: CGFloat
    ) -> NetworkLayoutSnapshot {
        let nodes = Array(Set(nodeIDs)).sorted()
        guard !nodes.isEmpty else {
            return NetworkLayoutSnapshot(
                positions: [:], routes: [:], layerBands: [], scopeBands: [],
                size: CGSize(width: 900, height: 620)
            )
        }

        let visible = Set(nodes)
        let validEdges = edges.filter {
            visible.contains($0.sourceID) && visible.contains($0.targetID) && $0.sourceID != $0.targetID
        }
        let chains = focusPaths
            .map { $0.filter(visible.contains) }
            .filter { !$0.isEmpty }
            .sorted {
                if $0.count != $1.count { return $0.count > $1.count }
                return $0.joined(separator: "\u{0}") < $1.joined(separator: "\u{0}")
            }

        let cells = place(nodes: nodes, edges: validEdges, chains: chains, metadata: metadata, districts: districts)
        let minimumX = cells.values.map(\.x).min() ?? 0
        let minimumY = cells.values.map(\.y).min() ?? 0
        let xStep = cardSize.width + horizontalStreetWidth
        let yStep = cardSize.height + verticalStreetWidth
        let sideInset: CGFloat = 66
        let positions = cells.mapValues { cell in
            CGPoint(
                x: sideInset + CGFloat(cell.x - minimumX) * xStep,
                y: topInset + CGFloat(cell.y - minimumY) * yStep
            )
        }
        let frames = positions.mapValues { CGRect(origin: $0, size: cardSize) }
        let chainPriority = prioritizedEdges(edges: validEdges, chains: chains)
        let routes = route(edges: validEdges, frames: frames, cardSize: cardSize, priorities: chainPriority)
        let bounds = frames.values.reduce(CGRect.null) { $0.union($1) }

        return NetworkLayoutSnapshot(
            positions: positions,
            routes: routes,
            // Scope and architecture layer remain semantic metadata. They never
            // partition the Canvas or create empty spatial bands.
            layerBands: [],
            scopeBands: [],
            size: CGSize(width: max(900, bounds.maxX + sideInset), height: max(620, bounds.maxY + 70))
        )
    }

    static func orthogonalRoute(source: CGPoint, target: CGPoint, cardSize: CGSize, lane: CGFloat) -> [CGPoint] {
        let sourceFrame = CGRect(origin: source, size: cardSize)
        let targetFrame = CGRect(origin: target, size: cardSize)
        let horizontal = abs(targetFrame.midX - sourceFrame.midX) >= abs(targetFrame.midY - sourceFrame.midY)
        return directFirstRoute(source: sourceFrame, target: targetFrame, obstacles: [], used: [], lane: lane)
            ?? fallbackRoute(source: sourceFrame, target: targetFrame, horizontal: horizontal, sourceOffset: lane, targetOffset: lane)
    }

    static func routeLane(index: Int, count: Int, maximumSpread: CGFloat = 24) -> CGFloat {
        guard count > 1 else { return 0 }
        let step = min(5, maximumSpread * 2 / CGFloat(count - 1))
        return (CGFloat(index) - CGFloat(count - 1) / 2) * step
    }

    // MARK: - Chain-first grid placement

    private static func place(
        nodes: [String], edges: [LayoutEdge], chains: [[String]],
        metadata: [String: LayoutNodeMetadata], districts: [String: Int]
    ) -> [String: Cell] {
        var result: [String: Cell] = [:]
        var occupied: Set<Cell> = []
        let adjacency = undirectedAdjacency(nodes: nodes, edges: edges)

        func reserve(_ node: String, at cell: Cell) {
            result[node] = cell
            occupied.insert(cell)
        }

        func nextComponentOrigin() -> Cell {
            guard !occupied.isEmpty else { return Cell(x: 0, y: 0) }
            let minX = occupied.map(\.x).min() ?? 0
            let maxX = occupied.map(\.x).max() ?? 0
            let minY = occupied.map(\.y).min() ?? 0
            let maxY = occupied.map(\.y).max() ?? 0
            let width = maxX - minX
            let height = maxY - minY
            if height >= width {
                return Cell(x: maxX + 1, y: minY)
            } else {
                return Cell(x: minX, y: maxY + 1)
            }
        }

        func bestCell(for node: String, pathNeighbors: [String], preferred: Direction?) -> Cell {
            let anchors = pathNeighbors.compactMap { result[$0] }
            let graphAnchors = (adjacency[node] ?? []).compactMap { result[$0] }
            let origins: [Cell]
            if !anchors.isEmpty {
                origins = anchors
            } else if !graphAnchors.isEmpty {
                origins = graphAnchors
            } else if !occupied.isEmpty {
                let minX = occupied.map(\.x).min() ?? 0
                let maxX = occupied.map(\.x).max() ?? 0
                let minY = occupied.map(\.y).min() ?? 0
                let maxY = occupied.map(\.y).max() ?? 0
                origins = [Cell(x: (minX + maxX) / 2, y: (minY + maxY) / 2)]
            } else {
                origins = [nextComponentOrigin()]
            }
            var candidates = Set<Cell>()
            for origin in origins {
                for radius in 1...6 {
                    for dx in -radius...radius {
                        let dy = radius - abs(dx)
                        candidates.insert(Cell(x: origin.x + dx, y: origin.y + dy))
                        candidates.insert(Cell(x: origin.x + dx, y: origin.y - dy))
                    }
                }
            }
            candidates.subtract(occupied)
            if candidates.isEmpty { return nextComponentOrigin() }

            return candidates.min { lhs, rhs in
                let left = placementScore(lhs, anchors: anchors, graphAnchors: graphAnchors, occupied: occupied, preferred: preferred)
                let right = placementScore(rhs, anchors: anchors, graphAnchors: graphAnchors, occupied: occupied, preferred: preferred)
                if left != right { return left < right }
                if lhs.y != rhs.y { return lhs.y < rhs.y }
                return lhs.x < rhs.x
            }!
        }

        for (chainIndex, path) in chains.enumerated() {
            guard !path.isEmpty else { continue }
            if !path.contains(where: { result[$0] != nil }) {
                var cell = chainIndex == 0 ? Cell(x: 0, y: 0) : nextComponentOrigin()
                for (index, node) in path.enumerated() where result[node] == nil {
                    if index > 0 { cell = cell.moved(primaryDirection(at: index - 1)) }
                    if occupied.contains(cell) {
                        cell = bestCell(for: node, pathNeighbors: index > 0 ? [path[index - 1]] : [], preferred: nil)
                    }
                    reserve(node, at: cell)
                }
                continue
            }

            var remaining = Set(path.filter { result[$0] == nil })
            while !remaining.isEmpty {
                var changed = false
                for index in path.indices {
                    let node = path[index]
                    guard remaining.contains(node) else { continue }
                    let neighbors = [index > 0 ? path[index - 1] : nil, index + 1 < path.count ? path[index + 1] : nil]
                        .compactMap { $0 }
                        .filter { result[$0] != nil }
                    guard !neighbors.isEmpty else { continue }
                    let preferred = preferredDirection(for: index, in: path, positions: result)
                    reserve(node, at: bestCell(for: node, pathNeighbors: neighbors, preferred: preferred))
                    remaining.remove(node)
                    changed = true
                }
                if !changed {
                    let node = remaining.sorted().first!
                    reserve(node, at: bestCell(for: node, pathNeighbors: [], preferred: nil))
                    remaining.remove(node)
                }
            }
        }

        // Attach Blocks outside Chains to the nearest occupied architectural road.
        var remaining = Set(nodes.filter { result[$0] == nil })
        while !remaining.isEmpty {
            let attachable = remaining.sorted { lhs, rhs in
                let left = (adjacency[lhs] ?? []).filter { result[$0] != nil }.count
                let right = (adjacency[rhs] ?? []).filter { result[$0] != nil }.count
                if left != right { return left > right }
                let leftOrder = metadata[lhs]?.order ?? 0
                let rightOrder = metadata[rhs]?.order ?? 0
                if leftOrder != rightOrder { return leftOrder < rightOrder }
                let leftDistrict = districts[lhs, default: 0]
                let rightDistrict = districts[rhs, default: 0]
                return leftDistrict == rightDistrict ? lhs < rhs : leftDistrict < rightDistrict
            }.first!
            reserve(attachable, at: bestCell(for: attachable, pathNeighbors: [], preferred: nil))
            remaining.remove(attachable)
        }
        return result
    }

    private static func primaryDirection(at index: Int) -> Direction {
        // A compact boulevard with repeated right-angle turns keeps long Chains
        // from stretching across a single enormous row.
        let pattern: [Direction] = [.right, .right, .down, .down, .right, .right, .up, .up]
        return pattern[index % pattern.count]
    }

    private static func preferredDirection(for index: Int, in path: [String], positions: [String: Cell]) -> Direction? {
        if index >= 2, let a = positions[path[index - 2]], let b = positions[path[index - 1]],
           let dir = Direction(from: a, to: b) {
            if index >= 3, let prevPrev = positions[path[index - 3]],
               Direction(from: prevPrev, to: a) == dir {
                return (dir == .down || dir == .up) ? .right : .down
            }
            return dir
        }
        if index + 2 < path.count, let a = positions[path[index + 2]], let b = positions[path[index + 1]],
           let dir = Direction(from: a, to: b) {
            return dir
        }
        return nil
    }

    private static func placementScore(
        _ candidate: Cell, anchors: [Cell], graphAnchors: [Cell], occupied: Set<Cell>, preferred: Direction?
    ) -> Int {
        let chainDistance = anchors.reduce(0) { $0 + candidate.distance(to: $1) } * 120
        let graphDistance = graphAnchors.reduce(0) { $0 + candidate.distance(to: $1) } * 12
        let crowding = Direction.allCases.reduce(0) { $0 + (occupied.contains(candidate.moved($1)) ? 7 : 0) }
        let directionPenalty: Int
        if let preferred, let anchor = anchors.first {
            directionPenalty = candidate == anchor.moved(preferred) ? 0 : 9
        } else {
            directionPenalty = 0
        }
        let centerPull: Int
        if !occupied.isEmpty {
            let cx = occupied.map(\.x).reduce(0, +) / occupied.count
            let cy = occupied.map(\.y).reduce(0, +) / occupied.count
            centerPull = abs(candidate.x - cx) + abs(candidate.y - cy)
        } else {
            centerPull = abs(candidate.x) + abs(candidate.y)
        }
        return chainDistance + graphDistance + crowding + directionPenalty + centerPull
    }

    private static func undirectedAdjacency(nodes: [String], edges: [LayoutEdge]) -> [String: Set<String>] {
        var result = Dictionary(uniqueKeysWithValues: nodes.map { ($0, Set<String>()) })
        for edge in edges {
            result[edge.sourceID, default: []].insert(edge.targetID)
            result[edge.targetID, default: []].insert(edge.sourceID)
        }
        return result
    }

    private static func prioritizedEdges(edges: [LayoutEdge], chains: [[String]]) -> [String: Int] {
        var pairPriority: [Pair: Int] = [:]
        var order = 0
        for chain in chains {
            for (source, target) in zip(chain, chain.dropFirst()) {
                pairPriority[Pair(source, target)] = min(pairPriority[Pair(source, target)] ?? .max, order)
                order += 1
            }
        }
        return Dictionary(uniqueKeysWithValues: edges.compactMap { edge in
            pairPriority[Pair(edge.sourceID, edge.targetID)].map { (edge.id, $0) }
        })
    }

    // MARK: - Multi-turn orthogonal routing

    private static func route(
        edges: [LayoutEdge], frames: [String: CGRect], cardSize: CGSize, priorities: [String: Int]
    ) -> [String: [CGPoint]] {
        let outgoing = Dictionary(grouping: edges, by: \.sourceID).mapValues { $0.sorted { $0.id < $1.id } }
        let incoming = Dictionary(grouping: edges, by: \.targetID).mapValues { $0.sorted { $0.id < $1.id } }
        // A reciprocal Link pair is still two semantic relationships. Give all
        // Links between the same unordered Block pair deterministic parallel
        // lanes so opposite arrows can never collapse into a misleading
        // single double-headed street.
        let parallelLaneOffsets = Dictionary(
            uniqueKeysWithValues: Dictionary(grouping: edges, by: { UndirectedPair($0.sourceID, $0.targetID) })
                .values
                .flatMap { group -> [(String, CGFloat)] in
                    let ordered = group.sorted { $0.id < $1.id }
                    let center = CGFloat(ordered.count - 1) / 2
                    return ordered.enumerated().map { index, edge in
                        (edge.id, (CGFloat(index) - center) * 14)
                    }
                }
        )
        // Reserve enough space for both the Link road and the Chain enclosure
        // drawn around it, so neither can cover an unrelated Block.
        let obstacles = frames.values.map { $0.insetBy(dx: -20, dy: -20) }
        var used: [[CGPoint]] = []
        var result: [String: [CGPoint]] = [:]
        let orderedEdges = edges.sorted {
            let left = priorities[$0.id] ?? Int.max
            let right = priorities[$1.id] ?? Int.max
            return left == right ? $0.id < $1.id : left < right
        }
        // The obstacle grid is intentionally reserved for the interactive,
        // small-map case. Its state space grows with every building in the
        // corridor and its overlap scoring grows with every earlier road. On a
        // 300-Block overview that turns one layout refresh into an effectively
        // unbounded search. Large maps still get deterministic orthogonal roads
        // (and direct roads continue to avoid buildings), while avoiding a
        // frame-blocking all-pairs search. Detailed routing remains available
        // when the user focuses a smaller subgraph.
        let useBoundedRouting = frames.count <= 120 && edges.count <= 180

        for edge in orderedEdges {
            guard let source = frames[edge.sourceID], let target = frames[edge.targetID] else { continue }
            let horizontal = abs(target.midX - source.midX) >= abs(target.midY - source.midY)
            let sourceIndex = outgoing[edge.sourceID]?.firstIndex(of: edge) ?? 0
            let targetIndex = incoming[edge.targetID]?.firstIndex(of: edge) ?? 0
            let sourceOffset = portOffset(index: sourceIndex, count: outgoing[edge.sourceID]?.count ?? 1, span: horizontal ? cardSize.height : cardSize.width)
            let targetOffset = portOffset(index: targetIndex, count: incoming[edge.targetID]?.count ?? 1, span: horizontal ? cardSize.height : cardSize.width)
            let parallelOffset = parallelLaneOffsets[edge.id, default: 0]
            let separatedSourceOffset = sourceOffset + parallelOffset
            let separatedTargetOffset = targetOffset + parallelOffset
            let excluded = [source.insetBy(dx: -20, dy: -20), target.insetBy(dx: -20, dy: -20)]
            let activeObstacles = obstacles.filter { obstacle in !excluded.contains(where: { nearlyEqual($0, obstacle) }) }
            let lane = abs(separatedSourceOffset - separatedTargetOffset) < 0.1 ? separatedSourceOffset : 0
            let path: [CGPoint]
            if useBoundedRouting {
                path = directFirstRoute(
                    source: source, target: target, obstacles: activeObstacles, used: used, lane: lane
                ) ?? gridRoute(
                    source: source, target: target, horizontal: horizontal,
                    sourceOffset: separatedSourceOffset, targetOffset: separatedTargetOffset,
                    obstacles: activeObstacles, used: used
                ) ?? fallbackRoute(source: source, target: target, horizontal: horizontal, sourceOffset: separatedSourceOffset, targetOffset: separatedTargetOffset)
            } else {
                // On an overview, do not feed every previously routed road into
                // the scoring loop. This keeps route work linear in the number
                // of buildings and makes repeated canvas updates predictable.
                // A direct road is still preferred, but the bounded obstacle
                // grid is the safe fallback for crowded corridors. Falling
                // straight through the old unconstrained fallback can draw a
                // road across an unrelated Block on a large overview.
                path = directFirstRoute(
                    source: source, target: target, obstacles: activeObstacles, used: [], lane: lane
                ) ?? gridRoute(
                    source: source, target: target, horizontal: horizontal,
                    sourceOffset: separatedSourceOffset, targetOffset: separatedTargetOffset,
                    obstacles: activeObstacles, used: []
                ) ?? fallbackRoute(
                    source: source, target: target, horizontal: horizontal,
                    sourceOffset: separatedSourceOffset, targetOffset: separatedTargetOffset, obstacles: activeObstacles
                )
            }
            let clean = compact(path)
            result[edge.id] = clean
            used.append(clean)
        }
        return result
    }

    /// Prefer the visually simplest valid road before invoking the obstacle grid.
    /// Candidates are scored by bends, shared-lane overlap, then distance.
    private static func directFirstRoute(
        source: CGRect, target: CGRect, obstacles: [CGRect], used: [[CGPoint]], lane: CGFloat
    ) -> [CGPoint]? {
        let dx = target.midX - source.midX
        let dy = target.midY - source.midY
        let horizontalStart = CGPoint(x: dx >= 0 ? source.maxX : source.minX, y: source.midY + lane)
        let horizontalEnd = CGPoint(x: dx >= 0 ? target.minX : target.maxX, y: target.midY + lane)
        let verticalStart = CGPoint(x: source.midX + lane, y: dy >= 0 ? source.maxY : source.minY)
        let verticalEnd = CGPoint(x: target.midX + lane, y: dy >= 0 ? target.minY : target.maxY)

        var candidates: [[CGPoint]] = []
        if abs(horizontalStart.y - horizontalEnd.y) < 0.5 {
            candidates.append([horizontalStart, horizontalEnd])
        }
        if abs(verticalStart.x - verticalEnd.x) < 0.5 {
            candidates.append([verticalStart, verticalEnd])
        }
        candidates.append([horizontalStart, CGPoint(x: horizontalEnd.x, y: horizontalStart.y), horizontalEnd])
        candidates.append([verticalStart, CGPoint(x: verticalStart.x, y: verticalEnd.y), verticalEnd])
        let middleX = (horizontalStart.x + horizontalEnd.x) / 2
        candidates.append([horizontalStart, CGPoint(x: middleX, y: horizontalStart.y), CGPoint(x: middleX, y: horizontalEnd.y), horizontalEnd])
        let middleY = (verticalStart.y + verticalEnd.y) / 2
        candidates.append([verticalStart, CGPoint(x: verticalStart.x, y: middleY), CGPoint(x: verticalEnd.x, y: middleY), verticalEnd])

        return candidates.map(compact).filter { points in
            zip(points, points.dropFirst()).allSatisfy { segmentIsClear($0, $1, obstacles: obstacles) }
        }.min { left, right in
            routeScore(left, used: used) < routeScore(right, used: used)
        }
    }

    private static func routeScore(_ points: [CGPoint], used: [[CGPoint]]) -> CGFloat {
        let bends = max(0, points.count - 2)
        let overlap = zip(points, points.dropFirst()).reduce(0) { total, pair in
            total + used.reduce(0) { $0 + segmentOverlap(pair.0, pair.1, path: $1) }
        }
        let length = zip(points, points.dropFirst()).reduce(CGFloat.zero) { total, pair in
            total + abs(pair.1.x - pair.0.x) + abs(pair.1.y - pair.0.y)
        }
        return CGFloat(bends) * 10_000 + CGFloat(overlap) * 1_000 + length
    }

    private static func gridRoute(
        source: CGRect, target: CGRect, horizontal: Bool, sourceOffset: CGFloat, targetOffset: CGFloat,
        obstacles: [CGRect], used: [[CGPoint]]
    ) -> [CGPoint]? {
        let clearance: CGFloat = 18
        let endpoints = routeEndpoints(source: source, target: target, horizontal: horizontal, sourceOffset: sourceOffset, targetOffset: targetOffset, clearance: clearance)
        let start = endpoints.start
        let escape = endpoints.escape
        let approach = endpoints.approach
        let end = endpoints.end

        let corridor = source.union(target).insetBy(dx: -72, dy: -72)
        let routingObstacles = obstacles.filter { $0.intersects(corridor) }
        var xs = [escape.x, approach.x, corridor.minX, corridor.maxX]
        var ys = [escape.y, approach.y, corridor.minY, corridor.maxY]
        for obstacle in routingObstacles {
            xs.append(contentsOf: [obstacle.minX - clearance, obstacle.maxX + clearance])
            ys.append(contentsOf: [obstacle.minY - clearance, obstacle.maxY + clearance])
        }
        xs = uniqueSorted(xs)
        ys = uniqueSorted(ys)

        let escapeKey = RoutePoint(escape)
        let approachKey = RoutePoint(approach)
        let points = xs.flatMap { x in ys.map { RoutePoint(x: x, y: $0) } }
            .filter { point in !obstacles.contains(where: { $0.containsStrictly(point.cgPoint) }) }
        let pointSet = Set(points)
        guard pointSet.contains(escapeKey), pointSet.contains(approachKey) else { return nil }

        var neighbors: [RoutePoint: [RoutePoint]] = [:]
        for y in ys {
            let row = xs.map { RoutePoint(x: $0, y: y) }.filter(pointSet.contains)
            for pair in zip(row, row.dropFirst()) where segmentIsClear(pair.0.cgPoint, pair.1.cgPoint, obstacles: obstacles) {
                neighbors[pair.0, default: []].append(pair.1)
                neighbors[pair.1, default: []].append(pair.0)
            }
        }
        for x in xs {
            let column = ys.map { RoutePoint(x: x, y: $0) }.filter(pointSet.contains)
            for pair in zip(column, column.dropFirst()) where segmentIsClear(pair.0.cgPoint, pair.1.cgPoint, obstacles: obstacles) {
                neighbors[pair.0, default: []].append(pair.1)
                neighbors[pair.1, default: []].append(pair.0)
            }
        }

        let initial = RouteState(point: escapeKey, direction: nil)
        var frontier = QueueHeap()
        frontier.insert(QueueEntry(cost: 0, state: initial))
        var costs: [RouteState: CGFloat] = [initial: 0]
        var previous: [RouteState: RouteState] = [:]
        var destination: RouteState?

        while let current = frontier.popMinimum() {
            guard current.cost <= costs[current.state, default: .greatestFiniteMagnitude] else { continue }
            if current.state.point == approachKey { destination = current.state; break }
            for nextPoint in (neighbors[current.state.point] ?? []).sorted(by: pointOrder) {
                let axis: Axis = nextPoint.x == current.state.point.x ? .vertical : .horizontal
                let distance = abs(nextPoint.x - current.state.point.x) + abs(nextPoint.y - current.state.point.y)
                let turnCost: CGFloat = current.state.direction == nil || current.state.direction == axis ? 0 : 16
                let overlapCost = CGFloat(used.reduce(0) { $0 + segmentOverlap(current.state.point.cgPoint, nextPoint.cgPoint, path: $1) }) * 36
                let next = RouteState(point: nextPoint, direction: axis)
                let newCost = current.cost + distance + turnCost + overlapCost
                if newCost < costs[next, default: .greatestFiniteMagnitude] {
                    costs[next] = newCost
                    previous[next] = current.state
                    frontier.insert(QueueEntry(cost: newCost, state: next))
                }
            }
        }
        guard var cursor = destination else { return nil }
        var middle = [cursor.point.cgPoint]
        while let parent = previous[cursor] {
            cursor = parent
            middle.append(cursor.point.cgPoint)
        }
        return compact([start] + middle.reversed() + [end])
    }

    private static func routeEndpoints(
        source: CGRect, target: CGRect, horizontal: Bool, sourceOffset: CGFloat, targetOffset: CGFloat, clearance: CGFloat
    ) -> (start: CGPoint, escape: CGPoint, approach: CGPoint, end: CGPoint) {
        if horizontal {
            let forward = target.midX >= source.midX
            let start = CGPoint(x: forward ? source.maxX : source.minX, y: source.midY + sourceOffset)
            let end = CGPoint(x: forward ? target.minX : target.maxX, y: target.midY + targetOffset)
            return (start, CGPoint(x: start.x + (forward ? clearance : -clearance), y: start.y), CGPoint(x: end.x + (forward ? -clearance : clearance), y: end.y), end)
        }
        let downward = target.midY >= source.midY
        let start = CGPoint(x: source.midX + sourceOffset, y: downward ? source.maxY : source.minY)
        let end = CGPoint(x: target.midX + targetOffset, y: downward ? target.minY : target.maxY)
        return (start, CGPoint(x: start.x, y: start.y + (downward ? clearance : -clearance)), CGPoint(x: end.x, y: end.y + (downward ? -clearance : clearance)), end)
    }

    private static func fallbackRoute(
        source: CGRect, target: CGRect, horizontal: Bool, sourceOffset: CGFloat, targetOffset: CGFloat,
        obstacles: [CGRect] = []
    ) -> [CGPoint] {
        let points = routeEndpoints(source: source, target: target, horizontal: horizontal, sourceOffset: sourceOffset, targetOffset: targetOffset, clearance: 18)
        let direct: [CGPoint]
        if horizontal {
            let trackY = (points.escape.y + points.approach.y) / 2
            direct = compact([points.start, points.escape, CGPoint(x: points.escape.x, y: trackY), CGPoint(x: points.approach.x, y: trackY), points.approach, points.end])
        } else {
            let trackX = (points.escape.x + points.approach.x) / 2
            direct = compact([points.start, points.escape, CGPoint(x: trackX, y: points.escape.y), CGPoint(x: trackX, y: points.approach.y), points.approach, points.end])
        }
        guard !obstacles.isEmpty else { return direct }
        let isClear: ([CGPoint]) -> Bool = { candidate in
            zip(candidate, candidate.dropFirst()).allSatisfy { segmentIsClear($0, $1, obstacles: obstacles) }
        }
        if isClear(direct) { return direct }

        // Try deterministic tracks outside the obstacle envelope before giving
        // up. The bounded grid normally resolves this case; these candidates
        // keep the final fallback honest if the grid has no finite route.
        let clearance: CGFloat = 36
        if horizontal {
            let tracks = uniqueSorted([
                (points.escape.y + points.approach.y) / 2,
                obstacles.map(\.minY).min()! - clearance,
                obstacles.map(\.maxY).max()! + clearance
            ])
            for trackY in tracks {
                let candidate = compact([points.start, points.escape, CGPoint(x: points.escape.x, y: trackY), CGPoint(x: points.approach.x, y: trackY), points.approach, points.end])
                if isClear(candidate) { return candidate }
            }
        } else {
            let tracks = uniqueSorted([
                (points.escape.x + points.approach.x) / 2,
                obstacles.map(\.minX).min()! - clearance,
                obstacles.map(\.maxX).max()! + clearance
            ])
            for trackX in tracks {
                let candidate = compact([points.start, points.escape, CGPoint(x: trackX, y: points.escape.y), CGPoint(x: trackX, y: points.approach.y), points.approach, points.end])
                if isClear(candidate) { return candidate }
            }
        }
        return direct
    }

    private static func portOffset(index: Int, count: Int, span: CGFloat) -> CGFloat {
        guard count > 1 else { return 0 }
        let step = min(13, max(4, (span - 34) / CGFloat(count - 1)))
        return (CGFloat(index) - CGFloat(count - 1) / 2) * step
    }

    private static func segmentIsClear(_ start: CGPoint, _ end: CGPoint, obstacles: [CGRect]) -> Bool {
        obstacles.allSatisfy { !segment(start, end, crosses: $0) }
    }

    private static func segmentOverlap(_ start: CGPoint, _ end: CGPoint, path: [CGPoint]) -> Int {
        let candidate = Segment(start, end)
        return zip(path, path.dropFirst()).contains { Segment($0, $1).overlaps(candidate) } ? 1 : 0
    }

    private static func segment(_ start: CGPoint, _ end: CGPoint, crosses rect: CGRect) -> Bool {
        if start.x == end.x {
            return start.x > rect.minX && start.x < rect.maxX && max(start.y, end.y) > rect.minY && min(start.y, end.y) < rect.maxY
        }
        if start.y == end.y {
            return start.y > rect.minY && start.y < rect.maxY && max(start.x, end.x) > rect.minX && min(start.x, end.x) < rect.maxX
        }
        return true
    }

    private static func nearlyEqual(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
        abs(lhs.minX - rhs.minX) < 0.1 && abs(lhs.minY - rhs.minY) < 0.1 && abs(lhs.width - rhs.width) < 0.1 && abs(lhs.height - rhs.height) < 0.1
    }

    private static func uniqueSorted(_ values: [CGFloat]) -> [CGFloat] {
        Array(Set(values.map { ($0 * 10).rounded() / 10 })).sorted()
    }

    private static func pointOrder(_ lhs: RoutePoint, _ rhs: RoutePoint) -> Bool {
        lhs.y == rhs.y ? lhs.x < rhs.x : lhs.y < rhs.y
    }

    private static func compact(_ points: [CGPoint]) -> [CGPoint] {
        var result: [CGPoint] = []
        for point in points {
            if result.last == point { continue }
            if result.count >= 2 {
                let a = result[result.count - 2]
                let b = result[result.count - 1]
                if (a.x == b.x && b.x == point.x) || (a.y == b.y && b.y == point.y) {
                    result[result.count - 1] = point
                    continue
                }
            }
            result.append(point)
        }
        return result
    }

    private enum Axis: Hashable { case horizontal, vertical }

    private struct RouteState: Hashable {
        let point: RoutePoint
        let direction: Axis?
    }

    private struct RoutePoint: Hashable {
        let x: CGFloat
        let y: CGFloat
        init(x: CGFloat, y: CGFloat) { self.x = x; self.y = y }
        init(_ point: CGPoint) { x = point.x; y = point.y }
        var cgPoint: CGPoint { CGPoint(x: x, y: y) }
    }

    private struct QueueEntry {
        let cost: CGFloat
        let state: RouteState
    }

    private struct QueueHeap {
        private var elements: [QueueEntry] = []

        mutating func insert(_ entry: QueueEntry) {
            elements.append(entry)
            var child = elements.count - 1
            while child > 0 {
                let parent = (child - 1) / 2
                guard precedes(elements[child], elements[parent]) else { break }
                elements.swapAt(child, parent)
                child = parent
            }
        }

        mutating func popMinimum() -> QueueEntry? {
            guard !elements.isEmpty else { return nil }
            if elements.count == 1 { return elements.removeLast() }
            let result = elements[0]
            elements[0] = elements.removeLast()
            var parent = 0
            while true {
                let left = parent * 2 + 1
                let right = left + 1
                guard left < elements.count else { break }
                var child = left
                if right < elements.count, precedes(elements[right], elements[left]) { child = right }
                guard precedes(elements[child], elements[parent]) else { break }
                elements.swapAt(child, parent)
                parent = child
            }
            return result
        }

        private func precedes(_ lhs: QueueEntry, _ rhs: QueueEntry) -> Bool {
            if lhs.cost != rhs.cost { return lhs.cost < rhs.cost }
            if lhs.state.point.y != rhs.state.point.y { return lhs.state.point.y < rhs.state.point.y }
            if lhs.state.point.x != rhs.state.point.x { return lhs.state.point.x < rhs.state.point.x }
            return String(describing: lhs.state.direction) < String(describing: rhs.state.direction)
        }
    }

    private struct Cell: Hashable {
        let x: Int
        let y: Int
        func moved(_ direction: Direction) -> Cell { Cell(x: x + direction.dx, y: y + direction.dy) }
        func distance(to other: Cell) -> Int { abs(x - other.x) + abs(y - other.y) }
    }

    private enum Direction: CaseIterable {
        case up, right, down, left
        var dx: Int { self == .right ? 1 : self == .left ? -1 : 0 }
        var dy: Int { self == .down ? 1 : self == .up ? -1 : 0 }
        init?(from source: Cell, to target: Cell) {
            let dx = target.x - source.x
            let dy = target.y - source.y
            guard abs(dx) + abs(dy) == 1 else { return nil }
            if dx == 1 { self = .right } else if dx == -1 { self = .left } else if dy == 1 { self = .down } else { self = .up }
        }
    }

    private struct Pair: Hashable {
        let first: String
        let second: String
        init(_ first: String, _ second: String) { self.first = first; self.second = second }
    }

    private struct UndirectedPair: Hashable {
        let first: String
        let second: String

        init(_ left: String, _ right: String) {
            if left <= right {
                first = left
                second = right
            } else {
                first = right
                second = left
            }
        }
    }

    private struct Segment: Hashable {
        let start: CGPoint
        let end: CGPoint
        init(_ start: CGPoint, _ end: CGPoint) {
            if start.x < end.x || (start.x == end.x && start.y <= end.y) { self.start = start; self.end = end }
            else { self.start = end; self.end = start }
        }

        func hash(into hasher: inout Hasher) {
            hasher.combine(start.x)
            hasher.combine(start.y)
            hasher.combine(end.x)
            hasher.combine(end.y)
        }

        static func == (lhs: Segment, rhs: Segment) -> Bool {
            lhs.start == rhs.start && lhs.end == rhs.end
        }

        func overlaps(_ other: Segment) -> Bool {
            if start.x == end.x, other.start.x == other.end.x, start.x == other.start.x {
                return max(start.y, other.start.y) < min(end.y, other.end.y)
            }
            if start.y == end.y, other.start.y == other.end.y, start.y == other.start.y {
                return max(start.x, other.start.x) < min(end.x, other.end.x)
            }
            return false
        }
    }
}

private extension CGRect {
    func containsStrictly(_ point: CGPoint) -> Bool {
        point.x > minX && point.x < maxX && point.y > minY && point.y < maxY
    }
}
