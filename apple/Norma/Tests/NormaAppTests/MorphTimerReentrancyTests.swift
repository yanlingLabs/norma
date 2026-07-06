import XCTest
@testable import Norma

/// Gate-fix regression (Esc-interrupt live-gate finding): `OrbWindowController`'s 60Hz morph
/// timer schedules each tick via `Task { @MainActor in self?.morphTick() }` rather than running
/// synchronously. Reproduced live during this gate's repro session (rapid, overlapping
/// summon/collapse triggers backed up the main actor): once free, SEVEN queued `Task` closures
/// all ran in a burst, and — with no re-entry guard — each one independently re-satisfied
/// `morphTick()`'s settle condition and redundantly re-ran the entire teardown branch, calling
/// `finishCollapse()` seven times for a single collapse (confirmed via `OrbDebug` logging; see
/// the gate report).
///
/// This locks in the fix: a stale/duplicate tick that fires after the real settle (i.e. after
/// `cancelMorphTimer()` has already nilled `morphTimer` out) must be a no-op.
@MainActor
final class MorphTimerReentrancyTests: XCTestCase {
    func testStaleMorphTickAfterSettleDoesNotRerunFinishCollapse() async throws {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        try await pollUntil(timeout: 2.0) { controller.morphProgressForTesting > 0.9 }

        controller.collapseToOrb()
        try await pollUntil(timeout: 2.0) { controller.surface == .orb }
        XCTAssertEqual(controller.finishCollapseCallCountForTesting, 1, "the real settle must run finishCollapse() exactly once")

        // Simulate the backlogged-Task scenario directly: the real timer already invalidated
        // itself (morphTimer == nil) by the time these fire, exactly like the queued closures
        // that arrived after the burst in the live repro.
        controller.morphTick()
        controller.morphTick()
        controller.morphTick()

        XCTAssertEqual(
            controller.finishCollapseCallCountForTesting, 1,
            "a stale tick after settle must not re-run finishCollapse() — it silently repeats the collapse teardown otherwise"
        )

        controller.hide()
    }

    /// Same polling helper as `MorphRetargetTests` — the 60Hz morph timer's settle time isn't
    /// deterministic under test-host scheduling load, so poll instead of a fixed sleep.
    private func pollUntil(
        timeout: TimeInterval,
        interval: TimeInterval = 0.02,
        _ condition: () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            try await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
        }
    }
}
