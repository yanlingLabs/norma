import SwiftUI

/// Owns the ONE `GlassEffectContainer` and the `@Namespace` shared by both surfaces (D3/D4/D8).
/// Switches on `controller.surface`: `.orb` renders the existing orb layout, `.field` renders
/// `FieldView`. Both branches tag their glass shell with the same `glassEffectID("norma-shell",
/// in: glassNamespace)` + `.glassEffectTransition(.matchedGeometry)` (v1 GlassFieldView.swift:
/// 490-502) so the orb circle morphs into the composer capsule in place, instead of the field
/// cross-fading in as a second window/view.
///
/// Draft ownership lives ENTIRELY here, not in `FieldView` or the controller: `@State draft` is
/// the live text; `DraftCache` is where it goes to survive a collapse (field → orb stashes it;
/// orb → field restores it, dropped after `DraftCache.expiry` = 15 min).
struct GlassRootView: View {
    @ObservedObject var session: SessionModel
    @ObservedObject var controller: OrbWindowController
    @Namespace private var glassNamespace
    @State private var draft = ""
    private let draftCache = DraftCache()

    var body: some View {
        GlassEffectContainer(spacing: 6) {
            switch controller.surface {
            case .orb:
                OrbView(session: session, glassNamespace: glassNamespace)
            case .field:
                FieldView(
                    session: session,
                    draft: $draft,
                    glassNamespace: glassNamespace,
                    onSubmit: submit
                )
            }
        }
        .onChange(of: controller.surface) { _, newSurface in
            switch newSurface {
            case .orb:
                draftCache.stash(draft)
                draft = ""
            case .field:
                draft = draftCache.restore() ?? ""
            }
        }
    }

    private func submit() {
        let text = draft
        controller.onSubmit?(text)
        draft = ""
        draftCache.clear()
    }
}
