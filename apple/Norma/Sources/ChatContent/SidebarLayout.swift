/// 2e-iii: pure width engine for the chat window's two sidebars. Thresholds derive from three
/// constants; BELOW the both-fit width AT MOST ONE sidebar is visible (user rule: opening one via
/// its chevron collapses the other), with the RIGHT side winning ties (right-first reveal). A
/// visible side that doesn't fit alone renders as an OVERLAY slid over the content.
let sidebarLeftWidth: CGFloat = 220
let sidebarRightWidth: CGFloat = 260
let sidebarContentMinWidth: CGFloat = 520

struct EffectiveSidebars: Equatable {
    var leftVisible: Bool
    var rightVisible: Bool
    var leftOverlay: Bool
    var rightOverlay: Bool
}

func resolveSidebars(width: CGFloat, leftExpanded: Bool, rightExpanded: Bool) -> EffectiveSidebars {
    let bothFit = width >= sidebarContentMinWidth + sidebarLeftWidth + sidebarRightWidth
    let rightAloneFits = width >= sidebarContentMinWidth + sidebarRightWidth
    let leftAloneFits = width >= sidebarContentMinWidth + sidebarLeftWidth
    if bothFit {
        return EffectiveSidebars(leftVisible: leftExpanded, rightVisible: rightExpanded, leftOverlay: false, rightOverlay: false)
    }
    if rightExpanded { // right wins ties — right-first reveal
        return EffectiveSidebars(leftVisible: false, rightVisible: true, leftOverlay: false, rightOverlay: !rightAloneFits)
    }
    if leftExpanded {
        return EffectiveSidebars(leftVisible: true, rightVisible: false, leftOverlay: !leftAloneFits, rightOverlay: false)
    }
    return EffectiveSidebars(leftVisible: false, rightVisible: false, leftOverlay: false, rightOverlay: false)
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
