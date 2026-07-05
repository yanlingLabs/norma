import AppKit

/// DIRECT TRANSPLANT of v1's `FieldCorner` (TextField/GlassFieldWindow.swift:2172-2284) —
/// verbatim, minus the dashboard/chat branch (see `GlassFieldSurface` below).

/// Reduced port of v1's `GlassFieldSurface` (TextField/GlassFieldWindow.swift:14-18: originally
/// `case composer, dashboard, chat`) — dashboard/chat are cut for this transplant, so only the
/// one case `windowOrigin(...)` actually needs remains. Kept as a real (single-case) enum rather
/// than dropping the parameter entirely so `windowOrigin`'s signature stays verbatim per the
/// brief; task B can reintroduce `.dashboard`/`.chat` here (and in `windowOrigin`'s switch) if
/// those surfaces come back.
enum GlassFieldSurface: Sendable {
    case composer
}

// MARK: - FieldCorner

/// Which corner of the COMPOSER pill sits over the orb. The window itself is
/// a fixed size big enough to contain the composer, a gap, the nav pill, and
/// halo padding on every side. The corner just determines (a) which screen
/// quadrant the UI extends into, and (b) how the interior is laid out — top
/// corners put the composer at the top (at the orb) with the nav pill below;
/// bottom corners invert that.
enum FieldCorner {
    case topLeft, topRight, bottomLeft, bottomRight

    /// True when this corner anchors the composer along the top edge of the
    /// window (composer near the orb, nav pill underneath it).
    var composerOnTop: Bool {
        switch self {
        case .topLeft, .topRight:       return true
        case .bottomLeft, .bottomRight: return false
        }
    }

    /// True when this corner anchors to the left side of the window.
    var isLeft: Bool {
        switch self {
        case .topLeft, .bottomLeft:   return true
        case .topRight, .bottomRight: return false
        }
    }

    /// The point inside the window (SwiftUI coordinate space, y grows down)
    /// where the orb sits when the composer is docked here. This is the
    /// corner of the composer pill that touches the orb.
    ///
    /// The nav pill is always ABOVE the composer, so for top corners the
    /// composer is pushed down inside the window (to leave room for the
    /// nav pill above it). For bottom corners the composer is at the
    /// window bottom and the nav pill lives in the space above.
    func orbAnchorInWindow(windowSize: CGSize, morph: FieldKitMorphModel) -> CGPoint {
        let P = morph.haloPadding
        let navOffset = morph.navPillHeight + morph.interPillGap
        switch self {
        case .topLeft:
            // Composer's top-left is at orb. Nav pill above composer, so
            // composer.top = P + navHeight + gap (nav pill occupies the top
            // of the interior).
            return CGPoint(x: P, y: P + navOffset)
        case .topRight:
            return CGPoint(x: windowSize.width - P, y: P + navOffset)
        case .bottomLeft:
            // Composer's bottom-left is at orb. Composer sits at the
            // bottom of the interior. Nav pill is above it.
            return CGPoint(x: P, y: windowSize.height - P)
        case .bottomRight:
            return CGPoint(x: windowSize.width - P, y: windowSize.height - P)
        }
    }

    /// Window origin in macOS screen space (bottom-left convention) such that
    /// the composer's chosen corner ends up at `glassAnchor`.
    func windowOrigin(
        glassAnchor: CGPoint,
        morph: FieldKitMorphModel,
        windowSize: CGSize? = nil,
        surface: GlassFieldSurface
    ) -> CGPoint {
        let size = windowSize ?? morph.windowSize
        let local: CGPoint
        switch surface {
        case .composer:
            local = orbAnchorInWindow(windowSize: size, morph: morph)
        }
        return CGPoint(
            x: glassAnchor.x - local.x,
            y: glassAnchor.y - (size.height - local.y)
        )
    }

    /// Preference order: `.topLeft` first (UI extends down-and-right from the
    /// orb, which the user prefers), then flip axes only when the INTERIOR
    /// (composer + gap + nav pill) would spill off-screen.
    static func choose(anchor: CGPoint, interiorSize: CGSize, padding: CGFloat) -> FieldCorner {
        let screenFrame = NSScreen.screens
            .first(where: { $0.frame.contains(anchor) })?.frame
            ?? NSScreen.main?.frame
            ?? .zero

        let screenMargin: CGFloat = 8
        let canExtendRight = (anchor.x + interiorSize.width + padding) <= (screenFrame.maxX - screenMargin)
        let canExtendDown  = (anchor.y - interiorSize.height - padding) >= (screenFrame.minY + screenMargin)

        switch (canExtendRight, canExtendDown) {
        case (true,  true):  return .topLeft       // preferred
        case (false, true):  return .topRight      // too close to right edge
        case (true,  false): return .bottomLeft    // too close to bottom
        case (false, false): return .bottomRight   // corner of screen
        }
    }
}
