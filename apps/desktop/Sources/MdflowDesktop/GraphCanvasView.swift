import AppKit
import SwiftUI

struct GraphCanvasView: View {
    @ObservedObject var store: GraphStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor
    @State private var scene: CanvasScene = .empty
    @State private var camera = CanvasCamera()
    @State private var dragStartOffset: CGSize?
    @State private var pinchStartScale: CGFloat?
    @State private var didFitProjectID = ""

    var body: some View {
        GeometryReader { viewport in
            ZStack(alignment: .topLeading) {
                grid(viewportSize: viewport.size)
                ZStack(alignment: .topLeading) {
                    Color.clear.contentShape(Rectangle())
                    chainEnvelopeLayer
                    linkLayer
                    chainMotionLayer
                    linkHitLayer
                    chainHitLayer
                    blockLayer
                }
                .frame(width: scene.layout.size.width, height: scene.layout.size.height, alignment: .topLeading)
                .scaleEffect(camera.scale, anchor: .topLeading)
                .offset(x: camera.offset.width, y: camera.offset.height)
            }
            .clipped()
            .contentShape(Rectangle())
            .background(MdflowTheme.canvas)
            .simultaneousGesture(
                SpatialTapGesture().onEnded { value in
                    let point = worldPoint(from: value.location)
                    guard !isInteractive(point) else { return }
                    store.clearSelection()
                }
            )
            .simultaneousGesture(
                DragGesture(minimumDistance: 3)
                    .onChanged { value in
                        let start = dragStartOffset ?? camera.offset
                        if dragStartOffset == nil { dragStartOffset = start }
                        camera.owner = .userPan
                        camera.offset = CGSize(width: start.width + value.translation.width, height: start.height + value.translation.height)
                        store.setCanvasOffset(camera.offset)
                    }
                    .onEnded { _ in dragStartOffset = nil; camera.owner = .none }
            )
            .simultaneousGesture(
                MagnificationGesture()
                    .onChanged { value in
                        let start = pinchStartScale ?? camera.scale
                        if pinchStartScale == nil { pinchStartScale = start }
                        camera.owner = .userPinch
                        setScale(start * value, around: viewportCenter(viewport.size))
                    }
                    .onEnded { _ in pinchStartScale = nil; camera.owner = .none }
            )
            .background {
                CameraEventBridge(
                    onScroll: { delta, _, zooming in
                        if zooming {
                            zoom(by: min(0.12, max(-0.12, delta.height * 0.012)), around: viewportCenter(viewport.size))
                        } else {
                            camera.owner = .userPan
                            camera.offset.width += delta.width
                            camera.offset.height += delta.height
                            store.setCanvasOffset(camera.offset)
                            camera.owner = .none
                        }
                    },
                    onDoubleClick: { _, zoomOut in zoom(by: zoomOut ? -0.32 : 0.42, around: viewportCenter(viewport.size)) }
                )
            }
            .onAppear { rebuildScene(viewport: viewport.size, fit: !store.hasRestoredCamera) }
            .onChange(of: sceneKey) { rebuildScene(viewport: viewport.size, fit: false) }
            .onChange(of: store.focusRequestID) { fitSelection(viewport: viewport.size) }
            .onChange(of: store.overviewFitRequestID) { fitAll(viewport: viewport.size) }
        }
    }

    private var sceneKey: String {
        let lenses = store.enabledLenses.map(\.rawValue).sorted().joined(separator: ",")
        return "\(store.snapshot.project.id):\(store.snapshot.project.graphRevision):\(store.snapshot.changeSequence):\(store.snapshotPresentationID.uuidString):\(lenses)"
    }

    private var sceneProjectionKey: String {
        let blocks = scene.blocks.map(\.id).sorted().joined(separator: ",")
        let links = scene.links.map(\.id).sorted().joined(separator: ",")
        return "b:\(blocks)|l:\(links)"
    }

    private func rebuildScene(viewport: CGSize, fit: Bool) {
        let nextScene = CanvasScene.compile(snapshot: store.snapshot, lenses: store.enabledLenses)
        if reduceMotion {
            scene = nextScene
        } else {
            withAnimation(.smooth(duration: 0.28)) {
                scene = nextScene
            }
        }
        if fit || didFitProjectID != store.snapshot.project.id {
            didFitProjectID = store.snapshot.project.id
            if store.hasRestoredCamera {
                camera.owner = .explicitLocate
                camera.scale = store.canvasScale
                camera.offset = store.canvasOffset
                camera.owner = .none
            } else {
                fitAll(viewport: viewport)
            }
        }
    }

    private var relatedBlockIDs: Set<String>? {
        guard let selection = store.selection else { return nil }
        switch selection.type {
        case .block:
            return scene.connectedComponent(from: selection.id)
        case .chain:
            return Set(scene.chainNodes[selection.id] ?? [])
        case .plan:
            return store.relatedBlockIDs(for: selection).intersection(Set(scene.blocks.map(\.id)))
        case .link:
            guard let link = scene.links.first(where: { $0.id == selection.id }) else { return [] }
            return [link.sourceId, link.targetId]
        case .decision:
            return []
        }
    }

    /// The grid is decorative and does not belong to the semantic scene. Keep
    /// its backing Canvas bounded to the viewport instead of the full world
    /// layout. A 300-Block graph can be tens of thousands of points wide; a
    /// world-sized grid needlessly allocates a giant render surface during the
    /// first frame and inflates the startup memory peak.
    private func grid(viewportSize: CGSize) -> some View {
        let spacing = max(12, min(36, 24 * camera.scale))
        let phaseX = positiveRemainder(camera.offset.width, modulus: spacing)
        let phaseY = positiveRemainder(camera.offset.height, modulus: spacing)
        return Canvas { context, size in
            var path = Path()
            stride(from: phaseX - spacing, through: size.width, by: spacing).forEach { x in
                stride(from: phaseY - spacing, through: size.height, by: spacing).forEach { y in
                    path.addEllipse(in: CGRect(x: x, y: y, width: 1, height: 1))
                }
            }
            context.fill(path, with: .color(MdflowTheme.hairline.opacity(0.42)))
        }
        .frame(width: max(1, viewportSize.width), height: max(1, viewportSize.height))
        .allowsHitTesting(false)
    }

    private var chainEnvelopeLayer: some View {
        Canvas { context, _ in
            for chain in store.snapshot.chains {
                let memberIDs = scene.chainNodes[chain.id] ?? []
                guard !memberIDs.isEmpty, let envelope = scene.chainEnvelopes[chain.id] else { continue }
                let color = store.chainColor(chain.id)
                let selected = store.highlightedChainIDs.contains(chain.id)
                let subdued = !store.highlightedChainIDs.isEmpty && !selected
                let fillOpacity = subdued ? 0.012 : selected ? 0.085 : 0.025
                let outerOpacity = subdued ? 0.05 : selected ? 0.18 : 0.09
                let strokeOpacity = subdued ? 0.12 : selected ? 0.96 : 0.62
                let path = chainEnvelopePath(envelope)
                context.fill(path, with: .color(color.opacity(fillOpacity)), style: FillStyle(eoFill: true))
                context.stroke(
                    path, with: .color(color.opacity(outerOpacity)),
                    style: StrokeStyle(lineWidth: selected ? 6.0 : 4.0, lineCap: .round, lineJoin: .round)
                )
                context.stroke(
                    path, with: .color(color.opacity(strokeOpacity)),
                    style: StrokeStyle(lineWidth: selected ? 2.8 : 1.8, lineCap: .round, lineJoin: .round)
                )
            }
        }
        .id("chain-envelopes:\(sceneProjectionKey)")
        .transition(.opacity)
        .allowsHitTesting(false)
    }

    @ViewBuilder
    private var chainMotionLayer: some View {
        if hasAnimatedChain {
            TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: reduceMotion || scene.blocks.count > 120)) { timeline in
                Canvas { context, _ in
                    let chains = store.snapshot.chains.sorted { $0.id < $1.id }
                    let seconds = timeline.date.timeIntervalSinceReferenceDate
                    for (index, chain) in chains.enumerated() {
                        let selected = store.highlightedChainIDs.contains(chain.id)
                        let active = ["implementing", "verifying"].contains(chain.deliveryState)
                        let unhealthy = ["warning", "failing", "unstable", "disputed"].contains(chain.healthState)
                        guard selected || active || unhealthy else { continue }
                        guard let envelope = scene.chainEnvelopes[chain.id] else { continue }

                        let color = store.chainColor(chain.id)
                        let signature = index % 3
                        let speed = chain.deliveryState == "verifying" ? 0.075 : 0.12 + Double(signature) * 0.018
                        let phaseOffset = Double(index) * 0.173
                        let progress = reduceMotion ? 0.82 : positiveRemainder(seconds * speed + phaseOffset, modulus: 1)
                        let dashPhase = reduceMotion ? 0 : CGFloat(-seconds * (18 + Double(signature) * 5))
                        let dash: [CGFloat] = switch signature {
                        case 0: [9, 14]
                        case 1: [4, 8, 13, 8]
                        default: [2, 7, 2, 15]
                        }
                        let path = chainEnvelopePath(envelope)
                        context.stroke(
                            path,
                            with: .color(color.opacity(selected ? 0.72 : 0.34)),
                            style: StrokeStyle(
                                lineWidth: selected ? 2.0 : 1.2,
                                lineCap: .round,
                                lineJoin: .round,
                                dash: dash,
                                dashPhase: dashPhase
                            )
                        )

                        guard let sample = chainMotionSample(chain.id, progress: progress) else { continue }
                        let pulse = unhealthy && !reduceMotion ? 0.68 + 0.32 * sin(seconds * 3.2) : 1
                        drawChainMarker(
                            context: &context,
                            point: sample.point,
                            horizontal: sample.horizontal,
                            signature: signature,
                            color: color.opacity((selected ? 0.96 : 0.72) * pulse),
                            selected: selected
                        )
                    }
                }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        } else {
            Color.clear
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }

    private var hasAnimatedChain: Bool {
        store.snapshot.chains.contains { chain in
            store.highlightedChainIDs.contains(chain.id)
                || ["implementing", "verifying"].contains(chain.deliveryState)
                || ["warning", "failing", "unstable", "disputed"].contains(chain.healthState)
        }
    }

    private func chainMotionSample(_ chainID: String, progress: Double) -> (point: CGPoint, horizontal: Bool)? {
        let segments = (scene.chainLinks[chainID] ?? []).flatMap { linkID -> [(CGPoint, CGPoint)] in
            guard let points = scene.layout.routes[linkID] else { return [] }
            return zip(points, points.dropFirst()).filter { length($0.0, $0.1) > 0 }
        }
        let total = segments.reduce(CGFloat.zero) { $0 + length($1.0, $1.1) }
        guard total > 0 else { return nil }
        var remaining = CGFloat(min(1, max(0, progress))) * total
        for (start, end) in segments {
            let segmentLength = length(start, end)
            if remaining <= segmentLength {
                let ratio = segmentLength == 0 ? 0 : remaining / segmentLength
                return (
                    CGPoint(x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio),
                    abs(end.x - start.x) >= abs(end.y - start.y)
                )
            }
            remaining -= segmentLength
        }
        guard let last = segments.last else { return nil }
        return (last.1, abs(last.1.x - last.0.x) >= abs(last.1.y - last.0.y))
    }

    private func drawChainMarker(
        context: inout GraphicsContext,
        point: CGPoint,
        horizontal: Bool,
        signature: Int,
        color: Color,
        selected: Bool
    ) {
        if selected {
            context.fill(
                Path(ellipseIn: CGRect(x: point.x - 7, y: point.y - 7, width: 14, height: 14)),
                with: .color(color.opacity(0.16))
            )
        }
        switch signature {
        case 0:
            context.fill(Path(ellipseIn: CGRect(x: point.x - 3.5, y: point.y - 3.5, width: 7, height: 7)), with: .color(color))
        case 1:
            let rect = horizontal
                ? CGRect(x: point.x - 6, y: point.y - 2.5, width: 12, height: 5)
                : CGRect(x: point.x - 2.5, y: point.y - 6, width: 5, height: 12)
            context.fill(Path(roundedRect: rect, cornerRadius: 2.5), with: .color(color))
        default:
            context.stroke(
                Path(ellipseIn: CGRect(x: point.x - 4.5, y: point.y - 4.5, width: 9, height: 9)),
                with: .color(color), lineWidth: 2
            )
            context.fill(Path(ellipseIn: CGRect(x: point.x - 1.5, y: point.y - 1.5, width: 3, height: 3)), with: .color(color))
        }
    }

    private func positiveRemainder(_ value: Double, modulus: Double) -> Double {
        let result = value.truncatingRemainder(dividingBy: modulus)
        return result >= 0 ? result : result + modulus
    }

    private func positiveRemainder(_ value: CGFloat, modulus: CGFloat) -> CGFloat {
        let result = value.truncatingRemainder(dividingBy: modulus)
        return result >= 0 ? result : result + modulus
    }

    private func length(_ start: CGPoint, _ end: CGPoint) -> CGFloat {
        abs(end.x - start.x) + abs(end.y - start.y)
    }

    private var linkLayer: some View {
        Canvas { context, _ in
            let related = relatedBlockIDs
            for link in scene.links {
                guard let points = scene.layout.routes[link.id], points.count > 1 else { continue }
                let isRelated = related == nil || (related!.contains(link.sourceId) && related!.contains(link.targetId))
                let opacity: Double = isRelated ? 0.86 : 0.10
                let color = MdflowTheme.linkKindColor(link.kind)
                let dash = differentiateWithoutColor ? differentiatedLinkDash(link.kind) : semanticLinkDash(link.kind)
                context.stroke(
                    streetPath(points), with: .color(color.opacity(opacity)),
                    style: StrokeStyle(lineWidth: isRelated ? 1.7 : 1.2, lineCap: .square, lineJoin: .miter, dash: dash)
                )
                drawArrow(context: &context, points: points, color: color.opacity(opacity))
            }
        }
        .id("links:\(sceneProjectionKey)")
        .transition(.opacity)
        .allowsHitTesting(false)
    }

    private func semanticLinkDash(_ kind: String) -> [CGFloat] {
        ["depends_on", "validates", "constrains", "supersedes"].contains(kind) ? [6, 4] : []
    }

    private func differentiatedLinkDash(_ kind: String) -> [CGFloat] {
        switch kind {
        case "flows_to": []
        case "calls": [9, 3]
        case "reads": [2, 3]
        case "writes": [12, 3, 2, 3]
        case "depends_on": [6, 4]
        case "implements": [10, 3, 2, 3]
        case "validates": [4, 4]
        case "constrains": [2, 4, 2, 4]
        case "supersedes": [14, 3]
        default: [5, 3]
        }
    }

    private var linkHitLayer: some View {
        ZStack(alignment: .topLeading) {
            ForEach(scene.links) { link in
                if let points = scene.layout.routes[link.id] {
                    let path = streetPath(points)
                    path.stroke(Color.black.opacity(0.001), lineWidth: 10)
                        .contentShape(path.strokedPath(StrokeStyle(lineWidth: 12)))
                        .onTapGesture { store.select(GraphSelection(type: .link, id: link.id)) }
                        .help(link.label.isEmpty ? link.kind : link.label)
                }
            }
        }
    }

    private var chainHitLayer: some View {
        ZStack(alignment: .topLeading) {
            ForEach(store.snapshot.chains) { chain in
                if let envelope = scene.chainEnvelopes[chain.id], !envelope.contours.isEmpty {
                    let path = chainEnvelopePath(envelope)
                    path.fill(Color.black.opacity(0.001), style: FillStyle(eoFill: true))
                        .contentShape(path, eoFill: true)
                        .onTapGesture { store.select(GraphSelection(type: .chain, id: chain.id)) }
                        .help(store.chainText(chain, field: "title"))
                }
            }
        }
    }

    private var blockLayer: some View {
        ForEach(scene.blocks) { block in
            if let point = scene.layout.positions[block.id] {
                blockCard(block)
                    .opacity(relatedBlockIDs == nil || relatedBlockIDs!.contains(block.id) ? 1 : 0.13)
                    .position(x: point.x + scene.cardSize.width / 2, y: point.y + scene.cardSize.height / 2)
                    .transition(.scale(scale: 0.96).combined(with: .opacity))
            }
        }
    }

    private func blockCard(_ block: BlockItem) -> some View {
        let selected = store.selection == GraphSelection(type: .block, id: block.id)
        let changed = store.recentlyChangedRefs.contains("block:\(block.id)")
        let typeColor = MdflowTheme.blockKindColor(block.kind)
        let stateColor = MdflowTheme.deliveryColor(block.deliveryState)
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
        let isGhost = block.isGhost
        let sources = store.sourceReferences(for: block.id)
        let hasFacade = sources.contains { $0.symbol != nil }

        return Button { store.select(GraphSelection(type: .block, id: block.id)) } label: {
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 6) {
                    Image(systemName: blockSymbol(block.kind))
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(typeColor)
                    Text(block.kind.uppercased())
                        .font(.system(size: 8, weight: .bold, design: .monospaced))
                        .tracking(0.9)
                        .foregroundStyle(typeColor)
                    Spacer()
                    if isGhost {
                        HStack(spacing: 3) {
                            Image(systemName: "sparkles")
                                .font(.system(size: 7.5, weight: .bold))
                            Text("GHOST")
                                .font(.system(size: 7, weight: .black, design: .monospaced))
                        }
                        .foregroundStyle(stateColor)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1.5)
                        .background(stateColor.opacity(0.12), in: Capsule())
                    } else if hasFacade {
                        HStack(spacing: 3) {
                            Image(systemName: "curlybraces")
                                .font(.system(size: 7, weight: .bold))
                            Text("AST")
                                .font(.system(size: 7, weight: .black, design: .monospaced))
                        }
                        .foregroundStyle(MdflowTheme.focus)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1.5)
                        .background(MdflowTheme.focus.opacity(0.12), in: Capsule())
                    }
                    Image(systemName: deliverySymbol(block.deliveryState))
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(stateColor)
                    if !["unknown", "healthy"].contains(block.healthState) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(MdflowTheme.healthColor(block.healthState))
                    }
                }
                Text(store.blockText(block, field: "title"))
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                    .foregroundStyle(MdflowTheme.ink)
                    .lineLimit(2)
                Text(store.blockText(block, field: "summary"))
                    .font(.system(size: 9.5, design: .rounded))
                    .foregroundStyle(MdflowTheme.muted)
                    .lineLimit(2)
                Spacer(minLength: 0)
                HStack {
                    Text(block.deliveryState.uppercased())
                        .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                        .tracking(0.6)
                        .foregroundStyle(stateColor)
                    Spacer()
                    if let first = sources.first(where: { $0.symbol != nil }), let sym = first.symbol {
                        Text(sym)
                            .font(.system(size: 7.5, weight: .medium, design: .monospaced))
                            .foregroundStyle(MdflowTheme.muted)
                            .lineLimit(1)
                    }
                }
            }
            .padding(11)
            .frame(width: scene.cardSize.width, height: scene.cardSize.height, alignment: .topLeading)
            .background(
                shape.fill(isGhost ? MdflowTheme.surface.opacity(0.72) : MdflowTheme.surface)
                    .overlay(alignment: .leading) {
                        Rectangle()
                            .fill(typeColor)
                            .frame(width: 4)
                            .padding(.vertical, 12)
                            .opacity(isGhost ? 0.6 : 1.0)
                    }
                    .overlay(
                        shape.stroke(
                            changed ? MdflowTheme.focus : selected ? typeColor : typeColor.opacity(isGhost ? 0.38 : 0.28),
                            style: StrokeStyle(
                                lineWidth: changed ? 3 : selected ? 2 : 1.1,
                                dash: isGhost ? [5, 3] : []
                            )
                        )
                    )
                    .shadow(color: Color.black.opacity(selected ? 0.10 : 0.045), radius: selected ? 10 : 4, y: 2)
            )
        }
        .buttonStyle(.plain)
        .help("\(store.blockText(block, field: "title"))\n\(store.blockText(block, field: "summary"))")
    }

    private func fitAll(viewport: CGSize) {
        guard !scene.layout.positions.isEmpty else { return }
        let scale = min(1.0, max(0.28, min((viewport.width - 36) / scene.layout.size.width, (viewport.height - 36) / scene.layout.size.height)))
        camera.owner = .explicitLocate
        camera.scale = scale
        camera.offset = CGSize(
            width: (viewport.width - scene.layout.size.width * scale) / 2,
            height: (viewport.height - scene.layout.size.height * scale) / 2
        )
        store.setZoom(scale)
        store.setCanvasOffset(camera.offset)
        camera.owner = .none
    }

    private func fitSelection(viewport: CGSize) {
        guard let selection = store.focusTarget else { return }
        let ids: Set<String>
        if selection.type == .chain {
            ids = Set(scene.chainNodes[selection.id] ?? [])
        } else if selection.type == .plan {
            ids = store.relatedBlockIDs(for: selection).intersection(Set(scene.blocks.map(\.id)))
        } else { return }
        guard let bounds = scene.bounds(for: ids) else { return }
        let scale = min(1.25, max(0.4, min((viewport.width - 54) / bounds.width, (viewport.height - 54) / bounds.height)))
        camera.owner = .explicitLocate
        camera.scale = scale
        camera.offset = CGSize(width: viewport.width / 2 - bounds.midX * scale, height: viewport.height / 2 - bounds.midY * scale)
        store.setZoom(scale)
        store.setCanvasOffset(camera.offset)
        camera.owner = .none
    }

    private func zoom(by delta: CGFloat, around point: CGPoint) {
        let factor = delta >= 0 ? 1 + delta : 1 / (1 - delta)
        camera.owner = .userZoom
        setScale(camera.scale * factor, around: point)
        camera.owner = .none
    }

    private func viewportCenter(_ size: CGSize) -> CGPoint {
        CGPoint(x: size.width / 2, y: size.height / 2)
    }

    private func setScale(_ proposed: CGFloat, around viewportPoint: CGPoint) {
        let next = min(1.8, max(0.25, proposed))
        let world = worldPoint(from: viewportPoint)
        camera.scale = next
        camera.offset = CGSize(width: viewportPoint.x - world.x * next, height: viewportPoint.y - world.y * next)
        store.setZoom(next)
        store.setCanvasOffset(camera.offset)
    }

    private func worldPoint(from viewportPoint: CGPoint) -> CGPoint {
        CGPoint(
            x: (viewportPoint.x - camera.offset.width) / max(camera.scale, 0.001),
            y: (viewportPoint.y - camera.offset.height) / max(camera.scale, 0.001)
        )
    }

    private func isInteractive(_ point: CGPoint) -> Bool {
        if scene.layout.positions.values.contains(where: { CGRect(origin: $0, size: scene.cardSize).insetBy(dx: -5, dy: -5).contains(point) }) { return true }
        if scene.chainEnvelopes.values.contains(where: { $0.contains(point) }) { return true }
        for link in scene.links {
            guard let points = scene.layout.routes[link.id] else { continue }
            if zip(points, points.dropFirst()).contains(where: { distance(point, $0, $1) < 20 }) { return true }
        }
        return false
    }

    private func distance(_ point: CGPoint, _ start: CGPoint, _ end: CGPoint) -> CGFloat {
        if start.x == end.x {
            let y = min(max(point.y, min(start.y, end.y)), max(start.y, end.y))
            return hypot(point.x - start.x, point.y - y)
        }
        let x = min(max(point.x, min(start.x, end.x)), max(start.x, end.x))
        return hypot(point.x - x, point.y - start.y)
    }

    private func streetPath(_ points: [CGPoint]) -> Path {
        var path = Path()
        guard let first = points.first else { return path }
        path.move(to: first)
        for point in points.dropFirst() { path.addLine(to: point) }
        return path
    }

    private func chainEnvelopePath(_ envelope: ChainEnvelopeGeometry) -> Path {
        var path = Path()
        for contour in envelope.contours where contour.count > 2 {
            let rounded = roundedContour(contour, radius: 10 + envelope.expansion * 0.25)
            path.addPath(rounded)
        }
        return path
    }

    private func roundedContour(_ points: [CGPoint], radius: CGFloat) -> Path {
        var path = Path()
        guard points.count > 2 else { return path }
        func offset(_ from: CGPoint, toward: CGPoint, distance: CGFloat) -> CGPoint {
            let dx = toward.x - from.x, dy = toward.y - from.y
            let length = max(0.001, hypot(dx, dy))
            return CGPoint(x: from.x + dx / length * distance, y: from.y + dy / length * distance)
        }
        let cornerData = points.enumerated().map { index, point -> (CGPoint, CGPoint, CGPoint) in
            let previous = points[(index - 1 + points.count) % points.count]
            let next = points[(index + 1) % points.count]
            let applied = min(radius, hypot(previous.x - point.x, previous.y - point.y) / 2, hypot(next.x - point.x, next.y - point.y) / 2)
            return (offset(point, toward: previous, distance: applied), point, offset(point, toward: next, distance: applied))
        }
        path.move(to: cornerData[0].0)
        for index in 0..<cornerData.count {
            let corner = cornerData[index]
            if index > 0 { path.addLine(to: corner.0) }
            path.addQuadCurve(to: corner.2, control: corner.1)
            let next = cornerData[(index + 1) % cornerData.count]
            path.addLine(to: next.0)
        }
        path.closeSubpath()
        return path
    }

    private func drawArrow(context: inout GraphicsContext, points: [CGPoint], color: Color) {
        guard let end = points.last, let start = points.dropLast().last else { return }
        let angle = atan2(end.y - start.y, end.x - start.x)
        let size: CGFloat = 7
        var arrow = Path()
        arrow.move(to: CGPoint(x: end.x - cos(angle - 0.55) * size, y: end.y - sin(angle - 0.55) * size))
        arrow.addLine(to: end)
        arrow.addLine(to: CGPoint(x: end.x - cos(angle + 0.55) * size, y: end.y - sin(angle + 0.55) * size))
        context.stroke(arrow, with: .color(color), style: StrokeStyle(lineWidth: 1.6, lineCap: .square, lineJoin: .miter))
    }

    private func blockSymbol(_ kind: String) -> String {
        switch kind {
        case "ui": "rectangle.3.group"
        case "flow": "arrow.triangle.branch"
        case "service": "gearshape.2"
        case "function": "function"
        case "integration": "externaldrive.connected.to.line.below"
        case "data": "tray.full"
        case "database": "cylinder.split.1x2"
        case "test", "checkpoint": "checkmark.seal"
        case "risk": "exclamationmark.triangle"
        case "principle", "decision", "requirement", "product": "book.closed"
        default: "square.stack.3d.up"
        }
    }

    private func deliverySymbol(_ state: String) -> String {
        switch state {
        case "complete": "checkmark.circle.fill"
        case "implementing": "hammer.fill"
        case "verifying": "testtube.2"
        case "deprecated": "archivebox.fill"
        case "planned": "clock.fill"
        default: "circle.dashed"
        }
    }
}

private struct CanvasCamera {
    enum Owner { case userPan, userPinch, userZoom, explicitLocate, none }
    var scale: CGFloat = 1
    var offset: CGSize = .zero
    var owner: Owner = .none
}

private struct CameraEventBridge: NSViewRepresentable {
    let onScroll: (CGSize, CGPoint, Bool) -> Void
    let onDoubleClick: (CGPoint, Bool) -> Void

    final class Coordinator {
        var monitor: Any?
        var onScroll: ((CGSize, CGPoint, Bool) -> Void)?
        var onDoubleClick: ((CGPoint, Bool) -> Void)?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> NSView { NSView(frame: .zero) }

    func updateNSView(_ view: NSView, context: Context) {
        let coordinator = context.coordinator
        coordinator.onScroll = onScroll
        coordinator.onDoubleClick = onDoubleClick
        if coordinator.monitor == nil {
            coordinator.monitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel, .leftMouseUp]) { [weak view, weak coordinator] event in
                guard let view, let coordinator, event.window === view.window else { return event }
                if event.type == .scrollWheel,
                   let hitView = event.window?.contentView?.hitTest(event.locationInWindow),
                   hitView.ancestorOrSelf(where: { $0 is NSScrollView }) != nil {
                    return event
                }
                let point = view.convert(event.locationInWindow, from: nil)
                guard view.bounds.contains(point) else { return event }
                if event.type == .scrollWheel {
                    coordinator.onScroll?(
                        CGSize(width: event.scrollingDeltaX, height: event.scrollingDeltaY),
                        point,
                        event.modifierFlags.contains(.command)
                    )
                    return nil
                }
                if event.type == .leftMouseUp, event.clickCount == 2 {
                    coordinator.onDoubleClick?(point, event.modifierFlags.contains(.option))
                    return nil
                }
                return event
            }
        }
    }

    static func dismantleNSView(_ nsView: NSView, coordinator: Coordinator) {
        if let monitor = coordinator.monitor { NSEvent.removeMonitor(monitor) }
    }
}

private extension NSView {
    func ancestorOrSelf(where predicate: (NSView) -> Bool) -> NSView? {
        var candidate: NSView? = self
        while let current = candidate {
            if predicate(current) { return current }
            candidate = current.superview
        }
        return nil
    }
}
