/// 2e-iii: pure width engine for the chat window's two sidebars. Thresholds derive from three
/// constants; BELOW the both-fit width AT MOST ONE sidebar is visible (user rule: opening one via
/// its chevron collapses the other), with the RIGHT side winning ties (right-first reveal).
///
/// Overlays are TAP-ONLY (fix: expanded-but-unfit collapses to a chevron, never auto-overlays —
/// SPEC: "when a sidebar doesn't fit, its edge chevron stays visible and TAPPING it slides the
/// sidebar OVER the content temporarily"). The `expanded` flags are an INLINE-visibility preference
/// only; an OVERLAY appears solely from an explicit `overlayOpen` request while that side does not
/// fit inline. See `resolveSidebars`.
let sidebarLeftWidth: CGFloat = 220
let sidebarRightWidth: CGFloat = 260
let sidebarContentMinWidth: CGFloat = 520

struct EffectiveSidebars: Equatable {
    var leftVisible: Bool
    var rightVisible: Bool
    var leftOverlay: Bool
    var rightOverlay: Bool
}

/// The FOUR raw sidebar flags the view holds and the chevron/dismiss helpers transform. Kept as one
/// value so a single `@State` drives the whole layout and the pure helpers can be unit-tested
/// end-to-end (`SidebarRelocationTests`). `expanded` = INLINE-visibility preference; `overlayOpen` =
/// an explicit tap-open overlay request (honored only while that side doesn't fit inline).
struct SidebarState: Equatable {
    var leftExpanded: Bool
    var rightExpanded: Bool
    var leftOverlayOpen: Bool
    var rightOverlayOpen: Bool
}

/// Resolves the two sidebars' EFFECTIVE state from the measured width plus the four raw flags.
///
/// - `leftExpanded`/`rightExpanded` — the INLINE-visibility preference ONLY. A side that's expanded
///   but too narrow to sit inline collapses to a CHEVRON; it NEVER auto-opens as an overlay.
/// - `leftOverlayOpen`/`rightOverlayOpen` — an EXPLICIT (chevron-tap) overlay request, honored ONLY
///   while that side does NOT fit inline (an overlay never appears where the side could be inline).
///
/// Below the both-fit width AT MOST ONE side is visible (mutual exclusion, RIGHT wins ties), and a
/// visible OVERLAY there also excludes the other side entirely. Overlays: at most one, right wins
/// ties. `leftVisible`/`rightVisible` count an overlay as visible (the relocation/never-duplicate
/// gate reads them).
func resolveSidebars(width: CGFloat,
                     leftExpanded: Bool,
                     rightExpanded: Bool,
                     leftOverlayOpen: Bool = false,
                     rightOverlayOpen: Bool = false) -> EffectiveSidebars {
    let bothFit = width >= sidebarContentMinWidth + sidebarLeftWidth + sidebarRightWidth
    let rightAloneFits = width >= sidebarContentMinWidth + sidebarRightWidth
    let leftAloneFits = width >= sidebarContentMinWidth + sidebarLeftWidth

    // --- Inline: expanded ∧ fits. Below both-fit, mutual exclusion with the right winning ties.
    //     An expanded side that doesn't fit inline shows NOTHING here (a chevron in the view).
    var leftInline = false
    var rightInline = false
    if bothFit {
        leftInline = leftExpanded
        rightInline = rightExpanded
    } else if rightExpanded && rightAloneFits { // right wins ties — right-first reveal
        rightInline = true
    } else if leftExpanded && leftAloneFits {
        leftInline = true
    }

    // --- Overlay: explicit tap-open ∧ does NOT fit inline. At most one; right wins ties.
    let rightOverlay = rightOverlayOpen && !rightAloneFits
    var leftOverlay = leftOverlayOpen && !leftAloneFits
    if rightOverlay { leftOverlay = false } // right wins ties

    // Below both-fit, a visible overlay excludes the other side entirely (mutual exclusion).
    if !bothFit {
        if rightOverlay { leftInline = false }
        if leftOverlay { rightInline = false }
    }

    return EffectiveSidebars(
        leftVisible: leftInline || leftOverlay,
        rightVisible: rightInline || rightOverlay,
        leftOverlay: leftOverlay,
        rightOverlay: rightOverlay
    )
}

/// Chevron tap semantics: below both-fit, EXPANDING one side collapses the other (never two);
/// collapsing a side never force-opens the other. At both-fit widths the sides are independent.
func toggleLeftSidebar(leftExpanded: Bool, rightExpanded: Bool, width: CGFloat) -> (left: Bool, right: Bool) {
    let bothFit = width >= sidebarContentMinWidth + sidebarLeftWidth + sidebarRightWidth
    let newLeft = !leftExpanded
    return (newLeft, (bothFit || !newLeft) ? rightExpanded : false)
}

func toggleRightSidebar(leftExpanded: Bool, rightExpanded: Bool, width: CGFloat) -> (left: Bool, right: Bool) {
    let bothFit = width >= sidebarContentMinWidth + sidebarLeftWidth + sidebarRightWidth
    let newRight = !rightExpanded
    return ((bothFit || !newRight) ? leftExpanded : false, newRight)
}
