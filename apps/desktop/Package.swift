// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "contextos-desktop",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "contextos-desktop", targets: ["ContextOSDesktop"])
    ],
    targets: [
        .systemLibrary(name: "CSQLite"),
        .executableTarget(
            name: "ContextOSDesktop",
            dependencies: ["CSQLite"]
        ),
    ]
)
