import XCTest
@testable import Norma

/// 2e-iii Task 4: the pure width engine — thresholds (780 right / 740 left-alone / 1000 both) and
/// the user's mutual-exclusion rule below both-fit ("opening the left collapses the right").
final class SidebarLayoutTests: XCTestCase {
    func testBothFitIndependence() {
        let r = resolveSidebars(width: 1000, leftExpanded: true, rightExpanded: true)
        XCTAssertEqual(r, EffectiveSidebars(leftVisible: true, rightVisible: true, leftOverlay: false, rightOverlay: false))
        XCTAssertFalse(resolveSidebars(width: 1000, leftExpanded: false, rightExpanded: true).leftVisible)
    }

    func testBelowBothFitAtMostOneRightWins() {
        // 999: both expanded → only RIGHT shows (right-first default on resize-down)
        let r = resolveSidebars(width: 999, leftExpanded: true, rightExpanded: true)
        XCTAssertEqual(r, EffectiveSidebars(leftVisible: false, rightVisible: true, leftOverlay: false, rightOverlay: false))
    }

    func testLeftAloneInlineAt740OverlayBelow() {
        let inline = resolveSidebars(width: 740, leftExpanded: true, rightExpanded: false)
        XCTAssertEqual(inline, EffectiveSidebars(leftVisible: true, rightVisible: false, leftOverlay: false, rightOverlay: false))
        XCTAssertTrue(resolveSidebars(width: 739, leftExpanded: true, rightExpanded: false).leftOverlay)
    }

    func testRightInlineBoundary() {
        XCTAssertFalse(resolveSidebars(width: 780, leftExpanded: false, rightExpanded: true).rightOverlay)
        XCTAssertTrue(resolveSidebars(width: 779, leftExpanded: false, rightExpanded: true).rightOverlay)
    }

    func testMorphWindowOverlays() {
        // 560: fits neither — whichever side is expanded shows as overlay, never both
        XCTAssertTrue(resolveSidebars(width: 560, leftExpanded: false, rightExpanded: true).rightOverlay)
        let l = resolveSidebars(width: 560, leftExpanded: true, rightExpanded: false)
        XCTAssertTrue(l.leftOverlay); XCTAssertFalse(l.rightVisible)
    }

    func testNeitherExpanded() {
        let r = resolveSidebars(width: 800, leftExpanded: false, rightExpanded: false)
        XCTAssertEqual(r, EffectiveSidebars(leftVisible: false, rightVisible: false, leftOverlay: false, rightOverlay: false))
    }

    func testToggleLeftCollapsesRightBelowBothFit() {
        // THE user rule: right open at 800, tap left chevron → left opens, right collapses
        let t = toggleLeftSidebar(leftExpanded: false, rightExpanded: true, width: 800)
        XCTAssertEqual(t.left, true); XCTAssertEqual(t.right, false)
        // and at bothFit width the right is untouched
        let wide = toggleLeftSidebar(leftExpanded: false, rightExpanded: true, width: 1200)
        XCTAssertEqual(wide.left, true); XCTAssertEqual(wide.right, true)
        // collapsing left (toggle off) never force-opens right
        let off = toggleLeftSidebar(leftExpanded: true, rightExpanded: false, width: 800)
        XCTAssertEqual(off.left, false); XCTAssertEqual(off.right, false)
    }

    func testToggleRightMirrors() {
        let t = toggleRightSidebar(leftExpanded: true, rightExpanded: false, width: 800)
        XCTAssertEqual(t.right, true); XCTAssertEqual(t.left, false)
    }
}
