import XCTest
@testable import Norma

final class ChatWindowLayoutTests: XCTestCase {
    let screen = NSRect(x: 0, y: 0, width: 1512, height: 944)

    func testOnScreenFrameUnchanged() {
        let f = NSRect(x: 100, y: 100, width: 560, height: 640)
        XCTAssertEqual(clampedChatWindowFrame(f, screenVisibleFrame: screen), f)
    }

    func testEdgeOverflowClampsInside() {
        let f = NSRect(x: 1400, y: -50, width: 560, height: 640)
        let c = clampedChatWindowFrame(f, screenVisibleFrame: screen)
        XCTAssertLessThanOrEqual(c.maxX, screen.maxX - 2)
        XCTAssertGreaterThanOrEqual(c.minY, screen.minY + 2)
        XCTAssertEqual(c.size, f.size) // fits, so size untouched
    }

    func testOversizeShrinksToScreen() {
        let f = NSRect(x: 0, y: 0, width: 3000, height: 2000)
        let c = clampedChatWindowFrame(f, screenVisibleFrame: screen)
        XCTAssertLessThanOrEqual(c.width, screen.width - 4)
        XCTAssertLessThanOrEqual(c.height, screen.height - 4)
    }

    func testMinimumSizeEnforced() {
        let f = NSRect(x: 100, y: 100, width: 50, height: 50)
        let c = clampedChatWindowFrame(f, screenVisibleFrame: screen)
        XCTAssertGreaterThanOrEqual(c.width, 340)
        XCTAssertGreaterThanOrEqual(c.height, 360)
    }

    func testFirstExpandCentersDefaultSizeOnSource() {
        let source = NSRect(x: 600, y: 400, width: 240, height: 44)
        let t = chatWindowTargetFrame(sourceFrame: source, remembered: nil,
                                      screenVisibleFrame: screen, defaultSize: chatWindowDefaultSize)
        XCTAssertEqual(t.size, chatWindowDefaultSize)
        XCTAssertEqual(t.midX, source.midX, accuracy: 0.5)
        XCTAssertEqual(t.midY, source.midY, accuracy: 0.5)
    }

    func testFirstExpandNearEdgeStaysOnScreen() {
        let source = NSRect(x: 1480, y: 10, width: 240, height: 44)
        let t = chatWindowTargetFrame(sourceFrame: source, remembered: nil,
                                      screenVisibleFrame: screen, defaultSize: chatWindowDefaultSize)
        XCTAssertLessThanOrEqual(t.maxX, screen.maxX - 2)
        XCTAssertGreaterThanOrEqual(t.minY, screen.minY + 2)
    }

    func testRememberedFrameWinsAndIsClamped() {
        let source = NSRect(x: 600, y: 400, width: 240, height: 44)
        let remembered = NSRect(x: 1300, y: 700, width: 560, height: 640) // sticks off top-right
        let t = chatWindowTargetFrame(sourceFrame: source, remembered: remembered,
                                      screenVisibleFrame: screen, defaultSize: chatWindowDefaultSize)
        XCTAssertEqual(t.size, remembered.size)
        XCTAssertLessThanOrEqual(t.maxX, screen.maxX - 2)
        XCTAssertLessThanOrEqual(t.maxY, screen.maxY - 2)
    }

    /// Gate r5 (window melts into the orb): the shrink's target is now the VISIBLE orb BUBBLE — a
    /// small square (`chatWindowOrbBubbleDiameter`, mirroring `MorphModel.orbBubbleSize`, 20pt), NOT
    /// the 240×140 collapsed PANEL (`chatWindowCollapsedSize`) that read as "a big square" then
    /// blinked away. Centered on the cursor point, position-only clamped (size is deliberately NOT
    /// floored to the 340×360 minimum — the orb bubble IS meant to be tiny).
    func testShrinkTargetIsOrbBubbleSizedAndCenteredOnCursor() {
        let cursor = NSPoint(x: 700, y: 500)
        let f = chatWindowShrinkTargetFrame(centeredOn: cursor, screenVisibleFrame: screen)
        XCTAssertEqual(f.size, NSSize(width: chatWindowOrbBubbleDiameter, height: chatWindowOrbBubbleDiameter))
        XCTAssertLessThan(f.size.width, chatWindowCollapsedSize.width, "gate r5: the target is the tiny bubble, not the 240×140 panel")
        XCTAssertEqual(f.midX, cursor.x, accuracy: 0.5)
        XCTAssertEqual(f.midY, cursor.y, accuracy: 0.5)
    }

    func testShrinkTargetNearEdgeStaysOnScreen() {
        let cursor = NSPoint(x: 1, y: 1) // bottom-left corner
        let f = chatWindowShrinkTargetFrame(centeredOn: cursor, screenVisibleFrame: screen)
        XCTAssertEqual(f.size, NSSize(width: chatWindowOrbBubbleDiameter, height: chatWindowOrbBubbleDiameter),
                       "position clamp must never touch size")
        XCTAssertGreaterThanOrEqual(f.minX, screen.minX + 2)
        XCTAssertGreaterThanOrEqual(f.minY, screen.minY + 2)
    }
}
