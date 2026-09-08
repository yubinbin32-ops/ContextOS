import Foundation

struct EditorPlatformStatus: Identifiable, Equatable {
    let id: String
    let name: String
    let iconSystemName: String
    var isAppInstalled: Bool
    var isSynced: Bool
    var configPath: String
}

enum PluginInstallStatus: Equatable {
    case checking
    case notInstalled
    case installing
    case installed
    case failed(String)
}

enum PluginInstaller {
    struct CommandFailure: LocalizedError {
        let output: String
        var errorDescription: String? { output }
    }

    static func detectAllPlatforms(projectRoot: URL?, marketplaceRoot: URL?) -> [EditorPlatformStatus] {
        var platforms: [EditorPlatformStatus] = []

        // 1. Claude Desktop
        let claudeConfigURL = FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Application Support/Claude/claude_desktop_config.json")
        let claudeAppExists = FileManager.default.fileExists(atPath: "/Applications/Claude.app") ||
                              FileManager.default.fileExists(atPath: claudeConfigURL.deletingLastPathComponent().path)
        let claudeSynced = isJsonMcpConfigured(at: claudeConfigURL)
        platforms.append(EditorPlatformStatus(
            id: "claude",
            name: "Claude Desktop",
            iconSystemName: "bubble.left.and.text.bubble.right.fill",
            isAppInstalled: claudeAppExists,
            isSynced: claudeSynced,
            configPath: "~/Library/Application Support/Claude/claude_desktop_config.json"
        ))

        // 2. Cursor
        let cursorAppExists = FileManager.default.fileExists(atPath: "/Applications/Cursor.app")
        var cursorConfigURL: URL? = nil
        if let root = projectRoot {
            cursorConfigURL = root.appending(path: ".cursor/mcp.json")
        }
        let userCursorURL = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".cursor/mcp.json")
        let cursorTargetURL = (cursorConfigURL != nil && FileManager.default.fileExists(atPath: cursorConfigURL!.path)) ? cursorConfigURL! : userCursorURL
        let cursorSynced = isJsonMcpConfigured(at: cursorTargetURL) || (cursorConfigURL != nil && isJsonMcpConfigured(at: cursorConfigURL!))
        platforms.append(EditorPlatformStatus(
            id: "cursor",
            name: "Cursor",
            iconSystemName: "chevron.left.forwardslash.chevron.right",
            isAppInstalled: cursorAppExists || cursorConfigURL != nil,
            isSynced: cursorSynced,
            configPath: cursorConfigURL != nil ? ".cursor/mcp.json" : "~/.cursor/mcp.json"
        ))

        // 3. Antigravity
        let antigravityAppExists = FileManager.default.fileExists(atPath: "/Applications/Antigravity.app") ||
                                   FileManager.default.fileExists(atPath: FileManager.default.homeDirectoryForCurrentUser.appending(path: ".gemini/antigravity").path)
        let antigravityUserURL = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".gemini/config/mcp_config.json")
        var antigravityProjectURL: URL? = nil
        if let root = projectRoot {
            antigravityProjectURL = root.appending(path: ".agents/mcp_config.json")
        }
        let antigravitySynced = (antigravityProjectURL != nil && isJsonMcpConfigured(at: antigravityProjectURL!)) || isJsonMcpConfigured(at: antigravityUserURL)
        platforms.append(EditorPlatformStatus(
            id: "antigravity",
            name: "Antigravity",
            iconSystemName: "sparkles",
            isAppInstalled: antigravityAppExists || antigravityProjectURL != nil,
            isSynced: antigravitySynced,
            configPath: antigravityProjectURL != nil ? ".agents/mcp_config.json" : "~/.gemini/config/mcp_config.json"
        ))

        // 4. OpenCode
        let opencodeConfigDir = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".config/opencode")
        let opencodeUserURL = opencodeConfigDir.appending(path: "mcp.json")
        let opencodeAltUserURL = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".opencode/mcp.json")
        var opencodeProjectURL: URL? = nil
        if let root = projectRoot {
            opencodeProjectURL = root.appending(path: ".opencode/mcp.json")
        }
        let opencodeAppExists = FileManager.default.fileExists(atPath: "/Applications/OpenCode.app") ||
                                FileManager.default.fileExists(atPath: "/opt/homebrew/bin/opencode") ||
                                FileManager.default.fileExists(atPath: "/usr/local/bin/opencode") ||
                                FileManager.default.fileExists(atPath: opencodeConfigDir.path)
        let opencodeSynced = (opencodeProjectURL != nil && isJsonMcpConfigured(at: opencodeProjectURL!)) ||
                             isJsonMcpConfigured(at: opencodeUserURL) ||
                             isJsonMcpConfigured(at: opencodeAltUserURL)
        platforms.append(EditorPlatformStatus(
            id: "opencode",
            name: "OpenCode",
            iconSystemName: "curlybraces",
            isAppInstalled: opencodeAppExists || opencodeProjectURL != nil,
            isSynced: opencodeSynced,
            configPath: opencodeProjectURL != nil ? ".opencode/mcp.json" : "~/.config/opencode/mcp.json"
        ))

        // 5. Codex CLI
        let codexUrl = try? codexExecutable()
        let codexAppExists = codexUrl != nil
        var codexSynced = false
        if let codexUrl, marketplaceRoot != nil {
            let result = try? run(codexUrl, arguments: ["plugin", "list", "--marketplace", "mdflow-development", "--json"])
            if let result, result.status == 0,
               let data = result.output.data(using: .utf8),
               let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let installed = object["installed"] as? [[String: Any]] {
                codexSynced = installed.contains { plugin in
                    plugin["pluginId"] as? String == "mdflow@mdflow-development"
                        && (plugin["installed"] as? Bool ?? false)
                        && (plugin["enabled"] as? Bool ?? false)
                }
            }
        }
        platforms.append(EditorPlatformStatus(
            id: "codex",
            name: "Codex CLI",
            iconSystemName: "command",
            isAppInstalled: codexAppExists,
            isSynced: codexSynced,
            configPath: "codex plugins"
        ))

        return platforms
    }

    static func syncPlatform(id: String, projectRoot: URL?, marketplaceRoot: URL) throws {
        let serverScript = marketplaceRoot
            .appending(path: "plugins/mdflow/server/mdflow-mcp.mjs")
            .standardizedFileURL.path

        switch id {
        case "claude":
            let claudeConfigURL = FileManager.default.homeDirectoryForCurrentUser
                .appending(path: "Library/Application Support/Claude/claude_desktop_config.json")
            try? FileManager.default.createDirectory(at: claudeConfigURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            _ = configureJsonMcp(at: claudeConfigURL, serverScript: serverScript)

        case "cursor":
            if let root = projectRoot {
                let cursorDir = root.appending(path: ".cursor")
                try? FileManager.default.createDirectory(at: cursorDir, withIntermediateDirectories: true)
                let cursorConfig = cursorDir.appending(path: "mcp.json")
                _ = configureJsonMcp(at: cursorConfig, serverScript: serverScript)
            }
            let userCursorDir = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".cursor")
            try? FileManager.default.createDirectory(at: userCursorDir, withIntermediateDirectories: true)
            _ = configureJsonMcp(at: userCursorDir.appending(path: "mcp.json"), serverScript: serverScript)

        case "antigravity":
            if let root = projectRoot {
                let agentsDir = root.appending(path: ".agents")
                try? FileManager.default.createDirectory(at: agentsDir, withIntermediateDirectories: true)
                let agentsConfig = agentsDir.appending(path: "mcp_config.json")
                _ = configureJsonMcp(at: agentsConfig, serverScript: serverScript)
            }
            let geminiConfigDir = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".gemini/config")
            try? FileManager.default.createDirectory(at: geminiConfigDir, withIntermediateDirectories: true)
            let userConfig = geminiConfigDir.appending(path: "mcp_config.json")
            _ = configureJsonMcp(at: userConfig, serverScript: serverScript)

        case "opencode":
            if let root = projectRoot {
                let opencodeDir = root.appending(path: ".opencode")
                try? FileManager.default.createDirectory(at: opencodeDir, withIntermediateDirectories: true)
                let opencodeConfig = opencodeDir.appending(path: "mcp.json")
                _ = configureJsonMcp(at: opencodeConfig, serverScript: serverScript)
            }
            let userOpencodeDir = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".config/opencode")
            try? FileManager.default.createDirectory(at: userOpencodeDir, withIntermediateDirectories: true)
            _ = configureJsonMcp(at: userOpencodeDir.appending(path: "mcp.json"), serverScript: serverScript)

        case "codex":
            if let executable = try? codexExecutable() {
                _ = try? run(executable, arguments: ["plugin", "marketplace", "add", marketplaceRoot.path, "--json"])
                _ = try? run(executable, arguments: ["plugin", "add", "mdflow@mdflow-development", "--json"])
            }

        default:
            break
        }
    }

    static func installAll(projectRoot: URL?, marketplaceRoot: URL) throws {
        let platforms = ["claude", "cursor", "antigravity", "opencode", "codex"]
        for p in platforms {
            try? syncPlatform(id: p, projectRoot: projectRoot, marketplaceRoot: marketplaceRoot)
        }
    }

    static func install(marketplaceRoot: URL) throws {
        try installAll(projectRoot: nil, marketplaceRoot: marketplaceRoot)
    }

    static func isInstalled(marketplaceRoot: URL) throws -> Bool {
        let platforms = detectAllPlatforms(projectRoot: nil, marketplaceRoot: marketplaceRoot)
        return platforms.contains { $0.isSynced }
    }

    private static func isJsonMcpConfigured(at configURL: URL) -> Bool {
        guard FileManager.default.fileExists(atPath: configURL.path),
              let data = try? Data(contentsOf: configURL),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let servers = json["mcpServers"] as? [String: Any] else {
            return false
        }
        return servers["mdflow"] != nil
    }

    private static func configureJsonMcp(at configURL: URL, serverScript: String) -> Bool {
        var json: [String: Any] = [:]
        if FileManager.default.fileExists(atPath: configURL.path),
           let data = try? Data(contentsOf: configURL),
           let existing = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            json = existing
        }
        var mcpServers = json["mcpServers"] as? [String: Any] ?? [:]
        mcpServers["mdflow"] = [
            "command": "node",
            "args": [serverScript]
        ]
        json["mcpServers"] = mcpServers
        guard let outputData = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys]) else {
            return false
        }
        do {
            try outputData.write(to: configURL)
            return true
        } catch {
            return false
        }
    }

    private static func codexExecutable() throws -> URL {
        let manager = FileManager.default
        let candidates = [
            "/Applications/Codex.app/Contents/Resources/codex",
            "/Applications/ChatGPT.app/Contents/Resources/codex",
            "/opt/homebrew/bin/codex",
            "/usr/local/bin/codex",
        ]
        if let path = candidates.first(where: { manager.isExecutableFile(atPath: $0) }) {
            return URL(fileURLWithPath: path)
        }
        let lookup = try run(URL(fileURLWithPath: "/usr/bin/which"), arguments: ["codex"])
        let path = lookup.output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard lookup.status == 0, manager.isExecutableFile(atPath: path) else {
            throw CommandFailure(output: "Codex CLI was not found. Install or open Codex, then try again.")
        }
        return URL(fileURLWithPath: path)
    }

    private static func run(_ executable: URL, arguments: [String]) throws -> (status: Int32, output: String) {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = executable
        process.arguments = arguments
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        process.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return (process.terminationStatus, String(decoding: data, as: UTF8.self))
    }
}
