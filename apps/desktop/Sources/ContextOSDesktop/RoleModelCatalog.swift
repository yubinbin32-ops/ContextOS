import Foundation

struct RoleReasoningLevel: Codable, Equatable, Identifiable {
    let id: String
    let label: String
}

struct RoleCatalogModel: Codable, Equatable, Identifiable {
    let id: String
    let label: String?
    let reasoningLevels: [RoleReasoningLevel]
    let reasoningSource: String
}

struct RoleModelCatalog: Codable, Equatable {
    let models: [RoleCatalogModel]
    let source: String
    let warnings: [String]
}

/// Explicit catalog discovery only; no generation requests or credential-bearing cache.
enum RoleCatalogService {
    static let deepSeekSource = "ContextOS DeepSeek mapping · https://api-docs.deepseek.com/guides/thinking_mode/"
    static let maximumBytes = 2_000_000

    static func modelsURL(_ baseURL: String) throws -> URL {
        guard var parts = URLComponents(string: baseURL.trimmingCharacters(in: .whitespacesAndNewlines)),
              ["http", "https"].contains(parts.scheme?.lowercased() ?? ""), parts.host != nil,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil else {
            throw failure("Enter a valid Base URL without credentials or query parameters.")
        }
        var path = parts.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        for suffix in ["chat/completions", "responses"] where path.hasSuffix(suffix) {
            path = String(path.dropLast(suffix.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            break
        }
        if !path.hasSuffix("/models") && path != "models" { path += (path.isEmpty ? "" : "/") + "models" }
        parts.path = "/" + path
        guard let url = parts.url else { throw failure("Invalid Base URL.") }
        return url
    }

    static func micro(baseURL: String, key: String?, configuration: [String: Any]) async throws -> RoleModelCatalog {
        let url = try modelsURL(baseURL)
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let key, !key.isEmpty { request.setValue("Bearer " + key, forHTTPHeaderField: "Authorization") }
        let delegate = NoCatalogRedirects()
        let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch { throw failure("Model sync failed. Check the connection; custom input remains available.") }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw failure("Model sync failed (HTTP \(status)). Custom input remains available.")
        }
        guard data.count <= maximumBytes else { throw failure("Model catalog is too large.") }
        let value = try JSONSerialization.jsonObject(with: data)
        return try parseJSON(value, source: "API /models", microConfiguration: configuration)
    }

    static func parseJSON(_ value: Any, source: String, microConfiguration: [String: Any]? = nil) throws -> RoleModelCatalog {
        guard let object = value as? [String: Any],
              let rows = (object["models"] ?? object["data"]) as? [[String: Any]] else {
            throw failure("The service did not return a model catalog. Custom input remains available.")
        }
        var seen = Set<String>()
        let models = rows.compactMap { row -> RoleCatalogModel? in
            guard row["hidden"] as? Bool != true,
                  let id = (row["model"] ?? row["id"]) as? String, !id.isEmpty, id.count <= 200,
                  seen.insert(id).inserted else { return nil }
            let advertised = row["reasoningLevels"] ?? row["thinkingLevels"] ?? row["supportedReasoningEfforts"] ?? row["supported_reasoning_efforts"] ?? row["reasoning_efforts"]
            let rawLevels = advertised as? [Any] ?? []
            var levels = rawLevels.compactMap { value -> String? in
                if let text = value as? String { return text }
                return (value as? [String: Any])?["id"] as? String
                    ?? (value as? [String: Any])?["reasoningEffort"] as? String
                    ?? (value as? [String: Any])?["reasoning_effort"] as? String
            }
            var modelSource = row["reasoningSource"] as? String ?? (advertised == nil ? "Not advertised · inherit or custom" : source)
            if advertised == nil, let config = microConfiguration {
                let transport = config["transport"] as? String ?? config["protocol"] as? String ?? "chat"
                let mapping = (config["thinkingMap"] as? [String: Any])?[transport] as? [String: Any] ?? [:]
                if !mapping.isEmpty {
                    levels = mapping.filter { !($0.value is NSNull) && ($0.value as? Bool != false) }.map(\.key).sorted()
                    modelSource = "Profile thinkingMap"
                } else if id.lowercased().hasPrefix("deepseek-v4") || ["deepseek-flash", "deepseek-pro"].contains(id.lowercased()) {
                    // These are requested OS levels; medium maps to high in the existing transport normalizer.
                    levels = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
                    modelSource = deepSeekSource
                }
            }
            var levelSeen = Set<String>()
            levels = levels.filter { !$0.isEmpty && $0.count <= 80 && levelSeen.insert($0).inserted }
            let label = (row["label"] ?? row["displayName"] ?? row["display_name"] ?? row["name"]) as? String
            let reasoning = levels.map { level in
                let metadata = rawLevels.compactMap { $0 as? [String: Any] }.first {
                    ($0["id"] as? String ?? $0["reasoningEffort"] as? String ?? $0["reasoning_effort"] as? String) == level
                }
                return RoleReasoningLevel(id: level, label: String((metadata?["label"] as? String ?? level).prefix(200)))
            }
            return RoleCatalogModel(id: id, label: label.map { String($0.prefix(200)) }, reasoningLevels: reasoning, reasoningSource: modelSource)
        }
        guard !models.isEmpty else { throw failure("No models were returned. Custom input remains available.") }
        var warnings = object["warnings"] as? [String] ?? []
        if models.contains(where: { $0.reasoningLevels.isEmpty }) {
            warnings.append("Some models do not advertise thinking levels; inherit or enter a custom value.")
        }
        return RoleModelCatalog(models: models, source: source, warnings: warnings)
    }

    static func parseAGY(_ output: String) throws -> RoleModelCatalog {
        let clean = output.replacingOccurrences(of: "\u{001B}\\[[0-9;]*m", with: "", options: .regularExpression)
        var seen = Set<String>()
        let rows: [(String, String?)] = clean.split(whereSeparator: \.isNewline).compactMap { line in
            let text = String(line).trimmingCharacters(in: .whitespaces)
            let fields = text.components(separatedBy: .init(charactersIn: "\t")).filter { !$0.isEmpty }
            let spaced = text.range(of: " {2,}", options: .regularExpression)
            let id = fields.count > 1 ? fields[0] : spaced.map { String(text[..<$0.lowerBound]) } ?? text
            let label = fields.count > 1 ? fields[1] : spaced.map { String(text[$0.upperBound...]) }
            guard !id.isEmpty, id.count <= 200,
                  id.range(of: "^[A-Za-z0-9][A-Za-z0-9._/-]*$", options: .regularExpression) != nil,
                  !["model", "models", "name", "slug"].contains(id.lowercased()), seen.insert(id).inserted else { return nil }
            return (id, label)
        }
        let identifiers = Set(rows.map { $0.0 })
        let models = rows.map { id, label in
            let level = ["low", "medium", "high", "xhigh", "max"].first { id.hasSuffix("-" + $0) }
            let levels: [String]
            if let level {
                let family = String(id.dropLast(level.count))
                levels = ["low", "medium", "high", "xhigh", "max"].filter { identifiers.contains(family + $0) }
            } else { levels = [] }
            return RoleCatalogModel(id: id, label: label, reasoningLevels: levels.map { RoleReasoningLevel(id: $0, label: $0) }, reasoningSource: levels.isEmpty ? "Not advertised · inherit or custom" : "agy models / listed aliases")
        }
        guard !models.isEmpty else { throw failure("AGY returned no models. Custom input remains available.") }
        return RoleModelCatalog(models: models, source: "agy models", warnings: models.contains(where: { $0.reasoningLevels.isEmpty }) ? ["Some aliases do not advertise thinking levels; inherit or enter a custom value."] : [])
    }

    static func cli(adapterID: String, configuration: [String: Any]) async throws -> RoleModelCatalog {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do { continuation.resume(returning: try cliBlocking(adapterID: adapterID, configuration: configuration)) }
                catch { continuation.resume(throwing: error) }
            }
        }
    }

    static func cliBlocking(adapterID: String, configuration: [String: Any]) throws -> RoleModelCatalog {
        let command = configuration["command"] as? String ?? (configuration["command"] as? [String])?.first ?? ""
        let executable = command.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? ""
        let name = URL(fileURLWithPath: executable).lastPathComponent
        if let catalog = configuration["catalog"] as? [String: Any],
           let command = catalog["command"] as? String, !command.isEmpty,
           let args = catalog["args"] as? [String] {
            let data = try commandOutput(command: command, args: args)
            return try parseJSON(JSONSerialization.jsonObject(with: data), source: "Adapter catalog")
        }
        if name == "agy" { return try parseAGY(String(decoding: commandOutput(command: executable, args: ["models"]), as: UTF8.self)) }
        if name == "codex" || configuration["provider"] as? String == "codex-cli" || adapterID == "codex" {
            return try codexCatalog(command: name == "codex" ? executable : "codex")
        }
        throw failure("This adapter needs an explicit catalog command. Custom input remains available.")
    }

    private static func process(command: String, args: [String]) -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [command] + args
        var environment = ProcessInfo.processInfo.environment
        let paths = [environment["PATH"] ?? "/usr/bin:/bin", "/opt/homebrew/bin", "/usr/local/bin",
                     NSHomeDirectory() + "/.local/bin", NSHomeDirectory() + "/.cargo/bin"]
        environment["PATH"] = paths.joined(separator: ":")
        process.environment = environment
        process.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
        process.standardError = FileHandle.nullDevice
        return process
    }

    private static func timeout(_ process: Process) -> DispatchWorkItem {
        let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + 25, execute: timeout)
        return timeout
    }

    private static func commandOutput(command: String, args: [String]) throws -> Data {
        let process = process(command: command, args: args)
        let output = Pipe()
        process.standardOutput = output
        process.standardInput = FileHandle.nullDevice
        do { try process.run() } catch { throw failure("CLI is unavailable. Check installation; custom input remains available.") }
        let timeout = timeout(process)
        defer { timeout.cancel(); if process.isRunning { process.terminate() } }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw failure("CLI model sync failed. Check login; custom input remains available.") }
        guard data.count <= maximumBytes else { throw failure("Model catalog is too large.") }
        return data
    }

    private static func codexCatalog(command: String) throws -> RoleModelCatalog {
        let process = process(command: command, args: ["app-server", "--listen", "stdio://"])
        let input = Pipe(), output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        do { try process.run() } catch { throw failure("Codex is unavailable. Custom input remains available.") }
        let deadline = timeout(process)
        defer {
            deadline.cancel()
            try? input.fileHandleForWriting.close()
            if process.isRunning { process.terminate() }
        }
        func send(_ object: [String: Any]) throws {
            var data = try JSONSerialization.data(withJSONObject: object)
            data.append(10)
            try input.fileHandleForWriting.write(contentsOf: data)
        }
        try send(["id": 1, "method": "initialize", "params": ["clientInfo": ["name": "contextos-model-catalog", "version": "3.0.0"]]])
        var buffer = Data()
        var bytesRead = 0
        var requestID = 2
        var rows: [[String: Any]] = []
        var cursors = Set<String>()
        while true {
            let chunk = output.fileHandleForReading.availableData
            guard !chunk.isEmpty else { throw failure("Codex model sync failed. Check login; custom input remains available.") }
            bytesRead += chunk.count
            guard bytesRead <= maximumBytes else { throw failure("Model catalog is too large.") }
            buffer.append(chunk)
            while let newline = buffer.firstIndex(of: 10) {
                let line = buffer.prefix(upTo: newline)
                buffer.removeSubrange(...newline)
                guard let message = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
                guard let id = message["id"] as? Int else { continue }
                if message["error"] != nil { throw failure("Codex rejected model discovery. Custom input remains available.") }
                if id == 1 {
                    try send(["method": "initialized"])
                    try send(["id": requestID, "method": "model/list", "params": ["limit": 100, "includeHidden": false]])
                } else if id == requestID, let result = message["result"] as? [String: Any] {
                    rows += result["data"] as? [[String: Any]] ?? []
                    if let cursor = result["nextCursor"] as? String, !cursor.isEmpty {
                        guard cursors.count < 20, cursors.insert(cursor).inserted else { throw failure("Invalid catalog pagination.") }
                        requestID += 1
                        try send(["id": requestID, "method": "model/list", "params": ["limit": 100, "includeHidden": false, "cursor": cursor]])
                    } else {
                        return try parseJSON(["data": rows], source: "codex app-server model/list")
                    }
                }
            }
        }
    }

    private static func failure(_ message: String) -> NSError {
        NSError(domain: "RoleCatalog", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}

private final class NoCatalogRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // Never forward bearer credentials to a redirect destination.
        completionHandler(nil)
    }
}
