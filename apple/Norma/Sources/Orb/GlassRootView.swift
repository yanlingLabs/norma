import SwiftUI

/// Owns the ONE `GlassEffectContainer` and the `@Namespace` shared by both surfaces (D3/D4/D8).
///
/// Wave 2 (v1 morph+follow engine): the discrete `switch controller.surface` render died —
/// `OrbView` and `FieldView` are now BOTH permanently in the ZStack, each computing its own
/// geometry/opacity off `morphModel.progress` (injected here as an `@ObservedObject` so this
/// view actually re-renders every 60Hz morph tick; `controller` is observed only for `surface`,
/// which now drives input/draft logic exclusively — see `onChange` below and the Esc monitor
/// in `OrbWindowController`). `controller.surface` still flips `.orb` ⇄ `.field` (immediately on
/// expand, on collapse COMPLETION), so the draft stash/restore contract is unchanged.
///
/// Draft ownership lives ENTIRELY here, not in `FieldView` or the controller: `@State draft` is
/// the live text; `DraftCache` is where it goes to survive a collapse (field → orb stashes it;
/// orb → field restores it, dropped after `DraftCache.expiry` = 15 min).
struct GlassRootView: View {
    @ObservedObject var session: SessionModel
    @ObservedObject var controller: OrbWindowController
    @ObservedObject var morphModel: MorphModel
    @Namespace private var glassNamespace
    @State private var draft = ""
    private let draftCache = DraftCache()

    var body: some View {
        GlassEffectContainer(spacing: 6) {
            ZStack(alignment: .topLeading) {
                OrbView(session: session, glassNamespace: glassNamespace, progress: morphModel.progress)
                FieldView(
                    session: session,
                    controller: controller,
                    draft: $draft,
                    glassNamespace: glassNamespace,
                    progress: morphModel.progress,
                    onSubmit: submit
                )
            }
        }
        .frame(width: FieldMetrics.size.width, height: FieldMetrics.size.height, alignment: .topLeading)
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
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        Task { @MainActor in
            if await controller.onSubmit?(text) == true {
                draft = ""
                draftCache.clear()
                // Wave 2c task 4: a successful send means the user is composing again, not
                // browsing — drop any swipe-pinned historical exchange so the shell is free to
                // pick up the new turn's reply (belt-and-suspenders alongside FieldView's own
                // turnRunning-flip reset: this fires the instant success is known, not only once
                // `turn_started` actually lands).
                controller.resetExchangeIndex()
            }
            // failure: text stays in the composer — the draft is never lost (spec §6)
        }
    }
}
