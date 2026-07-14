import XCTest
@testable import Norma

/// Sparkle T3: `UpdaterCoordinator`'s injectable deps seam (`DaemonSupervisorDeps` precedent —
/// see `DaemonSupervisorTests.swift`). Only the feed-override resolution is exercised here; T4
/// fills the idle gate, T5 fills channels.
@MainActor
final class UpdaterCoordinatorTests: XCTestCase {
    static func deps(
        activeTurns: @escaping () async -> Int? = { 0 },
        readChannel: @escaping () -> String? = { nil },
        feedOverride: @escaping () -> String? = { nil },
        now: @escaping () -> Date = { Date() },
        pollInterval: TimeInterval = 0.01,
        badgeAfter: TimeInterval = 0.05
    ) -> UpdaterCoordinatorDeps {
        .init(activeTurns: activeTurns, readChannel: readChannel, feedOverride: feedOverride,
              now: now, pollIntervalSeconds: pollInterval, badgeAfterSeconds: badgeAfter)
    }

    func testFeedOverrideWinsWhenSet() {
        let c = UpdaterCoordinator(deps: Self.deps(feedOverride: { "http://localhost:9999/appcast.xml" }))
        XCTAssertEqual(c.resolvedFeedOverride(), "http://localhost:9999/appcast.xml")
    }

    func testNoOverrideFallsBackToInfoPlist() {
        let c = UpdaterCoordinator(deps: Self.deps(feedOverride: { nil }))
        XCTAssertNil(c.resolvedFeedOverride()) // nil → Sparkle uses Info.plist SUFeedURL
    }
}
