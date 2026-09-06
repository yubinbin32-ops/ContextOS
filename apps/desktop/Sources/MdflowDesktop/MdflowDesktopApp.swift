import SwiftUI

@main
struct MdflowDesktopApp: App {
    var body: some Scene {
        WindowGroup("mdflow") {
            ContentView()
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1320, height: 780)
    }
}
