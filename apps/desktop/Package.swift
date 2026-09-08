// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "mdflow-desktop",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "mdflow-desktop", targets: ["MdflowDesktop"])
    ],
    targets: [
        .systemLibrary(name: "CSQLite"),
        .executableTarget(
            name: "MdflowDesktop",
            dependencies: ["CSQLite"]
        ),
    ]
)
