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

        let cells = place(
            nodes: nodes,
            edges: validEdges,
            chains: chains,
            metadata: metadata,
            districts: districts,
            cardSize: cardSize
        )
        let minimumX = cells.values.map(\.x).min() ?? 0
        let minimumY = cells.values.map(\.y).min() ?? 0
        let xStep = cardSize.width + 80
        let yStep = cardSize.height + 90
        let sideInset: CGFloat = 120
        let effectiveTopInset: CGFloat = 120
        let positions = cells.mapValues { cell in
            CGPoint(
                x: sideInset + CGFloat(cell.x - minimumX) * xStep,
                y: effectiveTopInset + CGFloat(cell.y - minimumY) * yStep
            )
        }
        let frames = positions.mapValues { CGRect(origin: $0, size: cardSize) }
        let chainPriority = prioritizedEdges(edges: validEdges, chains: chains)
        let routes = route(edges: validEdges, frames: frames, cardSize: cardSize, priorities: chainPriority)
        let bounds = frames.values.reduce(CGRect.null) { $0.union($1) }

        return NetworkLayoutSnapshot(
            positions: positions,
            routes: routes,
            layerBands: [],
            scopeBands: [],
            size: CGSize(width: max(1200, bounds.maxX + sideInset + 60), height: max(800, bounds.maxY + effectiveTopInset + 60))
        )
    }

    static func orthogonalRoute(source: CGPoint, target: CGPoint, cardSize: CGSize, lane: CGFloat) -> [CGPoint] {
        let sourceFrame = CGRect(origin: source, size: cardSize)
        let targetFrame = CGRect(origin: target, size: cardSize)
        let horizontal = abs(targetFrame.midX - sourceFrame.midX) >= abs(targetFrame.midY - sourceFrame.midY)
        return directFirstRoute(source: sourceFrame, target: targetFrame, obstacles: [], used: [], lane: lane)
            ?? fallbackRoute(source: sourceFrame, target: targetFrame, horizontal: horizontal, sourceOffset: lane, targetOffset: lane)
    }
    // MARK: - Chain-aware Square Shelf Placement

    private struct PlacementSegment {
        let id: String
        let memberIds: [String]
        let anchorIds: [String]
        let insertAfterAnchorID: String?
    }

    private struct ShelfCandidate {
        let columns: Int
        let rows: [[String]]
        let score: Double
    }

    private static func place(
        nodes: [String], edges: [LayoutEdge], chains: [[String]],
        metadata: [String: LayoutNodeMetadata], districts: [String: Int], cardSize: CGSize
    ) -> [String: Cell] {
        let sortedNodes = nodes.sorted()
        guard !sortedNodes.isEmpty else { return [:] }

        let nodeSet = Set(sortedNodes)
        var edgeNeighbors: [String: Set<String>] = [:]
        for edge in edges {
            edgeNeighbors[edge.sourceID, default: []].insert(edge.targetID)
            edgeNeighbors[edge.targetID, default: []].insert(edge.sourceID)
        }
        let xStep = max(1, cardSize.width + 80)
        let yStep = max(1, cardSize.height + 90)
        var ownedBlocks: Set<String> = []
        var segments: [PlacementSegment] = []

        for path in chains {
            var seen: Set<String> = []
            let members = path.filter { nodeSet.contains($0) && seen.insert($0).inserted }
            let unownedIndices = members.indices.filter { !ownedBlocks.contains(members[$0]) }
            guard !unownedIndices.isEmpty else { continue }

            // Keep each unowned run attached to its nearest owned Chain
            // neighbours instead of treating a shared-chain suffix as a new
            // standalone Block.
            var run: [Int] = []
            func flushRun() {
                guard let first = run.first, let last = run.last else { return }
                let previous = members[..<first].last { ownedBlocks.contains($0) }
                let next = members[(last + 1)...].first { ownedBlocks.contains($0) }
                let anchors = [previous, next].compactMap { $0 }
                segments.append(
                    PlacementSegment(
                        id: "chain:\(members.joined(separator: "\u{0}")):\(first)",
                        memberIds: run.map { members[$0] },
                        anchorIds: anchors,
                        insertAfterAnchorID: previous
                    )
                )
                run = []
            }

            for index in members.indices {
                if ownedBlocks.contains(members[index]) {
                    flushRun()
                } else {
                    run.append(index)
                }
            }
            flushRun()
            for index in unownedIndices { ownedBlocks.insert(members[index]) }
        }

        let chainOwnedBlocks = ownedBlocks
        for node in sortedNodes where !ownedBlocks.contains(node) {
            let anchors = edgeNeighbors[node, default: []]
                .filter { chainOwnedBlocks.contains($0) }
                .sorted()
            segments.append(
                PlacementSegment(
                    id: "block:\(node)",
                    memberIds: [node],
                    anchorIds: anchors,
                    insertAfterAnchorID: anchors.first
                )
            )
            ownedBlocks.insert(node)
        }

        func chooseShelf() -> ShelfCandidate {
            var best: ShelfCandidate?

            for columns in 1...sortedNodes.count {
                var chunks: [PlacementSegment] = []
                var splitCount = 0

                for segment in segments {
                    let count = segment.memberIds.count
                    if count > columns { splitCount += (count - 1) / columns }
                    var start = 0
                    while start < count {
                        let end = min(start + columns, count)
                        chunks.append(
                            PlacementSegment(
                                id: "\(segment.id):\(start / columns)",
                                memberIds: Array(segment.memberIds[start..<end]),
                                anchorIds: [],
                                insertAfterAnchorID: nil
                            )
                        )
                        start += columns
                    }
                }

                chunks.sort {
                    if $0.memberIds.count != $1.memberIds.count {
                        return $0.memberIds.count > $1.memberIds.count
                    }
                    return $0.id < $1.id
                }

                var rows: [[String]] = []
                for chunk in chunks {
                    var target: Int?
                    for rowIndex in rows.indices {
                        guard rows[rowIndex].count + chunk.memberIds.count <= columns else { continue }
                        if target == nil || rows[rowIndex].count < rows[target!].count {
                            target = rowIndex
                        }
                    }
                    if let target {
                        rows[target].append(contentsOf: chunk.memberIds)
                    } else {
                        rows.append(chunk.memberIds)
                    }
                }

                let rowWidths = rows.map(\.count)
                let maxWidth = rowWidths.max() ?? 0
                let minWidth = rowWidths.min() ?? 0
                let pixelWidth = CGFloat(maxWidth - 1) * xStep + cardSize.width + 240
                let pixelHeight = CGFloat(rows.count - 1) * yStep + cardSize.height + 240
                let squareness = abs(log(Double(pixelWidth / pixelHeight)))
                let fill = Double(sortedNodes.count) / Double(columns * rows.count)
                let balance = Double(maxWidth - minWidth) / Double(columns)
                let score = squareness + Double(splitCount) * 0.16 + (1 - fill) * 0.18 + balance * 0.08
                let candidate = ShelfCandidate(columns: columns, rows: rows, score: score)

                if let current = best {
                    if candidate.score < current.score - 1e-9 ||
                        (abs(candidate.score - current.score) <= 1e-9 && candidate.columns > current.columns) {
                        best = candidate
                    }
                } else {
                    best = candidate
                }
            }

            return best!
        }

        let shelf = chooseShelf()
        var rows = shelf.rows
        // Shelf packing owns density; this pass restores local topology by
        // inserting anchored runs beside their already placed neighbours.
        let anchoredSegments = segments.filter { !$0.anchorIds.isEmpty }
        let anchoredIDs = Set(anchoredSegments.flatMap(\.memberIds))
        if !anchoredIDs.isEmpty {
            rows = rows
                .map { $0.filter { !anchoredIDs.contains($0) } }
                .filter { !$0.isEmpty }

            for segment in anchoredSegments {
                let anchorCells = segment.anchorIds.compactMap { anchorID -> (row: Int, column: Int)? in
                    for (rowIndex, row) in rows.enumerated() {
                        if let column = row.firstIndex(of: anchorID) {
                            return (rowIndex, column)
                        }
                    }
                    return nil
                }
                guard !anchorCells.isEmpty else {
                    rows.append(segment.memberIds)
                    continue
                }

                var anchorRowCounts: [Int: Int] = [:]
                for cell in anchorCells { anchorRowCounts[cell.row, default: 0] += 1 }
                let targetRow = anchorRowCounts.keys.sorted {
                    if anchorRowCounts[$0] != anchorRowCounts[$1] {
                        return anchorRowCounts[$0, default: 0] > anchorRowCounts[$1, default: 0]
                    }
                    return $0 < $1
                }.first!
                let targetColumns = anchorCells.filter { $0.row == targetRow }.map(\.column)
                let insertionIndex: Int
                if let insertAfterAnchorID = segment.insertAfterAnchorID,
                   let rowIndex = rows.indices.first(where: { rows[$0].contains(insertAfterAnchorID) }),
                   let anchorIndex = rows[rowIndex].firstIndex(of: insertAfterAnchorID) {
                    insertionIndex = min(rows[rowIndex].count, anchorIndex + 1)
                } else {
                    insertionIndex = min(rows[targetRow].count, targetColumns.min() ?? rows[targetRow].count)
                }
                rows[targetRow].insert(contentsOf: segment.memberIds, at: insertionIndex)
            }
        }

        var result: [String: Cell] = [:]
        for (rowIndex, row) in rows.enumerated() {
            for (columnIndex, node) in row.enumerated() {
                result[node] = Cell(x: columnIndex, y: rowIndex)
            }
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
        // Reserve enough space for both the Link road and the base Chain
        // enclosure drawn around it. The envelope half-width is 25pt before
        // additional lane expansion, so a 20pt obstacle boundary was too small.
        let routingObstacleInset: CGFloat = 32
        let obstacles = frames.values.map { $0.insetBy(dx: -routingObstacleInset, dy: -routingObstacleInset) }
        var used: [[CGPoint]] = []
        var result: [String: [CGPoint]] = [:]
        let orderedEdges = edges.sorted {
            let left = priorities[$0.id] ?? Int.max
            let right = priorities[$1.id] ?? Int.max
            return left == right ? $0.id < $1.id : left < right
        }
        // Detailed obstacle-grid routing is only worth its state-space cost for
        // small focused graphs. Overview updates stay on the linear candidate
        // router so checkbox toggles do not trigger an A* search per Link.
        let useBoundedRouting = frames.count <= 32 && edges.count <= 64

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
            let excluded = [
                source.insetBy(dx: -routingObstacleInset, dy: -routingObstacleInset),
                target.insetBy(dx: -routingObstacleInset, dy: -routingObstacleInset)
            ]
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
                // Overview routing stays deterministic and linear: first try a
                // direct obstacle-clearing candidate, then use the bounded
                // fallback tracks instead of expanding a grid search.
                path = directFirstRoute(
                    source: source, target: target, obstacles: activeObstacles, used: [], lane: lane
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

        func connectAdjacent(_ points: [RoutePoint]) {
            for pair in zip(points, points.dropFirst())
            where segmentIsClear(pair.0.cgPoint, pair.1.cgPoint, obstacles: obstacles) {
                neighbors[pair.0, default: []].append(pair.1)
                neighbors[pair.1, default: []].append(pair.0)
            }
        }

        for y in ys {
            connectAdjacent(xs.map { RoutePoint(x: $0, y: y) }.filter(pointSet.contains))
        }
        for x in xs {
            connectAdjacent(ys.map { RoutePoint(x: x, y: $0) }.filter(pointSet.contains))
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
