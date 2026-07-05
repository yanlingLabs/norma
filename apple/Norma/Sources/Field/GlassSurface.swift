import SwiftUI

/// v1 port, WHOLE (GlassFieldView.swift:2643-2667) — the single shared Liquid Glass "recipe"
/// v1 used for every prompt chrome element (composer, nav pill, image chips, thinking pill) so
/// they all read as the same material. The modifier itself has zero v1-only dependencies (no
/// `AppState`/`FieldFocusCoordinator`/etc.), so it compiles standalone unchanged — this file is
/// a straight copy, not an adaptation.
///
/// The one place it can't be dropped in directly is `FieldView`'s composer/reply shell: that
/// fill has to carry `.glassEffectID` for the orb-morph identity (D8), and `GlassSurface`'s
/// `.background { ... }` would bury a second, un-tagged glass fill underneath it rather than
/// supplying the tagged one. `FieldView` instead reproduces this modifier's two halves inline
/// on the shell (tagged glass fill + the same hairline overlay below), so the shell and every
/// other surface in the field still share the identical constants (22pt corner radius, white
/// 0.5-opacity 1pt stroke) even though only one of them routes through this type directly.
struct GlassSurface: ViewModifier {
    var cornerRadius: CGFloat = 22
    var drawsBorder: Bool = true

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        return content
            .background {
                Color.clear
                    .glassEffect(.regular, in: shape)
            }
            .overlay(
                shape
                    .strokeBorder(Color.white.opacity(drawsBorder ? 0.5 : 0), lineWidth: drawsBorder ? 1 : 0)
            )
    }
}
