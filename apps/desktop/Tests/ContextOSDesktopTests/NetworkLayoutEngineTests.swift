import XCTest
@testable import ContextOSDesktop

final class NetworkLayoutEngineTests: XCTestCase {
    func testShelfLayoutIsSquareDistributedAndDeterministic() {
        let nodes = (1...59).map { String(format: "b%02d", $0) }
        let lengths = [9, 8, 7, 6, 5, 4, 3, 3, 3, 2, 2, 2, 1]
        var cursor = 0
        let chains = lengths.map { length -> [String] in
            let chain = Array(nodes[cursor..<cursor + length])
            cursor += length
            return chain
        }
        let edges = (1..<nodes.count).map { index in
            LayoutEdge(id: "l\(index)", sourceID: nodes[index - 1], targetID: nodes[index])
        }

        let layout = NetworkLayoutEngine.make(
            nodeIDs: nodes,
            edges: edges,
            focusPaths: chains,
            cardSize: CGSize(width: 220, height: 100),
            topInset: 0
        )

        XCTAssertEqual(layout.positions.count, nodes.count)
        XCTAssertGreaterThan(Set(layout.positions.values.map { "\($0.x),\($0.y)" }).count, 1)
        XCTAssertGreaterThan(Set(layout.positions.values.map(\.x)).count, 1)
        XCTAssertGreaterThan(Set(layout.positions.values.map(\.y)).count, 1)

        let aspect = layout.size.width / layout.size.height
        XCTAssertGreaterThan(aspect, 0.72)
        XCTAssertLessThan(aspect, 1.4)
        XCTAssertLessThan(layout.size.height, layout.size.width * 1.6)

        let second = NetworkLayoutEngine.make(
            nodeIDs: nodes,
            edges: edges,
            focusPaths: chains,
            cardSize: CGSize(width: 220, height: 100),
            topInset: 0
        )
        XCTAssertEqual(layout.positions, second.positions)
    }

    func testSharedChainSuffixStaysNearOwnedAnchors() {
        let primary = (0..<7).map { "anchor-\($0)" }
        let detached = "detached"
        let filler = (0..<40).map { String(format: "f%02d", $0) }
        let nodes = primary + [detached] + filler
        let chains = [
            primary,
            [primary[1], primary[2], detached]
        ]
        let edges = zip(primary, primary.dropFirst()).enumerated().map { index, pair in
            LayoutEdge(id: "primary-\(index)", sourceID: pair.0, targetID: pair.1)
        }

        let layout = NetworkLayoutEngine.make(
            nodeIDs: nodes,
            edges: edges,
            focusPaths: chains,
            cardSize: CGSize(width: 220, height: 100),
            topInset: 0
        )

        guard let detachedPosition = layout.positions[detached],
              let anchorPosition = layout.positions[primary[2]] else {
            return XCTFail("missing detached or anchor position")
        }
        let columnDistance = abs(detachedPosition.x - anchorPosition.x) / 300
        let rowDistance = abs(detachedPosition.y - anchorPosition.y) / 190
        XCTAssertLessThanOrEqual(columnDistance + rowDistance, 2)
        XCTAssertEqual(Set(layout.positions.values.map { "\($0.x),\($0.y)" }).count, nodes.count)
    }

    func testRoutesRespectChainEnvelopeClearance() {
        let nodes = (0..<36).map { String(format: "b%02d", $0) }
        let edges = [
            LayoutEdge(id: "long-1", sourceID: nodes[0], targetID: nodes[35]),
            LayoutEdge(id: "long-2", sourceID: nodes[5], targetID: nodes[30]),
            LayoutEdge(id: "long-3", sourceID: nodes[7], targetID: nodes[28])
        ]
        let cardSize = CGSize(width: 220, height: 100)
        let layout = NetworkLayoutEngine.make(
            nodeIDs: nodes,
            edges: edges,
            focusPaths: [],
            cardSize: cardSize,
            topInset: 0
        )

        for edge in edges {
            guard let route = layout.routes[edge.id] else {
                return XCTFail("missing route for \(edge.id)")
            }
            for node in nodes where node != edge.sourceID && node != edge.targetID {
                guard let position = layout.positions[node] else { continue }
                let protectedFrame = CGRect(origin: position, size: cardSize).insetBy(dx: -25, dy: -25)
                for pair in zip(route, route.dropFirst()) {
                    XCTAssertFalse(
                        segment(pair.0, pair.1, intersects: protectedFrame),
                        "\(edge.id) crosses the Chain envelope clearance of \(node)"
                    )
                }
            }
        }
    }

    private func segment(_ start: CGPoint, _ end: CGPoint, intersects rect: CGRect) -> Bool {
        if start.x == end.x {
            return start.x > rect.minX && start.x < rect.maxX &&
                max(start.y, end.y) > rect.minY && min(start.y, end.y) < rect.maxY
        }
        if start.y == end.y {
            return start.y > rect.minY && start.y < rect.maxY &&
                max(start.x, end.x) > rect.minX && min(start.x, end.x) < rect.maxX
        }
        return true
    }
}
