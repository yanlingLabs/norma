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
}
