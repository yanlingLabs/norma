import XCTest
@testable import Norma

final class OrbPlacementTests: XCTestCase {
    // testWindowCenteredOnOrbCenter (orbWindowOrigin(forOrbCenter:windowSize:)) is DELETED:
    // wave 2 kills the orb-sized/center-aligned panel entirely — the panel is always
    // FieldMetrics.size, and the tracking spring's target origin now reuses `fieldFrame`'s
    // clamp math (top-left anchored, not center-aligned). See FieldPlacementTests.

    func testMetricsMatchV1() {
        XCTAssertEqual(OrbMetrics.orbDiameter, 60)
    }

    func testAnchorRectPinsOrbAtLocalOrigin() {
        XCTAssertEqual(OrbMetrics.anchorRect, CGRect(x: 0, y: 0, width: 60, height: 60))
    }
}
