// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "NormaKit",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "NormaKit", targets: ["NormaKit"]),
        .executable(name: "norma-probe", targets: ["norma-probe"]),
    ],
    dependencies: [
        .package(path: "../NormaProtocol"),
    ],
    targets: [
        .target(name: "NormaKit", dependencies: ["NormaProtocol"]),
        .executableTarget(name: "norma-probe", dependencies: ["NormaKit", "NormaProtocol"]),
        .testTarget(name: "NormaKitTests", dependencies: ["NormaKit"]),
    ]
)
