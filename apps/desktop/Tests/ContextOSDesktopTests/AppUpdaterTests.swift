import XCTest
@testable import ContextOSDesktop

@MainActor
final class AppUpdaterTests: XCTestCase {
    func testChecksumParsingFindsMatchingAsset() throws {
        let text = """
        aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  ContextOS-macos-full-arm64.zip
        bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb *ContextOS-macos-arm64.zip
        """
        XCTAssertEqual(
            try AppUpdater.parseChecksum(text, assetName: "ContextOS-macos-full-arm64.zip"),
            String(repeating: "a", count: 64)
        )
        XCTAssertEqual(
            try AppUpdater.parseChecksum(text, assetName: "ContextOS-macos-arm64.zip"),
            String(repeating: "b", count: 64)
        )
    }

    func testChecksumParsingRejectsMissingOrMalformedHashes() {
        XCTAssertThrowsError(try AppUpdater.parseChecksum("not-a-hash  ContextOS-macos.zip", assetName: "ContextOS-macos.zip"))
        XCTAssertThrowsError(try AppUpdater.parseChecksum("aaaaaaaa  other.zip", assetName: "ContextOS-macos.zip"))
    }

    func testSHA256MatchesKnownVector() throws {
        let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent("contextos-sha256-\(UUID().uuidString).txt")
        try Data("abc".utf8).write(to: fileURL)
        defer { try? FileManager.default.removeItem(at: fileURL) }
        XCTAssertEqual(
            try AppUpdater.sha256(forFileAt: fileURL),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        )
        XCTAssertNoThrow(try AppUpdater.validateSHA256(
            actual: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            expected: "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD"
        ))
        XCTAssertThrowsError(try AppUpdater.validateSHA256(actual: String(repeating: "0", count: 64), expected: String(repeating: "a", count: 64)))
    }

    func testChecksumAssetDetection() {
        let checksum = AppReleaseAsset(
            id: 1,
            name: "SHA256SUMS-arm64.txt",
            downloadUrl: URL(string: "https://example.com/SHA256SUMS-arm64.txt")!,
            size: 10
        )
        let archive = AppReleaseAsset(
            id: 2,
            name: "ContextOS-macos-full-arm64.zip",
            downloadUrl: URL(string: "https://example.com/app.zip")!,
            size: 10
        )
        XCTAssertTrue(checksum.isChecksum)
        XCTAssertFalse(archive.isChecksum)
    }

    func testReleaseSelectionMatchesArchitectureAndFallsBackToUniversalAssets() {
        let release = AppRelease(
            id: 1,
            tagName: "v2.4.0",
            version: "2.4.0",
            name: "ContextOS 2.4.0",
            body: "",
            publishedAt: nil,
            htmlUrl: URL(string: "https://example.com/release")!,
            isPrerelease: false,
            assets: [
                asset(id: 1, name: "ContextOS-macos-full-arm64.zip"),
                asset(id: 2, name: "ContextOS-macos-full-x64.zip"),
                asset(id: 3, name: "ContextOS-macos-arm64.zip"),
                asset(id: 4, name: "ContextOS-macos-x64.zip"),
                asset(id: 5, name: "SHA256SUMS-arm64.txt"),
                asset(id: 6, name: "SHA256SUMS-x64.txt"),
                asset(id: 7, name: "SHA256SUMS"),
            ]
        )

        XCTAssertEqual(release.asset(for: .full, architecture: "arm64")?.name, "ContextOS-macos-full-arm64.zip")
        XCTAssertEqual(release.asset(for: .standard, architecture: "x64")?.name, "ContextOS-macos-x64.zip")
        XCTAssertEqual(release.checksumAsset(for: "arm64")?.name, "SHA256SUMS")

        let universal = AppRelease(
            id: 2,
            tagName: "v2.4.1",
            version: "2.4.1",
            name: "ContextOS 2.4.1",
            body: "",
            publishedAt: nil,
            htmlUrl: URL(string: "https://example.com/release")!,
            isPrerelease: false,
            assets: [
                asset(id: 8, name: "ContextOS-macos-full.zip"),
                asset(id: 9, name: "ContextOS-macos.zip"),
                asset(id: 10, name: "SHA256SUMS.txt"),
            ]
        )
        XCTAssertEqual(universal.asset(for: .full, architecture: "arm64")?.name, "ContextOS-macos-full.zip")
        XCTAssertEqual(universal.asset(for: .standard, architecture: "x64")?.name, "ContextOS-macos.zip")
        XCTAssertEqual(universal.checksumAsset(for: "x64")?.name, "SHA256SUMS.txt")
    }

    func testReleaseSelectionRejectsWrongArchitectureOnlyAssets() {
        let release = AppRelease(
            id: 1,
            tagName: "v2.4.0",
            version: "2.4.0",
            name: "ContextOS 2.4.0",
            body: "",
            publishedAt: nil,
            htmlUrl: URL(string: "https://example.com/release")!,
            isPrerelease: false,
            assets: [asset(id: 1, name: "ContextOS-macos-full-arm64.zip")]
        )
        XCTAssertNil(release.asset(for: .full, architecture: "x64"))
    }

    func testSignatureIdentityParsing() {
        XCTAssertEqual(
            AppUpdater.signatureIdentity(from: "Signature=adhoc\nTeamIdentifier=not set"),
            .adHoc
        )
        XCTAssertEqual(
            AppUpdater.signatureIdentity(from: "Authority=Developer ID Application: Example (TEAM123)\nTeamIdentifier=TEAM123"),
            .developerID(teamIdentifier: "TEAM123")
        )
        XCTAssertEqual(
            AppUpdater.signatureIdentity(from: "Signature=adhoc\nAuthority=Apple Development: Example"),
            .adHoc
        )
        XCTAssertEqual(AppUpdater.signatureIdentity(from: "TeamIdentifier=TEAM123"), .unknown)
    }

    func testSignatureCompatibilityAllowsMatchingTrustClass() {
        XCTAssertNoThrow(try AppUpdater.validateSignatureCompatibility(current: .adHoc, staged: .adHoc))
        XCTAssertNoThrow(try AppUpdater.validateSignatureCompatibility(
            current: .adHoc,
            staged: .developerID(teamIdentifier: "TEAM123")
        ))
        XCTAssertNoThrow(try AppUpdater.validateSignatureCompatibility(
            current: .developerID(teamIdentifier: "TEAM123"),
            staged: .developerID(teamIdentifier: "TEAM123")
        ))
    }

    func testSignatureCompatibilityRejectsDowngradeAndTeamChange() {
        XCTAssertThrowsError(try AppUpdater.validateSignatureCompatibility(
            current: .developerID(teamIdentifier: "TEAM123"),
            staged: .adHoc
        ))
        XCTAssertThrowsError(try AppUpdater.validateSignatureCompatibility(
            current: .developerID(teamIdentifier: "TEAM123"),
            staged: .developerID(teamIdentifier: "TEAM456")
        ))
        XCTAssertThrowsError(try AppUpdater.validateSignatureCompatibility(current: .unknown, staged: .adHoc))
    }

    private func asset(id: Int, name: String) -> AppReleaseAsset {
        AppReleaseAsset(
            id: id,
            name: name,
            downloadUrl: URL(string: "https://example.com/\(name)")!,
            size: 10
        )
    }
}
