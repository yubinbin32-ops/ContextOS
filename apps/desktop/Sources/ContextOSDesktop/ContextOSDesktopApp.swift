import SwiftUI

@main
struct ContextOSDesktopApp: App {
    var body: some Scene {
        WindowGroup("ContextOS") {
            ContentView()
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1320, height: 780)
    }
}
