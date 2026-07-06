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

/// Gate fix (F1 — expand choreography), generalized by gate r3 (W1) to the shrink too: position-
/// only counterpart of `clampedChatWindowFrame`, used for the chat window's grow/shrink-animation
/// START/intermediate frames (`ChatWindowController.isAnimatingFrame`'s doc). The grow's source
/// (and the shrink's target) is the collapsed orb's own small size (~240×140,
/// `chatWindowCollapsedSize` below), smaller than the 340×360 floor above in BOTH dimensions —
/// running it through the full clamp would inflate it to the floor, defeating the "grows from /
/// shrinks to a tiny circle" effect. This keeps only the on-screen-origin half of that clamp
/// (same inset convention), leaving size untouched.
func clampedChatWindowPosition(_ proposed: NSRect, screenVisibleFrame screen: NSRect) -> NSRect {
    var f = proposed
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

/// Gate r3 (W1 — animated close): size the close-shrink spring targets. Mirrors
/// `MorphModel.collapsedWindowSize` (`FieldKit/MorphModel.swift`, 240×140 — the same size the
/// orb panel itself is born/settled at, `OrbWindowController.init`/`finishCollapse()`) rather
/// than importing it: `ChatWindowController` has no reference to a live `MorphModel` instance
/// (owned by `OrbWindowController`/shared via `FieldStateAdapter`, neither reachable from here
/// without new coupling this gate fix doesn't need) — a plain mirrored constant is simplest.
/// If `collapsedWindowSize` ever changes, update this alongside it.
let chatWindowCollapsedSize = NSSize(width: 240, height: 140)

/// Gate r4 (fully self-drawn window): the window is borderless for life, so the CONTENT owns its
/// corners — `ChatWindowRootView` clips/fills a `RoundedRectangle` at this radius (the modern
/// macOS-26 look), and AppKit's window shadow follows that tinted shape. 16pt reads as a normal
/// contemporary window; tune here if the gate wants it rounder/squarer.
let chatWindowCornerRadius: CGFloat = 16

/// Gate r4 (custom green zoom button): how far `ChatWindowController.zoomToggle()` insets the
/// screen's visible frame when zooming to fill — a small breathing gap so the zoomed window doesn't
/// sit flush against the screen edges / menu bar.
let chatWindowZoomInset: CGFloat = 8

/// Gate r3 (W1): the shrink's end-of-animation frame — orb-sized, centered on `point` (the
/// cursor: `OrbWindowController.exitWindowMode()`'s `show()` re-summons the orb exactly there
/// once `ChatWindowController.closeAnimated()`'s teardown runs). Position-only clamp
/// (`clampedChatWindowPosition`) — deliberately NOT `clampedChatWindowFrame`'s full clamp, which
/// would inflate this back up to the 340×360 floor and defeat the "shrinks to a tiny orb" effect.
func chatWindowShrinkTargetFrame(centeredOn point: NSPoint, screenVisibleFrame: NSRect) -> NSRect {
    let size = chatWindowCollapsedSize
    let proposed = NSRect(
        x: point.x - size.width / 2,
        y: point.y - size.height / 2,
        width: size.width,
        height: size.height
    )
    return clampedChatWindowPosition(proposed, screenVisibleFrame: screenVisibleFrame)
}
