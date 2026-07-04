import AppKit

enum FieldMetrics {
    static let size = NSSize(width: 620, height: 240)
    static let screenMargin: CGFloat = 16
}

/// PURE: the expanded field's frame — top-left anchored at the orb center (grows down-right),
/// clamped fully inside the screen's visible frame with a margin.
func fieldFrame(orbCenter: CGPoint, visibleFrame: CGRect) -> CGRect {
    var frame = CGRect(
        x: orbCenter.x,
        y: orbCenter.y - FieldMetrics.size.height,
        width: FieldMetrics.size.width,
        height: FieldMetrics.size.height
    )
    let bounds = visibleFrame.insetBy(dx: FieldMetrics.screenMargin, dy: FieldMetrics.screenMargin)
    if frame.maxX > bounds.maxX { frame.origin.x = bounds.maxX - frame.width }
    if frame.minX < bounds.minX { frame.origin.x = bounds.minX }
    if frame.minY < bounds.minY { frame.origin.y = bounds.minY }
    if frame.maxY > bounds.maxY { frame.origin.y = bounds.maxY - frame.height }
    return frame
}
