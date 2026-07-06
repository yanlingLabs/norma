import XCTest
@testable import Norma

final class WindowEscActionTests: XCTestCase {
    func testNonEscPassesThrough() {
        XCTAssertNil(windowEscAction(keyCode: 36) { true })
    }
    func testEscWithRunningTurnInterrupts() {
        XCTAssertEqual(windowEscAction(keyCode: 53) { true }, .interrupt)
    }
    func testEscIdleCloses() {
        XCTAssertEqual(windowEscAction(keyCode: 53) { false }, .close)
    }
}

@MainActor
final class ChatWindowControllerTests: XCTestCase {
    private func makeController() -> ChatWindowController {
        let session = SessionModel()
        return ChatWindowController(session: session, adapter: FieldStateAdapter(session: session))
    }

    /// Polls until the panel's frame stops changing between ticks — the spring has settled
    /// (mirrors `testGrowSettlesToTargetFrame`'s own original inline loop, extracted so the new
    /// gate-r3 tests below can reuse it to let a GROW settle before starting a shrink).
    private func waitUntilFrameStable(_ c: ChatWindowController) async throws {
        var lastSize: NSSize = .zero
        var stableTicks = 0
        let deadline = Date().addingTimeInterval(3.0)
        while stableTicks < 3, Date() < deadline {
            try await Task.sleep(nanoseconds: 20_000_000)
            let size = c.panel?.frame.size ?? .zero
            if size == lastSize {
                stableTicks += 1
            } else {
                stableTicks = 0
                lastSize = size
            }
        }
    }

    /// Polls until `closeAnimated()`'s shrink settles and its teardown fires — asynchronous,
    /// unlike `close()`.
    private func waitUntilClosed(_ c: ChatWindowController) async throws {
        let deadline = Date().addingTimeInterval(3.0)
        while c.isVisible, Date() < deadline {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    func testShowCreatesPanelCloseDestroysIt() {
        let c = makeController()
        XCTAssertFalse(c.isVisible)
        c.show(from: NSRect(x: 400, y: 400, width: 240, height: 44))
        XCTAssertTrue(c.isVisible)
        c.close()
        XCTAssertFalse(c.isVisible) // D9: panel == nil when closed
    }

    func testOnCloseFiresExactlyOnce() {
        let c = makeController()
        var fired = 0
        c.onClose = { fired += 1 }
        c.show(from: NSRect(x: 400, y: 400, width: 240, height: 44))
        c.close()
        c.close() // second close is a no-op
        XCTAssertEqual(fired, 1)
    }

    func testUserDragIsRememberedProgrammaticMoveIsNot() {
        let c = makeController()
        c.show(from: NSRect(x: 400, y: 400, width: 240, height: 44))
        XCTAssertNil(c.rememberedFrame, "programmatic show/animate must not set the memory")
        c.noteUserMovedWindowForTesting(to: NSRect(x: 50, y: 60, width: 560, height: 640))
        XCTAssertEqual(c.rememberedFrame?.origin, NSPoint(x: 50, y: 60))
        c.close()
    }

    /// Gate fix (F1 — expand choreography): the grow's source is the collapsed orb's own tiny
    /// panel frame (`OrbWindowController.finishCollapse()`, ~240×140 in production — smaller than
    /// the chat window's own 340×360 floor in BOTH dimensions). The very FIRST `setFrame` of the
    /// grow (synchronous, before the 60Hz grow timer's first tick) must actually apply that small
    /// size, not get force-inflated to OUR OWN 340×360 floor by `clampedChatWindowFrame` — this
    /// pins the sanitizer-bypass-during-grow fix.
    ///
    /// Gate r4 (fully self-drawn window): the window is now BORDERLESS — there is NO AppKit chrome
    /// minimum anymore, so BOTH dimensions start at the raw orb size (r3's "height gets chrome-
    /// floored above the source" no longer happens). This is the cleaner "grows from something
    /// small" the whole choreography wanted.
    func testGrowStartsFromFullOrbSizedFrame() {
        let c = makeController()
        let orbFrame = NSRect(origin: NSPoint(x: 400, y: 400), size: chatWindowCollapsedSize) // 240×140
        c.show(from: orbFrame)
        let size = c.panel?.frame.size ?? .zero
        XCTAssertEqual(size.width, chatWindowCollapsedSize.width, accuracy: 0.5, "width starts orb-small — no chrome minimum")
        XCTAssertEqual(size.height, chatWindowCollapsedSize.height, accuracy: 0.5, "gate r4: borderless has no chrome minimum, so height starts orb-small too")
        c.close()
    }

    /// Gate r4 (fully self-drawn window): the panel is borderless for life —
    /// `[.borderless, .nonactivatingPanel, .resizable]`, NO `.titled`/toolbar. The resize floor is
    /// still enforced by our own `frameSanitizer` (`ChatWindowPanel.setFrame`'s override),
    /// asserted directly by attempting a tiny `setFrame` once settled (`isAnimatingFrame` false)
    /// and checking it clamps back up to 340×360. (Without a toolbar, AppKit no longer overrides
    /// `contentMinSize`, but the sanitizer floor is the real guarantee and is what's pinned here.)
    func testPanelHasBorderlessResizableStyleMaskAndSanitizerFloor() async throws {
        let c = makeController()
        c.show(from: NSRect(x: 400, y: 400, width: 240, height: 44))
        let styleMask = c.panel?.styleMask ?? []
        XCTAssertTrue(styleMask.contains(.nonactivatingPanel))
        XCTAssertTrue(styleMask.contains(.resizable))
        XCTAssertFalse(styleMask.contains(.titled), "gate r4: no native titlebar — traffic lights are self-drawn")
        // `.borderless` is rawValue 0, so `.contains` is not meaningful; assert the titled bit is
        // absent (above) as the real "is it borderless chrome" signal.

        try await waitUntilFrameStable(c) // let the grow settle — isAnimatingFrame goes false
        c.panel?.setFrame(NSRect(x: 0, y: 0, width: 50, height: 50), display: false)
        XCTAssertEqual(c.panel?.frame.size, NSSize(width: 340, height: 360),
                       "our own sanitizer must still floor a USER resize at 340×360 once settled")
        c.close()
    }

    /// Fix D (anim-fidelity restore): the grow is now spring-driven (`morphStep` at 140/18)
    /// rather than a fixed 0.30s duration — settle-based, not duration-based. Polls until the
    /// panel's frame stops changing between ticks (the spring has settled and `frameAnimTick()`'s
    /// own guard snapped it exactly to `frameAnimTarget`), then asserts it landed on the expected
    /// target size (mirrors `ChatWindowLayoutTests.testFirstExpandCentersDefaultSizeOnSource`'s
    /// own expectation for a fresh controller with no remembered frame) — proving the settle guard
    /// actually fires and the spring neither runs forever nor stops short of the real target.
    func testGrowSettlesToTargetFrame() async throws {
        let c = makeController()
        let source = NSRect(x: 400, y: 400, width: 240, height: 44)
        c.show(from: source)

        try await waitUntilFrameStable(c)

        XCTAssertEqual(
            c.panel?.frame.size, chatWindowDefaultSize,
            "the settled grow must land exactly on the target size, not merely close to it"
        )
        c.close()
    }

    /// Gate fix (F2), re-routed by gate r3 (W1): the native red close button (`windowShouldClose`)
    /// must route through our own teardown exactly once — never double-firing `onClose` even if
    /// something else raced a close in first. Now asynchronous (`closeAnimated()` shrinks to the
    /// cursor before running `close()`'s teardown), so this pumps the runloop rather than
    /// asserting synchronously.
    func testWindowShouldCloseRoutesThroughTeardownExactlyOnce() async throws {
        let c = makeController()
        var fired = 0
        c.onClose = { fired += 1 }
        c.show(from: NSRect(x: 400, y: 400, width: 240, height: 44))
        let panel = c.panel
        let shouldClose = c.windowShouldClose(panel!)
        XCTAssertFalse(shouldClose, "we tore the window down ourselves — AppKit must not also run its own close")

        try await waitUntilClosed(c)

        XCTAssertEqual(fired, 1)
        XCTAssertFalse(c.isVisible)
        // A second windowShouldClose (or a stray real close) must not double-fire onClose.
        _ = c.windowShouldClose(panel!)
        XCTAssertEqual(fired, 1)
    }

    // MARK: Gate r3 — W1 (animated close)

    /// `closeAnimated()` spring-shrinks the panel toward the cursor, THEN runs the same
    /// teardown `close()` always has — asynchronous, so `onClose` fires (and the panel nils)
    /// only once the shrink settles, not synchronously.
    func testCloseAnimatedEventuallyFiresOnCloseAndNilsPanel() async throws {
        let c = makeController()
        var fired = 0
        c.onClose = { fired += 1 }
        c.show(from: NSRect(x: 400, y: 400, width: 240, height: 44))
        try await waitUntilFrameStable(c) // let the grow settle first
        XCTAssertTrue(c.isVisible)

        c.closeAnimated()
        try await waitUntilClosed(c)

        XCTAssertFalse(c.isVisible, "D9: panel == nil once the shrink settles and close()'s teardown runs")
        XCTAssertEqual(fired, 1)
    }

    /// A plain `close()` racing an in-flight `closeAnimated()` shrink must win immediately
    /// (its synchronous contract is preserved) without the shrink's own later settle tick
    /// double-firing `onClose` once it discovers the panel is already gone.
    func testCloseDuringShrinkDoesNotDoubleFireOnClose() async throws {
        let c = makeController()
        var fired = 0
        c.onClose = { fired += 1 }
        c.show(from: NSRect(x: 400, y: 400, width: 240, height: 44))
        try await waitUntilFrameStable(c)

        c.closeAnimated() // starts the shrink's 60Hz timer
        c.close() // instant teardown races ahead of the shrink's own settle

        XCTAssertFalse(c.isVisible)
        XCTAssertEqual(fired, 1)

        // Let any already-in-flight timer ticks land — frameAnimTick()'s own panel/timer guards
        // must keep this from resurrecting a second onClose.
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(fired, 1)
    }

    /// `closeAnimated()` called the INSTANT after `show()` — while the grow is still mid-flight,
    /// before its spring has even had a chance to tick — must retarget into a shrink without
    /// crashing: the grow's timer state is cancelled WITHOUT jumping the frame, and the shrink
    /// starts from wherever the frame actually was.
    func testCloseAnimatedMidGrowRetargetsWithoutCrashing() async throws {
        let c = makeController()
        var fired = 0
        c.onClose = { fired += 1 }
        c.show(from: NSRect(x: 400, y: 400, width: 240, height: 44))
        c.closeAnimated() // fires while the grow is still mid-flight

        try await waitUntilClosed(c)

        XCTAssertFalse(c.isVisible)
        XCTAssertEqual(fired, 1)
    }

    // MARK: Gate r4 — fully self-drawn window (borderless always, custom traffic lights, manual zoom)

    /// Hypothesis 2 (the mystery post-stall "fade"): titled windows default to `.documentWindow`
    /// animation behavior, which adds a SYSTEM fade on `orderOut()`. `animationBehavior = .none` at
    /// construction kills it for every close path (borderless keeps this too).
    func testPanelAnimationBehaviorIsNoneToSuppressSystemFade() {
        let c = makeController()
        c.show(from: NSRect(x: 400, y: 400, width: 240, height: 44))
        XCTAssertEqual(c.panel?.animationBehavior, NSWindow.AnimationBehavior.none,
                       "system orderOut fade must be suppressed — our spring is the only motion language")
        c.close()
    }

    /// Gate r5 (window melts into the orb): the close-shrink must reach the VISIBLE orb-BUBBLE-sized
    /// square (`chatWindowOrbBubbleDiameter`, ~20×20) — NOT the 240×140 collapsed PANEL it used to
    /// target (the r5 defect: shrinking to a 240×140 opaque tinted slab read as "a big square" that
    /// then blinked away). Captured via `lastShrinkSettledFrameForTesting` — the true on-screen frame
    /// the spring settled on right before teardown.
    func testShrinkReachesOrbBubbleSizedTargetBeforeClose() async throws {
        let c = makeController()
        c.show(from: NSRect(x: 400, y: 400, width: 240, height: 44))
        try await waitUntilFrameStable(c)

        c.closeAnimated()
        try await waitUntilClosed(c)

        let settled = c.lastShrinkSettledFrameForTesting
        XCTAssertNotNil(settled, "the shrink must have settled and recorded its final on-screen frame")
        XCTAssertEqual(settled?.size.width ?? 0, chatWindowOrbBubbleDiameter, accuracy: 2,
                       "the shrink reaches the orb BUBBLE width (~20), not the 240×140 panel")
        XCTAssertEqual(settled?.size.height ?? 0, chatWindowOrbBubbleDiameter, accuracy: 2,
                       "the shrink reaches the orb BUBBLE height (~20) — a small circle, not a big square")
    }

    // MARK: Gate r5 — window melts into the orb (snapshot scaling, radius→circle ramp, early orb handoff)

    /// The moment the shrink starts, the live SwiftUI composer/header is replaced by a bitmap
    /// snapshot (`NSImageView`) that scales cleanly to ~20pt — the real layout can't lay out that
    /// small without clipping/fighting. Asserted synchronously right after `closeAnimated()`, since
    /// the swap happens synchronously at shrink start (before any 60Hz tick).
    func testCloseAnimatedSwapsLiveContentForSnapshot() async throws {
        let c = makeController()
        c.show(from: NSRect(x: 400, y: 400, width: 240, height: 44))
        try await waitUntilFrameStable(c)
        XCTAssertFalse(c.isShowingShrinkSnapshotForTesting, "live SwiftUI content while settled")

        c.closeAnimated()
        XCTAssertTrue(c.isShowingShrinkSnapshotForTesting,
                      "the shrink animates a snapshot bitmap, not the collapsing live composer")

        try await waitUntilClosed(c)
        XCTAssertFalse(c.isVisible)
    }

    /// The orb's return (`onClose`) fires EARLY — when the shrink crosses ~0.7 — NOT at the final
    /// settle, so the orb rematerializes while the last of the dissolving circle melts over it.
    /// `onCloseFiredAtProgressForTesting` records the shrink progress at that fire; it must land in
    /// [handoff, 1.0), i.e. strictly before settle.
    func testOnCloseFiresAtOverlapThresholdBeforeSettle() async throws {
        let c = makeController()
        var fired = 0
        c.onClose = { fired += 1 }
        c.show(from: NSRect(x: 400, y: 400, width: 240, height: 44))
        try await waitUntilFrameStable(c)

        c.closeAnimated()
        try await waitUntilClosed(c)

        XCTAssertEqual(fired, 1, "onClose fires exactly once")
        let firedAt = c.onCloseFiredAtProgressForTesting
        XCTAssertNotNil(firedAt, "onClose fired from the shrink's early handoff crossing, not a synchronous close")
        XCTAssertGreaterThanOrEqual(firedAt ?? 0, chatWindowOrbHandoffProgress)
        XCTAssertLessThan(firedAt ?? 1, 1.0, "the orb handoff must precede the final settle (progress < 1)")
    }

    /// The snapshot's corner radius ramps from the window's 16pt to a full circle (≈ half the
    /// ~20pt orb-bubble frame) by settle — the "converges to something that looks like the orb"
    /// half of the choreography. Read via the melt seam captured on the last tick.
    func testShrinkCornerRadiusRampsToCircleAtSettle() async throws {
        let c = makeController()
        c.show(from: NSRect(x: 400, y: 400, width: 240, height: 44))
        try await waitUntilFrameStable(c)

        c.closeAnimated()
        try await waitUntilClosed(c)

        XCTAssertEqual(c.lastShrinkCornerRadiusForTesting, chatWindowOrbBubbleDiameter / 2, accuracy: 1.5,
                       "by settle the corner radius is ≈ half the orb-bubble size — a circle")
    }

    /// The custom GREEN traffic light drives `zoomToggle()` (a borderless window has no native
    /// zoom): first press fills the screen's visible frame (inset a touch), second press restores
    /// the pre-zoom frame. Runs after the grow settles so no animation is in flight.
    func testZoomToggleMaximizesThenRestores() async throws {
        let c = makeController()
        c.show(from: NSRect(x: 400, y: 400, width: 240, height: 44))
        try await waitUntilFrameStable(c)
        let settled = c.panel?.frame ?? .zero
        let visible = (NSScreen.screens.first { $0.frame.intersects(settled) } ?? NSScreen.main)?.visibleFrame ?? .zero

        c.zoomToggle() // → fill screen
        let zoomed = c.panel?.frame ?? .zero
        XCTAssertEqual(zoomed.size.width, visible.width - 2 * chatWindowZoomInset, accuracy: 1, "zoom fills the visible width (inset)")
        XCTAssertGreaterThan(zoomed.size.height, settled.height, "zoom grew the window toward the screen")

        c.zoomToggle() // → restore
        let restored = c.panel?.frame ?? .zero
        XCTAssertEqual(restored.size.width, settled.width, accuracy: 1, "second press restores the pre-zoom size")
        XCTAssertEqual(restored.size.height, settled.height, accuracy: 1, "second press restores the pre-zoom size")
        c.close()
    }
}
