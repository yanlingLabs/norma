import CoreGraphics
import Foundation

// MARK: - Window-surface constants (gate r7 — same-panel window morph)

/// Spec §2: the window's approved content size (v2's `chatWindowDefaultSize`, kept by name across
/// the r7 pivot). This is the CONTENT rect (the tinted, self-drawn window body) — the AppKit panel
/// frame is larger: content inset by `-haloPadding` on every side, unioned with the orb bubble at
/// the current anchor so the whole orb→shell morph path fits (`windowSurfaceLayout`).
let chatWindowDefaultSize = CGSize(width: 560, height: 640)

/// Gate r6/r7: the window shell's final corner radius (macOS-26 proportions — reads on par with a
/// real macOS-26 window). `morphedWindowSurfaceCornerRadius` ramps a full circle (at the orb) up to
/// this as the shell forms. v1 used 30 (`dashboardCornerRadius`); v2's approved value is 26.
let chatWindowCornerRadius: CGFloat = 26

/// Gate r7 (green zoom): breathing gap between the zoomed window's CONTENT and the screen edges, so
/// the near-fullscreen window doesn't sit flush against the menu bar / screen edges.
let chatWindowZoomInset: CGFloat = 12

/// Spec §1: the window is glass but TINTED near-opaque (white in Light, grey in Dark) so it reads
/// as a solid normal window. Pure so the exact values are pinned by tests (`ChatWindowTintTests`).
/// The window branch fades this in with morph progress (`WindowSurfaceView`) — glassy at the orb,
/// solid once the shell has formed.
func chatWindowTint(darkMode: Bool) -> (white: Double, opacity: Double) {
    darkMode ? (white: 0.16, opacity: 0.94) : (white: 0.97, opacity: 0.94)
}

// MARK: - Layout (gate r7 — transplant of v1 dashboard `largeSurfaceLayout`, GlassFieldWindow.swift:1124-1153)

/// PURE window-surface layout: the CONTENT is `contentSize` CENTERED on the locked `screenFrame`;
/// the AppKit `windowFrame` is that content inset by `-haloPadding` on every side, UNIONED with the
/// orb bubble frame (at `anchor`, also inset by `-haloPadding`) so the whole orb→shell morph path
/// fits inside one panel. `finalRect`/`orbPoint` are window-LOCAL SwiftUI coordinates (y grows
/// down) for the view + hit-test to consume. Verbatim math from v1's dashboard branch (the chat
/// SIDEBAR branch — snap boundaries, third-placement — is deliberately not ported; v2's window is a
/// single centered surface).
func windowSurfaceLayout(
    anchor: CGPoint,
    contentSize: CGSize,
    haloPadding: CGFloat,
    orbBubbleSize: CGFloat,
    screenFrame: CGRect
) -> (windowFrame: CGRect, finalRect: CGRect, orbPoint: CGPoint) {
    let contentFrame = CGRect(
        x: screenFrame.midX - contentSize.width / 2,
        y: screenFrame.midY - contentSize.height / 2,
        width: contentSize.width,
        height: contentSize.height
    )
    let padding = haloPadding
    let paddedContentFrame = contentFrame.insetBy(dx: -padding, dy: -padding)
    let orbFrame = CGRect(
        x: anchor.x - orbBubbleSize / 2,
        y: anchor.y - orbBubbleSize / 2,
        width: orbBubbleSize,
        height: orbBubbleSize
    )
    .insetBy(dx: -padding, dy: -padding)
    let windowFrame = paddedContentFrame.union(orbFrame)

    let finalRect = CGRect(
        x: contentFrame.minX - windowFrame.minX,
        y: windowFrame.height - (contentFrame.maxY - windowFrame.minY),
        width: contentFrame.width,
        height: contentFrame.height
    )
    let orbPoint = CGPoint(
        x: anchor.x - windowFrame.minX,
        y: windowFrame.height - (anchor.y - windowFrame.minY)
    )
    return (windowFrame, finalRect, orbPoint)
}

// MARK: - Morph geometry (gate r7 — transplant of v1 `morphedLargeSurfaceRect`/`…CornerRadius`,
// GlassFieldWindow.swift:1391-1420)

/// The window shell rectangle for the given morph progress. At progress 0 it's a tiny `orbBubbleSize`
/// bubble centered on `orbPoint`; at progress 1 it's `finalRect`. Verbatim v1 bands (wider/slower
/// than the composer's — a large surface needs a longer travel to read as growing OUT of the orb):
/// width ss(0.05,0.62), height ss(0.08,0.66), travel ss(0.04,0.58).
func morphedWindowSurfaceRect(
    orbPoint: CGPoint,
    finalRect: CGRect,
    progress: Double,
    orbBubbleSize: CGFloat
) -> CGRect {
    let p = max(0, min(1, progress))
    let bubbleSize = orbBubbleSize
    let widthProgress = CGFloat(smoothstep(0.05, 0.62, p))
    let heightProgress = CGFloat(smoothstep(0.08, 0.66, p))
    let travelProgress = CGFloat(smoothstep(0.04, 0.58, p))

    let width = bubbleSize + (finalRect.width - bubbleSize) * widthProgress
    let height = bubbleSize + (finalRect.height - bubbleSize) * heightProgress
    let centerX = orbPoint.x + (finalRect.midX - orbPoint.x) * travelProgress
    let centerY = orbPoint.y + (finalRect.midY - orbPoint.y) * travelProgress

    return CGRect(
        x: centerX - width / 2,
        y: centerY - height / 2,
        width: width,
        height: height
    )
}

/// Corner radius: a full circle at bubble size, ramping into `chatWindowCornerRadius` (26 — v2's
/// approved value, adapting v1's :1415-1420 which used 30) as the shorter side passes 80→300.
func morphedWindowSurfaceCornerRadius(for rect: CGRect) -> CGFloat {
    let shorter = min(rect.width, rect.height)
    let circleRadius = shorter / 2
    let t = min(1, max(0, (shorter - 80) / 220))
    return circleRadius * (1 - t) + chatWindowCornerRadius * t
}

// MARK: - Mouse-gate hit test (gate r7 — transplant of v1 `roundedRect(contains:)`/`largeSurfaceHitTest`,
// GlassFieldWindow.swift:1248-1290/1422-1441)

/// Does `point` (window-local, y-down) fall inside the ROUNDED shell rect? The panel now spans
/// content + halo, so the mouse gate must let clicks on the transparent halo margin pass through
/// (`OrbWindowController.updateWindowMouseGate`). Pure so the hit region is unit-tested.
func windowSurfaceHitTest(
    point: CGPoint,
    windowSize: CGSize,
    finalRect: CGRect,
    orbPoint: CGPoint,
    progress: Double,
    orbBubbleSize: CGFloat
) -> Bool {
    let bounds = CGRect(origin: .zero, size: windowSize)
    guard bounds.contains(point) else { return false }
    let shellRect = morphedWindowSurfaceRect(
        orbPoint: orbPoint,
        finalRect: finalRect,
        progress: progress,
        orbBubbleSize: orbBubbleSize
    )
    let radius = morphedWindowSurfaceCornerRadius(for: shellRect)
    return roundedRectContains(shellRect, radius: radius, point: point)
}

/// v1's `roundedRect(_:radius:contains:)` (GlassFieldWindow.swift:1422-1441), verbatim: inside the
/// rect AND (in one of the two axis-inset cores OR within `radius` of a corner center).
func roundedRectContains(_ rect: CGRect, radius: CGFloat, point: CGPoint) -> Bool {
    guard rect.contains(point) else { return false }
    let r = min(radius, rect.width / 2, rect.height / 2)
    if rect.insetBy(dx: r, dy: 0).contains(point) ||
        rect.insetBy(dx: 0, dy: r).contains(point) {
        return true
    }
    let cornerCenters = [
        CGPoint(x: rect.minX + r, y: rect.minY + r),
        CGPoint(x: rect.maxX - r, y: rect.minY + r),
        CGPoint(x: rect.minX + r, y: rect.maxY - r),
        CGPoint(x: rect.maxX - r, y: rect.maxY - r)
    ]
    return cornerCenters.contains { center in
        hypot(point.x - center.x, point.y - center.y) <= r
    }
}
