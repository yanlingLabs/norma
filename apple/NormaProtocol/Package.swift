// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "NormaProtocol",
    platforms: [.macOS(.v13), .iOS(.v16)],
    targets: [
        .target(name: "NormaProtocol"),
        .testTarget(
            name: "NormaProtocolTests",
            dependencies: ["NormaProtocol"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
