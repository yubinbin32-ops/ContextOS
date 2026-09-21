import XCTest
@testable import ContextOSDesktop

@MainActor
final class GraphStoreTests: XCTestCase {
    private func checkpoint(
        id: String,
        targetType: String,
        targetId: String,
        status: String = "pending"
    ) -> CheckpointItem {
        CheckpointItem(
            id: id,
            targetType: targetType,
            targetId: targetId,
            title: id,
            criteria: "",
            status: status,
            kind: "atomic",
            aggregationPolicy: "{}",
            eligibleAfterChildren: false,
            evidenceLevel: status == "passed" ? "static" : "none",
            requiredEvidenceLevel: "none",
            coverage: status == "passed" ? "complete" : "unknown",
            evidence: "[]",
            invalidatedAt: nil,
            revision: 0,
            updatedAt: ""
        )
    }

    private func block(id: String, kind: String) -> BlockItem {
        BlockItem(
            id: id,
            kind: kind,
            title: id,
            summary: "",
            body: "",
            contract: "",
            scope: "",
            architectureLayer: "",
            localOrder: 0,
            deliveryState: "complete",
            healthState: "healthy",
            priority: "normal",
            revision: 0
        )
    }

    func testPlanCheckpointsAreNotDuplicatedAsStandaloneChecks() {
        let planCheckpoint = checkpoint(id: "cp-plan", targetType: "plan", targetId: "plan-1")
        let standaloneBlockCheckpoint = checkpoint(id: "cp-block", targetType: "block", targetId: "block-1")
        let passedStandalone = checkpoint(id: "cp-passed", targetType: "chain", targetId: "chain-1", status: "passed")

        let result = GraphStore.filterUnassignedCheckpoints(
            [planCheckpoint, standaloneBlockCheckpoint, passedStandalone],
            planCheckpointReferences: [
                PlanCheckpointReference(planId: "plan-1", checkpointId: "cp-plan", stepId: nil, position: 0, required: true)
            ],
            checkpointBindings: [],
            activeBlockIDs: ["block-1"],
            activeChainIDs: ["chain-1"],
            activePlanIDs: ["plan-1"],
            activeLinkIDs: []
        )

        XCTAssertEqual(result.map(\.id), ["cp-block"])
    }

    func testOrphanCheckpointTargetsAreNotShownInInbox() {
        let orphan = checkpoint(id: "cp-orphan", targetType: "block", targetId: "missing-block")
        let result = GraphStore.filterUnassignedCheckpoints(
            [orphan],
            planCheckpointReferences: [],
            checkpointBindings: [],
            activeBlockIDs: [],
            activeChainIDs: [],
            activePlanIDs: [],
            activeLinkIDs: []
        )

        XCTAssertTrue(result.isEmpty)
    }

    func testAvailableKindsPreserveRawCaseAndLanguage() {
        let kinds = GraphStore.availableKinds(from: [
            block(id: "a", kind: "API"),
            block(id: "b", kind: "custom-kind-中文"),
            block(id: "c", kind: "test"),
            block(id: "d", kind: "API"),
            block(id: "e", kind: "  decision  "),
        ])

        XCTAssertEqual(kinds, ["API", "custom-kind-中文", "decision", "test"])
    }
}
