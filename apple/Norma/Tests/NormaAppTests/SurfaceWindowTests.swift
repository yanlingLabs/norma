import AppKit
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

/// Gate r7 (moved from the deleted ChatWindowControllerTests): the window Esc routing — 53 (Esc)
/// interrupts a running turn (window stays), else collapses; every other key passes through.
final class WindowEscActionTests: XCTestCase {
    func testNonEscPassesThrough() {
        XCTAssertNil(windowEscAction(keyCode: 36) { true })   // Return
        XCTAssertNil(windowEscAction(keyCode: 0) { false })   // 'a'
    }
    func testEscInterruptsWhenTurnRunning() {
        XCTAssertEqual(windowEscAction(keyCode: 53) { true }, .interrupt)
    }
    func testEscClosesWhenIdle() {
        XCTAssertEqual(windowEscAction(keyCode: 53) { false }, .close)
    }
}

/// Gate r7 (ARCHITECTURE PIVOT): the window is a THIRD morph target of the ORB PANEL ITSELF — no
/// separate panel. These drive the real field→window present + window→orb collapse on one panel.
@MainActor
final class SurfaceWindowTests: XCTestCase {
    func testEnterWindowModeOnlyFromField() {
        let controller = OrbWindowController(session: SessionModel())
        controller.enterWindowMode() // surface == .orb → illegal, no-op
        XCTAssertEqual(controller.surface, .orb)
        XCTAssertEqual(controller.morphModel.renderSurface, .field)
        XCTAssertNil(controller.morphModel.windowFinalRect)
    }

    func testEnterWindowModeFromWindowIsNoOp() {
        let controller = OrbWindowController(session: SessionModel())
        controller.setSurfaceForTesting(.window)
        controller.enterWindowMode()
        XCTAssertEqual(controller.surface, .window)
    }

    /// Full round-trip on ONE panel (consolidated to keep the suite's 60Hz-timer load down): the
    /// field reverse-morphs toward the orb (must NOT flip to `.window` synchronously), the window
    /// presents on the SAME panel (`isVisible` stays true — never ordered out), then collapses back
    /// to the ORB (v1 parity — never to the field) with the window layout cleared.
    func testFieldToWindowRoundTripOnSamePanel() async throws {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        try await pollUntil(timeout: 5.0) { controller.morphProgressForTesting > 0.9 }

        // Present leg.
        controller.enterWindowMode()
        XCTAssertEqual(controller.surface, .field, "must not flip to .window synchronously — the field morphs back to the orb first")
        XCTAssertEqual(controller.morphModel.renderSurface, .field)

        try await pollUntil(timeout: 5.0) { controller.surface == .window }
        XCTAssertEqual(controller.morphModel.renderSurface, .window, "the window branch must render")
        XCTAssertNotNil(controller.morphModel.windowFinalRect, "layout must be computed at present")
        XCTAssertNotNil(controller.morphModel.windowOrbPoint)
        XCTAssertTrue(controller.isVisible, "the SAME panel stays visible — never ordered out (no separate window)")

        // Collapse leg.
        controller.collapseWindowToOrb()
        try await pollUntil(timeout: 5.0) { controller.surface == .orb }
        XCTAssertEqual(controller.morphModel.renderSurface, .field, "back to the field render branch")
        XCTAssertNil(controller.morphModel.windowFinalRect, "window layout cleared")
        XCTAssertNil(controller.morphModel.windowOrbPoint)
        XCTAssertTrue(controller.isVisible, "the orb panel is still visible after collapse")
        XCTAssertEqual(controller.morphModel.activeWindowSize, controller.morphModel.collapsedWindowSize)

        controller.hide()
    }

    /// A re-summon (`expandToField()`) mid-handoff, before the reverse-morph reaches ≤0.08, cancels
    /// the pending window present — the surface must never reach `.window`.
    func testRetargetDuringHandoffCancelsWindowPresent() async throws {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        try await pollUntil(timeout: 5.0) { controller.morphProgressForTesting > 0.9 }

        controller.enterWindowMode()
        XCTAssertEqual(controller.surface, .field)
        // Re-summon immediately — progress is still >0.9, nowhere near 0.08, so the retarget's
        // `pendingWindowExpand = false` always beats the present.
        controller.expandToField()
        try await pollUntil(timeout: 5.0) { controller.morphProgressForTesting > 0.9 }

        XCTAssertEqual(controller.surface, .field, "retarget wins — never presents the window")
        XCTAssertNil(controller.morphModel.windowFinalRect, "present would have set this")

        controller.hide()
    }

    /// `hide()` while the field is mid-handoff cancels the pending window present outright.
    func testHideDuringHandoffCancelsWindowPresent() {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        controller.enterWindowMode() // arms the latch, starts the reverse-morph

        controller.hide()

        XCTAssertEqual(controller.surface, .orb, "hide()'s force-finish always lands on .orb")
        XCTAssertFalse(controller.isVisible)
        XCTAssertEqual(controller.morphModel.renderSurface, .field)
        XCTAssertNil(controller.morphModel.windowFinalRect)
    }

    /// `hide()` while the WINDOW is open snap-collapses it to the orb, then hides — no orphaned
    /// monitors/mouse-gate behind a hidden panel.
    func testHideWhileWindowOpenCollapsesThenHides() async throws {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        try await pollUntil(timeout: 5.0) { controller.morphProgressForTesting > 0.9 }
        controller.enterWindowMode()
        try await pollUntil(timeout: 5.0) { controller.surface == .window }

        controller.hide()
        XCTAssertEqual(controller.surface, .orb)
        XCTAssertFalse(controller.isVisible)
        XCTAssertEqual(controller.morphModel.renderSurface, .field)
    }

    /// Green zoom toggle: grows the window to near-fullscreen content, then restores.
    func testZoomToggleGrowsThenRestores() async throws {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        try await pollUntil(timeout: 5.0) { controller.morphProgressForTesting > 0.9 }
        controller.enterWindowMode()
        try await pollUntil(timeout: 5.0) { controller.surface == .window }
        // Let the window's own 0→1 morph fully settle (`morphTimer == nil`) — zoom no-ops mid-morph.
        try await pollUntil(timeout: 5.0) { controller.surface == .window && controller.isMorphIdleForTesting }

        let normal = controller.morphModel.activeWindowSize
        controller.zoomToggleWindow()
        XCTAssertTrue(controller.windowZoomed, "first press zooms")
        XCTAssertGreaterThanOrEqual(controller.morphModel.activeWindowSize.width, normal.width)

        controller.zoomToggleWindow()
        XCTAssertFalse(controller.windowZoomed, "second press restores")

        controller.hide()
    }

    /// Gate r8 (v1 follow-collapse parity): DURING a window collapse, the panel already rides
    /// toward the live cursor each tick — it must NOT stay frozen at the locked open anchor until
    /// settle (that was the r7 "stationary collapse" conscious simplification this fixes). Drives
    /// the collapse with `glassAnchorOverrideForTesting` set (the real cursor tracker reads the live
    /// OS mouse position, which this suite can't deterministically move) and samples the panel
    /// MID-collapse (surface still `.window`, progress not yet settled) to assert it has already
    /// converged toward the overridden anchor.
    func testWindowCollapseRidesTowardChangedCursorMidCollapse() async throws {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        try await pollUntil(timeout: 5.0) { controller.morphProgressForTesting > 0.9 }
        controller.enterWindowMode()
        try await pollUntil(timeout: 5.0) { controller.surface == .window && controller.isMorphIdleForTesting }

        let screen = try XCTUnwrap(NSScreen.main).visibleFrame
        let target = CGPoint(x: screen.midX + 250, y: screen.midY - 120)
        controller.glassAnchorOverrideForTesting = target

        controller.collapseWindowToOrb()
        try await pollUntil(timeout: 5.0) { controller.morphProgressForTesting < 0.9 }
        XCTAssertEqual(controller.surface, .window, "still mid-collapse, not settled yet")
        // FINAL-REVIEW FIX: deliberately NO panel-frame-origin assertion here. For an anchor
        // INTERIOR to the padded content frame, `windowFrame = paddedContentFrame.union(orbFrame)`
        // is the content frame both before and after the ride — the panel origin legitimately
        // never moves. The ride's real contract is that the SHELL's orb anchor (`windowOrbPoint`
        // resolved against the frame) converges on the fenced cursor mid-collapse, asserted below
        // against the deterministic override. (The removed assertion was also machine-dependent:
        // the open anchor derives from the live mouse position at present time.)

        let orbPoint = try XCTUnwrap(controller.morphModel.windowOrbPoint, "must stay live mid-collapse")
        let frame = controller.panelFrameForTesting
        let midAnchor = CGPoint(x: frame.minX + orbPoint.x, y: frame.maxY - orbPoint.y)
        let expected = fenceAnchorForWindowCollapse(
            target, orbBubbleSize: controller.morphModel.orbBubbleSize,
            haloPadding: controller.morphModel.haloPadding, visibleFrame: screen
        )
        XCTAssertEqual(midAnchor.x, expected.x, accuracy: 1.0, "the shell's orb end must already be converging on the cursor mid-collapse")
        XCTAssertEqual(midAnchor.y, expected.y, accuracy: 1.0)

        try await pollUntil(timeout: 5.0) { controller.surface == .orb }
        controller.hide()
    }

    /// Gate r8 regression: once the collapse SETTLES, the orb lands at (near) wherever the ride
    /// converged to — NOT the stale locked-open anchor the r7 "stationary collapse" simplification
    /// used to melt to before the follower sprang it the rest of the way. `currentGlassAnchorForTesting`
    /// reads the settled orb's own composer-corner anchor (mapped through `collapsedWindowSize`).
    func testWindowCollapseSettlesAtRiddenAnchorNotStaleOpenAnchor() async throws {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        try await pollUntil(timeout: 5.0) { controller.morphProgressForTesting > 0.9 }
        controller.enterWindowMode()
        try await pollUntil(timeout: 5.0) { controller.surface == .window && controller.isMorphIdleForTesting }

        let screen = try XCTUnwrap(NSScreen.main).visibleFrame
        let openFrame = controller.panelFrameForTesting
        let openOrbPoint = try XCTUnwrap(controller.morphModel.windowOrbPoint)
        let openAnchor = CGPoint(x: openFrame.minX + openOrbPoint.x, y: openFrame.maxY - openOrbPoint.y)

        let target = CGPoint(x: screen.midX + 220, y: screen.midY + 90)
        XCTAssertGreaterThan(
            hypot(target.x - openAnchor.x, target.y - openAnchor.y), 50,
            "the test target must actually differ from the open anchor for this regression to mean anything"
        )
        controller.glassAnchorOverrideForTesting = target

        controller.collapseWindowToOrb()
        try await pollUntil(timeout: 5.0) { controller.surface == .orb }

        let settledAnchor = controller.currentGlassAnchorForTesting
        let expected = fenceAnchorForWindowCollapse(
            target, orbBubbleSize: controller.morphModel.orbBubbleSize,
            haloPadding: controller.morphModel.haloPadding, visibleFrame: screen
        )
        XCTAssertEqual(settledAnchor.x, expected.x, accuracy: 2.0, "the settled orb must land where the ride converged, not the stale open anchor")
        XCTAssertEqual(settledAnchor.y, expected.y, accuracy: 2.0)
        XCTAssertGreaterThan(
            hypot(settledAnchor.x - openAnchor.x, settledAnchor.y - openAnchor.y), 50,
            "must have actually moved away from the stale open anchor, not melted in place"
        )

        controller.hide()
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
