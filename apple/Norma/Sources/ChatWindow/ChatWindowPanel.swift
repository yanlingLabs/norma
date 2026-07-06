import AppKit

/// v1 transplant (AI pointer InteractionController.swift:1385-1425, `DetachedChatPanel`,
/// byte-faithful except the class name): a panel whose EVERY frame mutation is routed through
/// `frameSanitizer`, so no code path (drag, animation, programmatic resize, NATIVE resize —
/// gate fix F2 added `.resizable` to the styleMask) can ever push the window off-screen or
/// below its minimum size. Unlike the orb's `KeyableNonActivatingPanel` (canBecomeKey gated on
/// `acceptsKeyInput`), this panel is unconditionally keyable — the window only exists while the
/// user is deliberately interacting with it.
///
/// Gate fix (F2): the styleMask (set by `ChatWindowController.show(from:)`) went from
/// `[.borderless, .nonactivatingPanel]` to `[.titled, .closable, .miniaturizable, .resizable,
/// .fullSizeContentView, .nonactivatingPanel]` — real system traffic-light buttons + native
/// edge-resizing, while `.fullSizeContentView` keeps the SwiftUI content extending under the
/// (hidden-title, transparent) title bar so the glass tint reads as one continuous surface. See
/// that method's doc for why `.nonactivatingPanel` was kept.
final class ChatWindowPanel: NSPanel {
    var frameSanitizer: ((NSRect, NSRect) -> NSRect)?

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    override func setFrame(_ frameRect: NSRect, display flag: Bool) {
        guard let sanitized = sanitizedFrame(for: frameRect) else { return }
        super.setFrame(sanitized, display: flag)
    }

    override func setFrame(_ frameRect: NSRect, display displayFlag: Bool, animate animateFlag: Bool) {
        guard let sanitized = sanitizedFrame(for: frameRect) else { return }
        super.setFrame(sanitized, display: displayFlag, animate: animateFlag)
    }

    override func setContentSize(_ size: NSSize) {
        let proposedFrame = NSRect(origin: frame.origin, size: size)
        guard let sanitized = sanitizedFrame(for: proposedFrame) else { return }
        super.setFrame(sanitized, display: true)
    }

    private func sanitizedFrame(for proposed: NSRect) -> NSRect? {
        guard let frameSanitizer else { return proposed }
        let sanitized = frameSanitizer(proposed, frame)
        if !framesApproximatelyEqual(proposed, sanitized),
           framesApproximatelyEqual(sanitized, frame) {
            return nil
        }
        return sanitized
    }

    private func framesApproximatelyEqual(_ lhs: NSRect, _ rhs: NSRect) -> Bool {
        abs(lhs.origin.x - rhs.origin.x) < 0.5 &&
            abs(lhs.origin.y - rhs.origin.y) < 0.5 &&
            abs(lhs.size.width - rhs.size.width) < 0.5 &&
            abs(lhs.size.height - rhs.size.height) < 0.5
    }
}
