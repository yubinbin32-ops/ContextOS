import Foundation

enum PluginInstallStatus: Equatable {
    case idle
    case installing
    case installed
    case failed(String)
}

enum PluginInstaller {
    struct CommandFailure: LocalizedError {
        let output: String
        var errorDescription: String? { output }
    }

    static func install(marketplaceRoot: URL) throws {
        let executable = try codexExecutable()
        let addMarketplace = try run(executable, arguments: ["plugin", "marketplace", "add", marketplaceRoot.path, "--json"])
        if addMarketplace.status != 0 {
            let marketplaces = try run(executable, arguments: ["plugin", "marketplace", "list", "--json"])
            guard marketplaces.status == 0, marketplaces.output.contains("mdflow-development") else {
                throw CommandFailure(output: addMarketplace.output.nonEmpty ?? "Unable to register the mdflow marketplace.")
            }
        }

        let install = try run(executable, arguments: ["plugin", "add", "mdflow@mdflow-development", "--json"])
        guard install.status == 0 else {
            throw CommandFailure(output: install.output.nonEmpty ?? "Unable to install the mdflow plugin.")
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

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
