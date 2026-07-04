import AppKit

enum OrbMetrics {
    /// v1 PointerRenderer: 260×110 view; the orb sits dead-center so the follower's
    /// "window center == orb center" math holds; the pill overlays without layout.
    static let windowSize = NSSize(width: 260, height: 110)
    static let orbDiameter: CGFloat = 60
}

/// PURE: window origin such that the window's center is the orb center (v1 contract).
func orbWindowOrigin(forOrbCenter center: CGPoint, windowSize: NSSize) -> CGPoint {
    CGPoint(x: center.x - windowSize.width / 2, y: center.y - windowSize.height / 2)
}
