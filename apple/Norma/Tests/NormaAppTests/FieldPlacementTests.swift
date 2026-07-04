import XCTest
@testable import Norma

final class FieldPlacementTests: XCTestCase {
    let screen = CGRect(x: 0, y: 0, width: 1512, height: 950) // typical visibleFrame

    func testFieldTopLeftAtOrbCenterGrowingDownRight() {
        let f = fieldFrame(orbCenter: CGPoint(x: 400, y: 600), visibleFrame: screen)
        XCTAssertEqual(f.origin.x, 400)
        XCTAssertEqual(f.maxY, 600) // AppKit bottom-left origin: top edge at orb center
        XCTAssertEqual(f.size, NSSize(width: 620, height: 240))
    }

    func testClampsInsideVisibleFrame() {
        let f = fieldFrame(orbCenter: CGPoint(x: 1480, y: 60), visibleFrame: screen)
        XCTAssertLessThanOrEqual(f.maxX, screen.maxX - 16)
        XCTAssertGreaterThanOrEqual(f.minY, screen.minY + 16)
        XCTAssertGreaterThanOrEqual(f.minX, screen.minX + 16)
        XCTAssertLessThanOrEqual(f.maxY, screen.maxY - 16)
    }
}
