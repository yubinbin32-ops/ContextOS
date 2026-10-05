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

final class RoleSettingsTests: XCTestCase {
    private func profileURL() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory.appending(path: "profile.json")
    }

    func testSavingMicroPreservesInheritedCredentials() throws {
        let file = try profileURL()
        try RoleSettings.update(projectFile: file, draft: MicroSettingsDraft(baseURL: "https://example.com/v1", model: "model"))
        let profile = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        let micro = profile["micro"] as! [String: Any]
        XCTAssertNil(micro["key"])
        XCTAssertNil(micro["apiKey"])
        XCTAssertEqual(micro["baseUrl"] as? String, "https://example.com/v1")
        let permissions = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as! NSNumber
        XCTAssertEqual(permissions.intValue, 0o600)
    }

    func testReplacementOverridesAliasesAndPreservesOtherSettings() throws {
        let file = try profileURL()
        let initial: [String: Any] = ["micro": ["key": "old", "apiKey": "older", "budget": 42], "agents": ["adapters": ["codex": ["command": "codex"]]], "maxChars": 1200]
        try JSONSerialization.data(withJSONObject: initial).write(to: file)
        try RoleSettings.update(projectFile: file, draft: MicroSettingsDraft(baseURL: "https://new.example/v1", model: "model", thinking: "medium", replacementKey: "replacement"))
        try RoleSettings.update(projectFile: file, adapter: "codex", allowedAdapters: ["codex"])
        let profile = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        let micro = profile["micro"] as! [String: Any]
        XCTAssertEqual(micro["key"] as? String, "replacement")
        XCTAssertEqual(micro["apiKey"] as? String, "replacement")
        XCTAssertEqual(micro["url"] as? String, micro["baseUrl"] as? String)
        XCTAssertEqual(micro["budget"] as? Int, 42)
        XCTAssertEqual(profile["maxChars"] as? Int, 1200)
        XCTAssertEqual((profile["agents"] as? [String: Any])?["default"] as? String, "codex")
        XCTAssertNotNil((profile["agents"] as? [String: Any])?["adapters"])
    }

    func testInvalidProfileAndInputAreNotOverwritten() throws {
        let file = try profileURL()
        let broken = Data("{broken".utf8)
        try broken.write(to: file)
        XCTAssertThrowsError(try RoleSettings.update(projectFile: file, draft: MicroSettingsDraft(baseURL: "https://example.com", model: "model")))
        XCTAssertEqual(try Data(contentsOf: file), broken)
        try Data("{}".utf8).write(to: file)
        XCTAssertThrowsError(try RoleSettings.update(projectFile: file, adapter: "missing", allowedAdapters: ["codex"]))
        XCTAssertThrowsError(try RoleSettings.update(projectFile: file, draft: MicroSettingsDraft(baseURL: "file:///secret", model: "model")))
        XCTAssertEqual(try Data(contentsOf: file), Data("{}".utf8))
    }
}

@MainActor
final class EffectiveRoleProfileTests: XCTestCase {
    func testPartialProjectAdapterPreservesGlobalCommandAndSiblingAdapter() {
        let global: [String: Any] = [
            "micro": ["baseUrl": "https://example.com/v1", "model": "global", "key": "inherited"],
            "agents": ["default": "agy", "adapters": [
                "agy": ["command": "agy", "model": "gemini"],
                "codex": ["command": "node", "model": "old", "output": ["usage": ["input": "input_tokens", "cache": "cached_tokens"]]]
            ]]
        ]
        let project: [String: Any] = [
            "micro": ["model": "project"],
            "agents": ["default": "codex", "adapters": [
                "codex": ["model": "gpt-6.1-sol", "thinking": "medium", "output": ["usage": ["input": "fresh_input"]]]
            ]]
        ]
        let profile = GraphStore.effectiveProfile(global: global, project: project)
        let agents = profile["agents"] as! [String: Any]
        let adapters = agents["adapters"] as! [String: Any]
        let codex = adapters["codex"] as! [String: Any]
        XCTAssertEqual(codex["command"] as? String, "node")
        XCTAssertNotNil(adapters["agy"])
        let usage = (codex["output"] as! [String: Any])["usage"] as! [String: Any]
        XCTAssertEqual(usage["cache"] as? String, "cached_tokens")
        XCTAssertEqual(usage["input"] as? String, "fresh_input")
        let summary = GraphStore.summarizeMicroRoles(profile, configurationSource: "global + project")
        XCTAssertEqual(summary.defaultAdapter, "codex")
        XCTAssertEqual(summary.adapters.map(\.id), ["agy", "codex"])
        XCTAssertEqual(summary.adapters.first(where: { $0.id == "codex" })?.command, "node")
        XCTAssertEqual(summary.adapters.first(where: { $0.id == "codex" })?.model, "gpt-6.1-sol")
        XCTAssertEqual(summary.baseURL, "https://example.com/v1")
        XCTAssertTrue(summary.credentialConfigured)
    }

    func testNullClearsOneAdapterWithoutHidingOtherAdapters() {
        let global: [String: Any] = ["agents": ["adapters": [
            "agy": ["command": "agy"], "codex": ["command": "node", "model": "old"]
        ]]]
        let project: [String: Any] = ["agents": ["adapters": ["agy": NSNull(), "codex": ["model": NSNull()]]]]
        let profile = GraphStore.effectiveProfile(global: global, project: project)
        let summary = GraphStore.summarizeMicroRoles(profile, configurationSource: "global + project")
        XCTAssertEqual(summary.adapters.map(\.id), ["codex"])
        XCTAssertEqual(summary.adapters.first?.command, "node")
        XCTAssertNil(summary.adapters.first?.model)

        let cleared = GraphStore.effectiveProfile(global: global, project: ["agents": ["adapters": NSNull()]])
        XCTAssertTrue(GraphStore.summarizeMicroRoles(cleared, configurationSource: "project").adapters.isEmpty)
    }
}

final class CLISettingsPersistenceTests: XCTestCase {
    func testAGYThinkingChangesModelAliasWithoutAddingEffortFlag() throws {
        let config: [String: Any] = ["command": "agy", "model": "gemini-3.8-flash-high", "args": ["--model", "{model}", "--mode", "{mode}"]]
        let patch = try RoleSettings.cliPatch(CLISettingsDraft(model: "gemini-3.8-flash-high", thinking: "medium"), effectiveAdapter: config)
        XCTAssertEqual(patch["model"] as? String, "gemini-3.8-flash-medium")
        XCTAssertEqual(patch["thinking"] as? String, "medium")
        XCTAssertNil(patch["args"])
        XCTAssertThrowsError(try RoleSettings.cliPatch(CLISettingsDraft(model: "gemini-3.8-flash-high", thinking: "max"), effectiveAdapter: config))
    }

    func testAGYCatalogPreventsInventingUnavailableMediumAlias() throws {
        let catalog = try RoleCatalogService.parseAGY("gemini-pro-low\tPro Low\ngemini-pro-high\tPro High")
        let config: [String: Any] = ["command": "agy", "args": ["--model", "{model}"]]
        XCTAssertThrowsError(try RoleSettings.cliPatch(CLISettingsDraft(model: "gemini-pro-high", thinking: "medium"), effectiveAdapter: config, catalog: catalog))
        let patch = try RoleSettings.cliPatch(CLISettingsDraft(model: "gemini-pro-high", thinking: "low"), effectiveAdapter: config, catalog: catalog)
        XCTAssertEqual(patch["model"] as? String, "gemini-pro-low")
    }

    func testAGYEffortAliasRejectsEffortFlagEvenWithThinkingMappingOrInheritance() {
        XCTAssertThrowsError(try RoleSettings.cliPatch(CLISettingsDraft(model: "gemini-3.8-flash-high", thinking: "medium"), effectiveAdapter: ["command": "agy", "args": ["--effort", "{thinking}"]]))
        XCTAssertThrowsError(try RoleSettings.cliPatch(CLISettingsDraft(model: "gemini-3.8-flash-high", thinking: ""), effectiveAdapter: ["command": "agy", "args": ["--effort=high"]]))
    }

    func testThinkingWithoutMappingCannotSilentlySave() throws {
        XCTAssertThrowsError(try RoleSettings.cliPatch(CLISettingsDraft(model: "model", thinking: "medium"), effectiveAdapter: ["command": "custom", "args": ["--model", "{model}"]]))
        XCTAssertThrowsError(try RoleSettings.cliPatch(CLISettingsDraft(model: "gemini-3.8-flash-high", thinking: "medium"), effectiveAdapter: ["command": "agy", "args": ["--effort", "high"]]))
    }

    func testSavingCLIOverridesModelAndThinkingPreservesDefinitionsAndMicro() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appending(path: "profile.json")
        let initial: [String: Any] = ["micro": ["key": "existing", "model": "micro-model"], "agents": ["adapters": ["codex": ["output": ["usage": ["aggregation": "invocation"]]]]]]
        try JSONSerialization.data(withJSONObject: initial).write(to: file)
        try RoleSettings.update(projectFile: file, adapter: "codex", allowedAdapters: ["agy", "codex"],
            cliDraft: CLISettingsDraft(model: "gpt-6.1-sol", thinking: "high"),
            effectiveAdapter: ["command": "node", "args": ["--thinking", "{thinking}"]])
        let profile = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        XCTAssertEqual((profile["micro"] as! [String: Any])["key"] as? String, "existing")
        let agents = profile["agents"] as! [String: Any]
        XCTAssertEqual(agents["default"] as? String, "codex")
        let adapter = (agents["adapters"] as! [String: Any])["codex"] as! [String: Any]
        XCTAssertEqual(adapter["model"] as? String, "gpt-6.1-sol")
        XCTAssertEqual(adapter["thinking"] as? String, "high")
        XCTAssertNil(adapter["command"], "Inherited adapter commands should not be copied into the project")
        XCTAssertNotNil(adapter["output"], "Existing project mappings are preserved")
        try RoleSettings.update(projectFile: file, adapter: "agy", allowedAdapters: ["agy", "codex"])
        let switched = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        XCTAssertEqual((switched["agents"] as! [String: Any])["default"] as? String, "agy")
    }
}

final class RoleModelCatalogTests: XCTestCase {
    func testModelEndpointPreservesVersionPathAndRejectsCredentialURLs() throws {
        XCTAssertEqual(try RoleCatalogService.modelsURL(" https://example.com/v1/chat/completions ").absoluteString, "https://example.com/v1/models")
        XCTAssertEqual(try RoleCatalogService.modelsURL("https://example.com/v1/models").absoluteString, "https://example.com/v1/models")
        XCTAssertThrowsError(try RoleCatalogService.modelsURL("https://user:password@example.com/v1"))
        XCTAssertThrowsError(try RoleCatalogService.modelsURL("https://example.com/v1?key=secret"))
    }

    func testAPIModelsDeduplicateAndUnknownLevelsRemainUnknown() throws {
        let catalog = try RoleCatalogService.parseJSON(["data": [
            ["id": "custom-model"], ["id": "custom-model"], ["id": "hidden", "hidden": true]
        ]], source: "API /models", microConfiguration: [:])
        XCTAssertEqual(catalog.models.map(\.id), ["custom-model"])
        XCTAssertTrue(catalog.models[0].reasoningLevels.isEmpty)
        XCTAssertTrue(catalog.models[0].reasoningSource.contains("Not advertised"))
        XCTAssertFalse(catalog.warnings.isEmpty)
    }

    func testCodexMetadataIsModelSpecificAndSchemaIsShared() throws {
        let catalog = try RoleCatalogService.parseJSON(["data": [
            ["model": "first", "displayName": "First", "supportedReasoningEfforts": [
                ["reasoningEffort": "low"], ["reasoningEffort": "high"]
            ]],
            ["model": "second", "supportedReasoningEfforts": [["reasoningEffort": "medium"]]]
        ]], source: "codex app-server model/list")
        XCTAssertEqual(catalog.models[0].reasoningLevels.map(\.id), ["low", "high"])
        XCTAssertEqual(catalog.models[1].reasoningLevels.map(\.id), ["medium"])
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(catalog)) as! [String: Any]
        let model = (json["models"] as! [[String: Any]])[0]
        XCTAssertNotNil(model["reasoningSource"])
        XCTAssertNil(model["thinkingLevels"])
        XCTAssertEqual(((model["reasoningLevels"] as! [[String: Any]])[0])["label"] as? String, "low")
        XCTAssertNotNil(json["warnings"])
    }

    func testExplicitSharedCatalogLabelsArePreserved() throws {
        let catalog = try RoleCatalogService.parseJSON(["models": [
            ["id": "custom", "label": "Custom", "reasoningLevels": [["id": "balanced", "label": "Balanced"]],
             "reasoningSource": "Adapter metadata"]
        ], "warnings": ["Custom mapping"]], source: "Adapter catalog")
        XCTAssertEqual(catalog.models[0].reasoningLevels[0].label, "Balanced")
        XCTAssertEqual(catalog.models[0].reasoningSource, "Adapter metadata")
        XCTAssertEqual(catalog.warnings, ["Custom mapping"])
    }

    func testDeepSeekOSMappingRetainsRequestedMedium() throws {
        let catalog = try RoleCatalogService.parseJSON(["data": [["id": "deepseek-v4.1-flash"]]],
            source: "API /models", microConfiguration: [:])
        XCTAssertTrue(catalog.models[0].reasoningLevels.map(\.id).contains("medium"))
        XCTAssertEqual(catalog.models[0].reasoningSource, RoleCatalogService.deepSeekSource)
    }

    func testExplicitEffortMetadataOverridesDeepSeekCompatibilityMapping() throws {
        let catalog = try RoleCatalogService.parseJSON(["data": [
            ["id": "deepseek-v4.1-flash", "supported_reasoning_efforts": ["high"]]
        ]], source: "API /models", microConfiguration: [:])
        XCTAssertEqual(catalog.models[0].reasoningLevels.map(\.id), ["high"])
        XCTAssertEqual(catalog.models[0].reasoningSource, "API /models")
    }

    func testProfileThinkingMapControlsOnlyMappedLevels() throws {
        let catalog = try RoleCatalogService.parseJSON(["data": [["id": "custom"]]], source: "API /models",
            microConfiguration: ["transport": "responses", "thinkingMap": ["responses": ["balanced": [:], "disabled": false]]])
        XCTAssertEqual(catalog.models[0].reasoningLevels.map(\.id), ["balanced"])
        XCTAssertEqual(catalog.models[0].reasoningSource, "Profile thinkingMap")
    }

    func testAGYUsesListedAliasVariantsFromTabsOrSpacesAndDropsDuplicates() throws {
        let catalog = try RoleCatalogService.parseAGY("gemini-flash-low\tFlash Low\ngemini-flash-medium  Flash Medium\ngemini-flash-high\tFlash High\ngemini-flash-low\tDuplicate\ncustom\tCustom\n")
        XCTAssertEqual(catalog.models.count, 4)
        XCTAssertEqual(catalog.models[0].reasoningLevels.map(\.id), ["low", "medium", "high"])
        XCTAssertTrue(catalog.models[3].reasoningLevels.isEmpty)
    }

    func testMalformedAndEmptyCatalogFailWithoutResettingSettings() {
        XCTAssertThrowsError(try RoleCatalogService.parseJSON(["error": "secret"], source: "API /models"))
        XCTAssertThrowsError(try RoleCatalogService.parseJSON(["data": []], source: "API /models"))
        XCTAssertThrowsError(try RoleCatalogService.parseAGY(""))
    }
}

final class GlobalRoleSettingsTests: XCTestCase {
    private func profileFile() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory.appending(path: "profile.json")
    }

    func testBlankKeyKeepsSavedGlobalKeyAndUnrelatedConfiguration() throws {
        let file = try profileFile()
        try RoleSettings.writeProfile(["micro": ["baseUrl": "https://example.com/v1", "key": "saved-fixture", "budget": 42],
            "maxChars": 1200], to: file)
        try RoleSettings.update(projectFile: file, draft: MicroSettingsDraft(baseURL: "https://example.com/v2", model: "new-model", thinking: "medium"))
        let profile = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        let micro = profile["micro"] as! [String: Any]
        XCTAssertEqual(micro["key"] as? String, "saved-fixture")
        XCTAssertEqual(micro["budget"] as? Int, 42)
        XCTAssertEqual(micro["model"] as? String, "new-model")
        XCTAssertEqual(profile["maxChars"] as? Int, 1200)
        let permissions = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o600)
    }

    func testSavedKeyMayOnlySynchronizeToMatchingOrigin() throws {
        let saved: [String: Any] = ["baseUrl": "https://example.com/v1", "key": "saved-fixture", "apiKey": "stale-fixture"]
        XCTAssertEqual(try RoleSettings.catalogKey(MicroSettingsDraft(baseURL: "https://EXAMPLE.com:443/v2"), saved: saved), "saved-fixture")
        for url in ["http://example.com/v1", "https://other.example/v1", "https://example.com:444/v1"] {
            XCTAssertThrowsError(try RoleSettings.catalogKey(MicroSettingsDraft(baseURL: url), saved: saved)) { error in
                XCTAssertFalse(error.localizedDescription.contains("saved-fixture"))
                XCTAssertFalse(error.localizedDescription.contains("stale-fixture"))
            }
        }
        XCTAssertEqual(try RoleSettings.catalogKey(MicroSettingsDraft(baseURL: "https://other.example/v1", replacementKey: "new-fixture"), saved: saved), "new-fixture")
    }

    func testCrossOriginBlankKeySaveFailsAtomicallyAndNewKeySucceeds() throws {
        let file = try profileFile()
        try RoleSettings.writeProfile(["micro": ["baseUrl": "https://example.com/v1", "key": "saved-fixture"]], to: file)
        let original = try Data(contentsOf: file)
        XCTAssertThrowsError(try RoleSettings.update(projectFile: file,
            draft: MicroSettingsDraft(baseURL: "https://other.example/v1", model: "new-model")))
        XCTAssertEqual(try Data(contentsOf: file), original)
        try RoleSettings.update(projectFile: file,
            draft: MicroSettingsDraft(baseURL: "https://other.example/v1", model: "new-model", replacementKey: "new-fixture"))
        let profile = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        XCTAssertEqual((profile["micro"] as! [String: Any])["key"] as? String, "new-fixture")
    }

    func testEnvironmentKeyUsesSameOriginBoundary() throws {
        let saved: [String: Any] = ["url": "https://example.com", "keyEnv": "CATALOG_FIXTURE"]
        XCTAssertEqual(try RoleSettings.catalogKey(MicroSettingsDraft(baseURL: "https://example.com/v1"), saved: saved,
            environment: ["CATALOG_FIXTURE": "env-fixture"]), "env-fixture")
        XCTAssertThrowsError(try RoleSettings.catalogKey(MicroSettingsDraft(baseURL: "https://other.example"), saved: saved,
            environment: ["CATALOG_FIXTURE": "env-fixture"]))
    }

    func testUseGlobalExplicitlyClearsSelectedRoleAndPreservesOtherTopLevelSettings() throws {
        let file = try profileFile()
        try RoleSettings.writeProfile(["micro": ["provider": "custom", "url": "https://project.example", "thinkingMap": ["chat": [:]]],
            "agents": ["default": "agy", "adapters": ["agy": ["command": "project-command", "catalog": ["args": []]]]],
            "maxChars": 777, "permissions": ["allow": true]], to: file)
        try RoleSettings.useGlobalSettings(projectFile: file, micro: true)
        var profile = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        XCTAssertNil(profile["micro"])
        XCTAssertNotNil(profile["agents"])
        XCTAssertEqual(profile["maxChars"] as? Int, 777)
        try RoleSettings.useGlobalSettings(projectFile: file, micro: false)
        profile = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        XCTAssertNil(profile["agents"])
        XCTAssertNotNil(profile["permissions"])
        XCTAssertEqual(profile["maxChars"] as? Int, 777)
    }

    func testUseGlobalHandlesNullRoleOverrides() throws {
        let file = try profileFile()
        try RoleSettings.writeProfile(["micro": NSNull(), "agents": NSNull(), "maxChars": 777], to: file)
        try RoleSettings.useGlobalSettings(projectFile: file, micro: true)
        try RoleSettings.useGlobalSettings(projectFile: file, micro: false)
        let profile = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        XCTAssertEqual(profile.count, 1)
        XCTAssertEqual(profile["maxChars"] as? Int, 777)
    }
}
