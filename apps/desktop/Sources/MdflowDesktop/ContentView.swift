import SwiftUI

struct ContentView: View {
    @StateObject private var store = GraphStore()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor
    @AppStorage("mdflow.appearance") private var appearance = AppearancePreference.system.rawValue

    var body: some View {
        GeometryReader { proxy in
            let drawerWidth = detailDrawerWidth(totalWidth: proxy.size.width)
            HStack(spacing: 0) {
                sidebar.frame(width: 248)
                Divider()
                VStack(spacing: 0) {
                    canvasToolbar
                    Divider()
                    GraphCanvasView(store: store)
                        .overlay(alignment: .topLeading) { errorBanner }
                }
                if let selection = store.selection {
                    DetailView(store: store, selection: selection)
                        .frame(width: drawerWidth)
                        .background(MdflowTheme.surface)
                        .overlay(alignment: .leading) { Rectangle().fill(MdflowTheme.hairline).frame(width: 1) }
                        .shadow(color: .black.opacity(0.075), radius: 12, x: -4, y: 0)
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: store.selection)
        }
        .frame(minWidth: 1_080, minHeight: 680)
        .background(MdflowTheme.canvas)
        .preferredColorScheme(preferredColorScheme)
        .sheet(isPresented: $store.settingsPresented) { SettingsView(store: store) }
    }

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
                    sidebarSection(.projectRules, title: store.text("projectRules")) {
                        ForEach(projectRuleBlocks) { block in
                            sidebarButton(
                                title: store.blockText(block, field: "title"),
                                subtitle: "\(store.ruleScopeLabel(block.id).uppercased()) · \(block.deliveryState.uppercased())",
                                color: MdflowTheme.blockKindColor(block.kind),
                                selected: store.selection == GraphSelection(type: .block, id: block.id)
                            ) { store.select(GraphSelection(type: .block, id: block.id)) }
                        }
                    }

                    sidebarSection(.decisions, title: store.text("decisions")) {
                        ForEach(store.snapshot.decisions) { decision in
                            sidebarButton(
                                title: decision.title,
                                subtitle: "\(decision.status.uppercased()) · \(store.decisionScopeLabel(decision.id))",
                                color: MdflowTheme.blockKindColor("principle"),
                                selected: store.selection == GraphSelection(type: .decision, id: decision.id)
                            ) { store.select(GraphSelection(type: .decision, id: decision.id)) }
                        }
                    }

                    sidebarSection(.plans, title: store.text("plans")) {
                        ForEach(store.plans) { plan in
                            sidebarButton(
                                title: "\(plan.phase.uppercased()) \(plan.order) · \(store.planText(plan, field: "title"))",
                                subtitle: "\(plan.priority.uppercased()) · \(plan.derivedStatus.uppercased()) · \(plan.progress.completedSteps)/\(plan.progress.totalSteps)",
                                color: MdflowTheme.planColor(plan.derivedStatus),
                                selected: store.selection == GraphSelection(type: .plan, id: plan.id)
                            ) { store.focusPlan(plan.id) }
                        }
                    }

                    sidebarSection(.chains, title: store.text("chains")) {
                        ForEach(store.snapshot.chains) { chain in
                            sidebarButton(
                                title: store.chainText(chain, field: "title"),
                                subtitle: "\(store.chainNodeIDs(chain.id).count) BLOCKS · \(chain.deliveryState.uppercased())",
                                color: store.chainColor(chain.id),
                                selected: store.selection == GraphSelection(type: .chain, id: chain.id)
                            ) { store.select(GraphSelection(type: .chain, id: chain.id)) }
                        }
                    }

                    if !store.unassignedCheckpoints.isEmpty {
                        sidebarSection(.verification, title: store.text("verification")) {
                            Text(store.text("unassigned"))
                                .font(.system(size: 8, weight: .bold, design: .monospaced))
                                .foregroundStyle(MdflowTheme.muted)
                                .padding(.horizontal, 18).padding(.top, 4).padding(.bottom, 4)
                            ForEach(store.unassignedCheckpoints.filter {
                                $0.status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() != "passed"
                            }) { checkpoint in
                                if let type = GraphSelection.EntityType(rawValue: checkpoint.targetType) {
                                    sidebarButton(
                                        title: checkpoint.title,
                                        subtitle: "\(checkpoint.status.uppercased()) · \(store.checkpointOwner(checkpoint))",
                                        color: MdflowTheme.checkpointColor(checkpoint.status),
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
        .background(MdflowTheme.surface.opacity(0.97))
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
            .foregroundStyle(MdflowTheme.muted)
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
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                Text(store.snapshot.project.name)
                    .font(.system(size: 17, weight: .semibold, design: .rounded))
                    .foregroundStyle(MdflowTheme.ink).lineLimit(1)
                Text("\(store.snapshot.blocks.count) BLOCKS · \(store.snapshot.chains.count) CHAINS · \(store.snapshot.decisions.count) DECISIONS")
                    .font(.system(size: 8, weight: .bold, design: .monospaced)).tracking(0.8)
                    .foregroundStyle(MdflowTheme.muted)
                let coverage = store.architectureCoverage
                Text("\(coverage.verifiedBlocks)/\(coverage.totalBlocks) \(store.text("verified").uppercased()) · \(coverage.unplannedIDs.count) \(store.text("unplanned").uppercased()) · \(coverage.withoutCheckpointIDs.count) \(store.text("checkpointFree").uppercased()) · \(coverage.requiredCheckpointMissingIDs.count) REQUIRED · \(coverage.checkpointUnboundIDs.count) UNBOUND · \(coverage.chainGateMissingIDs.count) NO GATE")
                    .font(.system(size: 7.5, weight: .bold, design: .monospaced)).tracking(0.45)
                    .foregroundStyle(coverage.unplannedIDs.isEmpty && coverage.requiredCheckpointMissingIDs.isEmpty && coverage.checkpointUnboundIDs.isEmpty && coverage.chainGateMissingIDs.isEmpty ? MdflowTheme.success : MdflowTheme.pending)
            }
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
                    .font(.system(size: 10, weight: .semibold)).foregroundStyle(MdflowTheme.muted)
                    .frame(width: 28, height: 30)
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden)
        }
        .padding(18)
    }

    private func sidebarLabel(_ value: String) -> some View {
        Text(value.uppercased())
            .font(.system(size: 9, weight: .bold, design: .monospaced)).tracking(1.35)
            .foregroundStyle(MdflowTheme.muted)
            .padding(.horizontal, 18).padding(.top, 17).padding(.bottom, 7)
    }

    private func sidebarButton(title: String, subtitle: String, color: Color, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 2).fill(color).frame(width: 4, height: 30)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.system(size: 11.5, weight: .medium, design: .rounded)).foregroundStyle(MdflowTheme.ink).lineLimit(2)
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
                .foregroundStyle(MdflowTheme.ink)
            }
            Spacer()
            Text("\(Int((store.canvasScale * 100).rounded()))%")
                .font(.system(size: 9, weight: .semibold, design: .monospaced)).foregroundStyle(MdflowTheme.muted)
                .help(store.activeLocale == "zh-Hans" ? "触控板捏合、⌘滚动或双击缩放" : "Pinch, ⌘-scroll, or double-click to zoom")
            Button { store.settingsPresented = true } label: {
                Label(store.text("settings"), systemImage: "gearshape")
                    .font(.system(size: 11, weight: .semibold, design: .rounded)).foregroundStyle(MdflowTheme.ink)
                    .padding(.horizontal, 9).frame(height: 30)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16).frame(height: 50)
        .background(MdflowTheme.surface.opacity(0.96))
    }

    private var legend: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text((store.activeLocale == "zh-Hans" ? "图例" : "LEGEND").uppercased())
                .font(.system(size: 8, weight: .bold, design: .monospaced)).tracking(1.2).foregroundStyle(MdflowTheme.muted)
            HStack(spacing: 10) {
                legendItem(color: MdflowTheme.blockKindColor("ui"), text: store.text("ui"))
                legendItem(color: MdflowTheme.blockKindColor("service"), text: store.text("service"))
                legendItem(color: MdflowTheme.blockKindColor("database"), text: store.text("data"))
            }
            HStack(spacing: 10) {
                legendItem(color: MdflowTheme.deliveryColor("complete"), text: store.activeLocale == "zh-Hans" ? "完成" : "Done")
                legendItem(color: MdflowTheme.deliveryColor("implementing"), text: store.activeLocale == "zh-Hans" ? "进行中" : "Active")
                legendItem(color: MdflowTheme.failure, text: store.activeLocale == "zh-Hans" ? "失败/阻塞" : "Failed")
            }
            Text(store.activeLocale == "zh-Hans" ? "左侧色条＝Block 类型 · 图标＝交付状态 · 线色/虚线＝关系类型 · 外框＝Chain" : "Left rail = Block type · icon = delivery · line = Link kind · enclosure = Chain")
                .font(.system(size: 9.5, design: .rounded)).foregroundStyle(MdflowTheme.muted).fixedSize(horizontal: false, vertical: true)
            if differentiateWithoutColor {
                Text(store.activeLocale == "zh-Hans" ? "已启用无色彩区分：状态同时使用文字、图标和虚线。" : "Differentiation without color is on: status also uses text, icons, and dashes.")
                    .font(.system(size: 8.5, weight: .medium, design: .rounded))
                    .foregroundStyle(MdflowTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
    }

    private func legendItem(color: Color, text: String) -> some View {
        HStack(spacing: 4) { Circle().fill(color).frame(width: 6, height: 6); Text(text) }
            .font(.system(size: 8.5, weight: .medium, design: .rounded)).foregroundStyle(MdflowTheme.ink.opacity(0.8))
    }

    private var projectRuleBlocks: [BlockItem] {
        let ids = Set(store.snapshot.backgroundScopes.map(\.blockId))
        return store.snapshot.blocks.filter { ids.contains($0.id) }
    }

    @ViewBuilder
    private var errorBanner: some View {
        if let error = store.errorMessage {
            VStack(alignment: .leading, spacing: 9) {
                Text(error).font(.system(size: 11, weight: .medium, design: .rounded)).foregroundStyle(MdflowTheme.failure)
                Button(store.text("openProject")) { store.chooseProject() }.buttonStyle(.borderedProminent).controlSize(.small)
            }
            .padding(14).background(MdflowTheme.surface).clipShape(RoundedRectangle(cornerRadius: 10)).padding(16)
        }
    }
}

private struct SettingsView: View {
    @ObservedObject var store: GraphStore
    @Environment(\.dismiss) private var dismiss
    @AppStorage("mdflow.appearance") private var appearance = AppearancePreference.system.rawValue

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack { Text(store.text("settings")).font(.system(size: 20, weight: .semibold, design: .rounded)); Spacer(); Button(store.text("done")) { dismiss() } }
            VStack(alignment: .leading, spacing: 8) {
                label(store.text("language"))
                Picker(store.text("language"), selection: $store.language) {
                    Text(store.text("system")).tag(AppLanguage.system); Text(store.text("chinese")).tag(AppLanguage.zhHans); Text(store.text("english")).tag(AppLanguage.english)
                }.pickerStyle(.segmented)
            }
            VStack(alignment: .leading, spacing: 8) {
                label(store.text("appearance"))
                Picker(store.text("appearance"), selection: $appearance) {
                    Text(store.text("system")).tag(AppearancePreference.system.rawValue)
                    Text(store.text("light")).tag(AppearancePreference.light.rawValue)
                    Text(store.text("dark")).tag(AppearancePreference.dark.rawValue)
                }
                .pickerStyle(.segmented)
                .accessibilityLabel(store.text("appearance"))
            }
            VStack(alignment: .leading, spacing: 8) {
                label(store.text("plugin")); Text(store.text("pluginHelp")).font(.system(size: 12, design: .rounded))
                HStack {
                    Button(store.pluginInstallStatus == .installing ? store.text("installingPlugin") : store.text("installPlugin")) { store.installPlugin() }
                        .buttonStyle(.borderedProminent).disabled(store.pluginInstallStatus == .installing)
                    Button(store.text("revealPlugin")) { store.revealPlugin() }
                }
                if case .installed = store.pluginInstallStatus { Label(store.text("pluginInstalled"), systemImage: "checkmark.circle.fill").foregroundStyle(MdflowTheme.success) }
                if case .failed(let message) = store.pluginInstallStatus { Text("\(store.text("pluginInstallFailed")): \(message)").foregroundStyle(MdflowTheme.failure) }
            }
            VStack(alignment: .leading, spacing: 8) {
                label(store.text("liveData")); Text(store.databasePath).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(MdflowTheme.muted).textSelection(.enabled)
                Text(store.text("liveHelp")).font(.system(size: 12, design: .rounded)); Button(store.text("changeProject")) { store.chooseProject() }
            }
            Spacer()
        }
        .padding(28).frame(width: 480, height: 410)
    }

    private func label(_ value: String) -> some View {
        Text(value.uppercased()).font(.system(size: 9, weight: .bold, design: .monospaced)).tracking(1.4).foregroundStyle(MdflowTheme.muted)
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
