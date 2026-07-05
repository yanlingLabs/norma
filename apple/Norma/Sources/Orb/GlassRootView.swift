import SwiftUI

/// Task B (v1 field transplant, the swap): hosts the transplanted FieldKit view
/// (`NormaFieldView`) instead of the old orb/field morph approximation (`OrbView`+`FieldView`,
/// both deleted) — `NormaFieldView` owns its own `GlassEffectContainer` and renders the whole
/// orb↔field morph itself off `morphModel.progress`, so this view no longer needs one either.
///
/// What SURVIVES here from the pre-transplant version, moved onto `FieldStateAdapter` instead of
/// a local `@State draft`: draft ownership (stash on collapse / restore on expand via
/// `DraftCache`), the submit() chain (draft clear gated on `controller.onSubmit`'s success so a
/// failed send never loses the composed text — spec §6), and `exchangeIndex` reset rules (a new
/// turn starting, or the exchange list shrinking under a stale pin) that used to live in
/// `Field/FieldView.swift`.
struct GlassRootView: View {
    @ObservedObject var session: SessionModel
    @ObservedObject var controller: OrbWindowController
    @ObservedObject var morphModel: MorphModel
    @StateObject private var adapter: FieldStateAdapter
    private let draftCache = DraftCache()

    init(session: SessionModel, controller: OrbWindowController, morphModel: MorphModel) {
        self.session = session
        self.controller = controller
        self.morphModel = morphModel
        _adapter = StateObject(wrappedValue: FieldStateAdapter(session: session))

        // Wired here, once, rather than via `.onAppear`: `OrbWindowController.init` constructs
        // this view exactly ONCE for the field panel's entire lifetime (it never reassigns
        // `NSHostingView.rootView`), so this initializer body also runs exactly once — no risk
        // of rewiring on every SwiftUI re-render, and no dependency on SwiftUI's appear-timing
        // (which, for a permanently-offscreen-until-shown panel, is worth not relying on).
        adapter.onSubmit = { [self] text in submit(text) }
        adapter.onClearMessage = { [adapter] in adapter.composerDraft = "" }
        adapter.onCollapse = { [controller] in controller.collapseToOrb() }
    }

    var body: some View {
        NormaFieldView(adapter: adapter, morph: morphModel)
            .onChange(of: controller.surface) { _, newSurface in
                switch newSurface {
                case .orb:
                    draftCache.stash(adapter.composerDraft)
                    adapter.composerDraft = ""
                case .field:
                    adapter.composerDraft = draftCache.restore() ?? ""
                }
            }
            .onChange(of: controller.exchangeIndex) { _, newValue in
                adapter.exchangeIndex = newValue
            }
            .onChange(of: session.state.turnRunning) { _, running in
                // A NEW turn starting is the only reliable "browsing history is over" signal
                // (v1 parity, ported from the pre-transplant `Field/FieldView.swift`) — the
                // live/streaming reply takes the shell back over from whatever was pinned.
                if running {
                    controller.resetExchangeIndex()
                }
            }
            .onChange(of: session.state.exchanges.count) { _, newCount in
                // Session refocus/reset shrinks (or swaps) the history — a stale pin must not
                // survive pointing past the end of the (new, shorter) exchange list.
                if let index = controller.exchangeIndex, index >= newCount {
                    controller.resetExchangeIndex()
                }
            }
    }

    private func submit(_ text: String) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        Task { @MainActor in
            if await controller.onSubmit?(text) == true {
                adapter.composerDraft = ""
                draftCache.clear()
                // A successful send means the user is composing again, not browsing — drop any
                // swipe-pinned historical exchange so the shell is free to pick up the new
                // turn's reply (belt-and-suspenders alongside the turnRunning-flip reset above:
                // this fires the instant success is known, not only once `turn_started` lands).
                controller.resetExchangeIndex()
            }
            // failure: text stays in the composer — the draft is never lost (spec §6)
        }
    }
}
