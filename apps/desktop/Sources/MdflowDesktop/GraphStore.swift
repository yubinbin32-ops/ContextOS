import AppKit
import Combine
import Foundation
import SwiftUI

@MainActor
final class GraphStore: ObservableObject {
    @Published private(set) var snapshot: GraphSnapshot
    @Published private(set) var recentProjects: [RecentProject]
    @Published var selection: GraphSelection?
    @Published var highlightedChainIDs: Set<String> = []
    @Published private(set) var focusTarget: GraphSelection?
    @Published private(set) var focusRequestID = UUID()
    @Published private(set) var overviewFitRequestID = UUID()
    @Published var isolateFocused = false
    @Published var enabledLenses: Set<ViewLens> = Set(ViewLens.allCases)
    @Published var collapsedSidebarSections: Set<SidebarSection> = [] {
        didSet { persistSidebarState() }
    }
    @Published private(set) var recentlyChangedRefs: Set<String> = []
    @Published private(set) var errorMessage: String?
    @Published var settingsPresented = false
    @Published private(set) var pluginInstallStatus: PluginInstallStatus = .idle
    @Published var canvasScale: CGFloat = 1
    @Published var canvasOffset: CGSize = .zero
    @Published private(set) var hasRestoredCamera = false
    @Published private(set) var cameraRestoreRequestID = UUID()
    /// Changes even when a Git checkout restores a database with the same
    /// graph revision and change sequence. SwiftUI must still rebuild the
    /// Canvas scene because the canonical snapshot contents may differ.
    @Published private(set) var snapshotPresentationID = UUID()
    @Published var language: AppLanguage {
        didSet { UserDefaults.standard.set(language.rawValue, forKey: "mdflow.language") }
    }

    private var location: ProjectLocation?
    private var database: ProjectDatabase?
    private var databaseIdentity: DatabaseFileIdentity?
    private var clearChangeTask: Task<Void, Never>?
    private var focusTask: Task<Void, Never>?
    private var refreshDebounceTask: Task<Void, Never>?
    private var livePollingTask: Task<Void, Never>?
    private var fileWatcher: DispatchSourceFileSystemObject?
    private var watchedDescriptor: Int32 = -1
    private var projectViewStates: [String: ProjectViewState] = [:]

    private struct ProjectViewState {
        let selection: GraphSelection?
        let highlightedChainIDs: Set<String>
        let enabledLenses: Set<ViewLens>
        let canvasScale: CGFloat
        let canvasOffset: CGSize
        let focusTarget: GraphSelection?
        let isolateFocused: Bool
    }

    init() {
        self.language = AppLanguage(rawValue: UserDefaults.standard.string(forKey: "mdflow.language") ?? "system") ?? .system
        self.recentProjects = ProjectLocation.recentProjects()
        do {
            let resolvedLocation = try ProjectLocation.resolve()
            self.location = resolvedLocation
            self.recentProjects = ProjectLocation.recentProjects()
            do {
                let resolvedDatabase = try ProjectDatabase(location: resolvedLocation)
                self.database = resolvedDatabase
                self.databaseIdentity = resolvedDatabase.fileIdentity
                self.snapshot = try resolvedDatabase.loadSnapshot()
            } catch {
                self.database = nil
                self.databaseIdentity = nil
                self.snapshot = .empty(name: resolvedLocation.descriptor.name, root: resolvedLocation.root.path)
                self.errorMessage = error.localizedDescription
                Self.log(error, context: resolvedLocation.database.path)
            }
        } catch {
            self.location = nil
            self.database = nil
            self.databaseIdentity = nil
            self.snapshot = .empty(root: FileManager.default.currentDirectoryPath)
            self.errorMessage = error.localizedDescription
            Self.log(error, context: "project resolution")
        }
        restoreProjectViewState(for: snapshot.project.id)
        startLiveUpdates()
    }

    func chooseProject() {
        let panel = NSOpenPanel()
        panel.title = text("openProject")
        panel.message = text("openProjectHelp")
        panel.prompt = text("open")
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false

        guard panel.runModal() == .OK, let url = panel.url else { return }
        loadProject(at: url)
    }

    func openProject(_ project: RecentProject) {
        loadProject(at: URL(fileURLWithPath: project.path, isDirectory: true))
    }

    private func loadProject(at url: URL) {
        do {
            let resolvedLocation = try ProjectLocation.resolve(startingAt: url)
            let resolvedDatabase = try ProjectDatabase(location: resolvedLocation)
            let next = try resolvedDatabase.loadSnapshot()
            saveCurrentProjectViewState()
            database?.close()
            location = resolvedLocation
            database = resolvedDatabase
            databaseIdentity = resolvedDatabase.fileIdentity
            recentProjects = ProjectLocation.recentProjects()
            withAnimation(.smooth(duration: 0.24)) {
                snapshot = next
                snapshotPresentationID = UUID()
                restoreProjectViewState(for: next.project.id)
                recentlyChangedRefs.removeAll()
                errorMessage = nil
            }
            startLiveUpdates()
            if let focusTarget { requestFocus(focusTarget) }
        } catch {
            errorMessage = error.localizedDescription
            Self.log(error, context: url.path)
        }
    }

    private func saveCurrentProjectViewState() {
        guard !snapshot.project.id.isEmpty else { return }
        projectViewStates[snapshot.project.id] = ProjectViewState(
            selection: selection,
            highlightedChainIDs: highlightedChainIDs,
            enabledLenses: enabledLenses,
            canvasScale: canvasScale,
            canvasOffset: canvasOffset,
            focusTarget: focusTarget,
            isolateFocused: isolateFocused
        )
        persistCameraState(for: snapshot.project.id)
    }

    private func restoreProjectViewState(for projectID: String) {
        focusTask?.cancel()
        if let state = projectViewStates[projectID] {
            selection = state.selection.flatMap { Self.selection($0, existsIn: snapshot) ? $0 : nil }
            highlightedChainIDs = state.highlightedChainIDs.intersection(snapshot.chains.map(\.id))
            enabledLenses = state.enabledLenses
            canvasScale = state.canvasScale
            canvasOffset = state.canvasOffset
            focusTarget = state.focusTarget.flatMap { Self.selection($0, existsIn: snapshot) ? $0 : nil }
            isolateFocused = state.isolateFocused && focusTarget != nil
            hasRestoredCamera = true
            cameraRestoreRequestID = UUID()
            collapsedSidebarSections = loadSidebarState(for: projectID)
            persistCameraState(for: projectID)
            return
        }
        if let persisted = persistedCameraState(for: projectID) {
            selection = nil
            highlightedChainIDs.removeAll()
            focusTarget = nil
            isolateFocused = false
            enabledLenses = Set(ViewLens.allCases)
            canvasScale = persisted.scale
            canvasOffset = persisted.offset
            hasRestoredCamera = true
            cameraRestoreRequestID = UUID()
            collapsedSidebarSections = loadSidebarState(for: projectID)
            return
        }
        selection = nil
        highlightedChainIDs.removeAll()
        focusTarget = nil
        isolateFocused = false
        enabledLenses = Set(ViewLens.allCases)
        canvasScale = 1
        canvasOffset = .zero
        hasRestoredCamera = false
        cameraRestoreRequestID = UUID()
        collapsedSidebarSections = loadSidebarState(for: projectID)
    }

    private func cameraStateKey(for projectID: String, component: String) -> String {
        "mdflow.camera.\(projectID).\(component)"
    }

    private func persistCameraState(for projectID: String) {
        guard !projectID.isEmpty else { return }
        let defaults = UserDefaults.standard
        defaults.set(Double(canvasScale), forKey: cameraStateKey(for: projectID, component: "scale"))
        defaults.set(Double(canvasOffset.width), forKey: cameraStateKey(for: projectID, component: "x"))
        defaults.set(Double(canvasOffset.height), forKey: cameraStateKey(for: projectID, component: "y"))
    }

    private func persistedCameraState(for projectID: String) -> (scale: CGFloat, offset: CGSize)? {
        let defaults = UserDefaults.standard
        let scaleKey = cameraStateKey(for: projectID, component: "scale")
        let xKey = cameraStateKey(for: projectID, component: "x")
        let yKey = cameraStateKey(for: projectID, component: "y")
        guard defaults.object(forKey: scaleKey) != nil,
              let x = defaults.object(forKey: xKey) as? Double,
              let y = defaults.object(forKey: yKey) as? Double else { return nil }
        let scale = defaults.object(forKey: scaleKey) as? Double ?? 1
        return (CGFloat(min(1.8, max(0.25, scale))), CGSize(width: x, height: y))
    }

    private func sidebarStateKey(for projectID: String) -> String {
        "mdflow.sidebar.\(projectID).collapsed"
    }

    private func loadSidebarState(for projectID: String) -> Set<SidebarSection> {
        let values = UserDefaults.standard.stringArray(forKey: sidebarStateKey(for: projectID)) ?? []
        return Set(values.compactMap(SidebarSection.init(rawValue:)))
    }

    private func persistSidebarState() {
        guard !snapshot.project.id.isEmpty else { return }
        UserDefaults.standard.set(collapsedSidebarSections.map(\.rawValue).sorted(), forKey: sidebarStateKey(for: snapshot.project.id))
    }

    private static func log(_ error: Error, context: String) {
        let message = "mdflow: \(context): \(error.localizedDescription)\n"
        FileHandle.standardError.write(Data(message.utf8))
    }

    var plans: [PlanItem] {
        snapshot.plans
    }

    var architectureCoverage: ArchitectureCoverage {
        architectureCoverage(for: nil)
    }

    func architectureCoverage(for planID: String?) -> ArchitectureCoverage {
        let blocks = snapshot.blocks.filter { $0.deliveryState != "deprecated" }
        let blockIDs = Set(blocks.map(\.id))
        let chainMemberIDs = Set(snapshot.chainNodes.filter { blockIDs.contains($0.blockId) }.map(\.blockId))
        let candidatePlanIDs = Set(snapshot.plans.filter { planID == nil || $0.id == planID }.map(\.id))
        var directlyPlanned = Set(snapshot.planChanges.filter {
            candidatePlanIDs.contains($0.planId) && $0.entityType == "block" && blockIDs.contains($0.entityId)
        }.map(\.entityId))
        for step in snapshot.planSteps where candidatePlanIDs.contains(step.planId) {
            for ref in structuredStringList(step.targetReferences) where ref.hasPrefix("block:") {
                directlyPlanned.insert(String(ref.dropFirst("block:".count)))
            }
        }
        let chainPlanned = Set(snapshot.planChainScopes
            .filter { candidatePlanIDs.contains($0.planId) }
            .flatMap { structuredStringList($0.nodeIds) }
            .filter { blockIDs.contains($0) })
        let planned = directlyPlanned.union(chainPlanned)
        let checkpointGroups = Dictionary(grouping: snapshot.checkpoints.filter { $0.targetType == "block" }, by: \.targetId)
        let bindingsByCheckpoint = Dictionary(grouping: snapshot.checkpointBindings, by: \.checkpointId)
        let changesByBlock = Dictionary(grouping: snapshot.planChanges.filter {
            candidatePlanIDs.contains($0.planId) && $0.entityType == "block"
        }, by: \.entityId)
        let candidateScopes = snapshot.planChainScopes.filter { candidatePlanIDs.contains($0.planId) }
        var chainGateIDs = planID == nil
            ? Set(snapshot.checkpoints.filter { $0.targetType == "chain" && $0.kind == "integration" }.map(\.targetId))
            : Set<String>()
        for binding in snapshot.checkpointBindings where binding.required && binding.subjectType == "plan_chain_scope" {
            guard let scope = candidateScopes.first(where: { $0.id == binding.subjectId }),
                  let checkpoint = snapshot.checkpoints.first(where: { $0.id == binding.checkpointId }),
                  checkpoint.kind == "integration" else { continue }
            chainGateIDs.insert(scope.chainId)
        }
        let chainIDsByBlock = Dictionary(grouping: snapshot.chainNodes, by: \.blockId)
        let blockCoverage = blocks.map { block in
            let checkpoints = checkpointGroups[block.id, default: []]
            let changeIDs = Set(changesByBlock[block.id, default: []].map(\.id))
            let checkpointBindings = checkpoints.flatMap { bindingsByCheckpoint[$0.id, default: []] }
            let exactBinding = checkpointBindings.contains {
                $0.subjectType == "plan_change" && changeIDs.contains($0.subjectId)
            }
            let memberChainIDs = Set(chainIDsByBlock[block.id, default: []].map(\.chainId))
            let relevantChainIDs = planID == nil
                ? memberChainIDs
                : Set(candidateScopes.filter { structuredStringList($0.nodeIds).contains(block.id) }.map(\.chainId))
            let checkpointRequired = planned.contains(block.id) || block.deliveryState == "complete"
            return BlockCoverage(
                blockID: block.id,
                hasCheckpoint: !checkpoints.isEmpty,
                checkpointRequired: checkpointRequired,
                missingRequiredCheckpoint: checkpointRequired && checkpoints.isEmpty,
                isCoveredByPlan: planned.contains(block.id),
                isCoveredByChain: chainMemberIDs.contains(block.id),
                isCoveredByAnyVerification: !checkpointBindings.isEmpty || checkpoints.contains(where: checkpointPasses),
                checkpointUnbound: planned.contains(block.id) && !checkpoints.isEmpty && !exactBinding,
                chainGateMissing: !relevantChainIDs.isEmpty && relevantChainIDs.contains { !chainGateIDs.contains($0) }
            )
        }
        let verified = Set(blocks.filter { block in
            checkpointGroups[block.id, default: []].contains { checkpointPasses($0) }
        }.map(\.id))
        let failing = blocks.filter { block in
            checkpointGroups[block.id, default: []].contains { ["failed", "blocked", "retest_required"].contains($0.status) }
        }.map(\.id)
        let withCheckpoints = Set(checkpointGroups.keys)
        return ArchitectureCoverage(
            totalBlocks: blocks.count,
            verifiedBlocks: verified.count,
            plannedBlocks: planned.count,
            blocksWithCheckpoints: blocks.filter { withCheckpoints.contains($0.id) }.count,
            outsideChainIDs: blocks.filter { !chainMemberIDs.contains($0.id) }.map(\.id),
            unplannedIDs: blocks.filter { !planned.contains($0.id) }.map(\.id),
            withoutCheckpointIDs: blocks.filter { !withCheckpoints.contains($0.id) && (planID == nil || planned.contains($0.id)) }.map(\.id),
            requiredCheckpointMissingIDs: blockCoverage.filter(\.missingRequiredCheckpoint).map(\.blockID),
            failingIDs: failing,
            verificationCoveredBlocks: blockCoverage.filter(\.isCoveredByAnyVerification).count,
            checkpointUnboundIDs: blockCoverage.filter(\.checkpointUnbound).map(\.blockID),
            chainGateMissingIDs: blockCoverage.filter(\.chainGateMissing).map(\.blockID),
            blocks: blockCoverage
        )
    }

    func directPlanChanges(for planID: String) -> [PlanChangeItem] {
        let scopedIDs = Set(snapshot.planChainChangeReferences.map(\.planChangeId))
        return planChanges(for: planID).filter { !scopedIDs.contains($0.id) }
    }

    func targetCheckpoints(for change: PlanChangeItem) -> [CheckpointItem] {
        snapshot.checkpoints.filter { $0.targetType == change.entityType && $0.targetId == change.entityId }
    }

    private func checkpointPasses(_ checkpoint: CheckpointItem) -> Bool {
        let levels = ["none", "static", "simulated", "integration", "real_target", "human_review"]
        let actual = levels.firstIndex(of: checkpoint.evidenceLevel) ?? 0
        let required = levels.firstIndex(of: checkpoint.requiredEvidenceLevel) ?? 0
        return checkpoint.status == "passed" && checkpoint.coverage == "complete" && checkpoint.invalidatedAt == nil && actual >= required
    }

    private func structuredStringList(_ value: String) -> [String] {
        guard let data = value.data(using: .utf8), let values = try? JSONDecoder().decode([String].self, from: data) else { return [] }
        return values
    }

    /// Only kinds present in this project are offered by the Canvas filter.
    /// This keeps the toolbar semantic and avoids empty or overlapping lenses.
    var availableLenses: [ViewLens] {
        let backgroundRuleIDs = Set(snapshot.backgroundScopes.map(\.blockId))
        let kinds = Set(snapshot.blocks.filter { !backgroundRuleIDs.contains($0.id) && $0.kind.lowercased() != "decision" }.map { $0.kind.lowercased() })
        return ViewLens.allCases.filter { kinds.contains($0.rawValue.lowercased()) }
    }

    var unassignedCheckpoints: [CheckpointItem] {
        let planIDs = Set(snapshot.planCheckpointReferences.map(\.checkpointId))
        let boundToPlan = Set(snapshot.checkpointBindings.filter {
            ["plan", "plan_change", "plan_chain_scope"].contains($0.subjectType)
        }.map(\.checkpointId))
        let activeBlockIDs = Set(snapshot.blocks.map(\.id))
        let activeChainIDs = Set(snapshot.chains.map(\.id))
        let activePlanIDs = Set(snapshot.plans.map(\.id))
        let activeLinkIDs = Set(snapshot.links.map(\.id))
        let unassigned = snapshot.checkpoints.filter { checkpoint in
            guard !planIDs.contains(checkpoint.id) && !boundToPlan.contains(checkpoint.id) else { return false }
            switch checkpoint.targetType {
            case "block": return activeBlockIDs.contains(checkpoint.targetId)
            case "chain": return activeChainIDs.contains(checkpoint.targetId)
            case "plan": return activePlanIDs.contains(checkpoint.targetId)
            case "link": return activeLinkIDs.contains(checkpoint.targetId)
            default: return false
            }
        }
        return Self.visibleVerificationCheckpoints(unassigned)
    }

    /// The sidebar is an inbox for work that still needs attention. Passed
    /// checkpoints remain available from their owning entity and History.
    static func visibleVerificationCheckpoints(_ checkpoints: [CheckpointItem]) -> [CheckpointItem] {
        checkpoints.filter {
            $0.status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() != "passed"
        }
    }

    func checkpointOwner(_ checkpoint: CheckpointItem) -> String {
        if let block = snapshot.blocks.first(where: { checkpoint.targetType == "block" && $0.id == checkpoint.targetId }) { return block.title }
        if let chain = snapshot.chains.first(where: { checkpoint.targetType == "chain" && $0.id == checkpoint.targetId }) { return chain.title }
        if let plan = snapshot.plans.first(where: { checkpoint.targetType == "plan" && $0.id == checkpoint.targetId }) { return plan.title }
        if let link = snapshot.links.first(where: { checkpoint.targetType == "link" && $0.id == checkpoint.targetId }) { return link.label.isEmpty ? link.kind : link.label }
        return "\(checkpoint.targetType):\(checkpoint.targetId)"
    }

    var visibleBlocks: [BlockItem] {
        guard !enabledLenses.isEmpty else { return [] }
        let backgroundRuleIDs = Set(snapshot.backgroundScopes.map(\.blockId))
        return snapshot.blocks.filter { block in
            // Legacy decision Blocks are deliberately not a Canvas projection.
            // New decisions are loaded from the independent Decision entity.
            block.kind.lowercased() != "decision" && enabledLenses.contains { $0.includes(block: block) }
        }
            .filter { !backgroundRuleIDs.contains($0.id) }
    }

    func ruleScopeLabel(_ blockID: String) -> String {
        snapshot.backgroundScopes.filter { $0.blockId == blockID }
            .map { "\($0.scopeType):\($0.scopeValue)" }
            .joined(separator: " · ")
    }

    func decisionScopeLabel(_ decisionID: String) -> String {
        let scopes = snapshot.decisionScopes.filter { $0.decisionID == decisionID }
            .map { "\($0.scopeType):\($0.scopeValue)" }
        return scopes.isEmpty ? (activeLocale == "zh-Hans" ? "项目范围" : "PROJECT") : scopes.joined(separator: " · ")
    }

    func setLens(_ lens: ViewLens, enabled: Bool) {
        if enabled {
            enabledLenses.insert(lens)
        } else {
            enabledLenses.remove(lens)
        }
    }

    func setSidebarSection(_ section: SidebarSection, collapsed: Bool) {
        if collapsed { collapsedSidebarSections.insert(section) }
        else { collapsedSidebarSections.remove(section) }
    }

    func isSidebarSectionCollapsed(_ section: SidebarSection) -> Bool {
        collapsedSidebarSections.contains(section)
    }

    func showOverview() {
        selection = nil
        highlightedChainIDs.removeAll()
        focusTarget = nil
        isolateFocused = false
        focusTask?.cancel()
        overviewFitRequestID = UUID()
    }

    func focusPlan(_ id: String) {
        let target = GraphSelection(type: .plan, id: id)
        selection = target
        highlightedChainIDs = planChainIDs(for: id)
        requestFocus(target)
    }

    func select(_ value: GraphSelection) {
        selection = value
        switch value.type {
        case .block:
            highlightedChainIDs.removeAll()
            focusTask?.cancel()
            focusTarget = nil
        case .chain:
            highlightedChainIDs = [value.id]
            requestFocus(value)
        case .plan:
            highlightedChainIDs = planChainIDs(for: value.id)
            requestFocus(value)
        case .link:
            break
        case .decision:
            highlightedChainIDs.removeAll()
            focusTask?.cancel()
            focusTarget = nil
        }
    }

    func clearSelection() {
        selection = nil
        highlightedChainIDs.removeAll()
        focusTarget = nil
    }

    func fitOverview() { overviewFitRequestID = UUID() }

    func exitFocus() {
        focusTask?.cancel()
        focusTarget = nil
        isolateFocused = false
    }

    func refreshIfChanged() {
        do {
            guard let location else { return }
            var databaseWasReplaced = false
            var replacementSnapshot: GraphSnapshot?
            if let currentIdentity = ProjectDatabase.fileIdentity(at: location.database),
               currentIdentity != databaseIdentity {
                // Git checkout commonly replaces the SQLite file by rename.
                // Reopening before reading the sequence prevents the old
                // connection from serving a stale branch snapshot, including
                // the case where both branches happen to share a sequence.
                let replacement = try ProjectDatabase(location: location)
                // Validate the new file before closing the known-good reader.
                // A checkout can briefly expose a file before its sidecars are
                // ready; the next polling tick should retry that replacement.
                replacementSnapshot = try replacement.loadSnapshot()
                let nextIdentity = replacement.fileIdentity
                database?.close()
                database = replacement
                databaseIdentity = nextIdentity
                databaseWasReplaced = true
            }
            guard let database else { return }
            let sequence = try database.changeSequence()
            guard databaseWasReplaced || sequence != snapshot.changeSequence else { return }
            let previousSequence = snapshot.changeSequence
            let next: GraphSnapshot
            if let replacementSnapshot {
                next = replacementSnapshot
            } else {
                next = try database.loadSnapshot()
            }
            let retainedSelection = selection.flatMap { Self.selection($0, existsIn: next) ? $0 : nil }
            let retainedFocus = focusTarget.flatMap { Self.selection($0, existsIn: next) ? $0 : nil }
            let retainedChainIDs = highlightedChainIDs.intersection(next.chains.map(\.id))
            let changed = next.latestChanges
                .filter { databaseWasReplaced || $0.sequence > previousSequence }
                .map { "\($0.entityType):\($0.entityId)" }
            withAnimation(.smooth(duration: 0.28)) {
                snapshot = next
                snapshotPresentationID = UUID()
                // A data refresh must not behave like navigation. Re-publish the
                // still-valid view state after the snapshot so SwiftUI keeps the
                // inspector, Chain emphasis, and camera focus attached to the same
                // semantic entity while its content changes underneath it.
                selection = retainedSelection
                focusTarget = retainedFocus
                highlightedChainIDs = retainedChainIDs
                isolateFocused = isolateFocused && retainedFocus != nil
                recentlyChangedRefs = Set(changed)
                errorMessage = nil
            }
            clearChangeTask?.cancel()
            clearChangeTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(1.4))
                guard !Task.isCancelled else { return }
                withAnimation(.easeOut(duration: 0.25)) {
                    self?.recentlyChangedRefs.removeAll()
                }
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    static func selection(_ selection: GraphSelection, existsIn snapshot: GraphSnapshot) -> Bool {
        switch selection.type {
        case .block: snapshot.blocks.contains { $0.id == selection.id }
        case .chain: snapshot.chains.contains { $0.id == selection.id }
        case .plan: snapshot.plans.contains { $0.id == selection.id }
        case .link: snapshot.links.contains { $0.id == selection.id }
        case .decision: snapshot.decisions.contains { $0.id == selection.id }
        }
    }

    private func startLiveUpdates() {
        fileWatcher?.cancel()
        fileWatcher = nil
        livePollingTask?.cancel()
        livePollingTask = nil
        refreshDebounceTask?.cancel()
        refreshDebounceTask = nil
        watchedDescriptor = -1
        guard let location else { return }
        let directory = location.root.appending(path: ".mdflow", directoryHint: .isDirectory).path
        let descriptor = open(directory, O_EVTONLY)
        guard descriptor >= 0 else { return }
        watchedDescriptor = descriptor
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: descriptor,
            eventMask: [.write, .extend, .attrib, .rename],
            queue: DispatchQueue.main
        )
        source.setEventHandler { [weak self] in self?.scheduleLiveRefresh() }
        source.setCancelHandler { close(descriptor) }
        fileWatcher = source
        source.resume()
        livePollingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled else { return }
                self?.refreshIfChanged()
            }
        }
    }

    private func scheduleLiveRefresh() {
        refreshDebounceTask?.cancel()
        refreshDebounceTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(70))
            guard !Task.isCancelled else { return }
            self?.refreshIfChanged()
        }
    }

    func title(for value: GraphSelection) -> String {
        switch value.type {
        case .block:
            return snapshot.blocks.first(where: { $0.id == value.id })?.title ?? value.id
        case .chain:
            return snapshot.chains.first(where: { $0.id == value.id })?.title ?? value.id
        case .link:
            return snapshot.links.first(where: { $0.id == value.id })?.label.nonEmpty ?? text("link")
        case .plan:
            return snapshot.plans.first(where: { $0.id == value.id })?.title ?? value.id
        case .decision:
            return snapshot.decisions.first(where: { $0.id == value.id })?.title ?? value.id
        }
    }

    var activeLocale: String {
        switch language {
        case .english: "en"
        case .zhHans: "zh-Hans"
        case .system: Locale.preferredLanguages.first?.hasPrefix("zh") == true ? "zh-Hans" : "en"
        }
    }

    nonisolated static func projectContent(
        _ canonical: String,
        appLanguage _: AppLanguage,
        localizations _: [LocalizedTextItem] = []
    ) -> String {
        canonical
    }

    func blockText(_ block: BlockItem, field: String) -> String {
        let canonical: String
        switch field { case "title": canonical = block.title; case "summary": canonical = block.summary; case "body": canonical = block.body; default: canonical = block.contract }
        return Self.projectContent(canonical, appLanguage: language, localizations: snapshot.localizations)
    }

    func chainText(_ chain: ChainItem, field: String) -> String {
        let canonical: String
        switch field { case "title": canonical = chain.title; case "intent": canonical = chain.intent; case "inputContract": canonical = chain.inputContract; default: canonical = chain.outputContract }
        return Self.projectContent(canonical, appLanguage: language, localizations: snapshot.localizations)
    }

    func planText(_ plan: PlanItem, field: String) -> String {
        let canonical: String
        switch field { case "title": canonical = plan.title; case "summary": canonical = plan.summary; case "goal": canonical = plan.goal; default: canonical = plan.nextAction }
        return Self.projectContent(canonical, appLanguage: language, localizations: snapshot.localizations)
    }

    func targetChains(for planID: String) -> [ChainItem] {
        var ids: [String] = []
        for chainID in snapshot.planChainReferences
            .filter({ $0.planId == planID })
            .sorted(by: { $0.position < $1.position })
            .map(\.chainId) {
            if !ids.contains(chainID) { ids.append(chainID) }
        }
        for chainID in snapshot.planChainScopes
            .filter({ $0.planId == planID })
            .sorted(by: { $0.position < $1.position })
            .map(\.chainId) {
            if !ids.contains(chainID) { ids.append(chainID) }
        }
        let byID = Dictionary(uniqueKeysWithValues: snapshot.chains.map { ($0.id, $0) })
        return ids.compactMap { byID[$0] }
    }

    /// Chain references and ChainScopes are both valid Plan path declarations.
    /// Foundation Plans commonly have scopes without a separate target-chain
    /// row, so the UI must project both forms.
    func planChainIDs(for planID: String) -> Set<String> {
        Set(snapshot.planChainReferences.filter { $0.planId == planID }.map(\.chainId))
            .union(snapshot.planChainScopes.filter { $0.planId == planID }.map(\.chainId))
    }

    /// Direct PlanChanges are first-class work.  Include step target refs as a
    /// compatibility path for older graphs that predate canonical changes.
    func planBlockIDs(for planID: String) -> Set<String> {
        var result = Set(snapshot.planChanges
            .filter { $0.planId == planID && $0.entityType == "block" }
            .map(\.entityId))
        for step in snapshot.planSteps where step.planId == planID {
            for ref in structuredStringList(step.targetReferences) where ref.hasPrefix("block:") {
                result.insert(String(ref.dropFirst("block:".count)))
            }
        }
        for scope in snapshot.planChainScopes where scope.planId == planID {
            result.formUnion(structuredStringList(scope.nodeIds))
        }
        for chainID in planChainIDs(for: planID) {
            result.formUnion(chainNodeIDs(chainID))
        }
        return result
    }

    func chainNodeIDs(_ chainID: String) -> [String] {
        snapshot.chainNodes.filter { $0.chainId == chainID }.sorted { $0.position < $1.position }.map(\.blockId)
    }

    func chainLinkIDs(_ chainID: String) -> Set<String> {
        Set(snapshot.chainEdges.filter { $0.chainId == chainID }.map(\.linkId))
    }

    func chains(containing blockID: String) -> [ChainItem] {
        let ids = Set(snapshot.chainNodes.filter { $0.blockId == blockID }.map(\.chainId))
        return snapshot.chains.filter { ids.contains($0.id) }.sorted { $0.id < $1.id }
    }

    func chainColor(_ chainID: String) -> Color {
        let ordered = snapshot.chains.map(\.id).sorted()
        return MdflowTheme.chainColor(index: ordered.firstIndex(of: chainID) ?? 0)
    }

    func incomingLinks(for blockID: String) -> [LinkItem] {
        snapshot.links.filter {
            $0.sourceType == "block" && $0.targetType == "block" && $0.targetId == blockID
        }.sorted { $0.id < $1.id }
    }

    func outgoingLinks(for blockID: String) -> [LinkItem] {
        snapshot.links.filter {
            $0.sourceType == "block" && $0.targetType == "block" && $0.sourceId == blockID
        }.sorted { $0.id < $1.id }
    }

    func block(_ id: String) -> BlockItem? {
        snapshot.blocks.first { $0.id == id }
    }

    func chainPosition(_ chainID: String, blockID: String) -> (index: Int, count: Int)? {
        let nodes = snapshot.chainNodes.filter { $0.chainId == chainID }.sorted { $0.position < $1.position }
        guard let index = nodes.firstIndex(where: { $0.blockId == blockID }) else { return nil }
        return (index, nodes.count)
    }

    func plans(containing blockID: String) -> [PlanItem] {
        let chainIDs = Set(snapshot.chainNodes.filter { $0.blockId == blockID }.map(\.chainId))
        let planIDs = Set(snapshot.planChainReferences.filter { chainIDs.contains($0.chainId) }.map(\.planId))
            .union(snapshot.planChainScopes.filter { chainIDs.contains($0.chainId) }.map(\.planId))
            .union(snapshot.planChanges.filter { $0.entityType == "block" && $0.entityId == blockID }.map(\.planId))
            .union(snapshot.planSteps.filter { step in
                structuredStringList(step.targetReferences).contains("block:\(blockID)")
            }.map(\.planId))
        return snapshot.plans.filter { planIDs.contains($0.id) }
    }

    func relatedBlockIDs(for selection: GraphSelection) -> Set<String> {
        switch selection.type {
        case .block:
            // A Block explains its architectural role through the entire connected
            // component. Limiting this to one hop hides downstream consequences.
            let links = snapshot.links.filter { $0.sourceType == "block" && $0.targetType == "block" }
            var adjacency: [String: Set<String>] = [:]
            for link in links {
                adjacency[link.sourceId, default: []].insert(link.targetId)
                adjacency[link.targetId, default: []].insert(link.sourceId)
            }
            var visited: Set<String> = [selection.id]
            var queue = [selection.id]
            while !queue.isEmpty {
                let current = queue.removeFirst()
                for neighbor in (adjacency[current] ?? []).sorted() where visited.insert(neighbor).inserted {
                    queue.append(neighbor)
                }
            }
            return visited
        case .chain:
            return Set(chainNodeIDs(selection.id))
        case .plan:
            return planBlockIDs(for: selection.id)
        case .link:
            guard let link = snapshot.links.first(where: { $0.id == selection.id }) else { return [] }
            return [link.sourceId, link.targetId]
        case .decision:
            return []
        }
    }

    func requestFocus(_ target: GraphSelection) {
        selection = target
        focusTarget = target
        focusTask?.cancel()
        focusRequestID = UUID()
    }

    func magnify(_ target: GraphSelection, minimumScale: CGFloat = 1.08) {
        canvasScale = max(canvasScale, minimumScale)
        requestFocus(target)
    }

    func isRelatedToFocus(_ blockID: String) -> Bool {
        guard let focusTarget else { return true }
        return relatedBlockIDs(for: focusTarget).contains(blockID)
    }

    func text(_ key: String) -> String {
        let zh: [String: String] = [
            "overview":"整体网络", "plans":"计划", "chains":"链路", "settings":"设置", "done":"完成",
            "summary":"摘要", "details":"详情", "contract":"契约", "files":"文件与代码", "checkpoints":"检查点", "history":"历史",
            "plugin":"CODEX 插件", "pluginHelp":"开发插件包位于当前项目中。", "revealPlugin":"在访达中显示插件",
            "installPlugin":"一键安装", "installingPlugin":"正在安装…", "pluginInstalled":"已安装；新任务中即可使用", "pluginInstallFailed":"安装失败",
            "liveData":"实时数据", "liveHelp":"变化会自动同步，无需刷新。", "language":"语言", "appearance":"外观", "system":"跟随系统", "light":"浅色", "dark":"深色",
            "english":"English", "chinese":"中文", "link":"关系", "input":"输入", "output":"输出",
            "goal":"目标", "nextAction":"下一步", "targetChains":"目标 Chain", "proposedDelta":"计划中的图变更", "blockers":"阻塞",
            "upstream":"直接上游", "downstream":"直接下游", "memberships":"所在 Chain", "relatedPlans":"关联 Plan", "path":"路径", "revision":"版本",
            "fitNetwork":"适配全图", "focusMode":"聚焦", "exitFocus":"退出聚焦", "isolate":"仅显示关联", "projectRules":"项目规则", "decisions":"架构决策",
            "openProject":"打开项目", "changeProject":"切换项目", "recentProjects":"最近项目", "openProjectHelp":"请选择包含 .mdflow/project.json 的项目目录。", "open":"打开",
            "all":"全部", "verification":"验证", "unassigned":"独立验证", "verified":"已验证", "unplanned":"未规划", "noCheckpoint":"无检查点", "checkpointFree":"待验证", "directBlockWork":"直接 Block 工作", "principle":"原则", "product":"产品", "requirement":"需求", "decision":"决策", "flow":"流程", "ui":"界面", "service":"服务", "function":"函数", "api":"API", "integration":"集成", "data":"数据", "database":"数据库", "risk":"风险", "test":"测试", "checkpoint":"检查点"
        ]
        let en: [String: String] = [
            "overview":"Full Network", "plans":"Plans", "chains":"Chains", "settings":"Settings", "done":"Done",
            "summary":"Summary", "details":"Details", "contract":"Contract", "files":"Files & Code", "checkpoints":"Checkpoints", "history":"History",
            "plugin":"CODEX PLUGIN", "pluginHelp":"The development plugin bundle is available in this project.", "revealPlugin":"Reveal Plugin",
            "installPlugin":"Install in Codex", "installingPlugin":"Installing…", "pluginInstalled":"Installed; available in new tasks", "pluginInstallFailed":"Installation failed",
            "liveData":"LIVE DATA", "liveHelp":"Changes appear automatically; no refresh is required.", "language":"Language", "appearance":"Appearance", "system":"System", "light":"Light", "dark":"Dark",
            "english":"English", "chinese":"中文", "link":"Link", "input":"Input", "output":"Output",
            "goal":"Goal", "nextAction":"Next Action", "targetChains":"Target Chains", "proposedDelta":"Proposed Graph Delta", "blockers":"Blockers",
            "upstream":"Direct Upstream", "downstream":"Direct Downstream", "memberships":"Chain Memberships", "relatedPlans":"Related Plans", "path":"Path", "revision":"Revision",
            "fitNetwork":"Fit Network", "focusMode":"Focus", "exitFocus":"Exit Focus", "isolate":"Related Only", "projectRules":"Project Rules", "decisions":"Architecture Decisions",
            "openProject":"Open Project", "changeProject":"Change Project", "recentProjects":"Recent Projects", "openProjectHelp":"Choose a project folder containing .mdflow/project.json.", "open":"Open",
            "all":"All", "verification":"Verification", "unassigned":"Standalone checks", "verified":"Verified", "unplanned":"Unplanned", "noCheckpoint":"No checkpoint", "checkpointFree":"Checkpoint-free", "directBlockWork":"Direct Block work", "principle":"Principle", "product":"Product", "requirement":"Requirement", "decision":"Decision", "flow":"Flow", "ui":"UI", "service":"Service", "function":"Function", "api":"API", "integration":"Integration", "data":"Data", "database":"Database", "risk":"Risk", "test":"Test", "checkpoint":"Checkpoint"
        ]
        return (activeLocale == "zh-Hans" ? zh : en)[key] ?? key
    }

    func lensTitle(_ lens: ViewLens) -> String {
        switch lens {
        case .principle: text("principle"); case .product: text("product"); case .requirement: text("requirement")
        case .flow: text("flow"); case .ui: text("ui"); case .service: text("service")
        case .function: text("function"); case .api: text("api"); case .integration: text("integration"); case .data: text("data")
        case .database: text("database"); case .risk: text("risk"); case .test: text("test"); case .checkpoint: text("checkpoint")
        }
    }

    func setCanvasOffset(_ value: CGSize) {
        canvasOffset = value
        persistCameraState(for: snapshot.project.id)
    }

    func zoom(by amount: CGFloat) {
        canvasScale = min(1.8, max(0.25, canvasScale + amount))
        persistCameraState(for: snapshot.project.id)
    }

    func setZoom(_ value: CGFloat) {
        canvasScale = min(1.8, max(0.25, value))
        persistCameraState(for: snapshot.project.id)
    }

    func resetZoom() {
        canvasScale = 1
        persistCameraState(for: snapshot.project.id)
    }

    func checkpoints(for value: GraphSelection) -> [CheckpointItem] {
        if value.type == .plan {
            let referenced = Set(snapshot.planCheckpointReferences.filter { $0.planId == value.id }.map(\.checkpointId))
            return snapshot.checkpoints.filter {
                ($0.targetType == value.type.rawValue && $0.targetId == value.id) || referenced.contains($0.id)
            }
        }
        return snapshot.checkpoints.filter { $0.targetType == value.type.rawValue && $0.targetId == value.id }
    }

    func planDependencies(for planID: String) -> [PlanItem] {
        let ids = snapshot.planDependencies.filter { $0.planId == planID }.sorted { $0.position < $1.position }.map(\.dependsOnPlanId)
        return ids.compactMap { id in snapshot.plans.first { $0.id == id } }
    }

    func planSteps(for planID: String) -> [PlanStep] {
        snapshot.planSteps.filter { $0.planId == planID }.sorted { $0.position < $1.position }
    }

    func planStepTargets(_ step: PlanStep) -> String {
        let blockIDs = Dictionary(uniqueKeysWithValues: snapshot.blocks.map { ($0.id, $0) })
        let chainIDs = Dictionary(uniqueKeysWithValues: snapshot.chains.map { ($0.id, $0) })
        let linkIDs = Dictionary(uniqueKeysWithValues: snapshot.links.map { ($0.id, $0) })
        let planIDs = Dictionary(uniqueKeysWithValues: snapshot.plans.map { ($0.id, $0) })
        return structuredStringList(step.targetReferences).map { ref in
            let parts = ref.split(separator: ":", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { return ref }
            switch parts[0] {
            case "block": return blockIDs[parts[1]]?.title ?? ref
            case "chain": return chainIDs[parts[1]]?.title ?? ref
            case "link": return linkIDs[parts[1]]?.label.nonEmpty ?? ref
            case "plan": return planIDs[parts[1]]?.title ?? ref
            default: return ref
            }
        }.joined(separator: " · ")
    }

    func planChainScopes(for planID: String) -> [PlanChainScopeItem] {
        snapshot.planChainScopes.filter { $0.planId == planID }.sorted { $0.position < $1.position }
    }

    func planChainNodePath(_ scope: PlanChainScopeItem) -> String {
        let requestedIDs = structuredStringList(scope.nodeIds)
        let nodeIDs = requestedIDs.isEmpty
            ? snapshot.chainNodes.filter { $0.chainId == scope.chainId }.sorted { $0.position < $1.position }.map(\.blockId)
            : requestedIDs
        return nodeIDs.map { blockID in
            snapshot.blocks.first { $0.id == blockID }.map { blockText($0, field: "title") } ?? "block:\(blockID)"
        }.joined(separator: " → ")
    }

    func planChainLinks(_ scope: PlanChainScopeItem) -> [String] {
        let requestedIDs = structuredStringList(scope.linkIds)
        let linkIDs = requestedIDs.isEmpty
            ? snapshot.chainEdges.filter { $0.chainId == scope.chainId }.sorted { $0.position < $1.position }.map(\.linkId)
            : requestedIDs
        return linkIDs.map { linkID in
            guard let link = snapshot.links.first(where: { $0.id == linkID }) else { return "link:\(linkID)" }
            return link.label.nonEmpty ?? link.kind
        }
    }

    func planChanges(for planID: String) -> [PlanChangeItem] {
        snapshot.planChanges.filter { $0.planId == planID }.sorted { $0.position < $1.position }
    }

    func planChanges(for scope: PlanChainScopeItem) -> [PlanChangeItem] {
        let ids = snapshot.planChainChangeReferences
            .filter { $0.chainScopeId == scope.id }
            .sorted { $0.position < $1.position }
            .map(\.planChangeId)
        return ids.compactMap { id in snapshot.planChanges.first { $0.id == id } }
    }

    func checkpoints(subjectType: String, subjectID: String) -> [CheckpointItem] {
        let ids = snapshot.checkpointBindings
            .filter { $0.subjectType == subjectType && $0.subjectId == subjectID }
            .sorted { $0.position < $1.position }
            .map(\.checkpointId)
        return ids.compactMap { id in snapshot.checkpoints.first { $0.id == id } }
    }

    func checkpointChildren(_ checkpointID: String) -> [(checkpoint: CheckpointItem, required: Bool)] {
        snapshot.checkpointDependencies
            .filter { $0.parentCheckpointId == checkpointID }
            .sorted { $0.position < $1.position }
            .compactMap { dependency in
                snapshot.checkpoints.first { $0.id == dependency.childCheckpointId }.map { ($0, dependency.required) }
            }
    }

    func checkpointBlockers(_ checkpointID: String) -> [CheckpointItem] {
        checkpointChildren(checkpointID)
            .filter { $0.required && $0.checkpoint.status != "passed" }
            .map(\.checkpoint)
    }

    func locatePlanChange(_ change: PlanChangeItem) {
        guard let type = GraphSelection.EntityType(rawValue: change.entityType) else { return }
        select(GraphSelection(type: type, id: change.entityId))
        requestFocus(GraphSelection(type: type, id: change.entityId))
    }

    func checkpointReference(planID: String, checkpointID: String) -> PlanCheckpointReference? {
        snapshot.planCheckpointReferences.first { $0.planId == planID && $0.checkpointId == checkpointID }
    }

    func history(for value: GraphSelection) -> [HistoryItem] {
        snapshot.history.filter { $0.entityType == value.type.rawValue && $0.entityId == value.id }
    }

    func sourceReferences(for blockID: String) -> [SourceReference] {
        snapshot.sourceReferences.filter { $0.blockId == blockID }
    }

    func revealSource(_ source: SourceReference) {
        guard let location else { return }
        let url = location.root.appending(path: source.path)
        NSWorkspace.shared.open(url)
    }

    func revealPlugin() {
        guard let location else { return }
        NSWorkspace.shared.activateFileViewerSelecting([
            location.root.appending(path: "plugins/mdflow")
        ])
    }

    func installPlugin() {
        guard pluginInstallStatus != .installing, let marketplaceRoot else { return }
        pluginInstallStatus = .installing
        Task {
            do {
                try await Task.detached { try PluginInstaller.install(marketplaceRoot: marketplaceRoot) }.value
                pluginInstallStatus = .installed
            } catch {
                pluginInstallStatus = .failed(error.localizedDescription)
            }
        }
    }

    private var marketplaceRoot: URL? {
        let manager = FileManager.default
        if let resources = Bundle.main.resourceURL {
            let embedded = resources.appending(path: "MarketplaceRoot", directoryHint: .isDirectory)
            if manager.fileExists(atPath: embedded.appending(path: ".agents/plugins/marketplace.json").path) { return embedded }
        }
        if let root = location?.root,
           manager.fileExists(atPath: root.appending(path: ".agents/plugins/marketplace.json").path) { return root }
        return nil
    }

    var databasePath: String { location?.database.path ?? "Unavailable" }
    var projectRoot: String { location?.root.path ?? "" }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
