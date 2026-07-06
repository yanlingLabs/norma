import XCTest
@testable import Norma

final class SummonToggleTests: XCTestCase {
    func testTapWithWindowOpenClosesIt() {
        XCTAssertEqual(summonToggleAction(surface: .window, windowVisible: true), .closeWindow)
    }
    func testTapWithoutWindowTogglesField() {
        XCTAssertEqual(summonToggleAction(surface: .orb, windowVisible: false), .toggleField)
        XCTAssertEqual(summonToggleAction(surface: .field, windowVisible: false), .toggleField)
    }
    func testStaleWindowSurfaceWithNoPanelFallsBackToField() {
        // Belt: if surface says .window but the panel is gone, never wedge the summon path.
        XCTAssertEqual(summonToggleAction(surface: .window, windowVisible: false), .toggleField)
    }
}

@MainActor
final class SurfaceWindowTests: XCTestCase {
    func testEnterWindowModeOnlyFromField() {
        let controller = OrbWindowController(session: SessionModel())
        var expanded: NSRect?
        controller.onExpandToWindow = { expanded = $0 }
        controller.enterWindowMode() // surface == .orb → illegal, no-op
        XCTAssertNil(expanded)
        XCTAssertEqual(controller.surface, .orb)
    }

    /// Gate fix (F1): `enterWindowMode()` is legal only from `.field` — from `.window` it must
    /// also be a no-op (the guard doesn't special-case `.orb`).
    func testEnterWindowModeFromWindowIsNoOp() {
        let controller = OrbWindowController(session: SessionModel())
        controller.setSurfaceForTesting(.window)
        var expanded: NSRect?
        controller.onExpandToWindow = { expanded = $0 }
        controller.enterWindowMode()
        XCTAssertNil(expanded)
        XCTAssertEqual(controller.surface, .window)
    }

    func testExitWindowModeRestoresOrb() {
        let controller = OrbWindowController(session: SessionModel())
        controller.setSurfaceForTesting(.window)
        controller.exitWindowMode()
        XCTAssertEqual(controller.surface, .orb)
        XCTAssertTrue(controller.isVisible)
    }

    /// Fix C (anim-fidelity restore — handoff overlap): `enterWindowMode()` must NOT fire
    /// `onExpandToWindow` synchronously — the field has to visibly START morphing back into the
    /// orb FIRST (the ordinary `collapseToOrb()` spring) — but it no longer waits for the morph
    /// to fully SETTLE either: the handoff fires EARLY, the instant progress crosses ≤0.15 on the
    /// way down (v1's own early-fire pattern), carrying a projected "mid-shrink" frame sized to
    /// the COLLAPSED orb (not the field's old expanded frame). The orb's own last sliver of
    /// collapse (0.15 → 0) then finishes underneath the growing chat window.
    func testEnterWindowModeMorphsThenExpandsWithCollapsedOrbFrame() async throws {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        try await pollUntil(timeout: 2.0) { controller.morphProgressForTesting > 0.9 }

        var expandedFrames: [NSRect] = []
        controller.onExpandToWindow = { expandedFrames.append($0) }
        controller.enterWindowMode()

        XCTAssertTrue(expandedFrames.isEmpty, "must not fire synchronously, before the collapse morph even starts ticking")
        XCTAssertEqual(controller.surface, .field, "surface stays .field until progress crosses the ≤0.15 overlap threshold")

        try await pollUntil(timeout: 2.0) { controller.surface == .window }
        XCTAssertEqual(expandedFrames.count, 1, "onExpandToWindow must fire exactly once")
        XCTAssertEqual(
            expandedFrames[0].size, controller.morphModel.collapsedWindowSize,
            "the grow's source frame must be the COLLAPSED orb, not the field's expanded frame"
        )
        // Overlap, not a full settle: `finishCollapse()` (the natural-settle teardown) must not
        // have run yet at the instant the handoff fires and surface flips — proves this fired at
        // the early ≤0.15 crossing, not at the eventual full settle. (Not asserting an exact
        // progress upper bound here: by the time the poll observes `surface == .window`, the
        // 60Hz timer may have already ticked a few times past the crossing — the call-count check
        // is the robust proxy for "still mid-collapse".)
        XCTAssertEqual(
            controller.finishCollapseCallCountForTesting, 0,
            "handoff must overlap the tail of the collapse, not wait for it to fully settle"
        )
    }

    /// Fix C: once the overlapped handoff has fired (surface already `.window`), the orb's own
    /// collapse keeps ticking underneath the growing chat window and eventually settles for real
    /// (`finishCollapseCallCountForTesting` increments) — that natural settle must NOT stomp
    /// `surface` back to `.orb` (the window is the surface of record now) and must still tear the
    /// now-redundant orb panel down (order out, `isVisible == false`) exactly like the pre-overlap
    /// implementation's force-finish did, without re-firing `onExpandToWindow` a second time.
    func testFinishCollapseAfterOverlappedHandoffKeepsWindowSurfaceAndOrdersOrbOut() async throws {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        try await pollUntil(timeout: 2.0) { controller.morphProgressForTesting > 0.9 }

        var expandedFrames: [NSRect] = []
        controller.onExpandToWindow = { expandedFrames.append($0) }
        controller.enterWindowMode()
        try await pollUntil(timeout: 2.0) { controller.surface == .window }
        XCTAssertEqual(expandedFrames.count, 1)

        // Let the orb's remaining sliver of collapse finish naturally.
        try await pollUntil(timeout: 2.0) { controller.finishCollapseCallCountForTesting >= 1 }

        XCTAssertEqual(controller.surface, .window, "the natural settle must not stomp .window back to .orb")
        XCTAssertFalse(controller.isVisible, "the orb panel must be ordered out once the window owns the screen")
        XCTAssertEqual(expandedFrames.count, 1, "the settle must not re-fire onExpandToWindow — the one-shot already fired")
    }

    /// Gate fix (F1), extended for Fix C (handoff overlap): a re-summon mid-handoff (the user
    /// reopens the field before the collapse ever crosses the ≤0.15 overlap threshold) must
    /// cancel the pending window expansion — `onExpandToWindow` must never fire for that aborted
    /// handoff, and a later, unrelated collapse must not resurrect it either. This re-summon
    /// happens synchronously, right after `enterWindowMode()`, with no morph ticks in between —
    /// progress is still wherever the prior expand left it (>0.9), nowhere near 0.15 — so
    /// `expandToField()`'s retarget path (`pendingWindowExpand = false`) always wins the race
    /// against `beginWindowHandoffOverlapped()`.
    func testRetargetDuringHandoffCancelsWindowExpand() async throws {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        try await pollUntil(timeout: 2.0) { controller.morphProgressForTesting > 0.9 }

        var expandedFrames: [NSRect] = []
        controller.onExpandToWindow = { expandedFrames.append($0) }
        controller.enterWindowMode()
        XCTAssertEqual(controller.surface, .field)

        // Re-summon mid-collapse — same retarget path MorphRetargetTests drives, before this
        // handoff's collapse ever settles.
        controller.expandToField()
        try await pollUntil(timeout: 2.0) { controller.morphProgressForTesting > 0.9 }

        XCTAssertEqual(controller.surface, .field, "retarget must win — never left mid-way to .window")
        XCTAssertTrue(expandedFrames.isEmpty, "the aborted handoff must never fire onExpandToWindow")

        // A later, genuinely unrelated collapse must settle as a normal .orb collapse, not
        // resurrect the cancelled handoff.
        controller.collapseToOrb()
        try await pollUntil(timeout: 2.0) { controller.surface == .orb }
        XCTAssertTrue(expandedFrames.isEmpty, "a later unrelated collapse must not resurrect the cancelled handoff")

        controller.hide()
    }

    /// Gate fix (F1): `hide()` cancels a pending handoff too — hiding outright is a stronger
    /// action than a field→window handoff in flight.
    func testHideDuringHandoffCancelsWindowExpand() {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()

        var expandedFrames: [NSRect] = []
        controller.onExpandToWindow = { expandedFrames.append($0) }
        controller.enterWindowMode() // arms pendingWindowExpand, starts the collapse morph

        controller.hide() // force-finishes the collapse synchronously via finishCollapse()

        XCTAssertTrue(expandedFrames.isEmpty, "hide() must cancel the pending handoff, not fulfil it")
        XCTAssertEqual(controller.surface, .orb, "hide()'s own force-finish always lands on .orb")
        XCTAssertFalse(controller.isVisible)
    }

    /// Same polling helper as `MorphTimerReentrancyTests`/`MorphRetargetTests` — the 60Hz morph
    /// timer's settle time isn't deterministic under test-host scheduling load.
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
