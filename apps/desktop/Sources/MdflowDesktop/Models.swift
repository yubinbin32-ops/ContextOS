import Foundation

struct ProjectDescriptor: Decodable {
    let id: String
    let name: String
    let schemaVersion: Int
}

struct RecentProject: Identifiable, Codable, Equatable {
    var id: String { path }
    let path: String
    let name: String
}

struct ProjectInfo: Equatable {
    let id: String
    let name: String
    let root: String
    let graphRevision: Int
}

struct BlockItem: Identifiable, Equatable {
    let id: String
    let kind: String
    let title: String
    let summary: String
    let body: String
    let contract: String
    let scope: String
    let architectureLayer: String
    let localOrder: Int
    let deliveryState: String
    let healthState: String
    let priority: String
    let revision: Int

    var isGhost: Bool {
        deliveryState == "proposed" || deliveryState == "planned"
    }
}

struct ChainItem: Identifiable, Equatable {
    let id: String
    let title: String
    let purpose: String
    let intent: String
    let inputContract: String
    let outputContract: String
    let deliveryState: String
    let healthState: String
    let priority: String
    let revision: Int
}

struct LinkItem: Identifiable, Equatable {
    let id: String
    let sourceType: String
    let sourceId: String
    let targetType: String
    let targetId: String
    let kind: String
    let label: String
    let contract: String
    let healthState: String
    let revision: Int
}

struct ChainNode: Equatable {
    let chainId: String
    let blockId: String
    let position: Int
    let role: String
}

struct ChainEdge: Equatable {
    let chainId: String
    let linkId: String
    let position: Int
}

struct PlanItem: Identifiable, Equatable {
    let id: String
    let title: String
    let summary: String
    let goal: String
    let status: String
    let derivedStatus: String
    let statusReason: String
    let priority: String
    let phase: String
    let order: Int
    let proposedDelta: String
    let completionPolicy: String
    let nextAction: String
    let blockers: String
    let startedAt: String?
    let completedAt: String?
    let invalidatedAt: String?
    let progress: PlanProgress
    let revision: Int
}

struct PlanProgress: Equatable {
    let completedSteps: Int
    let totalSteps: Int
    let passedRequiredCheckpoints: Int
    let totalRequiredCheckpoints: Int
    let directBlockChanges: WorkProgress
    let chainChanges: WorkProgress
    let linkChanges: WorkProgress
    let chainIntegrationGates: GateProgress
    let planAcceptanceGates: GateProgress

    static let empty = PlanProgress(
        completedSteps: 0, totalSteps: 0, passedRequiredCheckpoints: 0, totalRequiredCheckpoints: 0,
        directBlockChanges: .empty, chainChanges: .empty, linkChanges: .empty,
        chainIntegrationGates: .empty, planAcceptanceGates: .empty
    )
}

struct WorkProgress: Equatable {
    let completed: Int
    let total: Int

    static let empty = WorkProgress(completed: 0, total: 0)
}

struct GateProgress: Equatable {
    let passed: Int
    let total: Int

    static let empty = GateProgress(passed: 0, total: 0)
}

struct BlockCoverage: Equatable {
    let blockID: String
    let hasCheckpoint: Bool
    let checkpointRequired: Bool
    let missingRequiredCheckpoint: Bool
    let isCoveredByPlan: Bool
    let isCoveredByChain: Bool
    let isCoveredByAnyVerification: Bool
    let checkpointUnbound: Bool
    let chainGateMissing: Bool
}

struct ArchitectureCoverage: Equatable {
    let totalBlocks: Int
    let verifiedBlocks: Int
    let plannedBlocks: Int
    let blocksWithCheckpoints: Int
    let outsideChainIDs: [String]
    let unplannedIDs: [String]
    let withoutCheckpointIDs: [String]
    let requiredCheckpointMissingIDs: [String]
    let failingIDs: [String]
    let verificationCoveredBlocks: Int
    let checkpointUnboundIDs: [String]
    let chainGateMissingIDs: [String]
    let blocks: [BlockCoverage]
}

struct PlanChainReference: Equatable {
    let planId: String
    let chainId: String
    let position: Int
}

struct PlanDependency: Equatable {
    let planId: String
    let dependsOnPlanId: String
    let position: Int
}

struct PlanStep: Identifiable, Equatable {
    let id: String
    let planId: String
    let position: Int
    let title: String
    let action: String
    let status: String
    let targetReferences: String
    let proposedDelta: String
    let updatedAt: String
}

struct PlanCheckpointReference: Equatable {
    let planId: String
    let checkpointId: String
    let stepId: String?
    let position: Int
    let required: Bool
}

struct PlanChainScopeItem: Identifiable, Equatable {
    let id: String
    let planId: String
    let chainId: String
    let position: Int
    let title: String
    let summary: String
    let rationale: String
    let startBlockId: String?
    let endBlockId: String?
    let nodeIds: String
    let linkIds: String
    let expectedDelta: String
    let prohibitions: String
    let status: String
    let revision: Int
}

struct PlanChangeItem: Identifiable, Equatable {
    let id: String
    let planId: String
    let entityType: String
    let entityId: String
    let position: Int
    let title: String
    let summary: String
    let currentBehavior: String
    let proposedBehavior: String
    let rationale: String
    let prohibitions: String
    let expectedEffects: String
    let sourceRefs: String
    let status: String
    let revision: Int
}

struct PlanChainChangeReference: Equatable {
    let chainScopeId: String
    let planChangeId: String
    let role: String
    let position: Int
}

struct BackgroundScope: Equatable {
    let blockId: String
    let scopeType: String
    let scopeValue: String
}

/// A Decision is project memory, not a Canvas node.  Only its scoped index is
/// loaded into the navigation context; the rationale and alternatives are
/// expanded in the detail drawer.
struct DecisionItem: Identifiable, Equatable {
    let id: String
    let title: String
    let summary: String
    let rationale: String
    let alternatives: String
    let consequences: String
    let status: String
    let supersedesDecisionID: String?
    let revision: Int
}

struct DecisionScope: Equatable {
    let decisionID: String
    let scopeType: String
    let scopeValue: String
}

struct SourceReference: Identifiable, Equatable {
    let id: String
    let blockId: String
    let path: String
    let startLine: Int?
    let endLine: Int?
    let symbol: String?
    let role: String
    let gitCommit: String?
}

struct CheckpointItem: Identifiable, Equatable {
    let id: String
    let targetType: String
    let targetId: String
    let title: String
    let criteria: String
    let status: String
    let kind: String
    let aggregationPolicy: String
    let eligibleAfterChildren: Bool
    let evidenceLevel: String
    let requiredEvidenceLevel: String
    let coverage: String
    let evidence: String
    let invalidatedAt: String?
    let revision: Int
    let updatedAt: String
}

struct CheckpointBinding: Equatable {
    let checkpointId: String
    let subjectType: String
    let subjectId: String
    let role: String
    let required: Bool
    let position: Int
}

struct CheckpointDependency: Equatable {
    let parentCheckpointId: String
    let childCheckpointId: String
    let position: Int
    let required: Bool
}

struct HistoryItem: Identifiable, Equatable {
    let id: Int
    let entityType: String
    let entityId: String
    let action: String
    let revision: Int
    let summary: String
    let planID: String?
    let chainScopeID: String?
    let changedFields: [String]
    let fieldDiffs: [HistoryFieldDiff]
    let affectedRefs: [String]
    let evidenceRefs: [String]
    let createdAt: String
}

struct HistoryFieldDiff: Identifiable, Equatable {
    var id: String { field }
    let field: String
    let before: String
    let after: String
}

struct ChangeItem: Equatable {
    let sequence: Int
    let entityType: String
    let entityId: String
    let action: String
}

struct LocalizedTextItem: Equatable {
    let entityType: String
    let entityId: String
    let locale: String
    let field: String
    let value: String
}

struct GraphSnapshot: Equatable {
    let project: ProjectInfo
    let changeSequence: Int
    let blocks: [BlockItem]
    let chains: [ChainItem]
    let plans: [PlanItem]
    let links: [LinkItem]
    let chainNodes: [ChainNode]
    let chainEdges: [ChainEdge]
    let planChainReferences: [PlanChainReference]
    let planDependencies: [PlanDependency]
    let planSteps: [PlanStep]
    let planCheckpointReferences: [PlanCheckpointReference]
    let planChainScopes: [PlanChainScopeItem]
    let planChanges: [PlanChangeItem]
    let planChainChangeReferences: [PlanChainChangeReference]
    let backgroundScopes: [BackgroundScope]
    let decisions: [DecisionItem]
    let decisionScopes: [DecisionScope]
    let sourceReferences: [SourceReference]
    let checkpoints: [CheckpointItem]
    let checkpointBindings: [CheckpointBinding]
    let checkpointDependencies: [CheckpointDependency]
    let localizations: [LocalizedTextItem]
    let history: [HistoryItem]
    let latestChanges: [ChangeItem]

    static func empty(name: String = "mdflow", root: String = "") -> GraphSnapshot {
        GraphSnapshot(
            project: ProjectInfo(id: "", name: name, root: root, graphRevision: 0),
            changeSequence: 0,
            blocks: [],
            chains: [],
            plans: [],
            links: [],
            chainNodes: [],
            chainEdges: [],
            planChainReferences: [],
            planDependencies: [],
            planSteps: [],
            planCheckpointReferences: [],
            planChainScopes: [],
            planChanges: [],
            planChainChangeReferences: [],
            backgroundScopes: [],
            decisions: [],
            decisionScopes: [],
            sourceReferences: [],
            checkpoints: [],
            checkpointBindings: [],
            checkpointDependencies: [],
            localizations: [],
            history: [],
            latestChanges: []
        )
    }
}

struct GraphSelection: Equatable, Hashable {
    enum EntityType: String {
        case block
        case chain
        case link
        case plan
        case decision
    }

    let type: EntityType
    let id: String
}

enum ViewLens: String, CaseIterable, Identifiable {
    // Canvas filters are a projection of the canonical Block.kind values.
    // Plans and QA are not kinds, so they must not appear as competing lenses.
    case principle = "Principle"
    case product = "Product"
    case requirement = "Requirement"
    case flow = "Flow"
    case ui = "UI"
    case service = "Service"
    case function = "Function"
    case api = "API"
    case integration = "Integration"
    case data = "Data"
    case database = "Database"
    case risk = "Risk"
    case test = "Test"
    case checkpoint = "Checkpoint"

    var id: String { rawValue }

    func includes(block: BlockItem) -> Bool {
        block.kind.caseInsensitiveCompare(rawValue) == .orderedSame
    }

    static func forKind(_ kind: String) -> ViewLens? {
        allCases.first { $0.rawValue.caseInsensitiveCompare(kind) == .orderedSame }
    }
}

enum SidebarSection: String, CaseIterable, Identifiable {
    case projectRules
    case decisions
    case plans
    case chains
    case verification

    var id: String { rawValue }
}

enum AppLanguage: String, CaseIterable, Identifiable {
    case system
    case zhHans = "zh-Hans"
    case english = "en"

    var id: String { rawValue }
}

enum AppearancePreference: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }
}
