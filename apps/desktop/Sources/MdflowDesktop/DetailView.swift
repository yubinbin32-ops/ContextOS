import AppKit
import SwiftUI

struct DetailView: View {
    @ObservedObject var store: GraphStore
    let selection: GraphSelection
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expandedScopeIDs: Set<String> = []
    @State private var expandedChangeIDs: Set<String> = []
    @State private var expandedStepIDs: Set<String> = []
    @State private var expandedCheckpointIDs: Set<String> = []
    @State private var expandedHistoryIDs: Set<Int> = []
    @State private var showCodeStream = false
    @State private var copiedStreamChainID: String? = nil

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top) {
                    Text(store.title(for: selection))
                        .font(.system(size: 17, weight: .semibold, design: .rounded))
                        .foregroundStyle(MdflowTheme.ink)
                        .lineLimit(3)
                    Spacer()
                    Button { store.clearSelection() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 11, weight: .semibold))
                    }
                    .buttonStyle(.plain)
                    .help(store.activeLocale == "zh-Hans" ? "关闭详情" : "Close details")
                }
                entityContent
                revisionSection
                checkpointSection
                historySection
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 16)
        }
        .background(MdflowTheme.surface)
    }

    @ViewBuilder
    private var entityContent: some View {
        switch selection.type {
        case .block:
            if let block = store.snapshot.blocks.first(where: { $0.id == selection.id }) {
                HStack(spacing: 8) {
                    metadataLabel(block.architectureLayer)
                    metadataSeparator
                    metadataLabel(block.scope)
                    let ruleScope = store.ruleScopeLabel(block.id)
                    if !ruleScope.isEmpty {
                        metadataSeparator
                        metadataLabel(store.activeLocale == "zh-Hans" ? "规则 · \(ruleScope)" : "RULE · \(ruleScope)")
                    }
                    if block.localOrder != 0 {
                        metadataSeparator
                        metadataLabel("#\(block.localOrder)")
                    }
                }
                HStack(spacing: 8) {
                    if block.isGhost {
                        HStack(spacing: 5) {
                            Image(systemName: "sparkles")
                            Text(store.activeLocale == "zh-Hans" ? "虚拟蓝图 (Ghost Blueprint) · 0 代码消耗" : "Ghost Blueprint · 0 Token Overhead")
                        }
                        .font(.system(size: 9, weight: .bold, design: .rounded))
                        .foregroundStyle(Color(nsColor: NSColor.systemIndigo))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3.5)
                        .background(Color(nsColor: NSColor.systemIndigo).opacity(0.12), in: Capsule())
                    } else {
                        let sources = store.sourceReferences(for: block.id)
                        let hasSymbol = sources.contains { $0.symbol != nil }
                        HStack(spacing: 5) {
                            Image(systemName: hasSymbol ? "curlybraces.square.fill" : "cube.fill")
                            Text(hasSymbol
                                ? (store.activeLocale == "zh-Hans" ? "实体落地 · AST 门面压缩" : "Solid · AST Facade Compressed")
                                : (store.activeLocale == "zh-Hans" ? "实体落地 (Solid Anchored)" : "Solid Anchored"))
                        }
                        .font(.system(size: 9, weight: .bold, design: .rounded))
                        .foregroundStyle(MdflowTheme.success)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3.5)
                        .background(MdflowTheme.success.opacity(0.12), in: Capsule())
                    }
                }
                if let coverage = store.architectureCoverage.blocks.first(where: { $0.blockID == block.id }) {
                    let coverageText = store.activeLocale == "zh-Hans"
                        ? "检查点 \(coverage.hasCheckpoint ? "有" : "无") · \(coverage.checkpointRequired ? "需要" : "暂不需要") · Plan \(coverage.isCoveredByPlan ? "有" : "无") · Chain \(coverage.isCoveredByChain ? "有" : "无") · 验证 \(coverage.isCoveredByAnyVerification ? "有" : "无")"
                        : "CHECKPOINT \(coverage.hasCheckpoint ? "YES" : "NO") · \(coverage.checkpointRequired ? "REQUIRED" : "OPTIONAL") · PLAN \(coverage.isCoveredByPlan ? "YES" : "NO") · CHAIN \(coverage.isCoveredByChain ? "YES" : "NO") · VERIFICATION \(coverage.isCoveredByAnyVerification ? "YES" : "NO")"
                    Text(coverageText)
                        .font(.system(size: 9, weight: .medium, design: .monospaced))
                        .foregroundStyle(coverage.missingRequiredCheckpoint ? MdflowTheme.failure : MdflowTheme.muted)
                }
                section(store.text("summary").uppercased(), text: store.blockText(block, field: "summary"))
                section(store.text("details").uppercased(), text: store.blockText(block, field: "body"))
                section(store.text("contract").uppercased(), text: store.blockText(block, field: "contract"))
                chainMembershipSection(block.id)
                relationSection(store.text("upstream").uppercased(), links: store.incomingLinks(for: block.id), blockID: block.id)
                relationSection(store.text("downstream").uppercased(), links: store.outgoingLinks(for: block.id), blockID: block.id)
                relatedPlanSection(block.id)
                sourceSection(block.id)
            }
        case .decision:
            if let decision = store.snapshot.decisions.first(where: { $0.id == selection.id }) {
                HStack(spacing: 8) {
                    metadataLabel(store.activeLocale == "zh-Hans" ? "架构决策" : "DECISION")
                    metadataSeparator
                    metadataLabel(decision.status)
                    metadataSeparator
                    metadataLabel(store.decisionScopeLabel(decision.id))
                }
                Text(store.activeLocale == "zh-Hans"
                     ? "项目记忆 · 不进入 Canvas、Block 覆盖或 checkpoint"
                     : "Project memory · excluded from Canvas, Block coverage, and checkpoints")
                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                    .foregroundStyle(MdflowTheme.muted)
                section(store.text("summary").uppercased(), text: decision.summary)
                section(store.activeLocale == "zh-Hans" ? "决策理由" : "RATIONALE", text: decision.rationale)
                structuredList(store.activeLocale == "zh-Hans" ? "备选方案" : "ALTERNATIVES", value: decision.alternatives)
                structuredList(store.activeLocale == "zh-Hans" ? "后果" : "CONSEQUENCES", value: decision.consequences)
                if let superseded = decision.supersedesDecisionID, !superseded.isEmpty {
                    section(store.activeLocale == "zh-Hans" ? "取代决策" : "SUPERSEDES", text: "decision:\(superseded)")
                }
            }
        case .chain:
            if let chain = store.snapshot.chains.first(where: { $0.id == selection.id }) {
                section(store.text("summary").uppercased(), text: store.chainText(chain, field: "intent"))
                let contract = [
                    chain.inputContract.isEmpty ? nil : "\(store.text("input")) — \(store.chainText(chain, field: "inputContract"))",
                    chain.outputContract.isEmpty ? nil : "\(store.text("output")) — \(store.chainText(chain, field: "outputContract"))",
                ].compactMap { $0 }.joined(separator: "\n\n")
                section(store.text("contract").uppercased(), text: contract)
                chainCodeStreamSection(chain)
                chainPathSection(chain.id)
            }
        case .link:
            if let link = store.snapshot.links.first(where: { $0.id == selection.id }) {
                linkEndpointsSection(link)
                section(store.text("contract").uppercased(), text: link.contract)
            }
        case .plan:
            if let plan = store.snapshot.plans.first(where: { $0.id == selection.id }) {
                HStack(spacing: 7) {
                    metadataLabel("\(plan.phase) #\(plan.order)")
                    metadataSeparator
                    metadataLabel(plan.priority)
                    metadataSeparator
                    Text(plan.derivedStatus.uppercased())
                        .font(.system(size: 8, weight: .bold, design: .monospaced))
                        .foregroundStyle(MdflowTheme.planColor(plan.derivedStatus))
                }
                planProgress(plan)
                if !plan.statusReason.isEmpty { section(store.activeLocale == "zh-Hans" ? "状态原因" : "STATE REASON", text: plan.statusReason) }
                section(store.text("summary").uppercased(), text: store.planText(plan, field: "summary"))
                section(store.text("goal").uppercased(), text: store.planText(plan, field: "goal"))
                section(store.text("nextAction").uppercased(), text: store.planText(plan, field: "nextAction"))
                let dependencies = store.planDependencies(for: plan.id)
                if !dependencies.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        sectionLabel(store.activeLocale == "zh-Hans" ? "前置计划" : "PREREQUISITES")
                        ForEach(dependencies) { dependency in
                            Button { store.focusPlan(dependency.id) } label: {
                                HStack {
                                    Image(systemName: dependency.derivedStatus == "complete" ? "checkmark.circle.fill" : "clock.fill")
                                        .foregroundStyle(MdflowTheme.planColor(dependency.derivedStatus))
                                    Text(store.planText(dependency, field: "title")); Spacer(); Text(dependency.derivedStatus.uppercased())
                                        .font(.system(size: 8, weight: .bold, design: .monospaced)).foregroundStyle(MdflowTheme.planColor(dependency.derivedStatus))
                                }
                                .font(.system(size: 11.5, weight: .medium, design: .rounded)).foregroundStyle(MdflowTheme.ink)
                                .padding(.vertical, 7)
                                .overlay(alignment: .bottom) { Rectangle().fill(MdflowTheme.hairline).frame(height: 1) }
                            }.buttonStyle(.plain)
                        }
                    }
                }
                planDocument(plan)
                structuredList(store.text("proposedDelta").uppercased(), value: plan.proposedDelta)
                structuredList(store.text("blockers").uppercased(), value: plan.blockers)
            }
        }
    }

    private func metadataLabel(_ value: String) -> some View {
        Text(value.uppercased())
            .font(.system(size: 8, weight: .bold, design: .monospaced))
            .tracking(0.7)
            .foregroundStyle(MdflowTheme.muted)
    }

    private var metadataSeparator: some View {
        Text("·")
            .font(.system(size: 9, weight: .bold, design: .monospaced))
            .foregroundStyle(MdflowTheme.hairline)
    }

    @ViewBuilder
    private func planDocument(_ plan: PlanItem) -> some View {
        let scopes = store.planChainScopes(for: plan.id)
        let directChanges = store.directPlanChanges(for: plan.id)
        let steps = store.planSteps(for: plan.id)
        let coverage = store.architectureCoverage(for: plan.id)
        VStack(alignment: .leading, spacing: 5) {
            sectionLabel(store.activeLocale == "zh-Hans" ? "架构覆盖" : "ARCHITECTURE COVERAGE")
            Text("\(coverage.verifiedBlocks)/\(coverage.totalBlocks) \(store.text("verified")) · \(coverage.plannedBlocks)/\(coverage.totalBlocks) \(store.activeLocale == "zh-Hans" ? "由此 Plan 覆盖" : "covered by this Plan")")
                .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                .foregroundStyle(MdflowTheme.ink.opacity(0.82))
            let directStandaloneIDs = Set(directChanges.filter { $0.entityType == "block" }.map(\.entityId))
                .intersection(Set(coverage.outsideChainIDs))
            if !directStandaloneIDs.isEmpty {
                let label = store.activeLocale == "zh-Hans" ? "不在 Chain 中的直接 Block" : "Direct Blocks outside Chains"
                let refs = directStandaloneIDs.sorted().map { "block:\($0)" }.joined(separator: ", ")
                Text("\(label): \(refs)")
                    .font(.system(size: 9.5, weight: .medium, design: .monospaced))
                    .foregroundStyle(MdflowTheme.focus)
            }
            if !coverage.withoutCheckpointIDs.isEmpty {
                Text("\(store.text("noCheckpoint")): \(coverage.withoutCheckpointIDs.prefix(6).joined(separator: ", "))")
                    .font(.system(size: 9.5, design: .monospaced)).foregroundStyle(MdflowTheme.failure)
            }
            if !coverage.checkpointUnboundIDs.isEmpty {
                Text("\(store.activeLocale == "zh-Hans" ? "Checkpoint 未绑定 PlanChange" : "Checkpoints not bound to PlanChanges"): \(coverage.checkpointUnboundIDs.prefix(6).joined(separator: ", "))")
                    .font(.system(size: 9.5, design: .monospaced)).foregroundStyle(MdflowTheme.pending)
            }
            if !coverage.chainGateMissingIDs.isEmpty {
                Text("\(store.activeLocale == "zh-Hans" ? "缺少 Chain integration gate" : "Missing Chain integration gates"): \(coverage.chainGateMissingIDs.prefix(6).joined(separator: ", "))")
                    .font(.system(size: 9.5, design: .monospaced)).foregroundStyle(MdflowTheme.pending)
            }
        }
        if !steps.isEmpty {
            VStack(alignment: .leading, spacing: 5) {
                sectionLabel(store.activeLocale == "zh-Hans" ? "有序步骤" : "ORDERED STEPS")
                ForEach(steps) { step in
                    Button {
                        toggle(step.id, in: &expandedStepIDs)
                    } label: {
                        HStack(alignment: .top, spacing: 8) {
                            disclosureChevron(expandedStepIDs.contains(step.id))
                                .padding(.top, 3)
                            Text(String(format: "%02d", step.position + 1))
                                .font(.system(size: 9, weight: .bold, design: .monospaced))
                                .foregroundStyle(MdflowTheme.planColor(step.status))
                                .frame(width: 22, alignment: .leading)
                                .padding(.top, 3)
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(alignment: .firstTextBaseline, spacing: 8) {
                                    Text(step.title)
                                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                                        .foregroundStyle(MdflowTheme.ink)
                                        .lineLimit(2)
                                    Spacer(minLength: 8)
                                    Text(step.status.uppercased())
                                        .font(.system(size: 8, weight: .bold, design: .monospaced))
                                        .foregroundStyle(MdflowTheme.planColor(step.status))
                                }
                                if !step.action.isEmpty {
                                    Text(step.action)
                                        .font(.system(size: 10, design: .rounded))
                                        .foregroundStyle(MdflowTheme.muted)
                                        .lineLimit(expandedStepIDs.contains(step.id) ? nil : 2)
                                }
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)

                    if expandedStepIDs.contains(step.id) {
                        VStack(alignment: .leading, spacing: 8) {
                            if !step.action.isEmpty {
                                detailParagraph(label: store.activeLocale == "zh-Hans" ? "执行内容" : "ACTION", value: step.action)
                            }
                            let targets = store.planStepTargets(step)
                            if !targets.isEmpty {
                                detailParagraph(label: store.activeLocale == "zh-Hans" ? "目标" : "TARGETS", value: targets)
                            }
                            structuredList(store.activeLocale == "zh-Hans" ? "期望变化" : "PROPOSED DELTA", value: step.proposedDelta)
                        }
                        .padding(.top, 6)
                        .padding(.leading, 46)
                        .transition(.opacity)
                    }
                    Divider().opacity(0.7)
                        .padding(.leading, 46)
                }
            }
            .animation(reduceMotion ? nil : .smooth(duration: 0.24), value: expandedStepIDs)
        }
        if steps.isEmpty && scopes.isEmpty && directChanges.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                sectionLabel(store.activeLocale == "zh-Hans" ? "变更结构" : "CHANGE STRUCTURE")
                Label(
                    store.activeLocale == "zh-Hans" ? "此计划没有有序步骤、ChainScope 或逐实体修改，不能用 0/0 表示完成。" : "This Plan has no ordered steps, ChainScopes, or per-entity work; 0/0 is not completion.",
                    systemImage: "exclamationmark.triangle.fill"
                )
                .font(.system(size: 11.5, weight: .medium, design: .rounded))
                .foregroundStyle(MdflowTheme.pending)
                .padding(.vertical, 6)
                .padding(.leading, 10)
                .overlay(alignment: .leading) { Rectangle().fill(MdflowTheme.pending).frame(width: 1) }
            }
        }
        if !directChanges.isEmpty {
            VStack(alignment: .leading, spacing: 7) {
                sectionLabel(store.text("directBlockWork").uppercased())
                ForEach(directChanges) { change in
                    planChangeCard(change)
                    Divider().opacity(0.7).padding(.leading, 20)
                }
            }
        }
        if !scopes.isEmpty {
            VStack(alignment: .leading, spacing: 7) {
                sectionLabel(store.activeLocale == "zh-Hans" ? "按链路展开的修改" : "CHANGES BY CHAIN")
                ForEach(scopes) { scope in
                    Button {
                        toggle(scope.id, in: &expandedScopeIDs)
                    } label: {
                        HStack(alignment: .top, spacing: 8) {
                            disclosureChevron(expandedScopeIDs.contains(scope.id))
                                .padding(.top, 3)
                            Text(String(format: "%02d", scope.position + 1))
                                .font(.system(size: 9, weight: .bold, design: .monospaced))
                                .foregroundStyle(MdflowTheme.planColor(scope.status))
                                .frame(width: 22, alignment: .leading)
                                .padding(.top, 3)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(scope.title)
                                    .font(.system(size: 12.5, weight: .semibold, design: .rounded))
                                Text(store.snapshot.chains.first(where: { $0.id == scope.chainId }).map { store.chainText($0, field: "title") } ?? scope.chainId)
                                    .font(.system(size: 9.5, weight: .medium, design: .monospaced))
                                    .foregroundStyle(MdflowTheme.muted)
                                if !scope.summary.isEmpty {
                                    Text(scope.summary)
                                        .font(.system(size: 10.5, design: .rounded))
                                        .foregroundStyle(MdflowTheme.muted)
                                        .lineLimit(2)
                                        .padding(.top, 1)
                                }
                            }
                            Spacer(minLength: 8)
                            Text(scope.status.uppercased())
                                .font(.system(size: 8, weight: .bold, design: .monospaced))
                                .foregroundStyle(MdflowTheme.planColor(scope.status))
                                .padding(.top, 3)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(scope.position + 1), \(scope.title)")
                    .accessibilityValue(expandedScopeIDs.contains(scope.id) ? (store.activeLocale == "zh-Hans" ? "已展开" : "Expanded") : (store.activeLocale == "zh-Hans" ? "已折叠" : "Collapsed"))

                    if expandedScopeIDs.contains(scope.id) {
                        VStack(alignment: .leading, spacing: 9) {
                            if !scope.summary.isEmpty { detailParagraph(label: store.text("summary"), value: scope.summary) }
                            if !scope.rationale.isEmpty { detailParagraph(label: store.activeLocale == "zh-Hans" ? "原因" : "RATIONALE", value: scope.rationale) }
                            let nodePath = store.planChainNodePath(scope)
                            if !nodePath.isEmpty {
                                detailParagraph(label: store.activeLocale == "zh-Hans" ? "路径" : "PATH", value: nodePath)
                            }
                            let pathLinks = store.planChainLinks(scope)
                            if !pathLinks.isEmpty {
                                detailParagraph(label: store.activeLocale == "zh-Hans" ? "连接" : "LINKS", value: pathLinks.joined(separator: " · "))
                            }
                            structuredList(store.activeLocale == "zh-Hans" ? "禁止事项" : "PROHIBITIONS", value: scope.prohibitions)
                            let changes = store.planChanges(for: scope)
                            if changes.isEmpty {
                                Text(store.activeLocale == "zh-Hans" ? "尚未声明此链路中的具体 Block / Link 修改。" : "No concrete Block or Link change has been declared for this Chain scope.")
                                    .font(.system(size: 11, design: .rounded)).foregroundStyle(MdflowTheme.pending)
                            }
                            ForEach(changes) { change in
                                planChangeCard(change)
                            }
                            let gates = store.checkpoints(subjectType: "plan_chain_scope", subjectID: scope.id)
                            if !gates.isEmpty {
                                VStack(alignment: .leading, spacing: 7) {
                                    sectionLabel(store.activeLocale == "zh-Hans" ? "CHAIN 验收" : "CHAIN GATES")
                                    ForEach(gates) { checkpoint in checkpointSummary(checkpoint) }
                                }
                            }
                        }
                        .padding(.top, 7)
                        .padding(.leading, 46)
                        .transition(.opacity)
                    }
                    Divider().opacity(0.7)
                        .padding(.leading, 46)
                }
            }
            .animation(reduceMotion ? nil : .smooth(duration: 0.24), value: expandedScopeIDs)
        }
    }

    private func planChangeCard(_ change: PlanChangeItem) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                toggle(change.id, in: &expandedChangeIDs)
            } label: {
                HStack(alignment: .top, spacing: 7) {
                    disclosureChevron(expandedChangeIDs.contains(change.id))
                        .padding(.top, 2)
                    Text(change.entityType.uppercased())
                        .font(.system(size: 8, weight: .bold, design: .monospaced))
                        .foregroundStyle(MdflowTheme.focus)
                        .frame(width: 42, alignment: .leading)
                        .padding(.top, 2)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(change.title)
                            .font(.system(size: 11.5, weight: .semibold, design: .rounded))
                        if !change.summary.isEmpty {
                            Text(change.summary)
                                .font(.system(size: 10.5, design: .rounded))
                                .foregroundStyle(MdflowTheme.muted)
                                .lineLimit(2)
                        }
                    }
                    Spacer(minLength: 6)
                    Image(systemName: checkpointSymbol(change.status))
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(MdflowTheme.planColor(change.status))
                        .padding(.top, 2)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expandedChangeIDs.contains(change.id) {
            VStack(alignment: .leading, spacing: 8) {
                detailParagraph(label: store.activeLocale == "zh-Hans" ? "当前行为" : "CURRENT", value: change.currentBehavior)
                detailParagraph(label: store.activeLocale == "zh-Hans" ? "目标行为" : "PROPOSED", value: change.proposedBehavior)
                detailParagraph(label: store.activeLocale == "zh-Hans" ? "修改原因" : "RATIONALE", value: change.rationale)
                structuredList(store.activeLocale == "zh-Hans" ? "禁止事项" : "MUST NOT", value: change.prohibitions)
                structuredList(store.activeLocale == "zh-Hans" ? "预期影响" : "EXPECTED EFFECTS", value: change.expectedEffects)
                structuredList(store.activeLocale == "zh-Hans" ? "文件与代码位置" : "FILES & CODE", value: change.sourceRefs)
                let checks = store.checkpoints(subjectType: "plan_change", subjectID: change.id)
                if !checks.isEmpty {
                    ForEach(checks) { checkpoint in checkpointSummary(checkpoint) }
                } else {
                    let targetChecks = store.targetCheckpoints(for: change)
                    if targetChecks.isEmpty {
                        Label(store.activeLocale == "zh-Hans" ? "此对象尚无 Checkpoint" : "No checkpoint exists for this entity", systemImage: "exclamationmark.triangle.fill")
                            .font(.system(size: 10, weight: .medium, design: .rounded)).foregroundStyle(MdflowTheme.failure)
                    } else {
                        Label(store.activeLocale == "zh-Hans" ? "已有 Checkpoint，但尚未绑定到此 Plan 工作项" : "Checkpoints exist but are not bound to this Plan work item", systemImage: "link.badge.plus")
                            .font(.system(size: 10, weight: .medium, design: .rounded)).foregroundStyle(MdflowTheme.pending)
                        ForEach(targetChecks) { checkpoint in checkpointSummary(checkpoint) }
                    }
                }
                Button {
                    store.locatePlanChange(change)
                } label: {
                    Label(store.activeLocale == "zh-Hans" ? "在 Canvas 中定位" : "Locate on Canvas", systemImage: "scope")
                        .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                        .foregroundStyle(MdflowTheme.focus)
                }
                .buttonStyle(.plain)
            }
            .font(.system(size: 11.5, design: .rounded))
            .padding(.top, 7)
            .padding(.leading, 20)
            .transition(.opacity)
            }
        }
        .padding(.vertical, 5)
        .padding(.leading, 9)
        .overlay(alignment: .leading) {
            Rectangle().fill(MdflowTheme.hairline).frame(width: 1)
        }
        .animation(reduceMotion ? nil : .smooth(duration: 0.24), value: expandedChangeIDs)
    }

    @ViewBuilder
    private func detailParagraph(label: String, value: String) -> some View {
        if !value.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                sectionLabel(label.uppercased())
                Text(value).font(.system(size: 11.5, design: .rounded)).foregroundStyle(MdflowTheme.ink.opacity(0.86)).lineSpacing(3).textSelection(.enabled)
            }
        }
    }

    @ViewBuilder
    private func checkpointSummary(_ checkpoint: CheckpointItem) -> some View {
        let blockers = store.checkpointBlockers(checkpoint.id)
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: checkpointSymbol(checkpoint.status)).foregroundStyle(MdflowTheme.checkpointColor(checkpoint.status))
                VStack(alignment: .leading, spacing: 2) {
                    Text(checkpoint.title).font(.system(size: 11, weight: .medium, design: .rounded))
                    Text("\(checkpoint.status) · \(checkpoint.evidenceLevel)/\(checkpoint.requiredEvidenceLevel)")
                        .font(.system(size: 8, weight: .bold, design: .monospaced)).foregroundStyle(MdflowTheme.muted)
                }
            }
            if !blockers.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    Text(store.activeLocale == "zh-Hans" ? "被以下必需检查阻塞" : "BLOCKED BY REQUIRED CHECKS")
                        .font(.system(size: 8, weight: .bold, design: .monospaced))
                        .foregroundStyle(MdflowTheme.pending)
                    ForEach(blockers.prefix(6)) { blocker in
                        HStack(spacing: 6) {
                            Image(systemName: checkpointSymbol(blocker.status))
                            Text(blocker.title).lineLimit(2)
                            Spacer(minLength: 4)
                            Text(blocker.status.uppercased())
                                .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                        }
                        .font(.system(size: 9.5, design: .rounded))
                        .foregroundStyle(MdflowTheme.checkpointColor(blocker.status))
                    }
                    if blockers.count > 6 {
                        Text("+ \(blockers.count - 6)")
                            .font(.system(size: 8, weight: .bold, design: .monospaced))
                            .foregroundStyle(MdflowTheme.muted)
                    }
                }
                .padding(.leading, 25)
            }
        }
    }

    @ViewBuilder
    private func chainMembershipSection(_ blockID: String) -> some View {
        let chains = store.chains(containing: blockID)
        if !chains.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                sectionLabel(store.text("memberships").uppercased())
                ForEach(chains) { chain in
                    let position = store.chainPosition(chain.id, blockID: blockID)
                    Button { store.select(GraphSelection(type: .chain, id: chain.id)) } label: {
                        HStack(spacing: 9) {
                            Circle().fill(store.chainColor(chain.id)).frame(width: 8, height: 8)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(store.chainText(chain, field: "title"))
                                Text("\((position?.index ?? 0) + 1) / \(position?.count ?? 0) · \(chain.deliveryState.uppercased())")
                                    .font(.system(size: 8.5, weight: .bold, design: .monospaced))
                                    .foregroundStyle(MdflowTheme.muted)
                            }
                            Spacer()
                            Image(systemName: "arrow.right")
                        }
                        .font(.system(size: 11.5, weight: .medium, design: .rounded))
                        .foregroundStyle(MdflowTheme.ink)
                        .padding(.vertical, 7)
                        .overlay(alignment: .bottom) { Rectangle().fill(MdflowTheme.hairline).frame(height: 1) }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(store.chainText(chain, field: "title")), step \((position?.index ?? 0) + 1) of \(position?.count ?? 0)")
                }
            }
        }
    }

    @ViewBuilder
    private func relationSection(_ title: String, links: [LinkItem], blockID: String) -> some View {
        if !links.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                sectionLabel(title)
                ForEach(links) { link in
                    let otherID = link.sourceId == blockID ? link.targetId : link.sourceId
                    Button { store.select(GraphSelection(type: .link, id: link.id)) } label: {
                        HStack(alignment: .top, spacing: 9) {
                            Image(systemName: link.sourceId == blockID ? "arrow.right" : "arrow.left")
                                .foregroundStyle(MdflowTheme.healthColor(link.healthState))
                            VStack(alignment: .leading, spacing: 3) {
                                Text(store.block(otherID).map { store.blockText($0, field: "title") } ?? otherID)
                                Text((link.label.isEmpty ? link.kind : link.label).uppercased())
                                    .font(.system(size: 8.5, weight: .bold, design: .monospaced))
                                    .foregroundStyle(MdflowTheme.muted)
                            }
                            Spacer()
                        }
                        .font(.system(size: 11.5, weight: .medium, design: .rounded))
                        .foregroundStyle(MdflowTheme.ink)
                        .padding(.vertical, 7)
                        .overlay(alignment: .bottom) { Rectangle().fill(MdflowTheme.hairline).frame(height: 1) }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    @ViewBuilder
    private func relatedPlanSection(_ blockID: String) -> some View {
        let plans = store.plans(containing: blockID)
        if !plans.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                sectionLabel(store.text("relatedPlans").uppercased())
                ForEach(plans) { plan in
                    Button { store.select(GraphSelection(type: .plan, id: plan.id)) } label: {
                        HStack {
                            Circle().fill(MdflowTheme.planColor(plan.status)).frame(width: 7, height: 7)
                            Text(store.planText(plan, field: "title")).lineLimit(2)
                            Spacer()
                            Text(plan.status.uppercased())
                                .font(.system(size: 8, weight: .bold, design: .monospaced))
                                .foregroundStyle(MdflowTheme.planColor(plan.status))
                        }
                        .font(.system(size: 11.5, weight: .medium, design: .rounded))
                        .foregroundStyle(MdflowTheme.ink)
                        .padding(.vertical, 7)
                        .overlay(alignment: .bottom) { Rectangle().fill(MdflowTheme.hairline).frame(height: 1) }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    @ViewBuilder
    private func chainPathSection(_ chainID: String) -> some View {
        let nodeIDs = store.chainNodeIDs(chainID)
        let linkIDs = store.chainLinkIDs(chainID)
        if !nodeIDs.isEmpty {
            VStack(alignment: .leading, spacing: 7) {
                sectionLabel(store.text("path").uppercased())
                ForEach(Array(nodeIDs.enumerated()), id: \.element) { index, id in
                    Button { store.select(GraphSelection(type: .block, id: id)) } label: {
                        HStack(alignment: .top, spacing: 9) {
                            Text("\(index + 1)")
                                .font(.system(size: 9, weight: .bold, design: .monospaced))
                                .foregroundStyle(store.chainColor(chainID))
                                .frame(width: 18, height: 18)
                                .background(store.chainColor(chainID).opacity(0.1), in: Circle())
                            if let block = store.block(id) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(store.blockText(block, field: "title"))
                                        .font(.system(size: 11.5, weight: .semibold, design: .rounded))
                                    HStack(spacing: 5) {
                                        Text(block.kind.uppercased())
                                        Text("·")
                                        Text(block.architectureLayer.uppercased())
                                        if let role = store.snapshot.chainNodes.first(where: { $0.chainId == chainID && $0.blockId == id })?.role,
                                           !role.isEmpty {
                                            Text("·")
                                            Text(role.uppercased())
                                        }
                                    }
                                    .font(.system(size: 8, weight: .bold, design: .monospaced))
                                    .foregroundStyle(MdflowTheme.muted)
                                    if !store.blockText(block, field: "summary").isEmpty {
                                        Text(store.blockText(block, field: "summary"))
                                            .font(.system(size: 10.5, design: .rounded))
                                            .foregroundStyle(MdflowTheme.muted)
                                            .lineLimit(3)
                                    }
                                }
                            } else {
                                Text(id)
                            }
                            Spacer(minLength: 6)
                            Image(systemName: "arrow.up.right")
                                .font(.system(size: 9, weight: .medium))
                                .foregroundStyle(MdflowTheme.muted)
                        }
                        .foregroundStyle(MdflowTheme.ink)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)

                    if index < nodeIDs.count - 1,
                       let link = store.snapshot.links.first(where: {
                           linkIDs.contains($0.id) && $0.sourceId == id && $0.targetId == nodeIDs[index + 1]
                       }) {
                        HStack(alignment: .top, spacing: 7) {
                            Rectangle()
                                .fill(MdflowTheme.linkKindColor(link.kind))
                                .frame(width: 1, height: 28)
                                .padding(.leading, 9)
                            VStack(alignment: .leading, spacing: 2) {
                                Text((link.label.isEmpty ? link.kind : link.label).uppercased())
                                    .font(.system(size: 8, weight: .bold, design: .monospaced))
                                    .foregroundStyle(MdflowTheme.linkKindColor(link.kind))
                                if !link.contract.isEmpty {
                                    Text(link.contract)
                                        .font(.system(size: 9.5, design: .rounded))
                                        .foregroundStyle(MdflowTheme.muted)
                                        .lineLimit(2)
                                }
                            }
                        }
                        .padding(.leading, 1)
                    }
                }
            }
        }
    }

    private func linkEndpointsSection(_ link: LinkItem) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            sectionLabel(store.text("link").uppercased())
            HStack(spacing: 7) {
                endpointButton(link.sourceId)
                Image(systemName: "arrow.right")
                    .foregroundStyle(MdflowTheme.healthColor(link.healthState))
                endpointButton(link.targetId)
            }
            Text((link.label.isEmpty ? link.kind : link.label).uppercased() + " · " + link.healthState.uppercased())
                .font(.system(size: 8.5, weight: .bold, design: .monospaced))
                .foregroundStyle(MdflowTheme.muted)
        }
    }

    private func endpointButton(_ blockID: String) -> some View {
        Button {
            store.select(GraphSelection(type: .block, id: blockID))
        } label: {
            Text(store.block(blockID).map { store.blockText($0, field: "title") } ?? blockID)
                .lineLimit(2)
                .padding(.vertical, 5)
                .overlay(alignment: .bottom) { Rectangle().fill(MdflowTheme.hairline).frame(height: 1) }
        }
        .buttonStyle(.plain)
    }

    private var revisionSection: some View {
        let revision: Int = switch selection.type {
        case .block: store.snapshot.blocks.first { $0.id == selection.id }?.revision ?? 0
        case .chain: store.snapshot.chains.first { $0.id == selection.id }?.revision ?? 0
        case .link: store.snapshot.links.first { $0.id == selection.id }?.revision ?? 0
        case .plan: store.snapshot.plans.first { $0.id == selection.id }?.revision ?? 0
        case .decision: store.snapshot.decisions.first { $0.id == selection.id }?.revision ?? 0
        }
        return HStack {
            sectionLabel(store.text("revision").uppercased())
            Spacer()
            Text("r\(revision)")
                .font(.system(size: 9, weight: .bold, design: .monospaced))
                .foregroundStyle(MdflowTheme.muted)
        }
    }

    @ViewBuilder
    private func section(_ title: String, text: String) -> some View {
        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                sectionLabel(title)
                Text(text)
                    .font(.system(size: 12, weight: .regular, design: .rounded))
                    .foregroundStyle(MdflowTheme.ink.opacity(0.86))
                    .lineSpacing(2)
                    .textSelection(.enabled)
            }
        }
    }

    @ViewBuilder
    private func sourceSection(_ blockID: String) -> some View {
        let sources = store.sourceReferences(for: blockID)
        if !sources.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    sectionLabel(store.text("files").uppercased())
                    Spacer()
                    Text(store.activeLocale == "zh-Hans" ? "AST 门面映射" : "AST Facade Anchors")
                        .font(.system(size: 8.5, weight: .semibold, design: .monospaced))
                        .foregroundStyle(MdflowTheme.focus)
                }
                ForEach(sources) { source in
                    VStack(alignment: .leading, spacing: 4) {
                        Button {
                            store.revealSource(source)
                        } label: {
                            HStack(alignment: .top, spacing: 9) {
                                Image(systemName: source.symbol != nil ? "curlybraces" : "doc.text")
                                    .font(.system(size: 11, weight: .medium))
                                    .foregroundStyle(source.symbol != nil ? MdflowTheme.focus : MdflowTheme.ink)
                                VStack(alignment: .leading, spacing: 3) {
                                    HStack(spacing: 6) {
                                        Text(source.path)
                                            .font(.system(size: 11, weight: .semibold, design: .monospaced))
                                            .lineLimit(1)
                                        if let start = source.startLine, let end = source.endLine {
                                            Text("L\(start)-L\(end)")
                                                .font(.system(size: 8.5, weight: .bold, design: .monospaced))
                                                .foregroundStyle(MdflowTheme.muted)
                                                .padding(.horizontal, 4)
                                                .padding(.vertical, 1.5)
                                                .background(MdflowTheme.hairline.opacity(0.6), in: RoundedRectangle(cornerRadius: 3))
                                        }
                                    }
                                    if let symbol = source.symbol {
                                        Text(symbol)
                                            .font(.system(size: 10, weight: .medium, design: .monospaced))
                                            .foregroundStyle(MdflowTheme.focus)
                                    } else {
                                        Text(source.role)
                                            .font(.system(size: 10, design: .monospaced))
                                            .foregroundStyle(MdflowTheme.muted)
                                    }
                                }
                                Spacer()
                                Image(systemName: "arrow.up.right")
                                    .font(.system(size: 10, weight: .medium))
                                    .foregroundStyle(MdflowTheme.muted)
                            }
                            .foregroundStyle(MdflowTheme.ink)
                            .padding(.vertical, 5)
                        }
                        .buttonStyle(.plain)

                        if let start = source.startLine, let end = source.endLine {
                            let lineCount = max(1, end - start + 1)
                            let sliceTokens = lineCount * 7
                            HStack(spacing: 6) {
                                Image(systemName: "bolt.shield.fill")
                                    .font(.system(size: 8))
                                    .foregroundStyle(MdflowTheme.success)
                                Text(store.activeLocale == "zh-Hans"
                                     ? "Token 节约: 仅切片 \(lineCount) 行 (~约 \(sliceTokens) tokens), 降低上下文膨胀 >85%"
                                     : "Token Saving: ~\(sliceTokens) tokens slice (\(lineCount) LOC), avoids full-file overhead")
                                    .font(.system(size: 8.5, design: .monospaced))
                                    .foregroundStyle(MdflowTheme.muted)
                            }
                            .padding(.leading, 20)
                            .padding(.bottom, 4)
                        }
                    }
                    .overlay(alignment: .bottom) { Rectangle().fill(MdflowTheme.hairline).frame(height: 1) }
                }
            }
        }
    }

    @ViewBuilder
    private func chainCodeStreamSection(_ chain: ChainItem) -> some View {
        let nodeIDs = store.chainNodeIDs(chain.id)
        if !nodeIDs.isEmpty {
            let blocks = nodeIDs.compactMap { store.block($0) }
            let ghostCount = blocks.filter(\.isGhost).count
            let solidCount = blocks.count - ghostCount

            let stats = calculateTokenStats(for: blocks)

            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    sectionLabel(store.activeLocale == "zh-Hans" ? "代码流切片与 TOKEN 经济" : "CODE STREAM & TOKEN ECONOMY")
                    Spacer()
                    if stats.savingsPercent > 0 {
                        Text("\(stats.savingsPercent)% SAVED")
                            .font(.system(size: 8.5, weight: .black, design: .monospaced))
                            .foregroundStyle(MdflowTheme.success)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 2)
                            .background(MdflowTheme.success.opacity(0.12), in: Capsule())
                    }
                }

                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 12) {
                        HStack(spacing: 4) {
                            Circle().fill(MdflowTheme.success).frame(width: 6, height: 6)
                            Text(store.activeLocale == "zh-Hans" ? "\(solidCount) 实体落地" : "\(solidCount) Solid")
                                .font(.system(size: 10, weight: .semibold, design: .rounded))
                        }
                        HStack(spacing: 4) {
                            Circle().fill(Color(nsColor: NSColor.systemIndigo)).frame(width: 6, height: 6)
                            Text(store.activeLocale == "zh-Hans" ? "\(ghostCount) 虚拟蓝图" : "\(ghostCount) Ghost")
                                .font(.system(size: 10, weight: .semibold, design: .rounded))
                        }
                    }
                    .foregroundStyle(MdflowTheme.ink)

                    HStack(spacing: 6) {
                        Image(systemName: "gauge.with.dots.needle.bottom.50percent")
                            .font(.system(size: 10))
                            .foregroundStyle(MdflowTheme.focus)
                        Text(store.activeLocale == "zh-Hans"
                             ? "AST 门面切片: ~\(stats.sliceTokens) tokens (全量文件约 ~\(stats.fullTokens) tokens)"
                             : "AST Facade Stream: ~\(stats.sliceTokens) tokens (vs ~\(stats.fullTokens) tokens full-files)")
                            .font(.system(size: 9.5, weight: .medium, design: .monospaced))
                            .foregroundStyle(MdflowTheme.muted)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(MdflowTheme.surface.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(MdflowTheme.hairline, lineWidth: 1))

                HStack(spacing: 8) {
                    Button {
                        let stream = buildChainCodeStream(chain: chain)
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(stream, forType: .string)
                        copiedStreamChainID = chain.id
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                            if copiedStreamChainID == chain.id {
                                copiedStreamChainID = nil
                            }
                        }
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: copiedStreamChainID == chain.id ? "checkmark" : "doc.on.doc")
                            Text(copiedStreamChainID == chain.id
                                 ? (store.activeLocale == "zh-Hans" ? "已复制切片流" : "Copied Stream")
                                 : (store.activeLocale == "zh-Hans" ? "复制链切片流" : "Copy Code Stream"))
                        }
                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                        .foregroundStyle(copiedStreamChainID == chain.id ? MdflowTheme.success : MdflowTheme.ink)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .background(MdflowTheme.hairline.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
                    }
                    .buttonStyle(.plain)

                    Button {
                        withAnimation {
                            showCodeStream.toggle()
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: showCodeStream ? "chevron.up" : "chevron.down")
                            Text(showCodeStream
                                 ? (store.activeLocale == "zh-Hans" ? "收起流预览" : "Hide Stream")
                                 : (store.activeLocale == "zh-Hans" ? "预览流内容" : "Preview Stream"))
                        }
                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                        .foregroundStyle(MdflowTheme.focus)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                    }
                    .buttonStyle(.plain)
                }

                if showCodeStream {
                    let streamText = buildChainCodeStream(chain: chain)
                    Text(streamText)
                        .font(.system(size: 9.5, design: .monospaced))
                        .foregroundStyle(MdflowTheme.ink)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(nsColor: NSColor.textBackgroundColor))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(MdflowTheme.hairline, lineWidth: 1))
                }
            }
            .padding(.vertical, 4)
        }
    }

    private func buildChainCodeStream(chain: ChainItem) -> String {
        let nodeIDs = store.chainNodeIDs(chain.id)
        var lines: [String] = []
        lines.append("# Chain Code Stream: \(chain.id)")
        lines.append("## Purpose: \(chain.intent.isEmpty ? chain.title : chain.intent)")
        lines.append("")
        for (index, id) in nodeIDs.enumerated() {
            guard let block = store.block(id) else { continue }
            let sources = store.sourceReferences(for: id)
            let isGhost = block.isGhost
            lines.append("### Node \(index + 1): [block:\(block.id)] \(block.title) (\(isGhost ? "Ghost Blueprint" : "Solid Anchored"))")
            lines.append("- Layer: \(block.architectureLayer) · Delivery: \(block.deliveryState)")
            if !block.contract.isEmpty {
                lines.append("- Contract: \(block.contract)")
            }
            if isGhost {
                lines.append("```markdown")
                lines.append("// [GHOST BLUEPRINT] Virtual node. No source files anchored yet.")
                lines.append("// Planned Specification: \(block.summary)")
                lines.append("```")
            } else if sources.isEmpty {
                lines.append("```text")
                lines.append("// [SOLID] Anchored block, no source references attached.")
                lines.append("```")
            } else {
                for source in sources {
                    lines.append("// Source: \(source.path)\(source.symbol.map { " :: \($0)" } ?? "")\(source.startLine.map { " (L\($0)-L\(source.endLine ?? $0))" } ?? "")")
                    if let start = source.startLine, let end = source.endLine, !store.snapshot.project.root.isEmpty {
                        let fullPath = URL(fileURLWithPath: store.snapshot.project.root).appendingPathComponent(source.path).path
                        if let fileContent = try? String(contentsOfFile: fullPath, encoding: .utf8) {
                            let fileLines = fileContent.components(separatedBy: "\n")
                            let startIdx = max(0, start - 1)
                            let endIdx = min(fileLines.count, end)
                            if startIdx < endIdx {
                                let slice = fileLines[startIdx..<endIdx].joined(separator: "\n")
                                lines.append("```")
                                lines.append(slice)
                                lines.append("```")
                                continue
                            }
                        }
                    }
                    lines.append("```")
                    lines.append("// Facade: \(source.symbol ?? source.path)")
                    lines.append("```")
                }
            }
            lines.append("")
        }
        return lines.joined(separator: "\n")
    }

    private struct TokenEconomyStats {
        let sliceTokens: Int
        let fullTokens: Int
        let savingsPercent: Int
    }

    private func calculateTokenStats(for blocks: [BlockItem]) -> TokenEconomyStats {
        var sliceTokens = 0
        var fullTokens = 0
        for block in blocks {
            if block.isGhost {
                sliceTokens += 15
                fullTokens += 15
            } else {
                let sources = store.sourceReferences(for: block.id)
                if sources.isEmpty {
                    sliceTokens += 30
                    fullTokens += 30
                } else {
                    for source in sources {
                        if let start = source.startLine, let end = source.endLine {
                            let lines = max(1, end - start + 1)
                            sliceTokens += lines * 7
                            fullTokens += max(250, lines * 15) * 7
                        } else {
                            sliceTokens += 50
                            fullTokens += 2000
                        }
                    }
                }
            }
        }
        let savingsPercent = fullTokens > sliceTokens ? Int(Double(fullTokens - sliceTokens) / Double(fullTokens) * 100.0) : 0
        return TokenEconomyStats(sliceTokens: sliceTokens, fullTokens: fullTokens, savingsPercent: savingsPercent)
    }

    @ViewBuilder
    private var checkpointSection: some View {
        let checkpoints = store.checkpoints(for: selection)
        if !checkpoints.isEmpty {
            VStack(alignment: .leading, spacing: 7) {
                sectionLabel(store.text("checkpoints").uppercased())
                ForEach(checkpoints) { checkpoint in
                    Button {
                        toggle(checkpoint.id, in: &expandedCheckpointIDs)
                    } label: {
                        HStack(spacing: 8) {
                            disclosureChevron(expandedCheckpointIDs.contains(checkpoint.id))
                            Image(systemName: checkpointSymbol(checkpoint.status))
                                .font(.system(size: 11, weight: .bold))
                                .foregroundStyle(MdflowTheme.checkpointColor(checkpoint.status))
                            Text(checkpoint.title)
                                .font(.system(size: 12, weight: .medium, design: .rounded))
                            Spacer(minLength: 6)
                            Text(checkpoint.status.uppercased())
                                .font(.system(size: 8, weight: .bold, design: .monospaced))
                                .foregroundStyle(MdflowTheme.checkpointColor(checkpoint.status))
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)

                    if expandedCheckpointIDs.contains(checkpoint.id) {
                        VStack(alignment: .leading, spacing: 7) {
                            HStack(spacing: 7) {
                                Text("\(checkpoint.evidenceLevel) / \(checkpoint.requiredEvidenceLevel)")
                                Text(checkpoint.coverage.uppercased())
                                if selection.type == .plan, let reference = store.checkpointReference(planID: selection.id, checkpointID: checkpoint.id) {
                                    Text(reference.required ? (store.activeLocale == "zh-Hans" ? "必需" : "REQUIRED") : (store.activeLocale == "zh-Hans" ? "可选" : "OPTIONAL"))
                                }
                            }
                            .font(.system(size: 8, weight: .bold, design: .monospaced))
                            .foregroundStyle(MdflowTheme.checkpointColor(checkpoint.status))
                            if !checkpoint.criteria.isEmpty { Text(checkpoint.criteria) }
                            ForEach(structuredItems(checkpoint.evidence)) { item in
                                HStack(alignment: .top, spacing: 7) {
                                    Circle().fill(MdflowTheme.focus.opacity(0.65)).frame(width: 4, height: 4).padding(.top, 6)
                                    VStack(alignment: .leading, spacing: 2) {
                                        if let eyebrow = item.eyebrow {
                                            Text(localizedType(eyebrow))
                                                .font(.system(size: 8, weight: .bold, design: .monospaced))
                                                .tracking(0.8)
                                        }
                                        Text(item.text).textSelection(.enabled)
                                    }
                                }
                            }
                        }
                        .font(.system(size: 11.5, design: .rounded))
                        .foregroundStyle(MdflowTheme.muted)
                        .padding(.top, 7)
                        .padding(.leading, 34)
                        .transition(.opacity)
                    }
                    Divider().opacity(0.65).padding(.leading, 34)
                }
            }
            .animation(reduceMotion ? nil : .smooth(duration: 0.24), value: expandedCheckpointIDs)
        }
    }

    @ViewBuilder
    private var historySection: some View {
        let history = store.history(for: selection)
        if !history.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                sectionLabel(store.text("history").uppercased())
                ForEach(history.prefix(12)) { item in
                    let expanded = expandedHistoryIDs.contains(item.id)
                    Button {
                        toggle(item.id, in: &expandedHistoryIDs)
                    } label: {
                        VStack(alignment: .leading, spacing: 7) {
                            HStack(alignment: .top, spacing: 8) {
                                disclosureChevron(expanded)
                                Text("r\(item.revision)")
                                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                                    .foregroundStyle(MdflowTheme.muted)
                                    .frame(width: 28, alignment: .leading)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(item.summary)
                                        .font(.system(size: 11.5, weight: .medium, design: .rounded))
                                        .foregroundStyle(MdflowTheme.ink)
                                    Text(item.action.uppercased())
                                        .font(.system(size: 8.5, weight: .bold, design: .monospaced))
                                        .tracking(1)
                                        .foregroundStyle(MdflowTheme.muted)
                                }
                                Spacer(minLength: 0)
                            }
                            if expanded {
                                historyDiff(item)
                                    .padding(.leading, 47)
                                    .transition(.opacity)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .contentShape(Rectangle())
                    .animation(reduceMotion ? nil : .smooth(duration: 0.24), value: expandedHistoryIDs)
                }
            }
        }
    }

    @ViewBuilder
    private func historyDiff(_ item: HistoryItem) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            if !item.changedFields.isEmpty { historyMetadata(store.activeLocale == "zh-Hans" ? "修改字段" : "CHANGED FIELDS", item.changedFields.joined(separator: ", ")) }
            if !item.affectedRefs.isEmpty { historyMetadata(store.activeLocale == "zh-Hans" ? "影响引用" : "AFFECTED REFS", item.affectedRefs.joined(separator: " · ")) }
            if let planID = item.planID, !planID.isEmpty { historyMetadata("PLAN", "plan:\(planID)") }
            if let chainScopeID = item.chainScopeID, !chainScopeID.isEmpty { historyMetadata("CHAIN SCOPE", chainScopeID) }
            if !item.evidenceRefs.isEmpty { historyMetadata(store.activeLocale == "zh-Hans" ? "证据引用" : "EVIDENCE REFS", item.evidenceRefs.joined(separator: " · ")) }
            ForEach(item.fieldDiffs) { diff in
                historyMetadata(
                    diff.field.uppercased(),
                    "\(store.activeLocale == "zh-Hans" ? "前" : "Before"): \(diff.before)\n\(store.activeLocale == "zh-Hans" ? "后" : "After"): \(diff.after)"
                )
            }
        }
        .font(.system(size: 9.5, design: .monospaced))
        .foregroundStyle(MdflowTheme.muted)
    }

    private func historyMetadata(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.system(size: 8, weight: .bold, design: .monospaced)).tracking(0.8)
            Text(value).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func sectionLabel(_ value: String) -> some View {
        Text(value)
            .font(.system(size: 9, weight: .bold, design: .monospaced))
            .tracking(1.4)
            .foregroundStyle(MdflowTheme.muted)
    }

    private func disclosureChevron(_ expanded: Bool) -> some View {
        Image(systemName: "chevron.right")
            .font(.system(size: 8, weight: .bold))
            .foregroundStyle(MdflowTheme.muted.opacity(0.7))
            .frame(width: 11, height: 14)
            .rotationEffect(.degrees(expanded ? 90 : 0))
    }

    private func toggle<Value: Hashable>(_ id: Value, in values: inout Set<Value>) {
        if values.contains(id) {
            values.remove(id)
        } else {
            values.insert(id)
        }
    }

    private func checkpointSymbol(_ status: String) -> String {
        switch status {
        case "passed": "checkmark.circle.fill"
        case "partial_pass": "circle.lefthalf.filled"
        case "running": "arrow.triangle.2.circlepath.circle.fill"
        case "failed": "xmark.circle.fill"
        case "blocked": "stop.circle.fill"
        case "retest_required": "arrow.clockwise.circle.fill"
        case "not_supported": "nosign"
        default: "circle"
        }
    }

    private func planProgress(_ plan: PlanItem) -> some View {
        let usesChanges = !store.planChainScopes(for: plan.id).isEmpty || !store.planChanges(for: plan.id).isEmpty
        let unit = usesChanges
            ? (store.activeLocale == "zh-Hans" ? "修改" : "changes")
            : (store.activeLocale == "zh-Hans" ? "步骤" : "steps")
        return VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(store.activeLocale == "zh-Hans" ? "进度" : "PROGRESS")
                Spacer()
                Text("\(plan.progress.completedSteps)/\(plan.progress.totalSteps) \(unit) · \(plan.progress.passedRequiredCheckpoints)/\(plan.progress.totalRequiredCheckpoints) gates")
            }
            .font(.system(size: 8.5, weight: .bold, design: .monospaced)).foregroundStyle(MdflowTheme.muted)
            Text("Block \(plan.progress.directBlockChanges.completed)/\(plan.progress.directBlockChanges.total) · Chain \(plan.progress.chainChanges.completed)/\(plan.progress.chainChanges.total) · Link \(plan.progress.linkChanges.completed)/\(plan.progress.linkChanges.total)")
                .font(.system(size: 8, weight: .medium, design: .monospaced))
                .foregroundStyle(MdflowTheme.muted)
            Text("Chain gates \(plan.progress.chainIntegrationGates.passed)/\(plan.progress.chainIntegrationGates.total) · Plan gates \(plan.progress.planAcceptanceGates.passed)/\(plan.progress.planAcceptanceGates.total)")
                .font(.system(size: 8, weight: .medium, design: .monospaced))
                .foregroundStyle(MdflowTheme.muted)
            GeometryReader { geometry in
                let total = max(1, plan.progress.totalSteps + plan.progress.totalRequiredCheckpoints)
                let complete = plan.progress.completedSteps + plan.progress.passedRequiredCheckpoints
                ZStack(alignment: .leading) {
                    Capsule().fill(MdflowTheme.hairline)
                    Capsule().fill(MdflowTheme.planColor(plan.derivedStatus)).frame(width: geometry.size.width * CGFloat(complete) / CGFloat(total))
                }
            }.frame(height: 3)
        }
    }

    @ViewBuilder
    private func structuredList(_ title: String, value: String) -> some View {
        let items = structuredItems(value)
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 7) {
                sectionLabel(title)
                ForEach(items) { item in
                    HStack(alignment: .top, spacing: 9) {
                        if let eyebrow = item.eyebrow {
                            Text("[\(localizedType(eyebrow))]")
                                .font(.system(size: 8, weight: .bold, design: .monospaced))
                                .tracking(0.7)
                                .foregroundStyle(MdflowTheme.focus)
                        } else {
                            Circle().fill(MdflowTheme.focus.opacity(0.65)).frame(width: 5, height: 5).padding(.top, 7)
                        }
                        Text(item.text)
                            .font(.system(size: 11.5, design: .rounded))
                            .foregroundStyle(MdflowTheme.ink.opacity(0.86))
                            .lineSpacing(3)
                            .textSelection(.enabled)
                    }
                }
            }
        }
    }

    private struct StructuredItem: Identifiable {
        let id: Int
        let eyebrow: String?
        let text: String
    }

    private func structuredItems(_ value: String) -> [StructuredItem] {
        guard value != "[]", let data = value.data(using: .utf8),
              let values = try? JSONSerialization.jsonObject(with: data) as? [Any]
        else { return value.isEmpty || value == "[]" ? [] : [StructuredItem(id: 0, eyebrow: nil, text: value)] }
        return values.enumerated().compactMap { index, item in
            if let text = item as? String { return StructuredItem(id: index, eyebrow: nil, text: text) }
            guard let dictionary = item as? [String: Any] else { return nil }
            let eyebrow = dictionary["type"] as? String ?? dictionary["kind"] as? String
            let preferred = dictionary["change"] as? String ?? dictionary["result"] as? String ?? dictionary["message"] as? String
            let remaining = dictionary.keys.sorted().filter { !["type", "kind", "change", "result", "message"].contains($0) }.map {
                "\($0): \(String(describing: dictionary[$0]!))"
            }
            let text = ([preferred].compactMap { $0 } + remaining).joined(separator: " · ")
            return text.isEmpty ? nil : StructuredItem(id: index, eyebrow: eyebrow, text: text)
        }
    }

    private func localizedType(_ value: String) -> String {
        guard store.activeLocale == "zh-Hans" else { return value.uppercased() }
        return ["schema": "模型", "canvas": "画布", "interaction": "交互", "evaluation": "验证", "automated-test": "自动测试"][value] ?? value.uppercased()
    }
}
