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
    /// actually apply that small size, not get force-inflated to the floor by
    /// `clampedChatWindowFrame` — this pins the sanitizer-bypass-during-grow fix.
    func testGrowStartsFromSmallOrbFrameWithoutSanitizerInflation() {
        let c = makeController()
        let tinyOrbFrame = NSRect(x: 400, y: 400, width: 28, height: 28)
        c.show(from: tinyOrbFrame)
        let size = c.panel?.frame.size ?? .zero
        XCTAssertEqual(size.width, 28, accuracy: 0.5, "the sanitizer must not inflate the grow's start frame")
        XCTAssertEqual(size.height, 28, accuracy: 0.5, "the sanitizer must not inflate the grow's start frame")
        c.close()
    }

    /// Gate fix (F2 — native traffic lights + resizable): the panel must carry the styleMask
    /// that gives it real system close/minimize/zoom buttons and native edge-resizing, plus the
    /// resize floor matching the sanitizer's own 340×360 minimum.
    func testPanelHasTitledResizableStyleMaskAndMinSize() {
        let c = makeController()
        c.show(from: NSRect(x: 400, y: 400, width: 240, height: 44))
        let styleMask = c.panel?.styleMask ?? []
        XCTAssertTrue(styleMask.contains(.titled))
        XCTAssertTrue(styleMask.contains(.closable))
        XCTAssertTrue(styleMask.contains(.miniaturizable))
        XCTAssertTrue(styleMask.contains(.resizable))
        XCTAssertTrue(styleMask.contains(.fullSizeContentView))
        XCTAssertEqual(c.panel?.contentMinSize, NSSize(width: 340, height: 360))
        c.close()
    }

    /// Gate fix (F2): the native red close button (`windowShouldClose`) must route through our
    /// own teardown exactly once — never double-firing `onClose` even if something else raced a
    /// close in first (`close()` is idempotent).
    func testWindowShouldCloseRoutesThroughTeardownExactlyOnce() {
        let c = makeController()
        var fired = 0
        c.onClose = { fired += 1 }
        c.show(from: NSRect(x: 400, y: 400, width: 240, height: 44))
        let panel = c.panel
        let shouldClose = c.windowShouldClose(panel!)
        XCTAssertFalse(shouldClose, "we tore the window down ourselves — AppKit must not also run its own close")
        XCTAssertEqual(fired, 1)
        XCTAssertFalse(c.isVisible)
        // A second windowShouldClose (or a stray real close) must not double-fire onClose.
        _ = c.windowShouldClose(panel!)
        XCTAssertEqual(fired, 1)
    }
}
