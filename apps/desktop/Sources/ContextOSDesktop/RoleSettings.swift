import Foundation

struct MicroSettingsDraft: Equatable {
    var baseURL = ""
    var model = ""
    var thinking = "medium"
    var replacementKey = ""
}

struct CLISettingsDraft: Equatable {
    var model = ""
    var thinking = "medium"
}

/// Only explicit edits are persisted. Inherited credentials never enter a UI draft.
enum RoleSettings {
    static let microOverrideKeys = ["baseUrl", "url", "key", "apiKey", "keyEnv", "model", "thinking", "effort"]

    static func sameOrigin(_ first: String, _ second: String) -> Bool {
        func origin(_ value: String) -> String? {
            guard let url = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
                  let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
                  let host = url.host?.lowercased(), url.user == nil, url.password == nil else { return nil }
            return "\(scheme)://\(host):\(url.port ?? (scheme == "https" ? 443 : 80))"
        }
        guard let firstOrigin = origin(first), let secondOrigin = origin(second) else { return false }
        return firstOrigin == secondOrigin
    }

    /// Saved credentials are scoped to the saved service origin, never to a newly typed host.
    static func catalogKey(_ draft: MicroSettingsDraft, saved: [String: Any], environment: [String: String] = ProcessInfo.processInfo.environment) throws -> String? {
        let replacement = draft.replacementKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if !replacement.isEmpty { return replacement }
        let key = saved["key"] as? String ?? saved["apiKey"] as? String
            ?? (saved["keyEnv"] as? String).flatMap { environment[$0] }
        guard let key, !key.isEmpty else { return nil }
        let savedURL = saved["baseUrl"] as? String ?? saved["url"] as? String ?? ""
        guard sameOrigin(savedURL, draft.baseURL) else {
            throw NSError(domain: "RoleSettings", code: 7, userInfo: [NSLocalizedDescriptionKey: "更换服务地址后，请填写该服务的 Key 再同步或保存。 / Enter this service's key after changing the service address."])
        }
        return key
    }

    static func globalProfileURL() -> URL {
        let configured = ProcessInfo.processInfo.environment["CONTEXTOS_HOME"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let home = configured.flatMap { $0.isEmpty ? nil : $0 } ?? URL(fileURLWithPath: NSHomeDirectory()).appending(path: ".contextos").path
        return URL(fileURLWithPath: home).appending(path: "profile.json")
    }

    static func useGlobalSettings(projectFile: URL, micro: Bool) throws {
        guard FileManager.default.fileExists(atPath: projectFile.path) else { return }
        guard var profile = try JSONSerialization.jsonObject(with: Data(contentsOf: projectFile)) as? [String: Any] else {
            throw NSError(domain: "RoleSettings", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid profile; settings were not changed."])
        }
        // This explicit action restores the whole selected role to global configuration.
        // All unrelated top-level project settings remain untouched.
        profile.removeValue(forKey: micro ? "micro" : "agents")
        try writeProfile(profile, to: projectFile)
    }

    static func writeProfile(_ profile: [String: Any], to file: URL) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: profile, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }

    static func cliPatch(_ draft: CLISettingsDraft, effectiveAdapter: [String: Any], catalog: RoleModelCatalog? = nil) throws -> [String: Any] {
        var model = draft.model.trimmingCharacters(in: .whitespacesAndNewlines)
        let thinking = draft.thinking.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !model.isEmpty else {
            throw NSError(domain: "RoleSettings", code: 4, userInfo: [NSLocalizedDescriptionKey: "Enter a CLI model and thinking level."])
        }
        let args = effectiveAdapter["args"] as? [String] ?? []
        let rawCommand = effectiveAdapter["command"] as? String ?? (effectiveAdapter["command"] as? [String])?.first ?? ""
        let command = rawCommand.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? ""
        let executable = command.components(separatedBy: CharacterSet(charactersIn: "/\\\\")).last ?? ""
        let mapsThinking = args.contains { $0.contains("{thinking}") }
        let aliasLevel = ["low", "medium", "high"].first(where: { model.hasSuffix("-" + $0) })
        if executable == "agy", aliasLevel != nil,
           args.contains(where: { $0 == "--effort" || $0.hasPrefix("--effort=") }) {
            throw NSError(domain: "RoleSettings", code: 5, userInfo: [NSLocalizedDescriptionKey: "AGY effort aliases must not be combined with --effort."])
        }
        if thinking.isEmpty { return ["model": model, "thinking": NSNull()] }
        if executable == "agy", !mapsThinking, let suffix = aliasLevel {
            guard ["low", "medium", "high"].contains(thinking) else {
                throw NSError(domain: "RoleSettings", code: 5, userInfo: [NSLocalizedDescriptionKey: "AGY effort aliases support low, medium or high without --effort."])
            }
            let alias = String(model.dropLast(suffix.count)) + thinking
            if let catalog, catalog.models.contains(where: { $0.id == model }),
               !catalog.models.contains(where: { $0.id == alias }) {
                throw NSError(domain: "RoleSettings", code: 8, userInfo: [NSLocalizedDescriptionKey: "This AGY model does not advertise that thinking alias. Choose a listed level or inherit."])
            }
            model = alias
        } else if !mapsThinking {
            throw NSError(domain: "RoleSettings", code: 6, userInfo: [NSLocalizedDescriptionKey: "Ask AI to add a supported {thinking} mapping to this adapter."])
        }
        return ["model": model, "thinking": thinking]
    }

    static func update(projectFile: URL, draft: MicroSettingsDraft? = nil, adapter: String? = nil, allowedAdapters: [String] = [], cliDraft: CLISettingsDraft? = nil, effectiveAdapter: [String: Any] = [:], cliCatalog: RoleModelCatalog? = nil) throws {
        var profile: [String: Any] = [:]
        if FileManager.default.fileExists(atPath: projectFile.path) {
            let data = try Data(contentsOf: projectFile)
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw NSError(domain: "RoleSettings", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid profile; settings were not changed."])
            }
            profile = object
        }
        if let draft {
            let endpoint = draft.baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
            let model = draft.model.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let url = URL(string: endpoint), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, !model.isEmpty else {
                throw NSError(domain: "RoleSettings", code: 2, userInfo: [NSLocalizedDescriptionKey: "Enter a valid HTTP(S) Base URL and model."])
            }
            var micro = profile["micro"] as? [String: Any] ?? [:]
            // A blank key keeps the old credential only for the same service.
            if micro["baseUrl"] is String || micro["url"] is String {
                _ = try catalogKey(draft, saved: micro)
            }
            micro["baseUrl"] = endpoint
            micro["url"] = endpoint
            micro["model"] = model
            if draft.thinking.isEmpty {
                micro.removeValue(forKey: "thinking")
                micro.removeValue(forKey: "effort")
            } else { micro["thinking"] = draft.thinking }
            let key = draft.replacementKey.trimmingCharacters(in: .whitespacesAndNewlines)
            if !key.isEmpty {
                micro["key"] = key
                micro["apiKey"] = key
            }
            profile["micro"] = micro
        }
        if let adapter {
            guard allowedAdapters.contains(adapter) else {
                throw NSError(domain: "RoleSettings", code: 3, userInfo: [NSLocalizedDescriptionKey: "Choose a configured CLI adapter."])
            }
            var agents = profile["agents"] as? [String: Any] ?? [:]
            agents["default"] = adapter
            if let cliDraft {
                let patch = try cliPatch(cliDraft, effectiveAdapter: effectiveAdapter, catalog: cliCatalog)
                var adapters = agents["adapters"] as? [String: Any] ?? [:]
                var config = adapters[adapter] as? [String: Any] ?? [:]
                config.merge(patch) { _, value in value }
                adapters[adapter] = config
                agents["adapters"] = adapters
            }
            profile["agents"] = agents
        }
        try writeProfile(profile, to: projectFile)
    }
}
