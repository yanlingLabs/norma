import XCTest
@testable import Norma

/// Coverage for `fenceAnchorForTopLeftCorner` (FieldKit/FieldCorner.swift) — the pure geometry
/// seam that replaces `FieldPlacementTests`' old `fieldFrame` coverage (deleted: `fieldFrame`/
/// `FieldMetrics` are gone with the pre-transplant approximation). Where the old test asserted
/// a single fixed-size frame clamped inside the visible frame, this asserts the EDGE FENCE that
/// replaces v1's per-corner switching (user directive: `morphModel.corner` stays `.topLeft`
/// forever) — the anchor is clamped so the EXPANDED frame always fits from `.topLeft`, not the
/// anchor's own frame.
@MainActor
final class FieldFenceTests: XCTestCase {
    let screen = CGRect(x: 0, y: 0, width: 1512, height: 950) // typical visibleFrame
    let expandedSize = CGSize(width: 480, height: 440)
    let haloPadding: CGFloat = 60
    let navOffset: CGFloat = 42 // navPillHeight(34) + interPillGap(8)

    func testAnchorWellInsideBoundsPassesThrough() {
        let anchor = CGPoint(x: 700, y: 500)
        let fenced = fenceAnchorForTopLeftCorner(
            anchor, expandedSize: expandedSize, haloPadding: haloPadding, navOffset: navOffset,
            visibleFrame: screen
        )
        XCTAssertEqual(fenced, anchor)
    }

    /// Near the right edge: the expanded frame's right edge (`origin.x + expandedSize.width`)
    /// must stay inside the margin-inset visible frame.
    func testClampsAwayFromRightEdge() {
        let anchor = CGPoint(x: 1500, y: 500)
        let fenced = fenceAnchorForTopLeftCorner(
            anchor, expandedSize: expandedSize, haloPadding: haloPadding, navOffset: navOffset,
            visibleFrame: screen
        )
        let origin = FieldCorner.topLeft.windowOrigin(
            glassAnchor: fenced,
            morph: MorphModel(),
            windowSize: expandedSize,
            surface: .composer
        )
        XCTAssertLessThanOrEqual(origin.x + expandedSize.width, screen.maxX - 16)
        XCTAssertLessThan(fenced.x, anchor.x, "anchor should have been pulled back from the raw edge-hugging value")
    }

    /// Near the bottom edge: the expanded frame's bottom edge (`origin.y`) must stay inside the
    /// margin-inset visible frame — this is the dominant constraint (needs ~`expandedSize.height`
    /// of clearance below the anchor).
    func testClampsAwayFromBottomEdge() {
        let anchor = CGPoint(x: 700, y: 20)
        let fenced = fenceAnchorForTopLeftCorner(
            anchor, expandedSize: expandedSize, haloPadding: haloPadding, navOffset: navOffset,
            visibleFrame: screen
        )
        let origin = FieldCorner.topLeft.windowOrigin(
            glassAnchor: fenced,
            morph: MorphModel(),
            windowSize: expandedSize,
            surface: .composer
        )
        XCTAssertGreaterThanOrEqual(origin.y, screen.minY + 16)
        XCTAssertGreaterThan(fenced.y, anchor.y, "anchor should have been pushed up from the raw edge-hugging value")
    }

    /// Near the top edge: the expanded frame's top edge must stay inside the visible frame too
    /// (haloPadding + navOffset clearance above the anchor for the nav pill).
    func testClampsAwayFromTopEdge() {
        let anchor = CGPoint(x: 700, y: 949)
        let fenced = fenceAnchorForTopLeftCorner(
            anchor, expandedSize: expandedSize, haloPadding: haloPadding, navOffset: navOffset,
            visibleFrame: screen
        )
        let origin = FieldCorner.topLeft.windowOrigin(
            glassAnchor: fenced,
            morph: MorphModel(),
            windowSize: expandedSize,
            surface: .composer
        )
        XCTAssertLessThanOrEqual(origin.y + expandedSize.height, screen.maxY - 16)
    }

    /// Near the left edge: a negative/near-zero anchor.x must still leave the expanded frame's
    /// left edge on-screen.
    func testClampsAwayFromLeftEdge() {
        let anchor = CGPoint(x: -50, y: 500)
        let fenced = fenceAnchorForTopLeftCorner(
            anchor, expandedSize: expandedSize, haloPadding: haloPadding, navOffset: navOffset,
            visibleFrame: screen
        )
        let origin = FieldCorner.topLeft.windowOrigin(
            glassAnchor: fenced,
            morph: MorphModel(),
            windowSize: expandedSize,
            surface: .composer
        )
        XCTAssertGreaterThanOrEqual(origin.x, screen.minX + 16)
    }

    /// A screen too small to ever fit the expanded frame must still produce a finite point
    /// (collapsed range, not an inverted min > max crash).
    func testDegenerateTinyScreenDoesNotProduceInvertedRange() {
        let tinyScreen = CGRect(x: 0, y: 0, width: 300, height: 300)
        let fenced = fenceAnchorForTopLeftCorner(
            CGPoint(x: 150, y: 150), expandedSize: expandedSize, haloPadding: haloPadding,
            navOffset: navOffset, visibleFrame: tinyScreen
        )
        XCTAssertTrue(fenced.x.isFinite)
        XCTAssertTrue(fenced.y.isFinite)
    }
}
