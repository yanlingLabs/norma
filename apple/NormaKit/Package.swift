// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "NormaKit",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "NormaKit", targets: ["NormaKit"]),
    ],
    dependencies: [
        .package(path: "../NormaProtocol"),
    ],
    targets: [
        .target(name: "NormaKit", dependencies: ["NormaProtocol"]),
        .testTarget(name: "NormaKitTests", dependencies: ["NormaKit"]),
    ]
)
