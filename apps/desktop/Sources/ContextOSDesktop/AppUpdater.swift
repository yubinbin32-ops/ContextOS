import Foundation
import AppKit
import SwiftUI

// MARK: - Models

public struct AppReleaseAsset: Identifiable, Equatable, Sendable {
    public let id: Int
    public let name: String
    public let downloadUrl: URL
    public let size: Int64

    public var formattedSize: String {
        ByteCountFormatter.string(fromByteCount: size, countStyle: .file)
    }

    public var isFullEdition: Bool {
        let lower = name.lowercased()
        return lower.contains("-full") || lower.contains("full")
    }

    public var isStandardEdition: Bool {
        let lower = name.lowercased()
        return lower.hasSuffix(".zip") && !isFullEdition
    }
}

public struct AppRelease: Identifiable, Equatable, Sendable {
    public let id: Int
    public let tagName: String
    public let version: String
    public let name: String
    public let body: String
    public let publishedAt: Date?
    public let htmlUrl: URL
    public let isPrerelease: Bool
    public let assets: [AppReleaseAsset]

    public func asset(for edition: UpdateEdition) -> AppReleaseAsset? {
        switch edition {
        case .full:
            return assets.first(where: { $0.isFullEdition }) ?? assets.first
        case .standard:
            return assets.first(where: { $0.isStandardEdition }) ?? assets.first
        }
    }
}

public enum UpdateEdition: String, CaseIterable, Identifiable, Sendable {
    case full = "full"
    case standard = "standard"

    public var id: String { rawValue }
}

public struct LocalNodeEnvironment: Equatable, Sendable {
    public let isQualified: Bool // Node >= 22
    public let version: String?
    public let executablePath: String?
    public let message: String

    public static let unknown = LocalNodeEnvironment(
        isQualified: false,
        version: nil,
        executablePath: nil,
        message: "未检测到本地 Node.js 22+ 环境"
    )
}

public enum UpdateState: Equatable, Sendable {
    case idle
    case checking
    case upToDate(checkedAt: Date)
    case updateAvailable(latest: AppRelease, releases: [AppRelease])
    case downloading(progress: Double, bytesWritten: Int64, totalBytes: Int64)
    case readyToInstall(stagedAppURL: URL, version: String)
    case installing
    case failed(message: String)

    public static func == (lhs: UpdateState, rhs: UpdateState) -> Bool {
        switch (lhs, rhs) {
        case (.idle, .idle), (.checking, .checking), (.installing, .installing):
            return true
        case (.upToDate(let a), .upToDate(let b)):
            return a == b
        case (.updateAvailable(let l1, let r1), .updateAvailable(let l2, let r2)):
            return l1 == l2 && r1 == r2
        case (.downloading(let p1, let b1, let t1), .downloading(let p2, let b2, let t2)):
            return p1 == p2 && b1 == b2 && t1 == t2
        case (.readyToInstall(let u1, let v1), .readyToInstall(let u2, let v2)):
            return u1 == u2 && v1 == v2
        case (.failed(let m1), .failed(let m2)):
            return m1 == m2
        default:
            return false
        }
    }
}

// MARK: - AppUpdater Engine

@MainActor
public final class AppUpdater: NSObject, ObservableObject {
    public static let shared = AppUpdater()

    public static let defaultRepository = "yubinbin32-ops/ContextOS"

    @Published public var state: UpdateState = .idle
    @Published public var repository: String {
        didSet {
            UserDefaults.standard.set(repository, forKey: "contextos.update_repo")
        }
    }
    @Published public var selectedEdition: UpdateEdition = .full
    @Published public var selectedReleaseId: Int? = nil
    @Published public var showReleaseNotes = false
    @Published public var nodeEnvironment: LocalNodeEnvironment = AppUpdater.detectSystemNodeEnvironment()

    private var activeDownloadTask: URLSessionDownloadTask?
    private var downloadDelegateHandler: DownloadProgressHandler?
    private var lastCheckedDate: Date?

    public var currentAppVersion: String {
        if let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String, !version.isEmpty {
            return version
        }
        return "2.2.2"
    }

    public var currentBuildNumber: String {
        if let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String, !build.isEmpty {
            return build
        }
        return ""
    }

    public override init() {
        let savedRepo = UserDefaults.standard.string(forKey: "contextos.update_repo")
        self.repository = (savedRepo?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false) ? savedRepo! : Self.defaultRepository
        let nodeEnv = Self.detectSystemNodeEnvironment()
        self.nodeEnvironment = nodeEnv
        // 检测本地 Node 环境：不合格（未安装或 < 22）则默认下载全功能版 (Full)；合格则推荐轻量版 (Standard)
        self.selectedEdition = nodeEnv.isQualified ? .standard : .full
        super.init()
    }

    // MARK: - Version Comparison

    public static func cleanVersion(_ raw: String) -> String {
        var clean = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if clean.lowercased().hasPrefix("v") {
            clean = String(clean.dropFirst())
        }
        return clean
    }

    public static func compareVersions(_ v1: String, _ v2: String) -> ComparisonResult {
        let clean1 = cleanVersion(v1)
        let clean2 = cleanVersion(v2)

        let parts1 = clean1.split(separator: "-").first?.split(separator: ".").compactMap { Int($0) } ?? []
        let parts2 = clean2.split(separator: "-").first?.split(separator: ".").compactMap { Int($0) } ?? []

        let count = max(parts1.count, parts2.count)
        for i in 0..<count {
            let p1 = i < parts1.count ? parts1[i] : 0
            let p2 = i < parts2.count ? parts2[i] : 0
            if p1 > p2 { return .orderedDescending }
            if p1 < p2 { return .orderedAscending }
        }

        return .orderedSame
    }

    public static func isNewer(remote: String, current: String) -> Bool {
        compareVersions(remote, current) == .orderedDescending
    }

    // MARK: - Explicit Check Triggers (每次启动 + 打开设置才检测更新)

    /// 每次应用启动时触发更新检测
    public func checkOnLaunch() {
        Task { await checkForUpdates(force: true) }
    }

    /// 每次打开设置窗口时触发更新检测
    public func checkOnSettingsOpen() {
        Task { await checkForUpdates(force: true) }
    }

    public func checkIfNeeded(force: Bool = false) {
        Task { await checkForUpdates(force: force) }
    }

    // MARK: - Check For Updates

    public func checkForUpdates(force: Bool = false) async {
        guard state != .checking else { return }

        state = .checking

        let repo = repository.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanRepo = repo.replacingOccurrences(of: "https://github.com/", with: "")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))

        guard !cleanRepo.isEmpty,
              let url = URL(string: "https://api.github.com/repos/\(cleanRepo)/releases") else {
            state = .failed(message: "无效的 Git 仓库地址")
            return
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("ContextOS-Updater", forHTTPHeaderField: "User-Agent")

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                state = .failed(message: "服务器响应无效")
                return
            }

            if httpResponse.statusCode == 404 {
                state = .failed(message: "未找到仓库 \(cleanRepo) 或无公开 Release")
                return
            } else if httpResponse.statusCode != 200 {
                state = .failed(message: "GitHub API 错误 (状态码: \(httpResponse.statusCode))")
                return
            }

            let releases = try parseReleases(from: data)
            lastCheckedDate = Date()

            let nodeEnv = Self.detectSystemNodeEnvironment()
            self.nodeEnvironment = nodeEnv
            if !nodeEnv.isQualified {
                self.selectedEdition = .full
            }

            if let latest = releases.first(where: { !$0.isPrerelease }) ?? releases.first {
                if selectedReleaseId == nil || !releases.contains(where: { $0.id == selectedReleaseId }) {
                    selectedReleaseId = latest.id
                }

                if Self.isNewer(remote: latest.version, current: currentAppVersion) {
                    state = .updateAvailable(latest: latest, releases: releases)
                } else {
                    state = .upToDate(checkedAt: Date())
                }
            } else {
                state = .upToDate(checkedAt: Date())
            }
        } catch {
            state = .failed(message: error.localizedDescription)
        }
    }

    // MARK: - JSON Parsing

    private func parseReleases(from data: Data) throws -> [AppRelease] {
        guard let jsonArray = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return []
        }

        let dateFormatter = ISO8601DateFormatter()
        dateFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fallbackDateFormatter = ISO8601DateFormatter()

        var releases: [AppRelease] = []

        for dict in jsonArray {
            guard let id = dict["id"] as? Int,
                  let tagName = dict["tag_name"] as? String,
                  let htmlUrlStr = dict["html_url"] as? String,
                  let htmlUrl = URL(string: htmlUrlStr) else {
                continue
            }

            let isDraft = dict["draft"] as? Bool ?? false
            if isDraft { continue }

            let name = dict["name"] as? String ?? tagName
            let body = dict["body"] as? String ?? ""
            let isPrerelease = dict["prerelease"] as? Bool ?? false

            var publishedAt: Date? = nil
            if let publishedStr = dict["published_at"] as? String {
                publishedAt = dateFormatter.date(from: publishedStr) ?? fallbackDateFormatter.date(from: publishedStr)
            }

            var assets: [AppReleaseAsset] = []
            if let assetsArray = dict["assets"] as? [[String: Any]] {
                for assetDict in assetsArray {
                    guard let assetId = assetDict["id"] as? Int,
                          let assetName = assetDict["name"] as? String,
                          let downloadStr = assetDict["browser_download_url"] as? String,
                          let downloadUrl = URL(string: downloadStr) else {
                        continue
                    }
                    let size = (assetDict["size"] as? NSNumber)?.int64Value ?? 0
                    assets.append(AppReleaseAsset(id: assetId, name: assetName, downloadUrl: downloadUrl, size: size))
                }
            }

            let version = Self.cleanVersion(tagName)
            releases.append(AppRelease(
                id: id,
                tagName: tagName,
                version: version,
                name: name,
                body: body,
                publishedAt: publishedAt,
                htmlUrl: htmlUrl,
                isPrerelease: isPrerelease,
                assets: assets
            ))
        }

        return releases
    }

    // MARK: - Download & In-App Update

    public func downloadAndApplyUpdate(release: AppRelease, edition: UpdateEdition) {
        if edition == .standard && !nodeEnvironment.isQualified {
            state = .failed(message: "本地未检测到合格的 Node 22+ 环境，无法运行轻量版，请选择全功能版更新")
            return
        }

        guard let asset = release.asset(for: edition) else {
            state = .failed(message: "该版本未提供所选规格的下载产物")
            return
        }

        cancelDownload()
        state = .downloading(progress: 0.0, bytesWritten: 0, totalBytes: asset.size)

        let sessionConfig = URLSessionConfiguration.default
        let handler = DownloadProgressHandler { [weak self] progress, written, total in
            Task { @MainActor [weak self] in
                self?.state = .downloading(progress: progress, bytesWritten: written, totalBytes: total)
            }
        } onCompletion: { [weak self] tempFileURL, error in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let error {
                    self.state = .failed(message: "下载失败: \(error.localizedDescription)")
                    return
                }
                guard let tempFileURL else {
                    self.state = .failed(message: "下载文件丢失")
                    return
                }

                self.unpackAndStage(downloadedZipURL: tempFileURL, release: release)
            }
        }

        self.downloadDelegateHandler = handler
        let session = URLSession(configuration: sessionConfig, delegate: handler, delegateQueue: nil)
        let task = session.downloadTask(with: asset.downloadUrl)
        self.activeDownloadTask = task
        task.resume()
    }

    public func cancelDownload() {
        activeDownloadTask?.cancel()
        activeDownloadTask = nil
        downloadDelegateHandler = nil
    }

    // MARK: - Unpack & Stage

    private func unpackAndStage(downloadedZipURL: URL, release: AppRelease) {
        state = .installing

        Task.detached(priority: .userInitiated) { [weak self] in
            let fm = FileManager.default
            let tempDir = fm.temporaryDirectory.appendingPathComponent("ContextOS-Update-\(UUID().uuidString)")

            do {
                try fm.createDirectory(at: tempDir, withIntermediateDirectories: true)
                let zipDest = tempDir.appendingPathComponent("update.zip")
                try fm.copyItem(at: downloadedZipURL, to: zipDest)

                // Unpack with ditto (preserves symlinks, extended attributes, and permissions)
                let extractDir = tempDir.appendingPathComponent("extracted")
                try fm.createDirectory(at: extractDir, withIntermediateDirectories: true)

                let ditto = Process()
                ditto.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
                ditto.arguments = ["-xk", zipDest.path, extractDir.path]
                try ditto.run()
                ditto.waitUntilExit()

                guard ditto.terminationStatus == 0 else {
                    throw NSError(domain: "AppUpdater", code: 1, userInfo: [NSLocalizedDescriptionKey: "解压更新包失败"])
                }

                // Locate ContextOS.app
                let stagedApp: URL
                let directApp = extractDir.appendingPathComponent("ContextOS.app")
                if fm.fileExists(atPath: directApp.path) {
                    stagedApp = directApp
                } else if let contents = try? fm.contentsOfDirectory(at: extractDir, includingPropertiesForKeys: nil),
                          let nested = contents.first(where: { $0.lastPathComponent == "ContextOS.app" }) {
                    stagedApp = nested
                } else {
                    throw NSError(domain: "AppUpdater", code: 2, userInfo: [NSLocalizedDescriptionKey: "更新包中未包含有效的 ContextOS.app"])
                }

                // Check executable
                let execPath = stagedApp.appendingPathComponent("Contents/MacOS/ContextOS").path
                guard fm.isExecutableFile(atPath: execPath) else {
                    throw NSError(domain: "AppUpdater", code: 3, userInfo: [NSLocalizedDescriptionKey: "解压的 ContextOS.app 缺少可执行程序"])
                }

                await self?.updateStateOnMain(.readyToInstall(stagedAppURL: stagedApp, version: release.version))
            } catch {
                await self?.updateStateOnMain(.failed(message: error.localizedDescription))
            }
        }
    }

    private func updateStateOnMain(_ newState: UpdateState) {
        self.state = newState
    }

    // MARK: - Final Swap & Relaunch

    public func installAndRelaunch(stagedAppURL: URL) {
        let currentBundleURL = Bundle.main.bundleURL
        let isRunningFromApp = currentBundleURL.pathExtension == "app"

        if !isRunningFromApp {
            // Running in development mode (e.g. swift run or Xcode)
            // Reveal the staged application in Finder without destroying the dev workspace
            NSWorkspace.shared.activateFileViewerSelecting([stagedAppURL])
            state = .failed(message: "当前处于源码开发环境，新版本应用已就绪在缓存目录：\(stagedAppURL.path)")
            return
        }

        let pid = ProcessInfo.processInfo.processIdentifier
        let scriptContent = """
        #!/bin/bash
        # ContextOS In-Place Update Script
        PID=\(pid)
        STAGED="\(stagedAppURL.path)"
        TARGET="\(currentBundleURL.path)"

        # Wait for host process to quit
        while kill -0 $PID 2>/dev/null; do
            sleep 0.2
        done

        # Atomic replacement
        rm -rf "$TARGET"
        cp -R "$STAGED" "$TARGET"

        # Remove Gatekeeper quarantine flag
        /usr/bin/xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true

        # Relaunch updated application
        /usr/bin/open "$TARGET"

        exit 0
        """

        let scriptPath = FileManager.default.temporaryDirectory.appendingPathComponent("contextos-updater-\(pid).sh")
        do {
            try scriptContent.write(to: scriptPath, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scriptPath.path)

            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/bash")
            process.arguments = [scriptPath.path]
            try process.run()

            // Gracefully terminate current app
            NSApplication.shared.terminate(nil)
        } catch {
            state = .failed(message: "启动更新替换程序失败: \(error.localizedDescription)")
        }
    }

    // MARK: - Local Node.js Environment Detection

    public static func isVersionAtLeast22(_ verString: String) -> Bool {
        var clean = verString.trimmingCharacters(in: .whitespacesAndNewlines)
        if clean.lowercased().hasPrefix("v") {
            clean = String(clean.dropFirst())
        }
        guard let majorStr = clean.split(separator: ".").first,
              let major = Int(majorStr) else {
            return false
        }
        return major >= 22
    }

    public static func detectSystemNodeEnvironment() -> LocalNodeEnvironment {
        let manager = FileManager.default
        let home = manager.homeDirectoryForCurrentUser.path

        // 1. Candidate paths to probe directly (excluding ContextOS.app bundle)
        var candidatePaths = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "\(home)/.nvm/current/bin/node",
            "\(home)/.volta/bin/node",
            "\(home)/.asdf/shims/node",
            "/usr/bin/node"
        ]

        let nvmVersionsDir = "\(home)/.nvm/versions/node"
        if let versions = try? manager.contentsOfDirectory(atPath: nvmVersionsDir) {
            for v in versions.sorted().reversed() {
                let p = "\(nvmVersionsDir)/\(v)/bin/node"
                if !candidatePaths.contains(p) {
                    candidatePaths.append(p)
                }
            }
        }

        for path in candidatePaths {
            if manager.isExecutableFile(atPath: path) {
                if let ver = queryNodeVersion(executablePath: path) {
                    let qualified = isVersionAtLeast22(ver)
                    let msg = qualified ? "Node.js \(ver) (>= 22，环境合格)" : "Node.js \(ver) (低于要求的 22+)"
                    return LocalNodeEnvironment(isQualified: qualified, version: ver, executablePath: path, message: msg)
                }
            }
        }

        // 2. Try login shell to query node -v
        if let shellOutput = runShell("node -v")?.trimmingCharacters(in: .whitespacesAndNewlines),
           shellOutput.hasPrefix("v") {
            let qualified = isVersionAtLeast22(shellOutput)
            let whichPath = runShell("which node")?.trimmingCharacters(in: .whitespacesAndNewlines)
            let msg = qualified ? "Node.js \(shellOutput) (>= 22，环境合格)" : "Node.js \(shellOutput) (低于要求的 22+)"
            return LocalNodeEnvironment(isQualified: qualified, version: shellOutput, executablePath: whichPath, message: msg)
        }

        return LocalNodeEnvironment(isQualified: false, version: nil, executablePath: nil, message: "未检测到本地 Node.js 22+ 环境")
    }

    private static func queryNodeVersion(executablePath: String) -> String? {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: executablePath)
        process.arguments = ["-v"]
        process.standardOutput = pipe
        process.standardError = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            return output.isEmpty ? nil : output
        } catch {
            return nil
        }
    }

    private static func runShell(_ command: String) -> String? {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-l", "-c", command]
        process.standardOutput = pipe
        process.standardError = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            return output.isEmpty ? nil : output
        } catch {
            return nil
        }
    }
}

// MARK: - Download Delegate

private final class DownloadProgressHandler: NSObject, URLSessionDownloadDelegate {
    private let onProgress: (Double, Int64, Int64) -> Void
    private let onCompletion: (URL?, Error?) -> Void

    init(onProgress: @escaping (Double, Int64, Int64) -> Void,
         onCompletion: @escaping (URL?, Error?) -> Void) {
        self.onProgress = onProgress
        self.onCompletion = onCompletion
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        let progress = totalBytesExpectedToWrite > 0
            ? Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)
            : 0.0
        onProgress(progress, totalBytesWritten, totalBytesExpectedToWrite)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        onCompletion(location, nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error {
            onCompletion(nil, error)
        }
    }
}
