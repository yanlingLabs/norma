import XCTest
@testable import Norma

/// Regression coverage for review finding I1: `expandToField()` used to guard on
/// `surface == .orb` only, so a re-summon that arrived mid-collapse (`surface` is still
/// `.field` until the morph settles at 0) was silently dropped — a ~200-400ms dead window
/// where tapping the summon shortcut did nothing. v1 handled this as a "retarget": the
/// collapse's implicit completion (gated on `morphTarget == 0` read fresh at settle time,
/// see `OrbWindowController.morphTick()`) is defused simply by flipping `morphTarget` to 1
/// before the spring settles — no teardown ever runs, and the field reopens continuously
/// from wherever the collapse had gotten to.
@MainActor
final class MorphRetargetTests: XCTestCase {
    func testReExpandDuringCollapseRetargetsWithoutTeardown() async throws {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        XCTAssertEqual(controller.surface, .field)

        // Let the expand morph make real progress before reversing it.
        try await pollUntil(timeout: 2.0) { controller.morphProgressForTesting > 0.3 }

        controller.collapseToOrb()
        // IMMEDIATELY re-summon mid-collapse (the dead-window bug: v1 parity requires this
        // to retarget rather than be dropped).
        controller.toggleField()

        // Poll for settle instead of a fixed sleep — the 60Hz morph timer's exact settle
        // time depends on the test host's scheduling, and a fixed sleep either flakes under
        // load or wastes wall-clock time padding for the worst case.
        try await pollUntil(timeout: 2.0) { controller.morphProgressForTesting > 0.9 }

        XCTAssertEqual(controller.surface, .field, "re-expand during collapse was dropped or torn down")
        XCTAssertGreaterThan(controller.morphProgressForTesting, 0.9, "morph did not return to expanded")

        controller.hide()
    }

    /// Polls `condition` on the main actor until it's true or `timeout` elapses, sleeping
    /// briefly between checks. Used instead of a fixed `Task.sleep` for timing-sensitive
    /// assertions against the 60Hz `Timer`-driven morph spring, which is not deterministic
    /// under test-host scheduling load.
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
