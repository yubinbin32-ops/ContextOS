import SwiftUI

@main
struct ContextOSDesktopApp: App {
    var body: some Scene {
        WindowGroup("ContextOS") {
            ContentView()
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1320, height: 780)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button(ProjectLocation.activeLocale == "zh-Hans" ? "打开项目…" : "Open Project…") {
                    NotificationCenter.default.post(name: Notification.Name("ChooseProject"), object: nil)
                }
                .keyboardShortcut("o", modifiers: .command)

                Menu(ProjectLocation.activeLocale == "zh-Hans" ? "打开最近项目" : "Open Recent") {
                    ForEach(ProjectLocation.recentProjects()) { project in
                        Button(project.name) {
                            NotificationCenter.default.post(
                                name: Notification.Name("OpenSpecificProject"),
                                object: nil,
                                userInfo: ["path": project.path]
                            )
                        }
                    }
                    if !ProjectLocation.recentProjects().isEmpty {
                        Divider()
                        Button(ProjectLocation.activeLocale == "zh-Hans" ? "清空最近项目记录" : "Clear Recents") {
                            ProjectLocation.clearAll()
                            NotificationCenter.default.post(name: Notification.Name("RecentProjectsChanged"), object: nil)
                        }
                    }
                }
            }
        }
    }
}
