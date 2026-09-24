import XCTest
@testable import ContextOSDesktop

final class PluginInstallerTests: XCTestCase {
    func testReplaceDirectoryAtomicallyReplacesAndKeepsDestinationOnFailure() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("contextos-installer-\(UUID().uuidString)")
        let source = root.appendingPathComponent("source")
        let destination = root.appendingPathComponent("destination")
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        try "new".write(to: source.appendingPathComponent("value.txt"), atomically: true, encoding: .utf8)
        try "old".write(to: destination.appendingPathComponent("value.txt"), atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: root) }

        try PluginInstaller.replaceDirectoryAtomically(from: source, to: destination)
        XCTAssertEqual(try String(contentsOf: destination.appendingPathComponent("value.txt")), "new")

        let missing = root.appendingPathComponent("missing")
        XCTAssertThrowsError(try PluginInstaller.replaceDirectoryAtomically(from: missing, to: destination))
        XCTAssertEqual(try String(contentsOf: destination.appendingPathComponent("value.txt")), "new")
    }

    func testCanonicalServerScriptStaysInUserContextDirectory() {
        let script = PluginInstaller.canonicalServerScriptURL
        XCTAssertEqual(script.deletingLastPathComponent(), PluginInstaller.canonicalServerDirectoryURL)
        XCTAssertFalse(script.path.hasPrefix(Bundle.main.bundleURL.path + "/"))
    }

    func testMarketplaceMergePreservesOtherPluginsAndUnknownFields() {
        let merged = PluginInstaller.mergePersonalMarketplace(existing: [
            "custom": ["keep": true],
            "plugins": [
                ["name": "other", "source": ["source": "local", "path": "./plugins/other"]],
                ["name": "contextos", "source": ["source": "old"]],
            ],
        ])

        XCTAssertEqual((merged["custom"] as? [String: Bool])?["keep"], true)
        let plugins = merged["plugins"] as? [[String: Any]]
        XCTAssertEqual(plugins?.count, 2)
        XCTAssertTrue(plugins?.contains(where: { ($0["name"] as? String) == "other" }) == true)
        XCTAssertEqual(plugins?.last?["name"] as? String, "contextos")
    }

    func testConfigureJsonMcpPreservesUnknownFieldsAndRejectsInvalidJson() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("contextos-json-\(UUID().uuidString)")
        let config = root.appendingPathComponent("mcp.json")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try #"{"custom":{"keep":true},"mcpServers":{"other":{"command":"other"}}}"#.write(to: config, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: root) }

        _ = try PluginInstaller.configureJsonMcp(
            at: config,
            serverScript: "/tmp/contextos-mcp.mjs",
            version: "2.4.0",
            build: "test"
        )
        let data = try Data(contentsOf: config)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual((json["custom"] as? [String: Bool])?["keep"], true)
        XCTAssertNotNil((json["mcpServers"] as? [String: Any])?["other"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: config.appendingPathExtension("contextos.bak").path))

        try "{ invalid json".write(to: config, atomically: true, encoding: .utf8)
        XCTAssertThrowsError(try PluginInstaller.configureJsonMcp(
            at: config,
            serverScript: "/tmp/contextos-mcp.mjs",
            version: "2.4.0",
            build: "test"
        ))
    }

    func testTomlStringEscapesQuotesBackslashesAndNewlines() {
        XCTAssertEqual(PluginInstaller.tomlString("a\"b\\nc"), "\"a\\\"b\\\\nc\"")
    }
}
