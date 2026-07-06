import XCTest
@testable import Norma

/// Gate r7 (same-panel window morph): the pure window-surface geometry — layout math, morph bands,
/// corner-radius ramp, and mouse-gate hit test. All AppKit-free so they run without a live panel.
final class WindowSurfaceGeometryTests: XCTestCase {
    let screen = CGRect(x: 0, y: 0, width: 1512, height: 944)
    let content = CGSize(width: 560, height: 640)
    let halo: CGFloat = 60
    let bubble: CGFloat = 20

    private func layout(anchor: CGPoint) -> (windowFrame: CGRect, finalRect: CGRect, orbPoint: CGPoint) {
        windowSurfaceLayout(
            anchor: anchor, contentSize: content,
            haloPadding: halo, orbBubbleSize: bubble, screenFrame: screen
        )
    }

    // MARK: layout

    /// The CONTENT is centered on the locked screen frame — reconstruct its screen-space center
    /// from the window-local `finalRect` and assert it lands on the screen center.
    func testContentCenteredOnScreen() {
        let anchor = CGPoint(x: 300, y: 300)
        let l = layout(anchor: anchor)
        let contentScreenMidX = l.windowFrame.minX + l.finalRect.midX
        let contentScreenMidY = l.windowFrame.maxY - l.finalRect.midY // flip y back to screen (y-up)
        XCTAssertEqual(contentScreenMidX, screen.midX, accuracy: 0.5)
        XCTAssertEqual(contentScreenMidY, screen.midY, accuracy: 0.5)
        XCTAssertEqual(l.finalRect.size, content)
    }

    /// `orbPoint` maps back to the exact `anchor` in screen coords — the shell converges to the orb
    /// at the anchor.
    func testOrbPointMapsBackToAnchor() {
        let anchor = CGPoint(x: 1400, y: 120)
        let l = layout(anchor: anchor)
        let orbScreenX = l.windowFrame.minX + l.orbPoint.x
        let orbScreenY = l.windowFrame.maxY - l.orbPoint.y
        XCTAssertEqual(orbScreenX, anchor.x, accuracy: 0.5)
        XCTAssertEqual(orbScreenY, anchor.y, accuracy: 0.5)
    }

    /// The window frame unions the padded content AND the padded orb bubble at the anchor, so the
    /// whole orb→shell morph path fits inside one panel.
    func testWindowFrameUnionContainsOrbAndContent() {
        let anchor = CGPoint(x: 200, y: 800) // far from the centered content
        let l = layout(anchor: anchor)
        // orb bubble + halo is inside the window frame
        let orbPadded = CGRect(x: anchor.x - bubble / 2, y: anchor.y - bubble / 2, width: bubble, height: bubble)
            .insetBy(dx: -halo, dy: -halo)
        XCTAssertTrue(l.windowFrame.contains(orbPadded), "window frame must contain the padded orb bubble")
        // padded content is inside the window frame
        let contentFrame = CGRect(x: screen.midX - content.width / 2, y: screen.midY - content.height / 2,
                                  width: content.width, height: content.height).insetBy(dx: -halo, dy: -halo)
        XCTAssertTrue(l.windowFrame.contains(contentFrame), "window frame must contain the padded content")
    }

    // MARK: morph bands

    func testMorphedRectAtZeroIsBubbleAtOrbPoint() {
        let finalRect = CGRect(x: 100, y: 100, width: 560, height: 640)
        let orbPoint = CGPoint(x: 40, y: 700)
        let r = morphedWindowSurfaceRect(orbPoint: orbPoint, finalRect: finalRect, progress: 0, orbBubbleSize: bubble)
        XCTAssertEqual(r.width, bubble, accuracy: 0.001)
        XCTAssertEqual(r.height, bubble, accuracy: 0.001)
        XCTAssertEqual(r.midX, orbPoint.x, accuracy: 0.001)
        XCTAssertEqual(r.midY, orbPoint.y, accuracy: 0.001)
    }

    func testMorphedRectAtOneIsFinalRect() {
        let finalRect = CGRect(x: 100, y: 100, width: 560, height: 640)
        let orbPoint = CGPoint(x: 40, y: 700)
        let r = morphedWindowSurfaceRect(orbPoint: orbPoint, finalRect: finalRect, progress: 1, orbBubbleSize: bubble)
        XCTAssertEqual(r.midX, finalRect.midX, accuracy: 0.5)
        XCTAssertEqual(r.midY, finalRect.midY, accuracy: 0.5)
        XCTAssertEqual(r.width, finalRect.width, accuracy: 0.5)
        XCTAssertEqual(r.height, finalRect.height, accuracy: 0.5)
    }

    /// Monotonic growth: the shell only ever gets bigger as progress rises (no mid-morph shrink).
    func testMorphedRectGrowsMonotonically() {
        let finalRect = CGRect(x: 100, y: 100, width: 560, height: 640)
        let orbPoint = CGPoint(x: 40, y: 700)
        var lastArea: CGFloat = -1
        for step in 0...10 {
            let p = Double(step) / 10.0
            let r = morphedWindowSurfaceRect(orbPoint: orbPoint, finalRect: finalRect, progress: p, orbBubbleSize: bubble)
            let area = r.width * r.height
            XCTAssertGreaterThanOrEqual(area, lastArea - 0.001)
            lastArea = area
        }
    }

    // MARK: corner radius

    func testCornerRadiusIsCircleAtBubbleSize() {
        let r = CGRect(x: 0, y: 0, width: bubble, height: bubble)
        XCTAssertEqual(morphedWindowSurfaceCornerRadius(for: r), bubble / 2, accuracy: 0.001)
    }

    func testCornerRadiusReachesTwentySixWhenLarge() {
        let r = CGRect(x: 0, y: 0, width: 560, height: 640)
        XCTAssertEqual(morphedWindowSurfaceCornerRadius(for: r), chatWindowCornerRadius, accuracy: 0.001)
        XCTAssertEqual(chatWindowCornerRadius, 26)
    }

    // MARK: hit test

    func testHitTestInsideShellAccepts_HaloRejects() {
        let windowSize = CGSize(width: 680, height: 760)
        let finalRect = CGRect(x: 60, y: 60, width: 560, height: 640)
        let orbPoint = CGPoint(x: 30, y: 730)
        // fully open: shell == finalRect
        let center = CGPoint(x: finalRect.midX, y: finalRect.midY)
        XCTAssertTrue(windowSurfaceHitTest(point: center, windowSize: windowSize, finalRect: finalRect,
                                           orbPoint: orbPoint, progress: 1, orbBubbleSize: bubble))
        // a point in the halo margin (top-left corner of the whole window, outside the content) rejects
        let haloPoint = CGPoint(x: 5, y: 5)
        XCTAssertFalse(windowSurfaceHitTest(point: haloPoint, windowSize: windowSize, finalRect: finalRect,
                                            orbPoint: orbPoint, progress: 1, orbBubbleSize: bubble))
    }

    func testHitTestOutsideWindowBoundsRejects() {
        let windowSize = CGSize(width: 680, height: 760)
        let finalRect = CGRect(x: 60, y: 60, width: 560, height: 640)
        let orbPoint = CGPoint(x: 30, y: 730)
        let outside = CGPoint(x: -10, y: 400)
        XCTAssertFalse(windowSurfaceHitTest(point: outside, windowSize: windowSize, finalRect: finalRect,
                                            orbPoint: orbPoint, progress: 1, orbBubbleSize: bubble))
    }

    /// Early in the morph the shell is a tiny bubble at the orb — only points near the orb accept,
    /// the (still-empty) content region rejects.
    func testHitTestAtProgressZeroOnlyNearOrb() {
        let windowSize = CGSize(width: 680, height: 760)
        let finalRect = CGRect(x: 60, y: 60, width: 560, height: 640)
        let orbPoint = CGPoint(x: 30, y: 730)
        XCTAssertTrue(windowSurfaceHitTest(point: orbPoint, windowSize: windowSize, finalRect: finalRect,
                                           orbPoint: orbPoint, progress: 0, orbBubbleSize: bubble))
        XCTAssertFalse(windowSurfaceHitTest(point: CGPoint(x: finalRect.midX, y: finalRect.midY),
                                            windowSize: windowSize, finalRect: finalRect,
                                            orbPoint: orbPoint, progress: 0, orbBubbleSize: bubble))
    }

    // MARK: rounded-rect containment

    func testRoundedRectRejectsClippedCorner() {
        let rect = CGRect(x: 0, y: 0, width: 100, height: 100)
        let radius: CGFloat = 30
        // dead center is in
        XCTAssertTrue(roundedRectContains(rect, radius: radius, point: CGPoint(x: 50, y: 50)))
        // the extreme corner is clipped away by the radius
        XCTAssertFalse(roundedRectContains(rect, radius: radius, point: CGPoint(x: 1, y: 1)))
        // a point on the straight edge (mid-top) is in
        XCTAssertTrue(roundedRectContains(rect, radius: radius, point: CGPoint(x: 50, y: 1)))
    }
}
