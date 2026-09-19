import AppKit
import Foundation

struct ProjectLocation {
    private static let recentProjectsKey = "contextos.recentProjects"

    let root: URL
    let descriptor: ProjectDescriptor
    let database: URL

    static func resolve() throws -> ProjectLocation {
        let arguments = ProcessInfo.processInfo.arguments
        let explicitRoot: String? = {
            guard let index = arguments.firstIndex(of: "--project"), arguments.indices.contains(index + 1) else {
                return nil
            }
            return arguments[index + 1]
        }()
        if let explicitRoot {
            return try resolve(startingAt: URL(fileURLWithPath: explicitRoot, isDirectory: true))
        }
        if let environmentRoot = ProcessInfo.processInfo.environment["CONTEXTOS_PROJECT_ROOT"] {
            return try resolve(startingAt: URL(fileURLWithPath: environmentRoot, isDirectory: true))
        }
        if let recentRoot = recentProjects().first?.path,
           let recent = try? resolve(startingAt: URL(fileURLWithPath: recentRoot, isDirectory: true)) {
            return recent
        }
        return try resolve(startingAt: URL(
            fileURLWithPath: FileManager.default.currentDirectoryPath,
            isDirectory: true
        ))
    }

    static func isValidProjectRoot(_ root: URL) -> Bool {
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDir), isDir.boolValue else {
            return false
        }
        let dotDir = root.appending(path: ".contextos")
        let descriptorURL = root.appending(path: ".contextos/project.json")
        let graphURL = root.appending(path: ".contextos/graph.json")
        let stateDb = root.appending(path: ".contextos/state.sqlite")
        let legacyDb = root.appending(path: ".contextos/contextos.sqlite")
        let fm = FileManager.default
        return fm.fileExists(atPath: dotDir.path) ||
               fm.fileExists(atPath: descriptorURL.path) ||
               fm.fileExists(atPath: graphURL.path) ||
               fm.fileExists(atPath: stateDb.path) ||
               fm.fileExists(atPath: legacyDb.path)
    }

    static func resolve(startingAt root: URL) throws -> ProjectLocation {
        var candidate = root.standardizedFileURL

        while candidate.path != "/" {
            let descriptorURL = candidate.appending(path: ".contextos/project.json")
            let graphURL = candidate.appending(path: ".contextos/graph.json")
            let stateDbURL = candidate.appending(path: ".contextos/state.sqlite")
            let legacyDbURL = candidate.appending(path: ".contextos/contextos.sqlite")
            let hasDescriptor = FileManager.default.fileExists(atPath: descriptorURL.path)
            let hasGraph = FileManager.default.fileExists(atPath: graphURL.path)
            let hasStateDb = FileManager.default.fileExists(atPath: stateDbURL.path)
            let hasLegacyDb = FileManager.default.fileExists(atPath: legacyDbURL.path)

            if hasDescriptor || hasGraph || hasStateDb || hasLegacyDb {
                let descriptor: ProjectDescriptor
                if hasDescriptor, let data = try? Data(contentsOf: descriptorURL),
                   let decoded = try? JSONDecoder().decode(ProjectDescriptor.self, from: data) {
                    descriptor = decoded
                } else {
                    let projId = candidate.lastPathComponent.lowercased().replacingOccurrences(of: " ", with: "-")
                    let newDescriptor = ProjectDescriptor(id: projId, name: candidate.lastPathComponent, schemaVersion: 2)
                    descriptor = newDescriptor
                    let dotDir = candidate.appending(path: ".contextos")
                    try? FileManager.default.createDirectory(at: dotDir, withIntermediateDirectories: true)
                    if let encoded = try? JSONEncoder().encode(newDescriptor) {
                        try? encoded.write(to: descriptorURL)
                    }
                }

                let dataRoot: URL
                if let override = ProcessInfo.processInfo.environment["CONTEXTOS_DATA_DIR"] {
                    dataRoot = URL(fileURLWithPath: override, isDirectory: true)
                        .appending(path: descriptor.id, directoryHint: .isDirectory)
                } else {
                    dataRoot = candidate.appending(path: ".contextos", directoryHint: .isDirectory)
                }
                let stateDb = dataRoot.appending(path: "state.sqlite")
                let legacyDb = dataRoot.appending(path: "contextos.sqlite")
                let database = FileManager.default.fileExists(atPath: stateDb.path) ? stateDb : legacyDb

                let location = ProjectLocation(
                    root: candidate,
                    descriptor: descriptor,
                    database: database
                )
                remember(location)
                return location
            }
            candidate.deleteLastPathComponent()
        }

        // Auto-initialize project at target directory if opened directly
        let targetRoot = root.standardizedFileURL
        let dotDir = targetRoot.appending(path: ".contextos")
        try? FileManager.default.createDirectory(at: dotDir, withIntermediateDirectories: true)
        let projId = targetRoot.lastPathComponent.lowercased().replacingOccurrences(of: " ", with: "-")
        let descriptor = ProjectDescriptor(id: projId, name: targetRoot.lastPathComponent, schemaVersion: 2)
        let descriptorURL = dotDir.appending(path: "project.json")
        if let encoded = try? JSONEncoder().encode(descriptor) {
            try? encoded.write(to: descriptorURL)
        }
        let stateDb = dotDir.appending(path: "state.sqlite")
        let location = ProjectLocation(
            root: targetRoot,
            descriptor: descriptor,
            database: stateDb
        )
        remember(location)
        return location
    }

    static func recentProjects() -> [RecentProject] {
        var projects: [RecentProject] = []
        if let data = UserDefaults.standard.data(forKey: recentProjectsKey),
           let decoded = try? JSONDecoder().decode([RecentProject].self, from: data) {
            projects = decoded
        }
        return projects.filter {
            let root = URL(fileURLWithPath: $0.path)
            return isValidProjectRoot(root)
        }
    }

    static func forget(path: String) {
        let projects = recentProjects().filter { $0.path != path }
        if let data = try? JSONEncoder().encode(projects) {
            UserDefaults.standard.set(data, forKey: recentProjectsKey)
            UserDefaults.standard.synchronize()
        }
    }

    static func clearAll() {
        UserDefaults.standard.removeObject(forKey: recentProjectsKey)
        UserDefaults.standard.synchronize()
    }

    static var activeLocale: String {
        UserDefaults.standard.string(forKey: "contextos.language") ?? (Locale.current.language.languageCode?.identifier == "zh" ? "zh-Hans" : "en")
    }

    private static func remember(_ location: ProjectLocation) {
        let current = RecentProject(path: location.root.path, name: location.descriptor.name)
        var projects = recentProjects().filter { $0.path != current.path }
        projects.insert(current, at: 0)
        // Keep the switcher a recent-project affordance, not an ever-growing
        // project registry.  Project data remains on disk and can always be
        // reopened from the file picker.
        if projects.count > 10 { projects.removeLast(projects.count - 10) }
        if let data = try? JSONEncoder().encode(projects) {
            UserDefaults.standard.set(data, forKey: recentProjectsKey)
            UserDefaults.standard.synchronize()
        }
        DispatchQueue.main.async {
            NSDocumentController.shared.noteNewRecentDocumentURL(location.root)
        }
    }
}
