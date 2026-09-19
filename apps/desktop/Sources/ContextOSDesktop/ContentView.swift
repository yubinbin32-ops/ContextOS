import SwiftUI
import UniformTypeIdentifiers

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
            var initialized = false
            while !Task.isCancelled {
                await knowledge.reload(root: root)
                let issues = store.knowledgeSyncIssues()
                if syncIssues != issues { syncIssues = issues }
                if !initialized {
                    initialized = true
                }
                try? await Task.sleep(for: .seconds(2))
            }
        }
        .onChange(of: store.selection) { _, value in
            if value != nil {
                closeDocument()
            }
        }
        .onChange(of: store.projectRoot) { _, _ in
            closeDocument()
        }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("OpenKnowledgeDocument"))) { event in
            if let id = event.userInfo?["id"] as? String { openDocument(id, nil) }
        }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("ChooseProject"))) { _ in
            store.chooseProject()
        }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("OpenSpecificProject"))) { notif in
            if let path = notif.userInfo?["path"] as? String {
                store.openProject(RecentProject(path: path, name: URL(fileURLWithPath: path).lastPathComponent))
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("RecentProjectsChanged"))) { _ in
            store.refreshRecentProjects()
        }
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            guard let provider = providers.first else { return false }
            _ = provider.loadObject(ofClass: URL.self) { url, _ in
                if let url = url {
                    DispatchQueue.main.async {
                        store.openKnowledgeProject(at: url)
                    }
                }
            }
            return true
        }
        .onOpenURL { url in
            guard url.scheme == "contextos" else { return }
            if url.host == "knowledge",
                let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) {
                if let project = parts.queryItems?.first(where: { $0.name == "project" })?.value, project != store.projectRoot {
                    store.openKnowledgeProject(at: URL(fileURLWithPath: project))
                }
                if let id = parts.queryItems?.first(where: { $0.name == "document" })?.value {
                    Task { await knowledge.reload(root: store.projectRoot); openDocument(id, parts.queryItems?.first(where: { $0.name == "section" })?.value) }
                }
            } else if url.host == "select",
                let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) {
                closeDocument()
                let typeStr = parts.queryItems?.first(where: { $0.name == "type" })?.value ?? "plan"
                let id = parts.queryItems?.first(where: { $0.name == "id" })?.value ?? ""
                if typeStr == "plan" {
                    store.focusPlan(id.isEmpty ? (store.snapshot.plans.first?.id ?? "plan-v2-rebuild") : id)
                } else if typeStr == "decision" {
                    store.select(GraphSelection(type: .decision, id: id))
                } else if typeStr == "block" {
                    store.select(GraphSelection(type: .block, id: id))
                }
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
                        ForEach(knowledge.documents.filter { $0.kind == "readme" }) { doc in
                            sidebarButton(title: doc.title, subtitle: store.activeLocale == "zh-Hans" ? "仓库原文件 · 只读" : "REPOSITORY · READ ONLY", color: ContextOSTheme.blockKindColor("principle"), selected: requestedDocument == doc.id) { openDocument(doc.id, nil) }
                        }
                        if knowledge.documents.filter({ $0.kind == "readme" }).isEmpty { Text(store.activeLocale == "zh-Hans" ? "README 与项目文档" : "README and project documents").font(.caption).foregroundStyle(.secondary).padding(.horizontal, 18) }
                    }
                    if !syncIssues.isEmpty || store.sourcePollingError != nil {
                        sidebarSection(.synchronization, title: store.activeLocale == "zh-Hans" ? "同步检查 (\(syncIssues.count))" : "Sync checks (\(syncIssues.count))") {
                            if let error = store.sourcePollingError { Text(error).font(.caption).foregroundStyle(.orange).padding(.horizontal, 18) }
                            ForEach(syncIssues, id: \.self) { Text($0).font(.caption).foregroundStyle(ContextOSTheme.muted).textSelection(.enabled).padding(.horizontal, 18).padding(.vertical, 4) }
                        }
                    }
                    let ruleDocs = knowledge.documents.filter { $0.kind == "rule" }
                    if !ruleDocs.isEmpty || !projectRuleBlocks.isEmpty {
                        sidebarSection(.projectRules, title: store.text("projectRules")) {
                            ForEach(ruleDocs) { rule in
                                sidebarButton(
                                    title: rule.title,
                                    subtitle: store.activeLocale == "zh-Hans" ? "规范 · 只读" : "RULE · SPEC",
                                    color: ContextOSTheme.blockKindColor("principle"),
                                    selected: requestedDocument == rule.id
                                ) { openDocument(rule.id, nil) }
                            }
                            ForEach(projectRuleBlocks) { block in
                                sidebarButton(
                                    title: store.blockText(block, field: "title"),
                                    subtitle: "\(store.ruleScopeLabel(block.id).uppercased()) · \(block.deliveryState.uppercased())",
                                    color: ContextOSTheme.blockKindColor(block.kind),
                                    selected: store.selection == GraphSelection(type: .block, id: block.id)
                                ) { store.select(GraphSelection(type: .block, id: block.id)) }
                            }
                        }
                    }

                    if let decisionDoc = knowledge.documents.first(where: { $0.id == "DECISION.md" }) {
                        sidebarSection(.decisions, title: store.text("decisions")) {
                            sidebarButton(
                                title: "DECISION.md",
                                subtitle: store.activeLocale == "zh-Hans" ? "架构决策记录 · 只读" : "ADR · READ ONLY",
                                color: ContextOSTheme.blockKindColor("principle"),
                                selected: requestedDocument == decisionDoc.id
                            ) {
                                openDocument(decisionDoc.id, nil)
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
                                    ? (store.chainMembers(for: chain.id).isEmpty
                                        ? "EMPTY COMPOSITE · REPAIR IN OS · \(chain.deliveryState.uppercased())"
                                        : "\(store.chainMembers(for: chain.id).count) STAGES · \(store.chainBlockIDs(chain.id).count) BLOCKS · COMPOSITE · \(chain.deliveryState.uppercased())")
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
            runningProcessesSection
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
            let isCloudProject = store.snapshot.project.name.contains("(Cloud)") || store.projectRoot.contains(".contextos/cloud_projects")
            HStack(alignment: .center, spacing: 6) {
                Menu {
                    if !store.recentProjects.isEmpty {
                        Section(store.text("recentProjects")) {
                            ForEach(store.recentProjects) { project in
                                Button {
                                    store.openProject(project)
                                } label: {
                                    let isCurrent = project.path == store.projectRoot
                                    let isCloud = project.name.contains("(Cloud)") || project.path.contains(".contextos/cloud_projects")
                                    Label(
                                        project.name,
                                        systemImage: isCurrent ? "checkmark" : (isCloud ? "cloud" : "folder")
                                    )
                                }
                            }
                        }
                        Divider()
                        Menu(store.activeLocale == "zh-Hans" ? "管理最近列表" : "Manage Recents") {
                            ForEach(store.recentProjects) { project in
                                Button(role: .destructive) {
                                    store.removeRecentProject(project)
                                } label: {
                                    Label(store.activeLocale == "zh-Hans" ? "移除 \(project.name)" : "Remove \(project.name)", systemImage: "trash")
                                }
                            }
                            Divider()
                            Button(role: .destructive) {
                                store.clearRecentProjects()
                            } label: {
                                Text(store.activeLocale == "zh-Hans" ? "清空所有最近记录" : "Clear All Recents")
                            }
                        }
                        Divider()
                    }
                    Button(store.text("openProject")) { store.chooseProject() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: isCloudProject ? "cloud.fill" : "folder.fill")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(ContextOSTheme.focus)
                        Text(store.snapshot.project.name)
                            .font(.system(size: 15, weight: .semibold, design: .rounded))
                            .foregroundStyle(ContextOSTheme.ink)
                            .lineLimit(1)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(ContextOSTheme.muted)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(ContextOSTheme.surface, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 7, style: .continuous)
                            .stroke(ContextOSTheme.hairline, lineWidth: 1)
                    )
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .help(store.activeLocale == "zh-Hans" ? "点击切换项目或查看最近项目 (⌘O 打开)" : "Click to switch project or view recents (⌘O to open)")

                if isCloudProject {
                    Button {
                        Task { await store.refreshCloudProject() }
                    } label: {
                        Image(systemName: "arrow.triangle.2.circlepath")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(ContextOSTheme.focus)
                    }
                    .buttonStyle(.plain)
                    .help(store.activeLocale == "zh-Hans" ? "从云端中枢拉取最新图谱" : "Sync latest graph from cloud")
                }
                Spacer()
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
            Button { store.fitOverview() } label: {
                Image(systemName: "arrow.up.left.and.arrow.down.right")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(ContextOSTheme.ink)
            }
            .buttonStyle(.plain)
            .help(store.activeLocale == "zh-Hans" ? "居中自适应视图" : "Fit overview")
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

    private var runningProcessesSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(store.activeLocale == "zh-Hans" ? "持续运行命令" : "RUNNING PROCESSES")
                    .font(.system(size: 8.5, weight: .bold, design: .monospaced))
                    .tracking(1.2)
                    .foregroundStyle(ContextOSTheme.muted)
                Spacer()
                if !store.runningProcesses.isEmpty {
                    Text("\(store.runningProcesses.count)")
                        .font(.system(size: 8, weight: .bold, design: .monospaced))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(ContextOSTheme.focus.opacity(0.15))
                        .foregroundStyle(ContextOSTheme.focus)
                        .clipShape(Capsule())
                }
            }

            if store.runningProcesses.isEmpty {
                HStack(spacing: 5) {
                    Circle().fill(ContextOSTheme.muted.opacity(0.3)).frame(width: 5, height: 5)
                    Text(store.activeLocale == "zh-Hans" ? "暂无运行中的长期任务" : "No active background tasks")
                        .font(.system(size: 8.5, weight: .medium, design: .rounded))
                        .foregroundStyle(ContextOSTheme.muted)
                }
                .padding(.vertical, 2)
            } else {
                VStack(spacing: 4) {
                    ForEach(store.runningProcesses) { proc in
                        HStack(spacing: 8) {
                            Circle()
                                .fill(proc.isRunning ? ContextOSTheme.success : ContextOSTheme.muted)
                                .frame(width: 6, height: 6)

                            VStack(alignment: .leading, spacing: 2) {
                                Text(proc.command)
                                    .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
                                    .foregroundStyle(ContextOSTheme.ink)
                                    .lineLimit(1)

                                HStack(spacing: 6) {
                                    Text("PID \(proc.pid)")
                                        .font(.system(size: 8, weight: .medium, design: .monospaced))
                                        .foregroundStyle(ContextOSTheme.muted)
                                    if let port = proc.port {
                                        Text(":\(port)")
                                            .font(.system(size: 8, weight: .bold, design: .monospaced))
                                            .foregroundStyle(ContextOSTheme.focus)
                                    }
                                }
                            }

                            Spacer()

                            Button {
                                store.stopProcess(id: proc.id)
                            } label: {
                                Image(systemName: "stop.circle.fill")
                                    .font(.system(size: 13))
                                    .foregroundStyle(ContextOSTheme.failure.opacity(0.85))
                            }
                            .buttonStyle(.plain)
                            .help(store.activeLocale == "zh-Hans" ? "停止此长期任务" : "Stop process")
                        }
                        .padding(6)
                        .background(ContextOSTheme.surface)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                        .overlay(
                            RoundedRectangle(cornerRadius: 6)
                                .stroke(ContextOSTheme.hairline, lineWidth: 0.8)
                        )
                    }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
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

            HStack(alignment: .top, spacing: 16) {
                // Left Column: 偏好设置 + 软件更新 + 数据内核
                VStack(alignment: .leading, spacing: 12) {
                    // Group 1: 偏好设置 (PREFERENCES)
                    VStack(alignment: .leading, spacing: 5) {
                        sectionHeader(store.activeLocale == "zh-Hans" ? "偏好设置" : "PREFERENCES")
                        VStack(spacing: 0) {
                            HStack {
                                Label {
                                    Text(store.text("language"))
                                        .font(.system(size: 12, weight: .medium, design: .rounded))
                                        .foregroundStyle(ContextOSTheme.ink)
                                } icon: {
                                    Image(systemName: "globe")
                                        .font(.system(size: 12, weight: .medium))
                                        .foregroundStyle(ContextOSTheme.muted)
                                        .frame(width: 18)
                                }
                                Spacer()
                                Picker("", selection: $store.language) {
                                    Text(store.text("system")).tag(AppLanguage.system)
                                    Text(store.text("chinese")).tag(AppLanguage.zhHans)
                                    Text(store.text("english")).tag(AppLanguage.english)
                                }
                                .pickerStyle(.menu)
                                .frame(width: 105)
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)

                            Divider().padding(.leading, 32)

                            HStack {
                                Label {
                                    Text(store.text("appearance"))
                                        .font(.system(size: 12, weight: .medium, design: .rounded))
                                        .foregroundStyle(ContextOSTheme.ink)
                                } icon: {
                                    Image(systemName: "circle.righthalf.filled")
                                        .font(.system(size: 12, weight: .medium))
                                        .foregroundStyle(ContextOSTheme.muted)
                                        .frame(width: 18)
                                }
                                Spacer()
                                Picker("", selection: $appearance) {
                                    Text(store.text("system")).tag(AppearancePreference.system.rawValue)
                                    Text(store.text("light")).tag(AppearancePreference.light.rawValue)
                                    Text(store.text("dark")).tag(AppearancePreference.dark.rawValue)
                                }
                                .pickerStyle(.menu)
                                .frame(width: 105)
                                .accessibilityLabel(store.text("appearance"))
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                        }
                        .background(RoundedRectangle(cornerRadius: 10).fill(ContextOSTheme.card))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(ContextOSTheme.hairline, lineWidth: 0.8))
                    }

                    // Group 2: 软件更新 (SOFTWARE UPDATE)
                    SoftwareUpdateSection(store: store)

                    // Group 3: 数据存储与内核 (DATA ENGINE & STORAGE)
                    VStack(alignment: .leading, spacing: 5) {
                        sectionHeader(store.text("liveData").uppercased())

                        VStack(spacing: 0) {
                            HStack(alignment: .center) {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(store.activeLocale == "zh-Hans" ? "当前数据库" : "DATABASE")
                                        .font(.system(size: 8, weight: .bold, design: .monospaced))
                                        .tracking(0.7)
                                        .foregroundStyle(ContextOSTheme.muted)
                                    Text(store.databasePath)
                                        .font(.system(size: 10, design: .monospaced))
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
                                .controlSize(.mini)
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)

                            Divider().padding(.leading, 12)

                            HStack {
                                HStack(spacing: 4) {
                                    Circle().fill(ContextOSTheme.success).frame(width: 5, height: 5)
                                    Text(store.text("liveHelp"))
                                        .font(.system(size: 10, design: .rounded))
                                        .foregroundStyle(ContextOSTheme.muted)
                                }
                                Spacer()
                                Text("SQLITE · GRAPH.JSON")
                                    .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                                    .tracking(0.8)
                                    .foregroundStyle(ContextOSTheme.muted)
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                        }
                        .background(RoundedRectangle(cornerRadius: 10).fill(ContextOSTheme.card))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(ContextOSTheme.hairline, lineWidth: 0.8))
                    }
                }
                .frame(width: 320)

                // Right Column: AI 编辑器集成 (AI CLIENT MCP BRIDGES)
                VStack(alignment: .leading, spacing: 5) {
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
                                Divider().padding(.leading, 46)
                            }
                            EditorPlatformRow(status: status, store: store)
                        }
                    }
                    .background(RoundedRectangle(cornerRadius: 10).fill(ContextOSTheme.card))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(ContextOSTheme.hairline, lineWidth: 0.8))

                    Text(store.runtimeHandshake)
                        .font(.system(size: 9.5, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .padding(.top, 2)
                    Text(store.text("pluginHelp"))
                        .font(.system(size: 10, design: .rounded))
                        .foregroundStyle(ContextOSTheme.muted)
                        .padding(.horizontal, 4)
                        .padding(.top, 1)
                }
                .frame(width: 340)
            }
            .padding(.horizontal, 20)
            .padding(.top, 14)
            .padding(.bottom, 18)
        }
        .frame(width: 716)
        .background(ContextOSTheme.surface.ignoresSafeArea())
        .onAppear {
            store.updater.checkOnSettingsOpen()
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 9.5, weight: .bold, design: .monospaced))
            .tracking(1.1)
            .foregroundStyle(ContextOSTheme.muted)
            .padding(.leading, 6)
    }
}

private struct SoftwareUpdateSection: View {
    @ObservedObject var store: GraphStore
    @State private var isEditingRepo = false
    @State private var customRepoInput = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionHeader(store.text("softwareUpdate").uppercased())

            VStack(spacing: 0) {
                // 1. Current App Info & Status Row
                HStack(spacing: 12) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 6.5)
                            .fill(ContextOSTheme.card)
                            .overlay(
                                RoundedRectangle(cornerRadius: 6.5)
                                    .stroke(Color.black.opacity(0.07), lineWidth: 0.75)
                            )
                        Image(systemName: "arrow.triangle.2.circlepath")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(ContextOSTheme.ink)
                    }
                    .frame(width: 26, height: 26)

                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text("ContextOS")
                                .font(.system(size: 12, weight: .semibold, design: .rounded))
                                .foregroundStyle(ContextOSTheme.ink)
                            Text("v\(store.updater.currentAppVersion)")
                                .font(.system(size: 10, weight: .bold, design: .monospaced))
                                .foregroundStyle(ContextOSTheme.muted)
                                .padding(.horizontal, 4.5)
                                .padding(.vertical, 1)
                                .background(Capsule().fill(Color.black.opacity(0.04)))
                        }

                        // Status subtitle line
                        switch store.updater.state {
                        case .idle:
                            Text(store.text("checkUpdate"))
                                .font(.system(size: 10, design: .rounded))
                                .foregroundStyle(ContextOSTheme.muted)
                        case .checking:
                            HStack(spacing: 4) {
                                ProgressView()
                                    .controlSize(.mini)
                                Text(store.text("checkingUpdate"))
                                    .font(.system(size: 10, design: .rounded))
                                    .foregroundStyle(ContextOSTheme.muted)
                            }
                        case .upToDate:
                            HStack(spacing: 4) {
                                Circle().fill(ContextOSTheme.success).frame(width: 5, height: 5)
                                Text(store.text("upToDate"))
                                    .font(.system(size: 10, design: .rounded))
                                    .foregroundStyle(ContextOSTheme.muted)
                            }
                        case .updateAvailable(let latest, _):
                            HStack(spacing: 4) {
                                Circle().fill(ContextOSTheme.focus).frame(width: 5, height: 5)
                                Text("\(store.text("newVersionFound")): v\(latest.version)")
                                    .font(.system(size: 10, weight: .medium, design: .rounded))
                                    .foregroundStyle(ContextOSTheme.focus)
                            }
                        case .downloading(let progress, _, _):
                            HStack(spacing: 4) {
                                Text("\(store.text("downloadingUpdate")) \(Int(progress * 100))%")
                                    .font(.system(size: 10, design: .rounded))
                                    .foregroundStyle(ContextOSTheme.focus)
                            }
                        case .readyToInstall:
                            HStack(spacing: 4) {
                                Circle().fill(ContextOSTheme.success).frame(width: 5, height: 5)
                                Text(store.text("restartAndUpdate"))
                                    .font(.system(size: 10, weight: .medium, design: .rounded))
                                    .foregroundStyle(ContextOSTheme.success)
                            }
                        case .installing:
                            HStack(spacing: 4) {
                                ProgressView()
                                    .controlSize(.mini)
                                Text(store.text("updating"))
                                    .font(.system(size: 10, design: .rounded))
                                    .foregroundStyle(ContextOSTheme.muted)
                            }
                        case .failed(let msg):
                            HStack(spacing: 4) {
                                Image(systemName: "exclamationmark.circle.fill")
                                    .font(.system(size: 10))
                                    .foregroundStyle(ContextOSTheme.failure)
                                Text(msg)
                                    .font(.system(size: 10, design: .rounded))
                                    .foregroundStyle(ContextOSTheme.failure)
                                    .lineLimit(1)
                            }
                        }
                    }

                    Spacer()

                    // Action button on header row
                    switch store.updater.state {
                    case .checking:
                        ProgressView()
                            .controlSize(.small)
                    case .idle, .upToDate:
                        Button(store.text("checkUpdate")) {
                            Task { await store.updater.checkForUpdates(force: true) }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    case .failed:
                        Button(store.text("retry")) {
                            Task { await store.updater.checkForUpdates(force: true) }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    default:
                        EmptyView()
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)

                // 2. Selection & Update Details Area (When update available / downloading / ready)
                if case .updateAvailable(let latest, let releases) = store.updater.state {
                    renderUpdateControls(latest: latest, releases: releases)
                } else if case .downloading(let progress, let written, let total) = store.updater.state {
                    renderDownloadingProgress(progress: progress, written: written, total: total)
                } else if case .readyToInstall(let stagedURL, let version) = store.updater.state {
                    renderReadyToInstall(stagedURL: stagedURL, version: version)
                }

                Divider().padding(.leading, 14)

                // 3. Git Repo & Remote Source Row
                HStack {
                    HStack(spacing: 5) {
                        Image(systemName: "arrow.triangle.branch")
                            .font(.system(size: 10))
                            .foregroundStyle(ContextOSTheme.muted)
                        Text(store.text("gitRepository"))
                            .font(.system(size: 10.5, design: .rounded))
                            .foregroundStyle(ContextOSTheme.muted)
                    }

                    Spacer()

                    if isEditingRepo {
                        TextField("owner/repo", text: $customRepoInput)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(size: 10, design: .monospaced))
                            .frame(width: 180)
                            .onSubmit {
                                let trimmed = customRepoInput.trimmingCharacters(in: .whitespacesAndNewlines)
                                if !trimmed.isEmpty {
                                    store.updater.repository = trimmed
                                    Task { await store.updater.checkForUpdates(force: true) }
                                }
                                isEditingRepo = false
                            }
                        Button("确定") {
                            let trimmed = customRepoInput.trimmingCharacters(in: .whitespacesAndNewlines)
                            if !trimmed.isEmpty {
                                store.updater.repository = trimmed
                                Task { await store.updater.checkForUpdates(force: true) }
                            }
                            isEditingRepo = false
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.mini)
                    } else {
                        Button {
                            customRepoInput = store.updater.repository
                            isEditingRepo = true
                        } label: {
                            HStack(spacing: 4) {
                                Text(store.updater.repository)
                                    .font(.system(size: 9.5, weight: .medium, design: .monospaced))
                                    .foregroundStyle(ContextOSTheme.ink)
                                Image(systemName: "pencil")
                                    .font(.system(size: 9))
                                    .foregroundStyle(ContextOSTheme.muted)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
            }
            .background(RoundedRectangle(cornerRadius: 10).fill(ContextOSTheme.card))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(ContextOSTheme.hairline, lineWidth: 0.8))
        }
    }

    @ViewBuilder
    private func renderUpdateControls(latest: AppRelease, releases: [AppRelease]) -> some View {
        let currentTarget = releases.first(where: { $0.id == store.updater.selectedReleaseId }) ?? latest

        VStack(spacing: 0) {
            Divider().padding(.leading, 14)

            // Version Selector
            HStack {
                Label {
                    Text(store.text("selectVersion"))
                        .font(.system(size: 11, weight: .medium, design: .rounded))
                        .foregroundStyle(ContextOSTheme.ink)
                } icon: {
                    Image(systemName: "tag")
                        .font(.system(size: 11))
                        .foregroundStyle(ContextOSTheme.muted)
                        .frame(width: 16)
                }
                Spacer()
                Picker("", selection: Binding(
                    get: { store.updater.selectedReleaseId ?? latest.id },
                    set: { store.updater.selectedReleaseId = $0 }
                )) {
                    ForEach(releases) { rel in
                        Text("\(rel.name)\(rel.id == latest.id ? " (最新)" : "")")
                            .tag(rel.id)
                    }
                }
                .pickerStyle(.menu)
                .frame(width: 150)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 6)

            Divider().padding(.leading, 38)

            // Edition Selector (Full vs Standard)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Label {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(store.text("selectEdition"))
                                .font(.system(size: 11, weight: .medium, design: .rounded))
                                .foregroundStyle(ContextOSTheme.ink)
                            if let asset = currentTarget.asset(for: store.updater.selectedEdition) {
                                Text(asset.formattedSize)
                                    .font(.system(size: 9, design: .monospaced))
                                    .foregroundStyle(ContextOSTheme.muted)
                            }
                        }
                    } icon: {
                        Image(systemName: "shippingbox")
                            .font(.system(size: 11))
                            .foregroundStyle(ContextOSTheme.muted)
                            .frame(width: 16)
                    }
                    Spacer()
                    Picker("", selection: $store.updater.selectedEdition) {
                        Text(store.activeLocale == "zh-Hans" ? "全功能版" : "Full").tag(UpdateEdition.full)
                        Text(store.activeLocale == "zh-Hans" ? "轻量版" : "Standard").tag(UpdateEdition.standard)
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 135)
                }

                // Node qualification badge
                HStack(spacing: 4) {
                    if store.updater.nodeEnvironment.isQualified {
                        Circle().fill(ContextOSTheme.success).frame(width: 5, height: 5)
                        Text(store.activeLocale == "zh-Hans"
                             ? "系统 Node 22+ 合格 (推荐轻量版)"
                             : "System Node 22+ qualified (Standard recommended)")
                            .font(.system(size: 8.5, design: .rounded))
                            .foregroundStyle(ContextOSTheme.muted)
                    } else {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 8.5))
                            .foregroundStyle(ContextOSTheme.failure)
                        Text(store.activeLocale == "zh-Hans"
                             ? "系统未检测到 Node 22+ (已默认选全功能版)"
                             : "Node 22+ missing locally, Full edition auto-selected")
                            .font(.system(size: 8.5, weight: .medium, design: .rounded))
                            .foregroundStyle(ContextOSTheme.failure)
                    }
                }
                .padding(.leading, 26)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 6)

            // Release Notes Toggle & Box
            if !currentTarget.body.isEmpty {
                Divider().padding(.leading, 38)

                VStack(alignment: .leading, spacing: 6) {
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            store.updater.showReleaseNotes.toggle()
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: store.updater.showReleaseNotes ? "chevron.down" : "chevron.right")
                                .font(.system(size: 8, weight: .semibold))
                            Text(store.updater.showReleaseNotes ? store.text("hideReleaseNotes") : store.text("viewReleaseNotes"))
                                .font(.system(size: 10, weight: .medium, design: .rounded))
                            Spacer()
                        }
                        .foregroundStyle(ContextOSTheme.focus)
                    }
                    .buttonStyle(.plain)

                    if store.updater.showReleaseNotes {
                        ScrollView(.vertical) {
                            Text(currentTarget.body)
                                .font(.system(size: 9.5, design: .monospaced))
                                .foregroundStyle(ContextOSTheme.ink.opacity(0.85))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(8)
                                .textSelection(.enabled)
                        }
                        .frame(maxHeight: 120)
                        .background(RoundedRectangle(cornerRadius: 6).fill(ContextOSTheme.card))
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(ContextOSTheme.hairline, lineWidth: 0.5))
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
            }

            Divider().padding(.leading, 14)

            // Action Buttons
            HStack {
                Button(store.text("openInBrowser")) {
                    NSWorkspace.shared.open(currentTarget.htmlUrl)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)

                Spacer()

                Button {
                    store.updater.downloadAndApplyUpdate(release: currentTarget, edition: store.updater.selectedEdition)
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.down.circle.fill")
                        Text(store.text("updateNow"))
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        }
    }

    @ViewBuilder
    private func renderDownloadingProgress(progress: Double, written: Int64, total: Int64) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider().padding(.leading, 14)

            HStack {
                Text(store.text("downloadingUpdate"))
                    .font(.system(size: 11, weight: .medium, design: .rounded))
                    .foregroundStyle(ContextOSTheme.ink)
                Spacer()
                Text("\(ByteCountFormatter.string(fromByteCount: written, countStyle: .file)) / \(ByteCountFormatter.string(fromByteCount: total, countStyle: .file))")
                    .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                    .foregroundStyle(ContextOSTheme.muted)
            }

            ProgressView(value: progress, total: 1.0)
                .progressViewStyle(.linear)

            HStack {
                Spacer()
                Button(store.text("cancelDownload")) {
                    store.updater.cancelDownload()
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private func renderReadyToInstall(stagedURL: URL, version: String) -> some View {
        VStack(spacing: 8) {
            Divider().padding(.leading, 14)

            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("新版本 v\(version) 下载完成")
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .foregroundStyle(ContextOSTheme.ink)
                    Text("点击下方按钮将自动安全替换并重启 ContextOS")
                        .font(.system(size: 9.5, design: .rounded))
                        .foregroundStyle(ContextOSTheme.muted)
                }
                Spacer()
                Button {
                    store.updater.installAndRelaunch(stagedAppURL: stagedURL)
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.clockwise.circle.fill")
                        Text(store.text("restartAndUpdate"))
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
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
                    .fill(ContextOSTheme.card)
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
