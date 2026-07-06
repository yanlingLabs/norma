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
    /// Task-3 fix wave: deliberately NOT `@ObservedObject` — same reason as `NormaFieldView.fluid`
    /// (see `FluidModel`'s doc, `FieldKit/FluidOrbView.swift`). Held only to pass down to
    /// `NormaFieldView`, which itself only passes it further down to `FluidOrbSlot`.
    let fluidModel: FluidModel
    // NOTE: owned by `OrbWindowController.fieldAdapter` (Task 2d-i.2), not here — the chat
    // window shares this same instance for drafts/replies/focus. Injected as `@ObservedObject`,
    // so the memberwise init suffices (no custom init needed).
    @ObservedObject var adapter: FieldStateAdapter
    private let draftCache = DraftCache()

    /// Idempotent callback wiring onto the INSTALLED adapter (see init NOTE).
    private func wireCallbacks() {
        adapter.onSubmit = { [self] text in submit(text) }
        adapter.onClearMessage = { [adapter] in adapter.composerDraft = "" }
        adapter.onCollapse = { [controller] in controller.collapseToOrb() }
        adapter.onExpandToWindow = { [controller] in controller.requestExpandToWindow() }
        // Wave-5 gate item 4: the composer-hop seam — `OrbWindowController.handleAcceptedSwipe`
        // needs to read/write `adapter.showingDraft` but can't reach the adapter directly (see
        // `OrbWindowController.isShowingDraft`'s doc).
        controller.isShowingDraft = { [adapter] in adapter.showingDraft }
        controller.setShowingDraft = { [adapter] value in adapter.showingDraft = value }
    }

    var body: some View {
        wireCallbacks()
        return NormaFieldView(adapter: adapter, morph: morphModel, fluid: fluidModel)
            .onChange(of: controller.surface) { _, newSurface in
                switch newSurface {
                case .orb:
                    draftCache.stash(adapter.composerDraft)
                    adapter.composerDraft = ""
                    // Task 6 (FieldFocus): virtual focus never survives a surface change — a
                    // collapse must not leave the chevron (or any future 2d-iii element) latched
                    // focused for the NEXT summon.
                    adapter.focusedElement = .composer
                case .field:
                    // Task 6 (FieldFocus): every fresh summon starts on the composer — same
                    // "focus never survives a surface change" rule as the `.orb` case above.
                    adapter.focusedElement = .composer
                    // Wave-9 gate fix: every fresh expand starts the reply scrolled to its top —
                    // matches v1 (a freshly re-morphed composer never remembered a stale scroll
                    // position either) and avoids a jarring mid-reply reopen if the content
                    // changed while collapsed.
                    morphModel.responseScrollOffset = 0
                    // Wave-3 gate item 2c: any summon path clears the unread blink — the field
                    // is about to show the reply (either the composer's home-state rule below
                    // yields to the answer-reveal one-shot, or there was never an unread reply
                    // to clear in the first place).
                    adapter.hasUnread = false
                    adapter.composerDraft = draftCache.restore() ?? ""
                    // Wave-3 gate item 2b: this expand is our OWN auto-expand revealing a
                    // just-finished answer (armed by the turn-completion handler below, right
                    // before it called `expandToField()`) — the summon-home-state rule just
                    // below would otherwise flip `showingDraft` back to `true` here, since by
                    // definition the turn has already finished (`turnRunning == false`), hiding
                    // the very answer this auto-expand exists to reveal.
                    if controller.consumeExpandForAnswerReveal() {
                        adapter.showingDraft = false
                    } else if summonShowsComposer(
                        // GATE-3 FIX (round 3, F4 — root cause): the composer is v1's HOME state
                        // on every summon, not whatever reply happened to occupy the shell when
                        // the field was last collapsed — without this, re-summoning a session
                        // that already has a reply reopened straight into the (non-editable)
                        // inline response view, so the ComposerTextView never mounted and typing
                        // went nowhere (empirically confirmed: zero AXTextArea/AXTextField in the
                        // AX tree post-expand). The one exception mirrors the response's own
                        // "takes the shell over" trigger below (`session.state.turnRunning`
                        // flip): a turn that's ACTIVELY STREAMING (running, with text already
                        // arriving) keeps the response view rather than yanking it away for an
                        // empty composer.
                        turnRunning: session.state.turnRunning,
                        streamingText: session.state.streamingText
                    ) {
                        adapter.showingDraft = true
                    }
                case .window:
                    // Phase 2d-i: `enterWindowMode()` routes through `hide()` internally, which
                    // sets `surface = .orb` synchronously BEFORE the controller overwrites it
                    // again to `.window` (see that method's ordering doc) — but both mutations
                    // land in the same synchronous call, before SwiftUI's next view-update pass
                    // ever observes the intermediate value, so this `onChange` only ever fires
                    // `.field` → `.window` directly, never routing through the `.orb` case above.
                    // That's exactly right: the chat window (`ChatWindowRootView`) renders off
                    // this SAME `adapter`, so the in-progress draft must survive the handoff
                    // untouched, not get stashed-and-cleared like a real collapse-to-orb.
                    break
                }
            }
            .onChange(of: controller.exchangeIndex) { _, newValue in
                adapter.exchangeIndex = newValue
                // Wave-9 gate fix: swiping to a different historical exchange swaps in different
                // reply text entirely — start that reply scrolled to its top rather than
                // carrying over wherever the PREVIOUS exchange happened to be scrolled to.
                morphModel.responseScrollOffset = 0
            }
            .onChange(of: session.state.turnRunning) { _, running in
                if running {
                    // A NEW turn starting is the only reliable "browsing history is over" signal
                    // (v1 parity, ported from the pre-transplant `Field/FieldView.swift`) — the
                    // live/streaming reply takes the shell back over from whatever was pinned
                    // AND from the composer (showingDraft flip lost in the transplant: without it
                    // the shell stayed on the emptied composer and replies never appeared).
                    controller.resetExchangeIndex()
                    adapter.showingDraft = false
                    // Wave-9 gate fix: the new turn's reply starts empty and grows from the top —
                    // don't carry over a scroll offset from whatever the shell showed before.
                    morphModel.responseScrollOffset = 0
                    // Wave-3 gate item 2a: auto-collapse to the orb ONLY when this turn-start
                    // followed the field's own submit (`collapseOnTurnStart`, armed in
                    // `submit(_:)` below) — a turn that started for some other reason while the
                    // field happens to be open (e.g. summoned mid-turn to watch/steer) never
                    // arms the flag, so `consumeCollapseOnTurnStart()` returns false and nothing
                    // here collapses it. Always consume first (one-shot) so a stale arm never
                    // survives to affect a later, unrelated turn-start.
                    if controller.consumeCollapseOnTurnStart(), controller.surface == .field {
                        OrbDebug.log("auto-collapse on submit-turn")
                        controller.collapseToOrb()
                    }
                } else {
                    handleTurnCompleted()
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
        // Wave-3 gate item 2a: captured BEFORE the send, not after awaiting it — by the time the
        // await returns, `session.state.turnRunning` may already reflect a `turn_started` event
        // that arrived during the round trip, which would make an idle-at-submit-time check
        // unreliable. `wasIdle` distinguishes a genuine new-turn submit (arms auto-collapse) from
        // a mid-turn steer (must NOT arm it — the user has the field open to watch/steer, and no
        // false→true flip will even occur for a steer, but a stale arm here could otherwise
        // survive to wrongly auto-collapse a LATER, unrelated turn-start).
        let wasIdle = !session.state.turnRunning
        Task { @MainActor in
            if await controller.onSubmit?(text) == true {
                adapter.composerDraft = ""
                draftCache.clear()
                // A successful send means the user is composing again, not browsing — drop any
                // swipe-pinned historical exchange so the shell is free to pick up the new
                // turn's reply (belt-and-suspenders alongside the turnRunning-flip reset above:
                // this fires the instant success is known, not only once `turn_started` lands).
                controller.resetExchangeIndex()
                if wasIdle {
                    controller.collapseOnTurnStart = true
                }
            }
            // failure: text stays in the composer — the draft is never lost (spec §6)
        }
    }

    /// Wave-3 gate item 2b/2c: a turn just finished (`session.state.turnRunning` flipped to
    /// `false`). Only relevant while collapsed — an already-expanded field is already showing
    /// whatever the shell settles on (the composer-vs-response logic elsewhere handles that);
    /// there is nothing extra to arrive for a field the user is already looking at.
    private func handleTurnCompleted() {
        guard controller.surface == .orb else { return }
        // Final-review I1: never auto-expand a HIDDEN panel (menu "Hide Orb") — expanding an
        // ordered-out panel re-creates the b8e1f8b wedge (surface=.field while invisible, next
        // summon collapses instead of opening). A hidden orb marks the answer unread instead.
        guard controller.isVisible else {
            adapter.hasUnread = true
            return
        }
        guard !(session.state.exchanges.last?.reply.isEmpty ?? true) else { return }
        if controller.follower.isCursorCalm() {
            OrbDebug.log("answer arrived: expanding")
            controller.expandForAnswerReveal = true
            controller.expandToField()
        } else {
            OrbDebug.log("answer arrived: cursor busy → unread")
            adapter.hasUnread = true
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
