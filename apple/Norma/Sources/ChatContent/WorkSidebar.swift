import SwiftUI

/// 2e-iii Task 6: the callback bundle the two window construction sites hand to `WindowContentView`
/// to light up its width-responsive sidebars. `WindowContentView.sidebars` is `SidebarWiring?` —
/// `nil` reproduces today's exact zero-sidebar layout (a guard clause in `body`); BOTH call sites
/// (the morph window via `OrbWindowController`, a detached window via `DetachedWindowController`)
/// pass a real value.
///
/// `directory` is the left session-switcher's live list; `currentSessionId` is read FRESH at render
/// (a closure, not a captured value — the focused/pinned session changes over the window's life);
/// `onSelect` switches in place, `onOpenDetached` spawns a new detached window for that id, and
/// `onNewSession` creates+focuses a fresh session.
struct SidebarWiring {
    let directory: SessionDirectory
    let currentSessionId: () -> String?
    let onSelect: (String) -> Void
    let onOpenDetached: (String) -> Void
    let onNewSession: () -> Void
}

/// Pure placement decision behind the relocation gates: the tasks/subagents "work" content is
/// EXCLUSIVELY either inline in the content column (no right sidebar) or in the right WorkSidebar
/// (the right side visible — inline OR overlay). Never both (would duplicate the sections), never
/// neither (would drop them). `SidebarRelocationTests` drives this directly; the `body` gates read
/// `resolved.rightVisible` (== `sidebarWork`) inline for the smallest diff.
func sidebarContentPlacement(_ e: EffectiveSidebars) -> (inlineWork: Bool, sidebarWork: Bool) {
    (!e.rightVisible, e.rightVisible)
}

/// CARRIED ITEM 1 (T4 resize-drift): a chevron is only ever shown for a side that is NOT effectively
/// visible, so its tap is always an OPEN, never a blind toggle. A resize below the both-fit width can
/// leave `leftExpanded` stale-true while the right won the tie and the left is invisible — a naive
/// `toggleLeftSidebar` on that stale-true flag would flip it to `false` (still closed → TWO taps to
/// open). Force the open by feeding the toggle helper `false` for THIS side, so `newLeft = !false =
/// true` reliably opens, while the helper still applies the below-both-fit mutual exclusion to the
/// OTHER side.
func openLeftViaChevron(rightExpanded: Bool, width: CGFloat) -> (left: Bool, right: Bool) {
    toggleLeftSidebar(leftExpanded: false, rightExpanded: rightExpanded, width: width)
}

/// Mirror of `openLeftViaChevron` for the right edge — see that function's doc.
func openRightViaChevron(leftExpanded: Bool, width: CGFloat) -> (left: Bool, right: Bool) {
    toggleRightSidebar(leftExpanded: leftExpanded, rightExpanded: false, width: width)
}
