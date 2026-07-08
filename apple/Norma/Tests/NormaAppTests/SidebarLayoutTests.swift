import XCTest
@testable import Norma

/// 2e-iii Task 4 / Task 6: the pure width engine — thresholds (780 right / 740 left-alone / 1000
/// both), the user's mutual-exclusion rule below both-fit ("opening the left collapses the right"),
/// and TAP-ONLY overlays (fix: `expanded` is inline-only — an expanded-but-unfit side is a chevron,
/// NEVER an auto-overlay; overlays come solely from an explicit `overlayOpen` request).
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
        // 739: expanded-but-unfit alone → NO overlay (a chevron). Overlay only with an explicit tap-open.
        XCTAssertFalse(resolveSidebars(width: 739, leftExpanded: true, rightExpanded: false).leftVisible)
        XCTAssertTrue(resolveSidebars(width: 739, leftExpanded: true, rightExpanded: false, leftOverlayOpen: true).leftOverlay)
    }

    func testRightInlineBoundary() {
        // 780: fits inline (no overlay) even with an overlayOpen request — overlays are honored only
        // when the side does NOT fit inline.
        XCTAssertFalse(resolveSidebars(width: 780, leftExpanded: false, rightExpanded: true).rightOverlay)
        XCTAssertFalse(resolveSidebars(width: 780, leftExpanded: false, rightExpanded: true, rightOverlayOpen: true).rightOverlay)
        // 779: expanded alone is a chevron; only an explicit tap-open makes it an overlay.
        XCTAssertFalse(resolveSidebars(width: 779, leftExpanded: false, rightExpanded: true).rightVisible)
        XCTAssertTrue(resolveSidebars(width: 779, leftExpanded: false, rightExpanded: true, rightOverlayOpen: true).rightOverlay)
    }

    func testMorphWindowTapOnlyOverlays() {
        // 560: fits neither. Expanded alone shows NOTHING (chevrons) — never an auto-overlay.
        let expandedOnly = resolveSidebars(width: 560, leftExpanded: true, rightExpanded: true)
        XCTAssertFalse(expandedOnly.leftVisible); XCTAssertFalse(expandedOnly.rightVisible)
        // A tap-open on the (unfitting) right → overlay, and it excludes the left entirely.
        let r = resolveSidebars(width: 560, leftExpanded: true, rightExpanded: true, rightOverlayOpen: true)
        XCTAssertTrue(r.rightOverlay); XCTAssertFalse(r.leftVisible)
        // A tap-open on the left → overlay, right excluded.
        let l = resolveSidebars(width: 560, leftExpanded: true, rightExpanded: false, leftOverlayOpen: true)
        XCTAssertTrue(l.leftOverlay); XCTAssertFalse(l.rightVisible)
    }

    func testNeitherExpanded() {
        let r = resolveSidebars(width: 800, leftExpanded: false, rightExpanded: false)
        XCTAssertEqual(r, EffectiveSidebars(leftVisible: false, rightVisible: false, leftOverlay: false, rightOverlay: false))
    }

    // MARK: - Fix (tap-only overlays): the new contract's edge cases

    /// (a) Resize-down 800→700 with the RIGHT expanded: 700 can't fit it inline, so it collapses to
    /// a CHEVRON — NOT an overlay. (An auto-overlay was the bug this fix removes.)
    func testResizeDownExpandedRightBecomesChevronNotOverlay() {
        let at800 = resolveSidebars(width: 800, leftExpanded: false, rightExpanded: true)
        XCTAssertTrue(at800.rightVisible); XCTAssertFalse(at800.rightOverlay) // inline at 800
        let at700 = resolveSidebars(width: 700, leftExpanded: false, rightExpanded: true)
        XCTAssertFalse(at700.rightVisible, "expanded-but-unfit → chevron")
        XCTAssertFalse(at700.rightOverlay, "never an auto-overlay")
    }

    /// (b) `overlayOpen` is honored ONLY when the side does NOT fit inline. At 800 the right fits
    /// inline → a lingering `rightOverlayOpen` is ignored (renders inline); at 700 it's honored.
    func testOverlayOpenHonoredOnlyWhenNotFittingInline() {
        let fits = resolveSidebars(width: 800, leftExpanded: false, rightExpanded: true, rightOverlayOpen: true)
        XCTAssertFalse(fits.rightOverlay); XCTAssertTrue(fits.rightVisible) // inline, overlayOpen ignored
        let unfit = resolveSidebars(width: 700, leftExpanded: false, rightExpanded: true, rightOverlayOpen: true)
        XCTAssertTrue(unfit.rightOverlay)
    }

    /// (c) At most ONE overlay, RIGHT wins ties: below both left-alone and right-alone fit widths,
    /// both `overlayOpen` set → only the right overlays.
    func testAtMostOneOverlayRightWins() {
        let r = resolveSidebars(width: 700, leftExpanded: true, rightExpanded: true,
                                leftOverlayOpen: true, rightOverlayOpen: true)
        XCTAssertTrue(r.rightOverlay)
        XCTAssertFalse(r.leftOverlay)
        XCTAssertFalse(r.leftVisible)
    }

    /// (d) The one-tap force-open regression still holds: both expanded at 1200, resize to 900 (left
    /// drifts invisible with `leftExpanded` stale-true), a left chevron tap opens the left INLINE in
    /// ONE tap and collapses the right.
    func testLeftChevronOneTapForceOpenAfterResizeDrift() {
        let drifted = resolveSidebars(width: 900, leftExpanded: true, rightExpanded: true)
        XCTAssertFalse(drifted.leftVisible); XCTAssertTrue(drifted.rightVisible)
        let opened = openLeftViaChevron(SidebarState(leftExpanded: true, rightExpanded: true,
                                                     leftOverlayOpen: false, rightOverlayOpen: false), width: 900)
        XCTAssertTrue(opened.leftExpanded); XCTAssertFalse(opened.rightExpanded)
        let after = resolveSidebars(width: 900,
                                    leftExpanded: opened.leftExpanded, rightExpanded: opened.rightExpanded,
                                    leftOverlayOpen: opened.leftOverlayOpen, rightOverlayOpen: opened.rightOverlayOpen)
        XCTAssertTrue(after.leftVisible); XCTAssertFalse(after.leftOverlay); XCTAssertFalse(after.rightVisible)
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

    // MARK: - gate-feedback-1 FIX B: `WindowContentView`'s `@State private var sidebar` now
    // defaults to `SidebarState(leftExpanded: true, rightExpanded: true, ...)` (both sides
    // expanded — previously only the right was). These pin the two width thresholds the brief
    // called out against THAT exact default combination, so a future default drift is caught here
    // rather than only visually.

    /// At (or above) the both-fit width (1000 = `sidebarContentMinWidth` 520 + `sidebarLeftWidth`
    /// 220 + `sidebarRightWidth` 260), the new default renders BOTH sidebars inline — no mutual
    /// exclusion applies above this threshold.
    func testDefaultStateAtBothFitWidthShowsBothSidebars() {
        let r = resolveSidebars(width: 1000, leftExpanded: true, rightExpanded: true)
        XCTAssertTrue(r.leftVisible)
        XCTAssertTrue(r.rightVisible)
        XCTAssertFalse(r.leftOverlay)
        XCTAssertFalse(r.rightOverlay)
    }

    /// Below the both-fit width (800 < 1000, but ≥ 780 so the right alone still fits), mutual
    /// exclusion kicks in and the RIGHT wins the tie — even though `leftExpanded` is ALSO true by
    /// default now, only the right renders (the left shows as a chevron, not an overlay).
    func testDefaultStateAt800ShowsRightOnly() {
        let r = resolveSidebars(width: 800, leftExpanded: true, rightExpanded: true)
        XCTAssertFalse(r.leftVisible, "below both-fit, right wins the tie even with left also expanded")
        XCTAssertTrue(r.rightVisible)
        XCTAssertFalse(r.leftOverlay, "unfit-but-expanded is a chevron, never an auto-overlay")
        XCTAssertFalse(r.rightOverlay)
    }

    // MARK: - gate-feedback-1 FIX C: the edge-chevron glyph moved from vertically-centered to
    // top-anchored (`WindowContentView.sidebarChevron`) — visual only, pinning the layout constant
    // it uses (`sidebarChevronTopOffset`) against the brief's "~12-16pt below the top inset".

    func testChevronTopOffsetWithinSpecRange() {
        XCTAssertGreaterThanOrEqual(sidebarChevronTopOffset, 12)
        XCTAssertLessThanOrEqual(sidebarChevronTopOffset, 16)
    }
}
