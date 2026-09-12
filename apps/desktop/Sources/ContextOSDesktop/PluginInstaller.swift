import CryptoKit
import Foundation

struct EditorPlatformStatus: Identifiable, Equatable {
    let id: String
    let name: String
    let iconSystemName: String
    var isAppInstalled: Bool
    var isSynced: Bool
    var installedVersion: String?
    var targetVersion: String
    var isOutdated: Bool
    var configPath: String
    var appVersion: String = ""
    var installedBuild: String? = nil
    var targetBuild: String = ""

    var isAppVersionMismatch: Bool {
        !appVersion.isEmpty && appVersion != targetVersion
    }

    var isBuildMismatch: Bool {
        installedBuild != nil && !targetBuild.isEmpty && installedBuild != targetBuild
    }
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

    static let fallbackVersion = "0.4.1"

    static var canonicalServerDirectoryURL: URL {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return home.appending(path: ".contextos/server", directoryHint: .isDirectory)
    }

    static var canonicalServerScriptURL: URL {
        canonicalServerDirectoryURL.appending(path: "contextos-mcp.mjs")
    }

    private static let buildFiles = [
        ".codex-plugin/plugin.json",
        "server/contextos-mcp.mjs",
        "skills/contextos/SKILL.md"
    ]

    private static func pluginBuildID(pluginRoot: URL) -> String? {
        var hasher = SHA256()
        for relativePath in buildFiles {
            let fileURL = pluginRoot.appending(path: relativePath)
            guard let data = try? Data(contentsOf: fileURL) else { return nil }
            hasher.update(data: Data(relativePath.utf8))
            hasher.update(data: Data([0]))
            if relativePath.hasSuffix(".json"),
               let json = try? JSONSerialization.jsonObject(with: data),
               let canonicalData = try? JSONSerialization.data(withJSONObject: json, options: [.sortedKeys, .withoutEscapingSlashes]) {
                hasher.update(data: canonicalData)
            } else {
                hasher.update(data: data)
            }
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    static func bundledPluginBuildID(marketplaceRoot: URL?) -> String {
        guard let marketplaceRoot else { return "" }
        let pluginRoot = marketplaceRoot.appending(path: "plugins/contextos", directoryHint: .isDirectory)
        return pluginBuildID(pluginRoot: pluginRoot) ?? ""
    }

    static func bundledAppVersion(marketplaceRoot: URL?) -> String {
        if let marketplaceRoot {
            let infoURL = marketplaceRoot.appending(path: "apps/desktop/Resources/Info.plist")
            if let data = try? Data(contentsOf: infoURL),
               let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any],
               let version = plist["CFBundleShortVersionString"] as? String,
               !version.isEmpty {
                return version
            }
        }
        if let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
           !version.isEmpty {
            return version
        }
        return fallbackVersion
    }

    static func bundledTargetVersion(marketplaceRoot: URL?) -> String {
        if let marketplaceRoot {
            let pluginJsonURL = marketplaceRoot.appending(path: "plugins/contextos/.codex-plugin/plugin.json")
            if let data = try? Data(contentsOf: pluginJsonURL),
               let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
               let ver = json["version"] as? String {
                let clean = ver.components(separatedBy: "+").first ?? ver
                if !clean.isEmpty { return clean }
            }
            let packageJsonURL = marketplaceRoot.appending(path: "package.json")
            if let data = try? Data(contentsOf: packageJsonURL),
               let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
               let ver = json["version"] as? String, !ver.isEmpty {
                return ver
            }
        }
        return fallbackVersion
    }

    static func detectAllPlatforms(projectRoot: URL?, marketplaceRoot: URL?) -> [EditorPlatformStatus] {
        var platforms: [EditorPlatformStatus] = []
        let targetVersion = bundledTargetVersion(marketplaceRoot: marketplaceRoot)
        let targetBuild = bundledPluginBuildID(marketplaceRoot: marketplaceRoot)
        let appVersion = bundledAppVersion(marketplaceRoot: marketplaceRoot)
        let versionsCompatible = appVersion == targetVersion
        let home = FileManager.default.homeDirectoryForCurrentUser

        // 1. Claude Desktop
        let claudeConfigURL = home.appending(path: "Library/Application Support/Claude/claude_desktop_config.json")
        let claudeAppExists = FileManager.default.fileExists(atPath: "/Applications/Claude.app") ||
                              FileManager.default.fileExists(atPath: "/Applications/Claude Desktop.app") ||
                              FileManager.default.fileExists(atPath: home.appending(path: "Applications/Claude.app").path)
        let claudeMetadata = claudeAppExists ? readMcpMetadata(at: claudeConfigURL) : (version: nil, build: nil)
        let claudeInstalledVer = claudeMetadata.version
        let claudeSynced = claudeAppExists && versionsCompatible && claudeInstalledVer != nil && claudeInstalledVer == targetVersion && claudeMetadata.build == targetBuild
        let claudeOutdated = claudeAppExists && claudeInstalledVer != nil && claudeInstalledVer != targetVersion
        platforms.append(EditorPlatformStatus(
            id: "claude",
            name: "Claude Desktop",
            iconSystemName: "bubble.left.and.text.bubble.right.fill",
            isAppInstalled: claudeAppExists,
            isSynced: claudeSynced,
            installedVersion: claudeInstalledVer,
            targetVersion: targetVersion,
            isOutdated: claudeOutdated,
            configPath: "~/Library/Application Support/Claude/claude_desktop_config.json",
            appVersion: appVersion,
            installedBuild: claudeMetadata.build,
            targetBuild: targetBuild
        ))

        // 2. Cursor
        let cursorAppExists = FileManager.default.fileExists(atPath: "/Applications/Cursor.app") ||
                              FileManager.default.fileExists(atPath: home.appending(path: "Applications/Cursor.app").path)
        let userCursorURL = home.appending(path: ".cursor/mcp.json")
        let cursorMetadata = cursorAppExists ? readMcpMetadata(at: userCursorURL) : (version: nil, build: nil)
        let cursorInstalledVer = cursorMetadata.version
        let cursorSynced = cursorAppExists && versionsCompatible && cursorInstalledVer != nil && cursorInstalledVer == targetVersion && cursorMetadata.build == targetBuild
        let cursorOutdated = cursorAppExists && cursorInstalledVer != nil && cursorInstalledVer != targetVersion
        platforms.append(EditorPlatformStatus(
            id: "cursor",
            name: "Cursor",
            iconSystemName: "chevron.left.forwardslash.chevron.right",
            isAppInstalled: cursorAppExists,
            isSynced: cursorSynced,
            installedVersion: cursorInstalledVer,
            targetVersion: targetVersion,
            isOutdated: cursorOutdated,
            configPath: "~/.cursor/mcp.json",
            appVersion: appVersion,
            installedBuild: cursorMetadata.build,
            targetBuild: targetBuild
        ))

        // 3. Antigravity
        let antigravityAppExists = FileManager.default.fileExists(atPath: "/Applications/Antigravity.app") ||
                                   FileManager.default.fileExists(atPath: home.appending(path: ".gemini/antigravity").path)
        let antigravityUserURL = home.appending(path: ".gemini/config/mcp_config.json")
        let antigravityMetadata = antigravityAppExists ? readMcpMetadata(at: antigravityUserURL) : (version: nil, build: nil)
        let antigravityInstalledVer = antigravityMetadata.version
        let antigravitySynced = antigravityAppExists && versionsCompatible && antigravityInstalledVer != nil && antigravityInstalledVer == targetVersion && antigravityMetadata.build == targetBuild
        let antigravityOutdated = antigravityAppExists && antigravityInstalledVer != nil && antigravityInstalledVer != targetVersion
        platforms.append(EditorPlatformStatus(
            id: "antigravity",
            name: "Antigravity",
            iconSystemName: "sparkles",
            isAppInstalled: antigravityAppExists,
            isSynced: antigravitySynced,
            installedVersion: antigravityInstalledVer,
            targetVersion: targetVersion,
            isOutdated: antigravityOutdated,
            configPath: "~/.gemini/config/mcp_config.json",
            appVersion: appVersion,
            installedBuild: antigravityMetadata.build,
            targetBuild: targetBuild
        ))

        // 4. OpenCode
        let opencodeConfigDir = home.appending(path: ".config/opencode")
        let opencodeUserURL = opencodeConfigDir.appending(path: "mcp.json")
        let opencodeAppExists = FileManager.default.fileExists(atPath: "/Applications/OpenCode.app") ||
                                FileManager.default.fileExists(atPath: home.appending(path: "Applications/OpenCode.app").path) ||
                                FileManager.default.fileExists(atPath: "/opt/homebrew/bin/opencode") ||
                                FileManager.default.fileExists(atPath: "/usr/local/bin/opencode")
        let opencodeMetadata = opencodeAppExists ? readMcpMetadata(at: opencodeUserURL) : (version: nil, build: nil)
        let opencodeInstalledVer = opencodeMetadata.version
        let opencodeSynced = opencodeAppExists && versionsCompatible && opencodeInstalledVer != nil && opencodeInstalledVer == targetVersion && opencodeMetadata.build == targetBuild
        let opencodeOutdated = opencodeAppExists && opencodeInstalledVer != nil && opencodeInstalledVer != targetVersion
        platforms.append(EditorPlatformStatus(
            id: "opencode",
            name: "OpenCode",
            iconSystemName: "curlybraces",
            isAppInstalled: opencodeAppExists,
            isSynced: opencodeSynced,
            installedVersion: opencodeInstalledVer,
            targetVersion: targetVersion,
            isOutdated: opencodeOutdated,
            configPath: "~/.config/opencode/mcp.json",
            appVersion: appVersion,
            installedBuild: opencodeMetadata.build,
            targetBuild: targetBuild
        ))

        // 5. Codex
        let codexUrl = try? codexExecutable()
        let codexAppExists = codexUrl != nil ||
                             FileManager.default.fileExists(atPath: "/Applications/ChatGPT.app") ||
                             FileManager.default.fileExists(atPath: home.appending(path: ".codex").path)
        let codexStatus = readCodexStatus(targetVersion: targetVersion, targetBuild: targetBuild)
        platforms.append(EditorPlatformStatus(
            id: "codex",
            name: "Codex",
            iconSystemName: "command",
            isAppInstalled: codexAppExists,
            isSynced: codexAppExists && versionsCompatible && codexStatus.isSynced,
            installedVersion: codexAppExists ? codexStatus.version : nil,
            targetVersion: targetVersion,
            isOutdated: codexAppExists && codexStatus.isOutdated,
            configPath: "~/.codex/config.toml",
            appVersion: appVersion,
            installedBuild: codexAppExists ? codexStatus.build : nil,
            targetBuild: targetBuild
        ))

        return platforms
    }

    static func syncPlatform(id: String, projectRoot: URL?, marketplaceRoot: URL) throws {
        let targetVersion = bundledTargetVersion(marketplaceRoot: marketplaceRoot)
        let targetBuild = bundledPluginBuildID(marketplaceRoot: marketplaceRoot)
        let appVersion = bundledAppVersion(marketplaceRoot: marketplaceRoot)
        guard appVersion == targetVersion else {
            throw CommandFailure(output: "contextos app v\(appVersion) 与内置插件 v\(targetVersion) 版本不一致；请重新构建或同步同一 bundle。")
        }

        // 1. Locate source server script inside App resources
        let sourceServerScript = marketplaceRoot
            .appending(path: "plugins/contextos/server/contextos-mcp.mjs")
            .standardizedFileURL
        guard FileManager.default.fileExists(atPath: sourceServerScript.path) else {
            throw CommandFailure(output: "未在 App 内部找到 MCP 服务端脚本: \(sourceServerScript.path)")
        }

        // 2. Deploy canonical user-level server script: ~/.contextos/server/contextos-mcp.mjs
        // Always delete old canonical file first, then copy fresh file
        let canonicalDir = canonicalServerDirectoryURL
        let canonicalServer = canonicalServerScriptURL
        try? FileManager.default.createDirectory(at: canonicalDir, withIntermediateDirectories: true)
        if FileManager.default.fileExists(atPath: canonicalServer.path) {
            try? FileManager.default.removeItem(at: canonicalServer)
        }
        do {
            try FileManager.default.copyItem(at: sourceServerScript, to: canonicalServer)
        } catch {
            throw CommandFailure(output: "部署 MCP 服务端到 \(canonicalServer.path) 失败: \(error.localizedDescription)")
        }
        let serverScript = canonicalServer.path

        let skillSource = marketplaceRoot
            .appending(path: "plugins/contextos/skills/contextos")
            .standardizedFileURL
        let home = FileManager.default.homeDirectoryForCurrentUser

        switch id {
        case "claude":
            let claudeConfigURL = home.appending(path: "Library/Application Support/Claude/claude_desktop_config.json")
            try? FileManager.default.createDirectory(at: claudeConfigURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            cleanJsonMcp(at: claudeConfigURL)
            _ = configureJsonMcp(at: claudeConfigURL, serverScript: serverScript, version: targetVersion, build: targetBuild)

        case "cursor":
            // 1. Clean old skill and MCP config
            let userCursorDir = home.appending(path: ".cursor")
            let userSkillDest = userCursorDir.appending(path: "skills/contextos")
            let userMcpConfig = userCursorDir.appending(path: "mcp.json")
            try? FileManager.default.createDirectory(at: userCursorDir, withIntermediateDirectories: true)
            try? FileManager.default.removeItem(at: userSkillDest)
            cleanJsonMcp(at: userMcpConfig)

            // 2. Copy fresh skill and write fresh MCP config
            syncDirectory(from: skillSource, to: userSkillDest)
            _ = configureJsonMcp(at: userMcpConfig, serverScript: serverScript, version: targetVersion, build: targetBuild)

            // 3. Update project root IF .cursor directory already explicitly existed
            if let root = projectRoot {
                let projectCursorDir = root.appending(path: ".cursor")
                if FileManager.default.fileExists(atPath: projectCursorDir.path) {
                    cleanJsonMcp(at: projectCursorDir.appending(path: "mcp.json"))
                    _ = configureJsonMcp(at: projectCursorDir.appending(path: "mcp.json"), serverScript: serverScript, version: targetVersion, build: targetBuild)
                }
            }

        case "antigravity":
            // 1. Clean old skill and MCP config
            let geminiConfigDir = home.appending(path: ".gemini/config")
            let userSkillDest = geminiConfigDir.appending(path: "skills/contextos")
            let userMcpConfig = geminiConfigDir.appending(path: "mcp_config.json")
            try? FileManager.default.createDirectory(at: geminiConfigDir, withIntermediateDirectories: true)
            try? FileManager.default.removeItem(at: userSkillDest)
            cleanJsonMcp(at: userMcpConfig)

            // 2. Copy fresh skill and write fresh MCP config
            syncDirectory(from: skillSource, to: userSkillDest)
            _ = configureJsonMcp(at: userMcpConfig, serverScript: serverScript, version: targetVersion, build: targetBuild)

            // 3. Update project root IF .agents/mcp_config.json already explicitly existed
            if let root = projectRoot {
                let projectAgentsConfig = root.appending(path: ".agents/mcp_config.json")
                if FileManager.default.fileExists(atPath: projectAgentsConfig.path) {
                    cleanJsonMcp(at: projectAgentsConfig)
                    _ = configureJsonMcp(at: projectAgentsConfig, serverScript: serverScript, version: targetVersion, build: targetBuild)
                }
            }

        case "opencode":
            // 1. Clean old skill and MCP config
            let userOpencodeDir = home.appending(path: ".config/opencode")
            let userSkillDest = userOpencodeDir.appending(path: "skills/contextos")
            let userMcpConfig = userOpencodeDir.appending(path: "mcp.json")
            try? FileManager.default.createDirectory(at: userOpencodeDir, withIntermediateDirectories: true)
            try? FileManager.default.removeItem(at: userSkillDest)
            cleanJsonMcp(at: userMcpConfig)

            // 2. Copy fresh skill and write fresh MCP config
            syncDirectory(from: skillSource, to: userSkillDest)
            _ = configureJsonMcp(at: userOpencodeDir.appending(path: "mcp.json"), serverScript: serverScript, version: targetVersion, build: targetBuild)

            // 3. Update project root IF .opencode directory already explicitly existed
            if let root = projectRoot {
                let projectOpencodeDir = root.appending(path: ".opencode")
                if FileManager.default.fileExists(atPath: projectOpencodeDir.path) {
                    cleanJsonMcp(at: projectOpencodeDir.appending(path: "mcp.json"))
                    _ = configureJsonMcp(at: projectOpencodeDir.appending(path: "mcp.json"), serverScript: serverScript, version: targetVersion, build: targetBuild)
                }
            }

        case "codex":
            let codexConfigURL = home.appending(path: ".codex/config.toml")
            let userPluginsContextOS = home.appending(path: "plugins/contextos")
            let personalMarketplaceDir = home.appending(path: ".agents/plugins")
            let personalMarketplaceURL = personalMarketplaceDir.appending(path: "marketplace.json")

            // 1. Clean up legacy marketplace and cache
            cleanCodexLegacyMarketplace(configURL: codexConfigURL)
            try? FileManager.default.removeItem(at: home.appending(path: ".codex/plugins/cache/contextos-development"))
            try? FileManager.default.removeItem(at: home.appending(path: ".codex/plugins/cache/contextos-personal"))
            if let executable = try? codexExecutable() {
                for plugin in [
                    "contextos@personal",
                    "contextos@contextos-development",
                ] {
                    _ = try? run(executable, arguments: ["plugin", "remove", plugin, "--json"])
                }
                for marketplace in ["contextos-development"] {
                    _ = try? run(executable, arguments: ["plugin", "marketplace", "remove", marketplace, "--json"])
                }
            }

            // 2. Delete old plugin bundles completely
            try? FileManager.default.removeItem(at: userPluginsContextOS)

            // 3. Sync fresh plugin bundle to ~/plugins/contextos
            let pluginSource = marketplaceRoot.appending(path: "plugins/contextos")
            syncDirectory(from: pluginSource, to: userPluginsContextOS)

            // Update version in ~/plugins/contextos/.codex-plugin/plugin.json only if changed
            let pluginJsonURL = userPluginsContextOS.appending(path: ".codex-plugin/plugin.json")
            if let data = try? Data(contentsOf: pluginJsonURL),
               var json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                let currentVer = (json["version"] as? String)?.components(separatedBy: "+").first
                if currentVer != targetVersion {
                    json["version"] = targetVersion
                    if let updatedData = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]) {
                        try? updatedData.write(to: pluginJsonURL)
                    }
                }
            }

            // 4. Ensure ~/.agents/plugins/marketplace.json has personal marketplace with contextos
            try? FileManager.default.createDirectory(at: personalMarketplaceDir, withIntermediateDirectories: true)
            let marketplaceEntry: [String: Any] = [
                "name": "personal",
                "interface": [
                    "displayName": "Personal"
                ],
                "plugins": [
                    [
                        "name": "contextos",
                        "source": [
                            "source": "local",
                            "path": "./plugins/contextos"
                        ],
                        "policy": [
                            "installation": "AVAILABLE",
                            "authentication": "ON_INSTALL"
                        ],
                        "category": "Productivity"
                    ]
                ]
            ]
            if let mpData = try? JSONSerialization.data(withJSONObject: marketplaceEntry, options: [.prettyPrinted, .sortedKeys]) {
                try? mpData.write(to: personalMarketplaceURL)
            }

            // 5. Install plugin via official codex plugin add contextos@personal
            if let executable = try? codexExecutable() {
                let installResult = try? run(executable, arguments: ["plugin", "add", "contextos@personal", "--json"])
                if installResult?.status != 0 {
                    configureTomlMcp(at: codexConfigURL, serverScript: serverScript, version: targetVersion, build: targetBuild)
                }
            } else {
                configureTomlMcp(at: codexConfigURL, serverScript: serverScript, version: targetVersion, build: targetBuild)
            }

        default:
            break
        }
    }

    static func installAll(projectRoot: URL?, marketplaceRoot: URL) throws {
        let statuses = detectAllPlatforms(projectRoot: projectRoot, marketplaceRoot: marketplaceRoot)
        for platform in statuses where platform.isAppInstalled {
            try syncPlatform(id: platform.id, projectRoot: projectRoot, marketplaceRoot: marketplaceRoot)
        }
    }

    static func install(marketplaceRoot: URL) throws {
        try installAll(projectRoot: nil, marketplaceRoot: marketplaceRoot)
    }

    static func isInstalled(marketplaceRoot: URL) throws -> Bool {
        let platforms = detectAllPlatforms(projectRoot: nil, marketplaceRoot: marketplaceRoot)
        return platforms.contains { $0.isSynced }
    }

    private static func readMcpMetadata(at configURL: URL) -> (version: String?, build: String?) {
        guard FileManager.default.fileExists(atPath: configURL.path),
              let data = try? Data(contentsOf: configURL),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let servers = json["mcpServers"] as? [String: Any],
              let contextos = servers["contextos"] as? [String: Any] else {
            return (nil, nil)
        }
        // Verify that the configured server script actually exists on disk!
        if let args = contextos["args"] as? [String], let script = args.first {
            guard FileManager.default.fileExists(atPath: script) else {
                return (nil, nil)
            }
        }
        var version: String?
        if let ver = contextos["_version"] as? String {
            version = ver
        } else if let ver = contextos["version"] as? String {
            version = ver
        }
        return (version, contextos["_build"] as? String)
    }

    private static func cleanJsonMcp(at configURL: URL) {
        guard FileManager.default.fileExists(atPath: configURL.path),
              let data = try? Data(contentsOf: configURL),
              var json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              var mcpServers = json["mcpServers"] as? [String: Any] else { return }
        var removed = false
        if mcpServers.removeValue(forKey: "contextos") != nil { removed = true }
        if removed {
            json["mcpServers"] = mcpServers
            if let outputData = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys]) {
                try? outputData.write(to: configURL)
            }
        }
    }

    private static func configureJsonMcp(at configURL: URL, serverScript: String, version: String, build: String) -> Bool {
        var json: [String: Any] = [:]
        if FileManager.default.fileExists(atPath: configURL.path),
           let data = try? Data(contentsOf: configURL),
           let existing = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            json = existing
        }
        var mcpServers = json["mcpServers"] as? [String: Any] ?? [:]
        mcpServers.removeValue(forKey: "contextos")
        mcpServers["contextos"] = [
            "command": "node",
            "args": [serverScript],
            "_version": version,
            "_build": build
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

    private static func syncDirectory(from sourceURL: URL, to destURL: URL) {
        let fm = FileManager.default
        guard fm.fileExists(atPath: sourceURL.path) else { return }
        try? fm.createDirectory(at: destURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let temporaryURL = destURL.deletingLastPathComponent()
            .appending(path: ".\(destURL.lastPathComponent).tmp-\(UUID().uuidString)")
        do {
            try? fm.removeItem(at: temporaryURL)
            try fm.copyItem(at: sourceURL, to: temporaryURL)
            if fm.fileExists(atPath: destURL.path) {
                try fm.removeItem(at: destURL)
            }
            try fm.moveItem(at: temporaryURL, to: destURL)
        } catch {
            try? fm.removeItem(at: temporaryURL)
        }
    }

    private static func readCodexStatus(targetVersion: String, targetBuild: String) -> (isInstalled: Bool, isSynced: Bool, isOutdated: Bool, version: String?, build: String?) {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let pluginJsonURL = home.appending(path: "plugins/contextos/.codex-plugin/plugin.json")
        let codexConfigURL = home.appending(path: ".codex/config.toml")
        
        guard FileManager.default.fileExists(atPath: codexConfigURL.path),
              let content = try? String(contentsOf: codexConfigURL, encoding: .utf8) else {
            return (false, false, false, nil, nil)
        }

        // The plugin is only considered installed if actively registered in ~/.codex/config.toml
        let hasPlugin = content.contains("[plugins.\"contextos")
        let hasMcp = content.contains("[mcp_servers.contextos]")
        guard hasPlugin || hasMcp else {
            return (false, false, false, nil, nil)
        }

        // Verify installed script exists on disk if plugin is registered
        let userScript = home.appending(path: "plugins/contextos/server/contextos-mcp.mjs")
        let canonicalScript = canonicalServerScriptURL
        let hasScriptOnDisk = FileManager.default.fileExists(atPath: userScript.path) || FileManager.default.fileExists(atPath: canonicalScript.path)
        guard hasScriptOnDisk else {
            return (false, false, false, nil, nil)
        }

        var detectedVer: String? = nil
        var detectedBuild: String? = nil
        let installedPluginRoot = home.appending(path: "plugins/contextos", directoryHint: .isDirectory)
        detectedBuild = pluginBuildID(pluginRoot: installedPluginRoot)
        
        if FileManager.default.fileExists(atPath: pluginJsonURL.path),
           let data = try? Data(contentsOf: pluginJsonURL),
           let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           let ver = json["version"] as? String {
            detectedVer = ver.components(separatedBy: "+").first ?? ver
        }

        if detectedVer == nil {
            for line in content.components(separatedBy: .newlines) {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.starts(with: "CONTEXTOS_VERSION") {
                    let parts = trimmed.components(separatedBy: "=")
                    if parts.count >= 2 {
                        detectedVer = parts[1].trimmingCharacters(in: CharacterSet(charactersIn: " \"'"))
                        break
                    }
                }
            }
        }

        if detectedBuild == nil {
            for line in content.components(separatedBy: .newlines) {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.starts(with: "CONTEXTOS_BUILD") {
                    let parts = trimmed.components(separatedBy: "=")
                    if parts.count >= 2 {
                        detectedBuild = parts[1].trimmingCharacters(in: CharacterSet(charactersIn: " \"'"))
                        break
                    }
                }
            }
        }

        guard let ver = detectedVer else {
            return (true, false, false, nil, detectedBuild)
        }
        let buildMatches = targetBuild.isEmpty || (detectedBuild == targetBuild)
        let hasSkill = FileManager.default.fileExists(atPath: installedPluginRoot.appending(path: "skills/contextos/SKILL.md").path)
        let isSynced = hasPlugin && hasSkill && (ver == targetVersion) && buildMatches
        let isOutdated = (ver != targetVersion)
        return (true, isSynced, isOutdated, ver, detectedBuild)
    }

    private static func cleanCodexLegacyMarketplace(configURL: URL) {
        let legacySections: Set<String> = [
            "[marketplaces.contextos-development]",
            "[plugins.\"contextos@contextos-development\"]",
        ]
        guard let configContent = try? String(contentsOf: configURL, encoding: .utf8),
              legacySections.contains(where: { configContent.contains($0) }) else { return }
        var cleanedLines: [String] = []
        var skipSection = false
        for line in configContent.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if legacySections.contains(trimmed) {
                skipSection = true
                continue
            }
            if skipSection && trimmed.hasPrefix("[") {
                skipSection = false
            }
            if !skipSection {
                cleanedLines.append(line)
            }
        }
        try? cleanedLines.joined(separator: "\n").write(to: configURL, atomically: true, encoding: .utf8)
    }

    private static func cleanTomlMcp(at configURL: URL) {
        guard let content = try? String(contentsOf: configURL, encoding: .utf8),
              content.contains("[mcp_servers.contextos]") else { return }
        var cleanedLines: [String] = []
        var skip = false
        for line in content.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed == "[mcp_servers.contextos]" {
                skip = true
                continue
            }
            if skip && trimmed.hasPrefix("[") {
                skip = false
            }
            if !skip {
                cleanedLines.append(line)
            }
        }
        try? cleanedLines.joined(separator: "\n").write(to: configURL, atomically: true, encoding: .utf8)
    }

    private static func configureTomlMcp(at configURL: URL, serverScript: String, version: String, build: String) {
        cleanTomlMcp(at: configURL)
        var content = (try? String(contentsOf: configURL, encoding: .utf8)) ?? ""
        content += """
        
        [mcp_servers.contextos]
        command = "node"
        args = ["--no-warnings=ExperimentalWarning", "\(serverScript)"]
        
        [mcp_servers.contextos.env]
        CONTEXTOS_VERSION = "\(version)"
        CONTEXTOS_BUILD = "\(build)"
        """
        try? content.write(to: configURL, atomically: true, encoding: .utf8)
    }
}
