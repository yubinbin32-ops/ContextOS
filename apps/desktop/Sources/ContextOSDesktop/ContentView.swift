import SwiftUI

struct ContentView: View {
    @StateObject private var store = GraphStore()
    @StateObject private var knowledge = KnowledgeLibrary()
    @State private var syncIssues: [String] = []
    @State private var requestedDocument: String?
    @State private var requestedSection: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor
    @AppStorage("contextos.appearance") private var appearance = AppearancePreference.system.rawValue

    var body: some View {
        GeometryReader { proxy in
            let drawerWidth = detailDrawerWidth(totalWidth: proxy.size.width)
            HStack(spacing: 0) {
                sidebar.frame(width: 248)
                Divider()
                VStack(spacing: 0) {
                    canvasToolbar
                    Divider()
                    GraphCanvasView(store: store).overlay(alignment: .topLeading) { errorBanner }
                }
                if let documentID = requestedDocument {
                    KnowledgeView(store: store, library: knowledge, documentID: documentID, section: requestedSection, close: closeDocument, openDocument: openDocument)
                        .frame(width: min(640, max(440, proxy.size.width * 0.38)))
                        .overlay(alignment: .leading) { Rectangle().fill(ContextOSTheme.hairline).frame(width: 1) }
                } else if let selection = store.selection {
                    DetailView(store: store, selection: selection)
                        .frame(width: drawerWidth)
                        .background(ContextOSTheme.surface)
                        .overlay(alignment: .leading) { Rectangle().fill(ContextOSTheme.hairline).frame(width: 1) }
                        .shadow(color: .black.opacity(0.075), radius: 12, x: -4, y: 0)
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: store.selection)
        }
        .frame(minWidth: 1_080, minHeight: 680)
        .background(ContextOSTheme.canvas)
        .preferredColorScheme(preferredColorScheme)
        .sheet(isPresented: $store.settingsPresented) { SettingsView(store: store) }
        .task(id: store.projectRoot) {
            let root = store.projectRoot
            while !Task.isCancelled {
                await knowledge.reload(root: root)
                let issues = store.knowledgeSyncIssues()
                if syncIssues != issues { syncIssues = issues }
                try? await Task.sleep(for: .seconds(2))
            }
        }
        .onChange(of: store.selection) { _, value in if value != nil { closeDocument() } }
        .onChange(of: store.projectRoot) { _, _ in closeDocument() }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("OpenKnowledgeDocument"))) { event in
            if let id = event.userInfo?["id"] as? String { openDocument(id, nil) }
        }
        .onOpenURL { url in
            guard url.scheme == "contextos", url.host == "knowledge",
                let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
            if let project = parts.queryItems?.first(where: { $0.name == "project" })?.value, project != store.projectRoot {
                store.openKnowledgeProject(at: URL(fileURLWithPath: project))
            }
            if let id = parts.queryItems?.first(where: { $0.name == "document" })?.value {
                Task { await knowledge.reload(root: store.projectRoot); openDocument(id, parts.queryItems?.first(where: { $0.name == "section" })?.value) }
            }
        }
    }

    private func openDocument(_ id: String, _ section: String?) {
        store.clearSelection()
        requestedSection = section
        requestedDocument = id
        store.setSidebarSection(.knowledge, collapsed: false)
    }
    private func closeDocument() { requestedDocument = nil; requestedSection = nil }

    private func detailDrawerWidth(totalWidth: CGFloat) -> CGFloat {
        guard let selection = store.selection else { return 0 }
        let preferredWidth = selection.type == .plan ? totalWidth * 0.33 : totalWidth * 0.25
        return min(
            selection.type == .plan ? 500 : 380,
            max(selection.type == .plan ? 410 : 320, preferredWidth)
        )
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            projectHeader
            Divider().padding(.horizontal, 14)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    sidebarSection(.knowledge, title: store.activeLocale == "zh-Hans" ? "知识" : "Knowledge") {
                        ForEach(knowledge.documents) { doc in
                            sidebarButton(title: doc.title, subtitle: doc.kind == "readme" ? (store.activeLocale == "zh-Hans" ? "仓库原文件 · 只读" : "REPOSITORY · READ ONLY") : "OS · r\(doc.revision)", color: ContextOSTheme.blockKindColor("principle"), selected: requestedDocument == doc.id) { openDocument(doc.id, nil) }
                        }
                        if knowledge.documents.isEmpty { Text(store.activeLocale == "zh-Hans" ? "README 与项目文档" : "README and project documents").font(.caption).foregroundStyle(.secondary).padding(.horizontal, 18) }
                    }
                    if !syncIssues.isEmpty || store.sourcePollingError != nil {
                        sidebarSection(.synchronization, title: store.activeLocale == "zh-Hans" ? "同步检查 (\(syncIssues.count))" : "Sync checks (\(syncIssues.count))") {
                            if let error = store.sourcePollingError { Text(error).font(.caption).foregroundStyle(.orange).padding(.horizontal, 18) }
                            ForEach(syncIssues, id: \.self) { Text($0).font(.caption).foregroundStyle(ContextOSTheme.muted).textSelection(.enabled).padding(.horizontal, 18).padding(.vertical, 4) }
                        }
                    }
                    sidebarSection(.projectRules, title: store.text("projectRules")) {
                        ForEach(projectRuleBlocks) { block in
                            sidebarButton(
                                title: store.blockText(block, field: "title"),
                                subtitle: "\(store.ruleScopeLabel(block.id).uppercased()) · \(block.deliveryState.uppercased())",
                                color: ContextOSTheme.blockKindColor(block.kind),
                                selected: store.selection == GraphSelection(type: .block, id: block.id)
                            ) { store.select(GraphSelection(type: .block, id: block.id)) }
                        }
                    }

                    if !store.snapshot.decisions.isEmpty {
                        sidebarSection(.decisions, title: store.text("decisions")) {
                            ForEach(store.snapshot.decisions) { decision in
                                sidebarButton(
                                    title: decision.title,
                                    subtitle: "\(decision.status.uppercased()) · \(store.decisionScopeLabel(decision.id))",
                                    color: ContextOSTheme.blockKindColor("principle"),
                                    selected: store.selection == GraphSelection(type: .decision, id: decision.id)
                                ) { store.select(GraphSelection(type: .decision, id: decision.id)) }
                            }
                        }
                    }

                    sidebarSection(.plans, title: store.text("plans")) {
                        ForEach(store.plans.filter { $0.derivedStatus != "cancelled" }) { plan in
                            sidebarButton(
                                title: "\(plan.phase.uppercased()) \(plan.order) · \(store.planText(plan, field: "title"))",
                                subtitle: "\(plan.priority.uppercased()) · \(plan.derivedStatus.uppercased()) · \(plan.progress.completedSteps)/\(plan.progress.totalSteps)",
                                color: ContextOSTheme.planColor(plan.derivedStatus),
                                selected: store.selection == GraphSelection(type: .plan, id: plan.id)
                            ) { store.focusPlan(plan.id) }
                        }
                    }

                    sidebarSection(.chains, title: store.text("chains")) {
                        ForEach(store.snapshot.chains) { chain in
                            sidebarButton(
                                title: store.chainText(chain, field: "title"),
                                subtitle: chain.chainType == "composite"
                                    ? "\(store.chainMembers(for: chain.id).count) STAGES · COMPOSITE · \(chain.deliveryState.uppercased())"
                                    : "\(store.chainNodeIDs(chain.id).count) BLOCKS · \(chain.deliveryState.uppercased())",
                                color: store.chainColor(chain.id),
                                selected: store.selection == GraphSelection(type: .chain, id: chain.id)
                            ) { store.select(GraphSelection(type: .chain, id: chain.id)) }
                        }
                    }

                    let pendingUnassigned = store.unassignedCheckpoints.filter {
                        $0.status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() != "passed"
                    }
                    if !pendingUnassigned.isEmpty {
                        sidebarSection(.verification, title: store.text("verification")) {
                            Text("\(store.text("unassigned")) (\(pendingUnassigned.count))")
                                .font(.system(size: 8, weight: .bold, design: .monospaced))
                                .foregroundStyle(ContextOSTheme.muted)
                                .padding(.horizontal, 18).padding(.top, 4).padding(.bottom, 4)
                            ForEach(pendingUnassigned.prefix(5)) { checkpoint in
                                if let type = GraphSelection.EntityType(rawValue: checkpoint.targetType) {
                                    sidebarButton(
                                        title: checkpoint.title,
                                        subtitle: "\(checkpoint.status.uppercased()) · \(store.checkpointOwner(checkpoint))",
                                        color: ContextOSTheme.checkpointColor(checkpoint.status),
                                        selected: store.selection == GraphSelection(type: type, id: checkpoint.targetId)
                                    ) { store.select(GraphSelection(type: type, id: checkpoint.targetId)) }
                                }
                            }
                        }
                    }
                }
                .padding(.bottom, 16)
            }
            Divider().padding(.horizontal, 14)
            legend
        }
        .background(ContextOSTheme.surface.opacity(0.97))
    }

    @ViewBuilder
    private func sidebarSection<Content: View>(_ section: SidebarSection, title: String, @ViewBuilder content: () -> Content) -> some View {
        let collapsed = store.isSidebarSectionCollapsed(section)
        Button {
            withAnimation(reduceMotion ? nil : .smooth(duration: 0.24)) {
                store.setSidebarSection(section, collapsed: !collapsed)
            }
        } label: {
            HStack(spacing: 7) {
                Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                    .font(.system(size: 9, weight: .bold))
                Text(title.uppercased())
                    .font(.system(size: 9, weight: .bold, design: .monospaced)).tracking(1.35)
                Spacer()
            }
            .foregroundStyle(ContextOSTheme.muted)
            .padding(.horizontal, 18).padding(.top, 17).padding(.bottom, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        if !collapsed {
            content()
                .transition(.opacity)
        }
    }

    private var projectHeader: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .center, spacing: 8) {
                Text(store.snapshot.project.name)
                    .font(.system(size: 16, weight: .semibold, design: .rounded))
                    .foregroundStyle(ContextOSTheme.ink)
                    .lineLimit(1)
                Spacer()
                Menu {
                    if !store.recentProjects.isEmpty {
                        Section(store.text("recentProjects")) {
                            ForEach(store.recentProjects) { project in
                                Button { store.openProject(project) } label: {
                                    project.path == store.projectRoot ? Label(project.name, systemImage: "checkmark") : Label(project.name, systemImage: "folder")
                                }
                            }
                        }
                        Divider()
                    }
                    Button(store.text("openProject")) { store.chooseProject() }
                } label: {
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 10, weight: .semibold)).foregroundStyle(ContextOSTheme.muted)
                        .frame(width: 24, height: 24)
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden)
            }

            let totalCps = store.totalCheckpointsCount
            let passedCps = store.passedCheckpointsCount
            let pct = store.checkpointPassPercentage

            if totalCps > 0 {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text("\(passedCps)/\(totalCps) \(store.text("checkpointsPassed"))")
                            .font(.system(size: 9, weight: .bold, design: .monospaced))
                            .foregroundStyle(pct == 100 ? ContextOSTheme.success : (pct >= 80 ? ContextOSTheme.focus : ContextOSTheme.pending))
                            .lineLimit(1)
                        Spacer()
                        Text("\(pct)%")
                            .font(.system(size: 9, weight: .bold, design: .monospaced))
                            .foregroundStyle(pct == 100 ? ContextOSTheme.success : (pct >= 80 ? ContextOSTheme.focus : ContextOSTheme.pending))
                    }
                    ProgressView(value: Double(passedCps), total: Double(totalCps))
                        .progressViewStyle(.linear)
                        .tint(pct == 100 ? ContextOSTheme.success : (pct >= 80 ? ContextOSTheme.focus : ContextOSTheme.pending))
                }
            } else {
                HStack(spacing: 5) {
                    Circle().fill(ContextOSTheme.muted.opacity(0.4)).frame(width: 5, height: 5)
                    Text(store.text("noCheckpoints"))
                        .font(.system(size: 8.5, weight: .medium, design: .monospaced))
                        .foregroundStyle(ContextOSTheme.muted)
                }
            }
        }
        .padding(18)
    }

    private func sidebarLabel(_ value: String) -> some View {
        Text(value.uppercased())
            .font(.system(size: 9, weight: .bold, design: .monospaced)).tracking(1.35)
            .foregroundStyle(ContextOSTheme.muted)
            .padding(.horizontal, 18).padding(.top, 17).padding(.bottom, 7)
    }

    private func sidebarButton(title: String, subtitle: String, color: Color, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 2).fill(color).frame(width: 4, height: 30)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.system(size: 11.5, weight: .medium, design: .rounded)).foregroundStyle(ContextOSTheme.ink).lineLimit(2)
                    Text(subtitle).font(.system(size: 7.5, weight: .bold, design: .monospaced)).tracking(0.7).foregroundStyle(color)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: 9).fill(selected ? color.opacity(0.10) : .clear))
        }
        .buttonStyle(.plain).padding(.horizontal, 7)
    }

    private var canvasToolbar: some View {
        HStack(spacing: 13) {
            ForEach(store.availableLenses) { lens in
                Toggle(
                    store.lensTitle(lens),
                    isOn: Binding(get: { store.enabledLenses.contains(lens) }, set: { store.setLens(lens, enabled: $0) })
                )
                .toggleStyle(.checkbox)
                .font(.system(size: 11, weight: .medium, design: .rounded))
                .foregroundStyle(ContextOSTheme.ink)
            }
            Spacer()
            Text("\(Int((store.canvasScale * 100).rounded()))%")
                .font(.system(size: 9, weight: .semibold, design: .monospaced)).foregroundStyle(ContextOSTheme.muted)
                .help(store.activeLocale == "zh-Hans" ? "触控板捏合、⌘滚动或双击缩放" : "Pinch, ⌘-scroll, or double-click to zoom")
            Button { store.settingsPresented = true } label: {
                Label(store.text("settings"), systemImage: "gearshape")
                    .font(.system(size: 11, weight: .semibold, design: .rounded)).foregroundStyle(ContextOSTheme.ink)
                    .padding(.horizontal, 9).frame(height: 30)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(",", modifiers: .command)
        }
        .padding(.horizontal, 16).frame(height: 50)
        .background(ContextOSTheme.surface.opacity(0.96))
    }

    private var legend: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text((store.activeLocale == "zh-Hans" ? "图例" : "LEGEND").uppercased())
                .font(.system(size: 8, weight: .bold, design: .monospaced)).tracking(1.2).foregroundStyle(ContextOSTheme.muted)
            HStack(spacing: 10) {
                legendItem(color: ContextOSTheme.blockKindColor("ui"), text: store.text("ui"))
                legendItem(color: ContextOSTheme.blockKindColor("service"), text: store.text("service"))
                legendItem(color: ContextOSTheme.blockKindColor("database"), text: store.text("data"))
            }
            HStack(spacing: 10) {
                legendItem(color: ContextOSTheme.deliveryColor("complete"), text: store.activeLocale == "zh-Hans" ? "完成" : "Done")
                legendItem(color: ContextOSTheme.deliveryColor("implementing"), text: store.activeLocale == "zh-Hans" ? "进行中" : "Active")
                legendItem(color: ContextOSTheme.failure, text: store.activeLocale == "zh-Hans" ? "失败/阻塞" : "Failed")
            }
            Text(store.activeLocale == "zh-Hans" ? "左侧色条＝Block 类型 · 图标＝交付状态 · 线色/虚线＝关系类型 · 外框＝Chain" : "Left rail = Block type · icon = delivery · line = Link kind · enclosure = Chain")
                .font(.system(size: 9.5, design: .rounded)).foregroundStyle(ContextOSTheme.muted).fixedSize(horizontal: false, vertical: true)
            if differentiateWithoutColor {
                Text(store.activeLocale == "zh-Hans" ? "已启用无色彩区分：状态同时使用文字、图标和虚线。" : "Differentiation without color is on: status also uses text, icons, and dashes.")
                    .font(.system(size: 8.5, weight: .medium, design: .rounded))
                    .foregroundStyle(ContextOSTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
    }

    private func legendItem(color: Color, text: String) -> some View {
        HStack(spacing: 4) { Circle().fill(color).frame(width: 6, height: 6); Text(text) }
            .font(.system(size: 8.5, weight: .medium, design: .rounded)).foregroundStyle(ContextOSTheme.ink.opacity(0.8))
    }

    private var projectRuleBlocks: [BlockItem] {
        let ids = Set(store.snapshot.backgroundScopes.map(\.blockId))
        return store.snapshot.blocks.filter { ids.contains($0.id) }
    }

    @ViewBuilder
    private var errorBanner: some View {
        if let error = store.errorMessage {
            VStack(alignment: .leading, spacing: 9) {
                Text(error).font(.system(size: 11, weight: .medium, design: .rounded)).foregroundStyle(ContextOSTheme.failure)
                Button(store.text("openProject")) { store.chooseProject() }.buttonStyle(.borderedProminent).controlSize(.small)
            }
            .padding(14).background(ContextOSTheme.surface).clipShape(RoundedRectangle(cornerRadius: 10)).padding(16)
        }
    }
}

private struct SettingsView: View {
    @ObservedObject var store: GraphStore
    @Environment(\.dismiss) private var dismiss
    @AppStorage("contextos.appearance") private var appearance = AppearancePreference.system.rawValue

    var body: some View {
        VStack(spacing: 0) {
            // macOS / iOS Sheet Navigation Bar
            HStack(alignment: .center) {
                Text(store.text("settings"))
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .foregroundStyle(ContextOSTheme.ink)
                Spacer()
                Button(store.text("done")) {
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .keyboardShortcut(.defaultAction)
            }
            .padding(.horizontal, 22)
            .padding(.top, 16)
            .padding(.bottom, 12)

            Divider()

            VStack(alignment: .leading, spacing: 14) {
                // Group 1: 偏好设置 (PREFERENCES)
                VStack(alignment: .leading, spacing: 6) {
                    sectionHeader(store.activeLocale == "zh-Hans" ? "偏好设置" : "PREFERENCES")
                    VStack(spacing: 0) {
                        HStack {
                            Label {
                                Text(store.text("language"))
                                    .font(.system(size: 12.5, weight: .medium, design: .rounded))
                                    .foregroundStyle(ContextOSTheme.ink)
                            } icon: {
                                Image(systemName: "globe")
                                    .font(.system(size: 12.5, weight: .medium))
                                    .foregroundStyle(ContextOSTheme.muted)
                                    .frame(width: 20)
                            }
                            Spacer()
                            Picker("", selection: $store.language) {
                                Text(store.text("system")).tag(AppLanguage.system)
                                Text(store.text("chinese")).tag(AppLanguage.zhHans)
                                Text(store.text("english")).tag(AppLanguage.english)
                            }
                            .pickerStyle(.menu)
                            .frame(width: 120)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)

                        Divider().padding(.leading, 38)

                        HStack {
                            Label {
                                Text(store.text("appearance"))
                                    .font(.system(size: 12.5, weight: .medium, design: .rounded))
                                    .foregroundStyle(ContextOSTheme.ink)
                            } icon: {
                                Image(systemName: "circle.righthalf.filled")
                                    .font(.system(size: 12.5, weight: .medium))
                                    .foregroundStyle(ContextOSTheme.muted)
                                    .frame(width: 20)
                            }
                            Spacer()
                            Picker("", selection: $appearance) {
                                Text(store.text("system")).tag(AppearancePreference.system.rawValue)
                                Text(store.text("light")).tag(AppearancePreference.light.rawValue)
                                Text(store.text("dark")).tag(AppearancePreference.dark.rawValue)
                            }
                            .pickerStyle(.menu)
                            .frame(width: 120)
                            .accessibilityLabel(store.text("appearance"))
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                    }
                    .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(ContextOSTheme.hairline, lineWidth: 0.8))
                }

                // Group 2: AI 编辑器集成 (AI CLIENT MCP BRIDGES)
                VStack(alignment: .leading, spacing: 6) {
                    sectionHeader(store.text("plugin").uppercased())

                    if let syncError = store.syncErrorMessage {
                        HStack(spacing: 6) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(ContextOSTheme.failure)
                            Text(syncError)
                                .font(.system(size: 10, design: .rounded))
                                .foregroundStyle(ContextOSTheme.failure)
                                .lineLimit(3)
                            Spacer()
                            Button {
                                store.syncErrorMessage = nil
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 10))
                                    .foregroundStyle(ContextOSTheme.muted)
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(RoundedRectangle(cornerRadius: 8).fill(ContextOSTheme.failure.opacity(0.1)))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(ContextOSTheme.failure.opacity(0.3), lineWidth: 0.8))
                    }

                    VStack(spacing: 0) {
                        ForEach(Array(store.editorStatuses.enumerated()), id: \.element.id) { index, status in
                            if index > 0 {
                                Divider().padding(.leading, 50)
                            }
                            EditorPlatformRow(status: status, store: store)
                        }
                    }
                    .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(ContextOSTheme.hairline, lineWidth: 0.8))

                    Text(store.runtimeHandshake).font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
                    Text(store.text("pluginHelp"))
                        .font(.system(size: 10.5, design: .rounded))
                        .foregroundStyle(ContextOSTheme.muted)
                        .padding(.horizontal, 6)
                        .padding(.top, 1)
                }

                // Group 3: 数据存储与内核 (DATA ENGINE & STORAGE)
                VStack(alignment: .leading, spacing: 6) {
                    sectionHeader(store.text("liveData").uppercased())

                    VStack(spacing: 0) {
                        HStack(alignment: .center) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(store.activeLocale == "zh-Hans" ? "当前数据库" : "DATABASE")
                                    .font(.system(size: 8, weight: .bold, design: .monospaced))
                                    .tracking(0.7)
                                    .foregroundStyle(ContextOSTheme.muted)
                                Text(store.databasePath)
                                    .font(.system(size: 10.5, design: .monospaced))
                                    .foregroundStyle(ContextOSTheme.ink)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                    .textSelection(.enabled)
                            }
                            Spacer()
                            Button(store.text("changeProject")) {
                                store.chooseProject()
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)

                        Divider().padding(.leading, 14)

                        HStack {
                            HStack(spacing: 5) {
                                Circle().fill(ContextOSTheme.success).frame(width: 5.5, height: 5.5)
                                Text(store.text("liveHelp"))
                                    .font(.system(size: 10.5, design: .rounded))
                                    .foregroundStyle(ContextOSTheme.muted)
                            }
                            Spacer()
                            Text("SQLITE · GRAPH.JSON")
                                .font(.system(size: 8, weight: .bold, design: .monospaced))
                                .tracking(0.8)
                                .foregroundStyle(ContextOSTheme.muted)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 7)
                    }
                    .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(ContextOSTheme.hairline, lineWidth: 0.8))
                }
            }
            .padding(.horizontal, 22)
            .padding(.top, 14)
            .padding(.bottom, 18)
        }
        .frame(width: 530)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 9.5, weight: .bold, design: .monospaced))
            .tracking(1.1)
            .foregroundStyle(ContextOSTheme.muted)
            .padding(.leading, 6)
    }
}

private struct EditorPlatformRow: View {
    let status: EditorPlatformStatus
    @ObservedObject var store: GraphStore

    var body: some View {
        HStack(spacing: 11) {
            // iOS-style Precision Icon Squircle
            ZStack {
                RoundedRectangle(cornerRadius: 6.5)
                    .fill(Color(nsColor: .controlBackgroundColor))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6.5)
                            .stroke(Color.black.opacity(0.07), lineWidth: 0.75)
                    )

                Image(systemName: iconName(for: status.id))
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(status.isAppInstalled ? ContextOSTheme.ink : ContextOSTheme.muted.opacity(0.5))
            }
            .frame(width: 26, height: 26)

            // Platform Details
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(status.name)
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundStyle(status.isAppInstalled ? ContextOSTheme.ink : ContextOSTheme.muted)

                    if !status.isAppInstalled {
                        Text(store.text("notDetected"))
                            .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                            .tracking(0.6)
                            .foregroundStyle(ContextOSTheme.muted)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Color.black.opacity(0.04)))
                    } else if status.isAppVersionMismatch {
                        HStack(spacing: 3) {
                            Text("App v\(status.appVersion)")
                            Text("↔")
                            Text("Plugin v\(status.targetVersion)")
                            Text("·")
                            Text(store.text("versionMismatch"))
                        }
                        .font(.system(size: 7.5, weight: .medium, design: .rounded))
                        .foregroundStyle(Color.orange)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Color.orange.opacity(0.12)))
                    } else if status.isSynced {
                        HStack(spacing: 3) {
                            Text("v\(status.installedVersion ?? status.targetVersion)")
                                .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                            Text("·")
                            Text(store.text("latest"))
                                .font(.system(size: 7.5, weight: .medium, design: .rounded))
                        }
                        .foregroundStyle(ContextOSTheme.success)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(ContextOSTheme.success.opacity(0.12)))
                    } else if status.isBuildMismatch {
                        Text(store.text("bundleChanged"))
                            .font(.system(size: 7.5, weight: .bold, design: .rounded))
                            .foregroundStyle(Color.orange)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Color.orange.opacity(0.12)))
                    } else if status.isOutdated {
                        HStack(spacing: 3) {
                            Text("v\(status.installedVersion ?? "?")")
                                .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                            Text("➔")
                            Text("v\(status.targetVersion)")
                                .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                            Text("·")
                            Text(store.text("updateAvailable"))
                                .font(.system(size: 7.5, weight: .medium, design: .rounded))
                        }
                        .foregroundStyle(Color.orange)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Color.orange.opacity(0.12)))
                    } else {
                        Text(store.text("notConfigured"))
                            .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                            .tracking(0.6)
                            .foregroundStyle(ContextOSTheme.muted)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Color.black.opacity(0.04)))
                    }
                }

                Text(status.configPath)
                    .font(.system(size: 8.5, design: .monospaced))
                    .foregroundStyle(ContextOSTheme.muted.opacity(status.isAppInstalled ? 1.0 : 0.6))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Spacer()

            // Trailing Actions & Status
            HStack(spacing: 8) {
                if !status.isAppInstalled {
                    Text(store.text("skipped"))
                        .font(.system(size: 10, weight: .medium, design: .rounded))
                        .foregroundStyle(ContextOSTheme.muted.opacity(0.6))
                        .frame(width: 54, alignment: .trailing)
                } else if store.syncingPlatformId == status.id {
                    HStack(spacing: 4) {
                        ProgressView()
                            .controlSize(.mini)
                        Text(store.text("syncing"))
                            .font(.system(size: 10, weight: .medium, design: .rounded))
                            .foregroundStyle(ContextOSTheme.muted)
                    }
                } else if status.isSynced {
                    HStack(spacing: 6) {
                        HStack(spacing: 3) {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(ContextOSTheme.success)
                            Text(store.text("synced"))
                                .font(.system(size: 10, weight: .medium, design: .rounded))
                                .foregroundStyle(ContextOSTheme.muted)
                        }
                        Button(action: {
                            store.syncEditor(id: status.id)
                        }) {
                            HStack(spacing: 2) {
                                Image(systemName: "arrow.clockwise")
                                    .font(.system(size: 8.5, weight: .bold))
                                Text(store.text("reinstall"))
                                    .font(.system(size: 9.5, weight: .medium, design: .rounded))
                            }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.mini)
                    }
                } else if status.isOutdated || status.isAppVersionMismatch || status.isBuildMismatch {
                    Button(action: {
                        store.syncEditor(id: status.id)
                    }) {
                        HStack(spacing: 3) {
                            Image(systemName: "arrow.triangle.2.circlepath")
                                .font(.system(size: 9, weight: .bold))
                            Text(status.isAppVersionMismatch || status.isBuildMismatch ? store.text("resync") : store.text("updateSingle"))
                                .font(.system(size: 10, weight: .semibold, design: .rounded))
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.orange)
                    .controlSize(.mini)
                } else {
                    Button(action: {
                        store.syncEditor(id: status.id)
                    }) {
                        HStack(spacing: 2) {
                            Image(systemName: "plus.circle")
                                .font(.system(size: 8.5, weight: .bold))
                            Text(store.text("syncSingle"))
                                .font(.system(size: 10, weight: .semibold, design: .rounded))
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.mini)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .contentShape(Rectangle())
    }

    private func iconName(for id: String) -> String {
        switch id {
        case "claude": return "bubble.left.and.text.bubble.right"
        case "cursor": return "chevron.left.forwardslash.chevron.right"
        case "antigravity": return "sparkles"
        case "opencode": return "cube.transparent"
        case "codex": return "terminal"
        default: return "cpu"
        }
    }
}

private extension ContentView {
    var preferredColorScheme: ColorScheme? {
        switch AppearancePreference(rawValue: appearance) ?? .system {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}
