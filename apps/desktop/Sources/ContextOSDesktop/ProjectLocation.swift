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

    static func resolve(startingAt root: URL) throws -> ProjectLocation {
        var candidate = root.standardizedFileURL

        while candidate.path != "/" {
            let descriptorURL = candidate.appending(path: ".contextos/project.json")
            if FileManager.default.fileExists(atPath: descriptorURL.path) {
                let data = try Data(contentsOf: descriptorURL)
                let descriptor = try JSONDecoder().decode(ProjectDescriptor.self, from: data)
                let dataRoot: URL
                if let override = ProcessInfo.processInfo.environment["CONTEXTOS_DATA_DIR"] {
                    dataRoot = URL(fileURLWithPath: override, isDirectory: true)
                        .appending(path: descriptor.id, directoryHint: .isDirectory)
                } else {
                    dataRoot = candidate.appending(path: ".contextos", directoryHint: .isDirectory)
                }
                let location = ProjectLocation(
                    root: candidate,
                    descriptor: descriptor,
                    database: dataRoot.appending(path: "contextos.sqlite")
                )
                remember(location)
                return location
            }
            candidate.deleteLastPathComponent()
        }
        throw CocoaError(.fileNoSuchFile, userInfo: [
            NSLocalizedDescriptionKey: "No .contextos/project.json found. Open ContextOS from a registered project."
        ])
    }

    static func recentProjects() -> [RecentProject] {
        var projects: [RecentProject] = []
        if let data = UserDefaults.standard.data(forKey: recentProjectsKey),
           let decoded = try? JSONDecoder().decode([RecentProject].self, from: data) {
            projects = decoded
        }
        return projects.filter {
            let root = URL(fileURLWithPath: $0.path)
            return FileManager.default.fileExists(atPath: root.appending(path: ".contextos/project.json").path)
        }
    }

    private static func remember(_ location: ProjectLocation) {
        let current = RecentProject(path: location.root.path, name: location.descriptor.name)
        var projects = recentProjects().filter { $0.path != current.path }
        projects.insert(current, at: 0)
        // Keep the switcher a recent-project affordance, not an ever-growing
        // project registry.  Project data remains on disk and can always be
        // reopened from the file picker.
        if projects.count > 3 { projects.removeLast(projects.count - 3) }
        if let data = try? JSONEncoder().encode(projects) {
            UserDefaults.standard.set(data, forKey: recentProjectsKey)
        }
    }
}
