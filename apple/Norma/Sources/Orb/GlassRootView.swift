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
        // NOTE: do NOT touch `adapter` here. Accessing a @StateObject's wrappedValue inside
        // init mutates a pre-installation THROWAWAY instance — the installed adapter keeps the
        // default no-op closures (live-gate bug: typing worked, Enter silently did nothing).
        // Wiring lives in body via wireCallbacks(); the closures are plain vars (not
        // @Published), so per-render reassignment is idempotent and publishes nothing.
    }

    /// Idempotent callback wiring onto the INSTALLED adapter (see init NOTE).
    private func wireCallbacks() {
        adapter.onSubmit = { [self] text in submit(text) }
        adapter.onClearMessage = { [adapter] in adapter.composerDraft = "" }
        adapter.onCollapse = { [controller] in controller.collapseToOrb() }
    }

    var body: some View {
        wireCallbacks()
        return NormaFieldView(adapter: adapter, morph: morphModel)
            .onChange(of: controller.surface) { _, newSurface in
                switch newSurface {
                case .orb:
                    draftCache.stash(adapter.composerDraft)
                    adapter.composerDraft = ""
                case .field:
                    adapter.composerDraft = draftCache.restore() ?? ""
                    // GATE-3 FIX (round 3, F4 — root cause): the composer is v1's HOME state on
                    // every summon, not whatever reply happened to occupy the shell when the
                    // field was last collapsed — without this, re-summoning a session that
                    // already has a reply reopened straight into the (non-editable) inline
                    // response view, so the ComposerTextView never mounted and typing went
                    // nowhere (empirically confirmed: zero AXTextArea/AXTextField in the AX tree
                    // post-expand). The one exception mirrors the response's own "takes the shell
                    // over" trigger below (`session.state.turnRunning` flip): a turn that's
                    // ACTIVELY STREAMING (running, with text already arriving) keeps the response
                    // view rather than yanking it away for an empty composer.
                    if summonShowsComposer(
                        turnRunning: session.state.turnRunning,
                        streamingText: session.state.streamingText
                    ) {
                        adapter.showingDraft = true
                    }
                }
            }
            .onChange(of: controller.exchangeIndex) { _, newValue in
                adapter.exchangeIndex = newValue
            }
            .onChange(of: session.state.turnRunning) { _, running in
                // A NEW turn starting is the only reliable "browsing history is over" signal
                // (v1 parity, ported from the pre-transplant `Field/FieldView.swift`) — the
                // live/streaming reply takes the shell back over from whatever was pinned
                // AND from the composer (showingDraft flip lost in the transplant: without it
                // the shell stayed on the emptied composer and replies never appeared).
                if running {
                    controller.resetExchangeIndex()
                    adapter.showingDraft = false
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

/// GATE-3 FIX (round 3, F4) — the summon home-state rule, extracted pure so it's unit-testable
/// (`SummonHomeStateTests`): on every orb→field expand the COMPOSER is the home state (v1
/// semantics — the response occupies the shell only after a submit / while streaming), EXCEPT
/// when a turn is actively streaming (running with reply text already arriving), in which case
/// the in-flight response keeps the shell. `turnRunning` alone (no streamed text yet — the
/// shimmer-only "thinking" state) still summons into the composer: nothing readable would be
/// yanked away, and the user summoning mid-think almost certainly wants to type.
func summonShowsComposer(turnRunning: Bool, streamingText: String) -> Bool {
    !(turnRunning && !streamingText.isEmpty)
}
