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

    /// Gate fix (F1 — expand choreography): the grow's source is now the collapsed orb's own
    /// tiny panel frame (`OrbWindowController.finishCollapse()`, ~240×140 in production —
    /// smaller than the chat window's own 340×360 floor in BOTH dimensions). The very FIRST
    /// `setFrame` of the grow (synchronous, before the 60Hz grow timer's first tick) must
    /// actually apply that small size, not get force-inflated to OUR OWN 340×360 floor by
    /// `clampedChatWindowFrame` — this pins the sanitizer-bypass-during-grow fix.
    ///
    /// Gate r3 (W2 — chrome pop fix): the toolbar is now attached at CONSTRUCTION (not deferred
    /// to the grow's settle), so AppKit's OWN chrome frame minimum binds on this very first frame
    /// too — a floor `isAnimatingFrame`'s sanitizer bypass cannot lift (that bypass only lifts
    /// OUR 340×360 floor, not AppKit's internal one). Empirically (see `show(from:)`'s doc)
    /// AppKit's own minimum is roughly 40 wide × ~220 tall — well under our own 340×360 floor in
    /// WIDTH, so a production-realistic source frame (the real collapsed orb's own
    /// `chatWindowCollapsedSize`, 240×140 — both this test's source and every real orb frame are
    /// comfortably wider than AppKit's ~40pt floor) still starts narrow; only the HEIGHT actually
    /// gets chrome-floored above the raw source height.
    func testGrowStartsFromOrbSizedFrameWidthSmallHeightFlooredByChrome() {
        let c = makeController()
        let orbFrame = NSRect(origin: NSPoint(x: 400, y: 400), size: chatWindowCollapsedSize) // 240×140
        c.show(from: orbFrame)
        let size = c.panel?.frame.size ?? .zero
        XCTAssertEqual(size.width, chatWindowCollapsedSize.width, accuracy: 0.5, "width must stay small — the 'grows from something small' effect")
        XCTAssertGreaterThan(size.height, chatWindowCollapsedSize.height, "gate r3: AppKit's own chrome minimum binds now that the toolbar is attached from construction")
        c.close()
    }

    /// Gate fix (F2 — native traffic lights + resizable): the panel must carry the styleMask
    /// that gives it real system close/minimize/zoom buttons and native edge-resizing, plus the
    /// resize floor matching the sanitizer's own 340×360 minimum.
    ///
    /// Gate r3 (W2) empirical note: once the toolbar is attached (now at construction — see
    /// `show(from:)`), AppKit silently overrides `panel.contentMinSize` with its OWN
    /// chrome-driven minimum (observed live: ~40×220-228, NOT what we assign) — reading
    /// `contentMinSize` back is no longer a meaningful assertion. The REAL guarantee this test
    /// exists to pin — the panel can never actually be resized below 340×360 — is still enforced
    /// by our own `frameSanitizer` (`ChatWindowPanel.setFrame`'s override), independent of
    /// whatever AppKit's own `contentMinSize` bookkeeping says; asserted directly below by
    /// attempting a tiny `setFrame` once settled (`isAnimatingFrame` false) and checking it gets
    /// clamped back up.
    func testPanelHasTitledResizableStyleMaskAndMinSize() async throws {
        let c = makeController()
        c.show(from: NSRect(x: 400, y: 400, width: 240, height: 44))
        let styleMask = c.panel?.styleMask ?? []
        XCTAssertTrue(styleMask.contains(.titled))
        XCTAssertTrue(styleMask.contains(.closable))
        XCTAssertTrue(styleMask.contains(.miniaturizable))
        XCTAssertTrue(styleMask.contains(.resizable))
        XCTAssertTrue(styleMask.contains(.fullSizeContentView))

        try await waitUntilFrameStable(c) // let the grow settle — isAnimatingFrame goes false
        c.panel?.setFrame(NSRect(x: 0, y: 0, width: 50, height: 50), display: false)
        XCTAssertEqual(c.panel?.frame.size, NSSize(width: 340, height: 360),
                       "our own sanitizer must still floor the size at 340×360 once settled, regardless of AppKit's own contentMinSize bookkeeping")
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

    // MARK: Gate r3 — W2 (chrome pop fix)

    /// The toolbar (Safari-style chrome) is now attached at panel CONSTRUCTION, not deferred to
    /// the grow's natural settle (superseding gate r2's original deferred-attach) — no more
    /// end-of-grow pop in corner radius/traffic-light insets.
    func testToolbarAttachedImmediatelyAtShow() {
        let c = makeController()
        c.show(from: NSRect(x: 400, y: 400, width: 240, height: 44))
        XCTAssertNotNil(c.panel?.toolbar, "gate r3: toolbar must exist from construction, not lazily at grow-settle")
        XCTAssertEqual(c.panel?.toolbarStyle, .unified)
        c.close()
    }
}
