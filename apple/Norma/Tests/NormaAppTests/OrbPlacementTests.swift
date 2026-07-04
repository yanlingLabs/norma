import XCTest
@testable import Norma

final class OrbPlacementTests: XCTestCase {
    func testWindowCenteredOnOrbCenter() {
        let origin = orbWindowOrigin(forOrbCenter: CGPoint(x: 500, y: 400), windowSize: NSSize(width: 380, height: 110))
        XCTAssertEqual(origin, CGPoint(x: 500 - 190, y: 400 - 55))
    }

    func testMetricsMatchV1() {
        XCTAssertEqual(OrbMetrics.windowSize, NSSize(width: 380, height: 110))
        XCTAssertEqual(OrbMetrics.orbDiameter, 60)
    }
}
