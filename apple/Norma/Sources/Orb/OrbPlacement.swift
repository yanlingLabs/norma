import AppKit

/// Wave 2 (v1 morph+follow engine): the panel itself is now ALWAYS `FieldMetrics.size` — there
/// is no separate orb-sized window to center-align (`orbWindowOrigin(forOrbCenter:windowSize:)`
/// and the 380×110 `windowSize` it used are gone). `OrbMetrics` keeps just the 60pt orb
/// diameter for the visuals.
enum OrbMetrics {
    static let orbDiameter: CGFloat = 60

    /// The orb circle's rect in the panel's own local coordinate space: top-left pinned at the
    /// glass anchor corner (local origin), matching `FieldMetrics`' "grows down-right from the
    /// anchor" law. This is also the morph's progress-0 source rect — the composer shell lerps
    /// FROM this exact rect (see `FieldView.composerShellRect`).
    static var anchorRect: CGRect {
        CGRect(origin: .zero, size: CGSize(width: orbDiameter, height: orbDiameter))
    }
}
