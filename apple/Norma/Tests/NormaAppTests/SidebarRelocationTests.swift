import XCTest
@testable import Norma

/// 2e-iii Task 6: the PURE decisions behind the width-responsive sidebar integration — where the
/// tasks/subagents "work" content is placed (inline vs the right WorkSidebar, never both/neither)
/// and the chevron force-open semantics that defeat the T4 resize-drift double-tap.
final class SidebarRelocationTests: XCTestCase {

    // MARK: - Placement is exclusive (the never-duplicated invariant)

    /// `sidebarContentPlacement` depends ONLY on `rightVisible`, and is exclusive for every one of
    /// the four EffectiveSidebars right states (`rightVisible` × `rightOverlay`): work is EITHER
    /// inline OR in the sidebar — never both (would duplicate the sections), never neither (would
    /// drop them entirely).
    func testPlacementExclusiveForAllRightStates() {
        for rightVisible in [false, true] {
            for rightOverlay in [false, true] {
                let e = EffectiveSidebars(leftVisible: false, rightVisible: rightVisible,
                                          leftOverlay: false, rightOverlay: rightOverlay)
                let p = sidebarContentPlacement(e)
                XCTAssertNotEqual(p.inlineWork, p.sidebarWork,
                                  "placement must be exclusive for rightVisible=\(rightVisible) rightOverlay=\(rightOverlay)")
                XCTAssertEqual(p.inlineWork, !rightVisible)
                XCTAssertEqual(p.sidebarWork, rightVisible)
            }
        }
    }

    /// Reuse the Task-4 width engine: at the 560-wide morph window the work content places INLINE
    /// while the right sidebar is collapsed, and RELOCATES into the (overlay) work sidebar the
    /// instant the right side is expanded — 560 fits neither content+right inline, so it opens as
    /// an overlay, but the placement decision still moves work off the content column.
    func testMorphWidthPlacesWorkInlineUntilRightOverlayOpens() {
        let collapsed = sidebarContentPlacement(resolveSidebars(width: 560, leftExpanded: false, rightExpanded: false))
        XCTAssertTrue(collapsed.inlineWork)
        XCTAssertFalse(collapsed.sidebarWork)

        let expanded = resolveSidebars(width: 560, leftExpanded: false, rightExpanded: true)
        XCTAssertTrue(expanded.rightOverlay, "560 is too narrow for the right sidebar to sit inline — it overlays")
        let placed = sidebarContentPlacement(expanded)
        XCTAssertFalse(placed.inlineWork)
        XCTAssertTrue(placed.sidebarWork)
    }

    // MARK: - CARRIED ITEM 1: chevron force-open defeats the T4 resize-drift double-tap

    /// THE regression: both sidebars expanded at 1200 (both fit, both visible) → resize down to 900
    /// (below both-fit). The right wins the tie so the LEFT goes invisible while `leftExpanded` is
    /// STILL true (resolveSidebars is pure — it never mutates the raw flags). The left chevron is
    /// now shown; tapping it must OPEN the left in ONE tap (and collapse the right), NOT blind-toggle
    /// the stale-true flag back to false.
    func testLeftChevronForcesOpenInOneTapAfterResizeDrift() {
        // Precondition: both expanded, resized to 900 → left is not visible, right is.
        let drifted = resolveSidebars(width: 900, leftExpanded: true, rightExpanded: true)
        XCTAssertFalse(drifted.leftVisible)
        XCTAssertTrue(drifted.rightVisible)

        // A NAIVE blind toggle of the stale-true flag would leave the left closed (the two-tap bug).
        let naive = toggleLeftSidebar(leftExpanded: true, rightExpanded: true, width: 900)
        XCTAssertFalse(naive.left, "documents the bug the chevron handler must avoid")

        // The chevron handler force-opens instead: ONE tap → left opens, right collapses.
        let opened = openLeftViaChevron(rightExpanded: true, width: 900)
        XCTAssertTrue(opened.left)
        XCTAssertFalse(opened.right)
        // …and the resolved state after that one tap actually shows the left.
        let after = resolveSidebars(width: 900, leftExpanded: opened.left, rightExpanded: opened.right)
        XCTAssertTrue(after.leftVisible)
        XCTAssertFalse(after.rightVisible)
    }

    /// Mirror: at 900 with the LEFT inline (leftExpanded, rightExpanded=false), the right chevron
    /// force-opens the right in one tap and collapses the left.
    func testRightChevronForcesOpenInOneTap() {
        let opened = openRightViaChevron(leftExpanded: true, width: 900)
        XCTAssertTrue(opened.right)
        XCTAssertFalse(opened.left)
        let after = resolveSidebars(width: 900, leftExpanded: opened.left, rightExpanded: opened.right)
        XCTAssertTrue(after.rightVisible)
        XCTAssertFalse(after.leftVisible)
    }

    /// At a both-fit width the force-open applies NO mutual exclusion — opening the left leaves the
    /// right untouched (the sides are independent above the both-fit threshold).
    func testChevronForceOpenIndependentAtBothFit() {
        let opened = openLeftViaChevron(rightExpanded: true, width: 1200)
        XCTAssertTrue(opened.left)
        XCTAssertTrue(opened.right)
    }
}
