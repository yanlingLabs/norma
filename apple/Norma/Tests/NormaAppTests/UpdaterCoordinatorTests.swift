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

    // MARK: - Sparkle T4: the idle gate

    func testBusyDaemonPostponesAndIdleInstalls() async {
        var turns = 1
        let c = UpdaterCoordinator(deps: Self.deps(activeTurns: { turns }))
        var installed = 0
        let postponed = c.handleRelaunchRequest(version: "0.2.002", untilInvoking: { installed += 1 })
        XCTAssertTrue(postponed)
        XCTAssertEqual(c.stagedVersion, "0.2.002")
        try? await Task.sleep(for: .seconds(0.05))
        XCTAssertEqual(installed, 0)              // still busy — never yanked
        turns = 0
        try? await Task.sleep(for: .seconds(0.1)) // next poll sees idle
        XCTAssertEqual(installed, 1)
    }

    func testFirstPollTickIsImmediate() async {
        // pollInterval far larger than the test window: only an immediate first check can install.
        let c = UpdaterCoordinator(deps: Self.deps(activeTurns: { 0 }, pollInterval: 1000))
        var installed = 0
        _ = c.handleRelaunchRequest(version: "0.2.002", untilInvoking: { installed += 1 })
        try? await Task.sleep(for: .seconds(0.05))
        XCTAssertEqual(installed, 1)   // fails if the impl waits pollIntervalSeconds before the first check
    }

    func testRestartNowOverridesWhileBusy() async {
        let c = UpdaterCoordinator(deps: Self.deps(activeTurns: { 5 }))
        var installed = 0
        _ = c.handleRelaunchRequest(version: "0.2.002", untilInvoking: { installed += 1 })
        c.installNow()
        XCTAssertEqual(installed, 1)
        c.installNow()                            // idempotent — no double-install
        XCTAssertEqual(installed, 1)
    }

    func testStagedAndBadgeCallbacksFire() async {
        var clock = Date()
        var stagedStates: [Bool] = []
        var badges: [Bool] = []
        let c = UpdaterCoordinator(deps: Self.deps(activeTurns: { 1 }, now: { clock }, badgeAfter: 0.01))
        c.onStagedChange = { staged, _ in stagedStates.append(staged) }
        c.onBadgeChange = { badges.append($0) }
        _ = c.handleRelaunchRequest(version: "0.2.002", untilInvoking: {})
        XCTAssertEqual(stagedStates, [true])
        clock = clock.addingTimeInterval(1)       // "24h" later (scaled by badgeAfter)
        try? await Task.sleep(for: .seconds(0.05))
        XCTAssertTrue(badges.contains(true))
    }
}
