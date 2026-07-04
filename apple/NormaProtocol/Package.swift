// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "NormaProtocol",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "NormaProtocol", targets: ["NormaProtocol"]),
    ],
    targets: [
        .target(name: "NormaProtocol"),
        .testTarget(
            name: "NormaProtocolTests",
            dependencies: ["NormaProtocol"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
