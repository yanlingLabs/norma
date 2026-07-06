import AppKit

/// Spec §2: default chat-window size.
let chatWindowDefaultSize = NSSize(width: 560, height: 640)

/// v1 transplant, adapted (AI pointer InteractionController.swift:1263-1279,
/// `clampedDetachedFrame`): min 340×360 (v1's floor), max = screen − 4, then origin
/// clamped so the frame sits fully inside `screenVisibleFrame` inset by 2pt.
func clampedChatWindowFrame(_ proposed: NSRect, screenVisibleFrame screen: NSRect) -> NSRect {
    var f = proposed
    f.size.width = min(max(f.width, 340), max(340, screen.width - 4))
    f.size.height = min(max(f.height, 360), max(360, screen.height - 4))
    f.origin.x = min(max(f.origin.x, screen.minX + 2), max(screen.minX + 2, screen.maxX - f.width - 2))
    f.origin.y = min(max(f.origin.y, screen.minY + 2), max(screen.minY + 2, screen.maxY - f.height - 2))
    return f
}

/// Spec §2 position rule: the FIRST expand of an app run grows to the default size centered
/// on the field's frame; once the user has dragged the window, re-expands go to the
/// remembered frame instead. Both clamped on-screen.
func chatWindowTargetFrame(
    sourceFrame: NSRect,
    remembered: NSRect?,
    screenVisibleFrame: NSRect,
    defaultSize: NSSize
) -> NSRect {
    if let remembered {
        return clampedChatWindowFrame(remembered, screenVisibleFrame: screenVisibleFrame)
    }
    let centered = NSRect(
        x: sourceFrame.midX - defaultSize.width / 2,
        y: sourceFrame.midY - defaultSize.height / 2,
        width: defaultSize.width,
        height: defaultSize.height
    )
    return clampedChatWindowFrame(centered, screenVisibleFrame: screenVisibleFrame)
}
