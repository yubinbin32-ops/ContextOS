import CSQLite
import Foundation

private let transientDestructor = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// The SQLite file can be atomically replaced by a Git checkout while the App
/// is running.  A path-only comparison cannot detect that replacement because
/// the URL remains unchanged; the system file number is the stable identity we
/// need to decide when an existing read connection must be reopened.
struct DatabaseFileIdentity: Equatable {
    let systemFileNumber: UInt64
}

final class ProjectDatabase {
    enum DatabaseError: LocalizedError {
        case open(String)
        case prepare(String)
        case step(String)

        var errorDescription: String? {
            switch self {
            case .open(let message), .prepare(let message), .step(let message): message
            }
        }
    }

    private var handle: OpaquePointer?
    let location: ProjectLocation

    var fileIdentity: DatabaseFileIdentity? {
        Self.fileIdentity(at: location.database)
    }

    static func fileIdentity(at url: URL) -> DatabaseFileIdentity? {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              let value = attributes[.systemFileNumber] as? NSNumber else { return nil }
        return DatabaseFileIdentity(systemFileNumber: value.uint64Value)
    }

    init(location: ProjectLocation) throws {
        self.location = location
        guard FileManager.default.fileExists(atPath: location.database.path) else {
            throw CocoaError(.fileNoSuchFile, userInfo: [
                NSLocalizedDescriptionKey: "The mdflow database does not exist yet. Connect the mdflow MCP server to this project first."
            ])
        }
        // WAL readers need permission to create or reuse the shared-memory sidecar.
        // Open the file read-write, then enforce a query-only connection before any reads.
        let result = sqlite3_open_v2(location.database.path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil)
        guard result == SQLITE_OK else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "Unable to open database"
            throw DatabaseError.open(message)
        }
        sqlite3_busy_timeout(handle, 3_000)
        guard sqlite3_exec(handle, "PRAGMA query_only = ON", nil, nil, nil) == SQLITE_OK else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "Unable to enforce query-only mode"
            throw DatabaseError.open(message)
        }
    }

    deinit {
        close()
    }

    func close() {
        guard let handle else { return }
        sqlite3_close(handle)
        self.handle = nil
    }

    func changeSequence() throws -> Int {
        try scalarInt(
            "SELECT COALESCE(MAX(sequence), 0) FROM change_feed WHERE project_id = ?",
            bindings: [location.descriptor.id]
        )
    }

    func loadSnapshot() throws -> GraphSnapshot {
        let projectRows = try rows(
            "SELECT id, name, repo_root, graph_revision FROM projects WHERE id = ?",
            bindings: [location.descriptor.id]
        )
        guard let projectRow = projectRows.first else {
            throw DatabaseError.step("Project metadata is missing")
        }
        let project = ProjectInfo(
            id: projectRow.text("id"),
            name: projectRow.text("name"),
            // repo_root is a stable repository-relative marker in the
            // versioned database. The active checkout is runtime state owned
            // by ProjectLocation and may differ across clones or worktrees.
            root: location.root.path,
            graphRevision: projectRow.int("graph_revision")
        )
        let blocks = try rows(
            "SELECT * FROM blocks WHERE project_id = ? AND archived = 0 ORDER BY title",
            bindings: [project.id]
        ).map { row in
            BlockItem(
                id: row.text("id"),
                kind: row.text("kind"),
                title: row.text("title"),
                summary: row.text("summary"),
                body: row.text("body"),
                contract: row.text("contract"),
                scope: row.text("scope"),
                architectureLayer: row.text("architecture_layer"),
                localOrder: row.int("local_order"),
                deliveryState: row.text("delivery_state"),
                healthState: row.text("health_state"),
                priority: row.text("priority"),
                revision: row.int("current_revision")
            )
        }
        let chains = try rows(
            "SELECT * FROM chains WHERE project_id = ? AND archived = 0 ORDER BY updated_at DESC",
            bindings: [project.id]
        ).map { row in
            ChainItem(
                id: row.text("id"),
                title: row.text("title"),
                purpose: row.text("purpose"),
                intent: row.text("intent"),
                inputContract: row.text("input_contract"),
                outputContract: row.text("output_contract"),
                deliveryState: row.text("delivery_state"),
                healthState: row.text("health_state"),
                priority: row.text("priority"),
                revision: row.int("current_revision")
            )
        }
        var plans = try rows(
            "SELECT * FROM plans WHERE project_id = ? AND archived = 0 ORDER BY updated_at DESC",
            bindings: [project.id]
        ).map { row in
            PlanItem(
                id: row.text("id"), title: row.text("title"), summary: row.text("summary"),
                goal: row.text("goal"), status: row.text("status"), derivedStatus: row.text("status"),
                statusReason: row.text("status_reason"), priority: row.text("priority"),
                phase: row.text("phase").isEmpty ? "implementation" : row.text("phase"), order: row.int("plan_order"),
                proposedDelta: row.text("proposed_delta_json"), completionPolicy: row.text("completion_policy_json"),
                nextAction: row.text("next_action"), blockers: row.text("blockers_json"),
                startedAt: row.optionalText("started_at"), completedAt: row.optionalText("completed_at"),
                invalidatedAt: row.optionalText("invalidated_at"), progress: .empty,
                revision: row.int("current_revision")
            )
        }
        let links = try rows(
            "SELECT * FROM links WHERE project_id = ? AND archived = 0 ORDER BY created_at",
            bindings: [project.id]
        ).map { row in
            LinkItem(
                id: row.text("id"),
                sourceType: row.text("source_type"),
                sourceId: row.text("source_id"),
                targetType: row.text("target_type"),
                targetId: row.text("target_id"),
                kind: row.text("kind"),
                label: row.text("label"),
                contract: row.text("contract"),
                healthState: row.text("health_state"),
                revision: row.int("current_revision")
            )
        }
        let chainNodes = try rows(
            """
            SELECT cn.* FROM chain_nodes cn JOIN chains c ON c.id = cn.chain_id
            WHERE c.project_id = ? AND c.archived = 0 ORDER BY cn.chain_id, cn.position
            """,
            bindings: [project.id]
        ).map { row in
            ChainNode(chainId: row.text("chain_id"), blockId: row.text("block_id"), position: row.int("position"), role: row.text("role"))
        }
        let chainEdges = try rows(
            """
            SELECT ce.* FROM chain_edges ce JOIN chains c ON c.id = ce.chain_id
            WHERE c.project_id = ? AND c.archived = 0 ORDER BY ce.chain_id, ce.position
            """,
            bindings: [project.id]
        ).map { row in
            ChainEdge(chainId: row.text("chain_id"), linkId: row.text("link_id"), position: row.int("position"))
        }
        let planChainReferences = try rows(
            """
            SELECT pcr.* FROM plan_chain_refs pcr JOIN plans p ON p.id = pcr.plan_id
            WHERE p.project_id = ? AND p.archived = 0 ORDER BY pcr.plan_id, pcr.position
            """,
            bindings: [project.id]
        ).map { row in
            PlanChainReference(planId: row.text("plan_id"), chainId: row.text("chain_id"), position: row.int("position"))
        }
        let planDependencies = try optionalRows(
            """
            SELECT pd.* FROM plan_dependencies pd JOIN plans p ON p.id = pd.plan_id
            WHERE p.project_id = ? AND p.archived = 0 ORDER BY pd.plan_id, pd.position
            """,
            table: "plan_dependencies", bindings: [project.id]
        ).map { row in
            PlanDependency(planId: row.text("plan_id"), dependsOnPlanId: row.text("depends_on_plan_id"), position: row.int("position"))
        }
        let planSteps = try optionalRows(
            """
            SELECT ps.* FROM plan_steps ps JOIN plans p ON p.id = ps.plan_id
            WHERE p.project_id = ? AND p.archived = 0 ORDER BY ps.plan_id, ps.position
            """,
            table: "plan_steps", bindings: [project.id]
        ).map { row in
            PlanStep(
                id: row.text("id"), planId: row.text("plan_id"), position: row.int("position"),
                title: row.text("title"), action: row.text("action"), status: row.text("status"),
                targetReferences: row.text("target_refs_json"), proposedDelta: row.text("proposed_delta_json"),
                updatedAt: row.text("updated_at")
            )
        }
        let planCheckpointReferences = try optionalRows(
            """
            SELECT pcr.* FROM plan_checkpoint_refs pcr JOIN plans p ON p.id = pcr.plan_id
            WHERE p.project_id = ? AND p.archived = 0 ORDER BY pcr.plan_id, pcr.position
            """,
            table: "plan_checkpoint_refs", bindings: [project.id]
        ).map { row in
            PlanCheckpointReference(
                planId: row.text("plan_id"), checkpointId: row.text("checkpoint_id"),
                stepId: row.optionalText("step_id"), position: row.int("position"), required: row.int("required") != 0
            )
        }
        let planChainScopes = try optionalRows(
            """
            SELECT pcs.* FROM plan_chain_scopes pcs JOIN plans p ON p.id = pcs.plan_id
            WHERE p.project_id = ? AND p.archived = 0 ORDER BY pcs.plan_id, pcs.position
            """,
            table: "plan_chain_scopes", bindings: [project.id]
        ).map { row in
            PlanChainScopeItem(
                id: row.text("id"), planId: row.text("plan_id"), chainId: row.text("chain_id"),
                position: row.int("position"), title: row.text("title"), summary: row.text("summary"),
                rationale: row.text("rationale"), startBlockId: row.optionalText("start_block_id"),
                endBlockId: row.optionalText("end_block_id"), nodeIds: row.text("node_ids_json"),
                linkIds: row.text("link_ids_json"), expectedDelta: row.text("expected_delta_json"),
                prohibitions: row.text("prohibitions_json"), status: row.text("status"),
                revision: row.int("current_revision")
            )
        }
        let planChanges = try optionalRows(
            """
            SELECT pc.* FROM plan_changes pc JOIN plans p ON p.id = pc.plan_id
            WHERE p.project_id = ? AND p.archived = 0 ORDER BY pc.plan_id, pc.position
            """,
            table: "plan_changes", bindings: [project.id]
        ).map { row in
            PlanChangeItem(
                id: row.text("id"), planId: row.text("plan_id"), entityType: row.text("entity_type"),
                entityId: row.text("entity_id"), position: row.int("position"), title: row.text("title"),
                summary: row.text("summary"), currentBehavior: row.text("current_behavior"),
                proposedBehavior: row.text("proposed_behavior"), rationale: row.text("rationale"),
                prohibitions: row.text("prohibitions_json"), expectedEffects: row.text("expected_effects_json"),
                sourceRefs: row.text("source_refs_json"), status: row.text("status"),
                revision: row.int("current_revision")
            )
        }
        let planChainChangeReferences = try optionalRows(
            """
            SELECT pccr.* FROM plan_chain_change_refs pccr
            JOIN plan_chain_scopes pcs ON pcs.id = pccr.chain_scope_id
            JOIN plans p ON p.id = pcs.plan_id
            WHERE p.project_id = ? AND p.archived = 0 ORDER BY pccr.chain_scope_id, pccr.position
            """,
            table: "plan_chain_change_refs", bindings: [project.id]
        ).map { row in
            PlanChainChangeReference(
                chainScopeId: row.text("chain_scope_id"), planChangeId: row.text("plan_change_id"),
                role: row.text("role"), position: row.int("position")
            )
        }
        let backgroundScopes = try rows(
            """
            SELECT bs.* FROM background_scopes bs JOIN blocks b ON b.id = bs.block_id
            WHERE b.project_id = ? AND b.archived = 0 ORDER BY bs.block_id
            """,
            bindings: [project.id]
        ).map { row in
            BackgroundScope(blockId: row.text("block_id"), scopeType: row.text("scope_type"), scopeValue: row.text("scope_value"))
        }
        let decisions = try optionalRows(
            "SELECT * FROM decisions WHERE project_id = ? AND archived = 0 ORDER BY updated_at DESC, id",
            table: "decisions", bindings: [project.id]
        ).map { row in
            DecisionItem(
                id: row.text("id"), title: row.text("title"), summary: row.text("summary"),
                rationale: row.text("rationale"), alternatives: row.text("alternatives_json"),
                consequences: row.text("consequences_json"), status: row.text("status"),
                supersedesDecisionID: row.optionalText("supersedes_decision_id"),
                revision: row.int("current_revision")
            )
        }
        let decisionScopes = try optionalRows(
            """
            SELECT ds.* FROM decision_scopes ds JOIN decisions d ON d.id = ds.decision_id
            WHERE d.project_id = ? AND d.archived = 0 ORDER BY ds.decision_id, ds.scope_type, ds.scope_value
            """,
            table: "decision_scopes", bindings: [project.id]
        ).map { row in
            DecisionScope(decisionID: row.text("decision_id"), scopeType: row.text("scope_type"), scopeValue: row.text("scope_value"))
        }
        let sourceReferences = try rows(
            """
            SELECT sr.* FROM source_refs sr
            JOIN blocks b ON b.id = sr.block_id
            WHERE b.project_id = ? ORDER BY sr.path, sr.start_line
            """,
            bindings: [project.id]
        ).map { row in
            SourceReference(
                id: row.text("id"),
                blockId: row.text("block_id"),
                path: row.text("path"),
                startLine: row.optionalInt("start_line"),
                endLine: row.optionalInt("end_line"),
                symbol: row.optionalText("symbol"),
                role: row.text("role"),
                gitCommit: row.optionalText("git_commit")
            )
        }
        var checkpoints = try rows(
            "SELECT * FROM checkpoints WHERE project_id = ? ORDER BY updated_at DESC",
            bindings: [project.id]
        ).map { row in
            CheckpointItem(
                id: row.text("id"),
                targetType: row.text("target_type"),
                targetId: row.text("target_id"),
                title: row.text("title"),
                criteria: row.text("criteria"),
                status: row.text("status"),
                kind: row.text("checkpoint_kind").isEmpty ? "atomic" : row.text("checkpoint_kind"),
                aggregationPolicy: row.text("aggregation_policy_json").isEmpty ? "{}" : row.text("aggregation_policy_json"),
                eligibleAfterChildren: row.int("eligible_after_children") != 0,
                evidenceLevel: row.text("evidence_level").isEmpty ? "none" : row.text("evidence_level"),
                requiredEvidenceLevel: row.text("required_evidence_level").isEmpty ? "static" : row.text("required_evidence_level"),
                coverage: row.text("coverage").isEmpty ? "complete" : row.text("coverage"),
                evidence: row.text("evidence_json"),
                invalidatedAt: row.optionalText("invalidated_at"),
                revision: row.int("current_revision"),
                updatedAt: row.text("updated_at")
            )
        }
        let checkpointBindings = try optionalRows(
            """
            SELECT cb.* FROM checkpoint_bindings cb JOIN checkpoints c ON c.id = cb.checkpoint_id
            WHERE c.project_id = ? ORDER BY cb.checkpoint_id, cb.position
            """,
            table: "checkpoint_bindings", bindings: [project.id]
        ).map { row in
            CheckpointBinding(
                checkpointId: row.text("checkpoint_id"), subjectType: row.text("subject_type"),
                subjectId: row.text("subject_id"), role: row.text("role"),
                required: row.int("required") != 0, position: row.int("position")
            )
        }
        let checkpointDependencies = try optionalRows(
            """
            SELECT cd.* FROM checkpoint_dependencies cd JOIN checkpoints c ON c.id = cd.parent_checkpoint_id
            WHERE c.project_id = ? ORDER BY cd.parent_checkpoint_id, cd.position
            """,
            table: "checkpoint_dependencies", bindings: [project.id]
        ).map { row in
            CheckpointDependency(
                parentCheckpointId: row.text("parent_checkpoint_id"), childCheckpointId: row.text("child_checkpoint_id"),
                position: row.int("position"), required: row.int("required") != 0
            )
        }
        checkpoints = Self.deriveCheckpoints(checkpoints, dependencies: checkpointDependencies)
        plans = plans.map { plan in
            Self.derive(plan: plan, allPlans: plans, dependencies: planDependencies, steps: planSteps,
                        checkpointReferences: planCheckpointReferences, checkpoints: checkpoints,
                        chainScopes: planChainScopes, changes: planChanges, bindings: checkpointBindings)
        }.sorted { left, right in
            if left.phase != right.phase { return left.phase < right.phase }
            if left.order != right.order { return left.order < right.order }
            return left.title.localizedCaseInsensitiveCompare(right.title) == .orderedAscending
        }
        // Project facts are canonical content, not App-localized UI strings. Keep the
        // legacy table readable by older releases, but do not load translation copies
        // into the live Canvas snapshot.
        let localizations: [LocalizedTextItem] = []
        let history = try rows(
            """
            SELECT h.* FROM history h
            JOIN change_sets cs ON cs.id = h.change_set_id
            WHERE cs.project_id = ? ORDER BY h.id DESC LIMIT 250
            """,
            bindings: [project.id]
        ).map { row in
            let changedFields = Self.jsonStringArray(row.text("changed_fields_json"))
            return HistoryItem(
                id: row.int("id"),
                entityType: row.text("entity_type"),
                entityId: row.text("entity_id"),
                action: row.text("action"),
                revision: row.int("revision"),
                summary: row.text("summary"),
                planID: row.optionalText("plan_id"),
                chainScopeID: row.optionalText("chain_scope_id"),
                changedFields: changedFields,
                fieldDiffs: Self.historyFieldDiffs(
                    beforeJSON: row.text("before_json"),
                    afterJSON: row.text("after_json"),
                    fields: changedFields
                ),
                affectedRefs: Self.jsonStringArray(row.text("affected_refs_json")),
                evidenceRefs: Self.jsonStringArray(row.text("evidence_refs_json")),
                createdAt: row.text("created_at")
            )
        }
        let latestChanges = try rows(
            """
            SELECT sequence, entity_type, entity_id, action FROM change_feed
            WHERE project_id = ? ORDER BY sequence DESC LIMIT 10
            """,
            bindings: [project.id]
        ).map { row in
            ChangeItem(
                sequence: row.int("sequence"),
                entityType: row.text("entity_type"),
                entityId: row.text("entity_id"),
                action: row.text("action")
            )
        }
        return GraphSnapshot(
            project: project,
            changeSequence: latestChanges.first?.sequence ?? 0,
            blocks: blocks,
            chains: chains,
            plans: plans,
            links: links,
            chainNodes: chainNodes,
            chainEdges: chainEdges,
            planChainReferences: planChainReferences,
            planDependencies: planDependencies,
            planSteps: planSteps,
            planCheckpointReferences: planCheckpointReferences,
            planChainScopes: planChainScopes,
            planChanges: planChanges,
            planChainChangeReferences: planChainChangeReferences,
            backgroundScopes: backgroundScopes,
            decisions: decisions,
            decisionScopes: decisionScopes,
            sourceReferences: sourceReferences,
            checkpoints: checkpoints,
            checkpointBindings: checkpointBindings,
            checkpointDependencies: checkpointDependencies,
            localizations: localizations,
            history: history,
            latestChanges: latestChanges
        )
    }

    private func scalarInt(_ sql: String, bindings: [String]) throws -> Int {
        let result = try rows(sql, bindings: bindings)
        return result.first?.values.values.first.flatMap(Int.init) ?? 0
    }

    private static func jsonStringArray(_ value: String) -> [String] {
        guard let data = value.data(using: .utf8),
              let decoded = try? JSONSerialization.jsonObject(with: data) as? [Any] else { return [] }
        return decoded.compactMap { $0 as? String }
    }

    static func historyFieldDiffs(beforeJSON: String, afterJSON: String, fields: [String]) -> [HistoryFieldDiff] {
        func object(_ value: String) -> [String: Any] {
            guard let data = value.data(using: .utf8),
                  let decoded = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
            return decoded
        }
        func display(_ value: Any?) -> String {
            guard let value, !(value is NSNull) else { return "—" }
            if let value = value as? String { return value.isEmpty ? "∅" : value }
            if let value = value as? NSNumber { return value.stringValue }
            guard JSONSerialization.isValidJSONObject(value),
                  let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
                  let text = String(data: data, encoding: .utf8) else { return String(describing: value) }
            return text.count > 240 ? String(text.prefix(237)) + "…" : text
        }
        let before = object(beforeJSON)
        let after = object(afterJSON)
        return fields.map { field in
            HistoryFieldDiff(field: field, before: display(before[field]), after: display(after[field]))
        }
    }

    private func optionalRows(_ sql: String, table: String, bindings: [String]) throws -> [SQLiteRow] {
        let exists = try rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", bindings: [table])
        return exists.isEmpty ? [] : try rows(sql, bindings: bindings)
    }

    private static func derive(
        plan: PlanItem, allPlans: [PlanItem], dependencies: [PlanDependency], steps: [PlanStep],
        checkpointReferences: [PlanCheckpointReference], checkpoints: [CheckpointItem],
        chainScopes: [PlanChainScopeItem], changes: [PlanChangeItem], bindings: [CheckpointBinding]
    ) -> PlanItem {
        let ownSteps = steps.filter { $0.planId == plan.id }
        let ownScopes = chainScopes.filter { $0.planId == plan.id }
        let ownChanges = changes.filter { $0.planId == plan.id }
        let changeIDs = Set(ownChanges.map(\.id))
        let referencedIDs = Set(checkpointReferences.filter { $0.planId == plan.id && $0.required }.map(\.checkpointId))
        let scopedIDs = Set(bindings.filter { binding in
            (binding.subjectType == "plan" && binding.subjectId == plan.id) ||
                (binding.subjectType == "plan_chain_scope" && ownScopes.contains { $0.id == binding.subjectId }) ||
                (binding.subjectType == "plan_change" && changeIDs.contains(binding.subjectId))
        }.filter(\.required).map(\.checkpointId))
        let directIDs = Set(checkpoints.filter { $0.targetType == "plan" && $0.targetId == plan.id }.map(\.id))
        let gateIDs = referencedIDs.union(scopedIDs).union(directIDs)
        let gates = gateIDs.compactMap { id in checkpoints.first { $0.id == id } }
        let passed = gates.filter { checkpoint in
            checkpoint.status == "passed" && checkpoint.coverage == "complete" && checkpoint.invalidatedAt == nil &&
                evidenceRank(checkpoint.evidenceLevel) >= evidenceRank(checkpoint.requiredEvidenceLevel)
        }.count
        let usesDetailedChanges = !ownScopes.isEmpty || !ownChanges.isEmpty
        let completedWork = usesDetailedChanges
            ? ownChanges.filter { ["complete", "passed"].contains($0.status) }.count
            : ownSteps.filter { ["complete", "skipped"].contains($0.status) }.count
        let totalWork = usesDetailedChanges ? ownChanges.count : ownSteps.count
        let progress = PlanProgress(
            completedSteps: completedWork,
            totalSteps: totalWork,
            passedRequiredCheckpoints: passed,
            totalRequiredCheckpoints: gates.count,
            directBlockChanges: workProgress(ownChanges.filter { $0.entityType == "block" }),
            chainChanges: workProgress(ownChanges.filter { $0.entityType == "chain" }),
            linkChanges: workProgress(ownChanges.filter { $0.entityType == "link" }),
            chainIntegrationGates: gateProgress(
                Set(bindings.filter { binding in
                    binding.required && binding.subjectType == "plan_chain_scope" && ownScopes.contains { $0.id == binding.subjectId }
                }.map(\.checkpointId)),
                checkpoints: checkpoints
            ),
            planAcceptanceGates: gateProgress(
                referencedIDs.union(directIDs).union(Set(bindings.filter {
                    $0.required && $0.subjectType == "plan" && $0.subjectId == plan.id
                }.map(\.checkpointId))),
                checkpoints: checkpoints
            )
        )
        var status = plan.status
        var reason = plan.statusReason
        if plan.invalidatedAt != nil || gates.contains(where: { $0.invalidatedAt != nil || $0.status == "retest_required" }) {
            status = "retest_required"; if reason.isEmpty { reason = "Required evidence must be run again." }
        } else if ownSteps.contains(where: { $0.status == "failed" }) || gates.contains(where: { $0.status == "failed" }) {
            status = "failed"; if reason.isEmpty { reason = "A required step or checkpoint failed." }
        } else if ownSteps.contains(where: { $0.status == "blocked" }) || gates.contains(where: { $0.status == "blocked" }) || plan.blockers != "[]" {
            status = "blocked"; if reason.isEmpty { reason = "A blocker prevents progress." }
        } else if dependencies.filter({ $0.planId == plan.id }).contains(where: { dependency in
            allPlans.first(where: { $0.id == dependency.dependsOnPlanId })?.status != "complete"
        }) {
            status = "ready"; if reason.isEmpty { reason = "Waiting for prerequisite Plans." }
        } else if totalWork > 0 && progress.completedSteps == totalWork && !gates.isEmpty && passed == gates.count {
            status = "complete"; if reason.isEmpty { reason = "All ordered steps and required gates passed." }
        } else if totalWork > 0 && progress.completedSteps == totalWork {
            status = "verifying"; if reason.isEmpty { reason = "Implementation is complete; evidence remains." }
        }
        return PlanItem(
            id: plan.id, title: plan.title, summary: plan.summary, goal: plan.goal, status: plan.status,
            derivedStatus: status, statusReason: reason, priority: plan.priority, phase: plan.phase, order: plan.order,
            proposedDelta: plan.proposedDelta, completionPolicy: plan.completionPolicy, nextAction: plan.nextAction,
            blockers: plan.blockers, startedAt: plan.startedAt, completedAt: plan.completedAt,
            invalidatedAt: plan.invalidatedAt, progress: progress, revision: plan.revision
        )
    }

    private static func workProgress(_ changes: [PlanChangeItem]) -> WorkProgress {
        WorkProgress(
            completed: changes.filter { ["complete", "passed"].contains($0.status) }.count,
            total: changes.count
        )
    }

    private static func gateProgress(_ ids: Set<String>, checkpoints: [CheckpointItem]) -> GateProgress {
        let gates = ids.compactMap { id in checkpoints.first { $0.id == id } }
        return GateProgress(
            passed: gates.filter { checkpoint in
                checkpoint.status == "passed" && checkpoint.coverage == "complete" && checkpoint.invalidatedAt == nil &&
                    evidenceRank(checkpoint.evidenceLevel) >= evidenceRank(checkpoint.requiredEvidenceLevel)
            }.count,
            total: gates.count
        )
    }

    private static func deriveCheckpoints(_ values: [CheckpointItem], dependencies: [CheckpointDependency]) -> [CheckpointItem] {
        var byID = Dictionary(uniqueKeysWithValues: values.map { ($0.id, $0) })
        for _ in 0...dependencies.count {
            for checkpoint in values {
                let childRefs = dependencies.filter { $0.parentCheckpointId == checkpoint.id }
                guard !childRefs.isEmpty else { continue }
                let required = childRefs.filter(\.required).compactMap { byID[$0.childCheckpointId] }
                let statuses = required.map(\.status)
                var status = checkpoint.status
                var evidence = checkpoint.evidenceLevel
                if required.contains(where: { $0.invalidatedAt != nil || $0.status == "retest_required" }) { status = "retest_required" }
                else if statuses.contains("failed") { status = "failed" }
                else if statuses.contains("blocked") { status = "blocked" }
                else if !required.isEmpty && required.allSatisfy({ checkpointPasses($0) }) {
                    if checkpoint.kind == "integration" || checkpoint.eligibleAfterChildren {
                        status = checkpoint.status
                    } else {
                        let rank = required.map { evidenceRank($0.evidenceLevel) }.min() ?? 0
                        evidence = evidenceName(rank)
                        status = rank >= evidenceRank(checkpoint.requiredEvidenceLevel) ? "passed" : "partial_pass"
                    }
                } else if statuses.contains("running") { status = "running" }
                else if statuses.contains(where: { ["passed", "partial_pass"].contains($0) }) { status = "partial_pass" }
                else { status = "pending" }
                byID[checkpoint.id] = CheckpointItem(
                    id: checkpoint.id, targetType: checkpoint.targetType, targetId: checkpoint.targetId,
                    title: checkpoint.title, criteria: checkpoint.criteria, status: status, kind: checkpoint.kind,
                    aggregationPolicy: checkpoint.aggregationPolicy, eligibleAfterChildren: checkpoint.eligibleAfterChildren,
                    evidenceLevel: evidence, requiredEvidenceLevel: checkpoint.requiredEvidenceLevel,
                    coverage: checkpoint.coverage, evidence: checkpoint.evidence, invalidatedAt: checkpoint.invalidatedAt,
                    revision: checkpoint.revision, updatedAt: checkpoint.updatedAt
                )
            }
        }
        return values.compactMap { byID[$0.id] }
    }

    private static func checkpointPasses(_ checkpoint: CheckpointItem) -> Bool {
        checkpoint.status == "passed" && checkpoint.coverage == "complete" && checkpoint.invalidatedAt == nil &&
            evidenceRank(checkpoint.evidenceLevel) >= evidenceRank(checkpoint.requiredEvidenceLevel)
    }

    private static func evidenceName(_ rank: Int) -> String {
        let values = ["none", "static", "simulated", "integration", "real_target", "human_review"]
        return values[min(max(rank, 0), values.count - 1)]
    }

    private static func evidenceRank(_ value: String) -> Int {
        ["none", "static", "simulated", "integration", "real_target", "human_review"].firstIndex(of: value) ?? 0
    }

    private func rows(_ sql: String, bindings: [String] = []) throws -> [SQLiteRow] {
        guard let handle else { throw DatabaseError.open("Database is closed") }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw DatabaseError.prepare(String(cString: sqlite3_errmsg(handle)))
        }
        defer { sqlite3_finalize(statement) }
        for (index, value) in bindings.enumerated() {
            sqlite3_bind_text(statement, Int32(index + 1), value, -1, transientDestructor)
        }
        var output: [SQLiteRow] = []
        while true {
            let result = sqlite3_step(statement)
            if result == SQLITE_DONE { break }
            guard result == SQLITE_ROW else {
                throw DatabaseError.step(String(cString: sqlite3_errmsg(handle)))
            }
            var values: [String: String] = [:]
            var nulls: Set<String> = []
            for columnIndex in 0..<sqlite3_column_count(statement) {
                let name = String(cString: sqlite3_column_name(statement, columnIndex))
                if sqlite3_column_type(statement, columnIndex) == SQLITE_NULL {
                    nulls.insert(name)
                } else if let text = sqlite3_column_text(statement, columnIndex) {
                    values[name] = String(cString: text)
                }
            }
            output.append(SQLiteRow(values: values, nulls: nulls))
        }
        return output
    }
}

private struct SQLiteRow {
    let values: [String: String]
    let nulls: Set<String>

    func text(_ key: String) -> String { values[key] ?? "" }
    func optionalText(_ key: String) -> String? { nulls.contains(key) ? nil : values[key] }
    func int(_ key: String) -> Int { Int(values[key] ?? "0") ?? 0 }
    func optionalInt(_ key: String) -> Int? { nulls.contains(key) ? nil : values[key].flatMap(Int.init) }
}
