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

    /// Gate fix (F1 — expand choreography): `enterWindowMode()` must NOT fire
    /// `onExpandToWindow` synchronously — the field has to visibly morph back into the orb
    /// FIRST (the ordinary `collapseToOrb()` spring), and only once that morph settles does the
    /// handoff actually fire, carrying the NOW-COLLAPSED orb's small frame (not the field's old
    /// expanded frame).
    func testEnterWindowModeMorphsThenExpandsWithCollapsedOrbFrame() async throws {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        try await pollUntil(timeout: 2.0) { controller.morphProgressForTesting > 0.9 }

        var expandedFrames: [NSRect] = []
        controller.onExpandToWindow = { expandedFrames.append($0) }
        controller.enterWindowMode()

        XCTAssertTrue(expandedFrames.isEmpty, "must not fire before the collapse morph settles")
        XCTAssertEqual(controller.surface, .field, "surface stays .field until the morph settles")

        try await pollUntil(timeout: 2.0) { controller.surface == .window }
        XCTAssertEqual(expandedFrames.count, 1, "onExpandToWindow must fire exactly once")
        XCTAssertEqual(
            expandedFrames[0].size, controller.morphModel.collapsedWindowSize,
            "the grow's source frame must be the COLLAPSED orb, not the field's expanded frame"
        )
    }

    /// Gate fix (F1): a re-summon mid-handoff (the user reopens the field before it finishes
    /// morphing back into the orb) must cancel the pending window expansion — `onExpandToWindow`
    /// must never fire for that aborted handoff, and a later, unrelated collapse must not
    /// resurrect it either.
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
